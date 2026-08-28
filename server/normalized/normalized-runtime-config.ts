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

export interface NormalizedWechatIdentityRuntimeConfig {
  appId: string
  appSecret: string
  stateSecret: string
  encryptionKeyVersion: number
  encryptionKey: Buffer
}

export interface NormalizedWechatNotificationRuntimeConfig {
  serviceTemplateId: string
  policyVersion: string
}

export interface NormalizedPersonalContactRuntimeConfig {
  activeKeyId: string
  activeKey: Buffer
  lookupKey: Buffer
  legacyPhoneLookupKey: Buffer
  previousKeys: readonly Readonly<{ keyId: string; key: Buffer }>[]
}

export interface NormalizedRuntimeConfig {
  nodeEnv: 'development' | 'test' | 'production'
  deploymentTier: 'validation' | 'production'
  runtimeRole?: 'normal' | 'contract_candidate'
  databaseUrl: string
  tenantId: string
  storeId: string
  secret: string
  metricsToken: string | null
  configVersion: typeof NORMALIZED_RUNTIME_CONFIG_VERSION
  integrations: NormalizedIntegrationContract
  payment: NormalizedPaymentRuntimeConfig | null
  wechatIdentity: NormalizedWechatIdentityRuntimeConfig | null
  wechatNotification: NormalizedWechatNotificationRuntimeConfig | null
  personalContactProtection?: NormalizedPersonalContactRuntimeConfig | null
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
  const runtimeRole = readRuntimeRole(environment.MBOX_RUNTIME_ROLE,errors)
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
  const wechatIdentity = readWechatIdentity(environment, errors)
  const wechatNotification = readWechatNotification(environment, errors)
  const personalContactProtection = readPersonalContactProtection(
    environment,commercialProduction,errors,
  )
  const guestPaymentMode = readGuestPaymentMode(
    environment.MBOX_GUEST_PAYMENT_MODE,
    commercialProduction,
    errors,
  )
  if (guestPaymentMode === 'wechat_jsapi' && payment?.wechat === null) {
    errors.push('POSTAR_WECHAT_APP_ID', 'POSTAR_WECHAT_TRADE_TYPE')
  }
  if (guestPaymentMode === 'wechat_jsapi' && payment !== null && payment.wechat !== null
    && wechatIdentity !== null && payment.wechat.appId !== wechatIdentity.appId) {
    errors.push('MBOX_WECHAT_APP_ID', 'POSTAR_WECHAT_APP_ID')
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
  if (commercialProduction && trustProxyHops !== 1) errors.push('MBOX_TRUST_PROXY_HOPS')
  const commitSha = readCommitSha(environment.APP_COMMIT_SHA ?? environment.GITHUB_SHA)
  const releaseImageDigest = readImageDigest(environment.MBOX_RELEASE_IMAGE_DIGEST, errors)
  const staticDir = optional(environment.MBOX_STATIC_DIR)
  const startWorkers = readBoolean(environment.MBOX_START_WORKERS, false, 'MBOX_START_WORKERS', errors)
  if (commercialProduction && !startWorkers && runtimeRole!=='contract_candidate') {
    errors.push('MBOX_START_WORKERS')
  }
  if (runtimeRole==='contract_candidate' && (!commercialProduction || startWorkers)) {
    errors.push('MBOX_RUNTIME_ROLE','MBOX_START_WORKERS')
  }
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
    runtimeRole,
    databaseUrl,
    tenantId,
    storeId,
    secret,
    metricsToken,
    configVersion: NORMALIZED_RUNTIME_CONFIG_VERSION,
    integrations,
    payment,
    wechatIdentity,
    wechatNotification,
    personalContactProtection,
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

function readRuntimeRole(value:string|undefined,errors:string[]):NormalizedRuntimeConfig['runtimeRole']{
  const normalized=optional(value) ?? 'normal'
  if (normalized==='normal' || normalized==='contract_candidate') return normalized
  errors.push('MBOX_RUNTIME_ROLE')
  return 'normal'
}

function readPersonalContactProtection(
  environment: Readonly<Record<string, string | undefined>>,
  requiredForProduction: boolean,
  errors: string[],
): NormalizedPersonalContactRuntimeConfig | null {
  const activeKeyId = optional(environment.MBOX_CONTACT_ACTIVE_KEY_ID)
  const activeKeyRaw = optional(environment.MBOX_CONTACT_ACTIVE_KEY_BASE64)
  const lookupKeyRaw = optional(environment.MBOX_CONTACT_LOOKUP_KEY_BASE64)
  const legacyPhoneLookupKeyRaw = optional(environment.MBOX_CONTACT_LEGACY_PHONE_LOOKUP_KEY_BASE64)
  const previousRaw = optional(environment.MBOX_CONTACT_PREVIOUS_KEYS)
  if (activeKeyId === null && activeKeyRaw === null && lookupKeyRaw === null
    && legacyPhoneLookupKeyRaw === null && previousRaw === null) {
    if (requiredForProduction) {
      errors.push('MBOX_CONTACT_ACTIVE_KEY_ID','MBOX_CONTACT_ACTIVE_KEY_BASE64',
        'MBOX_CONTACT_LOOKUP_KEY_BASE64','MBOX_CONTACT_LEGACY_PHONE_LOOKUP_KEY_BASE64',
        'MBOX_CONTACT_PREVIOUS_KEYS')
    }
    return null
  }
  if (activeKeyId === null || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(activeKeyId)
    || activeKeyId === 'normalized-contact-v1' || activeKeyId === 'normalized-phone-v1') {
    errors.push('MBOX_CONTACT_ACTIVE_KEY_ID')
  }
  const activeKey = decodeContactKey(activeKeyRaw,'MBOX_CONTACT_ACTIVE_KEY_BASE64',errors)
  const lookupKey = decodeContactKey(lookupKeyRaw,'MBOX_CONTACT_LOOKUP_KEY_BASE64',errors)
  const legacyPhoneLookupKey = decodeContactKey(
    legacyPhoneLookupKeyRaw,'MBOX_CONTACT_LEGACY_PHONE_LOOKUP_KEY_BASE64',errors,
  )
  const previousKeys: Array<{ keyId: string; key: Buffer }> = []
  if (requiredForProduction && previousRaw===null) errors.push('MBOX_CONTACT_PREVIOUS_KEYS')
  if (previousRaw !== null) {
    for (const item of previousRaw.split(';').map((value) => value.trim()).filter(Boolean)) {
      const separator = item.indexOf('=')
      const keyId = separator < 0 ? '' : item.slice(0,separator)
      const encoded = separator < 0 ? '' : item.slice(separator+1)
      const key = decodeContactKey(encoded,'MBOX_CONTACT_PREVIOUS_KEYS',errors)
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(keyId)
        || keyId === activeKeyId || previousKeys.some((entry) => entry.keyId === keyId)) {
        errors.push('MBOX_CONTACT_PREVIOUS_KEYS')
      } else if (key !== null) previousKeys.push({ keyId,key })
    }
  }
  if (activeKeyId === null || activeKey === null || lookupKey === null
    || legacyPhoneLookupKey === null) return null
  return Object.freeze({
    activeKeyId,activeKey,lookupKey,legacyPhoneLookupKey,
    previousKeys:Object.freeze(previousKeys),
  })
}

function decodeContactKey(value: string | null, field: string, errors: string[]): Buffer | null {
  if (value === null) { errors.push(field); return null }
  const key = Buffer.from(value,'base64')
  if (key.length !== 32 || key.toString('base64') !== value) {
    errors.push(field)
    return null
  }
  return key
}

function readWechatNotification(
  environment: Readonly<Record<string, string | undefined>>,
  errors: string[],
): NormalizedWechatNotificationRuntimeConfig | null {
  const serviceTemplateId = optional(environment.MBOX_WECHAT_SERVICE_TEMPLATE_ID)
  const policyVersion = optional(environment.MBOX_WECHAT_NOTIFICATION_POLICY_VERSION)
  if (serviceTemplateId === null && policyVersion === null) return null
  if (serviceTemplateId === null || !/^[A-Za-z0-9_-]{8,128}$/.test(serviceTemplateId)) {
    errors.push('MBOX_WECHAT_SERVICE_TEMPLATE_ID')
  }
  if (policyVersion === null || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(policyVersion)) {
    errors.push('MBOX_WECHAT_NOTIFICATION_POLICY_VERSION')
  }
  if (serviceTemplateId === null || policyVersion === null) return null
  return Object.freeze({ serviceTemplateId, policyVersion })
}

function readWechatIdentity(
  environment: Readonly<Record<string, string | undefined>>,
  errors: string[],
): NormalizedWechatIdentityRuntimeConfig | null {
  const enabled = readBoolean(environment.MBOX_WECHAT_ENABLED, false, 'MBOX_WECHAT_ENABLED', errors)
  const appId = optional(environment.MBOX_WECHAT_APP_ID)
  const appSecret = optional(environment.MBOX_WECHAT_APP_SECRET)
  const stateSecret = optional(environment.MBOX_WECHAT_STATE_SECRET)
  const keyVersionRaw = optional(environment.MBOX_WECHAT_ENCRYPTION_KEY_VERSION)
  const keyRaw = optional(environment.MBOX_WECHAT_ENCRYPTION_KEY_BASE64)
  const anyField = appId !== null || appSecret !== null || stateSecret !== null
    || keyVersionRaw !== null || keyRaw !== null

  if (!enabled) {
    if (anyField) errors.push('MBOX_WECHAT_ENABLED')
    return null
  }
  if (appId === null || !/^wx[A-Za-z0-9_-]{4,126}$/.test(appId)) errors.push('MBOX_WECHAT_APP_ID')
  if (appSecret === null || appSecret.length < 16) errors.push('MBOX_WECHAT_APP_SECRET')
  if (stateSecret === null || Buffer.byteLength(stateSecret, 'utf8') < 32) errors.push('MBOX_WECHAT_STATE_SECRET')
  const keyVersion = Number(keyVersionRaw)
  if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) errors.push('MBOX_WECHAT_ENCRYPTION_KEY_VERSION')
  let encryptionKey: Buffer | null = null
  if (keyRaw === null) {
    errors.push('MBOX_WECHAT_ENCRYPTION_KEY_BASE64')
  } else {
    try {
      encryptionKey = Buffer.from(keyRaw, 'base64')
    } catch {
      encryptionKey = null
    }
    if (encryptionKey === null || encryptionKey.length !== 32 || encryptionKey.toString('base64') !== keyRaw) {
      errors.push('MBOX_WECHAT_ENCRYPTION_KEY_BASE64')
      encryptionKey = null
    }
  }
  if (appId === null || appSecret === null || stateSecret === null
    || !Number.isSafeInteger(keyVersion) || keyVersion < 1 || encryptionKey === null) return null
  return Object.freeze({ appId, appSecret, stateSecret, encryptionKeyVersion: keyVersion, encryptionKey })
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
    if (commercialProduction && normalized === 'wechat_native_qr') errors.push('MBOX_GUEST_PAYMENT_MODE')
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
