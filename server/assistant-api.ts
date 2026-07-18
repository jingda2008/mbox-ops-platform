import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { assistantTurnRequestSchema } from '../src/shared/assistant-contracts.js'
import {
  effectiveDataScopeForEmployee,
  effectivePermissionIdsForEmployee,
  effectiveRoleIdsForEmployee,
} from '../src/shared/staff-access.js'
import { requireRequestActor } from './auth-context.js'
import { projectRuntimeStateForActor } from './bootstrap-projection.js'
import {
  AssistantConversationSessionError,
  type AssistantConversationStore,
} from './assistant-conversation-store.js'
import { AssistantPlannerError, type AssistantPlanner, type AssistantPlanningContext } from './assistant-planner.js'
import type { RateLimitStore } from './rate-limit.js'
import type { RuntimeRepository } from './repository.js'
import { CHINA_UTC_OFFSET, chinaDateTimeLocalValue } from '../src/shared/china-time.js'

const ASSISTANT_RATE_LIMIT = { scope: 'staff_assistant_turn', limit: 15, windowMs: 60_000 }

function redactSensitiveText(value: string) {
  return [...value]
    .filter((character) => {
      const code = character.charCodeAt(0)
      return code === 9 || code === 10 || code === 13 || code >= 32 && code !== 127
    })
    .join('')
    .replace(/\b(?:AIza|AQ\.)[A-Za-z0-9._-]{20,}\b/g, '[密钥已隐藏]')
    .replace(/((?:PIN|口令|密码|密钥|token|令牌)\s*[:：]?\s*)[^\s，。；]{4,}/giu, '$1[已隐藏]')
    .trim()
}

function commandHash(message: string) {
  return createHash('sha256').update(message).digest('hex')
}

function employeeName(state: ReturnType<typeof projectRuntimeStateForActor>, employeeId: string | null | undefined) {
  if (!employeeId) return null
  return state.employees.find((employee) => employee.id === employeeId)?.displayName ?? employeeId
}

function buildPlanningContext(
  state: Awaited<ReturnType<RuntimeRepository['read']>>,
  actor: ReturnType<typeof requireRequestActor>,
  page: { heading: string; capabilities: Array<{ id: string; label: string; command: string; description: string; risk: 'normal' | 'high'; disabled: boolean }> },
  now: number,
): AssistantPlanningContext {
  const projected = projectRuntimeStateForActor(state, actor)
  const employee = state.employees.find((item) => item.id === actor.actorId)!
  const roleIds = effectiveRoleIdsForEmployee(state, actor.actorId)
  const roleNames = roleIds.map((roleId) => state.config.roles.find((role) => role.id === roleId)?.name ?? roleId)
  return {
    actor: {
      id: actor.actorId,
      displayName: employee.displayName,
      roles: roleNames,
      permissions: effectivePermissionIdsForEmployee(state, actor.actorId),
      dataScope: effectiveDataScopeForEmployee(state, actor.actorId),
    },
    store: {
      name: state.store.name,
      businessDate: state.store.businessDate,
      timezone: state.store.timezone,
      currentTime: `${chinaDateTimeLocalValue(now)}:00${CHINA_UTC_OFFSET}`,
    },
    page: {
      heading: page.heading,
      capabilities: page.capabilities.filter((capability) => !capability.disabled),
    },
    live: {
      tables: projected.tables.slice(0, 80).map((table) => ({
        code: table.code,
        name: table.displayName,
        status: table.status,
        guests: table.guestCount,
        primaryEmployee: employeeName(projected, table.primaryEmployeeId),
      })),
      serviceTasks: projected.tasks
        .filter((task) => !task.archivedAt && !['completed', 'confirmed', 'cancelled'].includes(task.status))
        .slice(0, 40)
        .map((task) => ({
          id: task.id,
          table: projected.tables.find((table) => table.id === task.tableId)?.code ?? task.tableId,
          type: state.config.serviceTypes.find((type) => type.id === task.serviceTypeId)?.name ?? task.serviceTypeId,
          status: task.status,
          priority: task.priority,
          owner: employeeName(projected, task.ownerId),
        })),
      kdsTasks: projected.orderDomain.kdsTasks
        .filter((task) => task.status !== 'delivered')
        .slice(0, 40)
        .map((task) => ({
          id: task.id,
          table: task.tableCode ?? task.tableSessionId,
          item: task.itemName,
          quantity: task.quantity,
          station: task.stationId,
          status: task.status,
        })),
      performances: projected.songState.performanceSessions
        .filter((performance) => performance.businessDate === state.store.businessDate)
        .slice(0, 12)
        .map((performance) => ({
          id: performance.id,
          title: performance.title,
          status: performance.status,
          startsAt: performance.startsAt,
          endsAt: performance.endsAt,
          singers: performance.appearances.map((appearance) => ({
            name: projected.songState.singers.find((singer) => singer.id === appearance.singerId)?.displayName ?? appearance.singerId,
            startsAt: appearance.startsAt,
            endsAt: appearance.endsAt,
          })),
        })),
    },
  }
}

export interface AssistantRoutesOptions {
  repository: RuntimeRepository
  conversationStore: AssistantConversationStore
  rateLimitStore: RateLimitStore
  planner?: AssistantPlanner
  now?: () => number
}

export async function registerAssistantRoutes(app: FastifyInstance, options: AssistantRoutesOptions) {
  app.post('/api/assistant/turn', async (request, reply) => {
    const actor = requireRequestActor(request)
    if (!options.planner) {
      return reply.code(503).send({ code: 'ASSISTANT_DISABLED', message: '智能对话尚未启用，可以继续使用快速命令' })
    }
    const decision = await options.rateLimitStore.consume({
      ...ASSISTANT_RATE_LIMIT,
      key: `${actor.storeId}:${actor.actorId}`,
    })
    if (!decision.allowed) {
      return reply.code(429).send({
        code: 'ASSISTANT_RATE_LIMITED',
        message: '刚才的对话有点密集，请稍等再说',
        retryAfterMs: Math.max(0, decision.resetAt - Date.now()),
      })
    }
    const body = assistantTurnRequestSchema.parse(request.body)
    const message = redactSensitiveText(body.message)
    if (!message) return reply.code(400).send({ code: 'ASSISTANT_EMPTY_MESSAGE', message: '没有可处理的内容' })
    const now = options.now?.() ?? Date.now()
    const state = await options.repository.read()
    try {
      const session = await options.conversationStore.open({
        sessionId: body.sessionId,
        actorId: actor.actorId,
        businessDate: state.store.businessDate,
        now,
      })
      const replay = session.turns.find((turn) => turn.requestId === body.requestId)
      if (replay) {
        if (replay.userMessage !== message) {
          return reply.code(409).send({ code: 'ASSISTANT_REQUEST_CONFLICT', message: '同一个请求编号不能提交不同内容' })
        }
        return { ...replay.output, sessionId: session.id, model: replay.model, modelUsed: true, replayed: true }
      }
      const planning = await options.planner.plan({
        message,
        history: session.turns.map((turn) => ({
          userMessage: turn.userMessage,
          assistantReply: [
            turn.output.reply,
            turn.output.choices.length > 0 ? `可选项：${turn.output.choices.join('、')}` : '',
          ].filter(Boolean).join(' '),
        })),
        context: buildPlanningContext(state, actor, {
          heading: body.page.heading,
          capabilities: body.page.capabilities.map((capability) => ({
            ...capability,
            label: redactSensitiveText(capability.label),
            command: redactSensitiveText(capability.command),
            description: redactSensitiveText(capability.description),
          })),
        }, now),
      })
      const persisted = await options.conversationStore.record({
        sessionId: session.id,
        actorId: actor.actorId,
        requestId: body.requestId,
        userMessage: message,
        output: planning.output,
        model: planning.model,
        occurredAt: new Date(now).toISOString(),
      })
      if (persisted.userMessage !== message) {
        return reply.code(409).send({ code: 'ASSISTANT_REQUEST_CONFLICT', message: '同一个请求编号不能提交不同内容' })
      }
      await options.repository.mutate((working) => {
        working.auditEntries.push({
          id: `audit_${randomUUID()}`,
          actorId: actor.actorId,
          action: 'assistant.turn.proposed.v1',
          objectType: 'assistant_conversation',
          objectId: session.id,
          occurredAt: new Date(now).toISOString(),
          details: {
            requestId: body.requestId,
            messageHash: commandHash(message),
            kind: persisted.output.kind,
            stepCount: persisted.output.steps.length,
            model: planning.model,
            providerRequestId: planning.providerRequestId,
            inputTokens: planning.inputTokens,
            outputTokens: planning.outputTokens,
            executed: false,
          },
        })
        working.revision += 1
      })
      return {
        ...persisted.output,
        sessionId: session.id,
        model: planning.model,
        modelUsed: true,
        replayed: false,
      }
    } catch (error) {
      if (error instanceof AssistantConversationSessionError) {
        return reply.code(error.statusCode).send({ code: 'ASSISTANT_SESSION_INVALID', message: error.message })
      }
      if (error instanceof AssistantPlannerError) {
        request.log.warn({ actorId: actor.actorId, statusCode: error.statusCode }, 'assistant planning failed')
        return reply.code(error.statusCode).send({ code: 'ASSISTANT_PLANNING_FAILED', message: error.message })
      }
      throw error
    }
  })
}
