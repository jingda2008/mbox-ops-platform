import { describe, expect, it } from 'vitest'
import type { CreateTaskInput } from '../src/shared/contracts.js'
import {
  applyManagerTaskAction,
  applyTaskAction,
  canEmployeeClaimTask,
  createServiceTask,
  escalateDueTasks,
  managerTaskTransferCandidates,
  publishConfig,
  saveConfigDraft,
} from './domain.js'
import { createSeedState } from './seed.js'
import { serializeRuntimeState } from './postgres-repository.js'
import { JsonRepository } from './repository.js'

function taskInput(overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
  return {
    tableCode: 'L01',
    serviceTypeId: 'water',
    source: 'guest',
    note: '',
    idempotencyKey: `test-${crypto.randomUUID()}`,
    ...overrides,
  }
}

describe('service task domain', () => {
  it('assigns the occupied table primary server first', () => {
    const state = createSeedState()
    const task = createServiceTask(state, taskInput())

    expect(task.ownerId).toBe('emp-lin')
    expect(task.configVersion).toBe(1)
    expect(task).toMatchObject({
      workflowLevel: 'L1',
      requestCount: 1,
      firstRequestedAt: task.createdAt,
      lastRequestedAt: task.createdAt,
      viewedEmployeeIds: [],
      completedBy: null,
    })
    expect(task.customerReply).toContain('Tom')
    expect(state.taskEvents.at(-1)?.type).toBe('task.created.v1')
  })

  it('routes to the configured backup when primary reaches the load limit', () => {
    const state = createSeedState()
    const serverRole = state.config.roles.find((role) => role.id === 'server')
    if (!serverRole) throw new Error('missing server role')
    serverRole.maxConcurrentTasks = 1
    state.config.roles.find((role) => role.id === 'host')!.maxConcurrentTasks = 1
    state.config.roles.find((role) => role.id === 'runner')!.maxConcurrentTasks = 1

    const first = createServiceTask(state, taskInput())
    const second = createServiceTask(state, taskInput())

    expect(first.ownerId).toBe('emp-lin')
    expect(second.ownerId).toBe('emp-jie')
  })

  it('uses current workload before table preference and records the assignment basis', () => {
    const state = createSeedState()

    const first = createServiceTask(state, taskInput({ idempotencyKey: 'load-aware-first' }))
    const second = createServiceTask(state, taskInput({ idempotencyKey: 'load-aware-second' }))

    expect(first.ownerId).toBe('emp-lin')
    expect(second.ownerId).toBe('emp-jie')
    expect(state.taskEvents.find((event) => event.taskId === second.id && event.type === 'task.created.v1')).toMatchObject({
      payload: {
        ownerId: 'emp-jie',
        strategy: 'load_aware',
        candidateSource: 'backup',
        loadBefore: 0,
        capacity: 3,
      },
    })
  })

  it('lets a manager assist another owner without rewriting responsibility history', () => {
    const state = createSeedState()
    const task = createServiceTask(state, taskInput({ idempotencyKey: 'manager-assist-source' }))
    const originalOwnerId = task.ownerId

    const completed = applyManagerTaskAction(state, task.id, {
      action: 'assist_complete',
      actorId: 'emp-chen',
      targetEmployeeId: null,
      note: '',
      idempotencyKey: 'manager-assist-action',
    })

    expect(completed.ownerId).toBe(originalOwnerId)
    expect(completed.status).toBe('confirmed')
    expect(completed.completedBy).toBe('emp-chen')
    expect(completed.resolution).toBe('店长协助完成')
    expect(state.taskEvents.some((event) => event.taskId === task.id && event.type === 'task.manager_assist_completed.v1')).toBe(true)
  })

  it('lets a manager take over the same task without creating a replacement', () => {
    const state = createSeedState()
    const task = createServiceTask(state, taskInput({ idempotencyKey: 'manager-takeover-source' }))

    const takenOver = applyManagerTaskAction(state, task.id, {
      action: 'takeover',
      actorId: 'emp-chen',
      targetEmployeeId: null,
      note: '',
      idempotencyKey: 'manager-takeover-action',
    })

    expect(takenOver.id).toBe(task.id)
    expect(takenOver.ownerId).toBe('emp-chen')
    expect(takenOver.status).toBe('accepted')
    expect(state.taskEvents.find((event) => event.taskId === task.id && event.type === 'task.manager_taken_over.v1')?.payload)
      .toMatchObject({ previousOwnerId: 'emp-lin', ownerId: 'emp-chen' })
  })

  it('transfers to a suitable third employee and preserves the task identity and request record', () => {
    const state = createSeedState()
    const task = createServiceTask(state, taskInput({ idempotencyKey: 'manager-transfer-source' }))
    const originalWarningAt = task.warningAt
    const candidate = managerTaskTransferCandidates(state, task, 'emp-chen')
      .find((item) => item.employeeId === 'emp-jie')
    expect(candidate).toBeDefined()

    const transferred = applyManagerTaskAction(state, task.id, {
      action: 'transfer',
      actorId: 'emp-chen',
      targetEmployeeId: 'emp-jie',
      note: '',
      idempotencyKey: 'manager-transfer-action',
    })

    expect(transferred.id).toBe(task.id)
    expect(transferred.ownerId).toBe('emp-jie')
    expect(transferred.status).toBe('pending')
    expect(transferred.requestCount).toBe(1)
    expect(transferred.warningAt).toBe(originalWarningAt)
    expect(state.taskEvents.find((event) => event.taskId === task.id && event.type === 'task.manager_transferred.v1')?.payload)
      .toMatchObject({ previousOwnerId: 'emp-lin', ownerId: 'emp-jie' })
  })

  it('honors an explicitly targeted eligible employee ahead of automatic balancing', () => {
    const state = createSeedState()
    createServiceTask(state, taskInput({ idempotencyKey: 'targeted-load-first' }))

    const task = createServiceTask(state, {
      ...taskInput({ idempotencyKey: 'targeted-load-second' }),
      dispatchEmployeeIds: ['emp-lin'],
    })

    expect(task.ownerId).toBe('emp-lin')
    expect(state.taskEvents.find((event) => event.taskId === task.id && event.type === 'task.created.v1')?.payload)
      .toMatchObject({ strategy: 'load_aware', candidateSource: 'targeted', loadBefore: 1 })
  })

  it('dispatches to an employee serving a compatible secondary shift role', () => {
    const state = createSeedState()
    const table = state.tables.find((item) => item.code === 'L01')!
    const primary = state.employees.find((item) => item.id === table.primaryEmployeeId)!
    const backup = state.employees.find((item) => item.id === table.backupEmployeeIds[0])!
    primary.paused = true
    backup.paused = true
    state.employees.find((item) => item.id === 'emp-wu')!.paused = true
    for (const employee of state.employees) employee.paused = true
    const host = state.employees.find((item) => item.id === 'emp-host')!
    const hostShift = state.shiftAssignments.find((item) => item.employeeId === host.id)!
    hostShift.roleIds = ['server']
    host.online = true
    host.paused = false

    const task = createServiceTask(state, taskInput())

    expect(task.ownerId).toBe(host.id)
    expect(task.customerReply).toContain(host.displayName)
  })

  it('keeps the scene-specific reply while the service team is arranging coverage', () => {
    const state = createSeedState()
    for (const employee of state.employees) employee.paused = true

    const task = createServiceTask(state, taskInput())

    expect(task.ownerId).toBeNull()
    expect(task.customerReply).toContain('水水马上到')
    expect(task.customerReply).toContain('服务团队')
    expect(task.customerReply).not.toContain('值班领班正在安排人员')
  })

  it('lets an eligible online employee atomically claim an unowned task', () => {
    const state = createSeedState()
    for (const employee of state.employees) employee.online = false
    const task = createServiceTask(state, taskInput())
    const primary = state.employees.find((employee) => employee.id === 'emp-lin')!
    primary.online = true

    expect(canEmployeeClaimTask(state, task, primary.id)).toBe(true)
    const claimed = applyTaskAction(state, task.id, {
      action: 'accept', actorId: primary.id, note: '', idempotencyKey: 'claim-unowned-task-0001',
    })

    expect(claimed).toMatchObject({ ownerId: primary.id, status: 'accepted' })
    expect(claimed.notifiedEmployeeIds).toContain(primary.id)
    expect(state.taskEvents.at(-1)).toMatchObject({
      taskId: task.id,
      type: 'task.accepted.v1',
      actorId: primary.id,
      payload: { ownerId: primary.id },
    })
  })

  it('rejects an ineligible claimant and keeps the first claimant as the only owner', () => {
    const state = createSeedState()
    for (const employee of state.employees) employee.online = false
    const task = createServiceTask(state, taskInput())
    const primary = state.employees.find((employee) => employee.id === 'emp-lin')!
    const backup = state.employees.find((employee) => employee.id === 'emp-jie')!
    const cashier = state.employees.find((employee) => employee.id === 'emp-cashier')!
    primary.online = true
    backup.online = true
    cashier.online = true

    expect(canEmployeeClaimTask(state, task, cashier.id)).toBe(false)
    expect(() => applyTaskAction(state, task.id, {
      action: 'accept', actorId: cashier.id, note: '', idempotencyKey: 'claim-wrong-role-0001',
    })).toThrow('通知或责任范围')

    applyTaskAction(state, task.id, {
      action: 'accept', actorId: primary.id, note: '', idempotencyKey: 'claim-first-wins-0001',
    })
    expect(() => applyTaskAction(state, task.id, {
      action: 'accept', actorId: backup.id, note: '', idempotencyKey: 'claim-second-loses-0001',
    })).toThrow('已由其他员工接单')
    expect(task).toMatchObject({ ownerId: primary.id, status: 'accepted' })
    expect(state.taskEvents.filter((event) => event.type === 'task.accepted.v1')).toHaveLength(1)
  })

  it('serializes simultaneous claims so exactly one employee wins', async () => {
    const repository = new JsonRepository(`/tmp/mbox-task-claim-${crypto.randomUUID()}.json`)
    await repository.init()
    const taskId = await repository.mutate((state) => {
      for (const employee of state.employees) employee.online = false
      const task = createServiceTask(state, taskInput({ idempotencyKey: 'concurrent-claim-task-0001' }))
      state.employees.find((employee) => employee.id === 'emp-lin')!.online = true
      state.employees.find((employee) => employee.id === 'emp-jie')!.online = true
      return task.id
    })

    const results = await Promise.allSettled([
      repository.mutate((state) => applyTaskAction(state, taskId, {
        action: 'accept', actorId: 'emp-lin', note: '', idempotencyKey: 'concurrent-claim-lin-0001',
      })),
      repository.mutate((state) => applyTaskAction(state, taskId, {
        action: 'accept', actorId: 'emp-jie', note: '', idempotencyKey: 'concurrent-claim-jie-0001',
      })),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)

    const state = await repository.read()
    expect(state.tasks.find((task) => task.id === taskId)).toMatchObject({ status: 'accepted', ownerId: 'emp-lin' })
    expect(state.taskEvents.filter((event) => event.taskId === taskId && event.type === 'task.accepted.v1')).toHaveLength(1)
    await repository.close()
  })

  it('keeps supervisor and manager coverage available for unowned escalations', () => {
    const state = createSeedState()
    for (const employee of state.employees) employee.online = false
    const task = createServiceTask(state, taskInput({ serviceTypeId: 'complaint' }))
    const supervisor = state.employees.find((employee) => employee.id === 'emp-qing')!
    const manager = state.employees.find((employee) => employee.id === 'emp-chen')!
    supervisor.online = true
    manager.online = true

    expect(canEmployeeClaimTask(state, task, supervisor.id)).toBe(true)
    expect(canEmployeeClaimTask(state, task, manager.id)).toBe(true)
  })

  it('returns the same task for a repeated idempotency key', () => {
    const state = createSeedState()
    const input = taskInput({ idempotencyKey: 'same-request-key' })

    const first = createServiceTask(state, input)
    const second = createServiceTask(state, input)

    expect(second.id).toBe(first.id)
    expect(state.tasks).toHaveLength(1)
  })

  it('does not let an employee impersonate the guest service confirmation', () => {
    const state = createSeedState()
    const task = createServiceTask(state, taskInput())
    applyTaskAction(state, task.id, { action: 'accept', actorId: 'emp-lin', note: '', idempotencyKey: 'staff-accept-0001' })
    applyTaskAction(state, task.id, { action: 'arrive', actorId: 'emp-lin', note: '', idempotencyKey: 'staff-arrive-0001' })
    applyTaskAction(state, task.id, { action: 'complete', actorId: 'emp-lin', note: '已送到桌', idempotencyKey: 'staff-complete-0001' })

    expect(() => applyTaskAction(state, task.id, { action: 'confirm', actorId: 'emp-lin', note: '', idempotencyKey: 'staff-fake-confirm-0001' }))
      .toThrow('仅客人可以确认服务已经解决')
  })

  it('lets an eligible backup complete L1 service in one action', () => {
    const state = createSeedState()
    const task = createServiceTask(state, taskInput())

    const confirmed = applyTaskAction(state, task.id, {
      action: 'quick_complete',
      actorId: 'emp-jie',
      note: '候补已补水',
      idempotencyKey: 'task-quick-complete-0001',
    })

    expect(confirmed.status).toBe('confirmed')
    expect(confirmed.completedBy).toBe('emp-jie')
    expect(confirmed.viewedEmployeeIds).toContain('emp-jie')
    expect(state.taskEvents.map((event) => event.type)).toEqual([
      'task.created.v1',
      'task.quick_completed.v1',
      'service.closed_by_staff.v1',
    ])
    const eventCount = state.taskEvents.length
    expect(applyTaskAction(state, task.id, {
      action: 'quick_complete',
      actorId: 'emp-jie',
      note: '候补再次确认已补水',
      idempotencyKey: 'task-quick-complete-semantic-retry-0002',
    })).toBe(confirmed)
    expect(state.taskEvents).toHaveLength(eventCount)
  })

  it('records L0 guest context without creating an open employee task', () => {
    const state = createSeedState()
    const task = createServiceTask(state, taskInput({
      serviceTypeId: 'guest-mood-info',
      note: '客户心情反馈：安静。',
    }))

    expect(task).toMatchObject({
      workflowLevel: 'L0',
      status: 'confirmed',
      ownerId: null,
      completedBy: 'system',
      resolution: '客情信息已记录',
    })
    expect(state.taskEvents.map((event) => event.type)).toContain('service.info_recorded.v1')
  })

  it('rejects quick completion outside the L1 notification, backup and role scope', () => {
    const state = createSeedState()
    const task = createServiceTask(state, taskInput())

    expect(() => applyTaskAction(state, task.id, {
      action: 'quick_complete',
      actorId: 'emp-cashier',
      note: '',
      idempotencyKey: 'task-quick-complete-ineligible-0001',
    })).toThrow('通知、候补或岗位范围')
    expect(task.status).toBe('pending')
  })

  it('lets the responsible employee complete L2 directly after accepting', () => {
    const state = createSeedState()
    const task = createServiceTask(state, taskInput({ serviceTypeId: 'order-help' }))

    applyTaskAction(state, task.id, {
      action: 'accept', actorId: task.ownerId!, note: '', idempotencyKey: 'l2-accept-0001',
    })
    const completed = applyTaskAction(state, task.id, {
      action: 'complete', actorId: task.ownerId!, note: '', idempotencyKey: 'l2-complete-0001',
    })

    expect(completed).toMatchObject({ status: 'confirmed', workflowLevel: 'L2', completedBy: task.ownerId })
    expect(state.taskEvents.some((event) => event.type === 'task.arrived.v1')).toBe(false)
  })

  it('keeps L3 arrival and completion-note controls intact', () => {
    const state = createSeedState()
    const task = createServiceTask(state, taskInput({ serviceTypeId: 'complaint' }))
    const actorId = task.ownerId!

    applyTaskAction(state, task.id, {
      action: 'accept', actorId, note: '', idempotencyKey: 'l3-accept-0001',
    })
    expect(() => applyTaskAction(state, task.id, {
      action: 'complete', actorId, note: '已沟通', idempotencyKey: 'l3-too-early-0001',
    })).toThrow('必须先确认到桌')
    applyTaskAction(state, task.id, {
      action: 'arrive', actorId, note: '', idempotencyKey: 'l3-arrive-0001',
    })
    expect(() => applyTaskAction(state, task.id, {
      action: 'complete', actorId, note: '', idempotencyKey: 'l3-note-required-0001',
    })).toThrow('请填写处理结果')
    expect(applyTaskAction(state, task.id, {
      action: 'complete', actorId, note: '已现场解决', idempotencyKey: 'l3-complete-0001',
    })).toMatchObject({ status: 'confirmed', completedBy: actorId })
  })

  it('restarts SLA and notifies the replacement when the guest says service is unresolved', () => {
    const state = createSeedState()
    const task = createServiceTask(state, taskInput())
    applyTaskAction(state, task.id, { action: 'accept', actorId: 'emp-lin', note: '', idempotencyKey: 'reopen-accept-0001' })
    applyTaskAction(state, task.id, { action: 'arrive', actorId: 'emp-lin', note: '', idempotencyKey: 'reopen-arrive-0001' })
    applyTaskAction(state, task.id, { action: 'complete', actorId: 'emp-lin', note: '客人仍不满意', idempotencyKey: 'reopen-complete-0001' })
    task.warningAt = '2020-01-01T00:00:00.000Z'
    task.escalateAt = '2020-01-01T00:00:00.000Z'
    task.managerAt = '2020-01-01T00:00:00.000Z'

    const reopened = applyTaskAction(state, task.id, { action: 'unresolved', actorId: 'guest-L01', note: '还没有送到', idempotencyKey: 'reopen-unresolved-0001' })

    expect(reopened).toMatchObject({ status: 'reopened', completedAt: null, resolution: null })
    expect(Date.parse(reopened.warningAt)).toBeGreaterThan(Date.now())
    expect(reopened.notifiedEmployeeIds).toContain(reopened.ownerId)
  })

  it('replays a task action without adding another event or revision', () => {
    const state = createSeedState()
    const task = createServiceTask(state, taskInput())
    const input = { action: 'accept' as const, actorId: 'emp-lin', note: '', idempotencyKey: 'task-action-replay-0001' }

    applyTaskAction(state, task.id, input)
    const revision = state.revision
    const eventCount = state.taskEvents.length
    const replay = applyTaskAction(state, task.id, input)

    expect(replay.status).toBe('accepted')
    expect(state.revision).toBe(revision)
    expect(state.taskEvents).toHaveLength(eventCount)
    expect(() => applyTaskAction(state, task.id, { ...input, note: 'different' })).toThrow('幂等键')
  })

  it('escalates first to backup and then to the duty manager', () => {
    const state = createSeedState()
    const task = createServiceTask(state, taskInput())

    escalateDueTasks(state, new Date(new Date(task.escalateAt).getTime() + 1))
    expect(task.status).toBe('escalated')
    expect(task.escalationLevel).toBe(1)
    expect(task.ownerId).toBe('emp-jie')

    escalateDueTasks(state, new Date(new Date(task.managerAt).getTime() + 1))
    expect(task.escalationLevel).toBe(2)
    expect(task.ownerId).toBe('emp-chen')
  })
})

describe('versioned store configuration', () => {
  it('keeps draft isolated and publishes a new version', () => {
    const state = createSeedState()
    const serviceTypes = state.config.serviceTypes.map((type) => ({
      id: type.id,
      enabled: type.enabled,
      priority: type.priority,
      dispatchRoleIds: type.dispatchRoleIds,
      customerReply: type.customerReply,
      actionScript: type.actionScript,
      sla: type.id === 'water'
        ? { warningSeconds: 15, escalateSeconds: 30, managerSeconds: 60 }
        : type.sla,
    }))
    const roles = state.config.roles.map((role) => ({
      id: role.id,
      maxConcurrentTasks: role.maxConcurrentTasks,
      canReceiveTasks: role.canReceiveTasks,
    }))

    const guestServiceLimits = { ...state.config.guestServiceLimits, maxRequests: 4 }
    const communityBrand = { ...state.config.communityBrand, name: '超嗨社群测试版' }
    saveConfigDraft(state, {
      serviceTypes,
      roles,
      proactiveOrderCare: state.config.proactiveOrderCare,
      guestServiceLimits,
      communityBrand,
    }, 'manager-demo')
    expect(state.config.serviceTypes.find((type) => type.id === 'water')?.sla.warningSeconds).toBe(30)
    expect(state.config.guestServiceLimits.maxRequests).toBe(5)
    expect(state.config.communityBrand.name).toBe('超嗨部落')
    expect(state.draftConfig?.serviceTypes.find((type) => type.id === 'water')?.sla.warningSeconds).toBe(15)
    expect(state.draftConfig?.guestServiceLimits.maxRequests).toBe(4)
    expect(state.draftConfig?.communityBrand.name).toBe('超嗨社群测试版')

    const published = publishConfig(state, 'manager-demo')
    expect(published.version).toBe(2)
    expect(published.serviceTypes.find((type) => type.id === 'water')?.sla.warningSeconds).toBe(15)
    expect(published.guestServiceLimits.maxRequests).toBe(4)
    expect(published.communityBrand.name).toBe('超嗨社群测试版')
    expect(state.draftConfig).toBeNull()
  })

  it('adds a new role and rejects a normal guest service type as a delivery workflow', () => {
    const state = createSeedState()
    const serviceTypes = state.config.serviceTypes.map((type) => ({
      id: type.id,
      enabled: type.enabled,
      guestVisible: type.guestVisible,
      priority: type.priority,
      dispatchRoleIds: type.dispatchRoleIds,
      customerReply: type.customerReply,
      actionScript: type.actionScript,
      sla: type.sla,
    }))
    const roles = [
      ...state.config.roles.map((role) => ({ ...role })),
      { id: 'concierge', name: '客户体验专员', maxConcurrentTasks: 3, canReceiveTasks: true },
    ]

    saveConfigDraft(state, {
      serviceTypes,
      roles,
      skills: state.config.skills,
      workstations: state.config.workstations,
      proactiveOrderCare: state.config.proactiveOrderCare,
      guestServiceLimits: state.config.guestServiceLimits,
    }, 'emp-chen')
    expect(state.draftConfig?.roles.find((role) => role.id === 'concierge')).toMatchObject({
      name: '客户体验专员',
      dataScope: 'own',
      permissionIds: [],
    })

    const invalidWorkstations = state.config.workstations.map((station) => (
      station.id === 'bar-main' ? { ...station, deliveryServiceTypeId: 'order-help' } : station
    ))
    expect(() => saveConfigDraft(state, {
      serviceTypes,
      roles,
      skills: state.config.skills,
      workstations: invalidWorkstations,
      proactiveOrderCare: state.config.proactiveOrderCare,
      guestServiceLimits: state.config.guestServiceLimits,
    }, 'emp-chen')).toThrow('必须绑定已启用的专用取送任务类型')
  })

  it('keeps config drafts serializable when optional guest visibility is unset', () => {
    const state = createSeedState()
    const serviceTypes = state.config.serviceTypes.map((type) => ({
      id: type.id,
      enabled: type.enabled,
      priority: type.priority,
      dispatchRoleIds: type.dispatchRoleIds,
      customerReply: type.customerReply,
      actionScript: type.actionScript,
      sla: type.sla,
    }))

    saveConfigDraft(state, {
      serviceTypes,
      roles: state.config.roles,
      skills: state.config.skills,
      workstations: state.config.workstations,
      proactiveOrderCare: state.config.proactiveOrderCare,
      guestServiceLimits: state.config.guestServiceLimits,
    }, 'emp-chen')

    const birthday = state.draftConfig?.serviceTypes.find((type) => type.id === 'birthday')
    expect(birthday?.guestVisible).toBeUndefined()
    expect(birthday && Object.hasOwn(birthday, 'guestVisible')).toBe(false)
    expect(() => serializeRuntimeState(state)).not.toThrow()
  })

  it('versions complex SOP rules and rejects broken dispatch references', () => {
    const state = createSeedState()
    const sopRule = {
      id: 'sop-table-care',
      name: '开台连续关怀',
      description: '未点单时按步骤提醒桌边服务',
      enabled: true,
      trigger: { event: 'table_opened' as const, serviceTypeIds: [], productCategoryIds: [] },
      scope: { areaIds: ['lounge'], tableIds: ['table-l01'] },
      conditions: [{ type: 'no_order' as const, value: null }],
      stopConditions: ['table_closed' as const, 'order_submitted' as const],
      steps: [{
        id: 'sop-table-care-step-1',
        name: '首次关怀',
        timing: 'after_trigger' as const,
        delaySeconds: 15 * 60,
        action: {
          type: 'create_service_task' as const,
          serviceTypeId: 'order-help',
          dispatchRoleIds: ['server', 'backup'],
          noteTemplate: '{table}开台已{minutes}分钟，请主动到桌了解需要。',
        },
      }],
    }
    const input = {
      serviceTypes: state.config.serviceTypes,
      roles: state.config.roles,
      proactiveOrderCare: state.config.proactiveOrderCare,
      guestServiceLimits: state.config.guestServiceLimits,
      sopRules: [sopRule],
    }

    saveConfigDraft(state, input, 'emp-chen')
    expect(state.config.sopRules).toEqual([])
    expect(state.draftConfig?.sopRules).toEqual([sopRule])
    const published = publishConfig(state, 'emp-chen')
    expect(published.version).toBe(2)
    expect(published.sopRules?.[0]?.steps[0]?.delaySeconds).toBe(15 * 60)

    expect(() => saveConfigDraft(state, {
      ...input,
      sopRules: [{
        ...sopRule,
        steps: [{
          ...sopRule.steps[0],
          action: { ...sopRule.steps[0].action, dispatchRoleIds: ['missing-role'] },
        }],
      }],
    }, 'emp-chen')).toThrow('引用了不存在的岗位')

    expect(() => saveConfigDraft(state, {
      ...input,
      sopRules: [{
        ...sopRule,
        steps: [{
          ...sopRule.steps[0],
          action: {
            ...sopRule.steps[0].action,
            dispatchRoleIds: ['server'],
            dispatchEmployeeIds: ['emp-han'],
          },
        }],
      }],
    }, 'emp-chen')).toThrow('指定员工不具备所选执行岗位')

    expect(() => saveConfigDraft(state, {
      ...input,
      sopRules: [{
        ...sopRule,
        trigger: {
          event: 'fulfillment_completed' as const,
          serviceTypeIds: [],
          productCategoryIds: [],
          workstationIds: ['missing-station'],
        },
      }],
    }, 'emp-chen')).toThrow('引用了不存在的工作站')
  })
})
