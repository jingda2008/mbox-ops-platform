import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { verifyPublicPreflight } from './verify-release-public-preflight.mjs'

const options = { url: 'https://mbox.example', tier: 'production', maintenance: false }
const ready = { status: 'ready', deploymentTier: 'production', commitSha: 'a'.repeat(40), releaseImageDigest: `sha256:${'b'.repeat(64)}` }
const response = (body = ready, status = '200') => `${JSON.stringify(body)}\n${status}`

test('requires three consistent TLS-verified bounded probes', () => {
  const calls = []
  assert.equal(verifyPublicPreflight(options, (command, args, limits) => {
    calls.push({ command, args, limits }); return response()
  }).verified, true)
  assert.equal(calls.length, 3)
  for (const { command, args, limits } of calls) {
    assert.equal(command, 'curl')
    assert.ok(args.includes('--max-time'))
    assert.ok(!args.includes('-k') && !args.includes('--insecure'))
    assert.equal(limits.timeout, 10_000)
  }
})

test('rejects an intermittent transport failure, wrong tier, changed release and invalid status', () => {
  let attempt = 0
  assert.throws(() => verifyPublicPreflight(options, () => {
    if (++attempt === 2) throw new Error('TLS connection closed')
    return response()
  }), /TLS/)
  assert.equal(attempt, 2)
  assert.throws(() => verifyPublicPreflight(options, () => response({ ...ready, deploymentTier: 'validation' })))
  assert.throws(() => verifyPublicPreflight(options, () => response(ready, '500')))
  attempt = 0
  assert.throws(() => verifyPublicPreflight(options, () => response({ ...ready, commitSha: (++attempt === 1 ? 'a' : 'c').repeat(40) })), /changed/)
})

test('accepts the planned maintenance response only for the explicit maintenance path', () => {
  const run = () => response({ reason: 'planned_maintenance_upgrade' }, '503')
  assert.throws(() => verifyPublicPreflight(options, run))
  assert.equal(verifyPublicPreflight({ ...options, maintenance: true }, run).verified, true)
})

test('formal entry checks environment before upload, scopes permissions, and probes actual image before maintenance', () => {
  const deploy = readFileSync(new URL('../deploy/aliyun/deploy-release.sh', import.meta.url), 'utf8')
  const activate = readFileSync(new URL('../deploy/aliyun/activate-release.sh', import.meta.url), 'utf8')
  assert.ok(deploy.indexOf('verify-release-public-preflight.mjs') < deploy.indexOf('rsync -a'))
  assert.ok(deploy.indexOf('selected remote Bash') < deploy.indexOf('rsync -a'))
  assert.match(deploy, /store_config_name.*store_config_sha.*catalog_config_name.*catalog_config_sha/)
  assert.match(deploy, /chown 0:1000.*chmod 0440/)
  assert.doesNotMatch(deploy, /chmod -R (?:0440|440)/)
  assert.ok(activate.indexOf('docker run --rm --network none') < activate.indexOf('MBOX_VERIFIED_MAINTENANCE_ENTRY=1'))
  const probe = activate.slice(activate.indexOf('docker run --rm --network none'), activate.indexOf('# Planned maintenance'))
  assert.doesNotMatch(probe, /--env-file|--user.*root/)
  execFileSync('bash', ['-n', new URL('../deploy/aliyun/deploy-release.sh', import.meta.url).pathname])
  execFileSync('bash', ['-n', new URL('../deploy/aliyun/activate-release.sh', import.meta.url).pathname])
})
