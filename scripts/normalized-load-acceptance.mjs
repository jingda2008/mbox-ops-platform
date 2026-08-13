import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const SCHEMA_VERSION = 'normalized-load-acceptance-v2'
const DEFAULT_RPS = 5
const DEFAULT_DURATION_SECONDS = 60
const DEFAULT_ENDPOINTS = Object.freeze({
  ready: '/api/ready',
  tableOpen: '/api/table-sessions',
  tableBeginClose: '/api/table-sessions/{sessionId}/begin-closing',
  tableClose: '/api/table-sessions/{sessionId}/close',
  assistedOrderContext: '/api/commerce/assisted-order-contexts',
  orderSubmit: '/api/commerce/orders',
  kdsAction: '/api/commerce/kds/{taskId}/actions',
  serviceCreate: '/api/service-tasks',
  serviceTransition: '/api/service-tasks/{taskId}/{transition}',
})

const DEFAULT_THRESHOLDS = Object.freeze({
  targetRps: DEFAULT_RPS,
  minimumAchievedRpsRatio: 0.98,
  maximumErrorRate: 0.001,
  maximumP95Ms: 500,
  maximumP99Ms: 1_000,
  maximumSchedulingDelayP95Ms: 100,
  maximumSchedulingDelayP99Ms: 200,
  maximumDrainMs: 1_000,
  maximumBacklogSlopePerSecond: 0.1,
})

const IDEMPOTENCY_CLASSES = Object.freeze({
  replay: 'replay',
  payloadMismatch: 'payload_mismatch',
  inProgress: 'in_progress',
  unknownConflict: 'unknown_conflict',
  none: 'none',
})

export function percentile(values, fraction) {
  if (!Array.isArray(values) || values.length === 0) return 0
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new TypeError('fraction must be between 0 and 1')
  }
  const ordered = values.toSorted((left, right) => left - right)
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * fraction) - 1))] ?? 0
}

export function classifyIdempotencyConflict({ status = 0, body, headers = {} } = {}) {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value).toLowerCase()]),
  )
  const code = String(body?.code ?? body?.errorCode ?? body?.error?.code ?? '').toUpperCase()
  const replayed = normalizedHeaders['x-idempotency-replayed'] === 'true'
    || code.includes('IDEMPOTENCY_REPLAY')
    || body?.replayed === true
  if (replayed) return IDEMPOTENCY_CLASSES.replay
  if (status !== 409) return IDEMPOTENCY_CLASSES.none
  if (code.includes('PAYLOAD') || code.includes('FINGERPRINT') || code.includes('MISMATCH')) {
    return IDEMPOTENCY_CLASSES.payloadMismatch
  }
  if (code.includes('IN_PROGRESS') || code.includes('PROCESSING') || code.includes('PENDING')) {
    return IDEMPOTENCY_CLASSES.inProgress
  }
  return IDEMPOTENCY_CLASSES.unknownConflict
}

export function summarizeObservations(observations) {
  const durations = observations.map((item) => item.elapsedMs)
  const errors = observations.filter((item) => item.outcome === 'error')
  const idempotencyConflicts = countIdempotencyClasses(observations)
  return {
    requests: observations.length,
    successes: observations.length - errors.length,
    errors: errors.length,
    errorRate: observations.length === 0 ? 0 : round(errors.length / observations.length, 6),
    latencyMs: {
      min: durations.length === 0 ? 0 : round(Math.min(...durations)),
      average: durations.length === 0 ? 0 : round(durations.reduce((total, value) => total + value, 0) / durations.length),
      p50: round(percentile(durations, 0.5)),
      p95: round(percentile(durations, 0.95)),
      p99: round(percentile(durations, 0.99)),
      max: durations.length === 0 ? 0 : round(Math.max(...durations)),
    },
    statuses: countBy(observations, (item) => String(item.status)),
    errorCodes: countBy(errors, (item) => item.errorCode ?? 'UNKNOWN'),
    idempotencyConflicts,
  }
}

export function evaluateAcceptance(report, configuredThresholds = {}) {
  const thresholds = validateThresholds({ ...DEFAULT_THRESHOLDS, ...configuredThresholds })
  const checks = []
  const add = (id, passed, actual, expected) => checks.push({ id, passed, actual, expected })

  add('workload.target_rps', report.workload.targetRps === thresholds.targetRps,
    report.workload.targetRps, thresholds.targetRps)

  for (const [scenario, result] of Object.entries(report.scenarios)) {
    add(`${scenario}.achieved_rps`, result.arrival.achievedLaunchRps >= thresholds.targetRps * thresholds.minimumAchievedRpsRatio,
      result.arrival.achievedLaunchRps, `>= ${round(thresholds.targetRps * thresholds.minimumAchievedRpsRatio)}`)
    add(`${scenario}.completion_throughput`, result.arrival.completionThroughputRps >= thresholds.targetRps * thresholds.minimumAchievedRpsRatio,
      result.arrival.completionThroughputRps, `>= ${round(thresholds.targetRps * thresholds.minimumAchievedRpsRatio)}`)
    add(`${scenario}.error_rate`, result.summary.errorRate <= thresholds.maximumErrorRate,
      result.summary.errorRate, `<= ${thresholds.maximumErrorRate}`)
    add(`${scenario}.p95`, result.summary.latencyMs.p95 <= thresholds.maximumP95Ms,
      result.summary.latencyMs.p95, `<= ${thresholds.maximumP95Ms}ms`)
    add(`${scenario}.p99`, result.summary.latencyMs.p99 <= thresholds.maximumP99Ms,
      result.summary.latencyMs.p99, `<= ${thresholds.maximumP99Ms}ms`)
    add(`${scenario}.scheduling_delay_p95`, result.arrival.schedulingDelayP95Ms <= thresholds.maximumSchedulingDelayP95Ms,
      result.arrival.schedulingDelayP95Ms, `<= ${thresholds.maximumSchedulingDelayP95Ms}ms`)
    add(`${scenario}.scheduling_delay_p99`, result.arrival.schedulingDelayP99Ms <= thresholds.maximumSchedulingDelayP99Ms,
      result.arrival.schedulingDelayP99Ms, `<= ${thresholds.maximumSchedulingDelayP99Ms}ms`)
    add(`${scenario}.final_backlog`, result.backlog.final === 0, result.backlog.final, 0)
    add(`${scenario}.backlog_slope`, result.backlog.slopePerSecond <= thresholds.maximumBacklogSlopePerSecond,
      result.backlog.slopePerSecond, `<= ${thresholds.maximumBacklogSlopePerSecond}/s`)
    add(`${scenario}.drain_time`, result.backlog.drainMs <= thresholds.maximumDrainMs,
      result.backlog.drainMs, `<= ${thresholds.maximumDrainMs}ms`)
  }

  add('kds.duplicate_claims', report.consistency.kdsDuplicateClaims === 0,
    report.consistency.kdsDuplicateClaims, 0)
  add('kds.inconsistent_states', report.consistency.kdsInconsistentStates === 0,
    report.consistency.kdsInconsistentStates, 0)
  add('idempotency.unknown_conflicts', report.consistency.idempotencyConflicts.unknownConflict === 0,
    report.consistency.idempotencyConflicts.unknownConflict, 0)
  add('idempotency.payload_mismatch', report.consistency.idempotencyConflicts.payloadMismatch === 0,
    report.consistency.idempotencyConflicts.payloadMismatch, 0)
  add('idempotency.in_progress', report.consistency.idempotencyConflicts.inProgress === 0,
    report.consistency.idempotencyConflicts.inProgress, 0)

  return {
    passed: checks.every((check) => check.passed),
    thresholds,
    checks,
    failures: checks.filter((check) => !check.passed).map((check) => check.id),
  }
}

export async function runNormalizedLoadAcceptance(options = {}) {
  const targetRps = finitePositive(options.targetRps ?? DEFAULT_RPS, 'targetRps')
  const durationSeconds = finitePositive(options.durationSeconds ?? DEFAULT_DURATION_SECONDS, 'durationSeconds')
  const requestCount = options.requestsPerScenario === undefined
    ? Math.max(2, Math.floor(targetRps * durationSeconds))
    : positiveInteger(options.requestsPerScenario, 'requestsPerScenario')
  const runId = options.runId ?? `normalized-load-${randomUUID()}`
  const baseUrl = normalizeBaseUrl(options.baseUrl)
  const endpoints = { ...DEFAULT_ENDPOINTS, ...options.endpoints }
  const fixtures = validateFixtures(options.fixtures ?? (options.transport ? createMockFixtures() : null))
  const transport = options.transport ?? createHttpTransport({
    baseUrl,
    token: options.serviceToken ?? options.token,
    timeoutMs: options.timeoutMs ?? 5_000,
  })
  const productionTransport = options.productionTransport
    ?? (options.transport ? transport : createHttpTransport({
      baseUrl,
      token: options.productionToken,
      timeoutMs: options.timeoutMs ?? 5_000,
    }))
  const startedAt = new Date().toISOString()
  const context = {
    runId,
    transport,
    productionTransport,
    endpoints,
    fixtures,
    targetRps,
    requestCount,
    maxConcurrency: options.maxConcurrency ?? 20,
  }

  if (options.skipReadyCheck !== true) {
    await transport.request({ method: 'GET', path: endpoints.ready, label: 'ready' })
  }

  const scenarioResults = {}
  const tableResult = await runScenario('table_open', context, runTableOpenOperation)
  scenarioResults.tableOpen = tableResult.result
  const sessions = await openFixtureSessions(context)

  const orderResult = await runScenario('order_submit', { ...context, sessions }, runOrderSubmitOperation)
  scenarioResults.orderSubmit = orderResult.result
  const queuedKdsTaskIds = orderResult.outputs.flatMap((item) => item.kdsTaskIds ?? [])

  const claimedKdsTaskIds = new Set()
  let kdsDuplicateClaims = 0
  let kdsInconsistentStates = 0
  const kdsResult = await runScenario('kds_claim_complete', {
    ...context,
    queuedKdsTaskIds,
    claimedKdsTaskIds,
    onDuplicateClaim: () => { kdsDuplicateClaims += 1 },
    onInconsistentState: () => { kdsInconsistentStates += 1 },
  }, runKdsOperation)
  scenarioResults.kdsPrepareComplete = kdsResult.result
  const expectedKdsTaskIds = new Set(queuedKdsTaskIds)
  for (const taskId of expectedKdsTaskIds) {
    if (!claimedKdsTaskIds.has(taskId)) kdsInconsistentStates += 1
  }
  for (const taskId of claimedKdsTaskIds) {
    if (!expectedKdsTaskIds.has(taskId)) kdsInconsistentStates += 1
  }

  const serviceResult = await runScenario('service_task_flow', { ...context, sessions }, runServiceTaskOperation)
  scenarioResults.serviceTaskFlow = serviceResult.result

  const sessionCleanup = options.independentDatabasePerRun === true
    ? { attempted: false, reason: 'isolated_database_is_dropped_after_run' }
    : { attempted: true, reason: 'shared_test_environment' }
  if (sessionCleanup.attempted) await closeSessionsBestEffort({ context, sessions })

  const allObservations = Object.values(scenarioResults).flatMap((scenario) => scenario.observations)
  const idempotencyConflicts = countIdempotencyClasses(allObservations)
  const report = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    run: {
      runId,
      mode: options.mode ?? (options.transport ? 'injected' : 'http'),
      baseUrl: baseUrl ? redactUrl(baseUrl) : null,
      sourceCommitSha: options.sourceCommitSha ?? null,
      evidenceEligible: options.evidenceEligible === true,
      startedAt,
      finishedAt: new Date().toISOString(),
    },
    workload: {
      model: 'route_isolation',
      independentDatabasePerRun: options.independentDatabasePerRun === true,
      targetRps,
      durationSeconds,
      requestsPerScenario: requestCount,
      sessionCleanup,
      scenarioOrder: ['tableOpen', 'orderSubmit', 'kdsPrepareComplete', 'serviceTaskFlow'],
    },
    scenarios: Object.fromEntries(Object.entries(scenarioResults).map(([name, result]) => [name, stripObservations(result)])),
    consistency: {
      kdsDuplicateClaims,
      kdsInconsistentStates,
      idempotencyConflicts: {
        replay: idempotencyConflicts.replay,
        payloadMismatch: idempotencyConflicts.payloadMismatch,
        inProgress: idempotencyConflicts.inProgress,
        unknownConflict: idempotencyConflicts.unknownConflict,
      },
    },
  }
  report.gate = evaluateAcceptance(report, options.thresholds)
  return report
}

export function createMockTransport(options = {}) {
  const latencyMs = options.latencyMs ?? 2
  const sessions = new Map()
  const kdsQueue = []
  const claimed = new Set()
  const completed = new Set()
  const serviceTasks = new Map()
  let sequence = 0

  return {
    async request(request) {
      if (latencyMs > 0) await wait(latencyMs)
      const body = request.body ?? {}
      if (request.label === 'ready') return response(200, { status: 'ready' })
      if (request.label === 'table_open' || request.label === 'table_open_fixture') {
        const sessionId = mockUuid(++sequence)
        const session = { id: sessionId, status: 'open', tableId: body.tableId }
        sessions.set(sessionId, session)
        return response(201, { data: { ...session, publicId: `session-${sequence}` } })
      }
      if (request.label === 'table_begin_close') {
        const session = sessions.get(body.sessionId)
        if (session) session.status = 'closing'
        return response(200, { data: { id: body.sessionId, status: 'closing' } })
      }
      if (request.label === 'table_close') {
        const session = sessions.get(body.sessionId)
        if (session) session.status = 'closed'
        return response(200, { data: { id: body.sessionId, status: 'closed' } })
      }
      if (request.label === 'assisted_order_context') {
        return response(201, { data: { token: `a${String(++sequence).padStart(42, '0')}` } })
      }
      if (request.label === 'order_submit') {
        const orderId = mockUuid(++sequence)
        const taskId = mockUuid(++sequence)
        kdsQueue.push(taskId)
        return response(201, { id: orderId, status: 'submitted', kdsTasks: [{ id: taskId }] })
      }
      if (request.label === 'kds_start') {
        claimed.add(body.taskId)
        return response(200, {
          id: body.taskId,
          status: 'preparing',
          normalizedStatus: 'preparing',
          stationCode: 'bar',
        })
      }
      if (request.label === 'kds_complete') {
        if (!claimed.has(body.taskId)) return response(409, { code: 'KDS_TASK_NOT_STARTED' })
        completed.add(body.taskId)
        return response(200, {
          id: body.taskId,
          status: 'completed',
          normalizedStatus: 'ready',
          stationCode: 'bar',
        })
      }
      if (request.label === 'service_create') {
        const taskId = mockUuid(++sequence)
        serviceTasks.set(taskId, 'pending')
        return response(201, { data: { id: taskId, status: 'pending' } })
      }
      if (request.label === 'service_acknowledge' || request.label === 'service_start' || request.label === 'service_complete') {
        const status = request.label === 'service_acknowledge'
          ? 'acknowledged'
          : request.label === 'service_start' ? 'in_progress' : 'completed'
        serviceTasks.set(body.taskId, status)
        return response(200, { data: { id: body.taskId, status } })
      }
      return response(404, { code: 'MOCK_ROUTE_NOT_FOUND' })
    },
    inspect() {
      return { sessions, kdsQueue, claimed, completed, serviceTasks }
    },
  }
}

function createHttpTransport({ baseUrl, token, timeoutMs }) {
  if (!baseUrl) throw new Error('BASE_URL is required unless --mock is used')
  if (!nonBlank(token)) throw new Error('service and production authorization tokens are required for a real service run')
  return {
    async request({ method, path, body, label, idempotencyKey, headers: requestHeaders = {} }) {
      const headers = {
        accept: 'application/json',
        'x-mbox-acceptance-run': 'normalized-v1',
        ...requestHeaders,
      }
      if (body !== undefined) headers['content-type'] = 'application/json'
      if (idempotencyKey) headers['idempotency-key'] = idempotencyKey
      if (token) headers.authorization = `Bearer ${token}`
      const started = performance.now()
      try {
        const result = await fetch(`${baseUrl}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        })
        const text = await result.text()
        let parsed = null
        try { parsed = text ? JSON.parse(text) : null }
        catch { parsed = { message: text.slice(0, 200) } }
        return {
          status: result.status,
          ok: result.ok,
          body: parsed,
          headers: Object.fromEntries(result.headers.entries()),
          elapsedMs: performance.now() - started,
          label,
        }
      } catch (error) {
        return {
          status: 0,
          ok: false,
          body: { code: 'NETWORK_ERROR', message: safeErrorMessage(error) },
          headers: {},
          elapsedMs: performance.now() - started,
          label,
        }
      }
    },
  }
}

async function runScenario(name, context, operation) {
  const observations = []
  const outputs = new Array(context.requestCount)
  const backlogAtArrivalSamples = []
  const startedAt = performance.now()
  const active = new Set()
  const launchTimes = []
  const completionTimes = []
  const schedulingDelays = []
  let launched = 0
  let completed = 0
  let peakBacklog = 0
  let maximumConcurrency = 0
  const intervalMs = 1_000 / context.targetRps

  for (let index = 0; index < context.requestCount; index += 1) {
    const dueAt = startedAt + index * intervalMs
    await wait(dueAt - performance.now())
    while (active.size >= context.maxConcurrency) await Promise.race(active)
    const launchedAt = performance.now()
    launchTimes.push(launchedAt)
    schedulingDelays.push(Math.max(0, launchedAt - dueAt))
    launched += 1
    const backlog = launched - completed
    peakBacklog = Math.max(peakBacklog, backlog)
    backlogAtArrivalSamples.push({ elapsedMs: round(launchedAt - startedAt), pending: backlog })
    const pending = Promise.resolve()
      .then(() => operation(context, index, observations))
      .then((output) => { outputs[index] = output })
      .catch((error) => {
        const measuredFailureExists = observations.some((item) => item.index === index && item.outcome === 'error')
        if (!measuredFailureExists) observations.push(failedObservation(name, index, error))
      })
      .finally(() => {
        completed += 1
        completionTimes.push(performance.now())
        active.delete(pending)
      })
    active.add(pending)
    maximumConcurrency = Math.max(maximumConcurrency, active.size)
  }

  const lastLaunchAt = launchTimes.at(-1) ?? startedAt
  await Promise.all(active)
  const finishedAt = performance.now()
  const launchDurationMs = Math.max(0, lastLaunchAt - (launchTimes[0] ?? startedAt))
  const achievedLaunchRps = launchTimes.length <= 1
    ? context.targetRps
    : (launchTimes.length - 1) / (launchDurationMs / 1_000)
  const orderedCompletionTimes = completionTimes.toSorted((left, right) => left - right)
  const completionDurationMs = Math.max(0, (orderedCompletionTimes.at(-1) ?? finishedAt) - (orderedCompletionTimes[0] ?? startedAt))
  const completionThroughputRps = completionTimes.length <= 1 || completionDurationMs === 0
    ? context.targetRps
    : (completionTimes.length - 1) / (completionDurationMs / 1_000)
  const backlog = summarizeBacklog(backlogAtArrivalSamples, peakBacklog, launched - completed, finishedAt - lastLaunchAt)
  const result = {
    summary: summarizeObservations(observations),
    arrival: {
      targetRps: context.targetRps,
      achievedLaunchRps: round(achievedLaunchRps),
      completionThroughputRps: round(completionThroughputRps),
      requests: context.requestCount,
      maximumConcurrency,
      schedulingDelayP95Ms: round(percentile(schedulingDelays, 0.95)),
      schedulingDelayP99Ms: round(percentile(schedulingDelays, 0.99)),
      durationMs: round(finishedAt - startedAt),
    },
    backlog,
    observations,
  }
  return { result, outputs }
}

async function runTableOpenOperation(context, index, observations) {
  const tableId = context.fixtures.tableIds[index % context.fixtures.tableIds.length]
  const idempotencyKey = `${context.runId}:table-open:${index}`
  const result = await measuredRequest(context, observations, {
    method: 'POST', path: context.endpoints.tableOpen, label: 'table_open', idempotencyKey,
    body: {
      tableId,
      guestCount: 2,
      employeeId: context.fixtures.serviceEmployeeId,
      guestProfileSnapshot: { source: 'load_acceptance' },
    },
  }, index)
  const session = responseData(result.body)
  if (result.ok && !nonBlank(session?.id)) throw new Error('table open response did not include session id')
  if (result.ok) {
    await beginCloseSession(context, session, `${context.runId}:table-begin-close:${index}`)
    await context.transport.request({
      method: 'POST',
      path: interpolate(context.endpoints.tableClose, { sessionId: session.id }),
      label: 'table_close',
      body: { sessionId: session.id, employeeId: context.fixtures.serviceEmployeeId },
      idempotencyKey: `${context.runId}:table-close:${index}`,
    })
  }
  return { session }
}

async function openFixtureSessions(context) {
  const results = await Promise.all(context.fixtures.tableIds.map(async (tableId, index) => {
    const result = await context.transport.request({
      method: 'POST',
      path: context.endpoints.tableOpen,
      label: 'table_open_fixture',
      body: {
        tableId,
        guestCount: 2,
        employeeId: context.fixtures.serviceEmployeeId,
        guestProfileSnapshot: { source: 'load_acceptance' },
      },
      idempotencyKey: `${context.runId}:table-open-fixture:${index}`,
    })
    const session = responseData(result.body)
    if (!result.ok || !nonBlank(session?.id) || !nonBlank(session?.tableId)) {
      throw new Error(`failed to open table fixture ${index + 1}`)
    }
    const assisted = await context.transport.request({
      method: 'POST',
      path: context.endpoints.assistedOrderContext,
      label: 'assisted_order_context',
      body: { tableSessionId: session.id, employeeId: context.fixtures.serviceEmployeeId },
    })
    const token = responseData(assisted.body)?.token
    if (!assisted.ok || !nonBlank(token)) throw new Error(`failed to bind assisted order fixture ${index + 1}`)
    return { ...session, assistedOrderContextToken: token }
  }))
  return results
}

async function runOrderSubmitOperation(context, index, observations) {
  const session = context.sessions[index % context.sessions.length]
  if (!session?.id) throw new Error('order scenario requires an open table session fixture')
  const result = await measuredRequest(context, observations, {
    method: 'POST', path: context.endpoints.orderSubmit, label: 'order_submit',
    idempotencyKey: `${context.runId}:order-submit:${index}`,
    body: {
      tableSessionId: session.id,
      employeeId: context.fixtures.serviceEmployeeId,
      items: [{ productId: context.fixtures.productId, quantity: 1 }],
      settlementMode: 'table_tab',
    },
    headers: { 'x-assisted-order-context': session.assistedOrderContextToken },
  }, index)
  const taskIds = result.body?.kdsTaskIds ?? result.body?.kdsTasks?.map((task) => task.id) ?? []
  if (result.ok && taskIds.length === 0) throw new Error('order response did not include KDS task ids')
  return { order: result.body, kdsTaskIds: taskIds }
}

async function runKdsOperation(context, index, observations) {
  const taskId = context.queuedKdsTaskIds[index]
  if (!nonBlank(taskId)) {
    context.onInconsistentState()
    throw new Error('order scenario did not provide a KDS task id')
  }
  if (context.claimedKdsTaskIds.has(taskId)) context.onDuplicateClaim()
  context.claimedKdsTaskIds.add(taskId)
  const productionContext = { ...context, transport: context.productionTransport }
  const start = await measuredRequest(productionContext, observations, {
    method: 'POST', path: interpolate(context.endpoints.kdsAction, { taskId }), label: 'kds_start',
    idempotencyKey: `${context.runId}:kds-start:${taskId}`,
    body: { taskId, action: 'start', employeeId: context.fixtures.productionEmployeeId },
  }, index)
  if (start.ok && start.body?.normalizedStatus !== 'preparing') context.onInconsistentState()
  if (start.ok && start.body?.stationCode !== context.fixtures.stationCode) context.onInconsistentState()
  const complete = await measuredRequest(productionContext, observations, {
    method: 'POST', path: interpolate(context.endpoints.kdsAction, { taskId }), label: 'kds_complete',
    idempotencyKey: `${context.runId}:kds-complete:${taskId}`,
    body: { taskId, action: 'complete', employeeId: context.fixtures.productionEmployeeId },
  }, index)
  if (complete.ok && complete.body?.normalizedStatus !== 'ready') context.onInconsistentState()
  if (complete.ok && complete.body?.stationCode !== context.fixtures.stationCode) context.onInconsistentState()
  return { start: start.body, complete: complete.body }
}

async function runServiceTaskOperation(context, index, observations) {
  const session = context.sessions[index % context.sessions.length]
  if (!session?.id) throw new Error('service scenario requires an open table session fixture')
  const created = await measuredRequest(context, observations, {
    method: 'POST', path: context.endpoints.serviceCreate, label: 'service_create',
    idempotencyKey: `${context.runId}:service-create:${index}`,
    body: {
      tableId: session.tableId,
      tableSessionId: session.id,
      taskType: 'water',
      title: '压测加水任务',
      priority: 'normal',
      employeeId: context.fixtures.serviceEmployeeId,
    },
  }, index)
  const taskId = responseData(created.body)?.id
  if (!created.ok || !nonBlank(taskId)) throw new Error('service task response did not include task id')
  for (const transition of ['acknowledge', 'start', 'complete']) {
    const expectedStatus = transition === 'acknowledge'
      ? 'acknowledged'
      : transition === 'start' ? 'in_progress' : 'completed'
    const transitioned = await measuredRequest(context, observations, {
      method: 'POST',
      path: interpolate(context.endpoints.serviceTransition, { taskId, transition }),
      label: `service_${transition}`,
      idempotencyKey: `${context.runId}:service-${transition}:${taskId}`,
      body: { taskId, employeeId: context.fixtures.serviceEmployeeId },
    }, index)
    if (!transitioned.ok || responseData(transitioned.body)?.status !== expectedStatus) {
      throw new Error(`service task did not reach ${expectedStatus}`)
    }
  }
  return { taskId }
}

async function measuredRequest(context, observations, request, index) {
  const started = performance.now()
  const result = await context.transport.request(request)
  const elapsedMs = Number.isFinite(result.elapsedMs) ? result.elapsedMs : performance.now() - started
  const idempotencyClass = classifyIdempotencyConflict(result)
  const acceptedReplay = idempotencyClass === IDEMPOTENCY_CLASSES.replay
  const observation = {
    label: request.label,
    index,
    status: result.status ?? 0,
    elapsedMs: round(elapsedMs),
    outcome: result.ok || acceptedReplay ? 'success' : 'error',
    idempotencyClass,
    errorCode: result.ok ? null : safeCode(result.body),
  }
  observations.push(observation)
  if (!result.ok && !acceptedReplay) {
    throw new Error(`${request.label} failed with ${result.status ?? 0} ${observation.errorCode ?? 'UNKNOWN'}`)
  }
  return result
}

async function closeSessionsBestEffort({ context, sessions }) {
  await Promise.allSettled(sessions.map((session, index) => {
    if (!session?.id) return Promise.resolve()
    return beginCloseSession(context, session, `${context.runId}:final-table-begin-close:${index}`)
      .then(() => context.transport.request({
        method: 'POST',
        path: interpolate(context.endpoints.tableClose, { sessionId: session.id }),
        label: 'table_close',
        body: { sessionId: session.id, employeeId: context.fixtures.serviceEmployeeId },
        idempotencyKey: `${context.runId}:final-table-close:${index}`,
      }))
  }))
}

async function beginCloseSession(context, session, idempotencyKey) {
  return context.transport.request({
    method: 'POST',
    path: interpolate(context.endpoints.tableBeginClose, { sessionId: session.id }),
    label: 'table_begin_close',
    body: { sessionId: session.id, employeeId: context.fixtures.serviceEmployeeId },
    idempotencyKey,
  })
}

function responseData(body) {
  return body?.data ?? body
}

function summarizeBacklog(samples, peak, final, drainMs) {
  const first = samples[0] ?? { elapsedMs: 0, pending: 0 }
  return {
    initial: first.pending,
    peak,
    final,
    slopePerSecond: round(linearSlopePerSecond(samples), 6),
    drainMs: round(drainMs),
    sampleCount: samples.length,
  }
}

function linearSlopePerSecond(samples) {
  if (samples.length < 2) return 0
  const points = samples.map((sample) => ({ x: sample.elapsedMs / 1_000, y: sample.pending }))
  const meanX = points.reduce((total, point) => total + point.x, 0) / points.length
  const meanY = points.reduce((total, point) => total + point.y, 0) / points.length
  const numerator = points.reduce((total, point) => total + (point.x - meanX) * (point.y - meanY), 0)
  const denominator = points.reduce((total, point) => total + (point.x - meanX) ** 2, 0)
  return denominator === 0 ? 0 : numerator / denominator
}

function stripObservations(result) {
  const { observations: _observations, ...machineSummary } = result
  return machineSummary
}

function countIdempotencyClasses(observations) {
  const counts = { replay: 0, payloadMismatch: 0, inProgress: 0, unknownConflict: 0 }
  for (const item of observations) {
    if (item.idempotencyClass === IDEMPOTENCY_CLASSES.replay) counts.replay += 1
    if (item.idempotencyClass === IDEMPOTENCY_CLASSES.payloadMismatch) counts.payloadMismatch += 1
    if (item.idempotencyClass === IDEMPOTENCY_CLASSES.inProgress) counts.inProgress += 1
    if (item.idempotencyClass === IDEMPOTENCY_CLASSES.unknownConflict) counts.unknownConflict += 1
  }
  return counts
}

function countBy(items, selector) {
  const counts = {}
  for (const item of items) {
    const key = selector(item)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

function validateThresholds(thresholds) {
  for (const [name, value] of Object.entries(thresholds)) finiteNonNegative(value, name)
  if (thresholds.targetRps <= 0) throw new TypeError('targetRps must be positive')
  if (thresholds.minimumAchievedRpsRatio > 1) throw new TypeError('minimumAchievedRpsRatio must not exceed 1')
  if (thresholds.maximumErrorRate > 1) throw new TypeError('maximumErrorRate must not exceed 1')
  return thresholds
}

function validateFixtures(fixtures) {
  if (fixtures === null || typeof fixtures !== 'object') {
    throw new TypeError('NORMALIZED_ACCEPTANCE_FIXTURES_JSON is required for a real service run')
  }
  if (!Array.isArray(fixtures.tableIds) || fixtures.tableIds.length < 2 || fixtures.tableIds.some((id) => !nonBlank(id))) {
    throw new TypeError('fixtures.tableIds must contain at least two test table ids')
  }
  for (const field of ['productId', 'serviceEmployeeId', 'productionEmployeeId', 'stationCode']) {
    if (!nonBlank(fixtures[field])) throw new TypeError(`fixtures.${field} is required`)
  }
  return fixtures
}

function createMockFixtures() {
  return {
    tableIds: [mockUuid(101), mockUuid(102), mockUuid(103), mockUuid(104)],
    productId: mockUuid(201),
    serviceEmployeeId: mockUuid(301),
    productionEmployeeId: mockUuid(302),
    stationCode: 'bar',
  }
}

function failedObservation(label, index, error) {
  return {
    label,
    index,
    status: 0,
    elapsedMs: 0,
    outcome: 'error',
    idempotencyClass: IDEMPOTENCY_CLASSES.none,
    errorCode: 'SCENARIO_ERROR',
    message: safeErrorMessage(error),
  }
}

function response(status, body, headers = {}) {
  return { status, ok: status >= 200 && status < 300, body, headers, elapsedMs: 2 }
}

function mockUuid(sequence) {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`
}

function safeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').slice(0, 240)
}

function safeCode(body) {
  const code = body?.code ?? body?.errorCode ?? body?.error?.code
  return nonBlank(code) ? String(code).slice(0, 80) : null
}

function interpolate(template, values) {
  return Object.entries(values).reduce(
    (value, [key, replacement]) => value.replace(`{${key}}`, encodeURIComponent(replacement)),
    template,
  )
}

function normalizeBaseUrl(value) {
  if (value === undefined || value === null || value === '') return null
  const parsed = new URL(value)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new TypeError('BASE_URL must use http or https')
  parsed.pathname = parsed.pathname.replace(/\/$/, '')
  parsed.search = ''
  parsed.hash = ''
  parsed.username = ''
  parsed.password = ''
  return parsed.toString().replace(/\/$/, '')
}

function redactUrl(value) {
  const parsed = new URL(value)
  parsed.search = ''
  parsed.hash = ''
  parsed.username = ''
  parsed.password = ''
  return parsed.toString().replace(/\/$/, '')
}

function finitePositive(value, name) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) throw new TypeError(`${name} must be positive`)
  return number
}

function finiteNonNegative(value, name) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) throw new TypeError(`${name} must be non-negative`)
  return number
}

function positiveInteger(value, name) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(`${name} must be a positive integer`)
  return number
}

function nonBlank(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function round(value, digits = 2) {
  const multiplier = 10 ** digits
  return Math.round(value * multiplier) / multiplier
}

function wait(milliseconds) {
  return milliseconds <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function parseJsonEnv(name, fallback) {
  const raw = process.env[name]
  if (!raw) return fallback
  try { return JSON.parse(raw) }
  catch { throw new Error(`${name} must be valid JSON`) }
}

function parseCliArgs(argv) {
  const values = {}
  for (const argument of argv) {
    if (argument === '--mock') values.mock = true
    else if (argument.startsWith('--duration-seconds=')) values.durationSeconds = argument.split('=').slice(1).join('=')
    else if (argument.startsWith('--output=')) values.output = argument.split('=').slice(1).join('=')
    else if (argument.startsWith('--requests-per-scenario=')) values.requestsPerScenario = argument.split('=').slice(1).join('=')
    else throw new Error(`Unknown argument: ${argument}`)
  }
  return values
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2))
  const mock = args.mock === true || process.env.NORMALIZED_ACCEPTANCE_MOCK === 'true'
  const transport = mock ? createMockTransport() : undefined
  const report = await runNormalizedLoadAcceptance({
    mode: mock ? 'mock' : 'http',
    baseUrl: process.env.BASE_URL,
    serviceToken: process.env.NORMALIZED_ACCEPTANCE_SERVICE_TOKEN
      ?? process.env.NORMALIZED_ACCEPTANCE_TOKEN,
    productionToken: process.env.NORMALIZED_ACCEPTANCE_PRODUCTION_TOKEN
      ?? process.env.NORMALIZED_ACCEPTANCE_TOKEN,
    durationSeconds: args.durationSeconds ?? process.env.DURATION_SECONDS ?? DEFAULT_DURATION_SECONDS,
    requestsPerScenario: args.requestsPerScenario ?? process.env.REQUESTS_PER_SCENARIO,
    maxConcurrency: process.env.MAX_CONCURRENCY ? Number(process.env.MAX_CONCURRENCY) : 20,
    timeoutMs: process.env.REQUEST_TIMEOUT_MS ? Number(process.env.REQUEST_TIMEOUT_MS) : 5_000,
    endpoints: parseJsonEnv('NORMALIZED_ACCEPTANCE_ENDPOINTS_JSON', undefined),
    fixtures: parseJsonEnv('NORMALIZED_ACCEPTANCE_FIXTURES_JSON', mock ? createMockFixtures() : undefined),
    thresholds: parseJsonEnv('NORMALIZED_ACCEPTANCE_THRESHOLDS_JSON', undefined),
    transport,
  })
  const rendered = `${JSON.stringify(report, null, 2)}\n`
  const output = args.output ?? process.env.OUTPUT_FILE
  if (output) await writeFile(resolve(output), rendered, { encoding: 'utf8', mode: 0o600 })
  process.stdout.write(rendered)
  if (!report.gate.passed) process.exitCode = 1
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${safeErrorMessage(error)}\n`)
    process.exitCode = 1
  })
}
