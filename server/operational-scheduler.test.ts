import { describe, expect, it } from 'vitest'
import { createSeedState } from './seed.js'
import { normalizeOrderFulfillmentState } from './fulfillment-workstations.js'
import {
  applyScheduledOperations,
  scheduledOperationsMayBeDue,
  scheduledOperationsWouldChange,
} from './operational-scheduler.js'

const NOW = new Date('2026-07-20T12:00:00.000Z')

describe('operational scheduler lock preflight', () => {
  it('does not request an aggregate write lock after all work for the tick is settled', () => {
    const state = createSeedState(NOW)
    applyScheduledOperations(state, NOW)

    expect(scheduledOperationsWouldChange(state, NOW)).toBe(false)
  })

  it('keeps future KDS deadlines on the allocation-free no-work path', () => {
    const state = createSeedState(NOW)
    state.orderDomain.kdsTasks.push({
      id: 'kds-future', orderId: 'order-future', orderItemId: 'item-future',
      tableSessionId: state.songState.tableSessions[0]!.id, stationId: 'bar-main',
      status: 'queued', itemName: '测试酒水', specification: '1杯', quantity: 1,
      createdAt: NOW.toISOString(), queuedAt: NOW.toISOString(), startedAt: null,
      completedAt: null, pickedUpAt: null, deliveredAt: null,
      acceptedBy: null, completedBy: null, deliveredBy: null,
      productionSla: {
        dueAt: new Date(NOW.getTime() + 60_000).toISOString(),
        warningAt: new Date(NOW.getTime() + 30_000).toISOString(),
        breachedAt: null,
      },
      pickupSla: null,
    })
    normalizeOrderFulfillmentState(state.orderDomain)
    state.orderDomain.kdsTasks.at(-1)!.productionSla!.dueAt = new Date(NOW.getTime() + 60_000).toISOString()

    expect(scheduledOperationsMayBeDue(state, NOW)).toBe(false)
    expect(scheduledOperationsWouldChange(state, NOW)).toBe(false)
  })

  it('routes an overdue KDS deadline to the authoritative scheduler probe', () => {
    const state = createSeedState(NOW)
    state.orderDomain.kdsTasks.push({
      id: 'kds-due', orderId: 'order-due', orderItemId: 'item-due',
      tableSessionId: state.songState.tableSessions[0]!.id, stationId: 'bar-main',
      status: 'queued', itemName: '测试酒水', specification: '1杯', quantity: 1,
      createdAt: NOW.toISOString(), queuedAt: NOW.toISOString(), startedAt: null,
      completedAt: null, pickedUpAt: null, deliveredAt: null,
      acceptedBy: null, completedBy: null, deliveredBy: null,
      productionSla: {
        dueAt: new Date(NOW.getTime() - 1_000).toISOString(),
        warningAt: new Date(NOW.getTime() - 30_000).toISOString(),
        breachedAt: null,
      },
      pickupSla: null,
    })
    normalizeOrderFulfillmentState(state.orderDomain)
    state.orderDomain.kdsTasks.at(-1)!.productionSla!.dueAt = new Date(NOW.getTime() - 1_000).toISOString()

    expect(scheduledOperationsMayBeDue(state, NOW)).toBe(true)
  })

  it('routes an unnormalized legacy KDS task to the authoritative probe', () => {
    const state = createSeedState(NOW)
    state.orderDomain.kdsTasks.push({
      id: 'kds-legacy', orderId: 'order-legacy', orderItemId: 'item-legacy',
      tableSessionId: state.songState.tableSessions[0]!.id, stationId: 'bar-main',
      status: 'queued', itemName: '旧数据酒水', specification: '1杯', quantity: 1,
      createdAt: NOW.toISOString(), queuedAt: new Date(NOW.getTime() - 600_000).toISOString(),
      startedAt: null, completedAt: null, pickedUpAt: null, deliveredAt: null,
      acceptedBy: null, completedBy: null, deliveredBy: null,
      workstation: undefined, productionSla: undefined, pickupSla: undefined,
      deliveryServiceTask: undefined,
    })

    expect(scheduledOperationsMayBeDue(state, NOW)).toBe(true)
  })

  it('keeps the KDS delivery link authoritative when its service task crosses the SLA boundary', () => {
    const state = createSeedState(NOW)
    applyScheduledOperations(state, NOW)
    const table = state.tables[0]!
    const tableSessionId = state.songState.tableSessions.find((session) => session.tableId === table.id)?.id
      ?? `session:${table.id}:scheduler-regression`
    const deliveryTaskId = 'task:fulfillment:scheduler-regression'
    const kdsTask = {
      id: 'kds-scheduler-regression', orderId: 'order-scheduler-regression', orderItemId: 'item-scheduler-regression',
      tableSessionId, stationId: 'bar-main', status: 'completed' as const, itemName: '测试酒水',
      specification: '1杯', quantity: 1, createdAt: NOW.toISOString(), queuedAt: NOW.toISOString(),
      startedAt: NOW.toISOString(), completedAt: NOW.toISOString(), pickedUpAt: null, deliveredAt: null,
      acceptedBy: 'emp-qing', completedBy: 'emp-qing', deliveredBy: null,
      productionSla: { targetSeconds: 180, dueAt: NOW.toISOString() },
      pickupSla: { targetSeconds: 90, dueAt: new Date(NOW.getTime() + 90_000).toISOString() },
      deliveryServiceTask: {
        id: deliveryTaskId, status: 'pending' as const, ownerId: null, createdAt: NOW.toISOString(),
      },
    }
    state.orderDomain.kdsTasks.push(kdsTask)
    state.tasks.push({
      id: deliveryTaskId, tableId: table.id, tableSessionId,
      serviceTypeId: 'fulfillment-delivery', source: 'system', note: '测试取送', status: 'pending',
      priority: 'high', ownerId: null, notifiedEmployeeIds: [], dispatchRoleIdsSnapshot: ['server', 'backup'],
      targetEmployeeIdsSnapshot: [], managerRoleIdsSnapshot: ['manager'],
      slaSnapshot: { warningSeconds: 30, escalateSeconds: 60, managerSeconds: 120 },
      createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), acceptedAt: null, arrivedAt: null,
      completedAt: null, warningAt: new Date(NOW.getTime() + 30_000).toISOString(),
      escalateAt: new Date(NOW.getTime() + 60_000).toISOString(),
      managerAt: new Date(NOW.getTime() + 120_000).toISOString(), escalationLevel: 0,
      configVersion: state.config.version, customerReply: '', actionScript: [], resolution: null,
      workflowLevel: 'L1', requestCount: 1, firstRequestedAt: NOW.toISOString(),
      lastRequestedAt: NOW.toISOString(), viewedEmployeeIds: [], completedBy: null,
      triggerId: `fulfillment-delivery:${kdsTask.id}`, archivedAt: null,
      archiveOutcome: null, archivedFromStatus: null,
    })

    applyScheduledOperations(state, new Date(NOW.getTime() + 59_999))
    expect(state.tasks.find((task) => task.id === deliveryTaskId)?.status).toBe('pending')
    expect(kdsTask.deliveryServiceTask.status).toBe('pending')

    applyScheduledOperations(state, new Date(NOW.getTime() + 60_000))
    const escalated = state.tasks.find((task) => task.id === deliveryTaskId)!
    expect(escalated.status).toBe('escalated')
    expect(kdsTask.deliveryServiceTask).toMatchObject({
      id: deliveryTaskId,
      status: 'escalated',
      ownerId: escalated.ownerId,
    })
  })

  it('detects a due task before the real mutation runs', () => {
    const state = createSeedState(NOW)
    applyScheduledOperations(state, NOW)
    const serviceType = state.config.serviceTypes[0]!
    state.tasks.push({
      id: 'task-due', tableId: state.tables[0]!.id, tableSessionId: null,
      serviceTypeId: serviceType.id, source: 'system', note: '', status: 'pending',
      priority: serviceType.priority, ownerId: null, notifiedEmployeeIds: [],
      dispatchRoleIdsSnapshot: [...serviceType.dispatchRoleIds], targetEmployeeIdsSnapshot: [],
      managerRoleIdsSnapshot: ['manager'], slaSnapshot: { ...serviceType.sla },
      createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), acceptedAt: null,
      arrivedAt: null, completedAt: null, warningAt: NOW.toISOString(),
      escalateAt: new Date(NOW.getTime() - 1_000).toISOString(),
      managerAt: new Date(NOW.getTime() + 60_000).toISOString(), escalationLevel: 0,
      configVersion: state.config.version, customerReply: '', actionScript: [], resolution: null,
      triggerId: null, archivedAt: null, archiveOutcome: null, archivedFromStatus: null,
    })

    expect(scheduledOperationsWouldChange(state, NOW)).toBe(true)
  })
})
