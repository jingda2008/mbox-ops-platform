import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { assistantTurnRequestSchema, dutyManagerActionSchema, type DutyManagerIncident } from '../src/shared/assistant-contracts.js'
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
import { CHINA_UTC_OFFSET, chinaBusinessDateKey, chinaDateTimeLocalValue } from '../src/shared/china-time.js'
import {
  buildDutyManagerBriefing,
  buildDutyManagerHandover,
  collectDutyManagerRisks,
  reconcileDutyManagerIncidents,
} from './duty-manager.js'
import { isKdsTaskActiveForBusinessDate } from './operational-closure.js'
import { tableOperationsConfig } from './table-sessions.js'

const ASSISTANT_RATE_LIMIT = { scope: 'staff_assistant_turn', limit: 15, windowMs: 60_000 }

function dutyActionCapabilities(state: Awaited<ReturnType<RuntimeRepository['read']>>, actorId: string) {
  const permissions = new Set(effectivePermissionIdsForEmployee(state, actorId))
  return {
    canAcknowledge: permissions.has('dashboard.view') && (
      permissions.has('service.execute') || permissions.has('shift.manage') || permissions.has('audit.view')
    ),
    canManage: permissions.has('shift.manage') || permissions.has('audit.view'),
  }
}

async function reconcileAndRead(repository: RuntimeRepository, now: number) {
  await repository.mutate((working) => {
    if (!reconcileDutyManagerIncidents(working, now)) return
    working.revision += 1
  })
  return repository.read()
}

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
  const dutyBriefing = buildDutyManagerBriefing(projected, now, dutyActionCapabilities(state, actor.actorId))
  const dutyHandover = buildDutyManagerHandover(projected, now)
  const rolloverHour = tableOperationsConfig(projected).businessDayRolloverHour ?? 6
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
      businessDate: dutyBriefing.businessDate,
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
        .filter((task) => (
          !task.archivedAt
          && !['completed', 'confirmed', 'cancelled'].includes(task.status)
          && chinaBusinessDateKey(task.createdAt, rolloverHour) === dutyBriefing.businessDate
        ))
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
        .filter((task) => isKdsTaskActiveForBusinessDate(
          projected.orderDomain,
          task,
          dutyBriefing.businessDate,
          rolloverHour,
        ))
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
        .filter((performance) => performance.businessDate === dutyBriefing.businessDate)
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
      operationalRisks: dutyBriefing.risks,
      operationalHealth: {
        health: dutyBriefing.health,
        headline: dutyBriefing.headline,
        counts: dutyBriefing.counts,
      },
      dutyHandover,
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
  app.get('/api/assistant/briefing', async (request) => {
    const actor = requireRequestActor(request)
    const now = options.now?.() ?? Date.now()
    const state = await reconcileAndRead(options.repository, now)
    return buildDutyManagerBriefing(
      projectRuntimeStateForActor(state, actor), now, dutyActionCapabilities(state, actor.actorId),
    )
  })

  app.get('/api/assistant/handover', async (request) => {
    const actor = requireRequestActor(request)
    const now = options.now?.() ?? Date.now()
    const state = await reconcileAndRead(options.repository, now)
    return buildDutyManagerHandover(projectRuntimeStateForActor(state, actor), now)
  })

  app.post('/api/assistant/duty-actions', async (request, reply) => {
    const actor = requireRequestActor(request)
    const input = dutyManagerActionSchema.parse(request.body)
    const actionNote = input.note ? redactSensitiveText(input.note) : null
    if (input.action === 'dismiss_false_positive' && (!actionNote || actionNote.length < 2)) {
      return reply.code(400).send({ code: 'DUTY_DISMISS_REASON_REQUIRED', message: '误报复核原因不能只包含敏感信息' })
    }
    const now = options.now?.() ?? Date.now()
    const initialState = await reconcileAndRead(options.repository, now)
    const capabilities = dutyActionCapabilities(initialState, actor.actorId)
    if (!capabilities.canAcknowledge) {
      return reply.code(403).send({ code: 'DUTY_ACTION_FORBIDDEN', message: '当前岗位不能接管值班风险' })
    }
    if (input.action !== 'acknowledge' && !capabilities.canManage) {
      return reply.code(403).send({ code: 'DUTY_MANAGE_FORBIDDEN', message: '延后或误报需要值班管理权限' })
    }
    const projected = projectRuntimeStateForActor(initialState, actor)
    const visibleRisks = collectDutyManagerRisks(projected, now)
    const visibleRiskIds = new Set(visibleRisks.map((risk) => risk.id))
    if (input.riskIds.some((riskId) => !visibleRiskIds.has(riskId))) {
      return reply.code(404).send({ code: 'DUTY_RISK_NOT_VISIBLE', message: '风险已消失或不在当前岗位范围内，请刷新后重试' })
    }
    if (
      input.action === 'acknowledge' && !capabilities.canManage
      && visibleRisks.some((risk) => input.riskIds.includes(risk.id) && risk.category === 'system')
    ) {
      return reply.code(403).send({ code: 'DUTY_SYSTEM_RISK_FORBIDDEN', message: '系统级风险只能由值班管理人员接管' })
    }
    const activeIncidentRiskIds = new Set((initialState.dutyManagerIncidents ?? [])
      .filter((incident) => incident.status !== 'resolved')
      .map((incident) => incident.riskId))
    if (input.riskIds.some((riskId) => !activeIncidentRiskIds.has(riskId))) {
      return reply.code(409).send({ code: 'DUTY_INCIDENT_CLOSED', message: '值班事件已经关闭，请刷新后重试' })
    }

    const mutation = await options.repository.mutate((working) => {
      reconcileDutyManagerIncidents(working, now)
      const replay = working.auditEntries.find((entry) => (
        entry.action === 'duty.incident.action.v1'
        && entry.actorId === actor.actorId
        && entry.details.idempotencyKey === input.idempotencyKey
      ))
      if (replay) return { replayed: true }
      const nowIso = new Date(now).toISOString()
      const incidentCandidates = input.riskIds.map((riskId) => working.dutyManagerIncidents?.find((incident) => (
        incident.riskId === riskId && incident.status !== 'resolved'
      )))
      if (incidentCandidates.some((incident) => !incident)) return { replayed: false, closed: true }
      const incidents = incidentCandidates as DutyManagerIncident[]
      for (const incident of incidents) {
        if (input.action === 'acknowledge') {
          incident.status = 'acknowledged'
          incident.acknowledgedAt ??= nowIso
          incident.acknowledgedBy ??= actor.actorId
          incident.deferredUntil = null
        } else if (input.action === 'defer') {
          incident.status = 'deferred'
          incident.deferredAt = nowIso
          incident.deferredBy = actor.actorId
          incident.deferredUntil = new Date(now + input.deferMinutes! * 60_000).toISOString()
        } else {
          incident.status = 'dismissed'
          incident.dismissedAt = nowIso
          incident.dismissedBy = actor.actorId
          incident.dismissedReason = actionNote!
        }
      }
      working.auditEntries.push({
        id: `audit_${randomUUID()}`,
        actorId: actor.actorId,
        action: 'duty.incident.action.v1',
        objectType: 'duty_incident',
        objectId: incidents.map((incident) => incident.id).join(','),
        occurredAt: nowIso,
        details: {
          idempotencyKey: input.idempotencyKey,
          action: input.action,
          riskIds: input.riskIds,
          incidentIds: incidents.map((incident) => incident.id),
          deferMinutes: input.deferMinutes ?? null,
          note: actionNote,
        },
      })
      working.revision += 1
      return { replayed: false, closed: false }
    })
    if ('closed' in mutation && mutation.closed) {
      return reply.code(409).send({ code: 'DUTY_INCIDENT_CLOSED', message: '值班事件刚刚关闭，请刷新后重试' })
    }
    const state = await options.repository.read()
    const briefing = buildDutyManagerBriefing(
      projectRuntimeStateForActor(state, actor), now, dutyActionCapabilities(state, actor.actorId),
    )
    const message = input.action === 'acknowledge' ? '已记录接管，请继续处理到风险关闭。'
      : input.action === 'defer' ? `已延后${input.deferMinutes}分钟，到时会重新提醒。`
        : '已记录现场复核结果，这条风险不再提醒。'
    return { message, replayed: mutation.replayed, briefing }
  })

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
    const state = await reconcileAndRead(options.repository, now)
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
