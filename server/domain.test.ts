import { describe, expect, it } from 'vitest'
import type { CreateTaskInput } from '../src/shared/contracts.js'
import {
  applyTaskAction,
  canEmployeeClaimTask,
  createServiceTask,
  escalateDueTasks,
  publishConfig,
  saveConfigDraft,
} from './domain.js'
import { createSeedState } from './seed.js'
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

  it('enforces accept, arrive, complete and customer confirmation order', () => {
    const state = createSeedState()
    const task = createServiceTask(state, taskInput())

    expect(() =>
      applyTaskAction(state, task.id, { action: 'complete', actorId: 'emp-lin', note: '', idempotencyKey: 'complete-too-early' }),
    ).toThrow('必须先确认到桌')

    applyTaskAction(state, task.id, { action: 'accept', actorId: 'emp-lin', note: '', idempotencyKey: 'task-accept-0001' })
    applyTaskAction(state, task.id, { action: 'arrive', actorId: 'emp-lin', note: '', idempotencyKey: 'task-arrive-0001' })
    applyTaskAction(state, task.id, { action: 'complete', actorId: 'emp-lin', note: '已补水', idempotencyKey: 'task-complete-0001' })
    const confirmed = applyTaskAction(state, task.id, { action: 'confirm', actorId: 'guest-L01', note: '', idempotencyKey: 'task-confirm-0001' })

    expect(confirmed.status).toBe('confirmed')
    expect(state.taskEvents.map((event) => event.type)).toEqual([
      'task.created.v1',
      'task.accepted.v1',
      'task.arrived.v1',
      'task.completed.v1',
      'service.confirmed.v1',
    ])
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
})
