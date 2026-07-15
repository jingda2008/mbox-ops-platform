import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { registerCommerceRoutes } from './commerce-api.js'
import {
  addOrderItem,
  createOrderDraft,
  submitOrder,
} from './order-domain.js'
import { JsonRepository } from './repository.js'
import { syncOrderFulfillmentWorkstations } from './fulfillment-workstations.js'
import { applyTaskAction } from './domain.js'
import { syncKdsFromFulfillmentServiceTaskAction } from './fulfillment-service.js'

function registerTestActor(app: ReturnType<typeof Fastify>) {
  app.decorateRequest('mboxActor', null)
  app.addHook('preHandler', async (request) => {
    request.mboxActor = {
      actorId: String(request.headers['x-test-actor-id'] ?? 'emp-qing'),
      roleId: String(request.headers['x-test-role-id'] ?? 'specialist'),
      storeId: 'mbox-lujiazui',
      runtimeMode: 'test',
      authenticatedBy: 'local_header',
    }
  })
}

async function createSubmittedOrder(repository: JsonRepository) {
  await repository.mutate((state) => {
    syncOrderFulfillmentWorkstations(state)
    const occurredAt = '2020-01-01T00:00:00.000Z'
    createOrderDraft(state.orderDomain, {
      orderId: 'order-fulfillment', tableSessionId: `session:table-l01:${state.store.businessDate}`,
      createdBy: 'emp-lin', occurredAt, idempotencyKey: 'fulfillment-create-order',
    })
    addOrderItem(state.orderDomain, {
      orderId: 'order-fulfillment', actorId: 'emp-lin', occurredAt,
      idempotencyKey: 'fulfillment-add-item',
      item: {
        id: 'line-fulfillment', skuId: 'product-beer', name: '精酿啤酒', specification: '330ml',
        quantity: 1, unitListPriceAmount: 6800, unitSalePriceAmount: 6800, unitCostAmount: 1800,
        stationId: 'bar-main', configVersion: 1,
      },
    })
    submitOrder(state.orderDomain, {
      orderId: 'order-fulfillment', submittedBy: 'emp-lin', occurredAt,
      idempotencyKey: 'fulfillment-submit-order',
    })
    state.revision += 1
  })
}

async function action(
  app: ReturnType<typeof Fastify>,
  name: 'start' | 'complete' | 'pickUp' | 'deliver',
  idempotencyKey: string,
  roleId: string,
  actorId: string,
) {
  return app.inject({
    method: 'POST',
    url: '/api/commerce/kds/kds:order-fulfillment:line-fulfillment/actions',
    headers: { 'x-test-role-id': roleId, 'x-test-actor-id': actorId },
    payload: { action: name, actorId, idempotencyKey },
  })
}

describe('automatic fulfillment delivery service task', () => {
  it('creates one dedicated delivery task on completion and keeps the chain idempotent', async () => {
    const repository = new JsonRepository(`/tmp/mbox-fulfillment-${crypto.randomUUID()}.json`)
    await repository.init()
    await createSubmittedOrder(repository)
    const app = Fastify()
    registerTestActor(app)
    app.setErrorHandler((error, _request, reply) => reply.status(error.statusCode ?? 400).send({ message: error.message }))
    registerCommerceRoutes(app, repository)

    expect((await action(app, 'start', 'fulfillment-start-0001', 'specialist', 'emp-qing')).statusCode).toBe(200)
    const completed = await action(app, 'complete', 'fulfillment-complete-0001', 'specialist', 'emp-qing')
    expect(completed.statusCode).toBe(200)
    const replayed = await action(app, 'complete', 'fulfillment-complete-0001', 'specialist', 'emp-qing')
    expect(replayed.statusCode).toBe(200)

    let state = await repository.read()
    const kdsTask = state.orderDomain.kdsTasks[0]!
    expect(state.tasks.filter((task) => task.triggerId === `fulfillment-delivery:${kdsTask.id}`)).toHaveLength(1)
    expect(kdsTask.deliveryServiceTask).toMatchObject({ status: 'pending', ownerId: 'emp-tao' })
    const deliveryTask = state.tasks.find((task) => task.id === kdsTask.deliveryServiceTask?.id)!
    expect(deliveryTask).toMatchObject({
      serviceTypeId: 'fulfillment-delivery', source: 'system', ownerId: 'emp-tao', status: 'pending',
    })
    expect(deliveryTask.serviceTypeId).not.toBe('order-help')

    expect((await action(app, 'pickUp', 'fulfillment-pickup-0001', 'runner', 'emp-tao')).statusCode).toBe(200)
    expect((await action(app, 'deliver', 'fulfillment-deliver-0001', 'runner', 'emp-tao')).statusCode).toBe(200)
    state = await repository.read()
    expect(state.tasks.find((task) => task.id === deliveryTask.id)).toMatchObject({
      status: 'completed', resolution: '商品已送达桌台，待确认',
    })
    expect(state.orderDomain.kdsTasks[0]?.deliveryServiceTask?.status).toBe('completed')

    await app.close()
    await repository.close()
  })

  it('falls back to the next configured delivery role when the runner is unavailable', async () => {
    const repository = new JsonRepository(`/tmp/mbox-fulfillment-fallback-${crypto.randomUUID()}.json`)
    await repository.init()
    await repository.mutate((state) => {
      state.employees.find((employee) => employee.id === 'emp-tao')!.online = false
      state.revision += 1
    })
    await createSubmittedOrder(repository)
    const app = Fastify()
    registerTestActor(app)
    app.setErrorHandler((error, _request, reply) => reply.status(error.statusCode ?? 400).send({ message: error.message }))
    registerCommerceRoutes(app, repository)

    expect((await action(app, 'start', 'fulfillment-fallback-start', 'specialist', 'emp-qing')).statusCode).toBe(200)
    expect((await action(app, 'complete', 'fulfillment-fallback-complete', 'specialist', 'emp-qing')).statusCode).toBe(200)

    const state = await repository.read()
    expect(state.tasks.find((task) => task.triggerId?.startsWith('fulfillment-delivery:'))).toMatchObject({
      ownerId: 'emp-lin',
      status: 'pending',
    })
    await app.close()
    await repository.close()
  })

  it('uses workstation roles for production and allows supervisor fallback', async () => {
    const repository = new JsonRepository(`/tmp/mbox-fulfillment-auth-${crypto.randomUUID()}.json`)
    await repository.init()
    await repository.mutate((state) => {
      state.config.workstations.find((station) => station.id === 'bar-main')!.productionRoleIds = ['bartender']
      state.revision += 1
    })
    await createSubmittedOrder(repository)
    const app = Fastify()
    registerTestActor(app)
    app.setErrorHandler((error, _request, reply) => reply.status(error.statusCode ?? 400).send({ message: error.message }))
    registerCommerceRoutes(app, repository)

    expect((await action(app, 'start', 'fulfillment-denied-0001', 'specialist', 'emp-qing')).statusCode).toBe(403)
    expect((await action(app, 'start', 'fulfillment-supervisor-0001', 'supervisor', 'emp-mia')).statusCode).toBe(200)

    await app.close()
    await repository.close()
  })

  it('enforces employee skills and active-shift workstation scope on the server', async () => {
    const repository = new JsonRepository(`/tmp/mbox-fulfillment-scope-${crypto.randomUUID()}.json`)
    await repository.init()
    await repository.mutate((state) => {
      state.employees.find((employee) => employee.id === 'emp-qing')!.skillIds = []
      state.revision += 1
    })
    await createSubmittedOrder(repository)
    const app = Fastify()
    registerTestActor(app)
    app.setErrorHandler((error, _request, reply) => reply.status(error.statusCode ?? 400).send({ message: error.message }))
    registerCommerceRoutes(app, repository)

    expect((await action(app, 'start', 'fulfillment-skill-denied', 'bartender', 'emp-qing')).statusCode).toBe(403)
    await repository.mutate((state) => {
      state.employees.find((employee) => employee.id === 'emp-qing')!.skillIds = ['skill-bar']
      state.shiftAssignments.find((shift) => shift.employeeId === 'emp-qing')!.stationIds = ['kitchen-cold']
      state.revision += 1
    })
    expect((await action(app, 'start', 'fulfillment-station-denied', 'bartender', 'emp-qing')).statusCode).toBe(403)

    await app.close()
    await repository.close()
  })

  it('writes generic ServiceTask arrive and complete actions back to KDS in order', async () => {
    const repository = new JsonRepository(`/tmp/mbox-fulfillment-bridge-${crypto.randomUUID()}.json`)
    await repository.init()
    await createSubmittedOrder(repository)
    const app = Fastify()
    registerTestActor(app)
    registerCommerceRoutes(app, repository)
    expect((await action(app, 'start', 'fulfillment-bridge-start', 'specialist', 'emp-qing')).statusCode).toBe(200)
    expect((await action(app, 'complete', 'fulfillment-bridge-complete', 'specialist', 'emp-qing')).statusCode).toBe(200)

    await repository.mutate((state) => {
      const serviceTask = state.tasks.find((task) => task.triggerId?.startsWith('fulfillment-delivery:'))!
      const acceptInput = { action: 'accept' as const, actorId: serviceTask.ownerId!, note: '', idempotencyKey: 'bridge-accept-0001' }
      applyTaskAction(state, serviceTask.id, acceptInput)
      expect(syncKdsFromFulfillmentServiceTaskAction(state, serviceTask, acceptInput)).toBeNull()

      const arriveInput = { action: 'arrive' as const, actorId: serviceTask.ownerId!, note: '', idempotencyKey: 'bridge-arrive-0001' }
      applyTaskAction(state, serviceTask.id, arriveInput)
      expect(syncKdsFromFulfillmentServiceTaskAction(state, serviceTask, arriveInput)?.status).toBe('picked_up')

      const completeInput = { action: 'complete' as const, actorId: serviceTask.ownerId!, note: '已送达', idempotencyKey: 'bridge-complete-0001' }
      applyTaskAction(state, serviceTask.id, completeInput)
      expect(syncKdsFromFulfillmentServiceTaskAction(state, serviceTask, completeInput)?.status).toBe('delivered')
      expect(syncKdsFromFulfillmentServiceTaskAction(state, serviceTask, completeInput)?.status).toBe('delivered')
    })

    const state = await repository.read()
    expect(state.orderDomain.orders[0]?.status).toBe('fulfilled')
    expect(state.orderDomain.idempotencyRecords.filter((record) => record.operation === 'kds.pick_up.v1')).toHaveLength(1)
    expect(state.orderDomain.idempotencyRecords.filter((record) => record.operation === 'kds.deliver.v1')).toHaveLength(1)
    await app.close()
    await repository.close()
  })
})
