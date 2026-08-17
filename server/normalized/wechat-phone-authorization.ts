import { createHash } from 'node:crypto'
import { CustomerExperienceRequestError } from './customer-experience-repository.js'
import type {
  MembershipRecoveryPhoneAuthorizationPort,
  VerifiedRecoveryPhoneAuthorization,
} from './membership-recovery-service.js'

interface FetchResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

type FetchPort = (
  input: string,
  init: Readonly<{ method: string; headers?: Readonly<Record<string, string>>; body?: string; signal: AbortSignal }>,
) => Promise<FetchResponse>

export interface OfficialWechatPhoneAuthorizationOptions {
  appId: string
  appSecret: string
  fetch?: FetchPort
  timeoutMs?: number
  now?: () => Date
}

interface CachedToken {
  value: string
  expiresAtMs: number
}

const TOKEN_ENDPOINT = 'https://api.weixin.qq.com/cgi-bin/token'
const PHONE_ENDPOINT = 'https://api.weixin.qq.com/wxa/business/getuserphonenumber'

export class OfficialWechatPhoneAuthorizationProvider
implements MembershipRecoveryPhoneAuthorizationPort {
  private readonly request: FetchPort
  private readonly timeoutMs: number
  private readonly now: () => Date
  private token: CachedToken | null = null

  constructor(private readonly options: Readonly<OfficialWechatPhoneAuthorizationOptions>) {
    if (!/^wx[A-Za-z0-9_-]{4,126}$/.test(options.appId)) throw new TypeError('WeChat AppID is invalid')
    if (options.appSecret.trim().length < 8) throw new TypeError('WeChat AppSecret is invalid')
    this.request = options.fetch ?? (fetch as unknown as FetchPort)
    this.timeoutMs = options.timeoutMs ?? 5_000
    this.now = options.now ?? (() => new Date())
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 500 || this.timeoutMs > 30_000) {
      throw new TypeError('WeChat phone authorization timeout is invalid')
    }
  }

  async verify(input: Readonly<{
    authorizationCode: string
    customerId: string
  }>): Promise<VerifiedRecoveryPhoneAuthorization> {
    const code = input.authorizationCode.trim()
    if (code.length < 8 || code.length > 512) throw invalidAuthorization()
    if (!/^[0-9a-f-]{36}$/i.test(input.customerId)) throw invalidAuthorization()
    const accessToken = await this.accessToken()
    const body = await this.fetchJson(
      `${PHONE_ENDPOINT}?access_token=${encodeURIComponent(accessToken)}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) },
    )
    const record = object(body)
    if (record.errcode !== undefined && record.errcode !== 0) throw providerFailure(record, 'phone')
    const phoneInfo = object(record.phone_info)
    const watermark = object(phoneInfo.watermark)
    if (watermark.appid !== undefined && watermark.appid !== this.options.appId) throw invalidAuthorization()
    const purePhoneNumber = stringValue(phoneInfo.purePhoneNumber, '微信手机号')
    const countryCode = stringValue(phoneInfo.countryCode, '微信手机号国家码')
    if (!/^[1-9][0-9]{0,3}$/.test(countryCode) || !/^[0-9]{7,15}$/.test(purePhoneNumber)) {
      throw invalidAuthorization()
    }
    const e164Phone = `+${countryCode}${purePhoneNumber.replace(/^0+/, '')}`
    if (!/^\+[1-9][0-9]{7,14}$/.test(e164Phone)) throw invalidAuthorization()
    const verifiedAt = watermark.timestamp === undefined
      ? this.now().toISOString()
      : providerTimestamp(watermark.timestamp, this.now())
    return {
      e164Phone,
      providerReference: `wechat-phone:${createHash('sha256').update(code).digest('hex')}`,
      verifiedAt,
    }
  }

  private async accessToken(): Promise<string> {
    const nowMs = this.now().getTime()
    if (this.token !== null && this.token.expiresAtMs - 60_000 > nowMs) return this.token.value
    const endpoint = new URL(TOKEN_ENDPOINT)
    endpoint.searchParams.set('grant_type', 'client_credential')
    endpoint.searchParams.set('appid', this.options.appId)
    endpoint.searchParams.set('secret', this.options.appSecret)
    const body = object(await this.fetchJson(endpoint.toString(), { method: 'GET' }))
    if (body.errcode !== undefined && body.errcode !== 0) throw providerFailure(body, 'token')
    const token = stringValue(body.access_token, '微信访问令牌')
    const expiresIn = Number(body.expires_in)
    if (!Number.isSafeInteger(expiresIn) || expiresIn < 120 || expiresIn > 86_400) {
      throw providerUnavailable()
    }
    this.token = { value: token, expiresAtMs: nowMs + expiresIn * 1_000 }
    return token
  }

  private async fetchJson(
    url: string,
    init: Readonly<{ method: string; headers?: Readonly<Record<string, string>>; body?: string }>,
  ): Promise<unknown> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.request(url, { ...init, signal: controller.signal })
      if (!response.ok) throw providerUnavailable()
      return await response.json()
    } catch (error) {
      if (error instanceof CustomerExperienceRequestError) throw error
      throw providerUnavailable()
    } finally {
      clearTimeout(timeout)
    }
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw providerUnavailable()
  return value as Record<string, unknown>
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CustomerExperienceRequestError(`${label}无效`, 'WECHAT_PHONE_AUTHORIZATION_INVALID', 400)
  }
  return value.trim()
}

function providerTimestamp(value: unknown, now: Date): string {
  const seconds = Number(value)
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw invalidAuthorization()
  const timestamp = new Date(seconds * 1_000)
  const ageMs = now.getTime() - timestamp.getTime()
  if (ageMs < -2 * 60_000 || ageMs > 10 * 60_000) throw invalidAuthorization()
  return timestamp.toISOString()
}

function providerFailure(
  body: Readonly<Record<string, unknown>>,
  operation: 'token' | 'phone',
): CustomerExperienceRequestError {
  const code = Number(body.errcode)
  if (operation === 'phone' && [40029, 40163].includes(code)) return invalidAuthorization()
  if ([-1, 45009, 45011].includes(code)) return providerUnavailable()
  return operation === 'token'
    ? new CustomerExperienceRequestError('微信手机号服务配置不可用', 'WECHAT_PHONE_PROVIDER_CONFIGURATION', 503)
    : invalidAuthorization()
}

function invalidAuthorization(): CustomerExperienceRequestError {
  return new CustomerExperienceRequestError(
    '微信手机号授权无效或已过期，请重新点击找回',
    'WECHAT_PHONE_AUTHORIZATION_INVALID',
    400,
  )
}

function providerUnavailable(): CustomerExperienceRequestError {
  return new CustomerExperienceRequestError(
    '微信手机号服务暂时不可用，请稍后重试',
    'WECHAT_PHONE_PROVIDER_UNAVAILABLE',
    503,
  )
}
