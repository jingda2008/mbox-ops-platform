interface FetchResponse {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
  arrayBuffer(): Promise<ArrayBuffer>
}

type FetchPort = (
  input: string,
  init: Readonly<{ method: string; headers?: Readonly<Record<string, string>>; body?: string; signal: AbortSignal }>,
) => Promise<FetchResponse>

export interface WechatMiniProgramCodeInput {
  scene: string
  page: string
  environment: 'release' | 'trial' | 'develop'
  width?: number
}

export interface OfficialWechatMiniProgramCodeOptions {
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
const CODE_ENDPOINT = 'https://api.weixin.qq.com/wxa/getwxacodeunlimit'

export class WechatMiniProgramCodeError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'WechatMiniProgramCodeError'
  }
}

export class OfficialWechatMiniProgramCodeProvider {
  private readonly request: FetchPort
  private readonly timeoutMs: number
  private readonly now: () => Date
  private token: CachedToken | null = null

  constructor(private readonly options: Readonly<OfficialWechatMiniProgramCodeOptions>) {
    if (!/^wx[A-Za-z0-9_-]{4,126}$/.test(options.appId)) throw new TypeError('WeChat AppID is invalid')
    if (options.appSecret.trim().length < 8) throw new TypeError('WeChat AppSecret is invalid')
    this.request = options.fetch ?? (fetch as unknown as FetchPort)
    this.timeoutMs = options.timeoutMs ?? 8_000
    this.now = options.now ?? (() => new Date())
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 500 || this.timeoutMs > 30_000) {
      throw new TypeError('WeChat mini-program code timeout is invalid')
    }
  }

  async render(input: Readonly<WechatMiniProgramCodeInput>): Promise<Buffer> {
    const scene = input.scene.trim()
    const page = input.page.trim()
    const width = input.width ?? 430
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(scene)) {
      throw new WechatMiniProgramCodeError('微信小程序码场景参数无效', 'WECHAT_MINI_CODE_SCENE_INVALID')
    }
    if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(page) || page.startsWith('/')) {
      throw new WechatMiniProgramCodeError('微信小程序码页面路径无效', 'WECHAT_MINI_CODE_PAGE_INVALID')
    }
    if (!Number.isSafeInteger(width) || width < 280 || width > 1280) {
      throw new WechatMiniProgramCodeError('微信小程序码尺寸无效', 'WECHAT_MINI_CODE_WIDTH_INVALID')
    }
    const token = await this.accessToken()
    const response = await this.fetchResponse(
      `${CODE_ENDPOINT}?access_token=${encodeURIComponent(token)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scene,
          page,
          width,
          check_path: true,
          env_version: input.environment,
          is_hyaline: false,
        }),
      },
    )
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (response.ok && contentType.startsWith('image/')) {
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length < 128) throw providerUnavailable()
      return bytes
    }
    let body: unknown
    try { body = await response.json() } catch { throw providerUnavailable() }
    throw providerFailure(body)
  }

  private async accessToken(): Promise<string> {
    const nowMs = this.now().getTime()
    if (this.token !== null && this.token.expiresAtMs-60_000 > nowMs) return this.token.value
    const endpoint = new URL(TOKEN_ENDPOINT)
    endpoint.searchParams.set('grant_type', 'client_credential')
    endpoint.searchParams.set('appid', this.options.appId)
    endpoint.searchParams.set('secret', this.options.appSecret)
    const response = await this.fetchResponse(endpoint.toString(), { method: 'GET' })
    if (!response.ok) throw providerUnavailable()
    const body = object(await response.json())
    if (body.errcode !== undefined && body.errcode !== 0) throw providerFailure(body)
    const token = typeof body.access_token === 'string' ? body.access_token.trim() : ''
    const expiresIn = Number(body.expires_in)
    if (!token || !Number.isSafeInteger(expiresIn) || expiresIn < 120 || expiresIn > 86_400) {
      throw providerUnavailable()
    }
    this.token = { value: token, expiresAtMs: nowMs+expiresIn*1_000 }
    return token
  }

  private async fetchResponse(
    url: string,
    init: Readonly<{ method: string; headers?: Readonly<Record<string, string>>; body?: string }>,
  ): Promise<FetchResponse> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      return await this.request(url, { ...init, signal: controller.signal })
    } catch {
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

function providerFailure(value: unknown): WechatMiniProgramCodeError {
  const body = object(value)
  const errorCode = Number(body.errcode)
  if ([40001, 40013, 40125].includes(errorCode)) {
    return new WechatMiniProgramCodeError('微信小程序凭据无效', 'WECHAT_MINI_CODE_CONFIGURATION_INVALID')
  }
  if ([40129, 41030].includes(errorCode)) {
    return new WechatMiniProgramCodeError('微信小程序码场景或页面未获平台接受', 'WECHAT_MINI_CODE_CONTRACT_INVALID')
  }
  return providerUnavailable()
}

function providerUnavailable(): WechatMiniProgramCodeError {
  return new WechatMiniProgramCodeError('微信小程序码服务暂时不可用', 'WECHAT_MINI_CODE_PROVIDER_UNAVAILABLE')
}
