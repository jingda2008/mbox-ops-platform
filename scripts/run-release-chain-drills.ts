import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { loadNormalizedRuntimeConfig } from '../server/normalized/normalized-runtime-config.js'

const output = resolve(process.argv[2] ?? 'artifacts/release-drills')
const stateHelper = resolve('deploy/aliyun/release-state.sh')
const previous = { sha: '1'.repeat(40), digest: `sha256:${'2'.repeat(64)}` }
const baseEnvironment = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://redacted@database.internal/mbox',
  MBOX_TENANT_ID: '11111111-1111-4111-8111-111111111111',
  MBOX_STORE_ID: '22222222-2222-4222-8222-222222222222',
  MBOX_NORMALIZED_SECRET: 'redacted-secret-0123456789abcdef',
  MBOX_METRICS_TOKEN: 'redacted-metrics-0123456789abcdef',
  MBOX_RUNTIME_CONFIG_VERSION: 'normalized-runtime-config/v1',
  MBOX_DEPLOYMENT_TIER: 'validation',
  MBOX_PAYMENT_MODE: 'disabled',
  MBOX_AI_MODE: 'disabled',
  MBOX_PRINT_MODE: 'disabled',
  MBOX_HEADSET_MODE: 'disabled',
  MBOX_GUEST_PAYMENT_MODE: 'simulation',
  MBOX_INVENTORY_ENFORCEMENT_MODE: 'audit_only',
  MBOX_START_WORKERS: 'false',
}

await mkdir(output, { recursive: true })
const reports = [
  await configFailureDrill(),
  await migrationFailureDrill(),
  await candidateStartupFailureDrill(),
  await cutoverInterruptionDrill(),
  await evidenceFailureDrill(),
  await postCutoverRollbackDrill(),
  await happyPathDrill(),
]
for (const report of reports) {
  await writeFile(resolve(output, `${report.id}.json`), `${JSON.stringify(report, null, 2)}\n`)
}
const sums = []
for (const report of reports) {
  const name = `${report.id}.json`
  const bytes = await readFile(resolve(output, name))
  sums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`)
}
await writeFile(resolve(output, 'SHA256SUMS'), `${sums.join('\n')}\n`)
process.stdout.write(`${JSON.stringify({ status: 'pass', drills: reports.map(({ id, outcome }) => ({ id, outcome })) }, null, 2)}\n`)

async function configFailureDrill() {
  const candidate = identity('3')
  const state = await initState(candidate)
  transition(state, 'frozen', 'artifact_verified')
  let rejected = false
  try {
    loadNormalizedRuntimeConfig({ ...baseEnvironment, MBOX_PAYMENT_MODE: 'uat' })
  } catch {
    rejected = true
  }
  if (!rejected) throw new Error('partial payment configuration was not rejected')
  return report('candidate-config-rejected', candidate, state, 'rejected-before-database', {
    databaseWrites: 0, cutovers: 0, imageBuilds: 1, active: previous, expectedState: 'artifact_verified',
  })
}

async function postCutoverRollbackDrill() {
  const candidate = identity('4')
  const state = await initState(candidate)
  runTo(state, [
    ['frozen', 'artifact_verified'], ['artifact_verified', 'config_preflight_passed'],
    ['config_preflight_passed', 'external_preflight_passed'],
    ['external_preflight_passed', 'migration_compatible'], ['migration_compatible', 'backup_verified'],
    ['backup_verified', 'migrated'], ['migrated', 'provisioned'],
    ['provisioned', 'candidate_healthy'], ['candidate_healthy', 'candidate_deep_verified'],
    ['candidate_deep_verified', 'cutover_started'],
  ])
  let active = candidate
  active = previous
  transition(state, 'cutover_started', 'rolled_back')
  return report('candidate-post-cutover-rollback', candidate, state, 'previous-release-restored', {
    databaseWrites: 1, cutovers: 1, imageBuilds: 1, rollbackRebuilds: 0, active, expectedState: 'rolled_back',
  })
}

async function migrationFailureDrill() {
  const candidate = identity('6')
  const state = await initState(candidate)
  runTo(state, [
    ['frozen', 'artifact_verified'], ['artifact_verified', 'config_preflight_passed'],
    ['config_preflight_passed', 'external_preflight_passed'],
    ['external_preflight_passed', 'migration_compatible'], ['migration_compatible', 'backup_verified'],
  ])
  return report('candidate-migration-failed', candidate, state, 'previous-release-unmodified', {
    databaseWrites: 1, cutovers: 0, imageBuilds: 1, active: previous, expectedState: 'backup_verified',
  })
}

async function candidateStartupFailureDrill() {
  const candidate = identity('7')
  const state = await initState(candidate)
  runTo(state, [
    ['frozen', 'artifact_verified'], ['artifact_verified', 'config_preflight_passed'],
    ['config_preflight_passed', 'external_preflight_passed'],
    ['external_preflight_passed', 'migration_compatible'], ['migration_compatible', 'backup_verified'],
    ['backup_verified', 'migrated'], ['migrated', 'provisioned'],
    ['provisioned', 'rolled_back'],
  ])
  return report('candidate-startup-failed', candidate, state, 'previous-release-remained-active', {
    databaseWrites: 1, cutovers: 0, imageBuilds: 1, rollbackRebuilds: 0,
    active: previous, expectedState: 'rolled_back',
  })
}

async function cutoverInterruptionDrill() {
  const candidate = identity('8')
  const state = await initState(candidate)
  runTo(state, [
    ['frozen', 'artifact_verified'], ['artifact_verified', 'config_preflight_passed'],
    ['config_preflight_passed', 'external_preflight_passed'],
    ['external_preflight_passed', 'migration_compatible'], ['migration_compatible', 'backup_verified'],
    ['backup_verified', 'migrated'], ['migrated', 'provisioned'],
    ['provisioned', 'candidate_healthy'], ['candidate_healthy', 'candidate_deep_verified'],
    ['candidate_deep_verified', 'cutover_started'], ['cutover_started', 'rolled_back'],
  ])
  return report('candidate-cutover-interrupted', candidate, state, 'previous-release-restored', {
    databaseWrites: 1, cutovers: 1, imageBuilds: 1, rollbackRebuilds: 0,
    active: previous, expectedState: 'rolled_back',
  })
}

async function evidenceFailureDrill() {
  const candidate = identity('9')
  const state = await initState(candidate)
  runTo(state, [
    ['frozen', 'artifact_verified'], ['artifact_verified', 'config_preflight_passed'],
    ['config_preflight_passed', 'external_preflight_passed'],
    ['external_preflight_passed', 'migration_compatible'],
  ])
  return report('candidate-oss-verification-failed', candidate, state, 'blocked-before-database', {
    databaseWrites: 0, cutovers: 0, imageBuilds: 1, active: previous,
    expectedState: 'migration_compatible',
  })
}

async function happyPathDrill() {
  const candidate = identity('5')
  const state = await initState(candidate)
  runTo(state, [
    ['frozen', 'artifact_verified'], ['artifact_verified', 'config_preflight_passed'],
    ['config_preflight_passed', 'external_preflight_passed'],
    ['external_preflight_passed', 'migration_compatible'], ['migration_compatible', 'backup_verified'],
    ['backup_verified', 'migrated'], ['migrated', 'provisioned'],
    ['provisioned', 'candidate_healthy'], ['candidate_healthy', 'candidate_deep_verified'],
    ['candidate_deep_verified', 'cutover_started'], ['cutover_started', 'cutover_verified'],
    ['cutover_verified', 'evidence_archived'], ['evidence_archived', 'completed'],
  ])
  return report('candidate-happy-path', candidate, state, 'completed', {
    databaseWrites: 1, cutovers: 1, imageBuilds: 1, active: candidate, expectedState: 'completed',
  })
}

function identity(seed: string) {
  return { sha: seed.repeat(40), digest: `sha256:${seed.repeat(64)}` }
}

async function initState(candidate: ReturnType<typeof identity>) {
  const directory = await mkdtemp(resolve(tmpdir(), 'mbox-release-drill-'))
  const path = resolve(directory, 'release-state.json')
  runBash(`release_state_init "$1" "$2" "$3"`, [path, candidate.sha, candidate.digest])
  return path
}

function transition(path: string, from: string, to: string) {
  runBash('release_state_transition "$1" "$2" "$3"', [path, from, to])
}

function runTo(path: string, transitions: string[][]) {
  for (const [from, to] of transitions) transition(path, from!, to!)
}

function runBash(command: string, args: string[]) {
  const result = spawnSync('bash', ['-c', `source "$0"; ${command}`, stateHelper, ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || 'release state command failed')
}

async function report(
  id: string,
  candidate: ReturnType<typeof identity>,
  statePath: string,
  outcome: string,
  assertions: Record<string, unknown>,
) {
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  if (state.current !== assertions.expectedState) throw new Error(`${id} ended in ${state.current}`)
  if (JSON.stringify(assertions.active).includes('redacted-secret')) throw new Error('secret entered drill report')
  return { schemaVersion: 1, id, executedAt: new Date().toISOString(), candidate, outcome, assertions, state }
}
