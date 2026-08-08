import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import type { RequestActorContext } from '../src/shared/auth-contracts.js'
import type { RuntimeState } from '../src/shared/contracts.js'
import type { GuestSessionResponse } from '../src/shared/guest-contracts.js'
import { effectiveRoleIdsForEmployee } from '../src/shared/staff-access.js'
import { visibleGuestTasks } from '../src/components/guest-portal-utils.js'
import { taskQueueIsVisible } from '../src/components/task-queue.js'
import { AuthorizationError } from './authorization.js'
import { projectRuntimeStateForActor } from './bootstrap-projection.js'
import { registerCommerceRoutes } from './commerce-api.js'
import { registerGuestRoutes } from './guest-api.js'
import { MemoryGuestInsightsStore } from './guest-insights.js'
import { MemoryRateLimitStore } from './rate-limit.js'
import { registerPublicReservationRoutes } from './public-reservation-api.js'
import { registerReservationRoutes } from './reservation-api.js'
import type { RuntimeRepository, RuntimeRepositoryHealth } from './repository.js'
import { createSeedState } from './seed.js'
import { registerSongRoutes } from './song-api.js'
import { TableAccessError } from './table-access.js'
import { registerTaskRoutes } from './task-api.js'

const NOW = Date.parse('2026-07-20T04:00:00.000Z')
const GUEST_SECRET = 'g'.repeat(32)
const PUBLIC_RESERVATION_SECRET = 'r'.repeat(32)

class MemoryRuntimeRepository implements RuntimeRepository {
  state = createSeedState(new Date(NOW))

  async init() {}
  async read() { return structuredClone(this.state) }
  async mutate<T>(mutation: (state: RuntimeState) => T | Promise<T>) {
    const next = structuredClone(this.state)
    const result = await mutation(next)
    this.state = next
    return result
  }
  async reset() { this.state = createSeedState(new Date(NOW)); return structuredClone(this.state) }
  async healthCheck(): Promise<RuntimeRepositoryHealth> {
    return { ready: true, repository: 'memory', revision: this.state.revision }
  }
  async close() {}
}

function actorContext(state: RuntimeState, actorId: string): RequestActorContext {
  const employee = state.employees.find((item) => item.id === actorId)
  if (!employee) throw new Error(`测试员工不存在：${actorId}`)
  return {
    actorId,
    roleId: employee.roleId,
    storeId: state.store.id,
    runtimeMode: 'test',
    authenticatedBy: 'local_header',
  }
}

function employeeHeaders(actorId: string) {
  return { 'x-test-actor-id': actorId }
}

async function buildFixture() {
  const repository = new MemoryRuntimeRepository()
  const guestInsights = new MemoryGuestInsightsStore()
  await guestInsights.init()
  const app = Fastify()
  app.decorateRequest('mboxActor', null)
  app.addHook('preHandler', async (request) => {
    const actorId = String(request.headers['x-test-actor-id'] ?? 'emp-lin')
    request.mboxActor = actorContext(repository.state, actorId)
  })
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = error instanceof AuthorizationError || error instanceof TableAccessError
      ? error.statusCode
      : Number((error as Error & { statusCode?: number }).statusCode ?? 400)
    return reply.status(statusCode).send({
      code: (error as Error & { code?: string }).code ?? 'BUSINESS_ERROR',
      message: error.message,
    })
  })
  registerGuestRoutes(app, repository, {
    secret: GUEST_SECRET,
    runtimeMode: 'test',
    allowPaymentSimulation: true,
    now: () => NOW,
    guestInsights,
  })
  registerTaskRoutes(app, repository)
  registerCommerceRoutes(app, repository, { guestTokenSecret: GUEST_SECRET, now: () => NOW })
  registerSongRoutes(app, repository)
  registerPublicReservationRoutes(app, repository, {
    secret: PUBLIC_RESERVATION_SECRET,
    now: () => NOW,
    rateLimitStore: new MemoryRateLimitStore({
      usage: 'test', tenantId: 'tenant-flow-test', storeId: repository.state.store.id,
      hashSecret: 'l'.repeat(32), now: () => NOW,
    }),
  })
  registerReservationRoutes(app, repository)
  await app.ready()
  return { app, repository, guestInsights }
}

async function guestSession(app: FastifyInstance, tableCode: string, token = '') {
  const response = token
    ? await app.inject({ method: 'POST', url: '/api/guest/session', payload: { token } })
    : await app.inject({ method: 'GET', url: `/api/guest/session?table=${encodeURIComponent(tableCode)}` })
  expect(response.statusCode, response.body).toBe(200)
  return response.json() as GuestSessionResponse
}

async function taskAction(app: FastifyInstance, taskId: string, actorId: string, action: 'accept' | 'arrive' | 'complete', suffix: string) {
  const response = await app.inject({
    method: 'POST',
    url: `/api/tasks/${taskId}/actions`,
    headers: employeeHeaders(actorId),
    payload: {
      action,
      actorId,
      note: action === 'complete' ? '现场服务已完成' : '',
      idempotencyKey: `client-flow-${suffix}-${action}`,
    },
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}

const apps: FastifyInstance[] = []
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())))

describe('客户端指令到责任岗位完整流转', () => {
  it('把客户心情记录为客情信息而不打扰员工队列，同时保留匿名行为数据', async () => {
    const { app, repository, guestInsights } = await buildFixture()
    apps.push(app)
    const session = await guestSession(app, 'L01')
    const guestHeaders = { 'x-mbox-guest-id': session.guestIdentity.anonymousId }
    const taskCountBefore = repository.state.tasks.length
    const behavior = await app.inject({
      method: 'POST', url: '/api/guest/events', headers: guestHeaders,
      payload: {
        tableToken: session.tableToken,
        eventType: 'mood_selected',
        metadata: { moodId: 'tipsy', previousMoodId: null },
        idempotencyKey: 'client-flow-mood-event-0001',
      },
    })
    expect(behavior.statusCode, behavior.body).toBe(202)
    expect(repository.state.tasks).toHaveLength(taskCountBefore)
    expect(repository.state.tables.find((table) => table.code === 'L01')?.guestMood).toMatchObject({
      moodId: 'tipsy',
      tableSessionId: session.account.tableSessionId,
    })
    const employeeProjection = projectRuntimeStateForActor(repository.state, actorContext(repository.state, 'emp-lin'))
    expect(employeeProjection.tasks.filter(taskQueueIsVisible)).toHaveLength(
      repository.state.tasks.filter(taskQueueIsVisible).length,
    )
    expect(guestInsights.events).toContainEqual(expect.objectContaining({
      anonymousId: session.guestIdentity.anonymousId,
      tableSessionId: session.account.tableSessionId,
      eventType: 'mood_selected',
      metadata: { moodId: 'tipsy', previousMoodId: null },
    }))

    const refreshed = await guestSession(app, 'L01', session.tableToken)
    expect(refreshed.tasks).not.toContainEqual(expect.objectContaining({ serviceTypeCode: 'GUEST_MOOD_INFO' }))
  })

  it('让全部顾客服务类型进入正确责任人队列，并由责任人闭环后从客户端待办消失', async () => {
    const { app, repository } = await buildFixture()
    apps.push(app)
    const cases = [
      { tableCode: 'L01', serviceCode: 'ADD_WATER' },
      { tableCode: 'L02', serviceCode: 'ADD_ICE_LEMON' },
      { tableCode: 'L01', serviceCode: 'ORDER_HELP' },
      { tableCode: 'L02', serviceCode: 'REQUEST_BILL' },
      { tableCode: 'S01', serviceCode: 'COMPLAINT' },
      { tableCode: 'W01', serviceCode: 'BIRTHDAY_CARE' },
      { tableCode: 'B01', serviceCode: 'CUSTOM_REQUEST' },
    ]

    const firstSession = await guestSession(app, 'L01')
    expect(firstSession.serviceTypes.map((item) => item.code)).toEqual(expect.arrayContaining([
      'GUEST_MOOD_INFO',
      ...cases.map((item) => item.serviceCode),
    ]))

    for (const [index, item] of cases.entries()) {
      const session = index === 0 ? firstSession : await guestSession(app, item.tableCode)
      const serviceType = session.serviceTypes.find((candidate) => candidate.code === item.serviceCode)
      expect(serviceType, `客户端缺少服务类型 ${item.serviceCode}`).toBeTruthy()
      const created = await app.inject({
        method: 'POST',
        url: '/api/guest/tasks',
        payload: {
          tableToken: session.tableToken,
          serviceTypeId: serviceType!.id,
          note: item.serviceCode === 'CUSTOM_REQUEST' ? '需要两杯温水并暂时不要打扰' : '',
          idempotencyKey: `client-flow-service-${index}-0001`,
        },
      })
      expect(created.statusCode, created.body).toBe(201)
      const taskId = created.json().id as string
      const task = repository.state.tasks.find((candidate) => candidate.id === taskId)!
      expect(task.source).toBe('guest')
      expect(task.ownerId).toBeTruthy()
      expect(task.notifiedEmployeeIds).toContain(task.ownerId)
      expect(effectiveRoleIdsForEmployee(repository.state, task.ownerId!).some((roleId) => task.dispatchRoleIdsSnapshot?.includes(roleId))).toBe(true)

      const ownerProjection = projectRuntimeStateForActor(repository.state, actorContext(repository.state, task.ownerId!))
      expect(ownerProjection.tasks.some((candidate) => candidate.id === task.id)).toBe(true)

      await taskAction(app, task.id, task.ownerId!, 'accept', `service-${index}`)
      await taskAction(app, task.id, task.ownerId!, 'arrive', `service-${index}`)
      await taskAction(app, task.id, task.ownerId!, 'complete', `service-${index}`)

      const refreshed = await guestSession(app, item.tableCode, session.tableToken)
      expect(refreshed.tasks.some((candidate) => candidate.id === task.id)).toBe(false)
      expect(visibleGuestTasks(refreshed.tasks).some((candidate) => candidate.id === task.id)).toBe(false)
      expect(repository.state.tasks.find((candidate) => candidate.id === task.id)?.status).toBe('confirmed')
      expect(repository.state.taskEvents.some((event) => event.taskId === task.id && event.type === 'service.closed_by_staff.v1')).toBe(true)
    }
  })

  it('在主服务员和候补不可用时只向有桌台范围的员工自动改派，并允许责任人完成处理', async () => {
    const { app, repository } = await buildFixture()
    apps.push(app)
    await repository.mutate((state) => {
      state.employees.find((employee) => employee.id === 'emp-lin')!.paused = true
      state.employees.find((employee) => employee.id === 'emp-jie')!.paused = true
      state.revision += 1
    })
    const session = await guestSession(app, 'L01')
    const water = session.serviceTypes.find((item) => item.code === 'ADD_WATER')!
    const response = await app.inject({
      method: 'POST', url: '/api/guest/tasks',
      payload: { tableToken: session.tableToken, serviceTypeId: water.id, note: '', idempotencyKey: 'client-flow-fallback-0001' },
    })
    expect(response.statusCode, response.body).toBe(201)
    const task = repository.state.tasks.find((candidate) => candidate.id === response.json().id)!
    expect(task.ownerId).toBe('emp-qing')
    expect(task.ownerId).not.toBe('emp-wu')
    await taskAction(app, task.id, task.ownerId!, 'accept', 'fallback')
    await taskAction(app, task.id, task.ownerId!, 'arrive', 'fallback')
    await taskAction(app, task.id, task.ownerId!, 'complete', 'fallback')
  })

  it('把顾客点单支付分流给吧台和厨房，并在制作后转给取送责任人直至客户端显示送达', async () => {
    const { app, repository } = await buildFixture()
    apps.push(app)
    const session = await guestSession(app, 'L01')
    const orderResponse = await app.inject({
      method: 'POST', url: '/api/guest/orders',
      payload: {
        tableToken: session.tableToken,
        items: [
          { productId: 'product-cocktail', quantity: 1 },
          { productId: 'product-fruit', quantity: 1 },
          { productId: 'product-snack', quantity: 1 },
        ],
        idempotencyKey: 'client-flow-order-0001',
      },
    })
    expect(orderResponse.statusCode, orderResponse.body).toBe(201)
    expect(repository.state.orderDomain.kdsTasks).toHaveLength(0)
    const orderId = orderResponse.json().id as string
    const checkout = await app.inject({
      method: 'POST', url: '/api/guest/checkout',
      payload: { tableToken: session.tableToken, orderId, idempotencyKey: 'client-flow-checkout-0001' },
    })
    expect(checkout.statusCode, checkout.body).toBe(201)
    expect(checkout.json().paymentIntent.status).toBe('succeeded')
    expect(repository.state.orderDomain.kdsTasks).toHaveLength(3)
    expect(repository.state.commercialOps?.printJobs).toHaveLength(2)

    const barTask = repository.state.orderDomain.kdsTasks.find((task) => task.stationId === 'bar-main')!
    const denied = await app.inject({
      method: 'POST', url: `/api/commerce/kds/${barTask.id}/actions`, headers: employeeHeaders('emp-han'),
      payload: { action: 'start', actorId: 'emp-han', idempotencyKey: 'client-flow-wrong-station-0001' },
    })
    expect(denied.statusCode).toBe(403)

    for (const [index, initialTask] of repository.state.orderDomain.kdsTasks.entries()) {
      const producerId = initialTask.stationId === 'bar-main' ? 'emp-qing' : 'emp-han'
      for (const action of ['start', 'complete'] as const) {
        const response = await app.inject({
          method: 'POST', url: `/api/commerce/kds/${initialTask.id}/actions`, headers: employeeHeaders(producerId),
          payload: { action, actorId: producerId, idempotencyKey: `client-flow-kds-${index}-${action}` },
        })
        expect(response.statusCode, response.body).toBe(200)
      }
      const completedTask = repository.state.orderDomain.kdsTasks.find((task) => task.id === initialTask.id)!
      const deliveryTask = repository.state.tasks.find((task) => task.id === completedTask.deliveryServiceTask?.id)!
      expect(deliveryTask.id.length).toBeLessThanOrEqual(100)
      expect(deliveryTask.ownerId).toBeTruthy()
      const deliveryProjection = projectRuntimeStateForActor(repository.state, actorContext(repository.state, deliveryTask.ownerId!))
      expect(deliveryProjection.tasks.some((task) => task.id === deliveryTask.id)).toBe(true)
      await taskAction(app, deliveryTask.id, deliveryTask.ownerId!, 'accept', `delivery-${index}`)
      await taskAction(app, deliveryTask.id, deliveryTask.ownerId!, 'arrive', `delivery-${index}`)
      await taskAction(app, deliveryTask.id, deliveryTask.ownerId!, 'complete', `delivery-${index}`)
    }

    const finalState = repository.state
    expect(finalState.orderDomain.orders.find((order) => order.id === orderId)?.status).toBe('fulfilled')
    expect(finalState.orderDomain.kdsTasks.every((task) => task.status === 'delivered')).toBe(true)
    const cashierProjection = projectRuntimeStateForActor(finalState, actorContext(finalState, 'emp-cashier'))
    expect(cashierProjection.paymentDomain.paymentIntents.some((intent) => intent.orderIds.includes(orderId) && intent.status === 'succeeded')).toBe(true)
    const refreshed = await guestSession(app, 'L01', session.tableToken)
    const clientOrder = refreshed.account.orders.find((order) => order.id === orderId)!
    expect(clientOrder.items.every((item) => item.fulfillmentStatus === 'delivered')).toBe(true)
  })

  it('把点歌依次交给服务确认、收银收费和舞台运营，并把每一步同步回客户端', async () => {
    const { app, repository } = await buildFixture()
    apps.push(app)
    const session = await guestSession(app, 'L01')
    const offer = session.songOffers.find((item) => item.requestAvailable)!
    const created = await app.inject({
      method: 'POST', url: '/api/guest/song-requests',
      payload: {
        tableToken: session.tableToken,
        appearanceId: offer.appearanceId,
        singerId: offer.singerId,
        songId: offer.songId,
        customerNote: '朋友生日，希望合适时互动一下',
        idempotencyKey: 'client-flow-song-0001',
      },
    })
    expect(created.statusCode, created.body).toBe(201)
    const requestId = created.json().id as string
    for (const actorId of ['emp-lin', 'emp-mia', 'emp-chen']) {
      const projection = projectRuntimeStateForActor(repository.state, actorContext(repository.state, actorId))
      expect(projection.songState.requests.some((request) => request.id === requestId)).toBe(true)
    }

    const actions = [
      { actorId: 'emp-lin', action: 'confirm', key: 'confirm' },
      { actorId: 'emp-mia', action: 'accept', key: 'accept' },
      { actorId: 'emp-mia', action: 'start', key: 'start' },
      { actorId: 'emp-mia', action: 'complete', key: 'complete' },
    ] as const
    const confirmed = await app.inject({
      method: 'POST', url: `/api/songs/requests/${requestId}/actions`, headers: employeeHeaders(actions[0].actorId),
      payload: { action: actions[0].action, idempotencyKey: `client-flow-song-${actions[0].key}` },
    })
    expect(confirmed.statusCode, confirmed.body).toBe(200)
    expect(confirmed.json().status).toBe('pending_payment')
    const payment = await app.inject({
      method: 'POST', url: `/api/songs/requests/${requestId}/payment`, headers: employeeHeaders('emp-cashier'),
      payload: { paymentReference: 'POS-SONG-0001', collectionChannel: 'physical_pos', idempotencyKey: 'client-flow-song-payment' },
    })
    expect(payment.statusCode, payment.body).toBe(200)
    expect(payment.json().status).toBe('paid')
    for (const item of actions.slice(1)) {
      const response = await app.inject({
        method: 'POST', url: `/api/songs/requests/${requestId}/actions`, headers: employeeHeaders(item.actorId),
        payload: { action: item.action, idempotencyKey: `client-flow-song-${item.key}` },
      })
      expect(response.statusCode, response.body).toBe(200)
    }
    const refreshed = await guestSession(app, 'L01', session.tableToken)
    expect(refreshed.songRequests.find((request) => request.id === requestId)?.status).toBe('completed')
  })

  it('让线上预约实时进入服务与经理工作台，并在到店入座后自动生成生日关怀任务', async () => {
    const { app, repository } = await buildFixture()
    apps.push(app)
    const publicSession = await app.inject({ method: 'POST', url: '/api/public/reservation-session' })
    expect(publicSession.statusCode, publicSession.body).toBe(200)
    const authorization = { authorization: `Bearer ${publicSession.json().accessToken}` }
    const created = await app.inject({
      method: 'POST', url: '/api/public/reservations', headers: authorization,
      payload: {
        customerName: '完整流转测试客人', phone: '13800138000', partySize: 4,
        areaPreferenceCode: 'lounge', occasionCode: 'birthday', occasionNote: '到店后再确认生日歌',
        scheduledAt: new Date(NOW + 60 * 60_000).toISOString(), idempotencyKey: 'client-flow-reservation-0001',
      },
    })
    expect(created.statusCode, created.body).toBe(201)
    const reservationId = created.json().id as string
    for (const actorId of ['emp-lin', 'emp-jie', 'emp-wu', 'emp-chen']) {
      const projection = projectRuntimeStateForActor(repository.state, actorContext(repository.state, actorId))
      expect(projection.reservationState?.reservations.some((reservation) => reservation.id === reservationId)).toBe(true)
    }

    for (const [action, extra] of [
      ['confirm', {}],
      ['arrive', {}],
      ['seat', { tableId: 'table-l04' }],
    ] as const) {
      const response = await app.inject({
        method: 'POST', url: `/api/reservations/${reservationId}/actions`, headers: employeeHeaders('emp-chen'),
        payload: { action, ...extra, idempotencyKey: `client-flow-reservation-${action}` },
      })
      expect(response.statusCode, response.body).toBe(200)
    }
    const birthdayTask = repository.state.tasks.find((task) => task.triggerId === reservationId && task.serviceTypeId === 'birthday')!
    expect(birthdayTask.ownerId).toBe('emp-mia')
    await taskAction(app, birthdayTask.id, birthdayTask.ownerId!, 'accept', 'reservation-birthday')
    await taskAction(app, birthdayTask.id, birthdayTask.ownerId!, 'arrive', 'reservation-birthday')
    await taskAction(app, birthdayTask.id, birthdayTask.ownerId!, 'complete', 'reservation-birthday')
    expect(repository.state.awaitingOrderIntents.some((intent) => intent.tableId === 'table-l04' && intent.status === 'active')).toBe(true)

    const clientList = await app.inject({ method: 'GET', url: '/api/public/reservations', headers: authorization })
    expect(clientList.statusCode, clientList.body).toBe(200)
    expect(clientList.json().reservations.find((reservation: { id: string }) => reservation.id === reservationId)).toMatchObject({
      status: 'seated', tableCode: 'L04',
    })
  })

  it('让店长监督他人任务并安全转派给合适的第三人', async () => {
    const { app, repository } = await buildFixture()
    apps.push(app)
    const session = await guestSession(app, 'L01')
    const water = session.serviceTypes.find((item) => item.code === 'ADD_WATER')!
    const created = await app.inject({
      method: 'POST',
      url: '/api/guest/tasks',
      payload: {
        tableToken: session.tableToken,
        serviceTypeId: water.id,
        note: '请加两杯水',
        idempotencyKey: 'manager-transfer-flow-source',
      },
    })
    expect(created.statusCode, created.body).toBe(201)
    const taskId = created.json().id as string
    expect(repository.state.tasks.find((task) => task.id === taskId)?.ownerId).toBe('emp-lin')

    const denied = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/manager-actions`,
      headers: employeeHeaders('emp-wu'),
      payload: {
        action: 'takeover',
        actorId: 'emp-wu',
        targetEmployeeId: null,
        note: '',
        idempotencyKey: 'manager-transfer-flow-denied',
      },
    })
    expect(denied.statusCode).toBe(403)

    const candidates = await app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/transfer-candidates`,
      headers: employeeHeaders('emp-chen'),
    })
    expect(candidates.statusCode, candidates.body).toBe(200)
    expect(candidates.json()).toContainEqual(expect.objectContaining({ employeeId: 'emp-jie' }))

    const transferred = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/manager-actions`,
      headers: employeeHeaders('emp-chen'),
      payload: {
        action: 'transfer',
        actorId: 'emp-chen',
        targetEmployeeId: 'emp-jie',
        note: '',
        idempotencyKey: 'manager-transfer-flow-action',
      },
    })
    expect(transferred.statusCode, transferred.body).toBe(200)
    expect(transferred.json()).toMatchObject({ id: taskId, ownerId: 'emp-jie', status: 'pending' })
    expect(repository.state.taskEvents.find((event) => event.taskId === taskId && event.type === 'task.manager_transferred.v1')?.payload)
      .toMatchObject({ previousOwnerId: 'emp-lin', ownerId: 'emp-jie' })
  })
})
