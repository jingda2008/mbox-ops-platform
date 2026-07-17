import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonRepository } from './repository.js'
import { registerTableSessionRoutes } from './table-session-api.js'
import { addOrderItem, createOrderDraft, submitOrder } from './order-domain.js'
import { createPaymentIntent, handlePaymentNotification } from './payment-domain.js'
import { createServiceTask } from './domain.js'

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
  it('allows completed ordinary service to close but keeps completed urgent care open', async () => {
    const { app, repository } = await fixture()
    await repository.mutate((state) => {
      const ordinary = createServiceTask(state, {
        tableCode: 'L01', serviceTypeId: 'water', source: 'employee', note: '',
        requestedBy: 'emp-lin', idempotencyKey: 'table-close-completed-water',
      })
      ordinary.status = 'completed'
      ordinary.completedAt = new Date().toISOString()
      const urgent = createServiceTask(state, {
        tableCode: 'L02', serviceTypeId: 'complaint', source: 'employee', note: '等待明确结案',
        requestedBy: 'emp-mia', idempotencyKey: 'table-close-completed-urgent',
      })
      urgent.status = 'completed'
      urgent.completedAt = new Date().toISOString()
    })

    const ordinaryClose = await app.inject({
      method: 'POST', url: '/api/tables/table-l01/close',
      payload: { reason: '普通服务已经完成', idempotencyKey: 'table-close-completed-water-success' },
    })
    const urgentClose = await app.inject({
      method: 'POST', url: '/api/tables/table-l02/close',
      payload: { reason: '投诉尚未确认', idempotencyKey: 'table-close-completed-urgent-blocked' },
    })
    expect(ordinaryClose.statusCode, ordinaryClose.body).toBe(200)
    expect(urgentClose.statusCode).toBe(500)
    expect(urgentClose.json().message).toContain('服务任务未关闭')
  })

  it('blocks table close while a song request is active or awaiting refund', async () => {
    const { app, repository } = await fixture()
    await repository.mutate((state) => {
      const session = state.songState.tableSessions.find((candidate) => candidate.tableId === 'table-l01' && candidate.status === 'open')!
      state.songState.requests.push({
        id: 'table-close-active-song', performanceSessionId: 'performance-test', appearanceId: 'appearance-test',
        tableSessionId: session.id, tableId: session.tableId, tableCode: session.tableCode,
        requestedBy: 'guest-L01', customerNote: '', status: 'performing',
        priceSnapshot: {
          repertoireEntryId: 'repertoire-test', singerId: 'singer-test', songId: 'song-test',
          songTitle: '测试歌曲', songArtist: '测试歌手', singerName: '测试歌手',
          priceAmount: 9800, currency: 'CNY', configVersion: 1,
        },
        payment: {
          paymentReference: 'POS-SONG-TEST', paidAmount: 9800, currency: 'CNY',
          collectionChannel: 'physical_pos', paidAt: '2026-07-15T12:00:00.000Z',
        },
        confirmedBy: 'emp-lin', confirmedAt: '2026-07-15T11:58:00.000Z',
        acceptedBy: 'singer-test', acceptedAt: '2026-07-15T12:00:01.000Z',
        performingAt: '2026-07-15T12:01:00.000Z', completedAt: null,
        rejectedBy: null, rejectedAt: null, rejectionReason: null,
        cancelledBy: null, cancelledAt: null, refundReason: null, refundReference: null, refundedAt: null,
        createdAt: '2026-07-15T11:57:00.000Z', updatedAt: '2026-07-15T12:01:00.000Z', revision: 4,
      })
      state.revision += 1
    })

    const blocked = await app.inject({
      method: 'POST', url: '/api/tables/table-l01/close',
      payload: { reason: '错误尝试结台', idempotencyKey: 'table-close-active-song-blocked-0001' },
    })
    expect(blocked.statusCode).toBe(500)
    expect(blocked.json().message).toContain('点歌未完成或退款未结')
  })

  it('does not close a table until confirmed payment amounts cover every order line', async () => {
    const { app, repository } = await fixture()
    await repository.mutate((state) => {
      const session = state.songState.tableSessions.find((candidate) => candidate.tableId === 'table-l01' && candidate.status === 'open')!
      createOrderDraft(state.orderDomain, {
        orderId: 'table-close-amount-order', tableSessionId: session.id, createdBy: 'emp-owner',
        occurredAt: '2026-07-15T12:00:00.000Z', idempotencyKey: 'table-close-amount-order-create',
      })
      addOrderItem(state.orderDomain, {
        orderId: 'table-close-amount-order', actorId: 'emp-owner', occurredAt: '2026-07-15T12:00:01.000Z',
        idempotencyKey: 'table-close-amount-order-item',
        item: {
          id: 'table-close-amount-line', skuId: 'product-beer', name: '精酿啤酒', specification: '330ml',
          quantity: 1, unitListPriceAmount: 6800, unitSalePriceAmount: 6800, unitCostAmount: 1800,
          stationId: 'bar-main', configVersion: 1,
        },
      })
      submitOrder(state.orderDomain, {
        orderId: 'table-close-amount-order', submittedBy: 'emp-owner',
        occurredAt: '2026-07-15T12:00:02.000Z', idempotencyKey: 'table-close-amount-order-submit',
      })
      const kds = state.orderDomain.kdsTasks.find((candidate) => candidate.orderId === 'table-close-amount-order')!
      kds.status = 'delivered'
      kds.deliveredAt = '2026-07-15T12:01:00.000Z'
      const partial = createPaymentIntent(state.paymentDomain, {
        paymentIntentId: 'table-close-partial-payment', tableSessionId: session.id,
        lineAllocations: [{ orderId: 'table-close-amount-order', orderItemId: 'table-close-amount-line', quantity: 1, unitPaidAmount: 1 }],
        amount: 1, currency: 'CNY', channel: 'wechat_mock', merchantId: state.store.id,
        createdBy: 'emp-owner', deviceId: 'test', occurredAt: '2026-07-15T12:01:01.000Z',
        expiresAt: '2026-07-15T12:16:01.000Z', idempotencyKey: 'table-close-partial-payment-create',
      })
      handlePaymentNotification(state.paymentDomain, {
        channel: partial.channel, notificationId: 'table-close-partial-notification', paymentIntentId: partial.id,
        channelTransactionId: 'table-close-partial-transaction', status: 'succeeded', amount: partial.amount,
        currency: partial.currency, merchantId: partial.merchantId, signatureVerified: true,
        channelOccurredAt: '2026-07-15T12:01:02.000Z', receivedAt: '2026-07-15T12:01:02.000Z',
      })
      state.revision += 1
    })

    const blocked = await app.inject({
      method: 'POST', url: '/api/tables/table-l01/close',
      payload: { reason: '错误尝试结台', idempotencyKey: 'table-close-partial-blocked-0001' },
    })
    expect(blocked.statusCode).toBe(500)
    expect(blocked.json().message).toContain('实付1分，应付6800分')

    await repository.mutate((state) => {
      const session = state.songState.tableSessions.find((candidate) => candidate.tableId === 'table-l01' && candidate.status === 'open')!
      const remainder = createPaymentIntent(state.paymentDomain, {
        paymentIntentId: 'table-close-remainder-payment', tableSessionId: session.id,
        lineAllocations: [{ orderId: 'table-close-amount-order', orderItemId: 'table-close-amount-line', quantity: 1, unitPaidAmount: 6799 }],
        amount: 6799, currency: 'CNY', channel: 'wechat_mock', merchantId: state.store.id,
        createdBy: 'emp-owner', deviceId: 'test', occurredAt: '2026-07-15T12:02:00.000Z',
        expiresAt: '2026-07-15T12:17:00.000Z', idempotencyKey: 'table-close-remainder-payment-create',
      })
      handlePaymentNotification(state.paymentDomain, {
        channel: remainder.channel, notificationId: 'table-close-remainder-notification', paymentIntentId: remainder.id,
        channelTransactionId: 'table-close-remainder-transaction', status: 'succeeded', amount: remainder.amount,
        currency: remainder.currency, merchantId: remainder.merchantId, signatureVerified: true,
        channelOccurredAt: '2026-07-15T12:02:01.000Z', receivedAt: '2026-07-15T12:02:01.000Z',
      })
      state.revision += 1
    })
    const closed = await app.inject({
      method: 'POST', url: '/api/tables/table-l01/close',
      payload: { reason: '金额核对完成', idempotencyKey: 'table-close-amount-success-0001' },
    })
    expect(closed.statusCode, closed.body).toBe(200)
  })

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
