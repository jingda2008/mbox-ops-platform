import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonRepository } from './repository.js'
import { registerTableSessionRoutes } from './table-session-api.js'

const resources: Array<{ app: ReturnType<typeof Fastify>; repository: JsonRepository }> = []

async function fixture() {
  const repository = new JsonRepository(`/tmp/mbox-table-operations-${crypto.randomUUID()}.json`)
  await repository.init()
  const app = Fastify()
  let actor = { actorId: 'emp-owner', roleId: 'owner' }
  app.addHook('preHandler', async (request) => {
    request.mboxActor = {
      ...actor,
      storeId: 'mbox-lujiazui',
      runtimeMode: 'test',
      authenticatedBy: 'local_header',
    }
  })
  registerTableSessionRoutes(app, repository)
  resources.push({ app, repository })
  return {
    app,
    repository,
    useActor(actorId: string, roleId: string) { actor = { actorId, roleId } },
  }
}

afterEach(async () => {
  await Promise.all(resources.splice(0).map(async ({ app, repository }) => {
    await app.close()
    await repository.close()
  }))
})

function minimumConfig(amount: number, idempotencyKey: string) {
  return {
    reminder: { enabled: true, firstReminderMinutes: 1, repeatMinutes: 5, thresholdPercent: 80 },
    minimumSpendRules: [{
      id: 'minimum-table-l04',
      name: 'L04全时段低消',
      enabled: true,
      targetType: 'table',
      targetId: 'table-l04',
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      startTime: '00:00',
      endTime: '23:59',
      amount,
      currency: 'CNY',
    }],
    reason: '测试低消规则版本快照',
    idempotencyKey,
  }
}

describe('table operating line', () => {
  it('opens a walk-in in one transaction and freezes minimum-spend and sales snapshots', async () => {
    const { app, repository, useActor } = await fixture()
    const configured = await app.inject({
      method: 'PUT', url: '/api/table-operations/config', payload: minimumConfig(100_000, 'table-config-v2-0001'),
    })
    expect(configured.statusCode, configured.body).toBe(200)
    expect(configured.json().version).toBe(2)

    useActor('emp-chen', 'manager')
    const opened = await app.inject({
      method: 'POST',
      url: '/api/tables/table-l04/walk-in-open',
      payload: {
        partySize: 3,
        salesEmployeeId: 'emp-lin',
        customerName: '现场客人',
        idempotencyKey: 'walk-in-open-l04-0001',
      },
    })
    expect(opened.statusCode, opened.body).toBe(201)
    expect(opened.json().summary).toMatchObject({
      tableId: 'table-l04', minimumSpendAmount: 100_000, differenceAmount: 100_000,
      configVersion: 2, salesEmployeeId: 'emp-lin',
    })

    const state = await repository.read()
    const reservation = state.reservationState?.reservations.find((item) => item.id === opened.json().reservation.id)
    expect(reservation).toMatchObject({ sourceCode: 'walk_in', status: 'seated', tableId: 'table-l04' })
    expect(state.tableSessionOperations).toHaveLength(1)
    expect(state.salesAttributionRecords?.filter((record) => record.subjectId === reservation?.id)).toHaveLength(2)
    expect(state.auditEntries.some((entry) => entry.action === 'table.walk_in_opened.v1')).toBe(true)
  })

  it('keeps the seated snapshot after config changes and requires a manager reason to waive the difference', async () => {
    const { app, repository, useActor } = await fixture()
    await app.inject({ method: 'PUT', url: '/api/table-operations/config', payload: minimumConfig(100_000, 'table-config-v2-0002') })
    useActor('emp-chen', 'manager')
    await app.inject({
      method: 'POST', url: '/api/tables/table-l04/walk-in-open',
      payload: { partySize: 2, salesEmployeeId: 'emp-lin', idempotencyKey: 'walk-in-open-l04-0002' },
    })

    useActor('emp-owner', 'owner')
    await app.inject({ method: 'PUT', url: '/api/table-operations/config', payload: minimumConfig(200_000, 'table-config-v3-0002') })
    useActor('emp-chen', 'manager')
    const summary = await app.inject({ method: 'GET', url: '/api/tables/table-l04/session-summary' })
    expect(summary.json()).toMatchObject({ minimumSpendAmount: 100_000, configVersion: 2 })

    const blocked = await app.inject({
      method: 'POST', url: '/api/tables/table-l04/close',
      payload: { reason: '客人已经离店', idempotencyKey: 'table-close-l04-blocked-0002' },
    })
    expect(blocked.statusCode).toBe(500)
    expect(blocked.json().message).toContain('需要经理填写原因后豁免')

    const closed = await app.inject({
      method: 'POST', url: '/api/tables/table-l04/close',
      payload: {
        reason: '经理确认结台',
        minimumSpendWaiver: { reason: '客户提前离场且现场服务异常' },
        idempotencyKey: 'table-close-l04-waived-0002',
      },
    })
    expect(closed.statusCode, closed.body).toBe(200)
    const state = await repository.read()
    expect(state.tables.find((table) => table.id === 'table-l04')?.status).toBe('available')
    expect(state.auditEntries.find((entry) => entry.action === 'table.minimum_spend_waived.v1')).toMatchObject({
      actorId: 'emp-chen',
      details: { differenceAmount: 100_000, configVersion: 2, reason: '客户提前离场且现场服务异常' },
    })
  })

  it('merges, adds and splits tables without mutating order, payment or KDS state', async () => {
    const { app, repository, useActor } = await fixture()
    useActor('emp-chen', 'manager')
    const before = await repository.read()
    const protectedBefore = {
      orders: structuredClone(before.orderDomain.orders),
      kdsTasks: structuredClone(before.orderDomain.kdsTasks),
      payments: structuredClone(before.paymentDomain),
    }

    const merged = await app.inject({
      method: 'POST', url: '/api/tables/table-l01/combinations',
      payload: { action: 'merge', targetTableId: 'table-l02', reason: '两桌客人确认合台', idempotencyKey: 'table-merge-l01-l02-0001' },
    })
    expect(merged.statusCode, merged.body).toBe(200)
    expect(merged.json()).toMatchObject({ action: 'merge', primaryTableId: 'table-l01', relatedTableId: 'table-l02' })
    const splitMerge = await app.inject({
      method: 'POST', url: '/api/tables/table-l01/combinations',
      payload: { action: 'split_back', linkId: merged.json().linkId, reason: '合台接待结束', idempotencyKey: 'table-split-l01-l02-0001' },
    })
    expect(splitMerge.statusCode, splitMerge.body).toBe(200)

    const added = await app.inject({
      method: 'POST', url: '/api/tables/table-l01/combinations',
      payload: { action: 'add_table', targetTableId: 'table-l04', reason: '主桌增加座位', idempotencyKey: 'table-add-l01-l04-0001' },
    })
    expect(added.statusCode, added.body).toBe(200)
    expect((await repository.read()).tables.find((table) => table.id === 'table-l04')?.status).toBe('occupied')
    const splitAdded = await app.inject({
      method: 'POST', url: '/api/tables/table-l01/combinations',
      payload: { action: 'split_back', linkId: added.json().linkId, reason: '撤回空加桌', idempotencyKey: 'table-split-l01-l04-0001' },
    })
    expect(splitAdded.statusCode, splitAdded.body).toBe(200)

    const after = await repository.read()
    expect(after.tables.find((table) => table.id === 'table-l04')?.status).toBe('available')
    expect(after.orderDomain.orders).toEqual(protectedBefore.orders)
    expect(after.orderDomain.kdsTasks).toEqual(protectedBefore.kdsTasks)
    expect(after.paymentDomain).toEqual(protectedBefore.payments)
    expect(after.tableCombinationRecords).toHaveLength(4)
    expect(after.auditEntries.filter((entry) => entry.action.startsWith('table.combination.'))).toHaveLength(4)
  })
})
