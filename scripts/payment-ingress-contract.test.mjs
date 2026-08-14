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

test('payment ingress serves a normalized chain without bundled self-signed roots', () => {
  assert.match(configure, /certificate_parts=/)
  assert.match(configure, /subject#subject=/)
  assert.match(configure, /issuer#issuer=/)
  assert.match(configure, /removed_self_signed_roots/)
  assert.match(configure, /install -m 0600 "\$\{certificate_chain\}"/)
})

test('payment ingress is private-key safe, redacts query secrets and restores on failure', () => {
  assert.match(configure, /install -m 0600 "\$\{private_key\}"/)
  assert.match(configure, /certificate_backup=/)
  assert.match(configure, /private_key_backup=/)
  assert.match(configure, /install -m 0600 "\$\{certificate_backup\}" "\$\{managed_certificate\}"/)
  assert.match(configure, /install -m 0600 "\$\{private_key_backup\}" "\$\{managed_private_key\}"/)
  assert.match(configure, /import \/data\/mbox-ingress\/\*\.caddy/)
  assert.match(configure, /payment-domain\.caddy/)
  assert.match(configure, /replace customerAuthCode REDACTED/)
  assert.match(configure, /trap 'restore' ERR/)
  assert.doesNotMatch(configure, /cat "\$\{private_key\}"/)
})

test('payment ingress preserves the bind-mounted Caddyfile inode and verifies container visibility', () => {
  assert.match(configure, /cat "\$\{candidate\}" > "\$\{config_source\}"/)
  assert.match(configure, /cat "\$\{backup\}" > "\$\{config_source\}"/)
  assert.match(configure, /docker exec "\$\{caddy_container\}" cat \/etc\/caddy\/Caddyfile \| sha256sum/)
  assert.match(configure, /test "\$\{candidate_config_sha\}" = "\$\{container_config_sha\}"/)
  assert.doesNotMatch(configure, /install -m 0600 "\$\{candidate\}" "\$\{config_source\}"/)

  assert.match(rollback, /cat "\$\{backup\}" > "\$\{config_source\}"/)
  assert.match(rollback, /test "\$\{host_config_sha\}" = "\$\{container_config_sha\}"/)
  assert.doesNotMatch(rollback, /install -m 0600 "\$\{backup\}" "\$\{config_source\}"/)
})

test('payment ingress validates TLS and the reverse proxied application before success', () => {
  assert.match(configure, /caddy validate/)
  assert.match(configure, /for _ in \$\(seq 1 20\)/)
  assert.match(configure, /sleep 0\.5/)
  assert.match(configure, /test "\$\{probe_succeeded\}" = 1/)
  assert.match(configure, /--resolve "\$\{domain\}:443:127\.0\.0\.1"/)
  assert.match(configure, /https:\/\/\$\{domain\}\/api\/live/)
})

test('rollback accepts only managed backups and reloads validated configuration', () => {
  assert.match(rollback, /\/opt\/mbox\/ingress-backups\/\*/)
  assert.match(rollback, /rm -f .*payment-domain\.caddy/)
  assert.match(rollback, /caddy validate/)
  assert.match(rollback, /caddy reload/)
})
