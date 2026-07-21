import { describe, expect, it } from 'vitest'
import { createSeedState } from './seed.js'
import { applyScheduledOperations, scheduledOperationsWouldChange } from './operational-scheduler.js'

const NOW = new Date('2026-07-20T12:00:00.000Z')

describe('operational scheduler lock preflight', () => {
  it('does not request an aggregate write lock after all work for the tick is settled', () => {
    const state = createSeedState(NOW)
    applyScheduledOperations(state, NOW)

    expect(scheduledOperationsWouldChange(state, NOW)).toBe(false)
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
