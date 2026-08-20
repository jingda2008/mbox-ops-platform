import { createHash } from 'node:crypto'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type {
  AuditActor,
  CommandExecution,
  JsonCodec,
  JsonObject,
  NormalizedCommandExecutor,
} from './command-executor.js'
import {
  GuestTablePositionChangedError,
  type CommerceCommandService,
  type SubmittedCommerceResult,
} from './commerce-command-service.js'
import { CustomerExperienceRequestError } from './customer-experience-repository.js'
import {
  GuestOrderDuplicateConfirmationRequiredError,
  GuestOrderRateLimitedError,
} from './guest-order-safety.js'
import {
  GuestBehaviorRepository,
  GuestBehaviorSessionUnavailableError,
} from './guest-behavior-repository.js'
import {
  GuestServiceFeedbackStateError,
  GuestServiceRepository,
  GuestServiceRequestNotFoundError,
  GuestServiceSessionUnavailableError,
  type GuestServiceFeedbackAction,
  type GuestServiceFeedbackResult,
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
import { FulfillmentCapacityUnavailableError } from './fulfillment-capacity-repository.js'
import type { OnlinePaymentAction, OnlinePaymentService } from './online-payment-service.js'
import {
  OnlinePaymentUnavailableError,
  OnlinePaymentUnknownError,
} from './online-payment-service.js'
import {
  PaymentProviderActionRepository,
  ProviderPaymentInProgressError,
  ProviderPaymentMethodConflictError,
  ProviderPaymentUnknownError,
  WechatPaymentIdentityRequiredError,
} from './payment-provider-action-repository.js'
import { PostarPaymentRejectedError } from '../postar-adapter.js'
import {
  lockBoundGuestTablePosition,
  requireGuestSessionIdFromActorRef,
} from './guest-table-authority.js'
import type {
  ScopedPostgresTransactionRunner,
  ScopedTransaction,
  StoreScope,
} from './transaction-runner.js'

export type GuestCheckoutPaymentMode = 'wechat_jsapi' | 'wechat_native_qr' | 'simulation'

export interface GuestCommerceServiceApiOptions {
  transactions: Pick<ScopedPostgresTransactionRunner, 'run'>
  commandExecutor: Pick<NormalizedCommandExecutor, 'execute'>
  commerce: Pick<CommerceCommandService, 'submitOrder'>
  payments: Pick<PaymentCommandService, 'initiate'>
  onlinePayments: Pick<OnlinePaymentService, 'create' | 'resolveGuestMethod' | 'assertAvailable' | 'resolveActivePayment'>
  resolveGuestContext(request: FastifyRequest): Promise<GuestRequestContext> | GuestRequestContext
  resolveDeviceFingerprint(request: FastifyRequest): string
  paymentMode: GuestCheckoutPaymentMode
  resolvePaymentMode?: (scope: Readonly<StoreScope>) => Promise<GuestCheckoutPaymentMode | null>
  paymentActionSecret: string
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
  guest_visible: boolean
  search_text: string
  recommendation_beverage_family: string
  recommendation_enabled: boolean
  recommendation_min_guests: number
  recommendation_max_guests: number
  recommendation_priority: number
  recommendation_scene_tags: string[]
  recommendation_intent_tags: string[]
  recommendation_taste_tags: string[]
  recommendation_dwell_tags: string[]
  recommendation_single_wave_eligible: boolean
  recommendation_expected_prep_minutes: number
  recommendation_hold_minutes: number
  recommendation_upgrade_product_id: string | null
  menu_sort_order: number
  available_from: string | null
  available_until: string | null
  max_order_quantity: number
  within_availability: boolean
  cost_amount_minor: string | null
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
    const products = await options.transactions.run(context.scope, async (transaction) => {
      if (!await lockBoundGuestTablePosition(transaction, context)) {
        throw new GuestAuthenticationRequiredError()
      }
      return searchGuestCatalog(transaction, context.tableSessionId, query)
    })
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
    const paymentMode = await effectivePaymentMode(options, context.scope)
    options.onlinePayments.assertAvailable(paymentMode === 'simulation' ? 'simulation' : 'postar')
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
      checkoutUpgradeOfferPublicId: input.checkoutUpgradeOfferPublicId,
      ...(input.recommendationPublicId === null ? {} : {
        recommendationAttribution: {
          recommendationPublicId: input.recommendationPublicId,
          selectedProductId: input.selectedRecommendationProductId!,
        },
      }),
    })
    const payment = await initiateGuestPayment(options, context, orderExecution.value, idempotencyKey, createPublicId, paymentMode)
    const providerAction = await createGuestProviderAction(
      options,
      context,
      payment.value,
      orderExecution.value.order.publicId,
      request.ip,
    )
    return reply.code(orderExecution.replayed ? 200 : 201).send(
      checkoutResponse(orderExecution, payment, paymentMode, providerAction),
    )
  }))

  app.get('/guest/orders/table', async (request, reply) => handleRoute(reply, async () => {
    const context = await requireTableContext(options, request, 'guest.session.read')
    const orders = await options.transactions.run(context.scope, async (transaction) => {
      if (!await lockBoundGuestTablePosition(transaction,context)) {
        throw new GuestAuthenticationRequiredError()
      }
      return loadGuestTableOrders(transaction, context.tableSessionId, context.customerId)
    })
    return reply.send({ data: orders, meta: { tableSessionId: context.tableSessionId, count: orders.length } })
  }))

  app.post<{ Params: { orderPublicId: string } }>(
    '/guest/orders/:orderPublicId/payment',
    async (request, reply) => handleRoute(reply, async () => {
      const context = await requireTableContext(options, request, 'guest.order.create')
      const paymentMode = await effectivePaymentMode(options, context.scope)
      options.onlinePayments.assertAvailable(paymentMode === 'simulation' ? 'simulation' : 'postar')
      const orderPublicId = readPublicId(request.params.orderPublicId, 'orderPublicId')
      const resolved = await options.transactions.run(context.scope, async (transaction) => (
        new PaymentProviderActionRepository(transaction, options.paymentActionSecret)
          .resolveOrderForGuest(orderPublicId, guestPaymentPrincipal(context))
      ))
      let payment: CommandExecution<Payment>
      if (resolved.activePaymentId === null) {
        const method = await options.onlinePayments.resolveGuestMethod(context.scope, context.customerId)
        const idempotencyKey = readIdempotencyKey(request)
        try {
          payment = await options.payments.initiate({
            scope: context.scope,
            actor: guestActor(context),
            businessDate: context.businessDate,
            idempotencyKey,
            requestFingerprint: stableJson({ orderId: resolved.orderId, method, customerId: context.customerId }),
            orderId: resolved.orderId,
            publicId: createPublicId('payment', `${context.scope.storeId}:${idempotencyKey}`),
            provider: paymentMode === 'simulation' ? 'simulation' : 'postar',
            method,
            principal: guestPaymentPrincipal(context),
            providerSnapshot: { channel: 'guest_table_order' },
          })
        } catch (error) {
          if (!(error instanceof OrderNotPayableError)) throw error
          const active = await options.onlinePayments.resolveActivePayment({
            scope: context.scope,
            orderId: resolved.orderId,
            principal: guestPaymentPrincipal(context),
          })
          if (active === null) throw error
          payment = { value: paymentFromContext(active), replayed: true }
        }
      } else {
        const value = await options.transactions.run(context.scope, async (transaction) => (
          new PaymentProviderActionRepository(transaction, options.paymentActionSecret)
            .resolvePaymentContext(resolved.activePaymentId!,guestPaymentPrincipal(context),{ lock:false })
        ))
        payment = { value: paymentFromContext(value), replayed: true }
      }
      const action = await createGuestProviderAction(options, context, payment.value, orderPublicId, request.ip)
      return reply.send({ data: action, meta: { replayed: payment.replayed } })
    }),
  )

  app.post('/guest/service-requests', async (request, reply) => handleRoute(reply, async () => {
    const context = await requireTableContext(options, request, 'guest.service.create')
    const input = readServiceRequest(request.body)
    const deviceFingerprint = options.resolveDeviceFingerprint(request)
    const idempotencyKey = readIdempotencyKey(request)
    const execution = await options.commandExecutor.execute({
      scope: context.scope,
      operationScope: 'guest.service.request',
      idempotencyKey,
      requestFingerprint: stableJson({
        requestType: input.requestType,
        detail: input.detail,
        relatedOrderPublicId: input.relatedOrderPublicId,
      }),
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
        relatedOrderPublicId: input.relatedOrderPublicId,
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

  app.get('/guest/service-requests', async (request, reply) => handleRoute(reply, async () => {
    const context = await requireTableContext(options, request, 'guest.session.read')
    const requests = await options.transactions.run(context.scope, async (transaction) => {
      if (!await lockBoundGuestTablePosition(transaction,context)) {
        throw new GuestAuthenticationRequiredError()
      }
      return new GuestServiceRepository(transaction).listOwned(context.tableSessionId, context.customerId)
    })
    return reply.send({
      data: requests,
      meta: { count: requests.length },
    })
  }))

  app.post<{ Params: { publicId: string } }>(
    '/guest/service-requests/:publicId/feedback',
    async (request, reply) => handleRoute(reply, async () => {
      const context = await requireTableContext(options, request, 'guest.service.create')
      const publicId = readPublicId(request.params.publicId, 'publicId')
      const action = readServiceFeedback(request.body)
      const idempotencyKey = readIdempotencyKey(request)
      const execution = await options.commandExecutor.execute({
        scope: context.scope,
        operationScope: 'guest.service.feedback',
        idempotencyKey,
        requestFingerprint: stableJson({ publicId, action }),
        resultCodec: guestServiceFeedbackCodec,
      }, async (transaction) => {
        const result = await new GuestServiceRepository(transaction).feedback({
          tableSessionId: context.tableSessionId,
          customerId: context.customerId,
          actorRef: context.actorRef,
          publicId,
          action,
        })
        return {
          result,
          auditEvents: result.changed ? [{
            actor: guestActor(context),
            action: `guest.service.${action === 'confirm' ? 'confirmed' : 'escalated'}`,
            objectType: 'service_task',
            objectId: result.taskId,
            businessDate: context.businessDate,
            afterData: {
              publicId: result.publicId,
              action: result.action,
              taskStatus: result.taskStatus,
            },
          }] : [],
          outboxMessages: result.changed ? [{
            businessEventKey: `guest-service-feedback:${result.taskId}:${result.action}`,
            aggregateType: 'service_task',
            aggregateId: result.taskId,
            aggregateVersion: 1,
            eventType: `guest.service.${action === 'confirm' ? 'confirmed' : 'escalated'}.v1`,
            payload: {
              publicId: result.publicId,
              action: result.action,
              taskStatus: result.taskStatus,
            },
          }] : [],
        }
      })
      return reply.send({
        data: {
          publicId: execution.value.publicId,
          action: execution.value.action,
          taskStatus: execution.value.taskStatus,
          recorded: true,
          occurredAt: execution.value.occurredAt,
        },
        meta: { replayed: execution.replayed || !execution.value.changed },
      })
    }),
  )

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
      product.product_snapshot, product.guest_visible, product.search_text,
      product.recommendation_beverage_family,
      product.recommendation_enabled, product.recommendation_min_guests,
      product.recommendation_max_guests, product.recommendation_priority,
      product.recommendation_scene_tags, product.recommendation_intent_tags,
      product.recommendation_taste_tags, product.recommendation_dwell_tags,
      product.recommendation_single_wave_eligible,
      product.recommendation_expected_prep_minutes, product.recommendation_hold_minutes,
      product.recommendation_upgrade_product_id, product.menu_sort_order,
      to_char(product.available_from, 'HH24:MI') AS available_from,
      to_char(product.available_until, 'HH24:MI') AS available_until,
      product.max_order_quantity,
      CASE WHEN product.available_from IS NULL THEN true
        WHEN product.available_from < product.available_until THEN
          (clock_timestamp() AT TIME ZONE store.timezone)::time >= product.available_from
          AND (clock_timestamp() AT TIME ZONE store.timezone)::time < product.available_until
        ELSE (clock_timestamp() AT TIME ZONE store.timezone)::time >= product.available_from
          OR (clock_timestamp() AT TIME ZONE store.timezone)::time < product.available_until
      END AS within_availability,
      product.cost_amount_minor::text, product.status,
      price.amount_minor::text, price.currency,
      current_session.guest_count, current_session.guest_profile_snapshot
    FROM mbox.products AS product
    JOIN mbox.table_sessions AS current_session
      ON current_session.tenant_id = product.tenant_id
      AND current_session.store_id = product.store_id
      AND current_session.id = $3::uuid
      AND current_session.status = 'open'
    JOIN mbox.stores AS store
      ON store.tenant_id=product.tenant_id AND store.id=product.store_id AND store.status='active'
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
      AND product.guest_visible
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
        OR product.search_text ILIKE $6 ESCAPE '\\'
      )
    ORDER BY
      CASE WHEN product.recommendation_enabled
        AND product.cost_amount_minor IS NOT NULL
        AND price.amount_minor > product.cost_amount_minor
        AND product.recommendation_min_guests <= current_session.guest_count
        AND product.recommendation_max_guests >= current_session.guest_count
        THEN 0
        WHEN product.recommendation_enabled THEN 1
        ELSE 2
      END,
      product.recommendation_priority DESC,
      product.menu_sort_order,
      CASE WHEN product.product_kind = 'bundle' THEN 0 ELSE 1 END,
      CASE
        WHEN product.cost_amount_minor IS NOT NULL AND price.amount_minor > product.cost_amount_minor
        THEN price.amount_minor - product.cost_amount_minor
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
    beverageFamily: publicBeverageFamily(row.recommendation_beverage_family),
    specification: publicString(row.product_snapshot.specification)
      ?? publicString(source.specification),
    aliases: publicStringArray(row.product_snapshot.aliases ?? source.aliases),
    tags: publicStringArray(row.product_snapshot.tags ?? source.tags),
    imageUrl: publicString(row.product_snapshot.imageUrl) ?? publicString(source.imageUrl),
    description: publicString(row.product_snapshot.description) ?? publicString(source.description),
    sortOrder: row.menu_sort_order,
    availableFrom: row.available_from,
    availableUntil: row.available_until,
    guestVisible: row.guest_visible,
    requiresFulfillment: row.product_kind === 'bundle' || row.fulfillment_station !== 'none',
    maxOrderQuantity: row.max_order_quantity,
    amountMinor,
    currency: row.currency,
    fulfillmentStation: row.fulfillment_station,
    productKind: row.product_kind,
    bundleComponents: publicBundleComponents(row.bundle_components),
    recommendation: publicRecommendation(row, amountMinor),
    available: row.status === 'active' && row.amount_minor !== null && row.within_availability !== false,
  }
}

function publicRecommendation(row: CatalogMenuRow, amountMinor: number | null) {
  const source = jsonObject(row.product_snapshot.recommendation)
  const costAmount = row.cost_amount_minor === null ? null : Number(row.cost_amount_minor)
  const serverApproved = amountMinor !== null && costAmount !== null && amountMinor > costAmount
  return {
    enabled: row.recommendation_enabled && serverApproved,
    priority: row.recommendation_priority,
    badge: publicString(source.badge) ?? '',
    headline: publicString(source.headline) ?? '',
    reason: publicString(source.reason) ?? '',
    minimumPartySize: row.recommendation_min_guests,
    maximumPartySize: row.recommendation_max_guests,
    sceneTags: row.recommendation_scene_tags,
    intentTags: row.recommendation_intent_tags,
    tasteTags: row.recommendation_taste_tags,
    dwellTags: row.recommendation_dwell_tags,
    singleWaveEligible: row.recommendation_single_wave_eligible,
    expectedPrepMinutes: row.recommendation_expected_prep_minutes,
    holdMinutes: row.recommendation_hold_minutes,
    upgradeProductId: row.recommendation_upgrade_product_id,
  }
}

function publicBeverageFamily(value: unknown) {
  const allowed = ['none', 'cocktail', 'beer', 'wine', 'sparkling', 'spirits', 'non_alcoholic', 'mixed'] as const
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
  paymentMode: GuestCheckoutPaymentMode,
): Promise<CommandExecution<Payment>> {
  // WeChat is the customer-facing channel; Postar is the acquiring provider
  // whose order and callback identities must match the persisted payment.
  const provider = paymentMode === 'simulation' ? 'simulation' : 'postar'
  const method = paymentMode === 'simulation'
    ? 'native_qr'
    : await options.onlinePayments.resolveGuestMethod(context.scope, context.customerId)
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
    principal: guestPaymentPrincipal(context),
    providerSnapshot: { source: 'guest_checkout', configuredMode: paymentMode },
  })
}

async function effectivePaymentMode(
  options: GuestCommerceServiceApiOptions,
  scope: Readonly<StoreScope>,
): Promise<GuestCheckoutPaymentMode> {
  const mode = options.resolvePaymentMode === undefined ? options.paymentMode : await options.resolvePaymentMode(scope)
  if (mode === null) throw new OnlinePaymentUnavailableError('门店已暂停线上支付，请联系服务员')
  return mode
}

async function createGuestProviderAction(
  options: GuestCommerceServiceApiOptions,
  context: GuestRequestContext & { tableSessionId: string },
  payment: Payment,
  orderPublicId: string,
  clientIp: string,
): Promise<OnlinePaymentAction> {
  if (payment.method === 'auth_code') {
    throw new ProviderPaymentMethodConflictError('本笔正在由员工扫描付款码收款，请勿从桌码重复支付')
  }
  try {
    return await options.onlinePayments.create({
      scope: context.scope,
      paymentId: payment.id,
      principal: guestPaymentPrincipal(context),
      clientIp,
      operatorId: 'MBOXGUEST',
    })
  } catch (error) {
    if (error instanceof PostarPaymentRejectedError) return unavailablePaymentAction(payment, orderPublicId, 'failed')
    if (error instanceof ProviderPaymentInProgressError) return unavailablePaymentAction(payment, orderPublicId, 'pending')
    if (error instanceof ProviderPaymentUnknownError || error instanceof OnlinePaymentUnknownError) {
      return unavailablePaymentAction(payment, orderPublicId, 'unknown')
    }
    throw error
  }
}

function unavailablePaymentAction(
  payment: Payment,
  orderPublicId: string,
  status: Extract<OnlinePaymentAction['status'], 'pending' | 'unknown' | 'failed'>,
): OnlinePaymentAction {
  const presentation = payment.method === 'jsapi' ? 'jsapi'
    : payment.method === 'auth_code' ? 'barcode'
      : 'qr'
  return {
    paymentId: payment.id,
    paymentPublicId: payment.publicId,
    orderPublicId,
    status,
    presentation,
    expiresAt: new Date().toISOString(),
    payload: null,
  }
}

function checkoutResponse(
  orderExecution: CommandExecution<SubmittedCommerceResult>,
  paymentExecution: CommandExecution<Payment>,
  mode: GuestCheckoutPaymentMode,
  providerAction: OnlinePaymentAction,
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
        kdsNotice: attentionRequired ? '备注已保存，付款成功后将在出品与配送页面重点提示' : null,
      },
      settlement: {
        subtotalAmountMinor: order.subtotalAmountMinor,
        discountAmountMinor: order.discountAmountMinor,
        payableAmountMinor: order.totalAmountMinor,
        currency: order.currency,
      },
      payment: {
        publicId: payment.publicId,
        mode: providerAction.presentation === 'jsapi'
          ? 'wechat_jsapi'
          : mode === 'simulation' ? 'simulation' : 'wechat_native_qr',
        provider: payment.provider,
        method: payment.method,
        status: providerAction.status === 'failed' ? 'failed' : payment.status,
        simulated: mode === 'simulation',
        providerAction,
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
  checkoutUpgradeOfferPublicId: string | null
  recommendationPublicId: string | null
  selectedRecommendationProductId: string | null
} {
  const body = readStrictObject(value, '请求正文', [
    'items', 'note', 'confirmedDuplicateOrderId', 'checkoutUpgradeOfferPublicId',
    'recommendationPublicId', 'selectedRecommendationProductId',
  ])
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
  const checkoutUpgradeOfferPublicId = readOptionalString(
    body.checkoutUpgradeOfferPublicId,
    'checkoutUpgradeOfferPublicId',
    128,
  )
  if (checkoutUpgradeOfferPublicId !== null && checkoutUpgradeOfferPublicId.length < 8) {
    throw new GuestApiRequestError('CHECKOUT_UPGRADE_INVALID', '付款前升级编号无效')
  }
  const recommendationPublicId = readOptionalString(
    body.recommendationPublicId,
    'recommendationPublicId',
    128,
  )
  if (recommendationPublicId !== null && recommendationPublicId.length < 8) {
    throw new GuestApiRequestError('RECOMMENDATION_ATTRIBUTION_INVALID', '推荐编号无效')
  }
  const selectedRecommendationProductId = body.selectedRecommendationProductId === undefined
    || body.selectedRecommendationProductId === null
    ? null
    : readUuid(body.selectedRecommendationProductId, 'selectedRecommendationProductId')
  if ((recommendationPublicId === null) !== (selectedRecommendationProductId === null)) {
    throw new GuestApiRequestError(
      'RECOMMENDATION_ATTRIBUTION_INVALID',
      '推荐编号和所选推荐商品必须同时提供',
    )
  }
  return {
    items,
    note: readOptionalString(body.note, 'note', 500),
    confirmedDuplicateOrderId,
    checkoutUpgradeOfferPublicId,
    recommendationPublicId,
    selectedRecommendationProductId,
  }
}

function readServiceRequest(value: unknown): {
  requestType: GuestServiceRequestType
  detail: string | null
  relatedOrderPublicId: string | null
} {
  const body = readStrictObject(value, '请求正文', ['requestType', 'detail', 'relatedOrderPublicId'])
  if (typeof body.requestType !== 'string'
    || !['call_staff', 'complaint', 'custom'].includes(body.requestType)) {
    throw new GuestApiRequestError('SERVICE_REQUEST_INVALID', '请选择需要的服务类型')
  }
  const requestType = body.requestType as GuestServiceRequestType
  const detail = readOptionalString(body.detail, 'detail', 500)
  if (requestType === 'custom' && (detail === null || detail.length < 2)) {
    throw new GuestApiRequestError('SERVICE_DETAIL_REQUIRED', '请简单说说您需要什么，我们好马上安排')
  }
  const relatedOrderPublicId = body.relatedOrderPublicId === undefined || body.relatedOrderPublicId === null
    ? null : readPublicId(body.relatedOrderPublicId, 'relatedOrderPublicId')
  if (relatedOrderPublicId !== null && requestType !== 'complaint') {
    throw new GuestApiRequestError('SERVICE_REQUEST_INVALID', '只有订单问题可以关联订单')
  }
  return { requestType, detail, relatedOrderPublicId }
}

function readServiceFeedback(value: unknown): GuestServiceFeedbackAction {
  const body = readStrictObject(value, '请求正文', ['action'])
  if (body.action !== 'confirm' && body.action !== 'escalate') {
    throw new GuestApiRequestError('SERVICE_FEEDBACK_INVALID', '请选择确认完成或再次催办')
  }
  return body.action
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

function guestPaymentPrincipal(context: GuestRequestContext & { tableSessionId: string }) {
  return {
    type:'guest' as const,
    tableSessionId:context.tableSessionId,
    customerId:context.customerId,
    guestSessionId:requireGuestSessionIdFromActorRef(context.actorRef),
  }
}

function deterministicPublicId(kind: 'order' | 'payment' | 'service', seed: string): string {
  const prefix = kind === 'order' ? 'O' : kind === 'payment' ? 'P' : 'S'
  return `${prefix}${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`
}

function readPublicId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9-]{8,128}$/.test(value)) {
    throw new GuestApiRequestError('INVALID_PUBLIC_ID', `${name}格式无效`)
  }
  return value
}

function paymentFromContext(value: Awaited<ReturnType<PaymentProviderActionRepository['resolvePaymentContext']>>): Payment {
  return {
    id: value.id,
    payableKind: 'order',
    orderId: value.orderId,
    activityRegistrationId: null,
    publicId: value.publicId,
    provider: value.provider,
    providerTransactionId: value.providerTransactionId,
    settlementChannel: null,
    method: value.method,
    amountMinor: value.amountMinor,
    currency: value.currency,
    status: value.status as Payment['status'],
    providerSnapshot: {},
    succeededAt: null,
    createdAt: value.createdAt,
    updatedAt: value.createdAt,
  }
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
      || error instanceof TableSessionUnavailableForOrderError
      || error instanceof GuestTablePositionChangedError) {
      return reply.code(409).send({ error: { code: 'TABLE_SESSION_ENDED', message: '这桌已经结束服务，请重新扫描桌面二维码' } })
    }
    if (error instanceof GuestServiceRequestNotFoundError) {
      return reply.code(404).send({ error: { code: 'SERVICE_REQUEST_NOT_FOUND', message: error.message } })
    }
    if (error instanceof GuestServiceFeedbackStateError) {
      return reply.code(409).send({ error: { code: 'SERVICE_FEEDBACK_STATE_CONFLICT', message: error.message } })
    }
    if (error instanceof OrderProductUnavailableError) {
      return reply.code(409).send({ error: { code: 'PRODUCT_UNAVAILABLE', message: '有商品暂时无法供应，请返回购物车调整后再试' } })
    }
    if (error instanceof FulfillmentCapacityUnavailableError) {
      return reply.code(409).send({ error: { code: error.code, message: error.message } })
    }
    if (error instanceof CustomerExperienceRequestError) {
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } })
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
    if (error instanceof ProviderPaymentInProgressError) {
      return reply.code(409).send({ error: { code: 'PAYMENT_IN_PROGRESS', message: error.message } })
    }
    if (error instanceof ProviderPaymentMethodConflictError) {
      return reply.code(409).send({ error: { code: 'PAYMENT_METHOD_LOCKED', message: error.message } })
    }
    if (error instanceof ProviderPaymentUnknownError || error instanceof OnlinePaymentUnknownError) {
      return reply.code(409).send({ error: { code: 'PAYMENT_STATUS_UNKNOWN', message: error.message } })
    }
    if (error instanceof WechatPaymentIdentityRequiredError) {
      return reply.code(409).send({ error: { code: 'WECHAT_IDENTITY_REQUIRED', message: error.message } })
    }
    if (error instanceof OnlinePaymentUnavailableError) {
      return reply.code(503).send({ error: { code: 'ONLINE_PAYMENT_UNAVAILABLE', message: error.message } })
    }
    if (error instanceof PostarPaymentRejectedError) {
      return reply.code(409).send({ error: { code: 'PROVIDER_PAYMENT_REJECTED', message: '支付机构未受理本次付款，请核对后重试' } })
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

const guestServiceFeedbackCodec: JsonCodec<GuestServiceFeedbackResult> = {
  encode: (value) => ({ ...value }),
  decode: (value) => {
    const row = jsonObject(value)
    if (typeof row.taskId !== 'string'
      || typeof row.publicId !== 'string'
      || (row.action !== 'confirm' && row.action !== 'escalate')
      || typeof row.taskStatus !== 'string'
      || typeof row.changed !== 'boolean'
      || typeof row.occurredAt !== 'string') {
      throw new TypeError('Stored guest service feedback result is invalid')
    }
    return row as unknown as GuestServiceFeedbackResult
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
