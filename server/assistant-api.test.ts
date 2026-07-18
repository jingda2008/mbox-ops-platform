import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import type { RequestActorContext } from '../src/shared/auth-contracts.js'
import { createSeedState } from './seed.js'
import { registerAssistantRoutes } from './assistant-api.js'
import { MemoryAssistantConversationStore } from './assistant-conversation-store.js'
import type { AssistantPlanner, AssistantPlanningRequest } from './assistant-planner.js'
import { MemoryRateLimitStore } from './rate-limit.js'
import type { RuntimeRepository } from './repository.js'

function repository(): RuntimeRepository & { snapshot: () => ReturnType<typeof createSeedState> } {
  let state = createSeedState()
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
    expect(captured?.context.store.currentTime).toBe('2026-07-18T20:00:00+08:00')
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
})
