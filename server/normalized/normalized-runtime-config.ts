import { isAbsolute } from 'node:path'
import type { GuestCheckoutPaymentMode } from './guest-commerce-service-api.js'
import type { GuestOrderSafetyPolicy } from './guest-order-safety.js'
import {
  NORMALIZED_RUNTIME_CONFIG_VERSION,
  readNormalizedIntegrationContract,
  type NormalizedIntegrationContract,
} from './normalized-runtime-config-contract.js'

export const NORMALIZED_SCHEMA_FLAVOR = 'normalized-core-v1'

export interface NormalizedPaymentRuntimeConfig {
  provider: 'postar'
  environment: 'test' | 'uat' | 'production'
  agencyId: string
  merchantId: string
  publicKey: string
  callbackUrl: string
  timeoutMs: number
  wechat: null | {
    appId: string
    tradeType: '5' | '8'
  }
}

export interface NormalizedRuntimeConfig {
  nodeEnv: 'development' | 'test' | 'production'
  deploymentTier: 'validation' | 'production'
  databaseUrl: string
  tenantId: string
  storeId: string
  secret: string
  metricsToken: string | null
  configVersion: typeof NORMALIZED_RUNTIME_CONFIG_VERSION
  integrations: NormalizedIntegrationContract
  payment: NormalizedPaymentRuntimeConfig | null
  guestPaymentMode: GuestCheckoutPaymentMode
  inventoryEnforcementMode: 'strict' | 'audit_only'
  guestOrderSafetyPolicy: Readonly<GuestOrderSafetyPolicy>
  commitSha: string
  releaseImageDigest: string | null
  schemaFlavor: typeof NORMALIZED_SCHEMA_FLAVOR
  host: string
  port: number
  poolMax: number
  workerPoolMax: number
  trustProxyHops: number
  staticDir: string | null
  startWorkers: boolean
  workerId: string | null
  workerIntervalMs: number
  workerAdapterModule: string | null
}

export class NormalizedRuntimeConfigurationError extends Error {
  readonly fields: readonly string[]

  constructor(fields: readonly string[]) {
    super(`规范化服务配置不完整或无效：${fields.join(', ')}`)
    this.name = 'NormalizedRuntimeConfigurationError'
    this.fields = Object.freeze([...fields])
  }
}

export function loadNormalizedRuntimeConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): NormalizedRuntimeConfig {
  const nodeEnv = readNodeEnv(environment.NODE_ENV)
  const errors: string[] = []
  const deploymentTier = readDeploymentTier(
    environment.MBOX_DEPLOYMENT_TIER,
    nodeEnv,
    errors,
  )
  const commercialProduction = deploymentTier === 'production'
  const databaseUrl = required(environment.DATABASE_URL, 'DATABASE_URL', errors)
  const tenantId = requiredUuid(environment.MBOX_TENANT_ID, 'MBOX_TENANT_ID', errors)
  const storeId = requiredUuid(environment.MBOX_STORE_ID, 'MBOX_STORE_ID', errors)
  const secret = requiredSecret(environment.MBOX_NORMALIZED_SECRET, errors)
  const metricsToken = readMetricsToken(environment.MBOX_METRICS_TOKEN, nodeEnv, errors)
  const integrations = readNormalizedIntegrationContract(
    environment,
    nodeEnv,
    deploymentTier,
    errors,
  )
  const payment = readPayment(environment, integrations.modes.payment, errors)
  const guestPaymentMode = readGuestPaymentMode(
    environment.MBOX_GUEST_PAYMENT_MODE,
    commercialProduction,
    errors,
  )
  if (guestPaymentMode === 'wechat_jsapi' && payment?.wechat === null) {
    errors.push('POSTAR_WECHAT_APP_ID', 'POSTAR_WECHAT_TRADE_TYPE')
  }
  const inventoryEnforcementMode = readInventoryEnforcementMode(
    environment.MBOX_INVENTORY_ENFORCEMENT_MODE,
    commercialProduction,
    errors,
  )
  const guestOrderSafetyPolicy = Object.freeze({
    duplicateWindowSeconds: readInteger(
      environment.MBOX_GUEST_ORDER_DUPLICATE_WINDOW_SECONDS,
      'MBOX_GUEST_ORDER_DUPLICATE_WINDOW_SECONDS',
      45,
      1,
      600,
      errors,
    ),
    maxOrdersPerCustomerPerMinute: readInteger(
      environment.MBOX_GUEST_ORDER_CUSTOMER_LIMIT_PER_MINUTE,
      'MBOX_GUEST_ORDER_CUSTOMER_LIMIT_PER_MINUTE',
      5,
      1,
      100,
      errors,
    ),
    maxOrdersPerTablePerMinute: readInteger(
      environment.MBOX_GUEST_ORDER_TABLE_LIMIT_PER_MINUTE,
      'MBOX_GUEST_ORDER_TABLE_LIMIT_PER_MINUTE',
      20,
      1,
      500,
      errors,
    ),
  })
  if (guestOrderSafetyPolicy.maxOrdersPerTablePerMinute
    < guestOrderSafetyPolicy.maxOrdersPerCustomerPerMinute) {
    errors.push('MBOX_GUEST_ORDER_TABLE_LIMIT_PER_MINUTE')
  }
  const port = readInteger(environment.PORT, 'PORT', 3_000, 1, 65_535, errors)
  const poolMax = readInteger(environment.MBOX_DATABASE_POOL_MAX, 'MBOX_DATABASE_POOL_MAX', 12, 2, 100, errors)
  const workerPoolMax = readInteger(environment.MBOX_WORKER_DATABASE_POOL_MAX, 'MBOX_WORKER_DATABASE_POOL_MAX', 4, 2, 12, errors)
  const trustProxyHops = readInteger(environment.MBOX_TRUST_PROXY_HOPS, 'MBOX_TRUST_PROXY_HOPS', 0, 0, 2, errors)
  const commitSha = readCommitSha(environment.APP_COMMIT_SHA ?? environment.GITHUB_SHA)
  const releaseImageDigest = readImageDigest(environment.MBOX_RELEASE_IMAGE_DIGEST, errors)
  const staticDir = optional(environment.MBOX_STATIC_DIR)
  const startWorkers = readBoolean(environment.MBOX_START_WORKERS, false, 'MBOX_START_WORKERS', errors)
  if (commercialProduction && !startWorkers) errors.push('MBOX_START_WORKERS')
  const workerId = readWorkerId(environment.MBOX_WORKER_ID, startWorkers, errors)
  const workerIntervalMs = readInteger(
    environment.MBOX_WORKER_INTERVAL_MS,
    'MBOX_WORKER_INTERVAL_MS',
    2_000,
    250,
    60_000,
    errors,
  )
  const workerAdapterModule = readWorkerAdapterModule(
    environment.MBOX_WORKER_ADAPTER_MODULE,
    startWorkers,
    commercialProduction,
    errors,
  )

  if (errors.length > 0) throw new NormalizedRuntimeConfigurationError([...new Set(errors)])
  return Object.freeze({
    nodeEnv,
    deploymentTier,
    databaseUrl,
    tenantId,
    storeId,
    secret,
    metricsToken,
    configVersion: NORMALIZED_RUNTIME_CONFIG_VERSION,
    integrations,
    payment,
    guestPaymentMode,
    inventoryEnforcementMode,
    guestOrderSafetyPolicy,
    commitSha,
    releaseImageDigest,
    schemaFlavor: NORMALIZED_SCHEMA_FLAVOR,
    host: optional(environment.HOST) ?? '0.0.0.0',
    port,
    poolMax,
    workerPoolMax,
    trustProxyHops,
    staticDir,
    startWorkers,
    workerId,
    workerIntervalMs,
    workerAdapterModule,
  })
}

function readImageDigest(value: string | undefined, errors: string[]): string | null {
  const normalized = optional(value)
  if (normalized === null) return null
  if (!/^sha256:[0-9a-f]{64}$/.test(normalized)) {
    errors.push('MBOX_RELEASE_IMAGE_DIGEST')
    return null
  }
  return normalized
}

function readInventoryEnforcementMode(
  value: string | undefined,
  commercialProduction: boolean,
  errors: string[],
): NormalizedRuntimeConfig['inventoryEnforcementMode'] {
  const normalized = optional(value)
  if (normalized === 'strict') return normalized
  if (normalized === 'audit_only') {
    if (commercialProduction) errors.push('MBOX_INVENTORY_ENFORCEMENT_MODE')
    return normalized
  }
  if (normalized !== null) errors.push('MBOX_INVENTORY_ENFORCEMENT_MODE')
  return commercialProduction ? 'strict' : 'audit_only'
}

function readWorkerId(value: string | undefined, enabled: boolean, errors: string[]): string | null {
  const normalized = optional(value)
  if (normalized === null) {
    if (enabled) errors.push('MBOX_WORKER_ID')
    return null
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,95}$/.test(normalized)) {
    errors.push('MBOX_WORKER_ID')
    return null
  }
  return normalized
}

function readWorkerAdapterModule(
  value: string | undefined,
  enabled: boolean,
  commercialProduction: boolean,
  errors: string[],
): string | null {
  const normalized = optional(value)
  if (normalized === null) {
    if (enabled && commercialProduction) errors.push('MBOX_WORKER_ADAPTER_MODULE')
    return null
  }
  if (!isAbsolute(normalized)) {
    errors.push('MBOX_WORKER_ADAPTER_MODULE')
    return null
  }
  return normalized
}

function readPayment(
  environment: Readonly<Record<string, string | undefined>>,
  mode: NormalizedIntegrationContract['modes']['payment'],
  errors: string[],
): NormalizedPaymentRuntimeConfig | null {
  const provider = optional(environment.MBOX_PAYMENT_PROVIDER)
  const agencyId = optional(environment.POSTAR_AGENCY_ID)
  const merchantId = optional(environment.POSTAR_MERCHANT_ID)
  const publicKey = optional(environment.POSTAR_PUBLIC_KEY)
  const callbackUrl = optional(environment.POSTAR_CALLBACK_URL)
  const wechatAppId = optional(environment.POSTAR_WECHAT_APP_ID)
  const wechatTradeType = optional(environment.POSTAR_WECHAT_TRADE_TYPE)
  const anyPaymentField = provider !== null || agencyId !== null
    || merchantId !== null || publicKey !== null || callbackUrl !== null
    || wechatAppId !== null || wechatTradeType !== null

  if (mode === 'disabled') {
    if (anyPaymentField) errors.push('MBOX_PAYMENT_MODE')
    return null
  }
  if (provider !== 'postar') errors.push('MBOX_PAYMENT_PROVIDER')
  if (agencyId === null) errors.push('POSTAR_AGENCY_ID')
  if (merchantId === null) errors.push('POSTAR_MERCHANT_ID')
  if (publicKey === null) errors.push('POSTAR_PUBLIC_KEY')
  if (callbackUrl === null || !isHttpsUrl(callbackUrl)) errors.push('POSTAR_CALLBACK_URL')
  if ((wechatAppId === null) !== (wechatTradeType === null)) {
    errors.push('POSTAR_WECHAT_APP_ID', 'POSTAR_WECHAT_TRADE_TYPE')
  }
  if (wechatTradeType !== null && wechatTradeType !== '5' && wechatTradeType !== '8') {
    errors.push('POSTAR_WECHAT_TRADE_TYPE')
  }
  const timeoutMs = readInteger(
    environment.POSTAR_HTTP_TIMEOUT_MS,
    'POSTAR_HTTP_TIMEOUT_MS',
    10_000,
    1_000,
    30_000,
    errors,
  )
  if (provider !== 'postar'
    || agencyId === null || merchantId === null || publicKey === null
    || callbackUrl === null || !isHttpsUrl(callbackUrl)
    || (wechatTradeType !== null && wechatTradeType !== '5' && wechatTradeType !== '8')) return null
  return Object.freeze({
    provider,
    environment: mode,
    agencyId,
    merchantId,
    publicKey,
    callbackUrl,
    timeoutMs,
    wechat: wechatAppId === null || wechatTradeType === null
      ? null
      : Object.freeze({ appId: wechatAppId, tradeType: wechatTradeType }),
  })
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function readGuestPaymentMode(
  value: string | undefined,
  commercialProduction: boolean,
  errors: string[],
): GuestCheckoutPaymentMode {
  const normalized = optional(value)
  if (normalized === 'wechat_jsapi' || normalized === 'wechat_native_qr' || normalized === 'simulation') {
    if (commercialProduction && normalized === 'simulation') errors.push('MBOX_GUEST_PAYMENT_MODE')
    return normalized
  }
  if (normalized !== null) errors.push('MBOX_GUEST_PAYMENT_MODE')
  if (commercialProduction) {
    errors.push('MBOX_GUEST_PAYMENT_MODE')
    return 'wechat_native_qr'
  }
  return 'simulation'
}

function readDeploymentTier(
  value: string | undefined,
  nodeEnv: NormalizedRuntimeConfig['nodeEnv'],
  errors: string[],
): NormalizedRuntimeConfig['deploymentTier'] {
  const normalized = optional(value)
  if (normalized === 'validation') return normalized
  if (normalized === 'production') {
    if (nodeEnv !== 'production') errors.push('NODE_ENV')
    return normalized
  }
  if (normalized !== null) errors.push('MBOX_DEPLOYMENT_TIER')
  return nodeEnv === 'production' ? 'production' : 'validation'
}

function readMetricsToken(
  value: string | undefined,
  nodeEnv: NormalizedRuntimeConfig['nodeEnv'],
  errors: string[],
): string | null {
  const normalized = optional(value)
  if (normalized === null) {
    if (nodeEnv === 'production') errors.push('MBOX_METRICS_TOKEN')
    return null
  }
  if (Buffer.byteLength(normalized, 'utf8') < 32) {
    errors.push('MBOX_METRICS_TOKEN')
    return null
  }
  return normalized
}

function required(value: string | undefined, field: string, errors: string[]): string {
  const normalized = optional(value)
  if (normalized === null) errors.push(field)
  return normalized ?? ''
}

function requiredUuid(value: string | undefined, field: string, errors: string[]): string {
  const normalized = required(value, field, errors)
  if (normalized && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    errors.push(field)
  }
  return normalized
}

function requiredSecret(value: string | undefined, errors: string[]): string {
  const normalized = required(value, 'MBOX_NORMALIZED_SECRET', errors)
  if (normalized && Buffer.byteLength(normalized, 'utf8') < 32) errors.push('MBOX_NORMALIZED_SECRET')
  return normalized
}

function readNodeEnv(value: string | undefined): NormalizedRuntimeConfig['nodeEnv'] {
  return value === 'production' || value === 'test' ? value : 'development'
}

function readCommitSha(value: string | undefined): string {
  const normalized = optional(value)
  return normalized !== null && /^[0-9a-f]{7,64}$/i.test(normalized) ? normalized : 'development'
}

function readInteger(
  value: string | undefined,
  field: string,
  fallback: number,
  minimum: number,
  maximum: number,
  errors: string[],
): number {
  if (optional(value) === null) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    errors.push(field)
    return fallback
  }
  return parsed
}

function readBoolean(
  value: string | undefined,
  fallback: boolean,
  field: string,
  errors: string[],
): boolean {
  const normalized = optional(value)
  if (normalized === null) return fallback
  if (normalized === 'true') return true
  if (normalized === 'false') return false
  errors.push(field)
  return fallback
}

function optional(value: string | undefined): string | null {
  const normalized = value?.trim()
  return normalized ? normalized : null
}
