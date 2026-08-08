import type { FastifyInstance } from 'fastify'
import { createTaskSchema, managerTaskActionSchema, taskActionSchema } from '../src/shared/contracts.js'
import { AuthorizationError, requireConfiguredOperation, requireTableDataScope } from './authorization.js'
import { requireRequestActor } from './auth-context.js'
import {
  applyManagerTaskAction,
  applyTaskAction,
  canEmployeeClaimTask,
  canManagerSuperviseTask,
  createServiceTask,
  managerTaskTransferCandidates,
} from './domain.js'
import { syncKdsFromFulfillmentServiceTaskAction } from './fulfillment-service.js'
import type { RuntimeRepository } from './repository.js'

export function registerTaskRoutes(app: FastifyInstance, repository: RuntimeRepository) {
  app.post('/api/tasks', async (request, reply) => {
    const input = createTaskSchema.parse(request.body)
    const task = await repository.mutate((state) => {
      const actor = requireConfiguredOperation(request, state, 'service.task.create')
      const table = state.tables.find((item) => item.code === input.tableCode)
      if (!table) throw new Error('桌台不存在')
      requireTableDataScope(request, state, table.id, 'service.task.create')
      return createServiceTask(state, { ...input, source: 'employee', requestedBy: actor.actorId })
    })
    return reply.status(201).send(task)
  })

  app.post<{ Params: { taskId: string } }>('/api/tasks/:taskId/actions', async (request) => {
    const input = taskActionSchema.parse(request.body)
    const actor = requireRequestActor(request)
    if (['confirm', 'unresolved'].includes(input.action)) {
      throw new AuthorizationError('客户确认必须由客人端提交', 'service.task.action')
    }
    if (input.actorId !== actor.actorId) {
      throw new AuthorizationError('任务操作人必须与当前登录员工一致', 'service.task.action')
    }
    return repository.mutate((state) => {
      const effectiveActor = requireConfiguredOperation(request, state, 'service.task.action')
      const currentTask = state.tasks.find((item) => item.id === request.params.taskId)
      if (!currentTask) throw new Error('任务不存在')
      const eligibleNotifiedClaim = input.action === 'accept'
        && currentTask.ownerId === null
        && canEmployeeClaimTask(state, currentTask, actor.actorId)
      const domainValidatedQuickComplete = input.action === 'quick_complete'
      const assignedOwner = currentTask.ownerId === actor.actorId
      if (!assignedOwner && !eligibleNotifiedClaim && !domainValidatedQuickComplete) {
        requireTableDataScope(request, state, currentTask.tableId, 'service.task.action')
      }
      const action = { ...input, actorId: actor.actorId }
      const task = applyTaskAction(state, request.params.taskId, action)
      syncKdsFromFulfillmentServiceTaskAction(state, task, action, {
        requestId: request.id,
        effectiveRoleId: effectiveActor.roleId,
      })
      return task
    })
  })

  app.get<{ Params: { taskId: string } }>('/api/tasks/:taskId/transfer-candidates', async (request) => {
    const actor = requireRequestActor(request)
    const state = await repository.read()
    requireConfiguredOperation(request, state, 'service.task.action')
    const task = state.tasks.find((item) => item.id === request.params.taskId)
    if (!task) throw new Error('任务不存在')
    requireTableDataScope(request, state, task.tableId, 'service.task.action')
    if (!canManagerSuperviseTask(state, task, actor.actorId)) {
      throw new AuthorizationError('当前账号没有该任务的管理权限', 'service.task.action')
    }
    return managerTaskTransferCandidates(state, task, actor.actorId)
  })

  app.post<{ Params: { taskId: string } }>('/api/tasks/:taskId/manager-actions', async (request) => {
    const input = managerTaskActionSchema.parse(request.body)
    const actor = requireRequestActor(request)
    if (input.actorId !== actor.actorId) {
      throw new AuthorizationError('经理操作人必须与当前登录员工一致', 'service.task.action')
    }
    return repository.mutate((state) => {
      const effectiveActor = requireConfiguredOperation(request, state, 'service.task.action')
      const currentTask = state.tasks.find((item) => item.id === request.params.taskId)
      if (!currentTask) throw new Error('任务不存在')
      requireTableDataScope(request, state, currentTask.tableId, 'service.task.action')
      if (!canManagerSuperviseTask(state, currentTask, actor.actorId)) {
        throw new AuthorizationError('当前账号没有该任务的管理权限', 'service.task.action')
      }
      const action = { ...input, actorId: actor.actorId }
      const task = applyManagerTaskAction(state, request.params.taskId, action)
      if (action.action === 'assist_complete') {
        syncKdsFromFulfillmentServiceTaskAction(state, task, {
          action: task.workflowLevel === 'L1' ? 'quick_complete' : 'complete',
          actorId: actor.actorId,
          note: action.note || '店长协助完成',
          idempotencyKey: action.idempotencyKey,
        }, {
          requestId: request.id,
          effectiveRoleId: effectiveActor.roleId,
        })
      }
      return task
    })
  })
}
