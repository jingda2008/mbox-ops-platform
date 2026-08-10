import { signStaticTableQrToken } from '../dist-server/server/table-access.js'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  describeVenueWorkload,
  describeKdsWriteProfile,
  evaluatePhaseArrivalSchedules,
  runArrivalPool,
  selectAuthorizedOccupiedTables,
} from './load-workload-model.mjs'
import { resetRuntimeMetricsWindow } from './reset-runtime-metrics-window.mjs'

const baseUrls = (process.env.MBOX_LOAD_BASE_URLS ?? 'http://127.0.0.1:18791,http://127.0.0.1:18792')
  .split(',').map((value) => value.trim().replace(/\/$/, '')).filter(Boolean)
const samples = Number(process.env.MBOX_LOAD_SAMPLES ?? 300)
const concurrency = Number(process.env.MBOX_LOAD_CONCURRENCY ?? 60)
const setupConcurrency = Number(process.env.MBOX_LOAD_SETUP_CONCURRENCY ?? 10)
const staffColdStarts = Number(process.env.MBOX_LOAD_STAFF_COLD_STARTS ?? 12)
const staffStartRounds = Number(process.env.MBOX_LOAD_STAFF_START_ROUNDS ?? 10)
const testWindowSeconds = Number(process.env.MBOX_LOAD_WINDOW_SECONDS ?? 300)
const venueModel = describeVenueWorkload({ testWindowSeconds })
const kdsWriteProfile = describeKdsWriteProfile({
  guests: venueModel.guests,
  operatingHours: venueModel.operatingHours,
})
const readRps = Number(process.env.MBOX_LOAD_READ_RPS ?? 1)
const guestSessionRps = Number(process.env.MBOX_LOAD_GUEST_SESSION_RPS ?? venueModel.testGuestSessionArrivalPerSecond)
const heartbeatRps = Number(process.env.MBOX_LOAD_HEARTBEAT_RPS ?? 1)
const setupWriteRps = Number(process.env.MBOX_LOAD_SETUP_WRITE_RPS ?? 5)
const writeRps = Number(process.env.MBOX_LOAD_WRITE_RPS ?? kdsWriteProfile.representativeRegressionRps)
const staffStartRps = Number(process.env.MBOX_LOAD_STAFF_START_RPS ?? 2)
const schedulingDelayP95LimitMs = Number(process.env.MBOX_LOAD_SCHEDULING_DELAY_P95_LIMIT_MS ?? 250)
const phase = process.env.MBOX_LOAD_PHASE?.trim() || 'all'
const runId = process.env.MBOX_LOAD_RUN_ID?.trim() || null
const phases = ['all', 'staff_start', 'reads', 'create_task_live', 'create_quick_order_live', 'task_action', 'kds_start', 'kds_complete']
if (!phases.includes(phase)) throw new Error(`MBOX_LOAD_PHASE必须是${phases.join('、')}之一`)
const accessCode = process.env.MBOX_LOAD_ACCESS_CODE ?? 'MBOX521'
const qrSecret = process.env.MBOX_QR_SECRET ?? 'rc68-qr-secret-0123456789abcdef0123456789abcdef'
const defaultStaffPins = {
  'emp-operations-director': '7001', 'emp-admin': '7002', 'emp-host': '7003', 'emp-mia': '7004',
  'emp-chen': '7005', 'emp-qing': '7006', 'emp-cashier': '7007', 'emp-lin': '7008',
  'emp-wu': '7009', 'emp-jie': '7010', 'emp-han': '7011', 'emp-tao': '7012',
}
const expectedRoleNames = {
  'emp-operations-director': '运营负责人', 'emp-admin': '系统管理员', 'emp-host': '市场设计',
  'emp-mia': '新媒体舞台运营', 'emp-chen': '值班经理', 'emp-qing': '鸡尾酒调酒师',
  'emp-cashier': '收银员', 'emp-lin': '主服务员', 'emp-wu': '主服务员',
  'emp-jie': '服务员·全店候补', 'emp-han': '厨房出品', 'emp-tao': '调音灯光',
}
const pins = JSON.parse(process.env.MBOX_LOAD_STAFF_PINS_JSON ?? JSON.stringify(defaultStaffPins))
const staffActorIds = Object.keys(pins).slice(0, staffColdStarts)
if (baseUrls.length < 2) throw new Error('混合负载必须配置至少两个API实例')
if (!Number.isSafeInteger(samples) || samples < 300) throw new Error('每个关键路由至少需要300个样本')
if (!Number.isSafeInteger(concurrency) || concurrency < 60 || concurrency > 100) throw new Error('客户与读取并发必须是60至100')
if (!Number.isSafeInteger(setupConcurrency) || setupConcurrency < 1 || setupConcurrency > 20) throw new Error('准备数据并发必须是1至20')
if (!Number.isSafeInteger(staffColdStarts) || staffColdStarts < 1 || staffColdStarts > 50) throw new Error('员工冷启动样本必须是1至50')
if (!Number.isSafeInteger(staffStartRounds) || staffStartRounds < 10 || staffStartRounds > 50) throw new Error('员工启动测试每个岗位至少10轮且最多50轮')
if (staffActorIds.length !== staffColdStarts || !staffActorIds.includes('emp-chen') || !staffActorIds.includes('emp-qing')) {
  throw new Error('员工负载身份必须覆盖指定数量，并包含店长与调酒师')
}
for (const [name, value] of Object.entries({ readRps, guestSessionRps, heartbeatRps, setupWriteRps, writeRps, staffStartRps })) {
  if (!Number.isFinite(value) || value <= 0 || value > 100) throw new Error(`${name}必须是0至100之间的正数`)
}
if (!Number.isFinite(schedulingDelayP95LimitMs) || schedulingDelayP95LimitMs <= 0) {
  throw new Error('调度延迟P95上限必须是正数')
}

const observations = []
const keepaliveFailures = []
const measuredArrivalMetrics = {}
const setupArrivalMetrics = {}
function percentile(values, fraction) {
  if (!values.length) return 0
  const sorted = values.toSorted((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0
}
function round(value) { return Math.round(value * 10) / 10 }
function targetUrl(index, path) { return `${baseUrls[index % baseUrls.length]}${path}` }
async function jsonRequest(label, index, path, init = {}, measured = true, onResponse, testStage = measured ? 'measured' : 'setup') {
  const startedAt = performance.now()
  let response
  try {
    response = await fetch(targetUrl(index, path), {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        'x-mbox-test-phase': phase,
        'x-mbox-test-stage': testStage,
      },
    })
    const text = await response.text()
    const elapsedMs = round(performance.now() - startedAt)
    if (measured) observations.push({ label, status: response.status, elapsedMs, responseBytes: Buffer.byteLength(text) })
    onResponse?.(response)
    if (!response.ok && response.status !== 304) throw new Error(`${label} ${response.status}: ${text.slice(0, 400)}`)
    return text ? JSON.parse(text) : null
  } catch (error) {
    if (measured && !response) observations.push({ label, status: 0, elapsedMs: round(performance.now() - startedAt) })
    throw error
  }
}
function body(value, token) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(value),
  }
}
async function runPool(items, worker, workerCount = concurrency) {
  let cursor = 0
  const failures = []
  await Promise.all(Array.from({ length: Math.min(workerCount, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      try { await worker(items[index], index) }
      catch (error) { failures.push({ index, message: error instanceof Error ? error.message : String(error) }) }
    }
  }))
  return failures
}
async function runArrival(label, items, worker, options, stage = 'measured') {
  const result = await runArrivalPool(items, worker, options)
  const target = stage === 'setup' ? setupArrivalMetrics : measuredArrivalMetrics
  target[label] = Object.fromEntries(Object.entries(result.metrics).map(([key, value]) => [key, round(value)]))
  return result.failures
}
async function login(actorId, index = 0, testStage = 'setup') {
  if (typeof pins[actorId] !== 'string') throw new Error(`员工 ${actorId} 缺少负载测试PIN`)
  const session = await jsonRequest('setup_login', index, '/api/auth/pilot-login', body({
    accessCode, actorId, employeePin: pins[actorId],
  }), false, undefined, testStage)
  if (session.employee?.id !== actorId || session.employee?.roleName !== expectedRoleNames[actorId]) {
    throw new Error(`员工 ${actorId} 登录角色不符合负载模型`)
  }
  return session
}

for (let index = 0; index < baseUrls.length; index += 1) {
  await jsonRequest('setup_health', index, '/api/ready', {}, false)
}
const manager = await login('emp-chen')
const bartender = await login('emp-qing')
const managerHeaders = { authorization: `Bearer ${manager.token}` }
const bartenderToken = bartender.token
const staffSessions = await Promise.all(staffActorIds.map(async (actorId) => {
  if (actorId === 'emp-chen') return manager
  if (actorId === 'emp-qing') return bartender
  return login(actorId)
}))
const staffSessionByActorId = new Map(staffSessions.map((session) => [session.employee.id, session]))
const adminSession = staffSessionByActorId.get('emp-admin')
if (!adminSession) throw new Error('负载模型缺少系统管理员会话，无法读取权威桌台目录')
const indices = Array.from({ length: samples }, (_, index) => index)
const visibleTablesByActorId = new Map(await Promise.all(staffSessions.map(async (session, index) => {
  const catalog = await jsonRequest('setup_load_catalog', index, '/api/bootstrap', {
    headers: { authorization: `Bearer ${session.token}` },
  }, false)
  return [session.employee.id, catalog.tables]
})))
const occupiedTables = selectAuthorizedOccupiedTables(visibleTablesByActorId, staffSessionByActorId)
if (occupiedTables.length < 5) throw new Error(`权威桌台目录只有${occupiedTables.length}张可执行负载的营业桌台`)
for (const table of occupiedTables) {
  if (!staffSessionByActorId.has(table.actorId)) throw new Error(`桌台 ${table.code} 缺少责任人员工会话`)
}
const qrTokens = occupiedTables.map((table) => signStaticTableQrToken({
  storeId: 'mbox-lujiazui', tableCode: table.code, tokenVersion: 1, issuedAt: Date.now(),
}, qrSecret))
const setupFailures = []
const measuresStaffStart = phase === 'all' || phase === 'staff_start'
const measuresReads = phase === 'all' || phase === 'reads'
const measures = (route) => phase === 'all' || phase === route
const needsTaskFixtures = measures('task_action')
const needsOrderFixtures = measures('kds_start') || measures('kds_complete')

// Model the real staff client from login onward. Large fixture preparation is
// intentionally part of the candidate exercise and may outlive one lease.
await Promise.all([
  jsonRequest('setup_heartbeat', 0, '/api/auth/presence/heartbeat', body({}, manager.token), false),
  jsonRequest('setup_heartbeat', 1, '/api/auth/presence/heartbeat', body({}, bartenderToken), false),
])
const keepaliveRuns = new Set()
let keepaliveStopped = false
let keepalivePaused = false
const renewActiveStaff = async () => {
  const results = await Promise.allSettled(staffSessions.map((session, index) => (
    jsonRequest('keepalive_heartbeat', index, '/api/auth/presence/heartbeat', body({}, session.token), false)
  )))
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      keepaliveFailures.push({
        actorId: staffSessions[index]?.employee.id ?? `unknown-${index}`,
        message: result.reason instanceof Error ? result.reason.message : String(result.reason),
      })
    }
  })
}
const keepaliveTimer = setInterval(() => {
  if (keepaliveStopped || keepalivePaused) return
  const run = renewActiveStaff()
  keepaliveRuns.add(run)
  void run.finally(() => keepaliveRuns.delete(run))
}, 30_000)
keepaliveTimer.unref()

const taskIds = new Array(samples)
const kdsTaskIds = new Array(samples)
const liveTaskIds = new Array(samples)
const liveOrderIds = new Array(samples)
const liveTaskRequests = new Array(samples)
const liveOrderRequests = new Array(samples)
const [taskSetupFailures, orderSetupFailures] = await Promise.all([
  needsTaskFixtures ? runArrival('setup_create_task', indices, async (_, index) => {
    const task = await jsonRequest('fixture_create_task', index, '/api/tasks', body({
      tableCode: 'L01', serviceTypeId: 'water', source: 'employee', note: `rc68-load-${index}`,
      idempotencyKey: `rc68-load-task-${String(index).padStart(5, '0')}`,
    }, manager.token), false)
    taskIds[index] = task.id
  }, { requestsPerSecond: setupWriteRps, maxConcurrency: setupConcurrency }, 'setup') : [],
  needsOrderFixtures ? runArrival('setup_create_order', indices, async (_, index) => {
    const order = await jsonRequest('fixture_create_quick_order', index, '/api/commerce/quick-orders', body({
      tableId: 'table-l01', productId: 'product-cocktail', quantity: 1, actorId: 'emp-chen',
      idempotencyKey: `rc68-load-order-${String(index).padStart(5, '0')}`,
    }, manager.token), false)
    const itemId = order.items?.[0]?.id
    if (!itemId) throw new Error('快捷订单未返回品项ID')
    kdsTaskIds[index] = `kds:${order.id}:${itemId}`
  }, { requestsPerSecond: setupWriteRps, maxConcurrency: setupConcurrency }, 'setup') : [],
])
setupFailures.push(...taskSetupFailures, ...orderSetupFailures)
if (setupFailures.length) throw new Error(`负载数据准备失败：${JSON.stringify(setupFailures.slice(0, 5))}`)

async function resetMeasuredMetricsWindow() {
  keepalivePaused = true
  try {
    await Promise.allSettled([...keepaliveRuns])
    await resetRuntimeMetricsWindow({
      baseUrls,
      token: process.env.MBOX_METRICS_TOKEN ?? '',
      phase,
    })
  } finally {
    keepalivePaused = false
  }
}

// Fixture creation is intentionally faster than the representative route
// regression. KDS completion has one additional setup transition below, so it
// opens the clean metrics window only after every item has entered preparing.
if (phase !== 'kds_complete') await resetMeasuredMetricsWindow()

const failures = []
const coldStartIndices = Array.from({ length: staffColdStarts }, (_, index) => index)
const staffStartJourneys = Array.from({ length: staffActorIds.length * staffStartRounds }, (_, index) => ({
  actorId: staffActorIds[index % staffActorIds.length],
  round: Math.floor(index / staffActorIds.length) + 1,
}))
if (measuresStaffStart) failures.push(...await runArrival('staff_start_api_journey', staffStartJourneys, async (journey, index) => {
  const startedAt = performance.now()
  try {
    const session = await login(journey.actorId, index, 'measured')
    await jsonRequest('staff_start_bootstrap', index, '/api/bootstrap', {
      headers: { authorization: `Bearer ${session.token}` },
    }, false, undefined, 'measured')
    observations.push({
      label: 'staff_start_api_journey', status: 200,
      elapsedMs: round(performance.now() - startedAt), responseBytes: 0,
    })
  } catch (error) {
    observations.push({
      label: 'staff_start_api_journey', status: 0,
      elapsedMs: round(performance.now() - startedAt), responseBytes: 0,
    })
    throw error
  }
}, { requestsPerSecond: staffStartRps, maxConcurrency: Math.min(concurrency, staffActorIds.length) }))
if (measuresReads) failures.push(...await runPool(coldStartIndices, async (_, index) => {
  await jsonRequest('bootstrap_role_coverage', index, '/api/bootstrap', {
    headers: { authorization: `Bearer ${staffSessions[index].token}` },
  })
}, Math.min(staffColdStarts, 12)))
const guestSessionIds = new Array(samples)
const readRuns = measuresReads ? await Promise.all([
  runArrival('heartbeat', indices, async (_, index) => {
    await jsonRequest('heartbeat', index, '/api/auth/presence/heartbeat', body({}, staffSessions[index % staffSessions.length].token))
  }, { requestsPerSecond: heartbeatRps, maxConcurrency: Math.min(concurrency, staffColdStarts) }),
  runArrival('bootstrap_live', indices, async (_, index) => {
    await jsonRequest('bootstrap_live', index, '/api/bootstrap', {
      headers: managerHeaders,
    }, true, (response) => {
      if (response.status !== 200) throw new Error(`完整工作台应返回200，实际${response.status}`)
    })
  }, { requestsPerSecond: readRps, maxConcurrency: concurrency }),
  runArrival('reservations', indices, async (_, index) => {
    await jsonRequest('reservations', index, '/api/reservations', { headers: managerHeaders })
  }, { requestsPerSecond: readRps, maxConcurrency: concurrency }),
  runArrival('guest_session', indices, async (_, index) => {
    const session = await jsonRequest('guest_session', index, '/api/guest/session', {
      ...body({ token: qrTokens[index % qrTokens.length] }),
      headers: { 'content-type': 'application/json', 'x-mbox-guest-id': `70000000-0000-4000-8000-${String(index).padStart(12, '0')}` },
    })
    guestSessionIds[index] = session.guestSession?.tableSessionId
  }, { requestsPerSecond: guestSessionRps, maxConcurrency: concurrency }),
]) : []
for (const runFailures of readRuns) failures.push(...runFailures)
if (measuresReads) failures.push(...await runArrival('guest_session_repeat', indices, async (_, index) => {
  const session = await jsonRequest('guest_session_repeat', index + 1, '/api/guest/session', {
    ...body({ token: qrTokens[index % qrTokens.length] }),
    headers: { 'content-type': 'application/json', 'x-mbox-guest-id': `70000000-0000-4000-8000-${String(index).padStart(12, '0')}` },
  })
  const repeatedId = session.guestSession?.tableSessionId
  if (!guestSessionIds[index] || repeatedId !== guestSessionIds[index]) throw new Error(`客户${index}重复进入生成了不同会话`)
}, { requestsPerSecond: Math.max(readRps, 20), maxConcurrency: concurrency }))

// PR regression measures write routes one at a time. Simultaneous 1/2/4/6/8
// writes per second belongs to the separate capacity profile and must not be
// presented as a representative 300-guest operating window.
if (measures('create_task_live')) failures.push(...await runArrival('create_task_live', indices, async (_, index) => {
    const table = occupiedTables[index % occupiedTables.length]
    const actor = staffSessionByActorId.get(table.actorId)
    if (!actor) throw new Error(`桌台 ${table.code} 缺少任务操作人`)
    const input = {
      tableCode: table.code, serviceTypeId: 'water', source: 'employee', note: `rc68-live-${index}`,
      idempotencyKey: `rc68-live-task-${String(index).padStart(5, '0')}`,
    }
    const task = await jsonRequest('create_task_live', index, '/api/tasks', body(input, actor.token))
    liveTaskIds[index] = task.id
    liveTaskRequests[index] = { input, token: actor.token }
  }, { requestsPerSecond: writeRps, maxConcurrency: concurrency }))
if (measures('create_quick_order_live')) failures.push(...await runArrival('create_quick_order_live', indices, async (_, index) => {
    const table = occupiedTables[index % occupiedTables.length]
    const actor = staffSessionByActorId.get(table.actorId)
    if (!actor) throw new Error(`桌台 ${table.code} 缺少点单操作人`)
    const input = {
      tableId: table.id, productId: 'product-cocktail', quantity: 1, actorId: actor.employee.id,
      idempotencyKey: `rc68-live-order-${String(index).padStart(5, '0')}`,
    }
    const order = await jsonRequest('create_quick_order_live', index, '/api/commerce/quick-orders', body(input, actor.token))
    liveOrderIds[index] = order.id
    liveOrderRequests[index] = { input, token: actor.token }
  }, { requestsPerSecond: writeRps, maxConcurrency: concurrency }))
if (measures('task_action')) failures.push(...await runArrival('task_action', taskIds, async (taskId, index) => {
    await jsonRequest('task_action', index, `/api/tasks/${encodeURIComponent(taskId)}/actions`, body({
      action: 'quick_complete', actorId: 'emp-chen', note: '负载验证完成',
      idempotencyKey: `rc68-load-task-action-${String(index).padStart(5, '0')}`,
    }, manager.token))
  }, { requestsPerSecond: writeRps, maxConcurrency: concurrency }))
if (measures('kds_start')) failures.push(...await runArrival('kds_start', kdsTaskIds, async (taskId, index) => {
    await jsonRequest('kds_start', index, `/api/commerce/kds/${encodeURIComponent(taskId)}/actions`, body({
      action: 'start', actorId: 'emp-qing', idempotencyKey: `rc68-load-kds-start-${String(index).padStart(5, '0')}`,
    }, bartenderToken))
  }, { requestsPerSecond: writeRps, maxConcurrency: concurrency }))
if (phase === 'kds_complete') {
  const preparationFailures = await runArrival('setup_kds_start', kdsTaskIds, async (taskId, index) => {
    await jsonRequest('fixture_kds_start', index, `/api/commerce/kds/${encodeURIComponent(taskId)}/actions`, body({
      action: 'start', actorId: 'emp-qing', idempotencyKey: `rc68-load-kds-start-${String(index).padStart(5, '0')}`,
    }, bartenderToken), false)
  }, { requestsPerSecond: setupWriteRps, maxConcurrency: setupConcurrency }, 'setup')
  if (preparationFailures.length) throw new Error(`KDS完成阶段准备失败：${JSON.stringify(preparationFailures.slice(0, 5))}`)
  await resetMeasuredMetricsWindow()
}
if (measures('kds_complete')) failures.push(...await runArrival('kds_complete', kdsTaskIds, async (taskId, index) => {
    await jsonRequest('kds_complete', index, `/api/commerce/kds/${encodeURIComponent(taskId)}/actions`, body({
      action: 'complete', actorId: 'emp-qing', idempotencyKey: `rc68-load-kds-complete-${String(index).padStart(5, '0')}`,
    }, bartenderToken))
  }, { requestsPerSecond: writeRps, maxConcurrency: concurrency }))

function assertUniqueIds(ids, expected, label) {
  if (ids.length !== expected || ids.some((id) => typeof id !== 'string')) {
    throw new Error(`${label}返回ID ${ids.filter(Boolean).length}/${expected}`)
  }
  if (new Set(ids).size !== expected) throw new Error(`${label}返回了重复ID`)
}

function assertSameIds(left, right, label) {
  const leftIds = [...left].sort()
  const rightIds = [...right].sort()
  if (JSON.stringify(leftIds) !== JSON.stringify(rightIds)) throw new Error(`${label}两实例读取不一致`)
}

async function authoritativeSnapshots() {
  // Use both instances after every measured write. This verifies that a 2xx
  // response became authoritative state and is immediately observable across
  // the cluster, rather than merely updating one process cache.
  return Promise.all(baseUrls.map((_, index) => jsonRequest('verify_bootstrap', index, '/api/bootstrap', {
    headers: managerHeaders,
  }, false)))
}

async function verifyWritePhaseInvariants() {
  if (measures('create_task_live')) {
    assertUniqueIds(liveTaskIds, samples, '创建任务')
    const replay = await jsonRequest('verify_task_idempotency', 1, '/api/tasks', body(liveTaskRequests[0].input, liveTaskRequests[0].token), false)
    if (replay.id !== liveTaskIds[0]) throw new Error('任务幂等重放产生了新ID')
    const snapshots = await authoritativeSnapshots()
    const expected = new Set(liveTaskIds)
    const matching = snapshots.map((snapshot) => snapshot.tasks.filter((task) => expected.has(task.id)))
    for (let snapshotIndex = 0; snapshotIndex < matching.length; snapshotIndex += 1) {
      const tasks = matching[snapshotIndex]
      if (tasks.length !== samples) throw new Error(`任务落库数量 ${tasks.length}/${samples}`)
      const invalid = tasks.filter((task) => (
        !['pending', 'escalated'].includes(task.status)
        || !task.note.startsWith('rc68-live-')
        || task.archivedAt !== null
      ))
      if (invalid.length > 0) {
        const evidence = invalid.slice(0, 5).map((task) => ({
          id: task.id,
          status: task.status,
          serviceTypeId: task.serviceTypeId,
          workflowLevel: task.workflowLevel,
          note: task.note,
        }))
        throw new Error(`任务落库状态或标识不正确：${JSON.stringify(evidence)}`)
      }
      const escalated = tasks.filter((task) => task.status === 'escalated')
      const escalationEvents = snapshots[snapshotIndex].taskEvents.filter((event) => (
        event.type === 'task.escalated.v1' && expected.has(event.taskId)
      ))
      if (
        escalated.some((task) => task.escalationLevel < 1)
        || escalationEvents.length < escalated.length
      ) {
        throw new Error(`任务SLA升级缺少级别或事件证据：升级任务${escalated.length}，升级事件${escalationEvents.length}`)
      }
    }
    assertSameIds(matching[0].map((task) => task.id), matching[1].map((task) => task.id), '任务')
  }
  if (measures('create_quick_order_live')) {
    assertUniqueIds(liveOrderIds, samples, '快捷订单')
    const replay = await jsonRequest('verify_order_idempotency', 1, '/api/commerce/quick-orders', body(liveOrderRequests[0].input, liveOrderRequests[0].token), false)
    if (replay.id !== liveOrderIds[0]) throw new Error('订单幂等重放产生了新ID')
    const snapshots = await authoritativeSnapshots()
    const expected = new Set(liveOrderIds)
    const matching = snapshots.map((snapshot) => snapshot.orderDomain.orders.filter((order) => expected.has(order.id)))
    for (let snapshotIndex = 0; snapshotIndex < matching.length; snapshotIndex += 1) {
      const orders = matching[snapshotIndex]
      if (orders.length !== samples) throw new Error(`订单落库数量 ${orders.length}/${samples}`)
      const kdsById = new Map(snapshots[snapshotIndex].orderDomain.kdsTasks.map((task) => [task.id, task]))
      const orderAudits = snapshots[snapshotIndex].auditEntries.filter((entry) => (
        entry.action === 'commerce.quick_order.v1' && expected.has(entry.objectId)
      ))
      if (orderAudits.length !== samples) throw new Error(`订单审计数量 ${orderAudits.length}/${samples}`)
      const saleMovements = (snapshots[snapshotIndex].inventoryDomain?.movements ?? []).filter((movement) => (
        movement.type === 'sale' && expected.has(movement.orderId)
      ))
      if (saleMovements.length !== samples) throw new Error(`订单库存扣减数量 ${saleMovements.length}/${samples}`)
      const printJobs = (snapshots[snapshotIndex].commercialOps?.printJobs ?? []).filter((job) => expected.has(job.orderId))
      if (printJobs.length !== samples) throw new Error(`订单打印任务数量 ${printJobs.length}/${samples}`)
      for (const order of orders) {
        if (order.status !== 'submitted' || order.items.length !== 1) throw new Error(`订单 ${order.id} 状态或品项数不正确`)
        const item = order.items[0]
        const kds = item.kdsTaskId ? kdsById.get(item.kdsTaskId) : null
        if (!kds || kds.orderId !== order.id || kds.orderItemId !== item.id || kds.status !== 'queued') {
          throw new Error(`订单 ${order.id} 与KDS关联不完整`)
        }
        if (saleMovements.filter((movement) => movement.orderId === order.id && movement.orderItemId === item.id).length !== 1) {
          throw new Error(`订单 ${order.id} 库存副作用不是恰好一次`)
        }
        if (printJobs.filter((job) => job.orderId === order.id && job.orderItemIds.includes(item.id)).length !== 1) {
          throw new Error(`订单 ${order.id} 打印副作用不是恰好一次`)
        }
      }
    }
    assertSameIds(matching[0].map((order) => order.id), matching[1].map((order) => order.id), '订单')
  }
  if (measures('task_action')) {
    assertUniqueIds(taskIds, samples, '任务准备')
    const snapshots = await authoritativeSnapshots()
    const expected = new Set(taskIds)
    const matching = snapshots.map((snapshot) => snapshot.tasks.filter((task) => expected.has(task.id)))
    for (const tasks of matching) {
      if (tasks.length !== samples || tasks.some((task) => (
        task.status !== 'confirmed'
        || task.completedBy !== 'emp-chen'
        || !task.completedAt
      ))) {
        throw new Error('任务快速完成最终状态不正确')
      }
    }
    assertSameIds(matching[0].map((task) => task.id), matching[1].map((task) => task.id), '完成任务')
  }
  if (measures('kds_start') || measures('kds_complete')) {
    assertUniqueIds(kdsTaskIds, samples, 'KDS准备')
    const expectedStatus = measures('kds_complete') ? 'completed' : 'preparing'
    const snapshots = await authoritativeSnapshots()
    const expected = new Set(kdsTaskIds)
    const matching = snapshots.map((snapshot) => snapshot.orderDomain.kdsTasks.filter((task) => expected.has(task.id)))
    for (let snapshotIndex = 0; snapshotIndex < matching.length; snapshotIndex += 1) {
      const tasks = matching[snapshotIndex]
      if (tasks.length !== samples || tasks.some((task) => task.status !== expectedStatus)) {
        throw new Error(`KDS最终状态应为${expectedStatus}`)
      }
      const auditAction = measures('kds_complete') ? 'kds.complete.v1' : 'kds.start.v1'
      const audits = snapshots[snapshotIndex].auditEntries.filter((entry) => (
        entry.action === auditAction && expected.has(entry.objectId)
      ))
      if (audits.length !== samples) throw new Error(`KDS审计数量 ${audits.length}/${samples}`)
      if (measures('kds_complete')) {
        for (const task of tasks) {
          const deliveryTasks = snapshots[snapshotIndex].tasks.filter((candidate) => (
            candidate.triggerId === `fulfillment-delivery:${task.id}`
          ))
          if (deliveryTasks.length !== 1 || task.deliveryServiceTask?.id !== deliveryTasks[0].id) {
            throw new Error(`KDS ${task.id} 配送任务不是恰好一次`)
          }
        }
      }
    }
    assertSameIds(matching[0].map((task) => task.id), matching[1].map((task) => task.id), 'KDS')
  }
}

try {
  await verifyWritePhaseInvariants()
} catch (error) {
  failures.push({ index: -1, message: error instanceof Error ? error.message : String(error) })
}
keepaliveStopped = true
clearInterval(keepaliveTimer)
await Promise.allSettled([...keepaliveRuns])
failures.push(...keepaliveFailures.map((failure, index) => ({
  index,
  message: `在线续租失败 ${failure.actorId}: ${failure.message}`,
})))

// Cache-hit latency is a different contract from a live bootstrap response.
// Measure it only after all state-changing traffic and keepalives have stopped.
const bootstrapCachedEtags = measuresReads ? await Promise.all(staffSessions.map(async (session, index) => {
  let etag = ''
  await jsonRequest('setup_bootstrap_cached_etag', index, '/api/bootstrap', {
    headers: { authorization: `Bearer ${session.token}` },
  }, false, (response) => { etag = response.headers.get('etag') ?? '' })
  if (!etag) throw new Error(`员工 ${session.employee.id} 的Bootstrap没有返回稳定ETag`)
  return etag
})) : []
if (measuresReads) failures.push(...await runArrival('bootstrap_cached', indices, async (_, index) => {
  const sessionIndex = index % staffSessions.length
  await jsonRequest('bootstrap_cached', index, '/api/bootstrap', {
    headers: { authorization: `Bearer ${staffSessions[sessionIndex].token}`, 'if-none-match': bootstrapCachedEtags[sessionIndex] },
  }, true, (response) => {
    if (response.status !== 304) throw new Error(`稳定缓存轮询应返回304，实际${response.status}`)
  })
}, { requestsPerSecond: Math.max(readRps, 20), maxConcurrency: concurrency }))

const targets = {
  staff_start_api_journey: { p95: 500, p99: 800, minSamples: staffActorIds.length * staffStartRounds },
  create_task_live: { p95: 800, p99: 1_500 }, create_quick_order_live: { p95: 1_500, p99: 2_500 },
  heartbeat: { p95: 150, p99: 300 },
  bootstrap_role_coverage: { p95: 500, p99: 800, minSamples: staffColdStarts },
  bootstrap_live: { p95: 500, p99: 800 },
  bootstrap_cached: { p95: 150, p99: 300 },
  reservations: { p95: 500, p99: 800 }, guest_session: { p95: 500, p99: 800 },
  guest_session_repeat: { p95: 300, p99: 500 },
  task_action: { p95: 800, p99: 1_500 },
  kds_start: { p95: 800, p99: 1_500 }, kds_complete: { p95: 800, p99: 1_500 },
}
const activeTargets = Object.fromEntries(Object.entries(targets).filter(([label]) => observations.some((item) => item.label === label)))
const byLabel = Object.fromEntries(Object.entries(activeTargets).map(([label, target]) => {
  const rows = observations.filter((item) => item.label === label)
  const successful = rows.filter((item) => item.status >= 200 && item.status < 400)
  const times = successful.map((item) => item.elapsedMs)
  const p95Ms = round(percentile(times, 0.95))
  const p99Ms = round(percentile(times, 0.99))
  return [label, {
    samples: rows.length, successful: successful.length, failures: rows.length - successful.length,
    p50Ms: round(percentile(times, 0.5)), p95Ms, p99Ms, maxMs: round(Math.max(0, ...times)),
    statusCounts: Object.fromEntries([...new Set(rows.map((item) => item.status))].sort().map((status) => [status, rows.filter((item) => item.status === status).length])),
    responseBytesP95: round(percentile(successful.map((item) => item.responseBytes), 0.95)),
    responseBytesMax: Math.max(0, ...successful.map((item) => item.responseBytes)),
    target, passed: rows.length >= (target.minSamples ?? samples) && successful.length === rows.length && p95Ms <= target.p95 && p99Ms <= target.p99,
  }]
}))
const { measuredSchedule, setupSchedule } = evaluatePhaseArrivalSchedules(
  measuredArrivalMetrics,
  setupArrivalMetrics,
  schedulingDelayP95LimitMs,
)
const report = {
  model: {
    schemaVersion: 2,
    runId,
    instances: baseUrls.length, samplesPerReadOrAction: samples, kdsActionSamples: samples * 2,
    readConcurrency: concurrency, staffColdStarts, bootstrapLiveSamples: samples, bootstrapCachedSamples: samples,
    staffIdentityCount: staffSessions.length,
    staffRoleNames: [...new Set(staffSessions.map((session) => session.employee.roleName))],
    phase, setupConcurrency, routeRegressionConcurrency: concurrency,
    evidenceEligible: phase !== 'all',
    arrivalRatesPerSecond: {
      read: readRps, guestSession: guestSessionRps, heartbeat: heartbeatRps,
      setupWrite: setupWriteRps, write: writeRps, staffStart: staffStartRps,
    },
    workloadInterpretation: '提交级单路由性能回归；不是代表性经营峰值，也不是正式容量结论',
    rateMultipliersOverFullNightAverage: {
      guestSession: round(guestSessionRps / venueModel.guestArrivalsPerSecond),
      heartbeat: round(heartbeatRps / venueModel.employeeHeartbeatsPerSecond),
    },
    venue: venueModel,
    kdsWriteProfile,
    arrivalMetrics: measuredArrivalMetrics,
    setupArrivalMetrics,
    schedulingDelayP95LimitMs,
    measuredSchedule,
    setupSchedule,
    schedule: measuredSchedule,
  },
  totals: { measured: observations.length, failures: observations.filter((item) => item.status < 200 || item.status >= 400).length, workflowFailures: failures.length },
  byLabel, failureSamples: failures.slice(0, 10),
  passed: failures.length === 0 && measuredSchedule.passed && Object.values(byLabel).every((entry) => entry.passed),
}
const serializedReport = `${JSON.stringify(report, null, 2)}\n`
const reportPath = process.env.MBOX_LOAD_REPORT_PATH?.trim()
if (reportPath) await writeFile(resolve(reportPath), serializedReport, 'utf8')
process.stdout.write(serializedReport)
if (!report.passed) process.exitCode = 1
