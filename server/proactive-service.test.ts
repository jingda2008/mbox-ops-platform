import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { AuthorizationError } from './authorization.js'
import { JsonRepository } from './repository.js'
import { createSeedState } from './seed.js'
import {
  completeAwaitingOrderOnOrder,
  processAwaitingOrderReminders,
  registerProactiveServiceRoutes,
  snoozeAwaitingOrder,
  startAwaitingOrder,
  stopAwaitingOrder,
} from './proactive-service.js'

const T0 = new Date('2026-07-14T12:00:00.000Z')

describe('awaiting order proactive service', () => {
  it('starts only from an explicit employee action and is idempotent', () => {
    const state = createSeedState()
    const first = startAwaitingOrder(state, 'table-l01', 'emp-lin', 'await-order-start-1', T0)
    const retried = startAwaitingOrder(state, 'table-l01', 'emp-lin', 'await-order-start-1', T0)

    expect(retried.id).toBe(first.id)
    expect(first.status).toBe('active')
    expect(first.reminderCount).toBe(0)
    expect(first.nextReminderAt).toBe('2026-07-14T12:05:00.000Z')
    expect(state.awaitingOrderIntents).toHaveLength(1)
  })

  it('creates an order-help task only when the configured checkpoint is due', () => {
    const state = createSeedState()
    const intent = startAwaitingOrder(state, 'table-l01', 'emp-lin', 'await-order-start-2', T0)

    processAwaitingOrderReminders(state, new Date('2026-07-14T12:04:59.000Z'))
    expect(state.tasks).toHaveLength(0)

    processAwaitingOrderReminders(state, new Date('2026-07-14T12:05:00.000Z'))
    expect(state.tasks).toHaveLength(1)
    expect(state.tasks[0]).toMatchObject({
      tableId: 'table-l01',
      serviceTypeId: 'order-help',
      source: 'system',
      ownerId: 'emp-lin',
      triggerId: intent.id,
    })
    expect(state.tasks[0]?.note).toContain('不要催促消费')
    expect(intent.reminderCount).toBe(1)
  })

  it('does not create duplicate tasks while the previous reminder is still open', () => {
    const state = createSeedState()
    const intent = startAwaitingOrder(state, 'table-l01', 'emp-lin', 'await-order-start-3', T0)
    processAwaitingOrderReminders(state, new Date('2026-07-14T12:05:00.000Z'))
    processAwaitingOrderReminders(state, new Date('2026-07-14T12:10:00.000Z'))

    expect(state.tasks).toHaveLength(1)
    expect(intent.reminderCount).toBe(1)
    expect(intent.nextReminderAt).toBe('2026-07-14T12:15:00.000Z')
  })

  it('closes the intent and outstanding task when the table submits an order', () => {
    const state = createSeedState()
    const intent = startAwaitingOrder(state, 'table-l01', 'emp-lin', 'await-order-start-4', T0)
    processAwaitingOrderReminders(state, new Date('2026-07-14T12:05:00.000Z'))

    const completed = completeAwaitingOrderOnOrder(
      state,
      'table-l01',
      'order-placed-1',
      'emp-lin',
      new Date('2026-07-14T12:06:00.000Z'),
    )

    expect(completed?.status).toBe('completed')
    expect(completed?.stopReason).toBe('order_submitted:order-placed-1')
    expect(state.tasks.find((task) => task.triggerId === intent.id)?.status).toBe('cancelled')
  })

  it('allows an employee to cancel when the guest does not want ordering assistance', () => {
    const state = createSeedState()
    startAwaitingOrder(state, 'table-l01', 'emp-lin', 'await-order-start-5', T0)
    const cancelled = stopAwaitingOrder(
      state,
      'table-l01',
      'emp-lin',
      '客人正在等朋友，暂不需要服务',
      'cancelled',
      new Date('2026-07-14T12:02:00.000Z'),
    )

    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.nextReminderAt).toBeNull()
    expect(cancelled.stopReason).toContain('等朋友')
  })

  it('snoozes without duplicate reminders and resumes exactly at the selected time', () => {
    const state = createSeedState()
    const intent = startAwaitingOrder(state, 'table-l01', 'emp-lin', 'await-order-snooze-start', T0)
    processAwaitingOrderReminders(state, new Date('2026-07-14T12:05:00.000Z'))
    expect(state.tasks).toHaveLength(1)

    const snoozed = snoozeAwaitingOrder(
      state,
      'table-l01',
      'emp-lin',
      30,
      '客人正在等朋友',
      'await-order-snooze-0001',
      new Date('2026-07-14T12:06:00.000Z'),
    )
    expect(snoozed.id).toBe(intent.id)
    expect(snoozed.status).toBe('active')
    expect(snoozed.nextReminderAt).toBe('2026-07-14T12:36:00.000Z')
    expect(state.tasks[0]?.status).toBe('cancelled')

    processAwaitingOrderReminders(state, new Date('2026-07-14T12:35:59.000Z'))
    expect(state.tasks).toHaveLength(1)
    processAwaitingOrderReminders(state, new Date('2026-07-14T12:36:00.000Z'))
    expect(state.tasks).toHaveLength(2)
    expect(state.tasks.filter((task) => task.triggerId === intent.id && task.status === 'pending')).toHaveLength(1)
    expect(state.auditEntries.find((entry) => entry.action === 'awaiting_order.snoozed.v1')).toMatchObject({
      actorId: 'emp-lin',
      details: { snoozeMinutes: 30, reason: '客人正在等朋友' },
    })
  })

  it('uses the authenticated employee for start and stop audit and rejects other roles', async () => {
    const repository = new JsonRepository(`/tmp/mbox-proactive-rbac-${crypto.randomUUID()}.json`)
    await repository.init()
    const app = Fastify()
    app.decorateRequest('mboxActor', null)
    app.addHook('preHandler', async (request) => {
      const roleId = String(request.headers['x-test-role'] ?? 'server')
      const actorIds: Record<string, string> = {
        server: 'emp-lin',
        backup: 'emp-jie',
        specialist: 'emp-qing',
      }
      request.mboxActor = {
        actorId: actorIds[roleId] ?? 'emp-lin',
        storeId: 'mbox-lujiazui',
        roleId,
        runtimeMode: 'test',
        authenticatedBy: 'local_header',
      }
    })
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof AuthorizationError) {
        return reply.status(error.statusCode).send({ code: error.code, operation: error.operation })
      }
      throw error
    })
    registerProactiveServiceRoutes(app, repository)

    const denied = await app.inject({
      method: 'POST',
      url: '/api/tables/table-l02/awaiting-order/start',
      headers: { 'x-test-role': 'specialist' },
      payload: { actorId: 'emp-chen', idempotencyKey: 'proactive-denied-0001', reason: '' },
    })
    expect(denied.statusCode).toBe(403)
    expect(denied.json()).toEqual({
      code: 'AUTHORIZATION_DENIED',
      operation: 'proactive.awaiting-order.start',
    })

    const started = await app.inject({
      method: 'POST',
      url: '/api/tables/table-l02/awaiting-order/start',
      payload: { actorId: 'emp-chen', idempotencyKey: 'proactive-actor-start-0001', reason: '' },
    })
    expect(started.statusCode).toBe(201)
    expect(started.json().startedBy).toBe('emp-lin')

    const snoozed = await app.inject({
      method: 'POST',
      url: '/api/tables/table-l02/awaiting-order/snooze',
      payload: {
        actorId: 'emp-chen',
        snoozeMinutes: 30,
        idempotencyKey: 'proactive-route-snooze-0001',
        reason: '客人希望半小时后再问',
      },
    })
    expect(snoozed.statusCode).toBe(200)
    expect(snoozed.json()).toMatchObject({ status: 'active', startedBy: 'emp-lin' })

    const deniedStop = await app.inject({
      method: 'POST',
      url: '/api/tables/table-l02/awaiting-order/stop',
      headers: { 'x-test-role': 'specialist' },
      payload: {
        actorId: 'emp-chen',
        idempotencyKey: 'proactive-stop-denied-0001',
        reason: '越权停止',
      },
    })
    expect(deniedStop.statusCode).toBe(403)
    expect(deniedStop.json().operation).toBe('proactive.awaiting-order.stop')

    const stopped = await app.inject({
      method: 'POST',
      url: '/api/tables/table-l02/awaiting-order/stop',
      headers: { 'x-test-role': 'backup' },
      payload: {
        actorId: 'emp-chen',
        idempotencyKey: 'proactive-actor-stop-0001',
        reason: '客人稍后再点',
      },
    })
    expect(stopped.statusCode).toBe(200)
    expect(stopped.json().stoppedBy).toBe('emp-jie')

    const state = await repository.read()
    expect(state.auditEntries.find((entry) => entry.action === 'awaiting_order.started.v1')?.actorId).toBe('emp-lin')
    expect(state.auditEntries.find((entry) => entry.action === 'awaiting_order.snoozed.v1')?.actorId).toBe('emp-lin')
    expect(state.auditEntries.find((entry) => entry.action === 'awaiting_order.cancelled.v1')?.actorId).toBe('emp-jie')

    await app.close()
    await repository.close()
  })
})
