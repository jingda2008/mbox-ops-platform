import assert from 'node:assert/strict'
import test from 'node:test'
import { validateQualityEvidence } from './verify-quality-evidence.mjs'

function validEvidence() {
  return {
    schemaVersion: 1,
    project: 'example-app',
    version: '1.2.3',
    generatedAt: '2026-08-09T00:00:00.000Z',
    decision: 'ALLOW',
    source: { commitSha: 'a'.repeat(40), dirty: false },
    ci: { provider: 'github-actions', runId: '123' },
    testRuns: [{
      id: 'functional', kind: 'functional', required: true, status: 'pass',
      total: 10, passed: 10, failed: 0, blocked: 0, notRun: 0,
      evidence: ['artifact:functional-123'],
    }],
    performance: [{
      id: 'api-read', required: true, status: 'pass', samples: 300, failures: 0,
      p95Ms: 120, p99Ms: 180, limits: { minSamples: 300, p95Ms: 200, p99Ms: 300 },
      evidence: ['artifact:performance-123'],
    }],
    deployment: {
      imageDigest: `sha256:${'b'.repeat(64)}`,
      deployedCommitSha: 'a'.repeat(40),
      rollbackVerified: true,
    },
  }
}

test('accepts internally consistent immutable release and deployment evidence', () => {
  const report = validateQualityEvidence(validEvidence(), {
    requireImmutable: true, requireReleasePass: true, requireDeployment: true,
  })
  assert.equal(report.passed, true)
  assert.deepEqual(report.failures, [])
})

test('rejects false pass claims, under-sampled performance and dirty sources', () => {
  const evidence = validEvidence()
  evidence.source.dirty = true
  evidence.testRuns[0].failed = 1
  evidence.testRuns[0].passed = 9
  evidence.performance[0].samples = 20
  evidence.performance[0].p95Ms = 500
  const report = validateQualityEvidence(evidence, { requireImmutable: true, requireReleasePass: true })
  assert.equal(report.passed, false)
  assert.match(report.failures.join('\n'), /dirty worktree/)
  assert.match(report.failures.join('\n'), /claims pass/)
  assert.match(report.failures.join('\n'), /requires 300/)
  assert.match(report.failures.join('\n'), /exceeds 200/)
})

test('does not allow a required blocked gate to be released', () => {
  const evidence = validEvidence()
  evidence.testRuns[0] = {
    ...evidence.testRuns[0], status: 'blocked', passed: 8, blocked: 2,
  }
  evidence.decision = 'DENY'
  const internallyConsistent = validateQualityEvidence(evidence)
  assert.equal(internallyConsistent.passed, true)
  const release = validateQualityEvidence(evidence, { requireReleasePass: true })
  assert.match(release.failures.join('\n'), /requires decision ALLOW/)
  assert.match(release.failures.join('\n'), /every required gate to pass/)
})
