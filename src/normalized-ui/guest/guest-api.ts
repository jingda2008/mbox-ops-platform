import type { GuestMenuProduct, GuestMood } from './guest-model'

export type GuestApiFailureKind = 'timeout' | 'network' | 'http' | 'invalid_response' | 'aborted'

export class GuestApiError extends Error {
  readonly kind: GuestApiFailureKind
  readonly status: number | null
  readonly code: string
  readonly retryAt: string | null

  constructor(
    message: string,
    kind: GuestApiFailureKind,
    status: number | null = null,
    code = 'GUEST_API_ERROR',
    retryAt: string | null = null,
  ) {
    super(message)
    this.name = 'GuestApiError'
    this.kind = kind
    this.status = status
    this.code = code
    this.retryAt = retryAt
  }

  get retryable(): boolean {
    return this.kind === 'timeout' || this.kind === 'network' || this.status === 429 || (this.status ?? 0) >= 500
  }
}

export interface GuestSessionView {
  status: 'active' | 'already_active' | 'waiting_for_table'
  message?: string
  table: { code: string; displayName: string }
  businessDate?: string
  expiresAt?: string
  capabilities?: string[]
}

export interface GuestOrderResult {
  cart: {
    itemCount: number
    lineCount: number
    items: Array<{
      productId: string
      name: string
      quantity: number
      unitAmountMinor: number
      totalAmountMinor: number
      currency: string
      note: string | null
    }>
  }
  order: {
    publicId: string
    status: string
    paymentStatus: string
    note: string | null
    attentionRequired: boolean
    kdsNotice: string | null
  }
  settlement: {
    subtotalAmountMinor: number
    discountAmountMinor: number
    payableAmountMinor: number
    currency: string
  }
  payment: {
    publicId: string
    mode: 'wechat_jsapi' | 'wechat_native_qr' | 'simulation'
    provider: string
    method: string
    status: string
    simulated: boolean
    providerAction: string
  }
}

export interface GuestServiceResult {
  status: 'created' | 'merged' | 'rate_limited'
  message: string
  retryAt?: string | null
}

export interface GuestApiClientOptions {
  fetch?: typeof fetch
  defaultTimeoutMs?: number
}

interface RequestOptions {
  signal?: AbortSignal
  idempotencyKey?: string
}

export class GuestApiClient {
  private readonly send: typeof fetch
  private readonly timeoutMs: number
  private readonly deviceKey: string

  constructor(
    deviceKey: string,
    options: Readonly<GuestApiClientOptions> = {},
  ) {
    this.deviceKey = deviceKey
    this.send = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.timeoutMs = validTimeout(options.defaultTimeoutMs ?? 8_000)
  }

  async scanTable(tableQrToken: string, options: Readonly<RequestOptions> = {}): Promise<GuestSessionView> {
    const body = await this.request<unknown>('/api/guest/session/scan', {
      method: 'POST',
      body: { tableQrToken, deviceKey: this.deviceKey },
      signal: options.signal,
    })
    const data = responseData(body)
    if (!isSessionView(data)) throw invalidResponse()
    return data
  }

  async loadSession(options: Readonly<RequestOptions> = {}): Promise<GuestSessionView> {
    const body = await this.request<unknown>('/api/guest/session', { method: 'GET', signal: options.signal })
    const data = responseData(body)
    if (!isSessionView(data) || data.status !== 'active') throw invalidResponse()
    return data
  }

  async searchMenu(search = '', options: Readonly<RequestOptions> = {}): Promise<GuestMenuProduct[]> {
    const products: GuestMenuProduct[] = []
    const pageSize = 100
    for (let offset = 0; offset < 1_000; offset += pageSize) {
      const query = new URLSearchParams({ search: search.trim(), limit: String(pageSize), offset: String(offset) })
      const body = await this.request<unknown>(`/api/guest/menu/products?${query.toString()}`, {
        method: 'GET', signal: options.signal,
      })
      const data = responseData(body)
      if (!Array.isArray(data) || !data.every(isMenuProduct)) throw invalidResponse()
      products.push(...data)
      if (data.length < pageSize) break
    }
    return products
  }

  async submitOrder(
    input: Readonly<{ items: Array<{ productId: string; quantity: number }>; note: string | null }>,
    options: Readonly<RequestOptions> & { idempotencyKey: string },
  ): Promise<GuestOrderResult> {
    const body = await this.request<unknown>('/api/guest/orders', {
      method: 'POST', body: input, signal: options.signal, idempotencyKey: options.idempotencyKey,
    })
    const data = responseData(body)
    if (!isOrderResult(data)) throw invalidResponse()
    return data
  }

  async requestService(
    input: Readonly<{ requestType: 'call_staff' | 'complaint' | 'custom'; detail: string | null }>,
    options: Readonly<RequestOptions> & { idempotencyKey: string },
  ): Promise<GuestServiceResult> {
    const body = await this.request<unknown>('/api/guest/service-requests', {
      method: 'POST', body: input, signal: options.signal, idempotencyKey: options.idempotencyKey,
      acceptDataOnError: true,
    })
    const data = responseData(body)
    if (!isServiceResult(data)) throw invalidResponse()
    return data
  }

  async recordMood(
    mood: GuestMood,
    options: Readonly<RequestOptions> & { idempotencyKey: string },
  ): Promise<{ recorded: true; mood: GuestMood; occurredAt: string }> {
    const body = await this.request<unknown>('/api/guest/mood', {
      method: 'POST', body: { mood }, signal: options.signal, idempotencyKey: options.idempotencyKey,
    })
    const data = responseData(body)
    if (!isObject(data) || data.recorded !== true || data.mood !== mood || typeof data.occurredAt !== 'string') {
      throw invalidResponse()
    }
    return data as { recorded: true; mood: GuestMood; occurredAt: string }
  }

  private async request<Data>(
    url: string,
    options: Readonly<{
      method: 'GET' | 'POST'
      body?: unknown
      signal?: AbortSignal
      idempotencyKey?: string
      acceptDataOnError?: boolean
    }>,
  ): Promise<Data> {
    const controller = new AbortController()
    let timedOut = false
    const abortFromCaller = () => controller.abort(options.signal?.reason)
    if (options.signal?.aborted) abortFromCaller()
    else options.signal?.addEventListener('abort', abortFromCaller, { once: true })
    const timer = globalThis.setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.timeoutMs)
    const headers = new Headers({ accept: 'application/json', 'x-mbox-guest-device': this.deviceKey })
    if (options.body !== undefined) headers.set('content-type', 'application/json')
    if (options.idempotencyKey !== undefined) headers.set('idempotency-key', options.idempotencyKey)

    try {
      const response = await this.send(url, {
        method: options.method,
        headers,
        credentials: 'include',
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      })
      const body = await readJson(response)
      if (!response.ok && !(options.acceptDataOnError === true && hasData(body))) {
        throw responseError(response, body)
      }
      return body as Data
    } catch (error) {
      if (error instanceof GuestApiError) throw error
      if (timedOut) throw new GuestApiError('处理时间有点长，请再试一次。', 'timeout')
      if (options.signal?.aborted) throw new GuestApiError('操作已取消。', 'aborted')
      throw new GuestApiError('网络好像走神了，请检查网络后重试。', 'network')
    } finally {
      globalThis.clearTimeout(timer)
      options.signal?.removeEventListener('abort', abortFromCaller)
    }
  }
}

function responseError(response: Response, body: unknown): GuestApiError {
  const error = isObject(body) && isObject(body.error) ? body.error : null
  const message = typeof error?.message === 'string' ? error.message : friendlyStatus(response.status)
  const code = typeof error?.code === 'string' ? error.code : 'HTTP_ERROR'
  const retryAt = typeof error?.retryAt === 'string' ? error.retryAt : null
  return new GuestApiError(message, 'http', response.status, code, retryAt)
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw new GuestApiError('服务返回内容暂时无法读取，请重试。', 'invalid_response', response.status)
  }
}

function responseData(value: unknown): unknown {
  if (!isObject(value) || !('data' in value)) throw invalidResponse()
  return value.data
}

function hasData(value: unknown): boolean {
  return isObject(value) && 'data' in value
}

function isSessionView(value: unknown): value is GuestSessionView {
  if (!isObject(value) || !['active', 'already_active', 'waiting_for_table'].includes(String(value.status))) return false
  if (typeof value.message !== 'string' && value.status !== 'active') return false
  return isObject(value.table) && typeof value.table.code === 'string' && typeof value.table.displayName === 'string'
}

function isMenuProduct(value: unknown): value is GuestMenuProduct {
  return isObject(value)
    && typeof value.productId === 'string'
    && typeof value.code === 'string'
    && typeof value.name === 'string'
    && typeof value.categoryCode === 'string'
    && Number.isSafeInteger(value.amountMinor)
    && (value.amountMinor as number) >= 0
    && typeof value.currency === 'string'
    && (value.specification === null || typeof value.specification === 'string')
    && Array.isArray(value.aliases)
    && value.aliases.every((alias) => typeof alias === 'string')
    && (value.imageUrl === null || typeof value.imageUrl === 'string')
    && (value.description === null || typeof value.description === 'string')
    && typeof value.fulfillmentStation === 'string'
    && (value.productKind === 'single' || value.productKind === 'bundle')
    && Array.isArray(value.bundleComponents)
    && value.bundleComponents.every((component) => isObject(component)
      && typeof component.productId === 'string'
      && typeof component.name === 'string'
      && Number.isSafeInteger(component.quantity)
      && (component.quantity as number) > 0)
    && isObject(value.recommendation)
    && typeof value.recommendation.featured === 'boolean'
    && Number.isSafeInteger(value.recommendation.priority)
    && typeof value.recommendation.partySizeMatched === 'boolean'
    && Array.isArray(value.recommendation.intents)
    && value.recommendation.intents.every((intent) => ['easy', 'party', 'ritual', 'explore'].includes(String(intent)))
    && (value.recommendation.badge === null || typeof value.recommendation.badge === 'string')
    && (value.recommendation.valueCopy === null || typeof value.recommendation.valueCopy === 'string')
    && (value.recommendation.upgradeProductId === null || typeof value.recommendation.upgradeProductId === 'string')
    && typeof value.available === 'boolean'
}

function isOrderResult(value: unknown): value is GuestOrderResult {
  return isObject(value)
    && isObject(value.cart)
    && Number.isSafeInteger(value.cart.itemCount)
    && Number.isSafeInteger(value.cart.lineCount)
    && Array.isArray(value.cart.items)
    && isObject(value.order)
    && typeof value.order.publicId === 'string'
    && typeof value.order.status === 'string'
    && typeof value.order.paymentStatus === 'string'
    && typeof value.order.attentionRequired === 'boolean'
    && isObject(value.settlement)
    && Number.isSafeInteger(value.settlement.payableAmountMinor)
    && typeof value.settlement.currency === 'string'
    && isObject(value.payment)
    && ['wechat_jsapi', 'wechat_native_qr', 'simulation'].includes(String(value.payment.mode))
    && typeof value.payment.status === 'string'
    && typeof value.payment.simulated === 'boolean'
    && typeof value.payment.providerAction === 'string'
}

function isServiceResult(value: unknown): value is GuestServiceResult {
  return isObject(value)
    && ['created', 'merged', 'rate_limited'].includes(String(value.status))
    && typeof value.message === 'string'
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalidResponse(): GuestApiError {
  return new GuestApiError('服务返回内容暂时无法识别，请重试。', 'invalid_response')
}

function friendlyStatus(status: number): string {
  if (status === 401) return '这次桌边服务已结束，请重新扫描桌面二维码。'
  if (status === 403) return '当前桌面入口不能使用这项服务。'
  if (status === 409) return '当前桌台状态已经变化，请刷新后再试。'
  if (status === 429) return '操作有点快，我们已经在处理，请稍等一下。'
  if (status >= 500) return '店内服务暂时繁忙，请稍后再试。'
  return '这次没有处理成功，请检查后重试。'
}

function validTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > 120_000) {
    throw new TypeError('defaultTimeoutMs must be an integer between 100 and 120000')
  }
  return value
}
