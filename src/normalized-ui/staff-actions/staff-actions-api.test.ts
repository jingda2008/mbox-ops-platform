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

  it('sends only the normalized recommendation occasion with an open-table command', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 201 }))
    const api = new StaffActionsApi({ fetch: send, createIdempotencyKey: () => 'open-scene-key-0001' })

    await api.openTable({
      tableId: 'table-1',
      guestCount: 2,
      guestProfileSnapshot: { recommendationScene: 'friends' },
    })

    expect(send).toHaveBeenCalledWith('/api/table-management/sessions/open', expect.objectContaining({
      body: JSON.stringify({
        tableId: 'table-1',
        guestCount: 2,
        guestProfileSnapshot: { recommendationScene: 'friends' },
      }),
    }))
  })

  it('keeps the server reference on an unexpected order failure for staff escalation', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: 'INTERNAL_ERROR',
        message: '服务暂时不可用，请稍后重试',
        referenceId: 'req-order-17',
      },
    }), { status: 500, headers: { 'content-type': 'application/json' } }))
    const api = new StaffActionsApi({ fetch: send, createIdempotencyKey: () => 'order-error-key-0001' })

    await expect(api.submitAssistedOrder({
      tableSessionId: 'session-1',
      assistedOrderContextToken: 'T'.repeat(43),
      orderMode: 'paid',
      items: [{ productId: 'product-1', quantity: 1 }],
      settlementMode: 'immediate_payment',
    })).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      status: 500,
      referenceId: 'req-order-17',
      message: '服务暂时不可用，请稍后重试',
    })
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

  it('resumes an already-closing table without trying to begin closing twice', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }))
    const api = new StaffActionsApi({ fetch: send, createIdempotencyKey: () => 'close-key-0002' })

    await api.closeTable('session-1', 'closing')

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('/api/table-sessions/session-1/close', expect.any(Object))
    const headers = send.mock.calls[0]?.[1]?.headers as Headers
    expect(headers.get('idempotency-key')).toBe('staff-close-session-1-complete')
  })

  it('uses the explicit customer-left turnover command instead of pretending the table was paid', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: { eventId: 'turnover-1' }, meta: { replayed: false },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const api = new StaffActionsApi({ fetch: send, createIdempotencyKey: () => 'turnover-key-0001' })

    await api.closeTableAfterCustomerLeft('session-1', '顾客已离店，收款没有明确成功结果')

    const [url, request] = send.mock.calls[0]!
    expect(url).toBe('/api/table-sessions/session-1/close-after-customer-left')
    expect(request?.method).toBe('POST')
    expect(new Headers(request?.headers).get('idempotency-key')).toBe('staff-customer-left-turnover-session-1-turnover-key-0001')
    expect(request?.body).toBe(JSON.stringify({ reasonNote: '顾客已离店，收款没有明确成功结果' }))
  })

  it('loads and updates staff reservations through normalized routes', async () => {
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: {} }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: {} }), { status: 200 }))
    const api = new StaffActionsApi({ fetch: send })

    await expect(api.loadReservations()).resolves.toEqual([])
    await api.actOnReservation('reservation-1', 'confirm')
    await api.actOnReservation('reservation-1', 'complete')

    expect(send).toHaveBeenNthCalledWith(1, '/api/staff/reservations', expect.objectContaining({ method: 'GET' }))
    expect(send).toHaveBeenNthCalledWith(2, '/api/staff/reservations/reservation-1/confirm', expect.objectContaining({ method: 'POST' }))
    expect(send).toHaveBeenNthCalledWith(3, '/api/staff/reservations/reservation-1/complete', expect.objectContaining({ method: 'POST' }))
  })

  it('requests carryover and explicit history reservation scopes without substituting browser dates', async () => {
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
    const api = new StaffActionsApi({ fetch: send })

    await api.loadReservations({ range: 'carryover' })
    await api.loadReservations({
      range: 'history', from: '2026-08-20T16:00:00.000Z', to: '2026-08-22T16:00:00.000Z',
    })

    expect(send.mock.calls[0]?.[0]).toBe('/api/staff/reservations?range=carryover')
    expect(String(send.mock.calls[1]?.[0])).toContain('range=history')
    expect(String(send.mock.calls[1]?.[0])).toContain('from=2026-08-20T16%3A00%3A00.000Z')
  })

  it('requests carryover and explicit history reservation scopes without substituting browser dates', async () => {
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
    const api = new StaffActionsApi({ fetch: send })

    await api.loadReservations({ range: 'carryover' })
    await api.loadReservations({
      range: 'history', from: '2026-08-20T16:00:00.000Z', to: '2026-08-22T16:00:00.000Z',
    })

    expect(send.mock.calls[0]?.[0]).toBe('/api/staff/reservations?range=carryover')
    expect(String(send.mock.calls[1]?.[0])).toContain('range=history')
    expect(String(send.mock.calls[1]?.[0])).toContain('from=2026-08-20T16%3A00%3A00.000Z')
  })

  it('sends only supported KDS actions to the authoritative KDS endpoint', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }))
    const api = new StaffActionsApi({ fetch: send, createIdempotencyKey: () => 'kds-key-0001' })

    await api.runKdsAction('task-1', 'deliver')
    expect(send).toHaveBeenCalledWith('/api/commerce/kds/task-1/actions', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ action: 'deliver' }),
    }))

    await api.cancelKdsTask('task-2', '上一营业日误留任务，现场已核对')
    expect(send).toHaveBeenLastCalledWith('/api/commerce/kds/task-2/manager-cancel', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        reasonCode: 'prior_business_day_cleanup',
        reasonNote: '上一营业日误留任务，现场已核对',
      }),
    }))

    await api.runKdsAction('task-3', 'remake')
    expect(send).toHaveBeenLastCalledWith('/api/commerce/kds/task-3/remake', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        reasonCode: 'production_remake',
        reasonNote: '现场确认后重新制作',
      }),
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

  it('requires an explicit nullable unresolved payment id in the table collection response', async () => {
    const paymentId = '11111111-1111-4111-8111-111111111111'
    const valid = {
      id: '22222222-2222-4222-8222-222222222222',
      publicId: 'ORDER-A01-0001',
      currency: 'CNY',
      paymentStatus: 'unpaid',
      outstandingAmountMinor: 2_000,
      hasOnlinePaymentInProgress: true,
      unresolvedOnlinePaymentId: paymentId,
    }
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [valid] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{
        ...valid,
        unresolvedOnlinePaymentId: undefined,
      }] }), { status: 200 }))
    const api = new StaffActionsApi({ fetch: send })

    await expect(api.loadTablePaymentOrders?.('33333333-3333-4333-8333-333333333333')).resolves.toEqual([valid])
    await expect(api.loadTablePaymentOrders?.('33333333-3333-4333-8333-333333333333')).rejects.toMatchObject({
      code: 'INVALID_TABLE_PAYMENT_RESPONSE',
    })
  })

  it('reads only product delivery progress from the active table order-details endpoint', async () => {
    const valid = {
      publicId: 'ORDER-A01-0001',
      items: [{
        id: '22222222-2222-4222-8222-222222222222',
        productName: '金汤力',
        quantity: 2,
        fulfillmentStation: 'bar',
        fulfillmentStatus: 'ready_for_delivery',
      }],
    }
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [valid] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{
        ...valid,
        items: [{ ...valid.items[0], fulfillmentStatus: 'made_up' }],
      }] }), { status: 200 }))
    const api = new StaffActionsApi({ fetch: send })

    await expect(api.loadTableOrderDetails?.('33333333-3333-4333-8333-333333333333')).resolves.toEqual([valid])
    await expect(api.loadTableOrderDetails?.('33333333-3333-4333-8333-333333333333')).rejects.toMatchObject({
      code: 'INVALID_TABLE_ORDER_DETAILS_RESPONSE',
    })
    expect(send.mock.calls[0]?.[0]).toBe('/api/commerce/table-sessions/33333333-3333-4333-8333-333333333333/order-details')
  })

  it('records confirmed table cash collection through the existing audited manual-payment command', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: { id: '11111111-1111-4111-8111-111111111111', status: 'succeeded' },
      meta: { replayed: false },
    }), { status: 201, headers: { 'content-type': 'application/json' } }))
    const api = new StaffActionsApi({ fetch: send, createIdempotencyKey: () => 'cash-key-0001' })

    await api.recordManualPayment({
      orderId: '22222222-2222-4222-8222-222222222222',
      provider: 'cash',
      receiptReference: 'CASH-A01-20260827203000-1234abcd',
    })

    const [url, request] = send.mock.calls[0]!
    expect(url).toBe('/api/payments/manual')
    expect(request?.method).toBe('POST')
    expect(new Headers(request?.headers).get('idempotency-key')).toBe('staff-manual-payment-cash-key-0001')
    expect(JSON.parse(String(request?.body))).toEqual({
      orderId: '22222222-2222-4222-8222-222222222222',
      provider: 'cash',
      method: 'cash',
      receiptReference: 'CASH-A01-20260827203000-1234abcd',
    })
  })

  it('queries the original provider payment instead of creating another charge', async () => {
    const paymentId = '11111111-1111-4111-8111-111111111111'
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: { id: paymentId, status: 'succeeded' }, meta: { replayed: false },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const api = new StaffActionsApi({ fetch: send, createIdempotencyKey: () => 'query-key-0001' })

    await expect(api.queryOnlinePayment(paymentId)).resolves.toBe('succeeded')
    const [url, request] = send.mock.calls[0]!
    expect(url).toBe(`/api/payments/${paymentId}/provider-query`)
    expect(new Headers(request?.headers).get('idempotency-key')).toBe('staff-payment-query-query-key-0001')
    expect(request?.method).toBe('POST')
  })

  it('records an explicit unresolved-payment release before a waiter retries collection', async () => {
    const paymentId = '11111111-1111-4111-8111-111111111111'
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: { id: paymentId, status: 'pending', retryReleasedAt: '2026-08-26T10:00:00.000Z' },
      meta: { replayed: false },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const api = new StaffActionsApi({ fetch: send, createIdempotencyKey: () => 'query-close-key-0001' })

    await api.closeUnresolvedPaymentBeforeReplacement(paymentId, '顾客未确认到账，查询并关闭原线上收款')

    const [url, request] = send.mock.calls[0]!
    expect(url).toBe(`/api/payments/${paymentId}/retry-release`)
    expect(request?.method).toBe('POST')
    expect(new Headers(request?.headers).get('idempotency-key')).toBe(`staff-payment-query-close-${paymentId}-query-close-key-0001`)
    expect(request?.body).toBe(JSON.stringify({ reason: '顾客未确认到账，查询并关闭原线上收款' }))
  })

  it('only reads the persisted payment outcome for the assisted order auto-refresh', async () => {
    const paymentId = '11111111-1111-4111-8111-111111111111'
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: { id: paymentId, status: 'succeeded' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const api = new StaffActionsApi({ fetch: send })

    await expect(api.loadOnlinePaymentStatus(paymentId)).resolves.toBe('succeeded')
    const [url, request] = send.mock.calls[0]!
    expect(url).toBe(`/api/payments/${paymentId}/status`)
    expect(request?.method).toBe('GET')
    expect(new Headers(request?.headers).get('idempotency-key')).toBeNull()
  })

  it('keeps the table observation contract aligned with the server and reuses the saved urgency choice', async () => {
    const draft = {
      publicId: 'observation-0001', status: 'draft', inputKind: 'text', rawContent: '红色那杯太甜',
      parseConfidence: 0.98, needsImmediateAction: true, serviceTaskId: null,
      candidates: [{
        id: 'candidate-1', mentionIndex: 0, rawMention: '红色那杯', orderItemId: 'item-1',
        productId: 'product-1', productName: '暮色鸡尾酒', rank: 1, confidence: 0.98, matchKind: 'search_text',
      }],
      clarificationRequired: false, clarificationPrompt: null,
    }
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: draft }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: {
        publicId: draft.publicId, status: 'confirmed', serviceTaskId: 'task-1', events: [],
      } }), { status: 200 }))
    const api = new StaffActionsApi({ fetch: send, createIdempotencyKey: () => 'observation-key-0001' })

    await expect(api.parseObservation({
      tableSessionId: 'session-1', rawContent: draft.rawContent, needsImmediateAction: true,
    })).resolves.toEqual(draft)
    await expect(api.confirmObservation({
      observationPublicId: draft.publicId,
      candidateId: 'candidate-1', confidence: 0.96, rawExcerpt: draft.rawContent,
      expressionKind: 'customer_quote', eventType: 'too_sweet', degree: 'most',
    })).resolves.toEqual({ publicId: draft.publicId, status: 'confirmed', serviceTaskId: 'task-1' })

    expect(send.mock.calls[0]?.[0]).toBe('/api/staff/table-sessions/session-1/observations/parse')
    expect(JSON.parse(String(send.mock.calls[0]?.[1]?.body))).toEqual({
      inputKind: 'text', rawContent: draft.rawContent, needsImmediateAction: true,
    })
    expect(send.mock.calls[1]?.[0]).toBe('/api/staff/observations/observation-0001/confirm')
    expect(JSON.parse(String(send.mock.calls[1]?.[1]?.body))).toEqual({ events: [{
      expressionKind: 'customer_quote', scopeKind: 'product', eventType: 'too_sweet', degree: 'most', reasonCode: null,
      candidateId: 'candidate-1', confidence: 0.96, rawExcerpt: draft.rawContent,
    }] })
  })

  it('loads authoritative recent observations and sends an append-only correction with a reason', async () => {
    const event = {
      id: '83000000-0000-4000-8000-000000000011',
      eventGroupId: '83000000-0000-4000-8000-000000000012', revision: 1,
      expressionKind: 'customer_quote', scopeKind: 'product', eventType: 'too_sweet', degree: 'most',
      reasonCode: null, seatLabel: null, customerId: null, productId: '83000000-0000-4000-8000-000000000013',
      productName: '暮色鸡尾酒', orderItemId: '83000000-0000-4000-8000-000000000014',
      selectedCandidateId: '83000000-0000-4000-8000-000000000015', confidence: 0.96,
      rawExcerpt: '客人说红色那杯太甜', needsImmediateAction: true,
      serviceTaskId: '83000000-0000-4000-8000-000000000016', createdAt: '2026-08-16T12:00:00.000Z',
    } as const
    const history = {
      items: [{
        publicId: 'observation-history-0001', inputKind: 'text', rawContent: event.rawExcerpt,
        parseConfidence: 0.96, needsImmediateAction: true, serviceTaskId: event.serviceTaskId,
        serviceTaskStatus: 'assigned', recordedBy: '服务员A', confirmedBy: '服务员A',
        confirmedAt: event.createdAt, events: [event], revisions: [],
      }],
      permissions: { canCorrect: true, canViewRaw: true },
    }
    const revised = { ...event, revision: 2, eventType: 'praise' }
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: history }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: revised }), { status: 200 }))
    const api = new StaffActionsApi({ fetch: send, createIdempotencyKey: () => 'observation-revise-key-0001' })

    await expect(api.loadRecentObservations('session-1')).resolves.toEqual(history)
    await expect(api.reviseObservation({
      observationPublicId: history.items[0].publicId,
      eventId: event.id,
      reason: '客人补充说明，实际是称赞',
      replacement: {
        expressionKind: 'customer_quote', scopeKind: 'product', eventType: 'praise', degree: null,
        reasonCode: null, seatLabel: null, customerId: null, candidateId: event.selectedCandidateId,
        productId: event.productId, confidence: event.confidence, rawExcerpt: event.rawExcerpt,
      },
    })).resolves.toMatchObject({ revision: 2, eventType: 'praise' })

    expect(send.mock.calls[0]?.[0]).toBe('/api/staff/table-sessions/session-1/observations/recent')
    expect(send.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ method: 'GET' }))
    expect(send.mock.calls[1]?.[0]).toBe(`/api/staff/observations/${history.items[0].publicId}/events/${event.id}/revise`)
    const reviseRequest = send.mock.calls[1]?.[1]
    expect(new Headers(reviseRequest?.headers).get('idempotency-key')).toBe('staff-observation-revise-observation-revise-key-0001')
    expect(JSON.parse(String(reviseRequest?.body))).toMatchObject({
      reason: '客人补充说明，实际是称赞', replacement: { eventType: 'praise', candidateId: event.selectedCandidateId },
    })
  })

  it('fails closed when an observation response does not match the typed contract', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: { publicId: 'observation-0002', status: 'draft', overallConfidence: 0.9 },
    }), { status: 201 }))
    const api = new StaffActionsApi({ fetch: send })

    await expect(api.parseObservation({
      tableSessionId: 'session-1', rawContent: '记录原话', needsImmediateAction: false,
    })).rejects.toMatchObject({ code: 'INVALID_OBSERVATION_RESPONSE' })
  })

  it('loads and modifies only an existing table recommendation through the strict staff contract',async()=>{
    const session={
      recommendationPublicId:'recommendation-1',tableSessionId:'session/1',createdAt:'2026-08-16T01:00:00.000Z',
      options:[
        { productId:'product-1',productName:'舒适方案',rank:1,tier:'comfortable',amountMinor:12800,currency:'CNY' },
        { productId:'product-2',productName:'完整体验',rank:2,tier:'enhanced',amountMinor:16800,currency:'CNY' },
      ],
    }
    const modification={
      eventId:'event-1',recommendationPublicId:'recommendation-1',tableSessionId:'session/1',
      sourceProductId:'product-1',sourceProductName:'舒适方案',targetProductId:'product-2',targetProductName:'完整体验',
      reasonCode:'customer_request',employeeId:'employee-1',occurredAt:'2026-08-16T01:01:00.000Z',
    }
    const send=vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data:session }),{ status:200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data:modification }),{ status:201 }))
    const api=new StaffActionsApi({ fetch:send,createIdempotencyKey:()=> 'recommendation-key-0001' })
    await expect(api.loadTableRecommendation('session/1')).resolves.toEqual(session)
    await expect(api.modifyTableRecommendation({
      recommendationPublicId:'recommendation-1',sourceProductId:'product-1',targetProductId:'product-2',
      reasonCode:'customer_request',
    })).resolves.toEqual(modification)
    expect(send.mock.calls[0]?.[0]).toBe('/api/staff/customer-experience/recommendations?tableSessionId=session%2F1')
    const [url,request]=send.mock.calls[1]!
    expect(url).toBe('/api/staff/customer-experience/recommendations/recommendation-1/modifications')
    expect(new Headers(request?.headers).get('idempotency-key'))
      .toBe('staff-recommendation-modification-recommendation-key-0001')
    expect(JSON.parse(String(request?.body))).toEqual({
      sourceProductId:'product-1',targetProductId:'product-2',reasonCode:'customer_request',
    })
  })
})
