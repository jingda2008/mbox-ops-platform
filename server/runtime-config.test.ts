import { describe, expect, it } from 'vitest'
import { loadRuntimeConfig } from './runtime-config.js'

describe('runtime config', () => {
  it('uses bounded local defaults', () => {
    const config = loadRuntimeConfig({})
    expect(config.runtimeMode).toBe('local')
    expect(config.repositoryMode).toBe('json')
    expect(config.corsOrigins).toContain('http://localhost:5173')
    expect(config.voiceTranscriptionProvider).toBe('disabled')
    expect(config.assistantProvider).toBe('disabled')
  })

  it('accepts only supported voice transcription providers', () => {
    expect(loadRuntimeConfig({ MBOX_VOICE_TRANSCRIPTION_PROVIDER: 'google_v1' }).voiceTranscriptionProvider)
      .toBe('google_v1')
    expect(() => loadRuntimeConfig({ MBOX_VOICE_TRANSCRIPTION_PROVIDER: 'unknown' }))
      .toThrow()
  })

  it('requires a server-side Gemini key when conversational assistance is enabled', () => {
    expect(() => loadRuntimeConfig({ MBOX_ASSISTANT_PROVIDER: 'gemini_interactions' }))
      .toThrow('MBOX_GEMINI_API_KEY')
    expect(loadRuntimeConfig({
      MBOX_ASSISTANT_PROVIDER: 'gemini_interactions',
      MBOX_GEMINI_API_KEY: 'server-side-gemini-key-at-least-20-characters',
      MBOX_GEMINI_MODEL: 'gemini-3.5-flash',
    })).toMatchObject({
      assistantProvider: 'gemini_interactions',
      geminiModel: 'gemini-3.5-flash',
      assistantHttpTimeoutMs: 20_000,
    })
  })

  it('rejects production with unsafe defaults', () => {
    expect(() => loadRuntimeConfig({ MBOX_RUNTIME_MODE: 'production' })).toThrow('DATABASE_URL')
  })

  it.each(['staging', 'production'] as const)('rejects explicit JSON storage in %s', (runtimeMode) => {
    expect(() => loadRuntimeConfig({
      MBOX_RUNTIME_MODE: runtimeMode,
      MBOX_REPOSITORY: 'json',
    })).toThrow('预发布和生产环境必须使用PostgreSQL仓储')
  })

  it('defaults staging storage to PostgreSQL and requires its connection settings', () => {
    expect(() => loadRuntimeConfig({ MBOX_RUNTIME_MODE: 'staging' })).toThrow('DATABASE_URL')
  })

  it('loads a complete production configuration', () => {
    const production = {
      MBOX_RUNTIME_MODE: 'production',
      MBOX_REPOSITORY: 'postgres',
      DATABASE_URL: 'postgresql://mbox:secret@db/mbox?sslmode=verify-full',
      MBOX_TENANT_ID: '11111111-1111-4111-8111-111111111111',
      MBOX_STORE_UUID: '22222222-2222-4222-8222-222222222222',
      MBOX_SESSION_SECRET: 's'.repeat(32),
      MBOX_QR_SECRET: 'q'.repeat(32),
      MBOX_QR_PREVIOUS_SECRET: 'p'.repeat(32),
      MBOX_METRICS_TOKEN: 'm'.repeat(32),
      MBOX_CORS_ORIGINS: 'https://ops.example.com,https://staff.example.com',
      MBOX_PUBLIC_BASE_URL: 'https://api.example.com',
    }
    const config = loadRuntimeConfig(production)
    expect(config.repositoryMode).toBe('postgres')
    expect(config.qrPreviousSecret).toBe('p'.repeat(32))
    expect(config.corsOrigins).toHaveLength(2)
    expect(() => loadRuntimeConfig({ ...production, MBOX_PILOT_PAYMENT_SIMULATION_ENABLED: 'true' }))
      .toThrow('只能在staging')
    expect(() => loadRuntimeConfig({ ...production, MBOX_QR_PREVIOUS_SECRET: 'short' }))
      .toThrow('MBOX_QR_PREVIOUS_SECRET至少需要32个字符')
    expect(() => loadRuntimeConfig({ ...production, MBOX_QR_PREVIOUS_SECRET: production.MBOX_QR_SECRET }))
      .toThrow('MBOX_QR_PREVIOUS_SECRET不能与MBOX_QR_SECRET相同')
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

  it('uses the platform PORT when API_PORT is not configured', () => {
    expect(loadRuntimeConfig({ PORT: '9090' }).apiPort).toBe(9090)
    expect(loadRuntimeConfig({ API_PORT: '8788', PORT: '9090' }).apiPort).toBe(8788)
  })

  it('allows pilot login only in staging with a strong access code', () => {
    const staging = {
      MBOX_RUNTIME_MODE: 'staging',
      MBOX_REPOSITORY: 'postgres',
      DATABASE_URL: 'postgresql://mbox:secret@db/mbox',
      MBOX_TENANT_ID: '11111111-1111-4111-8111-111111111111',
      MBOX_STORE_UUID: '22222222-2222-4222-8222-222222222222',
      MBOX_SESSION_SECRET: 's'.repeat(32),
      MBOX_QR_SECRET: 'q'.repeat(32),
      MBOX_METRICS_TOKEN: 'm'.repeat(32),
      MBOX_CORS_ORIGINS: 'https://pilot.example.com',
      MBOX_PILOT_EMPLOYEE_PINS_JSON: JSON.stringify({ 'emp-owner': '1001', 'emp-host': '1002' }),
    }
    expect(loadRuntimeConfig({ ...staging, MBOX_PILOT_ACCESS_CODE: 'pilot-code-strong' })).toMatchObject({
      pilotAccessCode: 'pilot-code-strong',
      pilotSessionHours: 12,
      pilotPaymentSimulationEnabled: false,
    })
    expect(loadRuntimeConfig({ ...staging, MBOX_PILOT_PAYMENT_SIMULATION_ENABLED: 'true' }))
      .toMatchObject({ pilotPaymentSimulationEnabled: true })
    expect(() => loadRuntimeConfig({ MBOX_PILOT_PAYMENT_SIMULATION_ENABLED: 'true' }))
      .toThrow('只能在staging')
    expect(() => loadRuntimeConfig({ ...staging, MBOX_PILOT_ACCESS_CODE: 'short' })).toThrow('至少需要10个字符')
    expect(() => loadRuntimeConfig({ ...staging, MBOX_PILOT_ACCESS_CODE: 'pilot-code-strong', MBOX_PILOT_EMPLOYEE_PINS_JSON: '' })).toThrow('EMPLOYEE_PINS')
    expect(() => loadRuntimeConfig({ ...staging, MBOX_PILOT_ACCESS_CODE: 'pilot-code-strong', MBOX_PILOT_EMPLOYEE_PINS_JSON: JSON.stringify({ a: '1001', b: '1001' }) })).toThrow('不能重复')
    expect(() => loadRuntimeConfig({ MBOX_PILOT_ACCESS_CODE: 'pilot-code-strong' })).toThrow('只能在staging')
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

  it('fails closed when customer notification channels are incomplete', () => {
    expect(() => loadRuntimeConfig({ MBOX_SERVICE_ACCOUNT_NOTIFICATIONS_ENABLED: 'true' }))
      .toThrow('服务号AppID和AppSecret')
    expect(() => loadRuntimeConfig({
      MBOX_WECOM_NOTIFICATIONS_ENABLED: 'true',
      MBOX_WECOM_CORP_ID: 'corp-id',
    })).toThrow('CorpID、CorpSecret和AgentID')
  })

  it('parses configured service-account templates before requiring production storage', () => {
    expect(() => loadRuntimeConfig({
      MBOX_SERVICE_ACCOUNT_NOTIFICATIONS_ENABLED: 'true',
      MBOX_SERVICE_ACCOUNT_NOTIFICATION_APP_ID: 'wx-service-account',
      MBOX_SERVICE_ACCOUNT_NOTIFICATION_APP_SECRET: 'provider-secret',
      MBOX_SERVICE_ACCOUNT_NOTIFICATION_TEMPLATES_JSON: JSON.stringify({
        BENEFIT_GRANTED: { templateId: 'template-001', page: 'https://mbox.example/member' },
      }),
    })).toThrow('PostgreSQL')
    expect(() => loadRuntimeConfig({
      MBOX_SERVICE_ACCOUNT_NOTIFICATIONS_ENABLED: 'true',
      MBOX_SERVICE_ACCOUNT_NOTIFICATION_APP_ID: 'wx-service-account',
      MBOX_SERVICE_ACCOUNT_NOTIFICATION_APP_SECRET: 'provider-secret',
      MBOX_SERVICE_ACCOUNT_NOTIFICATION_TEMPLATES_JSON: '{bad-json',
    })).toThrow('必须是有效JSON')
  })
})
