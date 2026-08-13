import { describe, expect, it, vi } from 'vitest'
import { StaffActionsApi, StaffActionsApiError } from './staff-actions-api'

describe('StaffActionsApi', () => {
  it('uses the normalized table command contract and never reports success from a failed response', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: { code: 'CAPACITY_OVERRIDE_REASON_REQUIRED', message: '请填写加座说明' },
    }), { status: 422, headers: { 'content-type': 'application/json' } }))
    const api = new StaffActionsApi({ fetch: send, createIdempotencyKey: () => 'open-key-0001' })

    await expect(api.openTable({ tableId: 'table-1', guestCount: 6 })).rejects.toMatchObject({
      code: 'CAPACITY_OVERRIDE_REASON_REQUIRED', status: 422,
    })
    expect(send).toHaveBeenCalledWith('/api/table-management/sessions/open', expect.objectContaining({
      method: 'POST', credentials: 'include',
    }))
    const headers = send.mock.calls[0]?.[1]?.headers as Headers
    expect(headers.get('x-idempotency-key')).toBe('staff-action-open-key-0001')
  })

  it('marks a close as partial when begin-closing succeeded but close did not', async () => {
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: {} }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'CONFLICT', message: '状态已变化' } }), {
        status: 409, headers: { 'content-type': 'application/json' },
      }))
    const api = new StaffActionsApi({ fetch: send, createIdempotencyKey: () => 'close-key-0001' })

    await expect(api.closeTable('session-1')).rejects.toEqual(expect.objectContaining({
      code: 'TABLE_CLOSE_PARTIAL', partialMutation: true,
    } satisfies Partial<StaffActionsApiError>))
    expect(send).toHaveBeenNthCalledWith(1, '/api/table-sessions/session-1/begin-closing', expect.any(Object))
    expect(send).toHaveBeenNthCalledWith(2, '/api/table-sessions/session-1/close', expect.any(Object))
    const beginHeaders = send.mock.calls[0]?.[1]?.headers as Headers
    const closeHeaders = send.mock.calls[1]?.[1]?.headers as Headers
    expect(beginHeaders.get('idempotency-key')).toBe('staff-close-session-1-begin')
    expect(closeHeaders.get('idempotency-key')).toBe('staff-close-session-1-complete')
  })

  it('loads and updates staff reservations through normalized routes', async () => {
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: {} }), { status: 200 }))
    const api = new StaffActionsApi({ fetch: send })

    await expect(api.loadReservations()).resolves.toEqual([])
    await api.actOnReservation('reservation-1', 'confirm')

    expect(send).toHaveBeenNthCalledWith(1, '/api/staff/reservations', expect.objectContaining({ method: 'GET' }))
    expect(send).toHaveBeenNthCalledWith(2, '/api/staff/reservations/reservation-1/confirm', expect.objectContaining({ method: 'POST' }))
  })

  it('sends only supported KDS actions to the authoritative KDS endpoint', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }))
    const api = new StaffActionsApi({ fetch: send, createIdempotencyKey: () => 'kds-key-0001' })

    await api.runKdsAction('task-1', 'deliver')
    expect(send).toHaveBeenCalledWith('/api/commerce/kds/task-1/actions', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ action: 'deliver' }),
    }))
  })

  it('binds assisted ordering to the current table context and sends gift mode without a client authority id', async () => {
    const token = 'T'.repeat(43)
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { token } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'order-1', orderMode: 'gift', totalAmountMinor: 0, currency: 'CNY',
        amounts: { grossAmount: 6800, discountAmount: 0, giftAmount: 6800, payableAmount: 0 },
        paymentNextStep: { status: 'deferred', action: 'settle_table_later' },
      }), { status: 201 }))
    const api = new StaffActionsApi({ fetch: send, createIdempotencyKey: () => 'gift-key-0001' })

    await expect(api.issueAssistedOrderContext({ tableSessionId: 'session-1' })).resolves.toBe(token)
    await api.submitAssistedOrder({
      tableSessionId: 'session-1', assistedOrderContextToken: token, orderMode: 'gift',
      giftReason: '生日关怀', items: [{ productId: 'product-1', quantity: 1 }],
      settlementMode: 'table_tab',
    })

    expect(send).toHaveBeenNthCalledWith(1, '/api/commerce/assisted-order-contexts', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ tableSessionId: 'session-1' }),
    }))
    const orderRequest = send.mock.calls[1]?.[1]
    const headers = orderRequest?.headers as Headers
    expect(headers.get('x-assisted-order-context')).toBe(token)
    expect(headers.get('idempotency-key')).toBe('staff-order-gift-key-0001')
    expect(orderRequest?.body).toBe(JSON.stringify({
      tableSessionId: 'session-1', assistedOrderContextToken: token, orderMode: 'gift',
      giftReason: '生日关怀', items: [{ productId: 'product-1', quantity: 1 }],
      settlementMode: 'table_tab',
    }))
    expect(String(orderRequest?.body)).not.toContain('sourceId')
  })

  it('starts exactly the staff-selected payment path for the assisted order', async () => {
    const providerAction = {
      paymentId: '11111111-1111-4111-8111-111111111111',
      paymentPublicId: 'PSTAFF0001',
      orderPublicId: 'OSTAFF0001',
      status: 'pending',
      presentation: 'barcode',
      expiresAt: '2026-08-13T13:05:00.000Z',
      payload: { providerState: 'processing' },
    }
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: { providerAction }, meta: { replayed: false },
    }), { status: 201, headers: { 'content-type': 'application/json' } }))
    const api = new StaffActionsApi({ fetch: send, createIdempotencyKey: () => 'payment-key-0001' })

    await expect(api.createOnlinePayment({
      orderId: '22222222-2222-4222-8222-222222222222',
      provider: 'postar',
      method: 'auth_code',
      customerAuthCode: '134567890123456789',
    })).resolves.toEqual(providerAction)

    const [, request] = send.mock.calls[0]!
    expect(send.mock.calls[0]?.[0]).toBe('/api/payments')
    expect(new Headers(request?.headers).get('idempotency-key')).toBe('staff-payment-payment-key-0001')
    expect(JSON.parse(String(request?.body))).toEqual({
      orderId: '22222222-2222-4222-8222-222222222222',
      provider: 'postar',
      method: 'auth_code',
      customerAuthCode: '134567890123456789',
    })
  })
})
