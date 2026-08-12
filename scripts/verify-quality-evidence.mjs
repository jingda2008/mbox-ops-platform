import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
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

function validateEvidenceReferences(references, path, failures) {
  if (!Array.isArray(references) || references.length === 0) {
    failures.push(`${path} must contain at least one traceable reference`)
    return
  }
  references.forEach((reference, index) => {
    if (typeof reference !== 'string' || !reference.trim()) {
      failures.push(`${path}[${index}] must be a non-empty string`)
    } else if (/replace-with|example|todo|tbd/i.test(reference)) {
      failures.push(`${path}[${index}] contains a placeholder rather than evidence`)
    } else if (!/^(github-job|artifact|file-sha256|deployment):[^\s]+$/.test(reference)) {
      failures.push(`${path}[${index}] must use a traceable evidence reference scheme`)
    }
  })
}

function validateArtifactStatus(record, path, failures) {
  if (!['available', 'missing', 'unverified', 'not_applicable'].includes(record?.artifactStatus)) {
    failures.push(`${path}.artifactStatus is invalid`)
    return
  }
  if (record.status === 'not_run' && record.artifactStatus !== 'not_applicable') {
    failures.push(`${path} not_run evidence must use artifactStatus=not_applicable`)
  }
  if (record.status !== 'not_run' && record.artifactStatus === 'not_applicable') {
    failures.push(`${path} executed evidence cannot use artifactStatus=not_applicable`)
  }
}

function validateValidity(record, path, failures) {
  if (!['valid', 'invalid'].includes(record?.validityStatus)) {
    failures.push(`${path}.validityStatus is invalid`)
    return
  }
  if (record.validityStatus === 'invalid') {
    if (!String(record.invalidReason ?? '').trim()) failures.push(`${path}.invalidReason is required when validityStatus=invalid`)
    if (record.status === 'pass') failures.push(`${path} invalid evidence cannot pass`)
  } else if (String(record.invalidReason ?? '').trim()) {
    failures.push(`${path}.invalidReason must be empty when validityStatus=valid`)
  }
}

function validateTestRun(run, index, failures) {
  const path = `testRuns[${index}]`
  requireText(failures, run?.id, `${path}.id`)
  requireText(failures, run?.kind, `${path}.kind`)
  if (typeof run?.required !== 'boolean') failures.push(`${path}.required must be boolean`)
  if (!['pass', 'fail', 'blocked', 'not_run'].includes(run?.status)) {
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
  if (run?.required === true && run?.status === 'pass' && run.total < 1) failures.push(`${path} cannot pass with zero cases`)
  if (run?.status === 'fail' && run.failed === 0) failures.push(`${path} claims fail but failed count is zero`)
  if (run?.status === 'blocked' && run.blocked === 0) failures.push(`${path} claims blocked but blocked count is zero`)
  if (run?.status === 'not_run' && run.notRun === 0) failures.push(`${path} claims not_run but notRun count is zero`)
  validateEvidenceReferences(run?.evidence, `${path}.evidence`, failures)
  validateArtifactStatus(run, path, failures)
  validateValidity(run, path, failures)
}

function validatePerformance(metric, index, failures) {
  const path = `performance[${index}]`
  requireText(failures, metric?.id, `${path}.id`)
  requireText(failures, metric?.environmentRef, `${path}.environmentRef`)
  requireText(failures, metric?.workload?.profile, `${path}.workload.profile`)
  requireText(failures, metric?.workload?.model, `${path}.workload.model`)
  if (!['regression', 'representative_peak', 'capacity'].includes(metric?.conclusionLevel)) {
    failures.push(`${path}.conclusionLevel is invalid`)
  }
  if (typeof metric?.required !== 'boolean') failures.push(`${path}.required must be boolean`)
  if (!isNonNegativeInteger(metric?.samples)) failures.push(`${path}.samples must be a non-negative integer`)
  if (!isNonNegativeInteger(metric?.successful)) failures.push(`${path}.successful must be a non-negative integer`)
  if (!isNonNegativeInteger(metric?.failures)) failures.push(`${path}.failures must be a non-negative integer`)
  if (isNonNegativeInteger(metric?.samples) && isNonNegativeInteger(metric?.successful) && isNonNegativeInteger(metric?.failures)
    && metric.successful + metric.failures !== metric.samples) {
    failures.push(`${path} sample counts do not reconcile`)
  }
  for (const field of ['p50Ms', 'p95Ms', 'p99Ms', 'maxMs']) {
    if (!Number.isFinite(metric?.[field]) || metric[field] < 0) failures.push(`${path}.${field} must be a non-negative number`)
  }
  if (['p50Ms', 'p95Ms', 'p99Ms', 'maxMs'].every((field) => Number.isFinite(metric?.[field]))
    && !(metric.p50Ms <= metric.p95Ms && metric.p95Ms <= metric.p99Ms && metric.p99Ms <= metric.maxMs)) {
    failures.push(`${path} latency percentiles must satisfy p50 <= p95 <= p99 <= max`)
  }
  const limits = metric?.limits
  if (!isNonNegativeInteger(limits?.minSamples) || limits.minSamples < 1) {
    failures.push(`${path}.limits.minSamples must be a positive integer`)
  }
  for (const field of ['p95Ms', 'p99Ms']) {
    if (!Number.isFinite(limits?.[field]) || limits[field] <= 0) failures.push(`${path}.limits.${field} must be positive`)
  }
  if (!['pass', 'fail', 'blocked', 'not_run'].includes(metric?.status)) {
    failures.push(`${path}.status is invalid`)
  }
  if (metric?.status === 'pass') {
    if (metric.samples < 1) failures.push(`${path} cannot pass with zero samples`)
    if (metric.failures !== 0) failures.push(`${path} has ${metric.failures} failed samples`)
    if (Number.isFinite(limits?.minSamples) && metric.samples < limits.minSamples) {
      failures.push(`${path} has ${metric.samples} samples; requires ${limits.minSamples}`)
    }
    if (Number.isFinite(limits?.p95Ms) && metric.p95Ms > limits.p95Ms) {
      failures.push(`${path}.p95Ms ${metric.p95Ms} exceeds ${limits.p95Ms}`)
    }
    if (Number.isFinite(limits?.p99Ms) && metric.p99Ms > limits.p99Ms) {
      failures.push(`${path}.p99Ms ${metric.p99Ms} exceeds ${limits.p99Ms}`)
    }
  }
  if (metric?.workload?.model === 'open-arrival-rate') {
    for (const field of ['targetRps', 'achievedLaunchRps']) {
      if (!Number.isFinite(metric.workload[field]) || metric.workload[field] <= 0) failures.push(`${path}.workload.${field} must be positive`)
    }
    if (!Number.isSafeInteger(metric.workload.maxConcurrency) || metric.workload.maxConcurrency < 1) {
      failures.push(`${path}.workload.maxConcurrency must be a positive integer`)
    }
    if (!Number.isFinite(metric.workload.schedulingDelayP95Ms) || metric.workload.schedulingDelayP95Ms < 0) {
      failures.push(`${path}.workload.schedulingDelayP95Ms must be non-negative`)
    }
    if (metric?.status === 'pass' && Number.isFinite(metric.workload.targetRps)
      && metric.workload.achievedLaunchRps < metric.workload.targetRps * 0.98) {
      failures.push(`${path} did not achieve 98% of target arrival rate`)
    }
  }
  if (metric?.conclusionLevel === 'capacity') {
    if (limits?.minSamples < 1_000) failures.push(`${path} capacity conclusion requires at least 1000 samples`)
    if (!Number.isSafeInteger(metric?.repetitions) || metric.repetitions < 3) {
      failures.push(`${path} capacity conclusion requires at least three repetitions`)
    }
  }
  validateEvidenceReferences(metric?.evidence, `${path}.evidence`, failures)
  validateArtifactStatus(metric, path, failures)
  validateValidity(metric, path, failures)
}

function validatePolicy(document, policy, failures) {
  if (!policy || typeof policy !== 'object') {
    failures.push('release-pass verification requires a loaded quality policy')
    return
  }
  if (policy.schemaVersion !== 1) failures.push('quality policy schemaVersion must equal 1')
  requireText(failures, policy.id, 'quality policy id')
  if (typeof policy.id === 'string' && policy.id.trim()) {
    const expectedRef = `${policy.id}@sha256:${qualityPolicyDigest(policy)}`
    if (document?.qualityProfile?.policyRef !== expectedRef) {
      failures.push(`qualityProfile.policyRef must equal loaded policy identity ${expectedRef}`)
    }
  }
  const profile = policy.profiles?.[document?.qualityProfile?.id]
  if (!profile) {
    failures.push(`quality profile ${document?.qualityProfile?.id ?? '(missing)'} is not defined by policy`)
    return
  }
  const testRuns = Array.isArray(document?.testRuns) ? document.testRuns : []
  const performance = Array.isArray(document?.performance) ? document.performance : []
  for (const id of profile.requiredTestRunIds ?? []) {
    if (!testRuns.some((run) => run?.id === id && run?.required === true)) failures.push(`policy-required test gate ${id} is missing`)
  }
  for (const [id, limits] of Object.entries(profile.performance ?? {})) {
    const metric = performance.find((candidate) => candidate?.id === id && candidate?.required === true)
    if (!metric) {
      failures.push(`policy-required performance gate ${id} is missing`)
      continue
    }
    for (const field of ['minSamples', 'p95Ms', 'p99Ms']) {
      if (metric.limits?.[field] !== limits[field]) failures.push(`${id}.limits.${field} must equal policy value ${limits[field]}`)
    }
  }
  const maximumAgeHours = profile.maximumEvidenceAgeHours
  const generatedAt = Date.parse(document?.generatedAt)
  if (Number.isFinite(maximumAgeHours) && Number.isFinite(generatedAt)
    && generatedAt < Date.now() - maximumAgeHours * 60 * 60_000) {
    failures.push(`quality evidence is older than policy limit of ${maximumAgeHours} hours`)
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]))
}

export function qualityPolicyDigest(policy) {
  return createHash('sha256').update(JSON.stringify(canonicalJson(policy))).digest('hex')
}

export function validateQualityEvidence(document, options = {}) {
  const failures = []
  const warnings = []
  if (document?.schemaVersion !== 2) failures.push('schemaVersion must equal 2')
  requireText(failures, document?.project, 'project')
  requireText(failures, document?.version, 'version')
  requireText(failures, document?.qualityProfile?.id, 'qualityProfile.id')
  requireText(failures, document?.qualityProfile?.policyRef, 'qualityProfile.policyRef')
  requireText(failures, document?.environment?.id, 'environment.id')
  const generatedAt = Date.parse(document?.generatedAt)
  if (!Number.isFinite(generatedAt)) failures.push('generatedAt must be an ISO timestamp')
  else if (generatedAt > Date.now() + 5 * 60_000) failures.push('generatedAt cannot be more than five minutes in the future')
  if (!['ALLOW', 'DENY'].includes(document?.decision)) failures.push('decision must be ALLOW or DENY')

  const source = document?.source ?? {}
  requireText(failures, source.commitSha, 'source.commitSha')
  if (typeof source.dirty !== 'boolean') failures.push('source.dirty must be boolean')
  const requireImmutable = options.requireImmutable || options.requireReleasePass || options.requireDeployment
  if (requireImmutable) {
    if (!/^[0-9a-f]{40}$/.test(source.commitSha ?? '')) failures.push('immutable evidence requires a full 40-character commit SHA')
    if (source.dirty !== false) failures.push('immutable evidence cannot come from a dirty worktree')
    requireText(failures, document?.ci?.provider, 'ci.provider')
    requireText(failures, document?.ci?.runId, 'ci.runId')
  }

  if (source.proposedHeadSha !== undefined && !/^[0-9a-f]{40}$/.test(source.proposedHeadSha)) {
    failures.push('source.proposedHeadSha must be a full 40-character commit SHA when supplied')
  }

  const testRuns = Array.isArray(document?.testRuns) ? document.testRuns : []
  const performance = Array.isArray(document?.performance) ? document.performance : []
  if (testRuns.length === 0) {
    failures.push('testRuns must contain at least one test run')
  } else {
    testRuns.forEach((run, index) => validateTestRun(run, index, failures))
  }
  if (!Array.isArray(document?.performance)) failures.push('performance must be an array')
  else performance.forEach((metric, index) => validatePerformance(metric, index, failures))
  for (const [index, metric] of performance.entries()) {
    if (metric?.environmentRef !== document?.environment?.id) {
      failures.push(`performance[${index}].environmentRef must match environment.id`)
    }
  }
  const requiresPerformanceDetails = testRuns.some((run) => (
    run?.required === true && run?.kind === 'performance-gate' && run?.status === 'pass'
  ))
  if (requiresPerformanceDetails && (!Array.isArray(document?.performance) || document.performance.length === 0)) {
    failures.push('a passed required performance-gate must include route-level performance evidence')
  }

  const gateRecords = [...testRuns, ...performance]
  const gateIds = gateRecords.map((gate) => gate?.id).filter((id) => typeof id === 'string' && id.trim())
  if (new Set(gateIds).size !== gateIds.length) failures.push('test and performance gate IDs must be unique')
  if (!Array.isArray(document?.requiredGateIds) || document.requiredGateIds.length === 0) {
    failures.push('requiredGateIds must declare at least one required release gate')
  } else {
    const requiredGateIds = document.requiredGateIds
    if (requiredGateIds.some((id) => typeof id !== 'string' || !id.trim())) failures.push('requiredGateIds must contain non-empty strings')
    if (new Set(requiredGateIds).size !== requiredGateIds.length) failures.push('requiredGateIds must be unique')
    for (const id of requiredGateIds) {
      const gate = gateRecords.find((candidate) => candidate?.id === id)
      if (!gate) failures.push(`required gate ${id} is missing from testRuns and performance`)
      else if (gate.required !== true) failures.push(`required gate ${id} must set required=true`)
    }
  }

  const requiredGateFailure = testRuns.some((run) => run.required && run.status !== 'pass')
    || performance.some((metric) => metric.required && metric.status !== 'pass')
  if (document?.decision === 'ALLOW' && requiredGateFailure) failures.push('decision ALLOW conflicts with a failed required gate')
  if (document?.decision === 'DENY' && !requiredGateFailure) {
    warnings.push('decision DENY has no failed required automated gate; record the external or manual blocker in notes')
  }
  if (options.requireReleasePass && document?.decision !== 'ALLOW') failures.push('release-pass verification requires decision ALLOW')
  if (options.requireReleasePass && requiredGateFailure) failures.push('release-pass verification requires every required gate to pass')
  if (options.requireReleasePass && gateRecords.some((gate) => gate.required && gate.artifactStatus !== 'available')) {
    failures.push('release-pass verification requires available evidence artifacts for every required gate')
  }
  if (options.requireReleasePass && gateRecords.some((gate) => gate.required && gate.validityStatus !== 'valid')) {
    failures.push('release-pass verification requires valid execution evidence for every required gate')
  }
  if (options.requireReleasePass || options.requireDeployment) validatePolicy(document, options.policy, failures)

  if (options.requireDeployment) {
    if (!/^[0-9a-f]{40}$/.test(source.commitSha ?? '')) failures.push('deployment evidence requires a full 40-character source commit SHA')
    if (source.dirty !== false) failures.push('deployment evidence cannot come from a dirty worktree')
    const deployment = document?.deployment ?? {}
    if (!/^sha256:[0-9a-f]{64}$/.test(deployment.imageDigest ?? '')) {
      failures.push('deployment.imageDigest must be an immutable sha256 digest')
    }
    if (deployment.deployedCommitSha !== source.commitSha) {
      failures.push('deployment.deployedCommitSha must match source.commitSha')
    }
    if (deployment.rollbackVerified !== true) failures.push('deployment.rollbackVerified must be true')
    validateEvidenceReferences(deployment.evidence, 'deployment.evidence', failures)
  }

  return { passed: failures.length === 0, failures, warnings }
}

async function main() {
  const input = option('input')
  if (!input) throw new Error('Usage: node scripts/verify-quality-evidence.mjs --input <file> [--policy <file>] [--output <file>] [--require-immutable] [--require-release-pass] [--require-deployment]')
  const document = JSON.parse(await readFile(resolve(input), 'utf8'))
  const policyInput = option('policy')
  const policy = policyInput ? JSON.parse(await readFile(resolve(policyInput), 'utf8')) : undefined
  const report = validateQualityEvidence(document, {
    requireImmutable: flag('require-immutable'),
    requireReleasePass: flag('require-release-pass'),
    requireDeployment: flag('require-deployment'),
    policy,
  })
  const serialized = `${JSON.stringify(report, null, 2)}\n`
  const output = option('output')
  if (output) await writeFile(resolve(output), serialized, 'utf8')
  process.stdout.write(serialized)
  if (!report.passed) process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
