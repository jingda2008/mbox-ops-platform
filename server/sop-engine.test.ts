import { describe, expect, it } from 'vitest'
import type { RuntimeState } from '../src/shared/contracts.js'
import type { SopRule } from '../src/shared/sop-contracts.js'
import { createSeedState } from './seed.js'
import { processSopRules } from './sop-engine.js'
import { applyTaskAction, escalateDueTasks } from './domain.js'
import { resolveSopAction } from './sop-action-api.js'

function tableOpenedRule(patch: Partial<SopRule> = {}): SopRule {
  return {
    id: 'sop-table-care',
    name: '桌边连续关怀',
    description: '开台后分阶段提醒服务人员关注客人',
    enabled: true,
    trigger: { event: 'table_opened', serviceTypeIds: [], productCategoryIds: [] },
    scope: { areaIds: [], tableIds: [] },
    conditions: [{ type: 'no_order', value: null }],
    stopConditions: ['table_closed', 'order_submitted'],
    steps: [
      {
        id: 'step-first-care', name: '首次关怀', timing: 'after_trigger', delaySeconds: 300,
        action: {
          type: 'create_service_task', serviceTypeId: 'order-help', dispatchRoleIds: ['server', 'backup'],
          noteTemplate: '{table}开台已{minutes}分钟，请主动到桌了解需要。',
        },
      },
      {
        id: 'step-follow-up', name: '完成后复查', timing: 'after_previous_completed', delaySeconds: 120,
        action: {
          type: 'create_service_task', serviceTypeId: 'water', dispatchRoleIds: ['server', 'backup'],
          noteTemplate: '{table}首次关怀完成后请复查水、杯具和桌面。',
        },
      },
    ],
    ...patch,
  }
}

function fixture() {
  const state = createSeedState()
  state.tasks = []
  state.taskEvents = []
  state.auditEntries = []
  state.orderDomain.orders = []
  state.paymentDomain.paymentIntents = []
  state.sopExecutions = []
  state.config.sopRules = [tableOpenedRule()]
  return state
}

function l01Session(state: RuntimeState) {
  return state.songState.tableSessions.find((session) => session.tableCode === 'L01' && session.status === 'open')!
}

describe('complex SOP engine', () => {
  it('runs one task per step and waits for the previous step to complete', () => {
    const state = fixture()
    const openedAt = Date.parse(l01Session(state).openedAt)

    expect(processSopRules(state, new Date(openedAt + 301_000))).toBe(true)
    const execution = state.sopExecutions?.find((item) => item.ruleId === 'sop-table-care' && item.tableId === 'table-l01')
    expect(execution?.steps[0]).toMatchObject({ outcome: 'task_created' })
    expect(execution?.steps[1]).toMatchObject({ outcome: 'waiting', taskId: null })
    expect(state.tasks.filter((task) => task.triggerId?.startsWith(execution!.id))).toHaveLength(1)

    processSopRules(state, new Date(openedAt + 420_000))
    expect(state.tasks.filter((task) => task.triggerId?.startsWith(execution!.id))).toHaveLength(1)

    const firstTask = state.tasks.find((task) => task.id === execution?.steps[0]?.taskId)!
    firstTask.status = 'completed'
    firstTask.completedAt = new Date(openedAt + 420_000).toISOString()
    firstTask.updatedAt = firstTask.completedAt

    processSopRules(state, new Date(openedAt + 539_000))
    expect(state.tasks.filter((task) => task.triggerId?.startsWith(execution!.id))).toHaveLength(1)
    processSopRules(state, new Date(openedAt + 541_000))
    expect(state.tasks.filter((task) => task.triggerId?.startsWith(execution!.id))).toHaveLength(2)
    expect(execution?.steps[1]).toMatchObject({ outcome: 'task_created' })
  })

  it('cancels the remaining steps when a configured stop condition occurs', () => {
    const state = fixture()
    const session = l01Session(state)
    const openedAt = Date.parse(session.openedAt)
    processSopRules(state, new Date(openedAt + 60_000))

    state.orderDomain.orders.push({
      id: 'order-stops-sop', tableSessionId: session.id, status: 'submitted', items: [],
      amounts: { grossAmount: 0, discountAmount: 0, giftAmount: 0, payableAmount: 0 },
      revision: 1, createdBy: 'emp-lin', createdAt: new Date(openedAt + 90_000).toISOString(),
      submittedBy: 'emp-lin', submittedAt: new Date(openedAt + 90_000).toISOString(), fulfilledAt: null,
    })

    processSopRules(state, new Date(openedAt + 301_000))
    const execution = state.sopExecutions?.find((item) => item.ruleId === 'sop-table-care' && item.tableId === 'table-l01')
    expect(execution).toMatchObject({ status: 'cancelled', stoppedReason: 'order_submitted' })
    expect(state.tasks.filter((task) => task.triggerId?.startsWith(execution!.id))).toHaveLength(0)
  })

  it('filters order triggers by category and dispatches to the configured roles', () => {
    const state = fixture()
    const session = l01Session(state)
    const submittedAt = new Date().toISOString()
    state.config.publishedAt = new Date(Date.parse(submittedAt) - 1_000).toISOString()
    state.config.sopRules = [{
      ...tableOpenedRule(),
      id: 'sop-drinks-follow-up', name: '酒水下单后关怀',
      trigger: { event: 'order_submitted', serviceTypeIds: [], productCategoryIds: ['drinks'] },
      conditions: [], stopConditions: ['table_closed'],
      steps: [{
        id: 'step-drinks', name: '确认饮用偏好', timing: 'after_trigger', delaySeconds: 0,
        action: {
          type: 'create_service_task', serviceTypeId: 'water', dispatchRoleIds: ['backup'],
          noteTemplate: '{table}酒水订单已经提交，请确认冰块、柠檬和饮用节奏。',
        },
      }],
    }]
    state.orderDomain.orders.push({
      id: 'order-drinks-sop', tableSessionId: session.id, status: 'submitted',
      items: [{
        id: 'line-beer-sop', skuId: 'product-beer', name: '精酿啤酒', specification: '330ml', quantity: 2,
        unitListPriceAmount: 6800, unitSalePriceAmount: 6800, unitCostAmount: 1800, stationId: 'bar-main',
        configVersion: 1, fulfillmentStatus: 'queued', kdsTaskId: null, addedBy: 'emp-lin', addedAt: submittedAt,
      }],
      amounts: { grossAmount: 13_600, discountAmount: 0, giftAmount: 0, payableAmount: 13_600 },
      revision: 1, createdBy: 'emp-lin', createdAt: submittedAt,
      submittedBy: 'emp-lin', submittedAt, fulfilledAt: null,
    })

    processSopRules(state, new Date(Date.parse(submittedAt) + 1_000))
    const task = state.tasks.find((item) => item.triggerId?.includes('step-drinks'))
    expect(task).toMatchObject({ serviceTypeId: 'water', source: 'system' })
    expect(task?.note).toContain('酒水订单已经提交')
    expect(task?.notifiedEmployeeIds).toContain('emp-jie')
  })

  it('follows the open table session when guests transfer to another table', () => {
    const state = fixture()
    const session = l01Session(state)
    const openedAt = Date.parse(session.openedAt)

    processSopRules(state, new Date(openedAt + 60_000))
    const target = state.tables.find((table) => table.id === 'table-i03')!
    const source = state.tables.find((table) => table.id === 'table-l01')!
    source.status = 'available'
    source.guestCount = 0
    source.openedAt = null
    target.status = 'occupied'
    target.guestCount = 4
    target.openedAt = session.openedAt
    session.tableId = target.id
    session.tableCode = target.code

    processSopRules(state, new Date(openedAt + 301_000))

    const execution = state.sopExecutions?.find((item) => item.ruleId === 'sop-table-care' && item.tableSessionId === session.id)
    const task = state.tasks.find((item) => item.id === execution?.steps[0]?.taskId)
    expect(execution?.tableId).toBe(target.id)
    expect(task?.tableId).toBe(target.id)
    expect(task?.note).toContain(target.code)
    expect(state.auditEntries).toContainEqual(expect.objectContaining({
      action: 'sop.execution.table_transferred.v1',
      objectId: execution?.id,
    }))
  })

  it('reacts to a completed KDS item from the configured workstation', () => {
    const state = fixture()
    const session = l01Session(state)
    const completedAt = new Date()
    state.config.publishedAt = new Date(completedAt.getTime() - 1_000).toISOString()
    state.config.sopRules = [{
      ...tableOpenedRule(),
      id: 'sop-kds-completed',
      name: '酒水制作完成取送',
      trigger: {
        event: 'fulfillment_completed', serviceTypeIds: [], productCategoryIds: [], workstationIds: ['bar-main'],
      },
      conditions: [{ type: 'fulfillment_not_delivered', value: null }],
      stopConditions: ['table_closed', 'fulfillment_delivered'],
      steps: [{
        id: 'step-kds-pickup', name: '通知取送', timing: 'after_trigger', delaySeconds: 0,
        action: {
          type: 'create_service_task', serviceTypeId: 'fulfillment-delivery', dispatchRoleIds: ['runner', 'server'],
          noteTemplate: '{table}酒水已经制作完成，请立即取送。',
        },
      }],
    }]
    state.orderDomain.kdsTasks = [{
      id: 'kds-sop-completed', orderId: 'order-kds-sop', orderItemId: 'line-kds-sop', tableSessionId: session.id,
      tableCode: 'L01', stationId: 'bar-main', itemName: '精酿啤酒', specification: '330ml', quantity: 2,
      status: 'completed', queuedAt: new Date(completedAt.getTime() - 60_000).toISOString(),
      startedAt: new Date(completedAt.getTime() - 30_000).toISOString(), startedBy: 'emp-qing',
      completedAt: completedAt.toISOString(), completedBy: 'emp-qing', pickedUpAt: null, pickedUpBy: null,
      deliveredAt: null, deliveredBy: null,
    }]

    processSopRules(state, new Date(completedAt.getTime() + 1_000))

    const execution = state.sopExecutions?.find((item) => item.ruleId === 'sop-kds-completed')
    expect(execution?.context).toMatchObject({ kdsTaskId: 'kds-sop-completed', orderId: 'order-kds-sop' })
    expect(state.tasks.find((task) => task.id === execution?.steps[0]?.taskId)?.note).toContain('酒水已经制作完成')
  })

  it('applies per-step employee routing and escalation deadlines', () => {
    const state = fixture()
    const openedAt = Date.parse(l01Session(state).openedAt)
    state.config.sopRules = [tableOpenedRule({
      scope: { areaIds: [], tableIds: ['table-l01'] },
      conditions: [],
      steps: [{
        id: 'step-routed', name: '指定候补执行', timing: 'after_trigger', delaySeconds: 0,
        action: {
          type: 'create_service_task', serviceTypeId: 'water', dispatchRoleIds: ['backup', 'server'],
          dispatchEmployeeIds: ['emp-jie'], noteTemplate: '{table}请立即补水。',
          escalation: { warningSeconds: 5, backupAfterSeconds: 10, managerAfterSeconds: 15, managerRoleIds: ['supervisor'] },
        },
      }],
    })]

    processSopRules(state, new Date(openedAt + 1_000))
    const execution = state.sopExecutions?.find((item) => item.ruleId === 'sop-table-care' && item.tableId === 'table-l01')
    expect(execution).toBeDefined()
    const task = state.tasks.find((item) => item.id === execution!.steps[0]?.taskId)!
    expect(task).toMatchObject({
      ownerId: 'emp-jie', targetEmployeeIdsSnapshot: ['emp-jie'], managerRoleIdsSnapshot: ['supervisor'],
      slaSnapshot: { warningSeconds: 5, escalateSeconds: 10, managerSeconds: 15 },
    })
    expect(Date.parse(task.managerAt) - Date.parse(task.createdAt)).toBe(15_000)

    escalateDueTasks(state, new Date(Date.parse(task.createdAt) + 16_000))
    expect(task).toMatchObject({ ownerId: 'emp-qing', escalationLevel: 2, status: 'escalated' })
  })

  it('can require the configured role to complete a step', () => {
    const state = fixture()
    const openedAt = Date.parse(l01Session(state).openedAt)
    state.config.sopRules = [tableOpenedRule({
      conditions: [],
      steps: [{
        id: 'step-manager-check', name: '经理复核', timing: 'after_trigger', delaySeconds: 0,
        action: {
          type: 'create_service_task', serviceTypeId: 'water', dispatchRoleIds: ['manager'],
          dispatchEmployeeIds: ['emp-chen'], noteTemplate: '{table}请由值班经理完成复核。',
          verification: { type: 'completed_by_role', roleIds: ['manager'] },
        },
      }],
    })]

    processSopRules(state, new Date(openedAt + 1_000))
    const execution = state.sopExecutions?.find((item) => item.ruleId === 'sop-table-care')
    expect(execution).toBeDefined()
    const task = state.tasks.find((item) => item.id === execution!.steps[0]?.taskId)!
    applyTaskAction(state, task.id, { action: 'accept', actorId: 'emp-chen', note: '', idempotencyKey: 'sop-manager-accept' })
    applyTaskAction(state, task.id, { action: 'arrive', actorId: 'emp-chen', note: '', idempotencyKey: 'sop-manager-arrive' })
    applyTaskAction(state, task.id, { action: 'complete', actorId: 'emp-chen', note: '经理复核完成', idempotencyKey: 'sop-manager-complete' })

    processSopRules(state, new Date(openedAt + 2_000))
    expect(execution).toMatchObject({ status: 'completed' })
    expect(execution!.steps[0]).toMatchObject({ outcome: 'completed' })
  })

  it('waits for independent manager evidence before starting the next step', () => {
    const state = fixture()
    const openedAt = Date.parse(l01Session(state).openedAt)
    state.config.sopRules = [tableOpenedRule({
      conditions: [],
      steps: [
        {
          id: 'step-review', name: '经理复核', timing: 'after_trigger', delaySeconds: 0,
          action: {
            type: 'create_service_task', serviceTypeId: 'water', dispatchRoleIds: ['manager'],
            dispatchEmployeeIds: ['emp-chen'], notificationChannels: ['in_app', 'headset', 'wecom'],
            noteTemplate: '{table}请完成重点服务并交经理复核。',
            verification: { type: 'manager_review', roleIds: ['manager'] },
          },
        },
        {
          id: 'step-after-review', name: '复核后跟进', timing: 'after_previous_completed', delaySeconds: 60,
          action: {
            type: 'create_service_task', serviceTypeId: 'water', dispatchRoleIds: ['server'],
            noteTemplate: '{table}经理复核完成，请再次关怀。',
          },
        },
      ],
    })]

    processSopRules(state, new Date(openedAt + 1_000))
    const execution = (state.sopExecutions ?? []).find((item) => item.ruleId === 'sop-table-care')!
    const task = state.tasks.find((item) => item.id === execution.steps[0]?.taskId)!
    expect(execution.steps[0]?.actionRecordIds).toHaveLength(3)
    expect(state.sopActionRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'headset_notification', status: 'queued' }),
      expect.objectContaining({ type: 'wecom_notification', status: 'queued' }),
      expect.objectContaining({ type: 'manager_review', status: 'awaiting_evidence' }),
    ]))

    applyTaskAction(state, task.id, { action: 'accept', actorId: 'emp-chen', note: '', idempotencyKey: 'review-accept' })
    applyTaskAction(state, task.id, { action: 'arrive', actorId: 'emp-chen', note: '', idempotencyKey: 'review-arrive' })
    applyTaskAction(state, task.id, { action: 'complete', actorId: 'emp-chen', note: '现场动作完成', idempotencyKey: 'review-complete' })
    task.completedAt = new Date(openedAt + 10_000).toISOString()
    task.updatedAt = task.completedAt
    processSopRules(state, new Date(openedAt + 10_000))
    expect(execution.steps[0]).toMatchObject({ outcome: 'task_created' })
    expect(execution.steps[1]?.taskId).toBeNull()

    const review = (state.sopActionRecords ?? []).find((record) => record.type === 'manager_review')!
    resolveSopAction(state, review.id, 'emp-chen', {
      decision: 'approve', note: '经理独立复核通过', idempotencyKey: 'manager-review-decision-1',
    }, ['q'.repeat(32)], new Date(openedAt + 20_000))
    processSopRules(state, new Date(openedAt + 79_000))
    expect(execution.steps[1]?.taskId).toBeNull()
    processSopRules(state, new Date(openedAt + 81_000))
    expect(execution.steps[0]).toMatchObject({ outcome: 'completed' })
    expect(execution.steps[1]?.taskId).toBeTruthy()
  })

  it('starts parallel branches after their shared dependency completes', () => {
    const state = fixture()
    const openedAt = Date.parse(l01Session(state).openedAt)
    const routing = (dependsOnStepIds: string[]) => ({
      dependsOnStepIds, dependencyMode: 'all' as const, conditions: [], conditionMode: 'all' as const,
      onConditionFalse: 'skip' as const, onFailure: 'stop' as const, compensationStepId: null, compensationOnly: false,
    })
    state.config.sopRules = [tableOpenedRule({
      conditions: [],
      steps: [
        {
          id: 'step-arrive', name: '先到桌', timing: 'after_trigger', delaySeconds: 0,
          action: { type: 'create_service_task', serviceTypeId: 'water', dispatchRoleIds: ['server'], noteTemplate: '{table}先到桌确认。' },
          routing: routing([]),
        },
        {
          id: 'step-drink', name: '酒水关怀', timing: 'after_trigger', delaySeconds: 0,
          action: { type: 'create_service_task', serviceTypeId: 'water', dispatchRoleIds: ['server'], noteTemplate: '{table}确认酒水。' },
          routing: routing(['step-arrive']),
        },
        {
          id: 'step-table', name: '桌面整理', timing: 'after_trigger', delaySeconds: 0,
          action: { type: 'create_service_task', serviceTypeId: 'water', dispatchRoleIds: ['backup'], noteTemplate: '{table}整理桌面。' },
          routing: routing(['step-arrive']),
        },
      ],
    })]

    processSopRules(state, new Date(openedAt + 1_000))
    const execution = (state.sopExecutions ?? []).find((item) => item.ruleId === 'sop-table-care')!
    expect(execution.steps.filter((step) => step.taskId)).toHaveLength(1)
    const first = state.tasks.find((task) => task.id === execution.steps[0]?.taskId)!
    first.status = 'completed'
    first.completedAt = new Date(openedAt + 2_000).toISOString()
    first.updatedAt = first.completedAt

    processSopRules(state, new Date(openedAt + 3_000))
    expect(execution.steps.slice(1).every((step) => Boolean(step.taskId))).toBe(true)
    expect(state.tasks.filter((task) => task.triggerId?.startsWith(execution.id))).toHaveLength(3)
  })

  it('skips a false branch and allows a dependent branch to continue', () => {
    const state = fixture()
    const openedAt = Date.parse(l01Session(state).openedAt)
    state.config.sopRules = [tableOpenedRule({
      conditions: [],
      steps: [
        {
          id: 'step-vip-only', name: '大桌专属关怀', timing: 'after_trigger', delaySeconds: 0,
          action: { type: 'create_service_task', serviceTypeId: 'water', dispatchRoleIds: ['server'], noteTemplate: '{table}执行大桌关怀。' },
          routing: {
            dependsOnStepIds: [], dependencyMode: 'all',
            conditions: [{ type: 'minimum_guest_count', value: 99 }], conditionMode: 'all',
            onConditionFalse: 'skip', onFailure: 'stop', compensationStepId: null, compensationOnly: false,
          },
        },
        {
          id: 'step-normal-care', name: '普通关怀', timing: 'after_trigger', delaySeconds: 0,
          action: { type: 'create_service_task', serviceTypeId: 'water', dispatchRoleIds: ['server'], noteTemplate: '{table}执行普通关怀。' },
          routing: {
            dependsOnStepIds: ['step-vip-only'], dependencyMode: 'all', conditions: [], conditionMode: 'all',
            onConditionFalse: 'skip', onFailure: 'stop', compensationStepId: null, compensationOnly: false,
          },
        },
      ],
    })]

    processSopRules(state, new Date(openedAt + 1_000))
    const execution = (state.sopExecutions ?? []).find((item) => item.ruleId === 'sop-table-care')!
    expect(execution.steps[0]).toMatchObject({ outcome: 'skipped', reason: 'step_condition_not_matched', taskId: null })
    expect(execution.steps[1]?.taskId).toBeTruthy()
  })

  it('runs a dormant compensation step when its source step fails', () => {
    const state = fixture()
    const openedAt = Date.parse(l01Session(state).openedAt)
    state.config.sopRules = [tableOpenedRule({
      conditions: [],
      steps: [
        {
          id: 'step-primary', name: '主服务动作', timing: 'after_trigger', delaySeconds: 0,
          action: { type: 'create_service_task', serviceTypeId: 'water', dispatchRoleIds: ['server'], noteTemplate: '{table}执行主服务。' },
          routing: {
            dependsOnStepIds: [], dependencyMode: 'all', conditions: [], conditionMode: 'all', onConditionFalse: 'skip',
            onFailure: 'run_compensation', compensationStepId: 'step-compensation', compensationOnly: false,
          },
        },
        {
          id: 'step-compensation', name: '经理补偿关怀', timing: 'after_trigger', delaySeconds: 0,
          action: { type: 'create_service_task', serviceTypeId: 'water', dispatchRoleIds: ['manager'], noteTemplate: '{table}主服务失败，请经理补偿处理。' },
          routing: {
            dependsOnStepIds: [], dependencyMode: 'all', conditions: [], conditionMode: 'all', onConditionFalse: 'skip',
            onFailure: 'stop', compensationStepId: null, compensationOnly: true,
          },
        },
      ],
    })]

    processSopRules(state, new Date(openedAt + 1_000))
    const execution = (state.sopExecutions ?? []).find((item) => item.ruleId === 'sop-table-care')!
    expect(execution.steps[1]).toMatchObject({ outcome: 'waiting', taskId: null })
    const primary = state.tasks.find((task) => task.id === execution.steps[0]?.taskId)!
    primary.status = 'cancelled'
    primary.updatedAt = new Date(openedAt + 2_000).toISOString()

    processSopRules(state, new Date(openedAt + 3_000))
    expect(execution.status).toBe('active')
    expect(execution.steps[0]).toMatchObject({ outcome: 'cancelled' })
    expect(execution.steps[1]?.taskId).toBeTruthy()
    expect(state.tasks.find((task) => task.id === execution.steps[1]?.taskId)?.note).toContain('经理补偿处理')
  })
})
