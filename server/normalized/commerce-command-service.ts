import type {
  AuditActor,
  CommandExecution,
  JsonCodec,
  JsonObject,
} from './command-executor.js'
import type { NormalizedCommandExecutor } from './command-executor.js'
import type { ScopedTransaction, StoreScope } from './transaction-runner.js'
import {
  AssistedOrderContextDeniedError,
  AssistedOrderContextRepository,
  hashAssistedOrderContextToken,
  type AssistedOrderContext,
  type AssistedOrderContextProof,
} from './assisted-order-context.js'
import { InventoryRepository, type InventoryConsumption } from './inventory-repository.js'
import { KDS_PRIORITY_OVERRIDE_CAPABILITY } from './kds-authorization-policy.js'
import { KdsRepository, type KdsTask } from './kds-repository.js'
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

export interface KdsSchedulingOverride {
  priority?: number
  dueAt?: string | null
  reason: string
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
      const orderInput: CreateSubmittedOrderInput = {
        tableSessionId: context.tableSessionId,
        publicId: input.publicId,
        channel: input.channel,
        settlementMode: input.settlementMode ?? 'table_tab',
        lines: input.lines,
        note: input.note,
        createdByEmployeeId: input.createdByEmployeeId,
        createdByCustomerId: input.createdByCustomerId,
      }
      const pricingAuthorization = await this.authorizePricing(transaction, orderInput, input)
      const schedulingOverride = await authorizeKdsOverride(transaction, input)
      const order = await new OrderRepository(transaction).createSubmitted(orderInput, pricingAuthorization)
      if (pricingAuthorization) await this.pricingPolicy!.consume(transaction, pricingAuthorization, order.id)

      const inventoryEnforcementMode = this.options.inventoryEnforcementMode ?? 'strict'
      const inventoryConsumptions = await new InventoryRepository(transaction).consumeForOrderItems(
        order.items,
        {
          createdByEmployeeId: input.createdByEmployeeId ?? null,
          reason: 'order submitted',
          metadata: {
            orderId: order.id,
            orderPublicId: order.publicId,
            pricingAuthorizationId: pricingAuthorization?.authorizationId ?? null,
            assistedOrderContextId: context.assistedContextId,
          },
          allowMissingRecipes: inventoryEnforcementMode === 'audit_only',
        },
      )
      const consumedOrderItemIds = new Set(inventoryConsumptions.map((item) => item.orderItemId))
      const unconfiguredInventoryOrderItemIds = order.items
        .filter((item) => (item.fulfillmentStation === 'bar' || item.fulfillmentStation === 'kitchen')
          && !consumedOrderItemIds.has(item.id))
        .map((item) => item.id)
      const inventoryControl = {
        enforcementMode: inventoryEnforcementMode,
        configurationComplete: unconfiguredInventoryOrderItemIds.length === 0,
        unconfiguredOrderItemIds: unconfiguredInventoryOrderItemIds,
      } as const
      const kdsTasks = await createServerScheduledKdsTasks(transaction, order, schedulingOverride)
      const result: SubmittedCommerceResult = {
        order,
        kdsTasks,
        inventoryConsumptions,
        paymentNextStep: paymentNextStep(order),
      }
      return {
        result,
        auditEvents: [{
          actor: input.actor,
          action: 'order.submitted',
          objectType: 'order',
          objectId: order.id,
          businessDate: input.businessDate,
          afterData: orderAuditSnapshot(result, pricingAuthorization, context, schedulingOverride, inventoryControl),
        }],
        outboxMessages: [{
          aggregateType: 'order',
          aggregateId: order.id,
          aggregateVersion: 1,
          eventType: 'order.submitted.v1',
          payload: orderOutboxPayload(result, pricingAuthorization, context, schedulingOverride, inventoryControl),
        }],
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
  override?: Readonly<KdsSchedulingOverride>,
): Promise<KdsTask[]> {
  const repository = new KdsRepository(transaction)
  const tasks: KdsTask[] = []
  for (const item of order.items) {
    if (item.fulfillmentStation === 'none') continue
    const source = jsonObject(item.productSnapshot.source)
    const defaultPriority = configuredInteger(source.kdsPriority, 0, 1_000) ?? 100
    const defaultSeconds = configuredInteger(source.fulfillmentSlaSeconds, 30, 4 * 60 * 60)
      ?? defaultSlaSeconds(item.fulfillmentStation)
    const dueAt = override?.dueAt !== undefined
      ? override.dueAt
      : new Date(Date.now() + defaultSeconds * 1_000).toISOString()
    tasks.push(normalizeKdsTaskDates(await repository.create({
      orderItemId: item.id,
      stationCode: item.fulfillmentStation,
      quantity: item.quantity,
      priority: override?.priority ?? defaultPriority,
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

function defaultSlaSeconds(station: 'bar' | 'kitchen' | 'cashier'): number {
  if (station === 'bar') return 5 * 60
  if (station === 'kitchen') return 10 * 60
  return 2 * 60
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
    const result = value as Partial<SubmittedCommerceResult>
    if (!isSubmittedOrder(result.order) || !Array.isArray(result.kdsTasks)
      || !Array.isArray(result.inventoryConsumptions) || !isPaymentNextStep(result.paymentNextStep)) {
      throw new TypeError('Stored commerce result is incomplete')
    }
    return result as SubmittedCommerceResult
  },
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
  }>,
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
    } : null,
    assistedOrderContextId: context.assistedContextId,
    kdsOverrideReason: schedulingOverride?.reason ?? null,
    pricingAuthorization: authorizationToJson(authorization),
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
  }>,
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
    } : null,
    assistedOrderContextId: context.assistedContextId,
    tableCode: context.tableCode,
    kdsOverrideReason: schedulingOverride?.reason ?? null,
    pricingAuthorization: authorizationToJson(authorization),
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
      productSnapshot: item.productSnapshot,
      costSnapshot: item.costSnapshot,
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
      && typeof item.consumesInventory === 'boolean')
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

function jsonObject(value: unknown): JsonObject {
  return jsonObjectOrNull(value) ? value : {}
}

function jsonObjectOrNull(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function configuredInteger(value: unknown, minimum: number, maximum: number): number | null {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum
    ? Number(value)
    : null
}
