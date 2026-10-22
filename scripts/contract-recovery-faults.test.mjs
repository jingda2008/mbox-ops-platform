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
  writeFileSync(join(release, 'release-state.json'), JSON.stringify({ current: options.state ?? 'migrated' }))
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
verify_previous_runtime_database_identity() {
  printf 'restored-identity-check\\n' >> "\${OPERATIONS_LOG}"
  [ "${options.identityFails ? 'true' : 'false'}" = false ]
}
docker() {
  printf 'docker %s\\n' "$*" >> "\${OPERATIONS_LOG}"
  if [ "$1" = inspect ]; then
    if [ "$2" = mbox-candidate ] && [ "${options.candidateExists ? 'true' : 'false'}" = false ]; then return 1; fi
    if [[ "$*" == *org.opencontainers.image.revision* ]]; then
      if [ "$2" = mbox-candidate ] || [ "${options.activeIsNew ? 'true' : 'false'}" = true ]; then printf '%s\\n' "\${release_sha}";
      else printf '%s\\n' "\${previous_release_sha}"; fi
      return 0
    fi
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

test('restored database identity drift keeps maintenance before publishing the old app', () => {
  const log = runScenario('identity-fail', { identityFails: true })
  assert.match(log, /restored-identity-check/)
  assert.match(log, /Caddyfile\.contract-maintenance/)
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

test('forward-only failure drains the new writer before public cutover', () => {
  const log = runScenario('new-writer-before-cutover', { writeResumed: true, candidateExists: true })
  assert.match(log, /Caddyfile\.contract-maintenance/)
  assert.match(log, /docker stop -t 20 mbox-candidate/)
  assert.doesNotMatch(log, /restorer|docker start mbox-app/)
})

test('late contract failure after rename and cutover verification still holds writes without restoring stale data', () => {
  const log = runScenario('late-forward-only', { writeResumed: true, cutoverStarted: true, activeIsNew: true, state: 'cutover_verified' })
  assert.match(log, /Caddyfile\.contract-maintenance/)
  assert.match(log, /docker stop -t 20 mbox-app/)
  assert.doesNotMatch(log, /restorer|docker start mbox-app/)
  assert.match(log, /forward-recovery-required/)
})

const archiveStart = activate.indexOf('archive_release_evidence() {')
const archiveEnd = activate.indexOf('\nrelease_state_require "${state_file}" external_preflight_passed', archiveStart)
assert.ok(archiveStart > 0 && archiveEnd > archiveStart)
const archiveEvidenceFunction = activate.slice(archiveStart, archiveEnd)
const deploy = readFileSync(resolve('deploy/aliyun/deploy-release.sh'), 'utf8')
const contractRelayStart = deploy.indexOf('  relay_contract_backup_if_present() {')
const contractRelayEnd = deploy.indexOf('\n  if [ "${maintenance_mode}" = 1 ]; then', contractRelayStart)
assert.ok(contractRelayStart > 0 && contractRelayEnd > contractRelayStart)
const contractRelayFunction = deploy.slice(contractRelayStart, contractRelayEnd)

function verifyFrozenBackupReceipt(mutation = 'valid') {
  const root = mkdtempSync(join(tmpdir(), 'mbox-contract-relay-receipt-'))
  const stage = join(root, 'oss-backup')
  execFileSync('mkdir', ['-p', stage])
  const files = {
    'mbox-frozen.dump': 'post-drain-database-bytes',
    'contract-restore-source.json': '{"database":"scoped-db","schemaVersion":274}',
    'previous-release-manifest.json': '{"releaseSha":"previous-image","migration":{"count":274}}',
  }
  const digest = text => execFileSync('shasum', ['-a', '256'], { input: text, encoding: 'utf8' }).split(' ')[0]
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(stage, name), bytes)
  files.SHA256SUMS = Object.entries(files).map(([name, bytes]) => `${digest(bytes)}  ${name}`).join('\n') + '\n'
  writeFileSync(join(stage, 'SHA256SUMS'), files.SHA256SUMS)
  const sha = 'a'.repeat(40), attempt = 'e'.repeat(32), prefix = `mbox/backups/2026-10-23/${sha}/post-drain/${attempt}`
  const report = {
    verified: true, authMode: 'EcsRamRole', prefix,
    completionMarker: prefix + '/_COMPLETE.json', objectsManifest: prefix + '/_OBJECTS.json', objectsManifestSha256: 'c'.repeat(64),
    objects: Object.entries(files).map(([name, bytes]) => ({ key: prefix + '/' + name, sha256: digest(bytes), bytes: Buffer.byteLength(bytes), verified: true })),
  }
  if (mutation === 'pre-drain-prefix') report.prefix = prefix.replace('/post-drain', '')
  if (mutation === 'changed-backup-hash') report.objects[0].sha256 = 'd'.repeat(64)
  if (mutation === 'changed-backup-size') report.objects[0].bytes++
  if (mutation === 'missing-identity-file') report.objects = report.objects.filter(row => !row.key.endsWith('contract-restore-source.json'))
  if (mutation === 'wrong-completion') report.completionMarker = 'old/_COMPLETE.json'
  if (mutation === 'extra-object') report.objects.push({ key: prefix + '/unexpected', sha256: 'd'.repeat(64), bytes: 1, verified: true })
  const incoming = join(root, 'incoming.json'), receipt = join(root, 'oss-backup-verification.json'), marker = join(root, 'marker.json')
  writeFileSync(incoming, JSON.stringify(report))
  // A previous online backup receipt exists, but must be removed before waiting
  // for this post-drain stage. Timeout must not silently reuse it.
  writeFileSync(receipt, JSON.stringify(report))
  const priorMarker = { schemaVersion: 1, releaseSha: sha, activationAttempt: 'f'.repeat(32), report: receipt + '.' + 'f'.repeat(32) }
  if (mutation === 'retry' || mutation === 'late-prior-receipt') writeFileSync(marker, JSON.stringify(priorMarker))
  const harness = join(root, 'verify.sh'), accepted = join(root, 'migration-authorized')
  writeFileSync(harness, `#!/usr/bin/env bash
set -Eeuo pipefail
external_evidence_relay=1
evidence_relay_wait_seconds=2
activation_attempt=${attempt}
release_sha=${sha}
uploader=/never-call-oss-on-private-origin
stat() { [ "$1" = -c ] && [ "$2" = '%s' ] || return 1; wc -c < "$3" | tr -d ' '; }
sleep() { ${mutation === 'timeout' ? ':' : mutation === 'late-prior-receipt' ? `if [ ! -f '${root}/old-delivered' ]; then cp '${incoming}' '${receipt}.${'f'.repeat(32)}'; touch '${root}/old-delivered'; else cp '${incoming}' '${receipt}.${attempt}'; fi` : `cp '${incoming}' '${receipt}.${attempt}'`}; }
${archiveEvidenceFunction}
archive_release_evidence '${stage}' '${prefix}' '${receipt}' '${marker}'
printf verified > '${accepted}'
`)
  let status = 0
  try { execFileSync('bash', [harness], { stdio: 'pipe' }) } catch (error) { status = error.status }
  let authorized = false
  try { authorized = readFileSync(accepted, 'utf8') === 'verified' } catch { /* rejected before migration */ }
  return { status, authorized, marker, prefix, sha, stage, receipt, attempt, priorMarker }
}

test('post-drain contract backup accepts only the exact complete relay receipt without origin OSS access', () => {
  const result = verifyFrozenBackupReceipt()
  assert.equal(result.status, 0)
  assert.equal(result.authorized, true)
  assert.throws(() => readFileSync(result.marker), { code: 'ENOENT' })
})
for (const mutation of ['pre-drain-prefix','changed-backup-hash','changed-backup-size','missing-identity-file','wrong-completion','extra-object','timeout']) {
  test(`post-drain backup receipt rejects ${mutation} before authorizing migration`, () => {
    const result = verifyFrozenBackupReceipt(mutation)
    assert.notEqual(result.status, 0)
    assert.equal(result.authorized, false)
    const marker = JSON.parse(readFileSync(result.marker, 'utf8'))
    assert.deepEqual(marker, { schemaVersion: 1, releaseSha: result.sha, activationAttempt: result.attempt, prefix: result.prefix, evidenceDirectory: result.stage, report: result.receipt + '.' + result.attempt })
  })
}

function routeContractBackupStage(mode) {
  const root = mkdtempSync(join(tmpdir(), 'mbox-contract-relay-route-')), sha = 'a'.repeat(40)
  const attempt = 'e'.repeat(32), previousAttempt = 'f'.repeat(32)
  const marker = join(root, '.contract-backup-evidence-relay-ready.json'), called = join(root, 'relay-call')
  const currentMarker = { schemaVersion: 1, releaseSha: sha, activationAttempt: attempt, prefix: `mbox/backups/2026-10-23/${sha}/post-drain/${attempt}` }
  const currentMarkerPath = join(root, 'current-marker.json')
  writeFileSync(currentMarkerPath, JSON.stringify(currentMarker))
  if (mode === 'ordinary') writeFileSync(join(root, '.deployment-evidence-relay-ready.json'), JSON.stringify({ activationAttempt: attempt }))
  else if (mode !== 'activation-failed') writeFileSync(marker, JSON.stringify({
    schemaVersion: 1, releaseSha: mode === 'foreign-sha' ? 'b'.repeat(40) : sha,
    activationAttempt: mode === 'stale-retry' ? previousAttempt : attempt,
    prefix: `mbox/backups/2026-10-23/${sha}${mode === 'pre-drain' ? '' : '/post-drain/' + (mode === 'stale-retry' ? previousAttempt : attempt)}`,
  }))
  if (mode === 'stale-retry') writeFileSync(join(root, '.deployment-evidence-relay-ready.json'), JSON.stringify({ activationAttempt: previousAttempt }))
  const statusFile = join(root, 'activation-status'), log = join(root, 'activation-log')
  if (mode === 'activation-failed') writeFileSync(statusFile, '1')
  writeFileSync(log, 'activation blocked before migration\n')
  const harness = join(root, 'route.sh')
  writeFileSync(harness, `#!/usr/bin/env bash
set -Eeuo pipefail
remote_release_dir='${root}'
activation_attempt=${attempt}
release_sha=${sha}
ssh_options=()
ssh_target=isolated-test-origin
activation_status='${statusFile}'
activation_log='${log}'
ssh() { local last; for last in "$@"; do :; done; bash -c "$last"; }
sleep() { ${mode === 'stale-retry' ? `test ! -f '${called}'; cp '${currentMarkerPath}' '${marker}'; printf waited > '${root}/waited';` : 'echo unexpected-wait >&2; exit 91;'} }
relay_post_cutover_evidence() { printf '%s\\n' "$@" > '${called}'; }
${contractRelayFunction}
relay_contract_backup_if_present
`)
  let status = 0
  try { execFileSync('bash', [harness], { stdio: 'pipe' }) } catch (error) { status = error.status }
  let args = null
  try { args = readFileSync(called, 'utf8') } catch { /* no backup stage */ }
  return { status, args, root, sha, attempt }
}

test('ordinary relay deployment advances without waiting for a nonexistent contract marker', () => {
  const result = routeContractBackupStage('ordinary')
  assert.equal(result.status, 0)
  assert.equal(result.args, null)
})

test('contract relay passes the frozen backup stage to the existing transfer and readback helper', () => {
  const result = routeContractBackupStage('contract')
  assert.equal(result.status, 0)
  assert.equal(result.args, ['contract-backup', '.contract-backup-evidence-relay-ready.json',
    result.root + '/oss-backup', `mbox/backups/2026-10-23/${result.sha}/post-drain/${result.attempt}`,
    'oss-backup-verification.json', ''].join('\n'))
})

for (const scenario of ['foreign-sha', 'pre-drain', 'activation-failed']) {
  test(`contract relay refuses ${scenario} without uploading an alternative backup`, () => {
    const result = routeContractBackupStage(scenario)
    assert.notEqual(result.status, 0)
    assert.equal(result.args, null)
  })
}

test('contract relay keeps post-drain identity, full hash verification and the original migration barrier', () => {
  const drain = activate.indexOf('migration_compatible writer_drained')
  const capture = activate.indexOf('"${database_restorer}" capture "${contract_restore_evidence}"', drain)
  const backup = activate.indexOf('backup_path=$(DATABASE_SERVICE=', capture)
  const upload = activate.indexOf('archive_release_evidence \\\n    "${backup_stage}"', backup)
  const verified = activate.indexOf('writer_drained post_drain_backup_verified', upload)
  const migrate = activate.indexOf('run_database_maintenance_container dist-normalized/server/migrate-normalized.js\n', verified)
  assert.ok(drain > 0 && drain < capture && capture < backup && backup < upload && upload < verified && verified < migrate)
  assert.match(activate.slice(capture, upload), /contract-restore-source\.json/)
  assert.match(activate.slice(capture, upload), /previous-release-manifest\.json/)
  assert.match(activate.slice(capture, upload), /backup_prefix="\$\{backup_prefix\}\/post-drain\/\$\{activation_attempt\}"/)
  assert.match(activate.slice(drain, upload), /if \[ "\$\{contract_migration\}" != 1 \][\s\S]*relay_backup_preparation/)
  assert.match(archiveEvidenceFunction, /completionMarker == \(\$prefix \+ "\/_COMPLETE\.json"\)/)
  assert.match(archiveEvidenceFunction, /\.bytes == \$bytes/)
  assert.match(deploy.slice(contractRelayEnd), /maintenance-epoch[\s\S]*else\s+relay_contract_backup_if_present\s+fi/)
})

for (const scenario of ['retry', 'late-prior-receipt']) {
  test(`same-SHA ${scenario} uses only its current receipt and retains failed marker evidence`, () => {
    const result = verifyFrozenBackupReceipt(scenario)
    assert.equal(result.status, 0)
    assert.equal(result.authorized, true)
    assert.deepEqual(JSON.parse(readFileSync(result.marker + '.previous-' + result.attempt, 'utf8')), result.priorMarker)
    assert.equal(JSON.parse(readFileSync(result.receipt, 'utf8')).prefix, result.prefix)
    if (scenario === 'late-prior-receipt') assert.ok(readFileSync(result.receipt + '.' + 'f'.repeat(32)))
  })
}

test('same-SHA retry ignores stale contract and deployment markers until this activation publishes its own backup', () => {
  const result = routeContractBackupStage('stale-retry')
  assert.equal(result.status, 0)
  assert.equal(readFileSync(join(result.root, 'waited'), 'utf8'), 'waited')
  assert.match(result.args, new RegExp(`/post-drain/${result.attempt}`))
  assert.doesNotMatch(result.args, new RegExp('f'.repeat(32)))
})


const transferRelayStart = deploy.indexOf('  relay_post_cutover_evidence() {')
assert.ok(transferRelayStart > 0 && transferRelayStart < contractRelayStart)
const transferRelayFunction = deploy.slice(transferRelayStart, contractRelayStart)

function transferRelayReceipt(mode) {
  const root = mkdtempSync(join(tmpdir(), 'mbox-contract-relay-delivery-'))
  const origin = join(root, 'origin'), evidence = join(root, 'evidence'), bundle = join(root, 'bundle')
  for (const directory of [origin, evidence, bundle]) execFileSync('mkdir', ['-p', directory])
  const stage = join(origin, 'oss-backup')
  execFileSync('mkdir', ['-p', stage])
  writeFileSync(join(stage, 'frozen.dump'), 'frozen backup')
  const hash = execFileSync('shasum', ['-a', '256', join(stage, 'frozen.dump')], { encoding: 'utf8' }).split(' ')[0]
  writeFileSync(join(stage, 'SHA256SUMS'), `${hash}  frozen.dump\n`)
  const attempt = 'e'.repeat(32), nextAttempt = 'f'.repeat(32), sha = 'a'.repeat(40)
  const maintenance = mode.startsWith('maintenance-')
  const kind = maintenance ? mode.slice('maintenance-'.length) : 'contract-backup'
  const prefix = maintenance ? `mbox/evidence/rc/v1/${sha}/${kind}` : `mbox/backups/2026-10-23/${sha}/post-drain/${attempt}`
  const reportName = 'oss-backup-verification.json', report = join(origin, reportName)
  const receipt = maintenance ? report : report + '.' + attempt
  const currentReceipt = report + '.' + nextAttempt
  const markerName = '.contract-backup-evidence-relay-ready.json', marker = join(origin, markerName)
  const oldMarker = { releaseSha: sha, prefix, evidenceDirectory: stage, report: receipt, ...(maintenance ? {} : { activationAttempt: attempt }) }
  const newMarker = { ...oldMarker, activationAttempt: nextAttempt, report: currentReceipt }
  const newMarkerFile = join(root, 'new-marker.json')
  writeFileSync(marker, JSON.stringify(oldMarker))
  writeFileSync(newMarkerFile, JSON.stringify(newMarker))
  writeFileSync(currentReceipt, 'current-attempt-receipt')
  if (!maintenance) writeFileSync(report, 'verified-canonical-receipt')
  const uploader = join(evidence, 'upload-oss-verified.sh')
  writeFileSync(uploader, `#!/usr/bin/env bash
set -euo pipefail
jq -n --arg prefix "$2" '{verified:true,authMode:"EcsRamRole",prefix:$prefix}' > "$MBOX_OSS_VERIFICATION_REPORT"
`)
  execFileSync('chmod', ['+x', uploader])
  const harness = join(root, 'delivery.sh')
  writeFileSync(harness, `#!/usr/bin/env bash
set -Eeuo pipefail
remote_release_dir='${origin}'
evidence_release_dir='${evidence}'
bundle_dir='${bundle}'
release_sha=${sha}
activation_attempt=${attempt}
maintenance_mode=${maintenance ? 1 : 0}
activation_status='${root}/activation-status'
activation_log='${root}/activation-log'
ssh_options=(); evidence_ssh_options=(); scp_options=(); evidence_scp_options=()
ssh_target=local-origin; evidence_ssh_target=local-evidence
ssh_key=unused; evidence_ssh_key=unused; ssh_port=22; evidence_ssh_port=22
rsync_resume_option=--partial
ssh() { local last; for last in "$@"; do :; done; bash -c "$last"; }
rsync() { local values=("$@") count=$# src dst; src="\${values[$((count - 2))]}"; dst="\${values[$((count - 1))]}"; src="\${src#local-origin:}"; dst="\${dst#local-evidence:}"; mkdir -p "$dst"; cp -R "$src/." "$dst/"; }
scp() { local values=("$@") count=$# src dst; src="\${values[$((count - 2))]}"; dst="\${values[$((count - 1))]}"; src="\${src#local-evidence:}"; dst="\${dst#local-origin:}"; cp "$src" "$dst"; ${mode === 'marker-changed' ? `if [[ "$dst" == *.next ]]; then cp '${newMarkerFile}' '${marker}'; fi` : ':'}; }
${mode === 'late-after-check' ? `mv() { if [ "$3" = '${receipt}' ]; then cp '${newMarkerFile}' '${marker}'; fi; command mv "$@"; }
export -f mv` : ''}
sleep() { echo unexpected-wait >&2; exit 91; }
${transferRelayFunction}
relay_post_cutover_evidence '${kind}' '${markerName}' '${stage}' '${prefix}' '${reportName}'
`)
  let status = 0
  try { execFileSync('bash', [harness], { stdio: 'pipe' }) } catch (error) { status = error.status }
  return { status, report, receipt, currentReceipt, marker, prefix, nextAttempt }
}

test('actual relay transfer delivers a verified receipt to the current attempt path', () => {
  const result = transferRelayReceipt('normal')
  assert.equal(result.status, 0)
  assert.equal(JSON.parse(readFileSync(result.receipt, 'utf8')).prefix, result.prefix)
  assert.equal(readFileSync(result.report, 'utf8'), 'verified-canonical-receipt')
})

test('late relay refuses delivery when the activation marker has changed', () => {
  const result = transferRelayReceipt('marker-changed')
  assert.notEqual(result.status, 0)
  assert.throws(() => readFileSync(result.receipt), { code: 'ENOENT' })
  assert.equal(readFileSync(result.currentReceipt, 'utf8'), 'current-attempt-receipt')
  assert.equal(readFileSync(result.report, 'utf8'), 'verified-canonical-receipt')
})

test('a marker change after the final check still cannot overwrite the next attempt receipt', () => {
  const result = transferRelayReceipt('late-after-check')
  assert.equal(result.status, 0)
  assert.equal(JSON.parse(readFileSync(result.receipt, 'utf8')).prefix, result.prefix)
  assert.equal(readFileSync(result.currentReceipt, 'utf8'), 'current-attempt-receipt')
  assert.equal(readFileSync(result.report, 'utf8'), 'verified-canonical-receipt')
  assert.equal(JSON.parse(readFileSync(result.marker, 'utf8')).activationAttempt, result.nextAttempt)
})

for (const stage of ['maintenance-backup', 'maintenance-epoch', 'deployment', 'completion']) {
  test(`planned maintenance preserves the original ${stage} marker and receipt contract`, () => {
    const result = transferRelayReceipt('maintenance-' + stage)
    assert.equal(result.status, 0)
    assert.equal(JSON.parse(readFileSync(result.report, 'utf8')).prefix, result.prefix)
  })
}
