import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function flag(name) {
  return process.argv.includes(`--${name}`)
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function requireText(failures, value, path) {
  if (typeof value !== 'string' || !value.trim()) failures.push(`${path} must be a non-empty string`)
}

function validateTestRun(run, index, failures) {
  const path = `testRuns[${index}]`
  requireText(failures, run?.id, `${path}.id`)
  requireText(failures, run?.kind, `${path}.kind`)
  if (!['pass', 'fail', 'blocked', 'not_run', 'skipped'].includes(run?.status)) {
    failures.push(`${path}.status is invalid`)
  }
  for (const field of ['total', 'passed', 'failed', 'blocked', 'notRun']) {
    if (!isNonNegativeInteger(run?.[field])) failures.push(`${path}.${field} must be a non-negative integer`)
  }
  if (['total', 'passed', 'failed', 'blocked', 'notRun'].every((field) => isNonNegativeInteger(run?.[field]))) {
    const accounted = run.passed + run.failed + run.blocked + run.notRun
    if (accounted !== run.total) failures.push(`${path} totals do not reconcile: ${accounted} != ${run.total}`)
  }
  if (run?.status === 'pass' && (run.failed !== 0 || run.blocked !== 0 || run.notRun !== 0 || run.passed !== run.total)) {
    failures.push(`${path} claims pass but contains unfinished or failed cases`)
  }
  if (!Array.isArray(run?.evidence) || run.evidence.length === 0) {
    failures.push(`${path}.evidence must contain at least one traceable reference`)
  }
}

function validatePerformance(metric, index, failures) {
  const path = `performance[${index}]`
  requireText(failures, metric?.id, `${path}.id`)
  if (!isNonNegativeInteger(metric?.samples)) failures.push(`${path}.samples must be a non-negative integer`)
  if (!isNonNegativeInteger(metric?.failures)) failures.push(`${path}.failures must be a non-negative integer`)
  for (const field of ['p95Ms', 'p99Ms']) {
    if (!Number.isFinite(metric?.[field]) || metric[field] < 0) failures.push(`${path}.${field} must be a non-negative number`)
  }
  const limits = metric?.limits
  if (!isNonNegativeInteger(limits?.minSamples) || limits.minSamples < 1) {
    failures.push(`${path}.limits.minSamples must be a positive integer`)
  }
  for (const field of ['p95Ms', 'p99Ms']) {
    if (!Number.isFinite(limits?.[field]) || limits[field] <= 0) failures.push(`${path}.limits.${field} must be positive`)
  }
  if (!['pass', 'fail', 'blocked', 'not_run', 'skipped'].includes(metric?.status)) {
    failures.push(`${path}.status is invalid`)
  }
  if (metric?.status === 'pass') {
    if (metric.failures !== 0) failures.push(`${path} has ${metric.failures} failed samples`)
    if (metric.samples < limits.minSamples) failures.push(`${path} has ${metric.samples} samples; requires ${limits.minSamples}`)
    if (metric.p95Ms > limits.p95Ms) failures.push(`${path}.p95Ms ${metric.p95Ms} exceeds ${limits.p95Ms}`)
    if (metric.p99Ms > limits.p99Ms) failures.push(`${path}.p99Ms ${metric.p99Ms} exceeds ${limits.p99Ms}`)
  }
  if (!Array.isArray(metric?.evidence) || metric.evidence.length === 0) {
    failures.push(`${path}.evidence must contain at least one traceable reference`)
  }
}

export function validateQualityEvidence(document, options = {}) {
  const failures = []
  const warnings = []
  if (document?.schemaVersion !== 1) failures.push('schemaVersion must equal 1')
  requireText(failures, document?.project, 'project')
  requireText(failures, document?.version, 'version')
  if (!Number.isFinite(Date.parse(document?.generatedAt))) failures.push('generatedAt must be an ISO timestamp')
  if (!['ALLOW', 'DENY'].includes(document?.decision)) failures.push('decision must be ALLOW or DENY')

  const source = document?.source ?? {}
  requireText(failures, source.commitSha, 'source.commitSha')
  if (typeof source.dirty !== 'boolean') failures.push('source.dirty must be boolean')
  if (options.requireImmutable) {
    if (!/^[0-9a-f]{40}$/.test(source.commitSha ?? '')) failures.push('immutable evidence requires a full 40-character commit SHA')
    if (source.dirty !== false) failures.push('immutable evidence cannot come from a dirty worktree')
    requireText(failures, document?.ci?.provider, 'ci.provider')
    requireText(failures, document?.ci?.runId, 'ci.runId')
  }

  if (!Array.isArray(document?.testRuns) || document.testRuns.length === 0) {
    failures.push('testRuns must contain at least one test run')
  } else {
    document.testRuns.forEach((run, index) => validateTestRun(run, index, failures))
  }
  if (!Array.isArray(document?.performance)) failures.push('performance must be an array')
  else document.performance.forEach((metric, index) => validatePerformance(metric, index, failures))

  const requiredGateFailure = (document?.testRuns ?? []).some((run) => run.required && run.status !== 'pass')
    || (document?.performance ?? []).some((metric) => metric.required && metric.status !== 'pass')
  if (document?.decision === 'ALLOW' && requiredGateFailure) failures.push('decision ALLOW conflicts with a failed required gate')
  if (document?.decision === 'DENY' && !requiredGateFailure) {
    warnings.push('decision DENY has no failed required automated gate; record the external or manual blocker in notes')
  }
  if (options.requireReleasePass && document?.decision !== 'ALLOW') failures.push('release-pass verification requires decision ALLOW')
  if (options.requireReleasePass && requiredGateFailure) failures.push('release-pass verification requires every required gate to pass')

  if (options.requireDeployment) {
    const deployment = document?.deployment ?? {}
    if (!/^sha256:[0-9a-f]{64}$/.test(deployment.imageDigest ?? '')) {
      failures.push('deployment.imageDigest must be an immutable sha256 digest')
    }
    if (deployment.deployedCommitSha !== source.commitSha) {
      failures.push('deployment.deployedCommitSha must match source.commitSha')
    }
    if (deployment.rollbackVerified !== true) failures.push('deployment.rollbackVerified must be true')
  }

  return { passed: failures.length === 0, failures, warnings }
}

async function main() {
  const input = option('input')
  if (!input) throw new Error('Usage: node scripts/verify-quality-evidence.mjs --input <file> [--output <file>] [--require-immutable] [--require-release-pass] [--require-deployment]')
  const document = JSON.parse(await readFile(resolve(input), 'utf8'))
  const report = validateQualityEvidence(document, {
    requireImmutable: flag('require-immutable'),
    requireReleasePass: flag('require-release-pass'),
    requireDeployment: flag('require-deployment'),
  })
  const serialized = `${JSON.stringify(report, null, 2)}\n`
  const output = option('output')
  if (output) await writeFile(resolve(output), serialized, 'utf8')
  process.stdout.write(serialized)
  if (!report.passed) process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
