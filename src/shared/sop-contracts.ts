import { z } from 'zod'

export const sopTriggerEvents = [
  'table_opened',
  'order_submitted',
  'payment_succeeded',
  'service_requested',
  'fulfillment_started',
  'fulfillment_completed',
  'fulfillment_delivered',
  'complaint_requested',
  'birthday_requested',
  'guest_mood_selected',
] as const

export type SopTriggerEvent = typeof sopTriggerEvents[number]
export type SopStepTiming = 'after_trigger' | 'after_previous_completed'
export type SopDependencyMode = 'all' | 'any'
export type SopConditionMode = 'all' | 'any'
export type SopConditionFalseBehavior = 'skip' | 'block'
export type SopFailureBehavior = 'stop' | 'continue' | 'run_compensation'
export const sopNotificationChannels = ['in_app', 'headset', 'wecom'] as const
export type SopNotificationChannel = typeof sopNotificationChannels[number]
export const sopVerificationTypes = [
  'staff_completed',
  'completed_by_role',
  'manager_review',
  'table_qr_scan',
  'camera_snapshot',
] as const
export type SopVerificationType = typeof sopVerificationTypes[number]
export type SopConditionType =
  | 'no_order'
  | 'no_payment'
  | 'minimum_guest_count'
  | 'minimum_session_spend'
  | 'open_task_count_at_least'
  | 'primary_employee_busy'
  | 'fulfillment_not_completed'
  | 'fulfillment_not_delivered'
export type SopStopCondition =
  | 'table_closed'
  | 'order_submitted'
  | 'payment_succeeded'
  | 'fulfillment_delivered'

export interface SopTrigger {
  event: SopTriggerEvent
  serviceTypeIds: string[]
  productCategoryIds: string[]
  workstationIds?: string[]
}

export interface SopScope {
  areaIds: string[]
  tableIds: string[]
}

export interface SopCondition {
  type: SopConditionType
  value: number | null
}

export interface SopTaskAction {
  type: 'create_service_task'
  serviceTypeId: string
  dispatchRoleIds: string[]
  dispatchEmployeeIds?: string[]
  notificationChannels?: SopNotificationChannel[]
  noteTemplate: string
  escalation?: {
    warningSeconds: number
    backupAfterSeconds: number
    managerAfterSeconds: number
    managerRoleIds: string[]
  }
  verification?: {
    type: SopVerificationType
    roleIds: string[]
  }
}

export interface SopStepRouting {
  /** Empty means use the legacy timing/order behavior. */
  dependsOnStepIds: string[]
  dependencyMode: SopDependencyMode
  conditions: SopCondition[]
  conditionMode: SopConditionMode
  onConditionFalse: SopConditionFalseBehavior
  onFailure: SopFailureBehavior
  compensationStepId: string | null
  /** Compensation steps stay dormant until a failed step points to them. */
  compensationOnly: boolean
}

export interface SopStep {
  id: string
  name: string
  timing: SopStepTiming
  delaySeconds: number
  action: SopTaskAction
  routing?: SopStepRouting
}

export interface SopRule {
  id: string
  name: string
  description: string
  enabled: boolean
  trigger: SopTrigger
  scope: SopScope
  conditions: SopCondition[]
  stopConditions: SopStopCondition[]
  steps: SopStep[]
}

export type SopExecutionStatus = 'active' | 'completed' | 'cancelled' | 'blocked'

export interface SopStepExecution {
  stepId: string
  scheduledAt: string | null
  triggeredAt: string | null
  taskId: string | null
  actionRecordIds?: string[]
  outcome: 'waiting' | 'task_created' | 'completed' | 'cancelled' | 'blocked' | 'skipped' | 'failed'
  reason?: string | null
  failureHandledAt?: string | null
}

export type SopActionRecordType = 'headset_notification' | 'wecom_notification' | 'manager_review' | 'table_qr_scan' | 'camera_snapshot'
export type SopActionRecordStatus = 'queued' | 'awaiting_evidence' | 'completed' | 'rejected' | 'failed' | 'unconfigured' | 'cancelled'

export interface SopActionRecord {
  id: string
  executionId: string
  stepId: string
  taskId: string
  tableSessionId: string
  tableId: string
  type: SopActionRecordType
  status: SopActionRecordStatus
  recipientEmployeeIds: string[]
  requiredRoleIds: string[]
  content: string
  attemptCount: number
  requestedAt: string
  lastAttemptAt: string | null
  nextAttemptAt: string | null
  completedAt: string | null
  completedBy: string | null
  providerReference: string | null
  failureReason: string | null
  evidenceReference: string | null
  resolutionNote: string | null
  leaseOwner: string | null
  leaseExpiresAt: string | null
}

export interface SopExecution {
  id: string
  ruleId: string
  ruleName: string
  configVersion: number
  triggerEvent: SopTriggerEvent
  triggerOccurrenceId: string
  anchorAt: string
  tableSessionId: string
  tableId: string
  context?: {
    serviceTaskId: string | null
    kdsTaskId: string | null
    orderId: string | null
  }
  status: SopExecutionStatus
  ruleSnapshot: SopRule
  steps: SopStepExecution[]
  startedAt: string
  updatedAt: string
  completedAt: string | null
  stoppedReason: string | null
}

const identifier = z.string().trim().min(1).max(128)

export const sopTriggerSchema = z.object({
  event: z.enum(sopTriggerEvents),
  serviceTypeIds: z.array(identifier).max(50),
  productCategoryIds: z.array(identifier).max(50),
  workstationIds: z.array(identifier).max(50).optional(),
}).strict()

export const sopScopeSchema = z.object({
  areaIds: z.array(identifier).max(100),
  tableIds: z.array(identifier).max(500),
}).strict()

export const sopConditionSchema = z.object({
  type: z.enum([
    'no_order',
    'no_payment',
    'minimum_guest_count',
    'minimum_session_spend',
    'open_task_count_at_least',
    'primary_employee_busy',
    'fulfillment_not_completed',
    'fulfillment_not_delivered',
  ]),
  value: z.number().int().min(1).max(100_000_000).nullable(),
}).strict().superRefine((condition, context) => {
  const numericConditions: SopConditionType[] = [
    'minimum_guest_count',
    'minimum_session_spend',
    'open_task_count_at_least',
  ]
  if (numericConditions.includes(condition.type) && condition.value === null) {
    context.addIssue({ code: 'custom', path: ['value'], message: '这个条件必须填写数值' })
  }
  if (!numericConditions.includes(condition.type) && condition.value !== null) {
    context.addIssue({ code: 'custom', path: ['value'], message: '这个条件不需要填写数值' })
  }
})

export const sopStepSchema = z.object({
  id: identifier,
  name: z.string().trim().min(1).max(80),
  timing: z.enum(['after_trigger', 'after_previous_completed']),
  delaySeconds: z.number().int().min(0).max(7 * 24 * 60 * 60),
  action: z.object({
    type: z.literal('create_service_task'),
    serviceTypeId: identifier,
    dispatchRoleIds: z.array(identifier).min(1).max(50),
    dispatchEmployeeIds: z.array(identifier).max(100).optional(),
    notificationChannels: z.array(z.enum(sopNotificationChannels)).min(1).max(3).optional(),
    noteTemplate: z.string().trim().min(1).max(500),
    escalation: z.object({
      warningSeconds: z.number().int().min(5).max(7200),
      backupAfterSeconds: z.number().int().min(10).max(14_400),
      managerAfterSeconds: z.number().int().min(15).max(28_800),
      managerRoleIds: z.array(identifier).min(1).max(20),
    }).strict().refine((value) => (
      value.warningSeconds < value.backupAfterSeconds
      && value.backupAfterSeconds < value.managerAfterSeconds
    ), { message: '预警、候补和经理接管时间必须依次增大' }).optional(),
    verification: z.object({
      type: z.enum(sopVerificationTypes),
      roleIds: z.array(identifier).max(20),
    }).strict().superRefine((value, context) => {
      if (value.type !== 'staff_completed' && value.roleIds.length === 0) {
        context.addIssue({ code: 'custom', path: ['roleIds'], message: '非员工自确认至少需要一个验证岗位' })
      }
      if (value.type === 'staff_completed' && value.roleIds.length > 0) {
        context.addIssue({ code: 'custom', path: ['roleIds'], message: '员工完成验证不需要指定岗位' })
      }
    }).optional(),
  }).strict().superRefine((action, context) => {
    if (action.notificationChannels && new Set(action.notificationChannels).size !== action.notificationChannels.length) {
      context.addIssue({ code: 'custom', path: ['notificationChannels'], message: '通知终端不能重复' })
    }
    if (action.notificationChannels && !action.notificationChannels.includes('in_app')) {
      context.addIssue({ code: 'custom', path: ['notificationChannels'], message: '现场任务必须保留系统内通知' })
    }
  }),
  routing: z.object({
    dependsOnStepIds: z.array(identifier).max(20),
    dependencyMode: z.enum(['all', 'any']),
    conditions: z.array(sopConditionSchema).max(20),
    conditionMode: z.enum(['all', 'any']),
    onConditionFalse: z.enum(['skip', 'block']),
    onFailure: z.enum(['stop', 'continue', 'run_compensation']),
    compensationStepId: identifier.nullable(),
    compensationOnly: z.boolean(),
  }).strict().optional(),
}).strict()

export const sopRuleSchema = z.object({
  id: identifier,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300),
  enabled: z.boolean(),
  trigger: sopTriggerSchema,
  scope: sopScopeSchema,
  conditions: z.array(sopConditionSchema).max(20),
  stopConditions: z.array(z.enum(['table_closed', 'order_submitted', 'payment_succeeded', 'fulfillment_delivered'])).max(4),
  steps: z.array(sopStepSchema).min(1).max(20),
}).strict().superRefine((rule, context) => {
  if (new Set(rule.steps.map((step) => step.id)).size !== rule.steps.length) {
    context.addIssue({ code: 'custom', path: ['steps'], message: '同一SOP的步骤编号不能重复' })
  }
  if (new Set(rule.conditions.map((condition) => condition.type)).size !== rule.conditions.length) {
    context.addIssue({ code: 'custom', path: ['conditions'], message: '同一SOP的判断条件不能重复' })
  }
  if (new Set(rule.stopConditions).size !== rule.stopConditions.length) {
    context.addIssue({ code: 'custom', path: ['stopConditions'], message: '同一SOP的停止条件不能重复' })
  }
  const usesAdvancedRouting = rule.steps.some((step) => step.routing)
  if (!usesAdvancedRouting && rule.steps[0]?.timing === 'after_previous_completed') {
    context.addIssue({ code: 'custom', path: ['steps', 0, 'timing'], message: '第一步必须从触发事件开始计时' })
  }
  let previousTriggerDelay = -1
  let enteredSequentialSteps = false
  rule.steps.forEach((step, index) => {
    if (usesAdvancedRouting) return
    if (step.timing === 'after_previous_completed') enteredSequentialSteps = true
    if (step.timing !== 'after_trigger') return
    if (enteredSequentialSteps) {
      context.addIssue({ code: 'custom', path: ['steps', index, 'timing'], message: '按前一步完成计时后，后续步骤不能再改回触发事件计时' })
    }
    if (step.delaySeconds < previousTriggerDelay) {
      context.addIssue({ code: 'custom', path: ['steps', index, 'delaySeconds'], message: '按触发事件计时的步骤必须按时间先后排列' })
    }
    previousTriggerDelay = step.delaySeconds
  })
  const stepIds = new Set(rule.steps.map((step) => step.id))
  rule.steps.forEach((step, index) => {
    const routing = step.routing
    if (!routing) return
    if (new Set(routing.dependsOnStepIds).size !== routing.dependsOnStepIds.length) {
      context.addIssue({ code: 'custom', path: ['steps', index, 'routing', 'dependsOnStepIds'], message: '前置步骤不能重复' })
    }
    if (routing.dependsOnStepIds.includes(step.id)) {
      context.addIssue({ code: 'custom', path: ['steps', index, 'routing', 'dependsOnStepIds'], message: '步骤不能依赖自己' })
    }
    if (routing.dependsOnStepIds.some((stepId) => !stepIds.has(stepId))) {
      context.addIssue({ code: 'custom', path: ['steps', index, 'routing', 'dependsOnStepIds'], message: '引用了不存在的前置步骤' })
    }
    if (new Set(routing.conditions.map((condition) => condition.type)).size !== routing.conditions.length) {
      context.addIssue({ code: 'custom', path: ['steps', index, 'routing', 'conditions'], message: '同一步骤的判断条件不能重复' })
    }
    if (routing.onFailure === 'run_compensation' && !routing.compensationStepId) {
      context.addIssue({ code: 'custom', path: ['steps', index, 'routing', 'compensationStepId'], message: '失败补偿必须指定补偿步骤' })
    }
    if (routing.onFailure !== 'run_compensation' && routing.compensationStepId) {
      context.addIssue({ code: 'custom', path: ['steps', index, 'routing', 'compensationStepId'], message: '只有失败补偿策略可以指定补偿步骤' })
    }
    if (routing.compensationStepId === step.id || (routing.compensationStepId && !stepIds.has(routing.compensationStepId))) {
      context.addIssue({ code: 'custom', path: ['steps', index, 'routing', 'compensationStepId'], message: '补偿步骤引用无效' })
    }
    if (routing.compensationStepId) {
      const compensation = rule.steps.find((candidate) => candidate.id === routing.compensationStepId)
      if (!compensation?.routing?.compensationOnly) {
        context.addIssue({ code: 'custom', path: ['steps', index, 'routing', 'compensationStepId'], message: '指定步骤必须标记为仅失败时执行' })
      }
    }
  })
  const dependencyMap = new Map(rule.steps.map((step) => [step.id, step.routing?.dependsOnStepIds ?? []]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const hasCycle = (stepId: string): boolean => {
    if (visiting.has(stepId)) return true
    if (visited.has(stepId)) return false
    visiting.add(stepId)
    const cyclic = (dependencyMap.get(stepId) ?? []).some(hasCycle)
    visiting.delete(stepId)
    visited.add(stepId)
    return cyclic
  }
  if (rule.steps.some((step) => hasCycle(step.id))) {
    context.addIssue({ code: 'custom', path: ['steps'], message: '步骤依赖不能形成循环' })
  }
  if (rule.trigger.event !== 'service_requested' && rule.trigger.serviceTypeIds.length > 0) {
    context.addIssue({ code: 'custom', path: ['trigger', 'serviceTypeIds'], message: '只有服务请求触发器可以筛选服务类型' })
  }
  if (rule.trigger.event !== 'order_submitted' && rule.trigger.productCategoryIds.length > 0) {
    context.addIssue({ code: 'custom', path: ['trigger', 'productCategoryIds'], message: '只有订单触发器可以筛选商品品类' })
  }
  if (!rule.trigger.event.startsWith('fulfillment_') && (rule.trigger.workstationIds?.length ?? 0) > 0) {
    context.addIssue({ code: 'custom', path: ['trigger', 'workstationIds'], message: '只有出品触发器可以筛选工作站' })
  }
})

export const sopActionResolutionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  note: z.string().trim().min(2).max(300),
  tableQrToken: z.string().trim().min(32).max(4096).optional(),
  idempotencyKey: z.string().trim().min(8).max(128),
}).strict()

export type SopActionResolutionInput = z.infer<typeof sopActionResolutionSchema>
