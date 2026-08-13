import { isAbsolute } from 'node:path'
import type { GuestCheckoutPaymentMode } from './guest-commerce-service-api.js'

export const NORMALIZED_SCHEMA_FLAVOR = 'normalized-core-v1'

export interface NormalizedPaymentRuntimeConfig {
  provider: 'postar'
  agencyId: string
  merchantId: string
  publicKey: string
}

export interface NormalizedRuntimeConfig {
  nodeEnv: 'development' | 'test' | 'production'
  deploymentTier: 'validation' | 'production'
  databaseUrl: string
  tenantId: string
  storeId: string
  secret: string
  metricsToken: string | null
  payment: NormalizedPaymentRuntimeConfig | null
  guestPaymentMode: GuestCheckoutPaymentMode
  inventoryEnforcementMode: 'strict' | 'audit_only'
  commitSha: string
  schemaFlavor: typeof NORMALIZED_SCHEMA_FLAVOR
  host: string
  port: number
  poolMax: number
  workerPoolMax: number
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
    environment.MBOX_DEPLOYMENT_TIER ?? environment.DEPLOYMENT_TIER,
    nodeEnv,
    errors,
  )
  const commercialProduction = deploymentTier === 'production'
  const databaseUrl = required(environment.DATABASE_URL, 'DATABASE_URL', errors)
  const tenantId = requiredUuid(environment.MBOX_TENANT_ID, 'MBOX_TENANT_ID', errors)
  const storeId = requiredUuid(environment.MBOX_STORE_ID, 'MBOX_STORE_ID', errors)
  const secret = requiredSecret(environment.MBOX_NORMALIZED_SECRET, errors)
  const metricsToken = readMetricsToken(environment.MBOX_METRICS_TOKEN, nodeEnv, errors)
  const payment = readPayment(environment, commercialProduction, errors)
  const guestPaymentMode = readGuestPaymentMode(
    environment.MBOX_GUEST_PAYMENT_MODE,
    commercialProduction,
    errors,
  )
  const inventoryEnforcementMode = readInventoryEnforcementMode(
    environment.MBOX_INVENTORY_ENFORCEMENT_MODE,
    commercialProduction,
    errors,
  )
  const port = readInteger(environment.PORT, 'PORT', 3_000, 1, 65_535, errors)
  const poolMax = readInteger(environment.MBOX_DATABASE_POOL_MAX, 'MBOX_DATABASE_POOL_MAX', 12, 2, 100, errors)
  const workerPoolMax = readInteger(environment.MBOX_WORKER_DATABASE_POOL_MAX, 'MBOX_WORKER_DATABASE_POOL_MAX', 4, 2, 12, errors)
  const commitSha = readCommitSha(environment.APP_COMMIT_SHA ?? environment.GITHUB_SHA)
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
    payment,
    guestPaymentMode,
    inventoryEnforcementMode,
    commitSha,
    schemaFlavor: NORMALIZED_SCHEMA_FLAVOR,
    host: optional(environment.HOST) ?? '0.0.0.0',
    port,
    poolMax,
    workerPoolMax,
    staticDir,
    startWorkers,
    workerId,
    workerIntervalMs,
    workerAdapterModule,
  })
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
  commercialProduction: boolean,
  errors: string[],
): NormalizedPaymentRuntimeConfig | null {
  const provider = optional(environment.MBOX_PAYMENT_PROVIDER)
  const agencyId = optional(environment.POSTAR_AGENCY_ID)
  const merchantId = optional(environment.POSTAR_MERCHANT_ID)
  const publicKey = optional(environment.POSTAR_PUBLIC_KEY)
  const anyPaymentField = provider !== null || agencyId !== null || merchantId !== null || publicKey !== null

  if (!commercialProduction && !anyPaymentField) return null
  if (provider !== 'postar') errors.push('MBOX_PAYMENT_PROVIDER')
  if (agencyId === null) errors.push('POSTAR_AGENCY_ID')
  if (merchantId === null) errors.push('POSTAR_MERCHANT_ID')
  if (publicKey === null) errors.push('POSTAR_PUBLIC_KEY')
  if (provider !== 'postar' || agencyId === null || merchantId === null || publicKey === null) return null
  return Object.freeze({ provider, agencyId, merchantId, publicKey })
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
