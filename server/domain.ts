import { randomUUID } from 'node:crypto'
import type {
  ConfigDraftInput,
  CreateTaskInput,
  Employee,
  OperationsMetrics,
  RuntimeState,
  ServiceTask,
  ServiceTypeConfig,
  TaskActionInput,
  TaskEvent,
} from '../src/shared/contracts.js'
import { withDefaultRolePolicy } from '../src/shared/role-policy.js'

const closedStatuses = new Set(['confirmed', 'cancelled'])

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

export function isOpenTask(task: ServiceTask) {
  return !closedStatuses.has(task.status)
}

export function employeeLoad(state: RuntimeState, employeeId: string) {
  return state.tasks.filter((task) => task.ownerId === employeeId && isOpenTask(task)).length
}

function roleLimit(state: RuntimeState, employee: Employee) {
  return state.config.roles.find((role) => role.id === effectiveRoleId(state, employee))
}

function effectiveRoleId(state: RuntimeState, employee: Employee) {
  return state.shiftAssignments.find(
    (shift) =>
      shift.employeeId === employee.id &&
      shift.businessDate === state.store.businessDate &&
      shift.status === 'active',
  )?.roleId ?? employee.roleId
}

function chooseAssignee(
  state: RuntimeState,
  tableId: string,
  serviceType: ServiceTypeConfig,
  excludedEmployeeIds: string[] = [],
) {
  const table = state.tables.find((item) => item.id === tableId)
  if (!table) return null

  const candidateIds = [
    table.primaryEmployeeId,
    ...table.backupEmployeeIds,
    ...serviceType.dispatchRoleIds.flatMap((roleId) =>
      state.employees.filter((employee) => effectiveRoleId(state, employee) === roleId).map((employee) => employee.id),
    ),
  ]

  const seen = new Set<string>()
  for (const employeeId of candidateIds) {
    if (seen.has(employeeId) || excludedEmployeeIds.includes(employeeId)) continue
    seen.add(employeeId)
    const employee = state.employees.find((item) => item.id === employeeId)
    if (!employee || employee.status !== 'active' || !employee.online || employee.paused) continue
    if (!serviceType.dispatchRoleIds.includes(effectiveRoleId(state, employee))) continue
    const role = roleLimit(state, employee)
    if (!role?.canReceiveTasks || employeeLoad(state, employee.id) >= role.maxConcurrentTasks) continue
    return employee
  }

  return (
    state.employees.find(
      (employee) =>
        effectiveRoleId(state, employee) === 'manager' &&
        employee.status === 'active' &&
        employee.online &&
        !employee.paused,
    ) ?? null
  )
}

export function createServiceTask(state: RuntimeState, input: CreateTaskInput & { triggerId?: string; requestedBy?: string }) {
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

  const serviceType = state.config.serviceTypes.find((item) => item.id === input.serviceTypeId && item.enabled)
  if (!serviceType) throw new Error('服务类型未启用')

  const now = new Date()
  const assignee = chooseAssignee(state, table.id, serviceType)
  const customerReply = serviceType.customerReply.replace('{employee}', assignee?.displayName ?? '服务团队')
  const task: ServiceTask = {
    id: `task_${randomUUID()}`,
    tableId: table.id,
    serviceTypeId: serviceType.id,
    source: input.source,
    note: input.note,
    status: 'pending',
    priority: serviceType.priority,
    ownerId: assignee?.id ?? null,
    notifiedEmployeeIds: [assignee?.id, table.primaryEmployeeId].filter((value): value is string => Boolean(value)),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    acceptedAt: null,
    arrivedAt: null,
    completedAt: null,
    warningAt: isoAt(now, serviceType.sla.warningSeconds),
    escalateAt: isoAt(now, serviceType.sla.escalateSeconds),
    managerAt: isoAt(now, serviceType.sla.managerSeconds),
    escalationLevel: 0,
    configVersion: state.config.version,
    customerReply,
    actionScript: [...serviceType.actionScript],
    resolution: null,
    triggerId: 'triggerId' in input && typeof input.triggerId === 'string' ? input.triggerId : null,
  }
  state.tasks.unshift(task)
  state.auditEntries.push({
    id: `audit_${randomUUID()}`,
    actorId: input.requestedBy ?? input.source,
    action: 'service.requested.v1',
    objectType: 'serviceTask',
    objectId: task.id,
    occurredAt: now.toISOString(),
    details: { idempotencyKey: input.idempotencyKey, tableCode: table.code, configVersion: state.config.version },
  })
  appendTaskEvent(state, task.id, 'task.created.v1', 'system', {
    ownerId: task.ownerId,
    tableId: table.id,
    configVersion: task.configVersion,
  })
  state.revision += 1
  return task
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
      assertActor(task, input.actorId)
      if (!['pending', 'escalated', 'reopened'].includes(task.status)) throw new Error('当前状态不能接单')
      task.status = 'accepted'
      task.acceptedAt = now
      appendTaskEvent(state, task.id, 'task.accepted.v1', input.actorId, eventPayload)
      break
    case 'arrive':
      assertActor(task, input.actorId)
      if (task.status !== 'accepted') throw new Error('必须先接单')
      task.status = 'arrived'
      task.arrivedAt = now
      appendTaskEvent(state, task.id, 'task.arrived.v1', input.actorId, eventPayload)
      break
    case 'complete':
      assertActor(task, input.actorId)
      if (task.status !== 'arrived') throw new Error('必须先确认到桌')
      task.status = 'completed'
      task.completedAt = now
      task.resolution = input.note || '员工确认完成'
      appendTaskEvent(state, task.id, 'task.completed.v1', input.actorId, { ...eventPayload, resolution: task.resolution })
      break
    case 'confirm':
      if (!input.actorId.startsWith('guest-')) throw new Error('仅客人可以确认服务已经解决')
      if (task.status !== 'completed') throw new Error('任务尚未完成')
      task.status = 'confirmed'
      appendTaskEvent(state, task.id, 'service.confirmed.v1', input.actorId, eventPayload)
      break
    case 'unresolved': {
      if (!input.actorId.startsWith('guest-')) throw new Error('仅客人可以反馈服务仍未解决')
      if (task.status !== 'completed') throw new Error('任务尚未完成')
      const previousOwnerId = task.ownerId
      const serviceType = state.config.serviceTypes.find((item) => item.id === task.serviceTypeId)
      if (!serviceType) throw new Error('服务类型配置不存在')
      const nextOwner = chooseAssignee(state, task.tableId, serviceType, previousOwnerId ? [previousOwnerId] : [])
      task.status = 'reopened'
      task.priority = task.priority === 'urgent' ? 'urgent' : 'high'
      task.ownerId = nextOwner?.id ?? previousOwnerId
      task.escalationLevel = Math.max(task.escalationLevel, 1)
      const reopenedAt = new Date(now)
      task.warningAt = isoAt(reopenedAt, serviceType.sla.warningSeconds)
      task.escalateAt = isoAt(reopenedAt, serviceType.sla.escalateSeconds)
      task.managerAt = isoAt(reopenedAt, serviceType.sla.managerSeconds)
      task.acceptedAt = null
      task.arrivedAt = null
      task.completedAt = null
      task.resolution = null
      if (task.ownerId && !task.notifiedEmployeeIds.includes(task.ownerId)) task.notifiedEmployeeIds.push(task.ownerId)
      appendTaskEvent(state, task.id, 'task.reopened.v1', input.actorId, {
        ...eventPayload,
        previousOwnerId,
        ownerId: task.ownerId,
        reason: input.note || '客户反馈仍未解决',
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
    const serviceType = state.config.serviceTypes.find((item) => item.id === task.serviceTypeId)
    if (!serviceType) continue

    const shouldManagerEscalate = task.escalationLevel < 2 && now >= new Date(task.managerAt)
    const shouldFirstEscalate = task.escalationLevel < 1 && now >= new Date(task.escalateAt)
    if (!shouldManagerEscalate && !shouldFirstEscalate) continue

    const previousOwnerId = task.ownerId
    let nextOwner: Employee | null = null
    let level = 1
    if (shouldManagerEscalate) {
      nextOwner = state.employees.find(
        (employee) =>
          effectiveRoleId(state, employee) === 'manager' && employee.status === 'active' && employee.online,
      ) ?? null
      level = 2
    } else {
      nextOwner = chooseAssignee(state, task.tableId, serviceType, previousOwnerId ? [previousOwnerId] : [])
    }

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
    })
    changed = true
  }
  if (changed) state.revision += 1
  return changed
}

export function saveConfigDraft(state: RuntimeState, input: ConfigDraftInput, actorId: string) {
  const draft = structuredClone(state.config)
  draft.status = 'draft'
  draft.publishedAt = null
  draft.serviceTypes = draft.serviceTypes.map((serviceType) => {
    const update = input.serviceTypes.find((item) => item.id === serviceType.id)
    return update
      ? {
          ...serviceType,
          enabled: update.enabled,
          guestVisible: update.guestVisible ?? serviceType.guestVisible,
          priority: update.priority,
          dispatchRoleIds: [...update.dispatchRoleIds],
          customerReply: update.customerReply,
          actionScript: [...update.actionScript],
          sla: { ...update.sla },
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
