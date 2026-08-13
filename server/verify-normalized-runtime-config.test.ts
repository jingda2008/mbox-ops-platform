import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseStoreProvisionConfig } from './provision-normalized-store.js'
import { tlsServernameForHost, verifyNormalizedRuntimeConfig } from './verify-normalized-runtime-config.js'
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

const storeConfig = parseStoreProvisionConfig(JSON.parse(
  readFileSync(new URL('../deploy/normalized-store/mbox-lujiazui.store.json', import.meta.url), 'utf8'),
))

function environmentWithProvisioning(): Record<string, string> {
  const environment: Record<string, string> = { ...base }
  if (storeConfig.dailyCredentialEnv) environment[storeConfig.dailyCredentialEnv] = 'MBOX521'
  storeConfig.employees.forEach((employee, index) => {
    environment[employee.pinEnv] = String(5100 + index)
  })
  return environment
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

  it('validates every store provisioning secret without exposing values', async () => {
    const environment = environmentWithProvisioning()
    const report = await verifyNormalizedRuntimeConfig(environment, false, storeConfig)
    const serialized = JSON.stringify(report)
    expect(report.provisioning).toEqual({
      employeePinCount: storeConfig.employees.length,
      dailyCredentialConfigured: true,
    })
    expect(serialized).not.toContain('MBOX521')
    expect(serialized).not.toContain('5100')
  })

  it('rejects missing, invalid and duplicate employee PINs before database work', async () => {
    const missing = environmentWithProvisioning()
    delete missing[storeConfig.employees[0]!.pinEnv]
    await expect(verifyNormalizedRuntimeConfig(missing, false, storeConfig))
      .rejects.toThrow('Missing valid four-digit PIN environment')

    const invalid = environmentWithProvisioning()
    invalid[storeConfig.employees[0]!.pinEnv] = '12345'
    await expect(verifyNormalizedRuntimeConfig(invalid, false, storeConfig))
      .rejects.toThrow('Missing valid four-digit PIN environment')

    const duplicate = environmentWithProvisioning()
    duplicate[storeConfig.employees[1]!.pinEnv] = duplicate[storeConfig.employees[0]!.pinEnv]!
    await expect(verifyNormalizedRuntimeConfig(duplicate, false, storeConfig))
      .rejects.toThrow('Employee PIN values must be unique')
  })

  it('rejects a missing daily store credential before database work', async () => {
    const environment = environmentWithProvisioning()
    delete environment[storeConfig.dailyCredentialEnv!]
    await expect(verifyNormalizedRuntimeConfig(environment, false, storeConfig))
      .rejects.toThrow('Missing store credential environment')
  })

  it('does not send an IP address as a TLS SNI server name', () => {
    expect(tlsServernameForHost('139.224.254.60')).toBeUndefined()
    expect(tlsServernameForHost('pay.shmbox.com')).toBe('pay.shmbox.com')
  })
})
