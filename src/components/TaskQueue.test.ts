import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Employee, ServiceTask, ServiceTypeConfig, Table } from '../shared/contracts'
import { TaskQueue } from './TaskQueue'
import {
  taskAcceptMode,
  taskCanQuickComplete,
  taskQueueActionMode,
  taskQueueIsOpen,
  taskQueueIsVisible,
  taskWorkflowLevel,
} from './task-queue'

function task(ownerId: string | null, status: ServiceTask['status'] = 'pending') {
  return { ownerId, status } as ServiceTask
}

function serviceType(
  workflowLevel?: 'L0' | 'L1' | 'L2' | 'L3',
  allowBackupDirectComplete = false,
) {
  return {
    id: 'water',
    code: 'WATER',
    name: '加水',
    icon: 'water',
    enabled: true,
    priority: 'normal',
    dispatchRoleIds: [],
    sla: { warningSeconds: 60, escalateSeconds: 120, managerSeconds: 180 },
    customerReply: '收到',
    actionScript: [],
    workflowLevel,
    allowBackupDirectComplete,
  } as ServiceTypeConfig
}

function queueTask(patch: Partial<ServiceTask> = {}) {
  return {
    id: 'task-water',
    tableId: 'table-l01',
    tableSessionId: 'session-l01',
    serviceTypeId: 'water',
    source: 'guest',
    note: '两杯常温水',
    status: 'pending',
    priority: 'normal',
    ownerId: 'emp-tom',
    notifiedEmployeeIds: ['emp-tom'],
    createdAt: '2026-07-28T04:00:00.000Z',
    updatedAt: '2026-07-28T04:00:00.000Z',
    acceptedAt: null,
    arrivedAt: null,
    completedAt: null,
    warningAt: '2099-07-28T04:05:00.000Z',
    escalateAt: '2099-07-28T04:10:00.000Z',
    managerAt: '2099-07-28T04:15:00.000Z',
    escalationLevel: 0,
    configVersion: 1,
    customerReply: '收到',
    actionScript: ['接单', '到桌', '完成'],
    resolution: null,
    requestCount: 3,
    lastRequestedAt: new Date().toISOString(),
    triggerId: null,
    archivedAt: null,
    archiveOutcome: null,
    archivedFromStatus: null,
    ...patch,
  } as ServiceTask
}

function renderQueue(
  tasks: ServiceTask[],
  serviceTypes: ServiceTypeConfig[],
  options: { currentEmployeeId?: string; canManageTasks?: boolean } = {},
) {
  return renderToStaticMarkup(
    createElement(TaskQueue, {
      tasks,
      tables: [{ id: 'table-l01', displayName: 'L01' } as Table],
      employees: [
        { id: 'emp-tom', displayName: 'Tom' } as Employee,
        { id: 'emp-manager', displayName: '李艳' } as Employee,
      ],
      serviceTypes,
      selectedTableId: null,
      onClearTable: () => undefined,
      onAction: async () => undefined,
      onManagerAction: async () => undefined,
      onLoadTransferCandidates: async () => [],
      busyTaskIds: new Set<string>(),
      currentEmployeeId: options.currentEmployeeId ?? 'emp-tom',
      claimableTaskIds: new Set(['task-backup']),
      canManageTasks: options.canManageTasks ?? false,
    }),
  )
}

describe('task queue claim controls', () => {
  it('shows claim for unowned work and accept only to the assigned employee', () => {
    expect(taskAcceptMode(task(null), 'emp-lin', true)).toBe('claim')
    expect(taskAcceptMode(task(null), 'emp-lin', false)).toBeNull()
    expect(taskAcceptMode(task('emp-lin'), 'emp-lin', false)).toBe('accept')
    expect(taskAcceptMode(task('emp-jie'), 'emp-lin', true)).toBeNull()
  })

  it('does not offer claim or accept after work has already been accepted', () => {
    expect(taskAcceptMode(task(null, 'accepted'), 'emp-lin', true)).toBeNull()
    expect(taskAcceptMode(task('emp-lin', 'completed'), 'emp-lin', true)).toBeNull()
  })

  it('removes completed service from the employee reminder queue immediately', () => {
    expect(taskQueueIsOpen(task('emp-lin', 'arrived'))).toBe(true)
    expect(taskQueueIsOpen(task('emp-lin', 'completed'))).toBe(false)
    expect(taskQueueIsOpen(task('emp-lin', 'confirmed'))).toBe(false)
  })
})

describe('task workflow simplification', () => {
  it('keeps legacy service types on L3 and excludes L0 information from the queue', () => {
    expect(taskWorkflowLevel(serviceType())).toBe('L3')
    expect(taskQueueIsVisible(task(null), serviceType('L0'))).toBe(false)
    expect(taskQueueIsVisible(task(null), serviceType('L1'))).toBe(true)
  })

  it('allows an L1 owner or configured backup to complete in one action', () => {
    const quickService = serviceType('L1', true)
    expect(taskCanQuickComplete(task('emp-tom'), quickService, 'emp-tom', false)).toBe(true)
    expect(taskCanQuickComplete(task('emp-jerry'), quickService, 'emp-tom', true)).toBe(true)
    expect(taskCanQuickComplete(task('emp-jerry'), quickService, 'emp-tom', false)).toBe(false)
    expect(taskCanQuickComplete(task('emp-jerry'), serviceType('L1', false), 'emp-tom', true)).toBe(false)
  })

  it('reduces L2 to accept then complete while retaining the L3 responsibility chain', () => {
    const levelTwo = serviceType('L2')
    const levelThree = serviceType('L3')
    expect(taskQueueActionMode(task('emp-tom'), levelTwo, 'emp-tom', false)).toBe('accept')
    expect(taskQueueActionMode(task('emp-tom', 'accepted'), levelTwo, 'emp-tom', false)).toBe('complete')
    expect(taskQueueActionMode(task('emp-tom', 'arrived'), levelTwo, 'emp-tom', false)).toBe('complete')
    expect(taskQueueActionMode(task('emp-tom', 'accepted'), levelThree, 'emp-tom', false)).toBe('arrive')
    expect(taskQueueActionMode(task('emp-tom', 'arrived'), levelThree, 'emp-tom', false)).toBe('complete')
    expect(taskQueueActionMode(task('emp-jerry', 'accepted'), levelTwo, 'emp-tom', false)).toBeNull()
    expect(taskQueueActionMode(task('emp-jerry', 'arrived'), levelThree, 'emp-tom', false)).toBeNull()
  })

  it('renders no L0 card and keeps an L1 card to one concise action', () => {
    const markup = renderQueue(
      [
        queueTask({ id: 'task-info', serviceTypeId: 'info' }),
        queueTask(),
      ],
      [
        { ...serviceType('L0'), id: 'info', name: '客情提示' },
        serviceType('L1', true),
      ],
    )
    expect(markup).not.toContain('客情提示')
    expect(markup).not.toContain('AI指令')
    expect(markup).not.toContain('已到桌')
    expect(markup).not.toContain('接单')
    expect(markup).toContain('已处理')
    expect(markup).toContain('重复呼叫 3次')
  })

  it('renders L2 accepted work with completion only and no arrive action', () => {
    const markup = renderQueue(
      [queueTask({ status: 'accepted', actionScript: [] })],
      [serviceType('L2')],
    )
    expect(markup).toContain('完成')
    expect(markup).not.toContain('已到桌')
  })

  it('labels another employee task for manager oversight without rendering a false completion action', () => {
    const markup = renderQueue(
      [queueTask({ status: 'accepted', actionScript: [] })],
      [serviceType('L2')],
      { currentEmployeeId: 'emp-manager', canManageTasks: true },
    )
    expect(markup).toContain('他人任务 · Tom负责')
    expect(markup).toContain('处理')
    expect(markup).not.toContain('>完成<')
    expect(markup).not.toContain('提醒负责人')
  })
})
