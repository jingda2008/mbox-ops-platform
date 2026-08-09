import { signStaticTableQrToken } from '../dist-server/server/table-access.js'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const baseUrls = (process.env.MBOX_LOAD_BASE_URLS ?? 'http://127.0.0.1:18791,http://127.0.0.1:18792')
  .split(',').map((value) => value.trim().replace(/\/$/, '')).filter(Boolean)
const samples = Number(process.env.MBOX_LOAD_SAMPLES ?? 300)
const concurrency = Number(process.env.MBOX_LOAD_CONCURRENCY ?? 60)
// Ten simultaneous order/task submissions already exceed the expected burst
// for a 12-person team and roughly 300 guests over one business night. A
// separate 20-write stress observation is retained in the release evidence,
// but it must not be confused with the production SLO workload model.
const setupConcurrency = Number(process.env.MBOX_LOAD_SETUP_CONCURRENCY ?? 10)
const writeConcurrency = Number(process.env.MBOX_LOAD_WRITE_CONCURRENCY ?? 6)
const kdsConcurrency = Number(process.env.MBOX_LOAD_KDS_CONCURRENCY ?? 3)
const staffColdStarts = Number(process.env.MBOX_LOAD_STAFF_COLD_STARTS ?? 12)
const accessCode = process.env.MBOX_LOAD_ACCESS_CODE ?? 'MBOX521'
const qrSecret = process.env.MBOX_QR_SECRET ?? 'rc68-qr-secret-0123456789abcdef0123456789abcdef'
const pins = {
  'emp-chen': process.env.MBOX_LOAD_MANAGER_PIN ?? '5215',
  'emp-qing': process.env.MBOX_LOAD_BARTENDER_PIN ?? '5216',
}
if (baseUrls.length < 2) throw new Error('混合负载必须配置至少两个API实例')
if (!Number.isSafeInteger(samples) || samples < 300) throw new Error('每个关键路由至少需要300个样本')
if (!Number.isSafeInteger(concurrency) || concurrency < 60 || concurrency > 100) throw new Error('客户与读取并发必须是60至100')
if (!Number.isSafeInteger(setupConcurrency) || setupConcurrency < 1 || setupConcurrency > 20) throw new Error('准备数据并发必须是1至20')
if (!Number.isSafeInteger(writeConcurrency) || writeConcurrency < 1 || writeConcurrency > 20) throw new Error('任务写并发必须是1至20')
if (!Number.isSafeInteger(kdsConcurrency) || kdsConcurrency < 1 || kdsConcurrency > 10) throw new Error('KDS并发必须是1至10')
if (!Number.isSafeInteger(staffColdStarts) || staffColdStarts < 1 || staffColdStarts > 50) throw new Error('员工冷启动样本必须是1至50')

const observations = []
const keepaliveFailures = []
function percentile(values, fraction) {
  if (!values.length) return 0
  const sorted = values.toSorted((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0
}
function round(value) { return Math.round(value * 10) / 10 }
function targetUrl(index, path) { return `${baseUrls[index % baseUrls.length]}${path}` }
async function jsonRequest(label, index, path, init = {}, measured = true, onResponse) {
  const startedAt = performance.now()
  let response
  try {
    response = await fetch(targetUrl(index, path), init)
    const text = await response.text()
    const elapsedMs = round(performance.now() - startedAt)
    if (measured) observations.push({ label, status: response.status, elapsedMs })
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
async function login(actorId) {
  return jsonRequest('setup_login', 0, '/api/auth/pilot-login', body({
    accessCode, actorId, employeePin: pins[actorId],
  }), false)
}

for (let index = 0; index < baseUrls.length; index += 1) {
  await jsonRequest('setup_health', index, '/api/ready', {}, false)
}
const manager = await login('emp-chen')
const bartender = await login('emp-qing')
const managerHeaders = { authorization: `Bearer ${manager.token}` }
const bartenderToken = bartender.token
const qrToken = signStaticTableQrToken({
  storeId: 'mbox-lujiazui', tableCode: 'L01', tokenVersion: 1, issuedAt: Date.now(),
}, qrSecret)
const indices = Array.from({ length: samples }, (_, index) => index)
const setupFailures = []

// Model the real staff client from login onward. Large fixture preparation is
// intentionally part of the candidate exercise and may outlive one lease.
await Promise.all([
  jsonRequest('setup_heartbeat', 0, '/api/auth/presence/heartbeat', body({}, manager.token), false),
  jsonRequest('setup_heartbeat', 1, '/api/auth/presence/heartbeat', body({}, bartenderToken), false),
])
let keepaliveChain = Promise.resolve()
const renewActiveStaff = async () => {
  const results = await Promise.allSettled([
    jsonRequest('keepalive_heartbeat', 0, '/api/auth/presence/heartbeat', body({}, manager.token), false),
    jsonRequest('keepalive_heartbeat', 1, '/api/auth/presence/heartbeat', body({}, bartenderToken), false),
  ])
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      keepaliveFailures.push({
        actorId: index === 0 ? 'emp-chen' : 'emp-qing',
        message: result.reason instanceof Error ? result.reason.message : String(result.reason),
      })
    }
  })
}
const keepaliveTimer = setInterval(() => {
  keepaliveChain = keepaliveChain.then(renewActiveStaff)
}, 30_000)
keepaliveTimer.unref()

const taskIds = new Array(samples)
setupFailures.push(...await runPool(indices, async (_, index) => {
  const task = await jsonRequest('create_task', index, '/api/tasks', body({
    tableCode: 'L01', serviceTypeId: 'water', source: 'employee', note: `rc68-load-${index}`,
    idempotencyKey: `rc68-load-task-${String(index).padStart(5, '0')}`,
  }, manager.token))
  taskIds[index] = task.id
}, setupConcurrency))

const kdsTaskIds = new Array(samples)
setupFailures.push(...await runPool(indices, async (_, index) => {
  const order = await jsonRequest('create_quick_order', index, '/api/commerce/quick-orders', body({
    tableId: 'table-l01', productId: 'product-cocktail', quantity: 1, actorId: 'emp-chen',
    idempotencyKey: `rc68-load-order-${String(index).padStart(5, '0')}`,
  }, manager.token))
  const itemId = order.items?.[0]?.id
  if (!itemId) throw new Error('快捷订单未返回品项ID')
  kdsTaskIds[index] = `kds:${order.id}:${itemId}`
}, setupConcurrency))
if (setupFailures.length) throw new Error(`负载数据准备失败：${JSON.stringify(setupFailures.slice(0, 5))}`)

const failures = []
failures.push(...await runPool(indices, async (_, index) => {
  await jsonRequest('heartbeat', index, '/api/auth/presence/heartbeat', body({}, manager.token))
}))
const coldStartIndices = Array.from({ length: staffColdStarts }, (_, index) => index)
failures.push(...await runPool(coldStartIndices, async (_, index) => {
  await jsonRequest('bootstrap_cold', index, '/api/bootstrap', { headers: managerHeaders })
}, Math.min(staffColdStarts, 12)))
let bootstrapEtag = ''
await jsonRequest('setup_bootstrap_etag', 0, '/api/bootstrap', { headers: managerHeaders }, false, (response) => {
  bootstrapEtag = response.headers.get('etag') ?? ''
})
if (!bootstrapEtag) throw new Error('Bootstrap没有返回ETag，无法验证真实客户端增量轮询')
failures.push(...await runPool(indices, async (_, index) => {
  await jsonRequest('bootstrap_cached', index, '/api/bootstrap', {
    headers: { ...managerHeaders, 'if-none-match': bootstrapEtag },
  })
}))
failures.push(...await runPool(indices, async (_, index) => {
  await jsonRequest('reservations', index, '/api/reservations', { headers: managerHeaders })
}))
failures.push(...await runPool(indices, async (_, index) => {
  await jsonRequest('guest_session', index, '/api/guest/session', {
    ...body({ token: qrToken }),
    headers: { 'content-type': 'application/json', 'x-mbox-guest-id': `70000000-0000-4000-8000-${String(index).padStart(12, '0')}` },
  })
}))
failures.push(...await runPool(taskIds, async (taskId, index) => {
  await jsonRequest('task_action', index, `/api/tasks/${encodeURIComponent(taskId)}/actions`, body({
    action: 'quick_complete', actorId: 'emp-chen', note: '负载验证完成',
    idempotencyKey: `rc68-load-task-action-${String(index).padStart(5, '0')}`,
  }, manager.token))
}, writeConcurrency))
// The task-action phase can also exceed one lease interval on a constrained
// validation machine. KDS is a separate active-client workload.
await jsonRequest('setup_heartbeat', 1, '/api/auth/presence/heartbeat', body({}, bartenderToken), false)
failures.push(...await runPool(kdsTaskIds, async (taskId, index) => {
  await jsonRequest('kds_action', index, `/api/commerce/kds/${encodeURIComponent(taskId)}/actions`, body({
    action: 'start', actorId: 'emp-qing', idempotencyKey: `rc68-load-kds-start-${String(index).padStart(5, '0')}`,
  }, bartenderToken))
  await jsonRequest('kds_action', index, `/api/commerce/kds/${encodeURIComponent(taskId)}/actions`, body({
    action: 'complete', actorId: 'emp-qing', idempotencyKey: `rc68-load-kds-complete-${String(index).padStart(5, '0')}`,
  }, bartenderToken))
}, kdsConcurrency))
clearInterval(keepaliveTimer)
await keepaliveChain
failures.push(...keepaliveFailures.map((failure, index) => ({
  index,
  message: `在线续租失败 ${failure.actorId}: ${failure.message}`,
})))

const targets = {
  create_task: { p95: 800, p99: 1_500 }, create_quick_order: { p95: 1_500, p99: 2_500 },
  heartbeat: { p95: 150, p99: 300 },
  bootstrap_cold: { p95: 500, p99: 800, minSamples: staffColdStarts },
  bootstrap_cached: { p95: 150, p99: 300 },
  reservations: { p95: 500, p99: 800 }, guest_session: { p95: 500, p99: 800 },
  task_action: { p95: 800, p99: 1_500 }, kds_action: { p95: 800, p99: 1_500 },
}
const byLabel = Object.fromEntries(Object.entries(targets).map(([label, target]) => {
  const rows = observations.filter((item) => item.label === label)
  const successful = rows.filter((item) => item.status >= 200 && item.status < 400)
  const times = successful.map((item) => item.elapsedMs)
  const p95Ms = round(percentile(times, 0.95))
  const p99Ms = round(percentile(times, 0.99))
  return [label, {
    samples: rows.length, successful: successful.length, failures: rows.length - successful.length,
    p50Ms: round(percentile(times, 0.5)), p95Ms, p99Ms, maxMs: round(Math.max(0, ...times)),
    target, passed: rows.length >= (target.minSamples ?? samples) && successful.length === rows.length && p95Ms <= target.p95 && p99Ms <= target.p99,
  }]
}))
const report = {
  model: {
    instances: baseUrls.length, samplesPerReadOrAction: samples, kdsActionSamples: samples * 2,
    readConcurrency: concurrency, staffColdStarts, bootstrapCachedSamples: samples,
    setupConcurrency, taskWriteConcurrency: writeConcurrency, kdsConcurrency,
  },
  totals: { measured: observations.length, failures: observations.filter((item) => item.status < 200 || item.status >= 400).length, workflowFailures: failures.length },
  byLabel, failureSamples: failures.slice(0, 10),
  passed: failures.length === 0 && Object.values(byLabel).every((entry) => entry.passed),
}
const serializedReport = `${JSON.stringify(report, null, 2)}\n`
const reportPath = process.env.MBOX_LOAD_REPORT_PATH?.trim()
if (reportPath) await writeFile(resolve(reportPath), serializedReport, 'utf8')
process.stdout.write(serializedReport)
if (!report.passed) process.exitCode = 1
