import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const repoRoot = new URL('..', import.meta.url).pathname
const currentSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()

function runWriter({ results, load }) {
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
      },
    })
    return JSON.parse(readFileSync(output, 'utf8'))
  } finally {
    rmSync(directory, { recursive: true, force: true })
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
