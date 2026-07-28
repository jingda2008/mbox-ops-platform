import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { JsonRepository } from './repository.js'
import { registerWaitlistRoutes } from './waitlist-api.js'

async function fixture() {
  const repository = new JsonRepository(`/tmp/mbox-waitlist-${crypto.randomUUID()}.json`)
  await repository.init()
  const app = Fastify()
  app.addHook('preHandler', async (request) => {
    request.mboxActor = {
      actorId: 'emp-chen', storeId: 'mbox-lujiazui', roleId: 'manager',
      runtimeMode: 'test', authenticatedBy: 'local_header',
    }
  })
  registerWaitlistRoutes(app, repository)
  return { app, repository }
}

function guest(name: string, partySize: number, key: string) {
  return {
    customerReference: `crm-${name}`,
    customerName: name,
    contactReference: `wecom-${name}`,
    partySize,
    salesEmployeeId: 'emp-lin',
    maximumWaitMinutes: 120,
    idempotencyKey: key,
  }
}

describe('waitlist API', () => {
  it('preserves queue order, locks one table and seats without losing history', async () => {
    const { app, repository } = await fixture()
    const a = await app.inject({ method: 'POST', url: '/api/waitlist', payload: guest('A组', 2, 'waitlist-join-a-001') })
    const b = await app.inject({ method: 'POST', url: '/api/waitlist', payload: guest('B组', 8, 'waitlist-join-b-001') })
    const c = await app.inject({ method: 'POST', url: '/api/waitlist', payload: guest('C组', 3, 'waitlist-join-c-001') })
    expect([a.statusCode, b.statusCode, c.statusCode]).toEqual([201, 201, 201])
    expect([a.json().joinedSequence, b.json().joinedSequence, c.json().joinedSequence]).toEqual([1, 2, 3])

    const cBlocked = await app.inject({
      method: 'POST', url: `/api/waitlist/${c.json().id}/actions`,
      payload: { action: 'notify', tableId: 'table-l04', reason: '空桌匹配', idempotencyKey: 'waitlist-notify-c-block-001' },
    })
    expect(cBlocked.json().message).toContain('前面还有可匹配候补')

    const notifiedA = await app.inject({
      method: 'POST', url: `/api/waitlist/${a.json().id}/actions`,
      payload: { action: 'notify', tableId: 'table-l04', reason: '按顺序通知', idempotencyKey: 'waitlist-notify-a-001' },
    })
    expect(notifiedA.json()).toMatchObject({ status: 'notified', heldTableId: 'table-l04' })
    expect((await repository.read()).tables.find((table) => table.id === 'table-l04')?.status).toBe('reserved')

    await app.inject({
      method: 'POST', url: `/api/waitlist/${a.json().id}/actions`,
      payload: { action: 'skip', reason: '两次联系未响应', idempotencyKey: 'waitlist-skip-a-001' },
    })
    const notifiedC = await app.inject({
      method: 'POST', url: `/api/waitlist/${c.json().id}/actions`,
      payload: { action: 'notify', tableId: 'table-l04', reason: '顺序递补', idempotencyKey: 'waitlist-notify-c-001' },
    })
    expect(notifiedC.json().status).toBe('notified')

    const seatedC = await app.inject({
      method: 'POST', url: `/api/waitlist/${c.json().id}/actions`,
      payload: { action: 'seat', reason: '顾客已到入口确认', idempotencyKey: 'waitlist-seat-c-001' },
    })
    const replay = await app.inject({
      method: 'POST', url: `/api/waitlist/${c.json().id}/actions`,
      payload: { action: 'seat', reason: '顾客已到入口确认', idempotencyKey: 'waitlist-seat-c-001' },
    })
    expect(replay.json()).toEqual(seatedC.json())
    expect(seatedC.json()).toMatchObject({ status: 'seated', heldTableId: 'table-l04' })

    const state = await repository.read()
    expect(state.tables.find((table) => table.id === 'table-l04')).toMatchObject({ status: 'occupied', guestCount: 3 })
    expect(state.songState.tableSessions.filter((session) => session.tableId === 'table-l04' && session.status === 'open')).toHaveLength(1)
    expect(state.awaitingOrderIntents.some((intent) => intent.tableId === 'table-l04' && intent.status === 'active')).toBe(true)
    expect(state.waitlistEntries).toHaveLength(3)
    expect(state.auditEntries.filter((entry) => entry.action === 'waitlist.seat.v1')).toHaveLength(1)
    expect(state.salesAttributionRecords?.find((record) =>
      record.subjectType === 'table_session' && record.subjectId === seatedC.json().tableSessionId,
    )).toMatchObject({ salesEmployeeId: 'emp-lin' })

    await app.close()
    await repository.close()
  })

  it('seats normally when proactive order reminders are disabled and rejects early expiry', async () => {
    const { app, repository } = await fixture()
    await repository.mutate((state) => {
      state.config.proactiveOrderCare.enabled = false
      state.revision += 1
    })
    const awaitingOrderCountBefore = (await repository.read()).awaitingOrderIntents.length
    const joined = await app.inject({
      method: 'POST', url: '/api/waitlist', payload: guest('免提醒组', 2, 'waitlist-disabled-join-001'),
    })
    const earlyExpiry = await app.inject({
      method: 'POST', url: `/api/waitlist/${joined.json().id}/actions`,
      payload: { action: 'expire', reason: '误操作提前过期', idempotencyKey: 'waitlist-disabled-expire-001' },
    })
    expect(earlyExpiry.statusCode).toBe(500)
    expect(earlyExpiry.json().message).toContain('提前顺延请使用跳过')

    await app.inject({
      method: 'POST', url: `/api/waitlist/${joined.json().id}/actions`,
      payload: { action: 'notify', tableId: 'table-l04', reason: '按顺序通知', idempotencyKey: 'waitlist-disabled-notify-001' },
    })
    const seated = await app.inject({
      method: 'POST', url: `/api/waitlist/${joined.json().id}/actions`,
      payload: { action: 'seat', reason: '客人确认入座', idempotencyKey: 'waitlist-disabled-seat-001' },
    })
    expect(seated.statusCode).toBe(200)
    expect(seated.json().status).toBe('seated')
    expect((await repository.read()).awaitingOrderIntents).toHaveLength(awaitingOrderCountBefore)

    await app.close()
    await repository.close()
  })

  it('allows an oversized waitlist party to be seated with extra chairs', async () => {
    const { app, repository } = await fixture()
    const joined = await app.inject({
      method: 'POST', url: '/api/waitlist', payload: guest('加座组', 8, 'waitlist-extra-join-001'),
    })
    const notified = await app.inject({
      method: 'POST', url: `/api/waitlist/${joined.json().id}/actions`,
      payload: { action: 'notify', tableId: 'table-l04', reason: '现场确认可以加座', idempotencyKey: 'waitlist-extra-notify-001' },
    })
    expect(notified.statusCode, notified.body).toBe(200)
    const seated = await app.inject({
      method: 'POST', url: `/api/waitlist/${joined.json().id}/actions`,
      payload: { action: 'seat', reason: '已完成加座', idempotencyKey: 'waitlist-extra-seat-001' },
    })
    expect(seated.statusCode, seated.body).toBe(200)
    const state = await repository.read()
    expect(state.tables.find((table) => table.id === 'table-l04')).toMatchObject({ status: 'occupied', guestCount: 8 })
    expect(state.auditEntries.find((entry) => entry.action === 'waitlist.seat.v1')?.details)
      .toMatchObject({ tableCapacity: 6, extraSeatCount: 2 })
    await app.close()
    await repository.close()
  })
})
