import { afterEach, describe, expect, it, vi } from 'vitest'
import { GuestApiClient } from './guest-api'

const deviceKey = 'guest-device-browser-0001'
const qrToken = 'fixed-table-token-'.padEnd(48, 'x')

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function product(index: number) {
  return {
    productId: `55555555-5555-4555-8555-${String(index).padStart(12, '0')}`,
    code: `PRODUCT-${index}`,
    name: `商品${index}`,
    categoryCode: 'beer',
    categoryName: '酒水',
    beverageFamily: 'beer',
    specification: '330ml',
    aliases: [],
    tags: [],
    imageUrl: null,
    description: null,
    sortOrder: index,
    availableFrom: null,
    availableUntil: null,
    guestVisible: true,
    requiresFulfillment: true,
    maxOrderQuantity: 50,
    amountMinor: 6_800,
    currency: 'CNY',
    fulfillmentStation: 'bar',
    productKind: 'single',
    bundleComponents: [],
    recommendation: {
      enabled: false, priority: 0, badge: '', headline: '', reason: '',
      minimumPartySize: 1, maximumPartySize: 100,
      sceneTags: [], intentTags: [], tasteTags: [], dwellTags: [],
      singleWaveEligible: true, expectedPrepMinutes: 8, holdMinutes: 10,
      upgradeProductId: null,
    },
    available: true,
  }
}

describe('GuestApiClient', () => {
  it('keeps the fixed QR credential out of the URL and binds the scan to one device', async () => {
    const send = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => jsonResponse({ data: {
      status: 'active',
      message: '已经找到您的桌位',
      table: { code: 'W01', displayName: '室外 W01' },
      businessDate: '2026-08-11',
      expiresAt: '2026-08-12T02:00:00.000Z',
      cartScope: 'abcdefghijklmnopqrstuvwxyzABCDEF',
      capabilities: ['guest.menu.read'],
    } }))
    const client = new GuestApiClient(deviceKey, { fetch: send })

    await expect(client.scanTable(qrToken)).resolves.toMatchObject({ status: 'active', table: { code: 'W01' } })
    const [url, init] = send.mock.calls[0]!
    expect(url).toBe('/api/guest/session/scan')
    expect(String(url)).not.toContain(qrToken)
    expect(new Headers(init?.headers).get('x-mbox-guest-device')).toBe(deviceKey)
    expect(JSON.parse(String(init?.body))).toEqual({ tableQrToken: qrToken, deviceKey })
    expect(init?.credentials).toBe('include')
  })

  it('searches every menu page rather than silently stopping at the first 100 products', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => product(index + 1))
    const send = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse({ data: firstPage, meta: { count: 100, partySize: 2, recommendationScene: 'date' } }))
      .mockResolvedValueOnce(jsonResponse({ data: [product(101)], meta: { count: 1, partySize: 2, recommendationScene: 'date' } }))
    const client = new GuestApiClient(deviceKey, { fetch: send })

    const result = await client.searchMenu('啤酒')

    expect(result.products).toHaveLength(101)
    expect(result.partySize).toBe(2)
    expect(result.recommendationScene).toBe('date')
    expect(String(send.mock.calls[0]?.[0])).toContain('search=%E5%95%A4%E9%85%92')
    expect(String(send.mock.calls[1]?.[0])).toContain('offset=100')
  })

  it('submits only product quantities and notes with an idempotency key', async () => {
    const send = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => jsonResponse({ data: orderResult() }, 201))
    const client = new GuestApiClient(deviceKey, { fetch: send })

    const result = await client.submitOrder({
      items: [{ productId: '55555555-5555-4555-8555-555555555555', quantity: 2 }],
      note: '少冰，生日桌',
      confirmedDuplicateOrderId: 'guest-order-existing-0001',
    }, { idempotencyKey: 'guest-order-test-0001' })

    expect(result.payment).toMatchObject({ status: 'pending', simulated: false })
    const [, init] = send.mock.calls[0]!
    expect(new Headers(init?.headers).get('idempotency-key')).toBe('guest-order-test-0001')
    expect(JSON.parse(String(init?.body))).toEqual({
      items: [{ productId: '55555555-5555-4555-8555-555555555555', quantity: 2 }],
      note: '少冰，生日桌',
      confirmedDuplicateOrderId: 'guest-order-existing-0001',
    })
  })

  it('uses the server-authoritative shared cart for v2 table sessions', async () => {
    const send = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse({ data: sharedCart() }))
      .mockResolvedValueOnce(jsonResponse({ data: sharedCart({ version: 3, quantity: 2 }) }))
      .mockResolvedValueOnce(jsonResponse({ data: { ...orderResult(), sharedCart: sharedCart({ status: 'submitted', version: 4, quantity: 2 }) } }, 201))
    const client = new GuestApiClient(deviceKey, { fetch: send })

    await expect(client.loadSharedCart()).resolves.toMatchObject({ version: 2, lines: [{ quantity: 1 }] })
    await expect(client.adjustSharedCart({
      productId: '55555555-5555-4555-8555-555555555555', delta: 1, expectedGeneration: 1, expectedVersion: 2,
    }, { idempotencyKey: 'shared-cart-adjust-test-0001' })).resolves.toMatchObject({ version: 3, lines: [{ quantity: 2 }] })
    await expect(client.checkoutSharedCart({
      expectedGeneration: 1, expectedVersion: 3, note: '酒水和小食一起上', confirmedDuplicateOrderId: 'guest-order-existing-0001',
    }, { idempotencyKey: 'shared-cart-checkout-test-0001' })).resolves.toMatchObject({
      order: { publicId: 'guest-order-public-0001' }, sharedCart: { status: 'submitted' },
    })

    expect(send.mock.calls.map(([url]) => url)).toEqual([
      '/api/guest/shared-cart',
      '/api/guest/shared-cart/lines',
      '/api/guest/shared-cart/checkout',
    ])
    expect(JSON.parse(String(send.mock.calls[1]?.[1]?.body))).toEqual({
      productId: '55555555-5555-4555-8555-555555555555', delta: 1, expectedGeneration: 1, expectedVersion: 2,
    })
    expect(JSON.parse(String(send.mock.calls[2]?.[1]?.body))).toEqual({
      expectedGeneration: 1, expectedVersion: 3, note: '酒水和小食一起上', confirmedDuplicateOrderId: 'guest-order-existing-0001',
    })
    expect(new Headers(send.mock.calls[2]?.[1]?.headers).get('idempotency-key')).toBe('shared-cart-checkout-test-0001')
  })

  it('preserves server duplicate details for the confirmation dialog', async () => {
    const send = vi.fn(async () => jsonResponse({ error: {
      code: 'GUEST_ORDER_DUPLICATE_CONFIRMATION_REQUIRED',
      message: '本桌刚提交过相同商品，请确认这是继续加单而不是重复操作',
      details: { conflictingOrderId: 'guest-order-existing-0001' },
    } }, 409))
    const client = new GuestApiClient(deviceKey, { fetch: send })

    await expect(client.submitOrder({
      items: [{ productId: '55555555-5555-4555-8555-555555555555', quantity: 1 }],
      note: null,
    }, { idempotencyKey: 'guest-order-duplicate-0001' })).rejects.toMatchObject({
      status: 409,
      code: 'GUEST_ORDER_DUPLICATE_CONFIRMATION_REQUIRED',
      details: { conflictingOrderId: 'guest-order-existing-0001' },
    })
  })

  it('loads the shared table order view without requiring an idempotency key', async () => {
    const send = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => jsonResponse({ data: [{
      publicId: 'shared-order-0001', round: 1, channel: 'guest_qr', sourceText: '顾客扫码点单', status: 'submitted',
      visibility: 'shared', isMine: false, createdAt: '2026-08-11T12:00:00.000Z',
      paymentStatus: 'unpaid', paymentAccess: 'available', payableAmountMinor: 13_600, currency: 'CNY',
      items: [{ productId: '55555555-5555-4555-8555-555555555555', name: '青岛啤酒', quantity: 2, status: 'preparing' }],
    }] }))
    const client = new GuestApiClient(deviceKey, { fetch: send })

    await expect(client.loadTableOrders()).resolves.toHaveLength(1)
    expect(send.mock.calls[0]?.[0]).toBe('/api/guest/orders/table')
    expect(new Headers(send.mock.calls[0]?.[1]?.headers).has('idempotency-key')).toBe(false)
  })

  it('records an explicit payment-sheet exit with one idempotent abandonment request', async () => {
    const send = vi.fn(async () => jsonResponse({ data: {
      orderPublicId: 'guest-order-public-0001',
      operationalState: 'cancelled',
      paymentState: 'reconciliation_pending',
    } }))
    const client = new GuestApiClient(deviceKey, { fetch: send })

    await expect(client.abandonCheckout('guest-order-public-0001', {
      idempotencyKey: 'guest-abandon-test-0001',
    })).resolves.toMatchObject({ operationalState: 'cancelled', paymentState: 'reconciliation_pending' })
    expect(send.mock.calls[0]?.[0]).toBe('/api/guest/orders/guest-order-public-0001/abandon-checkout')
    expect(JSON.parse(String(send.mock.calls[0]?.[1]?.body))).toEqual({})
    expect(new Headers(send.mock.calls[0]?.[1]?.headers).get('idempotency-key'))
      .toBe('guest-abandon-test-0001')
  })

  it('loads the published performance timeline as a read-only guest view', async () => {
    const schedule = {
      id: 'schedule-0001', performerStageName: '李艳', performerProfile: { genres: ['流行'] },
      startsAt: '2026-08-11T12:30:00.000Z', endsAt: '2026-08-11T13:15:00.000Z',
      status: 'performing', sortOrder: 1,
    }
    const send = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => jsonResponse({ data: {
      timezone: 'Asia/Shanghai', localDate: '2026-08-11', phase: 'live',
      current: schedule, next: null, startsInSeconds: null, remainingSeconds: 900, schedules: [schedule],
    } }))
    const client = new GuestApiClient(deviceKey, { fetch: send })

    await expect(client.loadTodayPerformance()).resolves.toMatchObject({
      phase: 'live', current: { performerStageName: '李艳' },
    })
    expect(send.mock.calls[0]?.[0]).toBe('/api/guest/performances/today')
  })

  it('returns the friendly persisted rate-limit response instead of losing it as an exception', async () => {
    const send = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => jsonResponse({ data: {
      status: 'rate_limited',
      message: '我们已经收到啦，伙伴正在赶来，请稍等一下',
      retryAt: '2026-08-11T12:01:00.000Z',
    } }, 429))
    const client = new GuestApiClient(deviceKey, { fetch: send })

    await expect(client.requestService(
      { requestType: 'call_staff', detail: null },
      { idempotencyKey: 'guest-service-test-0001' },
    )).resolves.toMatchObject({ status: 'rate_limited' })
  })

  it('keeps mood as a behavior marker and validates the selected value', async () => {
    const send = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => jsonResponse({ data: {
      recorded: true, mood: 'happy', occurredAt: '2026-08-11T12:00:00.000Z',
    } }, 201))
    const client = new GuestApiClient(deviceKey, { fetch: send })

    await expect(client.recordMood('happy', { idempotencyKey: 'guest-mood-test-0001' })).resolves.toMatchObject({
      recorded: true, mood: 'happy',
    })
    expect(JSON.parse(String(send.mock.calls[0]?.[1]?.body))).toEqual({ mood: 'happy' })
  })

  it('times out a stalled request with a recoverable Chinese message', async () => {
    vi.useFakeTimers()
    const send = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }))
    const client = new GuestApiClient(deviceKey, { fetch: send, defaultTimeoutMs: 100 })
    const pending = client.searchMenu('')
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'timeout', retryable: true })

    await vi.advanceTimersByTimeAsync(100)
    await assertion
  })
})

function orderResult() {
  return {
    cart: { itemCount: 2, lineCount: 1, items: [] },
    order: {
      publicId: 'guest-order-public-0001', status: 'submitted', paymentStatus: 'pending', note: '少冰，生日桌',
      attentionRequired: true, kdsNotice: '备注已保存，付款成功后将在出品与配送页面重点提示',
    },
    settlement: { subtotalAmountMinor: 13_600, discountAmountMinor: 0, payableAmountMinor: 13_600, currency: 'CNY' },
    payment: {
      publicId: 'guest-payment-public-0001', mode: 'wechat_jsapi', provider: 'postar', method: 'jsapi',
      status: 'pending', simulated: false, providerAction: onlinePaymentAction('jsapi'),
    },
  }
}

function sharedCart(overrides: Partial<{ version: number; status: string; quantity: number }> = {}) {
  return {
    cartPublicId: 'GSC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    generation: 1,
    version: overrides.version ?? 2,
    status: overrides.status ?? 'open',
    guestWritesFrozen: false,
    lines: [{
      productId: '55555555-5555-4555-8555-555555555555',
      name: '青岛啤酒',
      quantity: overrides.quantity ?? 1,
      unitPriceMinor: 6_800,
      subtotalAmountMinor: 6_800 * (overrides.quantity ?? 1),
      currency: 'CNY',
      available: true,
      unavailableReason: null,
    }],
    totalAmountMinor: 6_800 * (overrides.quantity ?? 1),
    currency: 'CNY',
    updatedAt: '2026-08-11T12:00:00.000Z',
    allowedActions: overrides.status === 'submitted' ? [] : ['adjust', 'clear', 'checkout'],
  }
}

function onlinePaymentAction(presentation: 'jsapi' | 'qr' | 'barcode') {
  return {
    paymentId: '88888888-8888-4888-8888-888888888888',
    paymentPublicId: 'guest-payment-public-0001',
    orderPublicId: 'guest-order-public-0001',
    status: 'pending',
    presentation,
    expiresAt: '2026-08-11T12:05:00.000Z',
    payload: presentation === 'jsapi'
      ? { appId: 'wx-app-1', package: 'prepay_id=test' }
      : { qrCodeUrl: 'https://pay.example.test/order/1' },
  }
}
