import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import type { RuntimeMode } from '../src/shared/auth-contracts.js'
import { addOrderItem, createOrderDraft, submitOrder } from './order-domain.js'
import { createPaymentDomainState } from './payment-domain.js'
import { registerPaymentRoutes } from './payment-api.js'
import type { RuntimeRepository } from './repository.js'
import { createSeedState } from './seed.js'

function fixture(runtimeMode: RuntimeMode, actorId = 'emp-lin', roleId = 'server') {
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
  registerPaymentRoutes(app, repository)
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
})
