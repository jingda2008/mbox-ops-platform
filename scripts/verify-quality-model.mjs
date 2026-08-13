import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import Papa from 'papaparse'

const placeholder = /replace-with|example/i
const invariantHeaders = [
  'invariant_id', 'entity', 'severity', 'expression', 'authoritative_source', 'check_timing',
  'consistency_window_ms', 'tc_ids', 'production_monitor', 'evidence', 'status',
]

function text(value) { return typeof value === 'string' ? value.trim() : '' }
function nonPlaceholder(value) { return Boolean(text(value)) && !placeholder.test(text(value)) }
function stringList(value) { return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()) : [] }

function referencedTcIds(value) {
  return typeof value === 'string' ? value.split(/[;,]/).map((item) => item.trim()).filter(Boolean) : stringList(value)
}

export function validateStateMachine(machine, options = {}) {
  const failures = []
  const knownTcIds = new Set(options.knownTcIds ?? [])
  if (options.requireReleasePass && knownTcIds.size === 0) failures.push('release mode requires a non-empty TC register')
  if (machine?.schemaVersion !== 1) failures.push('state machine schemaVersion must equal 1')
  if (!nonPlaceholder(machine?.id)) failures.push('state machine id must be non-placeholder text')
  if (!nonPlaceholder(machine?.entity)) failures.push('state machine entity must be non-placeholder text')
  const states = stringList(machine?.states)
  if (states.length < 2 || new Set(states).size !== states.length) failures.push('states must contain at least two unique values')
  if (!states.includes(machine?.initialState)) failures.push('initialState must belong to states')
  const terminals = stringList(machine?.terminalStates)
  if (terminals.length < 1 || terminals.some((state) => !states.includes(state))) failures.push('terminalStates must be non-empty members of states')
  const ids = new Set()
  const transitionKeys = new Set()
  if (!Array.isArray(machine?.transitions) || machine.transitions.length < 1) failures.push('transitions must be non-empty')
  for (const [index, transition] of (machine?.transitions ?? []).entries()) {
    const path = `transitions[${index}]`
    if (!nonPlaceholder(transition?.id) || ids.has(transition.id)) failures.push(`${path}.id must be unique non-placeholder text`)
    else ids.add(transition.id)
    const from = stringList(transition?.from)
    if (from.length < 1 || from.some((state) => !states.includes(state))) failures.push(`${path}.from must contain known states`)
    if (!states.includes(transition?.to)) failures.push(`${path}.to must be a known state`)
    for (const state of from) {
      const key = `${state}->${transition?.to}`
      if (transitionKeys.has(key)) failures.push(`${path} duplicates transition ${key}`)
      transitionKeys.add(key)
    }
    if (stringList(transition?.roles).length < 1 || transition.roles.some((role) => !nonPlaceholder(role))) failures.push(`${path}.roles must identify real roles`)
    if (!nonPlaceholder(transition?.guard)) failures.push(`${path}.guard must be defined`)
    if (stringList(transition?.sideEffects).length < 1 || transition.sideEffects.some((effect) => !nonPlaceholder(effect))) failures.push(`${path}.sideEffects must identify authoritative effects`)
    if (!nonPlaceholder(transition?.compensation) && text(transition?.compensation).toLowerCase() !== 'none') failures.push(`${path}.compensation must describe recovery or equal none`)
    const tcIds = stringList(transition?.tcIds)
    if (tcIds.length < 1) failures.push(`${path}.tcIds must be non-empty`)
    else if (knownTcIds.size > 0) for (const tcId of tcIds) if (!knownTcIds.has(tcId)) failures.push(`${path}.tcIds references unknown TC ${tcId}`)
  }
  if (!Array.isArray(machine?.forbiddenTransitions) || machine.forbiddenTransitions.length < 1) failures.push('forbiddenTransitions must be non-empty')
  for (const [index, transition] of (machine?.forbiddenTransitions ?? []).entries()) {
    const path = `forbiddenTransitions[${index}]`
    if (!states.includes(transition?.from) || !states.includes(transition?.to)) failures.push(`${path} must use known states`)
    if (transitionKeys.has(`${transition?.from}->${transition?.to}`)) failures.push(`${path} conflicts with an allowed transition`)
    if (!nonPlaceholder(transition?.reason)) failures.push(`${path}.reason must be defined`)
    const tcIds = stringList(transition?.tcIds)
    if (tcIds.length < 1) failures.push(`${path}.tcIds must be non-empty`)
    else if (knownTcIds.size > 0) for (const tcId of tcIds) if (!knownTcIds.has(tcId)) failures.push(`${path}.tcIds references unknown TC ${tcId}`)
  }
  if (states.length > 0 && states.includes(machine?.initialState)) {
    const adjacency = new Map(states.map((state) => [state, new Set()]))
    for (const transition of machine?.transitions ?? []) {
      for (const from of stringList(transition?.from)) {
        if (adjacency.has(from) && states.includes(transition?.to)) adjacency.get(from).add(transition.to)
      }
    }
    const reachable = new Set([machine.initialState])
    const queue = [machine.initialState]
    while (queue.length) {
      const state = queue.shift()
      for (const next of adjacency.get(state) ?? []) {
        if (!reachable.has(next)) { reachable.add(next); queue.push(next) }
      }
    }
    const unreachable = states.filter((state) => !reachable.has(state))
    if (unreachable.length) failures.push(`unreachable states: ${unreachable.join(', ')}`)
    for (const state of states.filter((candidate) => !terminals.includes(candidate))) {
      if ((adjacency.get(state)?.size ?? 0) === 0) failures.push(`non-terminal state ${state} has no allowed outgoing transition`)
      const visited = new Set([state])
      const pending = [state]
      let reachesTerminal = terminals.includes(state)
      while (pending.length && !reachesTerminal) {
        const current = pending.shift()
        for (const next of adjacency.get(current) ?? []) {
          if (terminals.includes(next)) { reachesTerminal = true; break }
          if (!visited.has(next)) { visited.add(next); pending.push(next) }
        }
      }
      if (!reachesTerminal) failures.push(`state ${state} cannot reach a terminal state`)
    }
  }
  return { passed: failures.length === 0, failures, states: states.length, transitions: machine?.transitions?.length ?? 0 }
}

export function validateInvariantRegister(rows, headers = [], options = {}) {
  const failures = []
  const knownTcIds = new Set(options.knownTcIds ?? [])
  if (options.requireReleasePass && knownTcIds.size === 0) failures.push('release mode requires a non-empty TC register')
  const missing = invariantHeaders.filter((header) => !headers.includes(header))
  if (missing.length) failures.push(`missing invariant headers: ${missing.join(', ')}`)
  if (rows.length < 1) failures.push('invariant register must contain at least one row')
  const ids = new Set()
  for (const [index, row] of rows.entries()) {
    const path = `row ${index + 2}`
    const id = text(row.invariant_id)
    if (!nonPlaceholder(id) || ids.has(id)) failures.push(`${path} invariant_id must be unique non-placeholder text`)
    else ids.add(id)
    for (const field of ['entity', 'expression', 'authoritative_source', 'check_timing', 'tc_ids', 'production_monitor']) {
      if (!nonPlaceholder(row[field])) failures.push(`${path} ${field} must be non-placeholder text`)
    }
    if (!/^P[0-3]$/.test(text(row.severity))) failures.push(`${path} severity must be P0-P3`)
    const window = Number(row.consistency_window_ms)
    if (!Number.isSafeInteger(window) || window < 0) failures.push(`${path} consistency_window_ms must be a non-negative integer`)
    if (!['pass', 'fail', 'blocked', 'not_run'].includes(text(row.status))) failures.push(`${path} status is invalid`)
    if (text(row.status) === 'pass' && !nonPlaceholder(row.evidence)) failures.push(`${path} passed invariant requires traceable evidence`)
    if (options.requireReleasePass && text(row.status) === 'pass' && !/^(?:artifact|ci|report):\S+$/i.test(text(row.evidence))) {
      failures.push(`${path} release evidence must use artifact:, ci: or report: reference`)
    }
    if (knownTcIds.size > 0) for (const tcId of referencedTcIds(row.tc_ids)) {
      if (!knownTcIds.has(tcId)) failures.push(`${path} tc_ids references unknown TC ${tcId}`)
    }
    if (options.requireReleasePass && ['P0', 'P1'].includes(text(row.severity)) && text(row.status) !== 'pass') {
      failures.push(`${path} release-critical invariant ${id} is not passed`)
    }
  }
  return { passed: failures.length === 0, failures, rows: rows.length }
}

export async function verifyQualityModelFiles(stateMachinePath, invariantsPath, options = {}) {
  const machine = JSON.parse(await readFile(resolve(stateMachinePath), 'utf8'))
  const parsed = Papa.parse(await readFile(resolve(invariantsPath), 'utf8'), { header: true, skipEmptyLines: 'greedy', transformHeader: (header) => header.trim() })
  let knownTcIds = options.knownTcIds ?? []
  if (options.tcRegisterPath) {
    const tcParsed = Papa.parse(await readFile(resolve(options.tcRegisterPath), 'utf8'), { header: true, skipEmptyLines: 'greedy', transformHeader: (header) => header.trim() })
    if (tcParsed.errors.length) throw new Error(`TC register parse failed: ${tcParsed.errors[0].message}`)
    knownTcIds = tcParsed.data.map((row) => text(row.tc_id)).filter(Boolean)
  }
  const validationOptions = { ...options, knownTcIds }
  const stateMachine = validateStateMachine(machine, validationOptions)
  const invariantParseFailures = parsed.errors.map((error) => `CSV ${error.code}: ${error.message}`)
  const invariants = validateInvariantRegister(parsed.data, parsed.meta.fields ?? [], validationOptions)
  return {
    passed: stateMachine.passed && invariants.passed && invariantParseFailures.length === 0,
    stateMachine,
    invariants: { ...invariants, failures: [...invariantParseFailures, ...invariants.failures] },
  }
}

function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

export function currentTcRegisterPath(explicitPath, version) {
  return explicitPath ?? `docs/tc-execution-register-${version}.csv`
}

async function main() {
  const stateMachine = option('state-machine')
  const invariants = option('invariants')
  const packageDocument = JSON.parse(await readFile(resolve('package.json'), 'utf8'))
  const tcRegister = currentTcRegisterPath(option('tc-register'), packageDocument.version)
  if (!stateMachine || !invariants) throw new Error('Usage: node scripts/verify-quality-model.mjs --state-machine <json> --invariants <csv> [--require-release-pass]')
  const report = await verifyQualityModelFiles(stateMachine, invariants, {
    requireReleasePass: process.argv.includes('--require-release-pass'),
    tcRegisterPath: tcRegister,
  })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (!report.passed) process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
