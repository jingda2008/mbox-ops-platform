import { describe, expect, it } from 'vitest'
import { processOverdueProductionTasks } from './kds-production-alerts.js'
import { createSeedState } from './seed.js'
import { syncOrderFulfillmentWorkstations } from './fulfillment-workstations.js'

describe('KDS production delay escalation', () => {
  it('creates one station-aware service task after the production deadline', () => {
    const state = createSeedState()
    syncOrderFulfillmentWorkstations(state)
    const table = state.tables.find((item) => item.code === 'L01')!
    const session = state.songState.tableSessions.find((item) => item.tableId === table.id && item.status === 'open')!
    state.orderDomain.kdsTasks.push({
      id: 'kds-overdue-bar', orderId: 'order-overdue', orderItemId: 'line-overdue', tableSessionId: session.id,
      tableCode: table.code, stationId: 'bar-main', itemName: '招牌鸡尾酒', specification: '1杯', quantity: 1,
      status: 'preparing', productionSla: { targetSeconds: 180, dueAt: '2026-07-17T12:00:00.000Z' },
      pickupSla: { targetSeconds: 60, dueAt: null }, deliveryServiceTask: null, remakeOf: null, exceptionEvents: [],
      queuedAt: '2026-07-17T11:57:00.000Z', startedAt: '2026-07-17T11:58:00.000Z', startedBy: 'emp-qing',
      completedAt: null, completedBy: null, pickedUpAt: null, pickedUpBy: null, deliveredAt: null, deliveredBy: null,
    })

    expect(processOverdueProductionTasks(state, new Date('2026-07-17T12:01:00.000Z'))).toBe(1)
    expect(processOverdueProductionTasks(state, new Date('2026-07-17T12:02:00.000Z'))).toBe(0)
    expect(state.tasks.filter((task) => task.triggerId === 'kds-production-delay:kds-overdue-bar')).toEqual([
      expect.objectContaining({ serviceTypeId: 'kds-production-delay', ownerId: 'emp-qing', priority: 'high' }),
    ])
  })

  it('does not alert before the due time or after production completes', () => {
    const state = createSeedState()
    syncOrderFulfillmentWorkstations(state)
    const table = state.tables.find((item) => item.code === 'L01')!
    const session = state.songState.tableSessions.find((item) => item.tableId === table.id && item.status === 'open')!
    state.orderDomain.kdsTasks.push({
      id: 'kds-not-due', orderId: 'order-future', orderItemId: 'line-future', tableSessionId: session.id,
      stationId: 'kitchen-cold', itemName: '时令果盘', specification: '1份', quantity: 1, status: 'completed',
      productionSla: { targetSeconds: 300, dueAt: '2026-07-17T12:05:00.000Z' }, pickupSla: { targetSeconds: 90, dueAt: '2026-07-17T12:06:30.000Z' },
      deliveryServiceTask: null, remakeOf: null, exceptionEvents: [], queuedAt: '2026-07-17T12:00:00.000Z', startedAt: '2026-07-17T12:01:00.000Z', startedBy: 'emp-han',
      completedAt: '2026-07-17T12:05:00.000Z', completedBy: 'emp-han', pickedUpAt: null, pickedUpBy: null, deliveredAt: null, deliveredBy: null,
    })

    expect(processOverdueProductionTasks(state, new Date('2026-07-17T12:10:00.000Z'))).toBe(0)
    expect(state.tasks.some((task) => task.triggerId === 'kds-production-delay:kds-not-due')).toBe(false)
  })
})
