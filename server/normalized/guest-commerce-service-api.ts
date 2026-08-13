import { createHash } from 'node:crypto'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type {
  AuditActor,
  CommandExecution,
  JsonCodec,
  JsonObject,
  NormalizedCommandExecutor,
} from './command-executor.js'
import type {
  CommerceCommandService,
  SubmittedCommerceResult,
} from './commerce-command-service.js'
import {
  GuestOrderDuplicateConfirmationRequiredError,
  GuestOrderRateLimitedError,
} from './guest-order-safety.js'
import {
  GuestBehaviorRepository,
  GuestBehaviorSessionUnavailableError,
} from './guest-behavior-repository.js'
import {
  GuestServiceRepository,
  GuestServiceSessionUnavailableError,
  type GuestServiceRequestResult,
  type GuestServiceRequestType,
} from './guest-service-repository.js'
import { loadGuestTableOrders } from './guest-table-orders-query.js'
import {
  GuestAuthenticationRequiredError,
  GuestCapabilityDeniedError,
  GuestDeviceBindingError,
  GuestStoreScopeError,
  type GuestRequestContext,
  requireGuestCapability,
} from './guest-request-context.js'
import { OrderProductUnavailableError, TableSessionUnavailableForOrderError } from './order-repository.js'
import type { PaymentCommandService } from './payment-command-service.js'
import { OrderNotPayableError, type Payment } from './payment-repository.js'
import type {
  ScopedPostgresTransactionRunner,
  ScopedTransaction,
} from './transaction-runner.js'

export type GuestCheckoutPaymentMode = 'wechat_jsapi' | 'wechat_native_qr' | 'simulation'

export interface GuestCommerceServiceApiOptions {
  transactions: Pick<ScopedPostgresTransactionRunner, 'run'>
  commandExecutor: Pick<NormalizedCommandExecutor, 'execute'>
  commerce: Pick<CommerceCommandService, 'submitOrder'>
  payments: Pick<PaymentCommandService, 'initiate'>
  resolveGuestContext(request: FastifyRequest): Promise<GuestRequestContext> | GuestRequestContext
  resolveDeviceFingerprint(request: FastifyRequest): string
  paymentMode: GuestCheckoutPaymentMode
  deviceServiceLimitPerMinute?: number
  tableServiceLimitPerMinute?: number
  createPublicId?: (kind: 'order' | 'payment' | 'service', seed: string) => string
}

interface CatalogMenuRow extends Record<string, unknown> {
  id: string
  code: string
  name: string
  category_code: string
  fulfillment_station: string
  product_kind: 'single' | 'bundle'
  bundle_components: unknown
  product_snapshot: JsonObject
  status: string
  amount_minor: string | null
  currency: string | null
  guest_count: number
  guest_profile_snapshot: JsonObject
}

interface GuestServiceCommandResult {
  status: 'created' | 'merged' | 'rate_limited'
  requestType: GuestServiceRequestType
  taskPublicId: string | null
  taskStatus: string | null
  requestCount: number | null
  workflow: 'visible_then_complete' | 'manager_attention' | null
  dimension: 'table' | 'device' | null
  retryAt: string | null
}

interface GuestMoodCommandResult {
  recorded: true
  mood: GuestMood
  occurredAt: string
}

type GuestMood = 'happy' | 'excited' | 'listening' | 'social' | 'celebrating' | 'quiet' | 'tired' | 'uncomfortable'

const MOODS = new Set<GuestMood>([
  'happy', 'excited', 'listening', 'social', 'celebrating', 'quiet', 'tired', 'uncomfortable',
])

export const guestCommerceServiceApiPlugin: FastifyPluginAsync<GuestCommerceServiceApiOptions> = async (
  app,
  options,
) => {
  const createPublicId = options.createPublicId ?? deterministicPublicId

  app.get('/guest/menu/products', async (request, reply) => handleRoute(reply, async () => {
    const context = await requireTableContext(options, request, 'guest.menu.read')
    const query = readMenuQuery(request.query)
    const products = await options.transactions.run(context.scope, (transaction) => (
      searchGuestCatalog(transaction, context.tableSessionId, query)
    ), { readOnly: true })
    return reply.send({
      data: products.map(publicCatalogProduct),
      meta: {
        search: query.search,
        categoryCode: query.categoryCode,
        count: products.length,
        partySize: products[0]?.guest_count ?? null,
        recommendationScene: products[0] === undefined
          ? null
          : publicRecommendationScene(products[0].guest_profile_snapshot),
      },
    })
  }))

  app.post('/guest/orders', async (request, reply) => handleRoute(reply, async () => {
    const context = await requireTableContext(options, request, 'guest.order.create')
    const input = readGuestOrder(request.body)
    const idempotencyKey = readIdempotencyKey(request)
    const actor = guestActor(context)
    const orderExecution = await options.commerce.submitOrder({
      scope: context.scope,
      actor,
      businessDate: context.businessDate,
      idempotencyKey,
      tableSessionId: context.tableSessionId,
      publicId: createPublicId('order', `${context.scope.storeId}:${idempotencyKey}`),
      channel: 'guest_qr',
      settlementMode: 'immediate_payment',
      lines: input.items,
      note: input.note,
      createdByCustomerId: context.customerId,
      confirmedDuplicateOrderPublicId: input.confirmedDuplicateOrderId,
    })
    const payment = await initiateGuestPayment(options, context, orderExecution.value, idempotencyKey, createPublicId)
    return reply.code(orderExecution.replayed ? 200 : 201).send(
      checkoutResponse(orderExecution, payment, options.paymentMode),
    )
  }))

  app.get('/guest/orders/table', async (request, reply) => handleRoute(reply, async () => {
    const context = await requireTableContext(options, request, 'guest.session.read')
    const orders = await options.transactions.run(context.scope, (transaction) => (
      loadGuestTableOrders(transaction, context.tableSessionId, context.customerId)
    ), { readOnly: true })
    return reply.send({ data: orders, meta: { tableSessionId: context.tableSessionId, count: orders.length } })
  }))

  app.post('/guest/service-requests', async (request, reply) => handleRoute(reply, async () => {
    const context = await requireTableContext(options, request, 'guest.service.create')
    const input = readServiceRequest(request.body)
    const deviceFingerprint = options.resolveDeviceFingerprint(request)
    const idempotencyKey = readIdempotencyKey(request)
    const execution = await options.commandExecutor.execute({
      scope: context.scope,
      operationScope: 'guest.service.request',
      idempotencyKey,
      requestFingerprint: stableJson({ requestType: input.requestType, detail: input.detail }),
      resultCodec: guestServiceResultCodec,
    }, async (transaction) => {
      const service = new GuestServiceRepository(transaction, {
        deviceLimitPerMinute: options.deviceServiceLimitPerMinute,
        tableLimitPerMinute: options.tableServiceLimitPerMinute,
        createPublicId: () => createPublicId('service', `${context.tableSessionId}:${idempotencyKey}`),
      })
      const result = await service.request({
        tableSessionId: context.tableSessionId,
        customerId: context.customerId,
        actorRef: context.actorRef,
        deviceFingerprint,
        requestType: input.requestType,
        detail: input.detail,
      })
      const commandResult = toGuestServiceCommandResult(result, input.requestType)
      const behaviorType = result.status === 'rate_limited'
        ? 'guest.service.rate_limited'
        : result.status === 'merged'
          ? 'guest.service.merged'
          : 'guest.service.requested'
      const behavior = await new GuestBehaviorRepository(transaction).record({
        tableSessionId: context.tableSessionId,
        customerId: context.customerId,
        behaviorType,
        behaviorCode: input.requestType,
        behaviorData: serviceBehaviorData(commandResult),
        actorRef: context.actorRef,
        deviceFingerprint,
      })
      return {
        result: commandResult,
        auditEvents: [{
          actor: guestActor(context),
          action: behaviorType,
          objectType: 'guest_behavior',
          objectId: behavior.id,
          businessDate: context.businessDate,
          afterData: serviceBehaviorData(commandResult),
          reason: input.requestType === 'complaint' ? '客人提交投诉或不满意反馈' : null,
        }],
        outboxMessages: [{
          businessEventKey: `guest-service:${behavior.id}`,
          aggregateType: 'guest_behavior',
          aggregateId: behavior.id,
          aggregateVersion: 1,
          eventType: `${behaviorType}.v1`,
          payload: {
            tableSessionId: context.tableSessionId,
            requestType: input.requestType,
            result: serviceBehaviorData(commandResult),
          },
        }],
      }
    })
    const statusCode = execution.value.status === 'rate_limited'
      ? 429
      : execution.replayed || execution.value.status === 'merged' ? 200 : 201
    return reply.code(statusCode).send({
      data: serviceResponse(execution.value),
      meta: { replayed: execution.replayed },
    })
  }))

  app.post('/guest/mood', async (request, reply) => handleRoute(reply, async () => {
    const context = await requireTableContext(options, request, 'guest.service.create')
    const mood = readMood(request.body)
    const deviceFingerprint = options.resolveDeviceFingerprint(request)
    const idempotencyKey = readIdempotencyKey(request)
    const execution = await options.commandExecutor.execute({
      scope: context.scope,
      operationScope: 'guest.mood.select',
      idempotencyKey,
      requestFingerprint: mood,
      resultCodec: guestMoodResultCodec,
    }, async (transaction) => {
      const behavior = await new GuestBehaviorRepository(transaction).record({
        tableSessionId: context.tableSessionId,
        customerId: context.customerId,
        behaviorType: 'guest.mood.selected',
        behaviorCode: mood,
        behaviorData: { source: 'guest_table_page' },
        actorRef: context.actorRef,
        deviceFingerprint,
      })
      const result: GuestMoodCommandResult = { recorded: true, mood, occurredAt: behavior.occurredAt }
      return {
        result,
        auditEvents: [{
          actor: guestActor(context),
          action: 'guest.mood.selected',
          objectType: 'guest_behavior',
          objectId: behavior.id,
          businessDate: context.businessDate,
          afterData: { mood, createsServiceTask: false },
        }],
        outboxMessages: [{
          businessEventKey: `guest-mood:${behavior.id}`,
          aggregateType: 'guest_behavior',
          aggregateId: behavior.id,
          aggregateVersion: 1,
          eventType: 'guest.mood.selected.v1',
          payload: {
            tableSessionId: context.tableSessionId,
            customerId: context.customerId,
            mood,
            createsServiceTask: false,
          },
        }],
      }
    })
    return reply.code(execution.replayed ? 200 : 201).send({
      data: execution.value,
      meta: { replayed: execution.replayed, createsServiceTask: false },
    })
  }))
}

async function requireTableContext(
  options: GuestCommerceServiceApiOptions,
  request: FastifyRequest,
  capability: string,
): Promise<GuestRequestContext & { tableSessionId: string; businessDate: string }> {
  const context = await options.resolveGuestContext(request)
  requireGuestCapability(context, capability)
  if (context.sessionKind !== 'table' || context.tableSessionId === null || context.businessDate === null) {
    throw new GuestApiRequestError('TABLE_SESSION_REQUIRED', '请扫描已开台桌面的二维码后再继续', 409)
  }
  return context as GuestRequestContext & { tableSessionId: string; businessDate: string }
}

async function searchGuestCatalog(
  transaction: ScopedTransaction,
  tableSessionId: string,
  query: Readonly<{ search: string; categoryCode: string | null; limit: number; offset: number }>,
): Promise<CatalogMenuRow[]> {
  const searchPattern = `%${escapeLike(query.search)}%`
  const result = await transaction.query<CatalogMenuRow>(`
    SELECT product.id, product.code, product.name, product.category_code,
      product.fulfillment_station, product.product_kind,
      COALESCE(component_list.items, '[]'::jsonb) AS bundle_components,
      product.product_snapshot, product.status,
      price.amount_minor::text, price.currency,
      current_session.guest_count, current_session.guest_profile_snapshot
    FROM mbox.products AS product
    JOIN mbox.table_sessions AS current_session
      ON current_session.tenant_id = product.tenant_id
      AND current_session.store_id = product.store_id
      AND current_session.id = $3::uuid
      AND current_session.status = 'open'
    LEFT JOIN LATERAL (
      SELECT amount_minor, currency
      FROM mbox.product_prices
      WHERE tenant_id = product.tenant_id
        AND store_id = product.store_id
        AND product_id = product.id
        AND price_type = 'standard'
        AND valid_from <= clock_timestamp()
        AND (valid_until IS NULL OR valid_until > clock_timestamp())
      ORDER BY valid_from DESC, id DESC
      LIMIT 1
    ) AS price ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(
        jsonb_build_object(
          'productId', component_product.id,
          'name', component_product.name,
          'quantity', component.quantity
        ) ORDER BY component.sort_order, component.id
      ) AS items
      FROM mbox.product_bundle_components AS component
      JOIN mbox.products AS component_product
        ON component_product.tenant_id = component.tenant_id
        AND component_product.store_id = component.store_id
        AND component_product.id = component.component_product_id
      WHERE component.tenant_id = product.tenant_id
        AND component.store_id = product.store_id
        AND component.bundle_product_id = product.id
    ) AS component_list ON true
    WHERE product.tenant_id = $1::uuid
      AND product.store_id = $2::uuid
      AND product.status = 'active'
      AND price.amount_minor IS NOT NULL
      AND (
        product.product_kind = 'single'
        OR (
          EXISTS (
            SELECT 1 FROM mbox.product_bundle_components component
            WHERE component.tenant_id = product.tenant_id
              AND component.store_id = product.store_id
              AND component.bundle_product_id = product.id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM mbox.product_bundle_components component
            JOIN mbox.products component_product
              ON component_product.tenant_id = component.tenant_id
              AND component_product.store_id = component.store_id
              AND component_product.id = component.component_product_id
            WHERE component.tenant_id = product.tenant_id
              AND component.store_id = product.store_id
              AND component.bundle_product_id = product.id
              AND component_product.status <> 'active'
          )
        )
      )
      AND ($4::text IS NULL OR product.category_code = $4)
      AND (
        $5 = ''
        OR product.name ILIKE $6 ESCAPE '\\'
        OR product.code ILIKE $6 ESCAPE '\\'
        OR COALESCE(product.product_snapshot ->> 'aliases', '') ILIKE $6 ESCAPE '\\'
        OR COALESCE(product.product_snapshot ->> 'pinyin', '') ILIKE $6 ESCAPE '\\'
        OR COALESCE(product.product_snapshot ->> 'specification', '') ILIKE $6 ESCAPE '\\'
        OR COALESCE(product.product_snapshot -> 'source' ->> 'aliases', '') ILIKE $6 ESCAPE '\\'
        OR COALESCE(product.product_snapshot -> 'source' ->> 'pinyin', '') ILIKE $6 ESCAPE '\\'
        OR COALESCE(product.product_snapshot -> 'source' ->> 'specification', '') ILIKE $6 ESCAPE '\\'
      )
    ORDER BY
      CASE WHEN
        COALESCE(
          CASE WHEN product.product_snapshot -> 'recommendation' ->> 'minimumPartySize' ~ '^\\d{1,3}$'
            THEN (product.product_snapshot -> 'recommendation' ->> 'minimumPartySize')::integer END,
          1
        ) <= current_session.guest_count
        AND COALESCE(
          CASE WHEN product.product_snapshot -> 'recommendation' ->> 'maximumPartySize' ~ '^\\d{1,3}$'
            THEN (product.product_snapshot -> 'recommendation' ->> 'maximumPartySize')::integer END,
          200
        ) >= current_session.guest_count
        THEN 0 ELSE 1
      END,
      CASE
        WHEN product.product_snapshot -> 'recommendation' ->> 'priority' ~ '^\\d{1,4}$'
          THEN (product.product_snapshot -> 'recommendation' ->> 'priority')::integer
        ELSE 0
      END DESC,
      CASE WHEN product.product_kind = 'bundle' THEN 0 ELSE 1 END,
      CASE
        WHEN product.product_snapshot ->> 'costAmount' ~ '^\\d{1,12}$'
          AND price.amount_minor > (product.product_snapshot ->> 'costAmount')::bigint
        THEN price.amount_minor - (product.product_snapshot ->> 'costAmount')::bigint
        ELSE 0
      END DESC,
      product.category_code, product.name, product.id
    LIMIT $7 OFFSET $8
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    tableSessionId,
    query.categoryCode,
    query.search,
    searchPattern,
    query.limit,
    query.offset,
  ])
  return result.rows
}

function publicCatalogProduct(row: CatalogMenuRow) {
  const source = jsonObject(row.product_snapshot.source)
  const amountMinor = row.amount_minor === null ? null : Number(row.amount_minor)
  return {
    productId: row.id,
    code: row.code,
    name: row.name,
    categoryCode: row.category_code,
    categoryName: publicString(row.product_snapshot.categoryName)
      ?? publicString(source.categoryName)
      ?? row.category_code,
    beverageFamily: publicBeverageFamily(row.product_snapshot.beverageFamily ?? source.beverageFamily),
    specification: publicString(row.product_snapshot.specification)
      ?? publicString(source.specification),
    aliases: publicStringArray(row.product_snapshot.aliases ?? source.aliases),
    tags: publicStringArray(row.product_snapshot.tags ?? source.tags),
    imageUrl: publicString(row.product_snapshot.imageUrl) ?? publicString(source.imageUrl),
    description: publicString(row.product_snapshot.description) ?? publicString(source.description),
    sortOrder: boundedInteger(row.product_snapshot.sortOrder ?? source.sortOrder, 0, 100_000, 999),
    availableFrom: publicString(row.product_snapshot.availableFrom ?? source.availableFrom),
    availableUntil: publicString(row.product_snapshot.availableUntil ?? source.availableUntil),
    guestVisible: row.product_snapshot.guestVisible !== false && source.guestVisible !== false,
    requiresFulfillment: row.product_snapshot.requiresFulfillment !== false && source.requiresFulfillment !== false,
    maxOrderQuantity: boundedInteger(row.product_snapshot.maxOrderQuantity ?? source.maxOrderQuantity, 1, 999, 50),
    amountMinor,
    currency: row.currency,
    fulfillmentStation: row.fulfillment_station,
    productKind: row.product_kind,
    bundleComponents: publicBundleComponents(row.bundle_components),
    recommendation: publicRecommendation(row.product_snapshot, amountMinor),
    available: row.status === 'active' && row.amount_minor !== null,
  }
}

function publicRecommendation(snapshot: JsonObject, amountMinor: number | null) {
  const source = jsonObject(snapshot.recommendation)
  const costAmount = boundedInteger(snapshot.costAmount, 0, Number.MAX_SAFE_INTEGER, amountMinor ?? 0)
  const serverApproved = amountMinor !== null && amountMinor > costAmount
  return {
    enabled: source.enabled === true && serverApproved,
    priority: boundedInteger(source.priority, 0, 1_000, 100),
    badge: publicString(source.badge) ?? '',
    headline: publicString(source.headline) ?? '',
    reason: publicString(source.reason) ?? '',
    minimumPartySize: boundedInteger(source.minimumPartySize, 1, 200, 1),
    maximumPartySize: boundedInteger(source.maximumPartySize, 1, 200, 100),
    sceneTags: publicEnumArray(source.sceneTags, ['date', 'brothers', 'besties', 'friends', 'business', 'celebration', 'unsure']),
    intentTags: publicEnumArray(source.intentTags, ['relaxed', 'energetic', 'ritual', 'unsure']),
    tasteTags: publicEnumArray(source.tasteTags, ['refreshing', 'layered', 'strong', 'any']),
    dwellTags: publicEnumArray(source.dwellTags, ['one_set', 'stay_longer', 'no_rush']),
    singleWaveEligible: source.singleWaveEligible !== false,
    expectedPrepMinutes: boundedInteger(source.expectedPrepMinutes, 0, 240, 8),
    holdMinutes: boundedInteger(source.holdMinutes, 0, 240, 10),
    upgradeProductId: typeof source.upgradeProductId === 'string'
      && /^[0-9a-f-]{36}$/i.test(source.upgradeProductId)
      ? source.upgradeProductId
      : null,
  }
}

function boundedInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum
    ? Number(value)
    : fallback
}

function publicEnumArray<const Value extends string>(value: unknown, allowed: readonly Value[]): Value[] {
  const allowedValues = new Set<string>(allowed)
  return publicStringArray(value).filter((item): item is Value => allowedValues.has(item))
}

function publicBeverageFamily(value: unknown) {
  const allowed = ['none', 'cocktail', 'beer', 'wine', 'sparkling', 'spirits', 'non_alcoholic'] as const
  return typeof value === 'string' && allowed.includes(value as typeof allowed[number]) ? value : 'none'
}

function publicBundleComponents(value: unknown): Array<{ productId: string; name: string; quantity: number }> {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const component = jsonObject(item)
    return typeof component.productId === 'string'
      && typeof component.name === 'string'
      && Number.isSafeInteger(component.quantity)
      && Number(component.quantity) > 0
      ? [{
          productId: component.productId,
          name: component.name,
          quantity: Number(component.quantity),
        }]
      : []
  })
}

async function initiateGuestPayment(
  options: GuestCommerceServiceApiOptions,
  context: GuestRequestContext & { tableSessionId: string; businessDate: string },
  commerce: SubmittedCommerceResult,
  orderIdempotencyKey: string,
  createPublicId: NonNullable<GuestCommerceServiceApiOptions['createPublicId']>,
): Promise<CommandExecution<Payment>> {
  // WeChat is the customer-facing channel; Postar is the acquiring provider
  // whose order and callback identities must match the persisted payment.
  const provider = options.paymentMode === 'simulation' ? 'simulation' : 'postar'
  const method = options.paymentMode === 'wechat_jsapi' ? 'jsapi' : 'native_qr'
  const idempotencyKey = `guest-pay-${createHash('sha256').update(orderIdempotencyKey).digest('hex').slice(0, 48)}`
  const publicId = createPublicId('payment', `${context.scope.storeId}:${idempotencyKey}`)
  return options.payments.initiate({
    scope: context.scope,
    actor: guestActor(context),
    businessDate: context.businessDate,
    idempotencyKey,
    requestFingerprint: stableJson({
      orderId: commerce.order.id,
      publicId,
      provider,
      method,
      customerId: context.customerId,
      tableSessionId: context.tableSessionId,
    }),
    orderId: commerce.order.id,
    publicId,
    provider,
    method,
    principal: {
      type: 'guest',
      tableSessionId: context.tableSessionId,
      customerId: context.customerId,
    },
    providerSnapshot: { source: 'guest_checkout', configuredMode: options.paymentMode },
  })
}

function checkoutResponse(
  orderExecution: CommandExecution<SubmittedCommerceResult>,
  paymentExecution: CommandExecution<Payment>,
  mode: GuestCheckoutPaymentMode,
) {
  const order = orderExecution.value.order
  const payment = paymentExecution.value
  const billedItems = order.items.filter((item) => item.billable)
  const attentionRequired = Boolean(order.note?.trim()) || order.items.some((item) => Boolean(item.note?.trim()))
  return {
    data: {
      cart: {
        itemCount: billedItems.reduce((sum, item) => sum + item.quantity, 0),
        lineCount: billedItems.length,
        items: billedItems.map((item) => ({
          productId: item.productId,
          name: publicString(item.productSnapshot.name) ?? '',
          quantity: item.quantity,
          unitAmountMinor: item.unitPriceMinor,
          totalAmountMinor: item.totalAmountMinor,
          currency: item.currency,
          note: item.note,
        })),
      },
      order: {
        publicId: order.publicId,
        status: order.status,
        paymentStatus: order.paymentStatus,
        note: order.note,
        attentionRequired,
        kdsNotice: attentionRequired ? '订单含备注，出品与配送页面将重点提示' : null,
      },
      settlement: {
        subtotalAmountMinor: order.subtotalAmountMinor,
        discountAmountMinor: order.discountAmountMinor,
        payableAmountMinor: order.totalAmountMinor,
        currency: order.currency,
      },
      payment: {
        publicId: payment.publicId,
        mode,
        provider: payment.provider,
        method: payment.method,
        status: payment.status,
        simulated: mode === 'simulation',
        providerAction: mode === 'simulation'
          ? 'simulation_confirmation_required'
          : 'provider_order_required',
      },
    },
    meta: {
      replayed: orderExecution.replayed && paymentExecution.replayed,
      orderReplayed: orderExecution.replayed,
      paymentReplayed: paymentExecution.replayed,
    },
  }
}

function toGuestServiceCommandResult(
  result: GuestServiceRequestResult,
  requestType: GuestServiceRequestType,
): GuestServiceCommandResult {
  if (result.status === 'rate_limited') {
    return {
      status: result.status,
      requestType,
      taskPublicId: null,
      taskStatus: null,
      requestCount: null,
      workflow: null,
      dimension: result.dimension,
      retryAt: result.retryAt,
    }
  }
  return {
    status: result.status,
    requestType,
    taskPublicId: result.task.publicId,
    taskStatus: result.task.status,
    requestCount: result.requestCount,
    workflow: result.workflow,
    dimension: null,
    retryAt: null,
  }
}

function serviceBehaviorData(result: GuestServiceCommandResult): JsonObject {
  return {
    status: result.status,
    requestType: result.requestType,
    taskPublicId: result.taskPublicId,
    requestCount: result.requestCount,
    workflow: result.workflow,
    rateLimitDimension: result.dimension,
    retryAt: result.retryAt,
  }
}

function serviceResponse(result: GuestServiceCommandResult) {
  if (result.status === 'rate_limited') {
    return {
      status: result.status,
      message: '我们已经收到啦，伙伴正在赶来，请稍等一下',
      retryAt: result.retryAt,
    }
  }
  return {
    status: result.status,
    taskPublicId: result.taskPublicId,
    requestCount: result.requestCount,
    workflow: result.workflow,
    message: result.requestType === 'complaint'
      ? '已收到，值班经理会尽快到桌了解情况'
      : result.status === 'merged'
        ? '这件事我们记着呢，伙伴正在赶来'
        : '收到，我们马上来照顾您',
  }
}

function readGuestOrder(value: unknown): {
  items: Array<{ productId: string; quantity: number; note?: string | null }>
  note: string | null
  confirmedDuplicateOrderId: string | null
} {
  const body = readStrictObject(value, '请求正文', ['items', 'note', 'confirmedDuplicateOrderId'])
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 50) {
    throw new GuestApiRequestError('ORDER_ITEMS_INVALID', '请选择1至50项商品后再下单')
  }
  const seen = new Set<string>()
  const items = body.items.map((raw, index) => {
    const item = readStrictObject(raw, `items[${index}]`, ['productId', 'quantity', 'note'])
    const productId = readUuid(item.productId, `items[${index}].productId`)
    if (seen.has(productId)) {
      throw new GuestApiRequestError('ORDER_DUPLICATE_PRODUCT', '相同商品请合并数量后再下单')
    }
    seen.add(productId)
    const quantity = readInteger(item.quantity, `items[${index}].quantity`, 1, 999)
    const note = readOptionalString(item.note, `items[${index}].note`, 300)
    return { productId, quantity, note }
  })
  const confirmedDuplicateOrderId = readOptionalString(
    body.confirmedDuplicateOrderId,
    'confirmedDuplicateOrderId',
    128,
  )
  if (confirmedDuplicateOrderId !== null && confirmedDuplicateOrderId.length < 8) {
    throw new GuestApiRequestError('DUPLICATE_CONFIRMATION_INVALID', '重复订单确认信息无效')
  }
  return { items, note: readOptionalString(body.note, 'note', 500), confirmedDuplicateOrderId }
}

function readServiceRequest(value: unknown): { requestType: GuestServiceRequestType; detail: string | null } {
  const body = readStrictObject(value, '请求正文', ['requestType', 'detail'])
  if (typeof body.requestType !== 'string'
    || !['call_staff', 'complaint', 'custom'].includes(body.requestType)) {
    throw new GuestApiRequestError('SERVICE_REQUEST_INVALID', '请选择需要的服务类型')
  }
  const requestType = body.requestType as GuestServiceRequestType
  const detail = readOptionalString(body.detail, 'detail', 500)
  if (requestType === 'custom' && (detail === null || detail.length < 2)) {
    throw new GuestApiRequestError('SERVICE_DETAIL_REQUIRED', '请简单说说您需要什么，我们好马上安排')
  }
  return { requestType, detail }
}

function readMood(value: unknown): GuestMood {
  const body = readStrictObject(value, '请求正文', ['mood'])
  if (typeof body.mood !== 'string' || !MOODS.has(body.mood as GuestMood)) {
    throw new GuestApiRequestError('MOOD_INVALID', '请选择当前最符合您的状态')
  }
  return body.mood as GuestMood
}

function readMenuQuery(value: unknown): { search: string; categoryCode: string | null; limit: number; offset: number } {
  const query = jsonObject(value)
  const allowed = new Set(['search', 'categoryCode', 'limit', 'offset'])
  for (const key of Object.keys(query)) {
    if (!allowed.has(key)) throw new GuestApiRequestError('MENU_QUERY_INVALID', `不支持的菜单查询条件: ${key}`)
  }
  return {
    search: readOptionalString(query.search, 'search', 80) ?? '',
    categoryCode: readOptionalString(query.categoryCode, 'categoryCode', 64),
    limit: query.limit === undefined ? 50 : readIntegerString(query.limit, 'limit', 1, 100),
    offset: query.offset === undefined ? 0 : readIntegerString(query.offset, 'offset', 0, 10_000),
  }
}

function readIdempotencyKey(request: FastifyRequest): string {
  const header = request.headers['idempotency-key']
  if (Array.isArray(header) || typeof header !== 'string'
    || header.trim().length < 8 || header.trim().length > 128) {
    throw new GuestApiRequestError('IDEMPOTENCY_KEY_REQUIRED', '请求标识缺失，请刷新后重试')
  }
  return header.trim()
}

function guestActor(context: GuestRequestContext): AuditActor {
  return { type: 'guest', ref: context.actorRef }
}

function deterministicPublicId(kind: 'order' | 'payment' | 'service', seed: string): string {
  return `guest-${kind}-${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`
}

class GuestApiRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message)
    this.name = 'GuestApiRequestError'
  }
}

async function handleRoute(reply: FastifyReply, operation: () => Promise<unknown>): Promise<unknown> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof GuestApiRequestError) {
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } })
    }
    if (error instanceof GuestAuthenticationRequiredError || error instanceof GuestDeviceBindingError) {
      return reply.code(401).send({ error: { code: 'GUEST_SESSION_INVALID', message: error.message } })
    }
    if (error instanceof GuestStoreScopeError) {
      return reply.code(403).send({ error: { code: 'STORE_ACCESS_FORBIDDEN', message: error.message } })
    }
    if (error instanceof GuestCapabilityDeniedError) {
      return reply.code(403).send({ error: { code: 'GUEST_CAPABILITY_DENIED', message: '当前入口不能执行这项操作' } })
    }
    if (error instanceof GuestBehaviorSessionUnavailableError
      || error instanceof GuestServiceSessionUnavailableError
      || error instanceof TableSessionUnavailableForOrderError) {
      return reply.code(409).send({ error: { code: 'TABLE_SESSION_ENDED', message: '这桌已经结束服务，请重新扫描桌面二维码' } })
    }
    if (error instanceof OrderProductUnavailableError) {
      return reply.code(409).send({ error: { code: 'PRODUCT_UNAVAILABLE', message: '有商品暂时无法供应，请返回购物车调整后再试' } })
    }
    if (error instanceof GuestOrderDuplicateConfirmationRequiredError) {
      return reply.code(409).send({ error: {
        code: 'GUEST_ORDER_DUPLICATE_CONFIRMATION_REQUIRED',
        message: error.message,
        details: {
          conflictingOrderId: error.conflictingOrderPublicId,
          conflictingOrderCreatedAt: error.conflictingOrderCreatedAt,
        },
      } })
    }
    if (error instanceof GuestOrderRateLimitedError) {
      return reply.code(429).send({ error: {
        code: 'GUEST_ORDER_RATE_LIMITED',
        message: error.message,
        retryAt: error.retryAt,
        details: { dimension: error.dimension },
      } })
    }
    if (error instanceof OrderNotPayableError) {
      return reply.code(409).send({ error: { code: 'ORDER_NOT_PAYABLE', message: '订单已提交，但当前无法创建支付，请稍后重试或呼叫服务员' } })
    }
    if (error instanceof TypeError) {
      return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: error.message } })
    }
    reply.log.error({ err: error }, 'normalized guest commerce/service API failed')
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: '暂时没有处理成功，请稍后再试' } })
  }
}

function readStrictObject(value: unknown, name: string, allowedKeys: readonly string[]): JsonObject {
  const object = jsonObject(value)
  const allowed = new Set(allowedKeys)
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new GuestApiRequestError('UNTRUSTED_FIELD', `${name}不允许提交字段: ${key}`)
    }
  }
  return object
}

function jsonObject(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : {}
}

function readUuid(value: unknown, name: string): string {
  if (typeof value !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new GuestApiRequestError('INVALID_UUID', `${name}格式无效`)
  }
  return value
}

function readInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new GuestApiRequestError('INVALID_NUMBER', `${name}必须是${minimum}至${maximum}之间的整数`)
  }
  return value as number
}

function readIntegerString(value: unknown, name: string, minimum: number, maximum: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return readInteger(parsed, name, minimum, maximum)
}

function readOptionalString(value: unknown, name: string, maximum: number): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || value.trim().length > maximum) {
    throw new GuestApiRequestError('INVALID_TEXT', `${name}格式无效或超过${maximum}个字符`)
  }
  return value.trim()
}

function publicString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function publicStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string').slice(0, 20)
  if (typeof value === 'string') return value.split(/[,，]/).map((item) => item.trim()).filter(Boolean).slice(0, 20)
  return []
}

function publicRecommendationScene(value: unknown): string | null {
  const snapshot = jsonObject(value)
  const allowed = new Set(['unsure', 'date', 'brothers', 'besties', 'friends', 'business', 'celebration'])
  const candidates = [snapshot.recommendationScene, snapshot.scene, snapshot.occasion]
  return candidates.find((candidate): candidate is string => typeof candidate === 'string' && allowed.has(candidate)) ?? null
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

const guestServiceResultCodec: JsonCodec<GuestServiceCommandResult> = {
  encode: (value) => ({ ...value }),
  decode: (value) => {
    const row = jsonObject(value)
    if (typeof row.status !== 'string' || typeof row.requestType !== 'string') {
      throw new TypeError('Stored guest service result is invalid')
    }
    return row as unknown as GuestServiceCommandResult
  },
}

const guestMoodResultCodec: JsonCodec<GuestMoodCommandResult> = {
  encode: (value) => ({ ...value }),
  decode: (value) => {
    const row = jsonObject(value)
    if (row.recorded !== true || typeof row.mood !== 'string' || typeof row.occurredAt !== 'string') {
      throw new TypeError('Stored guest mood result is invalid')
    }
    return row as unknown as GuestMoodCommandResult
  },
}
