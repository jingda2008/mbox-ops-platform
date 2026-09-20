import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import {
  GROUP_VOUCHER_PLATFORM_CODES,
  GROUP_VOUCHER_PLATFORM_LABELS,
  groupVoucherPlatformLabel,
  parseGroupVoucherPlatform,
  type GroupVoucherPlatformCode,
  type GroupVoucherPlatformStatus,
} from '../../src/shared/group-voucher-contracts.js'

export interface GroupVoucherHttpResponse {
  status: number
  body: unknown
}

export interface GroupVoucherHttpClient {
  request(
    url: string,
    options: Readonly<{ method: 'GET' | 'POST'; headers?: Readonly<Record<string, string>>; body?: string; signal: AbortSignal }>,
  ): Promise<GroupVoucherHttpResponse>
}

export interface PreparedGroupVoucher {
  platform: GroupVoucherPlatformCode
  campaignName: string
  faceValueMinor: number
  settlementAmountMinor: number
  currency: string
  quantity: number
  statusLabel: string
  prepareToken: string
  certificateId: string
  expiresAt: string
}

export interface ConsumedGroupVoucher {
  platform: GroupVoucherPlatformCode
  campaignName: string
  faceValueMinor: number
  settlementAmountMinor: number
  currency: string
  certificateId: string
  verifyId: string
}

export interface GroupVoucherPlatformAdapter {
  readonly platform: GroupVoucherPlatformCode
  prepare(input: Readonly<{ voucherCode: string }>): Promise<PreparedGroupVoucher>
  consume(input: Readonly<{ voucherCode: string; prepareToken: string; requestId: string }>): Promise<ConsumedGroupVoucher>
}

export type GroupVoucherFailureCode =
  | 'unavailable'
  | 'not_found'
  | 'already_used'
  | 'expired'
  | 'rejected'
  | 'invalid'

export class GroupVoucherPlatformError extends Error {
  readonly code: GroupVoucherFailureCode
  readonly retryable: boolean
  constructor(message: string, code: GroupVoucherFailureCode, retryable = false) {
    super(message)
    this.name = 'GroupVoucherPlatformError'
    this.code = code
    this.retryable = retryable
  }
}

export interface MeituanVoucherCredentials {
  appKey: string
  appSecret: string
  shopId: string
  accessToken: string
  apiBase: string
}

export interface DianpingVoucherCredentials {
  appKey: string
  appSecret: string
  session: string
  shopId: string
  apiBase: string
}

export interface DouyinVoucherCredentials {
  clientKey: string
  clientSecret: string
  poiId: string
  accountId: string
  apiBase: string
}

export interface KuaishouVoucherCredentials {
  appId: string
  appSecret: string
  merchantId: string
  poiId: string
  apiBase: string
}

export interface GroupVoucherRuntimeConfig {
  mode: 'disabled' | 'test' | 'uat' | 'production'
  timeoutMs: number
  platforms: Readonly<{
    dianping: DianpingVoucherCredentials | null
    meituan: MeituanVoucherCredentials | null
    douyin: DouyinVoucherCredentials | null
    kuaishou: KuaishouVoucherCredentials | null
  }>
}

export interface GroupVoucherPlatformRegistry {
  status(): GroupVoucherPlatformStatus[]
  adapter(platform: GroupVoucherPlatformCode): GroupVoucherPlatformAdapter
}

const PREPARE_TTL_MS = 10 * 60 * 1000

export function createGroupVoucherPlatformRegistry(
  config: Readonly<GroupVoucherRuntimeConfig> | null | undefined,
  options: Readonly<{ httpClient?: GroupVoucherHttpClient; now?: () => number }> = {},
): GroupVoucherPlatformRegistry {
  const mode = config?.mode ?? 'disabled'
  const timeoutMs = config?.timeoutMs ?? 8_000
  const http = options.httpClient ?? new FetchGroupVoucherHttpClient()
  const now = options.now ?? Date.now
  const adapters = new Map<GroupVoucherPlatformCode, GroupVoucherPlatformAdapter>()
  if (mode === 'test') {
    for (const platform of GROUP_VOUCHER_PLATFORM_CODES) {
      adapters.set(platform, new SimulationGroupVoucherAdapter(platform, now))
    }
  } else if (mode === 'uat' || mode === 'production') {
    const platforms = config?.platforms
    if (platforms?.dianping) adapters.set('dianping', new DianpingGroupVoucherAdapter(platforms.dianping, http, timeoutMs))
    if (platforms?.meituan) adapters.set('meituan', new MeituanGroupVoucherAdapter(platforms.meituan, http, timeoutMs))
    if (platforms?.douyin) adapters.set('douyin', new DouyinGroupVoucherAdapter(platforms.douyin, http, timeoutMs, now))
    if (platforms?.kuaishou) adapters.set('kuaishou', new KuaishouGroupVoucherAdapter(platforms.kuaishou, http, timeoutMs, now))
  }
  return {
    status() {
      return GROUP_VOUCHER_PLATFORM_CODES.map((code) => ({
        code, label: GROUP_VOUCHER_PLATFORM_LABELS[code], enabled: adapters.has(code), mode,
      }))
    },
    adapter(platform) {
      const adapter = adapters.get(platform)
      if (!adapter) {
        throw new GroupVoucherPlatformError(
          `${groupVoucherPlatformLabel(platform)}核销未配置或当前模式不可用`,
          'unavailable',
        )
      }
      return adapter
    },
  }
}

export class SimulationGroupVoucherAdapter implements GroupVoucherPlatformAdapter {
  constructor(
    readonly platform: GroupVoucherPlatformCode,
    private readonly now: () => number = Date.now,
  ) {}

  async prepare(input: Readonly<{ voucherCode: string }>): Promise<PreparedGroupVoucher> {
    const code = normalizeCode(input.voucherCode)
    const failure = simulationFailure(code)
    if (failure) throw failure
    return simulationCertificate(this.platform, code, this.now())
  }

  async consume(input: Readonly<{ voucherCode: string; prepareToken: string; requestId: string }>): Promise<ConsumedGroupVoucher> {
    const prepared = await this.prepare({ voucherCode: input.voucherCode })
    if (input.prepareToken !== prepared.prepareToken) {
      throw new GroupVoucherPlatformError('核销准备已失效，请重新查询券码', 'expired')
    }
    return {
      platform: this.platform,
      campaignName: prepared.campaignName,
      faceValueMinor: prepared.faceValueMinor,
      settlementAmountMinor: prepared.settlementAmountMinor,
      currency: prepared.currency,
      certificateId: prepared.certificateId,
      verifyId: `sim-${input.requestId.slice(0, 12)}`,
    }
  }
}

export class MeituanGroupVoucherAdapter implements GroupVoucherPlatformAdapter {
  readonly platform = 'meituan' as const
  constructor(
    private readonly credentials: Readonly<MeituanVoucherCredentials>,
    private readonly http: GroupVoucherHttpClient,
    private readonly timeoutMs: number,
  ) {}

  async prepare(input: Readonly<{ voucherCode: string }>): Promise<PreparedGroupVoucher> {
    const payload = await this.call('/tuangou/ng/receipt/prepare', { receiptCode: normalizeCode(input.voucherCode) })
    return mapMeituanPrepare(payload, normalizeCode(input.voucherCode))
  }

  async consume(input: Readonly<{ voucherCode: string; prepareToken: string; requestId: string }>): Promise<ConsumedGroupVoucher> {
    const payload = await this.call('/tuangou/ng/receipt/consume', {
      receiptCode: normalizeCode(input.voucherCode),
      requestId: input.requestId,
      appShopAccount: this.credentials.shopId,
      appShopAccountName: 'M-BOX',
      verifyToken: input.prepareToken,
    })
    return mapMeituanConsume(payload, normalizeCode(input.voucherCode))
  }

  private async call(path: string, business: Readonly<Record<string, string>>): Promise<Record<string, unknown>> {
    const timestamp = String(Math.floor(Date.now() / 1000))
    const params = {
      app_id: this.credentials.appKey,
      appAuthToken: this.credentials.accessToken,
      bid: this.credentials.shopId,
      timestamp,
      format: 'json',
      v: '1',
      sign_method: 'MD5',
      ...business,
    }
    const body = new URLSearchParams({ ...params, sign: md5Sign(params, this.credentials.appSecret) }).toString()
    return signedJson(await this.http.request(joinUrl(this.credentials.apiBase, path), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: timeoutSignal(this.timeoutMs),
    }), '美团')
  }
}

export class DianpingGroupVoucherAdapter implements GroupVoucherPlatformAdapter {
  readonly platform = 'dianping' as const
  constructor(
    private readonly credentials: Readonly<DianpingVoucherCredentials>,
    private readonly http: GroupVoucherHttpClient,
    private readonly timeoutMs: number,
  ) {}

  async prepare(input: Readonly<{ voucherCode: string }>): Promise<PreparedGroupVoucher> {
    const payload = await this.call('/router/tuangou/receipt/prepare', { receipt_code: normalizeCode(input.voucherCode) })
    return mapDianpingPrepare(payload, normalizeCode(input.voucherCode))
  }

  async consume(input: Readonly<{ voucherCode: string; prepareToken: string; requestId: string }>): Promise<ConsumedGroupVoucher> {
    const payload = await this.call('/router/tuangou/receipt/consume', {
      receipt_code: normalizeCode(input.voucherCode),
      requestid: input.requestId,
      verify_token: input.prepareToken,
      open_shop_uuid: this.credentials.shopId,
    })
    return mapDianpingConsume(payload, normalizeCode(input.voucherCode))
  }

  private async call(path: string, business: Readonly<Record<string, string>>): Promise<Record<string, unknown>> {
    const timestamp = String(Date.now())
    const params = {
      app_key: this.credentials.appKey,
      session: this.credentials.session,
      timestamp,
      format: 'json',
      v: '1',
      sign_method: 'MD5',
      ...business,
    }
    const body = new URLSearchParams({ ...params, sign: md5Sign(params, this.credentials.appSecret) }).toString()
    return signedJson(await this.http.request(joinUrl(this.credentials.apiBase, path), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: timeoutSignal(this.timeoutMs),
    }), '大众点评')
  }
}

export class DouyinGroupVoucherAdapter implements GroupVoucherPlatformAdapter {
  readonly platform = 'douyin' as const
  private token: { value: string; refreshAfter: number } | null = null
  constructor(
    private readonly credentials: Readonly<DouyinVoucherCredentials>,
    private readonly http: GroupVoucherHttpClient,
    private readonly timeoutMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async prepare(input: Readonly<{ voucherCode: string }>): Promise<PreparedGroupVoucher> {
    const token = await this.accessToken()
    const url = new URL(joinUrl(this.credentials.apiBase, '/goodlife/v1/fulfilment/certificate/prepare/'))
    url.searchParams.set('code', normalizeCode(input.voucherCode))
    const payload = await oauthJson(await this.http.request(url.toString(), {
      method: 'GET',
      headers: { 'access-token': token },
      signal: timeoutSignal(this.timeoutMs),
    }), '抖音')
    return mapDouyinPrepare(payload, this.credentials.poiId)
  }

  async consume(input: Readonly<{ voucherCode: string; prepareToken: string; requestId: string }>): Promise<ConsumedGroupVoucher> {
    const token = await this.accessToken()
    const payload = await oauthJson(await this.http.request(
      joinUrl(this.credentials.apiBase, '/goodlife/v1/fulfilment/certificate/verify/'),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'access-token': token },
        body: JSON.stringify({
          verify_token: input.prepareToken,
          poi_id: this.credentials.poiId,
          encrypted_codes: [],
        }),
        signal: timeoutSignal(this.timeoutMs),
      },
    ), '抖音')
    return mapDouyinConsume(payload, input.requestId)
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.now() < this.token.refreshAfter) return this.token.value
    const payload = await oauthJson(await this.http.request(
      joinUrl(this.credentials.apiBase, '/oauth/client_token/'),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_key: this.credentials.clientKey,
          client_secret: this.credentials.clientSecret,
          grant_type: 'client_credential',
        }),
        signal: timeoutSignal(this.timeoutMs),
      },
    ), '抖音')
    const data = asObject(payload.data) ?? payload
    const value = readString(data.access_token)
    if (!value) throw new GroupVoucherPlatformError('抖音核销授权失败，请核对应用密钥', 'unavailable', true)
    const expiresIn = Number(data.expires_in ?? 7200)
    this.token = { value, refreshAfter: this.now() + Math.max(30_000, (Number.isFinite(expiresIn) ? expiresIn : 7200) * 1000 - 60_000) }
    return value
  }
}

export class KuaishouGroupVoucherAdapter implements GroupVoucherPlatformAdapter {
  readonly platform = 'kuaishou' as const
  private token: { value: string; refreshAfter: number } | null = null
  constructor(
    private readonly credentials: Readonly<KuaishouVoucherCredentials>,
    private readonly http: GroupVoucherHttpClient,
    private readonly timeoutMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async prepare(input: Readonly<{ voucherCode: string }>): Promise<PreparedGroupVoucher> {
    const token = await this.accessToken()
    const payload = await oauthJson(await this.http.request(
      joinUrl(this.credentials.apiBase, '/goodlife/v1/fulfilment/certificate/prepare'),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          code: normalizeCode(input.voucherCode),
          merchant_id: this.credentials.merchantId,
          poi_id: this.credentials.poiId,
        }),
        signal: timeoutSignal(this.timeoutMs),
      },
    ), '快手')
    return mapKuaishouPrepare(payload)
  }

  async consume(input: Readonly<{ voucherCode: string; prepareToken: string; requestId: string }>): Promise<ConsumedGroupVoucher> {
    const token = await this.accessToken()
    const payload = await oauthJson(await this.http.request(
      joinUrl(this.credentials.apiBase, '/goodlife/v1/fulfilment/certificate/verify'),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          verify_token: input.prepareToken,
          merchant_id: this.credentials.merchantId,
          poi_id: this.credentials.poiId,
          request_id: input.requestId,
        }),
        signal: timeoutSignal(this.timeoutMs),
      },
    ), '快手')
    return mapKuaishouConsume(payload, input.requestId)
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.now() < this.token.refreshAfter) return this.token.value
    const payload = await oauthJson(await this.http.request(
      joinUrl(this.credentials.apiBase, '/oauth2/access_token'),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          app_id: this.credentials.appId,
          app_secret: this.credentials.appSecret,
          grant_type: 'client_credentials',
        }),
        signal: timeoutSignal(this.timeoutMs),
      },
    ), '快手')
    const data = asObject(payload.data) ?? payload
    const value = readString(data.access_token)
    if (!value) throw new GroupVoucherPlatformError('快手核销授权失败，请核对应用密钥', 'unavailable', true)
    const expiresIn = Number(data.expires_in ?? 7200)
    this.token = { value, refreshAfter: this.now() + Math.max(30_000, (Number.isFinite(expiresIn) ? expiresIn : 7200) * 1000 - 60_000) }
    return value
  }
}

export interface GroupVoucherPrepareHandlePayload {
  platform: GroupVoucherPlatformCode
  codeHash: string
  prepareToken: string
  campaignName: string
  faceValueMinor: number
  settlementAmountMinor: number
  currency: string
  certificateId: string
  expiresAtMs: number
}

export function signGroupVoucherPrepareHandle(
  payload: Readonly<GroupVoucherPrepareHandlePayload>,
  secret: string,
): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
}

export function readGroupVoucherPrepareHandle(
  handle: string,
  secret: string,
  nowMs = Date.now(),
): GroupVoucherPrepareHandlePayload {
  const [body, signature] = handle.split('.')
  if (!body || !signature) throw new GroupVoucherPlatformError('核销准备凭证无效，请重新查询', 'invalid')
  const expected = createHmac('sha256', secret).update(body).digest()
  const actual = Buffer.from(signature, 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new GroupVoucherPlatformError('核销准备凭证无效，请重新查询', 'invalid')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    throw new GroupVoucherPlatformError('核销准备凭证无效，请重新查询', 'invalid')
  }
  const object = asObject(parsed)
  const platform = object ? parseGroupVoucherPlatform(String(object.platform ?? '')) : null
  if (!object || platform === null) throw new GroupVoucherPlatformError('核销准备凭证无效，请重新查询', 'invalid')
  const expiresAtMs = Number(object.expiresAtMs)
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
    throw new GroupVoucherPlatformError('核销准备已过期，请重新查询券码', 'expired')
  }
  return {
    platform,
    codeHash: readString(object.codeHash) ?? '',
    prepareToken: readString(object.prepareToken) ?? '',
    campaignName: readString(object.campaignName) ?? groupVoucherPlatformLabel(platform),
    faceValueMinor: Math.max(0, Number(object.faceValueMinor) || 0),
    settlementAmountMinor: Math.max(0, Number(object.settlementAmountMinor) || 0),
    currency: readString(object.currency) === 'CNY' ? 'CNY' : 'CNY',
    certificateId: readString(object.certificateId) ?? '',
    expiresAtMs,
  }
}

export function prepareHandleExpiryIso(nowMs = Date.now()): string {
  return new Date(nowMs + PREPARE_TTL_MS).toISOString()
}

export function prepareHandleExpiryMs(nowMs = Date.now()): number {
  return nowMs + PREPARE_TTL_MS
}

class FetchGroupVoucherHttpClient implements GroupVoucherHttpClient {
  async request(
    url: string,
    options: Readonly<{ method: 'GET' | 'POST'; headers?: Readonly<Record<string, string>>; body?: string; signal: AbortSignal }>,
  ): Promise<GroupVoucherHttpResponse> {
    const response = await fetch(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal: options.signal,
    })
    const text = await response.text()
    let body: unknown = text
    try { body = text ? JSON.parse(text) : null } catch { /* Keep the raw body for diagnostic mapping. */ }
    return { status: response.status, body }
  }
}

function simulationCertificate(
  platform: GroupVoucherPlatformCode,
  code: string,
  nowMs: number,
): PreparedGroupVoucher {
  return {
    platform,
    campaignName: `${GROUP_VOUCHER_PLATFORM_LABELS[platform]}门店团购券`,
    faceValueMinor: 10_000,
    settlementAmountMinor: 8_800,
    currency: 'CNY',
    quantity: 1,
    statusLabel: '待核销',
    prepareToken: `sim:${platform}:${createHash('sha256').update(code).digest('hex').slice(0, 24)}`,
    certificateId: `sim-cert-${code.slice(-6)}`,
    expiresAt: new Date(nowMs + PREPARE_TTL_MS).toISOString(),
  }
}

function simulationFailure(code: string): GroupVoucherPlatformError | null {
  if (code.startsWith('USED') || code.includes('USED')) {
    return new GroupVoucherPlatformError('这张券已被核销，不能再次使用', 'already_used')
  }
  if (code.startsWith('EXPIRED')) return new GroupVoucherPlatformError('这张券已过期', 'expired')
  if (code.startsWith('REJECT') || code.startsWith('FAIL')) {
    return new GroupVoucherPlatformError('平台拒绝核销，请改用有效券码', 'rejected')
  }
  if (code.startsWith('MISS') || code.startsWith('UNKNOWN')) {
    return new GroupVoucherPlatformError('未查询到这张券，请核对平台和券码', 'not_found')
  }
  return null
}

function mapMeituanPrepare(payload: Record<string, unknown>, code: string): PreparedGroupVoucher {
  const deal = asObject(payload.deal) ?? asObject(payload.result) ?? payload
  return {
    platform: 'meituan',
    campaignName: readString(deal.dealTitle) ?? readString(deal.title) ?? '美团团购券',
    faceValueMinor: yuanToMinor(deal.dealPrice ?? deal.faceValue ?? deal.price),
    settlementAmountMinor: yuanToMinor(deal.dealPromoPrice ?? deal.merchantAmount ?? deal.settlementAmount ?? deal.dealPrice),
    currency: 'CNY',
    quantity: Math.max(1, Number(deal.count ?? deal.quantity ?? 1) || 1),
    statusLabel: '待核销',
    prepareToken: readString(deal.verifyToken) ?? readString(payload.verifyToken) ?? `mt:${code}`,
    certificateId: readString(deal.receiptCode) ?? readString(deal.dealId) ?? code,
    expiresAt: prepareHandleExpiryIso(),
  }
}

function mapMeituanConsume(payload: Record<string, unknown>, code: string): ConsumedGroupVoucher {
  const deal = asObject(payload.result) ?? payload
  return {
    platform: 'meituan',
    campaignName: readString(deal.dealTitle) ?? '美团团购券',
    faceValueMinor: yuanToMinor(deal.dealPrice ?? deal.faceValue),
    settlementAmountMinor: yuanToMinor(deal.merchantAmount ?? deal.dealPromoPrice ?? deal.dealPrice),
    currency: 'CNY',
    certificateId: readString(deal.receiptCode) ?? code,
    verifyId: readString(deal.verifyId) ?? readString(payload.orderId) ?? code,
  }
}

function mapDianpingPrepare(payload: Record<string, unknown>, code: string): PreparedGroupVoucher {
  const deal = asObject(payload.deal_info) ?? asObject(payload.data) ?? payload
  return {
    platform: 'dianping',
    campaignName: readString(deal.deal_title) ?? readString(deal.title) ?? '大众点评团购券',
    faceValueMinor: yuanToMinor(deal.deal_price ?? deal.face_value),
    settlementAmountMinor: yuanToMinor(deal.settlement_amount ?? deal.merchant_amount ?? deal.deal_price),
    currency: 'CNY',
    quantity: Math.max(1, Number(deal.count ?? 1) || 1),
    statusLabel: '待核销',
    prepareToken: readString(deal.verify_token) ?? readString(payload.verify_token) ?? `dp:${code}`,
    certificateId: readString(deal.receipt_id) ?? readString(deal.deal_id) ?? code,
    expiresAt: prepareHandleExpiryIso(),
  }
}

function mapDianpingConsume(payload: Record<string, unknown>, code: string): ConsumedGroupVoucher {
  const deal = asObject(payload.data) ?? payload
  return {
    platform: 'dianping',
    campaignName: readString(deal.deal_title) ?? '大众点评团购券',
    faceValueMinor: yuanToMinor(deal.deal_price ?? deal.face_value),
    settlementAmountMinor: yuanToMinor(deal.settlement_amount ?? deal.deal_price),
    currency: 'CNY',
    certificateId: readString(deal.receipt_id) ?? code,
    verifyId: readString(deal.verify_id) ?? readString(payload.order_id) ?? code,
  }
}

function mapDouyinPrepare(payload: Record<string, unknown>, poiId: string): PreparedGroupVoucher {
  const data = asObject(payload.data) ?? payload
  const certificates = Array.isArray(data.certificates) ? data.certificates : []
  const first = asObject(certificates[0]) ?? data
  const sku = asObject(first.sku) ?? asObject(first.sku_info) ?? first
  return {
    platform: 'douyin',
    campaignName: readString(sku.title) ?? readString(sku.sku_name) ?? '抖音团购券',
    faceValueMinor: fenToMinor(sku.market_price ?? sku.origin_amount ?? first.market_price),
    settlementAmountMinor: fenToMinor(sku.settle_amount ?? sku.original_amount ?? sku.market_price),
    currency: 'CNY',
    quantity: Math.max(1, certificates.length || Number(data.available_times ?? 1) || 1),
    statusLabel: '待核销',
    prepareToken: readString(data.verify_token) ?? readString(first.verify_token) ?? `dy:${poiId}`,
    certificateId: readString(first.encrypted_code) ?? readString(first.certificate_id) ?? poiId,
    expiresAt: prepareHandleExpiryIso(),
  }
}

function mapDouyinConsume(payload: Record<string, unknown>, requestId: string): ConsumedGroupVoucher {
  const data = asObject(payload.data) ?? payload
  const verify = asObject((Array.isArray(data.verify_results) ? data.verify_results[0] : data.verify_results) as unknown)
    ?? data
  return {
    platform: 'douyin',
    campaignName: readString(verify.title) ?? '抖音团购券',
    faceValueMinor: fenToMinor(verify.origin_amount ?? verify.market_price),
    settlementAmountMinor: fenToMinor(verify.settle_amount ?? verify.origin_amount),
    currency: 'CNY',
    certificateId: readString(verify.certificate_id) ?? readString(verify.encrypted_code) ?? requestId,
    verifyId: readString(verify.verify_id) ?? readString(data.verify_id) ?? requestId,
  }
}

function mapKuaishouPrepare(payload: Record<string, unknown>): PreparedGroupVoucher {
  const data = asObject(payload.data) ?? payload
  const certificate = asObject(data.certificate) ?? asObject((Array.isArray(data.certificates) ? data.certificates[0] : null)) ?? data
  return {
    platform: 'kuaishou',
    campaignName: readString(certificate.title) ?? readString(certificate.product_name) ?? '快手团购券',
    faceValueMinor: fenToMinor(certificate.market_price ?? certificate.origin_amount),
    settlementAmountMinor: fenToMinor(certificate.settle_amount ?? certificate.market_price),
    currency: 'CNY',
    quantity: Math.max(1, Number(certificate.quantity ?? 1) || 1),
    statusLabel: '待核销',
    prepareToken: readString(data.verify_token) ?? readString(certificate.verify_token) ?? 'ks-prepare',
    certificateId: readString(certificate.certificate_id) ?? readString(certificate.code) ?? 'ks-cert',
    expiresAt: prepareHandleExpiryIso(),
  }
}

function mapKuaishouConsume(payload: Record<string, unknown>, requestId: string): ConsumedGroupVoucher {
  const data = asObject(payload.data) ?? payload
  return {
    platform: 'kuaishou',
    campaignName: readString(data.title) ?? '快手团购券',
    faceValueMinor: fenToMinor(data.market_price ?? data.origin_amount),
    settlementAmountMinor: fenToMinor(data.settle_amount ?? data.market_price),
    currency: 'CNY',
    certificateId: readString(data.certificate_id) ?? requestId,
    verifyId: readString(data.verify_id) ?? requestId,
  }
}

function signedJson(response: GroupVoucherHttpResponse, label: string): Record<string, unknown> {
  const payload = asObject(response.body)
  if (response.status >= 500 || payload === null) {
    throw new GroupVoucherPlatformError(`${label}核销服务暂时不可用，请稍后重试`, 'unavailable', true)
  }
  const code = String(payload.code ?? payload.error_code ?? payload.error ?? '')
  const message = readString(payload.msg) ?? readString(payload.message) ?? readString(payload.error_msg)
  if (response.status >= 400 || isProviderFailure(code)) {
    throw mapProviderFailure(label, code, message)
  }
  return asObject(payload.data) ?? payload
}

function oauthJson(response: GroupVoucherHttpResponse, label: string): Record<string, unknown> {
  const payload = asObject(response.body)
  if (response.status >= 500 || payload === null) {
    throw new GroupVoucherPlatformError(`${label}核销服务暂时不可用，请稍后重试`, 'unavailable', true)
  }
  const extra = asObject(payload.extra)
  const code = String(payload.code ?? payload.error_code ?? extra?.error_code ?? '')
  const message = readString(payload.msg) ?? readString(payload.message) ?? readString(extra?.description)
  if (response.status >= 400 || isProviderFailure(code)) {
    throw mapProviderFailure(label, code, message)
  }
  return payload
}

function isProviderFailure(code: string): boolean {
  const normalized = code.trim().toLowerCase()
  return normalized !== '' && normalized !== '0' && normalized !== 'ok' && normalized !== 'success' && normalized !== '200'
}

function mapProviderFailure(label: string, code: string, message: string | null): GroupVoucherPlatformError {
  const haystack = `${code} ${message ?? ''}`.toLowerCase()
  if (/already|used|consumed|核销过|已核销|重复/.test(haystack)) {
    return new GroupVoucherPlatformError(`${label}返回：这张券已被核销`, 'already_used')
  }
  if (/expire|过期/.test(haystack)) return new GroupVoucherPlatformError(`${label}返回：这张券已过期`, 'expired')
  if (/not.?found|invalid.?code|不存在|未找到|无效/.test(haystack)) {
    return new GroupVoucherPlatformError(`${label}未查询到这张券，请核对券码`, 'not_found')
  }
  if (/token|auth|sign|permission|unauthorized/.test(haystack)) {
    return new GroupVoucherPlatformError(`${label}核销授权失败，请核对运行配置`, 'unavailable', true)
  }
  return new GroupVoucherPlatformError(message ? `${label}拒绝核销：${message.slice(0, 80)}` : `${label}拒绝核销这张券`, 'rejected')
}

function md5Sign(params: Readonly<Record<string, string>>, secret: string): string {
  const canonical = Object.keys(params).filter((key) => key !== 'sign' && params[key] !== '').toSorted()
    .map((key) => `${key}${params[key]}`).join('')
  return createHash('md5').update(`${secret}${canonical}${secret}`, 'utf8').digest('hex').toUpperCase()
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`
}

function timeoutSignal(timeoutMs: number): AbortSignal {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  if (typeof timer === 'object' && 'unref' in timer) timer.unref()
  return controller.signal
}

function yuanToMinor(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value * 100))
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Math.max(0, Math.round(Number(value) * 100))
  }
  return 0
}

function fenToMinor(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value))
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Math.max(0, Math.round(Number(value)))
  }
  return 0
}

function normalizeCode(value: string): string {
  return value.trim()
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

export { parseGroupVoucherPlatform, groupVoucherPlatformLabel }
