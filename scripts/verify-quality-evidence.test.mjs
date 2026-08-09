import assert from 'node:assert/strict'
import test from 'node:test'
import { qualityPolicyDigest, validateQualityEvidence } from './verify-quality-evidence.mjs'

function validEvidence() {
  return {
    schemaVersion: 2,
    project: 'example-app',
    version: '1.2.3',
    qualityProfile: { id: 'commercial-release-v1', policyRef: 'unbound-policy-reference' },
    generatedAt: new Date().toISOString(),
    decision: 'ALLOW',
    source: { commitSha: 'a'.repeat(40), dirty: false },
    environment: { id: 'github-actions:123', name: 'github-actions' },
    ci: { provider: 'github-actions', runId: '123' },
    requiredGateIds: ['functional', 'api-read'],
    testRuns: [{
      id: 'functional', kind: 'functional', required: true, status: 'pass',
      total: 10, passed: 10, failed: 0, blocked: 0, notRun: 0,
      evidence: ['artifact:functional-123'],
    }],
    performance: [{
      id: 'api-read', required: true, conclusionLevel: 'regression', status: 'pass', samples: 300, successful: 300, failures: 0,
      p50Ms: 80, p95Ms: 120, p99Ms: 180, maxMs: 220,
      limits: { minSamples: 300, p95Ms: 200, p99Ms: 300 },
      environmentRef: 'github-actions:123',
      workload: {
        profile: 'steady-arrival-v1', model: 'open-arrival-rate', targetRps: 1,
        achievedLaunchRps: 1, maxConcurrency: 10, schedulingDelayP95Ms: 5,
      },
      evidence: ['artifact:performance-123'],
    }],
    deployment: {
      imageDigest: `sha256:${'b'.repeat(64)}`,
      deployedCommitSha: 'a'.repeat(40),
      rollbackVerified: true,
      evidence: ['artifact:deployment-123'],
    },
  }
}

function validPolicy() {
  const policy = {
    schemaVersion: 1,
    id: 'example-quality-policy-v1',
    profiles: {
      'commercial-release-v1': {
        maximumEvidenceAgeHours: 24,
        requiredTestRunIds: ['functional'],
        performance: { 'api-read': { minSamples: 300, p95Ms: 200, p99Ms: 300 } },
      },
    },
  }
  return policy
}

function bindPolicy(evidence, policy) {
  evidence.qualityProfile.policyRef = `${policy.id}@sha256:${qualityPolicyDigest(policy)}`
  return evidence
}

test('accepts internally consistent immutable release and deployment evidence', () => {
  const policy = validPolicy()
  const report = validateQualityEvidence(bindPolicy(validEvidence(), policy), {
    requireImmutable: true, requireReleasePass: true, requireDeployment: true,
    policy,
  })
  assert.equal(report.passed, true)
  assert.deepEqual(report.failures, [])
})

test('rejects false pass claims, under-sampled performance and dirty sources', () => {
  const policy = validPolicy()
  const evidence = bindPolicy(validEvidence(), policy)
  evidence.source.dirty = true
  evidence.testRuns[0].failed = 1
  evidence.testRuns[0].passed = 9
  evidence.performance[0].samples = 20
  evidence.performance[0].p95Ms = 500
  const report = validateQualityEvidence(evidence, { requireImmutable: true, requireReleasePass: true, policy })
  assert.equal(report.passed, false)
  assert.match(report.failures.join('\n'), /dirty worktree/)
  assert.match(report.failures.join('\n'), /claims pass/)
  assert.match(report.failures.join('\n'), /requires 300/)
  assert.match(report.failures.join('\n'), /exceeds 200/)
})

test('does not allow a required blocked gate to be released', () => {
  const policy = validPolicy()
  const evidence = bindPolicy(validEvidence(), policy)
  evidence.testRuns[0] = {
    ...evidence.testRuns[0], status: 'blocked', passed: 8, blocked: 2,
  }
  evidence.decision = 'DENY'
  const internallyConsistent = validateQualityEvidence(evidence)
  assert.equal(internallyConsistent.passed, true)
  const release = validateQualityEvidence(evidence, { requireReleasePass: true, policy })
  assert.match(release.failures.join('\n'), /requires decision ALLOW/)
  assert.match(release.failures.join('\n'), /every required gate to pass/)
})

test('rejects missing gates, duplicate IDs, placeholder evidence and future timestamps', () => {
  const evidence = validEvidence()
  evidence.generatedAt = '2999-01-01T00:00:00.000Z'
  evidence.requiredGateIds.push('security')
  evidence.testRuns.push({ ...evidence.testRuns[0], evidence: [''] })
  const report = validateQualityEvidence(evidence)
  assert.equal(report.passed, false)
  assert.match(report.failures.join('\n'), /future/)
  assert.match(report.failures.join('\n'), /must be unique/)
  assert.match(report.failures.join('\n'), /non-empty string/)
  assert.match(report.failures.join('\n'), /required gate security is missing/)
})

test('rejects fail status with zero failed cases and deployment without immutable source', () => {
  const policy = validPolicy()
  const evidence = bindPolicy(validEvidence(), policy)
  evidence.testRuns[0].status = 'fail'
  evidence.source.commitSha = 'short'
  evidence.source.dirty = true
  const report = validateQualityEvidence(evidence, { requireDeployment: true, policy })
  assert.equal(report.passed, false)
  assert.match(report.failures.join('\n'), /failed count is zero/)
  assert.match(report.failures.join('\n'), /full 40-character/)
  assert.match(report.failures.join('\n'), /dirty worktree/)
})

test('rejects a green performance gate without workload details', () => {
  const evidence = validEvidence()
  evidence.testRuns.push({
    id: 'performance', kind: 'performance-gate', required: true, status: 'pass',
    total: 1, passed: 1, failed: 0, blocked: 0, notRun: 0,
    evidence: ['github-job:performance:123'],
  })
  evidence.requiredGateIds.push('performance')
  evidence.performance = []
  const report = validateQualityEvidence(evidence)
  assert.equal(report.passed, false)
  assert.match(report.failures.join('\n'), /must include route-level performance evidence/)
})

test('rejects performance evidence without environment and workload identity', () => {
  const evidence = validEvidence()
  delete evidence.performance[0].environmentRef
  delete evidence.performance[0].workload
  const report = validateQualityEvidence(evidence)
  assert.equal(report.passed, false)
  assert.match(report.failures.join('\n'), /environmentRef/)
  assert.match(report.failures.join('\n'), /workload.profile/)
})

test('reports malformed performance data instead of crashing', () => {
  const evidence = validEvidence()
  evidence.performance[0].limits = undefined
  const report = validateQualityEvidence(evidence)
  assert.equal(report.passed, false)
  assert.match(report.failures.join('\n'), /limits.minSamples/)

  evidence.performance = undefined
  const missing = validateQualityEvidence(evidence)
  assert.equal(missing.passed, false)
  assert.match(missing.failures.join('\n'), /performance must be an array/)
})

test('rejects a release that deletes policy-required gates or weakens performance limits', () => {
  const policy = validPolicy()
  const evidence = bindPolicy(validEvidence(), policy)
  evidence.testRuns = []
  evidence.performance[0].limits.minSamples = 1
  const report = validateQualityEvidence(evidence, { requireReleasePass: true, policy })
  assert.equal(report.passed, false)
  assert.match(report.failures.join('\n'), /policy-required test gate functional is missing/)
  assert.match(report.failures.join('\n'), /must equal policy value 300/)
})

test('release-pass automatically rejects mutable source and zero-case passes', () => {
  const policy = validPolicy()
  const evidence = bindPolicy(validEvidence(), policy)
  evidence.source.dirty = true
  evidence.source.commitSha = 'short'
  evidence.testRuns[0] = { ...evidence.testRuns[0], total: 0, passed: 0 }
  const report = validateQualityEvidence(evidence, { requireReleasePass: true, policy })
  assert.equal(report.passed, false)
  assert.match(report.failures.join('\n'), /full 40-character/)
  assert.match(report.failures.join('\n'), /dirty worktree/)
  assert.match(report.failures.join('\n'), /zero cases/)
})

test('rejects inconsistent environment and impossible percentile ordering', () => {
  const evidence = validEvidence()
  evidence.performance[0].environmentRef = 'candidate-b'
  evidence.performance[0].p50Ms = 190
  const report = validateQualityEvidence(evidence)
  assert.equal(report.passed, false)
  assert.match(report.failures.join('\n'), /must match environment.id/)
  assert.match(report.failures.join('\n'), /p50 <= p95/)
})

test('does not let a PR-sized sample claim production capacity', () => {
  const evidence = validEvidence()
  evidence.performance[0].conclusionLevel = 'capacity'
  evidence.performance[0].repetitions = 1
  const report = validateQualityEvidence(evidence)
  assert.equal(report.passed, false)
  assert.match(report.failures.join('\n'), /at least 1000 samples/)
  assert.match(report.failures.join('\n'), /at least three repetitions/)
})

test('accepts a separately identified representative peak conclusion', () => {
  const document = validEvidence()
  document.performance[0].conclusionLevel = 'representative_peak'
  assert.equal(validateQualityEvidence(document).passed, true)
})

test('binds release evidence to the exact policy identity and digest', () => {
  const policy = validPolicy()
  const evidence = bindPolicy(validEvidence(), policy)
  evidence.qualityProfile.policyRef = 'example-quality-policy-v1@sha256:' + '0'.repeat(64)
  const mismatched = validateQualityEvidence(evidence, { requireReleasePass: true, policy })
  assert.equal(mismatched.passed, false)
  assert.match(mismatched.failures.join('\n'), /must equal loaded policy identity/)

  const invalidSchema = { ...policy, schemaVersion: 999 }
  evidence.qualityProfile.policyRef = `${invalidSchema.id}@sha256:${qualityPolicyDigest(invalidSchema)}`
  const malformed = validateQualityEvidence(evidence, { requireReleasePass: true, policy: invalidSchema })
  assert.match(malformed.failures.join('\n'), /schemaVersion must equal 1/)
})
