import { describe, expect, it } from 'vitest'
import {
  NORMALIZED_SCHEMA_FLAVOR,
  NormalizedRuntimeConfigurationError,
  loadNormalizedRuntimeConfig,
} from './normalized-runtime-config.js'

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
      payment: null,
      guestPaymentMode: 'simulation',
      schemaFlavor: NORMALIZED_SCHEMA_FLAVOR,
      port: 3_000,
      poolMax: 12,
      workerPoolMax: 4,
      startWorkers: false,
      workerId: null,
      workerIntervalMs: 2_000,
      workerAdapterModule: null,
    })
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
        'MBOX_PAYMENT_PROVIDER',
        'POSTAR_AGENCY_ID',
        'POSTAR_MERCHANT_ID',
        'POSTAR_PUBLIC_KEY',
        'MBOX_GUEST_PAYMENT_MODE',
        'MBOX_START_WORKERS',
      ]))
    }
  })

  it('accepts complete Postar production configuration and rejects simulation checkout', () => {
    const production = {
      ...base,
      NODE_ENV: 'production',
      MBOX_PAYMENT_PROVIDER: 'postar',
      POSTAR_AGENCY_ID: 'agency-1',
      POSTAR_MERCHANT_ID: 'merchant-1',
      POSTAR_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\nZmFrZQ==\n-----END PUBLIC KEY-----',
      MBOX_GUEST_PAYMENT_MODE: 'wechat_native_qr',
      MBOX_START_WORKERS: 'true',
      MBOX_WORKER_ID: 'mbox-worker-production-01',
      MBOX_WORKER_ADAPTER_MODULE: '/opt/mbox/worker-adapters.mjs',
    }
    expect(loadNormalizedRuntimeConfig(production).payment).toMatchObject({ provider: 'postar' })
    expect(() => loadNormalizedRuntimeConfig({
      ...production,
      MBOX_GUEST_PAYMENT_MODE: 'simulation',
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
