import { randomUUID } from 'node:crypto'
import type {
  ConfigDraftInput,
  CreateTaskInput,
  Employee,
  OperationsMetrics,
  RuntimeState,
  ServiceTask,
  ServiceTypeConfig,
  SlaConfig,
  TaskActionInput,
  TaskEvent,
} from '../src/shared/contracts.js'
import { withDefaultRolePolicy } from '../src/shared/role-policy.js'
import { effectiveDataScopeForEmployee, effectiveRoleIdsForEmployee } from '../src/shared/staff-access.js'
import { currentOpenTableSession } from './table-sessions.js'

const closedStatuses = new Set<ServiceTask['status']>(['completed', 'confirmed', 'cancelled'])
const claimableStatuses = new Set<ServiceTask['status']>(['pending', 'escalated', 'reopened'])

function isoAt(base: Date, seconds: number) {
  return new Date(base.getTime() + seconds * 1000).toISOString()
}

function appendTaskEvent(
  state: RuntimeState,
  taskId: string,
  type: string,
  actorId: string,
  payload: Record<string, unknown> = {},
) {
  const event: TaskEvent = {
    id: `evt_${randomUUID()}`,
    taskId,
    type,
    actorId,
    occurredAt: new Date().toISOString(),
    payload,
  }
  state.taskEvents.push(event)
}

function taskWorkflowLevel(task: ServiceTask) {
  return task.workflowLevel ?? 'L3'
}

function markTaskViewed(task: ServiceTask, employeeId: string) {
  task.viewedEmployeeIds = [...new Set([...(task.viewedEmployeeIds ?? []), employeeId])]
}

function completionNoteRequired(state: RuntimeState, task: ServiceTask) {
  return state.config.serviceTypes.find((item) => item.id === task.serviceTypeId)?.requiresCompletionNote ?? false
}

function assertCompletionNote(state: RuntimeState, task: ServiceTask, note: string) {
  if (completionNoteRequired(state, task) && !note.trim()) throw new Error('请填写处理结果')
}

function closeTaskByStaff(
  state: RuntimeState,
  task: ServiceTask,
  actorId: string,
  now: string,
  eventPayload: Record<string, unknown>,
  eventType = 'task.completed.v1',
) {
  task.status = 'confirmed'
  task.completedAt = now
  task.completedBy = actorId
  task.resolution = typeof eventPayload.note === 'string' && eventPayload.note.trim()
    ? eventPayload.note.trim()
    : '员工确认完成'
  markTaskViewed(task, actorId)
  appendTaskEvent(state, task.id, eventType, actorId, { ...eventPayload, resolution: task.resolution })
  appendTaskEvent(state, task.id, 'service.closed_by_staff.v1', actorId, {
    ...eventPayload,
    resolution: task.resolution,
    customerConfirmationRequired: false,
  })
}

export function isOpenTask(task: ServiceTask) {
  return !closedStatuses.has(task.status)
}

export function employeeLoad(state: RuntimeState, employeeId: string) {
  return state.tasks.filter((task) => task.ownerId === employeeId && isOpenTask(task)).length
}

function roleLimit(state: RuntimeState, employee: Employee) {
  return effectiveRoleIdsForEmployee(state, employee.id)
    .map((roleId) => state.config.roles.find((role) => role.id === roleId))
    .filter((role) => role?.canReceiveTasks)
    .toSorted((left, right) => (right?.maxConcurrentTasks ?? 0) - (left?.maxConcurrentTasks ?? 0))[0]
}

function canReceiveAutomaticTableDispatch(state: RuntimeState, employee: Employee, tableId: string) {
  const table = state.tables.find((item) => item.id === tableId)
  if (!table) return false
  const scope = effectiveDataScopeForEmployee(state, employee.id)
  if (scope === 'all_stores' || scope === 'store') return true
  if (scope === 'assigned_areas') {
    const activeShifts = state.shiftAssignments.filter((shift) => (
      shift.employeeId === employee.id
      && shift.businessDate === state.store.businessDate
      && shift.status === 'active'
    ))
    const areaIds = activeShifts.length > 0
      ? activeShifts.flatMap((shift) => shift.areaIds)
      : employee.areaIds
    return areaIds.includes(table.areaId)
  }
  return table.primaryEmployeeId === employee.id || table.backupEmployeeIds.includes(employee.id)
}

type DispatchSource = 'targeted' | 'primary' | 'backup' | 'role' | 'manager'

interface DispatchDecision {
  employee: Employee
  source: DispatchSource
  loadBefore: number
  capacity: number
  utilization: number
}

function assignmentMetadata(decision: DispatchDecision | null) {
  return decision ? {
    strategy: 'load_aware',
    candidateSource: decision.source,
    loadBefore: decision.loadBefore,
    capacity: decision.capacity,
    utilization: Math.round(decision.utilization * 100) / 100,
  } : {
    strategy: 'load_aware',
    candidateSource: null,
    loadBefore: null,
    capacity: null,
    utilization: null,
  }
}

function rankDispatchCandidates(
  state: RuntimeState,
  candidates: Array<{ employee: Employee; source: DispatchSource; sourceRank: number }>,
) {
  return candidates
    .map(({ employee, source, sourceRank }) => {
      const role = roleLimit(state, employee)
      const loadBefore = employeeLoad(state, employee.id)
      const capacity = role?.maxConcurrentTasks ?? 0
      return {
        employee,
        source,
        sourceRank,
        loadBefore,
        capacity,
        utilization: capacity > 0 ? loadBefore / capacity : Number.POSITIVE_INFINITY,
      }
    })
    .filter((candidate) => candidate.capacity > 0 && candidate.loadBefore < candidate.capacity)
    .toSorted((left, right) => (
      left.loadBefore - right.loadBefore
      || left.sourceRank - right.sourceRank
      || left.utilization - right.utilization
      || left.employee.displayName.localeCompare(right.employee.displayName, 'zh-CN')
      || left.employee.id.localeCompare(right.employee.id)
    ))
}

function chooseAssignee(
  state: RuntimeState,
  tableId: string,
  serviceType: ServiceTypeConfig,
  excludedEmployeeIds: string[] = [],
  preferredEmployeeIds: string[] = [],
) {
  const table = state.tables.find((item) => item.id === tableId)
  if (!table) return null

  const candidates = [
    ...preferredEmployeeIds.map((employeeId, index) => ({ employeeId, source: 'targeted' as const, sourceRank: index })),
    { employeeId: table.primaryEmployeeId, source: 'primary' as const, sourceRank: 0 },
    ...table.backupEmployeeIds.map((employeeId, index) => ({ employeeId, source: 'backup' as const, sourceRank: index + 1 })),
    ...serviceType.dispatchRoleIds.flatMap((roleId) =>
      state.employees
        .filter((employee) => effectiveRoleIdsForEmployee(state, employee.id).includes(roleId))
        .map((employee, index) => ({ employeeId: employee.id, source: 'role' as const, sourceRank: index + 20 })),
    ),
  ]

  const seen = new Set<string>()
  const eligible: Array<{ employee: Employee; source: DispatchSource; sourceRank: number }> = []
  for (const { employeeId, source, sourceRank } of candidates) {
    if (seen.has(employeeId) || excludedEmployeeIds.includes(employeeId)) continue
    seen.add(employeeId)
    const employee = state.employees.find((item) => item.id === employeeId)
    if (!employee || employee.status !== 'active' || !employee.online || employee.paused) continue
    if (!effectiveRoleIdsForEmployee(state, employee.id).some((roleId) => serviceType.dispatchRoleIds.includes(roleId))) continue
    if (source === 'role' && !canReceiveAutomaticTableDispatch(state, employee, table.id)) continue
    eligible.push({ employee, source, sourceRank })
  }

  const targeted = rankDispatchCandidates(state, eligible.filter((candidate) => candidate.source === 'targeted'))[0]
  if (targeted) return targeted

  const tableTeam = rankDispatchCandidates(state, eligible.filter((candidate) => (
    candidate.source === 'primary' || candidate.source === 'backup'
  )))[0]
  if (tableTeam) return tableTeam

  const roleCoverage = rankDispatchCandidates(state, eligible.filter((candidate) => candidate.source === 'role'))[0]
  if (roleCoverage) return roleCoverage

  return rankDispatchCandidates(state, state.employees
    .filter(
      (employee) =>
        effectiveRoleIdsForEmployee(state, employee.id).includes('manager') &&
        employee.status === 'active' &&
        employee.online &&
        !employee.paused &&
        !excludedEmployeeIds.includes(employee.id),
    )
    .map((employee, index) => ({ employee, source: 'manager' as const, sourceRank: index })))[0] ?? null
}

function employeeHasTableResponsibility(state: RuntimeState, employee: Employee, task: ServiceTask) {
  if (task.notifiedEmployeeIds.includes(employee.id)) return true
  const table = state.tables.find((item) => item.id === task.tableId)
  if (!table) return false
  const scope = effectiveDataScopeForEmployee(state, employee.id)
  if (scope === 'all_stores' || scope === 'store') return true
  if (scope === 'assigned_areas') return employee.areaIds.includes(table.areaId)
  return table.primaryEmployeeId === employee.id || table.backupEmployeeIds.includes(employee.id)
}

/** Authoritative eligibility check for manually claiming an unowned service task. */
export function canEmployeeClaimTask(state: RuntimeState, task: ServiceTask, employeeId: string) {
  if (task.ownerId !== null || !claimableStatuses.has(task.status)) return false
  const employee = state.employees.find((item) => item.id === employeeId)
  if (!employee || employee.status !== 'active' || !employee.online || employee.paused) return false
  const serviceType = state.config.serviceTypes.find((item) => item.id === task.serviceTypeId && item.enabled)
  if (!serviceType) return false
  const roleIds = effectiveRoleIdsForEmployee(state, employee.id)
  const dispatchRoleIds = task.dispatchRoleIdsSnapshot?.length ? task.dispatchRoleIdsSnapshot : serviceType.dispatchRoleIds
  if (!roleIds.some((roleId) => dispatchRoleIds.includes(roleId))) return false
  return employeeHasTableResponsibility(state, employee, task)
}

/** Assigns waiting work when staff return online. The caller owns the aggregate revision update. */
export function redispatchUnownedTasks(state: RuntimeState, now = new Date()) {
  let changed = false
  for (const task of state.tasks) {
    if (task.ownerId !== null || !claimableStatuses.has(task.status)) continue
    const configuredServiceType = state.config.serviceTypes.find((item) => item.id === task.serviceTypeId && item.enabled)
    if (!configuredServiceType) continue
    const serviceType = task.dispatchRoleIdsSnapshot?.length
      ? { ...configuredServiceType, dispatchRoleIds: task.dispatchRoleIdsSnapshot }
      : configuredServiceType
    const assignment = chooseAssignee(state, task.tableId, serviceType, [], task.targetEmployeeIdsSnapshot ?? [])
    if (!assignment) continue
    const assignee = assignment.employee
    task.ownerId = assignee.id
    task.updatedAt = now.toISOString()
    task.customerReply = serviceType.customerReply.replace('{employee}', assignee.displayName)
    if (!task.notifiedEmployeeIds.includes(assignee.id)) task.notifiedEmployeeIds.push(assignee.id)
    appendTaskEvent(state, task.id, 'task.assigned.v1', 'system', {
      ownerId: assignee.id,
      reason: 'employee_online',
      ...assignmentMetadata(assignment),
    })
    changed = true
  }
  return changed
}

export function createServiceTask(state: RuntimeState, input: CreateTaskInput & {
  triggerId?: string
  requestedBy?: string
  dispatchRoleIds?: string[]
  dispatchEmployeeIds?: string[]
  managerRoleIds?: string[]
  slaOverride?: SlaConfig
}) {
  const existing = state.auditEntries.find(
    (entry) => entry.action === 'service.requested.v1' && entry.details.idempotencyKey === input.idempotencyKey,
  )
  if (existing) {
    const task = state.tasks.find((item) => item.id === existing.objectId)
    if (task) return task
  }

  const table = state.tables.find((item) => item.code.toLowerCase() === input.tableCode.toLowerCase())
  if (!table) throw new Error('未找到桌台')
  if (table.status !== 'occupied') throw new Error('该桌台当前未开台')
  const tableSession = currentOpenTableSession(state, table.id)

  const serviceType = state.config.serviceTypes.find((item) => item.id === input.serviceTypeId && item.enabled)
  if (!serviceType) throw new Error('服务类型未启用')
  const dispatchServiceType = input.dispatchRoleIds?.length
    ? { ...serviceType, dispatchRoleIds: [...new Set(input.dispatchRoleIds)] }
    : serviceType

  const now = new Date()
  const taskSla = input.slaOverride ?? serviceType.sla
  const workflowLevel = serviceType.workflowLevel ?? 'L3'
  const informationOnly = workflowLevel === 'L0'
  const assignment = informationOnly
    ? null
    : chooseAssignee(state, table.id, dispatchServiceType, [], input.dispatchEmployeeIds)
  const assignee = assignment?.employee ?? null
  const customerReply = serviceType.customerReply.replace('{employee}', assignee?.displayName ?? '服务团队')
  const task: ServiceTask = {
    id: `task_${randomUUID()}`,
    tableId: table.id,
    tableSessionId: tableSession.id,
    serviceTypeId: serviceType.id,
    source: input.source,
    note: input.note,
    status: informationOnly ? 'confirmed' : 'pending',
    priority: serviceType.priority,
    ownerId: assignee?.id ?? null,
    notifiedEmployeeIds: [...new Set([
      assignee?.id,
      table.primaryEmployeeId,
      ...(input.dispatchEmployeeIds ?? []),
    ].filter((value): value is string => Boolean(value)))],
    dispatchRoleIdsSnapshot: [...dispatchServiceType.dispatchRoleIds],
    targetEmployeeIdsSnapshot: [...new Set(input.dispatchEmployeeIds ?? [])],
    managerRoleIdsSnapshot: [...new Set(input.managerRoleIds ?? ['manager'])],
    slaSnapshot: { ...taskSla },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    acceptedAt: null,
    arrivedAt: null,
    completedAt: informationOnly ? now.toISOString() : null,
    warningAt: isoAt(now, taskSla.warningSeconds),
    escalateAt: isoAt(now, taskSla.escalateSeconds),
    managerAt: isoAt(now, taskSla.managerSeconds),
    escalationLevel: 0,
    configVersion: state.config.version,
    customerReply,
    actionScript: [...serviceType.actionScript],
    resolution: informationOnly ? '客情信息已记录' : null,
    workflowLevel,
    requestCount: 1,
    firstRequestedAt: now.toISOString(),
    lastRequestedAt: now.toISOString(),
    viewedEmployeeIds: [],
    completedBy: informationOnly ? 'system' : null,
    triggerId: 'triggerId' in input && typeof input.triggerId === 'string' ? input.triggerId : null,
    archivedAt: null,
    archiveOutcome: null,
    archivedFromStatus: null,
  }
  state.tasks.unshift(task)
  state.auditEntries.push({
    id: `audit_${randomUUID()}`,
    actorId: input.requestedBy ?? input.source,
    action: 'service.requested.v1',
    objectType: 'serviceTask',
    objectId: task.id,
    occurredAt: now.toISOString(),
    details: {
      idempotencyKey: input.idempotencyKey,
      tableCode: table.code,
      tableSessionId: tableSession.id,
      configVersion: state.config.version,
      source: input.source,
      merged: false,
    },
  })
  appendTaskEvent(state, task.id, 'task.created.v1', 'system', {
    ownerId: task.ownerId,
    tableId: table.id,
    tableSessionId: tableSession.id,
    configVersion: task.configVersion,
    ...assignmentMetadata(assignment),
  })
  if (informationOnly) {
    appendTaskEvent(state, task.id, 'service.info_recorded.v1', input.requestedBy ?? input.source, {
      tableId: table.id,
      tableSessionId: tableSession.id,
      note: task.note,
    })
  }
  state.revision += 1
  return task
}

export function mergeServiceTaskRequest(
  state: RuntimeState,
  taskId: string,
  input: {
    note: string
    idempotencyKey: string
    requestedBy?: string
    source: ServiceTask['source']
  },
) {
  const replay = state.auditEntries.find(
    (entry) => entry.action === 'service.requested.v1' && entry.details.idempotencyKey === input.idempotencyKey,
  )
  if (replay) {
    const replayTask = state.tasks.find((task) => task.id === replay.objectId)
    if (!replayTask) throw new Error('重复请求对应的任务不存在')
    if (replayTask.id !== taskId) throw new Error('同一幂等键不能用于不同服务请求')
    return replayTask
  }

  const task = state.tasks.find((item) => item.id === taskId)
  if (!task) throw new Error('任务不存在')
  if (!isOpenTask(task) || task.archivedAt) throw new Error('已关闭的任务不能合并新请求')
  const now = new Date().toISOString()
  const previousNote = task.note
  const latestNote = input.note.trim()
  task.requestCount = (task.requestCount ?? 1) + 1
  task.firstRequestedAt ??= task.createdAt
  task.lastRequestedAt = now
  task.updatedAt = now
  if (latestNote) task.note = latestNote
  state.auditEntries.push({
    id: `audit_${randomUUID()}`,
    actorId: input.requestedBy ?? input.source,
    action: 'service.requested.v1',
    objectType: 'serviceTask',
    objectId: task.id,
    occurredAt: now,
    details: {
      idempotencyKey: input.idempotencyKey,
      tableSessionId: task.tableSessionId,
      source: input.source,
      merged: true,
      requestCount: task.requestCount,
    },
  })
  appendTaskEvent(state, task.id, 'task.request_merged.v1', input.requestedBy ?? input.source, {
    idempotencyKey: input.idempotencyKey,
    requestCount: task.requestCount,
    previousNote,
    requestedNote: latestNote,
    latestNote: task.note,
  })
  state.revision += 1
  return task
}

function tableCloseOutcome(status: ServiceTask['status']): NonNullable<ServiceTask['archiveOutcome']> {
  if (closedStatuses.has(status)) return 'resolved'
  return 'unresolved'
}

/** Removes a finished visit from live dispatch while retaining its full analytical trail. */
export function archiveServiceTasksForTableSession(
  state: RuntimeState,
  tableSessionId: string,
  occurredAt: string,
  actorId: string,
  reason: string,
) {
  const archived: ServiceTask[] = []
  for (const task of state.tasks.filter((item) => item.tableSessionId === tableSessionId && !item.archivedAt)) {
    const previousStatus = task.status
    task.archivedAt = occurredAt
    task.archiveOutcome = tableCloseOutcome(previousStatus)
    task.archivedFromStatus = previousStatus
    task.updatedAt = occurredAt
    if (!closedStatuses.has(previousStatus)) task.status = 'cancelled'
    if (!task.resolution && task.archiveOutcome === 'unresolved') task.resolution = '桌次结束时需求仍未完成'
    appendTaskEvent(state, task.id, 'task.archived_with_table_visit.v1', actorId, {
      tableSessionId,
      previousStatus,
      archiveOutcome: task.archiveOutcome,
      reason,
    })
    archived.push(task)
  }
  return archived
}

function assertActor(task: ServiceTask, actorId: string) {
  if (task.ownerId !== actorId) throw new Error('只有当前责任人可以执行此操作')
}

export function applyTaskAction(state: RuntimeState, taskId: string, input: TaskActionInput) {
  const task = state.tasks.find((item) => item.id === taskId)
  if (!task) throw new Error('任务不存在')
  const replay = state.taskEvents.find((event) => event.taskId === taskId && event.payload.idempotencyKey === input.idempotencyKey)
  if (replay) {
    if (replay.actorId !== input.actorId || replay.payload.action !== input.action || replay.payload.note !== input.note) {
      throw new Error('同一幂等键不能用于不同任务动作')
    }
    return task
  }
  const now = new Date().toISOString()
  const eventPayload = { idempotencyKey: input.idempotencyKey, action: input.action, note: input.note }

  switch (input.action) {
    case 'accept':
      if (!claimableStatuses.has(task.status)) {
        if (task.status === 'accepted' && task.ownerId !== input.actorId) throw new Error('任务已由其他员工接单')
        throw new Error('当前状态不能接单')
      }
      if (task.ownerId === null) {
        if (!canEmployeeClaimTask(state, task, input.actorId)) throw new Error('您当前不在该任务的通知或责任范围内')
        task.ownerId = input.actorId
        if (!task.notifiedEmployeeIds.includes(input.actorId)) task.notifiedEmployeeIds.push(input.actorId)
        const serviceType = state.config.serviceTypes.find((item) => item.id === task.serviceTypeId)
        const employee = state.employees.find((item) => item.id === input.actorId)
        if (serviceType && employee) task.customerReply = serviceType.customerReply.replace('{employee}', employee.displayName)
      } else {
        assertActor(task, input.actorId)
      }
      task.status = 'accepted'
      task.acceptedAt = now
      markTaskViewed(task, input.actorId)
      appendTaskEvent(state, task.id, 'task.accepted.v1', input.actorId, {
        ...eventPayload,
        ownerId: task.ownerId,
      })
      break
    case 'arrive':
      assertActor(task, input.actorId)
      if (task.status !== 'accepted') throw new Error('必须先接单')
      task.status = 'arrived'
      task.arrivedAt = now
      markTaskViewed(task, input.actorId)
      appendTaskEvent(state, task.id, 'task.arrived.v1', input.actorId, eventPayload)
      break
    case 'complete':
      assertActor(task, input.actorId)
      assertCompletionNote(state, task, input.note)
      if (taskWorkflowLevel(task) === 'L3' && task.status !== 'arrived') throw new Error('必须先确认到桌')
      if (taskWorkflowLevel(task) === 'L2' && !['accepted', 'arrived'].includes(task.status)) throw new Error('必须先接单')
      if (taskWorkflowLevel(task) === 'L1' && !['accepted', 'arrived'].includes(task.status)) {
        throw new Error('快速服务请直接使用一键完成')
      }
      if (taskWorkflowLevel(task) === 'L0') throw new Error('信息提示无需完成操作')
      closeTaskByStaff(state, task, input.actorId, now, eventPayload)
      break
    case 'quick_complete': {
      if (taskWorkflowLevel(task) !== 'L1') throw new Error('只有快速服务可以一键完成')
      if (!claimableStatuses.has(task.status)) throw new Error('当前状态不能一键完成')
      assertCompletionNote(state, task, input.note)
      const employee = state.employees.find((item) => item.id === input.actorId)
      if (!employee || employee.status !== 'active') throw new Error('员工账号不可用')
      const serviceType = state.config.serviceTypes.find((item) => item.id === task.serviceTypeId)
      if (!serviceType) throw new Error('服务类型配置不存在')
      const dispatchRoleIds = task.dispatchRoleIdsSnapshot?.length
        ? task.dispatchRoleIdsSnapshot
        : serviceType.dispatchRoleIds
      const roleEligible = effectiveRoleIdsForEmployee(state, employee.id)
        .some((roleId) => dispatchRoleIds.includes(roleId))
      const table = state.tables.find((item) => item.id === task.tableId)
      const directlyNotified = task.ownerId === employee.id || task.notifiedEmployeeIds.includes(employee.id)
      const backupEligible = Boolean(
        serviceType.allowBackupDirectComplete && table?.backupEmployeeIds.includes(employee.id),
      )
      const crossAreaEligible = Boolean(serviceType.allowCrossAreaComplete && roleEligible)
      if (!roleEligible || (!directlyNotified && !backupEligible && !crossAreaEligible)) {
        throw new Error('您当前不在该快速服务的通知、候补或岗位范围内')
      }
      closeTaskByStaff(state, task, input.actorId, now, eventPayload, 'task.quick_completed.v1')
      break
    }
    case 'confirm':
      if (!input.actorId.startsWith('guest-')) throw new Error('仅客人可以确认服务已经解决')
      if (!['completed', 'confirmed'].includes(task.status)) throw new Error('任务尚未完成')
      task.status = 'confirmed'
      appendTaskEvent(state, task.id, 'service.confirmed.v1', input.actorId, eventPayload)
      break
    case 'unresolved': {
      if (!input.actorId.startsWith('guest-')) throw new Error('仅客人可以反馈服务仍未解决')
      if (!['completed', 'confirmed'].includes(task.status)) throw new Error('任务尚未完成')
      const previousOwnerId = task.ownerId
      const configuredServiceType = state.config.serviceTypes.find((item) => item.id === task.serviceTypeId)
      if (!configuredServiceType) throw new Error('服务类型配置不存在')
      const serviceType = task.dispatchRoleIdsSnapshot?.length
        ? { ...configuredServiceType, dispatchRoleIds: task.dispatchRoleIdsSnapshot }
        : configuredServiceType
      const nextAssignment = chooseAssignee(
        state,
        task.tableId,
        serviceType,
        previousOwnerId ? [previousOwnerId] : [],
        task.targetEmployeeIdsSnapshot ?? [],
      )
      const nextOwner = nextAssignment?.employee ?? null
      task.status = 'reopened'
      task.priority = task.priority === 'urgent' ? 'urgent' : 'high'
      task.ownerId = nextOwner?.id ?? previousOwnerId
      task.escalationLevel = Math.max(task.escalationLevel, 1)
      const reopenedAt = new Date(now)
      const taskSla = task.slaSnapshot ?? serviceType.sla
      task.warningAt = isoAt(reopenedAt, taskSla.warningSeconds)
      task.escalateAt = isoAt(reopenedAt, taskSla.escalateSeconds)
      task.managerAt = isoAt(reopenedAt, taskSla.managerSeconds)
      task.acceptedAt = null
      task.arrivedAt = null
      task.completedAt = null
      task.completedBy = null
      task.resolution = null
      if (task.ownerId && !task.notifiedEmployeeIds.includes(task.ownerId)) task.notifiedEmployeeIds.push(task.ownerId)
      appendTaskEvent(state, task.id, 'task.reopened.v1', input.actorId, {
        ...eventPayload,
        previousOwnerId,
        ownerId: task.ownerId,
        reason: input.note || '客户反馈仍未解决',
        ...assignmentMetadata(nextAssignment),
      })
      break
    }
    case 'cancel':
      if (!['pending', 'accepted', 'escalated', 'reopened'].includes(task.status)) throw new Error('当前状态不能取消')
      task.status = 'cancelled'
      appendTaskEvent(state, task.id, 'task.cancelled.v1', input.actorId, { ...eventPayload, reason: input.note })
      break
  }

  task.updatedAt = now
  state.revision += 1
  return task
}

export function escalateDueTasks(state: RuntimeState, now = new Date()) {
  let changed = false
  for (const task of state.tasks) {
    if (!['pending', 'accepted', 'escalated', 'reopened'].includes(task.status)) continue
    const configuredServiceType = state.config.serviceTypes.find((item) => item.id === task.serviceTypeId)
    const serviceType = configuredServiceType && task.dispatchRoleIdsSnapshot?.length
      ? { ...configuredServiceType, dispatchRoleIds: task.dispatchRoleIdsSnapshot }
      : configuredServiceType
    if (!serviceType) continue

    const shouldManagerEscalate = task.escalationLevel < 2 && now >= new Date(task.managerAt)
    const shouldFirstEscalate = task.escalationLevel < 1 && now >= new Date(task.escalateAt)
    if (!shouldManagerEscalate && !shouldFirstEscalate) continue

    const previousOwnerId = task.ownerId
    let nextAssignment: DispatchDecision | null = null
    let level = 1
    if (shouldManagerEscalate) {
      const managerRoleIds = task.managerRoleIdsSnapshot?.length ? task.managerRoleIdsSnapshot : ['manager']
      const managerCandidates = state.employees.filter(
        (employee) =>
          effectiveRoleIdsForEmployee(state, employee.id).some((roleId) => managerRoleIds.includes(roleId))
          && employee.status === 'active' && employee.online && !employee.paused,
      ).map((employee, index) => ({ employee, source: 'manager' as const, sourceRank: index }))
      nextAssignment = rankDispatchCandidates(state, managerCandidates)[0] ?? null
      level = 2
    } else {
      nextAssignment = chooseAssignee(
        state,
        task.tableId,
        serviceType,
        previousOwnerId ? [previousOwnerId] : [],
        task.targetEmployeeIdsSnapshot ?? [],
      )
    }
    const nextOwner = nextAssignment?.employee ?? null

    if (nextOwner?.id === previousOwnerId && task.escalationLevel >= level) continue
    task.ownerId = nextOwner?.id ?? previousOwnerId
    task.status = 'escalated'
    task.escalationLevel = level
    task.updatedAt = now.toISOString()
    task.notifiedEmployeeIds = Array.from(
      new Set([...task.notifiedEmployeeIds, ...(task.ownerId ? [task.ownerId] : [])]),
    )
    appendTaskEvent(state, task.id, 'task.escalated.v1', 'system', {
      level,
      previousOwnerId,
      ownerId: task.ownerId,
      reason: shouldManagerEscalate ? 'manager_sla_exceeded' : 'response_sla_exceeded',
      ...assignmentMetadata(nextAssignment),
    })
    changed = true
  }
  if (changed) state.revision += 1
  return changed
}

/** Releases in-flight work when the employee's last online lease ends so coverage can continue. */
export function releaseTasksForOfflineEmployee(state: RuntimeState, employeeId: string, now = new Date()) {
  let changed = false
  for (const task of state.tasks) {
    if (task.ownerId !== employeeId || !['accepted', 'arrived'].includes(task.status)) continue
    const configuredServiceType = state.config.serviceTypes.find((item) => item.id === task.serviceTypeId)
    if (!configuredServiceType) continue
    const serviceType = task.dispatchRoleIdsSnapshot?.length
      ? { ...configuredServiceType, dispatchRoleIds: task.dispatchRoleIdsSnapshot }
      : configuredServiceType
    const nextAssignment = chooseAssignee(
      state,
      task.tableId,
      serviceType,
      [employeeId],
      task.targetEmployeeIdsSnapshot ?? [],
    )
    const nextOwner = nextAssignment?.employee ?? null
    task.status = 'reopened'
    task.ownerId = nextOwner?.id ?? null
    task.priority = task.priority === 'urgent' ? 'urgent' : 'high'
    task.escalationLevel = Math.max(1, task.escalationLevel)
    task.acceptedAt = null
    task.arrivedAt = null
    task.completedAt = null
    task.resolution = null
    const taskSla = task.slaSnapshot ?? serviceType.sla
    task.warningAt = isoAt(now, taskSla.warningSeconds)
    task.escalateAt = isoAt(now, taskSla.escalateSeconds)
    task.managerAt = isoAt(now, taskSla.managerSeconds)
    task.updatedAt = now.toISOString()
    if (task.ownerId && !task.notifiedEmployeeIds.includes(task.ownerId)) task.notifiedEmployeeIds.push(task.ownerId)
    appendTaskEvent(state, task.id, 'task.reopened.v1', 'system', {
      previousOwnerId: employeeId,
      ownerId: task.ownerId,
      reason: 'owner_offline',
      ...assignmentMetadata(nextAssignment),
    })
    changed = true
  }
  return changed
}

export function saveConfigDraft(state: RuntimeState, input: ConfigDraftInput, actorId: string) {
  const draft = structuredClone(state.config)
  draft.status = 'draft'
  draft.publishedAt = null
  draft.serviceTypes = draft.serviceTypes.map((serviceType) => {
    const update = input.serviceTypes.find((item) => item.id === serviceType.id)
    const { guestVisible: currentGuestVisible, ...serviceTypeWithoutGuestVisibility } = serviceType
    const guestVisible = update?.guestVisible ?? currentGuestVisible
    return update
      ? {
          ...serviceTypeWithoutGuestVisibility,
          ...(guestVisible === undefined ? {} : { guestVisible }),
          enabled: update.enabled,
          priority: update.priority,
          dispatchRoleIds: [...update.dispatchRoleIds],
          customerReply: update.customerReply,
          actionScript: [...update.actionScript],
          sla: { ...update.sla },
          workflowLevel: update.workflowLevel ?? serviceType.workflowLevel ?? 'L3',
          allowBackupDirectComplete: update.allowBackupDirectComplete
            ?? serviceType.allowBackupDirectComplete
            ?? false,
          allowCrossAreaComplete: update.allowCrossAreaComplete
            ?? serviceType.allowCrossAreaComplete
            ?? false,
          requiresCompletionNote: update.requiresCompletionNote
            ?? serviceType.requiresCompletionNote
            ?? false,
          duplicateSeconds: update.duplicateSeconds ?? serviceType.duplicateSeconds ?? 60,
        }
      : serviceType
  })
  const currentRoles = new Map(draft.roles.map((role) => [role.id, role]))
  draft.roles = input.roles.map((role) => withDefaultRolePolicy({
    id: role.id,
    name: role.name ?? currentRoles.get(role.id)?.name ?? role.id,
    maxConcurrentTasks: role.maxConcurrentTasks,
    canReceiveTasks: role.canReceiveTasks,
    permissionIds: role.permissionIds ?? currentRoles.get(role.id)?.permissionIds,
    dataScope: role.dataScope ?? currentRoles.get(role.id)?.dataScope,
    approvalLimits: role.approvalLimits ?? currentRoles.get(role.id)?.approvalLimits,
  }))
  draft.skills = structuredClone(input.skills ?? draft.skills)
  draft.workstations = structuredClone(input.workstations ?? draft.workstations)
  const roleIds = new Set(draft.roles.map((role) => role.id))
  const skillIds = new Set(draft.skills.map((skill) => skill.id))
  const deliveryServiceTypeIds = new Set(draft.serviceTypes.filter(
    (type) => type.enabled && type.code === 'FULFILLMENT_DELIVERY',
  ).map((type) => type.id))
  const workstationIds = new Set(draft.workstations.map((station) => station.id))
  if (skillIds.size !== draft.skills.length) throw new Error('技能配置ID不能重复')
  if (roleIds.size !== draft.roles.length) throw new Error('岗位配置ID不能重复')
  if (workstationIds.size !== draft.workstations.length) throw new Error('工作站配置ID不能重复')
  if (state.employees.some((employee) => !roleIds.has(employee.roleId))) throw new Error('不能删除仍有员工使用的岗位')
  if (state.shiftAssignments.some((shift) => !roleIds.has(shift.roleId))) throw new Error('不能删除仍有班次使用的岗位')
  for (const station of draft.workstations) {
    if (station.productionRoleIds.length === 0) throw new Error(`${station.name}至少需要一个出品岗位`)
    if (station.productionRoleIds.some((roleId) => !roleIds.has(roleId))) throw new Error(`${station.name}引用了不存在的出品岗位`)
    if (station.deliveryRoleIds.some((roleId) => !roleIds.has(roleId))) throw new Error(`${station.name}引用了不存在的取送岗位`)
    if (station.requiredSkillIds.some((skillId) => !skillIds.has(skillId))) throw new Error(`${station.name}引用了不存在的技能`)
    if (station.deliveryServiceTypeId && !deliveryServiceTypeIds.has(station.deliveryServiceTypeId)) {
      throw new Error(`${station.name}必须绑定已启用的专用取送任务类型`)
    }
    if (station.fallbackStationId === station.id || (station.fallbackStationId && !workstationIds.has(station.fallbackStationId))) {
      throw new Error(`${station.name}的候补工作站配置无效`)
    }
  }
  const proactiveServiceType = draft.serviceTypes.find(
    (serviceType) => serviceType.id === input.proactiveOrderCare.serviceTypeId && serviceType.enabled,
  )
  if (!proactiveServiceType) throw new Error('待点单提醒必须绑定已启用的服务类型')
  draft.proactiveOrderCare = { ...input.proactiveOrderCare }
  draft.guestServiceLimits = { ...input.guestServiceLimits }
  draft.communityBrand = structuredClone(input.communityBrand ?? draft.communityBrand)
  draft.assistantCapabilities = structuredClone(input.assistantCapabilities ?? draft.assistantCapabilities ?? [])
  draft.sopRules = structuredClone(input.sopRules ?? draft.sopRules ?? [])
  const sopRuleIds = new Set(draft.sopRules.map((rule) => rule.id))
  const serviceTypeIds = new Set(draft.serviceTypes.filter((serviceType) => serviceType.enabled).map((serviceType) => serviceType.id))
  const areaIds = new Set(state.areas.map((area) => area.id))
  const tableIds = new Set(state.tables.map((table) => table.id))
  const employeeIds = new Set(state.employees.filter((employee) => employee.status === 'active').map((employee) => employee.id))
  const productCategoryIds = new Set(state.products.map((product) => product.categoryId))
  if (sopRuleIds.size !== draft.sopRules.length) throw new Error('复杂SOP规则编号不能重复')
  for (const rule of draft.sopRules) {
    if (rule.scope.areaIds.some((areaId) => !areaIds.has(areaId))) throw new Error(`${rule.name}引用了不存在的区域`)
    if (rule.scope.tableIds.some((tableId) => !tableIds.has(tableId))) throw new Error(`${rule.name}引用了不存在的桌台`)
    if (rule.trigger.serviceTypeIds.some((serviceTypeId) => !serviceTypeIds.has(serviceTypeId))) throw new Error(`${rule.name}触发器引用了未启用的服务类型`)
    if (rule.trigger.productCategoryIds.some((categoryId) => !productCategoryIds.has(categoryId))) throw new Error(`${rule.name}触发器引用了不存在的商品品类`)
    if ((rule.trigger.workstationIds ?? []).some((workstationId) => !workstationIds.has(workstationId))) throw new Error(`${rule.name}触发器引用了不存在的工作站`)
    for (const step of rule.steps) {
      if (!serviceTypeIds.has(step.action.serviceTypeId)) throw new Error(`${rule.name}的步骤“${step.name}”引用了未启用的服务类型`)
      if (step.action.dispatchRoleIds.some((roleId) => !roleIds.has(roleId))) throw new Error(`${rule.name}的步骤“${step.name}”引用了不存在的岗位`)
      if ((step.action.dispatchEmployeeIds ?? []).some((employeeId) => !employeeIds.has(employeeId))) throw new Error(`${rule.name}的步骤“${step.name}”引用了不存在或停用的员工`)
      if ((step.action.dispatchEmployeeIds ?? []).some((employeeId) => (
        !effectiveRoleIdsForEmployee(state, employeeId).some((roleId) => step.action.dispatchRoleIds.includes(roleId))
      ))) throw new Error(`${rule.name}的步骤“${step.name}”指定员工不具备所选执行岗位`)
      if ((step.action.escalation?.managerRoleIds ?? []).some((roleId) => !roleIds.has(roleId))) throw new Error(`${rule.name}的步骤“${step.name}”经理接管岗位不存在`)
      if ((step.action.verification?.roleIds ?? []).some((roleId) => !roleIds.has(roleId))) throw new Error(`${rule.name}的步骤“${step.name}”验证岗位不存在`)
    }
  }
  state.draftConfig = draft
  state.auditEntries.push({
    id: `audit_${randomUUID()}`,
    actorId,
    action: 'config.draft_saved.v1',
    objectType: 'storeConfig',
    objectId: state.store.id,
    occurredAt: new Date().toISOString(),
    details: { basedOnVersion: state.config.version },
  })
  state.revision += 1
  return draft
}

export function publishConfig(state: RuntimeState, actorId: string) {
  if (!state.draftConfig) throw new Error('没有待发布草稿')
  const next = structuredClone(state.draftConfig)
  next.version = state.config.version + 1
  next.status = 'published'
  next.publishedAt = new Date().toISOString()
  state.config = next
  state.draftConfig = null
  state.auditEntries.push({
    id: `audit_${randomUUID()}`,
    actorId,
    action: 'config.published.v1',
    objectType: 'storeConfig',
    objectId: state.store.id,
    occurredAt: next.publishedAt,
    details: { version: next.version },
  })
  state.revision += 1
  return next
}

export function calculateMetrics(state: RuntimeState, now = new Date()): OperationsMetrics {
  const openTasks = state.tasks.filter(isOpenTask)
  return {
    occupiedTables: state.tables.filter((table) => table.status === 'occupied').length,
    openTasks: openTasks.length,
    atRiskTasks: openTasks.filter(
      (task) => now >= new Date(task.warningAt) && !['arrived', 'completed', 'confirmed'].includes(task.status),
    ).length,
    escalatedTasks: openTasks.filter((task) => task.escalationLevel > 0).length,
    complaints: openTasks.filter((task) => task.serviceTypeId === 'complaint').length,
  }
}
