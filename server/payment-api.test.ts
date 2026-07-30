import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import type { RuntimeMode } from '../src/shared/auth-contracts.js'
import { addOrderItem, createOrderDraft, submitOrder } from './order-domain.js'
import { createPaymentDomainState } from './payment-domain.js'
import { registerPaymentRoutes } from './payment-api.js'
import type { RuntimeRepository } from './repository.js'
import { createSeedState } from './seed.js'
import { serializeRuntimeState } from './postgres-repository.js'

function fixture(
  runtimeMode: RuntimeMode,
  actorId = 'emp-lin',
  roleId = 'server',
  allowPilotSimulation = false,
) {
  let state = createSeedState()
  state.paymentDomain = createPaymentDomainState()
  const tableSession = state.songState.tableSessions.find((candidate) => candidate.status === 'open')!
  const product = state.products.find((candidate) => candidate.enabled)!
  createOrderDraft(state.orderDomain, {
    orderId: 'payment-api-order', tableSessionId: tableSession.id, createdBy: actorId,
    occurredAt: '2026-07-14T12:00:00.000Z', idempotencyKey: 'payment-api-order-draft',
  })
  addOrderItem(state.orderDomain, {
    orderId: 'payment-api-order', actorId, occurredAt: '2026-07-14T12:00:01.000Z',
    idempotencyKey: 'payment-api-order-item',
    item: {
      id: 'payment-api-line', skuId: product.id, name: product.name, specification: product.specification,
      quantity: 1, unitListPriceAmount: product.listPriceAmount, unitSalePriceAmount: product.listPriceAmount,
      unitCostAmount: product.costAmount, stationId: product.stationId, configVersion: product.configVersion,
    },
  })
  submitOrder(state.orderDomain, {
    orderId: 'payment-api-order', submittedBy: actorId, occurredAt: '2026-07-14T12:00:02.000Z',
    idempotencyKey: 'payment-api-order-submit',
  })
  const repository: RuntimeRepository = {
    init: async () => undefined,
    read: async () => structuredClone(state),
    mutate: async (mutation) => {
      const working = structuredClone(state)
      const result = await mutation(working)
      state = working
      return result
    },
    reset: async () => structuredClone(state),
    healthCheck: async () => ({ ready: true, repository: 'test', revision: state.revision }),
    close: async () => undefined,
  }
  const app = Fastify()
  const actor = { actorId, roleId }
  app.addHook('preHandler', async (request) => {
    request.mboxActor = {
      actorId: actor.actorId,
      storeId: state.store.id,
      roleId: actor.roleId,
      runtimeMode,
      authenticatedBy: runtimeMode === 'local' || runtimeMode === 'test' ? 'local_header' : 'signed_session',
    }
  })
  registerPaymentRoutes(app, repository, { allowPilotSimulation })
  return {
    app,
    repository,
    setActor(nextActorId: string, nextRoleId: string) {
      actor.actorId = nextActorId
      actor.roleId = nextRoleId
    },
  }
}

describe('payment API security boundary', () => {
  it.each(['staging', 'production'] as const)('does not expose payment simulation in %s', async (runtimeMode) => {
    const { app, repository } = fixture(runtimeMode)
    const response = await app.inject({
      method: 'POST',
      url: '/api/payments/missing/dev-simulate-success',
      payload: { idempotencyKey: `payment-simulation-${runtimeMode}` },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json().code).toBe('DEVELOPMENT_ENDPOINT_DISABLED')
    await app.close()
    await repository.close()
  })

  it('does not allow creation of mock payment intents in staging', async () => {
    const { app, repository } = fixture('staging')
    const state = await repository.read()
    const order = state.orderDomain.orders.find((candidate) => candidate.status !== 'draft')!
    const response = await app.inject({
      method: 'POST',
      url: '/api/payments/table-intents',
      payload: {
        tableSessionId: order.tableSessionId,
        channel: 'wechat_mock',
        deviceId: 'cashier-test',
        idempotencyKey: 'mock-payment-intent-staging-0001',
      },
    })
    expect(response.statusCode).toBe(404)
    expect(response.json().code).toBe('DEVELOPMENT_CHANNEL_DISABLED')
    await app.close()
    await repository.close()
  })

  it('allows the explicit non-settling simulator only in staging pilot mode', async () => {
    const { app, repository } = fixture('staging', 'emp-lin', 'server', true)
    const state = await repository.read()
    const order = state.orderDomain.orders.find((candidate) => candidate.status !== 'draft')!
    const created = await app.inject({
      method: 'POST',
      url: '/api/payments/table-intents',
      payload: {
        tableSessionId: order.tableSessionId,
        channel: 'wechat_mock',
        deviceId: 'pilot-cashier-test',
        idempotencyKey: 'pilot-mock-payment-intent-0001',
      },
    })
    expect(created.statusCode).toBe(201)
    const simulated = await app.inject({
      method: 'POST',
      url: `/api/payments/${created.json().id}/dev-simulate-success`,
      payload: { idempotencyKey: 'pilot-mock-payment-success-0001' },
    })
    expect(simulated.statusCode).toBe(200)
    expect(simulated.json()).toMatchObject({ channel: 'wechat_mock', status: 'succeeded' })
    const persisted = await repository.read()
    expect(() => serializeRuntimeState(persisted)).not.toThrow()
    await app.close()
    await repository.close()
  })

  it('takes the payment audit actor from the authenticated request, never from the payload', async () => {
    const { app, repository } = fixture('test', 'emp-lin')
    const state = await repository.read()
    const order = state.orderDomain.orders.find((candidate) => candidate.status !== 'draft')
    expect(order).toBeDefined()

    const response = await app.inject({
      method: 'POST',
      url: '/api/payments/table-intents',
      payload: {
        tableSessionId: order!.tableSessionId,
        channel: 'physical_pos',
        actorId: 'emp-chen',
        deviceId: 'cashier-test',
        idempotencyKey: 'payment-request-actor-binding-0001',
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json().createdBy).toBe('emp-lin')
    const persisted = await repository.read()
    expect(persisted.auditEntries.at(-1)).toMatchObject({
      actorId: 'emp-lin',
      action: 'payment.intent.created.v1',
    })
    await app.close()
    await repository.close()
  })

  it('completes a physical POS item refund with a different authorized employee', async () => {
    const { app, repository, setActor } = fixture('test', 'emp-lin', 'server')
    const state = await repository.read()
    const order = state.orderDomain.orders.find((candidate) => candidate.status !== 'draft')!
    const intentResponse = await app.inject({
      method: 'POST',
      url: '/api/payments/table-intents',
      payload: {
        tableSessionId: order.tableSessionId,
        channel: 'physical_pos',
        deviceId: 'cashier-test',
        idempotencyKey: 'physical-refund-intent-0001',
      },
    })
    const intent = intentResponse.json()
    setActor('emp-cashier', 'cashier')
    expect((await app.inject({
      method: 'POST',
      url: `/api/payments/${intent.id}/physical-pos-reports`,
      payload: {
        terminalId: 'POS-01', terminalTransactionId: 'POS-SALE-0001', paymentMethod: '银行卡',
        deviceId: 'cashier-test', idempotencyKey: 'physical-pos-report-0001',
      },
    })).statusCode).toBe(201)
    setActor('emp-lin', 'server')
    const refundResponse = await app.inject({
      method: 'POST',
      url: `/api/payments/${intent.id}/refunds`,
      payload: {
        orderId: order.id, orderItemId: order.items[0]!.id, quantity: 1, reason: '客人退单',
        idempotencyKey: 'physical-refund-request-0001',
      },
    })
    expect(refundResponse.statusCode).toBe(201)
    const refund = refundResponse.json()

    const duplicateRefundResponse = await app.inject({
      method: 'POST',
      url: `/api/payments/${intent.id}/refunds`,
      payload: {
        orderId: order.id, orderItemId: order.items[0]!.id, quantity: 1, reason: '重复点击',
        idempotencyKey: 'physical-refund-request-duplicate-0001',
      },
    })
    expect(duplicateRefundResponse.statusCode).toBe(409)
    expect(duplicateRefundResponse.json().code).toBe('REFUND_ALREADY_PENDING')
    expect(duplicateRefundResponse.json().message).toContain('已有待处理退款')
    expect(duplicateRefundResponse.json().message).toContain('另一名有退款审批权限')

    expect((await app.inject({
      method: 'POST',
      url: `/api/payments/refunds/${refund.id}/physical-pos-complete`,
      payload: {
        terminalRefundTransactionId: 'POS-REFUND-0001', reason: 'POS终端已确认退款',
        idempotencyKey: 'physical-refund-complete-0001',
      },
    })).statusCode).toBe(403)

    setActor('emp-chen', 'manager')
    const completeResponse = await app.inject({
      method: 'POST',
      url: `/api/payments/refunds/${refund.id}/physical-pos-complete`,
      payload: {
        terminalRefundTransactionId: 'POS-REFUND-0001', reason: 'POS终端已确认退款',
        idempotencyKey: 'physical-refund-complete-0001',
      },
    })
    expect(completeResponse.statusCode).toBe(200)
    expect(completeResponse.json()).toMatchObject({
      status: 'succeeded',
      decidedBy: 'emp-chen',
      channelRefundTransactionId: 'POS-REFUND-0001',
    })
    await app.close()
    await repository.close()
  })

  it('splits one item by specified amounts without assigning more than the remaining receivable', async () => {
    const { app, repository } = fixture('test', 'emp-cashier', 'cashier')
    const state = await repository.read()
    const order = state.orderDomain.orders.find((candidate) => candidate.id === 'payment-api-order')!
    const total = order.items[0]!.unitSalePriceAmount
    const firstAmount = Math.floor(total / 2)
    const first = await app.inject({
      method: 'POST', url: '/api/payments/table-intents',
      payload: {
        tableSessionId: order.tableSessionId, channel: 'physical_pos', allocation: { mode: 'amount', amount: firstAmount },
        deviceId: 'cashier-test', idempotencyKey: 'partial-payment-first-0001',
      },
    })
    const second = await app.inject({
      method: 'POST', url: '/api/payments/table-intents',
      payload: {
        tableSessionId: order.tableSessionId, channel: 'cash', allocation: { mode: 'amount', amount: total - firstAmount },
        deviceId: 'cashier-test', idempotencyKey: 'partial-payment-second-0001',
      },
    })
    const duplicate = await app.inject({
      method: 'POST', url: '/api/payments/table-intents',
      payload: {
        tableSessionId: order.tableSessionId, channel: 'cash', allocation: { mode: 'all' },
        deviceId: 'cashier-test', idempotencyKey: 'partial-payment-overallocate-0001',
      },
    })
    expect(first.statusCode, first.body).toBe(201)
    expect(second.statusCode, second.body).toBe(201)
    expect(first.json().amount + second.json().amount).toBe(total)
    expect(duplicate.statusCode).toBe(500)
    expect(duplicate.json().message).toContain('没有可支付的订单商品')
    await app.close()
    await repository.close()
  })

  it('closes an expired processing intent and creates a fresh payment with a new key', async () => {
    const { app, repository } = fixture('test', 'emp-cashier', 'cashier')
    const order = (await repository.read()).orderDomain.orders.find((candidate) => candidate.id === 'payment-api-order')!
    const first = await app.inject({
      method: 'POST', url: '/api/payments/table-intents',
      payload: {
        tableSessionId: order.tableSessionId, channel: 'physical_pos', allocation: { mode: 'all' },
        deviceId: 'cashier-test', idempotencyKey: 'expired-payment-first-0001',
      },
    })
    expect(first.statusCode, first.body).toBe(201)
    await repository.mutate((state) => {
      const intent = state.paymentDomain.paymentIntents.find((candidate) => candidate.id === first.json().id)!
      intent.status = 'processing'
      intent.expiresAt = new Date(Date.now() - 1_000).toISOString()
    })

    const replacement = await app.inject({
      method: 'POST', url: '/api/payments/table-intents',
      payload: {
        tableSessionId: order.tableSessionId, channel: 'cash', allocation: { mode: 'all' },
        deviceId: 'cashier-test', idempotencyKey: 'expired-payment-replacement-0001',
      },
    })
    expect(replacement.statusCode, replacement.body).toBe(201)
    const persisted = await repository.read()
    expect(persisted.paymentDomain.paymentIntents.find((candidate) => candidate.id === first.json().id)).toMatchObject({
      status: 'closed', failureReason: '支付意图已过期',
    })
    expect(replacement.json()).toMatchObject({ status: 'pending', amount: order.amounts.payableAmount })
    await app.close()
    await repository.close()
  })

  it('does not count a cash intent as received until the cashier confirms it', async () => {
    const { app, repository } = fixture('test', 'emp-cashier', 'cashier')
    const state = await repository.read()
    const order = state.orderDomain.orders.find((candidate) => candidate.id === 'payment-api-order')!
    const intentResponse = await app.inject({
      method: 'POST', url: '/api/payments/table-intents',
      payload: {
        tableSessionId: order.tableSessionId, channel: 'cash', allocation: { mode: 'all' },
        deviceId: 'cashier-test', idempotencyKey: 'cash-payment-intent-0001',
      },
    })
    expect(intentResponse.json().status).toBe('pending')
    const confirmation = await app.inject({
      method: 'POST', url: `/api/payments/${intentResponse.json().id}/cash-confirmations`,
      payload: { deviceId: 'cashier-test', idempotencyKey: 'cash-payment-confirm-0001' },
    })
    expect(confirmation.statusCode, confirmation.body).toBe(201)
    expect((await repository.read()).paymentDomain.paymentIntents[0]?.status).toBe('succeeded')
    await app.close()
    await repository.close()
  })

  it('returns explicit provider unavailability and persists no intent when Postar credentials are missing', async () => {
    const { app, repository } = fixture('production', 'emp-cashier', 'cashier')
    const state = await repository.read()
    const order = state.orderDomain.orders.find((candidate) => candidate.id === 'payment-api-order')!
    const response = await app.inject({
      method: 'POST', url: '/api/payments/table-intents',
      payload: {
        tableSessionId: order.tableSessionId,
        channel: 'postar',
        allocation: { mode: 'all' },
        providerPayment: { presentation: 'jsapi', payWay: 'wechat', payerId: 'openid-test', wxAppid: 'wx-app-test' },
        deviceId: 'cashier-test',
        idempotencyKey: 'postar-missing-credentials-0001',
      },
    })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ code: 'PAYMENT_PROVIDER_UNAVAILABLE' })
    expect((await repository.read()).paymentDomain.paymentIntents).toHaveLength(0)
    await app.close()
    await repository.close()
  })
})
