import { describe, expect, it } from 'vitest'
import { AssistantPlannerError, GeminiAssistantPlanner } from './assistant-planner.js'

function planningInput() {
  return {
    message: 'L04来了四位客人，帮我开台',
    history: [],
    context: {
      actor: { id: 'emp-lin', displayName: 'Tom', roles: ['主服务员'], permissions: ['table.open'], dataScope: 'assigned_areas' },
      store: { name: 'M-BOX', businessDate: '2026-07-18', timezone: 'Asia/Shanghai', currentTime: '2026-07-18T12:00:00.000Z' },
      page: { heading: '全店现场', capabilities: [] },
      live: { tables: [], serviceTasks: [], kdsTasks: [], performances: [] },
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

    const result = await planner.plan({ ...planningInput(), message: 'L01开台' })

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
