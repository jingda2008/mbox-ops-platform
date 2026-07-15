import { resolve } from 'node:path'
import { z } from 'zod'
import type { RuntimeMode } from '../src/shared/auth-contracts.js'

const runtimeModeSchema = z.enum(['local', 'test', 'staging', 'production'])
const repositoryModeSchema = z.enum(['json', 'postgres'])
const logLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])

export interface RuntimeConfig {
  runtimeMode: RuntimeMode
  host: string
  apiPort: number
  logLevel: z.infer<typeof logLevelSchema>
  bodyLimitBytes: number
  shutdownGraceMs: number
  sessionSecret?: string
  qrSecret: string
  corsOrigins: string[]
  repositoryMode: z.infer<typeof repositoryModeSchema>
  jsonStatePath: string
  databaseUrl?: string
  tenantId?: string
  storeUuid?: string
  databasePoolMax: number
  metricsToken?: string
  publicBaseUrl?: string
  pilotAccessCode?: string
  pilotEmployeePins?: Record<string, string>
  pilotSessionHours: number
  pilotPaymentSimulationEnabled: boolean
  wechatEnabled: boolean
  wechatAppId?: string
  wechatAppSecret?: string
  wechatStateSecret?: string
  wechatEncryptionKeyVersion: number
  wechatEncryptionKey?: Buffer
  notificationHttpTimeoutMs: number
  serviceAccountNotificationsEnabled: boolean
  serviceAccountNotificationAppId?: string
  serviceAccountNotificationAppSecret?: string
  serviceAccountNotificationTemplates?: Record<string, { templateId: string; page?: string }>
  wecomNotificationsEnabled: boolean
  wecomCorpId?: string
  wecomCorpSecret?: string
  wecomAgentId?: string
}

function parseInteger(value: string | undefined, fallback: number, name: string, minimum: number, maximum: number) {
  const parsed = value === undefined || value === '' ? fallback : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name}必须是${minimum}至${maximum}之间的整数`)
  }
  return parsed
}

function parseCorsOrigins(value: string | undefined, runtimeMode: RuntimeMode) {
  if (!value?.trim()) {
    return runtimeMode === 'local' || runtimeMode === 'test'
      ? ['http://localhost:5173', 'http://127.0.0.1:5173']
      : []
  }
  return [...new Set(value.split(',').map((origin) => origin.trim()).filter(Boolean))]
}

function assertUrl(value: string, name: string, protocols: string[]) {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${name}不是有效URL`)
  }
  if (!protocols.includes(parsed.protocol)) throw new Error(`${name}必须使用${protocols.join('或')}`)
}

function parseBoolean(value: string | undefined, fallback = false) {
  if (value === undefined || value === '') return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error('布尔配置必须是true或false')
}

function parseEncryptionKey(value: string | undefined) {
  if (!value?.trim()) return undefined
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value.trim())) {
    throw new Error('MBOX_WECHAT_ENCRYPTION_KEY_BASE64必须是标准Base64')
  }
  const key = Buffer.from(value.trim(), 'base64')
  if (key.length !== 32) throw new Error('微信身份加密密钥解码后必须是32字节')
  return key
}

function parseNotificationTemplates(value: string | undefined) {
  if (!value?.trim()) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('MBOX_SERVICE_ACCOUNT_NOTIFICATION_TEMPLATES_JSON必须是有效JSON')
  }
  return z.record(z.string().trim().min(1), z.object({
    templateId: z.string().trim().min(1),
    page: z.string().trim().url().optional(),
  })).parse(parsed)
}

function parsePilotEmployeePins(value: string | undefined) {
  if (!value?.trim()) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('MBOX_PILOT_EMPLOYEE_PINS_JSON必须是有效JSON')
  }
  const pins = z.record(z.string().trim().min(1).max(128), z.string().regex(/^\d{6,12}$/, '员工PIN必须是6至12位数字')).parse(parsed)
  const values = Object.values(pins)
  if (new Set(values).size !== values.length) throw new Error('门店验证员工PIN不能重复')
  return pins
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const runtimeMode = runtimeModeSchema.parse(env.MBOX_RUNTIME_MODE ?? 'local')
  const repositoryMode = repositoryModeSchema.parse(
    env.MBOX_REPOSITORY ?? (runtimeMode === 'staging' || runtimeMode === 'production' ? 'postgres' : 'json'),
  )
  const corsOrigins = parseCorsOrigins(env.MBOX_CORS_ORIGINS, runtimeMode)
  const config: RuntimeConfig = {
    runtimeMode,
    host: env.API_HOST?.trim() || '0.0.0.0',
    apiPort: parseInteger(env.API_PORT, 8787, 'API_PORT', 1, 65_535),
    logLevel: logLevelSchema.parse(env.MBOX_LOG_LEVEL ?? 'info'),
    bodyLimitBytes: parseInteger(env.MBOX_BODY_LIMIT_BYTES, 1_048_576, 'MBOX_BODY_LIMIT_BYTES', 16_384, 10_485_760),
    shutdownGraceMs: parseInteger(env.MBOX_SHUTDOWN_GRACE_MS, 10_000, 'MBOX_SHUTDOWN_GRACE_MS', 1_000, 60_000),
    sessionSecret: env.MBOX_SESSION_SECRET?.trim() || undefined,
    qrSecret: env.MBOX_QR_SECRET?.trim() || 'local-development-qr-secret-change-me',
    corsOrigins,
    repositoryMode,
    jsonStatePath: resolve(env.MBOX_JSON_STATE_PATH?.trim() || '.runtime/state.json'),
    databaseUrl: env.DATABASE_URL?.trim() || undefined,
    tenantId: env.MBOX_TENANT_ID?.trim() || undefined,
    storeUuid: env.MBOX_STORE_UUID?.trim() || undefined,
    databasePoolMax: parseInteger(env.MBOX_DATABASE_POOL_MAX, 10, 'MBOX_DATABASE_POOL_MAX', 1, 100),
    metricsToken: env.MBOX_METRICS_TOKEN?.trim() || undefined,
    publicBaseUrl: env.MBOX_PUBLIC_BASE_URL?.trim() || undefined,
    pilotAccessCode: env.MBOX_PILOT_ACCESS_CODE?.trim() || undefined,
    pilotEmployeePins: parsePilotEmployeePins(env.MBOX_PILOT_EMPLOYEE_PINS_JSON),
    pilotSessionHours: parseInteger(env.MBOX_PILOT_SESSION_HOURS, 12, 'MBOX_PILOT_SESSION_HOURS', 1, 24),
    pilotPaymentSimulationEnabled: parseBoolean(env.MBOX_PILOT_PAYMENT_SIMULATION_ENABLED),
    wechatEnabled: parseBoolean(env.MBOX_WECHAT_ENABLED),
    wechatAppId: env.MBOX_WECHAT_APP_ID?.trim() || undefined,
    wechatAppSecret: env.MBOX_WECHAT_APP_SECRET?.trim() || undefined,
    wechatStateSecret: env.MBOX_WECHAT_STATE_SECRET?.trim() || undefined,
    wechatEncryptionKeyVersion: parseInteger(
      env.MBOX_WECHAT_ENCRYPTION_KEY_VERSION,
      1,
      'MBOX_WECHAT_ENCRYPTION_KEY_VERSION',
      1,
      1_000_000,
    ),
    wechatEncryptionKey: parseEncryptionKey(env.MBOX_WECHAT_ENCRYPTION_KEY_BASE64),
    notificationHttpTimeoutMs: parseInteger(
      env.MBOX_NOTIFICATION_HTTP_TIMEOUT_MS,
      10_000,
      'MBOX_NOTIFICATION_HTTP_TIMEOUT_MS',
      1,
      60_000,
    ),
    serviceAccountNotificationsEnabled: parseBoolean(env.MBOX_SERVICE_ACCOUNT_NOTIFICATIONS_ENABLED),
    serviceAccountNotificationAppId: env.MBOX_SERVICE_ACCOUNT_NOTIFICATION_APP_ID?.trim() || undefined,
    serviceAccountNotificationAppSecret: env.MBOX_SERVICE_ACCOUNT_NOTIFICATION_APP_SECRET?.trim() || undefined,
    serviceAccountNotificationTemplates: parseNotificationTemplates(
      env.MBOX_SERVICE_ACCOUNT_NOTIFICATION_TEMPLATES_JSON,
    ),
    wecomNotificationsEnabled: parseBoolean(env.MBOX_WECOM_NOTIFICATIONS_ENABLED),
    wecomCorpId: env.MBOX_WECOM_CORP_ID?.trim() || undefined,
    wecomCorpSecret: env.MBOX_WECOM_CORP_SECRET?.trim() || undefined,
    wecomAgentId: env.MBOX_WECOM_AGENT_ID?.trim() || undefined,
  }

  for (const origin of corsOrigins) assertUrl(origin, 'MBOX_CORS_ORIGINS', ['http:', 'https:'])
  if (config.publicBaseUrl) assertUrl(config.publicBaseUrl, 'MBOX_PUBLIC_BASE_URL', ['http:', 'https:'])
  if ((runtimeMode === 'staging' || runtimeMode === 'production') && repositoryMode !== 'postgres') {
    throw new Error('预发布和生产环境必须使用PostgreSQL仓储')
  }
  if (repositoryMode === 'postgres' && !config.databaseUrl) {
    throw new Error('PostgreSQL仓储必须配置DATABASE_URL')
  }
  if (repositoryMode === 'postgres') {
    if (!config.tenantId || !z.string().uuid().safeParse(config.tenantId).success) {
      throw new Error('PostgreSQL仓储必须配置UUID格式的MBOX_TENANT_ID')
    }
    if (!config.storeUuid || !z.string().uuid().safeParse(config.storeUuid).success) {
      throw new Error('PostgreSQL仓储必须配置UUID格式的MBOX_STORE_UUID')
    }
  }
  if (config.wechatEnabled) {
    if (repositoryMode !== 'postgres') throw new Error('启用微信身份必须使用PostgreSQL仓储')
    if (!config.wechatAppId || !config.wechatAppSecret) throw new Error('启用微信身份必须配置AppID和AppSecret')
    if (!config.wechatStateSecret || config.wechatStateSecret.length < 32) {
      throw new Error('启用微信身份必须配置至少32字符的MBOX_WECHAT_STATE_SECRET')
    }
    if (!config.wechatEncryptionKey) throw new Error('启用微信身份必须配置32字节加密密钥')
  }
  if (config.serviceAccountNotificationsEnabled) {
    if (!config.serviceAccountNotificationAppId || !config.serviceAccountNotificationAppSecret) {
      throw new Error('启用服务号通知必须配置服务号AppID和AppSecret')
    }
    if (!config.serviceAccountNotificationTemplates || Object.keys(config.serviceAccountNotificationTemplates).length === 0) {
      throw new Error('启用服务号通知必须配置至少一个消息模板')
    }
  }
  if (config.wecomNotificationsEnabled && (!config.wecomCorpId || !config.wecomCorpSecret || !config.wecomAgentId)) {
    throw new Error('启用企业微信通知必须配置CorpID、CorpSecret和AgentID')
  }
  if (config.serviceAccountNotificationsEnabled || config.wecomNotificationsEnabled) {
    if (repositoryMode !== 'postgres') throw new Error('启用客户通知必须使用PostgreSQL仓储')
    if (!config.wechatEncryptionKey) throw new Error('启用客户通知必须配置32字节微信身份加密密钥')
  }

  if (config.pilotAccessCode) {
    if (runtimeMode !== 'staging') throw new Error('门店验证登录只能在staging环境启用')
    if (config.pilotAccessCode.length < 10) throw new Error('MBOX_PILOT_ACCESS_CODE至少需要10个字符')
    if (!config.pilotEmployeePins || Object.keys(config.pilotEmployeePins).length === 0) {
      throw new Error('门店验证登录必须配置MBOX_PILOT_EMPLOYEE_PINS_JSON')
    }
  }
  if (config.pilotPaymentSimulationEnabled && runtimeMode !== 'staging') {
    throw new Error('支付模拟开关只能在staging环境启用')
  }

  if (runtimeMode === 'staging' || runtimeMode === 'production') {
    if (!config.sessionSecret || config.sessionSecret.length < 32) {
      throw new Error('预发布和生产环境必须配置至少32字符的MBOX_SESSION_SECRET')
    }
    if (config.qrSecret.length < 32) throw new Error('预发布和生产环境必须配置至少32字符的MBOX_QR_SECRET')
    if (!config.metricsToken || config.metricsToken.length < 32) {
      throw new Error('预发布和生产环境必须配置至少32字符的MBOX_METRICS_TOKEN')
    }
    if (!corsOrigins.length || corsOrigins.includes('*')) {
      throw new Error('预发布和生产环境必须配置明确的MBOX_CORS_ORIGINS白名单')
    }
  }

  if (runtimeMode === 'production') {
    if (!config.publicBaseUrl?.startsWith('https://')) throw new Error('生产环境MBOX_PUBLIC_BASE_URL必须使用HTTPS')
    if (corsOrigins.some((origin) => !origin.startsWith('https://'))) {
      throw new Error('生产环境CORS来源必须全部使用HTTPS')
    }
    const databaseUrl = new URL(config.databaseUrl!)
    if (!['require', 'verify-ca', 'verify-full'].includes(databaseUrl.searchParams.get('sslmode') ?? '')) {
      throw new Error('生产环境DATABASE_URL必须配置sslmode=require、verify-ca或verify-full')
    }
  }

  return config
}
