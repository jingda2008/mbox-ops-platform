import type {
  ServiceAccountSubscriptionMessageClient,
  ServiceAccountSubscriptionMessageRequest,
  WechatAccessToken,
  WechatAccessTokenClient,
  WechatFailure,
  WechatNotificationRecipientResolver,
  WechatProviderMessageReceipt,
  WechatProviderResult,
  WecomNotificationClient,
  WecomNotificationRequest,
} from '../src/shared/wechat-contracts.js'
import type { NotificationProviderAdapter } from './notification-dispatch.js'
import {
  CachedWechatAccessTokenProvider,
  InMemoryWechatDeliveryIdempotencyStore,
  ServiceAccountNotificationAdapter,
  WecomNotificationAdapter,
  type WechatDeliveryIdempotencyStore,
} from './wechat-notification-adapter.js'

const DEFAULT_TIMEOUT_MS = 10_000
const SERVICE_ACCOUNT_TOKEN_ENDPOINT = 'https://api.weixin.qq.com/cgi-bin/token'
const SERVICE_ACCOUNT_SEND_ENDPOINT = 'https://api.weixin.qq.com/cgi-bin/message/template/send'
const WECOM_TOKEN_ENDPOINT = 'https://qyapi.weixin.qq.com/cgi-bin/gettoken'
const WECOM_SEND_ENDPOINT = 'https://qyapi.weixin.qq.com/cgi-bin/message/send'

export type CustomerNotificationAdapter = NotificationProviderAdapter

export interface NotificationHttpRequest {
  method: 'GET' | 'POST'
  url: string
  headers?: Readonly<Record<string, string>>
  body?: string
  signal: AbortSignal
}

export interface NotificationHttpResponse {
  status: number
  body: unknown
}

export interface NotificationHttpClient {
  request(request: NotificationHttpRequest): Promise<NotificationHttpResponse>
}

export class FetchNotificationHttpClient implements NotificationHttpClient {
  async request(request: NotificationHttpRequest): Promise<NotificationHttpResponse> {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: request.signal,
    })
    const responseText = await response.text()
    let body: unknown = {}
    if (responseText) {
      try {
        body = JSON.parse(responseText)
      } catch {
        body = { rawResponse: responseText }
      }
    }
    return { status: response.status, body }
  }
}

export interface ServiceAccountNotificationRuntimeConfig {
  enabled?: boolean
  appId?: string
  appSecret?: string
  templates?: Readonly<Record<string, { templateId: string; page?: string }>>
  tokenEndpoint?: string
  sendEndpoint?: string
}

export interface WecomNotificationRuntimeConfig {
  enabled?: boolean
  corpId?: string
  corpSecret?: string
  agentId?: string
  tokenEndpoint?: string
  sendEndpoint?: string
}

export interface CustomerNotificationRuntimeConfig {
  serviceAccount?: ServiceAccountNotificationRuntimeConfig
  wecom?: WecomNotificationRuntimeConfig
  timeoutMs?: number
}

export type NotificationRuntimeChannel = 'service_account' | 'wecom'

export interface NotificationRuntimeDiagnostic {
  level: 'info' | 'warn'
  channel: NotificationRuntimeChannel
  code: 'CHANNEL_DISABLED' | 'CONFIG_INCOMPLETE' | 'DEPENDENCY_MISSING' | 'ADAPTER_REGISTERED'
  message: string
  missing?: readonly string[]
}

export interface CustomerNotificationRuntimeDependencies {
  recipientResolver?: WechatNotificationRecipientResolver
  deliveryStore?: WechatDeliveryIdempotencyStore
  httpClient?: NotificationHttpClient
  observe?: (diagnostic: NotificationRuntimeDiagnostic) => void
  now?: () => number
}

interface ProviderResponseBody extends Record<string, unknown> {
  access_token?: unknown
  errcode?: unknown
  errmsg?: unknown
  expires_in?: unknown
  msgid?: unknown
  request_id?: unknown
  requestid?: unknown
}

function asProviderBody(body: unknown): ProviderResponseBody {
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    ? body as ProviderResponseBody
    : {}
}

function stringValue(value: unknown) {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function integerValue(value: unknown) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value)
  return null
}

function providerRequestId(body: ProviderResponseBody) {
  return stringValue(body.request_id) || stringValue(body.requestid) || undefined
}

function failure(
  classification: WechatFailure['classification'],
  code: string,
  message: string,
  retryable: boolean,
): WechatProviderResult<never> {
  return { ok: false, failure: { classification, code, message, retryable } }
}

function httpFailure(status: number, provider: string, credentialRequest = false): WechatProviderResult<never> {
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return failure(
      status === 429 ? 'rate_limit' : 'transient',
      `${provider}_HTTP_${status}`,
      `${provider}服务暂时不可用`,
      true,
    )
  }
  if (!credentialRequest && (status === 401 || status === 403)) {
    return failure('authentication', `${provider}_HTTP_${status}`, `${provider}访问凭证失效`, true)
  }
  return failure(
    credentialRequest ? 'configuration' : 'provider_rejection',
    `${provider}_HTTP_${status}`,
    `${provider}拒绝请求`,
    false,
  )
}

const AUTHENTICATION_ERROR_CODES = new Set([40001, 40014, 41001, 42001])
const RATE_LIMIT_ERROR_CODES = new Set([45009, 45011])

function providerFailure(
  body: ProviderResponseBody,
  provider: string,
  credentialRequest = false,
): WechatProviderResult<never> | null {
  const errorCode = integerValue(body.errcode)
  if (errorCode === null || errorCode === 0) return null
  const code = `${provider}_${errorCode}`
  if (errorCode === -1) return failure('transient', code, `${provider}系统繁忙`, true)
  if (RATE_LIMIT_ERROR_CODES.has(errorCode)) return failure('rate_limit', code, `${provider}请求频率受限`, true)
  if (!credentialRequest && AUTHENTICATION_ERROR_CODES.has(errorCode)) {
    return failure('authentication', code, `${provider}访问凭证失效`, true)
  }
  return failure(
    credentialRequest ? 'configuration' : 'provider_rejection',
    code,
    credentialRequest ? `${provider}应用凭证配置无效` : `${provider}拒绝发送通知`,
    false,
  )
}

function positiveInteger(value: unknown) {
  const parsed = integerValue(value)
  return parsed !== null && parsed > 0 ? parsed : null
}

function withTimeout(timeoutMs: number) {
  return AbortSignal.timeout(timeoutMs)
}

function addQuery(endpoint: string, values: Readonly<Record<string, string>>) {
  const url = new URL(endpoint)
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value)
  return url.toString()
}

function assertHttpsEndpoint(endpoint: string, name: string) {
  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    throw new Error(`${name}不是有效URL`)
  }
  if (parsed.protocol !== 'https:') throw new Error(`${name}必须使用HTTPS`)
}

export interface OfficialServiceAccountHttpClientOptions {
  appId: string
  appSecret: string
  httpClient?: NotificationHttpClient
  tokenEndpoint?: string
  sendEndpoint?: string
  timeoutMs?: number
}

export class OfficialServiceAccountHttpClient
implements WechatAccessTokenClient, ServiceAccountSubscriptionMessageClient {
  private readonly httpClient: NotificationHttpClient
  private readonly tokenEndpoint: string
  private readonly sendEndpoint: string
  private readonly timeoutMs: number

  constructor(private readonly options: OfficialServiceAccountHttpClientOptions) {
    this.httpClient = options.httpClient ?? new FetchNotificationHttpClient()
    this.tokenEndpoint = options.tokenEndpoint ?? SERVICE_ACCOUNT_TOKEN_ENDPOINT
    this.sendEndpoint = options.sendEndpoint ?? SERVICE_ACCOUNT_SEND_ENDPOINT
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (!options.appId.trim() || !options.appSecret.trim()) throw new Error('服务号HTTP客户端缺少应用凭证')
    assertHttpsEndpoint(this.tokenEndpoint, '服务号凭证地址')
    assertHttpsEndpoint(this.sendEndpoint, '服务号发送地址')
  }

  async refreshAccessToken(): Promise<WechatProviderResult<WechatAccessToken>> {
    const response = await this.httpClient.request({
      method: 'GET',
      url: addQuery(this.tokenEndpoint, {
        grant_type: 'client_credential',
        appid: this.options.appId,
        secret: this.options.appSecret,
      }),
      signal: withTimeout(this.timeoutMs),
    })
    if (response.status < 200 || response.status >= 300) return httpFailure(response.status, 'SERVICE_ACCOUNT', true)
    const body = asProviderBody(response.body)
    const rejected = providerFailure(body, 'SERVICE_ACCOUNT', true)
    if (rejected) return rejected
    const accessToken = stringValue(body.access_token)
    const expiresInSeconds = positiveInteger(body.expires_in)
    if (!accessToken || !expiresInSeconds) {
      return failure('provider_rejection', 'SERVICE_ACCOUNT_INVALID_TOKEN_RESPONSE', '服务号未返回有效访问凭证', false)
    }
    return {
      ok: true,
      value: { accessToken, expiresInSeconds, providerRequestId: providerRequestId(body) },
    }
  }

  async sendSubscriptionMessage(
    request: ServiceAccountSubscriptionMessageRequest,
  ): Promise<WechatProviderResult<WechatProviderMessageReceipt>> {
    const response = await this.httpClient.request({
      method: 'POST',
      url: addQuery(this.sendEndpoint, { access_token: request.accessToken }),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        touser: request.toOpenId,
        template_id: request.templateId,
        ...(request.page ? { url: request.page } : {}),
        data: request.data,
      }),
      signal: withTimeout(this.timeoutMs),
    })
    if (response.status < 200 || response.status >= 300) return httpFailure(response.status, 'SERVICE_ACCOUNT')
    return messageReceipt(response.body, 'SERVICE_ACCOUNT')
  }
}

export interface OfficialWecomHttpClientOptions {
  corpId: string
  corpSecret: string
  httpClient?: NotificationHttpClient
  tokenEndpoint?: string
  sendEndpoint?: string
  timeoutMs?: number
}

export class OfficialWecomHttpClient implements WechatAccessTokenClient, WecomNotificationClient {
  private readonly httpClient: NotificationHttpClient
  private readonly tokenEndpoint: string
  private readonly sendEndpoint: string
  private readonly timeoutMs: number

  constructor(private readonly options: OfficialWecomHttpClientOptions) {
    this.httpClient = options.httpClient ?? new FetchNotificationHttpClient()
    this.tokenEndpoint = options.tokenEndpoint ?? WECOM_TOKEN_ENDPOINT
    this.sendEndpoint = options.sendEndpoint ?? WECOM_SEND_ENDPOINT
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (!options.corpId.trim() || !options.corpSecret.trim()) throw new Error('企业微信HTTP客户端缺少企业凭证')
    assertHttpsEndpoint(this.tokenEndpoint, '企业微信凭证地址')
    assertHttpsEndpoint(this.sendEndpoint, '企业微信发送地址')
  }

  async refreshAccessToken(): Promise<WechatProviderResult<WechatAccessToken>> {
    const response = await this.httpClient.request({
      method: 'GET',
      url: addQuery(this.tokenEndpoint, { corpid: this.options.corpId, corpsecret: this.options.corpSecret }),
      signal: withTimeout(this.timeoutMs),
    })
    if (response.status < 200 || response.status >= 300) return httpFailure(response.status, 'WECOM', true)
    const body = asProviderBody(response.body)
    const rejected = providerFailure(body, 'WECOM', true)
    if (rejected) return rejected
    const accessToken = stringValue(body.access_token)
    const expiresInSeconds = positiveInteger(body.expires_in)
    if (!accessToken || !expiresInSeconds) {
      return failure('provider_rejection', 'WECOM_INVALID_TOKEN_RESPONSE', '企业微信未返回有效访问凭证', false)
    }
    return {
      ok: true,
      value: { accessToken, expiresInSeconds, providerRequestId: providerRequestId(body) },
    }
  }

  async sendNotification(request: WecomNotificationRequest): Promise<WechatProviderResult<WechatProviderMessageReceipt>> {
    const agentId = positiveInteger(request.agentId)
    const response = await this.httpClient.request({
      method: 'POST',
      url: addQuery(this.sendEndpoint, { access_token: request.accessToken }),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        touser: request.toUserId,
        msgtype: 'text',
        agentid: agentId ?? request.agentId,
        text: { content: request.content },
        safe: 0,
        enable_id_trans: 0,
        enable_duplicate_check: 1,
        duplicate_check_interval: 1_800,
      }),
      signal: withTimeout(this.timeoutMs),
    })
    if (response.status < 200 || response.status >= 300) return httpFailure(response.status, 'WECOM')
    return messageReceipt(response.body, 'WECOM')
  }
}

function messageReceipt(bodyValue: unknown, provider: string): WechatProviderResult<WechatProviderMessageReceipt> {
  const body = asProviderBody(bodyValue)
  const rejected = providerFailure(body, provider)
  if (rejected) return rejected
  const providerMessageId = stringValue(body.msgid)
  if (!providerMessageId) {
    return failure('provider_rejection', `${provider}_INVALID_SEND_RESPONSE`, `${provider}未返回消息ID`, false)
  }
  return {
    ok: true,
    value: { providerMessageId, providerRequestId: providerRequestId(body) },
  }
}

function nonEmpty(value: string | undefined) {
  return Boolean(value?.trim())
}

function validTemplates(templates: ServiceAccountNotificationRuntimeConfig['templates']) {
  return templates && Object.keys(templates).length > 0 && Object.values(templates).every((template) => nonEmpty(template.templateId))
}

function emit(
  dependencies: CustomerNotificationRuntimeDependencies,
  diagnostic: NotificationRuntimeDiagnostic,
) {
  dependencies.observe?.(diagnostic)
}

function disabled(
  dependencies: CustomerNotificationRuntimeDependencies,
  channel: NotificationRuntimeChannel,
) {
  emit(dependencies, {
    level: 'info',
    channel,
    code: 'CHANNEL_DISABLED',
    message: `${channel} customer notification channel is disabled`,
  })
}

function incomplete(
  dependencies: CustomerNotificationRuntimeDependencies,
  channel: NotificationRuntimeChannel,
  missing: string[],
) {
  emit(dependencies, {
    level: 'warn',
    channel,
    code: 'CONFIG_INCOMPLETE',
    message: `${channel} customer notification adapter was not registered because configuration is incomplete`,
    missing,
  })
}

export function createCustomerNotificationAdapters(
  config: CustomerNotificationRuntimeConfig,
  dependencies: CustomerNotificationRuntimeDependencies = {},
): CustomerNotificationAdapter[] {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error('客户通知HTTP超时必须是1至60000之间的整数')
  }

  const channelsEnabled = Boolean(config.serviceAccount?.enabled || config.wecom?.enabled)
  if (channelsEnabled && !dependencies.recipientResolver) {
    for (const channel of ['service_account', 'wecom'] as const) {
      const enabled = channel === 'service_account' ? config.serviceAccount?.enabled : config.wecom?.enabled
      if (enabled) {
        emit(dependencies, {
          level: 'warn',
          channel,
          code: 'DEPENDENCY_MISSING',
          message: `${channel} customer notification adapter was not registered because recipient resolver is missing`,
          missing: ['recipientResolver'],
        })
      }
    }
    return []
  }

  const adapters: CustomerNotificationAdapter[] = []
  const deliveryStore = dependencies.deliveryStore ?? new InMemoryWechatDeliveryIdempotencyStore()
  const httpClient = dependencies.httpClient ?? new FetchNotificationHttpClient()

  const serviceAccount = config.serviceAccount
  if (!serviceAccount?.enabled) {
    disabled(dependencies, 'service_account')
  } else {
    const missing = [
      !nonEmpty(serviceAccount.appId) ? 'appId' : null,
      !nonEmpty(serviceAccount.appSecret) ? 'appSecret' : null,
      !validTemplates(serviceAccount.templates) ? 'templates' : null,
    ].filter((value): value is string => value !== null)
    if (missing.length) {
      incomplete(dependencies, 'service_account', missing)
    } else {
      const client = new OfficialServiceAccountHttpClient({
        appId: serviceAccount.appId!,
        appSecret: serviceAccount.appSecret!,
        httpClient,
        tokenEndpoint: serviceAccount.tokenEndpoint,
        sendEndpoint: serviceAccount.sendEndpoint,
        timeoutMs,
      })
      adapters.push(new ServiceAccountNotificationAdapter({
        client,
        tokenProvider: new CachedWechatAccessTokenProvider(client, { now: dependencies.now }),
        recipientResolver: dependencies.recipientResolver!,
        deliveryStore,
        templates: serviceAccount.templates!,
        now: dependencies.now,
      }))
      emit(dependencies, {
        level: 'info',
        channel: 'service_account',
        code: 'ADAPTER_REGISTERED',
        message: 'service_account customer notification adapter registered',
      })
    }
  }

  const wecom = config.wecom
  if (!wecom?.enabled) {
    disabled(dependencies, 'wecom')
  } else {
    const missing = [
      !nonEmpty(wecom.corpId) ? 'corpId' : null,
      !nonEmpty(wecom.corpSecret) ? 'corpSecret' : null,
      !nonEmpty(wecom.agentId) ? 'agentId' : null,
    ].filter((value): value is string => value !== null)
    if (missing.length) {
      incomplete(dependencies, 'wecom', missing)
    } else {
      const client = new OfficialWecomHttpClient({
        corpId: wecom.corpId!,
        corpSecret: wecom.corpSecret!,
        httpClient,
        tokenEndpoint: wecom.tokenEndpoint,
        sendEndpoint: wecom.sendEndpoint,
        timeoutMs,
      })
      adapters.push(new WecomNotificationAdapter({
        client,
        tokenProvider: new CachedWechatAccessTokenProvider(client, { now: dependencies.now }),
        recipientResolver: dependencies.recipientResolver!,
        deliveryStore,
        agentId: wecom.agentId!,
        now: dependencies.now,
      }))
      emit(dependencies, {
        level: 'info',
        channel: 'wecom',
        code: 'ADAPTER_REGISTERED',
        message: 'wecom customer notification adapter registered',
      })
    }
  }

  return adapters
}
