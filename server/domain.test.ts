import { describe, expect, it } from 'vitest'
import type { CreateTaskInput } from '../src/shared/contracts.js'
import {
  applyTaskAction,
  createServiceTask,
  escalateDueTasks,
  publishConfig,
  saveConfigDraft,
} from './domain.js'
import { createSeedState } from './seed.js'

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
    expect(task.customerReply).toContain('小林')
    expect(state.taskEvents.at(-1)?.type).toBe('task.created.v1')
  })

  it('routes to the configured backup when primary reaches the load limit', () => {
    const state = createSeedState()
    const serverRole = state.config.roles.find((role) => role.id === 'server')
    if (!serverRole) throw new Error('missing server role')
    serverRole.maxConcurrentTasks = 1

    const first = createServiceTask(state, taskInput())
    const second = createServiceTask(state, taskInput())

    expect(first.ownerId).toBe('emp-lin')
    expect(second.ownerId).toBe('emp-jie')
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

  it('returns the same task for a repeated idempotency key', () => {
    const state = createSeedState()
    const input = taskInput({ idempotencyKey: 'same-request-key' })

    const first = createServiceTask(state, input)
    const second = createServiceTask(state, input)

    expect(second.id).toBe(first.id)
    expect(state.tasks).toHaveLength(1)
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
