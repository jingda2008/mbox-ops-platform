import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const repoRoot = new URL('..', import.meta.url).pathname
const currentSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()

function runWriter({ results, load, browserStartup }) {
  const directory = mkdtempSync(join(tmpdir(), 'mbox-quality-evidence-'))
  const output = join(directory, 'evidence.json')
  try {
    execFileSync(process.execPath, ['scripts/write-ci-quality-evidence.mjs'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_REPOSITORY: 'jingda2008/mbox-ops-platform',
        GITHUB_RUN_ID: '31327038745',
        MBOX_CI_SCOPE: 'full',
        MBOX_CI_SOURCE_HEAD_SHA: currentSha,
        MBOX_CI_RESULTS_JSON: JSON.stringify(results),
        MBOX_CI_EVIDENCE_PATH: output,
        MBOX_CI_LOAD_EVIDENCE_BASE64: load
          ? Buffer.from(JSON.stringify(load), 'utf8').toString('base64')
          : '',
        MBOX_CI_BROWSER_STARTUP_EVIDENCE_BASE64: browserStartup
          ? Buffer.from(JSON.stringify(browserStartup), 'utf8').toString('base64')
          : '',
      },
    })
    return JSON.parse(readFileSync(output, 'utf8'))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function validBrowserStartup() {
  const metric = {
    samples: 30, successful: 30, failures: 0,
    p50Ms: 120, p95Ms: 240, p99Ms: 310, maxMs: 350,
    criticalApiPathP50Ms: 40, criticalApiPathP95Ms: 80,
    criticalApiPathP99Ms: 120, criticalApiPathMaxMs: 150,
  }
  return {
    schemaVersion: 'normalized-browser-startup-v1',
    run: {
      mode: 'real_browser_isolated_postgres', evidenceEligible: true, sourceCommitSha: currentSha,
    },
    workload: {
      freshBrowserContextPerSample: true,
      samplesPerMode: 30,
      employeeSessionPreparedOutsideMeasurement: true,
      guestSessionPreparedOutsideMeasurement: true,
      staticTableQrScanCoveredByCommercialFlow: true,
    },
    metrics: { employeeStartup: metric, guestSessionStartup: metric },
    gate: {
      passed: true,
      thresholds: { minimumSamples: 30, p95Ms: 500, p99Ms: 1000 },
    },
  }
}

test('preserves failed route metrics instead of replacing them with missing evidence', () => {
  const document = runWriter({
    results: { quality: 'success', browser: 'success', database: 'success', performance: 'failure' },
    load: {
      model: {
        evidenceEligible: true,
        independentBaselinePerPhase: true,
        instances: 2,
        samplesPerReadOrAction: 300,
        arrivalMetrics: {
          kds_complete: {
            targetRps: 2,
            achievedLaunchRps: 2,
            maximumConcurrency: 2,
            schedulingDelayP95Ms: 1,
          },
        },
      },
      byLabel: {
        kds_complete: {
          passed: false,
          samples: 300,
          successful: 300,
          failures: 0,
          p50Ms: 200,
          p95Ms: 543.4,
          p99Ms: 600,
          maxMs: 650,
          target: { minSamples: 300, p95: 500, p99: 800 },
        },
      },
    },
  })

  assert.equal(document.decision, 'DENY')
  assert.equal(document.testRuns.find((run) => run.id === 'performance').status, 'fail')
  assert.equal(document.performance.length, 1)
  assert.equal(document.performance[0].id, 'kds_complete')
  assert.equal(document.performance[0].status, 'fail')
  assert.equal(document.performance[0].p95Ms, 543.4)
})

test('converts normalized isolated load evidence into release performance records', () => {
  const scenario = {
    summary: {
      requests: 300, successes: 300, errors: 0, errorRate: 0,
      latencyMs: { min: 8, average: 18, p50: 15, p95: 42, p99: 70, max: 90 },
    },
    arrival: {
      targetRps: 5, achievedLaunchRps: 5, completionThroughputRps: 5,
      requests: 300, maximumConcurrency: 2, schedulingDelayP95Ms: 2,
      schedulingDelayP99Ms: 4, durationMs: 60_000,
    },
    backlog: { initial: 1, peak: 2, final: 0, slopePerSecond: 0, drainMs: 42 },
  }
  const scenarios = {
    tableOpen: scenario,
    orderSubmit: scenario,
    kdsPrepareComplete: scenario,
    serviceTaskFlow: scenario,
  }
  const checks = Object.keys(scenarios).flatMap((name) => [
    { id: `${name}.achieved_rps`, passed: true },
    { id: `${name}.p95`, passed: true },
  ])
  checks.push(
    { id: 'database.pool_acquisition_failures', passed: true },
    { id: 'database.pool_wait_p95', passed: true },
    { id: 'database.pool_wait_p99', passed: true },
    { id: 'database.pool_waiting_at_end', passed: true },
    { id: 'database.transaction_failures', passed: true },
    { id: 'database.transaction_p95', passed: true },
    { id: 'database.transaction_p99', passed: true },
    { id: 'database.query_failures', passed: true },
    { id: 'database.query_p95', passed: true },
    { id: 'database.query_p99', passed: true },
  )
  const document = runWriter({
    results: {
      quality: 'success', browser: 'success', database: 'success', normalized_database: 'success',
      normalized_browser: 'success', performance: 'success',
    },
    load: {
      schemaVersion: 'normalized-load-acceptance-v2',
      run: {
        mode: 'http_isolated_postgres', evidenceEligible: true, sourceCommitSha: currentSha,
      },
      workload: { independentDatabasePerRun: true, requestsPerScenario: 300 },
      scenarios,
      serverMetrics: {
        database: {
          pool: {
            acquisitionFailures: 0,
            acquisitionWaitMs: { samples: 1_000, p50: 1, p95: 5, p99: 9, max: 12 },
          },
          transactions: {
            failed: 0,
            durationMs: { samples: 1_000, p50: 8, p95: 25, p99: 40, max: 80 },
          },
          queries: {
            failed: 0,
            durationMs: { samples: 5_000, p50: 2, p95: 8, p99: 15, max: 40 },
          },
        },
      },
      gate: {
        passed: true,
        thresholds: { maximumP95Ms: 500, maximumP99Ms: 1000 },
        checks,
      },
    },
    browserStartup: validBrowserStartup(),
  })

  assert.equal(document.decision, 'ALLOW')
  assert.deepEqual(document.performance.map((metric) => metric.id), [
    'normalized_employee_startup',
    'normalized_guest_session_startup',
    'normalized_employee_startup_api',
    'normalized_guest_session_api',
    'normalized_table_open',
    'normalized_order_submit',
    'normalized_kds_prepare_complete',
    'normalized_service_task_flow',
    'normalized_database_pool_acquire',
    'normalized_database_transaction',
    'normalized_database_query',
  ])
  assert.ok(document.performance.every((metric) => metric.status === 'pass'))
  assert.ok(document.performance.slice(0, 4).every((metric) => metric.workload.profile === 'mbox-normalized-browser-startup-v1'))
  assert.ok(document.performance.slice(4).every((metric) => metric.workload.profile === 'mbox-normalized-core-regression-v1'))
})

test('rejects normalized browser startup evidence from another commit', () => {
  const browserStartup = validBrowserStartup()
  browserStartup.run.sourceCommitSha = '0'.repeat(40)
  assert.throws(() => runWriter({
    results: {
      quality: 'success', browser: 'success', database: 'success', normalized_database: 'success',
      normalized_browser: 'success', performance: 'success',
    },
    browserStartup,
  }), /启动性能证据提交/)
})

test('rejects normalized browser startup evidence with too few samples', () => {
  const browserStartup = validBrowserStartup()
  browserStartup.metrics.guestSessionStartup = {
    ...browserStartup.metrics.guestSessionStartup,
    samples: 29,
    successful: 29,
  }
  assert.throws(() => runWriter({
    results: {
      quality: 'success', browser: 'success', database: 'success', normalized_database: 'success',
      normalized_browser: 'success', performance: 'success',
    },
    browserStartup,
  }), /启动性能证据不完整/)
})

test('rejects normalized evidence that omits server database telemetry', () => {
  const load = {
    schemaVersion: 'normalized-load-acceptance-v2',
    run: { mode: 'http_isolated_postgres', evidenceEligible: true, sourceCommitSha: currentSha },
    workload: { independentDatabasePerRun: true, requestsPerScenario: 300 },
    scenarios: {},
    gate: { passed: true, thresholds: {}, checks: [] },
  }
  assert.throws(() => runWriter({
    results: {
      quality: 'success', browser: 'success', database: 'success', normalized_database: 'success',
      normalized_browser: 'success', performance: 'success',
    },
    load,
    browserStartup: validBrowserStartup(),
  }), /服务端数据库门禁/)
})

test('distinguishes cancelled work from work that never ran', () => {
  const document = runWriter({
    results: { quality: 'success', browser: 'cancelled', database: 'skipped', performance: 'skipped' },
  })

  const byId = Object.fromEntries(document.testRuns.map((run) => [run.id, run]))
  assert.equal(document.decision, 'DENY')
  assert.deepEqual(
    { status: byId.browser.status, blocked: byId.browser.blocked, notRun: byId.browser.notRun },
    { status: 'blocked', blocked: 1, notRun: 0 },
  )
  assert.deepEqual(
    { status: byId.database.status, blocked: byId.database.blocked, notRun: byId.database.notRun },
    { status: 'not_run', blocked: 0, notRun: 1 },
  )
})

test('requires the normalized database gate for a full release decision', () => {
  const denied = runWriter({
    results: {
      quality: 'success', browser: 'success', database: 'success',
      normalized_database: 'skipped', performance: 'skipped',
    },
  })

  const gate = denied.testRuns.find((run) => run.id === 'normalized_database')
  assert.equal(denied.decision, 'DENY')
  assert.equal(gate.status, 'not_run')
  assert.equal(gate.required, true)
})

test('requires the normalized real-browser gate for a full release decision', () => {
  const denied = runWriter({
    results: {
      quality: 'success', browser: 'success', database: 'success', normalized_database: 'success',
      normalized_browser: 'skipped', performance: 'skipped',
    },
  })

  const gate = denied.testRuns.find((run) => run.id === 'normalized_browser')
  assert.equal(denied.decision, 'DENY')
  assert.equal(gate.status, 'not_run')
  assert.equal(gate.required, true)
})
