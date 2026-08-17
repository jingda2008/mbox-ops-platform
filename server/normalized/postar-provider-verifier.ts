import {
  constants,
  createHash,
  createPublicKey,
  publicDecrypt,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto'
import type { JsonObject, JsonValue } from './command-executor.js'
import {
  PaymentProviderVerificationError,
  type PaymentProviderVerifier,
  type ProviderVerificationInput,
  type TrustedProviderMerchantIdentity,
  type VerifiedPaymentCallback,
  type VerifiedRefundCallback,
} from './payment-api.js'
import type { StoreScope } from './transaction-runner.js'

export interface PostarMerchantBinding {
  agencyId: string
  merchantId: string
  scope: Readonly<StoreScope>
  publicKey: string
}

export interface PostarProviderVerifierOptions {
  bindings: readonly PostarMerchantBinding[]
  maximumBodyBytes?: number
}

interface PreparedNotification {
  fields: JsonObject
  merchant: TrustedProviderMerchantIdentity
  status: string
  amountMinor: number
  occurredAt: string
  providerOrderId: string
  merchantOrderId: string
}

interface StoredBinding {
  merchant: TrustedProviderMerchantIdentity
  publicKey: KeyObject
}

const DEFAULT_MAXIMUM_BODY_BYTES = 256 * 1024

export class PostarRsaPaymentProviderVerifier implements PaymentProviderVerifier {
  private readonly bindings = new Map<string, StoredBinding>()
  private readonly maximumBodyBytes: number

  constructor(options: Readonly<PostarProviderVerifierOptions>) {
    this.maximumBodyBytes = options.maximumBodyBytes ?? DEFAULT_MAXIMUM_BODY_BYTES
    if (!Number.isSafeInteger(this.maximumBodyBytes) || this.maximumBodyBytes < 1) {
      throw new TypeError('maximumBodyBytes must be a positive integer')
    }
    for (const binding of options.bindings) this.addBinding(binding)
    if (this.bindings.size === 0) throw new TypeError('At least one Postar merchant binding is required')
  }

  async verifyPaymentCallback(
    input: Readonly<ProviderVerificationInput>,
  ): Promise<VerifiedPaymentCallback> {
    const prepared = this.prepare(input)
    if (prepared.status !== '1' && prepared.status !== 'e') {
      throw new PaymentProviderVerificationError('星驿通知不是支付成功终态')
    }
    if (prepared.amountMinor <= 0) throw new PaymentProviderVerificationError('星驿支付金额无效')
    const providerTransactionId = prepared.providerOrderId
    const settlementChannel = postarSettlementChannel(prepared.fields.PAY_CHANNEL)
    const businessIdentity = hashBusinessIdentity([
      'payment',
      prepared.merchant.agencyId,
      prepared.merchant.merchantId,
      prepared.merchantOrderId,
      providerTransactionId,
      String(prepared.amountMinor),
    ])
    return {
      merchant: prepared.merchant,
      eventId: businessIdentity,
      businessIdentity,
      paymentPublicId: prepared.merchantOrderId,
      providerTransactionId,
      amountMinor: prepared.amountMinor,
      currency: 'CNY',
      ...(settlementChannel === null ? {} : { settlementChannel }),
      occurredAt: prepared.occurredAt,
      evidence: providerEvidence(prepared, businessIdentity),
    }
  }

  async verifyRefundCallback(
    input: Readonly<ProviderVerificationInput>,
  ): Promise<VerifiedRefundCallback> {
    const prepared = this.prepare(input)
    const succeeded = prepared.status === '4' || prepared.status === 'c'
    if (!succeeded && prepared.status !== '3') {
      throw new PaymentProviderVerificationError('星驿退款通知不是成功或失败终态')
    }
    if (prepared.amountMinor >= 0) throw new PaymentProviderVerificationError('星驿退款金额必须为负数')
    const originalProviderTransactionId = requiredString(
      prepared.fields.OLD_ORDER_NO,
      'OLD_ORDER_NO',
      256,
    )
    const providerRefundId = prepared.providerOrderId
    const reportedAmountMinor = Math.abs(prepared.amountMinor)
    const businessIdentity = hashBusinessIdentity([
      'refund',
      prepared.merchant.agencyId,
      prepared.merchant.merchantId,
      prepared.merchantOrderId,
      providerRefundId,
      originalProviderTransactionId,
      String(reportedAmountMinor),
      succeeded ? 'succeeded' : 'failed',
    ])
    return {
      merchant: prepared.merchant,
      eventId: businessIdentity,
      businessIdentity,
      refundPublicId: prepared.merchantOrderId,
      provider: 'postar',
      succeeded,
      providerRefundId,
      originalProviderTransactionId,
      amountMinor: reportedAmountMinor,
      currency: 'CNY',
      occurredAt: prepared.occurredAt,
      evidence: providerEvidence(prepared, businessIdentity),
    }
  }

  private prepare(input: Readonly<ProviderVerificationInput>): PreparedNotification {
    if (input.provider !== 'postar') {
      throw new PaymentProviderVerificationError('当前验签器不支持该支付机构')
    }
    const contentType = singleHeader(input.headers['content-type'])
    if (contentType !== null && !contentType.toLowerCase().includes('application/json')) {
      throw new PaymentProviderVerificationError('星驿通知Content-Type无效')
    }
    if (input.rawBody.length < 2 || input.rawBody.length > this.maximumBodyBytes) {
      throw new PaymentProviderVerificationError('星驿通知原始报文大小无效')
    }
    const fields = parseJsonObject(input.rawBody)
    const agencyId = requiredString(fields.AGET_ID, 'AGET_ID', 128)
    const merchantId = requiredString(fields.CUST_ID, 'CUST_ID', 128)
    const binding = this.bindings.get(bindingKey(agencyId, merchantId))
    if (binding === undefined) throw new PaymentProviderVerificationError('星驿商户未绑定门店')
    verifySignature(fields, binding.publicKey)
    const status = requiredString(fields.ORDER_STATUS, 'ORDER_STATUS', 8)
    const amountMinor = signedMinor(fields.TXAMT)
    return {
      fields,
      merchant: binding.merchant,
      status,
      amountMinor,
      occurredAt: postarTimestamp(requiredString(fields.ORDER_TIME, 'ORDER_TIME', 14)),
      providerOrderId: requiredString(fields.ORDER_NO, 'ORDER_NO', 256),
      merchantOrderId: requiredString(fields.THREE_ORDER_NO, 'THREE_ORDER_NO', 128, 8),
    }
  }

  private addBinding(binding: Readonly<PostarMerchantBinding>): void {
    const agencyId = configuredIdentifier(binding.agencyId, 'agencyId')
    const merchantId = configuredIdentifier(binding.merchantId, 'merchantId')
    const key = bindingKey(agencyId, merchantId)
    if (this.bindings.has(key)) throw new TypeError(`Duplicate Postar merchant binding: ${key}`)
    const integrationDigest = createHash('sha256').update(key).digest('hex').slice(0, 24)
    this.bindings.set(key, {
      merchant: Object.freeze({
        provider: 'postar',
        agencyId,
        merchantId,
        scope: Object.freeze({ ...binding.scope }),
        integrationRef: `postar:${integrationDigest}`,
      }),
      publicKey: parsePublicKey(binding.publicKey),
    })
  }
}

function parseJsonObject(rawBody: Buffer): JsonObject {
  let value: unknown
  try {
    value = JSON.parse(rawBody.toString('utf8'))
  } catch {
    throw new PaymentProviderVerificationError('星驿通知不是有效JSON')
  }
  if (!isJsonObject(value)) throw new PaymentProviderVerificationError('星驿通知正文必须是JSON对象')
  return value
}

function verifySignature(fields: JsonObject, publicKey: KeyObject): void {
  const signature = requiredString(fields.sign, 'sign', 8_192)
  const canonical = canonicalSignString(fields)
  const expectedDigest = Buffer.from(createHash('sha256').update(canonical, 'utf8').digest('hex'), 'utf8')
  let decrypted: Buffer
  try {
    decrypted = publicDecrypt(
      { key: publicKey, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(signature, 'base64'),
    )
  } catch {
    throw new PaymentProviderVerificationError()
  }
  if (decrypted.length !== expectedDigest.length || !timingSafeEqual(decrypted, expectedDigest)) {
    throw new PaymentProviderVerificationError()
  }
}

export function canonicalPostarSignString(fields: Readonly<JsonObject>): string {
  return canonicalSignString(fields)
}

function canonicalSignString(fields: Readonly<JsonObject>): string {
  return Object.keys(fields)
    .filter((key) => key !== 'sign' && fields[key] !== null)
    .sort()
    .map((key) => `${key}=${postarValue(fields[key]!)}`)
    .join('&')
}

function postarValue(value: JsonValue): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function parsePublicKey(value: string): KeyObject {
  try {
    const trimmed = value.trim()
    return trimmed.includes('BEGIN PUBLIC KEY')
      ? createPublicKey(trimmed)
      : createPublicKey({ key: Buffer.from(trimmed, 'base64'), format: 'der', type: 'spki' })
  } catch {
    throw new TypeError('Postar public key is invalid')
  }
}

function providerEvidence(prepared: PreparedNotification, eventId: string): JsonObject {
  const channel = postarSettlementChannel(prepared.fields.PAY_CHANNEL)
  return {
    providerOrderId: prepared.providerOrderId,
    merchantOrderId: prepared.merchantOrderId,
    transactionState: prepared.status,
    eventId,
    occurredAt: prepared.occurredAt,
    ...(channel === null ? {} : { channel }),
  }
}

function postarSettlementChannel(value: JsonValue | undefined): 'wechat' | 'alipay' | 'unionpay' | null {
  if (value === '2') return 'wechat'
  if (value === '1') return 'alipay'
  if (value === '9') return 'unionpay'
  return null
}

function hashBusinessIdentity(parts: readonly string[]): string {
  return `postar:${createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex')}`
}

function bindingKey(agencyId: string, merchantId: string): string {
  return `${agencyId}\u0000${merchantId}`
}

function configuredIdentifier(value: string, label: string): string {
  const normalized = value.trim()
  if (normalized.length < 1 || normalized.length > 128) throw new TypeError(`${label} is invalid`)
  return normalized
}

function requiredString(value: JsonValue | undefined, label: string, maximum: number, minimum = 1): string {
  if (typeof value !== 'string') throw new PaymentProviderVerificationError(`星驿通知缺少${label}`)
  const normalized = value.trim()
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new PaymentProviderVerificationError(`星驿通知${label}长度无效`)
  }
  if (normalized !== value) throw new PaymentProviderVerificationError(`星驿通知${label}格式无效`)
  return normalized
}

function signedMinor(value: JsonValue | undefined): number {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw new PaymentProviderVerificationError('星驿通知TXAMT无效')
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed === 0) {
    throw new PaymentProviderVerificationError('星驿通知TXAMT超出范围')
  }
  return parsed
}

function postarTimestamp(value: string): string {
  if (!/^\d{14}$/.test(value)) throw new PaymentProviderVerificationError('星驿通知ORDER_TIME无效')
  const local = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}+08:00`
  const parsed = Date.parse(local)
  if (!Number.isFinite(parsed)) throw new PaymentProviderVerificationError('星驿通知ORDER_TIME无效')
  const roundTrip = new Date(parsed + 8 * 60 * 60 * 1_000)
    .toISOString()
    .replace(/[-:T]/g, '')
    .slice(0, 14)
  if (roundTrip !== value) throw new PaymentProviderVerificationError('星驿通知ORDER_TIME无效')
  return new Date(parsed).toISOString()
}

function singleHeader(value: string | string[] | undefined): string | null {
  if (value === undefined) return null
  if (Array.isArray(value)) {
    if (value.length !== 1 || value[0] === undefined) {
      throw new PaymentProviderVerificationError('星驿通知请求头重复')
    }
    return value[0]
  }
  return value
}

function isJsonObject(value: unknown): value is JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.values(value).every(isJsonValue)
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ['boolean', 'number', 'string'].includes(typeof value)) return true
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isJsonObject(value)
}
