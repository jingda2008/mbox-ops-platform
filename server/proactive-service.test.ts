import { describe, expect, it } from 'vitest'
import { createSeedState } from './seed.js'
import {
  completeAwaitingOrderOnOrder,
  processAwaitingOrderReminders,
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
})
