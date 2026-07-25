import { createHash } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { z } from 'zod'
import type {
  AssistantToolCall,
  AssistantToolExecutionResponse,
} from '../src/shared/assistant-tool-contracts.js'
import type { RuntimeState } from '../src/shared/contracts.js'
import { effectivePermissionIdsForEmployee, effectiveRoleIdsForEmployee } from '../src/shared/staff-access.js'
import { availableAssistantExecutableTools } from './assistant-capability-registry.js'
import { requireRequestActor } from './auth-context.js'
import { requireConfiguredOperation, requireTableDataScope } from './authorization.js'
import { applyTaskAction, canEmployeeClaimTask, createServiceTask } from './domain.js'
import { syncKdsFromFulfillmentServiceTaskAction } from './fulfillment-service.js'
import type { RuntimeRepository } from './repository.js'
import { scheduleAdHocServiceTask } from './sop-engine.js'
import { openWalkInTableSession } from './table-session-api.js'
import { executeAnalyticsQuery } from './analytics-engine.js'

const tableOpenArguments = z.object({
  tableCode: z.string().trim().min(1).max(32),
  partySize: z.number().int().min(1).max(100),
  customerName: z.string().trim().min(1).max(80).optional(),
  salesEmployeeId: z.string().trim().min(1).max(128).optional(),
}).strict()

const taskCreateArguments = z.object({
  tableCode: z.string().trim().min(1).max(32),
  serviceTypeId: z.string().trim().min(1).max(64),
  note: z.string().trim().max(300).optional(),
}).strict()

const taskScheduleArguments = z.object({
  tableCode: z.string().trim().min(1).max(32),
  serviceTypeId: z.string().trim().min(1).max(64),
  delayMinutes: z.number().int().min(0).max(24 * 60),
  assigneeEmployeeId: z.string().trim().min(1).max(128),
  note: z.string().trim().max(300).optional(),
}).strict()

const taskActionArguments = z.object({
  taskId: z.string().trim().min(1).max(160),
  note: z.string().trim().max(300).optional(),
}).strict()

function resolveEmployeeId(state: RuntimeState, value: string | undefined, fallbackActorId: string) {
  if (!value) return fallbackActorId
  const normalized = value.trim().toLocaleLowerCase('zh-CN')
  const matches = state.employees.filter((employee) => (
    employee.status === 'active' && (
      employee.id.toLocaleLowerCase('zh-CN') === normalized
      || employee.displayName.toLocaleLowerCase('zh-CN') === normalized
    )
  ))
  if (matches.length !== 1) throw new Error(matches.length === 0 ? '销售归属员工不存在' : '销售归属员工名称不唯一')
  return matches[0]!.id
}

function resolveServiceTypeId(state: RuntimeState, value: string) {
  const normalized = value.trim().toLocaleLowerCase('zh-CN')
  const matches = state.config.serviceTypes.filter((type) => type.enabled && (
    type.id.toLocaleLowerCase('zh-CN') === normalized
    || type.code.toLocaleLowerCase('zh-CN') === normalized
    || type.name.toLocaleLowerCase('zh-CN') === normalized
  ))
  if (matches.length !== 1) throw new Error(matches.length === 0 ? '服务类型不存在或未启用' : '服务类型名称不唯一')
  return matches[0]!.id
}

function parseArguments<T>(schema: z.ZodType<T>, value: unknown, message: string) {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new Error(message)
  return parsed.data
}

function tableCodeKey(value: string) {
  const normalized = value.trim().toLocaleUpperCase('zh-CN')
  const match = normalized.match(/^([A-Z]+)0*(\d+)$/)
  return match ? `${match[1]}${Number(match[2])}` : normalized
}

function resolveTable(state: RuntimeState, value: string) {
  const key = tableCodeKey(value)
  const matches = state.tables.filter((table) => tableCodeKey(table.code) === key)
  if (matches.length !== 1) throw new Error(matches.length === 0 ? '桌台不存在' : '桌号匹配到多个桌台')
  return matches[0]!
}

function requestHash(call: AssistantToolCall) {
  return createHash('sha256').update(JSON.stringify(call)).digest('hex')
}

function previousExecution(state: RuntimeState, executionId: string, call: AssistantToolCall) {
  const audit = state.auditEntries.find((entry) => (
    entry.action === 'assistant.tool.executed.v1' && entry.details.executionId === executionId
  ))
  if (!audit) return null
  if (audit.details.requestHash !== requestHash(call)) throw new Error('同一个AI执行编号不能用于不同操作')
  const evidence = audit.details.evidence as AssistantToolExecutionResponse['evidence'] | undefined
  return {
    executionId,
    toolId: call.toolId,
    status: 'completed' as const,
    message: String(audit.details.message ?? '操作已完成'),
    objectType: audit.objectType,
    objectId: audit.objectId,
    replayed: true,
    stateRevision: state.revision,
    evidence: evidence ?? { verified: true as const, outcome: 'executed' as const },
  }
}

function executeTaskAction(
  request: FastifyRequest,
  state: RuntimeState,
  call: AssistantToolCall,
  executionId: string,
  action: 'accept' | 'arrive' | 'complete',
) {
  const actor = requireRequestActor(request)
  const input = parseArguments(taskActionArguments, call.arguments, '任务信息不完整，请重新选择要处理的任务')
  requireConfiguredOperation(request, state, 'service.task.action')
  const currentTask = state.tasks.find((item) => item.id === input.taskId)
  if (!currentTask) throw new Error('任务不存在')
  const eligibleNotifiedClaim = action === 'accept'
    && currentTask.ownerId === null
    && canEmployeeClaimTask(state, currentTask, actor.actorId)
  const assignedOwner = currentTask.ownerId === actor.actorId
  if (!assignedOwner && !eligibleNotifiedClaim) {
    requireTableDataScope(request, state, currentTask.tableId, 'service.task.action')
  }
  const toolAction = {
    action,
    actorId: actor.actorId,
    note: input.note ?? '',
    idempotencyKey: `assistant-tool:${executionId}`,
  } as const
  const task = applyTaskAction(state, currentTask.id, toolAction)
  syncKdsFromFulfillmentServiceTaskAction(state, task, toolAction)
  return {
    objectType: 'service_task',
    objectId: task.id,
    message: action === 'accept' ? `${task.id}已由您接单。`
      : action === 'arrive' ? `${task.id}已记录到桌。`
        : `${task.id}已完成并从待办中关闭。`,
  }
}

export class AssistantToolBus {
  constructor(
    private readonly repository: RuntimeRepository,
    private readonly now: () => number = Date.now,
  ) {}

  async execute(
    request: FastifyRequest,
    executionId: string,
    call: AssistantToolCall,
  ): Promise<AssistantToolExecutionResponse> {
    const actor = requireRequestActor(request)
    return this.repository.mutate((state) => {
      const replay = previousExecution(state, executionId, call)
      if (replay) return replay
      const available = new Set(availableAssistantExecutableTools(state, actor.actorId).map((tool) => tool.id))
      if (!available.has(call.toolId)) throw new Error('当前岗位没有执行这个AI工具的权限')
      const previousRevision = state.revision
      let result: {
        objectType: string
        objectId: string
        message: string
        evidence: AssistantToolExecutionResponse['evidence']
      }

      if (call.toolId === 'analytics.query') {
        const analytics = executeAnalyticsQuery(state, actor, call.arguments, this.now())
        result = {
          objectType: 'analytics_query',
          objectId: analytics.id,
          message: analytics.message,
          evidence: {
            verified: true,
            outcome: 'queried',
            analytics: analytics.result,
          },
        }
      } else if (call.toolId === 'table.open') {
        const input = parseArguments(tableOpenArguments, call.arguments, '开台信息不完整，请确认桌号和实际到店人数')
        const table = resolveTable(state, input.tableCode)
        requireConfiguredOperation(request, state, 'table.open')
        requireTableDataScope(request, state, table.id, 'table.open')
        const opened = openWalkInTableSession(state, table.id, {
          partySize: input.partySize,
          customerName: input.customerName ?? '现场客人',
          customerReference: undefined,
          salesEmployeeId: resolveEmployeeId(state, input.salesEmployeeId, actor.actorId),
          idempotencyKey: `assistant-open:${executionId}`,
        }, actor.actorId, new Date(this.now()).toISOString())
        result = {
          objectType: 'table', objectId: opened.table.id,
          message: `${opened.table.code}已开台，实际到店${input.partySize}人。`,
          evidence: {
            verified: true,
            outcome: 'executed',
            tableCode: opened.table.code,
            tableStatus: opened.table.status,
            guestCount: opened.table.guestCount,
          },
        }
      } else if (call.toolId === 'service.task.create') {
        const input = parseArguments(taskCreateArguments, call.arguments, '服务任务信息不完整，请确认桌号和服务内容')
        const table = resolveTable(state, input.tableCode)
        requireConfiguredOperation(request, state, 'service.task.create')
        requireTableDataScope(request, state, table.id, 'service.task.create')
        const task = createServiceTask(state, {
          tableCode: table.code,
          serviceTypeId: resolveServiceTypeId(state, input.serviceTypeId),
          source: 'employee',
          note: input.note ?? '',
          idempotencyKey: `assistant-task:${executionId}`,
          requestedBy: actor.actorId,
        })
        result = {
          objectType: 'service_task', objectId: task.id, message: `${table.code}服务任务已创建并进入派单。`,
          evidence: {
            verified: true,
            outcome: 'executed',
            tableCode: table.code,
            taskStatus: task.status,
            assigneeEmployeeId: task.ownerId ?? undefined,
            assigneeName: task.ownerId ? state.employees.find((employee) => employee.id === task.ownerId)?.displayName : undefined,
          },
        }
      } else if (call.toolId === 'service.task.schedule') {
        const input = parseArguments(taskScheduleArguments, call.arguments, '定时任务信息不完整，请确认时间、桌号、员工和服务内容')
        const table = resolveTable(state, input.tableCode)
        const serviceTypeId = resolveServiceTypeId(state, input.serviceTypeId)
        const serviceType = state.config.serviceTypes.find((candidate) => candidate.id === serviceTypeId)!
        const assigneeEmployeeId = resolveEmployeeId(state, input.assigneeEmployeeId, actor.actorId)
        const assignee = state.employees.find((employee) => employee.id === assigneeEmployeeId)!
        if (!assignee.online || assignee.paused) {
          throw new Error(`${assignee.displayName}当前不在可接单状态，请改派其他当班人员`)
        }
        if (assigneeEmployeeId !== actor.actorId && !effectivePermissionIdsForEmployee(state, actor.actorId).includes('shift.manage')) {
          throw new Error('只有值班管理岗位可以指派其他员工')
        }
        if (!effectivePermissionIdsForEmployee(state, assignee.id).includes('service.execute')) {
          throw new Error(`${assignee.displayName}没有现场服务执行权限`)
        }
        if (!effectiveRoleIdsForEmployee(state, assignee.id).some((roleId) => serviceType.dispatchRoleIds.includes(roleId))) {
          throw new Error(`${assignee.displayName}的岗位不能执行${serviceType.name}`)
        }
        requireConfiguredOperation(request, state, 'service.task.action')
        requireTableDataScope(request, state, table.id, 'service.task.action')
        const scheduled = scheduleAdHocServiceTask(state, {
          executionId,
          actorId: actor.actorId,
          tableId: table.id,
          serviceTypeId,
          assigneeEmployeeId,
          delaySeconds: input.delayMinutes * 60,
          note: input.note ?? `AI指派：为${table.code}执行${serviceType.name}`,
          now: new Date(this.now()),
        })
        result = {
          objectType: 'sop_execution',
          objectId: scheduled.execution.id,
          message: input.delayMinutes === 0
            ? `已安排立即向${assignee.displayName}派发${table.code}${serviceType.name}任务${input.note ? `：${input.note}` : ''}。`
            : `已安排${input.delayMinutes}分钟后向${assignee.displayName}派发${table.code}${serviceType.name}任务${input.note ? `：${input.note}` : ''}。`,
          evidence: {
            verified: true,
            outcome: 'scheduled',
            tableCode: table.code,
            scheduledAt: scheduled.scheduledAt,
            assigneeEmployeeId: assignee.id,
            assigneeName: assignee.displayName,
          },
        }
      } else {
        const action = call.toolId === 'service.task.accept' ? 'accept'
          : call.toolId === 'service.task.arrive' ? 'arrive' : 'complete'
        const taskResult = executeTaskAction(request, state, call, executionId, action)
        const task = state.tasks.find((candidate) => candidate.id === taskResult.objectId)!
        result = {
          ...taskResult,
          evidence: {
            verified: true,
            outcome: 'executed',
            tableCode: state.tables.find((table) => table.id === task.tableId)?.code,
            taskStatus: task.status,
            assigneeEmployeeId: task.ownerId ?? undefined,
            assigneeName: task.ownerId ? state.employees.find((employee) => employee.id === task.ownerId)?.displayName : undefined,
          },
        }
      }

      state.auditEntries.push({
        id: `audit_assistant_tool_${executionId}`,
        actorId: actor.actorId,
        action: 'assistant.tool.executed.v1',
        objectType: result.objectType,
        objectId: result.objectId,
        occurredAt: new Date(this.now()).toISOString(),
        details: {
          executionId,
          toolId: call.toolId,
          requestHash: requestHash(call),
          message: result.message,
          evidence: result.evidence,
          executionMode: 'server_tool_bus',
        },
      })
      if (state.revision === previousRevision) state.revision += 1
      return {
        executionId,
        toolId: call.toolId,
        status: 'completed',
        message: result.message,
        objectType: result.objectType,
        objectId: result.objectId,
        replayed: false,
        stateRevision: state.revision,
        evidence: result.evidence,
      }
    })
  }
}
