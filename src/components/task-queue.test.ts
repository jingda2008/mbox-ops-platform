import { describe, expect, it } from 'vitest'
import type { ServiceTask } from '../shared/contracts'
import { compareTaskQueueItems, taskMatchesQueueFilter, taskQueueFilterForQuery, taskRepeatSummary } from './task-queue'
import type { ServiceTypeConfig } from '../shared/contracts'
import { stabilizeOperationalOrder } from './stable-operational-order'

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

describe('task queue operating priority', () => {
  const serviceTypes = new Map<string, ServiceTypeConfig>([
    ['delivery', { id: 'delivery', code: 'FULFILLMENT_DELIVERY' } as ServiceTypeConfig],
    ['water', { id: 'water', code: 'WATER' } as ServiceTypeConfig],
  ])

  it('puts risks first, then own and backup delivery work', () => {
    const ownDelivery = task({ id: 'own-delivery', serviceTypeId: 'delivery', ownerId: 'employee-tom', warningAt: '2026-07-21T12:05:00.000Z' })
    const backupDelivery = task({ id: 'backup-delivery', serviceTypeId: 'delivery', warningAt: '2026-07-21T12:04:00.000Z' })
    const ownService = task({ id: 'own-service', ownerId: 'employee-tom', warningAt: '2026-07-21T12:03:00.000Z' })
    const risk = task({ id: 'risk', priority: 'urgent', warningAt: '2026-07-21T12:10:00.000Z' })
    const claimable = new Set(['backup-delivery'])
    const sorted = [ownService, backupDelivery, ownDelivery, risk].toSorted((left, right) => (
      compareTaskQueueItems(left, right, serviceTypes, 'employee-tom', claimable, now)
    ))
    expect(sorted.map((item) => item.id)).toEqual(['risk', 'own-delivery', 'backup-delivery', 'own-service'])
  })

  it('keeps the earliest deadline first inside the same group', () => {
    const later = task({ id: 'later', serviceTypeId: 'delivery', ownerId: 'employee-tom', warningAt: '2026-07-21T12:09:00.000Z' })
    const earlier = task({ id: 'earlier', serviceTypeId: 'delivery', ownerId: 'employee-tom', warningAt: '2026-07-21T12:03:00.000Z' })
    const sorted = [later, earlier].toSorted((left, right) => (
      compareTaskQueueItems(left, right, serviceTypes, 'employee-tom', new Set(), Date.parse('2026-07-21T11:50:00.000Z'))
    ))
    expect(sorted.map((item) => item.id)).toEqual(['earlier', 'later'])
  })

  it('does not move an operating task when another task crosses its SLA deadline', () => {
    const operating = task({ id: 'operating', warningAt: '2026-07-21T12:10:00.000Z' })
    const crossing = task({ id: 'crossing', warningAt: '2026-07-21T12:00:30.000Z' })
    const before = [operating, crossing]
    const afterClockTick = [crossing, operating]
    expect(stabilizeOperationalOrder(afterClockTick, before.map((item) => item.id), new Set(['operating']))
      .map((item) => item.id)).toEqual(['operating', 'crossing'])
    expect(stabilizeOperationalOrder(afterClockTick, before.map((item) => item.id), new Set())
      .map((item) => item.id)).toEqual(['crossing', 'operating'])
  })
})
