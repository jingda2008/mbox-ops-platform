import { describe, expect, it } from 'vitest'
import { collectBlockers, prepareNextBusinessDayShifts } from './business-day-api.js'
import { createServiceTask } from './domain.js'
import { addOrderItem, createOrderDraft, decideKdsException, reportKdsException, submitOrder } from './order-domain.js'
import { createSeedState } from './seed.js'

function nextDate(date: string) {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + 1)
  return value.toISOString().slice(0, 10)
}

describe('business day shift continuity', () => {
  it('activates existing next-day shifts without copying the current roster', () => {
    const state = createSeedState()
    const currentDate = state.store.businessDate
    const followingDate = nextDate(currentDate)
    const scheduled = {
      ...structuredClone(state.shiftAssignments[0]!),
      id: 'shift-next-existing',
      businessDate: followingDate,
      status: 'scheduled' as const,
    }
    state.shiftAssignments.push(scheduled)

    const result = prepareNextBusinessDayShifts(state, currentDate, followingDate)

    expect(result).toEqual({ source: 'existing', shiftIds: ['shift-next-existing'] })
    expect(state.shiftAssignments.find((shift) => shift.id === scheduled.id)?.status).toBe('active')
    expect(state.shiftAssignments.filter((shift) => shift.businessDate === followingDate)).toHaveLength(1)
  })

  it('copies active shifts with preserved duration when no next-day roster exists', () => {
    const state = createSeedState()
    const currentDate = state.store.businessDate
    const followingDate = nextDate(currentDate)
    const source = state.shiftAssignments[0]!
    const sourceDuration = Date.parse(source.endAt) - Date.parse(source.startAt)

    const result = prepareNextBusinessDayShifts(state, currentDate, followingDate)
    const copies = state.shiftAssignments.filter((shift) => shift.businessDate === followingDate)

    expect(result.source).toBe('copied')
    expect(copies).toHaveLength(state.shiftAssignments.length / 2)
    expect(copies.every((shift) => shift.status === 'active')).toBe(true)
    expect(Date.parse(copies[0]!.endAt) - Date.parse(copies[0]!.startAt)).toBe(sourceDuration)
  })

  it('refuses to roll over into a business day with no usable roster source', () => {
    const state = createSeedState()
    const currentDate = state.store.businessDate
    state.shiftAssignments.forEach((shift) => { shift.status = 'completed' })

    expect(() => prepareNextBusinessDayShifts(state, currentDate, nextDate(currentDate)))
      .toThrow('无可复制的有效班次')
  })
})

describe('business day operational closure', () => {
  it('identifies an open previous-day table visit as requiring manager handover', () => {
    const state = createSeedState()
    const session = state.songState.tableSessions.find((candidate) => candidate.status === 'open')!
    const previousBusinessDate = state.store.businessDate
    state.store.businessDate = nextDate(previousBusinessDate)

    expect(collectBlockers(state, 'emp-chen')).toContainEqual({
      kind: 'legacy_table_session_handover_required',
      id: session.id,
      detail: `${session.tableCode}:${previousBusinessDate}->${state.store.businessDate}`,
    })
  })

  it('accepts completed ordinary and authorized urgent service without guest confirmation', () => {
    const state = createSeedState()
    const ordinary = createServiceTask(state, {
      tableCode: 'L01', serviceTypeId: 'water', source: 'employee', note: '',
      requestedBy: 'emp-lin', idempotencyKey: 'business-close-completed-water',
    })
    ordinary.status = 'completed'
    ordinary.completedAt = new Date().toISOString()
    const urgent = createServiceTask(state, {
      tableCode: 'L01', serviceTypeId: 'complaint', source: 'employee', note: '仍需客人确认',
      requestedBy: 'emp-mia', idempotencyKey: 'business-close-completed-complaint',
    })
    urgent.status = 'completed'
    urgent.completedAt = new Date().toISOString()

    const serviceBlockers = collectBlockers(state, 'emp-chen').filter((item) => item.kind === 'open_service_task')
    expect(serviceBlockers.map((item) => item.id)).not.toContain(ordinary.id)
    expect(serviceBlockers.map((item) => item.id)).not.toContain(urgent.id)
  })

  it('treats a manager-cancelled KDS exception as operationally closed', () => {
    const state = createSeedState()
    const session = state.songState.tableSessions.find((candidate) => candidate.status === 'open')!
    createOrderDraft(state.orderDomain, {
      orderId: 'business-close-kds-order', tableSessionId: session.id, createdBy: 'emp-lin',
      occurredAt: '2026-07-15T12:00:00.000Z', idempotencyKey: 'business-close-kds-order-create',
    })
    addOrderItem(state.orderDomain, {
      orderId: 'business-close-kds-order', actorId: 'emp-lin', occurredAt: '2026-07-15T12:00:01.000Z',
      idempotencyKey: 'business-close-kds-order-item',
      item: {
        id: 'business-close-kds-line', skuId: 'product-beer', name: '精酿啤酒', specification: '330ml',
        quantity: 1, unitListPriceAmount: 6800, unitSalePriceAmount: 6800, unitCostAmount: 1800,
        stationId: 'bar-main', configVersion: 1,
      },
    })
    submitOrder(state.orderDomain, {
      orderId: 'business-close-kds-order', submittedBy: 'emp-lin',
      occurredAt: '2026-07-15T12:00:02.000Z', idempotencyKey: 'business-close-kds-order-submit',
    })
    const task = state.orderDomain.kdsTasks.find((candidate) => candidate.orderId === 'business-close-kds-order')!
    reportKdsException(state.orderDomain, {
      exceptionId: 'business-close-kds-exception', eventId: 'business-close-kds-report', taskId: task.id,
      exceptionKind: 'shortage', reasonCode: 'product_out_of_stock', reasonNote: '',
      actorId: 'emp-qing', actorRoleId: 'bartender', occurredAt: '2026-07-15T12:00:03.000Z',
      idempotencyKey: 'business-close-kds-report-key',
    })
    decideKdsException(state.orderDomain, {
      eventId: 'business-close-kds-decision', exceptionId: 'business-close-kds-exception',
      disposition: 'cancelled', reasonCode: 'unavailable_confirmed', reasonNote: '', remakeTaskId: null,
      actorId: 'emp-chen', actorRoleId: 'manager', occurredAt: '2026-07-15T12:00:04.000Z',
      idempotencyKey: 'business-close-kds-decision-key',
    })

    const kdsBlockers = collectBlockers(state, 'emp-chen').filter((item) => item.kind === 'undelivered_kds')
    expect(kdsBlockers.map((item) => item.id)).not.toContain(task.id)
  })

  it.each(['pending_confirmation', 'pending_payment', 'paid', 'accepted', 'performing', 'refund_required'] as const)(
    'blocks business-day close for an active song request in %s',
    (status) => {
      const state = createSeedState()
      const session = state.songState.tableSessions.find((candidate) => candidate.status === 'open')!
      state.songState.requests.push({
        id: `business-close-song-${status}`, performanceSessionId: 'performance-test', appearanceId: 'appearance-test',
        tableSessionId: session.id, tableId: session.tableId, tableCode: session.tableCode,
        requestedBy: 'guest-test', customerNote: '', status,
        priceSnapshot: {
          repertoireEntryId: 'repertoire-test', singerId: 'singer-test', songId: 'song-test',
          songTitle: '测试歌曲', songArtist: '测试歌手', singerName: '测试歌手',
          priceAmount: 9800, currency: 'CNY', configVersion: 1,
        },
        payment: null, confirmedBy: null, confirmedAt: null, acceptedBy: null, acceptedAt: null,
        performingAt: null, completedAt: null, rejectedBy: null, rejectedAt: null, rejectionReason: null,
        cancelledBy: null, cancelledAt: null, refundReason: null, refundReference: null, refundedAt: null,
        createdAt: '2026-07-15T12:00:00.000Z', updatedAt: '2026-07-15T12:00:00.000Z', revision: 1,
      })

      expect(collectBlockers(state, 'emp-chen')).toContainEqual(expect.objectContaining({
        kind: 'active_song_request', id: `business-close-song-${status}`,
      }))
    },
  )
})
