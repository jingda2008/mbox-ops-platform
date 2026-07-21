import { describe, expect, it } from 'vitest'
import type { AssistantToolDescriptor } from '../src/shared/assistant-tool-contracts.js'
import { AssistantPlannerError, GeminiAssistantPlanner, type AssistantPlanningRequest } from './assistant-planner.js'

function tool(id: AssistantToolDescriptor['id']): AssistantToolDescriptor {
  const humanWorkflow = [
    'payment.refund.request',
    'payment.refund.approve',
    'benefit.approve',
    'commerce.authorization.approve',
  ].includes(id)
  const domain = id.startsWith('payment.') ? 'payment'
    : id.startsWith('benefit.') ? 'benefit'
      : id.startsWith('commerce.') ? 'commerce'
        : id === 'table.open' ? 'table' : 'service'
  const navigationId = domain === 'benefit' ? 'benefits'
    : domain === 'commerce' ? 'commerce' : 'payments'
  return {
    id,
    name: id,
    description: id,
    domain,
    executionMode: humanWorkflow ? 'human_workflow' : 'server_execute',
    risk: humanWorkflow ? 'high' : 'normal',
    requiredPermission: humanWorkflow ? id
      : id === 'table.open' ? 'table.open' : 'service.execute',
    argumentGuide: {},
    aliases: humanWorkflow ? ['申请退款', '审批退款'] : [],
    humanWorkflow: humanWorkflow ? {
      navigationId, instruction: '人工处理', resultGuard: 'AI不得代替人工审批',
      requiredAuditEvents: ['refund.requested.v1'], separationOfDuties: true,
    } : undefined,
  }
}

function planningInput(message = '今晚有什么安排'): AssistantPlanningRequest {
  return {
    message,
    history: [],
    context: {
      actor: {
        id: 'emp-lin', displayName: 'Tom', roles: ['主服务员'],
        permissions: ['table.open', 'service.execute'], dataScope: 'assigned_areas',
      },
      store: { name: 'M-BOX', businessDate: '2026-07-18', timezone: 'Asia/Shanghai', currentTime: '2026-07-18T12:00:00.000Z' },
      page: { heading: '全店现场', capabilities: [] },
      tools: [tool('table.open'), tool('service.task.schedule')],
      live: {
        tables: [], serviceTasks: [], kdsTasks: [], performances: [], operationalRisks: [], operationalHealth: {},
        dutyHandover: {
          generatedAt: '2026-07-18T12:00:00.000Z', businessDate: '2026-07-18', summary: '无待交接风险',
          detected: 0, active: 0, acknowledged: 0, deferred: 0, dismissed: 0, resolved: 0,
          averageAcknowledgeMinutes: null, oldestActiveMinutes: null,
        },
      },
    },
  }
}

describe('Gemini assistant planner', () => {
  it('asks for the actual party size before calling the model for open-table work', async () => {
    let modelCalled = false
    const planner = new GeminiAssistantPlanner({
      apiKey: 'test-key',
      model: 'gemini-3.5-flash',
      timeoutMs: 2_000,
      fetchImpl: async () => {
        modelCalled = true
        throw new Error('model must not be called')
      },
    })

    const result = await planner.plan(planningInput('L01开台'))

    expect(modelCalled).toBe(false)
    expect(result).toMatchObject({
      providerRequestId: null,
      inputTokens: null,
      outputTokens: null,
      output: {
        kind: 'clarification',
        reply: 'L01准备开台，请告诉我实际到店人数。',
        steps: [],
        choices: ['1位', '2位', '3位', '4位', '其他人数'],
      },
    })
  })

  it('creates an authoritative server tool plan for open-table commands with a party size', async () => {
    let modelCalled = false
    const planner = new GeminiAssistantPlanner({
      apiKey: 'test-key',
      model: 'gemini-3.5-flash',
      timeoutMs: 2_000,
      fetchImpl: async () => {
        modelCalled = true
        throw new Error('model must not be called')
      },
    })

    const result = await planner.plan(planningInput('给l01开台，实际到了4位客人'))

    expect(modelCalled).toBe(false)
    expect(result).toMatchObject({
      model: 'mbox-deterministic-operations-v1',
      output: {
        kind: 'plan',
        steps: [{ toolCall: { toolId: 'table.open', arguments: { tableCode: 'L01', partySize: 4 } } }],
      },
    })
  })

  it('uses the previous open-table question when the employee supplies only the party size', async () => {
    const planner = new GeminiAssistantPlanner({
      apiKey: 'test-key', model: 'gemini-3.5-flash', timeoutMs: 2_000,
      fetchImpl: async () => { throw new Error('model must not be called') },
    })
    const input = planningInput('4位')
    input.history = [{ userMessage: 'L01开台', assistantReply: 'L01准备开台，请告诉我实际到店人数。' }]

    await expect(planner.plan(input)).resolves.toMatchObject({
      output: {
        kind: 'plan',
        steps: [{ toolCall: { toolId: 'table.open', arguments: { tableCode: 'L01', partySize: 4 } } }],
      },
    })
  })

  it('creates a delayed named-employee service assignment without calling the model', async () => {
    let modelCalled = false
    const planner = new GeminiAssistantPlanner({
      apiKey: 'test-key', model: 'gemini-3.5-flash', timeoutMs: 2_000,
      fetchImpl: async () => {
        modelCalled = true
        throw new Error('model must not be called')
      },
    })

    const result = await planner.plan(planningInput('5分钟后让Tom给K2加水'))

    expect(modelCalled).toBe(false)
    expect(result).toMatchObject({
      model: 'mbox-deterministic-operations-v1',
      output: {
        kind: 'plan',
        steps: [{
          toolCall: {
            toolId: 'service.task.schedule',
            arguments: { tableCode: 'K2', serviceTypeId: '加水', delayMinutes: 5, assigneeEmployeeId: 'Tom' },
          },
        }],
      },
    })
  })

  it('keeps open-table and delayed service commands in the employee spoken order', async () => {
    const planner = new GeminiAssistantPlanner({
      apiKey: 'test-key', model: 'gemini-3.5-flash', timeoutMs: 2_000,
      fetchImpl: async () => { throw new Error('model must not be called') },
    })

    const result = await planner.plan(planningInput('给L04开台，到了4位客人，然后5分钟后让Tom给L04桌加水'))

    expect(result.output.steps).toHaveLength(2)
    expect(result.output.steps.map((step) => step.toolCall)).toEqual([
      { toolId: 'table.open', arguments: { tableCode: 'L04', partySize: 4 } },
      {
        toolId: 'service.task.schedule',
        arguments: { tableCode: 'L04', serviceTypeId: '加水', delayMinutes: 5, assigneeEmployeeId: 'Tom' },
      },
    ])
  })

  it('requests non-retained structured Interactions output and validates the plan', async () => {
    let requestBody: Record<string, unknown> | null = null
    let requestHeaders: Headers | null = null
    const planner = new GeminiAssistantPlanner({
      apiKey: 'secret-gemini-key',
      model: 'gemini-3.5-flash',
      timeoutMs: 5_000,
      fetchImpl: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body))
        requestHeaders = new Headers(init?.headers)
        return new Response(JSON.stringify({
          id: 'interaction-safe-001',
          status: 'completed',
          steps: [{
            type: 'model_output',
            content: [{
              type: 'text',
              text: JSON.stringify({
                kind: 'plan',
                reply: 'Tom，您好！我整理成开台计划，请先核对。',
                steps: [{ label: '打开现场', command: '打开现场桌台' }],
                choices: [],
              }),
            }],
          }],
          usage: { input_tokens: 120, output_tokens: 42 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      },
    })

    const result = await planner.plan(planningInput())

    expect(result).toMatchObject({
      model: 'gemini-3.5-flash',
      providerRequestId: 'interaction-safe-001',
      inputTokens: 120,
      outputTokens: 42,
      output: { kind: 'plan', reply: '我整理成开台计划，请先核对。', steps: [{ command: '打开现场桌台' }] },
    })
    expect(requestBody).toMatchObject({
      model: 'gemini-3.5-flash',
      store: false,
      response_format: { type: 'text', mime_type: 'application/json' },
    })
    expect(requestHeaders?.get('x-goog-api-key')).toBe('secret-gemini-key')
    expect(JSON.stringify(requestBody)).not.toContain('secret-gemini-key')
  })

  it('rewrites a model-suggested refund click into navigation-only human handling', async () => {
    const planner = new GeminiAssistantPlanner({
      apiKey: 'secret-gemini-key', model: 'gemini-3.5-flash', timeoutMs: 5_000,
      fetchImpl: async () => new Response(JSON.stringify({
        steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify({
          kind: 'plan', reply: '准备执行退款。',
          steps: [{ label: '批准退款', command: '点击批准并完成退款' }], choices: [],
        }) }] }],
      }), { status: 200 }),
    })
    const input = planningInput('把这杯酒退了')
    input.context.tools.push(tool('payment.refund.request'), tool('payment.refund.approve'))

    const result = await planner.plan(input)

    expect(result.output).toMatchObject({
      kind: 'plan',
      reply: expect.stringContaining('必须由人工核对并操作'),
      steps: [{ command: '打开收银/支付' }],
    })
    expect(result.output.steps[0]).not.toHaveProperty('toolCall')
  })

  it('routes discount approval to commerce authorization instead of member benefits', async () => {
    let modelCalled = false
    const planner = new GeminiAssistantPlanner({
      apiKey: 'test-key', model: 'gemini-3.5-flash', timeoutMs: 2_000,
      fetchImpl: async () => {
        modelCalled = true
        throw new Error('model must not be called')
      },
    })
    const input = planningInput('审批L01这桌的八折折扣')
    input.context.actor.permissions.push('benefit.approve', 'commerce.authorization.approve')
    input.context.tools.push(tool('benefit.approve'), tool('commerce.authorization.approve'))

    const result = await planner.plan(input)

    expect(modelCalled).toBe(false)
    expect(result.output).toMatchObject({
      kind: 'plan',
      steps: [{ command: '打开订单/KDS' }],
    })
  })

  it('clarifies whether an ambiguous cancellation is unpaid cancellation or paid refund', async () => {
    let modelCalled = false
    const planner = new GeminiAssistantPlanner({
      apiKey: 'test-key', model: 'gemini-3.5-flash', timeoutMs: 2_000,
      fetchImpl: async () => {
        modelCalled = true
        throw new Error('model must not be called')
      },
    })

    const result = await planner.plan(planningInput('L01这单退单'))

    expect(modelCalled).toBe(false)
    expect(result.output).toMatchObject({
      kind: 'clarification',
      choices: ['取消未付款订单', '申请已付款退款'],
    })
  })

  it('fails closed when the model returns schema-valid JSON with an unsafe shape', async () => {
    let calls = 0
    const planner = new GeminiAssistantPlanner({
      apiKey: 'secret-gemini-key',
      model: 'gemini-3.5-flash',
      timeoutMs: 5_000,
      fetchImpl: async () => {
        calls += 1
        return new Response(JSON.stringify({
          steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify({
            kind: 'plan', reply: '已经执行完成', steps: [], choices: [],
          }) }] }],
        }), { status: 200 })
      },
    })

    await expect(planner.plan(planningInput())).rejects.toEqual(expect.objectContaining<Partial<AssistantPlannerError>>({
      name: 'AssistantPlannerError',
      statusCode: 502,
    }))
    expect(calls).toBe(2)
  })

  it('accepts JSON wrapped by harmless model formatting without weakening schema validation', async () => {
    const planner = new GeminiAssistantPlanner({
      apiKey: 'secret-gemini-key',
      model: 'gemini-3.5-flash',
      timeoutMs: 5_000,
      fetchImpl: async () => new Response(JSON.stringify({
        steps: [{ type: 'model_output', content: [{ type: 'text', text: `\`\`\`json
${JSON.stringify({ kind: 'clarification', reply: '请选一桌。', steps: [], choices: ['L01', 'L02'] })}
\`\`\`` }] }],
      }), { status: 200 }),
    })

    await expect(planner.plan(planningInput())).resolves.toMatchObject({
      output: { kind: 'clarification', choices: ['L01', 'L02'] },
    })
  })
})
