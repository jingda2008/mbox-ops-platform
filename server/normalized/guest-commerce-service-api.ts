import { createHash, randomUUID } from 'node:crypto'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type {
  AuditActor,
  CommandExecution,
  CommandOutcome,
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
  GuestSharedCartEmptyError,
  GuestSharedCartFrozenError,
  GuestSharedCartLimitError,
  GuestSharedCartOperationConflictError,
  GuestSharedCartRateLimitedError,
  GuestSharedCartRepository,
  GuestSharedCartVersionConflictError,
  type GuestSharedCart,
  type GuestSharedCartCheckoutTransition,
} from './guest-shared-cart-repository.js'
import {
  GuestAuthenticationRequiredError,
  GuestCapabilityDeniedError,
  GuestDeviceBindingError,
  GuestStoreScopeError,
  type GuestRequestContext,
  requireGuestCapability,
} from './guest-request-context.js'
import { OrderProductUnavailableError, TableSessionUnavailableForOrderError } from './order-repository.js'
import type { InitiatePaymentCommand, PaymentCommandService } from './payment-command-service.js'
import { OrderNotPayableError, type Payment } from './payment-repository.js'
import { FulfillmentCapacityUnavailableError } from './fulfillment-capacity-repository.js'
import type { OnlinePaymentAction, OnlinePaymentService } from './online-payment-service.js'
import {
  OnlinePaymentUnavailableError,
  OnlinePaymentUnknownError,
} from './online-payment-service.js'
import {
  PaymentProviderActionRepository,
  GuestOrderPaymentAccessError,
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
import { ReservationGuestSessionInvalidError } from './reservation-guest-session.js'
import { GuestSessionInvalidError, GuestTableSessionEndedError } from './guest-session-repository.js'
import { publicMiniProgramImageUrl } from './media-asset-url.js'
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
    & Partial<Pick<CommerceCommandService, 'submitOrderInTransaction'>>
  payments: Pick<PaymentCommandService, 'initiate'>
    & Partial<Pick<PaymentCommandService, 'initiateInTransaction'>>
  onlinePayments: Pick<OnlinePaymentService, 'create' | 'assertGuestJsapiReady' | 'assertAvailable' | 'resolveActivePayment'>
  resolveGuestContext(request: FastifyRequest): Promise<GuestRequestContext> | GuestRequestContext
  resolvePublicContext(request: FastifyRequest): Promise<{ scope: Readonly<StoreScope> }> | { scope: Readonly<StoreScope> }
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
  category_name: string | null
  category_parent_code: string | null
  category_parent_name: string | null
  category_sort_order: number | null
  top_category_sort_order: number | null
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
  inventory_configuration_complete: boolean
  inventory_available: boolean
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

  app.get('/public/mini/menu/products', async (request, reply) => handleRoute(reply, async () => {
    const context = await options.resolvePublicContext(request)
    const query = readMenuQuery(request.query)
    const products = await options.transactions.run(context.scope, (transaction) => (
      searchGuestCatalog(transaction, null, query)
    ))
    return reply.send({
      data: products.map(publicCatalogProduct),
      meta: { search: query.search, categoryCode: query.categoryCode, count: products.length,
        partySize: null, recommendationScene: null, orderingRequiresTableScan: true },
    })
  }))

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
    await options.transactions.run(context.scope, async (transaction) => {
      if (!await lockBoundGuestTablePosition(transaction, context)) throw new GuestAuthenticationRequiredError()
      await requireGuestCartProtocol(transaction, context.tableSessionId, 1)
    })
    const paymentMode = await effectivePaymentMode(options, context.scope)
    assertGuestSelfPaymentMode(paymentMode)
    options.onlinePayments.assertAvailable(paymentMode === 'simulation' ? 'simulation' : 'postar')
    // Resolve the server-side WeChat payer before creating an order.  This is
    // the same safety boundary used by the shared-cart checkout: a missing
    // identity is recoverable by the customer and must not leave an unpaid
    // order behind.
    const paymentMethod = await guestCheckoutPaymentMethod(options, context, paymentMode)
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
    const payment = await initiateGuestPayment(
      options, context, orderExecution.value, idempotencyKey, createPublicId, paymentMode, paymentMethod,
    )
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
    return reply.send({ data: orders, meta: { count: orders.length } })
  }))

  app.get('/guest/shared-cart', async (request, reply) => handleRoute(reply, async () => {
    const context = await requireTableContext(options, request, 'guest.session.read')
    const cart = await options.transactions.run(context.scope, async (transaction) => {
      if (!await lockBoundGuestTablePosition(transaction, context)) throw new GuestAuthenticationRequiredError()
      await requireGuestCartProtocol(transaction, context.tableSessionId, 2)
      return new GuestSharedCartRepository(transaction).readOpen(
        context.tableSessionId,
        createSharedCartPublicId(),
      )
    })
    return reply.send({ data: publicSharedCart(cart) })
  }))

  app.post('/guest/shared-cart/lines', async (request, reply) => handleRoute(reply, async () => {
    const context = await requireTableContext(options, request, 'guest.order.create')
    const input = readSharedCartAdjustment(request.body)
    const operationId = readIdempotencyKey(request)
    await recordSharedCartWriteAttempt(options,context,operationId,'adjust')
    const cart = await options.transactions.run(context.scope, async (transaction) => {
      if (!await lockBoundGuestTablePosition(transaction, context)) throw new GuestAuthenticationRequiredError()
      await requireGuestCartProtocol(transaction, context.tableSessionId, 2)
      return new GuestSharedCartRepository(transaction).adjust(context.tableSessionId, createSharedCartPublicId(), {
        ...input,
        operationId,
        actorSessionRef: context.actorRef,
      })
    })
    return reply.send({ data: publicSharedCart(cart) })
  }))

  app.delete<{ Params:{ productId:string } }>('/guest/shared-cart/lines/:productId',async (request,reply) => (
    handleRoute(reply,async () => {
      const context=await requireTableContext(options,request,'guest.order.create')
      const input=readSharedCartClear(request.body)
      const operationId=readIdempotencyKey(request)
      await recordSharedCartWriteAttempt(options,context,operationId,'remove')
      const cart=await options.transactions.run(context.scope,async (transaction) => {
        if (!await lockBoundGuestTablePosition(transaction,context)) throw new GuestAuthenticationRequiredError()
        await requireGuestCartProtocol(transaction,context.tableSessionId,2)
        return new GuestSharedCartRepository(transaction).removeLine(
          context.tableSessionId,createSharedCartPublicId(),{
            ...input,productId:readUuid(request.params.productId,'productId'),operationId,
            actorSessionRef:context.actorRef,
          },
        )
      })
      return reply.send({ data:publicSharedCart(cart) })
    })
  ))

  app.post('/guest/shared-cart/clear', async (request, reply) => handleRoute(reply, async () => {
    const context = await requireTableContext(options, request, 'guest.order.create')
    const input = readSharedCartClear(request.body)
    const operationId = readIdempotencyKey(request)
    await recordSharedCartWriteAttempt(options,context,operationId,'clear')
    const cart = await options.transactions.run(context.scope, async (transaction) => {
      if (!await lockBoundGuestTablePosition(transaction, context)) throw new GuestAuthenticationRequiredError()
      await requireGuestCartProtocol(transaction, context.tableSessionId, 2)
      return new GuestSharedCartRepository(transaction).clear(context.tableSessionId, createSharedCartPublicId(), {
        ...input,
        operationId,
        actorSessionRef: context.actorRef,
      })
    })
    return reply.send({ data: publicSharedCart(cart) })
  }))

  app.post('/guest/shared-cart/checkout', async (request, reply) => handleRoute(reply, async () => {
    const context = await requireTableContext(options, request, 'guest.order.create')
    const paymentMode = await effectivePaymentMode(options, context.scope)
    assertGuestSelfPaymentMode(paymentMode)
    options.onlinePayments.assertAvailable(paymentMode === 'simulation' ? 'simulation' : 'postar')
    const input = readSharedCartCheckout(request.body)
    const idempotencyKey = readIdempotencyKey(request)
    await recordSharedCartWriteAttempt(options,context,idempotencyKey,'checkout')
    const paymentMethod = await guestCheckoutPaymentMethod(options, context, paymentMode)
    const paymentCommand = await guestPaymentCommand(
      context, idempotencyKey, createPublicId, paymentMode, paymentMethod,
    )
    if (!options.commerce.submitOrderInTransaction || !options.payments.initiateInTransaction) {
      throw new Error('Shared cart checkout service is unavailable')
    }
    const submitOrderInTransaction = options.commerce.submitOrderInTransaction.bind(options.commerce)
    const initiatePaymentInTransaction = options.payments.initiateInTransaction.bind(options.payments)
    const execution = await options.commandExecutor.execute({
      scope: context.scope,
      operationScope: 'guest.shared-cart.checkout',
      idempotencyKey,
      requestFingerprint: stableJson({
        tableSessionId: context.tableSessionId,
        customerId: context.customerId,
        expectedGeneration: input.expectedGeneration,
        expectedVersion: input.expectedVersion,
        note: input.note,
        confirmedDuplicateOrderId: input.confirmedDuplicateOrderId,
        checkoutUpgradeOfferPublicId: input.checkoutUpgradeOfferPublicId,
        recommendationPublicId: input.recommendationPublicId,
        selectedRecommendationProductId: input.selectedRecommendationProductId,
      }),
      resultCodec: sharedCartCheckoutCodec,
    }, async (transaction) => {
      if (!await lockBoundGuestTablePosition(transaction, context)) throw new GuestAuthenticationRequiredError()
      await requireGuestCartProtocol(transaction, context.tableSessionId, 2)
      const repository = new GuestSharedCartRepository(transaction)
      const cart = await repository.beginCheckout(context.tableSessionId, createSharedCartPublicId(), {
        expectedGeneration: input.expectedGeneration,
        expectedVersion: input.expectedVersion,
        operationId: idempotencyKey,
        actorSessionRef: context.actorRef,
      })
      const orderOutcome = await submitOrderInTransaction(transaction, {
        scope: context.scope,
        actor: guestActor(context),
        businessDate: context.businessDate,
        idempotencyKey: `shared-cart-order-${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 48)}`,
        tableSessionId: context.tableSessionId,
        publicId: createPublicId('order', `${context.scope.storeId}:${idempotencyKey}`),
        channel: 'guest_qr',
        settlementMode: 'immediate_payment',
        lines: cart.lines,
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
      const paymentOutcome = await initiatePaymentInTransaction(transaction, {
        ...paymentCommand,
        orderId: orderOutcome.result.order.id,
        requestFingerprint: stableJson({
          orderId: orderOutcome.result.order.id,
          publicId: paymentCommand.publicId,
          provider: paymentCommand.provider,
          method: paymentCommand.method,
          customerId: context.customerId,
          tableSessionId: context.tableSessionId,
        }),
      })
      const completedCart = await repository.completeCheckout(cart, {
        orderId: orderOutcome.result.order.id,
        expectedVersion: input.expectedVersion,
        operationId: idempotencyKey,
        actorSessionRef: context.actorRef,
        nextCartPublicId: createSharedCartPublicId(),
      })
      return combineSharedCartCheckoutOutcomes(completedCart, orderOutcome, paymentOutcome, context)
    })
    const providerAction = await createGuestProviderAction(
        options, context, execution.value.payment, execution.value.order.order.publicId, request.ip,
    )
    const response = checkoutResponse(
      { value: execution.value.order, replayed: execution.replayed },
      { value: execution.value.payment, replayed: execution.replayed },
      paymentMode,
      providerAction,
    )
    return reply.code(execution.replayed ? 200 : 201).send({
      ...response,
      data: { ...response.data, sharedCart: publicSharedCart(execution.value.cart) },
    })
  }))

  app.post<{ Params: { orderPublicId: string } }>(
    '/guest/orders/:orderPublicId/payment',
    async (request, reply) => handleRoute(reply, async () => {
      const context = await requireTableContext(options, request, 'guest.order.create')
      const paymentMode = await effectivePaymentMode(options, context.scope)
      assertGuestSelfPaymentMode(paymentMode)
      options.onlinePayments.assertAvailable(paymentMode === 'simulation' ? 'simulation' : 'postar')
      const orderPublicId = readPublicId(request.params.orderPublicId, 'orderPublicId')
      const resolved = await options.transactions.run(context.scope, async (transaction) => (
        new PaymentProviderActionRepository(transaction, options.paymentActionSecret)
          .resolveOrderForGuest(orderPublicId, guestPaymentPrincipal(context))
      ))
      let payment: CommandExecution<Payment>
      if (resolved.activePaymentId === null) {
        const method = await options.onlinePayments.assertGuestJsapiReady(context.scope, context.customerId)
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
        if (value.provider !== 'simulation' && value.method !== 'jsapi') {
          throw new OnlinePaymentUnavailableError(
            '这笔订单的微信付款无法在小程序中打开，请刷新微信身份或呼叫员工协助核对',
          )
        }
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

class GuestCartProtocolVersionError extends Error {
  constructor(expectedVersion: 1 | 2) {
    super(expectedVersion === 2
      ? '本桌正在完成旧版点单，请在结台后更新小程序再继续点单'
      : '当前桌次已升级为共享购物车，请更新小程序后继续点单')
    this.name = 'GuestCartProtocolVersionError'
  }
}

async function requireGuestCartProtocol(
  transaction: ScopedTransaction,
  tableSessionId: string,
  expectedVersion: 1 | 2,
): Promise<void> {
  const result = await transaction.query<{ id: string }>(`
    SELECT id
    FROM mbox.table_sessions
    WHERE tenant_id=$1::uuid
      AND store_id=$2::uuid
      AND id=$3::uuid
      AND status='open'
      AND guest_cart_protocol_version=$4::smallint
    FOR KEY SHARE
  `, [transaction.scope.tenantId, transaction.scope.storeId, tableSessionId, expectedVersion])
  if (result.rows[0] === undefined) throw new GuestCartProtocolVersionError(expectedVersion)
}

async function searchGuestCatalog(
  transaction: ScopedTransaction,
  tableSessionId: string | null,
  query: Readonly<{ search: string; categoryCode: string | null; limit: number; offset: number }>,
): Promise<CatalogMenuRow[]> {
  const searchPattern = `%${escapeLike(query.search)}%`
  const result = await transaction.query<CatalogMenuRow>(`
    SELECT product.id, product.code, product.name, product.category_code,
      menu_category.display_name AS category_name,
      menu_category.parent_code AS category_parent_code,
      parent_menu_category.display_name AS category_parent_name,
      menu_category.sort_order AS category_sort_order,
      COALESCE(parent_menu_category.sort_order,menu_category.sort_order) AS top_category_sort_order,
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
      COALESCE(current_session.guest_count, 2) AS guest_count,
      COALESCE(current_session.guest_profile_snapshot, '{}'::jsonb) AS guest_profile_snapshot,
      COALESCE(inventory_readiness.configuration_complete, false) AS inventory_configuration_complete,
      COALESCE(inventory_stock.available, false) AS inventory_available
    FROM mbox.products AS product
    LEFT JOIN mbox.table_sessions AS current_session
      ON current_session.tenant_id = product.tenant_id
      AND current_session.store_id = product.store_id
      AND current_session.id = $3::uuid
      AND current_session.status = 'open'
    JOIN mbox.stores AS store
      ON store.tenant_id=product.tenant_id AND store.id=product.store_id AND store.status='active'
    LEFT JOIN mbox.menu_categories AS menu_category
      ON menu_category.tenant_id=product.tenant_id
     AND menu_category.store_id=product.store_id
     AND menu_category.code=product.category_code
    LEFT JOIN mbox.menu_categories AS parent_menu_category
      ON parent_menu_category.tenant_id=menu_category.tenant_id
     AND parent_menu_category.store_id=menu_category.store_id
     AND parent_menu_category.code=menu_category.parent_code
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
    LEFT JOIN LATERAL (
      SELECT COALESCE(bool_and(
        required_product.inventory_control_mode = 'not_managed'
        OR required_product.fulfillment_station NOT IN ('bar', 'kitchen')
        OR EXISTS (
          SELECT 1
          FROM mbox.recipes AS recipe
          WHERE recipe.tenant_id=product.tenant_id AND recipe.store_id=product.store_id
            AND recipe.product_id=required_product.product_id
            AND recipe.status='active' AND recipe.effective_at<=statement_timestamp()
            AND EXISTS (
              SELECT 1 FROM mbox.recipe_items AS recipe_item
              WHERE recipe_item.tenant_id=recipe.tenant_id AND recipe_item.store_id=recipe.store_id
                AND recipe_item.recipe_id=recipe.id
            )
            AND NOT EXISTS (
              SELECT 1
              FROM mbox.recipe_items AS recipe_item
              LEFT JOIN mbox.inventory_items AS inventory_item
                ON inventory_item.tenant_id=recipe_item.tenant_id
               AND inventory_item.store_id=recipe_item.store_id
               AND inventory_item.id=recipe_item.inventory_item_id
              LEFT JOIN mbox.inventory_balances AS balance
                ON balance.tenant_id=recipe_item.tenant_id
               AND balance.store_id=recipe_item.store_id
               AND balance.inventory_item_id=recipe_item.inventory_item_id
              WHERE recipe_item.tenant_id=recipe.tenant_id AND recipe_item.store_id=recipe.store_id
                AND recipe_item.recipe_id=recipe.id
                AND (inventory_item.id IS NULL OR inventory_item.status<>'active' OR balance.id IS NULL)
            )
        )
      ), true) AS configuration_complete
      FROM (
        SELECT product.id AS product_id, product.fulfillment_station, product.inventory_control_mode
        WHERE COALESCE(product.product_kind, 'single')<>'bundle'
        UNION ALL
        SELECT component_product.id, component_product.fulfillment_station, component_product.inventory_control_mode
        FROM mbox.product_bundle_components AS component
        JOIN mbox.products AS component_product
          ON component_product.tenant_id=component.tenant_id
         AND component_product.store_id=component.store_id
         AND component_product.id=component.component_product_id
        WHERE component.tenant_id=product.tenant_id AND component.store_id=product.store_id
          AND component.bundle_product_id=product.id
          AND COALESCE(product.product_kind, 'single')='bundle'
      ) AS required_product
    ) AS inventory_readiness ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(bool_and(
        required_product.inventory_control_mode='not_managed'
        OR required_product.fulfillment_station NOT IN ('bar','kitchen')
        OR EXISTS (
          SELECT 1 FROM mbox.recipes recipe
          WHERE recipe.tenant_id=product.tenant_id AND recipe.store_id=product.store_id
            AND recipe.product_id=required_product.product_id
            AND recipe.status='active' AND recipe.effective_at<=statement_timestamp()
            AND EXISTS (
              SELECT 1 FROM mbox.recipe_items recipe_item
              WHERE recipe_item.tenant_id=recipe.tenant_id AND recipe_item.store_id=recipe.store_id
                AND recipe_item.recipe_id=recipe.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM mbox.recipe_items recipe_item
              LEFT JOIN mbox.inventory_items inventory_item
                ON inventory_item.tenant_id=recipe_item.tenant_id
               AND inventory_item.store_id=recipe_item.store_id
               AND inventory_item.id=recipe_item.inventory_item_id
              LEFT JOIN mbox.inventory_balances balance
                ON balance.tenant_id=recipe_item.tenant_id AND balance.store_id=recipe_item.store_id
               AND balance.inventory_item_id=recipe_item.inventory_item_id
              WHERE recipe_item.tenant_id=recipe.tenant_id AND recipe_item.store_id=recipe.store_id
                AND recipe_item.recipe_id=recipe.id
                AND (inventory_item.id IS NULL OR inventory_item.status<>'active' OR balance.id IS NULL
                  OR balance.on_hand_quantity-balance.reserved_quantity
                    < recipe_item.quantity*required_product.multiplier)
            )
        )
      ),true) AS available
      FROM (
        SELECT product.id AS product_id,product.fulfillment_station,product.inventory_control_mode,
          1::numeric AS multiplier
        WHERE COALESCE(product.product_kind,'single')<>'bundle'
        UNION ALL
        SELECT component_product.id,component_product.fulfillment_station,
          component_product.inventory_control_mode,component.quantity::numeric
        FROM mbox.product_bundle_components component
        JOIN mbox.products component_product
          ON component_product.tenant_id=component.tenant_id
         AND component_product.store_id=component.store_id
         AND component_product.id=component.component_product_id
        WHERE component.tenant_id=product.tenant_id AND component.store_id=product.store_id
          AND component.bundle_product_id=product.id
          AND COALESCE(product.product_kind,'single')='bundle'
      ) required_product
    ) AS inventory_stock ON true
    WHERE product.tenant_id = $1::uuid
      AND product.store_id = $2::uuid
      AND ($3::uuid IS NULL OR current_session.id IS NOT NULL)
      AND product.status = 'active'
      AND product.guest_visible
      -- Unconfigured legacy codes stay visible until staff explicitly map
      -- them.  Once configured, parent and child visibility is authoritative
      -- for the customer menu without altering the product itself.
      AND (menu_category.id IS NULL OR (
        menu_category.guest_visible
        AND (parent_menu_category.id IS NULL OR parent_menu_category.guest_visible)
      ))
      AND 'guest_qr'=ANY(product.allowed_channels)
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
        AND product.recommendation_min_guests <= COALESCE(current_session.guest_count, 2)
        AND product.recommendation_max_guests >= COALESCE(current_session.guest_count, 2)
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
  const availabilityStatus = publicCatalogAvailabilityStatus(row)
  const configuredCategoryName = publicString(row.category_name)
  const categoryName = configuredCategoryName
    ?? publicCatalogCategoryFallbackName(row.category_code, row.product_snapshot, source)
  const unconfiguredCategory = configuredCategoryName === null
  return {
    productId: row.id,
    code: row.code,
    name: row.name,
    categoryCode: row.category_code,
    // The editable catalog hierarchy is the primary display source.  A
    // legacy snapshot is only a compatibility fallback; never show a raw
    // operational category code such as "cocktail" to a customer.
    categoryName,
    // A current product import can briefly contain an unknown operational
    // code.  Keep it in one safe "其他" top-level bucket until staff maps it;
    // never turn the code itself into a customer-facing label.
    categoryParentCode: unconfiguredCategory ? 'other' : row.category_parent_code,
    categoryParentName: unconfiguredCategory ? '其他' : publicString(row.category_parent_name),
    categorySortOrder: row.category_sort_order === null ? 9000 : Number(row.category_sort_order),
    topCategorySortOrder: row.top_category_sort_order === null
      ? (row.category_sort_order === null ? 9000 : Number(row.category_sort_order))
      : Number(row.top_category_sort_order),
    beverageFamily: publicBeverageFamily(row.recommendation_beverage_family),
    specification: publicString(row.product_snapshot.specification)
      ?? publicString(source.specification),
    aliases: publicStringArray(row.product_snapshot.aliases ?? source.aliases),
    tags: publicStringArray(row.product_snapshot.tags ?? source.tags),
    imageUrl: publicMiniProgramImageUrl(publicString(row.product_snapshot.imageUrl))
      ?? publicMiniProgramImageUrl(publicString(source.imageUrl)),
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
    availabilityStatus,
    available: availabilityStatus === 'available',
  }
}

function publicCatalogCategoryFallbackName(
  categoryCode: string,
  snapshot: JsonObject,
  source: JsonObject,
): string {
  const normalizedCode = categoryCode.trim().toLowerCase()
  for (const candidate of [snapshot.categoryName, source.categoryName]) {
    const name = publicString(candidate)
    if (name !== null && name.trim().toLowerCase() !== normalizedCode) return name
  }
  return '其他'
}

function publicCatalogAvailabilityStatus(row: CatalogMenuRow): 'available' | 'configuration_incomplete' | 'inventory_unavailable' | 'scheduled' | 'unavailable' {
  // Keep the public menu's status order aligned with assisted ordering: a missing
  // recipe/configuration takes precedence over a time-window label, then stock.
  if (row.status !== 'active' || row.amount_minor === null) return 'unavailable'
  if (!row.inventory_configuration_complete) return 'configuration_incomplete'
  if (!row.inventory_available) return 'inventory_unavailable'
  if (row.within_availability === false) return 'scheduled'
  return 'available'
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
  paymentMethod: GuestCheckoutPaymentMethod,
): Promise<CommandExecution<Payment>> {
  return options.payments.initiate(await guestPaymentCommand(
    context, orderIdempotencyKey, createPublicId, paymentMode, paymentMethod, commerce.order.id,
  ))
}

type GuestCheckoutPaymentMethod = Extract<Payment['method'], 'jsapi' | 'native_qr'>

async function guestCheckoutPaymentMethod(
  options: GuestCommerceServiceApiOptions,
  context: GuestRequestContext & { tableSessionId: string; businessDate: string },
  paymentMode: GuestCheckoutPaymentMode,
): Promise<GuestCheckoutPaymentMethod> {
  return paymentMode === 'simulation'
    ? 'native_qr'
    : options.onlinePayments.assertGuestJsapiReady(context.scope, context.customerId)
}

async function guestPaymentCommand(
  context: GuestRequestContext & { tableSessionId: string; businessDate: string },
  orderIdempotencyKey: string,
  createPublicId: NonNullable<GuestCommerceServiceApiOptions['createPublicId']>,
  paymentMode: GuestCheckoutPaymentMode,
  method: GuestCheckoutPaymentMethod,
  orderId = 'shared-cart-order-pending',
): Promise<InitiatePaymentCommand> {
  // WeChat is the customer-facing channel; Postar is the acquiring provider
  // whose order and callback identities must match the persisted payment.
  const provider = paymentMode === 'simulation' ? 'simulation' : 'postar'
  const idempotencyKey = `guest-pay-${createHash('sha256').update(orderIdempotencyKey).digest('hex').slice(0, 48)}`
  const publicId = createPublicId('payment', `${context.scope.storeId}:${idempotencyKey}`)
  return {
    scope: context.scope,
    actor: guestActor(context),
    businessDate: context.businessDate,
    idempotencyKey,
    requestFingerprint: stableJson({
      orderId,
      publicId,
      provider,
      method,
      customerId: context.customerId,
      tableSessionId: context.tableSessionId,
    }),
    orderId,
    publicId,
    provider,
    method,
    principal: guestPaymentPrincipal(context),
    providerSnapshot: { source: 'guest_checkout', configuredMode: paymentMode },
  }
}

function assertGuestSelfPaymentMode(mode: GuestCheckoutPaymentMode): void {
  if (mode === 'wechat_native_qr') {
    throw new GuestApiRequestError(
      'GUEST_CHECKOUT_CONFIGURATION_UNAVAILABLE',
      '顾客小程序支付配置异常；本次没有创建订单，请联系服务员',
      503,
    )
  }
}

interface SharedCartCheckoutResult {
  cart: GuestSharedCart
  order: SubmittedCommerceResult
  payment: Payment
}

const sharedCartCheckoutCodec: JsonCodec<SharedCartCheckoutResult> = {
  encode: (value) => JSON.parse(JSON.stringify(value)) as JsonObject,
  decode: (value) => {
    const record = jsonObject(value)
    if (!isRecord(value) || !isRecord(record.cart) || !isRecord(record.order) || !isRecord(record.payment)) {
      throw new TypeError('Stored shared cart checkout result is invalid')
    }
    return value as unknown as SharedCartCheckoutResult
  },
}

function combineSharedCartCheckoutOutcomes(
  transition: GuestSharedCartCheckoutTransition,
  order: CommandOutcome<SubmittedCommerceResult>,
  payment: CommandOutcome<Payment>,
  context: GuestRequestContext & { businessDate: string },
): CommandOutcome<SharedCartCheckoutResult> {
  const cart=transition.submittedCart
  const cartSnapshot = publicSharedCart(cart) as JsonObject
  return {
    result: { cart:transition.nextCart, order: order.result, payment: payment.result },
    auditEvents: [
      ...order.auditEvents,
      ...payment.auditEvents,
      {
        actor: guestActor(context), action: 'guest.shared_cart.submitted', objectType: 'guest_shared_cart',
        objectId: cart.id, businessDate: context.businessDate, afterData: {
          ...cartSnapshot, orderId: order.result.order.id, orderPublicId: order.result.order.publicId,
        },
      },
    ],
    outboxMessages: [
      ...order.outboxMessages,
      ...payment.outboxMessages,
      {
        aggregateType: 'guest_shared_cart', aggregateId: cart.id, aggregateVersion: cart.version,
        eventType: 'guest.shared_cart.submitted.v1',
        payload: { ...cartSnapshot, orderPublicId: order.result.order.publicId },
      },
    ],
  }
}

async function recordSharedCartWriteAttempt(
  options:GuestCommerceServiceApiOptions,
  context:GuestRequestContext&{tableSessionId:string;businessDate:string},
  operationId:string,
  action:'adjust'|'remove'|'clear'|'checkout',
):Promise<void>{
  const allowed=await options.transactions.run(context.scope,async transaction=>{
    if(!await lockBoundGuestTablePosition(transaction,context))throw new GuestAuthenticationRequiredError()
    await requireGuestCartProtocol(transaction,context.tableSessionId,2)
    return new GuestSharedCartRepository(transaction).recordWriteAttempt({
      tableSessionId:context.tableSessionId,
      actorSessionRef:context.actorRef,
      operationId,
      action,
    })
  })
  if(!allowed)throw new GuestSharedCartRateLimitedError()
}

function publicSharedCart(cart: GuestSharedCart) {
  const guestMayWrite = cart.status === 'open' && !cart.guestWritesFrozen
  const hasLines = cart.lines.length > 0
  const mayCheckout = guestMayWrite
    && hasLines
    && cart.totalAmountMinor !== null
    && cart.lines.every((line) => line.available)
  return {
    cartPublicId: cart.publicId,
    generation: cart.generation,
    version: cart.version,
    status: cart.status,
    guestWritesFrozen: cart.guestWritesFrozen,
    lines: cart.lines.map((line) => ({
      productId: line.productId,
      quantity: line.quantity,
      name: line.name,
      unitPriceMinor: line.unitPriceMinor,
      subtotalAmountMinor: line.subtotalAmountMinor,
      currency: line.currency,
      available: line.available,
      unavailableReason: line.unavailableReason,
    })),
    totalAmountMinor: cart.totalAmountMinor,
    currency: cart.currency,
    updatedAt: cart.updatedAt,
    allowedActions: guestMayWrite ? [
      'adjust',
      ...(hasLines ? ['remove', 'clear'] : []),
      ...(mayCheckout ? ['checkout'] : []),
    ] : [],
  }
}

function createSharedCartPublicId(): string {
  const token = randomUUID().replace(/-/g, '').toUpperCase()
  return `GSC${token}`
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
  if (payment.provider !== 'simulation' && payment.method !== 'jsapi') {
    throw new OnlinePaymentUnavailableError(
      '顾客小程序仅支持微信内支付；收银二维码请由员工在收银设备上发起',
    )
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

function readSharedCartAdjustment(value: unknown): {
  productId: string
  delta: number
  expectedGeneration: number
  expectedVersion: number
} {
  const body = readStrictObject(value, '共享购物车请求', [
    'productId', 'delta', 'expectedGeneration', 'expectedVersion',
  ])
  return {
    productId: readUuid(body.productId, 'productId'),
    delta: readInteger(body.delta, 'delta', -99, 99),
    expectedGeneration: readInteger(body.expectedGeneration, 'expectedGeneration', 1, 2_147_483_647),
    expectedVersion: readInteger(body.expectedVersion, 'expectedVersion', 0, 2_147_483_647),
  }
}

function readSharedCartClear(value: unknown): {
  expectedGeneration: number
  expectedVersion: number
} {
  const body = readStrictObject(value, '清空共享购物车请求', ['expectedGeneration', 'expectedVersion'])
  return {
    expectedGeneration: readInteger(body.expectedGeneration, 'expectedGeneration', 1, 2_147_483_647),
    expectedVersion: readInteger(body.expectedVersion, 'expectedVersion', 0, 2_147_483_647),
  }
}

function readSharedCartCheckout(value: unknown): {
  expectedGeneration: number
  expectedVersion: number
  note: string | null
  confirmedDuplicateOrderId: string | null
  checkoutUpgradeOfferPublicId: string | null
  recommendationPublicId: string | null
  selectedRecommendationProductId: string | null
} {
  const body = readStrictObject(value, '共享购物车结账请求', [
    'expectedGeneration', 'expectedVersion', 'note', 'confirmedDuplicateOrderId', 'checkoutUpgradeOfferPublicId',
    'recommendationPublicId', 'selectedRecommendationProductId',
  ])
  const confirmedDuplicateOrderId = readOptionalString(
    body.confirmedDuplicateOrderId, 'confirmedDuplicateOrderId', 128,
  )
  if (confirmedDuplicateOrderId !== null && confirmedDuplicateOrderId.length < 8) {
    throw new GuestApiRequestError('DUPLICATE_CONFIRMATION_INVALID', '重复订单确认信息无效')
  }
  const checkoutUpgradeOfferPublicId = readOptionalString(
    body.checkoutUpgradeOfferPublicId, 'checkoutUpgradeOfferPublicId', 128,
  )
  if (checkoutUpgradeOfferPublicId !== null && checkoutUpgradeOfferPublicId.length < 8) {
    throw new GuestApiRequestError('CHECKOUT_UPGRADE_INVALID', '付款前升级编号无效')
  }
  const recommendationPublicId = readOptionalString(
    body.recommendationPublicId, 'recommendationPublicId', 128,
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
      'RECOMMENDATION_ATTRIBUTION_INVALID', '推荐编号和所选推荐商品必须同时提供',
    )
  }
  return {
    expectedGeneration: readInteger(body.expectedGeneration, 'expectedGeneration', 1, 2_147_483_647),
    expectedVersion: readInteger(body.expectedVersion, 'expectedVersion', 0, 2_147_483_647),
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
    activityRegistrationCycle: null,
    publicId: value.publicId,
    provider: value.provider,
    providerTransactionId: value.providerTransactionId,
    settlementChannel: null,
    method: value.method,
    amountMinor: value.amountMinor,
    currency: value.currency,
    status: value.status as Payment['status'],
    providerSnapshot: {},
    retryReleasedAt: null,
    retryReleaseReason: null,
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
    if (error instanceof GuestAuthenticationRequiredError
      || error instanceof GuestDeviceBindingError
      || error instanceof ReservationGuestSessionInvalidError
      || error instanceof GuestSessionInvalidError) {
      return reply.code(401).send({ error: { code: 'GUEST_SESSION_INVALID', message: error.message } })
    }
    if (error instanceof GuestStoreScopeError) {
      return reply.code(403).send({ error: { code: 'STORE_ACCESS_FORBIDDEN', message: error.message } })
    }
    if (error instanceof GuestOrderPaymentAccessError) {
      if (error.reason === 'guest_not_at_current_table') {
        return reply.code(401).send({ error: { code: 'GUEST_SESSION_INVALID', message: error.message } })
      }
      return reply.code(409).send({ error: { code: 'GUEST_ORDER_ACCESS_FORBIDDEN', message: error.message } })
    }
    if (error instanceof GuestCapabilityDeniedError) {
      return reply.code(403).send({ error: { code: 'GUEST_CAPABILITY_DENIED', message: '当前入口不能执行这项操作' } })
    }
    if (error instanceof GuestBehaviorSessionUnavailableError
      || error instanceof GuestServiceSessionUnavailableError
      || error instanceof TableSessionUnavailableForOrderError
      || error instanceof GuestTableSessionEndedError
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
    if (error instanceof GuestCartProtocolVersionError) {
      return reply.code(409).send({ error: { code: 'CART_PROTOCOL_UPGRADE_REQUIRED', message: error.message } })
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
    if (error instanceof GuestSharedCartVersionConflictError) {
      return reply.code(409).send({ error: {
        code: 'SHARED_CART_VERSION_CONFLICT',
        message: error.message,
        ...(error.latestCart === null ? {} : { details: { latestSharedCart: publicSharedCart(error.latestCart) } }),
      } })
    }
    if (error instanceof GuestSharedCartEmptyError) {
      return reply.code(409).send({ error: { code: 'SHARED_CART_EMPTY', message: error.message } })
    }
    if (error instanceof GuestSharedCartOperationConflictError) {
      return reply.code(409).send({ error: { code: 'SHARED_CART_OPERATION_CONFLICT', message: error.message } })
    }
    if (error instanceof GuestSharedCartLimitError) {
      return reply.code(409).send({ error: { code: 'SHARED_CART_LIMIT_EXCEEDED', message: error.message } })
    }
    if (error instanceof GuestSharedCartRateLimitedError) {
      return reply.code(429).send({ error: { code: 'SHARED_CART_RATE_LIMITED', message: error.message } })
    }
    if (error instanceof GuestSharedCartFrozenError) {
      return reply.code(423).send({ error: { code: 'SHARED_CART_WRITES_FROZEN', message: error.message } })
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

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
