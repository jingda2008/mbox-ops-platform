import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeLoadReports, requiredRoutePhases } from './merge-rc68-load-reports.mjs'

const labels = {
  staff_start: ['staff_start_api_journey'],
  reads: ['bootstrap_role_coverage', 'heartbeat', 'bootstrap_live', 'bootstrap_cached', 'reservations', 'guest_session', 'guest_session_repeat'],
  create_task_live: ['create_task_live'],
  create_quick_order_live: ['create_quick_order_live'],
  task_action: ['task_action'],
  kds_start: ['kds_start'],
  kds_complete: ['kds_complete'],
}

function report(phase, passed = true) {
  const byLabel = Object.fromEntries(labels[phase].map((label) => [label, {
    samples: 300, successful: passed ? 300 : 299, failures: passed ? 0 : 1,
    p50Ms: 10, p95Ms: 20, p99Ms: 30, maxMs: 40,
    target: { p95: 100, p99: 200 }, passed,
  }]))
  return {
    model: {
      phase, runId: 'run-12345678', evidenceEligible: true, instances: 2, samplesPerReadOrAction: 300,
      arrivalRatesPerSecond: { read: 1, write: 2 },
      arrivalMetrics: Object.fromEntries(labels[phase].map((label) => [label, { targetRps: 5 }])),
    },
    totals: { measured: 300, failures: passed ? 0 : 1, workflowFailures: 0 },
    byLabel, failureSamples: [], passed,
  }
}

function evidence(phase, passed = true) {
  return {
    phase,
    runtimeMetrics: { passed },
    logAnalysis: { selection: { testStage: 'measured', testPhase: phase }, gate: { passed } },
    environment: {
      phase,
      runId: 'run-12345678',
      source: { commitSha: 'a'.repeat(40), dirty: false },
      runtime: {
        nodeVersion: 'v24.0.0', instances: 2, databasePoolMax: 10,
        mutationQueueMax: 100, mutationQueueWaitMs: 15000, stateReadCacheMs: 3000,
      },
      inputs: { packageLockSha256: 'lock', migrationSetSha256: 'migration', seedStateSha256: 'seed' },
      workload: { samplesPerReadOrAction: 300, browserSamples: 30, readRps: 1, writeRps: 2 },
    },
    browserStartup: ['staff_start', 'reads'].includes(phase) ? {
      passed,
      mode: phase === 'staff_start' ? 'staff' : 'guest',
      measurementClass: 'fresh_browser_context_page_readiness',
      testStage: 'measured',
      testPhase: phase === 'staff_start' ? 'browser_staff' : 'browser_guest',
    } : null,
  }
}

test('merges only complete isolated phase reports', () => {
  const merged = mergeLoadReports(
    requiredRoutePhases.map((phase) => report(phase)),
    requiredRoutePhases.map((phase) => evidence(phase)),
  )
  assert.equal(merged.passed, true)
  assert.equal(merged.model.independentBaselinePerPhase, true)
  assert.equal(merged.model.environmentConsistent, true)
  assert.equal(Object.keys(merged.byLabel).length, 13)
})

test('denies dirty or inconsistent environments', () => {
  const dirty = requiredRoutePhases.map((phase) => evidence(phase))
  dirty[0].environment.source.dirty = true
  assert.equal(mergeLoadReports(requiredRoutePhases.map((phase) => report(phase)), dirty).passed, false)

  const inconsistent = requiredRoutePhases.map((phase) => evidence(phase))
  inconsistent.at(-1).environment.inputs.seedStateSha256 = 'other-seed'
  const merged = mergeLoadReports(requiredRoutePhases.map((phase) => report(phase)), inconsistent)
  assert.equal(merged.passed, false)
  assert.equal(merged.model.environmentConsistent, false)
})

test('preserves a failing phase as a release denial', () => {
  const merged = mergeLoadReports(
    requiredRoutePhases.map((phase) => report(phase, phase !== 'kds_start')),
    requiredRoutePhases.map((phase) => evidence(phase)),
  )
  assert.equal(merged.passed, false)
  assert.equal(merged.byLabel.kds_start.passed, false)
})

test('rejects all-mode and missing phases', () => {
  assert.throws(() => mergeLoadReports(requiredRoutePhases.slice(1).map((phase) => report(phase)), []), /恰好包含/)
  const reports = requiredRoutePhases.map((phase) => report(phase))
  reports[0].model.phase = 'all'
  assert.throws(() => mergeLoadReports(reports, requiredRoutePhases.map((phase) => evidence(phase))), /不允许合并阶段/)
})

test('denies a phase when runtime metrics or server logs failed', () => {
  const gates = requiredRoutePhases.map((phase) => evidence(phase, phase !== 'reads'))
  const merged = mergeLoadReports(requiredRoutePhases.map((phase) => report(phase)), gates)
  assert.equal(merged.passed, false)
  assert.equal(merged.phaseGates.reads.runtimePassed, false)
  assert.equal(merged.phaseGates.reads.logsPassed, false)
})

test('denies mismatched log selection, browser mode, or expected commit', () => {
  const logs = requiredRoutePhases.map((phase) => evidence(phase))
  logs[1].logAnalysis.selection.testPhase = 'staff_start'
  assert.equal(mergeLoadReports(requiredRoutePhases.map((phase) => report(phase)), logs).passed, false)

  const browser = requiredRoutePhases.map((phase) => evidence(phase))
  browser[0].browserStartup.mode = 'guest'
  assert.equal(mergeLoadReports(requiredRoutePhases.map((phase) => report(phase)), browser).passed, false)

  const commit = requiredRoutePhases.map((phase) => evidence(phase))
  assert.equal(mergeLoadReports(
    requiredRoutePhases.map((phase) => report(phase)), commit, { expectedCommitSha: 'b'.repeat(40) },
  ).passed, false)
})

test('denies mixed run identities or workload parameters', () => {
  const mixedRun = requiredRoutePhases.map((phase) => evidence(phase))
  mixedRun.at(-1).environment.runId = 'run-87654321'
  assert.equal(mergeLoadReports(requiredRoutePhases.map((phase) => report(phase)), mixedRun).passed, false)

  const mixedWorkload = requiredRoutePhases.map((phase) => evidence(phase))
  mixedWorkload[2].environment.workload.writeRps = 1
  assert.equal(mergeLoadReports(requiredRoutePhases.map((phase) => report(phase)), mixedWorkload).passed, false)
})
