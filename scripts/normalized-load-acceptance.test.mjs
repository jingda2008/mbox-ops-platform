import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyIdempotencyConflict,
  createMockTransport,
  evaluateAcceptance,
  percentile,
  runNormalizedLoadAcceptance,
  summarizeObservations,
} from './normalized-load-acceptance.mjs'

test('calculates nearest-rank percentiles and operation summaries', () => {
  assert.equal(percentile([50, 10, 40, 20, 30], 0.95), 50)
  assert.deepEqual(summarizeObservations([
    observation(200, 10),
    observation(201, 20),
    observation(500, 100, 'error'),
  ]), {
    requests: 3,
    successes: 2,
    errors: 1,
    errorRate: 0.333333,
    latencyMs: { min: 10, average: 43.33, p50: 20, p95: 100, p99: 100, max: 100 },
    statuses: { 200: 1, 201: 1, 500: 1 },
    errorCodes: { TEST_ERROR: 1 },
    idempotencyConflicts: { replay: 0, payloadMismatch: 0, inProgress: 0, unknownConflict: 0 },
  })
})

test('classifies idempotency replay and conflict causes without request data', () => {
  assert.equal(classifyIdempotencyConflict({ status: 200, headers: { 'X-Idempotency-Replayed': 'true' } }), 'replay')
  assert.equal(classifyIdempotencyConflict({ status: 409, body: { code: 'IDEMPOTENCY_PAYLOAD_MISMATCH' } }), 'payload_mismatch')
  assert.equal(classifyIdempotencyConflict({ status: 409, body: { errorCode: 'IDEMPOTENCY_IN_PROGRESS' } }), 'in_progress')
  assert.equal(classifyIdempotencyConflict({ status: 409, body: { code: 'ORDER_CONFLICT' } }), 'unknown_conflict')
  assert.equal(classifyIdempotencyConflict({ status: 422, body: { code: 'VALIDATION_ERROR' } }), 'none')
})

test('passes a complete built-in mock run at sustained 5 RPS', async () => {
  const transport = createMockTransport({ latencyMs: 1 })
  const report = await runNormalizedLoadAcceptance({
    mode: 'mock',
    transport,
    requestsPerScenario: 3,
    durationSeconds: 0.6,
    targetRps: 5,
    thresholds: {
      maximumSchedulingDelayP95Ms: 50,
      maximumSchedulingDelayP99Ms: 100,
    },
  })

  assert.equal(report.schemaVersion, 'normalized-load-acceptance-v2')
  assert.equal(report.gate.passed, true, JSON.stringify(report.gate.failures))
  assert.equal(report.consistency.kdsDuplicateClaims, 0)
  assert.equal(report.consistency.kdsInconsistentStates, 0)
  assert.equal(report.scenarios.tableOpen.summary.requests, 3)
  assert.equal(report.scenarios.orderSubmit.summary.requests, 3)
  assert.equal(report.scenarios.kdsPrepareComplete.summary.requests, 6)
  assert.equal(report.scenarios.serviceTaskFlow.summary.requests, 12)
  assert.equal(report.scenarios.serviceTaskFlow.backlog.final, 0)
  assert.equal(report.run.baseUrl, null)
  assert.equal(report.run.evidenceEligible, false)
  assert.equal(report.workload.independentDatabasePerRun, false)
})

test('records immutable evidence identity only when the isolated runner opts in', async () => {
  const sourceCommitSha = 'a'.repeat(40)
  const report = await runNormalizedLoadAcceptance({
    mode: 'http_isolated_postgres',
    sourceCommitSha,
    evidenceEligible: true,
    independentDatabasePerRun: true,
    transport: createMockTransport({ latencyMs: 0 }),
    requestsPerScenario: 2,
    durationSeconds: 0.4,
    targetRps: 5,
  })

  assert.equal(report.run.sourceCommitSha, sourceCommitSha)
  assert.equal(report.run.evidenceEligible, true)
  assert.equal(report.workload.independentDatabasePerRun, true)
})

test('fails gates for lag, latency, errors, KDS inconsistency, and unknown idempotency conflicts', () => {
  const scenario = {
    summary: {
      requests: 10,
      successes: 8,
      errors: 2,
      errorRate: 0.2,
      latencyMs: { min: 10, average: 300, p50: 100, p95: 700, p99: 1_500, max: 1_500 },
      statuses: { 200: 8, 500: 2 },
      idempotencyConflicts: { replay: 0, payloadMismatch: 0, inProgress: 0, unknownConflict: 1 },
    },
    arrival: {
      targetRps: 5,
      achievedLaunchRps: 4,
      completionThroughputRps: 3.8,
      requests: 10,
      maximumConcurrency: 10,
      schedulingDelayP95Ms: 150,
      schedulingDelayP99Ms: 300,
      durationMs: 3_000,
    },
    backlog: { initial: 1, peak: 8, final: 3, slopePerSecond: 1, drainMs: 2_000, sampleCount: 20 },
  }
  const report = {
    workload: { targetRps: 5 },
    scenarios: { tableOpen: scenario },
    consistency: {
      kdsDuplicateClaims: 1,
      kdsInconsistentStates: 1,
      idempotencyConflicts: { replay: 0, payloadMismatch: 1, inProgress: 1, unknownConflict: 1 },
    },
  }
  const gate = evaluateAcceptance(report)
  assert.equal(gate.passed, false)
  assert.ok(gate.failures.includes('tableOpen.achieved_rps'))
  assert.ok(gate.failures.includes('tableOpen.completion_throughput'))
  assert.ok(gate.failures.includes('tableOpen.final_backlog'))
  assert.ok(gate.failures.includes('kds.duplicate_claims'))
  assert.ok(gate.failures.includes('idempotency.unknown_conflicts'))
})

test('detects a duplicated KDS task id returned for different orders', async () => {
  const base = createMockTransport({ latencyMs: 0 })
  let firstTaskId
  const transport = {
    async request(request) {
      const result = await base.request(request)
      if (request.label === 'order_submit') {
        const taskId = result.body?.kdsTasks?.[0]?.id
        if (firstTaskId) {
          return { ...result, body: { ...result.body, kdsTasks: [{ id: firstTaskId }] } }
        }
        firstTaskId = taskId
      }
      return result
    },
  }
  const report = await runNormalizedLoadAcceptance({
    mode: 'mock',
    transport,
    requestsPerScenario: 2,
    durationSeconds: 0.4,
    targetRps: 5,
  })
  assert.equal(report.consistency.kdsDuplicateClaims, 1)
  assert.equal(report.gate.passed, false)
})

test('does not expose an authorization token in the report', async () => {
  const report = await runNormalizedLoadAcceptance({
    mode: 'injected',
    baseUrl: 'https://user:password@example.invalid/path?token=secret#fragment',
    token: 'top-secret-token',
    transport: createMockTransport({ latencyMs: 0 }),
    requestsPerScenario: 2,
    durationSeconds: 0.4,
    targetRps: 5,
  })
  const serialized = JSON.stringify(report)
  assert.equal(serialized.includes('top-secret-token'), false)
  assert.equal(serialized.includes('password'), false)
  assert.equal(serialized.includes('token=secret'), false)
  assert.equal(report.run.baseUrl, 'https://example.invalid/path')
})

function observation(status, elapsedMs, outcome = 'success') {
  return {
    label: 'test',
    index: 0,
    status,
    elapsedMs,
    outcome,
    idempotencyClass: 'none',
    errorCode: outcome === 'error' ? 'TEST_ERROR' : null,
  }
}
