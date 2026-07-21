import { createHash } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeState } from '../src/shared/contracts.js'
import type { WechatAuthenticatedPrincipal } from '../src/shared/wechat-contracts.js'
import { registerCommerceRoutes } from './commerce-api.js'
import { applyTaskAction, createServiceTask } from './domain.js'
import { registerGuestRoutes } from './guest-api.js'
import { registerPaymentRoutes } from './payment-api.js'
import {
  processAwaitingOrderReminders,
  registerProactiveServiceRoutes,
} from './proactive-service.js'
import { registerReservationRoutes } from './reservation-api.js'
import type { RuntimeRepository, RuntimeRepositoryHealth } from './repository.js'
import { createSeedState } from './seed.js'
import type { WechatApiSessionRecord } from './wechat-api.js'
import { registerWechatReservationRoutes } from './wechat-reservation-api.js'
import { registerBusinessDayRoutes } from './business-day-api.js'
import { reconcileAutomaticBusinessDay } from './business-day-rollover.js'
import { registerTableSessionRoutes } from './table-session-api.js'

const WECHAT_TOKEN = 'n'.repeat(43)
const GUEST_TOKEN_SECRET = 'night-operations-simulation-secret-v1'
const WECHAT_APP_ID = 'wx-mbox-night-simulation'

function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('base64url')
}

function nextBusinessDate(businessDate: string) {
  const next = new Date(`${businessDate}T00:00:00.000Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  return next.toISOString().slice(0, 10)
}

class MemoryRuntimeRepository implements RuntimeRepository {
  state = createSeedState()

  async init() {}

  async read() {
    return structuredClone(this.state)
  }

  async mutate<T>(mutation: (state: RuntimeState) => T | Promise<T>) {
    const working = structuredClone(this.state)
    const result = await mutation(working)
    this.state = working
    return result
  }

  async reset() {
    this.state = createSeedState()
    return structuredClone(this.state)
  }

  async healthCheck(): Promise<RuntimeRepositoryHealth> {
    return { ready: true, repository: 'memory', revision: this.state.revision }
  }

  async close() {}
}

function employeeHeaders(actorId: string, roleId: string) {
  return {
    'x-test-actor-id': actorId,
    'x-test-role-id': roleId,
  }
}

async function completeServiceTask(repository: MemoryRuntimeRepository, taskId: string, resolution: string) {
  await repository.mutate((state) => {
    const task = state.tasks.find((candidate) => candidate.id === taskId)
    if (!task?.ownerId) throw new Error(`任务 ${taskId} 没有可执行责任人`)
    for (const [action, note] of [
      ['accept', '已接单'],
      ['arrive', '已到桌'],
      ['complete', resolution],
    ] as const) {
      applyTaskAction(state, task.id, {
        action,
        actorId: task.ownerId,
        note,
        idempotencyKey: `night-sim-${task.id}-${action}`,
      })
    }
  })
}

async function createQuickOrder(
  app: FastifyInstance,
  tableId: string,
  productId: string,
  quantity: number,
  key: string,
) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/commerce/quick-orders',
    headers: employeeHeaders('emp-lin', 'server'),
    payload: { tableId, productId, quantity, actorId: 'payload-must-not-win', idempotencyKey: key },
  })
  expect(response.statusCode).toBe(201)
  return response.json()
}

async function kdsAction(
  app: FastifyInstance,
  taskId: string,
  action: 'start' | 'complete' | 'pickUp' | 'deliver',
  actorId: string,
  roleId: string,
) {
  const response = await app.inject({
    method: 'POST',
    url: `/api/commerce/kds/${taskId}/actions`,
    headers: employeeHeaders(actorId, roleId),
    payload: {
      action,
      actorId: 'payload-must-not-win',
      idempotencyKey: `night-sim-${taskId}-${action}`,
    },
  })
  expect(response.statusCode).toBe(200)
  return response.json()
}

async function buildFixture() {
  const app = Fastify()
  const repository = new MemoryRuntimeRepository()
  const now = Date.now()
  const principal: WechatAuthenticatedPrincipal = {
    tenantId: 'mbox',
    storeId: repository.state.store.id,
    appId: WECHAT_APP_ID,
    principalId: 'night-simulation-customer',
    identityId: 'identity-night-simulation-customer',
    memberId: 'member-amy',
    hasUnionId: true,
  }
  const wechatSession: WechatApiSessionRecord = {
    accessTokenHash: tokenHash(WECHAT_TOKEN),
    principal,
    issuedAt: now - 60_000,
    expiresAt: now + 3_600_000,
    revokedAt: null,
  }

  app.decorateRequest('mboxActor', null)
  app.addHook('preHandler', async (request) => {
    request.mboxActor = {
      actorId: String(request.headers['x-test-actor-id'] ?? 'emp-lin'),
      roleId: String(request.headers['x-test-role-id'] ?? 'server'),
      storeId: repository.state.store.id,
      runtimeMode: 'test',
      authenticatedBy: 'local_header',
    }
  })
  app.setErrorHandler((error, _request, reply) => {
    const candidate = error as Error & { statusCode?: number; code?: string }
    return reply.status(candidate.statusCode ?? 400).send({
      code: candidate.code ?? 'BUSINESS_ERROR',
      message: candidate.message,
    })
  })

  registerWechatReservationRoutes(app, repository, {
    identityRepository: {
      async findSession(hash) {
        return hash === wechatSession.accessTokenHash ? structuredClone(wechatSession) : null
      },
    },
    tenantId: principal.tenantId,
    storeId: principal.storeId,
    appId: principal.appId,
    now: () => now,
  })
  registerReservationRoutes(app, repository)
  registerGuestRoutes(app, repository, {
    secret: GUEST_TOKEN_SECRET,
    runtimeMode: 'test',
    now: () => now,
  })
  registerProactiveServiceRoutes(app, repository)
  registerCommerceRoutes(app, repository)
  registerPaymentRoutes(app, repository)
  registerTableSessionRoutes(app, repository)
  registerBusinessDayRoutes(app, repository)
  await app.ready()
  return { app, repository, now }
}

const apps: FastifyInstance[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

describe('真实营业夜间全链路仿真', () => {
  it('北京时间06:00自动切日后仍可补交并复核前一营业日财务', async () => {
    const { app, repository } = await buildFixture()
    apps.push(app)
    const businessDate = repository.state.store.businessDate
    const followingDate = nextBusinessDate(businessDate)
    const rolloverAt = new Date(`${followingDate}T06:00:00+08:00`)

    const rollover = await repository.mutate((state) => reconcileAutomaticBusinessDay(state, rolloverAt))
    expect(rollover.status).toBe('rolled_over')
    expect(repository.state.store.businessDate).toBe(followingDate)

    const settlement = await app.inject({
      method: 'GET', url: `/api/business-days/${businessDate}/payment-settlement`,
      headers: employeeHeaders('emp-cashier', 'cashier'),
    })
    expect(settlement.statusCode, settlement.body).toBe(200)

    const handover = await app.inject({
      method: 'POST', url: `/api/business-days/${businessDate}/cashier-handovers`,
      headers: employeeHeaders('emp-cashier', 'cashier'),
      payload: {
        confirmedActualAmounts: { cash: 0, physical_pos: 0, wechat: 0, alipay: 0, unionpay: 0 },
        issues: [], deviceId: 'cashier-historical-close', idempotencyKey: 'historical-handover-submit-0001',
      },
    })
    expect(handover.statusCode, handover.body).toBe(201)

    const review = await app.inject({
      method: 'POST', url: `/api/business-days/${businessDate}/cashier-handovers/${handover.json().id}/review`,
      headers: employeeHeaders('emp-chen', 'manager'),
      payload: { decision: 'approve', note: '补核对完成', idempotencyKey: 'historical-handover-review-0001' },
    })
    expect(review.statusCode, review.body).toBe(200)
    expect(review.json().status).toBe('closed')
    expect(repository.state.store.businessDate).toBe(followingDate)
    expect(repository.state.auditEntries).toContainEqual(expect.objectContaining({
      action: 'cashier_handover.approved_and_closed.v1',
      objectId: handover.json().id,
    }))
  })

  it('手机预约到店入座后应真正开台，并让生日执行任务保留预约关联', async () => {
    const { app, repository, now } = await buildFixture()
    apps.push(app)
    const reservationResponse = await app.inject({
      method: 'POST',
      url: '/api/wechat/reservations',
      headers: { authorization: `Bearer ${WECHAT_TOKEN}` },
      payload: {
        customerName: 'Amy',
        partySize: 6,
        areaPreferenceCode: 'lounge',
        occasionCode: 'birthday',
        occasionNote: '22:30送果盘并安排生日歌，不要提前透露',
        scheduledAt: new Date(now + 60 * 60_000).toISOString(),
        idempotencyKey: 'night-sim-mobile-reservation-0001',
      },
    })
    expect(reservationResponse.statusCode).toBe(201)
    const reservationId = reservationResponse.json().id as string

    for (const [action, key] of [
      ['confirm', 'night-sim-mobile-confirm-0001'],
      ['arrive', 'night-sim-mobile-arrive-0001'],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/reservations/${reservationId}/actions`,
        headers: employeeHeaders('emp-lin', 'server'),
        payload: { action, idempotencyKey: key },
      })
      expect(response.statusCode).toBe(200)
    }

    const seatedResponse = await app.inject({
      method: 'POST',
      url: `/api/reservations/${reservationId}/actions`,
      headers: employeeHeaders('emp-lin', 'server'),
      payload: {
        action: 'seat',
        tableId: 'table-l03',
        idempotencyKey: 'night-sim-mobile-seat-0001',
      },
    })
    expect(seatedResponse.statusCode, seatedResponse.body).toBe(200)
    expect(seatedResponse.json()).toMatchObject({ status: 'seated', tableCode: 'L03', occasionCode: 'birthday' })

    const state = await repository.read()
    const reservation = state.reservationState.reservations.find((candidate) => candidate.id === reservationId)
    expect(reservation).toMatchObject({ sourceCode: 'wechat', arrivedAt: expect.any(String), seatedAt: expect.any(String) })

    expect.soft(state.tables.find((table) => table.id === 'table-l03')).toMatchObject({
      status: 'occupied',
      guestCount: 6,
      openedAt: expect.any(String),
    })
    expect.soft(state.songState.tableSessions.filter((session) => session.id === reservation?.tableSessionId && session.status === 'open')).toHaveLength(1)
    const birthdayTask = state.tasks.find((task) => task.serviceTypeId === 'birthday' && task.tableId === 'table-l03')
    expect(birthdayTask).toMatchObject({ serviceTypeId: 'birthday', source: 'system', status: 'pending' })
    expect(birthdayTask?.triggerId).toBe(reservationId)
  })

  it('临时到店可以登记、确认到店并入座，且保留现场来源', async () => {
    const { app, repository, now } = await buildFixture()
    apps.push(app)
    const created = await app.inject({
      method: 'POST',
      url: '/api/reservations',
      headers: employeeHeaders('emp-lin', 'server'),
      payload: {
        customerReference: 'walk-in-night-sim-guest',
        customerName: '临时到店客人',
        contactReference: 'front-desk-opaque-contact',
        sourceCode: 'walk_in',
        partySize: 3,
        areaPreferenceCode: 'lounge',
        scheduledAt: new Date(now).toISOString(),
        depositRequiredAmount: 0,
        depositCurrency: 'CNY',
        idempotencyKey: 'night-sim-walk-in-create-0001',
      },
    })
    expect(created.statusCode).toBe(201)
    const reservationId = created.json().id as string

    for (const [action, payload] of [
      ['confirm', { idempotencyKey: 'night-sim-walk-in-confirm-0001' }],
      ['arrive', { idempotencyKey: 'night-sim-walk-in-arrive-0001' }],
      ['seat', {
        tableId: 'table-l04',
        idempotencyKey: 'night-sim-walk-in-seat-0001',
      }],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/reservations/${reservationId}/actions`,
        headers: employeeHeaders('emp-lin', 'server'),
        payload: { action, ...payload },
      })
      expect(response.statusCode, response.body).toBe(200)
    }

    const state = await repository.read()
    expect(state.reservationState.reservations.find((candidate) => candidate.id === reservationId)).toMatchObject({
      sourceCode: 'walk_in',
      status: 'seated',
      tableCode: 'L04',
      deposit: { status: 'not_required' },
    })
  })

  it('同一桌结台后再次接待应生成全新桌次，避免翻台串账', async () => {
    const { app, repository, now } = await buildFixture()
    apps.push(app)

    const seatWalkIn = async (suffix: string) => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/reservations',
        headers: employeeHeaders('emp-lin', 'server'),
        payload: {
          customerReference: `walk-in-turnover-${suffix}`,
          customerName: `翻台客人${suffix}`,
          contactReference: `front-desk-${suffix}`,
          sourceCode: 'walk_in',
          partySize: 2,
          areaPreferenceCode: 'lounge',
          scheduledAt: new Date(now).toISOString(),
          depositRequiredAmount: 0,
          depositCurrency: 'CNY',
          idempotencyKey: `night-sim-turnover-create-${suffix}`,
        },
      })
      expect(created.statusCode).toBe(201)
      for (const action of ['confirm', 'arrive', 'seat'] as const) {
        const response = await app.inject({
          method: 'POST',
          url: `/api/reservations/${created.json().id}/actions`,
          headers: employeeHeaders('emp-lin', 'server'),
          payload: action === 'seat'
            ? { action, tableId: 'table-l04', idempotencyKey: `night-sim-turnover-${action}-${suffix}` }
            : { action, idempotencyKey: `night-sim-turnover-${action}-${suffix}` },
        })
        expect(response.statusCode, response.body).toBe(200)
      }
      const reservation = (await repository.read()).reservationState.reservations
        .find((candidate) => candidate.id === created.json().id)!
      return reservation.tableSessionId!
    }

    const firstSessionId = await seatWalkIn('0001')
    const closed = await app.inject({
      method: 'POST',
      url: '/api/tables/table-l04/close',
      headers: employeeHeaders('emp-cashier', 'cashier'),
      payload: { reason: '首轮客人已离店，无消费账单', idempotencyKey: 'night-sim-turnover-close-0001' },
    })
    expect(closed.statusCode, closed.body).toBe(200)
    expect(closed.json()).toMatchObject({ id: 'table-l04', status: 'available', guestCount: 0, openedAt: null })

    const secondSessionId = await seatWalkIn('0002')
    expect(secondSessionId).not.toBe(firstSessionId)
    const state = await repository.read()
    expect(state.songState.tableSessions.find((session) => session.id === firstSessionId)?.status).toBe('closed')
    expect(state.songState.tableSessions.find((session) => session.id === secondSessionId)?.status).toBe('open')
  })

  it('未点单提醒、客人呼叫、主候补按实时负荷分工、投诉和生日服务都形成可确认闭环', async () => {
    const { app, repository } = await buildFixture()
    apps.push(app)
    const guestSession = await app.inject({ method: 'GET', url: '/api/guest/session?table=L01' })
    expect(guestSession.statusCode).toBe(200)
    const tableToken = guestSession.json().tableToken as string

    const awaiting = await app.inject({
      method: 'POST',
      url: '/api/tables/table-l01/awaiting-order/start',
      headers: employeeHeaders('emp-lin', 'server'),
      payload: {
        actorId: 'payload-must-not-win',
        idempotencyKey: 'night-sim-awaiting-order-0001',
        reason: '客人已入座尚未点单',
      },
    })
    expect(awaiting.statusCode).toBe(201)
    await repository.mutate((state) => {
      const intent = state.awaitingOrderIntents.find((candidate) => candidate.id === awaiting.json().id)!
      processAwaitingOrderReminders(state, new Date(intent.nextReminderAt!))
    })

    const callService = async (serviceTypeId: string, key: string, note: string) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/guest/tasks',
        payload: { tableToken, serviceTypeId, note, idempotencyKey: key },
      })
      expect(response.statusCode).toBe(201)
      return response.json().id as string
    }

    const waterTaskId = await callService('water', 'night-sim-water-call-0001', '请加常温水')
    const backupTaskId = await callService('ice', 'night-sim-backup-call-0001', '请补冰块和柠檬')
    let state = await repository.read()
    const reminder = state.tasks.find((task) => task.triggerId === awaiting.json().id)
    expect(reminder).toMatchObject({ serviceTypeId: 'order-help', source: 'system', ownerId: 'emp-lin' })
    expect(state.tasks.find((task) => task.id === waterTaskId)?.ownerId).toBe('emp-jie')
    expect(state.tasks.find((task) => task.id === backupTaskId)?.ownerId).toBe('emp-lin')

    await completeServiceTask(repository, backupTaskId, '冰块和柠檬已补齐')
    const backupConfirmed = await app.inject({
      method: 'POST',
      url: `/api/guest/tasks/${backupTaskId}/feedback`,
      payload: {
        tableToken,
        action: 'confirm',
        note: '已收到',
        idempotencyKey: 'night-sim-backup-confirm-0001',
      },
    })
    expect(backupConfirmed.statusCode).toBe(200)
    expect(backupConfirmed.json().status).toBe('confirmed')

    for (const [serviceTypeId, key, note, resolution] of [
      ['complaint', 'night-sim-complaint-call-0001', '果盘等待过久且无人解释', '领班解释并完成补救'],
      ['birthday', 'night-sim-birthday-call-0001', '22:30安排生日歌', '生日流程已按客人意愿执行'],
    ] as const) {
      const taskId = await callService(serviceTypeId, key, note)
      await completeServiceTask(repository, taskId, resolution)
      const confirmed = await app.inject({
        method: 'POST',
        url: `/api/guest/tasks/${taskId}/feedback`,
        payload: {
          tableToken,
          action: 'confirm',
          note: '问题已解决',
          idempotencyKey: `${key}-confirm`,
        },
      })
      expect(confirmed.statusCode).toBe(200)
      expect(confirmed.json().status).toBe('confirmed')
    }

    state = await repository.read()
    expect(state.tasks.find((task) => task.serviceTypeId === 'complaint')).toMatchObject({
      priority: 'urgent',
      ownerId: 'emp-qing',
      status: 'confirmed',
    })
    expect(state.tasks.find((task) => task.serviceTypeId === 'birthday')).toMatchObject({ status: 'confirmed' })
  })

  it('点单分别进入吧台和厨房KDS，并由传菜完成送达', async () => {
    const { app, repository } = await buildFixture()
    apps.push(app)
    await createQuickOrder(app, 'table-l01', 'product-beer', 2, 'night-sim-bar-order-0001')
    await createQuickOrder(app, 'table-l01', 'product-fruit', 1, 'night-sim-kitchen-order-0001')

    let state = await repository.read()
    const barTask = state.orderDomain.kdsTasks.find((task) => task.stationId === 'bar-main')!
    const kitchenTask = state.orderDomain.kdsTasks.find((task) => task.stationId === 'kitchen-cold')!
    expect(barTask).toBeDefined()
    expect(kitchenTask).toBeDefined()

    for (const [taskId, actorId, roleId] of [
      [barTask.id, 'emp-qing', 'bartender'],
      [kitchenTask.id, 'emp-han', 'kitchen'],
    ] as const) {
      await kdsAction(app, taskId, 'start', actorId, roleId)
      await kdsAction(app, taskId, 'complete', actorId, roleId)
      await kdsAction(app, taskId, 'pickUp', 'emp-lin', 'server')
      await kdsAction(app, taskId, 'deliver', 'emp-lin', 'server')
    }

    state = await repository.read()
    expect(state.orderDomain.kdsTasks).toHaveLength(2)
    expect(state.orderDomain.kdsTasks.every((task) => task.status === 'delivered')).toBe(true)
    expect(state.orderDomain.orders.every((order) => order.status === 'fulfilled')).toBe(true)
    expect(state.tasks.filter((task) => task.serviceTypeId === 'fulfillment-delivery')).toEqual([
      expect.objectContaining({ status: 'completed' }),
      expect.objectContaining({ status: 'completed' }),
    ])
    expect(state.taskEvents.filter((event) => event.type === 'fulfillment.delivered.v1')).toEqual([
      expect.objectContaining({ actorId: 'emp-lin' }),
      expect.objectContaining({ actorId: 'emp-lin' }),
    ])
  })

  it('服务员不能通过接口操作当前班次责任区外的桌台', async () => {
    const { app, repository } = await buildFixture()
    apps.push(app)
    const denied = await app.inject({
      method: 'POST',
      url: '/api/commerce/quick-orders',
      headers: employeeHeaders('emp-lin', 'server'),
      payload: {
        tableId: 'table-i01', productId: 'product-beer', quantity: 1,
        actorId: 'payload-must-not-win',
        idempotencyKey: 'night-sim-out-of-scope-order-0001',
      },
    })
    expect(denied.statusCode, denied.body).toBe(403)
    expect(denied.json()).toMatchObject({ code: 'AUTHORIZATION_DENIED' })
    expect(denied.json().message).toContain('无权访问桌台')
    expect((await repository.read()).orderDomain.orders).toHaveLength(0)

    const interactiveOrder = await app.inject({
      method: 'POST',
      url: '/api/commerce/quick-orders',
      headers: employeeHeaders('emp-wu', 'server'),
      payload: {
        tableId: 'table-i01', productId: 'product-beer', quantity: 1,
        actorId: 'payload-must-not-win', idempotencyKey: 'night-sim-interactive-order-0001',
      },
    })
    expect(interactiveOrder.statusCode, interactiveOrder.body).toBe(201)
    const tableSessionId = (await repository.read()).songState.tableSessions
      .find((session) => session.tableId === 'table-i01' && session.status === 'open')!.id
    const deniedPayment = await app.inject({
      method: 'POST',
      url: '/api/payments/table-intents',
      headers: employeeHeaders('emp-lin', 'server'),
      payload: {
        tableSessionId, channel: 'physical_pos', deviceId: 'scope-test-device',
        idempotencyKey: 'night-sim-out-of-scope-payment-0001',
      },
    })
    expect(deniedPayment.statusCode, deniedPayment.body).toBe(403)
    expect((await repository.read()).paymentDomain.paymentIntents).toHaveLength(0)
  })

  it('客人发起买单后可完成物理POS收款，并由不同员工完成退款', async () => {
    const { app, repository } = await buildFixture()
    apps.push(app)
    const order = await createQuickOrder(app, 'table-l01', 'product-beer', 2, 'night-sim-payment-order-0001')
    const guestSession = await app.inject({ method: 'GET', url: '/api/guest/session?table=L01' })
    const tableToken = guestSession.json().tableToken as string
    const billCall = await app.inject({
      method: 'POST',
      url: '/api/guest/tasks',
      payload: {
        tableToken,
        serviceTypeId: 'bill',
        note: '请核对账单后刷实体POS',
        idempotencyKey: 'night-sim-bill-call-0001',
      },
    })
    expect(billCall.statusCode).toBe(201)
    await completeServiceTask(repository, billCall.json().id, '账单已核对并交收银处理')
    const billConfirmed = await app.inject({
      method: 'POST',
      url: `/api/guest/tasks/${billCall.json().id}/feedback`,
      payload: {
        tableToken,
        action: 'confirm',
        note: '账单无误',
        idempotencyKey: 'night-sim-bill-confirm-0001',
      },
    })
    expect(billConfirmed.statusCode).toBe(200)

    const tableSessionId = `session:table-l01:${repository.state.store.businessDate}`
    const intentResponse = await app.inject({
      method: 'POST',
      url: '/api/payments/table-intents',
      headers: employeeHeaders('emp-cashier', 'cashier'),
      payload: {
        tableSessionId,
        channel: 'physical_pos',
        deviceId: 'cashier-night-sim',
        idempotencyKey: 'night-sim-pos-intent-0001',
      },
    })
    expect(intentResponse.statusCode).toBe(201)
    const intent = intentResponse.json()

    const posReport = await app.inject({
      method: 'POST',
      url: `/api/payments/${intent.id}/physical-pos-reports`,
      headers: employeeHeaders('emp-cashier', 'cashier'),
      payload: {
        terminalId: 'POS-NIGHT-01',
        terminalTransactionId: 'POS-NIGHT-SALE-0001',
        paymentMethod: '银行卡',
        receiptReference: 'receipt-night-0001',
        deviceId: 'cashier-night-sim',
        idempotencyKey: 'night-sim-pos-report-0001',
      },
    })
    expect(posReport.statusCode).toBe(201)

    const refundResponse = await app.inject({
      method: 'POST',
      url: `/api/payments/${intent.id}/refunds`,
      headers: employeeHeaders('emp-lin', 'server'),
      payload: {
        orderId: order.id,
        orderItemId: order.items[0].id,
        quantity: 1,
        reason: '客人发现一杯重复下单',
        idempotencyKey: 'night-sim-refund-request-0001',
      },
    })
    expect(refundResponse.statusCode).toBe(201)
    expect(refundResponse.json().requestedBy).toBe('emp-lin')

    const refundCompletion = await app.inject({
      method: 'POST',
      url: `/api/payments/refunds/${refundResponse.json().id}/physical-pos-complete`,
      headers: employeeHeaders('emp-chen', 'manager'),
      payload: {
        terminalRefundTransactionId: 'POS-NIGHT-REFUND-0001',
        reason: '经理复核原小票后确认终端退款',
        idempotencyKey: 'night-sim-refund-complete-0001',
      },
    })
    expect(refundCompletion.statusCode).toBe(200)
    expect(refundCompletion.json()).toMatchObject({
      status: 'succeeded',
      requestedBy: 'emp-lin',
      decidedBy: 'emp-chen',
      channelRefundTransactionId: 'POS-NIGHT-REFUND-0001',
    })

    const state = await repository.read()
    expect(state.tasks.find((task) => task.id === billCall.json().id)?.status).toBe('confirmed')
    expect(state.paymentDomain.physicalPosReports).toHaveLength(1)
    expect(state.paymentDomain.refunds).toEqual([expect.objectContaining({ status: 'succeeded' })])
  })

  it('闭店时自动归档未完成现场事项，保留原状态并以干净现场进入下一营业日', async () => {
    const { app, repository } = await buildFixture()
    apps.push(app)
    const businessDate = repository.state.store.businessDate
    const followingDate = nextBusinessDate(businessDate)
    await createQuickOrder(app, 'table-l01', 'product-fruit', 1, 'night-sim-unfinished-order-0001')
    const unfinishedTask = await repository.mutate((state) => {
      const task = createServiceTask(state, {
        tableCode: 'L01',
        serviceTypeId: 'complaint',
        source: 'employee',
        note: '闭店前仍未处理的投诉',
        idempotencyKey: 'night-sim-unfinished-complaint-0001',
        requestedBy: 'emp-mia',
      })
      state.dutyManagerIncidents = [{
        id: 'incident-night-close', riskId: 'risk-night-close', cycle: 1, businessDate,
        severity: 'high', category: 'service', title: '闭店前服务未完成', detail: '用于验证日结归档',
        tableCode: 'L01', recommendedCommand: '打开任务', status: 'acknowledged',
        firstDetectedAt: new Date().toISOString(), lastDetectedAt: new Date().toISOString(), observationCount: 1,
        acknowledgedAt: new Date().toISOString(), acknowledgedBy: 'emp-chen', deferredAt: null, deferredBy: null,
        deferredUntil: null, dismissedAt: null, dismissedBy: null, dismissedReason: null,
        resolvedAt: null, resolvedBy: null, resolution: null,
      }]
      return task
    })

    const blocked = await app.inject({
      method: 'POST',
      url: `/api/business-days/${businessDate}/close`,
      headers: employeeHeaders('emp-chen', 'manager'),
      payload: {
        nextBusinessDate: followingDate,
        idempotencyKey: 'night-sim-close-business-day-0001',
      },
    })
    expect(blocked.statusCode, blocked.body).toBe(409)
    expect(blocked.json().blockers).toEqual([
      expect.objectContaining({ kind: 'cashier_handover_missing' }),
    ])
    expect((await repository.read()).tasks.find((task) => task.id === unfinishedTask.id)?.archivedAt).toBeNull()

    const handover = await app.inject({
      method: 'POST', url: `/api/business-days/${businessDate}/cashier-handovers`,
      headers: employeeHeaders('emp-cashier', 'cashier'),
      payload: {
        confirmedActualAmounts: { cash: 0, physical_pos: 0, wechat: 0, alipay: 0, unionpay: 0 },
        issues: [], deviceId: 'cashier-night-close', idempotencyKey: 'night-sim-archive-handover-0001',
      },
    })
    expect(handover.statusCode, handover.body).toBe(201)
    const review = await app.inject({
      method: 'POST', url: `/api/business-days/${businessDate}/cashier-handovers/${handover.json().id}/review`,
      headers: employeeHeaders('emp-chen', 'manager'),
      payload: { decision: 'approve', note: '账务核对完成', idempotencyKey: 'night-sim-archive-review-0001' },
    })
    expect(review.statusCode, review.body).toBe(200)
    const response = await app.inject({
      method: 'POST', url: `/api/business-days/${businessDate}/close`,
      headers: employeeHeaders('emp-chen', 'manager'),
      payload: { nextBusinessDate: followingDate, idempotencyKey: 'night-sim-close-business-day-0001' },
    })
    expect(response.statusCode, response.body).toBe(200)

    const state = await repository.read()
    expect(state.store.businessDate).toBe(followingDate)
    expect(state.tasks.find((task) => task.id === unfinishedTask.id)).toMatchObject({
      status: 'cancelled', archivedFromStatus: 'pending', archiveOutcome: 'unresolved',
      resolution: '营业日结束时需求仍未完成',
    })
    expect(state.orderDomain.kdsTasks.every((task) => task.exceptionEvents?.some((event) => (
      event.type === 'manager_disposition' && event.managerDisposition === 'cancelled'
    )))).toBe(true)
    expect(state.songState.tableSessions.every((session) => session.status === 'closed')).toBe(true)
    expect(state.tables.every((table) => !['occupied', 'reserved'].includes(table.status))).toBe(true)
    expect(state.dutyManagerIncidents?.every((incident) => incident.status === 'resolved')).toBe(true)
    expect(state.auditEntries.find((entry) => entry.action === 'business_day.closed.v1')?.details.archiveSummary)
      .toMatchObject({ serviceTasks: expect.any(Number), kdsTasks: expect.any(Number), dutyIncidents: 1 })
  })

  it('所有阻断项清零后经理可日结，生成次日班次且重放幂等', async () => {
    const { app, repository } = await buildFixture()
    apps.push(app)
    const businessDate = repository.state.store.businessDate
    const followingDate = nextBusinessDate(businessDate)
    await repository.mutate((state) => {
      state.tasks = []
      state.orderDomain.kdsTasks = []
      state.paymentDomain.paymentIntents = []
      state.paymentDomain.refunds = []
      state.benefitRedemptions = []
      state.reservationState.reservations = []
      for (const session of state.songState.tableSessions) {
        session.status = 'closed'
        session.closedAt = new Date().toISOString()
      }
    })

    const handoverResponse = await app.inject({
      method: 'POST',
      url: `/api/business-days/${businessDate}/cashier-handovers`,
      headers: employeeHeaders('emp-cashier', 'cashier'),
      payload: {
        confirmedActualAmounts: { cash: 0, physical_pos: 0, wechat: 0, alipay: 0, unionpay: 0 },
        issues: [], deviceId: 'cashier-test', idempotencyKey: 'night-sim-handover-submit-0001',
      },
    })
    expect(handoverResponse.statusCode, handoverResponse.body).toBe(201)
    const reviewResponse = await app.inject({
      method: 'POST',
      url: `/api/business-days/${businessDate}/cashier-handovers/${handoverResponse.json().id}/review`,
      headers: employeeHeaders('emp-chen', 'manager'),
      payload: { decision: 'approve', note: '经理独立核对通过', idempotencyKey: 'night-sim-handover-review-0001' },
    })
    expect(reviewResponse.statusCode, reviewResponse.body).toBe(200)

    const request = {
      method: 'POST' as const,
      url: `/api/business-days/${businessDate}/close`,
      headers: employeeHeaders('emp-chen', 'manager'),
      payload: { nextBusinessDate: followingDate, idempotencyKey: 'night-sim-close-success-0001' },
    }
    const first = await app.inject(request)
    const replay = await app.inject(request)
    expect(first.statusCode, first.body).toBe(200)
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json()).toEqual(first.json())
    expect(first.json()).toMatchObject({
      status: 'closed', businessDate, nextBusinessDate: followingDate,
      shiftContinuity: { source: 'copied' },
    })

    const state = await repository.read()
    expect(state.store.businessDate).toBe(followingDate)
    expect(state.songState.businessDate).toBe(followingDate)
    expect(state.shiftAssignments.filter((shift) => shift.businessDate === businessDate).every((shift) => shift.status === 'completed')).toBe(true)
    expect(state.shiftAssignments.filter((shift) => shift.businessDate === followingDate && shift.status === 'active')).toHaveLength(13)
    expect(state.employees.every((employee) => !employee.online && !employee.paused)).toBe(true)
    expect(state.auditEntries.filter((entry) => entry.action === 'business_day.closed.v1')).toHaveLength(1)
    expect(state.auditEntries.filter((entry) => entry.action === 'business_day.shift_continuity_prepared.v1')).toHaveLength(1)
  })
})
