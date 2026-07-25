import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { registerCommerceRoutes } from './commerce-api.js'
import { addOrderItem, createOrderDraft, submitOrder } from './order-domain.js'
import { syncOrderFulfillmentWorkstations } from './fulfillment-workstations.js'
import { receiveInventory } from './inventory-domain.js'
import { createPaymentIntent, handlePaymentNotification } from './payment-domain.js'
import { JsonRepository } from './repository.js'

function registerTestActor(app: ReturnType<typeof Fastify>) {
  app.decorateRequest('mboxActor', null)
  app.addHook('preHandler', async (request) => {
    request.mboxActor = {
      actorId: String(request.headers['x-test-actor-id'] ?? 'emp-qing'),
      roleId: String(request.headers['x-test-role-id'] ?? 'bartender'),
      storeId: 'mbox-lujiazui',
      runtimeMode: 'test',
      authenticatedBy: 'local_header',
    }
  })
}

async function createSubmittedOrder(repository: JsonRepository) {
  await repository.mutate((state) => {
    syncOrderFulfillmentWorkstations(state)
    const occurredAt = '2026-07-15T12:00:00.000Z'
    createOrderDraft(state.orderDomain, {
      orderId: 'order-kds-exception',
      tableSessionId: `session:table-l01:${state.store.businessDate}`,
      createdBy: 'emp-lin',
      occurredAt,
      idempotencyKey: 'kds-exception-create-order',
    })
    addOrderItem(state.orderDomain, {
      orderId: 'order-kds-exception',
      actorId: 'emp-lin',
      occurredAt,
      idempotencyKey: 'kds-exception-add-item',
      item: {
        id: 'line-kds-exception',
        skuId: 'product-beer',
        name: '精酿啤酒',
        specification: '330ml',
        quantity: 1,
        unitListPriceAmount: 6800,
        unitSalePriceAmount: 6800,
        unitCostAmount: 1800,
        stationId: 'bar-main',
        configVersion: 1,
      },
    })
    submitOrder(state.orderDomain, {
      orderId: 'order-kds-exception',
      submittedBy: 'emp-lin',
      occurredAt,
      idempotencyKey: 'kds-exception-submit-order',
    })
    state.revision += 1
  })
}

function headers(actorId: string, roleId: string) {
  return { 'x-test-actor-id': actorId, 'x-test-role-id': roleId }
}

describe('KDS exception API', () => {
  it('lets the KDS role report shortage and only a lead or manager create one linked remake', async () => {
    const repository = new JsonRepository(`/tmp/mbox-kds-exception-${crypto.randomUUID()}.json`)
    await repository.init()
    await createSubmittedOrder(repository)
    const app = Fastify()
    registerTestActor(app)
    app.setErrorHandler((error, _request, reply) => reply.status(error.statusCode ?? 400).send({ message: error.message }))
    registerCommerceRoutes(app, repository)
    const taskId = 'kds:order-kds-exception:line-kds-exception'
    const reportPayload = {
      exceptionKind: 'shortage',
      reasonCode: 'product_out_of_stock',
      reasonNote: '',
      actorId: 'emp-qing',
      idempotencyKey: 'kds-shortage-report-api-0001',
    }

    const reported = await app.inject({
      method: 'POST',
      url: `/api/commerce/kds/${taskId}/exceptions`,
      headers: headers('emp-qing', 'bartender'),
      payload: reportPayload,
    })
    expect(reported.statusCode).toBe(201)
    expect(reported.json()).toMatchObject({
      type: 'reported',
      exceptionKind: 'shortage',
      reasonCode: 'product_out_of_stock',
      actorId: 'emp-qing',
      actorRoleId: 'bartender',
      originalOrderItemId: 'line-kds-exception',
      originalKdsTaskId: taskId,
    })
    const replayedReport = await app.inject({
      method: 'POST',
      url: `/api/commerce/kds/${taskId}/exceptions`,
      headers: headers('emp-qing', 'bartender'),
      payload: reportPayload,
    })
    expect(replayedReport.statusCode).toBe(201)
    const exceptionId = reported.json().exceptionId as string
    const decisionPayload = {
      disposition: 'remake',
      reasonCode: 'service_recovery',
      reasonNote: '',
      actorId: 'emp-qing',
      idempotencyKey: 'kds-shortage-remake-api-0001',
    }

    const denied = await app.inject({
      method: 'POST',
      url: `/api/commerce/kds/exceptions/${exceptionId}/decision`,
      headers: headers('emp-han', 'kitchen'),
      payload: { ...decisionPayload, actorId: 'emp-han' },
    })
    expect(denied.statusCode).toBe(403)

    const decided = await app.inject({
      method: 'POST',
      url: `/api/commerce/kds/exceptions/${exceptionId}/decision`,
      headers: headers('emp-qing', 'bartender'),
      payload: decisionPayload,
    })
    expect(decided.statusCode).toBe(200)
    expect(decided.json()).toMatchObject({
      type: 'manager_disposition',
      managerDisposition: 'remake',
      actorId: 'emp-qing',
      actorRoleId: 'supervisor',
      originalOrderItemId: 'line-kds-exception',
      originalKdsTaskId: taskId,
    })
    const replayedDecision = await app.inject({
      method: 'POST',
      url: `/api/commerce/kds/exceptions/${exceptionId}/decision`,
      headers: headers('emp-qing', 'bartender'),
      payload: decisionPayload,
    })
    expect(replayedDecision.statusCode).toBe(200)

    const originalBlocked = await app.inject({
      method: 'POST',
      url: `/api/commerce/kds/${taskId}/actions`,
      headers: headers('emp-qing', 'bartender'),
      payload: { action: 'start', actorId: 'emp-qing', idempotencyKey: 'kds-original-blocked-0001' },
    })
    expect(originalBlocked.statusCode).toBe(400)
    expect(originalBlocked.json()).toMatchObject({ message: '原KDS任务已由异常处置关闭' })

    const state = await repository.read()
    const original = state.orderDomain.kdsTasks.find((task) => task.id === taskId)!
    const remakes = state.orderDomain.kdsTasks.filter((task) => task.remakeOf?.kdsTaskId === taskId)
    expect(original.status).toBe('queued')
    expect(original.exceptionEvents).toHaveLength(2)
    expect(remakes).toHaveLength(1)
    expect(remakes[0]).toMatchObject({
      status: 'queued',
      orderItemId: 'line-kds-exception',
      remakeOf: { orderItemId: 'line-kds-exception', kdsTaskId: taskId, exceptionId, attempt: 1 },
    })
    expect(state.orderDomain.orders[0]?.items[0]?.kdsTaskId).toBe(taskId)
    expect(state.auditEntries.filter((entry) => entry.action === 'kds.exception.reported.v1')).toHaveLength(1)
    expect(state.auditEntries.filter((entry) => entry.action === 'kds.exception.remake.v1')).toHaveLength(1)

    await app.close()
    await repository.close()
  })

  it('lets a manager cancel an undelivered item without changing order or payment amounts', async () => {
    const repository = new JsonRepository(`/tmp/mbox-kds-manager-cancel-${crypto.randomUUID()}.json`)
    await repository.init()
    await createSubmittedOrder(repository)
    const taskId = 'kds:order-kds-exception:line-kds-exception'
    await repository.mutate((state) => {
      const task = state.orderDomain.kdsTasks.find((candidate) => candidate.id === taskId)!
      task.status = 'completed'
      task.startedAt = '2026-07-15T12:01:00.000Z'
      task.completedAt = '2026-07-15T12:02:00.000Z'
      const payment = createPaymentIntent(state.paymentDomain, {
        paymentIntentId: 'manager-cancel-paid-intent', tableSessionId: task.tableSessionId,
        lineAllocations: [{ orderId: task.orderId, orderItemId: task.orderItemId, quantity: 1, unitPaidAmount: 6800 }],
        amount: 6800, currency: 'CNY', channel: 'wechat_mock', merchantId: state.store.id,
        createdBy: 'emp-chen', deviceId: 'test', occurredAt: '2026-07-15T12:02:01.000Z',
        expiresAt: '2026-07-15T12:17:01.000Z', idempotencyKey: 'manager-cancel-payment-create',
      })
      handlePaymentNotification(state.paymentDomain, {
        channel: payment.channel, notificationId: 'manager-cancel-payment-notification', paymentIntentId: payment.id,
        channelTransactionId: 'manager-cancel-payment-transaction', status: 'succeeded', amount: 6800,
        currency: 'CNY', merchantId: state.store.id, signatureVerified: true,
        channelOccurredAt: '2026-07-15T12:02:02.000Z', receivedAt: '2026-07-15T12:02:02.000Z',
      })
      state.revision += 1
    })
    const app = Fastify()
    registerTestActor(app)
    app.setErrorHandler((error, _request, reply) => reply.status(error.statusCode ?? 400).send({ message: error.message }))
    registerCommerceRoutes(app, repository)
    const payload = {
      reasonCode: 'manager_cancelled',
      reasonNote: '',
      idempotencyKey: 'manager-turnover-cancel-0001',
    }

    const denied = await app.inject({
      method: 'POST', url: `/api/commerce/kds/${taskId}/manager-cancel`,
      headers: headers('emp-han', 'kitchen'), payload,
    })
    expect(denied.statusCode).toBe(403)

    const cancelled = await app.inject({
      method: 'POST', url: `/api/commerce/kds/${taskId}/manager-cancel`,
      headers: headers('emp-chen', 'manager'), payload,
    })
    expect(cancelled.statusCode, cancelled.body).toBe(200)
    expect(cancelled.json()).toMatchObject({
      taskId,
      itemName: '精酿啤酒',
      accounting: {
        policy: 'manual_confirmation_required',
        mutationApplied: false,
        recommendation: 'review_refund',
        payableAmount: 6800,
        paidAmount: 6800,
        refundedAmount: 0,
        suggestedAmount: 6800,
      },
    })
    const replayed = await app.inject({
      method: 'POST', url: `/api/commerce/kds/${taskId}/manager-cancel`,
      headers: headers('emp-chen', 'manager'), payload,
    })
    expect(replayed.statusCode, replayed.body).toBe(200)
    expect(replayed.json().cancellationEventId).toBe(cancelled.json().cancellationEventId)

    const state = await repository.read()
    expect(state.orderDomain.orders[0]?.amounts).toEqual({
      grossAmount: 6800, discountAmount: 0, giftAmount: 0, payableAmount: 6800,
    })
    expect(state.paymentDomain.refunds).toHaveLength(0)
    const cancellationEvents = state.orderDomain.kdsTasks.find((task) => task.id === taskId)?.exceptionEvents ?? []
    expect(cancellationEvents).toHaveLength(2)
    expect(cancellationEvents.every((event) => event.reasonNote?.includes('未补充情况说明'))).toBe(true)
    const cancellationAudit = state.auditEntries.filter((entry) => entry.action === 'kds.manager_cancelled.v1')
    expect(cancellationAudit).toHaveLength(1)
    expect(cancellationAudit[0]?.details).toMatchObject({
      reasonCode: 'manager_cancelled',
      reasonNote: null,
      reasonNoteProvided: false,
    })

    await app.close()
    await repository.close()
  })

  it('creates a separately audited gift order only within the configured employee authority', async () => {
    const repository = new JsonRepository(`/tmp/mbox-complimentary-order-${crypto.randomUUID()}.json`)
    await repository.init()
    const initial = await repository.read()
    const table = initial.tables.find((candidate) => candidate.status === 'occupied')!
    const product = initial.products.find((candidate) => candidate.id === 'product-fruit')!
    await repository.mutate((state) => {
      const occurredAt = new Date()
      const managerAuthority = state.orderDomain.authorizationAuthorities.find(
        (authority) => authority.actorId === 'emp-chen' && authority.kinds.includes('gift'),
      )!
      managerAuthority.validFrom = new Date(occurredAt.getTime() - 60_000).toISOString()
      managerAuthority.validUntil = new Date(occurredAt.getTime() + 60_000).toISOString()
      receiveInventory(state.inventoryDomain!, {
        movementId: 'gift-order-receipt', productId: product.id, unitCode: 'portion', quantity: 5,
        actorId: 'emp-chen', reason: '赠送订单测试入库', businessDate: state.store.businessDate,
        occurredAt: occurredAt.toISOString(), idempotencyKey: 'gift-order-receipt-0001',
      })
      state.revision += 1
    })
    const app = Fastify()
    registerTestActor(app)
    app.setErrorHandler((error, _request, reply) => reply.status(error.statusCode ?? 400).send({ message: error.message }))
    registerCommerceRoutes(app, repository)
    const payload = {
      tableId: table.id,
      items: [{ productId: product.id, quantity: 1 }],
      reason: '未上菜服务补偿',
      sourceKdsTaskId: 'source-kds-test',
      idempotencyKey: 'manager-gift-order-0001',
    }

    const denied = await app.inject({
      method: 'POST', url: '/api/commerce/complimentary-orders',
      headers: headers('emp-lin', 'server'), payload,
    })
    expect(denied.statusCode).toBe(403)

    const created = await app.inject({
      method: 'POST', url: '/api/commerce/complimentary-orders',
      headers: headers('emp-chen', 'manager'), payload,
    })
    expect(created.statusCode, created.body).toBe(201)
    expect(created.json()).toMatchObject({
      status: 'submitted',
      amounts: { grossAmount: 12800, discountAmount: 0, giftAmount: 12800, payableAmount: 0 },
      items: [{ skuId: product.id, unitSalePriceAmount: 0 }],
    })
    const replayed = await app.inject({
      method: 'POST', url: '/api/commerce/complimentary-orders',
      headers: headers('emp-chen', 'manager'), payload,
    })
    expect(replayed.statusCode, replayed.body).toBe(201)
    expect(replayed.json().id).toBe(created.json().id)

    const state = await repository.read()
    expect(state.orderDomain.kdsTasks.filter((task) => task.orderId === created.json().id)).toHaveLength(1)
    expect(state.inventoryDomain?.movements.filter((movement) => movement.orderId === created.json().id)).toEqual([
      expect.objectContaining({ type: 'gift', productId: product.id, quantity: 1 }),
    ])
    expect(state.auditEntries.filter((entry) => entry.action === 'commerce.complimentary_order.v1')).toHaveLength(1)

    await app.close()
    await repository.close()
  })
})
