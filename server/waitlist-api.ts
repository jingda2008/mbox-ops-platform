import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { RuntimeState, WaitlistEntry } from '../src/shared/contracts.js'
import { requireConfiguredOperation, requireTableDataScope } from './authorization.js'
import { startAwaitingOrder } from './proactive-service.js'
import type { RuntimeRepository } from './repository.js'
import { reservationsFor } from './reservation-api.js'
import { currentSalesEmployeeId, openTableSession, recordSalesAttribution } from './table-sessions.js'

const idempotencyKeySchema = z.string().trim().min(8).max(128)

function childIdempotencyKey(key: string, suffix: string) {
  return `${key.slice(0, Math.max(8, 118 - suffix.length))}:${suffix}`
}

const createSchema = z.object({
  customerReference: z.string().trim().min(1).max(128),
  customerName: z.string().trim().min(1).max(100),
  contactReference: z.string().trim().min(1).max(256),
  partySize: z.number().int().min(1).max(100),
  areaPreferenceCode: z.string().trim().min(1).max(64).optional(),
  originalReservationId: z.string().trim().min(1).max(128).optional(),
  salesEmployeeId: z.string().trim().min(1).max(128).optional(),
  maximumWaitMinutes: z.number().int().min(1).max(480),
  idempotencyKey: idempotencyKeySchema,
}).strict()

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('notify'), tableId: z.string().trim().min(1).max(128), reason: z.string().trim().min(2).max(300), idempotencyKey: idempotencyKeySchema }).strict(),
  z.object({ action: z.literal('seat'), reason: z.string().trim().min(2).max(300), idempotencyKey: idempotencyKeySchema }).strict(),
  z.object({ action: z.enum(['cancel', 'skip', 'expire']), reason: z.string().trim().min(2).max(300), idempotencyKey: idempotencyKeySchema }).strict(),
])

function audit(state: RuntimeState, entry: WaitlistEntry, actorId: string, action: string, occurredAt: string, details: Record<string, unknown>) {
  state.auditEntries.push({
    id: `audit_${randomUUID()}`,
    actorId,
    action,
    objectType: 'waitlistEntry',
    objectId: entry.id,
    occurredAt,
    details,
  })
}

function replay(state: RuntimeState, idempotencyKey: string, action: string, entryId?: string) {
  const event = state.auditEntries.find((item) => item.details.idempotencyKey === idempotencyKey)
  if (!event) return null
  if (event.action !== action || (entryId && event.objectId !== entryId)) throw new Error('幂等键已用于不同候补请求')
  return state.waitlistEntries.find((entry) => entry.id === event.objectId) ?? null
}

function releaseHeldTable(state: RuntimeState, entry: WaitlistEntry) {
  if (!entry.heldTableId) return
  const table = state.tables.find((item) => item.id === entry.heldTableId)
  if (table?.status === 'reserved' && !state.songState.tableSessions.some((session) => session.tableId === table.id && session.status === 'open')) {
    table.status = 'available'
    table.guestCount = 0
    table.openedAt = null
  }
}

function assertTargetPrimaryReady(state: RuntimeState, tableId: string) {
  const table = state.tables.find((item) => item.id === tableId)
  if (!table) throw new Error('候补目标桌台不存在')
  const primary = state.employees.find((employee) => employee.id === table.primaryEmployeeId && employee.status === 'active')
  const shift = primary && state.shiftAssignments.find((item) =>
    item.employeeId === primary.id && item.businessDate === state.store.businessDate && item.status === 'active' && item.areaIds.includes(table.areaId),
  )
  if (!primary || !primary.online || primary.paused || !shift) throw new Error('目标桌主服务员当前不可接待，请先完成员工调度')
  return table
}

export function registerWaitlistRoutes(app: FastifyInstance, repository: RuntimeRepository) {
  app.get('/api/waitlist', async (request) => {
    const state = await repository.read()
    requireConfiguredOperation(request, state, 'reservation.view')
    const entries = state.waitlistEntries.toSorted((left, right) => left.joinedSequence - right.joinedSequence)
    const active = entries.filter((entry) => ['waiting', 'notified'].includes(entry.status))
    return {
      entries,
      positions: Object.fromEntries(active.map((entry, index) => [entry.id, index + 1])),
      responseMinutes: reservationsFor(state).config.waitlistResponseMinutes,
    }
  })

  app.post('/api/waitlist', async (request, reply) => {
    const input = createSchema.parse(request.body)
    const result = await repository.mutate((state) => {
      const actor = requireConfiguredOperation(request, state, 'reservation.manage')
      const existing = replay(state, input.idempotencyKey, 'waitlist.joined.v1')
      if (existing) return existing
      const config = reservationsFor(state).config
      if (input.partySize < config.minimumPartySize || input.partySize > config.maximumPartySize) {
        throw new Error(`候补人数必须在${config.minimumPartySize}至${config.maximumPartySize}之间`)
      }
      if (input.areaPreferenceCode && !config.areaPreferences.some((area) => area.code === input.areaPreferenceCode && area.enabled)) {
        throw new Error('候补区域偏好未配置或已停用')
      }
      if (input.originalReservationId && !reservationsFor(state).reservations.some((reservation) => reservation.id === input.originalReservationId)) {
        throw new Error('关联的原预约不存在')
      }
      const occurredAt = new Date().toISOString()
      const entry: WaitlistEntry = {
        id: `waitlist:${randomUUID()}`,
        customerReference: input.customerReference,
        customerName: input.customerName,
        contactReference: input.contactReference,
        partySize: input.partySize,
        areaPreferenceCode: input.areaPreferenceCode ?? null,
        originalReservationId: input.originalReservationId ?? null,
        status: 'waiting',
        joinedSequence: Math.max(0, ...state.waitlistEntries.map((item) => item.joinedSequence)) + 1,
        joinedAt: occurredAt,
        maximumWaitUntil: new Date(Date.parse(occurredAt) + input.maximumWaitMinutes * 60_000).toISOString(),
        notifiedAt: null,
        responseExpiresAt: null,
        heldTableId: null,
        heldTableCode: null,
        tableSessionId: null,
        seatedAt: null,
        closedAt: null,
        closeReason: null,
        createdBy: actor.actorId,
        updatedAt: occurredAt,
        revision: 1,
        configVersion: config.version,
      }
      state.waitlistEntries.push(entry)
      if (input.salesEmployeeId) {
        recordSalesAttribution(state, {
          subjectType: 'waitlist', subjectId: entry.id, salesEmployeeId: input.salesEmployeeId,
          actorId: actor.actorId, reason: '候补登记时指定销售', occurredAt,
          idempotencyKey: childIdempotencyKey(input.idempotencyKey, 'sales'),
        })
      }
      audit(state, entry, actor.actorId, 'waitlist.joined.v1', occurredAt, { idempotencyKey: input.idempotencyKey, joinedSequence: entry.joinedSequence })
      state.revision += 1
      return entry
    })
    return reply.status(201).send(result)
  })

  app.post<{ Params: { entryId: string } }>('/api/waitlist/:entryId/actions', async (request) => {
    const input = actionSchema.parse(request.body)
    return repository.mutate((state) => {
      const actor = requireConfiguredOperation(request, state, 'reservation.manage')
      const actionName = `waitlist.${input.action}.v1`
      const existing = replay(state, input.idempotencyKey, actionName, request.params.entryId)
      if (existing) return existing
      const entry = state.waitlistEntries.find((item) => item.id === request.params.entryId)
      if (!entry) throw new Error('候补记录不存在')
      const occurredAt = new Date().toISOString()

      if (input.action === 'notify') {
        requireTableDataScope(request, state, input.tableId, 'reservation.manage')
        if (entry.status !== 'waiting') throw new Error('只有等待中的候补可以通知')
        if (Date.parse(entry.maximumWaitUntil) <= Date.parse(occurredAt)) throw new Error('候补最长等待时间已到，请先标记过期')
        const table = assertTargetPrimaryReady(state, input.tableId)
        if (table.status !== 'available') throw new Error('目标桌当前不可锁定')
        const earlier = state.waitlistEntries
          .filter((item) => item.status === 'waiting' && item.joinedSequence < entry.joinedSequence && item.partySize <= table.capacity)
          .filter((item) => !item.areaPreferenceCode || item.areaPreferenceCode === table.areaId)
          .toSorted((left, right) => left.joinedSequence - right.joinedSequence)[0]
        if (earlier) throw new Error(`前面还有可匹配候补：${earlier.customerName}（第${earlier.joinedSequence}号）`)
        table.status = 'reserved'
        entry.status = 'notified'
        entry.notifiedAt = occurredAt
        entry.responseExpiresAt = new Date(Date.parse(occurredAt) + reservationsFor(state).config.waitlistResponseMinutes * 60_000).toISOString()
        entry.heldTableId = table.id
        entry.heldTableCode = table.code
      } else if (input.action === 'seat') {
        if (entry.status !== 'notified' || !entry.heldTableId) throw new Error('只有已通知并锁桌的候补可以入座')
        requireTableDataScope(request, state, entry.heldTableId, 'reservation.manage')
        if (entry.responseExpiresAt && Date.parse(entry.responseExpiresAt) < Date.parse(occurredAt)) throw new Error('候补响应时间已过，请先标记过期')
        const table = assertTargetPrimaryReady(state, entry.heldTableId)
        if (table.status !== 'reserved') throw new Error('候补锁定桌台状态已变化')
        const session = openTableSession(state, table, occurredAt, {
          source: 'waitlist', sourceId: entry.id, guestCount: entry.partySize,
        })
        table.status = 'occupied'
        table.guestCount = entry.partySize
        table.openedAt = occurredAt
        entry.status = 'seated'
        entry.tableSessionId = session.id
        entry.seatedAt = occurredAt
        entry.closedAt = occurredAt
        const salesEmployeeId = currentSalesEmployeeId(state, 'waitlist', entry.id)
        if (salesEmployeeId) {
          recordSalesAttribution(state, {
            subjectType: 'table_session', subjectId: session.id, salesEmployeeId,
            actorId: actor.actorId, reason: '候补入座继承销售归属', occurredAt,
            idempotencyKey: childIdempotencyKey(input.idempotencyKey, 'sales'),
          })
        }
        if (state.config.proactiveOrderCare.enabled) {
          startAwaitingOrder(state, table.id, actor.actorId, `waitlist-seat:${entry.id}`, new Date(occurredAt))
        }
      } else {
        if (!['waiting', 'notified'].includes(entry.status)) throw new Error('当前候补状态不能结束')
        if (
          input.action === 'expire' &&
          Date.parse(entry.maximumWaitUntil) > Date.parse(occurredAt) &&
          (!entry.responseExpiresAt || Date.parse(entry.responseExpiresAt) > Date.parse(occurredAt))
        ) throw new Error('候补尚未到期；提前顺延请使用跳过')
        releaseHeldTable(state, entry)
        entry.status = input.action === 'cancel' ? 'cancelled' : input.action === 'skip' ? 'skipped' : 'expired'
        entry.closedAt = occurredAt
        entry.closeReason = input.reason
      }

      entry.updatedAt = occurredAt
      entry.revision += 1
      audit(state, entry, actor.actorId, actionName, occurredAt, {
        idempotencyKey: input.idempotencyKey,
        reason: input.reason,
        tableId: entry.heldTableId,
        responseExpiresAt: entry.responseExpiresAt,
        tableSessionId: entry.tableSessionId,
        tableCapacity: entry.heldTableId
          ? state.tables.find((table) => table.id === entry.heldTableId)?.capacity ?? null
          : null,
        extraSeatCount: entry.heldTableId
          ? Math.max(0, entry.partySize - (state.tables.find((table) => table.id === entry.heldTableId)?.capacity ?? entry.partySize))
          : 0,
      })
      state.revision += 1
      return entry
    })
  })
}
