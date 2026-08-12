import assert from 'node:assert/strict'
import test from 'node:test'
import { validateInvariantRegister, validateStateMachine } from './verify-quality-model.mjs'

const headers = [
  'invariant_id', 'entity', 'severity', 'expression', 'authoritative_source', 'check_timing',
  'consistency_window_ms', 'tc_ids', 'production_monitor', 'evidence', 'status',
]

function machine() {
  return {
    schemaVersion: 1,
    id: 'order-lifecycle-v1',
    entity: 'order',
    initialState: 'created',
    terminalStates: ['completed'],
    states: ['created', 'processing', 'completed'],
    transitions: [
      { id: 'start', from: ['created'], to: 'processing', roles: ['operator'], guard: 'order is payable', sideEffects: ['database order status'], compensation: 'none', tcIds: ['TC-001'] },
      { id: 'complete', from: ['processing'], to: 'completed', roles: ['operator'], guard: 'work is verified', sideEffects: ['database order status'], compensation: 'none', tcIds: ['TC-002'] },
    ],
    forbiddenTransitions: [{ from: 'completed', to: 'processing', reason: 'terminal state cannot regress', tcIds: ['TC-002'] }],
  }
}

function invariant(overrides = {}) {
  return {
    invariant_id: 'INV-001', entity: 'order', severity: 'P0', expression: 'one key maps to one order',
    authoritative_source: 'database unique constraint', check_timing: 'command;recovery', consistency_window_ms: '0',
    tc_ids: 'TC-001', production_monitor: 'duplicate_order_total', evidence: 'artifact:invariant-report', status: 'pass',
    ...overrides,
  }
}

test('accepts a traceable state machine and invariant register', () => {
  assert.equal(validateStateMachine(machine(), { knownTcIds: ['TC-001', 'TC-002'] }).passed, true)
  assert.equal(validateInvariantRegister([invariant()], headers, {
    requireReleasePass: true,
    knownTcIds: ['TC-001'],
  }).passed, true)
})

test('rejects placeholder, conflicting and untested state transitions', () => {
  const input = machine()
  input.id = 'replace-with-state-machine-id'
  input.forbiddenTransitions[0] = { from: 'created', to: 'processing', reason: '', tcIds: [] }
  const report = validateStateMachine(input)
  assert.equal(report.passed, false)
  assert.match(report.failures.join('\n'), /non-placeholder/)
  assert.match(report.failures.join('\n'), /conflicts with an allowed transition/)
})

test('blocks unfinished P0/P1 invariants in release mode', () => {
  const planning = validateInvariantRegister([invariant({ status: 'not_run', evidence: '' })], headers)
  assert.equal(planning.passed, true)
  const release = validateInvariantRegister([invariant({ status: 'not_run', evidence: '' })], headers, {
    requireReleasePass: true,
    knownTcIds: ['TC-001'],
  })
  assert.equal(release.passed, false)
  assert.match(release.failures.join('\n'), /release-critical invariant/)
})

test('release model rejects unknown TCs, missing register and loose evidence references', () => {
  const missing = validateStateMachine(machine(), { requireReleasePass: true })
  assert.equal(missing.passed, false)
  assert.match(missing.failures.join('\n'), /non-empty TC register/)

  const unknown = validateStateMachine(machine(), { knownTcIds: ['TC-001'] })
  assert.equal(unknown.passed, false)
  assert.match(unknown.failures.join('\n'), /unknown TC TC-002/)

  const evidence = validateInvariantRegister([invariant({ evidence: 'trust-me' })], headers, {
    requireReleasePass: true,
    knownTcIds: ['TC-001'],
  })
  assert.equal(evidence.passed, false)
  assert.match(evidence.failures.join('\n'), /artifact:, ci: or report:/)
})

test('rejects unreachable states and non-terminal states without a terminal path', () => {
  const input = machine()
  input.states.push('orphaned')
  const report = validateStateMachine(input)
  assert.equal(report.passed, false)
  assert.match(report.failures.join('\n'), /unreachable states: orphaned/)
  assert.match(report.failures.join('\n'), /non-terminal state orphaned has no allowed outgoing transition/)
  assert.match(report.failures.join('\n'), /state orphaned cannot reach a terminal state/)
})
