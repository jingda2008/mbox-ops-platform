import { describe, expect, it, vi } from 'vitest'
import type { RuntimeState } from '../src/shared/contracts.js'
import type { SopActionRecord } from '../src/shared/sop-contracts.js'
import type { RuntimeRepository } from './repository.js'
import { createSeedState } from './seed.js'
import { dispatchDueSopActions, type SopActionAdapter } from './sop-action-dispatch.js'

class MemoryRepository implements RuntimeRepository {
  readCount = 0
  constructor(readonly state: RuntimeState) {}
  async init() {}
  async read() { this.readCount += 1; return structuredClone(this.state) }
  async mutate<T>(mutation: (state: RuntimeState) => T | Promise<T>) {
    const working = structuredClone(this.state)
    const result = await mutation(working)
    Object.assign(this.state, working)
    return result
  }
  async reset() { return this.state }
  async healthCheck() { return { ready: true, repository: 'memory', revision: this.state.revision } }
  async close() {}
}

function queuedRecord(type: 'headset_notification' | 'camera_snapshot'): SopActionRecord {
  return {
    id: `action-${type}`, executionId: 'execution-1', stepId: 'step-1', taskId: 'task-1',
    tableSessionId: 'session-1', tableId: 'table-l01', type, status: 'queued', recipientEmployeeIds: ['emp-lin'],
    requiredRoleIds: type === 'camera_snapshot' ? ['manager'] : [], content: 'L01需要处理', attemptCount: 0,
    requestedAt: '2026-07-19T12:00:00.000Z', lastAttemptAt: null, nextAttemptAt: '2026-07-19T12:00:00.000Z',
    completedAt: null, completedBy: null, providerReference: null, failureReason: null, evidenceReference: null,
    resolutionNote: null, leaseOwner: null, leaseExpiresAt: null,
  }
}

describe('SOP external action dispatcher', () => {
  it('reuses the scheduler snapshot when checking for due work', async () => {
    const state = createSeedState()
    const repository = new MemoryRepository(state)

    await dispatchDueSopActions(repository, [], 'worker-1', new Date('2026-07-19T12:00:01.000Z'), structuredClone(state))

    expect(repository.readCount).toBe(0)
  })

  it('marks a missing adapter as unconfigured instead of pretending success', async () => {
    const state = createSeedState()
    state.sopActionRecords = [queuedRecord('headset_notification')]
    await dispatchDueSopActions(new MemoryRepository(state), [], 'worker-1', new Date('2026-07-19T12:00:01.000Z'))
    expect(state.sopActionRecords[0]).toMatchObject({ status: 'unconfigured', completedAt: null })
    expect(state.auditEntries.at(-1)).toMatchObject({ action: 'sop.action.unconfigured.v1' })
  })

  it('requires a provider reference before marking a camera verification complete', async () => {
    const state = createSeedState()
    state.sopActionRecords = [queuedRecord('camera_snapshot')]
    const dispatch = vi.fn(async () => ({
      outcome: 'completed' as const, providerReference: 'vision-job-001', evidenceReference: 'gs://evidence/frame-001.jpg',
    }))
    const adapter: SopActionAdapter = { type: 'camera_snapshot', dispatch }
    await dispatchDueSopActions(new MemoryRepository(state), [adapter], 'worker-1', new Date('2026-07-19T12:00:01.000Z'))
    expect(state.sopActionRecords[0]).toMatchObject({
      status: 'completed', providerReference: 'vision-job-001', evidenceReference: 'gs://evidence/frame-001.jpg',
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
})
