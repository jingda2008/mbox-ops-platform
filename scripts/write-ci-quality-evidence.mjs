import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'

const scope = process.env.MBOX_CI_SCOPE?.trim() || 'full'
const results = JSON.parse(process.env.MBOX_CI_RESULTS_JSON ?? '{}')
const releaseArtifactRequired = process.env.MBOX_CI_RELEASE_ARTIFACT_REQUIRED === 'true'
const output = resolve(process.env.MBOX_CI_EVIDENCE_PATH ?? 'artifacts/quality-evidence/ci-quality-evidence.json')
const packageDocument = JSON.parse(await readFile('package.json', 'utf8'))
const checkedOutSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
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

const testRuns = selected.map((id) => {
  const status = results[id] === 'success' ? 'pass' : results[id] === 'skipped' ? 'skipped' : 'fail'
  return {
    id,
    kind: id === 'performance' ? 'performance-gate' : id,
    required: true,
    status,
    total: 1,
    passed: status === 'pass' ? 1 : 0,
    failed: status === 'fail' ? 1 : 0,
    blocked: 0,
    notRun: status === 'skipped' ? 1 : 0,
    evidence: [id === 'performance'
      ? `artifact:runtime-quality-${process.env.GITHUB_SHA}`
      : `github-job:${id}`],
  }
})

const performance = []
if (scope === 'full' && results.performance === 'success') {
  const loadPath = resolve(process.env.MBOX_CI_LOAD_EVIDENCE_PATH ?? 'artifacts/runtime-quality/client-observed-load.json')
  const load = JSON.parse(await readFile(loadPath, 'utf8'))
  for (const [id, metric] of Object.entries(load.byLabel ?? {})) {
    performance.push({
      id,
      required: true,
      status: metric.passed ? 'pass' : 'fail',
      samples: metric.samples,
      failures: metric.failures,
      p95Ms: metric.p95Ms,
      p99Ms: metric.p99Ms,
      limits: { minSamples: metric.target?.minSamples ?? load.model?.samplesPerReadOrAction ?? 300, p95Ms: metric.target.p95, p99Ms: metric.target.p99 },
      evidence: [`artifact:runtime-quality-${process.env.GITHUB_SHA}/client-observed-load.json`],
    })
  }
}

const allSelectedPassed = testRuns.every((run) => run.status === 'pass')
  && performance.every((metric) => metric.status === 'pass')
const document = {
  schemaVersion: 1,
  project: process.env.GITHUB_REPOSITORY ?? packageDocument.name,
  version: packageDocument.version,
  generatedAt: new Date().toISOString(),
  decision: allSelectedPassed ? 'ALLOW' : 'DENY',
  source: {
    commitSha: checkedOutSha,
    dirty,
    ref: process.env.GITHUB_REF ?? null,
  },
  environment: { name: 'github-actions', scope },
  ci: {
    provider: 'github-actions',
    runId: process.env.GITHUB_RUN_ID ?? '',
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? '',
  },
  testRuns,
  performance,
  notes: releaseArtifactRequired
    ? ['CI image bundle is produced separately and contains its immutable image digest.']
    : ['This ledger proves source-level CI gates; it is not deployment or field-acceptance evidence.'],
}

await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify(document, null, 2)}\n`)
