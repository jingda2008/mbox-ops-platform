import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { qualityPolicyDigest } from './verify-quality-evidence.mjs'

const scope = process.env.MBOX_CI_SCOPE?.trim() || 'full'
const results = JSON.parse(process.env.MBOX_CI_RESULTS_JSON ?? '{}')
const releaseArtifactRequired = process.env.MBOX_CI_RELEASE_ARTIFACT_REQUIRED === 'true'
const output = resolve(process.env.MBOX_CI_EVIDENCE_PATH ?? 'artifacts/quality-evidence/ci-quality-evidence.json')
const packageDocument = JSON.parse(await readFile('package.json', 'utf8'))
const qualityPolicy = JSON.parse(await readFile('docs/quality-policy-mbox-v1.json', 'utf8'))
const checkedOutSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const sourceHeadSha = process.env.MBOX_CI_SOURCE_HEAD_SHA?.trim() || checkedOutSha
const generatedAt = new Date().toISOString()
const environmentId = `github-actions:${process.env.GITHUB_RUN_ID ?? 'unknown'}`
const dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim())
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== checkedOutSha) {
  throw new Error(`Checked-out commit ${checkedOutSha} does not match GITHUB_SHA ${process.env.GITHUB_SHA}`)
}

const selectedByScope = {
  docs: ['docs'],
  ui: ['fast_quality', 'ui_browser'],
  frontend: ['fast_quality', 'browser'],
  full: ['quality', 'browser', 'database', 'performance'],
}
const selected = [...(selectedByScope[scope] ?? selectedByScope.full)]
if (releaseArtifactRequired) selected.push('image')

function normalizedRunStatus(result) {
  if (result === 'success') return 'pass'
  if (result === 'failure') return 'fail'
  if (result === 'cancelled') return 'blocked'
  return 'not_run'
}

const testRuns = selected.map((id) => {
  const status = normalizedRunStatus(results[id])
  return {
    id,
    kind: id === 'performance' ? 'performance-gate' : id,
    required: true,
    status,
    total: 1,
    passed: status === 'pass' ? 1 : 0,
    failed: status === 'fail' ? 1 : 0,
    blocked: status === 'blocked' ? 1 : 0,
    notRun: status === 'not_run' ? 1 : 0,
    evidence: [id === 'performance'
      ? process.env.GITHUB_EVENT_NAME === 'pull_request'
        ? `github-job:performance:${process.env.GITHUB_RUN_ID}`
        : `artifact:runtime-quality-${process.env.GITHUB_SHA}`
      : `github-job:${id}:${process.env.GITHUB_RUN_ID ?? 'unknown'}`],
  }
})

const performance = []
const encodedLoad = process.env.MBOX_CI_LOAD_EVIDENCE_BASE64?.trim()
if (scope === 'full' && (results.performance === 'success' || encodedLoad)) {
  const loadPath = resolve(process.env.MBOX_CI_LOAD_EVIDENCE_PATH ?? 'artifacts/runtime-quality/client-observed-load.json')
  const load = encodedLoad
    ? JSON.parse(Buffer.from(encodedLoad, 'base64').toString('utf8'))
    : JSON.parse(await readFile(loadPath, 'utf8'))
  if (load.model?.evidenceEligible !== true || load.model?.independentBaselinePerPhase !== true) {
    throw new Error('性能发布证据必须来自独立数据库基线的分阶段路由套件')
  }
  for (const [id, metric] of Object.entries(load.byLabel ?? {})) {
    const arrival = load.model?.arrivalMetrics?.[id]
    performance.push({
      id,
      required: true,
      conclusionLevel: 'regression',
      status: metric.passed ? 'pass' : 'fail',
      samples: metric.samples,
      successful: metric.successful,
      failures: metric.failures,
      p50Ms: metric.p50Ms,
      p95Ms: metric.p95Ms,
      p99Ms: metric.p99Ms,
      maxMs: metric.maxMs,
      limits: { minSamples: metric.target?.minSamples ?? load.model?.samplesPerReadOrAction ?? 300, p95Ms: metric.target.p95, p99Ms: metric.target.p99 },
      environmentRef: environmentId,
      workload: {
        profile: 'mbox-pr-route-regression-v1',
        model: id === 'bootstrap_role_coverage'
          ? 'bounded-role-coverage'
          : arrival
            ? 'open-arrival-rate'
            : 'bounded-independent-request',
        route: id,
        instances: load.model?.instances ?? null,
        targetRps: arrival?.targetRps ?? null,
        achievedLaunchRps: arrival?.achievedLaunchRps ?? null,
        maxConcurrency: arrival?.maximumConcurrency ?? null,
        schedulingDelayP95Ms: arrival?.schedulingDelayP95Ms ?? null,
      },
      evidence: [process.env.GITHUB_EVENT_NAME === 'pull_request'
        ? `github-job:performance:${process.env.GITHUB_RUN_ID}`
        : `artifact:runtime-quality-${process.env.GITHUB_SHA}/client-observed-load.json`],
    })
  }
}

const allSelectedPassed = testRuns.every((run) => run.status === 'pass')
  && performance.every((metric) => metric.status === 'pass')
const document = {
  schemaVersion: 2,
  project: process.env.GITHUB_REPOSITORY ?? packageDocument.name,
  version: packageDocument.version,
  qualityProfile: {
    id: `mbox-${scope}-release-v1`,
    policyRef: `${qualityPolicy.id}@sha256:${qualityPolicyDigest(qualityPolicy)}`,
  },
  generatedAt,
  decision: allSelectedPassed ? 'ALLOW' : 'DENY',
  source: {
    commitSha: checkedOutSha,
    proposedHeadSha: sourceHeadSha,
    dirty,
    ref: process.env.GITHUB_REF ?? null,
  },
  environment: { id: environmentId, name: 'github-actions', scope },
  ci: {
    provider: 'github-actions',
    runId: process.env.GITHUB_RUN_ID ?? '',
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? '',
  },
  requiredGateIds: [...selected, ...performance.map((metric) => metric.id)],
  testRuns,
  performance,
  notes: releaseArtifactRequired
    ? ['CI image bundle is produced separately and contains its immutable image digest.']
    : ['This ledger proves source-level CI gates; it is not deployment or field-acceptance evidence.'],
}

await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify(document, null, 2)}\n`)
