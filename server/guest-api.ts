import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { RuntimeMode } from '../src/shared/auth-contracts.js'
import {
  guestTaskCreateSchema,
  guestTaskFeedbackSchema,
  guestSongRequestSchema,
  guestCartOrderSchema,
  guestCheckoutSchema,
  type GuestSessionClaims,
  type GuestSessionResponse,
  type GuestTaskView,
  type TableAccessClaims,
} from '../src/shared/guest-contracts.js'
import { guestBehaviorEventSchema, type GuestBehaviorEventType, type GuestBehaviorValue } from '../src/shared/guest-insight-contracts.js'
import type { RuntimeState, ServiceTask, Table } from '../src/shared/contracts.js'
import { chinaBusinessDateKey } from '../src/shared/china-time.js'
import type { PaymentIntent } from '../src/shared/payment-contracts.js'
import type { Order } from '../src/shared/order-contracts.js'
import { productAvailability } from '../src/shared/product-availability.js'
import type { SongTableSession } from '../src/shared/song-contracts.js'
import { applyTaskAction, createServiceTask, mergeServiceTaskRequest } from './domain.js'
import type { RuntimeRepository } from './repository.js'
import {
  requireGuestSession,
  requireStaticTableQr,
  signGuestSessionToken,
  TableAccessError,
  verifyTableAccessToken,
} from './table-access.js'
import { resolveSongRequestMode, submitSongRequest } from './song-domain.js'
import { createOrderDraft, submitOrder } from './order-domain.js'
import { createPaymentIntent, expirePaymentIntents, handlePaymentNotification } from './payment-domain.js'
import { consumeManagedInventoryForSubmittedOrder } from './inventory-order-integration.js'
import { completeAwaitingOrderOnOrder } from './proactive-service.js'
import { syncOrderFulfillmentWorkstations } from './fulfillment-workstations.js'
import {
  applyProviderPaymentCreation,
  createEnvironmentPaymentProviderResolver,
  requestPaymentThroughProvider,
  type PaymentProviderResolver,
} from './payment-provider.js'
import {
  tableSessionBusinessDate,
  tableSessionOperation,
  tableSessionRequiresHandover,
} from './table-sessions.js'
import { MemoryGuestInsightsStore, type GuestInsightsStore } from './guest-insights.js'
import {
  commercialOpsFor,
  queuePrintJobsForOrder,
  recentGuestOrderCount,
  recentMatchingGuestOrder,
} from './commercial-ops.js'
import { addConfiguredProductToOrder } from './product-order-expansion.js'

const DEFAULT_GUEST_SESSION_TTL_MS = 60 * 60_000

function deterministicId(prefix: string, key: string) {
  return `${prefix}_${createHash('sha256').update(key).digest('hex').slice(0, 32)}`
}

function paymentUrl(intent: PaymentIntent) {
  const value = intent.providerPaymentPayload?.qrCodeUrl
  return typeof value === 'string' && value.startsWith('https://') ? value : null
}

function publicCheckoutResult(input: {
  paymentIntent: PaymentIntent
  order: Order
  providerRequired: boolean
  wechatJsapiParameters: null
  paymentUrl: string | null
}) {
  return {
    paymentIntent: input.paymentIntent,
    order: input.order,
    providerRequired: input.paymentIntent.status !== 'succeeded',
    wechatJsapiParameters: input.wechatJsapiParameters,
    paymentUrl: paymentUrl(input.paymentIntent) ?? input.paymentUrl,
  }
}

interface GuestApiOptions {
  secret: string
  previousSecret?: string
  runtimeMode: RuntimeMode
  allowPaymentSimulation?: boolean
  guestSessionTtlMs?: number
  now?: () => number
  providerResolver?: PaymentProviderResolver
  guestInsights?: GuestInsightsStore
}

function verifyGuestEntryToken(token: string, options: GuestApiOptions, now: number) {
  try {
    return verifyTableAccessToken(token, options.secret, now)
  } catch (currentSecretError) {
    if (!options.previousSecret) throw currentSecretError
    try {
      return requireStaticTableQr(verifyTableAccessToken(token, options.previousSecret, now))
    } catch (previousSecretError) {
      if (previousSecretError instanceof TableAccessError && previousSecretError.code === 'TABLE_QR_REQUIRED') {
        throw previousSecretError
      }
      throw currentSecretError
    }
  }
}

const guestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const guestSources = new Set(['guest_web', 'miniprogram', 'service_account', 'staff_assisted'])
type GuestInsightCoordinates = { tableSessionId: string; tableCode: string; businessDate: string }
const clientGuestEventMetadata = {
  tab_viewed: new Set(['tab']),
  mood_selected: new Set(['moodId', 'previousMoodId']),
  category_viewed: new Set(['categoryId']),
  recommendation_viewed: new Set(['productId', 'partySize', 'intent', 'taste', 'dwell']),
  quick_select_started: new Set<string>(),
  quick_select_exited: new Set(['reason']),
  quick_select_answered: new Set(['field', 'value', 'step']),
  quick_select_completed: new Set(['intent', 'taste', 'dwell']),
  recommendation_reranked: new Set(['categoryId', 'partySize', 'intent', 'taste', 'dwell']),
  recommendation_result_updated: new Set(['source', 'primaryProductId', 'comparisonProductIds', 'changed']),
  shake_requested: new Set(['productId', 'attempt', 'score']),
  shake_result_viewed: new Set(['productId', 'attempt']),
  product_detail_viewed: new Set(['productId']),
  recommendation_accepted: new Set(['productId']),
  upgrade_accepted: new Set(['productId', 'fromProductId']),
  product_added: new Set(['productId', 'quantity']),
  product_removed: new Set(['productId', 'quantity']),
  cart_cleared: new Set<string>(),
  cart_abandoned: new Set(['itemCount', 'distinctProductCount', 'totalAmount', 'lastView']),
  cart_submitted: new Set(['itemCount', 'distinctProductCount']),
  singer_profile_viewed: new Set(['appearanceId', 'singerId']),
} as const

function clientBehaviorMetadata(
  eventType: GuestBehaviorEventType,
  metadata: Record<string, GuestBehaviorValue>,
) {
  const allowed = clientGuestEventMetadata[eventType as keyof typeof clientGuestEventMetadata]
  if (!allowed) throw new TableAccessError('这个行为只能由系统确认后记录', 'GUEST_EVENT_SERVER_OWNED', 400)
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => allowed.has(key as never)))
}

function deterministicGuestId(value: string) {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32).split('')
  hex[12] = '4'
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16]!, 16) % 4]!
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`
}

function guestIdentityFromRequest(request: FastifyRequest, fallback: () => string) {
  const supplied = String(request.headers['x-mbox-guest-id'] ?? '').trim()
  return guestIdPattern.test(supplied) ? supplied.toLowerCase() : fallback()
}

function guestIdentityForWrite(request: FastifyRequest, tableToken: string, options: GuestApiOptions) {
  const claims = requireGuestSession(verifyTableAccessToken(tableToken, options.secret, options.now?.() ?? Date.now()))
  return guestIdentityFromRequest(request, () => deterministicGuestId(`legacy-table-session:${claims.tableSessionId}`))
}

function guestSourceFromRequest(request: FastifyRequest) {
  const supplied = String(request.headers['x-mbox-guest-source'] ?? '').trim()
  return guestSources.has(supplied) ? supplied as 'guest_web' | 'miniprogram' | 'service_account' | 'staff_assisted' : 'guest_web'
}

async function recordGuestInsight(
  request: FastifyRequest,
  store: GuestInsightsStore,
  input: {
    anonymousId: string
    tableSessionId: string
    tableCode: string
    businessDate: string
    eventType: GuestBehaviorEventType
    metadata?: Record<string, GuestBehaviorValue>
    idempotencyKey: string
    occurredAt?: string
  },
) {
  try {
    await store.recordEvent({
      anonymousId: input.anonymousId,
      tableSessionId: input.tableSessionId,
      tableCode: input.tableCode,
      businessDate: input.businessDate,
      eventType: input.eventType,
      source: guestSourceFromRequest(request),
      occurredAt: input.occurredAt ?? new Date().toISOString(),
      metadata: input.metadata ?? {},
      idempotencyKey: input.idempotencyKey,
    })
  } catch (error) {
    request.log.error({ err: error, eventType: input.eventType }, 'guest insight event persistence failed')
  }
}

function tableTokenVersion(table: Table) {
  const version = (table as Table & { qrTokenVersion?: number }).qrTokenVersion
  return Number.isSafeInteger(version) && Number(version) > 0 ? Number(version) : 1
}

function resolveTable(state: RuntimeState, claims: TableAccessClaims) {
  if (claims.storeId !== state.store.id) throw new TableAccessError('这个桌码好像走错门店了，请扫一下桌面上的 M-BOX 二维码。', 'TABLE_STORE_MISMATCH', 403)
  const table = state.tables.find((candidate) => candidate.code.toLowerCase() === claims.tableCode.toLowerCase())
  if (!table) throw new TableAccessError('没有找到这张桌子，请让迎宾伙伴帮您确认一下桌码。', 'TABLE_NOT_FOUND', 404)
  if (claims.tokenVersion !== tableTokenVersion(table)) {
    throw new TableAccessError('这张桌码已经换新啦，请重新扫一下桌面二维码，我们马上接上服务。', 'TABLE_TOKEN_REVOKED', 410)
  }
  return table
}

function resolveOpenTableSession(state: RuntimeState, table: Table) {
  if (table.status !== 'occupied') {
    throw new TableAccessError('欢迎到店～这张桌子还没完成入座登记，请招呼迎宾伙伴帮您开台。', 'TABLE_SESSION_NOT_OPEN', 409)
  }
  const sessions = state.songState.tableSessions.filter(
    (candidate) => candidate.tableId === table.id && candidate.status === 'open',
  )
  if (sessions.length !== 1) {
    throw new TableAccessError(
      sessions.length === 0
        ? '这张桌子的服务还没接上，请招呼身边伙伴，我们马上帮您处理。'
        : '这张桌子的状态需要我们确认一下，请呼叫服务伙伴，马上帮您处理。',
      sessions.length === 0 ? 'TABLE_SESSION_NOT_OPEN' : 'TABLE_SESSION_AMBIGUOUS',
      409,
    )
  }
  return sessions[0]!
}

function resolveGuestSession(state: RuntimeState, claims: GuestSessionClaims) {
  const table = resolveTable(state, claims)
  const claimedSession = state.songState.tableSessions.find((session) => session.id === claims.tableSessionId)
  if (claimedSession?.status === 'open' && claimedSession.tableId !== table.id) {
    throw new TableAccessError('新座位已经为您接好啦～请扫一下新桌二维码，服务会跟着您一起过去。', 'GUEST_SESSION_REVOKED', 410)
  }
  const tableSession = resolveOpenTableSession(state, table)
  if (claims.tableSessionId !== tableSession.id) {
    throw new TableAccessError('这一桌的服务旅程已经结束啦，需要继续时重新扫一下桌面二维码就好。', 'GUEST_SESSION_REVOKED', 410)
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
    serviceTypeName: state.config.serviceTypes.find((serviceType) => serviceType.id === task.serviceTypeId)?.name ?? '服务进度',
    status: task.status,
    priority: task.priority,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    customerReply: task.customerReply,
    ownerName: state.employees.find((employee) => employee.id === task.ownerId)?.displayName ?? null,
  }
}

function bypassesGuestServiceRateLimit(serviceType: RuntimeState['config']['serviceTypes'][number]) {
  return /(COMPLAINT|SAFETY|SECURITY|EMERGENCY)/i.test(`${serviceType.code} ${serviceType.id}`)
    || /(投诉|安全|冲突|醉酒|紧急)/.test(serviceType.name)
}

function sessionView(
  state: RuntimeState,
  table: Table,
  tableSession: SongTableSession,
  sessionClaims: Omit<GuestSessionClaims, 'version' | 'tokenType'>,
  tableToken: string,
  nowMs: number,
  enforceMaximumOpenHours: boolean,
  anonymousId: string,
): GuestSessionResponse {
  const primary = state.employees.find((employee) => employee.id === table.primaryEmployeeId)
  const sessionBusinessDate = tableSessionBusinessDate(state, tableSession)
  const sessionOperation = tableSessionOperation(state, tableSession)
  const scheduleBusinessDate = chinaBusinessDateKey(nowMs)
  const frozen = tableSessionRequiresHandover(state, tableSession, nowMs, enforceMaximumOpenHours)
  const orders = frozen ? [] : state.orderDomain.orders.filter((order) => order.tableSessionId === tableSession.id)
  const ledgerEntries = frozen ? [] : state.orderDomain.tableLedgerEntries.filter((entry) => entry.tableSessionId === tableSession.id)
  const balanceAmount = ledgerEntries.at(-1)?.balanceAfter ?? orders
    .filter((order) => order.status !== 'draft')
    .reduce((sum, order) => sum + order.amounts.payableAmount, 0)
  const todaysPerformances = state.songState.performanceSessions
    .filter((performance) => performance.businessDate === scheduleBusinessDate)
    .filter((performance) => performance.status === 'scheduled' || performance.status === 'live')
  const occurredAt = new Date(nowMs).toISOString()
  const songOffers = todaysPerformances
    .flatMap((performance) => performance.appearances
      .flatMap((appearance) => state.songState.repertoire
        .filter((entry) => entry.enabled && entry.singerId === appearance.singerId)
        .flatMap((entry) => {
          const singer = state.songState.singers.find((item) => item.id === entry.singerId && item.active)
          const song = state.songState.songs.find((item) => item.id === entry.songId && item.active)
          if (!singer || !song) return []
          const requestMode = resolveSongRequestMode(appearance, song.durationSeconds, occurredAt)
          const requestUnavailableReason = requestMode ? null
            : !appearance.acceptingRequests ? '歌手暂时暂停接收点歌'
              : nowMs < Date.parse(appearance.requestOpensAt) ? `预约将在${new Date(appearance.requestOpensAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: state.store.timezone })}开放`
                : nowMs >= Date.parse(appearance.endsAt) ? '这轮演出已经结束'
                  : nowMs < Date.parse(appearance.startsAt) && appearance.advanceBookingEnabled === false ? '这位歌手暂未开放提前预约'
                    : '本轮剩余时间不足，歌手未开放延长协商'
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
            endsAt: appearance.endsAt,
            durationSeconds: song.durationSeconds,
            requestMode,
            requestAvailable: requestMode !== null,
            requestUnavailableReason,
            scheduleVersion: performance.configVersion ?? 1,
            repertoireVersion: entry.configVersion,
          }]
        })))
  const stageSchedule = todaysPerformances
    .flatMap((performance) => performance.appearances.flatMap((appearance) => {
      const singer = state.songState.singers.find((item) => item.id === appearance.singerId && item.active)
      if (!singer) return []
      return [{
        performanceSessionId: performance.id,
        performanceTitle: performance.title,
        appearanceId: appearance.id,
        singerId: singer.id,
        singerName: singer.displayName,
        startsAt: appearance.startsAt,
        endsAt: appearance.endsAt,
        acceptingRequests: appearance.acceptingRequests,
        scheduleVersion: performance.configVersion ?? 1,
        advanceBookingEnabled: appearance.advanceBookingEnabled ?? true,
        extensionNegotiationEnabled: appearance.extensionNegotiationEnabled ?? true,
        extensionThresholdMinutes: appearance.extensionThresholdMinutes ?? 10,
        profile: {
          photoUrl: singer.photoUrl?.trim() ?? '',
          headline: singer.headline?.trim() ?? '',
          bio: singer.bio?.trim() ?? '',
          styleTags: (singer.styleTags ?? []).filter(Boolean).slice(0, 6),
        },
      }]
    }))
    .sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt))
  const visibleProducts = state.products.filter((product) => product.enabled && product.guestVisible !== false)
  const bundleComponentIds = new Set(
    visibleProducts.flatMap((product) => (
      product.productKind === 'bundle'
        ? (product.bundleComponents ?? []).map((component) => component.productId)
        : []
    )),
  )
  return {
    store: { id: state.store.id, name: state.store.name, businessDate: scheduleBusinessDate, timezone: state.store.timezone },
    communityBrand: state.config.communityBrand.enabled && state.config.communityBrand.guestOrderVisible
      ? {
          name: state.config.communityBrand.name,
          eyebrow: state.config.communityBrand.eyebrow,
          tagline: state.config.communityBrand.tagline,
          markUrl: state.config.communityBrand.markUrl,
          highlights: [...state.config.communityBrand.highlights],
        }
      : null,
    table: {
      code: table.code,
      displayName: table.displayName,
      status: table.status,
      occupied: table.status === 'occupied',
      guestCount: table.guestCount,
      recommendationScene: sessionOperation.recommendationScene,
    },
    primaryServiceName: primary?.displayName ?? null,
    orderSafety: structuredClone(commercialOpsFor(state).config.orderSafety),
    serviceTypes: state.config.serviceTypes
      .filter((serviceType) => serviceType.enabled && serviceType.guestVisible !== false)
      .map(({ id, code, name, icon, priority }) => ({ id, code, name, icon, priority })),
    products: state.products
      .filter((product) => (
        product.enabled
        && (product.guestVisible !== false || bundleComponentIds.has(product.id))
      ))
      .sort((left, right) => (left.sortOrder ?? 999) - (right.sortOrder ?? 999))
      .map((product) => ({ ...product, costAmount: 0 })),
    tasks: (frozen ? [] : state.tasks)
      .filter((task) => task.tableSessionId === tableSession.id && !task.archivedAt)
      .filter((task) => !['completed', 'confirmed', 'cancelled'].includes(task.status))
      .slice(0, 10)
      .map((task) => taskView(state, task)),
    account: {
      tableSessionId: tableSession.id,
      sessionBusinessDate,
      frozen,
      frozenReason: frozen ? '这桌属于上一营业日或已经超过安全开放时长，旧账已冻结且不会在本页展示或收款。' : null,
      requiresManagerHandover: frozen,
      balanceAmount,
      orders: orders.map((order) => ({
        id: order.id,
        status: order.status,
        createdAt: order.createdAt,
        payableAmount: order.amounts.payableAmount,
        fulfillmentNote: order.fulfillmentNote ?? '',
        items: order.items.filter((item) => item.commercialLine !== false).map((item) => ({
          id: item.id,
          name: item.name,
          specification: item.specification,
          quantity: item.quantity,
          amount: item.unitSalePriceAmount * item.quantity,
          fulfillmentStatus: item.fulfillmentStatus,
        })),
      })),
      payments: (frozen ? [] : state.paymentDomain.paymentIntents)
        .filter((intent) => intent.tableSessionId === tableSession.id)
        .slice(-20)
        .reverse()
        .map((intent) => ({
          id: intent.id,
          orderIds: intent.orderIds,
          amount: intent.amount,
          status: intent.status,
          channel: intent.channel,
          paidAt: intent.paidAt,
        })),
    },
    songOffers,
    stageSchedule,
    songRequests: (frozen ? [] : state.songState.requests)
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
        requestMode: request.requestMode,
      })),
    guestSession: {
      tableSessionId: tableSession.id,
      expiresAt: new Date(sessionClaims.expiresAt).toISOString(),
      tokenVersion: sessionClaims.tokenVersion,
    },
    guestIdentity: { anonymousId, memberLinked: false, wechatLinked: false },
    tableToken,
    serverNow: new Date(nowMs).toISOString(),
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
    const claims = verifyGuestEntryToken(token, options, now)
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
  if (!table) throw new TableAccessError('没有找到这张桌子，请让迎宾伙伴帮您确认一下桌码。', 'TABLE_NOT_FOUND', 404)
    const tableSession = resolveOpenTableSession(state, table)
    const sessionClaims = mintGuestSession(state.store.id, table, tableSession, options, now)
    return {
      table,
      tableSession,
      sessionClaims,
      token: signGuestSessionToken(sessionClaims, options.secret),
    }
  }
  throw new TableAccessError('还差一步～请扫描桌面二维码进入，这样我们才知道去哪里找您。')
}

function writeAccessFromToken(state: RuntimeState, token: string, options: GuestApiOptions) {
  const claims = requireGuestSession(verifyTableAccessToken(token, options.secret, options.now?.() ?? Date.now()))
  const access = resolveGuestSession(state, claims)
  const enforceMaximumOpenHours = options.runtimeMode === 'staging' || options.runtimeMode === 'production'
  if (tableSessionRequiresHandover(state, access.tableSession, options.now?.() ?? Date.now(), enforceMaximumOpenHours)) {
    throw new TableAccessError(
      '这张桌子正在做上一班账务交接，旧账已经冻结。请让值班经理处理后重新扫码，我们不会让您看到或误付上一桌账单。',
      'TABLE_SESSION_HANDOVER_REQUIRED',
      409,
    )
  }
  return access
}

export function registerGuestRoutes(app: FastifyInstance, repository: RuntimeRepository, options: GuestApiOptions) {
  const resolveProvider = options.providerResolver ?? createEnvironmentPaymentProviderResolver()
  const guestInsights = options.guestInsights ?? new MemoryGuestInsightsStore()
  app.get<{ Querystring: { token?: string; table?: string } }>('/api/guest/session', async (request) => {
    const state = await repository.read()
    const access = exchangeAccessFromRequest(state, request.query.token, request.query.table, options)
    const anonymousId = guestIdentityFromRequest(request, randomUUID)
    await recordGuestInsight(request, guestInsights, {
      anonymousId,
      tableSessionId: access.tableSession.id,
      tableCode: access.table.code,
      businessDate: tableSessionBusinessDate(state, access.tableSession),
      eventType: 'session_started',
      metadata: { entry: request.query.token ? 'table_qr_or_session' : 'local_table_sample' },
      idempotencyKey: `guest-session-started:${anonymousId}:${access.tableSession.id}`,
      occurredAt: new Date(options.now?.() ?? Date.now()).toISOString(),
    })
    return sessionView(
      state,
      access.table,
      access.tableSession,
      access.sessionClaims,
      access.token,
      options.now?.() ?? Date.now(),
      options.runtimeMode === 'staging' || options.runtimeMode === 'production',
      anonymousId,
    )
  })

  app.post('/api/guest/events', async (request, reply) => {
    const input = guestBehaviorEventSchema.parse(request.body)
    const state = await repository.read()
    const { table, tableSession } = writeAccessFromToken(state, input.tableToken, options)
    const anonymousId = guestIdentityFromRequest(
      request,
      () => deterministicGuestId(`legacy-table-session:${tableSession.id}`),
    )
    await recordGuestInsight(request, guestInsights, {
      anonymousId,
      tableSessionId: tableSession.id,
      tableCode: table.code,
      businessDate: tableSessionBusinessDate(state, tableSession),
      eventType: input.eventType,
      metadata: clientBehaviorMetadata(input.eventType, input.metadata),
      idempotencyKey: `client:${anonymousId}:${input.idempotencyKey}`,
      occurredAt: new Date(options.now?.() ?? Date.now()).toISOString(),
    })
    return reply.status(202).send({ accepted: true, anonymousId })
  })

  app.post('/api/guest/tasks', async (request, reply) => {
    const input = guestTaskCreateSchema.parse(request.body)
    const anonymousId = guestIdentityForWrite(request, input.tableToken, options)
    let insightContext: { tableSessionId: string; tableCode: string; businessDate: string } | null = null
    const result = await repository.mutate((state) => {
      const { table, tableSession } = writeAccessFromToken(state, input.tableToken, options)
      insightContext = { tableSessionId: tableSession.id, tableCode: table.code, businessDate: tableSessionBusinessDate(state, tableSession) }
      const serviceType = state.config.serviceTypes.find((candidate) => candidate.id === input.serviceTypeId && candidate.enabled)
      if (!serviceType) throw new TableAccessError('这个服务今晚暂时没有开放，您可以选择“呼叫”，我们到桌听您说。', 'GUEST_SERVICE_NOT_AVAILABLE', 409)
      const normalizedNote = input.note.trim().replace(/\s+/g, ' ').toLowerCase()
      if (serviceType.code === 'CUSTOM_REQUEST' && !normalizedNote) {
        throw new TableAccessError('把想要的内容告诉我们吧，写几个字就可以。', 'GUEST_CUSTOM_REQUEST_REQUIRED', 400)
      }
      const limits = state.config.guestServiceLimits
      const now = options.now?.() ?? Date.now()
      const replayAudit = state.auditEntries.find((entry) => (
        entry.action === 'service.requested.v1'
        && entry.details.idempotencyKey === input.idempotencyKey
      ))
      const replayTask = replayAudit
        ? state.tasks.find((candidate) => candidate.id === replayAudit.objectId)
        : null
      if (replayTask) {
        if (replayTask.tableSessionId !== tableSession.id || replayTask.serviceTypeId !== input.serviceTypeId) {
          throw new TableAccessError('这次提交标识已经用于其他服务，请重新提交。', 'GUEST_SERVICE_IDEMPOTENCY_CONFLICT', 409)
        }
        return taskView(state, replayTask)
      }

      const mergeTarget = state.tasks.find((candidate) => (
        candidate.tableSessionId === tableSession.id
        && !candidate.archivedAt
        && candidate.serviceTypeId === input.serviceTypeId
        && !['completed', 'confirmed', 'cancelled'].includes(candidate.status)
      ))
      const windowCutoff = now - limits.windowSeconds * 1000
      const recentCount = state.auditEntries.filter((entry) => (
        entry.action === 'service.requested.v1'
        && entry.actorId === 'guest'
        && entry.details.tableSessionId === tableSession.id
        && Date.parse(entry.occurredAt) >= windowCutoff
      )).length
      if (recentCount >= limits.maxRequests && !bypassesGuestServiceRateLimit(serviceType)) {
        throw new TableAccessError(
          '收到啦～你的召唤已经闪到我们这边，小伙伴正在赶来，再给我们一点点时间哦。',
          'GUEST_SERVICE_RATE_LIMITED',
          429,
        )
      }
      if (mergeTarget) {
        return taskView(state, mergeServiceTaskRequest(state, mergeTarget.id, {
          note: input.note,
          idempotencyKey: input.idempotencyKey,
          source: 'guest',
        }))
      }
      const task = createServiceTask(state, {
        tableCode: table.code,
        serviceTypeId: input.serviceTypeId,
        source: 'guest',
        note: input.note,
        idempotencyKey: input.idempotencyKey,
      })
      return taskView(state, task)
    })
    if (insightContext) await recordGuestInsight(request, guestInsights, {
      anonymousId,
      ...(insightContext as GuestInsightCoordinates),
      eventType: 'service_requested',
      metadata: { serviceTypeId: input.serviceTypeId },
      idempotencyKey: `service-requested:${anonymousId}:${input.idempotencyKey}`,
    })
    return reply.status(201).send(result)
  })

  app.post('/api/guest/orders', async (request, reply) => {
    const input = guestCartOrderSchema.parse(request.body)
    const anonymousId = guestIdentityForWrite(request, input.tableToken, options)
    let insightContext: { tableSessionId: string; tableCode: string; businessDate: string } | null = null
    const order = await repository.mutate((state) => {
      const { table, tableSession } = writeAccessFromToken(state, input.tableToken, options)
      insightContext = { tableSessionId: tableSession.id, tableCode: table.code, businessDate: tableSessionBusinessDate(state, tableSession) }
      const existing = state.orderDomain.orders.find((candidate) => (
        candidate.id === deterministicId('guest_order', input.idempotencyKey)
      ))
      if (existing) {
        const requestedItems = input.items
          .map((item) => `${item.productId}:${item.quantity}`)
          .toSorted()
        const existingItems = existing.items
          .map((item) => `${item.skuId}:${item.quantity}`)
          .toSorted()
        if (
          existing.tableSessionId !== tableSession.id
          || JSON.stringify(requestedItems) !== JSON.stringify(existingItems)
          || (existing.fulfillmentNote ?? '') !== input.fulfillmentNote
        ) {
          throw new TableAccessError(
            '这次购物车或备注和刚才那次不一样，我们没有重复提交。请重新确认后再下单。',
            'GUEST_ORDER_IDEMPOTENCY_CONFLICT',
            409,
          )
        }
        return existing
      }
      if (new Set(input.items.map((item) => item.productId)).size !== input.items.length) {
        throw new TableAccessError('购物车里同一款出现了两次，我们没敢替您重复下单；合并数量后再试一次就好。', 'GUEST_CART_DUPLICATE_PRODUCT', 400)
      }
      const safety = commercialOpsFor(state).config.orderSafety
      const requestTime = options.now?.() ?? Date.now()
      if (safety.enabled && recentGuestOrderCount(state, tableSession.id, requestTime) >= safety.maxOrdersPerMinute) {
        throw new TableAccessError('这一桌刚刚下单有点快，我们先停一下核对，避免重复上单。请查看订单记录，或呼叫服务伙伴帮您确认。', 'GUEST_ORDER_RATE_LIMITED', 429)
      }
      const matchingOrder = recentMatchingGuestOrder(state, tableSession.id, input.items, requestTime)
      if (matchingOrder && input.confirmedDuplicateOrderId !== matchingOrder.id) {
        throw new TableAccessError(
          '刚刚已经有一笔相同订单。请先看看订单记录；确实要加同样商品时，再点“确认继续加单”。',
          'GUEST_ORDER_DUPLICATE_CONFIRMATION_REQUIRED',
          409,
          { conflictingOrderId: matchingOrder.id, createdAt: matchingOrder.createdAt },
        )
      }
      const products = input.items.map((item) => {
        const product = state.products.find((candidate) => candidate.id === item.productId && candidate.enabled && candidate.guestVisible !== false)
        if (!product) throw new TableAccessError('购物车里有一款刚刚下架了，抱歉让您空欢喜；换一个试试，我们也可以帮您推荐。', 'PRODUCT_NOT_AVAILABLE', 409)
        if (item.quantity > (product.maxOrderQuantity ?? 50)) {
          throw new TableAccessError(`${product.name}这次最多可选${product.maxOrderQuantity ?? 50}${product.specification}，需要更多可以呼叫服务伙伴。`, 'PRODUCT_QUANTITY_EXCEEDED', 400)
        }
        const availability = productAvailability(product, new Date(options.now?.() ?? Date.now()), state.store.timezone)
        if (!availability.orderable) {
          const code = availability.state === 'sold_out' ? 'PRODUCT_SOLD_OUT' : 'PRODUCT_OUTSIDE_SERVICE_TIME'
          const message = availability.state === 'sold_out'
            ? `抱歉，${product.name}刚刚没法继续供应了（${availability.label}）～换一款试试，想听推荐就叫我们。`
            : `这会儿还没到${product.name}的供应时间，先看看其他选择，也可以让服务伙伴帮您搭配。`
          throw new TableAccessError(message, code, 409)
        }
        return { product, quantity: item.quantity }
      })
      syncOrderFulfillmentWorkstations(state)
      const now = new Date(options.now?.() ?? Date.now()).toISOString()
      const actorId = `guest-${table.code}`
      const orderId = deterministicId('guest_order', input.idempotencyKey)
      createOrderDraft(state.orderDomain, {
        orderId,
        tableSessionId: tableSession.id,
        createdBy: actorId,
        fulfillmentNote: input.fulfillmentNote,
        occurredAt: now,
        idempotencyKey: `${input.idempotencyKey}:draft`,
      })
      products.forEach(({ product, quantity }, index) => {
        addConfiguredProductToOrder(state, {
          orderId,
          actorId,
          occurredAt: now,
          product,
          quantity,
          idempotencyKey: `${input.idempotencyKey}:item:${index}`,
          linePrefix: 'guest_line',
        })
      })
      state.auditEntries.push({
        id: `audit_${randomUUID()}`,
        actorId,
        action: 'guest.cart_order_created.v1',
        objectType: 'order',
        objectId: orderId,
        occurredAt: now,
        details: {
          tableId: table.id,
          items: input.items,
          hasFulfillmentNote: Boolean(input.fulfillmentNote),
          idempotencyKey: input.idempotencyKey,
        },
      })
      state.revision += 1
      return state.orderDomain.orders.find((candidate) => candidate.id === orderId)!
    })
    if (insightContext) await recordGuestInsight(request, guestInsights, {
      anonymousId,
      ...(insightContext as GuestInsightCoordinates),
      eventType: 'order_created',
      metadata: { orderId: order.id, itemCount: input.items.reduce((sum, item) => sum + item.quantity, 0), payableAmount: order.amounts.payableAmount },
      idempotencyKey: `order-created:${anonymousId}:${input.idempotencyKey}`,
    })
    return reply.status(201).send(order)
  })

  app.post('/api/guest/checkout', async (request, reply) => {
    const input = guestCheckoutSchema.parse(request.body)
    const anonymousId = guestIdentityForWrite(request, input.tableToken, options)
    let insightContext: { tableSessionId: string; tableCode: string; businessDate: string } | null = null
    const prepared = await repository.mutate((state) => {
      const { table, tableSession } = writeAccessFromToken(state, input.tableToken, options)
      insightContext = { tableSessionId: tableSession.id, tableCode: table.code, businessDate: tableSessionBusinessDate(state, tableSession) }
      const order = state.orderDomain.orders.find((candidate) => candidate.id === input.orderId)
      if (!order || order.tableSessionId !== tableSession.id) {
        throw new TableAccessError('这张订单不属于当前桌位，请让服务伙伴来帮您核对，别担心，我们会处理好。', 'GUEST_ORDER_ACCESS_FORBIDDEN', 403)
      }
      if (order.amounts.payableAmount <= 0) {
        throw new TableAccessError('这张订单已经有其他结账安排啦，请让服务伙伴来为您核对，避免重复付款。', 'ORDER_PAYMENT_NOT_REQUIRED', 409)
      }
      const now = new Date(options.now?.() ?? Date.now()).toISOString()
      const expiredIntents = expirePaymentIntents(state.paymentDomain, now, tableSession.id)
      if (expiredIntents.length > 0) state.revision += 1
      const existingIntent = state.paymentDomain.paymentIntents.find((intent) => (
        intent.orderIds.includes(order.id) && !['failed', 'closed'].includes(intent.status)
      ))
      if (existingIntent) {
        const runtime = existingIntent.channel === 'postar' && existingIntent.status === 'pending'
          ? resolveProvider(state.paymentDomain, 'postar')
          : null
        return {
          paymentIntent: existingIntent,
          order,
          providerRequired: existingIntent.status !== 'succeeded',
          wechatJsapiParameters: null,
          paymentUrl: paymentUrl(existingIntent),
          providerRuntime: runtime,
          providerRequest: runtime ? {
            paymentIntentId: existingIntent.id,
            merchantId: existingIntent.merchantId,
            amount: existingIntent.amount,
            currency: existingIntent.currency,
            expiresAt: existingIntent.expiresAt,
            presentation: 'qr' as const,
            clientIp: request.ip,
            callbackUrl: runtime.callbackUrl,
            operatorId: `guest-${table.code}`,
            remark: `MBOX桌台${table.code}`,
          } : null,
        }
      }
      if (!['draft', 'submitted', 'in_fulfillment', 'fulfilled'].includes(order.status)) {
        throw new TableAccessError('这张订单现在还不能付款，我们正在确认状态；呼叫服务伙伴就能马上帮您看。', 'ORDER_NOT_PAYABLE', 409)
      }
      const simulatedPayment = options.runtimeMode === 'local'
        || options.runtimeMode === 'test'
        || (options.runtimeMode === 'staging' && options.allowPaymentSimulation === true)
      const providerRuntime = simulatedPayment ? null : resolveProvider(state.paymentDomain, 'postar')
      const channel = simulatedPayment ? 'wechat_mock' : 'postar'
      const attemptNumber = state.paymentDomain.paymentIntents.filter((intent) => intent.orderIds.includes(order.id)).length + 1
      const attemptKey = `${input.idempotencyKey}:attempt:${attemptNumber}`
      const paymentIntent = createPaymentIntent(state.paymentDomain, {
        paymentIntentId: simulatedPayment
          ? deterministicId('guest_payment', attemptKey)
          : `Payment${createHash('sha256').update(attemptKey).digest('hex').slice(0, 32)}`,
        tableSessionId: tableSession.id,
        lineAllocations: order.items.filter((item) => item.commercialLine !== false).map((item) => ({
          orderId: order.id,
          orderItemId: item.id,
          quantity: item.quantity,
          unitPaidAmount: item.unitSalePriceAmount,
        })),
        amount: order.amounts.payableAmount,
        currency: 'CNY',
        channel,
        merchantId: providerRuntime?.merchantId ?? state.store.id,
        createdBy: `guest-${table.code}`,
        deviceId: `guest-web-${table.code}`,
        occurredAt: now,
        expiresAt: new Date(Date.parse(now) + 15 * 60_000).toISOString(),
        idempotencyKey: `${attemptKey}:intent`,
      })
      let submittedOrder = order
      if (simulatedPayment) {
        handlePaymentNotification(state.paymentDomain, {
          channel,
          notificationId: deterministicId('notification', input.idempotencyKey),
          paymentIntentId: paymentIntent.id,
          channelTransactionId: deterministicId('wechat_transaction', input.idempotencyKey),
          status: 'succeeded',
          amount: paymentIntent.amount,
          currency: paymentIntent.currency,
          merchantId: paymentIntent.merchantId,
          signatureVerified: true,
          channelOccurredAt: now,
          receivedAt: now,
        })
        if (order.status === 'draft') {
          submittedOrder = submitOrder(state.orderDomain, {
            orderId: order.id,
            submittedBy: `guest-${table.code}`,
            occurredAt: now,
            idempotencyKey: `${input.idempotencyKey}:submit`,
          })
          consumeManagedInventoryForSubmittedOrder(state.inventoryDomain, submittedOrder, {
            actorId: `guest-${table.code}`,
            businessDate: state.store.businessDate,
            occurredAt: now,
          })
          completeAwaitingOrderOnOrder(state, table.id, order.id, `guest-${table.code}`, new Date(now))
          queuePrintJobsForOrder(state, submittedOrder, now)
        }
      }
      state.auditEntries.push({
        id: `audit_${randomUUID()}`,
        actorId: `guest-${table.code}`,
        action: simulatedPayment ? 'guest.payment_succeeded.v1' : 'guest.payment_initiated.v1',
        objectType: 'paymentIntent',
        objectId: paymentIntent.id,
        occurredAt: now,
        details: { orderId: order.id, channel, idempotencyKey: input.idempotencyKey },
      })
      state.revision += 1
      return {
        paymentIntent,
        order: submittedOrder,
        providerRequired: !simulatedPayment,
        wechatJsapiParameters: null,
        paymentUrl: null,
        providerRuntime,
        providerRequest: providerRuntime ? {
          paymentIntentId: paymentIntent.id,
          merchantId: paymentIntent.merchantId,
          amount: paymentIntent.amount,
          currency: paymentIntent.currency,
          expiresAt: paymentIntent.expiresAt,
          presentation: 'qr' as const,
          clientIp: request.ip,
          callbackUrl: providerRuntime.callbackUrl,
          operatorId: `guest-${table.code}`,
          remark: `MBOX桌台${table.code}`,
        } : null,
      }
    })
    if (insightContext) {
      await recordGuestInsight(request, guestInsights, {
        anonymousId,
        ...(insightContext as GuestInsightCoordinates),
        eventType: 'checkout_started',
        metadata: { orderId: prepared.order.id, amount: prepared.paymentIntent.amount, channel: prepared.paymentIntent.channel },
        idempotencyKey: `checkout-started:${anonymousId}:${input.idempotencyKey}`,
      })
      if (prepared.paymentIntent.status === 'succeeded') await recordGuestInsight(request, guestInsights, {
        anonymousId,
        ...(insightContext as GuestInsightCoordinates),
        eventType: 'payment_completed',
        metadata: { orderId: prepared.order.id, amount: prepared.paymentIntent.amount, channel: prepared.paymentIntent.channel },
        idempotencyKey: `payment-completed:${anonymousId}:${prepared.paymentIntent.id}`,
      })
    }
    if (!prepared.providerRuntime || !prepared.providerRequest) {
      return reply.status(201).send(publicCheckoutResult(prepared))
    }
    const providerResult = await requestPaymentThroughProvider({
      intent: prepared.paymentIntent,
      adapter: prepared.providerRuntime.adapter,
      secrets: prepared.providerRuntime.secrets,
      request: prepared.providerRequest,
    })
    const paymentIntent = await repository.mutate((state) => {
      const result = applyProviderPaymentCreation(
        state.paymentDomain,
        prepared.providerRuntime!.adapter.provider,
        prepared.providerRequest!,
        providerResult,
      )
      state.auditEntries.push({
        id: `audit_${randomUUID()}`,
        actorId: result.createdBy,
        action: 'guest.provider_payment_order_created.v1',
        objectType: 'paymentIntent',
        objectId: result.id,
        occurredAt: new Date(options.now?.() ?? Date.now()).toISOString(),
        details: { channel: result.channel, presentation: 'qr' },
      })
      state.revision += 1
      return result
    })
    return reply.status(201).send(publicCheckoutResult({ ...prepared, paymentIntent }))
  })

  app.post<{ Params: { taskId: string } }>('/api/guest/tasks/:taskId/feedback', async (request) => {
    const input = guestTaskFeedbackSchema.parse(request.body)
    const anonymousId = guestIdentityForWrite(request, input.tableToken, options)
    let insightContext: { tableSessionId: string; tableCode: string; businessDate: string } | null = null
    const result = await repository.mutate((state) => {
      const { table, tableSession } = writeAccessFromToken(state, input.tableToken, options)
      insightContext = { tableSessionId: tableSession.id, tableCode: table.code, businessDate: tableSessionBusinessDate(state, tableSession) }
      const task = state.tasks.find((candidate) => candidate.id === request.params.taskId)
      if (
        !task || task.tableId !== table.id ||
        Date.parse(task.createdAt) < Date.parse(tableSession.openedAt)
      ) {
        throw new TableAccessError('这条服务记录不属于当前桌位，请刷新一下；需要帮助就直接呼叫我们。', 'GUEST_TASK_ACCESS_FORBIDDEN', 403)
      }
      return taskView(state, applyTaskAction(state, task.id, {
        action: input.action,
        actorId: `guest-${table.code}`,
        note: input.note,
        idempotencyKey: input.idempotencyKey,
      }))
    })
    if (insightContext) await recordGuestInsight(request, guestInsights, {
      anonymousId,
      ...(insightContext as GuestInsightCoordinates),
      eventType: 'service_feedback',
      metadata: { taskId: request.params.taskId, action: input.action },
      idempotencyKey: `service-feedback:${anonymousId}:${input.idempotencyKey}`,
    })
    return result
  })

  app.post('/api/guest/song-requests', async (request, reply) => {
    const input = guestSongRequestSchema.parse(request.body)
    const anonymousId = guestIdentityForWrite(request, input.tableToken, options)
    let insightContext: { tableSessionId: string; tableCode: string; businessDate: string } | null = null
    const result = await repository.mutate((state) => {
      const { table, tableSession } = writeAccessFromToken(state, input.tableToken, options)
      insightContext = { tableSessionId: tableSession.id, tableCode: table.code, businessDate: tableSessionBusinessDate(state, tableSession) }
      const performance = state.songState.performanceSessions.find((candidate) =>
        candidate.appearances.some((appearance) => appearance.id === input.appearanceId),
      )
      if (!performance) throw new TableAccessError('这一轮演出刚刚有调整，先看看最新排班，也可以让服务伙伴帮您问歌手。', 'PERFORMANCE_NOT_FOUND', 404)
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
        occurredAt: new Date(options.now?.() ?? Date.now()).toISOString(),
        idempotencyKey: input.idempotencyKey,
      })
      if (state.songState.idempotencyRecords.length !== idempotencyCount) state.revision += 1
      return songRequest
    })
    if (insightContext) await recordGuestInsight(request, guestInsights, {
      anonymousId,
      ...(insightContext as GuestInsightCoordinates),
      eventType: 'song_requested',
      metadata: { appearanceId: input.appearanceId, singerId: input.singerId, songId: input.songId },
      idempotencyKey: `song-requested:${anonymousId}:${input.idempotencyKey}`,
    })
    return reply.status(201).send(result)
  })
}
