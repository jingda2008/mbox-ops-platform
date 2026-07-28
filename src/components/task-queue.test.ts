import { describe, expect, it } from 'vitest'
import type { ServiceTask } from '../shared/contracts'
import { taskMatchesQueueFilter, taskQueueFilterForQuery, taskRepeatSummary } from './task-queue'

const now = Date.parse('2026-07-21T12:00:00.000Z')

function task(patch: Partial<ServiceTask> = {}) {
  return {
    id: 'task-1',
    tableId: 'table-l01',
    tableSessionId: 'session-l01',
    serviceTypeId: 'water',
    source: 'guest',
    note: '',
    status: 'pending',
    priority: 'normal',
    ownerId: null,
    notifiedEmployeeIds: [],
    createdAt: '2026-07-21T11:55:00.000Z',
    updatedAt: '2026-07-21T11:55:00.000Z',
    acceptedAt: null,
    arrivedAt: null,
    completedAt: null,
    warningAt: '2026-07-21T11:59:00.000Z',
    escalateAt: '2026-07-21T12:02:00.000Z',
    managerAt: '2026-07-21T12:04:00.000Z',
    escalationLevel: 0,
    configVersion: 1,
    customerReply: '',
    actionScript: [],
    resolution: null,
    triggerId: null,
    archivedAt: null,
    archiveOutcome: null,
    archivedFromStatus: null,
    ...patch,
  } as ServiceTask
}

describe('task queue navigation filters', () => {
  it('maps home and live summary queries to the intended queue', () => {
    expect(taskQueueFilterForQuery('service-sla-risk')).toBe('sla-risk')
    expect(taskQueueFilterForQuery('service-escalated')).toBe('escalated')
    expect(taskQueueFilterForQuery('service-complaints')).toBe('complaint')
    expect(taskQueueFilterForQuery('service-open')).toBe('all')
  })

  it('matches SLA, escalation and complaint tasks without mixing resolved work', () => {
    const complaints = new Set(['complaint'])
    expect(taskMatchesQueueFilter(task(), 'sla-risk', complaints, now)).toBe(true)
    expect(taskMatchesQueueFilter(task({ status: 'arrived' }), 'sla-risk', complaints, now)).toBe(false)
    expect(taskMatchesQueueFilter(task({ escalationLevel: 1 }), 'escalated', complaints, now)).toBe(true)
    expect(taskMatchesQueueFilter(task({ serviceTypeId: 'complaint' }), 'complaint', complaints, now)).toBe(true)
  })
})

describe('task repeat request summary', () => {
  it('shows the merged request count and most recent request time', () => {
    const repeated = task({
      requestCount: 4,
      lastRequestedAt: '2026-07-21T11:59:42.000Z',
    })
    expect(taskRepeatSummary(repeated, now)).toBe('重复呼叫 4次 · 最近18秒前')
  })

  it('does not add repeat noise for a single request', () => {
    expect(taskRepeatSummary(task(), now)).toBeNull()
  })
})
