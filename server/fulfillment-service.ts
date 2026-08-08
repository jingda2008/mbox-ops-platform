import { createHash } from 'node:crypto'
import type {
  RuntimeState,
  ServiceTask,
  TaskActionInput,
  TaskEvent,
} from '../src/shared/contracts.js'
import type {
  KdsDeliveryServiceTaskLink,
  KdsTask,
} from '../src/shared/order-contracts.js'
import {
  normalizeOrderFulfillmentState,
  resolveKdsWorkstation,
} from './fulfillment-workstations.js'
import { deliverKdsTask, pickUpKdsTask } from './order-domain.js'
import { effectiveRoleIdsForEmployee } from '../src/shared/staff-access.js'

const closedServiceTaskStatuses = new Set<ServiceTask['status']>(['completed', 'confirmed', 'cancelled'])

function activeTaskCount(state: RuntimeState, employeeId: string) {
  return state.tasks.filter((task) => task.ownerId === employeeId && !closedServiceTaskStatuses.has(task.status)).length
}

function canReceiveTask(state: RuntimeState, employeeId: string) {
  const employee = state.employees.find((item) => item.id === employeeId)
  if (!employee || employee.status !== 'active' || !employee.online || employee.paused) return false
  const roles = effectiveRoleIdsForEmployee(state, employeeId)
    .map((roleId) => state.config.roles.find((item) => item.id === roleId))
    .filter((role) => role?.canReceiveTasks)
  return roles.length > 0 && roles.some((role) => activeTaskCount(state, employeeId) < (role?.maxConcurrentTasks ?? 0))
}

function candidatesForRoles(state: RuntimeState, tableId: string, roleIds: readonly string[], stationId: string) {
  const table = state.tables.find((item) => item.id === tableId)
  const preferredIds = [table?.primaryEmployeeId, ...(table?.backupEmployeeIds ?? [])]
    .filter((employeeId): employeeId is string => Boolean(employeeId))
  const allIds = state.employees.map((employee) => employee.id)
  const employeeRank = new Map([...preferredIds, ...allIds].map((employeeId, index) => [employeeId, index]))
  const roleRank = new Map(roleIds.map((roleId, index) => [roleId, index]))
  return [...new Set([...preferredIds, ...allIds])]
    .filter((employeeId) => {
      const shift = state.shiftAssignments.find((assignment) => (
        assignment.employeeId === employeeId &&
        assignment.businessDate === state.store.businessDate &&
        assignment.status === 'active'
      ))
      const stationEligible = !shift?.stationIds?.length || shift.stationIds.includes(stationId)
      return stationEligible && effectiveRoleIdsForEmployee(state, employeeId).some((roleId) => roleIds.includes(roleId)) && canReceiveTask(state, employeeId)
    })
    .sort((left, right) => {
      const leftRoleRank = Math.min(...effectiveRoleIdsForEmployee(state, left).map((roleId) => roleRank.get(roleId) ?? Number.MAX_SAFE_INTEGER))
      const rightRoleRank = Math.min(...effectiveRoleIdsForEmployee(state, right).map((roleId) => roleRank.get(roleId) ?? Number.MAX_SAFE_INTEGER))
      return leftRoleRank - rightRoleRank ||
        activeTaskCount(state, left) - activeTaskCount(state, right) ||
        (employeeRank.get(left) ?? Number.MAX_SAFE_INTEGER) - (employeeRank.get(right) ?? Number.MAX_SAFE_INTEGER)
    })
}

function chooseDeliveryOwner(state: RuntimeState, tableId: string, deliveryRoleIds: string[], stationId: string) {
  return candidatesForRoles(state, tableId, deliveryRoleIds, stationId)[0]
    ?? null
}

function tableIdForSession(state: RuntimeState, tableSessionId: string) {
  const activeSession = state.songState.tableSessions.find((session) => session.id === tableSessionId)
  if (activeSession) return activeSession.tableId
  return state.tables.find((table) => (
    tableSessionId === table.id || tableSessionId.startsWith(`session:${table.id}:`)
  ))?.id ?? tableSessionId.replace(/^session:/, '').split(':')[0]!
}

function isoAfter(value: string, seconds: number) {
  return new Date(Date.parse(value) + seconds * 1000).toISOString()
}

export function fulfillmentServiceTaskId(kdsTaskId: string) {
  const digest = createHash('sha256').update(kdsTaskId).digest('hex').slice(0, 32)
  return `task:fulfillment:${digest}`
}

function triggerId(kdsTaskId: string) {
  return `fulfillment-delivery:${kdsTaskId}`
}

function linkServiceTask(task: KdsTask, serviceTask: ServiceTask): KdsDeliveryServiceTaskLink {
  const link: KdsDeliveryServiceTaskLink = {
    id: serviceTask.id,
    status: serviceTask.status,
    ownerId: serviceTask.ownerId,
    createdAt: serviceTask.createdAt,
  }
  task.deliveryServiceTask = link
  return link
}

export interface DeliveryServiceTaskResult {
  serviceTask: ServiceTask
  created: boolean
}

/** Creates exactly one delivery ServiceTask for a completed KDS task and repairs a missing link on replay. */
export function ensureDeliveryServiceTask(
  state: RuntimeState,
  kdsTask: KdsTask,
  occurredAt: string,
): DeliveryServiceTaskResult {
  normalizeOrderFulfillmentState(state.orderDomain)
  state.tasks ??= []
  state.taskEvents ??= []
  state.auditEntries ??= []
  if (!kdsTask.completedAt || !['completed', 'picked_up', 'delivered'].includes(kdsTask.status)) {
    throw new Error('只有已完成制作的KDS任务可以创建取送任务')
  }

  const workstation = resolveKdsWorkstation(state.orderDomain, kdsTask)
  const deliveryServiceTypeId = workstation.deliveryServiceTypeId ?? 'fulfillment-delivery'
  const configuredServiceType = state.config.serviceTypes.find((item) => item.id === deliveryServiceTypeId)
  if (configuredServiceType && (!configuredServiceType.enabled || configuredServiceType.code !== 'FULFILLMENT_DELIVERY')) {
    throw new Error(`工作站取送服务类型未启用：${deliveryServiceTypeId}`)
  }
  // Persisted stores created before FULFILLMENT_DELIVERY are allowed to finish in-flight orders.
  // The task still uses the dedicated ID and never falls back to ORDER_HELP.
  const serviceType = configuredServiceType ?? {
    priority: 'high' as const,
    customerReply: '{employee}正在取送您的商品。',
    actionScript: ['到工作站核对商品与数量', '确认桌号后取货', '送达桌台并确认摆放完成'],
    workflowLevel: 'L1' as const,
    allowBackupDirectComplete: true,
    allowCrossAreaComplete: true,
    requiresCompletionNote: false,
  }

  const expectedTriggerId = triggerId(kdsTask.id)
  const expectedId = fulfillmentServiceTaskId(kdsTask.id)
  const existing = state.tasks.find((task) => task.id === kdsTask.deliveryServiceTask?.id)
    ?? state.tasks.find((task) => task.triggerId === expectedTriggerId)
    ?? state.tasks.find((task) => task.id === expectedId)
  if (existing) {
    if (existing.triggerId !== expectedTriggerId || existing.serviceTypeId !== deliveryServiceTypeId) {
      throw new Error('KDS取送任务关联到不一致的服务任务')
    }
    linkServiceTask(kdsTask, existing)
    return { serviceTask: existing, created: false }
  }

  const tableId = tableIdForSession(state, kdsTask.tableSessionId)
  const ownerId = chooseDeliveryOwner(state, tableId, workstation.deliveryRoleIds, workstation.id)
  const pickupSeconds = kdsTask.pickupSla?.targetSeconds ?? workstation.pickupSlaSeconds
  const pickupDueAt = kdsTask.pickupSla?.dueAt ?? isoAfter(kdsTask.completedAt, pickupSeconds)
  kdsTask.pickupSla = { targetSeconds: pickupSeconds, dueAt: pickupDueAt }
  const warningSeconds = Math.max(1, Math.floor(pickupSeconds / 2))
  const owner = ownerId ? state.employees.find((employee) => employee.id === ownerId) : null
  const fulfillmentNote = kdsTask.fulfillmentNote?.trim()
  const serviceTask: ServiceTask = {
    id: expectedId,
    tableId,
    tableSessionId: kdsTask.tableSessionId,
    serviceTypeId: deliveryServiceTypeId,
    source: 'system',
    note: [
      `${workstation.name}取送：${kdsTask.itemName} x ${kdsTask.quantity}`,
      fulfillmentNote ? `【订单重点备注】${fulfillmentNote}` : '',
    ].filter(Boolean).join('；'),
    status: 'pending',
    priority: serviceType.priority,
    ownerId,
    notifiedEmployeeIds: ownerId ? [ownerId] : [],
    createdAt: occurredAt,
    updatedAt: occurredAt,
    acceptedAt: null,
    arrivedAt: null,
    completedAt: null,
    warningAt: isoAfter(kdsTask.completedAt, warningSeconds),
    escalateAt: pickupDueAt,
    managerAt: isoAfter(kdsTask.completedAt, pickupSeconds * 2),
    escalationLevel: 0,
    configVersion: workstation.configVersion,
    customerReply: owner
      ? serviceType.customerReply.replace('{employee}', owner.displayName)
      : serviceType.customerReply,
    actionScript: [...serviceType.actionScript],
    resolution: null,
    workflowLevel: serviceType.workflowLevel ?? 'L1',
    requestCount: 1,
    firstRequestedAt: occurredAt,
    lastRequestedAt: occurredAt,
    viewedEmployeeIds: [],
    completedBy: null,
    triggerId: expectedTriggerId,
    archivedAt: null,
    archiveOutcome: null,
    archivedFromStatus: null,
  }
  state.tasks.unshift(serviceTask)
  state.auditEntries.push({
    id: `audit:fulfillment:${kdsTask.id}`,
    actorId: 'system',
    action: 'service.requested.v1',
    objectType: 'serviceTask',
    objectId: serviceTask.id,
    occurredAt,
    details: {
      idempotencyKey: expectedTriggerId,
      kdsTaskId: kdsTask.id,
      orderId: kdsTask.orderId,
      workstationId: workstation.id,
      serviceTypeId: deliveryServiceTypeId,
      ownerId,
      configVersion: workstation.configVersion,
    },
  })
  state.taskEvents.push({
    id: `event:fulfillment:${kdsTask.id}:created`,
    taskId: serviceTask.id,
    type: 'task.created.v1',
    actorId: 'system',
    occurredAt,
    payload: {
      ownerId,
      tableId,
      kdsTaskId: kdsTask.id,
      workstationId: workstation.id,
      configVersion: workstation.configVersion,
    },
  })
  linkServiceTask(kdsTask, serviceTask)
  return { serviceTask, created: true }
}

export function syncDeliveryServiceTaskForKdsAction(
  state: RuntimeState,
  kdsTask: KdsTask,
  action: 'pickUp' | 'deliver',
  actorId: string,
  occurredAt: string,
  idempotencyKey: string,
) {
  const serviceTask = state.tasks.find((task) => task.id === kdsTask.deliveryServiceTask?.id)
    ?? state.tasks.find((task) => task.triggerId === triggerId(kdsTask.id))
  if (!serviceTask) throw new Error('KDS任务缺少关联取送服务任务')
  const eventId = `event:fulfillment:${kdsTask.id}:${action}:${idempotencyKey}`
  if (state.taskEvents.some((event) => event.id === eventId)) {
    linkServiceTask(kdsTask, serviceTask)
    return serviceTask
  }

  if (action === 'pickUp') {
    if (['pending', 'escalated', 'reopened'].includes(serviceTask.status)) {
      serviceTask.status = 'accepted'
      serviceTask.acceptedAt = occurredAt
    }
  } else if (!['completed', 'confirmed'].includes(serviceTask.status)) {
    serviceTask.acceptedAt ??= occurredAt
    serviceTask.arrivedAt ??= occurredAt
    serviceTask.completedAt = occurredAt
    serviceTask.completedBy = actorId
    serviceTask.viewedEmployeeIds = [...new Set([...(serviceTask.viewedEmployeeIds ?? []), actorId])]
    serviceTask.status = 'completed'
    serviceTask.resolution = '商品已送达桌台，待确认'
  }
  serviceTask.updatedAt = occurredAt
  const event: TaskEvent = {
    id: eventId,
    taskId: serviceTask.id,
    type: action === 'pickUp' ? 'fulfillment.picked_up.v1' : 'fulfillment.delivered.v1',
    actorId,
    occurredAt,
    payload: { idempotencyKey, action, kdsTaskId: kdsTask.id },
  }
  state.taskEvents.push(event)
  linkServiceTask(kdsTask, serviceTask)
  return serviceTask
}

/**
 * Bridges the generic task queue back into KDS after applyTaskAction succeeds.
 * Call this in the same repository mutation immediately after the ServiceTask action.
 */
export function syncKdsFromFulfillmentServiceTaskAction(
  state: RuntimeState,
  serviceTask: ServiceTask,
  input: TaskActionInput,
  auditContext: { requestId?: string; effectiveRoleId?: string } = {},
): KdsTask | null {
  const prefix = 'fulfillment-delivery:'
  if (!serviceTask.triggerId?.startsWith(prefix) || !['arrive', 'complete', 'quick_complete'].includes(input.action)) return null

  normalizeOrderFulfillmentState(state.orderDomain)
  const kdsTaskId = serviceTask.triggerId.slice(prefix.length)
  const kdsTask = state.orderDomain.kdsTasks.find((task) => task.id === kdsTaskId)
  if (!kdsTask) throw new Error('取送服务任务关联的KDS任务不存在')
  if (kdsTask.deliveryServiceTask?.id && kdsTask.deliveryServiceTask.id !== serviceTask.id) {
    throw new Error('取送服务任务与KDS任务关联不一致')
  }
  if (serviceTask.serviceTypeId !== (kdsTask.workstation?.deliveryServiceTypeId ?? 'fulfillment-delivery')) {
    throw new Error('取送服务任务类型与KDS工作站不一致')
  }

  if (input.action === 'arrive') {
    if (kdsTask.status === 'completed') {
      if (!serviceTask.arrivedAt) throw new Error('取送服务任务缺少到达时间')
      pickUpKdsTask(state.orderDomain, {
        taskId: kdsTask.id,
        actorId: input.actorId,
        occurredAt: serviceTask.arrivedAt,
        idempotencyKey: `fulfillment-service:${serviceTask.id}:${input.idempotencyKey}:pick-up`,
      })
    } else if (!['picked_up', 'delivered'].includes(kdsTask.status)) {
      throw new Error(`取送任务确认取货前KDS必须完成制作，当前状态：${kdsTask.status}`)
    }
  } else if (input.action === 'quick_complete') {
    if (!serviceTask.completedAt) throw new Error('取送服务任务缺少完成时间')
    if (kdsTask.status === 'completed') {
      pickUpKdsTask(state.orderDomain, {
        taskId: kdsTask.id,
        actorId: input.actorId,
        occurredAt: serviceTask.completedAt,
        idempotencyKey: `fulfillment-service:${serviceTask.id}:${input.idempotencyKey}:quick-pick-up`,
      })
    }
    if (kdsTask.status === 'picked_up') {
      deliverKdsTask(state.orderDomain, {
        taskId: kdsTask.id,
        actorId: input.actorId,
        occurredAt: serviceTask.completedAt,
        idempotencyKey: `fulfillment-service:${serviceTask.id}:${input.idempotencyKey}:quick-deliver`,
      })
    } else if (kdsTask.status !== 'delivered') {
      throw new Error(`快速送达前KDS必须已完成出品，当前状态：${kdsTask.status}`)
    }
    const semanticDeliveryKey = `${kdsTask.id}:pickup_and_delivery`
    const atomicEventId = `task_event_atomic_delivery_${createHash('sha256').update(semanticDeliveryKey).digest('hex').slice(0, 24)}`
    if (!state.taskEvents.some((event) => event.id === atomicEventId)) {
      state.taskEvents.push({
        id: atomicEventId,
        taskId: serviceTask.id,
        type: 'fulfillment.atomic_pickup_delivery.v1',
        actorId: input.actorId,
        occurredAt: serviceTask.completedAt,
        payload: {
          idempotencyKey: input.idempotencyKey,
          kdsTaskId: kdsTask.id,
          transition: 'pickup_and_delivery',
          pickupEvidence: 'system_inferred_from_one_tap_delivery',
          deliveryEvidence: 'employee_confirmed',
        },
      })
      state.auditEntries.push({
        id: `audit_atomic_delivery_${createHash('sha256').update(semanticDeliveryKey).digest('hex').slice(0, 24)}`,
        actorId: input.actorId,
        action: 'fulfillment.atomic_pickup_delivery.v1',
        objectType: 'kdsTask',
        objectId: kdsTask.id,
        occurredAt: serviceTask.completedAt,
        details: {
          serviceTaskId: serviceTask.id,
          orderId: kdsTask.orderId,
          orderItemId: kdsTask.orderItemId,
          tableSessionId: kdsTask.tableSessionId,
          stationId: kdsTask.stationId,
          workstationName: kdsTask.workstation?.name ?? kdsTask.stationId,
          workstationConfigVersion: kdsTask.workstation?.configVersion ?? null,
          transition: 'pickup_and_delivery',
          actionStage: 'delivery',
          effectiveRoleId: auditContext.effectiveRoleId
            ?? state.employees.find((employee) => employee.id === input.actorId)?.roleId
            ?? null,
          requestId: auditContext.requestId ?? null,
          pickupEvidence: 'system_inferred_from_one_tap_delivery',
          deliveryEvidence: 'employee_confirmed',
          idempotencyKey: input.idempotencyKey,
        },
      })
    }
  } else if (kdsTask.status === 'picked_up') {
    if (!serviceTask.completedAt) throw new Error('取送服务任务缺少完成时间')
    deliverKdsTask(state.orderDomain, {
      taskId: kdsTask.id,
      actorId: input.actorId,
      occurredAt: serviceTask.completedAt,
      idempotencyKey: `fulfillment-service:${serviceTask.id}:${input.idempotencyKey}:deliver`,
    })
  } else if (kdsTask.status !== 'delivered') {
    throw new Error(`取送任务完成送达前KDS必须先确认取货，当前状态：${kdsTask.status}`)
  }

  linkServiceTask(kdsTask, serviceTask)
  return kdsTask
}
