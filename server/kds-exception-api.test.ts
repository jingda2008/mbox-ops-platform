import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { registerCommerceRoutes } from './commerce-api.js'
import { addOrderItem, createOrderDraft, submitOrder } from './order-domain.js'
import { syncOrderFulfillmentWorkstations } from './fulfillment-workstations.js'
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
      actorId: 'emp-mia',
      idempotencyKey: 'kds-shortage-remake-api-0001',
    }

    const denied = await app.inject({
      method: 'POST',
      url: `/api/commerce/kds/exceptions/${exceptionId}/decision`,
      headers: headers('emp-qing', 'bartender'),
      payload: { ...decisionPayload, actorId: 'emp-qing' },
    })
    expect(denied.statusCode).toBe(403)

    const decided = await app.inject({
      method: 'POST',
      url: `/api/commerce/kds/exceptions/${exceptionId}/decision`,
      headers: headers('emp-mia', 'supervisor'),
      payload: decisionPayload,
    })
    expect(decided.statusCode).toBe(200)
    expect(decided.json()).toMatchObject({
      type: 'manager_disposition',
      managerDisposition: 'remake',
      actorId: 'emp-mia',
      actorRoleId: 'supervisor',
      originalOrderItemId: 'line-kds-exception',
      originalKdsTaskId: taskId,
    })
    const replayedDecision = await app.inject({
      method: 'POST',
      url: `/api/commerce/kds/exceptions/${exceptionId}/decision`,
      headers: headers('emp-mia', 'supervisor'),
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
})
