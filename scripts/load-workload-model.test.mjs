import assert from 'node:assert/strict'
import test from 'node:test'
import {
  describeVenueWorkload,
  describeKdsWriteProfile,
  evaluateArrivalSchedule,
  evaluatePhaseArrivalSchedules,
  runArrivalPool,
  selectAuthorizedOccupiedTables,
  validateArrivalProfile,
} from './load-workload-model.mjs'

test('venue model exposes the assumptions behind 300-guest performance tests', () => {
  const model = describeVenueWorkload()
  assert.equal(model.guests, 300)
  assert.equal(model.employees, 12)
  assert.equal(model.modelType, 'representative_peak_window')
  assert.equal(model.testWindowSeconds, 300)
  assert.equal(model.fullNightCompressionReferenceFactor, 66)
  assert.equal(model.equivalentToCompressedFullNight, false)
  assert.equal(model.testGuestSessionArrivalPerSecond, 1)
  assert.ok(model.guestArrivalsPerSecond < 0.02)
  assert.ok(model.tenTimesGuestArrivalBurstPerSecond < 0.2)
  assert.ok(model.employeeHeartbeatsPerSecond < 0.3)
})

test('KDS regression and capacity rates remain separate and expose every assumption', () => {
  const profile = describeKdsWriteProfile()
  assert.equal(profile.modelType, 'explicit_assumption_not_production_observation')
  assert.equal(profile.estimatedFullNightTransitions, 3_600)
  assert.ok(Math.abs(profile.estimatedFullNightAverageRps - 0.1818) < 0.001)
  assert.ok(Math.abs(profile.representativeMultiplier - 11) < 0.01)
  assert.ok(Math.abs(profile.capacityProbeMultiplier - 27.5) < 0.01)
  assert.ok(profile.capacityProbeRps > profile.representativeRegressionRps)
})

test('arrival pool paces work and never exceeds its concurrency ceiling', async () => {
  let active = 0
  let highWatermark = 0
  const startedAt = performance.now()
  const result = await runArrivalPool([1, 2, 3, 4, 5], async () => {
    active += 1
    highWatermark = Math.max(highWatermark, active)
    await new Promise((resolve) => setTimeout(resolve, 30))
    active -= 1
  }, { requestsPerSecond: 20, maxConcurrency: 2 })
  assert.deepEqual(result.failures, [])
  assert.equal(result.metrics.requests, 5)
  assert.equal(result.metrics.targetRps, 20)
  assert.ok(result.metrics.achievedLaunchRps >= 19.6)
  assert.equal(result.metrics.missedArrivalCount, 0)
  assert.ok(result.metrics.maximumConcurrency <= 2)
  assert.ok(highWatermark <= 2)
  assert.ok(performance.now() - startedAt >= 190)
})

test('arrival pool records failures without stopping later samples', async () => {
  const visited = []
  const result = await runArrivalPool([0, 1, 2], async (value) => {
    visited.push(value)
    if (value === 1) throw new Error('expected failure')
  }, { requestsPerSecond: 1_000, maxConcurrency: 2 })
  assert.deepEqual(visited, [0, 1, 2])
  assert.deepEqual(result.failures, [{ index: 1, message: 'expected failure' }])
  assert.ok(result.metrics.schedulingDelayP95Ms >= 0)
})

test('arrival profile rejects invalid values', () => {
  assert.throws(() => validateArrivalProfile({ requestsPerSecond: 0, maxConcurrency: 2 }), /正数/)
  assert.throws(() => validateArrivalProfile({ requestsPerSecond: 2, maxConcurrency: 1.5 }), /正整数/)
})

test('arrival schedule fails when the load generator misses its target cadence', () => {
  assert.deepEqual(evaluateArrivalSchedule({ guest: {
    targetRps: 1, achievedLaunchRps: 1, arrivalIntervalMs: 1_000,
    schedulingDelayP95Ms: 20, schedulingDelayP99Ms: 30, missedArrivalCount: 0,
  } }, 250), {
    passed: true, failedLabels: [],
  })
  assert.deepEqual(evaluateArrivalSchedule({ guest: {
    targetRps: 5, achievedLaunchRps: 4, arrivalIntervalMs: 200,
    schedulingDelayP95Ms: 120, schedulingDelayP99Ms: 300, missedArrivalCount: 2,
  } }, 250), {
    passed: false, failedLabels: ['guest'],
  })
})

test('setup capacity drift is reported independently from the measured schedule', () => {
  const healthy = {
    targetRps: 2, achievedLaunchRps: 2, arrivalIntervalMs: 500,
    schedulingDelayP95Ms: 10, schedulingDelayP99Ms: 20, missedArrivalCount: 0,
  }
  const delayedSetup = {
    targetRps: 5, achievedLaunchRps: 4.4, arrivalIntervalMs: 200,
    schedulingDelayP95Ms: 7_000, schedulingDelayP99Ms: 7_600, missedArrivalCount: 182,
  }
  assert.deepEqual(evaluatePhaseArrivalSchedules({ kds_complete: healthy }, { setup_kds_start: delayedSetup }, 250), {
    measuredSchedule: { passed: true, failedLabels: [] },
    setupSchedule: { passed: false, failedLabels: ['setup_kds_start'] },
  })
})

test('load tables come from the authoritative catalog and only use responsible staff sessions', () => {
  const sessions = new Map([['emp-lin', { token: 'a' }]])
  const visibleTables = new Map([
    ['emp-lin', [
      { id: 'table-l01', code: 'L01', status: 'occupied', primaryEmployeeId: 'emp-lin' },
      { id: 'table-l02', code: 'L02', status: 'available', primaryEmployeeId: 'emp-lin' },
    ]],
    ['emp-missing', [
      { id: 'table-retired', code: 'I01', status: 'occupied', primaryEmployeeId: 'emp-missing' },
    ]],
  ])
  assert.deepEqual(selectAuthorizedOccupiedTables(visibleTables, sessions), [
    { id: 'table-l01', code: 'L01', actorId: 'emp-lin' },
  ])
})

test('load tables prefer the primary employee when multiple authorized actors can see a table', () => {
  const sessions = new Map([['emp-manager', { token: 'manager' }], ['emp-lin', { token: 'server' }]])
  const table = { id: 'table-l01', code: 'L01', status: 'occupied', primaryEmployeeId: 'emp-lin' }
  assert.deepEqual(selectAuthorizedOccupiedTables(new Map([
    ['emp-manager', [table]],
    ['emp-lin', [table]],
  ]), sessions), [
    { id: 'table-l01', code: 'L01', actorId: 'emp-lin' },
  ])
})
