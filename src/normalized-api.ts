import type {
  NormalizedApiErrorBody,
  NormalizedApiSuccessBody,
  StaffOnDemandResource,
  StaffBootstrapResponse,
  StaffBootstrapView,
} from './shared/normalized-contracts'

export type NormalizedFailureKind = 'aborted' | 'timeout' | 'network' | 'http' | 'invalid_response'
export type NormalizedRecovery = 'retry' | 'login' | 'none'

export class NormalizedApiError extends Error {
  readonly kind: NormalizedFailureKind
  readonly recovery: NormalizedRecovery
  readonly status: number | null
  readonly code: string

  constructor(
    message: string,
    kind: NormalizedFailureKind,
    recovery: NormalizedRecovery,
    status: number | null = null,
    code = 'NORMALIZED_API_ERROR',
  ) {
    super(message)
    this.name = 'NormalizedApiError'
    this.kind = kind
    this.recovery = recovery
    this.status = status
    this.code = code
  }

  get retryable(): boolean {
    return this.recovery === 'retry'
  }
}

export interface NormalizedRequestOptions {
  signal?: AbortSignal
  timeoutMs?: number
  etag?: string
}

export interface StaffBootstrapLoadResult {
  data: StaffBootstrapView | null
  etag: string | null
  notModified: boolean
}

export interface NormalizedApiClientOptions {
  fetch?: typeof fetch
  defaultTimeoutMs?: number
}

export interface StaffAuthView {
  session: { id: string; employeeId: string; issuedAt: string; expiresAt: string; onlineLeaseUntil: string; isOnline: boolean }
  employee: { id: string; code: string; displayName: string; roleCodes: string[] }
  permissions: string[]
  deniedPermissions: string[]
}

export class NormalizedApiClient {
  private readonly send: typeof fetch
  private readonly defaultTimeoutMs: number

  constructor(options: Readonly<NormalizedApiClientOptions> = {}) {
    this.send = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.defaultTimeoutMs = validTimeout(options.defaultTimeoutMs ?? 8_000)
  }

  async getStaffSession(options: Readonly<NormalizedRequestOptions> = {}): Promise<StaffAuthView> {
    return this.getDataEndpoint<StaffAuthView>('/api/auth/session', options)
  }

  async heartbeatStaff(): Promise<StaffAuthView> {
    return this.postDataEndpoint<StaffAuthView>('/api/auth/heartbeat', {})
  }

  async grantDeviceAccess(input: Readonly<{ credential: string; deviceKey: string }>): Promise<{ businessDate: string; expiresAt: string }> {
    return this.postDataEndpoint('/api/auth/device-access', input)
  }

  async loginStaff(input: Readonly<{ employeeCode: string; pin: string }>): Promise<StaffAuthView> {
    return this.postDataEndpoint('/api/auth/login', input)
  }

  async switchStaff(input: Readonly<{ employeeCode: string; pin: string }>): Promise<StaffAuthView> {
    return this.postDataEndpoint('/api/auth/switch', input)
  }

  async logoutStaff(): Promise<void> {
    const response = await this.request('/api/auth/logout', { method: 'POST' })
    if (response.status !== 204) throw new NormalizedApiError('退出结果无法确认，请重试', 'invalid_response', 'retry')
  }

  async getStaffBootstrap(options: Readonly<NormalizedRequestOptions> = {}): Promise<StaffBootstrapLoadResult> {
    const headers = new Headers({ accept: 'application/json' })
    if (options.etag !== undefined) headers.set('if-none-match', options.etag)
    const response = await this.get('/api/staff/workspace', { ...options, headers })
    const etag = response.headers.get('etag')
    if (response.status === 304) return { data: null, etag: etag ?? options.etag ?? null, notModified: true }
    const body = await readJson<StaffBootstrapResponse>(response)
    if (!isStaffBootstrapView(body.data)) {
      throw new NormalizedApiError('工作台返回了无法识别的数据，请刷新后重试', 'invalid_response', 'retry')
    }
    return { data: body.data, etag, notModified: false }
  }

  async getEndpoint<Data>(
    endpointRef: string,
    options: Readonly<NormalizedRequestOptions> = {},
  ): Promise<Data> {
    if (!endpointRef.startsWith('/api/')) {
      throw new NormalizedApiError('接口地址不受信任', 'invalid_response', 'none')
    }
    const response = await this.get(endpointRef, options)
    return readJson<Data>(response)
  }

  async postEndpoint<Data>(
    endpointRef: string,
    body: unknown,
    options: Readonly<{ idempotencyKey?: string; timeoutMs?: number }> = {},
  ): Promise<Data> {
    if (!endpointRef.startsWith('/api/')) {
      throw new NormalizedApiError('接口地址不受信任', 'invalid_response', 'none')
    }
    const headers = new Headers({ accept: 'application/json', 'content-type': 'application/json' })
    if (options.idempotencyKey !== undefined) headers.set('idempotency-key', options.idempotencyKey)
    const response = await this.request(endpointRef, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }, { timeoutMs: options.timeoutMs })
    const payload = await readJson<NormalizedApiSuccessBody<Data>>(response)
    if (!isObject(payload) || !('data' in payload)) {
      throw new NormalizedApiError('服务返回了无法识别的数据，请重试', 'invalid_response', 'retry')
    }
    return payload.data
  }

  async patchEndpoint<Data>(
    endpointRef: string,
    body: unknown,
    options: Readonly<{ idempotencyKey?: string; timeoutMs?: number }> = {},
  ): Promise<Data> {
    return this.mutateEndpoint<Data>('PATCH', endpointRef, body, options)
  }

  async putEndpoint<Data>(
    endpointRef: string,
    body: unknown,
    options: Readonly<{ idempotencyKey?: string; timeoutMs?: number }> = {},
  ): Promise<Data> {
    return this.mutateEndpoint<Data>('PUT', endpointRef, body, options)
  }

  getSessions<Data = unknown>(options: Readonly<NormalizedRequestOptions> = {}): Promise<Data> {
    return this.getDataEndpoint<Data>('/api/operations', options)
  }

  getOperations<Data = unknown>(options: Readonly<NormalizedRequestOptions> = {}): Promise<Data> {
    return this.getDataEndpoint<Data>('/api/operations', options)
  }

  getFulfillment<Data = unknown>(options: Readonly<NormalizedRequestOptions> = {}): Promise<Data> {
    return this.getDataEndpoint<Data>('/api/commerce/fulfillment', options)
  }

  getReservationSummary<Data = unknown>(options: Readonly<NormalizedRequestOptions> = {}): Promise<Data> {
    return this.getDataEndpoint<Data>('/api/staff/reservations', options)
  }

  getOnDemand<Data = unknown>(
    resource: StaffOnDemandResource,
    options: Readonly<NormalizedRequestOptions> = {},
  ): Promise<Data> {
    switch (resource) {
      case 'sessions': return this.getSessions<Data>(options)
      case 'operations': return this.getOperations<Data>(options)
      case 'fulfillment': return this.getFulfillment<Data>(options)
      case 'reservation-summary': return this.getReservationSummary<Data>(options)
    }
  }

  private async getDataEndpoint<Data>(
    endpointRef: string,
    options: Readonly<NormalizedRequestOptions>,
  ): Promise<Data> {
    const response = await this.get(endpointRef, options)
    const body = await readJson<NormalizedApiSuccessBody<Data>>(response)
    if (!isObject(body) || !('data' in body)) {
      throw new NormalizedApiError('服务返回了无法识别的数据，请重试', 'invalid_response', 'retry')
    }
    return body.data
  }

  private async postDataEndpoint<Data>(endpointRef: string, body: unknown): Promise<Data> {
    const response = await this.request(endpointRef, {
      method: 'POST',
      headers: new Headers({ accept: 'application/json', 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    })
    const payload = await readJson<NormalizedApiSuccessBody<Data>>(response)
    if (!isObject(payload) || !('data' in payload)) {
      throw new NormalizedApiError('服务返回了无法识别的数据，请重试', 'invalid_response', 'retry')
    }
    return payload.data
  }

  private async mutateEndpoint<Data>(
    method: 'PATCH' | 'PUT',
    endpointRef: string,
    body: unknown,
    options: Readonly<{ idempotencyKey?: string; timeoutMs?: number }>,
  ): Promise<Data> {
    if (!endpointRef.startsWith('/api/')) {
      throw new NormalizedApiError('接口地址不受信任', 'invalid_response', 'none')
    }
    const headers = new Headers({ accept: 'application/json', 'content-type': 'application/json' })
    if (options.idempotencyKey !== undefined) headers.set('idempotency-key', options.idempotencyKey)
    const response = await this.request(endpointRef, {
      method,
      headers,
      body: JSON.stringify(body),
    }, { timeoutMs: options.timeoutMs })
    const payload = await readJson<NormalizedApiSuccessBody<Data>>(response)
    if (!isObject(payload) || !('data' in payload)) {
      throw new NormalizedApiError('服务返回了无法识别的数据，请重试', 'invalid_response', 'retry')
    }
    return payload.data
  }

  private async get(
    url: string,
    options: Readonly<NormalizedRequestOptions & { headers?: Headers }> = {},
  ): Promise<Response> {
    return this.request(url, { method: 'GET', headers: options.headers }, options)
  }

  private async request(
    url: string,
    request: Readonly<{ method: 'GET' | 'POST' | 'PATCH' | 'PUT'; headers?: Headers; body?: string }>,
    options: Readonly<NormalizedRequestOptions> = {},
  ): Promise<Response> {
    if (!url.startsWith('/api/')) throw new NormalizedApiError('接口地址不受信任', 'invalid_response', 'none')
    const timeoutMs = validTimeout(options.timeoutMs ?? this.defaultTimeoutMs)
    const controller = new AbortController()
    let timedOut = false
    const abortFromCaller = () => controller.abort(options.signal?.reason)
    if (options.signal?.aborted) abortFromCaller()
    else options.signal?.addEventListener('abort', abortFromCaller, { once: true })
    const timer = globalThis.setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)

    try {
      const response = await this.send(url, {
        method: request.method,
        credentials: 'include',
        headers: request.headers ?? new Headers({ accept: 'application/json' }),
        ...(request.body === undefined ? {} : { body: request.body }),
        signal: controller.signal,
      })
      if (response.status === 304) return response
      if (!response.ok) throw await responseError(response)
      return response
    } catch (error) {
      if (error instanceof NormalizedApiError) throw error
      if (timedOut) {
        throw new NormalizedApiError('请求超时，请重试', 'timeout', 'retry')
      }
      if (options.signal?.aborted) {
        throw new NormalizedApiError('操作已取消', 'aborted', 'none')
      }
      throw new NormalizedApiError('网络连接失败，请检查网络后重试', 'network', 'retry')
    } finally {
      globalThis.clearTimeout(timer)
      options.signal?.removeEventListener('abort', abortFromCaller)
    }
  }
}

async function responseError(response: Response): Promise<NormalizedApiError> {
  let code = 'HTTP_ERROR'
  let message = response.statusText || '请求失败'
  let bodyRetryable: boolean | undefined
  try {
    const body = await response.json() as Partial<NormalizedApiErrorBody>
    if (typeof body.error?.code === 'string') code = body.error.code
    if (typeof body.error?.message === 'string') message = body.error.message
    if (typeof body.error?.retryable === 'boolean') bodyRetryable = body.error.retryable
  } catch {
    // The status still determines a safe recovery path when an upstream returns non-JSON.
  }
  const recovery: NormalizedRecovery = response.status === 401
    ? 'login'
    : response.status >= 500 || response.status === 429 ? 'retry' : 'none'
  if (bodyRetryable === true && recovery === 'none') {
    return new NormalizedApiError(message, 'http', 'retry', response.status, code)
  }
  return new NormalizedApiError(message, 'http', recovery, response.status, code)
}

async function readJson<Data>(response: Response): Promise<Data> {
  try {
    return await response.json() as Data
  } catch {
    throw new NormalizedApiError('服务返回内容无法读取，请重试', 'invalid_response', 'retry', response.status)
  }
}

function validTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > 120_000) {
    throw new TypeError('timeoutMs must be an integer between 100 and 120000')
  }
  return value
}

function isStaffBootstrapView(value: unknown): value is StaffBootstrapView {
  if (!isObject(value) || value.schemaVersion !== 1 || typeof value.generatedAt !== 'string') return false
  if (!isObject(value.store) || typeof value.store.id !== 'string' || typeof value.store.name !== 'string') return false
  if (!isObject(value.businessDay) || typeof value.businessDay.date !== 'string') return false
  if (!isObject(value.staff) || typeof value.staff.id !== 'string' || typeof value.staff.displayName !== 'string') return false
  if (!isObject(value.access) || !Array.isArray(value.access.permissions)) return false
  return Array.isArray(value.navigation)
    && Array.isArray(value.highFrequencyEntries)
    && Array.isArray(value.domainSummaries)
    && isObject(value.endpointRefs)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
