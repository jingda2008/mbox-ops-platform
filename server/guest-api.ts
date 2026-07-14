import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { RuntimeMode } from '../src/shared/auth-contracts.js'
import {
  guestTaskCreateSchema,
  guestTaskFeedbackSchema,
  guestSongRequestSchema,
  type GuestSessionResponse,
  type GuestTaskView,
  type TableAccessClaims,
} from '../src/shared/guest-contracts.js'
import type { RuntimeState, ServiceTask, Table } from '../src/shared/contracts.js'
import { applyTaskAction, createServiceTask } from './domain.js'
import type { RuntimeRepository } from './repository.js'
import { signTableAccessToken, TableAccessError, verifyTableAccessToken } from './table-access.js'
import { submitSongRequest } from './song-domain.js'

function deterministicId(prefix: string, key: string) {
  return `${prefix}_${createHash('sha256').update(key).digest('hex').slice(0, 32)}`
}

interface GuestApiOptions {
  secret: string
  runtimeMode: RuntimeMode
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

function sessionView(state: RuntimeState, table: Table, tableToken: string): GuestSessionResponse {
  const primary = state.employees.find((employee) => employee.id === table.primaryEmployeeId)
  const tableSession = state.songState.tableSessions.find(
    (candidate) => candidate.tableId === table.id && candidate.status === 'open',
  )
  const orders = tableSession
    ? state.orderDomain.orders.filter((order) => order.tableSessionId === tableSession.id)
    : []
  const ledgerEntries = tableSession
    ? state.orderDomain.tableLedgerEntries.filter((entry) => entry.tableSessionId === tableSession.id)
    : []
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
      .filter((task) => task.tableId === table.id)
      .slice(0, 10)
      .map((task) => taskView(state, task)),
    account: {
      tableSessionId: tableSession?.id ?? null,
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
      .filter((request) => request.tableId === table.id)
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
    tableToken,
    serverNow: new Date().toISOString(),
  }
}

function accessFromRequest(
  state: RuntimeState,
  token: string | undefined,
  legacyTable: string | undefined,
  options: GuestApiOptions,
) {
  if (token) return { claims: verifyTableAccessToken(token, options.secret), token }
  if ((options.runtimeMode === 'local' || options.runtimeMode === 'test') && legacyTable) {
    const claims = {
      storeId: state.store.id,
      tableCode: legacyTable,
      tokenVersion: tableTokenVersion(
        state.tables.find((table) => table.code.toLowerCase() === legacyTable.toLowerCase()) ??
          (() => { throw new TableAccessError('桌台不存在', 'TABLE_NOT_FOUND', 404) })(),
      ),
      issuedAt: Date.now(),
    }
    return { claims: { version: 1 as const, ...claims }, token: signTableAccessToken(claims, options.secret) }
  }
  throw new TableAccessError('缺少有效桌码')
}

export function registerGuestRoutes(app: FastifyInstance, repository: RuntimeRepository, options: GuestApiOptions) {
  app.get<{ Querystring: { token?: string; table?: string } }>('/api/guest/session', async (request) => {
    const state = await repository.read()
    const access = accessFromRequest(state, request.query.token, request.query.table, options)
    return sessionView(state, resolveTable(state, access.claims), access.token)
  })

  app.post('/api/guest/tasks', async (request, reply) => {
    const input = guestTaskCreateSchema.parse(request.body)
    const result = await repository.mutate((state) => {
      const claims = verifyTableAccessToken(input.tableToken, options.secret)
      const table = resolveTable(state, claims)
      if (table.status !== 'occupied') throw new TableAccessError('该桌台尚未开台，请呼叫迎宾', 'TABLE_SESSION_NOT_OPEN', 409)
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
      const claims = verifyTableAccessToken(input.tableToken, options.secret)
      const table = resolveTable(state, claims)
      const task = state.tasks.find((candidate) => candidate.id === request.params.taskId)
      if (!task || task.tableId !== table.id) {
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
      const claims = verifyTableAccessToken(input.tableToken, options.secret)
      const table = resolveTable(state, claims)
      const tableSession = state.songState.tableSessions.find(
        (candidate) => candidate.tableId === table.id && candidate.status === 'open',
      )
      if (!tableSession) throw new TableAccessError('当前桌台没有有效会话，暂不能点歌', 'TABLE_SESSION_NOT_OPEN', 409)
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
