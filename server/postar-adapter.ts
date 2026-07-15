import {
  constants,
  createHash,
  publicDecrypt,
  publicEncrypt,
  timingSafeEqual,
} from 'node:crypto'
import type {
  DownloadProviderBillRequest,
  PaymentProviderAdapter,
  PaymentProviderContext,
  ProviderBillEntry,
  ProviderCreatePaymentRequest,
  ProviderCreatePaymentResult,
  ProviderPaymentObservation,
  ProviderPaymentQueryRequest,
  ProviderRefundObservation,
  ProviderRefundQueryRequest,
  ProviderRefundRequest,
  RawPaymentProviderCallback,
  VerifiedProviderPaymentCallback,
} from '../src/shared/payment-provider-contracts.js'
import {
  POSTAR_BASE_URLS,
  POSTAR_ENDPOINTS,
  type PostarAdapterOptions,
  type PostarHttpResponse,
  type PostarJsonValue,
  type PostarSynchronousResponse,
  type PostarTopLevelPayload,
} from '../src/shared/postar-contracts.js'

const DEFAULT_AGENCY_ID_SECRET = 'postar.agencyId'
const DEFAULT_PUBLIC_KEY_SECRET = 'postar.publicKey'
const VERSION = '1.0.0'
const ASCII_KEY = /^[\x20-\x7e]+$/
const DATE = /^\d{8}$/
const DATE_TIME = /^\d{14}$/
const ALPHANUMERIC_ORDER_ID = /^[A-Za-z0-9]{1,40}$/

type JsonObject = Record<string, PostarJsonValue | undefined>

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label}必须是JSON对象`)
  }
}

function requiredString(object: Record<string, unknown>, key: string, label = key) {
  const value = object[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`星驿${label}缺失或无效`)
  }
  return value
}

function optionalString(object: Record<string, unknown>, key: string) {
  const value = object[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`星驿${key}必须是字符串`)
  return value
}

function assertDate(value: string, label: string) {
  if (!DATE.test(value)) throw new Error(`${label}必须为yyyyMMdd`)
}

function assertRefundMetadata(merchantId: string, tag: string) {
  if (!merchantId.trim()) throw new Error('星驿退款商户号不能为空')
  if (!['1', '2', '9', '11', '12', '30'].includes(tag)) {
    throw new Error(`星驿普通退款渠道tag无效: ${tag}`)
  }
}

function refundTagForChannel(channel: ProviderRefundRequest['settlementChannel']) {
  if (channel === 'alipay') return '1' as const
  if (channel === 'wechat') return '2' as const
  if (channel === 'unionpay') return '9' as const
  return undefined
}

function compactJson(value: unknown) {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new Error('星驿签名值不能序列化')
  return serialized
}

function asciiCompare(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

function sortedSigningEntries(payload: PostarTopLevelPayload) {
  return Object.entries(payload)
    .filter(([key, value]) => key !== 'sign' && value !== null && value !== undefined)
    .sort(([left], [right]) => asciiCompare(left, right))
}

function signingValue(value: Exclude<PostarJsonValue, null>) {
  if (typeof value === 'string') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('星驿签名数字必须有限')
    return String(value)
  }
  if (typeof value === 'boolean') return String(value)
  return compactJson(value)
}

export function canonicalizePostarPayload(payload: PostarTopLevelPayload) {
  for (const key of Object.keys(payload)) {
    if (!ASCII_KEY.test(key)) throw new Error('星驿顶层参数名必须为ASCII字符')
  }
  return sortedSigningEntries(payload)
    .map(([key, value]) => `${key}=${signingValue(value as Exclude<PostarJsonValue, null>)}`)
    .join('&')
}

export function hashPostarPayload(payload: PostarTopLevelPayload) {
  return createHash('sha256').update(canonicalizePostarPayload(payload), 'utf8').digest('hex')
}

function normalizePublicKey(value: string) {
  const trimmed = value.trim()
  if (trimmed.includes('-----BEGIN PUBLIC KEY-----')) return trimmed
  const base64 = trimmed.replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error('星驿公钥格式无效')
  return `-----BEGIN PUBLIC KEY-----\n${base64.match(/.{1,64}/g)?.join('\n') ?? ''}\n-----END PUBLIC KEY-----`
}

function encryptDigest(publicKey: string, digest: string) {
  return publicEncrypt(
    { key: normalizePublicKey(publicKey), padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(digest, 'utf8'),
  ).toString('base64')
}

function verifyEncryptedDigest(payload: PostarTopLevelPayload, publicKey: string) {
  const sign = payload.sign
  if (typeof sign !== 'string' || sign.trim().length === 0) {
    throw new Error('星驿响应缺少签名，按安全规范拒绝处理')
  }
  let decrypted: Buffer
  try {
    decrypted = publicDecrypt(
      { key: normalizePublicKey(publicKey), padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(sign, 'base64'),
    )
  } catch {
    throw new Error('星驿签名公钥解密失败')
  }
  const expected = Buffer.from(hashPostarPayload(payload), 'utf8')
  if (decrypted.length !== expected.length || !timingSafeEqual(decrypted, expected)) {
    throw new Error('星驿签名验证失败')
  }
}

function sortedPayload(payload: JsonObject) {
  const entries = Object.entries(payload)
    .filter(([, value]) => value !== null && value !== undefined)
    .sort(([left], [right]) => asciiCompare(left, right))
  return Object.fromEntries(entries) as JsonObject
}

function signedRequestBody(payload: JsonObject, publicKey: string) {
  const withoutNulls = sortedPayload(payload)
  const sign = encryptDigest(publicKey, hashPostarPayload(withoutNulls))
  return new TextEncoder().encode(compactJson(sortedPayload({ ...withoutNulls, sign })))
}

function decodeSecret(value: string | Uint8Array) {
  return typeof value === 'string' ? value : new TextDecoder('utf-8', { fatal: true }).decode(value)
}

async function getCredentials(
  context: PaymentProviderContext,
  agencyIdSecretName: string,
  publicKeySecretName: string,
) {
  const [agencyIdSecret, publicKeySecret] = await Promise.all([
    context.secrets.getSecret(agencyIdSecretName),
    context.secrets.getSecret(publicKeySecretName),
  ])
  const agencyId = decodeSecret(agencyIdSecret).trim()
  const publicKey = decodeSecret(publicKeySecret)
  if (!agencyId) throw new Error('星驿机构号密钥为空')
  normalizePublicKey(publicKey)
  return { agencyId, publicKey }
}

function parseJsonBytes(body: Uint8Array, label: string) {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
  } catch {
    throw new Error(`${label}不是有效UTF-8 JSON`)
  }
  assertObject(value, label)
  return value
}

function parseSignedResponse(response: PostarHttpResponse, publicKey: string) {
  if (response.status !== 200) throw new Error(`星驿HTTP响应异常: ${response.status}`)
  const parsed = parseJsonBytes(response.body, '星驿同步响应')
  verifyEncryptedDigest(parsed as PostarTopLevelPayload, publicKey)
  const code = requiredString(parsed, 'code', '同步响应code')
  const msg = requiredString(parsed, 'msg', '同步响应msg')
  return { ...parsed, code, msg, data: parsed.data as PostarJsonValue | undefined } as PostarSynchronousResponse
}

function parseMoney(value: unknown, label: string, options: { allowNegative?: boolean } = {}) {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) throw new Error(`${label}必须为整数分字符串`)
  const amount = Number(value)
  if (!Number.isSafeInteger(amount)) throw new Error(`${label}超出安全整数范围`)
  if (!options.allowNegative && amount < 0) throw new Error(`${label}不能为负数`)
  return amount
}

function parsePositiveMoney(value: unknown, label: string) {
  const amount = parseMoney(value, label)
  if (amount <= 0) throw new Error(`${label}必须大于0`)
  return amount
}

function parsePostarDateTime(value: string, label: string) {
  if (!DATE_TIME.test(value)) throw new Error(`${label}必须为yyyyMMddHHmmss`)
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}+08:00`
  const timestamp = Date.parse(iso)
  if (Number.isNaN(timestamp)) throw new Error(`${label}不是有效日期时间`)
  return new Date(timestamp).toISOString()
}

function formatPostarTimestamp(date: Date) {
  if (Number.isNaN(date.getTime())) throw new Error('星驿时钟返回无效时间')
  const formatter = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    second: '2-digit',
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
  })
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]))
  return `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}${parts.second}`
}

function paymentStatus(value: string): ProviderPaymentObservation['status'] {
  switch (value) {
    case '0':
      return 'failed'
    case '1':
    case 'e':
    case 'i':
      return 'succeeded'
    case '2':
      return 'processing'
    case '99':
      return 'failed'
    case '3':
    case '4':
    case '5':
    case '7':
    case '8':
    case '9':
    case 'a':
    case 'b':
    case 'c':
    case 'f':
    case '14':
    case '15':
    case '16':
    case '98':
    case 'j':
    case 'k':
      throw new Error(`星驿订单状态${value}不是普通支付状态`)
    default:
      throw new Error(`未知星驿订单状态: ${value}`)
  }
}

function refundStatus(value: string): ProviderRefundObservation['status'] {
  switch (value) {
    case '3':
      return 'failed'
    case '4':
    case 'c':
      return 'succeeded'
    case '5':
    case 'b':
      return 'processing'
    case '7':
    case '98':
      throw new Error(`星驿订单状态${value}是撤销状态，不是普通退款状态`)
    default:
      throw new Error(`未知星驿退款状态: ${value}`)
  }
}

function requireDataObject(response: PostarSynchronousResponse) {
  if (!response.data) throw new Error('星驿同步响应缺少data')
  assertObject(response.data, '星驿同步响应data')
  return response.data as Record<string, unknown>
}

function requireDataString(response: PostarSynchronousResponse) {
  if (typeof response.data !== 'string' || !response.data.trim()) {
    throw new Error('星驿同步响应data必须是非空链接')
  }
  return response.data
}

function settlementChannel(value: unknown) {
  if (value === '1') return 'alipay' as const
  if (value === '2') return 'wechat' as const
  if (value === '9') return 'unionpay' as const
  return undefined
}

function assertAgency(data: Record<string, unknown>, agencyId: string) {
  const returnedAgencyId = optionalString(data, 'agetId')
  if (returnedAgencyId !== undefined && returnedAgencyId !== agencyId) {
    throw new Error('星驿响应机构号不匹配')
  }
}

function assertMerchant(data: Record<string, unknown>, merchantId: string) {
  const returnedMerchantId = optionalString(data, 'custId')
  if (returnedMerchantId !== undefined && returnedMerchantId !== merchantId) {
    throw new Error('星驿响应商户号不匹配')
  }
}

function callbackPaymentStatus(payload: Record<string, unknown>) {
  const status = requiredString(payload, 'ORDER_STATUS', '通知ORDER_STATUS')
  const transactionType = requiredString(payload, 'TRAN_TYPE_SER', '通知TRAN_TYPE_SER')
  const allowedTypes = status === 'e' ? ['31'] : ['01', 'P1']
  if (!allowedTypes.includes(transactionType)) {
    throw new Error(`星驿通知交易类型${transactionType}不是普通支付成功类型`)
  }
  if (!['1', 'e', 'i'].includes(status)) {
    paymentStatus(status)
    throw new Error(`星驿通知状态${status}不是支付成功状态`)
  }
  return 'succeeded' as const
}

function parsePaymentObservation(
  response: PostarSynchronousResponse,
  request: ProviderPaymentQueryRequest,
  agencyId: string,
) {
  if (!['000000', '222222', '555555'].includes(response.code)) {
    throw new Error(`星驿支付查询返回不可映射状态码: ${response.code} ${response.msg}`)
  }
  const data = requireDataObject(response)
  assertAgency(data, agencyId)
  const paymentIntentId = requiredString(data, 'threeOrderNo')
  if (paymentIntentId !== request.paymentIntentId) throw new Error('星驿支付查询三方订单号不匹配')
  const status = paymentStatus(requiredString(data, 'orderStatus'))
  if (response.code === '000000' && status !== 'succeeded') {
    throw new Error('星驿支付查询协议码与订单状态冲突')
  }
  if (response.code === '222222' && status !== 'processing') {
    throw new Error('星驿支付中响应与订单状态冲突')
  }
  if (response.code === '555555' && status !== 'failed') {
    throw new Error('星驿支付失败响应与订单状态冲突')
  }
  return {
    amount: parsePositiveMoney(data.txamt, '星驿支付金额'),
    currency: 'CNY',
    merchantId: request.merchantId,
    settlementChannel: settlementChannel(data.payChannel),
    occurredAt: parsePostarDateTime(requiredString(data, 'orderTime'), '星驿支付完成时间'),
    paymentIntentId,
    providerTransactionId: requiredString(data, 'orderNo'),
    status,
  } satisfies ProviderPaymentObservation
}

function refundFailure(
  request: ProviderRefundRequest,
  response: PostarSynchronousResponse,
  occurredAt: string,
): ProviderRefundObservation {
  return {
    amount: request.amount,
    currency: request.currency,
    failureReason: `${response.code}: ${response.msg}`,
    occurredAt,
    providerRefundId: request.refundId,
    providerRefundTransactionId: null,
    refundId: request.refundId,
    status: 'failed',
  }
}

function parseRefundQueryObservation(
  response: PostarSynchronousResponse,
  request: ProviderRefundQueryRequest,
  agencyId: string,
) {
  if (response.code === '121338') {
    throw new Error('星驿退款处理中响应不含可核验金额，拒绝写入支付域')
  }
  if (response.code !== '000000') {
    throw new Error(`星驿退款查询返回不可安全映射状态码: ${response.code} ${response.msg}`)
  }
  const data = requireDataObject(response)
  assertAgency(data, agencyId)
  assertMerchant(data, request.merchantId)
  const refundAmount = Math.abs(parseMoney(data.refundAmt, '星驿退款金额', { allowNegative: true }))
  const status = refundStatus(requiredString(data, 'orderStatus'))
  const transactionId = requiredString(data, 'orderFlowNo')
  return {
    amount: refundAmount,
    currency: 'CNY',
    failureReason: status === 'failed' ? optionalString(data, 'remark') || response.msg : undefined,
    occurredAt: parsePostarDateTime(requiredString(data, 'orderTime'), '星驿退款订单时间'),
    providerRefundId: request.providerRefundId,
    providerRefundTransactionId: status === 'succeeded' ? transactionId : null,
    refundId: request.refundId,
    status,
  } satisfies ProviderRefundObservation
}

function parseBillObject(line: string, label: string) {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new Error(`${label}不是有效JSON`)
  }
  assertObject(value, label)
  return value
}

function parseCount(value: unknown, label: string) {
  const count = parseMoney(value, label)
  if (count < 0) throw new Error(`${label}不能为负数`)
  return count
}

function parseEnglishBill(
  bytes: Uint8Array,
  agencyId: string,
  merchantId: string,
  businessDate: string,
) {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('星驿英文对账文件不是有效UTF-8')
  }
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0) throw new Error('星驿英文对账文件为空')
  const summary = parseBillObject(lines[0]!, '星驿对账汇总行')
  const rows = lines.slice(1).map((line, index) => parseBillObject(line, `星驿对账明细第${index + 1}行`))
  const paymentRows = rows.filter((row) => requiredString(row, 'JY_TYPE') === '1')
  const refundRows = rows.filter((row) => requiredString(row, 'JY_TYPE') === '2')
  if (paymentRows.length + refundRows.length !== rows.length) throw new Error('星驿对账文件包含未知交易类型')
  if (parseCount(summary.SUM_COUNT, '星驿正向交易汇总笔数') !== paymentRows.length) {
    throw new Error('星驿正向交易汇总笔数与明细不一致')
  }
  if (parseCount(summary.RE_SUM_COUNT, '星驿退款汇总笔数') !== refundRows.length) {
    throw new Error('星驿退款汇总笔数与明细不一致')
  }
  const compactDate = businessDate.replaceAll('-', '')
  return rows
    .filter((row) => requiredString(row, 'CUST_ID') === merchantId)
    .map((row): ProviderBillEntry => {
      if (requiredString(row, 'AGET_ID') !== agencyId) throw new Error('星驿对账机构号不匹配')
      if (requiredString(row, 'JY_DATE') !== compactDate) throw new Error('星驿对账交易日期不匹配')
      const type = requiredString(row, 'JY_TYPE') === '1' ? 'payment' : 'refund'
      const rawAmount = parseMoney(row.JY_OLD_TXAMT, '星驿对账原交易金额', { allowNegative: true })
      if ((type === 'payment' && rawAmount <= 0) || (type === 'refund' && rawAmount >= 0)) {
        throw new Error('星驿对账金额符号与交易类型冲突')
      }
      const providerTransactionId = requiredString(row, 'JY_ORDER_NO')
      return {
        amount: Math.abs(rawAmount),
        currency: 'CNY',
        occurredAt: parsePostarDateTime(requiredString(row, 'JY_TIME'), '星驿对账交易时间'),
        providerEntryId: providerTransactionId,
        providerTransactionId,
        status: 'succeeded',
        type,
      }
    })
}

export class PostarPaymentProviderAdapter implements PaymentProviderAdapter {
  readonly provider = 'postar'
  readonly baseUrl: string

  private readonly agencyIdSecretName: string
  private readonly publicKeySecretName: string
  private readonly now: () => Date

  constructor(private readonly options: PostarAdapterOptions) {
    this.baseUrl = POSTAR_BASE_URLS[options.environment]
    if (!Object.values(POSTAR_BASE_URLS).includes(this.baseUrl)) {
      throw new Error('星驿环境域名不在白名单中')
    }
    this.agencyIdSecretName = options.agencyIdSecretName ?? DEFAULT_AGENCY_ID_SECRET
    this.publicKeySecretName = options.publicKeySecretName ?? DEFAULT_PUBLIC_KEY_SECRET
    this.now = options.now ?? (() => new Date())
  }

  async createPayment(
    request: ProviderCreatePaymentRequest,
    context: PaymentProviderContext,
  ): Promise<ProviderCreatePaymentResult> {
    if (!ALPHANUMERIC_ORDER_ID.test(request.paymentIntentId)) {
      throw new Error('星驿支付单号必须为1至40位大小写字母或数字')
    }
    if (request.currency !== 'CNY') throw new Error('星驿基础支付仅支持CNY')
    if (!Number.isSafeInteger(request.amount) || request.amount <= 0) throw new Error('星驿支付金额必须为正整数分')
    if (!request.merchantId.trim()) throw new Error('星驿支付商户号不能为空')
    if (request.presentation === 'jsapi' && !request.payerId?.trim()) throw new Error('星驿JSAPI支付付款人标识不能为空')
    if (request.presentation === 'jsapi' && !request.payWay) throw new Error('星驿JSAPI支付方式不能为空')
    if (request.presentation === 'jsapi' && !request.clientIp.trim()) throw new Error('星驿JSAPI支付消费者IP不能为空')
    if (request.presentation === 'barcode' && !request.clientIp.trim()) throw new Error('星驿付款码支付交易IP不能为空')
    if (request.presentation === 'barcode' && !request.customerAuthCode?.trim()) throw new Error('星驿付款码不能为空')
    if (request.presentation === 'barcode' && !/^(?:1[0-5]\d{16}|(?:2[5-9]|30)\d{14,22}|62\d{17})$/.test(request.customerAuthCode ?? '')) {
      throw new Error('星驿付款码格式无效')
    }
    if (!request.operatorId.trim()) throw new Error('星驿支付操作员不能为空')
    const callbackUrl = new URL(request.callbackUrl)
    if (callbackUrl.protocol !== 'https:') throw new Error('星驿异步通知地址必须使用HTTPS')
    if (request.presentation === 'jsapi' && request.payWay === 'wechat' && !request.wxAppid?.trim()) throw new Error('星驿微信支付必须提供wxAppid')
    const expiresInMinutes = Math.ceil((Date.parse(request.expiresAt) - this.now().getTime()) / 60_000)
    if (!Number.isInteger(expiresInMinutes) || expiresInMinutes < 1 || expiresInMinutes > 15) {
      throw new Error('星驿支付有效期必须为1至15分钟')
    }

    const { agencyId, publicKey } = await getCredentials(
      context,
      this.agencyIdSecretName,
      this.publicKeySecretName,
    )
    const commonPayload = {
      agetId: agencyId,
      asyncNotify: callbackUrl.toString(),
      custId: request.merchantId,
      orderNo: request.paymentIntentId,
      outTime: String(expiresInMinutes),
      remark: request.remark,
      timeStamp: formatPostarTimestamp(this.now()),
      txamt: String(request.amount),
      version: VERSION,
    }
    if (request.presentation === 'qr') {
      const response = parseSignedResponse(await this.options.httpClient.post({
        body: signedRequestBody({
          ...commonPayload,
          payType: '00',
          title: request.remark.slice(0, 30),
        }, publicKey),
        headers: { 'content-type': 'application/json; charset=utf-8' },
        url: `${this.baseUrl}${POSTAR_ENDPOINTS.createQrPayment}`,
      }), publicKey)
      if (response.code !== '000000') throw new Error(`星驿聚合支付码下单失败: ${response.code} ${response.msg}`)
      const qrCodeUrl = requireDataString(response)
      if (new URL(qrCodeUrl).protocol !== 'https:') throw new Error('星驿聚合支付码链接必须使用HTTPS')
      return {
        paymentIntentId: request.paymentIntentId,
        providerTransactionId: null,
        status: 'processing',
        amount: request.amount,
        currency: request.currency,
        merchantId: request.merchantId,
        occurredAt: this.now().toISOString(),
        paymentPayload: { presentation: 'qr', qrCodeUrl, expiresAt: request.expiresAt },
      }
    }

    if (request.presentation === 'barcode') {
      const response = parseSignedResponse(await this.options.httpClient.post({
        body: signedRequestBody({
          ...commonPayload,
          code: request.customerAuthCode,
          operator: request.operatorId,
          title: request.remark.slice(0, 30),
          tradingIp: request.clientIp,
          type: 'A',
        }, publicKey),
        headers: { 'content-type': 'application/json; charset=utf-8' },
        url: `${this.baseUrl}${POSTAR_ENDPOINTS.createBarcodePayment}`,
      }), publicKey)
      if (!['000000', '222222'].includes(response.code)) {
        throw new Error(`星驿付款码支付失败: ${response.code} ${response.msg}`)
      }
      const data = requireDataObject(response)
      assertAgency(data, agencyId)
      const returnedIntentId = requiredString(data, 'threeOrderNo')
      if (returnedIntentId !== request.paymentIntentId) throw new Error('星驿付款码响应三方单号不匹配')
      const returnedAmount = optionalString(data, 'txamt')
      if (returnedAmount !== undefined && parsePositiveMoney(returnedAmount, '星驿付款码响应金额') !== request.amount) {
        throw new Error('星驿付款码响应金额不匹配')
      }
      const orderTime = optionalString(data, 'orderTime')
      return {
        paymentIntentId: request.paymentIntentId,
        providerTransactionId: requiredString(data, 'orderNo'),
        status: 'processing',
        amount: request.amount,
        currency: request.currency,
        merchantId: request.merchantId,
        occurredAt: orderTime ? parsePostarDateTime(orderTime, '星驿付款码订单时间') : this.now().toISOString(),
        paymentPayload: {
          presentation: 'barcode',
          providerState: response.code === '000000' ? 'accepted' : 'processing',
        },
      }
    }

    const response = parseSignedResponse(await this.options.httpClient.post({
      body: signedRequestBody({
        ...commonPayload,
        ip: request.clientIp,
        openid: request.payerId,
        operator: request.operatorId,
        payWay: request.payWay === 'wechat' ? '1' : '2',
        sceneType: '02',
        wxAppid: request.payWay === 'wechat' ? request.wxAppid : undefined,
      }, publicKey),
      headers: { 'content-type': 'application/json; charset=utf-8' },
      url: `${this.baseUrl}${POSTAR_ENDPOINTS.createJsapiPayment}`,
    }), publicKey)
    if (response.code !== '000000') throw new Error(`星驿下单失败: ${response.code} ${response.msg}`)
    const data = requireDataObject(response)
    assertAgency(data, agencyId)
    const returnedIntentId = requiredString(data, 'threeOrderNo')
    if (returnedIntentId !== request.paymentIntentId) throw new Error('星驿下单响应三方单号不匹配')
    const actualPayAmount = optionalString(data, 'actualPayAmt')
    if (actualPayAmount !== undefined && parsePositiveMoney(actualPayAmount, '星驿下单响应金额') !== request.amount) {
      throw new Error('星驿下单响应金额不匹配')
    }

    let paymentPayload: Readonly<Record<string, unknown>>
    if (request.payWay === 'wechat') {
      if (requiredString(data, 'getPrepayId') !== '1') throw new Error('星驿微信预下单未返回可支付状态')
      paymentPayload = {
        presentation: 'jsapi',
        appId: requiredString(data, 'jsapiAppid'),
        timeStamp: requiredString(data, 'jsapiTimestamp'),
        nonceStr: requiredString(data, 'jsapiNoncestr'),
        package: requiredString(data, 'jsapiPackage'),
        signType: requiredString(data, 'jsapiSignType'),
        paySign: requiredString(data, 'jsapiPaySign'),
      }
    } else {
      if (requiredString(data, 'getprepayid') !== '1') throw new Error('星驿支付宝预下单未返回可支付状态')
      paymentPayload = { presentation: 'jsapi', tradeNO: requiredString(data, 'prepayid') }
    }

    return {
      paymentIntentId: request.paymentIntentId,
      providerTransactionId: requiredString(data, 'orderNo'),
      status: 'processing',
      amount: request.amount,
      currency: request.currency,
      merchantId: request.merchantId,
      occurredAt: parsePostarDateTime(requiredString(data, 'orderTime'), '星驿订单创建时间'),
      paymentPayload,
    }
  }

  async verifyPaymentCallback(
    request: RawPaymentProviderCallback,
    context: PaymentProviderContext,
  ): Promise<VerifiedProviderPaymentCallback> {
    const payload = parseJsonBytes(request.rawBody, '星驿回调')
    const { agencyId, publicKey } = await getCredentials(
      context,
      this.agencyIdSecretName,
      this.publicKeySecretName,
    )
    verifyEncryptedDigest(payload as PostarTopLevelPayload, publicKey)
    if (requiredString(payload, 'AGET_ID') !== agencyId) throw new Error('星驿回调机构号不匹配')
    const digest = hashPostarPayload(payload as PostarTopLevelPayload)
    return {
      amount: parsePositiveMoney(payload.TXAMT, '星驿回调支付金额'),
      currency: 'CNY',
      merchantId: requiredString(payload, 'CUST_ID'),
      settlementChannel: settlementChannel(payload.PAY_CHANNEL),
      occurredAt: parsePostarDateTime(requiredString(payload, 'ORDER_TIME'), '星驿回调订单时间'),
      paymentIntentId: requiredString(payload, 'THREE_ORDER_NO'),
      providerEventId: `postar:${digest}`,
      providerTransactionId: requiredString(payload, 'ORDER_NO'),
      status: callbackPaymentStatus(payload),
    }
  }

  async queryPayment(
    request: ProviderPaymentQueryRequest,
    context: PaymentProviderContext,
  ): Promise<ProviderPaymentObservation> {
    const metadata = await this.options.metadataSource.getPaymentMetadata(request)
    assertDate(metadata.orderDate, '星驿原支付日期')
    const { agencyId, publicKey } = await getCredentials(
      context,
      this.agencyIdSecretName,
      this.publicKeySecretName,
    )
    const response = await this.options.httpClient.post({
      body: signedRequestBody({
        agetId: agencyId,
        custId: request.merchantId,
        orderNo: request.paymentIntentId,
        orderTime: metadata.orderDate,
        timeStamp: formatPostarTimestamp(this.now()),
        version: VERSION,
      }, publicKey),
      headers: { 'content-type': 'application/json; charset=utf-8' },
      url: `${this.baseUrl}${POSTAR_ENDPOINTS.queryPayment}`,
    })
    return parsePaymentObservation(parseSignedResponse(response, publicKey), request, agencyId)
  }

  async requestRefund(
    request: ProviderRefundRequest,
    context: PaymentProviderContext,
  ): Promise<ProviderRefundObservation> {
    if (!ALPHANUMERIC_ORDER_ID.test(request.refundId)) {
      throw new Error('星驿退款单号必须为1至40位大小写字母或数字')
    }
    if (request.currency !== 'CNY') throw new Error('星驿普通退款仅支持CNY')
    if (!Number.isSafeInteger(request.amount) || request.amount <= 0) throw new Error('星驿退款金额必须为正整数分')
    const metadata = await this.options.metadataSource.getRefundMetadata(request)
    const refundTag = refundTagForChannel(request.settlementChannel) ?? metadata.tag
    assertRefundMetadata(metadata.merchantId, refundTag)
    const { agencyId, publicKey } = await getCredentials(
      context,
      this.agencyIdSecretName,
      this.publicKeySecretName,
    )
    const response = parseSignedResponse(await this.options.httpClient.post({
      body: signedRequestBody({
        agetId: agencyId,
        custId: metadata.merchantId,
        orderNo: request.refundId,
        reOrderNo: request.providerTransactionId,
        refundAmount: String(request.amount),
        tag: refundTag,
        timeStamp: formatPostarTimestamp(this.now()),
        version: VERSION,
      }, publicKey),
      headers: { 'content-type': 'application/json; charset=utf-8' },
      url: `${this.baseUrl}${POSTAR_ENDPOINTS.refund}`,
    }), publicKey)
    const occurredAt = this.now().toISOString()
    if (response.code !== '000000') return refundFailure(request, response, occurredAt)
    const data = requireDataObject(response)
    assertAgency(data, agencyId)
    assertMerchant(data, metadata.merchantId)
    const returnedRefundId = requiredString(data, 'threeOrderNo')
    if (returnedRefundId !== request.refundId) throw new Error('星驿退款响应三方单号不匹配')
    const amount = Math.abs(parseMoney(data.realRefundAmt, '星驿退款受理金额', { allowNegative: true }))
    if (amount !== request.amount) throw new Error('星驿退款受理金额不匹配')
    return {
      amount: request.amount,
      currency: request.currency,
      occurredAt: parsePostarDateTime(requiredString(data, 'orderTime'), '星驿退款创建时间'),
      providerRefundId: request.refundId,
      providerRefundTransactionId: null,
      refundId: request.refundId,
      status: 'processing',
    }
  }

  async queryRefund(
    request: ProviderRefundQueryRequest,
    context: PaymentProviderContext,
  ): Promise<ProviderRefundObservation> {
    const metadata = await this.options.metadataSource.getRefundQueryMetadata(request)
    assertDate(metadata.refundDate, '星驿退款日期')
    const { agencyId, publicKey } = await getCredentials(
      context,
      this.agencyIdSecretName,
      this.publicKeySecretName,
    )
    const response = parseSignedResponse(await this.options.httpClient.post({
      body: signedRequestBody({
        agetId: agencyId,
        custId: request.merchantId,
        orderNo: request.providerRefundId,
        originTradeDate: metadata.refundDate,
        timeStamp: formatPostarTimestamp(this.now()),
        version: VERSION,
      }, publicKey),
      headers: { 'content-type': 'application/json; charset=utf-8' },
      url: `${this.baseUrl}${POSTAR_ENDPOINTS.queryRefund}`,
    }), publicKey)
    return parseRefundQueryObservation(response, request, agencyId)
  }

  async downloadBill(
    request: DownloadProviderBillRequest,
    context: PaymentProviderContext,
  ): Promise<readonly ProviderBillEntry[]> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(request.businessDate)) {
      throw new Error('星驿账单营业日必须为YYYY-MM-DD')
    }
    const { agencyId } = await getCredentials(
      context,
      this.agencyIdSecretName,
      this.publicKeySecretName,
    )
    const bytes = await this.options.billSource.downloadBill({
      agencyId,
      businessDate: request.businessDate,
      format: 'english-json-lines',
      merchantId: request.merchantId,
    })
    return parseEnglishBill(bytes, agencyId, request.merchantId, request.businessDate)
  }
}
