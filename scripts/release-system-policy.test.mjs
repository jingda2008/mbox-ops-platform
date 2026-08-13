import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8')

test('formal release freezes a main-reachable tag and builds exactly one deployable image', async () => {
  const ci = await read('../.github/workflows/ci.yml')
  const release = await read('../.github/workflows/release.yml')
  const manifest = await read('./write-release-bundle-manifest.mjs')
  assert.match(ci, /Build production image once/)
  assert.equal((ci.match(/docker\/build-push-action@/g) ?? []).length, 1)
  assert.match(ci, /Reject an off-main release tag before image construction[\s\S]{0,240}merge-base --is-ancestor "\$\{GITHUB_SHA\}" origin\/main/)
  assert.match(release, /merge-base --is-ancestor "\$\{GITHUB_SHA\}" origin\/main/)
  assert.match(manifest, /sourceBranch !== 'main'/)
  assert.match(manifest, /Date\.parse\(frozenAt\)/)
})

test('configuration and migration checks precede every database write and application candidate', async () => {
  const activate = await read('../deploy/aliyun/activate-release.sh')
  const config = activate.indexOf('verify-normalized-runtime-config.js')
  const migrationCompatibility = activate.indexOf('verify-normalized-migration-compatibility.js')
  const backup = activate.indexOf('backup-postgres.sh')
  const migrate = activate.indexOf('migrate-normalized.js')
  const provision = activate.indexOf('provision-normalized-release.js')
  const candidate = activate.indexOf('docker run -d')
  assert.ok(config > 0 && config < migrationCompatibility)
  assert.ok(migrationCompatibility < backup && backup < migrate && migrate < provision && provision < candidate)
  assert.match(activate, /release_state_require "\$\{state_file\}" migration_compatible/)
  assert.match(activate, /release_state_require "\$\{state_file\}" backup_verified/)
})

test('diagnostic GitHub artifacts cannot hide tests while formal OSS failures block release', async () => {
  const ci = await read('../.github/workflows/ci.yml')
  const release = await read('../.github/workflows/release.yml')
  const deploy = await read('../deploy/aliyun/deploy-release.sh')
  assert.match(ci, /continue-on-error: true[\s\S]{0,180}actions\/upload-artifact/)
  assert.match(release, /Upload short-lived OSS transfer bundle[\s\S]{0,180}continue-on-error: true/)
  assert.doesNotMatch(deploy, /stage-release-evidence\.sh[^\n]*\|\| true/)
  assert.match(deploy, /stage-release-evidence\.sh/)
})

test('public verification includes root, table QR, reservation and staff deep links', async () => {
  const smoke = await read('./verify-release-smoke.mjs')
  for (const route of ["'/'", "'/guest?table=W01'", "'/reserve'", "'/staff/live'"]) assert.ok(smoke.includes(route))
})

test('candidate deep routes are verified without routing public traffic before cutover', async () => {
  const activate = await read('../deploy/aliyun/activate-release.sh')
  const privateVerification = activate.indexOf('http://${candidate_ip}:8787')
  const cutover = activate.indexOf('candidate_deep_verified cutover_started')
  assert.ok(privateVerification > 0 && privateVerification < cutover)
  assert.doesNotMatch(activate.slice(0, cutover), /Caddyfile\.candidate|caddy reload --config \/tmp/)
})
