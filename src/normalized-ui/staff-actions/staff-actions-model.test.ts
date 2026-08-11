import { describe, expect, it } from 'vitest'
import {
  actionableFulfillmentItems,
  actionableServiceTasks,
  fulfillmentAction,
  requiresCapacityReason,
  validateOpenTableInput,
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

  it('puts assigned and urgent service work first while hiding terminal work', () => {
    const tasks: StaffServiceTask[] = [
      serviceTask({ id: 'normal', priority: 'normal', assignedEmployeeId: null }),
      serviceTask({ id: 'mine', priority: 'low', assignedEmployeeId: 'employee-1' }),
      serviceTask({ id: 'urgent', priority: 'urgent', assignedEmployeeId: null }),
    ]
    expect(actionableServiceTasks(tasks, 'employee-1').map((task) => task.id)).toEqual(['mine', 'urgent', 'normal'])
  })

  it('shows only executable KDS work and orders overdue then delivery before production', () => {
    const items: StaffFulfillmentItem[] = [
      fulfillmentItem({ taskId: 'prepare', canPrepare: true, kdsStatus: 'pending' }),
      fulfillmentItem({ taskId: 'deliver', canDeliver: true, readyForDelivery: true, kdsStatus: 'ready' }),
      fulfillmentItem({ taskId: 'overdue', canPrepare: true, overdue: true, kdsStatus: 'preparing' }),
      fulfillmentItem({ taskId: 'readonly' }),
    ]
    const actionable = actionableFulfillmentItems(items)
    expect(actionable.map((item) => item.taskId)).toEqual(['overdue', 'deliver', 'prepare'])
    expect(fulfillmentAction(actionable[0]!)).toBe('complete')
    expect(fulfillmentAction(actionable[1]!)).toBe('deliver')
    expect(fulfillmentAction(items[3]!)).toBeNull()
  })
})

function serviceTask(input: Partial<StaffServiceTask>): StaffServiceTask {
  return {
    id: 'task', tableId: 'table-1', tableCode: 'VIP1', tableSessionId: 'session-1', title: '送水',
    detail: null, priority: 'normal', status: 'pending', assignedEmployeeId: null, backupEmployeeId: null,
    dueAt: '2026-08-11T12:10:00.000Z', createdAt: '2026-08-11T12:00:00.000Z', ...input,
  }
}

function fulfillmentItem(input: Partial<StaffFulfillmentItem>): StaffFulfillmentItem {
  return {
    taskId: 'kds-1', stationCode: 'bar', kdsStatus: 'pending', priority: 1, overdue: false,
    readyForDelivery: false, canPrepare: false, canDeliver: false, dueAt: null,
    nextActionAt: '2026-08-11T12:05:00.000Z', createdAt: '2026-08-11T12:00:00.000Z',
    item: { productName: '鸡尾酒', quantity: 1, note: null },
    order: { publicId: 'order-1', note: null },
    table: { id: 'table-1', code: 'VIP1', assignmentType: null }, attentionMessages: [], ...input,
  }
}
