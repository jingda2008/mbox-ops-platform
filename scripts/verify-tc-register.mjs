import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import Papa from 'papaparse'

const requiredHeaders = [
  'tc_id', 'requirement_id', 'priority', 'risk_area', 'role', 'preconditions', 'steps',
  'expected_result', 'status', 'automation_level', 'evidence', 'owner', 'environment',
  'commit_sha', 'ci_run_id', 'defect_id', 'last_executed_at',
]

const strictIsoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/
const spreadsheetFormula = /^[=+\-@]/

export function parseRequiredTcBaseline(input) {
  const ids = input.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index)
  if (duplicates.length) throw new Error(`required TC baseline contains duplicate IDs: ${[...new Set(duplicates)].join(', ')}`)
  return ids
}

export function validateTcRegister(rows, headers = [], options = {}) {
  const failures = []
  const warnings = []
  const minimumTcCount = options.minimumTcCount ?? 1
  const requiredTcIds = new Set(options.requiredTcIds ?? [])
  const expectedCommitSha = String(options.expectedCommitSha ?? '').trim()
  const maximumEvidenceAgeDays = options.maximumEvidenceAgeDays
  const nowMs = options.nowMs ?? Date.now()
  if (options.requireReleasePass && requiredTcIds.size === 0) failures.push('release mode requires a non-empty required TC baseline')
  if (options.requireReleasePass && !expectedCommitSha) failures.push('release mode requires expectedCommitSha')
  if (options.requireReleasePass && !Number.isFinite(maximumEvidenceAgeDays)) failures.push('release mode requires maximumEvidenceAgeDays')
  if (!Number.isSafeInteger(minimumTcCount) || minimumTcCount < 1) failures.push('minimumTcCount must be a positive integer')
  if (expectedCommitSha && !/^[0-9a-f]{40}$/.test(expectedCommitSha)) failures.push('expectedCommitSha must be a full 40-character SHA')
  if (maximumEvidenceAgeDays !== undefined && (!Number.isFinite(maximumEvidenceAgeDays) || maximumEvidenceAgeDays <= 0)) {
    failures.push('maximumEvidenceAgeDays must be a positive number')
  }
  if (rows.length < minimumTcCount) failures.push(`TC register requires at least ${minimumTcCount} row(s), found ${rows.length}`)
  const missingHeaders = requiredHeaders.filter((header) => !headers.includes(header))
  if (missingHeaders.length) failures.push(`missing required headers: ${missingHeaders.join(', ')}`)
  const ids = new Set()
  rows.forEach((row, index) => {
    const path = `row ${index + 2}`
    const id = String(row.tc_id ?? '').trim()
    if (!id) failures.push(`${path} tc_id is required`)
    else if (ids.has(id)) failures.push(`${path} duplicates tc_id ${id}`)
    else ids.add(id)
    if (!/^P[0-3]$/.test(String(row.priority ?? ''))) failures.push(`${path} priority must be P0-P3`)
    if (!['pass', 'fail', 'blocked', 'not_run', 'skipped'].includes(String(row.status ?? ''))) {
      failures.push(`${path} status is invalid`)
    }
    if (!['manual', 'automated', 'hybrid'].includes(String(row.automation_level ?? ''))) {
      failures.push(`${path} automation_level is invalid`)
    }
    for (const [field, value] of Object.entries(row)) {
      if (spreadsheetFormula.test(String(value ?? '').trimStart())) failures.push(`${path} ${field} cannot start with a spreadsheet formula character`)
    }
    for (const field of ['requirement_id', 'risk_area', 'role', 'preconditions', 'steps', 'expected_result', 'owner', 'environment']) {
      if (!String(row[field] ?? '').trim()) failures.push(`${path} ${field} is required`)
    }
    const sha = String(row.commit_sha ?? '').trim()
    if (sha && !/^[0-9a-f]{40}$/.test(sha)) failures.push(`${path} commit_sha must be a full 40-character SHA`)
    if (['pass', 'fail', 'blocked'].includes(row.status)) {
      if (!String(row.evidence ?? '').trim()) failures.push(`${path} executed TC requires evidence`)
      if (!sha) failures.push(`${path} executed TC requires commit_sha`)
      if (!String(row.last_executed_at ?? '').trim()) failures.push(`${path} executed TC requires last_executed_at`)
      if (String(row.owner ?? '').trim().toLowerCase() === 'unassigned') failures.push(`${path} executed TC requires an assigned owner`)
    }
    if (row.status === 'fail' && !String(row.defect_id ?? '').trim()) failures.push(`${path} failed TC requires defect_id`)
    if (row.status === 'pass' && ['automated', 'hybrid'].includes(row.automation_level)
      && !String(row.ci_run_id ?? '').trim()) failures.push(`${path} automated passed TC requires ci_run_id`)
    const executedAt = String(row.last_executed_at ?? '').trim()
    if (executedAt && (!strictIsoTimestamp.test(executedAt) || !Number.isFinite(Date.parse(executedAt)))) failures.push(`${path} last_executed_at must be a strict ISO timestamp with timezone`)
    else if (executedAt && Date.parse(executedAt) > nowMs + 5 * 60_000) failures.push(`${path} last_executed_at cannot be in the future`)
    else if (executedAt && Number.isFinite(maximumEvidenceAgeDays)
      && Date.parse(executedAt) < nowMs - maximumEvidenceAgeDays * 24 * 60 * 60_000) {
      failures.push(`${path} evidence is older than ${maximumEvidenceAgeDays} day(s)`)
    }
    if (expectedCommitSha && ['pass', 'fail', 'blocked'].includes(row.status) && sha !== expectedCommitSha) {
      failures.push(`${path} commit_sha does not match expected commit ${expectedCommitSha}`)
    }
    if (['P0', 'P1'].includes(row.priority) && row.status !== 'pass') {
      const message = `${id || path} is an unfinished release-critical TC`
      if (options.requireReleasePass) failures.push(message)
      else warnings.push(message)
    }
  })
  for (const requiredId of requiredTcIds) {
    if (!ids.has(requiredId)) failures.push(`required TC ${requiredId} is missing from the register`)
  }
  return { passed: failures.length === 0, failures, warnings, rows: rows.length }
}

export async function verifyTcRegisterFile(input, options = {}) {
  const parsed = Papa.parse(await readFile(resolve(input), 'utf8'), {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (header) => header.trim(),
  })
  const failures = parsed.errors.map((error) => `CSV ${error.code}: ${error.message}`)
  const report = validateTcRegister(parsed.data, parsed.meta.fields ?? [], options)
  return { ...report, passed: report.passed && failures.length === 0, failures: [...failures, ...report.failures] }
}

async function main() {
  const inputIndex = process.argv.indexOf('--input')
  const minimumIndex = process.argv.indexOf('--minimum-count')
  const baselineIndex = process.argv.indexOf('--required-baseline')
  const commitIndex = process.argv.indexOf('--expected-commit')
  const ageIndex = process.argv.indexOf('--max-evidence-age-days')
  const input = inputIndex >= 0 ? process.argv[inputIndex + 1] : 'docs/templates/software-tc-register-template.csv'
  const minimumTcCount = minimumIndex >= 0 ? Number(process.argv[minimumIndex + 1]) : 1
  const requiredTcIds = baselineIndex >= 0
    ? parseRequiredTcBaseline(await readFile(resolve(process.argv[baselineIndex + 1]), 'utf8'))
    : []
  const report = await verifyTcRegisterFile(input, {
    minimumTcCount,
    requireReleasePass: process.argv.includes('--require-release-pass'),
    requiredTcIds,
    expectedCommitSha: commitIndex >= 0 ? process.argv[commitIndex + 1] : undefined,
    maximumEvidenceAgeDays: ageIndex >= 0 ? Number(process.argv[ageIndex + 1]) : undefined,
  })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (!report.passed) process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
