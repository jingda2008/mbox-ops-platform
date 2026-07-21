import { createHash, randomUUID } from 'node:crypto'
import type { RuntimeState, ServiceTask } from '../src/shared/contracts.js'
import type {
  SopActionRecord,
  SopActionRecordType,
  SopCondition,
  SopExecution,
  SopRule,
  SopStep,
  SopStepExecution,
  SopStopCondition,
  SopTriggerEvent,
} from '../src/shared/sop-contracts.js'
import { effectiveRoleIdsForEmployee } from '../src/shared/staff-access.js'
import { createServiceTask, employeeLoad } from './domain.js'

interface TriggerOccurrence {
  id: string
  event: SopTriggerEvent
  occurredAt: string
  tableSessionId: string
  tableId: string
  context: {
    serviceTaskId: string | null
    kdsTaskId: string | null
    orderId: string | null
  }
}

const completedTaskStatuses = new Set<ServiceTask['status']>(['completed', 'confirmed'])
const openTaskStatuses = new Set<ServiceTask['status']>(['pending', 'accepted', 'arrived', 'reopened', 'escalated'])
const terminalStepOutcomes = new Set<SopStepExecution['outcome']>(['completed', 'cancelled', 'blocked', 'skipped', 'failed'])
const failedStepOutcomes = new Set<SopStepExecution['outcome']>(['cancelled', 'blocked', 'failed'])

function deterministicExecutionId(ruleId: string, occurrenceId: string) {
  return `sop_execution_${createHash('sha256').update(`${ruleId}:${occurrenceId}`).digest('hex').slice(0, 32)}`
}

function deterministicActionRecordId(executionId: string, stepId: string, type: SopActionRecordType) {
  return `sop_action_${createHash('sha256').update(`${executionId}:${stepId}:${type}`).digest('hex').slice(0, 32)}`
}

function dateMs(value: string) {
  const result = Date.parse(value)
  if (!Number.isFinite(result)) throw new Error(`SOP时间无效：${value}`)
  return result
}

function openSession(state: RuntimeState, tableSessionId: string) {
  return state.songState.tableSessions.find((session) => session.id === tableSessionId && session.status === 'open') ?? null
}

function occurrenceMatchesScope(state: RuntimeState, rule: SopRule, occurrence: TriggerOccurrence) {
  const table = state.tables.find((candidate) => candidate.id === occurrence.tableId)
  if (!table) return false
  if (rule.scope.tableIds.length > 0 && !rule.scope.tableIds.includes(table.id)) return false
  if (rule.scope.areaIds.length > 0 && !rule.scope.areaIds.includes(table.areaId)) return false
  return true
}

function orderHasConfiguredCategory(state: RuntimeState, orderId: string, categoryIds: string[]) {
  if (categoryIds.length === 0) return true
  const order = state.orderDomain.orders.find((candidate) => candidate.id === orderId)
  return Boolean(order?.items.some((item) => {
    const product = state.products.find((candidate) => candidate.id === item.skuId)
    return product?.categoryId && categoryIds.includes(product.categoryId)
  }))
}

function emptyContext(): TriggerOccurrence['context'] {
  return { serviceTaskId: null, kdsTaskId: null, orderId: null }
}

function serviceTypeCode(state: RuntimeState, task: ServiceTask) {
  return state.config.serviceTypes.find((serviceType) => serviceType.id === task.serviceTypeId)?.code ?? ''
}

function serviceTaskOccurrences(state: RuntimeState, rule: SopRule) {
  return state.tasks
    .filter((task) => task.tableSessionId && openSession(state, task.tableSessionId))
    .filter((task) => !task.triggerId?.startsWith('sop_execution_'))
    .filter((task) => {
      const code = serviceTypeCode(state, task)
      if (rule.trigger.event === 'complaint_requested') return code === 'COMPLAINT'
      if (rule.trigger.event === 'birthday_requested') return code === 'BIRTHDAY_CARE'
      if (rule.trigger.event === 'guest_mood_selected') {
        return task.source === 'guest' && /^客户心情(?:反馈|更新)：/.test(task.note)
      }
      return rule.trigger.serviceTypeIds.length === 0 || rule.trigger.serviceTypeIds.includes(task.serviceTypeId)
    })
    .map((task): TriggerOccurrence => ({
      id: task.id,
      event: rule.trigger.event,
      occurredAt: task.createdAt,
      tableSessionId: task.tableSessionId!,
      tableId: task.tableId,
      context: { serviceTaskId: task.id, kdsTaskId: null, orderId: null },
    }))
}

function fulfillmentOccurrences(state: RuntimeState, rule: SopRule) {
  const stationIds = rule.trigger.workstationIds ?? []
  return state.orderDomain.kdsTasks
    .filter((task) => stationIds.length === 0 || stationIds.includes(task.stationId))
    .filter((task) => openSession(state, task.tableSessionId))
    .flatMap((task): TriggerOccurrence[] => {
      const timestamp = rule.trigger.event === 'fulfillment_started'
        ? task.startedAt
        : rule.trigger.event === 'fulfillment_completed'
          ? task.completedAt
          : task.deliveredAt
      if (!timestamp) return []
      return [{
        id: `${task.id}:${rule.trigger.event}`,
        event: rule.trigger.event,
        occurredAt: timestamp,
        tableSessionId: task.tableSessionId,
        tableId: openSession(state, task.tableSessionId)!.tableId,
        context: { serviceTaskId: null, kdsTaskId: task.id, orderId: task.orderId },
      }]
    })
}

function triggerOccurrences(state: RuntimeState, rule: SopRule): TriggerOccurrence[] {
  if (rule.trigger.event === 'table_opened') {
    return state.songState.tableSessions
      .filter((session) => session.status === 'open')
      .map((session) => ({
        id: session.id,
        event: 'table_opened',
        occurredAt: session.openedAt,
        tableSessionId: session.id,
        tableId: session.tableId,
        context: emptyContext(),
      }))
  }
  if (rule.trigger.event === 'order_submitted') {
    return state.orderDomain.orders
      .filter((order) => order.submittedAt && openSession(state, order.tableSessionId))
      .filter((order) => orderHasConfiguredCategory(state, order.id, rule.trigger.productCategoryIds))
      .map((order) => ({
        id: order.id,
        event: 'order_submitted',
        occurredAt: order.submittedAt!,
        tableSessionId: order.tableSessionId,
        tableId: openSession(state, order.tableSessionId)!.tableId,
        context: { ...emptyContext(), orderId: order.id },
      }))
  }
  if (rule.trigger.event === 'payment_succeeded') {
    return state.paymentDomain.paymentIntents
      .filter((payment) => payment.status === 'succeeded' && payment.paidAt && openSession(state, payment.tableSessionId))
      .map((payment) => ({
        id: payment.id,
        event: 'payment_succeeded',
        occurredAt: payment.paidAt!,
        tableSessionId: payment.tableSessionId,
        tableId: openSession(state, payment.tableSessionId)!.tableId,
        context: emptyContext(),
      }))
  }
  if (rule.trigger.event.startsWith('fulfillment_')) return fulfillmentOccurrences(state, rule)
  return serviceTaskOccurrences(state, rule)
}

function conditionMatches(state: RuntimeState, occurrence: TriggerOccurrence, condition: SopCondition) {
  if (condition.type === 'no_order') {
    return !state.orderDomain.orders.some((order) => order.tableSessionId === occurrence.tableSessionId && order.submittedAt)
  }
  if (condition.type === 'no_payment') {
    return !state.paymentDomain.paymentIntents.some((payment) => (
      payment.tableSessionId === occurrence.tableSessionId && payment.status === 'succeeded'
    ))
  }
  if (condition.type === 'minimum_session_spend') {
    const latestLedgerEntry = state.orderDomain.tableLedgerEntries
      .filter((entry) => entry.tableSessionId === occurrence.tableSessionId)
      .toSorted((left, right) => right.sequence - left.sequence)[0]
    return (latestLedgerEntry?.balanceAfter ?? 0) >= (condition.value ?? 1)
  }
  if (condition.type === 'open_task_count_at_least') {
    return state.tasks.filter((task) => (
      task.tableSessionId === occurrence.tableSessionId && openTaskStatuses.has(task.status)
    )).length >= (condition.value ?? 1)
  }
  if (condition.type === 'primary_employee_busy') {
    const table = state.tables.find((candidate) => candidate.id === occurrence.tableId)
    const employee = table ? state.employees.find((candidate) => candidate.id === table.primaryEmployeeId) : null
    if (!employee) return false
    const limits = effectiveRoleIdsForEmployee(state, employee.id)
      .map((roleId) => state.config.roles.find((role) => role.id === roleId))
      .filter((role) => role?.canReceiveTasks)
      .map((role) => role!.maxConcurrentTasks)
    return limits.length > 0 && employeeLoad(state, employee.id) >= Math.max(...limits)
  }
  if (condition.type === 'fulfillment_not_completed') {
    return state.orderDomain.kdsTasks.some((task) => (
      task.tableSessionId === occurrence.tableSessionId && !['completed', 'picked_up', 'delivered'].includes(task.status)
    ))
  }
  if (condition.type === 'fulfillment_not_delivered') {
    return state.orderDomain.kdsTasks.some((task) => (
      task.tableSessionId === occurrence.tableSessionId && task.status !== 'delivered'
    ))
  }
  const table = state.tables.find((candidate) => candidate.id === occurrence.tableId)
  return Boolean(table && table.guestCount >= (condition.value ?? 1))
}

function stopReason(state: RuntimeState, execution: SopExecution, stopConditions: SopStopCondition[]) {
  if (!openSession(state, execution.tableSessionId)) return 'table_closed'
  const anchorMs = dateMs(execution.anchorAt)
  if (stopConditions.includes('order_submitted') && state.orderDomain.orders.some((order) => (
    order.tableSessionId === execution.tableSessionId
    && order.submittedAt
    && dateMs(order.submittedAt) >= anchorMs
  ))) return 'order_submitted'
  if (stopConditions.includes('payment_succeeded') && state.paymentDomain.paymentIntents.some((payment) => (
    payment.tableSessionId === execution.tableSessionId
    && payment.status === 'succeeded'
    && payment.paidAt
    && dateMs(payment.paidAt) >= anchorMs
  ))) return 'payment_succeeded'
  if (stopConditions.includes('fulfillment_delivered')) {
    const specificTask = execution.context?.kdsTaskId
      ? state.orderDomain.kdsTasks.find((task) => task.id === execution.context?.kdsTaskId)
      : null
    if (specificTask?.deliveredAt && dateMs(specificTask.deliveredAt) >= anchorMs) return 'fulfillment_delivered'
    if (!specificTask && state.orderDomain.kdsTasks.some((task) => (
      task.tableSessionId === execution.tableSessionId
      && task.deliveredAt
      && dateMs(task.deliveredAt) >= anchorMs
    ))) return 'fulfillment_delivered'
  }
  return null
}

function taskOutcome(state: RuntimeState, definition: SopStep, task: ServiceTask | undefined): SopStepExecution['outcome'] {
  if (!task) return 'blocked'
  if (task.status === 'cancelled') return 'cancelled'
  if (!completedTaskStatuses.has(task.status)) return 'task_created'
  const verification = definition.action.verification
  if (verification?.type === 'completed_by_role') {
    const completionEvent = state.taskEvents.findLast((event) => (
      event.taskId === task.id && event.type === 'task.completed.v1'
    ))
    if (!completionEvent || !effectiveRoleIdsForEmployee(state, completionEvent.actorId)
      .some((roleId) => verification.roleIds.includes(roleId))) return 'blocked'
  }
  if (verification && (
    verification.type === 'manager_review'
    || verification.type === 'table_qr_scan'
    || verification.type === 'camera_snapshot'
  )) {
    const record = (state.sopActionRecords ?? []).find((candidate) => (
      candidate.taskId === task.id && candidate.type === verification.type
    ))
    if (!record || ['failed', 'rejected', 'unconfigured'].includes(record.status)) return 'blocked'
    if (record.status !== 'completed') return 'task_created'
  }
  return 'completed'
}

function refreshStepOutcomes(state: RuntimeState, execution: SopExecution) {
  let changed = false
  for (const [index, step] of execution.steps.entries()) {
    if (!step.taskId) continue
    const definition = execution.ruleSnapshot.steps[index]
    if (!definition) continue
    const next = taskOutcome(state, definition, state.tasks.find((task) => task.id === step.taskId))
    if (next !== step.outcome) {
      step.outcome = next
      changed = true
    }
  }
  return changed
}

function stepDefinition(execution: SopExecution, stepId: string) {
  return execution.ruleSnapshot.steps.find((step) => step.id === stepId) ?? null
}

function stepExecution(execution: SopExecution, stepId: string) {
  return execution.steps.find((step) => step.stepId === stepId) ?? null
}

function stepFinishedAt(state: RuntimeState, execution: SopExecution, step: SopStepExecution) {
  const task = step.taskId ? state.tasks.find((candidate) => candidate.id === step.taskId) : null
  const evidenceTimes = (state.sopActionRecords ?? [])
    .filter((record) => (step.actionRecordIds ?? []).includes(record.id) && record.completedAt)
    .map((record) => dateMs(record.completedAt!))
  const candidates = [
    task?.completedAt ? dateMs(task.completedAt) : null,
    step.failureHandledAt ? dateMs(step.failureHandledAt) : null,
    step.triggeredAt ? dateMs(step.triggeredAt) : null,
    step.scheduledAt ? dateMs(step.scheduledAt) : null,
    ...evidenceTimes,
  ].filter((value): value is number => value !== null)
  return candidates.length > 0 ? Math.max(...candidates) : dateMs(execution.updatedAt)
}

function dependencySucceeded(execution: SopExecution, dependency: SopStepExecution) {
  if (dependency.outcome === 'completed' || dependency.outcome === 'skipped') return true
  if (!failedStepOutcomes.has(dependency.outcome)) return false
  const definition = stepDefinition(execution, dependency.stepId)
  if (definition?.routing?.onFailure === 'continue') return true
  if (definition?.routing?.onFailure === 'run_compensation' && definition.routing.compensationStepId) {
    return stepExecution(execution, definition.routing.compensationStepId)?.outcome === 'completed'
  }
  return false
}

function compensationActivated(execution: SopExecution, compensationStepId: string) {
  return execution.ruleSnapshot.steps.some((candidate) => (
    candidate.routing?.onFailure === 'run_compensation'
    && candidate.routing.compensationStepId === compensationStepId
    && failedStepOutcomes.has(stepExecution(execution, candidate.id)?.outcome ?? 'waiting')
  ))
}

function compensationSourceSteps(execution: SopExecution, compensationStepId: string) {
  return execution.ruleSnapshot.steps
    .filter((candidate) => (
      candidate.routing?.onFailure === 'run_compensation'
      && candidate.routing.compensationStepId === compensationStepId
    ))
    .map((candidate) => stepExecution(execution, candidate.id))
    .filter((candidate): candidate is SopStepExecution => Boolean(candidate && failedStepOutcomes.has(candidate.outcome)))
}

function explicitDependenciesReady(state: RuntimeState, execution: SopExecution, step: SopStep) {
  const dependencies = (step.routing?.dependsOnStepIds ?? [])
    .map((stepId) => stepExecution(execution, stepId))
    .filter((candidate): candidate is SopStepExecution => Boolean(candidate))
  if (dependencies.length === 0) return { ready: true, readyAt: dateMs(execution.anchorAt) }
  const succeeded = dependencies.filter((dependency) => dependencySucceeded(execution, dependency))
  const ready = step.routing?.dependencyMode === 'any'
    ? succeeded.length > 0
    : succeeded.length === dependencies.length
  if (!ready) return { ready: false, readyAt: null }
  const relevant = step.routing?.dependencyMode === 'any' ? succeeded : dependencies
  return {
    ready: true,
    readyAt: Math.max(...relevant.map((dependency) => stepFinishedAt(state, execution, dependency))),
  }
}

function scheduledAt(state: RuntimeState, execution: SopExecution, step: SopStep, stepIndex: number) {
  if (step.routing) {
    if (step.routing.compensationOnly && !compensationActivated(execution, step.id)) return null
    const dependencies = explicitDependenciesReady(state, execution, step)
    if (!dependencies.ready || dependencies.readyAt === null) return null
    const compensationReadyAt = step.routing.compensationOnly
      ? Math.max(...compensationSourceSteps(execution, step.id).map((source) => stepFinishedAt(state, execution, source)))
      : dependencies.readyAt
    return new Date(Math.max(dependencies.readyAt, compensationReadyAt) + step.delaySeconds * 1000).toISOString()
  }
  if (step.timing === 'after_trigger') {
    return new Date(dateMs(execution.anchorAt) + step.delaySeconds * 1000).toISOString()
  }
  const previous = execution.steps[stepIndex - 1]
  if (!previous?.taskId || previous.outcome !== 'completed') return null
  const task = state.tasks.find((candidate) => candidate.id === previous.taskId)
  if (!task?.completedAt || !completedTaskStatuses.has(task.status)) return null
  const evidenceTimes = (state.sopActionRecords ?? [])
    .filter((record) => (previous.actionRecordIds ?? []).includes(record.id) && record.completedAt)
    .map((record) => dateMs(record.completedAt!))
  const completedAt = Math.max(dateMs(task.completedAt), ...evidenceTimes)
  return new Date(completedAt + step.delaySeconds * 1000).toISOString()
}

function routingConditionsMatch(state: RuntimeState, occurrence: TriggerOccurrence, step: SopStep) {
  const conditions = step.routing?.conditions ?? []
  if (conditions.length === 0) return true
  const matches = conditions.map((condition) => conditionMatches(state, occurrence, condition))
  return step.routing?.conditionMode === 'any' ? matches.some(Boolean) : matches.every(Boolean)
}

function handleStepFailures(state: RuntimeState, execution: SopExecution, now: Date) {
  for (const step of execution.steps) {
    if (!failedStepOutcomes.has(step.outcome) || step.failureHandledAt) continue
    const definition = stepDefinition(execution, step.stepId)
    const behavior = definition?.routing?.onFailure ?? 'stop'
    step.failureHandledAt = now.toISOString()
    step.reason ??= 'step_failed'
    auditExecution(state, execution, 'sop.execution.step_failed.v1', {
      stepId: step.stepId,
      outcome: step.outcome,
      behavior,
      compensationStepId: definition?.routing?.compensationStepId ?? null,
    })
    if (behavior !== 'stop') continue
    execution.status = 'blocked'
    execution.completedAt = now.toISOString()
    execution.updatedAt = now.toISOString()
    execution.stoppedReason = `step_failed:${step.stepId}`
    auditExecution(state, execution, 'sop.execution.blocked.v1', { stepId: step.stepId, reason: step.reason })
    return true
  }
  return false
}

function skipDormantCompensationSteps(execution: SopExecution, now: Date) {
  const ordinarySteps = execution.ruleSnapshot.steps.filter((step) => !step.routing?.compensationOnly)
  if (!ordinarySteps.every((definition) => {
    const step = stepExecution(execution, definition.id)
    return Boolean(step && terminalStepOutcomes.has(step.outcome))
  })) return false
  let changed = false
  for (const definition of execution.ruleSnapshot.steps.filter((step) => step.routing?.compensationOnly)) {
    const step = stepExecution(execution, definition.id)
    if (!step || terminalStepOutcomes.has(step.outcome) || compensationActivated(execution, definition.id)) continue
    step.outcome = 'skipped'
    step.reason = 'compensation_not_required'
    step.triggeredAt = now.toISOString()
    changed = true
  }
  return changed
}

function renderNote(template: string, input: { tableCode: string; ruleName: string; stepName: string; elapsedMinutes: number }) {
  return template
    .replaceAll('{table}', input.tableCode)
    .replaceAll('{rule}', input.ruleName)
    .replaceAll('{step}', input.stepName)
    .replaceAll('{minutes}', String(input.elapsedMinutes))
}

function auditExecution(state: RuntimeState, execution: SopExecution, action: string, details: Record<string, unknown>) {
  state.auditEntries.push({
    id: `audit_${randomUUID()}`,
    actorId: 'system',
    action,
    objectType: 'sop_execution',
    objectId: execution.id,
    occurredAt: execution.updatedAt,
    details,
  })
}

function createStepActionRecords(
  state: RuntimeState,
  execution: SopExecution,
  definition: SopStep,
  task: ServiceTask,
  content: string,
  now: Date,
) {
  state.sopActionRecords ??= []
  const targetEmployees = [...new Set([
    ...(definition.action.dispatchEmployeeIds ?? []),
    ...task.notifiedEmployeeIds,
    ...(task.ownerId ? [task.ownerId] : []),
  ])]
  const requestedTypes: Array<{ type: SopActionRecordType; status: SopActionRecord['status']; roles: string[] }> = []
  for (const channel of definition.action.notificationChannels ?? ['in_app']) {
    if (channel === 'headset') requestedTypes.push({ type: 'headset_notification', status: 'queued', roles: [] })
    if (channel === 'wecom') requestedTypes.push({ type: 'wecom_notification', status: 'queued', roles: [] })
  }
  const verification = definition.action.verification
  const verificationType = verification?.type
  if (verification && (
    verificationType === 'manager_review'
    || verificationType === 'table_qr_scan'
    || verificationType === 'camera_snapshot'
  )) {
    requestedTypes.push({
      type: verificationType,
      status: verificationType === 'camera_snapshot' ? 'queued' : 'awaiting_evidence',
      roles: verification.roleIds,
    })
  }

  const ids: string[] = []
  for (const requested of requestedTypes) {
    const id = deterministicActionRecordId(execution.id, definition.id, requested.type)
    ids.push(id)
    if (state.sopActionRecords.some((record) => record.id === id)) continue
    state.sopActionRecords.push({
      id,
      executionId: execution.id,
      stepId: definition.id,
      taskId: task.id,
      tableSessionId: execution.tableSessionId,
      tableId: execution.tableId,
      type: requested.type,
      status: requested.status,
      recipientEmployeeIds: targetEmployees,
      requiredRoleIds: requested.roles,
      content,
      attemptCount: 0,
      requestedAt: now.toISOString(),
      lastAttemptAt: null,
      nextAttemptAt: now.toISOString(),
      completedAt: null,
      completedBy: null,
      providerReference: null,
      failureReason: null,
      evidenceReference: null,
      resolutionNote: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    })
    auditExecution(state, execution, 'sop.action.queued.v1', {
      stepId: definition.id,
      taskId: task.id,
      actionRecordId: id,
      actionType: requested.type,
      status: requested.status,
      recipientEmployeeIds: targetEmployees,
      requiredRoleIds: requested.roles,
    })
  }
  return ids
}

function createExecution(state: RuntimeState, rule: SopRule, occurrence: TriggerOccurrence, now: Date) {
  const execution: SopExecution = {
    id: deterministicExecutionId(rule.id, occurrence.id),
    ruleId: rule.id,
    ruleName: rule.name,
    configVersion: state.config.version,
    triggerEvent: occurrence.event,
    triggerOccurrenceId: occurrence.id,
    anchorAt: occurrence.occurredAt,
    tableSessionId: occurrence.tableSessionId,
    tableId: occurrence.tableId,
    context: { ...occurrence.context },
    status: 'active',
    ruleSnapshot: structuredClone(rule),
    steps: rule.steps.map((step) => ({
      stepId: step.id,
      scheduledAt: step.timing === 'after_trigger'
        ? new Date(dateMs(occurrence.occurredAt) + step.delaySeconds * 1000).toISOString()
        : null,
      triggeredAt: null,
      taskId: null,
      actionRecordIds: [],
      outcome: 'waiting',
      reason: null,
      failureHandledAt: null,
    })),
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    completedAt: null,
    stoppedReason: null,
  }
  state.sopExecutions!.push(execution)
  auditExecution(state, execution, 'sop.execution.started.v1', {
    ruleId: rule.id,
    triggerEvent: occurrence.event,
    triggerOccurrenceId: occurrence.id,
    tableSessionId: occurrence.tableSessionId,
    configVersion: state.config.version,
  })
  return execution
}

export function scheduleAdHocServiceTask(
  state: RuntimeState,
  input: {
    executionId: string
    actorId: string
    tableId: string
    serviceTypeId: string
    assigneeEmployeeId: string
    delaySeconds: number
    note: string
    now: Date
  },
) {
  const table = state.tables.find((candidate) => candidate.id === input.tableId)
  if (!table || table.status !== 'occupied') throw new Error('只能为已开台桌台安排定时服务')
  const session = state.songState.tableSessions.find((candidate) => (
    candidate.tableId === table.id && candidate.status === 'open'
  ))
  if (!session) throw new Error('桌台没有有效桌次')
  const serviceType = state.config.serviceTypes.find((candidate) => (
    candidate.id === input.serviceTypeId && candidate.enabled
  ))
  if (!serviceType) throw new Error('服务类型不存在或未启用')
  if (!Number.isInteger(input.delaySeconds) || input.delaySeconds < 0 || input.delaySeconds > 24 * 60 * 60) {
    throw new Error('定时服务只能安排在24小时内')
  }

  const ruleId = `assistant_one_off_${input.executionId}`
  const occurrenceId = `assistant_schedule_${input.executionId}`
  const existingId = deterministicExecutionId(ruleId, occurrenceId)
  const existing = state.sopExecutions?.find((candidate) => candidate.id === existingId)
  if (existing) {
    return { execution: existing, scheduledAt: existing.steps[0]?.scheduledAt ?? input.now.toISOString(), replayed: true }
  }

  const rule: SopRule = {
    id: ruleId,
    name: `AI定时指派·${table.code}·${serviceType.name}`,
    description: '由授权员工通过AI值班经理创建的一次性定时服务',
    enabled: true,
    trigger: { event: 'service_requested', serviceTypeIds: [], productCategoryIds: [] },
    scope: { areaIds: [], tableIds: [table.id] },
    conditions: [],
    stopConditions: ['table_closed'],
    steps: [{
      id: 'dispatch_service',
      name: `派发${serviceType.name}`,
      timing: 'after_trigger',
      delaySeconds: input.delaySeconds,
      action: {
        type: 'create_service_task',
        serviceTypeId: serviceType.id,
        dispatchRoleIds: [...serviceType.dispatchRoleIds],
        dispatchEmployeeIds: [input.assigneeEmployeeId],
        notificationChannels: ['in_app'],
        noteTemplate: input.note,
        verification: { type: 'staff_completed', roleIds: [] },
      },
    }],
  }
  const occurrence: TriggerOccurrence = {
    id: occurrenceId,
    event: 'service_requested',
    occurredAt: input.now.toISOString(),
    tableSessionId: session.id,
    tableId: table.id,
    context: emptyContext(),
  }
  state.sopExecutions ??= []
  const execution = createExecution(state, rule, occurrence, input.now)
  const scheduledAt = execution.steps[0]?.scheduledAt ?? new Date(input.now.getTime() + input.delaySeconds * 1000).toISOString()
  state.auditEntries.push({
    id: `audit_${randomUUID()}`,
    actorId: input.actorId,
    action: 'assistant.service_task.scheduled.v1',
    objectType: 'sop_execution',
    objectId: execution.id,
    occurredAt: input.now.toISOString(),
    details: {
      executionId: input.executionId,
      tableId: table.id,
      tableCode: table.code,
      tableSessionId: session.id,
      serviceTypeId: serviceType.id,
      assigneeEmployeeId: input.assigneeEmployeeId,
      delaySeconds: input.delaySeconds,
      scheduledAt,
    },
  })
  state.revision += 1
  return { execution, scheduledAt, replayed: false }
}

function advanceExecution(state: RuntimeState, execution: SopExecution, now: Date) {
  let changed = refreshStepOutcomes(state, execution)
  if (handleStepFailures(state, execution, now)) return true
  const session = openSession(state, execution.tableSessionId)
  if (session && execution.tableId !== session.tableId) {
    execution.tableId = session.tableId
    for (const record of (state.sopActionRecords ?? []).filter((candidate) => (
      candidate.executionId === execution.id && !['completed', 'rejected', 'failed'].includes(candidate.status)
    ))) record.tableId = session.tableId
    execution.updatedAt = now.toISOString()
    changed = true
    auditExecution(state, execution, 'sop.execution.table_transferred.v1', {
      tableSessionId: execution.tableSessionId,
      tableId: session.tableId,
    })
  }
  const reason = stopReason(state, execution, execution.ruleSnapshot.stopConditions)
  if (reason) {
    execution.status = 'cancelled'
    execution.completedAt = now.toISOString()
    execution.updatedAt = now.toISOString()
    execution.stoppedReason = reason
    auditExecution(state, execution, 'sop.execution.cancelled.v1', { reason })
    return true
  }

  for (let index = 0; index < execution.ruleSnapshot.steps.length; index += 1) {
    const definition = execution.ruleSnapshot.steps[index]!
    const step = execution.steps[index]!
    if (step.taskId || terminalStepOutcomes.has(step.outcome)) continue
    if (!definition.routing && definition.timing === 'after_previous_completed') {
      const previous = execution.steps[index - 1]
      if (previous?.outcome === 'cancelled' || previous?.outcome === 'blocked') {
        step.outcome = 'blocked'
        execution.status = 'blocked'
        execution.completedAt = now.toISOString()
        execution.updatedAt = now.toISOString()
        execution.stoppedReason = 'previous_step_not_completed'
        auditExecution(state, execution, 'sop.execution.blocked.v1', { stepId: definition.id })
        return true
      }
    }
    const dueAt = scheduledAt(state, execution, definition, index)
    step.scheduledAt = dueAt
    if (!dueAt || dateMs(dueAt) > now.getTime()) continue
    const currentOccurrence: TriggerOccurrence = {
      id: execution.triggerOccurrenceId,
      event: execution.triggerEvent,
      occurredAt: execution.anchorAt,
      tableSessionId: execution.tableSessionId,
      tableId: execution.tableId,
      context: execution.context ?? emptyContext(),
    }
    if (!execution.ruleSnapshot.conditions.every((condition) => conditionMatches(state, currentOccurrence, condition))) {
      execution.status = 'cancelled'
      execution.completedAt = now.toISOString()
      execution.updatedAt = now.toISOString()
      execution.stoppedReason = 'condition_no_longer_matches'
      auditExecution(state, execution, 'sop.execution.cancelled.v1', {
        reason: execution.stoppedReason,
        stepId: definition.id,
      })
      return true
    }
    if (!routingConditionsMatch(state, currentOccurrence, definition)) {
      step.triggeredAt = now.toISOString()
      step.reason = 'step_condition_not_matched'
      if (definition.routing?.onConditionFalse === 'block') {
        step.outcome = 'blocked'
        execution.updatedAt = now.toISOString()
        changed = true
        auditExecution(state, execution, 'sop.execution.step_condition_blocked.v1', { stepId: definition.id })
        if (handleStepFailures(state, execution, now)) return true
      } else {
        step.outcome = 'skipped'
        execution.updatedAt = now.toISOString()
        changed = true
        auditExecution(state, execution, 'sop.execution.step_skipped.v1', { stepId: definition.id, reason: step.reason })
      }
      continue
    }
    const table = state.tables.find((candidate) => candidate.id === execution.tableId)
    if (!table || table.status !== 'occupied') break
    const renderedNote = renderNote(definition.action.noteTemplate, {
      tableCode: table.code,
      ruleName: execution.ruleName,
      stepName: definition.name,
      elapsedMinutes: Math.max(0, Math.floor((now.getTime() - dateMs(execution.anchorAt)) / 60_000)),
    })
    const task = createServiceTask(state, {
      tableCode: table.code,
      serviceTypeId: definition.action.serviceTypeId,
      source: 'system',
      note: renderedNote,
      dispatchRoleIds: definition.action.dispatchRoleIds,
      dispatchEmployeeIds: definition.action.dispatchEmployeeIds,
      managerRoleIds: definition.action.escalation?.managerRoleIds,
      slaOverride: definition.action.escalation ? {
        warningSeconds: definition.action.escalation.warningSeconds,
        escalateSeconds: definition.action.escalation.backupAfterSeconds,
        managerSeconds: definition.action.escalation.managerAfterSeconds,
      } : undefined,
      triggerId: `${execution.id}:${definition.id}`,
      idempotencyKey: `${execution.id}:${definition.id}`,
    })
    step.taskId = task.id
    step.actionRecordIds = createStepActionRecords(state, execution, definition, task, renderedNote, now)
    step.triggeredAt = now.toISOString()
    step.outcome = 'task_created'
    execution.updatedAt = now.toISOString()
    changed = true
    auditExecution(state, execution, 'sop.execution.step_triggered.v1', {
      stepId: definition.id,
      taskId: task.id,
      scheduledAt: dueAt,
      verification: definition.action.verification?.type ?? 'staff_completed',
      notificationChannels: definition.action.notificationChannels ?? ['in_app'],
      actionRecordIds: step.actionRecordIds,
      escalation: definition.action.escalation ?? null,
    })
    if (!definition.routing && definition.timing === 'after_previous_completed') break
  }

  if (refreshStepOutcomes(state, execution)) changed = true
  if (handleStepFailures(state, execution, now)) return true
  if (skipDormantCompensationSteps(execution, now)) changed = true
  if (execution.steps.every((step) => terminalStepOutcomes.has(step.outcome))) {
    execution.status = 'completed'
    execution.completedAt = now.toISOString()
    execution.updatedAt = now.toISOString()
    execution.stoppedReason = execution.steps.some((step) => failedStepOutcomes.has(step.outcome))
      ? 'completed_with_recovery'
      : null
    auditExecution(state, execution, 'sop.execution.completed.v1', { recovered: Boolean(execution.stoppedReason) })
    changed = true
  }
  return changed
}

export function processSopRules(state: RuntimeState, now = new Date()) {
  state.sopExecutions ??= []
  let changed = false
  for (const rule of state.config.sopRules ?? []) {
    if (!rule.enabled) continue
    for (const occurrence of triggerOccurrences(state, rule)) {
      if (dateMs(occurrence.occurredAt) > now.getTime()) continue
      if (
        occurrence.event !== 'table_opened'
        && state.config.publishedAt
        && dateMs(occurrence.occurredAt) < dateMs(state.config.publishedAt)
      ) continue
      if (!occurrenceMatchesScope(state, rule, occurrence)) continue
      if (!rule.conditions.every((condition) => conditionMatches(state, occurrence, condition))) continue
      let execution = state.sopExecutions.find((candidate) => (
        candidate.ruleId === rule.id && candidate.triggerOccurrenceId === occurrence.id
      ))
      if (!execution) {
        execution = createExecution(state, rule, occurrence, now)
        changed = true
      }
    }
  }
  for (const execution of state.sopExecutions.filter((candidate) => candidate.status === 'active')) {
    if (advanceExecution(state, execution, now)) changed = true
  }
  if (changed) state.revision += 1
  return changed
}
