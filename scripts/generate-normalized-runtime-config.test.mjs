import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('config templates use explicit integration modes without secrets', () => {
  const output = mkdtempSync(join(tmpdir(), 'mbox-runtime-config-'))
  execFileSync('npx', ['tsx', 'scripts/generate-normalized-runtime-config.ts', output], {
    cwd: new URL('..', import.meta.url),
  })
  const validation = readFileSync(join(output, 'validation.env.template'), 'utf8')
  const production = readFileSync(join(output, 'production.env.template'), 'utf8')
  const required = JSON.parse(readFileSync(join(output, 'required-fields.json'), 'utf8'))
  assert.match(validation, /MBOX_PAYMENT_MODE=disabled/)
  assert.match(validation, /MBOX_WECHAT_ENABLED=false/)
  assert.doesNotMatch(validation, /POSTAR_AGENCY_ID=/)
  assert.match(production, /MBOX_PAYMENT_MODE=production/)
  assert.match(production, /MBOX_WECHAT_ENABLED=true/)
  assert.match(production, /MBOX_WECHAT_APP_ID=<mini-program-app-id>/)
  assert.match(production, /MBOX_WECHAT_APP_SECRET=<mini-program-app-secret>/)
  assert.match(production, /MBOX_WECHAT_SERVICE_TEMPLATE_ID=<wechat-service-template-id>/)
  assert.equal(required.configVersion, 'normalized-runtime-config/v1')
  assert.ok(required.alwaysRequiredInOptimizedRuntime.includes('MBOX_WECHAT_ENABLED'))
  for (const field of [
    'MBOX_CONTACT_ACTIVE_KEY_ID','MBOX_CONTACT_ACTIVE_KEY_BASE64',
    'MBOX_CONTACT_LOOKUP_KEY_BASE64','MBOX_CONTACT_LEGACY_PHONE_LOOKUP_KEY_BASE64',
    'MBOX_CONTACT_PREVIOUS_KEYS',
  ]) {
    assert.match(validation, new RegExp(`^${field}=`, 'm'))
    assert.match(production, new RegExp(`^${field}=`, 'm'))
    assert.ok(required.alwaysRequiredInOptimizedRuntime.includes(field))
  }
  assert.deepEqual(required.conditional.wechatIdentity, [
    'MBOX_WECHAT_APP_ID', 'MBOX_WECHAT_APP_SECRET', 'MBOX_WECHAT_STATE_SECRET',
    'MBOX_WECHAT_ENCRYPTION_KEY_VERSION', 'MBOX_WECHAT_ENCRYPTION_KEY_BASE64',
  ])
  assert.match(validation, /MBOX_STORE_DAILY_CREDENTIAL=<store-daily-credential>/)
  assert.match(validation, /MBOX_EMPLOYEE_PIN_LIYAN=<unique-four-digit-pin>/)
  assert.deepEqual(required.conditional.storeProvisioning, [...required.conditional.storeProvisioning].sort())
  assert.doesNotMatch(`${validation}${production}`, /sk-[A-Za-z0-9]/)
})
