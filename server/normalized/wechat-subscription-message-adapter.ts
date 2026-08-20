import type {
  WechatSubscriptionDeliveryRequest,
  WechatSubscriptionDeliveryResult,
  WechatSubscriptionMessageDelivery,
} from './wechat-loyalty-notification-worker.js'

const DEFAULT_TOKEN_ENDPOINT = 'https://api.weixin.qq.com/cgi-bin/token'
const DEFAULT_SEND_ENDPOINT = 'https://api.weixin.qq.com/cgi-bin/message/subscribe/send'

export interface WechatSubscriptionHttpResponse {
  status: number
  body: unknown
}

export interface WechatSubscriptionHttpClient {
  request(
    url: string,
    options: Readonly<{ method: 'GET' | 'POST'; body?: string; signal: AbortSignal }>,
  ): Promise<WechatSubscriptionHttpResponse>
}

export interface OfficialWechatSubscriptionMessageAdapterOptions {
  appId: string
  appSecret: string
  tokenEndpoint?: string
  sendEndpoint?: string
  timeoutMs?: number
  now?: () => number
  httpClient?: WechatSubscriptionHttpClient
}

export interface WechatTemplateMessageRequest {
  jobId: string
  recipientOpenId: string
  templateId: string
  pagePath: string
  data: Readonly<Record<string, string>>
}

export interface WechatTemplateMessageDelivery {
  preflight?(): Promise<void>
  sendTemplate(request: Readonly<WechatTemplateMessageRequest>): Promise<WechatSubscriptionDeliveryResult>
}

interface CachedToken {
  value: string
  refreshAfter: number
}

export class OfficialWechatSubscriptionMessageAdapter implements
  WechatSubscriptionMessageDelivery,
  WechatTemplateMessageDelivery {
  private readonly tokenEndpoint: string
  private readonly sendEndpoint: string
  private readonly timeoutMs: number
  private readonly now: () => number
  private readonly http: WechatSubscriptionHttpClient
  private token: CachedToken | null = null

  constructor(private readonly options: Readonly<OfficialWechatSubscriptionMessageAdapterOptions>) {
    if (!/^wx[A-Za-z0-9_-]{4,126}$/.test(options.appId)) throw new TypeError('WeChat appId is invalid')
    if (options.appSecret.length < 16) throw new TypeError('WeChat appSecret is invalid')
    this.tokenEndpoint = secureEndpoint(options.tokenEndpoint ?? DEFAULT_TOKEN_ENDPOINT)
    this.sendEndpoint = secureEndpoint(options.sendEndpoint ?? DEFAULT_SEND_ENDPOINT)
    this.timeoutMs = options.timeoutMs ?? 5_000
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 500 || this.timeoutMs > 30_000) {
      throw new TypeError('WeChat notification timeout is invalid')
    }
    this.now = options.now ?? Date.now
    this.http = options.httpClient ?? new FetchWechatSubscriptionHttpClient()
  }

  async preflight(): Promise<void> {
    await this.accessToken()
  }

  async send(request: Readonly<WechatSubscriptionDeliveryRequest>): Promise<WechatSubscriptionDeliveryResult> {
    validateDeliveryRequest(request)
    return this.sendTemplate({
      jobId: request.jobId,
      recipientOpenId: request.recipientOpenId,
      templateId: request.templateId,
      pagePath: request.pagePath,
      data: loyaltyTemplateData(request),
    })
  }

  async sendTemplate(request: Readonly<WechatTemplateMessageRequest>): Promise<WechatSubscriptionDeliveryResult> {
    validateTemplateMessageRequest(request)
    let accessToken: string
    try {
      accessToken = await this.accessToken()
    } catch {
      return { outcome: 'unknown', providerReference: null, errorCode: 'access_token_unavailable' }
    }
    const endpoint = new URL(this.sendEndpoint)
    endpoint.searchParams.set('access_token', accessToken)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: WechatSubscriptionHttpResponse
    try {
      response = await this.http.request(endpoint.toString(), {
        method: 'POST',
        body: JSON.stringify(toProviderBody(request)),
        signal: controller.signal,
      })
    } catch {
      return { outcome: 'unknown', providerReference: null, errorCode: 'provider_outcome_unknown' }
    } finally {
      clearTimeout(timeout)
    }
    const body = object(response.body)
    const providerReference = textOrNull(body.rid) ?? textOrNull(body.msgid)
    const errorCode = integerOrNull(body.errcode)
    if (response.status >= 200 && response.status < 300 && errorCode === 0) {
      return { outcome: 'accepted', providerReference }
    }
    if (response.status >= 500 || errorCode === -1) {
      return {
        outcome: 'unknown',
        providerReference,
        errorCode: errorCode === null ? `http_${response.status}` : `wechat_${errorCode}`,
      }
    }
    return {
      outcome: 'provider_rejected',
      providerReference,
      errorCode: errorCode === null ? `http_${response.status}` : `wechat_${errorCode}`,
    }
  }

  private async accessToken(): Promise<string> {
    if (this.token !== null && this.token.refreshAfter > this.now()) return this.token.value
    const endpoint = new URL(this.tokenEndpoint)
    endpoint.searchParams.set('grant_type', 'client_credential')
    endpoint.searchParams.set('appid', this.options.appId)
    endpoint.searchParams.set('secret', this.options.appSecret)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: WechatSubscriptionHttpResponse
    try {
      response = await this.http.request(endpoint.toString(), { method: 'GET', signal: controller.signal })
    } finally {
      clearTimeout(timeout)
    }
    const body = object(response.body)
    const token = textOrNull(body.access_token)
    const expiresIn = integerOrNull(body.expires_in)
    if (response.status < 200 || response.status >= 300 || token === null
      || expiresIn === null || expiresIn < 300) {
      throw new Error('WeChat access token is unavailable')
    }
    this.token = {
      value: token,
      refreshAfter: this.now() + Math.max(60, expiresIn - 300) * 1000,
    }
    return token
  }
}

class FetchWechatSubscriptionHttpClient implements WechatSubscriptionHttpClient {
  async request(
    url: string,
    options: Readonly<{ method: 'GET' | 'POST'; body?: string; signal: AbortSignal }>,
  ): Promise<WechatSubscriptionHttpResponse> {
    const response = await fetch(url, {
      method: options.method,
      signal: options.signal,
      headers: options.body === undefined
        ? { accept: 'application/json' }
        : { accept: 'application/json', 'content-type': 'application/json' },
      ...(options.body === undefined ? {} : { body: options.body }),
    })
    const text = await response.text()
    let body: unknown = null
    if (text) {
      try { body = JSON.parse(text) } catch { body = text }
    }
    return { status: response.status, body }
  }
}

function loyaltyTemplateData(request: Readonly<WechatSubscriptionDeliveryRequest>): Record<string, string> {
  const pointsValue = request.notificationType === 'loyalty_points_expiring'
    ? `${request.pointsAtRisk}积分`
    : `${request.pointsChange > 0 ? '+' : ''}${request.pointsChange}积分`
  const data: Record<string, string> = {
    [request.pointsDataKey]: pointsValue,
    [request.occurredAtDataKey]: providerTime(request.eventOccurredAt),
  }
  if (request.balanceDataKey !== null && request.balanceAfter !== null) {
    data[request.balanceDataKey] = `${request.balanceAfter}`
  }
  if (request.expiresAtDataKey !== null && request.expiresAt !== null) {
    data[request.expiresAtDataKey] = providerTime(request.expiresAt)
  }
  return data
}

function toProviderBody(request: Readonly<WechatTemplateMessageRequest>) {
  return {
    touser: request.recipientOpenId,
    template_id: request.templateId,
    page: request.pagePath,
    miniprogram_state: 'formal',
    lang: 'zh_CN',
    data: Object.fromEntries(Object.entries(request.data).map(([key, value]) => [key, { value }])),
  }
}

function validateDeliveryRequest(request: Readonly<WechatSubscriptionDeliveryRequest>): void {
  for (const key of [request.pointsDataKey, request.occurredAtDataKey,
    request.balanceDataKey, request.expiresAtDataKey].filter((value): value is string => value !== null)) {
    if (!/^[a-z][a-z0-9_]{1,31}$/.test(key)) throw new TypeError('template data key is invalid')
  }
  if (!Number.isFinite(Date.parse(request.eventOccurredAt))) throw new TypeError('eventOccurredAt is invalid')
  if (request.notificationType === 'loyalty_points_expiring') {
    if (request.pointsChange !== 0 || request.pointsAtRisk <= 0 || request.balanceAfter !== null
      || request.expiresAtDataKey === null || request.expiresAt === null) {
      throw new TypeError('expiry notification values are invalid')
    }
  } else if (!Number.isSafeInteger(request.pointsChange) || request.pointsChange === 0
    || request.pointsAtRisk !== 0 || request.balanceDataKey === null
    || request.balanceAfter === null || request.expiresAtDataKey !== null || request.expiresAt !== null) {
    throw new TypeError('balance notification values are invalid')
  }
}

function validateTemplateMessageRequest(request: Readonly<WechatTemplateMessageRequest>): void {
  if (!/^[0-9a-f-]{36}$/i.test(request.jobId)) throw new TypeError('jobId is invalid')
  if (!request.recipientOpenId.trim() || request.recipientOpenId.length > 200) throw new TypeError('recipientOpenId is invalid')
  if (request.templateId.trim().length < 8 || request.templateId.length > 128) throw new TypeError('templateId is invalid')
  if (!/^pages\/[A-Za-z0-9_/-]{1,120}$/.test(request.pagePath)) throw new TypeError('pagePath is invalid')
  const entries = Object.entries(request.data)
  if (entries.length < 1 || entries.length > 10) throw new TypeError('template data is invalid')
  for (const [key, value] of entries) {
    if (!/^[a-z][a-z0-9_]{1,31}$/.test(key)) throw new TypeError('template data key is invalid')
    if (!value.trim() || value.length > 200) throw new TypeError('template data value is invalid')
  }
}

function providerTime(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new TypeError('provider time is invalid')
  return date.toISOString().replace('T', ' ').slice(0, 16)
}

function secureEndpoint(value: string): string {
  const endpoint = new URL(value)
  if (endpoint.protocol !== 'https:' && endpoint.hostname !== '127.0.0.1' && endpoint.hostname !== 'localhost') {
    throw new TypeError('WeChat notification endpoint must use HTTPS')
  }
  return endpoint.toString()
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : null
}

function integerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}
