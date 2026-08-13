import { describe, expect, it } from 'vitest'
import { verifyNormalizedRuntimeConfig } from './verify-normalized-runtime-config.js'
import { NORMALIZED_RUNTIME_CONFIG_VERSION } from './normalized/normalized-runtime-config-contract.js'

const base = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://user:secret@database.internal/mbox',
  MBOX_TENANT_ID: '11111111-1111-4111-8111-111111111111',
  MBOX_STORE_ID: '22222222-2222-4222-8222-222222222222',
  MBOX_NORMALIZED_SECRET: '0123456789abcdef0123456789abcdef',
  MBOX_METRICS_TOKEN: 'metrics-token-0123456789abcdef0123456789',
  MBOX_DEPLOYMENT_TIER: 'validation',
  MBOX_RUNTIME_CONFIG_VERSION: NORMALIZED_RUNTIME_CONFIG_VERSION,
  MBOX_PAYMENT_MODE: 'disabled',
  MBOX_AI_MODE: 'disabled',
  MBOX_PRINT_MODE: 'disabled',
  MBOX_HEADSET_MODE: 'disabled',
  MBOX_GUEST_PAYMENT_MODE: 'simulation',
  MBOX_INVENTORY_ENFORCEMENT_MODE: 'audit_only',
  MBOX_START_WORKERS: 'false',
  APP_COMMIT_SHA: 'a'.repeat(40),
  MBOX_RELEASE_IMAGE_DIGEST: `sha256:${'b'.repeat(64)}`,
  MBOX_EXPECTED_RELEASE_SHA: 'a'.repeat(40),
  MBOX_EXPECTED_IMAGE_DIGEST: `sha256:${'b'.repeat(64)}`,
}

describe('verifyNormalizedRuntimeConfig', () => {
  it('returns only redacted release identity and subsystem modes', async () => {
    const report = await verifyNormalizedRuntimeConfig(base)
    const serialized = JSON.stringify(report)
    expect(report).toMatchObject({
      status: 'pass',
      configVersion: NORMALIZED_RUNTIME_CONFIG_VERSION,
      modes: { payment: 'disabled', ai: 'disabled', printing: 'disabled', headset: 'disabled' },
    })
    expect(serialized).not.toContain('secret')
    expect(serialized).not.toContain('DATABASE_URL')
  })

  it('rejects a release identity mismatch', async () => {
    await expect(verifyNormalizedRuntimeConfig({ ...base, MBOX_EXPECTED_RELEASE_SHA: 'c'.repeat(40) }))
      .rejects.toThrow('发布提交身份与配置不一致')
  })
})
