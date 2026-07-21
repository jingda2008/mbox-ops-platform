import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import type { RequestActorContext } from '../src/shared/auth-contracts.js'
import { createSeedState } from './seed.js'
import { createServiceTask } from './domain.js'
import { registerAssistantRoutes } from './assistant-api.js'
import { MemoryAssistantConversationStore } from './assistant-conversation-store.js'
import { GeminiAssistantPlanner, type AssistantPlanner, type AssistantPlanningRequest } from './assistant-planner.js'
import { MemoryRateLimitStore } from './rate-limit.js'
import type { RuntimeRepository } from './repository.js'
import { applyScheduledOperations } from './operational-scheduler.js'
import { projectRuntimeStateForActor } from './bootstrap-projection.js'

function repository(): RuntimeRepository & { snapshot: () => ReturnType<typeof createSeedState> } {
  let state = createSeedState(new Date('2026-07-18T12:00:00.000Z'))
  return {
    init: async () => undefined,
    read: async () => structuredClone(state),
    mutate: async (mutation) => {
      const working = structuredClone(state)
      const result = await mutation(working)
      state = working
      return result
    },
    reset: async () => structuredClone(state),
    healthCheck: async () => ({ ready: true, repository: 'test', revision: state.revision }),
    close: async () => undefined,
    snapshot: () => structuredClone(state),
  }
}

function rateLimitStore() {
  return new MemoryRateLimitStore({
    usage: 'test', tenantId: 'tenant-test', storeId: 'mbox-lujiazui', hashSecret: 'a'.repeat(32),
  })
}

async function testApp(
  planner?: AssistantPlanner,
  actor: Pick<RequestActorContext, 'actorId' | 'roleId'> = { actorId: 'emp-lin', roleId: 'server' },
) {
  const app = Fastify()
  const runtimeRepository = repository()
  app.addHook('onRequest', async (request) => {
    request.mboxActor = {
      actorId: actor.actorId, storeId: 'mbox-lujiazui', roleId: actor.roleId, runtimeMode: 'test',
      authenticatedBy: 'local_header', sessionId: null, sessionExpiresAt: null,
    } satisfies RequestActorContext
  })
  await registerAssistantRoutes(app, {
    repository: runtimeRepository,
    conversationStore: new MemoryAssistantConversationStore(),
    rateLimitStore: rateLimitStore(),
    planner,
    now: () => Date.parse('2026-07-18T12:00:00.000Z'),
  })
  return { app, repository: runtimeRepository }
}

const payload = {
  requestId: '00000000-0000-4000-8000-000000000001',
  message: '我现在有什么任务',
  page: {
    heading: '服务员工作台',
    capabilities: [{
      id: 'navigation:tasks', label: '看看我现在要处理什么', command: '看看我现在要处理什么',
      description: '打开任务页', risk: 'normal', disabled: false,
    }],
  },
}

describe('assistant API', () => {
  it('builds role-scoped context, persists a bounded turn, and replays without another model call', async () => {
    let calls = 0
    let captured: AssistantPlanningRequest | null = null
    const planner: AssistantPlanner = {
      model: 'gemini-3.5-flash',
      plan: async (input) => {
        calls += 1
        captured = input
        return {
          output: { kind: 'answer', reply: '您当前没有待处理任务。', steps: [], choices: [] },
          model: 'gemini-3.5-flash', providerRequestId: 'interaction-001', inputTokens: 100, outputTokens: 20,
        }
      },
    }
    const { app, repository: runtimeRepository } = await testApp(planner)
    await runtimeRepository.mutate((state) => {
      for (const task of state.orderDomain.kdsTasks) task.queuedAt = '2026-07-17T12:00:00.000Z'
    })
    const first = await app.inject({ method: 'POST', url: '/api/assistant/turn', payload })
    const firstBody = first.json()
    const replay = await app.inject({
      method: 'POST', url: '/api/assistant/turn', payload: { ...payload, sessionId: firstBody.sessionId },
    })
    const conflict = await app.inject({
      method: 'POST', url: '/api/assistant/turn', payload: { ...payload, sessionId: firstBody.sessionId, message: '打开我的桌台' },
    })

    expect(first.statusCode).toBe(200)
    expect(firstBody).toMatchObject({ kind: 'answer', modelUsed: true, replayed: false })
    expect(replay.json()).toMatchObject({ kind: 'answer', replayed: true })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json()).toMatchObject({ code: 'ASSISTANT_REQUEST_CONFLICT' })
    expect(calls).toBe(1)
    expect(captured?.context.actor).toMatchObject({ displayName: 'Tom', dataScope: 'assigned_areas' })
    expect(captured?.context.actor.permissions).not.toContain('finance.view')
    expect(captured?.context.page.capabilities).toHaveLength(1)
    expect(captured?.context.tools.map((tool) => tool.id)).toContain('table.open')
    expect(captured?.context.store.currentTime).toBe('2026-07-18T20:00:00+08:00')
    expect(captured?.context.live.operationalHealth).toHaveProperty('health')
    expect(Array.isArray(captured?.context.live.operationalRisks)).toBe(true)
    expect(captured?.context.live.kdsTasks).toEqual([])
    expect(runtimeRepository.snapshot().auditEntries.at(-1)).toMatchObject({
      action: 'assistant.turn.proposed.v1',
      details: { executed: false, stepCount: 0, model: 'gemini-3.5-flash' },
    })
    expect(JSON.stringify(runtimeRepository.snapshot().auditEntries.at(-1))).not.toContain(payload.message)
    await app.close()
  })

  it('keeps clarification choices in bounded conversation context', async () => {
    const captured: AssistantPlanningRequest[] = []
    const planner: AssistantPlanner = {
      model: 'gemini-3.5-flash',
      plan: async (input) => {
        captured.push(input)
        return {
          output: captured.length === 1
            ? { kind: 'clarification', reply: '请选一桌。', steps: [], choices: ['休闲01 (L01)', '休闲02 (L02)'] }
            : { kind: 'answer', reply: 'L01当前没有未完成服务。', steps: [], choices: [] },
          model: 'gemini-3.5-flash', providerRequestId: `interaction-${captured.length}`, inputTokens: 80, outputTokens: 20,
        }
      },
    }
    const { app } = await testApp(planner)
    const first = await app.inject({
      method: 'POST', url: '/api/assistant/turn', payload: { ...payload, message: '帮我处理一桌客人' },
    })
    const second = await app.inject({
      method: 'POST', url: '/api/assistant/turn', payload: {
        ...payload,
        requestId: '00000000-0000-4000-8000-000000000002',
        sessionId: first.json().sessionId,
        message: '休闲01 (L01)',
      },
    })

    expect(second.statusCode).toBe(200)
    expect(captured[1]?.history[0]?.assistantReply).toContain('可选项：休闲01 (L01)、休闲02 (L02)')
    await app.close()
  })

  it('builds different live contexts for manager and bartender permissions', async () => {
    const contexts: AssistantPlanningRequest['context'][] = []
    const planner: AssistantPlanner = {
      model: 'gemini-3.5-flash',
      plan: async (input) => {
        contexts.push(input.context)
        return {
          output: { kind: 'answer', reply: '已按当前岗位范围查看。', steps: [], choices: [] },
          model: 'gemini-3.5-flash', providerRequestId: null, inputTokens: null, outputTokens: null,
        }
      },
    }
    const manager = await testApp(planner, { actorId: 'emp-chen', roleId: 'manager' })
    const bartender = await testApp(planner, { actorId: 'emp-qing', roleId: 'bartender' })
    await manager.app.inject({ method: 'POST', url: '/api/assistant/turn', payload })
    await bartender.app.inject({
      method: 'POST', url: '/api/assistant/turn', payload: { ...payload, requestId: '00000000-0000-4000-8000-000000000003' },
    })

    expect(contexts[0]?.actor).toMatchObject({ displayName: '李艳', dataScope: 'store' })
    expect(contexts[0]?.actor.permissions).toContain('finance.view')
    expect(contexts[1]?.actor).toMatchObject({ displayName: '冷言志', dataScope: 'store' })
    expect(contexts[1]?.actor.permissions).not.toContain('finance.view')
    expect(contexts[1]?.actor.permissions).toContain('kds.prepare')
    await manager.app.close()
    await bartender.app.close()
  })

  it('publishes one permission-scoped capability registry with locked human workflows', async () => {
    const { app, repository: runtimeRepository } = await testApp(undefined, { actorId: 'emp-chen', roleId: 'manager' })
    await runtimeRepository.mutate((state) => {
      const refund = state.config.assistantCapabilities?.find((item) => item.id === 'payment.refund.request')
      const openTable = state.config.assistantCapabilities?.find((item) => item.id === 'table.open')
      if (!refund || !openTable) throw new Error('测试能力配置缺失')
      refund.aliases = ['给客人退一下']
      openTable.enabled = false
    })

    const response = await app.inject({ method: 'GET', url: '/api/assistant/tools' })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().tools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'payment.refund.request', executionMode: 'human_workflow', risk: 'high',
        aliases: expect.arrayContaining(['给客人退一下']),
        humanWorkflow: expect.objectContaining({
          navigationId: 'payments', separationOfDuties: true,
          resultGuard: expect.stringContaining('AI不得提交'),
        }),
      }),
      expect.objectContaining({ id: 'service.task.create', executionMode: 'server_execute' }),
    ]))
    expect(response.json().tools.some((item: { id: string }) => item.id === 'table.open')).toBe(false)
    const blocked = await app.inject({ method: 'POST', url: '/api/assistant/tool-executions', payload: {
      executionId: '00000000-0000-4000-8000-000000000209',
      toolCall: { toolId: 'table.open', arguments: { tableCode: 'L04', partySize: 2 } },
    } })
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json()).toMatchObject({ code: 'ASSISTANT_TOOL_REJECTED' })
    expect(runtimeRepository.snapshot().tables.find((table) => table.id === 'table-l04')?.status).toBe('available')
    await app.close()
  })

  it('turns refund language into a human handoff without creating or executing a refund', async () => {
    const planner = new GeminiAssistantPlanner({
      apiKey: 'test-key', model: 'gemini-3.5-flash', timeoutMs: 2_000,
      fetchImpl: async () => { throw new Error('protected workflows must not call the model') },
    })
    const { app, repository: runtimeRepository } = await testApp(planner, { actorId: 'emp-chen', roleId: 'manager' })
    const before = runtimeRepository.snapshot().paymentDomain.refunds.length
    const response = await app.inject({ method: 'POST', url: '/api/assistant/turn', payload: {
      ...payload,
      requestId: '00000000-0000-4000-8000-000000000210',
      message: '帮客人申请退款',
    } })

    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({
      kind: 'plan', model: 'mbox-deterministic-operations-v1',
      reply: expect.stringContaining('人工核对'),
      steps: [{ command: '打开收银/支付' }],
    })
    expect(response.json().steps[0]).not.toHaveProperty('toolCall')
    expect(runtimeRepository.snapshot().paymentDomain.refunds).toHaveLength(before)
    expect(runtimeRepository.snapshot().auditEntries.filter((entry) => entry.action === 'assistant.tool.executed.v1')).toHaveLength(0)
    await app.close()
  })

  it('does not downgrade a refund approval command to a refund request permission', async () => {
    const planner = new GeminiAssistantPlanner({
      apiKey: 'test-key', model: 'gemini-3.5-flash', timeoutMs: 2_000,
      fetchImpl: async () => { throw new Error('protected workflows must not call the model') },
    })
    const { app } = await testApp(planner, { actorId: 'emp-cashier', roleId: 'cashier' })
    const response = await app.inject({ method: 'POST', url: '/api/assistant/turn', payload: {
      ...payload,
      requestId: '00000000-0000-4000-8000-000000000211',
      message: '批准这笔退款并执行',
    } })

    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({ kind: 'answer', steps: [], reply: expect.stringContaining('没有对应权限') })
    await app.close()
  })

  it('redacts labelled credentials before model planning and audit', async () => {
    let capturedMessage = ''
    const planner: AssistantPlanner = {
      model: 'gemini-3.5-flash',
      plan: async (input) => {
        capturedMessage = input.message
        return {
          output: { kind: 'answer', reply: '敏感信息不会用于操作。', steps: [], choices: [] },
          model: 'gemini-3.5-flash', providerRequestId: null, inputTokens: null, outputTokens: null,
        }
      },
    }
    const { app, repository: runtimeRepository } = await testApp(planner)
    const secretMessage = `PIN: 1234，密钥 AQ.${'x'.repeat(64)}`
    const response = await app.inject({
      method: 'POST', url: '/api/assistant/turn', payload: {
        ...payload, requestId: '00000000-0000-4000-8000-000000000004', message: secretMessage,
      },
    })

    expect(response.statusCode).toBe(200)
    expect(capturedMessage).not.toContain('1234')
    expect(capturedMessage).not.toContain('AQ.')
    expect(capturedMessage).toContain('[已隐藏]')
    expect(JSON.stringify(runtimeRepository.snapshot().auditEntries.at(-1))).not.toContain(secretMessage)
    await app.close()
  })

  it('fails explicitly when the model provider is disabled', async () => {
    const { app } = await testApp()
    const response = await app.inject({ method: 'POST', url: '/api/assistant/turn', payload })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ code: 'ASSISTANT_DISABLED' })
    await app.close()
  })

  it('returns a deterministic role-scoped duty briefing even when the model is disabled', async () => {
    const { app } = await testApp()
    const response = await app.inject({ method: 'GET', url: '/api/assistant/briefing' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      businessDate: expect.stringMatching(/^2026-07-\d{2}$/),
      counts: expect.objectContaining({ openServiceTasks: expect.any(Number) }),
      risks: expect.any(Array),
    })
    await app.close()
  })

  it('tracks manager acknowledgement, deferral and false-positive decisions idempotently', async () => {
    const { app, repository: runtimeRepository } = await testApp(undefined, { actorId: 'emp-chen', roleId: 'manager' })
    await runtimeRepository.mutate((state) => {
      const task = createServiceTask(state, {
        tableCode: 'L01', serviceTypeId: 'water', source: 'guest', note: '值班经理风险处置测试',
        idempotencyKey: 'assistant-duty-risk-source-0001', requestedBy: 'guest-test',
      })
      task.createdAt = '2026-07-18T11:00:00.000Z'
      task.updatedAt = task.createdAt
      task.warningAt = '2026-07-18T11:00:00.000Z'
      task.escalateAt = '2026-07-18T11:15:00.000Z'
      task.managerAt = '2026-07-18T11:30:00.000Z'
    })
    const initial = (await app.inject({ method: 'GET', url: '/api/assistant/briefing' })).json()
    const risk = initial.risks[0]
    expect(risk.sourceRiskIds.length).toBeGreaterThan(0)

    const acknowledgePayload = {
      idempotencyKey: '00000000-0000-4000-8000-000000000101',
      action: 'acknowledge',
      riskIds: risk.sourceRiskIds,
    }
    const acknowledged = await app.inject({ method: 'POST', url: '/api/assistant/duty-actions', payload: acknowledgePayload })
    const replayed = await app.inject({ method: 'POST', url: '/api/assistant/duty-actions', payload: acknowledgePayload })
    expect(acknowledged.statusCode).toBe(200)
    expect(acknowledged.json()).toMatchObject({ replayed: false, briefing: { counts: { acknowledgedIncidents: expect.any(Number) } } })
    expect(replayed.json()).toMatchObject({ replayed: true })

    const deferred = await app.inject({ method: 'POST', url: '/api/assistant/duty-actions', payload: {
      idempotencyKey: '00000000-0000-4000-8000-000000000102',
      action: 'defer', riskIds: risk.sourceRiskIds, deferMinutes: 10,
    } })
    expect(deferred.statusCode).toBe(200)
    expect(deferred.json().briefing.risks.flatMap((item: { sourceRiskIds: string[] }) => item.sourceRiskIds)).not.toContain(risk.sourceRiskIds[0])

    const dismissed = await app.inject({ method: 'POST', url: '/api/assistant/duty-actions', payload: {
      idempotencyKey: '00000000-0000-4000-8000-000000000103',
      action: 'dismiss_false_positive', riskIds: risk.sourceRiskIds, note: '现场复核确认误报',
    } })
    const handover = await app.inject({ method: 'GET', url: '/api/assistant/handover' })
    expect(dismissed.statusCode).toBe(200)
    expect(handover.json()).toMatchObject({ dismissed: expect.any(Number), detected: expect.any(Number) })
    expect(runtimeRepository.snapshot().auditEntries.filter((entry) => entry.action === 'duty.incident.action.v1')).toHaveLength(3)
    await app.close()
  })

  it('lets frontline staff acknowledge visible risks but blocks manager-only deferral', async () => {
    const { app, repository: runtimeRepository } = await testApp(undefined, { actorId: 'emp-lin', roleId: 'server' })
    await runtimeRepository.mutate((state) => {
      const task = createServiceTask(state, { tableCode: 'L01', serviceTypeId: 'water', source: 'guest', note: '加水' })
      task.createdAt = '2026-07-18T11:50:00.000Z'
      task.updatedAt = task.createdAt
      task.warningAt = '2026-07-18T11:55:00.000Z'
      task.escalateAt = '2026-07-18T11:56:00.000Z'
      task.managerAt = '2026-07-18T11:57:00.000Z'
      state.revision += 1
    })
    const briefing = (await app.inject({ method: 'GET', url: '/api/assistant/briefing' })).json()
    const risk = briefing.risks.find((item: { category: string }) => item.category !== 'system')
    expect(risk).toBeTruthy()

    const acknowledged = await app.inject({ method: 'POST', url: '/api/assistant/duty-actions', payload: {
      idempotencyKey: '00000000-0000-4000-8000-000000000105',
      action: 'acknowledge', riskIds: risk.sourceRiskIds,
    } })
    expect(acknowledged.statusCode).toBe(200)
    expect(acknowledged.json()).toMatchObject({
      replayed: false,
      briefing: { risks: expect.arrayContaining([expect.objectContaining({ handledByName: 'Tom' })]) },
    })

    const deferred = await app.inject({ method: 'POST', url: '/api/assistant/duty-actions', payload: {
      idempotencyKey: '00000000-0000-4000-8000-000000000104',
      action: 'defer', riskIds: risk.sourceRiskIds, deferMinutes: 10,
    } })
    expect(deferred.statusCode).toBe(403)
    expect(deferred.json()).toMatchObject({ code: 'DUTY_MANAGE_FORBIDDEN' })
    await app.close()
  })

  it('rate limits model turns per employee without affecting other routes', async () => {
    const planner: AssistantPlanner = {
      model: 'gemini-3.5-flash',
      plan: async () => ({
        output: { kind: 'answer', reply: '收到。', steps: [], choices: [] },
        model: 'gemini-3.5-flash', providerRequestId: null, inputTokens: null, outputTokens: null,
      }),
    }
    const { app } = await testApp(planner)
    const responses = []
    for (let index = 1; index <= 16; index += 1) {
      responses.push(await app.inject({
        method: 'POST', url: '/api/assistant/turn', payload: {
          ...payload,
          requestId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        },
      }))
    }

    expect(responses.slice(0, 15).every((response) => response.statusCode === 200)).toBe(true)
    expect(responses[15]?.statusCode).toBe(429)
    expect(responses[15]?.json()).toMatchObject({ code: 'ASSISTANT_RATE_LIMITED' })
    await app.close()
  })

  it('executes supported AI tools on the server and returns real state evidence', async () => {
    const { app, repository: runtimeRepository } = await testApp(undefined, { actorId: 'emp-lin', roleId: 'server' })
    const opened = await app.inject({
      method: 'POST', url: '/api/assistant/tool-executions', payload: {
        executionId: '00000000-0000-4000-8000-000000000301',
        toolCall: { toolId: 'table.open', arguments: { tableCode: 'L04', partySize: 4 } },
      },
    })
    expect(opened.statusCode).toBe(200)
    expect(opened.json()).toMatchObject({ status: 'completed', objectId: 'table-l04', replayed: false })
    expect(runtimeRepository.snapshot().tables.find((table) => table.id === 'table-l04')).toMatchObject({
      status: 'occupied', guestCount: 4,
    })

    const created = await app.inject({
      method: 'POST', url: '/api/assistant/tool-executions', payload: {
        executionId: '00000000-0000-4000-8000-000000000302',
        toolCall: { toolId: 'service.task.create', arguments: { tableCode: 'L04', serviceTypeId: 'water', note: '补两杯水' } },
      },
    })
    expect(created.statusCode).toBe(200)
    const taskId = created.json().objectId as string
    for (const [index, toolId] of ['service.task.accept', 'service.task.arrive', 'service.task.complete'].entries()) {
      const response = await app.inject({
        method: 'POST', url: '/api/assistant/tool-executions', payload: {
          executionId: `00000000-0000-4000-8000-${String(303 + index).padStart(12, '0')}`,
          toolCall: { toolId, arguments: { taskId, note: toolId.endsWith('complete') ? '已经补水' : '' } },
        },
      })
      expect(response.statusCode, response.body).toBe(200)
    }
    expect(runtimeRepository.snapshot().tasks.find((task) => task.id === taskId)).toMatchObject({
      status: 'confirmed', resolution: '已经补水',
    })
    expect(runtimeRepository.snapshot().auditEntries.filter((entry) => entry.action === 'assistant.tool.executed.v1')).toHaveLength(5)
    await app.close()
  })

  it('lets a manager schedule a named employee task and dispatches it only when due', async () => {
    const { app, repository: runtimeRepository } = await testApp(undefined, { actorId: 'emp-chen', roleId: 'manager' })
    const scheduled = await app.inject({
      method: 'POST', url: '/api/assistant/tool-executions', payload: {
        executionId: '00000000-0000-4000-8000-000000000320',
        toolCall: {
          toolId: 'service.task.schedule',
          arguments: {
            tableCode: 'L01', serviceTypeId: '加水', delayMinutes: 5, assigneeEmployeeId: 'Tom',
          },
        },
      },
    })

    expect(scheduled.statusCode, scheduled.body).toBe(200)
    expect(scheduled.json()).toMatchObject({
      status: 'completed',
      evidence: {
        verified: true, outcome: 'scheduled', tableCode: 'L01',
        scheduledAt: '2026-07-18T12:05:00.000Z', assigneeEmployeeId: 'emp-lin', assigneeName: 'Tom',
      },
    })
    const executionId = scheduled.json().objectId as string
    const scheduledTriggerId = `${executionId}:dispatch_service`
    expect(runtimeRepository.snapshot().tasks.some((task) => task.triggerId === scheduledTriggerId)).toBe(false)

    await runtimeRepository.mutate((state) => {
      applyScheduledOperations(state, new Date('2026-07-18T12:04:59.999Z'))
    })
    expect(runtimeRepository.snapshot().tasks.some((task) => task.triggerId === scheduledTriggerId)).toBe(false)

    await runtimeRepository.mutate((state) => {
      applyScheduledOperations(state, new Date('2026-07-18T12:05:00.000Z'))
    })
    const task = runtimeRepository.snapshot().tasks.find((candidate) => candidate.triggerId === scheduledTriggerId)
    expect(task).toMatchObject({
      tableId: 'table-l01', serviceTypeId: 'water', status: 'pending', ownerId: 'emp-lin',
      targetEmployeeIdsSnapshot: ['emp-lin'],
    })
    expect(task?.notifiedEmployeeIds).toContain('emp-lin')
    const tomView = projectRuntimeStateForActor(runtimeRepository.snapshot(), {
      actorId: 'emp-lin', roleId: 'server', storeId: 'mbox-lujiazui', runtimeMode: 'test',
      authenticatedBy: 'local_header', sessionId: null, sessionExpiresAt: null,
    })
    expect(tomView.tasks.find((candidate) => candidate.id === task?.id)).toMatchObject({
      ownerId: 'emp-lin', status: 'pending', serviceTypeId: 'water',
    })
    expect(runtimeRepository.snapshot().auditEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: 'assistant.service_task.scheduled.v1', actorId: 'emp-chen', objectId: executionId,
      }),
      expect.objectContaining({ action: 'sop.execution.step_triggered.v1', objectId: executionId }),
    ]))
    await app.close()
  })

  it('runs the full manager conversation, authoritative open-table, and delayed Tom assignment flow', async () => {
    const planner = new GeminiAssistantPlanner({
      apiKey: 'test-key', model: 'gemini-3.5-flash', timeoutMs: 2_000,
      fetchImpl: async () => { throw new Error('core operational commands must not call the model') },
    })
    const { app, repository: runtimeRepository } = await testApp(planner, { actorId: 'emp-chen', roleId: 'manager' })
    const openTurn = await app.inject({
      method: 'POST', url: '/api/assistant/turn', payload: {
        ...payload,
        requestId: '00000000-0000-4000-8000-000000000330',
        message: '给L04开台，实际到了4位客人',
      },
    })
    expect(openTurn.statusCode, openTurn.body).toBe(200)
    expect(openTurn.json()).toMatchObject({
      kind: 'plan', model: 'mbox-deterministic-operations-v1',
      steps: [{ toolCall: { toolId: 'table.open', arguments: { tableCode: 'L04', partySize: 4 } } }],
    })
    const openExecution = await app.inject({
      method: 'POST', url: '/api/assistant/tool-executions', payload: {
        executionId: '00000000-0000-4000-8000-000000000331',
        toolCall: openTurn.json().steps[0].toolCall,
      },
    })
    expect(openExecution.statusCode, openExecution.body).toBe(200)
    expect(openExecution.json()).toMatchObject({
      evidence: { verified: true, outcome: 'executed', tableCode: 'L04', tableStatus: 'occupied', guestCount: 4 },
    })

    const scheduleTurn = await app.inject({
      method: 'POST', url: '/api/assistant/turn', payload: {
        ...payload,
        requestId: '00000000-0000-4000-8000-000000000332',
        message: '5分钟后让Tom给L04加水',
      },
    })
    expect(scheduleTurn.statusCode, scheduleTurn.body).toBe(200)
    expect(scheduleTurn.json()).toMatchObject({
      kind: 'plan', model: 'mbox-deterministic-operations-v1',
      steps: [{ toolCall: {
        toolId: 'service.task.schedule',
        arguments: { tableCode: 'L04', serviceTypeId: '加水', delayMinutes: 5, assigneeEmployeeId: 'Tom' },
      } }],
    })
    const scheduleExecution = await app.inject({
      method: 'POST', url: '/api/assistant/tool-executions', payload: {
        executionId: '00000000-0000-4000-8000-000000000333',
        toolCall: scheduleTurn.json().steps[0].toolCall,
      },
    })
    expect(scheduleExecution.statusCode, scheduleExecution.body).toBe(200)
    await runtimeRepository.mutate((state) => {
      applyScheduledOperations(state, new Date('2026-07-18T12:05:00.000Z'))
    })
    const scheduledTask = runtimeRepository.snapshot().tasks.find((task) => (
      task.triggerId === `${scheduleExecution.json().objectId}:dispatch_service`
    ))
    expect(scheduledTask).toMatchObject({ tableId: 'table-l04', ownerId: 'emp-lin', status: 'pending' })
    await app.close()
  })

  it('blocks frontline staff from assigning another employee through the AI tool bus', async () => {
    const { app, repository: runtimeRepository } = await testApp(undefined, { actorId: 'emp-lin', roleId: 'server' })
    const response = await app.inject({
      method: 'POST', url: '/api/assistant/tool-executions', payload: {
        executionId: '00000000-0000-4000-8000-000000000321',
        toolCall: {
          toolId: 'service.task.schedule',
          arguments: {
            tableCode: 'I01', serviceTypeId: '加水', delayMinutes: 5, assigneeEmployeeId: 'Jerry',
          },
        },
      },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ code: 'ASSISTANT_TOOL_REJECTED' })
    expect(response.json().message).toContain('只有值班管理岗位可以指派其他员工')
    expect(runtimeRepository.snapshot().sopExecutions).toHaveLength(0)
    await app.close()
  })

  it('replays an AI execution idempotently and rejects a changed request', async () => {
    const { app } = await testApp(undefined, { actorId: 'emp-lin', roleId: 'server' })
    const payload = {
      executionId: '00000000-0000-4000-8000-000000000310',
      toolCall: { toolId: 'service.task.create', arguments: { tableCode: 'L01', serviceTypeId: 'water' } },
    }
    expect((await app.inject({ method: 'POST', url: '/api/assistant/tool-executions', payload })).json()).toMatchObject({ replayed: false })
    expect((await app.inject({ method: 'POST', url: '/api/assistant/tool-executions', payload })).json()).toMatchObject({ replayed: true })
    const conflict = await app.inject({
      method: 'POST', url: '/api/assistant/tool-executions', payload: {
        ...payload, toolCall: { ...payload.toolCall, arguments: { tableCode: 'L02', serviceTypeId: 'water' } },
      },
    })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json()).toMatchObject({ code: 'ASSISTANT_TOOL_REJECTED' })
    await app.close()
  })
})
