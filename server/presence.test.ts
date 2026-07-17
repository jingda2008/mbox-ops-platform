import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import type { RuntimeState } from '../src/shared/contracts.js'
import { employeeWriteSchema } from '../src/shared/contracts.js'
import { registerAuthContext, signStaffSession } from './auth-context.js'
import {
  endPresenceLease,
  establishPresenceLease,
  reconcilePresence,
  registerPresenceRoutes,
} from './presence.js'
import type { RuntimeRepository, RuntimeRepositoryHealth } from './repository.js'
import { createSeedState } from './seed.js'
import { createServiceTask } from './domain.js'

class MemoryRepository implements RuntimeRepository {
  state = createSeedState()

  async init() {}
  async read() { return structuredClone(this.state) }
  async mutate<T>(mutation: (state: RuntimeState) => T | Promise<T>) {
    const working = structuredClone(this.state)
    const result = await mutation(working)
    this.state = working
    return result
  }
  async reset() { this.state = createSeedState(); return structuredClone(this.state) }
  async healthCheck(): Promise<RuntimeRepositoryHealth> {
    return { ready: true, repository: 'memory', revision: this.state.revision }
  }
  async close() {}
}

const secret = 'presence-route-test-session-secret-32-characters'

function establish(
  state: RuntimeState,
  sessionId: string,
  now: number,
  leaseTtlMs: number,
  sessionExpiresAt = now + 60_000,
  actorId = 'emp-chen',
) {
  return establishPresenceLease(state, {
    sessionId,
    actorId,
    storeId: state.store.id,
    businessDate: state.store.businessDate,
    now,
    leaseTtlMs,
    sessionExpiresAt,
  })
}

describe('staff presence domain', () => {
  it('keeps an employee online while any device lease is valid and expires automatically by time', () => {
    const state = createSeedState()
    const now = Date.parse('2026-07-16T12:00:00.000Z')
    establish(state, 'device-1', now, 1_000)
    establish(state, 'device-2', now, 2_000)

    expect(endPresenceLease(state, 'device-1', 'emp-chen', now + 500)).toBe(true)
    expect(state.employees.find((employee) => employee.id === 'emp-chen')?.online).toBe(true)

    reconcilePresence(state, now + 2_001)
    expect(state.presenceLeases).toEqual([])
    expect(state.employees.find((employee) => employee.id === 'emp-chen')?.online).toBe(false)
  })

  it('does not accept an administrator online checkbox as presence evidence', () => {
    const parsed = employeeWriteSchema.parse({
      displayName: '测试员工', initials: '测', status: 'active', roleId: 'server',
      online: true, paused: false, areaIds: ['lounge'],
    })

    expect(parsed.online).toBe(false)
  })

  it('reopens accepted work for a replacement when the last device lease expires', () => {
    const state = createSeedState()
    const now = Date.parse('2026-07-16T12:00:00.000Z')
    establish(state, 'server-device', now, 1_000, now + 60_000, 'emp-lin')
    establish(state, 'backup-device', now, 5_000, now + 60_000, 'emp-jie')
    const task = createServiceTask(state, {
      tableCode: 'L01', serviceTypeId: 'water', source: 'guest', note: '', idempotencyKey: 'presence-reassign-test',
    })
    task.status = 'arrived'
    task.acceptedAt = new Date(now).toISOString()
    task.arrivedAt = new Date(now).toISOString()

    reconcilePresence(state, now + 1_001)

    expect(task).toMatchObject({ status: 'reopened', ownerId: 'emp-jie', acceptedAt: null, arrivedAt: null })
    expect(state.taskEvents.at(-1)).toMatchObject({ taskId: task.id, type: 'task.reopened.v1', payload: { reason: 'owner_offline' } })
  })
})

describe('staff presence routes', () => {
  it('heartbeats and logs out only the current signed device session', async () => {
    const repository = new MemoryRepository()
    const app = Fastify()
    let now = Date.now()
    await registerAuthContext(app, {
      runtimeMode: 'production', sessionSecret: secret, readState: () => repository.read(),
    })
    await registerPresenceRoutes(app, repository, { leaseTtlMs: 10_000, sweepIntervalMs: 0, now: () => now })
    const sessionExpiresAt = now + 60_000
    await repository.mutate((state) => {
      establish(state, 'device-a', now, 10_000, sessionExpiresAt)
      establish(state, 'device-b', now, 10_000, sessionExpiresAt)
    })
    const token = (sessionId: string) => signStaffSession({
      sessionId, actorId: 'emp-chen', storeId: 'mbox-lujiazui', issuedAt: now, expiresAt: sessionExpiresAt,
    }, secret)

    now += 1_000
    const heartbeat = await app.inject({
      method: 'POST', url: '/api/auth/presence/heartbeat',
      headers: { authorization: `Bearer ${token('device-a')}` },
    })
    expect(heartbeat.statusCode, heartbeat.body).toBe(200)
    expect(heartbeat.json()).toMatchObject({ sessionId: 'device-a', actorId: 'emp-chen', online: true })

    const firstLogout = await app.inject({
      method: 'POST', url: '/api/auth/logout', headers: { authorization: `Bearer ${token('device-a')}` },
    })
    expect(firstLogout.json()).toMatchObject({ sessionId: 'device-a', online: true })
    const secondLogout = await app.inject({
      method: 'POST', url: '/api/auth/logout', headers: { authorization: `Bearer ${token('device-b')}` },
    })
    expect(secondLogout.json()).toMatchObject({ sessionId: 'device-b', online: false })
    expect((await repository.read()).presenceLeases).toEqual([])
    await app.close()
  })

  it('returns a re-login response after the lease expires', async () => {
    const repository = new MemoryRepository()
    const app = Fastify()
    let now = Date.now()
    await registerAuthContext(app, {
      runtimeMode: 'production', sessionSecret: secret, readState: () => repository.read(),
    })
    await registerPresenceRoutes(app, repository, { leaseTtlMs: 1_000, sweepIntervalMs: 0, now: () => now })
    const sessionExpiresAt = now + 60_000
    await repository.mutate((state) => establish(state, 'expired-device', now, 1_000, sessionExpiresAt))
    const token = signStaffSession({
      sessionId: 'expired-device', actorId: 'emp-chen', storeId: 'mbox-lujiazui', issuedAt: now, expiresAt: sessionExpiresAt,
    }, secret)

    now += 1_001
    const response = await app.inject({
      method: 'POST', url: '/api/auth/presence/heartbeat', headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json().code).toBe('PRESENCE_LEASE_EXPIRED')
    expect((await repository.read()).employees.find((employee) => employee.id === 'emp-chen')?.online).toBe(false)
    await app.close()
  })
})
