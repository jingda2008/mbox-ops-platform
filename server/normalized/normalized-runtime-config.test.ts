import { describe, expect, it } from 'vitest'
import {
  NORMALIZED_SCHEMA_FLAVOR,
  NormalizedRuntimeConfigurationError,
  loadNormalizedRuntimeConfig,
} from './normalized-runtime-config.js'
import { NORMALIZED_RUNTIME_CONFIG_VERSION } from './normalized-runtime-config-contract.js'

const base = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://localhost/mbox_normalized_test',
  MBOX_TENANT_ID: '11111111-1111-4111-8111-111111111111',
  MBOX_STORE_ID: '22222222-2222-4222-8222-222222222222',
  MBOX_NORMALIZED_SECRET: '0123456789abcdef0123456789abcdef',
}

describe('loadNormalizedRuntimeConfig', () => {
  it('loads a non-production normalized service without enabling real payment', () => {
    const config = loadNormalizedRuntimeConfig(base)
    expect(config).toMatchObject({
      nodeEnv: 'test',
      deploymentTier: 'validation',
      payment: null,
      metricsToken: null,
      guestPaymentMode: 'simulation',
      inventoryEnforcementMode: 'audit_only',
      guestOrderSafetyPolicy: {
        duplicateWindowSeconds: 45,
        maxOrdersPerCustomerPerMinute: 5,
        maxOrdersPerTablePerMinute: 20,
      },
      schemaFlavor: NORMALIZED_SCHEMA_FLAVOR,
      releaseImageDigest: null,
      port: 3_000,
      poolMax: 12,
      workerPoolMax: 4,
      startWorkers: false,
      workerId: null,
      workerIntervalMs: 2_000,
      workerAdapterModule: null,
    })
  })

  it('rejects legacy Postar aliases instead of silently retaining inactive configuration', () => {
    expect(() => loadNormalizedRuntimeConfig({
      ...base,
      MBOX_POSTAR_ENABLED: 'false',
      MBOX_POSTAR_ENVIRONMENT: 'test',
      MBOX_POSTAR_AGENCY_ID: 'inactive-agency',
      MBOX_POSTAR_MERCHANT_ID: 'inactive-merchant',
      MBOX_POSTAR_CALLBACK_URL: 'https://pay.shmbox.com/api/payments/providers/postar/callback',
      MBOX_GUEST_PAYMENT_MODE: 'simulation',
    })).toThrowError(NormalizedRuntimeConfigurationError)
  })

  it('does not let the legacy off switch disable an explicitly configured provider', () => {
    expect(() => loadNormalizedRuntimeConfig({
      ...base,
      MBOX_POSTAR_ENABLED: 'false',
      MBOX_PAYMENT_PROVIDER: 'postar',
      POSTAR_ENVIRONMENT: 'uat',
      POSTAR_AGENCY_ID: 'agency-1',
      POSTAR_MERCHANT_ID: 'merchant-1',
      POSTAR_CALLBACK_URL: 'https://pay.shmbox.com/api/payments/providers/postar/callback',
    })).toThrowError(NormalizedRuntimeConfigurationError)
  })

  it('does not allow the legacy off switch to bypass production payment requirements', () => {
    expect(() => loadNormalizedRuntimeConfig({
      ...base,
      NODE_ENV: 'production',
      MBOX_DEPLOYMENT_TIER: 'production',
      MBOX_METRICS_TOKEN: 'production-metrics-token-0123456789abcdef',
      MBOX_POSTAR_ENABLED: 'false',
      MBOX_POSTAR_ENVIRONMENT: 'production',
      MBOX_POSTAR_AGENCY_ID: 'agency-1',
      MBOX_POSTAR_MERCHANT_ID: 'merchant-1',
      MBOX_POSTAR_CALLBACK_URL: 'https://pay.shmbox.com/api/payments/providers/postar/callback',
      MBOX_GUEST_PAYMENT_MODE: 'wechat_native_qr',
      MBOX_START_WORKERS: 'true',
      MBOX_WORKER_ID: 'mbox-worker-production-01',
      MBOX_WORKER_ADAPTER_MODULE: '/opt/mbox/worker-adapters.mjs',
    })).toThrowError(NormalizedRuntimeConfigurationError)
  })

  it('accepts only an immutable release image digest', () => {
    expect(loadNormalizedRuntimeConfig({
      ...base,
      MBOX_RELEASE_IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`,
    }).releaseImageDigest).toBe(`sha256:${'a'.repeat(64)}`)
    expect(() => loadNormalizedRuntimeConfig({
      ...base,
      MBOX_RELEASE_IMAGE_DIGEST: 'mbox-normalized:latest',
    })).toThrowError(NormalizedRuntimeConfigurationError)
  })

  it('fails closed without core production configuration and never includes secret values', () => {
    const leaked = 'short-secret-value'
    expect(() => loadNormalizedRuntimeConfig({
      NODE_ENV: 'production',
      MBOX_NORMALIZED_SECRET: leaked,
    })).toThrowError(NormalizedRuntimeConfigurationError)
    try {
      loadNormalizedRuntimeConfig({ NODE_ENV: 'production', MBOX_NORMALIZED_SECRET: leaked })
    } catch (error) {
      expect(String(error)).not.toContain(leaked)
      expect((error as NormalizedRuntimeConfigurationError).fields).toEqual(expect.arrayContaining([
        'DATABASE_URL',
        'MBOX_TENANT_ID',
        'MBOX_STORE_ID',
        'MBOX_NORMALIZED_SECRET',
        'MBOX_METRICS_TOKEN',
        'MBOX_RUNTIME_CONFIG_VERSION',
        'MBOX_PAYMENT_MODE',
        'MBOX_AI_MODE',
        'MBOX_PRINT_MODE',
        'MBOX_HEADSET_MODE',
        'MBOX_GUEST_PAYMENT_MODE',
        'MBOX_START_WORKERS',
      ]))
    }
  })

  it('accepts complete Postar production configuration and rejects simulation checkout', () => {
    const production = {
      ...base,
      NODE_ENV: 'production',
      MBOX_DEPLOYMENT_TIER: 'production',
      MBOX_RUNTIME_CONFIG_VERSION: NORMALIZED_RUNTIME_CONFIG_VERSION,
      MBOX_PAYMENT_MODE: 'production',
      MBOX_AI_MODE: 'disabled',
      MBOX_PRINT_MODE: 'disabled',
      MBOX_HEADSET_MODE: 'disabled',
      MBOX_METRICS_TOKEN: 'production-metrics-token-0123456789abcdef',
      MBOX_PAYMENT_PROVIDER: 'postar',
      POSTAR_ENVIRONMENT: 'production',
      POSTAR_AGENCY_ID: 'agency-1',
      POSTAR_MERCHANT_ID: 'merchant-1',
      POSTAR_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\nZmFrZQ==\n-----END PUBLIC KEY-----',
      POSTAR_CALLBACK_URL: 'https://pay.shmbox.com/api/payments/providers/postar/callback',
      MBOX_GUEST_PAYMENT_MODE: 'wechat_native_qr',
      MBOX_START_WORKERS: 'true',
      MBOX_WORKER_ID: 'mbox-worker-production-01',
      MBOX_WORKER_ADAPTER_MODULE: '/opt/mbox/worker-adapters.mjs',
    }
    expect(loadNormalizedRuntimeConfig(production).payment).toMatchObject({ provider: 'postar' })
    expect(loadNormalizedRuntimeConfig(production).inventoryEnforcementMode).toBe('strict')
    expect(() => loadNormalizedRuntimeConfig({
      ...production,
      MBOX_GUEST_PAYMENT_MODE: 'simulation',
    })).toThrowError(NormalizedRuntimeConfigurationError)
  })

  it('allows a production-optimized validation runtime without claiming commercial readiness', () => {
    const validation = loadNormalizedRuntimeConfig({
      ...base,
      NODE_ENV: 'production',
      MBOX_DEPLOYMENT_TIER: 'validation',
      MBOX_RUNTIME_CONFIG_VERSION: NORMALIZED_RUNTIME_CONFIG_VERSION,
      MBOX_PAYMENT_MODE: 'disabled',
      MBOX_AI_MODE: 'disabled',
      MBOX_PRINT_MODE: 'disabled',
      MBOX_HEADSET_MODE: 'disabled',
      MBOX_METRICS_TOKEN: 'validation-metrics-token-0123456789abcdef',
      MBOX_GUEST_PAYMENT_MODE: 'simulation',
      MBOX_INVENTORY_ENFORCEMENT_MODE: 'audit_only',
      MBOX_START_WORKERS: 'false',
    })
    expect(validation).toMatchObject({
      nodeEnv: 'production',
      deploymentTier: 'validation',
      payment: null,
      guestPaymentMode: 'simulation',
      inventoryEnforcementMode: 'audit_only',
      startWorkers: false,
    })
  })

  it('loads configurable guest duplicate and rate limits and rejects an invalid table limit', () => {
    expect(loadNormalizedRuntimeConfig({
      ...base,
      MBOX_GUEST_ORDER_DUPLICATE_WINDOW_SECONDS: '60',
      MBOX_GUEST_ORDER_CUSTOMER_LIMIT_PER_MINUTE: '4',
      MBOX_GUEST_ORDER_TABLE_LIMIT_PER_MINUTE: '12',
    }).guestOrderSafetyPolicy).toEqual({
      duplicateWindowSeconds: 60,
      maxOrdersPerCustomerPerMinute: 4,
      maxOrdersPerTablePerMinute: 12,
    })
    expect(() => loadNormalizedRuntimeConfig({
      ...base,
      MBOX_GUEST_ORDER_CUSTOMER_LIMIT_PER_MINUTE: '8',
      MBOX_GUEST_ORDER_TABLE_LIMIT_PER_MINUTE: '4',
    })).toThrowError(NormalizedRuntimeConfigurationError)
  })

  it('rejects invalid deployment tiers and a production tier outside NODE_ENV production', () => {
    expect(() => loadNormalizedRuntimeConfig({
      ...base,
      MBOX_DEPLOYMENT_TIER: 'staging',
    })).toThrowError(NormalizedRuntimeConfigurationError)
    expect(() => loadNormalizedRuntimeConfig({
      ...base,
      MBOX_DEPLOYMENT_TIER: 'production',
    })).toThrowError(NormalizedRuntimeConfigurationError)
  })

  it('allows inventory audit mode only outside production', () => {
    expect(loadNormalizedRuntimeConfig({
      ...base,
      MBOX_INVENTORY_ENFORCEMENT_MODE: 'audit_only',
    }).inventoryEnforcementMode).toBe('audit_only')
    expect(() => loadNormalizedRuntimeConfig({
      ...base,
      NODE_ENV: 'production',
      MBOX_DEPLOYMENT_TIER: 'production',
      MBOX_METRICS_TOKEN: 'production-metrics-token-0123456789abcdef',
      MBOX_PAYMENT_PROVIDER: 'postar',
      POSTAR_AGENCY_ID: 'agency-1',
      POSTAR_MERCHANT_ID: 'merchant-1',
      POSTAR_PUBLIC_KEY: 'public-key',
      MBOX_GUEST_PAYMENT_MODE: 'wechat_native_qr',
      MBOX_START_WORKERS: 'true',
      MBOX_WORKER_ID: 'mbox-worker-production-01',
      MBOX_WORKER_ADAPTER_MODULE: '/opt/mbox/worker-adapters.mjs',
      MBOX_INVENTORY_ENFORCEMENT_MODE: 'audit_only',
    })).toThrowError(NormalizedRuntimeConfigurationError)
  })

  it('fails closed when workers are enabled without an explicit identity', () => {
    expect(() => loadNormalizedRuntimeConfig({
      ...base,
      MBOX_START_WORKERS: 'true',
    })).toThrowError(NormalizedRuntimeConfigurationError)

    try {
      loadNormalizedRuntimeConfig({ ...base, MBOX_START_WORKERS: 'true' })
    } catch (error) {
      expect((error as NormalizedRuntimeConfigurationError).fields).toEqual(expect.arrayContaining([
        'MBOX_WORKER_ID',
      ]))
    }
  })

  it('accepts an explicit worker runtime and rejects relative adapter modules', () => {
    const enabled = loadNormalizedRuntimeConfig({
      ...base,
      MBOX_START_WORKERS: 'true',
      MBOX_WORKER_ID: 'mbox-worker-01',
      MBOX_WORKER_INTERVAL_MS: '750',
      MBOX_WORKER_ADAPTER_MODULE: '/opt/mbox/worker-adapters.mjs',
    })
    expect(enabled).toMatchObject({
      startWorkers: true,
      workerId: 'mbox-worker-01',
      workerIntervalMs: 750,
      workerAdapterModule: '/opt/mbox/worker-adapters.mjs',
    })

    expect(() => loadNormalizedRuntimeConfig({
      ...base,
      MBOX_START_WORKERS: 'true',
      MBOX_WORKER_ID: 'mbox-worker-01',
      MBOX_WORKER_ADAPTER_MODULE: './worker-adapters.mjs',
    })).toThrowError(NormalizedRuntimeConfigurationError)
  })

  it('allows database-only workers without claiming external delivery jobs', () => {
    expect(loadNormalizedRuntimeConfig({
      ...base,
      MBOX_START_WORKERS: 'true',
      MBOX_WORKER_ID: 'mbox-worker-core-01',
    })).toMatchObject({
      startWorkers: true,
      workerId: 'mbox-worker-core-01',
      workerAdapterModule: null,
    })
  })

  it('rejects a production runtime that would silently omit external delivery workers', () => {
    expect(() => loadNormalizedRuntimeConfig({
      ...base,
      NODE_ENV: 'production',
      MBOX_DEPLOYMENT_TIER: 'production',
      MBOX_METRICS_TOKEN: 'production-metrics-token-0123456789abcdef',
      MBOX_PAYMENT_PROVIDER: 'postar',
      POSTAR_AGENCY_ID: 'agency-1',
      POSTAR_MERCHANT_ID: 'merchant-1',
      POSTAR_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\nZmFrZQ==\n-----END PUBLIC KEY-----',
      MBOX_GUEST_PAYMENT_MODE: 'wechat_native_qr',
      MBOX_START_WORKERS: 'true',
      MBOX_WORKER_ID: 'mbox-worker-production-01',
    })).toThrowError(NormalizedRuntimeConfigurationError)
  })
})
