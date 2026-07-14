import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { RuntimeMode } from '../src/shared/auth-contracts.js'
import {
  guestTaskCreateSchema,
  guestTaskFeedbackSchema,
  guestSongRequestSchema,
  type GuestSessionClaims,
  type GuestSessionResponse,
  type GuestTaskView,
  type TableAccessClaims,
} from '../src/shared/guest-contracts.js'
import type { RuntimeState, ServiceTask, Table } from '../src/shared/contracts.js'
import type { SongTableSession } from '../src/shared/song-contracts.js'
import { applyTaskAction, createServiceTask } from './domain.js'
import type { RuntimeRepository } from './repository.js'
import {
  requireGuestSession,
  signGuestSessionToken,
  TableAccessError,
  verifyTableAccessToken,
} from './table-access.js'
import { submitSongRequest } from './song-domain.js'

const DEFAULT_GUEST_SESSION_TTL_MS = 15 * 60_000

function deterministicId(prefix: string, key: string) {
  return `${prefix}_${createHash('sha256').update(key).digest('hex').slice(0, 32)}`
}

interface GuestApiOptions {
  secret: string
  runtimeMode: RuntimeMode
  guestSessionTtlMs?: number
  now?: () => number
}

function tableTokenVersion(table: Table) {
  const version = (table as Table & { qrTokenVersion?: number }).qrTokenVersion
  return Number.isSafeInteger(version) && Number(version) > 0 ? Number(version) : 1
}

function resolveTable(state: RuntimeState, claims: TableAccessClaims) {
  if (claims.storeId !== state.store.id) throw new TableAccessError('桌码不属于当前门店', 'TABLE_STORE_MISMATCH', 403)
  const table = state.tables.find((candidate) => candidate.code.toLowerCase() === claims.tableCode.toLowerCase())
  if (!table) throw new TableAccessError('桌台不存在', 'TABLE_NOT_FOUND', 404)
  if (claims.tokenVersion !== tableTokenVersion(table)) {
    throw new TableAccessError('桌码已经失效，请联系服务人员', 'TABLE_TOKEN_REVOKED', 410)
  }
  return table
}

function resolveOpenTableSession(state: RuntimeState, table: Table) {
  if (table.status !== 'occupied') {
    throw new TableAccessError('该桌台尚未开台，请呼叫迎宾', 'TABLE_SESSION_NOT_OPEN', 409)
  }
  const sessions = state.songState.tableSessions.filter(
    (candidate) => candidate.tableId === table.id && candidate.status === 'open',
  )
  if (sessions.length !== 1) {
    throw new TableAccessError(
      sessions.length === 0 ? '当前桌台没有有效桌次，请联系服务人员' : '当前桌台存在重复开放桌次，请联系服务人员',
      sessions.length === 0 ? 'TABLE_SESSION_NOT_OPEN' : 'TABLE_SESSION_AMBIGUOUS',
      409,
    )
  }
  return sessions[0]!
}

function resolveGuestSession(state: RuntimeState, claims: GuestSessionClaims) {
  const table = resolveTable(state, claims)
  const tableSession = resolveOpenTableSession(state, table)
  if (claims.tableSessionId !== tableSession.id) {
    throw new TableAccessError('本次桌次已经结束，请重新扫描桌上二维码', 'GUEST_SESSION_REVOKED', 410)
  }
  return { table, tableSession }
}

function guestSessionTtl(options: GuestApiOptions) {
  const ttl = options.guestSessionTtlMs ?? DEFAULT_GUEST_SESSION_TTL_MS
  if (!Number.isSafeInteger(ttl) || ttl < 60_000 || ttl > 60 * 60_000) {
    throw new Error('客人桌次令牌有效期必须在1分钟到60分钟之间')
  }
  return ttl
}

function mintGuestSession(
  storeId: string,
  table: Table,
  tableSession: SongTableSession,
  options: GuestApiOptions,
  now: number,
) {
  const claims: Omit<GuestSessionClaims, 'version' | 'tokenType'> = {
    storeId,
    tableCode: table.code,
    tableSessionId: tableSession.id,
    tokenVersion: tableTokenVersion(table),
    issuedAt: now,
    expiresAt: now + guestSessionTtl(options),
  }
  return claims
}

function taskView(state: RuntimeState, task: ServiceTask): GuestTaskView {
  return {
    id: task.id,
    serviceTypeId: task.serviceTypeId,
    status: task.status,
    priority: task.priority,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    customerReply: task.customerReply,
    ownerName: state.employees.find((employee) => employee.id === task.ownerId)?.displayName ?? null,
  }
}

function sessionView(
  state: RuntimeState,
  table: Table,
  tableSession: SongTableSession,
  sessionClaims: Omit<GuestSessionClaims, 'version' | 'tokenType'>,
  tableToken: string,
): GuestSessionResponse {
  const primary = state.employees.find((employee) => employee.id === table.primaryEmployeeId)
  const orders = state.orderDomain.orders.filter((order) => order.tableSessionId === tableSession.id)
  const ledgerEntries = state.orderDomain.tableLedgerEntries.filter((entry) => entry.tableSessionId === tableSession.id)
  const balanceAmount = ledgerEntries.at(-1)?.balanceAfter ?? orders.reduce((sum, order) => sum + order.amounts.payableAmount, 0)
  const songOffers = state.songState.performanceSessions
    .filter((performance) => performance.status === 'scheduled' || performance.status === 'live')
    .flatMap((performance) => performance.appearances
      .filter((appearance) => appearance.acceptingRequests)
      .flatMap((appearance) => state.songState.repertoire
        .filter((entry) => entry.enabled && entry.singerId === appearance.singerId)
        .flatMap((entry) => {
          const singer = state.songState.singers.find((item) => item.id === entry.singerId && item.active)
          const song = state.songState.songs.find((item) => item.id === entry.songId && item.active)
          if (!singer || !song) return []
          return [{
            id: `${appearance.id}:${entry.id}`,
            performanceSessionId: performance.id,
            appearanceId: appearance.id,
            singerId: singer.id,
            songId: song.id,
            songTitle: song.title,
            songArtist: song.artist,
            singerName: singer.displayName,
            priceAmount: entry.priceAmount,
            currency: entry.currency,
            startsAt: appearance.startsAt,
          }]
        })))
  return {
    store: { id: state.store.id, name: state.store.name, businessDate: state.store.businessDate },
    table: {
      code: table.code,
      displayName: table.displayName,
      status: table.status,
      occupied: table.status === 'occupied',
    },
    primaryServiceName: primary?.displayName ?? null,
    serviceTypes: state.config.serviceTypes
      .filter((serviceType) => serviceType.enabled)
      .map(({ id, code, name, icon, priority }) => ({ id, code, name, icon, priority })),
    tasks: state.tasks
      .filter((task) => task.tableId === table.id && Date.parse(task.createdAt) >= Date.parse(tableSession.openedAt))
      .slice(0, 10)
      .map((task) => taskView(state, task)),
    account: {
      tableSessionId: tableSession.id,
      balanceAmount,
      orders: orders.map((order) => ({
        id: order.id,
        status: order.status,
        createdAt: order.createdAt,
        payableAmount: order.amounts.payableAmount,
        items: order.items.map((item) => ({
          id: item.id,
          name: item.name,
          specification: item.specification,
          quantity: item.quantity,
          amount: item.unitSalePriceAmount * item.quantity,
          fulfillmentStatus: item.fulfillmentStatus,
        })),
      })),
    },
    songOffers,
    songRequests: state.songState.requests
      .filter((request) => request.tableSessionId === tableSession.id)
      .slice(-20)
      .reverse()
      .map((request) => ({
        id: request.id,
        status: request.status,
        songTitle: request.priceSnapshot.songTitle,
        singerName: request.priceSnapshot.singerName,
        priceAmount: request.priceSnapshot.priceAmount,
        currency: request.priceSnapshot.currency,
        createdAt: request.createdAt,
      })),
    guestSession: {
      tableSessionId: tableSession.id,
      expiresAt: new Date(sessionClaims.expiresAt).toISOString(),
      tokenVersion: sessionClaims.tokenVersion,
    },
    tableToken,
    serverNow: new Date().toISOString(),
  }
}

function exchangeAccessFromRequest(
  state: RuntimeState,
  token: string | undefined,
  legacyTable: string | undefined,
  options: GuestApiOptions,
) {
  const now = options.now?.() ?? Date.now()
  if (token) {
    const claims = verifyTableAccessToken(token, options.secret, now)
    const table = resolveTable(state, claims)
    const tableSession = claims.tokenType === 'guest_session'
      ? resolveGuestSession(state, claims).tableSession
      : resolveOpenTableSession(state, table)
    const sessionClaims = mintGuestSession(state.store.id, table, tableSession, options, now)
    return {
      table,
      tableSession,
      sessionClaims,
      token: signGuestSessionToken(sessionClaims, options.secret),
    }
  }
  if ((options.runtimeMode === 'local' || options.runtimeMode === 'test') && legacyTable) {
    const table = state.tables.find((candidate) => candidate.code.toLowerCase() === legacyTable.toLowerCase())
    if (!table) throw new TableAccessError('桌台不存在', 'TABLE_NOT_FOUND', 404)
    const tableSession = resolveOpenTableSession(state, table)
    const sessionClaims = mintGuestSession(state.store.id, table, tableSession, options, now)
    return {
      table,
      tableSession,
      sessionClaims,
      token: signGuestSessionToken(sessionClaims, options.secret),
    }
  }
  throw new TableAccessError('缺少有效桌码')
}

function writeAccessFromToken(state: RuntimeState, token: string, options: GuestApiOptions) {
  const claims = requireGuestSession(verifyTableAccessToken(token, options.secret, options.now?.() ?? Date.now()))
  return resolveGuestSession(state, claims)
}

export function registerGuestRoutes(app: FastifyInstance, repository: RuntimeRepository, options: GuestApiOptions) {
  app.get<{ Querystring: { token?: string; table?: string } }>('/api/guest/session', async (request) => {
    const state = await repository.read()
    const access = exchangeAccessFromRequest(state, request.query.token, request.query.table, options)
    return sessionView(state, access.table, access.tableSession, access.sessionClaims, access.token)
  })

  app.post('/api/guest/tasks', async (request, reply) => {
    const input = guestTaskCreateSchema.parse(request.body)
    const result = await repository.mutate((state) => {
      const { table } = writeAccessFromToken(state, input.tableToken, options)
      const task = createServiceTask(state, {
        tableCode: table.code,
        serviceTypeId: input.serviceTypeId,
        source: 'guest',
        note: input.note,
        idempotencyKey: input.idempotencyKey,
      })
      return taskView(state, task)
    })
    return reply.status(201).send(result)
  })

  app.post<{ Params: { taskId: string } }>('/api/guest/tasks/:taskId/feedback', async (request) => {
    const input = guestTaskFeedbackSchema.parse(request.body)
    return repository.mutate((state) => {
      const { table, tableSession } = writeAccessFromToken(state, input.tableToken, options)
      const task = state.tasks.find((candidate) => candidate.id === request.params.taskId)
      if (
        !task || task.tableId !== table.id ||
        Date.parse(task.createdAt) < Date.parse(tableSession.openedAt)
      ) {
        throw new TableAccessError('不能操作其他桌台的任务', 'GUEST_TASK_ACCESS_FORBIDDEN', 403)
      }
      return taskView(state, applyTaskAction(state, task.id, {
        action: input.action,
        actorId: `guest-${table.code}`,
        note: input.note,
        idempotencyKey: input.idempotencyKey,
      }))
    })
  })

  app.post('/api/guest/song-requests', async (request, reply) => {
    const input = guestSongRequestSchema.parse(request.body)
    const result = await repository.mutate((state) => {
      const { table, tableSession } = writeAccessFromToken(state, input.tableToken, options)
      const performance = state.songState.performanceSessions.find((candidate) =>
        candidate.appearances.some((appearance) => appearance.id === input.appearanceId),
      )
      if (!performance) throw new TableAccessError('演出场次不存在', 'PERFORMANCE_NOT_FOUND', 404)
      const idempotencyCount = state.songState.idempotencyRecords.length
      const songRequest = submitSongRequest(state.songState, {
        requestId: deterministicId('song_request', input.idempotencyKey),
        performanceSessionId: performance.id,
        appearanceId: input.appearanceId,
        tableSessionId: tableSession.id,
        singerId: input.singerId,
        songId: input.songId,
        requestedBy: `guest-${table.code}`,
        customerNote: input.customerNote,
        occurredAt: new Date().toISOString(),
        idempotencyKey: input.idempotencyKey,
      })
      if (state.songState.idempotencyRecords.length !== idempotencyCount) state.revision += 1
      return songRequest
    })
    return reply.status(201).send(result)
  })
}
