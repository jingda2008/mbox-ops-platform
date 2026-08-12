import type {
  StaffFulfillmentData,
  StaffOperationsData,
  StaffReservation,
} from './types'

export class StaffActionsApiError extends Error {
  readonly code: string
  readonly status: number | null
  readonly partialMutation: boolean

  constructor(
    message: string,
    code: string,
    status: number | null,
    partialMutation = false,
  ) {
    super(message)
    this.name = 'StaffActionsApiError'
    this.code = code
    this.status = status
    this.partialMutation = partialMutation
  }
}

export interface AssistedOrderAccess {
  canCreateOrder: boolean
  gift: null | {
    enabled: boolean
    maximumAmountMinor: number | null
    currency: string
  }
}

export interface AssistedOrderCatalogProduct {
  id: string
  code: string
  name: string
  categoryCode: string
  fulfillmentStation: 'bar' | 'kitchen' | 'cashier' | 'none'
  productSnapshot: Record<string, unknown>
  status: 'active' | 'sold_out' | 'inactive'
  isAvailable: boolean
  standardPrice: null | {
    amountMinor: string | null
    currency: string | null
  }
}

export interface AssistedOrderResult {
  id: string
  orderMode: 'paid' | 'gift'
  totalAmountMinor: number
  currency: string
  amounts: {
    grossAmount: number
    discountAmount: number
    giftAmount: number
    payableAmount: number
  }
  paymentNextStep: {
    status: 'required' | 'deferred'
    action: 'create_payment_intent' | 'settle_table_later'
  }
}

export interface StaffActionsApiPort {
  loadOperations(signal?: AbortSignal): Promise<StaffOperationsData>
  loadFulfillment(signal?: AbortSignal): Promise<StaffFulfillmentData>
  loadReservations(signal?: AbortSignal): Promise<StaffReservation[]>
  openTable(input: Readonly<{
    tableId: string
    guestCount: number
    capacityOverrideReason?: string
  }>): Promise<void>
  closeTable(sessionId: string): Promise<void>
  transferTable(input: Readonly<{
    tableSessionId: string
    targetTableId: string
    capacityOverrideReason?: string
  }>): Promise<void>
  completeServiceTask(taskId: string, note?: string): Promise<void>
  runKdsAction(taskId: string, action: 'complete' | 'deliver'): Promise<void>
  actOnReservation(reservationId: string, action: 'confirm' | 'arrive'): Promise<void>
  loadAssistedOrderAccess(signal?: AbortSignal): Promise<AssistedOrderAccess>
  loadAssistedOrderCatalog(signal?: AbortSignal): Promise<AssistedOrderCatalogProduct[]>
  issueAssistedOrderContext(input: Readonly<{
    tableSessionId: string
  }>): Promise<string>
  submitAssistedOrder(input: Readonly<{
    tableSessionId: string
    assistedOrderContextToken: string
    orderMode: 'paid' | 'gift'
    items: ReadonlyArray<{ productId: string; quantity: number }>
    fulfillmentNote?: string
    giftReason?: string
    settlementMode: 'immediate_payment' | 'table_tab'
  }>): Promise<AssistedOrderResult>
}

export interface StaffActionsApiOptions {
  fetch?: typeof fetch
  timeoutMs?: number
  createIdempotencyKey?: () => string
}

export class StaffActionsApi implements StaffActionsApiPort {
  private readonly send: typeof fetch
  private readonly timeoutMs: number
  private readonly createIdempotencyKey: () => string

  constructor(options: Readonly<StaffActionsApiOptions> = {}) {
    this.send = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.timeoutMs = options.timeoutMs ?? 8_000
    this.createIdempotencyKey = options.createIdempotencyKey ?? (() => crypto.randomUUID())
  }

  loadOperations(signal?: AbortSignal): Promise<StaffOperationsData> {
    return this.getData('/api/operations', signal)
  }

  loadFulfillment(signal?: AbortSignal): Promise<StaffFulfillmentData> {
    return this.getData('/api/commerce/fulfillment', signal)
  }

  loadReservations(signal?: AbortSignal): Promise<StaffReservation[]> {
    return this.getData('/api/staff/reservations', signal)
  }

  async openTable(input: Readonly<{
    tableId: string
    guestCount: number
    capacityOverrideReason?: string
  }>): Promise<void> {
    await this.command('/api/table-management/sessions/open', input, 'x-idempotency-key')
  }

  async closeTable(sessionId: string): Promise<void> {
    const operationKey = `staff-close-${sessionId}`
    await this.command(
      `/api/table-sessions/${encodeURIComponent(sessionId)}/begin-closing`,
      {},
      'idempotency-key',
      `${operationKey}-begin`,
    )
    try {
      await this.command(
        `/api/table-sessions/${encodeURIComponent(sessionId)}/close`,
        {},
        'idempotency-key',
        `${operationKey}-complete`,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : '关台结果无法确认'
      throw new StaffActionsApiError(message, 'TABLE_CLOSE_PARTIAL', null, true)
    }
  }

  async transferTable(input: Readonly<{
    tableSessionId: string
    targetTableId: string
    capacityOverrideReason?: string
  }>): Promise<void> {
    await this.command(
      `/api/table-management/sessions/${encodeURIComponent(input.tableSessionId)}/transfer`,
      { targetTableId: input.targetTableId, capacityOverrideReason: input.capacityOverrideReason },
      'x-idempotency-key',
    )
  }

  async completeServiceTask(taskId: string, note?: string): Promise<void> {
    await this.command(
      `/api/service-tasks/${encodeURIComponent(taskId)}/complete`,
      note === undefined ? {} : { note },
      'idempotency-key',
    )
  }

  async runKdsAction(taskId: string, action: 'complete' | 'deliver'): Promise<void> {
    await this.command(`/api/commerce/kds/${encodeURIComponent(taskId)}/actions`, { action }, 'idempotency-key')
  }

  async actOnReservation(reservationId: string, action: 'confirm' | 'arrive'): Promise<void> {
    await this.command(
      `/api/staff/reservations/${encodeURIComponent(reservationId)}/${action}`,
      {},
      'idempotency-key',
      `staff-reservation-${action}-${reservationId}`,
    )
  }

  loadAssistedOrderAccess(signal?: AbortSignal): Promise<AssistedOrderAccess> {
    return this.getData('/api/commerce/assisted-order-access', signal)
  }

  loadAssistedOrderCatalog(signal?: AbortSignal): Promise<AssistedOrderCatalogProduct[]> {
    return this.getData('/api/catalog/products?status=active&limit=100', signal)
  }

  async issueAssistedOrderContext(input: Readonly<{ tableSessionId: string }>): Promise<string> {
    const response = await this.request('/api/commerce/assisted-order-contexts', {
      method: 'POST',
      headers: new Headers({ accept: 'application/json', 'content-type': 'application/json' }),
      body: JSON.stringify(input),
    })
    const body = await readJson(response)
    if (!isObject(body) || !isObject(body.data) || typeof body.data.token !== 'string') {
      throw new StaffActionsApiError('协助点单授权无法识别，请重新进入桌台', 'INVALID_RESPONSE', response.status)
    }
    return body.data.token
  }

  async submitAssistedOrder(input: Readonly<{
    tableSessionId: string
    assistedOrderContextToken: string
    orderMode: 'paid' | 'gift'
    items: ReadonlyArray<{ productId: string; quantity: number }>
    fulfillmentNote?: string
    giftReason?: string
    settlementMode: 'immediate_payment' | 'table_tab'
  }>): Promise<AssistedOrderResult> {
    const headers = new Headers({
      accept: 'application/json',
      'content-type': 'application/json',
      'idempotency-key': `staff-order-${this.createIdempotencyKey()}`,
      'x-assisted-order-context': input.assistedOrderContextToken,
    })
    const response = await this.request('/api/commerce/orders', {
      method: 'POST', headers, body: JSON.stringify(input),
    })
    const body = await readJson(response)
    if (!isObject(body) || typeof body.id !== 'string') {
      throw new StaffActionsApiError('订单结果无法识别，请到订单列表核对', 'INVALID_RESPONSE', response.status)
    }
    return body as unknown as AssistedOrderResult
  }

  private async getData<Data>(url: string, signal?: AbortSignal): Promise<Data> {
    const response = await this.request(url, { method: 'GET', signal })
    const body = await readJson(response)
    if (!isObject(body) || !('data' in body)) throw new StaffActionsApiError('服务返回内容无法识别', 'INVALID_RESPONSE', response.status)
    return body.data as Data
  }

  private async command(
    url: string,
    body: object,
    idempotencyHeader: 'idempotency-key' | 'x-idempotency-key',
    idempotencyKey = `staff-action-${this.createIdempotencyKey()}`,
  ): Promise<void> {
    const headers = new Headers({ accept: 'application/json', 'content-type': 'application/json' })
    headers.set(idempotencyHeader, idempotencyKey)
    await this.request(url, { method: 'POST', body: JSON.stringify(body), headers })
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    if (!url.startsWith('/api/')) throw new StaffActionsApiError('接口地址不受信任', 'UNTRUSTED_ENDPOINT', null)
    const controller = new AbortController()
    const callerSignal = init.signal
    const abort = () => controller.abort(callerSignal?.reason)
    if (callerSignal?.aborted) abort()
    else callerSignal?.addEventListener('abort', abort, { once: true })
    const timer = globalThis.setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.send(url, { ...init, signal: controller.signal, credentials: 'include' })
      if (!response.ok) throw await apiError(response)
      return response
    } catch (error) {
      if (error instanceof StaffActionsApiError) throw error
      if (callerSignal?.aborted) throw new StaffActionsApiError('操作已取消', 'ABORTED', null)
      if (controller.signal.aborted) throw new StaffActionsApiError('请求超时，请重试', 'TIMEOUT', null)
      throw new StaffActionsApiError('网络连接失败，请检查网络后重试', 'NETWORK_ERROR', null)
    } finally {
      globalThis.clearTimeout(timer)
      callerSignal?.removeEventListener('abort', abort)
    }
  }
}

async function apiError(response: Response): Promise<StaffActionsApiError> {
  const body = await readJson(response).catch(() => null)
  if (isObject(body) && isObject(body.error)) {
    return new StaffActionsApiError(
      typeof body.error.message === 'string' ? body.error.message : '操作未完成',
      typeof body.error.code === 'string' ? body.error.code : 'HTTP_ERROR',
      response.status,
    )
  }
  return new StaffActionsApiError('操作未完成，请重试', 'HTTP_ERROR', response.status)
}

async function readJson(response: Response): Promise<unknown> {
  return response.json()
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
