import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { StaffPresenceResponse } from '../src/shared/auth-contracts.js'
import type { PresenceLease, RuntimeState } from '../src/shared/contracts.js'
import { requireRequestActor } from './auth-context.js'
import type { RuntimeRepository } from './repository.js'
import { redispatchUnownedTasks, releaseTasksForOfflineEmployee } from './domain.js'
import { MemoryPresenceLeaseStore, type PresenceLeaseStore } from './presence-store.js'

export const DEFAULT_PRESENCE_LEASE_TTL_MS = 90_000
export const DEFAULT_PRESENCE_SWEEP_INTERVAL_MS = 15_000

export interface EstablishPresenceInput {
  sessionId: string
  actorId: string
  storeId: string
  businessDate: string
  now: number
  leaseTtlMs: number
  sessionExpiresAt: number
}

export interface PresenceRoutesOptions {
  leaseTtlMs?: number
  sweepIntervalMs?: number
  now?: () => number
  leaseStore?: PresenceLeaseStore
}

function appendAudit(
  state: RuntimeState,
  actorId: string,
  action: string,
  sessionId: string,
  occurredAt: number,
  details: Record<string, unknown>,
) {
  state.auditEntries.push({
    id: `audit_${randomUUID()}`,
    actorId,
    action,
    objectType: 'staffSession',
    objectId: sessionId,
    occurredAt: new Date(occurredAt).toISOString(),
    details,
  })
}

function synchronizeOnlineProjection(state: RuntimeState, now: number) {
  const before = state.presenceLeases ?? []
  const activeEmployees = new Set(state.employees.filter((employee) => employee.status === 'active').map((employee) => employee.id))
  const leases = before.filter((lease) => (
    lease.storeId === state.store.id
    && lease.businessDate === state.store.businessDate
    && activeEmployees.has(lease.actorId)
    && lease.expiresAt > now
    && lease.sessionExpiresAt > now
  ))
  let changed = leases.length !== before.length || state.presenceLeases === undefined
  state.presenceLeases = leases
  const onlineEmployeeIds = new Set(leases.map((lease) => lease.actorId))
  for (const employee of state.employees) {
    const online = employee.status === 'active' && onlineEmployeeIds.has(employee.id)
    if (employee.online !== online) {
      const wentOffline = employee.online && !online
      employee.online = online
      if (wentOffline) releaseTasksForOfflineEmployee(state, employee.id, new Date(now))
      changed = true
    }
  }
  return changed
}

export function reconcilePresence(state: RuntimeState, now: number, advanceRevision = true) {
  const expiredSessionIds = (state.presenceLeases ?? [])
    .filter((lease) => lease.expiresAt <= now || lease.sessionExpiresAt <= now || lease.businessDate !== state.store.businessDate)
    .map((lease) => lease.sessionId)
  if (synchronizeOnlineProjection(state, now) && advanceRevision) state.revision += 1
  return { expiredSessionIds, onlineEmployeeIds: state.employees.filter((employee) => employee.online).map((employee) => employee.id) }
}

export function establishPresenceLease(state: RuntimeState, input: EstablishPresenceInput): PresenceLease {
  if (!Number.isSafeInteger(input.now) || input.leaseTtlMs <= 0 || input.sessionExpiresAt <= input.now) {
    throw new Error('在线租约时间无效')
  }
  if (input.storeId !== state.store.id || input.businessDate !== state.store.businessDate) {
    throw new Error('在线租约不属于当前门店营业日')
  }
  const employee = state.employees.find((candidate) => candidate.id === input.actorId && candidate.status === 'active')
  if (!employee) throw new Error('员工不存在或已停用')

  synchronizeOnlineProjection(state, input.now)
  const wasOnline = employee.online
  state.presenceLeases = state.presenceLeases!.filter((lease) => lease.sessionId !== input.sessionId)
  const lease: PresenceLease = {
    sessionId: input.sessionId,
    actorId: input.actorId,
    storeId: input.storeId,
    businessDate: input.businessDate,
    establishedAt: input.now,
    lastSeenAt: input.now,
    expiresAt: Math.min(input.now + input.leaseTtlMs, input.sessionExpiresAt),
    sessionExpiresAt: input.sessionExpiresAt,
  }
  state.presenceLeases.push(lease)
  synchronizeOnlineProjection(state, input.now)
  if (!wasOnline && employee.online) redispatchUnownedTasks(state, new Date(input.now))
  appendAudit(state, input.actorId, 'staff_presence.established.v1', input.sessionId, input.now, {
    businessDate: input.businessDate,
    leaseExpiresAt: lease.expiresAt,
  })
  state.revision += 1
  return lease
}

export function heartbeatPresenceLease(
  state: RuntimeState,
  sessionId: string,
  actorId: string,
  now: number,
  leaseTtlMs: number,
) {
  const changedByReconciliation = synchronizeOnlineProjection(state, now)
  const lease = state.presenceLeases!.find((candidate) => (
    candidate.sessionId === sessionId
    && candidate.actorId === actorId
    && candidate.businessDate === state.store.businessDate
  ))
  if (!lease) {
    if (changedByReconciliation) state.revision += 1
    return null
  }
  lease.lastSeenAt = now
  lease.expiresAt = Math.min(now + leaseTtlMs, lease.sessionExpiresAt)
  synchronizeOnlineProjection(state, now)
  state.revision += 1
  return lease
}

export function resumePresenceLease(state: RuntimeState, input: EstablishPresenceInput) {
  const explicitlyEnded = state.auditEntries.some((entry) => (
    entry.action === 'staff_presence.ended.v1'
    && entry.objectType === 'staffSession'
    && entry.objectId === input.sessionId
  ))
  if (explicitlyEnded) return null

  const existing = state.presenceLeases?.find((lease) => (
    lease.sessionId === input.sessionId
    && lease.actorId === input.actorId
    && lease.storeId === input.storeId
    && lease.businessDate === input.businessDate
    && lease.expiresAt > input.now
    && lease.sessionExpiresAt > input.now
  ))
  return existing ?? establishPresenceLease(state, input)
}

export function endPresenceLease(state: RuntimeState, sessionId: string, actorId: string, now: number) {
  const changedByReconciliation = synchronizeOnlineProjection(state, now)
  const before = state.presenceLeases!.length
  state.presenceLeases = state.presenceLeases!.filter((lease) => (
    lease.sessionId !== sessionId || lease.actorId !== actorId
  ))
  const ended = state.presenceLeases.length !== before
  const projectionChanged = synchronizeOnlineProjection(state, now)
  if (ended) {
    appendAudit(state, actorId, 'staff_presence.ended.v1', sessionId, now, {})
  }
  if (changedByReconciliation || ended || projectionChanged) state.revision += 1
  return state.employees.find((employee) => employee.id === actorId)?.online ?? false
}

export function clearPresenceLeases(state: RuntimeState, now: number) {
  const sessionIds = (state.presenceLeases ?? []).map((lease) => lease.sessionId)
  state.presenceLeases = []
  const changed = synchronizeOnlineProjection(state, now)
  if (sessionIds.length > 0 || changed) state.revision += 1
  return sessionIds
}

function responseFor(
  state: RuntimeState,
  actorId: string,
  sessionId: string,
  lease: PresenceLease | null,
  leaseTtlMs: number,
): StaffPresenceResponse {
  return {
    sessionId,
    actorId,
    online: Boolean(lease) || (state.employees.find((employee) => employee.id === actorId)?.online ?? false),
    leaseExpiresAt: lease?.expiresAt ?? null,
    heartbeatAfterMs: Math.max(1_000, Math.floor(leaseTtlMs / 2)),
  }
}

export async function registerPresenceRoutes(
  app: FastifyInstance,
  repository: RuntimeRepository,
  options: PresenceRoutesOptions = {},
) {
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_PRESENCE_LEASE_TTL_MS
  const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_PRESENCE_SWEEP_INTERVAL_MS
  const now = options.now ?? Date.now
  const normalizedLeaseStore = options.leaseStore
  const leaseStore = options.leaseStore ?? new MemoryPresenceLeaseStore()
  if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs <= 0) throw new Error('presence leaseTtlMs必须为正整数')
  if (!Number.isSafeInteger(sweepIntervalMs) || sweepIntervalMs < 0) throw new Error('presence sweepIntervalMs不能为负数')

  if (normalizedLeaseStore) {
    const initialState = await repository.read()
    reconcilePresence(initialState, now(), false)
    await leaseStore.upsertMany(initialState.presenceLeases ?? [])
  } else {
    await repository.mutate((state) => reconcilePresence(state, now()))
  }

  app.post('/api/auth/presence/heartbeat', async (request, reply) => {
    const actor = requireRequestActor(request)
    if (!actor.sessionId || !actor.sessionExpiresAt) {
      return reply.status(401).send({ code: 'SIGNED_SESSION_REQUIRED', message: '心跳需要签名员工会话' })
    }
    if (!normalizedLeaseStore) {
      const result = await repository.mutate((state) => {
        const heartbeatAt = now()
        const lease = heartbeatPresenceLease(state, actor.sessionId!, actor.actorId, heartbeatAt, leaseTtlMs)
          ?? resumePresenceLease(state, {
            sessionId: actor.sessionId!, actorId: actor.actorId, storeId: actor.storeId,
            businessDate: state.store.businessDate, now: heartbeatAt, leaseTtlMs,
            sessionExpiresAt: actor.sessionExpiresAt!,
          })
        return responseFor(state, actor.actorId, actor.sessionId!, lease, leaseTtlMs)
      })
      if (!result.leaseExpiresAt) {
        return reply.status(401).send({ code: 'PRESENCE_LEASE_EXPIRED', message: '在线会话已过期，请重新登录' })
      }
      return result
    }

    const heartbeatAt = now()
    if (actor.presenceExpiresAt && actor.businessDate) {
      return {
        sessionId: actor.sessionId,
        actorId: actor.actorId,
        online: true,
        leaseExpiresAt: actor.presenceExpiresAt,
        heartbeatAfterMs: Math.max(1_000, Math.floor(leaseTtlMs / 2)),
      } satisfies StaffPresenceResponse
    }
    const authState = request.mboxAuthState
    const businessDate = actor.businessDate ?? authState?.store.businessDate
    if (!businessDate) throw new Error('在线会话缺少营业日上下文')
    let lease = await leaseStore.heartbeat({
      sessionId: actor.sessionId,
      actorId: actor.actorId,
      businessDate,
      now: heartbeatAt,
      leaseTtlMs,
    })
    if (!lease) {
      lease = await repository.mutate((state) => resumePresenceLease(state, {
        sessionId: actor.sessionId!,
        actorId: actor.actorId,
        storeId: actor.storeId,
        businessDate: state.store.businessDate,
        now: heartbeatAt,
        leaseTtlMs,
        sessionExpiresAt: actor.sessionExpiresAt!,
      }))
      if (lease) await leaseStore.upsert(lease)
    }
    const result: StaffPresenceResponse = {
      sessionId: actor.sessionId,
      actorId: actor.actorId,
      online: Boolean(lease),
      leaseExpiresAt: lease?.expiresAt ?? null,
      heartbeatAfterMs: Math.max(1_000, Math.floor(leaseTtlMs / 2)),
    }
    if (!result.leaseExpiresAt) {
      return reply.status(401).send({ code: 'PRESENCE_LEASE_EXPIRED', message: '在线会话已过期，请重新登录' })
    }
    return result
  })

  app.post('/api/auth/logout', async (request, reply) => {
    const actor = requireRequestActor(request)
    if (!actor.sessionId) {
      return reply.status(401).send({ code: 'SIGNED_SESSION_REQUIRED', message: '退出需要签名员工会话' })
    }
    if (!normalizedLeaseStore) {
      return repository.mutate((state) => {
        endPresenceLease(state, actor.sessionId!, actor.actorId, now())
        return responseFor(state, actor.actorId, actor.sessionId!, null, leaseTtlMs)
      })
    }
    const logoutAt = now()
    await leaseStore.revoke({ sessionId: actor.sessionId, actorId: actor.actorId, now: logoutAt })
    const businessDate = actor.businessDate ?? request.mboxAuthState?.store.businessDate
    if (!businessDate) throw new Error('在线会话缺少营业日上下文')
    const activeLeases = await leaseStore.listActive(businessDate, logoutAt)
    try {
      return await repository.mutate((state) => {
        endPresenceLease(state, actor.sessionId!, actor.actorId, logoutAt)
        state.presenceLeases = activeLeases
        reconcilePresence(state, logoutAt)
        return responseFor(state, actor.actorId, actor.sessionId!, null, leaseTtlMs)
      })
    } catch (error) {
      app.log.error({ error, sessionId: actor.sessionId, actorId: actor.actorId }, 'presence projection failed after durable logout revocation')
      return {
        sessionId: actor.sessionId,
        actorId: actor.actorId,
        online: activeLeases.some((lease) => lease.actorId === actor.actorId),
        leaseExpiresAt: null,
        heartbeatAfterMs: Math.max(1_000, Math.floor(leaseTtlMs / 2)),
      } satisfies StaffPresenceResponse
    }
  })

  if (sweepIntervalMs > 0) {
    const timer = setInterval(() => {
      const sweepAt = now()
      void repository.read().then(async (snapshot) => {
        if (!normalizedLeaseStore) {
          const probe = structuredClone(snapshot)
          const previousRevision = probe.revision
          reconcilePresence(probe, sweepAt)
          if (probe.revision === previousRevision) return undefined
          return repository.mutate((state) => reconcilePresence(state, sweepAt))
        }
        await leaseStore.removeExpired(snapshot.store.businessDate, sweepAt)
        const activeLeases = await leaseStore.listActive(snapshot.store.businessDate, sweepAt)
        const activeEmployeeIds = new Set(activeLeases.map((lease) => lease.actorId))
        const projectionChanged = snapshot.employees.some((employee) => (
          employee.online !== (employee.status === 'active' && activeEmployeeIds.has(employee.id))
        ))
        if (!projectionChanged) return undefined
        return repository.mutate((state) => {
          state.presenceLeases = activeLeases
          return reconcilePresence(state, sweepAt)
        })
      }).catch((error: unknown) => {
        app.log.error({ error }, 'presence lease sweep failed')
      })
    }, sweepIntervalMs)
    timer.unref()
    app.addHook('onClose', async () => clearInterval(timer))
  }
}
