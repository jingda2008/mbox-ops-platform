import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import type { RequestActorContext } from '../src/shared/auth-contracts.js'
import { englishReadingAliases } from '../src/shared/voice-entity-aliases.js'
import { MemoryAssistantConversationStore } from './assistant-conversation-store.js'
import { registerAssistantRoutes } from './assistant-api.js'
import { availableAssistantCapabilities } from './assistant-capability-registry.js'
import {
  QwenAssistantPlanner,
  type AssistantPlanningRequest,
} from './assistant-planner.js'
import { applyScheduledOperations } from './operational-scheduler.js'
import { MemoryRateLimitStore } from './rate-limit.js'
import type { RuntimeRepository } from './repository.js'
import { createSeedState } from './seed.js'

const NOW = Date.parse('2026-07-18T12:00:00.000Z')

function repository(): RuntimeRepository & { snapshot: () => ReturnType<typeof createSeedState> } {
  let state = createSeedState(new Date(NOW))
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

function managerPlanningInput(message: string): AssistantPlanningRequest {
  const state = createSeedState(new Date(NOW))
  return {
    message,
    history: [],
    context: {
      actor: {
        id: 'emp-chen',
        displayName: '李艳',
        roles: ['店长'],
        permissions: ['table.open', 'table.manage', 'table.close', 'service.execute', 'shift.manage'],
        dataScope: 'store',
      },
      store: {
        name: state.store.name,
        businessDate: state.store.businessDate,
        timezone: state.store.timezone,
        currentTime: '2026-07-18T20:00:00+08:00',
      },
      page: { heading: 'AI值班经理', capabilities: [] },
      tools: availableAssistantCapabilities(state, 'emp-chen'),
      live: {
        employees: state.employees.filter((employee) => employee.status === 'active').map((employee) => ({
          id: employee.id,
          name: employee.displayName,
          aliases: englishReadingAliases(employee.displayName),
          online: employee.online,
          paused: employee.paused,
        })),
        tables: state.tables.map((table) => ({
          code: table.code,
          name: table.displayName,
          status: table.status,
          guests: table.guestCount,
        })),
        serviceTasks: [],
        kdsTasks: [],
        performances: [],
        operationalRisks: [],
        operationalHealth: {},
        dutyHandover: {
          generatedAt: '2026-07-18T12:00:00.000Z',
          businessDate: state.store.businessDate,
          summary: '无待交接风险',
          detected: 0,
          active: 0,
          acknowledged: 0,
          deferred: 0,
          dismissed: 0,
          resolved: 0,
          averageAcknowledgeMinutes: null,
          oldestActiveMinutes: null,
        },
      },
    },
  }
}

function deterministicPlanner() {
  let modelCalls = 0
  const planner = new QwenAssistantPlanner({
    apiKey: 'test-key',
    model: 'qwen-test',
    timeoutMs: 2_000,
    endpoint: 'https://example.invalid/chat/completions',
    fetchImpl: async () => {
      modelCalls += 1
      throw new Error('deterministic command unexpectedly called the model')
    },
  })
  return { planner, modelCalls: () => modelCalls }
}

async function testApp(
  actor: Pick<RequestActorContext, 'actorId' | 'roleId'> = { actorId: 'emp-chen', roleId: 'manager' },
) {
  const app = Fastify()
  const runtimeRepository = repository()
  app.addHook('onRequest', async (request) => {
    request.mboxActor = {
      actorId: actor.actorId,
      roleId: actor.roleId,
      storeId: 'mbox-lujiazui',
      runtimeMode: 'test',
      authenticatedBy: 'local_header',
      sessionId: null,
      sessionExpiresAt: null,
    } satisfies RequestActorContext
  })
  const { planner } = deterministicPlanner()
  await registerAssistantRoutes(app, {
    repository: runtimeRepository,
    conversationStore: new MemoryAssistantConversationStore(),
    rateLimitStore: new MemoryRateLimitStore({
      usage: 'test',
      tenantId: 'tenant-test',
      storeId: 'mbox-lujiazui',
      hashSecret: 'm'.repeat(32),
    }),
    planner,
    now: () => NOW,
  })
  return { app, repository: runtimeRepository }
}

function turnPayload(message: string, suffix: number) {
  return {
    requestId: `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`,
    message,
    page: { heading: 'AI值班经理', capabilities: [] },
  }
}

describe('店长AI命令识别验收', () => {
  const openTableCases = [
    ['给L04开台，实际到了4位客人', 'L04', 4],
    ['l04开台4人', 'L04', 4],
    ['休闲04开台，来了四位', 'L04', 4],
    ['开台休闲04，实际三个人', 'L04', 3],
    ['给I03开台，两名客人', 'I03', 2],
    ['社交B开台十位客人', 'S02', 10],
  ] as const

  for (const [message, tableCode, partySize] of openTableCases) {
    it(`识别开台命令：${message}`, async () => {
      const { planner, modelCalls } = deterministicPlanner()
      const result = await planner.plan(managerPlanningInput(message))
      expect(modelCalls()).toBe(0)
      expect(result.output).toMatchObject({
        kind: 'plan',
        steps: [{ toolCall: { toolId: 'table.open', arguments: { tableCode, partySize } } }],
      })
    })
  }

  const missingPartyCases = ['L04开台', '给休闲04开台', 'I03开台，客人到了']
  for (const message of missingPartyCases) {
    it(`人数缺失时追问且不默认：${message}`, async () => {
      const { planner, modelCalls } = deterministicPlanner()
      const result = await planner.plan(managerPlanningInput(message))
      expect(modelCalls()).toBe(0)
      expect(result.output).toMatchObject({
        kind: 'clarification',
        steps: [],
        reply: expect.stringContaining('实际到店人数'),
      })
    })
  }

  it('连续对话只补人数时沿用上一轮桌台', async () => {
    const { planner } = deterministicPlanner()
    const input = managerPlanningInput('4位')
    input.history = [{ userMessage: '休闲04开台', assistantReply: '请告诉我实际到店人数。' }]
    await expect(planner.plan(input)).resolves.toMatchObject({
      output: {
        kind: 'plan',
        steps: [{ toolCall: { toolId: 'table.open', arguments: { tableCode: 'L04', partySize: 4 } } }],
      },
    })
  })

  it('不存在的桌台必须追问，不能生成可执行工具', async () => {
    const { planner } = deterministicPlanner()
    const result = await planner.plan(managerPlanningInput('X99开台4人'))
    expect(result.output).toMatchObject({ kind: 'clarification', steps: [] })
    expect(result.output.reply).toContain('没有找到X99桌')
  })

  const scheduledServiceCases = [
    ['5分钟后让Tom给L01加水', 'L01', 'water', 5, 'emp-lin', undefined],
    ['五分钟后让汤姆给休闲01加水', 'L01', 'water', 5, 'emp-lin', undefined],
    ['让Jerry给互动01加冰块', 'I01', 'ice', 0, 'emp-wu', undefined],
    ['十分钟后安排Tyke为社交A协助点单', 'S01', 'order-help', 10, 'emp-jie', undefined],
    ['15分钟后让Tom给卡座A买单', 'B01', 'bill', 15, 'emp-lin', undefined],
    ['1分钟后让tom给卡座a上两杯柠檬冰水', 'B01', 'water', 1, 'emp-lin', '两杯柠檬冰水'],
    ['半小时后让Tom给L01送生日小礼物', 'L01', 'birthday', 30, 'emp-lin', '生日小礼物'],
  ] as const

  for (const [message, tableCode, serviceTypeId, delayMinutes, employeeId, note] of scheduledServiceCases) {
    it(`识别定时或立即指派：${message}`, async () => {
      const { planner, modelCalls } = deterministicPlanner()
      const result = await planner.plan(managerPlanningInput(message))
      expect(modelCalls()).toBe(0)
      expect(result.output).toMatchObject({
        kind: 'plan',
        steps: [{
          toolCall: {
            toolId: 'service.task.schedule',
            arguments: {
              tableCode,
              serviceTypeId,
              delayMinutes,
              assigneeEmployeeId: employeeId,
              ...(note ? { note } : {}),
            },
          },
        }],
      })
    })
  }

  const directServiceCases = [
    ['B01加水', 'B01', 'water'],
    ['给卡座A送两杯柠檬水', 'B01', 'water'],
    ['互动01需要冰块', 'I01', 'ice'],
    ['请为休闲01安排协助点单', 'L01', 'order-help'],
    ['社交A客人要买单', 'S01', 'bill'],
    ['卡座A客人投诉服务慢', 'B01', 'complaint'],
    ['给休闲01安排生日服务', 'L01', 'birthday'],
  ] as const

  for (const [message, tableCode, serviceTypeId] of directServiceCases) {
    it(`识别无指定员工的现场服务：${message}`, async () => {
      const { planner, modelCalls } = deterministicPlanner()
      const result = await planner.plan(managerPlanningInput(message))
      expect(modelCalls()).toBe(0)
      expect(result.output).toMatchObject({
        kind: 'plan',
        steps: [{ toolCall: { toolId: 'service.task.create', arguments: { tableCode, serviceTypeId } } }],
      })
    })
  }

  it('员工名称无法匹配时给出当班候选，不能猜人', async () => {
    const { planner } = deterministicPlanner()
    const result = await planner.plan(managerPlanningInput('5分钟后让小王给L01加水'))
    expect(result.output).toMatchObject({ kind: 'clarification', steps: [] })
    expect(result.output.reply).toContain('没有找到“小王”')
  })

  it('员工不在可接单状态时要求改派', async () => {
    const { planner } = deterministicPlanner()
    const input = managerPlanningInput('5分钟后让Tom给L01加水')
    const tom = input.context.live.employees.find((employee) => employee.id === 'emp-lin')!
    tom.paused = true
    const result = await planner.plan(input)
    expect(result.output).toMatchObject({ kind: 'clarification', steps: [] })
    expect(result.output.reply).toContain('不在可接单状态')
  })

  it('超过24小时的定时任务必须追问', async () => {
    const { planner } = deterministicPlanner()
    const result = await planner.plan(managerPlanningInput('一千五百分钟后让Tom给L01加水'))
    expect(result.output).toMatchObject({ kind: 'clarification', steps: [] })
    expect(result.output.reply).toContain('最长24小时')
  })

  it('一句话可按顺序生成开台和定时服务两步', async () => {
    const { planner } = deterministicPlanner()
    const result = await planner.plan(managerPlanningInput('休闲04开台4人，然后5分钟后让Tom给休闲04加水'))
    expect(result.output.steps.map((step) => step.toolCall?.toolId)).toEqual([
      'table.open',
      'service.task.schedule',
    ])
  })

  const taskActionCases = [
    ['接下B01加水任务', 'service.task.accept'],
    ['B01加水已经到桌', 'service.task.arrive'],
    ['B01加水任务完成', 'service.task.complete'],
  ] as const

  for (const [message, toolId] of taskActionCases) {
    it(`识别服务任务状态命令：${message}`, async () => {
      const { planner, modelCalls } = deterministicPlanner()
      const input = managerPlanningInput(message)
      input.context.live.serviceTasks = [{
        id: 'task-b01-water-001',
        table: 'B01',
        type: '加水',
        status: 'pending',
        owner: 'Tom',
      }]
      const result = await planner.plan(input)
      expect(modelCalls()).toBe(0)
      expect(result.output).toMatchObject({
        kind: 'plan',
        steps: [{ toolCall: { toolId, arguments: { taskId: 'task-b01-water-001' } } }],
      })
    })
  }

  it('同桌多条任务时必须让店长选择，不能随便完成一条', async () => {
    const { planner } = deterministicPlanner()
    const input = managerPlanningInput('B01任务完成')
    input.context.live.serviceTasks = [
      { id: 'task-b01-water-001', table: 'B01', type: '加水', status: 'pending', owner: 'Tom' },
      { id: 'task-b01-ice-001', table: 'B01', type: '冰块/柠檬', status: 'pending', owner: 'Tom' },
    ]
    const result = await planner.plan(input)
    expect(result.output).toMatchObject({ kind: 'clarification', steps: [] })
    expect(result.output.choices).toHaveLength(2)
  })

  it('没有对应任务时明确提示，不生成虚假完成动作', async () => {
    const { planner } = deterministicPlanner()
    const result = await planner.plan(managerPlanningInput('B01加水任务完成'))
    expect(result.output).toMatchObject({
      kind: 'clarification',
      steps: [],
      choices: ['打开当前任务', '说出桌号和服务内容'],
    })
  })

  const humanWorkflowCases = [
    ['帮客人申请退款', '打开收银/支付'],
    ['批准这笔退款并执行', '打开收银/支付'],
    ['登记POS刷卡收款', '打开收银/支付'],
    ['确认现金到账', '打开收银/支付'],
    ['现在做日结关账', '打开收银/支付'],
    ['批准库存盘亏', '打开库存/存酒'],
    ['审批会员权益赠送', '打开会员权益'],
    ['审批L01八折折扣', '打开订单/KDS'],
    ['给L01结台', '打开现场'],
    ['把L01转到L04', '打开现场'],
  ] as const

  for (const [message, command] of humanWorkflowCases) {
    it(`高风险命令只转人工：${message}`, async () => {
      const { planner, modelCalls } = deterministicPlanner()
      const result = await planner.plan(managerPlanningInput(message))
      expect(modelCalls()).toBe(0)
      expect(result.output).toMatchObject({
        kind: 'plan',
        steps: [{ command }],
      })
      expect(result.output.steps[0]).not.toHaveProperty('toolCall')
      expect(result.output.reply).toContain('人工')
    })
  }
})

describe('店长AI命令真实执行验收', () => {
  it('桌台名称开台后必须返回真实桌台状态证据', async () => {
    const { app, repository: runtimeRepository } = await testApp()
    const turn = await app.inject({
      method: 'POST',
      url: '/api/assistant/turn',
      payload: turnPayload('休闲04开台4人', 701),
    })
    const execution = await app.inject({
      method: 'POST',
      url: '/api/assistant/tool-executions',
      payload: {
        executionId: '00000000-0000-4000-8000-000000000702',
        toolCall: turn.json().steps[0].toolCall,
      },
    })
    expect(execution.statusCode, execution.body).toBe(200)
    expect(execution.json()).toMatchObject({
      evidence: {
        verified: true,
        outcome: 'executed',
        tableCode: 'L04',
        tableStatus: 'occupied',
        guestCount: 4,
      },
    })
    expect(runtimeRepository.snapshot().tables.find((table) => table.id === 'table-l04')).toMatchObject({
      status: 'occupied',
      guestCount: 4,
    })
    await app.close()
  })

  it('人数缺失时不能改变桌台状态', async () => {
    const { app, repository: runtimeRepository } = await testApp()
    const before = runtimeRepository.snapshot().tables.find((table) => table.id === 'table-l04')
    const turn = await app.inject({
      method: 'POST',
      url: '/api/assistant/turn',
      payload: turnPayload('休闲04开台', 703),
    })
    expect(turn.json()).toMatchObject({ kind: 'clarification', steps: [] })
    expect(runtimeRepository.snapshot().tables.find((table) => table.id === 'table-l04')).toEqual(before)
    await app.close()
  })

  it('中文员工别名可定时派单，到点前不出现，到点后Tom可见', async () => {
    const { app, repository: runtimeRepository } = await testApp()
    const turn = await app.inject({
      method: 'POST',
      url: '/api/assistant/turn',
      payload: turnPayload('5分钟后让汤姆给卡座A加水', 704),
    })
    const execution = await app.inject({
      method: 'POST',
      url: '/api/assistant/tool-executions',
      payload: {
        executionId: '00000000-0000-4000-8000-000000000705',
        toolCall: turn.json().steps[0].toolCall,
      },
    })
    expect(execution.statusCode, execution.body).toBe(200)
    const triggerId = `${execution.json().objectId}:dispatch_service`
    expect(runtimeRepository.snapshot().tasks.some((task) => task.triggerId === triggerId)).toBe(false)
    await runtimeRepository.mutate((state) => applyScheduledOperations(state, new Date(NOW + 299_999)))
    expect(runtimeRepository.snapshot().tasks.some((task) => task.triggerId === triggerId)).toBe(false)
    await runtimeRepository.mutate((state) => applyScheduledOperations(state, new Date(NOW + 300_000)))
    expect(runtimeRepository.snapshot().tasks.find((task) => task.triggerId === triggerId)).toMatchObject({
      tableId: 'table-b01',
      ownerId: 'emp-lin',
      serviceTypeId: 'water',
      status: 'pending',
    })
    await app.close()
  })

  it('无指定员工的命令创建真实服务任务并进入派单', async () => {
    const { app, repository: runtimeRepository } = await testApp()
    const turn = await app.inject({
      method: 'POST',
      url: '/api/assistant/turn',
      payload: turnPayload('卡座A需要两杯柠檬冰水', 706),
    })
    const execution = await app.inject({
      method: 'POST',
      url: '/api/assistant/tool-executions',
      payload: {
        executionId: '00000000-0000-4000-8000-000000000707',
        toolCall: turn.json().steps[0].toolCall,
      },
    })
    expect(execution.statusCode, execution.body).toBe(200)
    expect(runtimeRepository.snapshot().tasks.find((task) => task.id === execution.json().objectId)).toMatchObject({
      tableId: 'table-b01',
      serviceTypeId: 'water',
      note: '需要两杯柠檬冰水',
    })
    await app.close()
  })

  it('重复执行编号只能重放同一操作，不能偷换命令', async () => {
    const { app } = await testApp()
    const payload = {
      executionId: '00000000-0000-4000-8000-000000000708',
      toolCall: {
        toolId: 'service.task.create',
        arguments: { tableCode: 'B01', serviceTypeId: 'water' },
      },
    }
    expect((await app.inject({ method: 'POST', url: '/api/assistant/tool-executions', payload })).json())
      .toMatchObject({ replayed: false })
    expect((await app.inject({ method: 'POST', url: '/api/assistant/tool-executions', payload })).json())
      .toMatchObject({ replayed: true })
    const changed = await app.inject({
      method: 'POST',
      url: '/api/assistant/tool-executions',
      payload: {
        ...payload,
        toolCall: { ...payload.toolCall, arguments: { tableCode: 'L01', serviceTypeId: 'water' } },
      },
    })
    expect(changed.statusCode).toBe(409)
    expect(changed.json().message).toContain('不能用于不同操作')
    await app.close()
  })

  it('非法开台参数返回经营人员看得懂的原因', async () => {
    const { app } = await testApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/assistant/tool-executions',
      payload: {
        executionId: '00000000-0000-4000-8000-000000000709',
        toolCall: { toolId: 'table.open', arguments: { tableCode: '', partySize: 0 } },
      },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({
      code: 'ASSISTANT_TOOL_REJECTED',
      message: '开台信息不完整，请确认桌号和实际到店人数',
    })
    await app.close()
  })

  it('普通服务员不能通过AI指派其他员工', async () => {
    const { app } = await testApp({ actorId: 'emp-lin', roleId: 'server' })
    const response = await app.inject({
      method: 'POST',
      url: '/api/assistant/tool-executions',
      payload: {
        executionId: '00000000-0000-4000-8000-000000000710',
        toolCall: {
          toolId: 'service.task.schedule',
          arguments: {
            tableCode: 'B01',
            serviceTypeId: 'water',
            delayMinutes: 5,
            assigneeEmployeeId: 'emp-wu',
          },
        },
      },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().message).toContain('只有值班管理岗位可以指派其他员工')
    await app.close()
  })

  it('退款命令不能创建退款、不能执行渠道、不能写成功证据', async () => {
    const { app, repository: runtimeRepository } = await testApp()
    const beforeRefunds = runtimeRepository.snapshot().paymentDomain.refunds.length
    const turn = await app.inject({
      method: 'POST',
      url: '/api/assistant/turn',
      payload: turnPayload('批准这笔退款并执行', 711),
    })
    expect(turn.json()).toMatchObject({ kind: 'plan', steps: [{ command: '打开收银/支付' }] })
    expect(turn.json().steps[0]).not.toHaveProperty('toolCall')
    expect(runtimeRepository.snapshot().paymentDomain.refunds).toHaveLength(beforeRefunds)
    expect(runtimeRepository.snapshot().auditEntries.some((entry) => (
      entry.action === 'assistant.tool.executed.v1' && entry.objectType === 'refund'
    ))).toBe(false)
    await app.close()
  })
})
