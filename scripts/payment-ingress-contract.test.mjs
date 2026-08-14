import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const configure = await readFile(new URL('../deploy/aliyun/configure-payment-ingress.sh', import.meta.url), 'utf8')
const rollback = await readFile(new URL('../deploy/aliyun/rollback-payment-ingress.sh', import.meta.url), 'utf8')

test('payment ingress verifies certificate identity, key pairing and expiry before writing', () => {
  assert.match(configure, /x509 .* -checkhost/)
  assert.match(configure, /x509 .* -checkend 604800/)
  assert.match(configure, /cert_public=.*sha256sum/)
  assert.match(configure, /key_public=.*sha256sum/)
  assert.match(configure, /test "\$\{cert_public\}" = "\$\{key_public\}"/)
})

test('payment ingress is private-key safe, redacts query secrets and restores on failure', () => {
  assert.match(configure, /install -m 0600 "\$\{private_key\}"/)
  assert.match(configure, /import \/data\/mbox-ingress\/\*\.caddy/)
  assert.match(configure, /payment-domain\.caddy/)
  assert.match(configure, /replace customerAuthCode REDACTED/)
  assert.match(configure, /trap 'restore' ERR/)
  assert.doesNotMatch(configure, /cat "\$\{private_key\}"/)
})

test('payment ingress validates TLS and the reverse proxied application before success', () => {
  assert.match(configure, /caddy validate/)
  assert.match(configure, /--resolve "\$\{domain\}:443:127\.0\.0\.1"/)
  assert.match(configure, /https:\/\/\$\{domain\}\/api\/live/)
})

test('rollback accepts only managed backups and reloads validated configuration', () => {
  assert.match(rollback, /\/opt\/mbox\/ingress-backups\/\*/)
  assert.match(rollback, /rm -f .*payment-domain\.caddy/)
  assert.match(rollback, /caddy validate/)
  assert.match(rollback, /caddy reload/)
})
