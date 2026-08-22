import type {
  AuditActor,
  CommandExecution,
  JsonCodec,
  JsonObject,
} from './command-executor.js'
import { appendOutboxMessage, type NormalizedCommandExecutor, type OutboxMessage } from './command-executor.js'
import type { ScopedTransaction, StoreScope } from './transaction-runner.js'
import {
  AssistedOrderContextDeniedError,
  AssistedOrderContextRepository,
  hashAssistedOrderContextToken,
  type AssistedOrderContext,
  type AssistedOrderContextProof,
} from './assisted-order-context.js'
import { InventoryRepository, type InventoryConsumption } from './inventory-repository.js'
import {
  GuestOrderSafetyRepository,
  type GuestOrderSafetyPolicy,
} from './guest-order-safety.js'
import { KDS_PRIORITY_OVERRIDE_CAPABILITY } from './kds-authorization-policy.js'
import { KdsRepository, type KdsTask } from './kds-repository.js'
import {
  PaymentFulfillmentRepository,
  buildFulfillmentPlan,
} from './payment-fulfillment-repository.js'
import {
  OrderRepository,
  type CreateSubmittedOrderInput,
  type SubmittedOrder,
} from './order-repository.js'
import {
  PricingAuthorizationPolicy,
  type PricingAuthorizationRequest,
  type PricingAuthorityPort,
  type VerifiedPricingAuthorization,
} from './pricing-authorization-policy.js'
import { StaffAccessRepository } from './staff-access-repository.js'
import {
  CustomerExperienceRepository,
  CustomerExperienceRequestError,
  type SelectedCheckoutUpgrade,
} from './customer-experience-repository.js'
import { ExperiencePlanActivationRepository } from './experience-plan-activation-repository.js'
import { lockBoundGuestTablePosition } from './guest-table-authority.js'
import { PrintTicketSourceRepository } from './print-ticket-source.js'

export interface KdsSchedulingOverride {
  priority?: number
  dueAt?: string | null
  reason: string
}

export interface RecommendationOrderAttribution {
  recommendationPublicId: string
  selectedProductId: string
  experiencePlanState?: 'active' | 'planned' | 'failed'
}

export interface SubmitOrderCommand extends Omit<CreateSubmittedOrderInput, 'tableSessionId'> {
  scope: Readonly<StoreScope>
  actor: AuditActor
  businessDate: string
  idempotencyKey: string
  tableSessionId?: string
  assistedOrderContext?: Readonly<AssistedOrderContextProof>
  kdsOverride?: Readonly<KdsSchedulingOverride>
  pricingAuthorization?: Readonly<PricingAuthorizationRequest>
  confirmedDuplicateOrderPublicId?: string | null
  checkoutUpgradeOfferPublicId?: string | null
  recommendationAttribution?: Readonly<RecommendationOrderAttribution> | null
}

export interface PaymentNextStep {
  status: 'required' | 'deferred'
  action: 'create_payment_intent' | 'settle_table_later'
  orderId: string
  amountMinor: number
  currency: string
  paymentStatus: 'unpaid'
}

export interface SubmittedCommerceResult {
  order: SubmittedOrder
  kdsTasks: readonly KdsTask[]
  inventoryConsumptions: readonly InventoryConsumption[]
  paymentNextStep: PaymentNextStep
}

export interface CommerceCommandServiceOptions {
  inventoryEnforcementMode?: 'strict' | 'audit_only'
  guestOrderSafetyPolicy?: Readonly<GuestOrderSafetyPolicy>
  printTicketSources?: boolean
}

export class GuestTablePositionChangedError extends Error {
  constructor() {
    super('顾客已不在当前桌次位置，请重新扫描所在桌二维码')
    this.name = 'GuestTablePositionChangedError'
  }
}

export class CommerceCommandService {
  private readonly pricingPolicy: PricingAuthorizationPolicy | null

  constructor(
    private readonly commands: Pick<NormalizedCommandExecutor, 'execute'>,
    pricingAuthority?: PricingAuthorityPort,
    private readonly options: Readonly<CommerceCommandServiceOptions> = {},
  ) {
    this.pricingPolicy = pricingAuthority ? new PricingAuthorizationPolicy(pricingAuthority) : null
  }

  async submitOrder(input: Readonly<SubmitOrderCommand>): Promise<CommandExecution<SubmittedCommerceResult>> {
    validateCommand(input)
    return this.commands.execute({
      scope: input.scope,
      operationScope: 'commerce.order.submit',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: canonicalSubmitFingerprint(input),
      resultCodec: submittedCommerceCodec,
    }, async (transaction) => {
      const context = await resolveAuthoritativeTableContext(transaction, input)
      if (input.channel === 'guest_qr') {
        const lockedSession=await transaction.query<{ id:string }>(`
          SELECT id FROM mbox.table_sessions
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='open'
          FOR UPDATE
        `,[transaction.scope.tenantId,transaction.scope.storeId,context.tableSessionId])
        if (!lockedSession.rows[0]) throw new GuestTablePositionChangedError()
        const allowed=await lockBoundGuestTablePosition(transaction,{
          tableSessionId:context.tableSessionId,
          customerId:input.createdByCustomerId!,
          actorRef:input.actor.ref,
        })
        if (!allowed) throw new GuestTablePositionChangedError()
      }
      const selectedUpgrade = await selectCheckoutUpgrade(transaction, input, context.tableSessionId)
      const effectiveLines = selectedUpgrade?.upgradedItems ?? input.lines
      const orderInput: CreateSubmittedOrderInput = {
        tableSessionId: context.tableSessionId,
        publicId: input.publicId,
        channel: input.channel,
        settlementMode: input.settlementMode ?? 'table_tab',
        lines: effectiveLines,
        note: input.note,
        createdByEmployeeId: input.createdByEmployeeId,
        createdByCustomerId: input.createdByCustomerId,
      }
      const pricingAuthorization = await this.authorizePricing(transaction, orderInput, input)
      if (input.channel === 'guest_qr') {
        await new GuestOrderSafetyRepository(transaction, this.options.guestOrderSafetyPolicy).assertAllowed({
          tableSessionId: context.tableSessionId,
          customerId: input.createdByCustomerId!,
          lines: effectiveLines,
          confirmedDuplicateOrderPublicId: input.confirmedDuplicateOrderPublicId,
        })
      }
      const schedulingOverride = await authorizeKdsOverride(transaction, input)
      const order = await new OrderRepository(transaction).createSubmitted(orderInput, pricingAuthorization)
      if (pricingAuthorization) await this.pricingPolicy!.consume(transaction, pricingAuthorization, order.id)

      const inventoryEnforcementMode = this.options.inventoryEnforcementMode ?? 'strict'
      const fulfillmentPlan = buildFulfillmentPlan(order.items, schedulingOverride)
      const inventoryReservations = await new PaymentFulfillmentRepository(transaction).prepareSubmittedOrder(
        order,
        {
          ...fulfillmentPlan,
          overrideReason: schedulingOverride?.reason ?? null,
          allowMissingRecipes: inventoryEnforcementMode === 'audit_only',
        },
      )
      const inventoryMetadata = {
        orderId: order.id,
        orderPublicId: order.publicId,
        pricingAuthorizationId: pricingAuthorization?.authorizationId ?? null,
        assistedOrderContextId: context.assistedContextId,
      }
      const inventoryConsumptions = order.settlementMode === 'immediate_payment'
        ? []
        : await new InventoryRepository(transaction).consumeForOrderItems(order.items, {
            createdByEmployeeId: input.createdByEmployeeId ?? null,
            reason: 'order submitted for deferred settlement',
            metadata: inventoryMetadata,
            allowMissingRecipes: inventoryEnforcementMode === 'audit_only',
          })
      const inventoryEvidenceOrderItemIds = new Set([
        ...inventoryReservations.map((item) => item.orderItemId),
        ...inventoryConsumptions.map((item) => item.orderItemId),
      ])
      const unconfiguredInventoryOrderItemIds = order.items
        .filter((item) => (item.fulfillmentStation === 'bar' || item.fulfillmentStation === 'kitchen')
          && !inventoryEvidenceOrderItemIds.has(item.id))
        .map((item) => item.id)
      const inventoryControl = {
        enforcementMode: inventoryEnforcementMode,
        configurationComplete: unconfiguredInventoryOrderItemIds.length === 0,
        unconfiguredOrderItemIds: unconfiguredInventoryOrderItemIds,
        reservationCount: inventoryReservations.length,
      } as const
      const kdsTasks = order.settlementMode === 'immediate_payment'
        ? []
        : await createServerScheduledKdsTasks(transaction, order, fulfillmentPlan)
      if (selectedUpgrade !== null) {
        assertCheckoutUpgradeOrder(order, selectedUpgrade)
        await new CustomerExperienceRepository(transaction).markCheckoutUpgradeConverted({
          offerId: selectedUpgrade.offerId,
          orderId: order.id,
          targetProductId: selectedUpgrade.targetProductId,
          targetAmountMinor: selectedUpgrade.targetAmountMinor,
          currency: selectedUpgrade.currency,
        })
      }
      const orderedRecommendation = await recordOrderedRecommendation(
        transaction,
        input,
        context.tableSessionId,
        order,
      )
      const result: SubmittedCommerceResult = {
        order,
        kdsTasks,
        inventoryConsumptions,
        paymentNextStep: paymentNextStep(order),
      }
      const outboxMessage: OutboxMessage = {
        aggregateType: 'order',
        aggregateId: order.id,
        aggregateVersion: 1,
        eventType: 'order.submitted.v1',
        payload: orderOutboxPayload(
          result, pricingAuthorization, context, schedulingOverride, inventoryControl, selectedUpgrade?.offerId ?? null,
          orderedRecommendation,
        ),
      }
      const productionSourceMaterialized = this.options.printTicketSources === true && result.kdsTasks.length > 0
      if (productionSourceMaterialized) {
        const sourceOutboxMessageId = await appendOutboxMessage(transaction, outboxMessage)
        await new PrintTicketSourceRepository(transaction).materializeOrderProduction(sourceOutboxMessageId, order.id)
      }
      return {
        result,
        auditEvents: [{
          actor: input.actor,
          action: 'order.submitted',
          objectType: 'order',
          objectId: order.id,
          businessDate: input.businessDate,
          afterData: orderAuditSnapshot(
            result, pricingAuthorization, context, schedulingOverride, inventoryControl, selectedUpgrade?.offerId ?? null,
            orderedRecommendation,
          ),
        }],
        outboxMessages: productionSourceMaterialized ? [] : [outboxMessage],
      }
    })
  }

  private authorizePricing(
    transaction: ScopedTransaction,
    orderInput: Readonly<CreateSubmittedOrderInput>,
    input: Readonly<SubmitOrderCommand>,
  ): Promise<Readonly<VerifiedPricingAuthorization> | undefined> {
    if (!input.pricingAuthorization) return Promise.resolve(undefined)
    if (!this.pricingPolicy) throw new TypeError('A pricing authority is required for discounts and gifts')
    return this.pricingPolicy.authorize(transaction, {
      scope: input.scope,
      actor: input.actor,
      tableSessionId: orderInput.tableSessionId,
      channel: input.channel,
      lines: input.lines,
    }, input.pricingAuthorization)
  }
}

async function recordOrderedRecommendation(
  transaction: ScopedTransaction,
  input: Readonly<SubmitOrderCommand>,
  tableSessionId: string,
  order: Readonly<SubmittedOrder>,
): Promise<Readonly<RecommendationOrderAttribution> | null> {
  const attribution = input.recommendationAttribution ?? null
  if (attribution === null) return null
  if (input.channel !== 'guest_qr' || !input.createdByCustomerId || input.actor.type !== 'guest') {
    throw new TypeError('Recommendation attribution requires an authenticated guest order')
  }
  const normalized = {
    recommendationPublicId: attribution.recommendationPublicId.trim(),
    selectedProductId: attribution.selectedProductId.trim(),
  }
  const reference = await new CustomerExperienceRepository(transaction).recordRecommendationOrdered({
    recommendationPublicId: normalized.recommendationPublicId,
    selectedProductId: normalized.selectedProductId,
    customerId: input.createdByCustomerId,
    tableSessionId,
    businessDate: input.businessDate,
    orderId: order.id,
    orderPublicId: order.publicId,
    actorRef: input.actor.ref ?? 'guest-order',
  })
  const plan = await new ExperiencePlanActivationRepository(transaction).recordOrderedNonCritical({
    reference,
    orderId: order.id,
    actorRef: input.actor.ref ?? 'guest-order',
  })
  return { ...normalized, experiencePlanState: plan.state === 'active' || plan.state === 'planned' ? plan.state : 'failed' }
}

async function selectCheckoutUpgrade(
  transaction: ScopedTransaction,
  input: Readonly<SubmitOrderCommand>,
  tableSessionId: string,
): Promise<SelectedCheckoutUpgrade | null> {
  const publicId = input.checkoutUpgradeOfferPublicId?.trim() || null
  if (publicId === null) return null
  if (input.channel !== 'guest_qr' || !input.createdByCustomerId
    || (input.settlementMode ?? 'table_tab') !== 'immediate_payment') {
    throw new TypeError('Checkout upgrades require an authenticated guest immediate-payment order')
  }
  return new CustomerExperienceRepository(transaction).selectCheckoutUpgrade({
    customerId: input.createdByCustomerId,
    tableSessionId,
    businessDate: input.businessDate,
  }, publicId, input.lines)
}

function assertCheckoutUpgradeOrder(
  order: Readonly<SubmittedOrder>,
  selected: Readonly<SelectedCheckoutUpgrade>,
): void {
  const expected = selected.upgradedItems.map((line) => ({
    productId: line.productId,
    quantity: line.quantity,
    note: line.note?.trim() || null,
  })).toSorted(compareBasketLine)
  const actual = order.items
    .filter((item) => item.billable && item.parentOrderItemId === null)
    .map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
      note: item.note?.trim() || null,
    }))
    .toSorted(compareBasketLine)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new CustomerExperienceRequestError(
      '升级后的订单内容与顾客确认不一致，已取消本次下单',
      'CHECKOUT_UPGRADE_ORDER_MISMATCH',
      409,
    )
  }
}

function compareBasketLine(
  left: Readonly<{ productId: string; note: string | null }>,
  right: Readonly<{ productId: string; note: string | null }>,
): number {
  return left.productId.localeCompare(right.productId) || (left.note ?? '').localeCompare(right.note ?? '')
}

async function resolveAuthoritativeTableContext(
  transaction: ScopedTransaction,
  input: Readonly<SubmitOrderCommand>,
): Promise<{ tableSessionId: string; assistedContextId: string | null; tableCode: string | null }> {
  if (input.channel === 'staff_assisted') {
    if (!input.assistedOrderContext) {
      throw new AssistedOrderContextDeniedError('ASSISTED_CONTEXT_INVALID')
    }
    const context: AssistedOrderContext = await new AssistedOrderContextRepository(transaction)
      .requireForSubmit(input.assistedOrderContext)
    if (input.tableSessionId !== undefined && input.tableSessionId !== context.tableSessionId) {
      throw new AssistedOrderContextDeniedError('ASSISTED_CONTEXT_INVALID')
    }
    return {
      tableSessionId: context.tableSessionId,
      assistedContextId: context.id,
      tableCode: context.tableCode,
    }
  }
  if (!input.tableSessionId) throw new TypeError('tableSessionId is required for this order channel')
  return { tableSessionId: input.tableSessionId, assistedContextId: null, tableCode: null }
}

async function authorizeKdsOverride(
  transaction: ScopedTransaction,
  input: Readonly<SubmitOrderCommand>,
): Promise<Readonly<KdsSchedulingOverride> | undefined> {
  if (!input.kdsOverride) return undefined
  if (input.actor.type !== 'employee' || input.createdByEmployeeId !== input.actor.employeeId) {
    throw new TypeError('A KDS scheduling override requires an employee actor')
  }
  await new StaffAccessRepository(transaction)
    .assertPermission(input.actor.employeeId, KDS_PRIORITY_OVERRIDE_CAPABILITY)
  return input.kdsOverride
}

async function createServerScheduledKdsTasks(
  transaction: ScopedTransaction,
  order: SubmittedOrder,
  plan: Readonly<ReturnType<typeof buildFulfillmentPlan>>,
): Promise<KdsTask[]> {
  const repository = new KdsRepository(transaction)
  const tasks: KdsTask[] = []
  for (const item of order.items) {
    if (item.fulfillmentStation === 'none') continue
    const priority = plan.priorityByOrderItemId.get(item.id)
    const dueAt = plan.dueAtByOrderItemId.get(item.id)
    if (priority === undefined || dueAt === undefined) throw new Error(`Fulfillment plan is missing for ${item.id}`)
    tasks.push(normalizeKdsTaskDates(await repository.create({
      orderItemId: item.id,
      stationCode: item.fulfillmentStation,
      quantity: item.quantity,
      priority,
      dueAt,
      eventIdempotencyKey: `created:${item.id}:${item.fulfillmentStation}`,
    })))
  }
  return tasks
}

function normalizeKdsTaskDates(task: KdsTask): KdsTask {
  return {
    ...task,
    dueAt: timestampText(task.dueAt),
    nextActionAt: timestampText(task.nextActionAt)!,
    acceptedAt: timestampText(task.acceptedAt),
    readyAt: timestampText(task.readyAt),
    cancelledAt: timestampText(task.cancelledAt),
  }
}

function timestampText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

function paymentNextStep(order: SubmittedOrder): PaymentNextStep {
  return {
    status: order.settlementMode === 'immediate_payment' ? 'required' : 'deferred',
    action: order.settlementMode === 'immediate_payment'
      ? 'create_payment_intent'
      : 'settle_table_later',
    orderId: order.id,
    amountMinor: order.totalAmountMinor,
    currency: order.currency,
    paymentStatus: 'unpaid',
  }
}

const submittedCommerceCodec: JsonCodec<SubmittedCommerceResult> = {
  encode: submittedCommerceToJson,
  decode: (value) => {
    if (!jsonObjectOrNull(value)) throw new TypeError('Stored commerce result is invalid')
    const rawResult = value as Partial<SubmittedCommerceResult>
    const result = {
      ...rawResult,
      order: normalizeStoredOrderSubmissionCosts(rawResult.order),
    } as Partial<SubmittedCommerceResult>
    if (!isSubmittedOrder(result.order) || !Array.isArray(result.kdsTasks)
      || !Array.isArray(result.inventoryConsumptions) || !isPaymentNextStep(result.paymentNextStep)) {
      throw new TypeError('Stored commerce result is incomplete')
    }
    return result as SubmittedCommerceResult
  },
}

function normalizeStoredOrderSubmissionCosts(value: unknown): unknown {
  if (!jsonObjectOrNull(value) || !Array.isArray(value.items)) return value
  return {
    ...value,
    items: value.items.map((item) => {
      if (!jsonObjectOrNull(item)) return item
      const hasAnySubmissionCostField = [
        'unitCostMinorAtSubmission',
        'totalCostMinorAtSubmission',
        'costSource',
        'costReferenceProductId',
        'costReferenceOrderItemId',
        'costReferenceProductUpdatedAt',
      ].some((key) => Object.hasOwn(item, key))
      const withLoyalty = Object.hasOwn(item, 'loyaltyEligibleAtSubmission')
        && Object.hasOwn(item, 'loyaltyEligibilitySource')
        ? item
        : {
            ...item,
            // Old idempotency payloads are response compatibility only. They are
            // never used for accrual; the database order row remains authoritative.
            loyaltyEligibleAtSubmission: false,
            loyaltyEligibilitySource: 'legacy_current_catalog',
          }
      if (hasAnySubmissionCostField) return withLoyalty
      // Idempotency results written before migration 066 remain replayable, but
      // no cost is inferred from their historical JSON snapshot.
      return {
        ...withLoyalty,
        unitCostMinorAtSubmission: null,
        totalCostMinorAtSubmission: null,
        costSource: 'unavailable',
        costReferenceProductId: null,
        costReferenceOrderItemId: null,
        costReferenceProductUpdatedAt: null,
      }
    }),
  }
}

function submittedCommerceToJson(result: SubmittedCommerceResult): JsonObject {
  return {
    order: orderToJson(result.order),
    kdsTasks: result.kdsTasks.map(kdsTaskToJson),
    inventoryConsumptions: result.inventoryConsumptions.map(inventoryConsumptionToJson),
    paymentNextStep: { ...result.paymentNextStep },
  }
}

function orderAuditSnapshot(
  result: SubmittedCommerceResult,
  authorization: Readonly<VerifiedPricingAuthorization> | undefined,
  context: Readonly<{ assistedContextId: string | null; tableCode: string | null }>,
  schedulingOverride?: Readonly<KdsSchedulingOverride>,
  inventoryControl?: Readonly<{
    enforcementMode: 'strict' | 'audit_only'
    configurationComplete: boolean
    unconfiguredOrderItemIds: readonly string[]
    reservationCount: number
  }>,
  checkoutUpgradeOfferId: string | null = null,
  recommendationAttribution: Readonly<RecommendationOrderAttribution> | null = null,
): JsonObject {
  return {
    id: result.order.id,
    tableSessionId: result.order.tableSessionId,
    tableCode: context.tableCode,
    publicId: result.order.publicId,
    channel: result.order.channel,
    settlementMode: result.order.settlementMode,
    status: result.order.status,
    paymentStatus: result.order.paymentStatus,
    paymentNextStep: { ...result.paymentNextStep },
    totalAmountMinor: result.order.totalAmountMinor,
    currency: result.order.currency,
    note: result.order.note,
    itemCount: result.order.items.length,
    kdsTaskCount: result.kdsTasks.length,
    inventoryMovementCount: result.inventoryConsumptions.length,
    inventoryControl: inventoryControl ? {
      enforcementMode: inventoryControl.enforcementMode,
      configurationComplete: inventoryControl.configurationComplete,
      unconfiguredOrderItemIds: [...inventoryControl.unconfiguredOrderItemIds],
      reservationCount: inventoryControl.reservationCount,
    } : null,
    assistedOrderContextId: context.assistedContextId,
    kdsOverrideReason: schedulingOverride?.reason ?? null,
    pricingAuthorization: authorizationToJson(authorization),
    checkoutUpgradeOfferId,
    ...(recommendationAttribution ? { recommendationAttribution: { ...recommendationAttribution } } : {}),
  }
}

function orderOutboxPayload(
  result: SubmittedCommerceResult,
  authorization: Readonly<VerifiedPricingAuthorization> | undefined,
  context: Readonly<{ assistedContextId: string | null; tableCode: string | null }>,
  schedulingOverride?: Readonly<KdsSchedulingOverride>,
  inventoryControl?: Readonly<{
    enforcementMode: 'strict' | 'audit_only'
    configurationComplete: boolean
    unconfiguredOrderItemIds: readonly string[]
    reservationCount: number
  }>,
  checkoutUpgradeOfferId: string | null = null,
  recommendationAttribution: Readonly<RecommendationOrderAttribution> | null = null,
): JsonObject {
  return {
    order: orderToJson(result.order),
    paymentNextStep: { ...result.paymentNextStep },
    kdsTaskIds: result.kdsTasks.map((task) => task.id),
    inventoryMovementIds: result.inventoryConsumptions.map((movement) => movement.movementId),
    inventoryControl: inventoryControl ? {
      enforcementMode: inventoryControl.enforcementMode,
      configurationComplete: inventoryControl.configurationComplete,
      unconfiguredOrderItemIds: [...inventoryControl.unconfiguredOrderItemIds],
      reservationCount: inventoryControl.reservationCount,
    } : null,
    assistedOrderContextId: context.assistedContextId,
    tableCode: context.tableCode,
    kdsOverrideReason: schedulingOverride?.reason ?? null,
    pricingAuthorization: authorizationToJson(authorization),
    checkoutUpgradeOfferId,
    ...(recommendationAttribution ? { recommendationAttribution: { ...recommendationAttribution } } : {}),
  }
}

function orderToJson(order: SubmittedOrder): JsonObject {
  return {
    id: order.id,
    tableSessionId: order.tableSessionId,
    publicId: order.publicId,
    channel: order.channel,
    settlementMode: order.settlementMode,
    status: order.status,
    paymentStatus: order.paymentStatus,
    subtotalAmountMinor: order.subtotalAmountMinor,
    discountAmountMinor: order.discountAmountMinor,
    totalAmountMinor: order.totalAmountMinor,
    currency: order.currency,
    note: order.note,
    createdByEmployeeId: order.createdByEmployeeId,
    createdByCustomerId: order.createdByCustomerId,
    createdAt: order.createdAt,
    submittedAt: order.submittedAt,
    items: order.items.map((item) => ({
      id: item.id,
      orderId: item.orderId,
      productId: item.productId,
      parentOrderItemId: item.parentOrderItemId,
      billable: item.billable,
      consumesInventory: item.consumesInventory,
      quantity: item.quantity,
      unitPriceMinor: item.unitPriceMinor,
      discountAmountMinor: item.discountAmountMinor,
      totalAmountMinor: item.totalAmountMinor,
      currency: item.currency,
      fulfillmentStation: item.fulfillmentStation,
      fulfillmentPriority: item.fulfillmentPriority ?? 100,
      fulfillmentDueAt: item.fulfillmentDueAt ?? null,
      productSnapshot: item.productSnapshot,
      costSnapshot: item.costSnapshot,
      unitCostMinorAtSubmission: item.unitCostMinorAtSubmission,
      totalCostMinorAtSubmission: item.totalCostMinorAtSubmission,
      costSource: item.costSource,
      costReferenceProductId: item.costReferenceProductId,
      costReferenceOrderItemId: item.costReferenceOrderItemId,
      costReferenceProductUpdatedAt: item.costReferenceProductUpdatedAt,
      loyaltyEligibleAtSubmission: item.loyaltyEligibleAtSubmission,
      loyaltyEligibilitySource: item.loyaltyEligibilitySource,
      status: item.status,
      note: item.note,
      createdAt: item.createdAt,
    })),
  }
}

function kdsTaskToJson(task: KdsTask): JsonObject {
  return {
    id: task.id,
    orderItemId: task.orderItemId,
    stationCode: task.stationCode,
    status: task.status,
    priority: task.priority,
    quantity: task.quantity,
    assignedEmployeeId: task.assignedEmployeeId,
    dueAt: task.dueAt,
    nextActionAt: task.nextActionAt,
    acceptedAt: task.acceptedAt,
    readyAt: task.readyAt,
    cancelledAt: task.cancelledAt,
  }
}

function inventoryConsumptionToJson(consumption: InventoryConsumption): JsonObject {
  return {
    movementId: consumption.movementId,
    orderItemId: consumption.orderItemId,
    inventoryItemId: consumption.inventoryItemId,
    sku: consumption.sku,
    quantity: consumption.quantity,
    remainingOnHandQuantity: consumption.remainingOnHandQuantity,
  }
}

function validateCommand(input: Readonly<SubmitOrderCommand>): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate)) {
    throw new TypeError('businessDate must use YYYY-MM-DD')
  }
  if (input.actor.type === 'employee' && input.createdByEmployeeId !== input.actor.employeeId) {
    throw new TypeError('createdByEmployeeId must match the employee audit actor')
  }
  if (input.channel === 'guest_qr' && (!input.createdByCustomerId || input.createdByEmployeeId)) {
    throw new TypeError('Guest QR orders require an authenticated guest creator')
  }
  if (input.checkoutUpgradeOfferPublicId !== undefined && input.checkoutUpgradeOfferPublicId !== null) {
    if (input.checkoutUpgradeOfferPublicId.trim().length < 8) {
      throw new TypeError('checkoutUpgradeOfferPublicId is invalid')
    }
    if (input.channel !== 'guest_qr' || (input.settlementMode ?? 'table_tab') !== 'immediate_payment') {
      throw new TypeError('Checkout upgrades require a guest immediate-payment order')
    }
  }
  if (input.recommendationAttribution !== undefined && input.recommendationAttribution !== null) {
    const recommendationPublicId = input.recommendationAttribution.recommendationPublicId.trim()
    const selectedProductId = input.recommendationAttribution.selectedProductId.trim()
    if (recommendationPublicId.length < 8 || recommendationPublicId.length > 128) {
      throw new TypeError('recommendationPublicId is invalid')
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(selectedProductId)) {
      throw new TypeError('selected recommendation product ID is invalid')
    }
    if (input.channel !== 'guest_qr' || !input.createdByCustomerId
      || input.actor.type !== 'guest' || (input.settlementMode ?? 'table_tab') !== 'immediate_payment') {
      throw new TypeError('Recommendation attribution requires a guest immediate-payment order')
    }
  }
  if (input.channel === 'staff_assisted') {
    if (input.actor.type !== 'employee' || !input.assistedOrderContext) {
      throw new AssistedOrderContextDeniedError('ASSISTED_CONTEXT_INVALID')
    }
    if (input.assistedOrderContext.employeeId !== input.actor.employeeId) {
      throw new AssistedOrderContextDeniedError('ASSISTED_CONTEXT_INVALID')
    }
  }
  if (input.kdsOverride) {
    if (input.kdsOverride.reason.trim().length < 2 || input.kdsOverride.reason.length > 300) {
      throw new TypeError('KDS override reason must contain between 2 and 300 characters')
    }
    if (input.kdsOverride.priority !== undefined
      && (!Number.isInteger(input.kdsOverride.priority)
        || input.kdsOverride.priority < 0 || input.kdsOverride.priority > 1_000)) {
      throw new TypeError('KDS override priority must be an integer between 0 and 1000')
    }
    if (input.kdsOverride.dueAt !== undefined && input.kdsOverride.dueAt !== null
      && !Number.isFinite(Date.parse(input.kdsOverride.dueAt))) {
      throw new TypeError('KDS override dueAt must be a valid timestamp')
    }
  }
}

function authorizationToJson(
  authorization: Readonly<VerifiedPricingAuthorization> | undefined,
): JsonObject | null {
  if (!authorization) return null
  return {
    authorizationId: authorization.authorizationId,
    kind: authorization.kind,
    sourceType: authorization.sourceType,
    sourceId: authorization.sourceId,
    amountMinor: authorization.amountMinor,
    maximumAmountMinor: authorization.maximumAmountMinor,
    currency: authorization.currency,
    authorizedByEmployeeId: authorization.authorizedByEmployeeId,
    capability: authorization.capability,
  }
}

function canonicalSubmitFingerprint(input: Readonly<SubmitOrderCommand>): string {
  const actor = input.actor.type === 'employee'
    ? { type: input.actor.type, employeeId: input.actor.employeeId, ref: input.actor.ref ?? null }
    : { type: input.actor.type, ref: input.actor.ref ?? null }
  return JSON.stringify({
    tableSessionId: input.channel === 'staff_assisted' ? null : input.tableSessionId,
    assistedOrderContextTokenHash: input.assistedOrderContext
      ? hashAssistedOrderContextToken(input.assistedOrderContext.token)
      : null,
    assistedOrderStaffSessionId: input.assistedOrderContext?.staffSessionId ?? null,
    assistedOrderDeviceLeaseId: input.assistedOrderContext?.deviceAccessLeaseId ?? null,
    publicId: input.publicId,
    channel: input.channel,
    settlementMode: input.settlementMode ?? 'table_tab',
    lines: input.lines.map((line) => ({
      productId: line.productId,
      quantity: line.quantity,
      note: line.note?.trim() || null,
    })),
    note: input.note?.trim() || null,
    createdByEmployeeId: input.createdByEmployeeId ?? null,
    createdByCustomerId: input.createdByCustomerId ?? null,
    actor,
    businessDate: input.businessDate,
    kdsOverride: input.kdsOverride ? {
      priority: input.kdsOverride.priority ?? null,
      dueAt: input.kdsOverride.dueAt ?? null,
      reason: input.kdsOverride.reason.trim(),
    } : null,
    pricingAuthorization: input.pricingAuthorization ?? null,
    confirmedDuplicateOrderPublicId: input.confirmedDuplicateOrderPublicId ?? null,
    checkoutUpgradeOfferPublicId: input.checkoutUpgradeOfferPublicId?.trim() || null,
    ...(input.recommendationAttribution ? {
      recommendationAttribution: {
        recommendationPublicId: input.recommendationAttribution.recommendationPublicId.trim(),
        selectedProductId: input.recommendationAttribution.selectedProductId.trim(),
      },
    } : {}),
  })
}

function isSubmittedOrder(value: unknown): value is SubmittedOrder {
  if (!jsonObjectOrNull(value)) return false
  const order = value as Partial<SubmittedOrder>
  return typeof order.id === 'string'
    && typeof order.tableSessionId === 'string'
    && typeof order.publicId === 'string'
    && (order.settlementMode === 'immediate_payment' || order.settlementMode === 'table_tab')
    && order.status === 'submitted'
    && order.paymentStatus === 'unpaid'
    && typeof order.totalAmountMinor === 'number'
    && typeof order.createdAt === 'string'
    && typeof order.submittedAt === 'string'
    && Array.isArray(order.items)
    && order.items.every((item) => jsonObjectOrNull(item)
      && (item.parentOrderItemId === null || typeof item.parentOrderItemId === 'string')
      && typeof item.billable === 'boolean'
      && typeof item.consumesInventory === 'boolean'
      && (item.unitCostMinorAtSubmission === null || typeof item.unitCostMinorAtSubmission === 'number')
      && (item.totalCostMinorAtSubmission === null || typeof item.totalCostMinorAtSubmission === 'number')
      && ['catalog_product', 'legacy_snapshot', 'included_in_parent', 'unavailable'].includes(String(item.costSource))
      && (item.costReferenceProductId === null || typeof item.costReferenceProductId === 'string')
      && (item.costReferenceOrderItemId === null || typeof item.costReferenceOrderItemId === 'string')
      && (item.costReferenceProductUpdatedAt === null
        || typeof item.costReferenceProductUpdatedAt === 'string')
      && typeof item.loyaltyEligibleAtSubmission === 'boolean'
      && ['catalog_product', 'included_in_parent', 'legacy_current_catalog']
        .includes(String(item.loyaltyEligibilitySource)))
}

function isPaymentNextStep(value: unknown): value is PaymentNextStep {
  if (!jsonObjectOrNull(value)) return false
  const next = value as Partial<PaymentNextStep>
  return (next.status === 'required' || next.status === 'deferred')
    && (next.action === 'create_payment_intent' || next.action === 'settle_table_later')
    && next.paymentStatus === 'unpaid'
    && typeof next.orderId === 'string'
    && typeof next.amountMinor === 'number'
    && typeof next.currency === 'string'
}

function jsonObjectOrNull(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
