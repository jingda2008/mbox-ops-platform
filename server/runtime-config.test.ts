import { describe, expect, it } from 'vitest'
import { loadRuntimeConfig } from './runtime-config.js'

describe('runtime config', () => {
  it('uses bounded local defaults', () => {
    const config = loadRuntimeConfig({})
    expect(config.runtimeMode).toBe('local')
    expect(config.repositoryMode).toBe('json')
    expect(config.corsOrigins).toContain('http://localhost:5173')
  })

  it('rejects production with unsafe defaults', () => {
    expect(() => loadRuntimeConfig({ MBOX_RUNTIME_MODE: 'production' })).toThrow('DATABASE_URL')
  })

  it('loads a complete production configuration', () => {
    const config = loadRuntimeConfig({
      MBOX_RUNTIME_MODE: 'production',
      MBOX_REPOSITORY: 'postgres',
      DATABASE_URL: 'postgresql://mbox:secret@db/mbox?sslmode=verify-full',
      MBOX_TENANT_ID: '11111111-1111-4111-8111-111111111111',
      MBOX_STORE_UUID: '22222222-2222-4222-8222-222222222222',
      MBOX_SESSION_SECRET: 's'.repeat(32),
      MBOX_QR_SECRET: 'q'.repeat(32),
      MBOX_METRICS_TOKEN: 'm'.repeat(32),
      MBOX_CORS_ORIGINS: 'https://ops.example.com,https://staff.example.com',
      MBOX_PUBLIC_BASE_URL: 'https://api.example.com',
    })
    expect(config.repositoryMode).toBe('postgres')
    expect(config.corsOrigins).toHaveLength(2)
  })

  it('rejects wildcard or insecure production origins', () => {
    const base = {
      MBOX_RUNTIME_MODE: 'production',
      MBOX_REPOSITORY: 'postgres',
      DATABASE_URL: 'postgresql://mbox:secret@db/mbox?sslmode=verify-full',
      MBOX_SESSION_SECRET: 's'.repeat(32),
      MBOX_QR_SECRET: 'q'.repeat(32),
      MBOX_METRICS_TOKEN: 'm'.repeat(32),
      MBOX_PUBLIC_BASE_URL: 'https://api.example.com',
      MBOX_TENANT_ID: '11111111-1111-4111-8111-111111111111',
      MBOX_STORE_UUID: '22222222-2222-4222-8222-222222222222',
    }
    expect(() => loadRuntimeConfig({ ...base, MBOX_CORS_ORIGINS: '*' })).toThrow('有效URL')
    expect(() => loadRuntimeConfig({ ...base, MBOX_CORS_ORIGINS: 'http://ops.example.com' })).toThrow('HTTPS')
  })

  it('rejects invalid integer settings', () => {
    expect(() => loadRuntimeConfig({ API_PORT: '8787.5' })).toThrow('API_PORT')
    expect(() => loadRuntimeConfig({ MBOX_BODY_LIMIT_BYTES: '10' })).toThrow('MBOX_BODY_LIMIT_BYTES')
  })

  it('fails closed when WeChat identity is enabled without production cryptographic material', () => {
    expect(() => loadRuntimeConfig({ MBOX_WECHAT_ENABLED: 'true' })).toThrow('PostgreSQL')
    const base = {
      MBOX_RUNTIME_MODE: 'staging',
      MBOX_REPOSITORY: 'postgres',
      DATABASE_URL: 'postgresql://mbox:secret@db/mbox',
      MBOX_TENANT_ID: '11111111-1111-4111-8111-111111111111',
      MBOX_STORE_UUID: '22222222-2222-4222-8222-222222222222',
      MBOX_SESSION_SECRET: 's'.repeat(32),
      MBOX_QR_SECRET: 'q'.repeat(32),
      MBOX_METRICS_TOKEN: 'm'.repeat(32),
      MBOX_CORS_ORIGINS: 'https://ops.example.com',
      MBOX_WECHAT_ENABLED: 'true',
      MBOX_WECHAT_APP_ID: 'wx-commercial-app',
      MBOX_WECHAT_APP_SECRET: 'provider-secret',
      MBOX_WECHAT_STATE_SECRET: 'w'.repeat(32),
      MBOX_WECHAT_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
    }
    expect(loadRuntimeConfig(base)).toMatchObject({
      wechatEnabled: true,
      wechatAppId: 'wx-commercial-app',
      wechatEncryptionKeyVersion: 1,
    })
    expect(() => loadRuntimeConfig({ ...base, MBOX_WECHAT_ENCRYPTION_KEY_BASE64: 'dG9vLXNob3J0' })).toThrow('32字节')
  })
})
