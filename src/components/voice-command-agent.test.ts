import { describe, expect, it } from 'vitest'
import {
  DeterministicVoiceCommandPlanner,
  createModelVoiceCommandPlan,
  MAX_VOICE_COMMAND_STEPS,
  classifyVoiceCommandRisk,
  transitionVoiceCommandStep,
} from './voice-command-agent'
import type { VoiceCommandModelAdapter } from './voice-command-agent'

describe('DeterministicVoiceCommandPlanner.split', () => {
  it('recognizes supported Chinese connectors and caps output at five steps', () => {
    const planner = new DeterministicVoiceCommandPlanner()

    expect(planner.split('打开现场然后选择K2接着填写4人再归属Tom并且立即开台同时查看任务')).toEqual([
      '打开现场',
      '选择K2',
      '填写4人',
      '归属Tom',
      '立即开台',
    ])
    expect(planner.split('一，然后二；接着三。并且四，同时五，再六')).toHaveLength(MAX_VOICE_COMMAND_STEPS)
  })

  it('does not treat the first character of “再次” as a connector', () => {
    const planner = new DeterministicVoiceCommandPlanner()
    expect(planner.split('再次确认权限')).toEqual(['再次确认权限'])
  })
})

describe('DeterministicVoiceCommandPlanner.plan', () => {
  it('expands a compact open-table command into five ordered UI steps', () => {
    const planner = new DeterministicVoiceCommandPlanner()
    const plan = planner.plan('K2四位客人开台并归属Tom')

    expect(plan.steps.map((step) => step.action)).toEqual([
      'open_live',
      'select_table',
      'set_party_size',
      'assign_sales',
      'open_table_now',
    ])
    expect(plan.steps.map((step) => step.label)).toEqual([
      '打开现场',
      '选择桌台 K2',
      '填写人数 4',
      '销售归属 Tom',
      '立即开台',
    ])
    expect(plan.steps.map((step) => step.command)).toEqual([
      '打开现场桌台',
      '点击开台桌台K2',
      '客人人数输入4',
      '销售归属选择 Tom',
      '点击立即开台',
    ])
    expect(plan.steps.map((step) => step.status)).toEqual(Array(5).fill('pending'))
    expect(plan.steps[1].entities).toEqual({ tableCode: 'K2' })
    expect(plan.steps[2].entities).toEqual({ partySize: 4 })
    expect(plan.steps[3].entities).toEqual({ salesOwner: 'Tom' })
    expect(plan).toMatchObject({
      status: 'pending',
      risk: 'normal',
      truncated: false,
      executionMode: 'sequential-ui',
      serverTransactionAtomic: false,
      modelUsed: false,
    })
  })

  it('supports Arabic party sizes and normalizes lowercase table codes', () => {
    const plan = new DeterministicVoiceCommandPlanner().plan('k12 18位客人立即开台并且销售归属给 Alice')
    expect(plan.steps[1].entities).toEqual({ tableCode: 'K12' })
    expect(plan.steps[2].entities).toEqual({ partySize: 18 })
    expect(plan.steps[3].entities).toEqual({ salesOwner: 'Alice' })
  })

  it('does not invent a party size for a short open-table command', () => {
    const planner = new DeterministicVoiceCommandPlanner({
      defaultOpenTableSalesOwner: 'Tom',
    })
    const plan = planner.plan('L01开台')

    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]).toMatchObject({ action: 'execute_command', command: 'L01开台' })
    expect(plan.steps[0]?.entities).toEqual({})
  })

  it('uses the spoken party size while defaulting sales to the current employee', () => {
    const plan = new DeterministicVoiceCommandPlanner({
      defaultOpenTableSalesOwner: 'Tom',
    }).plan('L01四位客人开台')

    expect(plan.steps[2].entities).toEqual({ partySize: 4 })
    expect(plan.steps[3].entities).toEqual({ salesOwner: 'Tom' })
  })

  it('normalizes a natural arrival sentence into the verified five-step open-table workflow', () => {
    const plan = new DeterministicVoiceCommandPlanner({
      defaultOpenTableSalesOwner: 'Tom',
    }).plan('L04来了四位客人，帮我开台并归属Tom')

    expect(plan.steps.map((step) => step.command)).toEqual([
      '打开现场桌台',
      '点击开台桌台L04',
      '客人人数输入4',
      '销售归属选择 Tom',
      '点击立即开台',
    ])
  })

  it('caps general plans, reports omitted steps, and remains deterministic', () => {
    const planner = new DeterministicVoiceCommandPlanner()
    const command = '一步然后二步然后三步然后四步然后五步然后六步'

    expect(planner.plan(command)).toEqual(planner.plan(command))
    expect(planner.plan(command)).toMatchObject({
      truncated: true,
      omittedStepCount: 1,
    })
    expect(planner.plan(command).steps).toHaveLength(MAX_VOICE_COMMAND_STEPS)
  })

  it.each(['支付', '退款', '权限', '删除', '发布'])('marks commands containing %s as high risk', (term) => {
    const plan = new DeterministicVoiceCommandPlanner().plan(`确认${term}`)
    expect(classifyVoiceCommandRisk(`确认${term}`)).toBe('high')
    expect(plan.risk).toBe('high')
    expect(plan.steps[0]).toMatchObject({ risk: 'high', riskTerms: [term] })
  })

  it('returns an empty, non-model plan for blank input', () => {
    expect(new DeterministicVoiceCommandPlanner().plan('  ')).toMatchObject({
      steps: [],
      status: 'pending',
      modelUsed: false,
    })
  })

  it('never calls a configured adapter while the model is disabled', () => {
    let modelCalls = 0
    const adapter: VoiceCommandModelAdapter = {
      propose: async () => {
        modelCalls += 1
        return [{ label: '模型步骤', command: '模型步骤' }]
      },
    }
    const planner = new DeterministicVoiceCommandPlanner({ modelEnabled: false, modelAdapter: adapter })

    expect(planner.plan('打开现场').steps[0].command).toBe('打开现场')
    expect(planner.modelEnabled).toBe(false)
    expect(modelCalls).toBe(0)
  })

  it('rejects attempts to enable a model in the deterministic planner', () => {
    expect(() => new DeterministicVoiceCommandPlanner({ modelEnabled: true })).toThrow(
      'DeterministicVoiceCommandPlanner does not permit model calls',
    )
  })

  it('converts bounded model suggestions into an untrusted sequential plan', () => {
    const plan = createModelVoiceCommandPlan('帮我处理L04', [
      { label: '打开现场', command: '打开现场桌台' },
      { label: '选择L04', command: '点击开台桌台L04' },
      { label: '确认转桌', command: '点击确认转桌' },
    ])

    expect(plan).toMatchObject({
      modelUsed: true,
      executionMode: 'sequential-ui',
      serverTransactionAtomic: false,
      risk: 'high',
    })
    expect(plan.steps.map((step) => step.command)).toEqual([
      '打开现场桌台', '点击开台桌台L04', '点击确认转桌',
    ])
  })
})

describe('transitionVoiceCommandStep', () => {
  it('enforces pending -> running -> completed in sequence', () => {
    const initial = new DeterministicVoiceCommandPlanner().plan('打开现场然后选择K2')

    expect(() => transitionVoiceCommandStep(initial, 2, 'running')).toThrow(
      'Step voice-step-2 cannot run before prior steps complete',
    )

    const firstRunning = transitionVoiceCommandStep(initial, 1, 'running')
    expect(firstRunning.steps.map((step) => step.status)).toEqual(['running', 'pending'])

    const firstCompleted = transitionVoiceCommandStep(firstRunning, 'voice-step-1', 'completed')
    const secondRunning = transitionVoiceCommandStep(firstCompleted, 2, 'running')
    const completed = transitionVoiceCommandStep(secondRunning, 2, 'completed')

    expect(completed.status).toBe('completed')
    expect(completed.steps.map((step) => step.status)).toEqual(['completed', 'completed'])
    expect(initial.steps.map((step) => step.status)).toEqual(['pending', 'pending'])
  })

  it('preserves completed UI work when a later step is blocked because the plan is non-atomic', () => {
    const initial = new DeterministicVoiceCommandPlanner().plan('打开现场然后选择K2然后立即开台')
    const firstRunning = transitionVoiceCommandStep(initial, 1, 'running')
    const firstCompleted = transitionVoiceCommandStep(firstRunning, 1, 'completed')
    const secondBlocked = transitionVoiceCommandStep(firstCompleted, 2, 'blocked', '桌台当前不可选')

    expect(secondBlocked.status).toBe('blocked')
    expect(secondBlocked.serverTransactionAtomic).toBe(false)
    expect(secondBlocked.steps.map((step) => step.status)).toEqual(['completed', 'blocked', 'pending'])
    expect(secondBlocked.steps[1].blockedReason).toBe('桌台当前不可选')
  })

  it('does not complete a step that never started', () => {
    const plan = new DeterministicVoiceCommandPlanner().plan('打开现场')
    expect(() => transitionVoiceCommandStep(plan, 1, 'completed')).toThrow(
      'Step voice-step-1 must be running before it can complete',
    )
  })
})
