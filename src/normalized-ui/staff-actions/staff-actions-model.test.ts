import { describe, expect, it } from 'vitest'
import {
  actionableFulfillmentItems,
  actionableServiceTasks,
  fulfillmentAction,
  recommendationSceneSnapshot,
  requiresCapacityReason,
  tableMoodPresentation,
  unifiedActionQueue,
  validateOpenTableInput,
  visibleFulfillmentItems,
  visibleStaffTables,
} from './staff-actions-model'
import type { StaffActionTable, StaffFulfillmentItem, StaffServiceTask } from './types'

const table: StaffActionTable = {
  id: 'table-1', code: 'VIP1', displayName: 'VIP1', areaId: 'area-1', areaName: '室内', capacity: 4,
  status: 'available', assignedToActor: true, activeSession: null,
}

describe('staff actions model', () => {
  it('never invents a default guest count and requires an audited reason above capacity', () => {
    expect(validateOpenTableInput(table, '', '')).toEqual({ error: '请先选择或输入实际到店人数' })
    expect(validateOpenTableInput(table, '6', '')).toEqual({ error: '人数超过桌台容量4人，请填写加座说明' })
    expect(validateOpenTableInput(table, '6', '现场加椅，通道已确认')).toEqual({
      guestCount: 6,
      capacityOverrideReason: '现场加椅，通道已确认',
    })
    expect(requiresCapacityReason(table, 4)).toBe(false)
    expect(requiresCapacityReason(table, 5)).toBe(true)
  })

  it('maps optional open-table scenes to the existing recommendation occasion vocabulary', () => {
    expect(recommendationSceneSnapshot('brothers')).toEqual({ recommendationScene: 'friends' })
    expect(recommendationSceneSnapshot('friends')).toEqual({ recommendationScene: 'friends' })
    expect(recommendationSceneSnapshot('business')).toEqual({ recommendationScene: 'business' })
    expect(recommendationSceneSnapshot('date')).toEqual({ recommendationScene: 'date' })
    expect(recommendationSceneSnapshot('solo')).toEqual({ recommendationScene: 'other' })
    expect(recommendationSceneSnapshot('unsure')).toEqual({ recommendationScene: 'other' })
  })

  it('puts assigned and urgent service work first while hiding terminal work', () => {
    const tasks: StaffServiceTask[] = [
      serviceTask({ id: 'normal', priority: 'normal', assignedEmployeeId: null }),
      serviceTask({ id: 'table-mine', priority: 'low', assignedToActor: true }),
      serviceTask({ id: 'mine', priority: 'low', assignedEmployeeId: 'employee-1' }),
      serviceTask({ id: 'urgent', priority: 'urgent', assignedEmployeeId: null }),
    ]
    expect(actionableServiceTasks(tasks, 'employee-1').map((task) => task.id)).toEqual(['table-mine', 'mine', 'urgent', 'normal'])
  })

  it('keeps every visible KDS item inspectable while reserving the action queue for executable work', () => {
    const items: StaffFulfillmentItem[] = [
      fulfillmentItem({ taskId: 'prepare', canPrepare: true, kdsStatus: 'pending' }),
      fulfillmentItem({ taskId: 'deliver', canDeliver: true, readyForDelivery: true, kdsStatus: 'ready' }),
      fulfillmentItem({ taskId: 'overdue', canPrepare: true, overdue: true, kdsStatus: 'preparing' }),
      fulfillmentItem({ taskId: 'readonly' }),
    ]
    const actionable = actionableFulfillmentItems(items)
    expect(actionable.map((item) => item.taskId)).toEqual(['overdue', 'deliver', 'prepare'])
    expect(visibleFulfillmentItems(items).map((item) => item.taskId)).toEqual(['overdue', 'deliver', 'prepare', 'readonly'])
    expect(fulfillmentAction(actionable[0]!)).toBe('complete')
    expect(fulfillmentAction(actionable[1]!)).toBe('deliver')
    expect(fulfillmentAction(items[3]!)).toBeNull()
  })

  it('keeps a failed production task actionable when the current employee has remake permission', () => {
    const failed = fulfillmentItem({ taskId: 'failed', kdsStatus: 'failed', canRemake: true })

    expect(fulfillmentAction(failed)).toBe('remake')
    expect(actionableFulfillmentItems([failed])).toEqual([failed])
  })

  it('presents guest mood as a compact table marker instead of an action', () => {
    expect(tableMoodPresentation('happy')).toEqual({ symbol: '☺', label: '开心' })
    expect(tableMoodPresentation('quiet')).toEqual({ symbol: '☾', label: '安静' })
    expect(tableMoodPresentation('unknown')).toEqual({ symbol: '·', label: '客人状态' })
  })

  it('keeps the table workspace quiet by default while search can still find any table', () => {
    const active = { ...table, id: 'active', code: 'W01', assignedToActor: false, activeSession: {
      id: 'session-1', guestCount: 2, capacityAtOpen:4, status: 'open' as const,
      openedAt: '2026-08-11T12:00:00.000Z', latestMood: null,
    } }
    const assigned = { ...table, id: 'assigned', code: 'VIP1', assignedToActor: true }
    const quiet = { ...table, id: 'quiet', code: 'A01', assignedToActor: false }
    const attention = new Set(['quiet'])

    expect(visibleStaffTables([active, assigned, quiet], 'attention', '', attention).map((item) => item.code))
      .toEqual(['W01', 'VIP1', 'A01'])
    expect(visibleStaffTables([active, assigned, quiet], 'mine', '', attention).map((item) => item.code))
      .toEqual(['VIP1'])
    expect(visibleStaffTables([active, assigned, quiet], 'all', 'a01', attention).map((item) => item.code))
      .toEqual(['A01'])
  })

  it('builds one busy-time queue: complaint, overdue, delivery, assigned service, production', () => {
    const complaint = serviceTask({ id: 'complaint', taskType: 'guest.complaint', interactionMode: 'manager_resolution' })
    const assigned = serviceTask({ id: 'assigned', assignedToActor: true })
    const overdue = fulfillmentItem({ taskId: 'overdue', overdue: true, canPrepare: true })
    const delivery = fulfillmentItem({
      taskId: 'delivery', kdsStatus: 'ready', readyForDelivery: true, canDeliver: true,
      table: { id: 'table-1', code: 'VIP1', assignmentType: 'backup' },
    })
    const supportDelivery = fulfillmentItem({
      taskId: 'support-delivery', kdsStatus: 'ready', readyForDelivery: true, canDeliver: true,
    })
    const production = fulfillmentItem({ taskId: 'production', canPrepare: true })

    expect(unifiedActionQueue([assigned, complaint], [production, supportDelivery, delivery, overdue], 'employee-1')
      .map((action) => action.key)).toEqual([
        'service:complaint', 'fulfillment:overdue', 'fulfillment:delivery',
        'service:assigned', 'fulfillment:support-delivery', 'fulfillment:production',
      ])
  })
})

function serviceTask(input: Partial<StaffServiceTask>): StaffServiceTask {
  return {
    id: 'task', taskType: 'water', tableId: 'table-1', tableCode: 'VIP1', tableSessionId: 'session-1', title: '送水',
    detail: null, priority: 'normal', status: 'pending', assignedEmployeeId: null, backupEmployeeId: null,
    assignedToActor: false, interactionMode: 'quick_complete',
    dueAt: '2026-08-11T12:10:00.000Z', createdAt: '2026-08-11T12:00:00.000Z', ...input,
  }
}

function fulfillmentItem(input: Partial<StaffFulfillmentItem>): StaffFulfillmentItem {
  return {
    taskId: 'kds-1', stationCode: 'bar', kdsStatus: 'pending', priority: 1, overdue: false,
    readyForDelivery: false, canPrepare: false, canDeliver: false, canRemake: false, dueAt: null,
    nextActionAt: '2026-08-11T12:05:00.000Z', createdAt: '2026-08-11T12:00:00.000Z',
    item: { productName: '鸡尾酒', quantity: 1, note: null },
    order: { publicId: 'order-1', note: null },
    table: { id: 'table-1', code: 'VIP1', assignmentType: null }, attentionMessages: [], ...input,
  }
}
