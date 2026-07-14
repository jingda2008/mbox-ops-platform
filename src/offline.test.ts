import { describe, expect, it, vi } from 'vitest'
import type { BootstrapResponse, TaskActionInput } from './shared/contracts'
import {
  buildQueuedTaskAction,
  isHighRiskOfflineWrite,
  replayQueuedActionsInOrder,
  sanitizeBootstrapSnapshot,
} from './offline'

function taskInput(idempotencyKey: string): TaskActionInput {
  return { action: 'accept', actorId: 'emp-owner', note: '', idempotencyKey }
}

describe('offline snapshot sanitization', () => {
  it('persists only the onsite whitelist and strips sensitive domains and free text', () => {
    const bootstrap = {
      store: { id: 'store-secret', name: 'M-Box', businessDate: '2026-07-14', timezone: 'Asia/Shanghai' },
      metrics: { occupiedTables: 1, openTasks: 1, atRiskTasks: 0, escalatedTasks: 0, complaints: 0 },
      areas: [{ id: 'area-1', name: '大厅', shortName: '大厅', color: '#333333', sortOrder: 1 }],
      tables: [{
        id: 'table-1', code: 'L01', displayName: '大厅01', areaId: 'area-1', capacity: 8,
        status: 'occupied', primaryEmployeeId: 'emp-owner', backupEmployeeIds: ['emp-backup'],
        guestCount: 5, openedAt: '2026-07-14T12:00:00.000Z',
      }],
      config: { serviceTypes: [{ id: 'water', name: '加水', icon: 'water', actionScript: ['送水到桌'] }] },
      tasks: [{
        id: 'task-1', tableId: 'table-1', serviceTypeId: 'water', status: 'pending', priority: 'normal',
        ownerId: 'emp-owner', createdAt: '2026-07-14T12:00:00.000Z', warningAt: '2026-07-14T12:01:00.000Z',
        actionScript: ['送水到桌'], note: '手机号 13800138000，会员要求退款', customerReply: '含客户自由文本',
      }],
      members: [{ id: 'member-1', phone: '13800138000' }],
      paymentDomain: { refunds: [{ id: 'refund-1', amount: 999 }] },
    } as unknown as BootstrapResponse

    const serialized = JSON.stringify(sanitizeBootstrapSnapshot(bootstrap))

    expect(serialized).not.toContain('13800138000')
    expect(serialized).not.toContain('member-1')
    expect(serialized).not.toContain('refund-1')
    expect(serialized).not.toContain('store-secret')
    expect(serialized).not.toContain('客户自由文本')
    expect(serialized).toContain('task-1')
    expect(serialized).toContain('送水到桌')
  })
})

describe('offline task action queue', () => {
  it('uses the existing task action idempotency key as the durable queue identity', () => {
    const item = buildQueuedTaskAction('task-1', taskInput('task-action-stable-001'), '2026-07-14T12:00:00.000Z', 17)

    expect(item.id).toBe('task-action-stable-001')
    expect(item.input.idempotencyKey).toBe('task-action-stable-001')
    expect(item.sequence).toBe(17)
  })

  it('replays by sequence and stops before later actions on HTTP 409', async () => {
    const first = buildQueuedTaskAction('task-1', taskInput('task-action-001'), '2026-07-14T12:00:02.000Z', 2)
    const conflict = buildQueuedTaskAction('task-2', taskInput('task-action-002'), '2026-07-14T12:00:01.000Z', 3)
    const later = buildQueuedTaskAction('task-3', taskInput('task-action-003'), '2026-07-14T12:00:00.000Z', 4)
    const sent: string[] = []
    const send = vi.fn(async (item: typeof first) => {
      sent.push(item.id)
      if (item.id === conflict.id) throw Object.assign(new Error('状态已被现场修改'), { status: 409 })
    })

    const result = await replayQueuedActionsInOrder([later, conflict, first], send)

    expect(sent).toEqual(['task-action-001', 'task-action-002'])
    expect(result.completedIds).toEqual(['task-action-001'])
    expect(result.conflict?.item.id).toBe('task-action-002')
    expect(result.conflict?.message).toBe('状态已被现场修改')
  })
})

describe('offline high-risk write policy', () => {
  it('blocks payment, refund, benefit, master-data and config writes but not service task actions', () => {
    expect(isHighRiskOfflineWrite('/api/payments/intent-1/refunds', 'POST')).toBe(true)
    expect(isHighRiskOfflineWrite('/api/config/publish', 'POST')).toBe(true)
    expect(isHighRiskOfflineWrite('/api/benefits/grants', 'POST')).toBe(true)
    expect(isHighRiskOfflineWrite('/api/master-data/employees', 'PUT')).toBe(true)
    expect(isHighRiskOfflineWrite('/api/tasks/task-1/actions', 'POST')).toBe(false)
    expect(isHighRiskOfflineWrite('/api/payments/intent-1', 'GET')).toBe(false)
  })
})
