import { createHash } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { z } from 'zod'
import type {
  AssistantServerToolId,
  AssistantToolCall,
  AssistantToolDescriptor,
  AssistantToolExecutionResponse,
} from '../src/shared/assistant-tool-contracts.js'
import type { RuntimeState } from '../src/shared/contracts.js'
import type { StaffPermissionId } from '../src/shared/contracts.js'
import { effectivePermissionIdsForEmployee } from '../src/shared/staff-access.js'
import { requireRequestActor } from './auth-context.js'
import { requireConfiguredOperation, requireTableDataScope } from './authorization.js'
import { applyTaskAction, canEmployeeClaimTask, createServiceTask } from './domain.js'
import { syncKdsFromFulfillmentServiceTaskAction } from './fulfillment-service.js'
import type { RuntimeRepository } from './repository.js'
import { openWalkInTableSession } from './table-session-api.js'

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

const taskActionArguments = z.object({
  taskId: z.string().trim().min(1).max(160),
  note: z.string().trim().max(300).optional(),
}).strict()

const descriptors: Record<AssistantServerToolId, Omit<AssistantToolDescriptor, 'argumentGuide'>> = {
  'table.open': {
    id: 'table.open', name: '开台', description: '按桌号和实际到店人数开台并建立临客桌次',
    risk: 'normal', requiredPermission: 'table.open',
  },
  'service.task.create': {
    id: 'service.task.create', name: '创建服务任务', description: '为指定桌台创建一条可派发、升级和追踪的服务任务',
    risk: 'normal', requiredPermission: 'service.execute',
  },
  'service.task.accept': {
    id: 'service.task.accept', name: '接单', description: '接管一条当前员工有权处理的服务任务',
    risk: 'normal', requiredPermission: 'service.execute',
  },
  'service.task.arrive': {
    id: 'service.task.arrive', name: '确认到桌', description: '把本人已接单的服务任务更新为已经到桌',
    risk: 'normal', requiredPermission: 'service.execute',
  },
  'service.task.complete': {
    id: 'service.task.complete', name: '完成服务', description: '把本人已到桌的服务任务闭环并记录结果',
    risk: 'normal', requiredPermission: 'service.execute',
  },
}

function serviceTypeGuide(state: RuntimeState) {
  return state.config.serviceTypes
    .filter((type) => type.enabled)
    .map((type) => `${type.name}=${type.id}`)
    .join('、')
}

export function availableAssistantTools(state: RuntimeState, actorId: string): AssistantToolDescriptor[] {
  const permissions = new Set(effectivePermissionIdsForEmployee(state, actorId))
  return Object.values(descriptors)
    .filter((descriptor) => permissions.has(descriptor.requiredPermission as StaffPermissionId))
    .map((descriptor) => {
      const argumentGuide: Record<string, string> = descriptor.id === 'table.open'
        ? {
            tableCode: '必填，现场桌号，例如L01',
            partySize: '必填，实际到店人数；不得猜测',
            customerName: '选填，未提供时使用现场客人',
            salesEmployeeId: '选填，员工ID或姓名；未提供时归属当前操作员工',
          }
        : descriptor.id === 'service.task.create'
          ? {
              tableCode: '必填，现场桌号',
              serviceTypeId: `必填，${serviceTypeGuide(state)}`,
              note: '选填，现场需求补充说明',
            }
          : { taskId: '必填，实时任务列表中的任务ID', note: '选填，处理结果或说明' }
      return { ...descriptor, argumentGuide }
    })
}

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

function requestHash(call: AssistantToolCall) {
  return createHash('sha256').update(JSON.stringify(call)).digest('hex')
}

function previousExecution(state: RuntimeState, executionId: string, call: AssistantToolCall) {
  const audit = state.auditEntries.find((entry) => (
    entry.action === 'assistant.tool.executed.v1' && entry.details.executionId === executionId
  ))
  if (!audit) return null
  if (audit.details.requestHash !== requestHash(call)) throw new Error('同一个AI执行编号不能用于不同操作')
  return {
    executionId,
    toolId: call.toolId,
    status: 'completed' as const,
    message: String(audit.details.message ?? '操作已完成'),
    objectType: audit.objectType,
    objectId: audit.objectId,
    replayed: true,
    stateRevision: state.revision,
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
  const input = taskActionArguments.parse(call.arguments)
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
  constructor(private readonly repository: RuntimeRepository) {}

  async execute(
    request: FastifyRequest,
    executionId: string,
    call: AssistantToolCall,
  ): Promise<AssistantToolExecutionResponse> {
    const actor = requireRequestActor(request)
    return this.repository.mutate((state) => {
      const replay = previousExecution(state, executionId, call)
      if (replay) return replay
      const available = new Set(availableAssistantTools(state, actor.actorId).map((tool) => tool.id))
      if (!available.has(call.toolId)) throw new Error('当前岗位没有执行这个AI工具的权限')
      const previousRevision = state.revision
      let result: { objectType: string; objectId: string; message: string }

      if (call.toolId === 'table.open') {
        const input = tableOpenArguments.parse(call.arguments)
        const table = state.tables.find((candidate) => candidate.code.toLocaleLowerCase('zh-CN') === input.tableCode.toLocaleLowerCase('zh-CN'))
        if (!table) throw new Error('桌台不存在')
        requireConfiguredOperation(request, state, 'table.open')
        requireTableDataScope(request, state, table.id, 'table.open')
        const opened = openWalkInTableSession(state, table.id, {
          partySize: input.partySize,
          customerName: input.customerName ?? '现场客人',
          customerReference: undefined,
          salesEmployeeId: resolveEmployeeId(state, input.salesEmployeeId, actor.actorId),
          idempotencyKey: `assistant-open:${executionId}`,
        }, actor.actorId)
        result = {
          objectType: 'table', objectId: opened.table.id,
          message: `${opened.table.code}已开台，实际到店${input.partySize}人。`,
        }
      } else if (call.toolId === 'service.task.create') {
        const input = taskCreateArguments.parse(call.arguments)
        const table = state.tables.find((candidate) => candidate.code.toLocaleLowerCase('zh-CN') === input.tableCode.toLocaleLowerCase('zh-CN'))
        if (!table) throw new Error('桌台不存在')
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
        result = { objectType: 'service_task', objectId: task.id, message: `${table.code}服务任务已创建并进入派单。` }
      } else {
        const action = call.toolId === 'service.task.accept' ? 'accept'
          : call.toolId === 'service.task.arrive' ? 'arrive' : 'complete'
        result = executeTaskAction(request, state, call, executionId, action)
      }

      state.auditEntries.push({
        id: `audit_assistant_tool_${executionId}`,
        actorId: actor.actorId,
        action: 'assistant.tool.executed.v1',
        objectType: result.objectType,
        objectId: result.objectId,
        occurredAt: new Date().toISOString(),
        details: {
          executionId,
          toolId: call.toolId,
          requestHash: requestHash(call),
          message: result.message,
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
      }
    })
  }
}
