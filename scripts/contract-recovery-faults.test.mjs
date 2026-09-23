import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const activate = readFileSync(resolve('deploy/aliyun/activate-release.sh'), 'utf8')
const start = activate.indexOf('restore_contract_database_and_previous_app() {')
const end = activate.indexOf('\nrollback_contract_on_error() {', start)
assert.ok(start > 0 && end > start)
const recoveryFunction = activate.slice(start, end)
const identityStart = activate.indexOf('assert_backup_targets_application_database() {')
const identityEnd = activate.indexOf('\nrestore_contract_database_and_previous_app() {', identityStart)
assert.ok(identityStart > 0 && identityEnd > identityStart)
const identityFunction = activate.slice(identityStart, identityEnd)
const activeReadyStart = activate.indexOf('fetch_active_ready_response() {')
const activeReadyEnd = activate.indexOf('\nwrite_release_failure() {', activeReadyStart)
assert.ok(activeReadyStart > 0 && activeReadyEnd > activeReadyStart)
const activeReadyFunction = activate.slice(activeReadyStart, activeReadyEnd)

function runActiveReadyScenario(name, payload, expectedSchema = '98') {
  const root = mkdtempSync(join(tmpdir(), `mbox-active-ready-${name}-`))
  const output = join(root, 'ready.json')
  const harness = join(root, 'harness.sh')
  writeFileSync(harness, `#!/usr/bin/env bash
set -Eeuo pipefail
release_dir=${JSON.stringify(root)}
active_container=mbox-app
docker() {
  [ "$1" = exec ] && [ "$2" = mbox-app ] || return 1
  printf '%s' ${JSON.stringify(JSON.stringify(payload))}
}
sleep() { :; }
${activeReadyFunction}
fetch_active_ready_response ${'a'.repeat(40)} sha256:${'b'.repeat(64)} ${JSON.stringify(expectedSchema)} production ${JSON.stringify(output)} 1
`)
  chmodSync(harness, 0o700)
  let status = 0
  try { execFileSync('bash', [harness], { stdio: 'pipe' }) } catch (error) { status = error.status }
  return { status, output }
}

test('active release preflight accepts zero-padded schema only with exact healthy identity', () => {
  const result = runActiveReadyScenario('healthy', {
    status: 'ready',
    commitSha: 'a'.repeat(40),
    releaseImageDigest: `sha256:${'b'.repeat(64)}`,
    schemaVersion: '098',
    deploymentTier: 'production',
    runtimeRole: 'normal',
    writeEnabled: true,
    workers: { status: 'healthy' },
  })
  assert.equal(result.status, 0)
  assert.equal(JSON.parse(readFileSync(result.output, 'utf8')).schemaVersion, '098')
})

test('active release preflight rejects an unhealthy worker before database work', () => {
  const result = runActiveReadyScenario('worker-unhealthy', {
    status: 'ready',
    commitSha: 'a'.repeat(40),
    releaseImageDigest: `sha256:${'b'.repeat(64)}`,
    schemaVersion: '098',
    deploymentTier: 'production',
    runtimeRole: 'normal',
    writeEnabled: true,
    workers: { status: 'degraded' },
  })
  assert.notEqual(result.status, 0)
})

test('active release preflight permits a numeric runtime schema to be reconciled after migration checks', () => {
  const result = runActiveReadyScenario('runtime-schema', {
    status: 'ready',
    commitSha: 'a'.repeat(40),
    releaseImageDigest: `sha256:${'b'.repeat(64)}`,
    schemaVersion: '108',
    deploymentTier: 'production',
    runtimeRole: 'normal',
    writeEnabled: true,
    workers: { status: 'healthy' },
  }, '')
  assert.equal(result.status, 0)
  assert.equal(JSON.parse(readFileSync(result.output, 'utf8')).schemaVersion, '108')
})

function runRuntimeSchemaReconciliation(name, ready, preflight, manifestSchema = 105) {
  const root = mkdtempSync(join(tmpdir(), `mbox-runtime-schema-${name}-`))
  const readyFile = join(root, 'ready.json')
  const preflightFile = join(root, 'migration-preflight.json')
  const output = join(root, 'schema.txt')
  const harness = join(root, 'harness.sh')
  writeFileSync(readyFile, JSON.stringify(ready))
  writeFileSync(preflightFile, JSON.stringify(preflight))
  writeFileSync(harness, `#!/usr/bin/env bash
set -Eeuo pipefail
${activeReadyFunction}
reconcile_previous_runtime_schema ${JSON.stringify(String(manifestSchema))} ${JSON.stringify(readyFile)} ${JSON.stringify(preflightFile)} > ${JSON.stringify(output)}
`)
  chmodSync(harness, 0o700)
  let status = 0
  try { execFileSync('bash', [harness], { stdio: 'pipe' }) } catch (error) { status = error.status }
  return { status, output }
}

test('runtime schema reconciliation only accepts a manifest-compatible applied migration sequence', () => {
  const pass = runRuntimeSchemaReconciliation('pass',
    { schemaVersion: '108' }, { status: 'pass', appliedCount: 108 })
  assert.equal(pass.status, 0)
  assert.equal(readFileSync(pass.output, 'utf8'), '108\n')

  const mismatchedAppliedCount = runRuntimeSchemaReconciliation('applied-mismatch',
    { schemaVersion: '108' }, { status: 'pass', appliedCount: 107 })
  assert.notEqual(mismatchedAppliedCount.status, 0)

  const staleRuntime = runRuntimeSchemaReconciliation('stale-runtime',
    { schemaVersion: '104' }, { status: 'pass', appliedCount: 104 })
  assert.notEqual(staleRuntime.status, 0)
})

function runIdentityScenario(name, identities) {
  const root = mkdtempSync(join(tmpdir(), `mbox-database-identity-${name}-`))
  const log = join(root, 'operations.log')
  const harness = join(root, 'harness.sh')
  writeFileSync(log, '')
  writeFileSync(harness, `#!/usr/bin/env bash
set -Eeuo pipefail
active_container=mbox-app
application_database_service=mbox_app
backup_database_service=mbox_backup
database_pgservice_file=/opt/mbox/secrets/pg_service.conf
database_pgpass_file=/opt/mbox/secrets/pgpass
contract_database_url='service=mbox_app'
backup_database_url='service=mbox_backup'
candidate_database_identity=${JSON.stringify(identities.candidate)}
runtime_database_identity=
docker() {
  if [ "$1" = inspect ]; then printf 'true\\n'; return; fi
  if [ "$1" = exec ]; then cat >/dev/null; printf '%s' ${JSON.stringify(identities.active)}; return; fi
  return 1
}
psql() {
  case "$*" in
    *service=mbox_app*) printf '%s\\n' ${JSON.stringify(identities.application)} ;;
    *service=mbox_backup*) printf '%s\\n' ${JSON.stringify(identities.backup)} ;;
    *) return 1 ;;
  esac
}
${identityFunction}
assert_backup_targets_application_database
printf 'maintenance-started\\n' >> ${JSON.stringify(log)}
`)
  chmodSync(harness, 0o700)
  let status = 0
  try { execFileSync('bash', [harness], { stdio: 'pipe' }) } catch (error) { status = error.status }
  return { status, log: readFileSync(log, 'utf8') }
}

test('candidate runtime database mismatch is denied before maintenance or backup', () => {
  const expected = 'mbox|10.0.0.8|5432'
  const result = runIdentityScenario('candidate-mismatch', {
    active: expected, application: expected, backup: expected, candidate: 'other|10.0.0.9|5432',
  })
  assert.notEqual(result.status, 0)
  assert.doesNotMatch(result.log, /maintenance-started/)
})

test('backup service database mismatch is denied before maintenance or backup', () => {
  const expected = 'mbox|10.0.0.8|5432'
  const result = runIdentityScenario('backup-mismatch', {
    active: expected, application: expected, candidate: expected, backup: 'other|10.0.0.9|5432',
  })
  assert.notEqual(result.status, 0)
  assert.doesNotMatch(result.log, /maintenance-started/)
})

function runScenario(name, options = {}) {
  const root = mkdtempSync(join(tmpdir(), `mbox-contract-${name}-`))
  const release = join(root, 'release')
  const bin = join(root, 'bin')
  execFileSync('mkdir', ['-p', release, bin])
  const log = join(root, 'operations.log')
  const restorer = join(bin, 'restorer')
  const verifier = join(bin, 'verifier')
  writeFileSync(restorer, `#!/bin/sh
printf 'restorer %s\\n' "$*" >> "$OPERATIONS_LOG"
[ "${options.restoreFails ? 'true' : 'false'}" = false ]
`)
  writeFileSync(verifier, `#!/bin/sh
printf 'public-verifier %s\\n' "$*" >> "$OPERATIONS_LOG"
[ "${options.publicFails ? 'true' : 'false'}" = false ]
`)
  chmodSync(restorer, 0o700)
  chmodSync(verifier, 0o700)
  writeFileSync(join(release, 'release-state.json'), JSON.stringify({ current: 'migrated' }))
  writeFileSync(join(release, '.database-write-started'), '')
  if (options.writeResumed) writeFileSync(join(release, '.contract-write-resumed'), '')
  if (options.cutoverStarted) writeFileSync(join(release, '.cutover-started'), '')
  const harness = join(root, 'harness.sh')
  writeFileSync(harness, `#!/usr/bin/env bash
set -Eeuo pipefail
export OPERATIONS_LOG=${JSON.stringify(log)}
release_dir=${JSON.stringify(release)}
state_file="\${release_dir}/release-state.json"
release_sha=${'a'.repeat(40)}
previous_release_sha=${'b'.repeat(40)}
previous_release_digest=sha256:${'c'.repeat(64)}
previous_schema_version=95
previous_deployment_tier=production
previous_public_extended_identity=1
application_database_service=mbox_app
admin_database_service=mbox_admin
database_pgservice_file=/opt/mbox/secrets/pg_service.conf
database_pgpass_file=/opt/mbox/secrets/pgpass
contract_database_url='service=mbox_app'
contract_admin_database_url='service=mbox_admin'
contract_database_identity=mbox
contract_restore_evidence="\${release_dir}/source.json"
contract_restore_report="\${release_dir}/report.json"
previous_release_dir="\${release_dir}/previous"
selected_backup="\${release_dir}/backup.dump"
database_restorer=${JSON.stringify(restorer)}
public_verifier=${JSON.stringify(verifier)}
public_url=https://example.invalid
active_container=mbox-app
candidate=mbox-candidate
maintenance_container=mbox-maintenance
caddy_container=mbox-caddy
short_sha=abcdef0
rollback_container=
active_running=false
mkdir -p "\${previous_release_dir}"
printf '{"migration":{"count":95,"files":[]}}' > "\${previous_release_dir}/release-manifest.json"
printf '{}' > "\${contract_restore_evidence}"
printf x > "\${selected_backup}"
printf x > "\${selected_backup}.sha256"
emit_release_audit() { printf 'audit %s\\n' "$*" >> "\${OPERATIONS_LOG}"; }
write_release_failure() { printf 'failure %s\\n' "$*" >> "\${OPERATIONS_LOG}"; }
release_state_transition() { printf 'state %s\\n' "$*" >> "\${OPERATIONS_LOG}"; }
psql() { printf '095\\n'; }
docker() {
  printf 'docker %s\\n' "$*" >> "\${OPERATIONS_LOG}"
  if [ "$1" = inspect ]; then
    if [ "$2" = mbox-candidate ]; then return 1; fi
    if [[ "$*" == *org.opencontainers.image.revision* ]]; then printf '%s\\n' "\${previous_release_sha}"; return 0; fi
    if [[ "$*" == *'{{.State.Running}}'* ]]; then
      printf '%s\\n' "\${active_running}"
      return 0
    fi
    return 0
  fi
  if [ "$1" = start ] && [ "$2" = mbox-app ]; then
    active_running=true
    return 0
  fi
  if [ "$1" = stop ] && [ "$3" = mbox-app ]; then
    active_running=false
    return 0
  fi
  if [ "$1" = exec ] && [ "$2" = mbox-app ] && [[ "$*" == *wget* ]]; then
    [ "${options.privateFails ? 'true' : 'false'}" = false ] || return 1
    printf '{"status":"ready","commitSha":"%s","schemaVersion":95}\\n' "\${previous_release_sha}"
  fi
}
${recoveryFunction}
restore_contract_database_and_previous_app 41
`)
  chmodSync(harness, 0o700)
  let status = 0
  try {
    execFileSync('bash', [harness], { stdio: 'pipe' })
  } catch (error) {
    status = error.status
  }
  assert.equal(status, 41)
  return readFileSync(log, 'utf8')
}

test('restore failure keeps maintenance and never starts the old application', () => {
  const log = runScenario('restore-fail', { restoreFails: true })
  assert.match(log, /restorer restore/)
  assert.doesNotMatch(log, /docker start mbox-app/)
  assert.match(log, /Caddyfile\.contract-maintenance/)
  assert.doesNotMatch(log, /docker rm mbox-maintenance/)
})

test('old private readiness failure returns to maintenance and stops the old application', () => {
  const log = runScenario('private-fail', { privateFails: true })
  assert.match(log, /docker start mbox-app/)
  assert.match(log, /Caddyfile\.contract-maintenance/)
  assert.match(log, /docker stop -t 20 mbox-app/)
  assert.doesNotMatch(log, /caddy reload --config \/etc\/caddy\/Caddyfile/)
})

test('public verification failure re-enters maintenance and stops the unverified old application', () => {
  const log = runScenario('public-fail', { publicFails: true })
  const canonical = log.indexOf('caddy reload --config /etc/caddy/Caddyfile')
  const verify = log.indexOf('public-verifier')
  const maintenance = log.lastIndexOf('Caddyfile.contract-maintenance')
  const stoppedAfterMaintenance = log.indexOf('docker stop -t 20 mbox-app', maintenance)
  assert.ok(canonical >= 0 && canonical < verify && verify < maintenance)
  assert.ok(stoppedAfterMaintenance > maintenance)
  assert.doesNotMatch(log, /docker rm mbox-maintenance/)
})

test('read-only candidate failure restores the database before starting and publishing the old app', () => {
  const log = runScenario('candidate-fail-restored')
  const restored = log.indexOf('restorer restore')
  const started = log.indexOf('docker start mbox-app')
  const canonical = log.indexOf('caddy reload --config /etc/caddy/Caddyfile')
  const verified = log.indexOf('public-verifier')
  const maintenanceRemoved = log.indexOf('docker rm mbox-maintenance')
  assert.ok(restored >= 0 && restored < started && started < canonical && canonical < verified)
  assert.ok(verified < maintenanceRemoved)
})

test('forward-only failure after writes resume never restores the database or starts the old app', () => {
  const log = runScenario('forward-only', { writeResumed: true })
  assert.doesNotMatch(log, /restorer/)
  assert.doesNotMatch(log, /docker start mbox-app/)
  assert.match(log, /forward-recovery-required/)
})
