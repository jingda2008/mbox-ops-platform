import assert from 'node:assert/strict'
import test from 'node:test'
import { parseRequiredTcBaseline, validateTcRegister, verifyTcRegisterFile } from './verify-tc-register.mjs'

const headers = [
  'tc_id', 'requirement_id', 'priority', 'risk_area', 'role', 'preconditions', 'steps',
  'expected_result', 'status', 'automation_level', 'evidence', 'owner', 'environment',
  'commit_sha', 'ci_run_id', 'defect_id', 'last_executed_at',
]

function row(overrides = {}) {
  return {
    tc_id: 'TC-001', requirement_id: 'REQ-001', priority: 'P1', risk_area: 'order', role: 'customer',
    preconditions: 'table open', steps: 'submit once', expected_result: 'one order', status: 'pass',
    automation_level: 'automated', evidence: 'artifact:test', owner: 'qa', environment: 'candidate',
    commit_sha: 'a'.repeat(40), ci_run_id: '123', defect_id: '', last_executed_at: new Date().toISOString(),
    ...overrides,
  }
}

test('accepts a traceable TC register row', () => {
  assert.equal(validateTcRegister([row()], headers).passed, true)
})

test('rejects an empty register and blocks unfinished P0/P1 in release mode', () => {
  assert.equal(validateTcRegister([], headers).passed, false)
  const planning = validateTcRegister([row({ status: 'blocked' })], headers)
  assert.equal(planning.passed, true)
  assert.equal(planning.warnings.length, 1)
  const release = validateTcRegister([row({ status: 'blocked' })], headers, {
    requireReleasePass: true,
    requiredTcIds: ['TC-001'],
    expectedCommitSha: 'a'.repeat(40),
    maximumEvidenceAgeDays: 7,
  })
  assert.equal(release.passed, false)
  assert.match(release.failures.join('\n'), /unfinished release-critical TC/)
})

test('release mode cannot omit baseline, candidate commit or evidence age', () => {
  const report = validateTcRegister([row()], headers, { requireReleasePass: true })
  assert.equal(report.passed, false)
  assert.match(report.failures.join('\n'), /non-empty required TC baseline/)
  assert.match(report.failures.join('\n'), /requires expectedCommitSha/)
  assert.match(report.failures.join('\n'), /requires maximumEvidenceAgeDays/)
})

test('rejects formula injection, unassigned execution and loose timestamps', () => {
  const report = validateTcRegister([
    row({ tc_id: 'TC-FORMULA', steps: '=HYPERLINK("https://example.invalid")' }),
    row({ tc_id: 'TC-OWNER', owner: 'unassigned' }),
    row({ tc_id: 'TC-TIME', last_executed_at: '2026-08-09' }),
  ], headers)
  assert.equal(report.passed, false)
  assert.match(report.failures.join('\n'), /spreadsheet formula/)
  assert.match(report.failures.join('\n'), /assigned owner/)
  assert.match(report.failures.join('\n'), /strict ISO timestamp/)
})

test('rejects duplicate IDs and false passed rows', () => {
  const report = validateTcRegister([row(), row({ evidence: '', commit_sha: '', last_executed_at: '' })], headers)
  assert.equal(report.passed, false)
  assert.match(report.failures.join('\n'), /duplicates tc_id/)
  assert.match(report.failures.join('\n'), /executed TC requires evidence/)
  assert.match(report.failures.join('\n'), /executed TC requires commit_sha/)
})

test('rejects a register that silently deletes a required TC', () => {
  const report = validateTcRegister([row()], headers, { requiredTcIds: ['TC-001', 'TC-002'] })
  assert.equal(report.passed, false)
  assert.match(report.failures.join('\n'), /required TC TC-002 is missing/)
})

test('rejects stale evidence and evidence from another commit', () => {
  const nowMs = Date.parse('2026-08-09T12:00:00.000Z')
  const report = validateTcRegister([row({
    commit_sha: 'b'.repeat(40),
    last_executed_at: '2026-08-01T12:00:00.000Z',
  })], headers, {
    expectedCommitSha: 'a'.repeat(40),
    maximumEvidenceAgeDays: 7,
    nowMs,
  })
  assert.equal(report.passed, false)
  assert.match(report.failures.join('\n'), /older than 7 day/)
  assert.match(report.failures.join('\n'), /does not match expected commit/)
})

test('parses a required TC baseline and rejects duplicate baseline IDs', () => {
  assert.deepEqual(parseRequiredTcBaseline('# required\nTC-001\n\nTC-002\n'), ['TC-001', 'TC-002'])
  assert.throws(() => parseRequiredTcBaseline('TC-001\nTC-001\n'), /duplicate IDs/)
})

test('rejects untraceable failures, future execution and automated passes without a CI run', () => {
  const report = validateTcRegister([
    row({ tc_id: 'TC-FAIL', status: 'fail', defect_id: '' }),
    row({ tc_id: 'TC-FUTURE', last_executed_at: '2999-01-01T00:00:00.000Z' }),
    row({ tc_id: 'TC-NO-CI', ci_run_id: '' }),
  ], headers)
  assert.equal(report.passed, false)
  assert.match(report.failures.join('\n'), /failed TC requires defect_id/)
  assert.match(report.failures.join('\n'), /cannot be in the future/)
  assert.match(report.failures.join('\n'), /requires ci_run_id/)
})

test('the reusable CSV template is structurally valid', async () => {
  const report = await verifyTcRegisterFile('docs/templates/software-tc-register-template.csv')
  assert.equal(report.passed, true)
})
