import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IdempotencyConflictError } from './command-executor.js'
import {
  paymentApiPlugin,
  PaymentProviderVerificationError,
  type PaymentApiOptions,
} from './payment-api.js'
import type { Payment } from './payment-repository.js'
import { OrderNotPayableError } from './payment-repository.js'
import { PaymentAuthorizationError } from './payment-security-policy.js'
import type { ReconciliationEntry } from './reconciliation-repository.js'
import { RefundApprovalRequiredError, type Refund } from './refund-repository.js'
import type { CashierWorkbenchView } from '../../src/shared/cashier-workbench-contracts.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const employeeId = '33333333-3333-4333-8333-333333333333'
const verifiedPaymentObservationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const verifiedRefundObservationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const requesterId = '44444444-4444-4444-8444-444444444444'
const paymentId = '55555555-5555-4555-8555-555555555555'
const refundId = '66666666-6666-4666-8666-666666666666'
const orderId = '77777777-7777-4777-8777-777777777777'
const orderItemId = '88888888-8888-4888-8888-888888888888'
const tableSessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const customerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const guestSessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const trustedMerchant = {
  provider: 'postar' as const,
  agencyId: 'FWH000030224',
  merchantId: '60000001067349',
  scope: { tenantId, storeId },
  integrationRef: 'postar-payment-callback',
}

const payment: Payment = {
  id: paymentId,
  payableKind: 'order',
  orderId,
  activityRegistrationId: null,
  publicId: 'payment-public-0001',
  provider: 'postar',
  providerTransactionId: null,
  settlementChannel: null,
  method: 'native_qr',
  amountMinor: 8_800,
  currency: 'CNY',
  status: 'pending',
  providerSnapshot: {},
  succeededAt: null,
  createdAt: '2026-08-11T12:00:00.000Z',
  updatedAt: '2026-08-11T12:00:00.000Z',
}

const refund: Refund = {
  id: refundId,
  paymentId,
  orderId,
  paymentProvider: 'postar',
  publicId: 'refund-public-0001',
  providerRefundId: null,
  amountMinor: 1_000,
  currency: 'CNY',
  status: 'requested',
  reason: '客人退回一项未出品商品',
  requestedByEmployeeId: requesterId,
  approvedByEmployeeId: null,
  decisionReason: null,
  allocations: [{ orderItemId, amountMinor: 1_000 }],
  providerSnapshot: {},
  completedAt: null,
  createdAt: '2026-08-11T12:10:00.000Z',
  updatedAt: '2026-08-11T12:10:00.000Z',
}

const reconciliationEntry: ReconciliationEntry = {
  id: '99999999-9999-4999-8999-999999999999',
  paymentId,
  refundId: null,
  entryType: 'payment',
  provider: 'postar',
  providerReference: 'POSTAR-TX-0001',
  amountMinor: 8_800,
  currency: 'CNY',
  businessDate: '2026-08-11',
  occurredAt: '2026-08-11T12:05:00.000Z',
  evidenceSnapshot: { signatureVerified: true },
  createdAt: '2026-08-11T12:05:00.000Z',
}

const cashierWorkbench: CashierWorkbenchView = {
  businessDate: '2026-08-11',
  query: 'VIP1',
  actions: {
    canRequestRefund: false,
    canApproveRefund: false,
    canExecuteRefund: false,
    canViewReconciliation: true,
  },
  summary: {
    orderCount: 1,
    capturedPaymentCount: 1,
    requestedRefundCount: 1,
    processingRefundCount: 0,
  },
  orders: [],
}

const apps: FastifyInstance[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

function fixture(overrides: Partial<PaymentApiOptions> = {}) {
  const commands = {
    initiate: vi.fn(async (
      _input: Parameters<PaymentApiOptions['commands']['initiate']>[0],
    ) => ({ value: payment, replayed: false })),
    recordManual: vi.fn(async () => ({ value: { ...payment, status: 'succeeded' as const }, replayed: false })),
    recordSucceededCallback: vi.fn(async (
      _input: Parameters<PaymentApiOptions['commands']['recordSucceededCallback']>[0],
    ) => ({
      value: {
        ...payment,
        providerTransactionId: 'POSTAR-TX-0001',
        status: 'succeeded' as const,
      },
      replayed: false,
    })),
    recordProviderQueryResult: vi.fn(async () => ({
      value: {
        ...payment,
        providerTransactionId: 'POSTAR-TX-0001',
        status: 'succeeded' as const,
      },
      replayed: false,
    })),
    requestRefund: vi.fn(async () => ({ value: refund, replayed: false })),
    approveRefund: vi.fn(async () => ({
      value: { ...refund, status: 'approved' as const, approvedByEmployeeId: employeeId },
      replayed: false,
    })),
    rejectRefund: vi.fn(async () => ({
      value: { ...refund, status: 'rejected' as const, approvedByEmployeeId: employeeId },
      replayed: false,
    })),
    beginRefundExecution: vi.fn(async () => ({
      value: { ...refund, status: 'processing' as const, approvedByEmployeeId: employeeId },
      replayed: false,
    })),
    recordProviderRefundResult: vi.fn(async (
      _input: Parameters<PaymentApiOptions['commands']['recordProviderRefundResult']>[0],
    ) => ({
      value: {
        ...refund,
        status: 'succeeded' as const,
        approvedByEmployeeId: employeeId,
        decisionReason: '同意退回未出品商品',
        providerRefundId: 'POSTAR-REFUND-0001',
      },
      replayed: false,
    })),
    recordManualRefundResult: vi.fn(async (
      _input: Parameters<PaymentApiOptions['commands']['recordManualRefundResult']>[0],
    ) => ({
      value: {
        ...refund,
        status: 'succeeded' as const,
        approvedByEmployeeId: employeeId,
        providerRefundId: 'POSTAR-REFUND-0001',
      },
      replayed: false,
    })),
  }
  const providerVerifier = {
    verifyPaymentCallback: vi.fn(async () => ({
      eventId: 'postar-payment-event-0001',
      merchant: trustedMerchant,
      businessIdentity: 'postar-payment-business-0001',
      paymentPublicId: payment.publicId,
      providerTransactionId: 'POSTAR-TX-0001',
      amountMinor: 8_800,
      currency: 'CNY',
      settlementChannel: 'wechat' as const,
      occurredAt: '2026-08-11T12:05:00.000Z',
      evidence: {
        tradeState: 'SUCCESS',
        signature: 'must-not-pass-through',
        customerOpenId: 'must-not-pass-through',
      },
    })),
    verifyRefundCallback: vi.fn(async () => ({
      eventId: 'postar-refund-event-0001',
      merchant: trustedMerchant,
      businessIdentity: 'postar-refund-business-0001',
      refundPublicId: refund.publicId,
      provider: 'postar' as const,
      succeeded: true,
      providerRefundId: 'POSTAR-REFUND-0001',
      originalProviderTransactionId: 'POSTAR-TX-0001',
      amountMinor: 1_000,
      currency: 'CNY',
      occurredAt: '2026-08-11T12:20:00.000Z',
      evidence: { refundState: 'SUCCESS' },
    })),
  }
  const reconciliationQuery = {
    list: vi.fn(async () => ({ entries: [reconciliationEntry], nextCursor: null })),
  }
  const cashierWorkbenchQuery = {
    get: vi.fn(async () => cashierWorkbench),
  }
  const orderCancellation = {
    cancel: vi.fn(async () => ({
      eventId: '55555555-5555-4555-8555-555555555555',
      orderPublicId: 'ORDER-VIP1-0001',
      sourceBusinessDate: '2026-08-10',
      actionBusinessDate: '2026-08-11',
      deliveredItemCount: 1,
      cancelledItemCount: 0,
      cancelledKdsTaskCount: 0,
      releasedInventoryReservationCount: 0,
      occurredAt: '2026-08-11T12:30:00.000Z',
      replayed: false,
    })),
  }
  const orderSettlementException = {
    settle: vi.fn(async () => ({
      eventId: '66666666-6666-4666-8666-666666666666',
      orderPublicId: 'ORDER-VIP1-0001',
      sourceBusinessDate: '2026-08-10',
      actionBusinessDate: '2026-08-11',
      settledAmountMinor: 1_000,
      occurredAt: '2026-08-11T12:31:00.000Z',
      replayed: false,
    })),
  }
  const providerObservations = {
    recordPayment: vi.fn(async () => verifiedPaymentObservationId),
    recordRefund: vi.fn(async () => verifiedRefundObservationId),
  }
  const options: PaymentApiOptions = {
    commands,
    providerVerifier,
    providerObservations,
    reconciliationQuery,
    cashierWorkbenchQuery,
    orderCancellation,
    orderSettlementException,
    resolveActorContext: () => ({
      scope: { tenantId, storeId },
      actor: { type: 'guest', ref: `guest-session:${guestSessionId}` },
      businessDate: '2026-08-11',
      tableSessionId,
      customerId,
    }),
    resolveStaffContext: () => ({
      scope: { tenantId, storeId },
      actor: { type: 'employee', employeeId },
      employeeId,
      businessDate: '2026-08-11',
      capabilities: ['reconciliation.view'],
    }),
    resolveProviderBusinessDate: () => '2026-08-11',
    createPublicId: (kind) => `${kind}-generated-0001`,
    ...overrides,
  }
  const app = Fastify()
  apps.push(app)
  app.register(paymentApiPlugin, { ...options, prefix: '/api' })
  return {
    app, options, commands, providerVerifier, providerObservations,
    reconciliationQuery, cashierWorkbenchQuery, orderCancellation, orderSettlementException,
  }
}

describe('paymentApiPlugin', () => {
  it('initiates an online payment with a server-resolved actor and idempotency boundary', async () => {
    const value = fixture()
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/payments',
      headers: { 'idempotency-key': 'payment-init-0001' },
      payload: {
        orderId,
        provider: 'postar',
        method: 'native_qr',
      providerSnapshot: { channel: 'QR' },
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toEqual({ data: { ...payment, providerAction: null }, meta: { replayed: false } })
    expect(value.commands.initiate).toHaveBeenCalledWith(expect.objectContaining({
      scope: { tenantId, storeId },
      actor: { type: 'guest', ref: `guest-session:${guestSessionId}` },
      businessDate: '2026-08-11',
      idempotencyKey: 'payment-init-0001',
      orderId,
      publicId: 'payment-generated-0001',
      provider: 'postar',
      method: 'native_qr',
      principal: { type: 'guest', tableSessionId, customerId, guestSessionId },
      providerSnapshot: { channel: 'QR' },
    }))
    const initiatedCommand = value.commands.initiate.mock.calls[0]?.[0]
    expect(initiatedCommand).toBeDefined()
    expect(initiatedCommand?.requestFingerprint).toContain(orderId)
  })

  it('cancels an unpaid order only through the scoped staff command', async () => {
    const value = fixture({
      resolveStaffContext: () => ({
        scope: { tenantId, storeId },
        actor: { type: 'employee', employeeId },
        employeeId,
        businessDate: '2026-08-11',
        capabilities: ['reconciliation.view', 'order.cancel_unpaid'],
      }),
    })
    const response = await value.app.inject({
      method: 'POST',
      url: `/api/orders/${orderId}/cancel-unpaid`,
      headers: { 'idempotency-key': 'cancel-unpaid-order-0001' },
      payload: { reasonCode: 'guest_left', reasonNote: '客人离店，现场确认未付款' },
    })

    expect(response.statusCode).toBe(200)
    expect(value.orderCancellation.cancel).toHaveBeenCalledWith(expect.objectContaining({
      scope: { tenantId, storeId }, orderId, employeeId,
      businessDate: '2026-08-11', reasonCode: 'guest_left',
      reasonNote: '客人离店，现场确认未付款', idempotencyKey: 'cancel-unpaid-order-0001',
    }))
  })

  it('rejects unpaid cancellation without the dedicated permission', async () => {
    const value = fixture({
      resolveStaffContext: () => ({
        scope: { tenantId, storeId },
        actor: { type: 'employee', employeeId },
        employeeId,
        businessDate: '2026-08-11',
        capabilities: ['reconciliation.view'],
      }),
    })
    const response = await value.app.inject({
      method: 'POST',
      url: `/api/orders/${orderId}/cancel-unpaid`,
      headers: { 'idempotency-key': 'cancel-unpaid-order-denied-0001' },
      payload: { reasonCode: 'guest_left', reasonNote: '客人离店，现场确认未付款' },
    })

    expect(response.statusCode).toBe(403)
    expect(value.orderCancellation.cancel).not.toHaveBeenCalled()
  })

  it('records a delivered unpaid settlement exception only through the dedicated manager command', async () => {
    const value = fixture({
      resolveStaffContext: () => ({
        scope: { tenantId, storeId }, actor: { type: 'employee', employeeId }, employeeId,
        businessDate: '2026-08-11', capabilities: ['reconciliation.view', 'order.settle_exception'],
      }),
    })
    const response = await value.app.inject({
      method: 'POST', url: `/api/orders/${orderId}/settle-exception`,
      headers: { 'idempotency-key': 'settle-exception-order-0001' },
      payload: { reasonCode: 'manager_comp', reasonNote: '店长确认本单免单结清' },
    })
    expect(response.statusCode).toBe(200)
    expect(value.orderSettlementException.settle).toHaveBeenCalledWith(expect.objectContaining({
      scope: { tenantId, storeId }, orderId, employeeId, businessDate: '2026-08-11',
      reasonCode: 'manager_comp', reasonNote: '店长确认本单免单结清',
      idempotencyKey: 'settle-exception-order-0001',
    }))
  })

  it('rejects settlement exception without its dedicated permission', async () => {
    const value = fixture()
    const response = await value.app.inject({
      method: 'POST', url: `/api/orders/${orderId}/settle-exception`,
      headers: { 'idempotency-key': 'settle-exception-denied-0001' },
      payload: { reasonCode: 'manager_comp', reasonNote: '店长确认本单免单结清' },
    })
    expect(response.statusCode).toBe(403)
    expect(value.orderSettlementException.settle).not.toHaveBeenCalled()
  })

  it('rejects a new online payment when the store operating policy is closed', async () => {
    const value = fixture({ resolveOnlinePaymentAvailable: vi.fn(async () => false) })
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/payments',
      headers: { 'idempotency-key': 'payment-policy-closed-0001' },
      payload: { orderId, provider: 'postar', method: 'native_qr' },
    })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ error: { code: 'ONLINE_PAYMENT_UNAVAILABLE' } })
    expect(value.commands.initiate).not.toHaveBeenCalled()
  })

  it('keeps verified callbacks and human refund handling available after new payment initiation is closed', async () => {
    const resolveOnlinePaymentAvailable = vi.fn(async () => false)
    const value = fixture({ resolveOnlinePaymentAvailable })

    const callback = await value.app.inject({
      method: 'POST',
      url: '/api/payments/providers/postar/callback',
      payload: { delivery: 'in-flight-payment-after-policy-close' },
    })
    const refundRequest = await value.app.inject({
      method: 'POST',
      url: `/api/payments/${paymentId}/refunds`,
      headers: { 'idempotency-key': 'refund-after-policy-close-0001' },
      payload: {
        reason: '支付开关关闭后继续处理已收款订单退款',
        allocations: [{ orderItemId, amountMinor: 1_000 }],
      },
    })

    expect(callback.statusCode).toBe(200)
    expect(refundRequest.statusCode).toBe(201)
    expect(value.commands.recordSucceededCallback).toHaveBeenCalledOnce()
    expect(value.commands.requestRefund).toHaveBeenCalledOnce()
    expect(resolveOnlinePaymentAvailable).not.toHaveBeenCalled()
  })

  it('reuses the one active payment for the same order and presentation', async () => {
    const action = {
      paymentId, paymentPublicId: payment.publicId, orderPublicId: 'OORDER0001',
      status: 'pending' as const, presentation: 'qr' as const,
      expiresAt: '2026-08-11T12:05:00.000Z',
      payload: { qrCodeUrl: 'https://pay.example.test/order/1' },
    }
    const onlinePayments = {
      assertAvailable: vi.fn(),
      resolveActivePayment: vi.fn(async () => ({
        id: payment.id, orderId: payment.orderId, orderPublicId: 'OORDER0001',
        publicId: payment.publicId, provider: payment.provider, providerTransactionId: null,
        method: payment.method,
        amountMinor: payment.amountMinor, currency: payment.currency, status: payment.status,
        tableSessionId, tableCode: 'W01', createdAt: payment.createdAt,
      })),
      create: vi.fn(async () => action),
      query: vi.fn(),
    }
    const value = fixture({
      resolveActorContext: () => ({
        scope: { tenantId, storeId }, actor: { type: 'employee', employeeId }, businessDate: '2026-08-11',
      }),
      commands: {
        ...fixtureCommands(),
        initiate: vi.fn(async () => { throw new OrderNotPayableError(orderId, 'another payment is already pending') }),
      },
      onlinePayments,
    })
    const response = await value.app.inject({
      method: 'POST', url: '/api/payments',
      headers: { 'idempotency-key': 'payment-resume-0001' },
      payload: { orderId, provider: 'postar', method: 'native_qr' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ data: { id: paymentId, providerAction: action }, meta: { replayed: true } })
    expect(onlinePayments.create).toHaveBeenCalledWith(expect.objectContaining({ paymentId }))
  })

  it('does not switch an active payment to a different staff collection method', async () => {
    const value = fixture({
      resolveActorContext: () => ({
        scope: { tenantId, storeId }, actor: { type: 'employee', employeeId }, businessDate: '2026-08-11',
      }),
      commands: {
        ...fixtureCommands(),
        initiate: vi.fn(async () => { throw new OrderNotPayableError(orderId, 'another payment is already pending') }),
      },
      onlinePayments: {
        assertAvailable: vi.fn(),
        resolveActivePayment: vi.fn(async () => ({
          id: payment.id, orderId: payment.orderId, orderPublicId: 'OORDER0001',
          publicId: payment.publicId, provider: payment.provider, providerTransactionId: null,
          method: 'native_qr' as const,
          amountMinor: payment.amountMinor, currency: payment.currency, status: payment.status,
          tableSessionId, tableCode: 'W01', createdAt: payment.createdAt,
        })),
        create: vi.fn(),
        query: vi.fn(),
      },
    })
    const response = await value.app.inject({
      method: 'POST', url: '/api/payments',
      headers: { 'idempotency-key': 'payment-switch-0001' },
      payload: { orderId, provider: 'postar', method: 'auth_code', customerAuthCode: '134567890123456789' },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: { code: 'PAYMENT_METHOD_LOCKED' } })
  })

  it('keeps guest and employee payment methods inside their real operating channels', async () => {
    const guest = fixture()
    const guestResponse = await guest.app.inject({
      method: 'POST', url: '/api/payments',
      headers: { 'idempotency-key': 'guest-forged-barcode-0001' },
      payload: { orderId, provider: 'postar', method: 'auth_code', customerAuthCode: '134567890123456789' },
    })
    expect(guestResponse.statusCode).toBe(403)
    expect(guest.commands.initiate).not.toHaveBeenCalled()

    const employee = fixture({ resolveActorContext: () => ({
      scope: { tenantId, storeId }, actor: { type: 'employee', employeeId }, businessDate: '2026-08-11',
    }) })
    const employeeResponse = await employee.app.inject({
      method: 'POST', url: '/api/payments',
      headers: { 'idempotency-key': 'staff-forged-jsapi-0001' },
      payload: { orderId, provider: 'postar', method: 'jsapi' },
    })
    expect(employeeResponse.statusCode).toBe(400)
    expect(employee.commands.initiate).not.toHaveBeenCalled()
  })

  it('actively queries a signed provider result and applies it through the command boundary', async () => {
    const query = vi.fn(async () => ({
      context: {
        id: payment.id,
        orderId: payment.orderId,
        orderPublicId: 'OORDER0001',
        publicId: payment.publicId,
        provider: payment.provider,
        providerTransactionId: null,
        method: payment.method,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        status: payment.status,
        tableSessionId,
        tableCode: 'W01',
        createdAt: payment.createdAt,
      },
      observation: {
        paymentIntentId: payment.publicId,
        providerTransactionId: 'POSTAR-TX-0001',
        status: 'succeeded' as const,
        amount: payment.amountMinor,
        providerReportedAmount: payment.amountMinor,
        currency: payment.currency,
        settlementChannel: 'wechat' as const,
        merchantId: trustedMerchant.merchantId,
        occurredAt: '2026-08-11T12:05:00.000Z',
      },
      verifiedObservationId: verifiedPaymentObservationId,
    }))
    const value = fixture({
      onlinePayments: {
        assertAvailable: vi.fn(),
        resolveActivePayment: vi.fn(),
        create: vi.fn(),
        query,
      },
    })
    const response = await value.app.inject({
      method: 'POST',
      url: `/api/payments/${paymentId}/provider-query`,
      headers: { 'idempotency-key': 'provider-query-0001' },
      payload: {},
    })

    expect(response.statusCode).toBe(200)
    expect(query).toHaveBeenCalledWith(expect.objectContaining({
      paymentId,
      queryBindingId: 'provider-query-0001',
      principal: { type: 'guest', tableSessionId, customerId, guestSessionId },
    }))
    expect(value.commands.recordProviderQueryResult).toHaveBeenCalledWith(expect.objectContaining({
      actor: { type: 'integration', ref: 'postar-active-query' },
      paymentPublicId: payment.publicId,
      providerTransactionId: 'POSTAR-TX-0001',
      status: 'succeeded',
      settlementChannel: 'wechat',
      providerSnapshot: expect.objectContaining({
        providerReportedAmountMinor: payment.amountMinor,
      }),
      verifiedObservationId: verifiedPaymentObservationId,
    }))
  })

  it('lets a reconciliation-authorized employee query an unresolved payment without relying on a guest session', async () => {
    const query = vi.fn(async () => ({
      context: {
        id: payment.id, orderId: payment.orderId, orderPublicId: 'OORDER0001',
        publicId: payment.publicId, provider: payment.provider, providerTransactionId: null,
        method: payment.method, amountMinor: payment.amountMinor, currency: payment.currency,
        status: 'pending' as const, tableSessionId, tableCode: 'W01', createdAt: payment.createdAt,
      },
      observation: {
        paymentIntentId: payment.publicId, providerTransactionId: 'POSTAR-TX-0002',
        status: 'pending' as const, amount: payment.amountMinor,
        providerReportedAmount: payment.amountMinor, currency: payment.currency,
        settlementChannel: 'wechat' as const, merchantId: trustedMerchant.merchantId,
        occurredAt: '2026-08-11T12:06:00.000Z',
      },
      verifiedObservationId: verifiedPaymentObservationId,
    }))
    const value = fixture({
      resolveActorContext: () => ({
        scope: { tenantId, storeId }, actor: { type: 'employee', employeeId }, businessDate: '2026-08-11',
      }),
      onlinePayments: { assertAvailable: vi.fn(), resolveActivePayment: vi.fn(), create: vi.fn(), query },
    })
    const response = await value.app.inject({
      method: 'POST', url: `/api/payments/${paymentId}/provider-query`,
      headers: { 'idempotency-key': 'staff-provider-query-0001' }, payload: {},
    })

    expect(response.statusCode).toBe(200)
    expect(query).toHaveBeenCalledWith(expect.objectContaining({
      principal: { type: 'employee', employeeId },
    }))
  })

  it('refuses staff provider query without reconciliation permission', async () => {
    const value = fixture({
      resolveActorContext: () => ({
        scope: { tenantId, storeId }, actor: { type: 'employee', employeeId }, businessDate: '2026-08-11',
      }),
      resolveStaffContext: () => ({
        scope: { tenantId, storeId }, actor: { type: 'employee', employeeId }, employeeId,
        businessDate: '2026-08-11', capabilities: ['payment.manual.cash.record'],
      }),
      onlinePayments: { assertAvailable: vi.fn(), resolveActivePayment: vi.fn(), create: vi.fn(), query: vi.fn() },
    })
    const response = await value.app.inject({
      method: 'POST', url: `/api/payments/${paymentId}/provider-query`,
      headers: { 'idempotency-key': 'staff-provider-query-denied-0001' }, payload: {},
    })

    expect(response.statusCode).toBe(403)
  })

  it('records cash or physical POS evidence with the authenticated employee, not a body actor', async () => {
    const value = fixture()
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/payments/manual',
      headers: { 'idempotency-key': 'manual-pos-0001' },
      payload: {
        orderId,
        provider: 'physical_pos',
        method: 'card',
        receiptReference: 'POS-RECEIPT-0001',
        terminalId: 'POS-01',
        occurredAt: '2026-08-11T12:04:00.000Z',
      },
    })

    expect(response.statusCode).toBe(201)
    expect(value.commands.recordManual).toHaveBeenCalledWith(expect.objectContaining({
      actor: { type: 'employee', employeeId },
      evidence: {
        receiptReference: 'POS-RECEIPT-0001',
        terminalId: 'POS-01',
        collectedByEmployeeId: employeeId,
      },
    }))

    const forged = await value.app.inject({
      method: 'POST',
      url: '/api/payments/manual',
      headers: { 'idempotency-key': 'manual-pos-0002' },
      payload: {
        actorId: requesterId,
        orderId,
        provider: 'physical_pos',
        method: 'card',
        receiptReference: 'POS-RECEIPT-0002',
        occurredAt: '2026-08-11T12:04:00.000Z',
      },
    })
    expect(forged.statusCode).toBe(403)
    expect(forged.json()).toMatchObject({ error: { code: 'ACTOR_BINDING_FORBIDDEN' } })
    expect(value.commands.recordManual).toHaveBeenCalledTimes(1)
  })

  it('never trusts callback body verification flags and calls no command when server verification fails', async () => {
    const verifier = {
      verifyPaymentCallback: vi.fn(async () => {
        throw new PaymentProviderVerificationError('星驿商户未绑定门店')
      }),
      verifyRefundCallback: vi.fn(),
    }
    const value = fixture({ providerVerifier: verifier })
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/payments/providers/postar/callback',
      payload: {
        paymentId,
        signatureVerified: true,
        providerTransactionId: 'FORGED',
      },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({
      error: { code: 'PROVIDER_SIGNATURE_INVALID', message: '支付机构通知验签失败' },
    })
    expect(value.commands.recordSucceededCallback).not.toHaveBeenCalled()
  })

  it('derives callback idempotency from the verified provider event and strips sensitive evidence', async () => {
    const value = fixture()
    const first = await value.app.inject({
      method: 'POST',
      url: '/api/payments/providers/postar/callback',
      headers: {
        authorization: 'provider-secret-header',
        'content-type': 'application/json',
      },
      payload: '{"any" : "untrusted-provider-body"}',
    })
    const second = await value.app.inject({
      method: 'POST',
      url: '/api/payments/providers/postar/callback',
      payload: { delivery: 2 },
    })

    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    const firstCommand = value.commands.recordSucceededCallback.mock.calls[0]?.[0]
    const secondCommand = value.commands.recordSucceededCallback.mock.calls[1]?.[0]
    expect(firstCommand).toBeDefined()
    expect(secondCommand).toBeDefined()
    expect(firstCommand?.idempotencyKey).toBe(secondCommand?.idempotencyKey)
    expect(firstCommand).toMatchObject({
      actor: { type: 'integration', ref: 'postar-payment-callback' },
      paymentPublicId: payment.publicId,
      provider: 'postar',
      providerTransactionId: 'POSTAR-TX-0001',
      reportedAmountMinor: 8_800,
      reportedCurrency: 'CNY',
      settlementChannel: 'wechat',
      verifiedObservationId: verifiedPaymentObservationId,
      providerSnapshot: {
        tradeState: 'SUCCESS',
        eventId: 'postar-payment-event-0001',
        occurredAt: '2026-08-11T12:05:00.000Z',
      },
    })
    expect(JSON.stringify(firstCommand)).not.toContain('provider-secret-header')
    expect(JSON.stringify(firstCommand)).not.toContain('must-not-pass-through')
    expect(value.providerVerifier.verifyPaymentCallback).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'postar',
      rawBody: Buffer.from('{"any" : "untrusted-provider-body"}'),
      headers: expect.objectContaining({ authorization: 'provider-secret-header' }),
    }))
  })

  it('keeps refund request, human decision and execution as separate HTTP commands', async () => {
    const value = fixture({
      onlinePayments: {
        create: vi.fn(), query: vi.fn(), assertAvailable: vi.fn(), resolveActivePayment: vi.fn(),
        requestRefund: vi.fn(async () => ({
          refundId, refundPublicId: refund.publicId,
          merchantRefundId: refundId.replaceAll('-', ''),
          paymentPublicId: payment.publicId,
          originalProviderTransactionId: 'POSTAR-TX-0001',
          amountMinor: refund.amountMinor, currency: refund.currency,
          observation: {
            refundId: refundId.replaceAll('-', ''),
            providerRefundId: refundId.replaceAll('-', ''),
            providerRefundTransactionId: null,
            originalProviderTransactionId: 'POSTAR-TX-0001',
            status: 'processing', amount: refund.amountMinor, currency: refund.currency,
            occurredAt: '2026-08-11T12:20:00.000Z',
          },
          verifiedObservationId: null,
        })),
        queryRefund: vi.fn(),
      },
    })
    const requested = await value.app.inject({
      method: 'POST',
      url: `/api/payments/${paymentId}/refunds`,
      headers: { 'idempotency-key': 'refund-request-0001' },
      payload: {
        reason: '客人退回一项未出品商品',
        allocations: [{ orderItemId, amountMinor: 1_000 }],
        requestEvidence: {
          reasonCode: 'NOT_PRODUCED',
          signatureVerified: true,
          providerStatus: 'SUCCESS',
        },
      },
    })
    const approved = await value.app.inject({
      method: 'POST',
      url: `/api/refunds/${refundId}/approve`,
      headers: { 'idempotency-key': 'refund-approve-0001' },
      payload: { reason: '商品未出品，同意退款' },
    })
    const executed = await value.app.inject({
      method: 'POST',
      url: `/api/refunds/${refundId}/execute`,
      headers: { 'idempotency-key': 'refund-execute-0001' },
    })

    expect(requested.statusCode).toBe(201)
    expect(approved.statusCode).toBe(200)
    expect(executed.statusCode).toBe(200)
    expect(value.commands.requestRefund).toHaveBeenCalledWith(expect.objectContaining({
      actor: { type: 'employee', employeeId },
      paymentId,
      allocations: [{ orderItemId, amountMinor: 1_000 }],
      requestEvidence: { reasonCode: 'NOT_PRODUCED' },
    }))
    expect(value.commands.approveRefund).toHaveBeenCalledWith(expect.objectContaining({ refundId }))
    expect(value.commands.beginRefundExecution).toHaveBeenCalledWith(expect.objectContaining({ refundId }))
    expect(value.commands.approveRefund).toHaveBeenCalledWith(expect.objectContaining({
      refundId,
      decisionReason: '商品未出品，同意退款',
    }))
    expect(value.commands.recordProviderRefundResult).not.toHaveBeenCalled()
    expect(value.commands.recordManualRefundResult).not.toHaveBeenCalled()
  })

  it('closes a refund as failed when the provider synchronously rejects execute', async () => {
    const merchantRefundId = refundId.replaceAll('-', '')
    const requestRefund = vi.fn(async () => ({
      refundId, refundPublicId: refund.publicId, merchantRefundId,
      paymentPublicId: payment.publicId,
      originalProviderTransactionId: 'POSTAR-TX-0001',
      amountMinor: refund.amountMinor, currency: refund.currency,
      observation: {
        refundId: merchantRefundId, providerRefundId: merchantRefundId,
        providerRefundTransactionId: null,
        originalProviderTransactionId: 'POSTAR-TX-0001',
        status: 'failed' as const, amount: refund.amountMinor, currency: refund.currency,
        failureReason: '021000: 商户余额不足',
        occurredAt: '2026-08-11T12:20:00.000Z',
      },
      verifiedObservationId: verifiedRefundObservationId,
    }))
    const value = fixture({
      onlinePayments: {
        create: vi.fn(), query: vi.fn(), assertAvailable: vi.fn(), resolveActivePayment: vi.fn(),
        requestRefund, queryRefund: vi.fn(),
      },
    })
    await value.app.inject({
      method: 'POST',
      url: `/api/refunds/${refundId}/approve`,
      headers: { 'idempotency-key': 'refund-approve-failed-0001' },
      payload: { reason: '商品未出品，同意退款' },
    })
    const executed = await value.app.inject({
      method: 'POST',
      url: `/api/refunds/${refundId}/execute`,
      headers: { 'idempotency-key': 'refund-execute-failed-0001' },
    })

    expect(executed.statusCode).toBe(200)
    expect(value.commands.recordProviderRefundResult).toHaveBeenCalledWith(expect.objectContaining({
      succeeded: false,
      verifiedObservationId: verifiedRefundObservationId,
      providerSnapshot: expect.objectContaining({ failureReason: '021000: 商户余额不足' }),
    }))
  })

  it('writes a terminal refund only from a bound provider query', async () => {
    const merchantRefundId = refundId.replaceAll('-', '')
    const queryRefund = vi.fn(async () => ({
      refundId, refundPublicId: refund.publicId, merchantRefundId,
      paymentPublicId: payment.publicId,
      originalProviderTransactionId: 'POSTAR-TX-0001',
      amountMinor: refund.amountMinor, currency: refund.currency,
      observation: {
        refundId: merchantRefundId, providerRefundId: merchantRefundId,
        providerRefundTransactionId: 'POSTAR-REFUND-TX-0001',
        originalProviderTransactionId: 'POSTAR-TX-0001',
        status: 'succeeded' as const, amount: refund.amountMinor, currency: refund.currency,
        occurredAt: '2026-08-11T12:21:00.000Z',
      },
      verifiedObservationId: verifiedRefundObservationId,
    }))
    const onlinePayments = {
      create: vi.fn(), query: vi.fn(), assertAvailable: vi.fn(), resolveActivePayment: vi.fn(),
      requestRefund: vi.fn(), queryRefund,
    }
    const value = fixture({
      onlinePayments,
      resolveStaffContext: () => ({
        scope: { tenantId, storeId }, actor: { type: 'employee' as const, employeeId },
        employeeId, businessDate: '2026-08-11', capabilities: ['refund.execute'],
      }),
    })
    const response = await value.app.inject({
      method: 'POST', url: `/api/refunds/${refundId}/provider-query`,
      headers: { 'idempotency-key': 'refund-provider-query-0001' },
    })

    expect(response.statusCode).toBe(200)
    expect(queryRefund).toHaveBeenCalledWith(
      { tenantId, storeId }, refundId, 'refund-provider-query-0001',
    )
    expect(value.commands.recordProviderRefundResult).toHaveBeenCalledWith(expect.objectContaining({
      refundPublicId: merchantRefundId,
      providerRefundId: 'POSTAR-REFUND-TX-0001',
      originalProviderTransactionId: 'POSTAR-TX-0001',
      reportedAmountMinor: refund.amountMinor,
      verifiedObservationId: verifiedRefundObservationId,
    }))
    expect(response.json().provider).toEqual({
      status: 'succeeded', amountMinor: refund.amountMinor, currency: 'CNY',
      occurredAt: '2026-08-11T12:21:00.000Z',
    })
  })

  it('preserves authorization and approval guards from the payment command service', async () => {
    const deniedApproval = fixture({
      commands: {
        ...fixtureCommands(),
        approveRefund: vi.fn(async () => {
          throw new PaymentAuthorizationError('Refund requester cannot approve the same refund')
        }),
      },
    })
    const approval = await deniedApproval.app.inject({
      method: 'POST',
      url: `/api/refunds/${refundId}/approve`,
      headers: { 'idempotency-key': 'refund-self-approve-0001' },
      payload: { reason: '申请人与审批人冲突' },
    })
    expect(approval.statusCode).toBe(403)
    expect(approval.json()).toEqual({
      error: { code: 'FINANCIAL_ACTION_FORBIDDEN', message: '当前员工无权执行此财务操作' },
    })

    const notApproved = fixture({
      commands: {
        ...fixtureCommands(),
        beginRefundExecution: vi.fn(async () => {
          throw new RefundApprovalRequiredError(refundId, 'requested')
        }),
      },
    })
    const execution = await notApproved.app.inject({
      method: 'POST',
      url: `/api/refunds/${refundId}/execute`,
      headers: { 'idempotency-key': 'refund-execute-early-0001' },
    })
    expect(execution.statusCode).toBe(409)
    expect(execution.json()).toEqual({
      error: {
        code: 'REFUND_APPROVAL_REQUIRED',
        message: '退款必须先由有权限且非申请人的员工审批',
      },
    })
  })

  it('records only a verified provider refund result after execution has begun', async () => {
    const value = fixture()
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/refunds/providers/postar/callback',
      payload: { status: 'untrusted' },
    })

    expect(response.statusCode).toBe(200)
    expect(value.commands.recordProviderRefundResult).toHaveBeenCalledWith(expect.objectContaining({
      actor: { type: 'integration', ref: 'postar-payment-callback' },
      refundPublicId: refund.publicId,
      provider: 'postar',
      succeeded: true,
      providerRefundId: 'POSTAR-REFUND-0001',
      originalProviderTransactionId: 'POSTAR-TX-0001',
      reportedAmountMinor: 1_000,
      reportedCurrency: 'CNY',
      verifiedObservationId: verifiedRefundObservationId,
      providerSnapshot: {
        refundState: 'SUCCESS',
        eventId: 'postar-refund-event-0001',
        occurredAt: '2026-08-11T12:20:00.000Z',
      },
    }))
  })

  it('binds a manual refund result to the employee and receipt evidence', async () => {
    const value = fixture()
    const response = await value.app.inject({
      method: 'POST',
      url: `/api/refunds/${refundId}/manual-result`,
      headers: { 'idempotency-key': 'refund-manual-result-0001' },
      payload: {
        succeeded: true,
        receiptReference: 'POS-REFUND-RECEIPT-0001',
        occurredAt: '2026-08-11T12:22:00.000Z',
        providerSnapshot: { signatureVerified: true, secret: 'must-be-ignored' },
      },
    })

    expect(response.statusCode).toBe(200)
    expect(value.commands.recordManualRefundResult).toHaveBeenCalledWith(expect.objectContaining({
      actor: { type: 'employee', employeeId },
      refundId,
      succeeded: true,
      receiptReference: 'POS-REFUND-RECEIPT-0001',
      providerSnapshot: {
        receiptReference: 'POS-REFUND-RECEIPT-0001',
        collectedByEmployeeId: employeeId,
        resultCode: 'SUCCESS',
      },
    }))
    expect(JSON.stringify(value.commands.recordManualRefundResult.mock.calls[0]?.[0])).not.toContain('must-be-ignored')
  })

  it('lists scoped reconciliation evidence without accepting client employee or store scope', async () => {
    const value = fixture()
    const response = await value.app.inject({
      method: 'GET',
      url: `/api/reconciliation?businessDate=2026-08-11&entryType=payment&limit=20&employeeId=${requesterId}`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ data: [reconciliationEntry], meta: { nextCursor: null } })
    expect(value.reconciliationQuery.list).toHaveBeenCalledWith({
      scope: { tenantId, storeId },
      employeeId,
      businessDate: '2026-08-11',
      entryType: 'payment',
      limit: 20,
    })
  })

  it('does not expose reconciliation evidence to staff without the view capability', async () => {
    const value = fixture({
      resolveStaffContext: () => ({
        scope: { tenantId, storeId },
        actor: { type: 'employee', employeeId },
        employeeId,
        businessDate: '2026-08-11',
        capabilities: [],
      }),
    })
    const response = await value.app.inject({
      method: 'GET',
      url: '/api/reconciliation?businessDate=2026-08-11',
    })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: { code: 'FINANCIAL_ACTION_FORBIDDEN' } })
    expect(value.reconciliationQuery.list).not.toHaveBeenCalled()
  })

  it('returns the current business day cashier workbench from trusted staff scope', async () => {
    const value = fixture()
    const response = await value.app.inject({
      method: 'GET',
      url: '/api/payments/workbench?query=VIP1&limit=25&businessDate=2020-01-01',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ data: cashierWorkbench })
    expect(value.cashierWorkbenchQuery.get).toHaveBeenCalledWith({
      scope: { tenantId, storeId },
      employeeId,
      businessDate: '2026-08-11',
      capabilities: ['reconciliation.view'],
      query: 'VIP1',
      limit: 25,
    })
  })

  it('does not expose the cashier workbench without a financial capability', async () => {
    const value = fixture({
      resolveStaffContext: () => ({
        scope: { tenantId, storeId },
        actor: { type: 'employee', employeeId },
        employeeId,
        businessDate: '2026-08-11',
        capabilities: ['dashboard.view'],
      }),
    })
    const response = await value.app.inject({ method: 'GET', url: '/api/payments/workbench' })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: { code: 'FINANCIAL_ACTION_FORBIDDEN' } })
    expect(value.cashierWorkbenchQuery.get).not.toHaveBeenCalled()
  })

  it('does not expose store-wide after-sales data to staff who can only initiate payment', async () => {
    const value = fixture({
      resolveStaffContext: () => ({
        scope: { tenantId, storeId },
        actor: { type: 'employee', employeeId },
        employeeId,
        businessDate: '2026-08-11',
        capabilities: ['payment.initiate.staff'],
      }),
    })
    const response = await value.app.inject({ method: 'GET', url: '/api/payments/workbench' })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: { code: 'FINANCIAL_ACTION_FORBIDDEN' } })
    expect(value.cashierWorkbenchQuery.get).not.toHaveBeenCalled()
  })

  it('maps malformed requests and idempotency conflicts to stable errors', async () => {
    const value = fixture()
    const malformed = await value.app.inject({
      method: 'POST',
      url: '/api/payments',
      payload: { orderId: 'not-an-id', provider: 'postar', method: 'native_qr' },
    })
    expect(malformed.statusCode).toBe(400)
    expect(malformed.json()).toMatchObject({ error: { code: 'PAYMENT_REQUEST_INVALID' } })

    const conflict = fixture({
      commands: {
        ...fixtureCommands(),
        requestRefund: vi.fn(async () => {
          throw new IdempotencyConflictError('refund.request', 'refund-request-conflict')
        }),
      },
    })
    const duplicate = await conflict.app.inject({
      method: 'POST',
      url: `/api/payments/${paymentId}/refunds`,
      headers: { 'idempotency-key': 'refund-request-conflict' },
      payload: {
        reason: '重复请求',
        allocations: [{ orderItemId, amountMinor: 100 }],
      },
    })
    expect(duplicate.statusCode).toBe(409)
    expect(duplicate.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } })
  })

  it('strips client-supplied trusted evidence before initiating payment', async () => {
    const value = fixture()
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/payments',
      headers: { 'idempotency-key': 'payment-init-hints-0001' },
      payload: {
        orderId,
        provider: 'postar',
        method: 'native_qr',
        providerSnapshot: {
          channel: 'QR',
          signatureVerified: true,
          providerStatus: 'SUCCESS',
          eventId: 'forged-event',
        },
      },
    })

    expect(response.statusCode).toBe(201)
    expect(value.commands.initiate).toHaveBeenCalledWith(expect.objectContaining({
      providerSnapshot: { channel: 'QR' },
    }))
    expect(JSON.stringify(value.commands.initiate.mock.calls[0]?.[0])).not.toContain('forged-event')
  })

  it('fails closed for unsupported callback providers before executing commands', async () => {
    const value = fixture()
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/payments/providers/simulation/callback',
      payload: { sign: 'forged' },
    })

    expect(response.statusCode).toBe(401)
    expect(value.providerVerifier.verifyPaymentCallback).not.toHaveBeenCalled()
    expect(value.commands.recordSucceededCallback).not.toHaveBeenCalled()
  })

  it('uses only the verified merchant binding to select callback store context', async () => {
    const foreignStoreId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const resolveProviderBusinessDate = vi.fn(() => '2026-08-11')
    const value = fixture({
      providerVerifier: {
        verifyPaymentCallback: vi.fn(async () => ({
          merchant: { ...trustedMerchant, scope: { tenantId, storeId: foreignStoreId } },
          eventId: 'verified-event',
          businessIdentity: 'verified-business-identity',
          paymentPublicId: payment.publicId,
          providerTransactionId: 'POSTAR-TX-0001',
          amountMinor: 8_800,
          currency: 'CNY',
          occurredAt: '2026-08-11T12:05:00.000Z',
        })),
        verifyRefundCallback: vi.fn(),
      },
      resolveProviderBusinessDate,
    })
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/payments/providers/postar/callback',
      payload: { tenantId, storeId, CUST_ID: 'attacker-supplied' },
    })

    expect(response.statusCode).toBe(200)
    expect(resolveProviderBusinessDate).toHaveBeenCalledWith(expect.objectContaining({
      scope: { tenantId, storeId: foreignStoreId },
    }))
    expect(value.commands.recordSucceededCallback).toHaveBeenCalledWith(expect.objectContaining({
      scope: { tenantId, storeId: foreignStoreId },
    }))
  })
})

function fixtureCommands(): PaymentApiOptions['commands'] {
  return {
    initiate: vi.fn(async () => ({ value: payment, replayed: false })),
    recordManual: vi.fn(async () => ({ value: payment, replayed: false })),
    recordSucceededCallback: vi.fn(async () => ({ value: payment, replayed: false })),
    recordProviderQueryResult: vi.fn(async () => ({ value: payment, replayed: false })),
    requestRefund: vi.fn(async () => ({ value: refund, replayed: false })),
    approveRefund: vi.fn(async () => ({ value: refund, replayed: false })),
    rejectRefund: vi.fn(async () => ({ value: refund, replayed: false })),
    beginRefundExecution: vi.fn(async () => ({ value: refund, replayed: false })),
    recordProviderRefundResult: vi.fn(async () => ({ value: refund, replayed: false })),
    recordManualRefundResult: vi.fn(async () => ({ value: refund, replayed: false })),
  }
}
