import { createHash, randomUUID } from 'node:crypto'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type {
  CommandExecution,
  JsonCodec,
  JsonObject,
  NormalizedCommandExecutor,
} from './command-executor.js'
import {
  AssistedOrderContextDeniedError,
  AssistedOrderContextRepository,
} from './assisted-order-context.js'
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyRecordError,
} from './command-executor.js'
import type {
  CommerceCommandService,
  SubmittedCommerceResult,
} from './commerce-command-service.js'
import type {
  FulfillmentQueryService,
} from './fulfillment-query-service.js'
import {
  FULFILLMENT_VIEW_ALL_PERMISSION,
  KDS_DELIVER_PERMISSION,
  KDS_EXCEPTION_MANAGE_PERMISSION,
  KDS_PREPARE_PERMISSION,
} from './fulfillment-query-service.js'
import {
  InventoryBalanceMissingError,
  InventoryRepository,
  InventoryRecipeMissingError,
  InsufficientInventoryError,
} from './inventory-repository.js'
import { FulfillmentCapacityUnavailableError } from './fulfillment-capacity-repository.js'
import {
  KdsAuthorizationError,
  NormalizedKdsAuthorization,
} from './kds-authorization-policy.js'
import {
  KdsRepository,
  KdsTransitionError,
  type KdsStatus,
  type KdsTask,
} from './kds-repository.js'
import {
  OrderDeliveryBlockedError,
  OrderProductUnavailableError,
  OrderRepository,
  TableSessionUnavailableForOrderError,
  type OrderItem,
} from './order-repository.js'
import { PricingAuthorizationDeniedError } from './pricing-authorization-policy.js'
import {
  NormalizedAuthenticationRequiredError,
  NormalizedStoreUnavailableError,
  TrustedStoreScopeError,
} from './normalized-request-context.js'
import {
  StaffAccessDeniedError,
  StaffAccessRepository,
  StaffNotFoundError,
} from './staff-access-repository.js'
import {
  assertEmployeeTableSessionAccess,
  EmployeeTableAccessDeniedError,
} from './employee-table-access.js'
import { StaffSessionNotFoundError } from './staff-session-repository.js'
import type {
  ScopedPostgresTransactionRunner,
  ScopedTransaction,
  StoreScope,
} from './transaction-runner.js'

export interface CommerceKdsRequestContext {
  scope: Readonly<StoreScope>
  employeeId: string
  staffSessionId: string
  deviceAccessLeaseId: string
  businessDate: string
}

type CommerceCommandPort = Pick<CommerceCommandService, 'submitOrder'>
type FulfillmentQueryPort = Pick<FulfillmentQueryService, 'getStaffWorkQueue'>
type CommandExecutorPort = Pick<NormalizedCommandExecutor, 'execute'>
type StaffAccessTransactionPort = Pick<ScopedPostgresTransactionRunner, 'run'>
type KdsRepositoryPort = Pick<KdsRepository, 'accept' | 'startPreparing' | 'markReady' | 'cancel' | 'fail' | 'create'>
type OrderRepositoryPort = Pick<OrderRepository, 'markDelivered'>

export interface CommerceKdsApiOptions {
  commerce: CommerceCommandPort
  fulfillmentQuery: FulfillmentQueryPort
  commandExecutor: CommandExecutorPort
  staffAccessTransactions: StaffAccessTransactionPort
  resolveContext(request: FastifyRequest): Promise<CommerceKdsRequestContext> | CommerceKdsRequestContext
  createKdsRepository(transaction: ScopedTransaction): KdsRepositoryPort
  createOrderRepository(transaction: ScopedTransaction): OrderRepositoryPort
  resolveOpenTableSessionId?: (
    scope: Readonly<StoreScope>,
    tableId: string,
  ) => Promise<string | null>
  onlinePaymentAvailable?: boolean
  resolveOnlinePaymentAvailable?: (scope: Readonly<StoreScope>) => Promise<boolean>
  onlinePaymentProvider?: 'postar' | 'simulation' | null
}

type KdsAction =
  | 'accept'
  | 'start'
  | 'complete'
  | 'completeAndDeliver'
  | 'pickUp'
  | 'pickupAndDeliver'
  | 'deliver'
  | 'fail'

interface KdsCommandTarget {
  task: KdsTask
  orderItemId: string
  orderId: string
  tableSessionId: string
  tableId: string
  tableCode: string
  productId: string
  productName: string
  specification: string
  fulfillmentNote: string
  queuedAt: string
}

interface KdsActionResult {
  task: KdsTask
  target: KdsCommandTarget
  orderItem: OrderItem | null
  fulfillmentStatus: 'pending' | 'in_progress' | 'ready' | 'delivered' | 'cancelled' | 'failed'
  exceptionEvidence: JsonObject | null
}

interface KdsExceptionReason {
  code: string
  note: string
}

interface ApiErrorBody {
  error: {
    code: string
    message: string
    referenceId?: string
  }
}

interface KdsTaskLockRow extends Record<string, unknown> {
  id: string
  order_item_id: string
  remake_of_task_id: string | null
  station_code: 'bar' | 'kitchen' | 'cashier'
  status: KdsStatus
  priority: number
  quantity: number
  assigned_employee_id: string | null
  due_at: string | null
  next_action_at: string
  accepted_at: string | null
  ready_at: string | null
  cancelled_at: string | null
  created_at: string
}

interface KdsTargetDetailRow extends Record<string, unknown> {
  order_item_id: string
  order_id: string
  table_session_id: string
  table_id: string
  table_code: string
  product_id: string
  product_name: string
  specification: string
  product_snapshot: JsonObject
  fulfillment_note: string | null
}

class CommerceKdsRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message)
    this.name = 'CommerceKdsRequestError'
  }
}

class CommerceKdsCapabilityError extends Error {
  constructor(public readonly capability: string) {
    super(`当前员工缺少操作权限：${capability}`)
    this.name = 'CommerceKdsCapabilityError'
  }
}

class CommerceKdsActorBindingError extends Error {
  constructor() {
    super('请求中的员工身份与当前登录员工不一致')
    this.name = 'CommerceKdsActorBindingError'
  }
}

class KdsTaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`KDS任务不存在：${taskId}`)
    this.name = 'KdsTaskNotFoundError'
  }
}

export interface StaffTablePaymentOrderView {
  id: string
  publicId: string
  currency: string
  paymentStatus: string
  outstandingAmountMinor: number
  hasOnlinePaymentInProgress: boolean
  unresolvedOnlinePaymentId: string | null
}

export type StaffTableOrderItemFulfillmentStatus =
  | 'delivered'
  | 'ready_for_delivery'
  | 'preparing'
  | 'pending'
  | 'awaiting_payment'
  | 'not_required'
  | 'cancelled'
  | 'attention'

export interface StaffTableOrderDetailView {
  publicId: string
  items: Array<{
    id: string
    productName: string
    quantity: number
    fulfillmentStation: 'bar' | 'kitchen' | 'cashier' | 'none'
    fulfillmentStatus: StaffTableOrderItemFulfillmentStatus
  }>
}

interface StaffTableOrderDetailRow extends Record<string, unknown> {
  order_id: string
  order_public_id: string
  order_status: string
  order_fulfillment_state: string
  item_id: string
  product_name: string
  quantity: string | number
  fulfillment_station: 'bar' | 'kitchen' | 'cashier' | 'none'
  item_status: 'submitted' | 'accepted' | 'preparing' | 'ready' | 'delivered' | 'cancelled'
  kds_status: KdsStatus | null
}

/**
 * Read-only item progress for one active table session.  Item delivery is
 * authoritative: a ready KDS task is explicitly still waiting to be served.
 */
export async function listTableOrderDetailsForSession(
  transaction: ScopedTransaction,
  tableSessionId: string,
): Promise<StaffTableOrderDetailView[]> {
  const result = await transaction.query<StaffTableOrderDetailRow>(`
    SELECT order_header.id AS order_id,order_header.public_id AS order_public_id,
      order_header.status AS order_status,order_header.fulfillment_state AS order_fulfillment_state,
      item.id AS item_id,
      COALESCE(NULLIF(item.product_snapshot->>'name',''),product.name,'商品') AS product_name,
      item.quantity,item.fulfillment_station,item.status AS item_status,kds.status AS kds_status
    FROM mbox.orders order_header
    JOIN mbox.order_items item
      ON item.tenant_id=order_header.tenant_id AND item.store_id=order_header.store_id
     AND item.order_id=order_header.id
    LEFT JOIN mbox.products product
      ON product.tenant_id=item.tenant_id AND product.store_id=item.store_id
     AND product.id=item.product_id
    LEFT JOIN LATERAL (
      SELECT task.status
      FROM mbox.kds_tasks task
      WHERE task.tenant_id=item.tenant_id AND task.store_id=item.store_id
        AND task.order_item_id=item.id
      ORDER BY CASE task.status
        WHEN 'ready' THEN 0
        WHEN 'preparing' THEN 1
        WHEN 'accepted' THEN 2
        WHEN 'pending' THEN 3
        WHEN 'failed' THEN 4
        WHEN 'cancelled' THEN 5
        ELSE 6
      END,task.created_at DESC,task.id DESC
      LIMIT 1
    ) kds ON true
    WHERE order_header.tenant_id=$1::uuid AND order_header.store_id=$2::uuid
      AND order_header.table_session_id=$3::uuid AND order_header.status<>'draft'
    ORDER BY order_header.created_at DESC,order_header.id DESC,item.created_at,item.id
  `, [transaction.scope.tenantId, transaction.scope.storeId, tableSessionId])
  const orders = new Map<string, StaffTableOrderDetailView>()
  for (const row of result.rows) {
    const order = orders.get(row.order_id) ?? {
      publicId: row.order_public_id,
      items: [],
    }
    order.items.push({
      id: row.item_id,
      productName: row.product_name,
      quantity: Number(row.quantity),
      fulfillmentStation: row.fulfillment_station,
      fulfillmentStatus: tableOrderItemFulfillmentStatus(row),
    })
    orders.set(row.order_id, order)
  }
  return [...orders.values()]
}

function tableOrderItemFulfillmentStatus(row: StaffTableOrderDetailRow): StaffTableOrderItemFulfillmentStatus {
  if (row.item_status === 'delivered') return 'delivered'
  if (row.item_status === 'cancelled' || row.order_status === 'cancelled') return 'cancelled'
  if (row.fulfillment_station === 'none') return 'not_required'
  if (row.order_fulfillment_state === 'awaiting_payment') return 'awaiting_payment'
  if (row.order_fulfillment_state !== 'active') return 'attention'
  if (row.kds_status === 'ready') return 'ready_for_delivery'
  if (row.kds_status === 'preparing' || row.kds_status === 'accepted') return 'preparing'
  if (row.kds_status === 'pending' || row.kds_status === null) return 'pending'
  return 'attention'
}

export async function listTablePaymentOrdersForSession(
  transaction: ScopedTransaction,
  tableSessionId: string,
): Promise<StaffTablePaymentOrderView[]> {
  const result = await transaction.query<{
    id: string
    public_id: string
    currency: string
    payment_status: string
    outstanding_amount_minor: string | number
    has_online_payment_in_progress: boolean | null
    unresolved_online_payment_id: string | null
  }>(`
    SELECT order_header.id,order_header.public_id,order_header.currency,order_header.payment_status,
      GREATEST(0,order_header.total_amount_minor-paid.captured_amount_minor+refund.refunded_amount_minor)
        AS outstanding_amount_minor,
      pending.has_online_payment_in_progress,
      pending.unresolved_online_payment_id
    FROM mbox.orders order_header
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(payment.amount_minor) FILTER (
        WHERE payment.status IN ('succeeded','partially_refunded','refunded')
      ),0)::bigint
        AS captured_amount_minor
      FROM mbox.payments payment
      WHERE payment.tenant_id=order_header.tenant_id AND payment.store_id=order_header.store_id
        AND payment.order_id=order_header.id
    ) paid ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(refund_row.amount_minor) FILTER (WHERE refund_row.status='succeeded'),0)::bigint
        AS refunded_amount_minor
      FROM mbox.refunds refund_row
      JOIN mbox.payments payment
        ON payment.tenant_id=refund_row.tenant_id AND payment.store_id=refund_row.store_id
       AND payment.id=refund_row.payment_id
      WHERE refund_row.tenant_id=order_header.tenant_id AND refund_row.store_id=order_header.store_id
        AND payment.order_id=order_header.id
    ) refund ON true
    LEFT JOIN LATERAL (
      SELECT payment.id AS unresolved_online_payment_id,
        true AS has_online_payment_in_progress
      FROM mbox.payments payment
      WHERE payment.tenant_id=order_header.tenant_id AND payment.store_id=order_header.store_id
        AND payment.order_id=order_header.id AND payment.status='pending'
        AND payment.provider IN ('wechat','postar','simulation')
        AND payment.retry_released_at IS NULL
      ORDER BY payment.created_at DESC,payment.id DESC
      LIMIT 1
    ) pending ON true
    LEFT JOIN LATERAL (
      SELECT EXISTS(
        SELECT 1 FROM mbox.order_recollection_authorizations recollection_authorization
        WHERE recollection_authorization.tenant_id=order_header.tenant_id
          AND recollection_authorization.store_id=order_header.store_id
          AND recollection_authorization.order_id=order_header.id
          AND recollection_authorization.status='active'
          AND recollection_authorization.expires_at>clock_timestamp()
      ) AS active
    ) recollection ON true
    WHERE order_header.tenant_id=$1::uuid AND order_header.store_id=$2::uuid
      AND order_header.table_session_id=$3::uuid AND order_header.status<>'cancelled'
      AND GREATEST(0,order_header.total_amount_minor-paid.captured_amount_minor+refund.refunded_amount_minor)>0
      -- A server can collect only an ordinary unpaid balance, or a balance
      -- that a cashier explicitly reopened after a completed refund.
      AND (refund.refunded_amount_minor=0 OR recollection.active)
    ORDER BY order_header.created_at DESC,order_header.id DESC
    LIMIT 20
  `, [transaction.scope.tenantId, transaction.scope.storeId, tableSessionId])
  return result.rows.map((row) => ({
    id: row.id,
    publicId: row.public_id,
    currency: row.currency,
    paymentStatus: row.payment_status,
    outstandingAmountMinor: Number(row.outstanding_amount_minor),
    hasOnlinePaymentInProgress: row.has_online_payment_in_progress === true,
    unresolvedOnlinePaymentId: row.unresolved_online_payment_id,
  }))
}

export const commerceKdsApiPlugin: FastifyPluginAsync<CommerceKdsApiOptions> = async (
  app,
  options,
) => {
  app.get('/commerce/assisted-order-access', async (request, reply) => handleRoute(reply, async () => {
    const context = await resolveContext(options, request)
    const access = await resolveStaffAccess(options, context)
    const canCreateOrder = access.permissions.includes('order.create')
    const onlinePaymentAvailable = options.resolveOnlinePaymentAvailable === undefined
      ? options.onlinePaymentAvailable === true
      : await options.resolveOnlinePaymentAvailable(context.scope)
    const hasPaymentInitiationPermission = access.permissions.includes('payment.initiate.staff')
    const onlinePaymentProvider = options.onlinePaymentProvider ?? null
    const paymentInitiationBlockReason = !hasPaymentInitiationPermission
      ? 'permission_required'
      : onlinePaymentProvider === null
        ? 'provider_not_configured'
        : !onlinePaymentAvailable
          ? 'online_payment_unavailable'
          : null
    const giftLimit = canCreateOrder && access.permissions.includes('order.gift')
      ? access.approvalLimits.find((limit) => limit.code === 'order.gift') ?? null
      : null
    return reply.send({
      data: {
        canCreateOrder,
        canInitiatePayment: paymentInitiationBlockReason === null,
        paymentInitiationBlockReason,
        canQueryOnlinePayment: access.permissions.includes('reconciliation.view'),
        onlinePaymentProvider,
        manualCollection: {
          canRecordCash: access.permissions.includes('payment.manual.cash.record'),
          canRecordPos: access.permissions.includes('payment.manual.pos.record'),
          canRecordExternal: access.permissions.includes('payment.manual.external.record'),
        },
        gift: giftLimit === null ? null : {
          enabled: giftLimit.allowFullGift,
          maximumAmountMinor: giftLimit.amountMinor,
          currency: giftLimit.currency,
        },
      },
    })
  }))

  // This is deliberately a narrow, table-bound read model instead of exposing
  // the cashier workbench to every server who may initiate a payment.  The
  // payment command repeats both the capability and table-scope checks in its
  // write transaction; this route only makes the correct existing order easy
  // to select from the table page.
  app.get('/commerce/table-sessions/:tableSessionId/payment-orders', async (request, reply) => handleRoute(reply, async () => {
    const context = await resolveContext(options, request)
    const collectionPermissions = [
      'payment.initiate.staff',
      'payment.manual.cash.record',
      'payment.manual.pos.record',
      'payment.manual.external.record',
    ] as const
    await requireAnyPermission(options, context, collectionPermissions)
    const tableSessionId = readUuid(
      readRequiredString(readObject(request.params, '路由参数').tableSessionId, 'tableSessionId', 64),
      'tableSessionId',
    )
    const data = await options.staffAccessTransactions.run(context.scope, async (transaction) => {
      await assertEmployeeTableSessionAccess(transaction, {
        employeeId: context.employeeId,
        tableSessionId,
        includeTableViewAll: false,
        allTablePermissionCodes: ['payment.collect.all_tables'],
      })
      return listTablePaymentOrdersForSession(transaction, tableSessionId)
    })
    return reply.send({ data })
  }))

  // This is a deliberately read-only, low-sensitivity view: no price, payment
  // or guest identity is returned.  Any employee allowed to execute service
  // may inspect an active table's delivery progress; mutations keep their
  // stricter table responsibility checks.
  app.get('/commerce/table-sessions/:tableSessionId/order-details', async (request, reply) => handleRoute(reply, async () => {
    const context = await resolveContext(options, request)
    await requireAnyPermission(options, context, ['service.execute', 'order.view'])
    const tableSessionId = readUuid(
      readRequiredString(readObject(request.params, '路由参数').tableSessionId, 'tableSessionId', 64),
      'tableSessionId',
    )
    const data = await options.staffAccessTransactions.run(context.scope, async (transaction) => {
      await assertEmployeeTableSessionAccess(transaction, {
        employeeId: context.employeeId,
        tableSessionId,
        includeTableViewAll: false,
        allTablePermissionCodes: ['service.execute', 'order.view'],
      })
      return listTableOrderDetailsForSession(transaction, tableSessionId)
    }, { readOnly: true })
    return reply.send({ data })
  }))

  app.post('/commerce/assisted-order-contexts', async (request, reply) => handleRoute(reply, async () => {
    const context = await resolveContext(options, request)
    const body = readObject(request.body, '请求正文')
    assertActorBinding(body, context.employeeId)
    const tableSessionId = await readTableSessionId(options, context.scope, body)
    const issued = await options.staffAccessTransactions.run(context.scope, async (transaction) => (
      new AssistedOrderContextRepository(transaction).issue({
        employeeId: context.employeeId,
        staffSessionId: context.staffSessionId,
        deviceAccessLeaseId: context.deviceAccessLeaseId,
        tableSessionId,
      })
    ))
    return reply.code(201).send({ data: issued })
  }))

  app.post('/commerce/orders', async (request, reply) => handleRoute(reply, async () => {
    const context = await resolveContext(options, request)
    await requirePermission(options, context, 'order.create')
    const body = readObject(request.body, '请求正文')
    assertActorBinding(body, context.employeeId)
    const idempotencyKey = readIdempotencyKey(request, body)
    const input = readOrderInput(body)
    const pricingAuthorization = input.orderMode === 'gift'
      ? await resolveEmployeeGiftAuthorization(options, context)
      : undefined
    const assistedToken = readAssistedOrderContextToken(request, body)
    const execution = await options.commerce.submitOrder({
      scope: context.scope,
      actor: { type: 'employee', employeeId: context.employeeId },
      businessDate: context.businessDate,
      idempotencyKey,
      tableSessionId: readOptionalUuid(body.tableSessionId, 'tableSessionId') ?? undefined,
      publicId: readOptionalString(body.publicId, 'publicId', 128)
        ?? deterministicPublicId(context.scope, idempotencyKey),
      channel: 'staff_assisted',
      lines: input.lines,
      note: input.orderMode === 'gift'
        ? giftOrderNote(input.giftReason!, input.note)
        : input.note,
      settlementMode: input.orderMode === 'gift' ? 'table_tab' : input.settlementMode,
      createdByEmployeeId: context.employeeId,
      assistedOrderContext: {
        token: assistedToken,
        employeeId: context.employeeId,
        staffSessionId: context.staffSessionId,
        deviceAccessLeaseId: context.deviceAccessLeaseId,
      },
      pricingAuthorization,
      kdsOverride: input.kdsOverride,
    })
    return reply.code(execution.replayed ? 200 : 201).send(commerceResponse(execution, input.orderMode))
  }))

  app.get('/commerce/fulfillment', async (request, reply) => handleRoute(reply, async () => {
    const context = await resolveContext(options, request)
    await requireAnyPermission(options, context, [
      'order.view',
      KDS_PREPARE_PERMISSION,
      KDS_DELIVER_PERMISSION,
      KDS_EXCEPTION_MANAGE_PERMISSION,
      FULFILLMENT_VIEW_ALL_PERMISSION,
    ])
    const view = await options.fulfillmentQuery.getStaffWorkQueue(
      context.scope,
      context.employeeId,
      context.businessDate,
    )
    return reply.send({ data: view })
  }))

  app.post<{ Params: { taskId: string } }>(
    '/commerce/kds/:taskId/actions',
    async (request, reply) => handleRoute(reply, async () => {
      const context = await resolveContext(options, request)
      const body = readObject(request.body, '请求正文')
      assertActorBinding(body, context.employeeId)
      const action = readKdsAction(body.action)
      if (action === 'completeAndDeliver') {
        throw new CommerceKdsRequestError(
          'KDS_COMBINED_ACTION_DISABLED',
          '制作完成和送达必须由实际岗位分别确认',
          409,
        )
      }
      if (action === 'pickUp') {
        throw new CommerceKdsRequestError(
          'KDS_PICKUP_ACTION_UNSUPPORTED',
          '规范化流程不单独记录取货，请在实际送达后确认送达',
          409,
        )
      }
      const deliveryAction = action === 'deliver' || action === 'pickupAndDeliver'
      await requirePermission(
        options,
        context,
        deliveryAction ? KDS_DELIVER_PERMISSION : KDS_PREPARE_PERMISSION,
      )
      const taskId = readUuid(request.params.taskId, 'taskId')
      const reason = action === 'fail' ? readExceptionReason(body) : null
      const idempotencyKey = readIdempotencyKey(request, body)
      const execution = await executeKdsAction(
        options,
        context,
        taskId,
        action,
        idempotencyKey,
        request.id,
        reason,
      )
      return reply.send(kdsResponse(execution))
    }),
  )

  app.post<{ Params: { taskId: string } }>(
    '/commerce/kds/:taskId/manager-cancel',
    async (request, reply) => handleRoute(reply, async () => {
      const context = await resolveContext(options, request)
      const body = readObject(request.body, '请求正文')
      assertActorBinding(body, context.employeeId)
      const taskId = readUuid(request.params.taskId, 'taskId')
      const idempotencyKey = readIdempotencyKey(request, body)
      const reason = readExceptionReason(body)
      const execution = await executeManagerCancellation(
        options,
        context,
        taskId,
        idempotencyKey,
        request.id,
        reason,
      )
      return reply.send(kdsResponse(execution))
    }),
  )

  // A failed production task must not disappear from the operating loop. An
  // administrator can grant this narrow capability to a bartender, server or
  // manager; the API records the decision and creates a new KDS task rather
  // than reopening and rewriting the failed historical task.
  app.post<{ Params: { taskId: string } }>(
    '/commerce/kds/:taskId/remake',
    async (request, reply) => handleRoute(reply, async () => {
      const context = await resolveContext(options, request)
      const body = readObject(request.body, '请求正文')
      assertActorBinding(body, context.employeeId)
      const taskId = readUuid(request.params.taskId, 'taskId')
      const reason = readExceptionReason(body)
      const idempotencyKey = readIdempotencyKey(request, body)
      const execution = await executeKdsRemake(
        options,
        context,
        taskId,
        idempotencyKey,
        request.id,
        reason,
      )
      return reply.send(kdsResponse(execution))
    }),
  )
}

async function executeKdsAction(
  options: CommerceKdsApiOptions,
  context: CommerceKdsRequestContext,
  taskId: string,
  action: Exclude<KdsAction, 'completeAndDeliver' | 'pickUp'>,
  idempotencyKey: string,
  requestId: string,
  reason: KdsExceptionReason | null,
): Promise<CommandExecution<KdsActionResult>> {
  return options.commandExecutor.execute({
    scope: context.scope,
    operationScope: 'commerce.kds.action',
    idempotencyKey,
    requestFingerprint: JSON.stringify({ taskId, action, employeeId: context.employeeId, reason }),
    resultCodec: kdsActionResultCodec,
  }, async (transaction) => {
    const target = await lockKdsCommandTarget(transaction, taskId)
    await new NormalizedKdsAuthorization().assertCanActOnTask({
      transaction,
      employeeId: context.employeeId,
      staffSessionId: context.staffSessionId,
      deviceAccessLeaseId: context.deviceAccessLeaseId,
      action: action === 'pickupAndDeliver' || action === 'deliver' ? 'deliver' : action,
      stationCode: target.task.stationCode,
      tableId: target.tableId,
    })
    const kds = options.createKdsRepository(transaction)
    const order = options.createOrderRepository(transaction)
    const transitionInput = (suffix: string) => ({
      taskId,
      actorEmployeeId: context.employeeId,
      eventIdempotencyKey: `${idempotencyKey}:${suffix}`,
      metadata: { requestId, source: 'http_api' },
    })

    let task = target.task
    let orderItem: OrderItem | null = null
    let exceptionEvidence: JsonObject | null = null
    if (action === 'accept') {
      task = await kds.accept(transitionInput('accept'))
    } else if (action === 'start') {
      if (task.status === 'pending') task = await kds.accept(transitionInput('accept'))
      const inventory = new InventoryRepository(transaction)
      await inventory.consumeOrderItemReservations(target.orderItemId, {
        createdByEmployeeId: context.employeeId,
        reason: 'KDS开始制作，消费已确认订单的库存预留',
        metadata: { kdsTaskId: task.id, requestId, source: 'kds_production_start' },
      })
      await inventory.consumeRemakeMaterials(task.id, {
        createdByEmployeeId: context.employeeId,
        originalTaskId: task.remakeOfTaskId,
        reason: 'KDS开始制作，消费重新制作预留的追加物料',
        metadata: { kdsTaskId: task.id, requestId, source: 'kds_remake_production_start' },
      })
      task = await kds.startPreparing(transitionInput('start'))
    } else if (action === 'complete') {
      if (task.status === 'pending') task = await kds.accept(transitionInput('accept'))
      if (task.status === 'accepted') {
        const inventory = new InventoryRepository(transaction)
        await inventory.consumeOrderItemReservations(target.orderItemId, {
          createdByEmployeeId: context.employeeId,
          reason: 'KDS开始制作，消费已确认订单的库存预留',
          metadata: { kdsTaskId: task.id, requestId, source: 'kds_production_start' },
        })
        await inventory.consumeRemakeMaterials(task.id, {
          createdByEmployeeId: context.employeeId,
          originalTaskId: task.remakeOfTaskId,
          reason: 'KDS开始制作，消费重新制作预留的追加物料',
          metadata: { kdsTaskId: task.id, requestId, source: 'kds_remake_production_start' },
        })
        task = await kds.startPreparing(transitionInput('start'))
      }
      task = await kds.markReady(transitionInput('complete'))
    } else if (action === 'fail') {
      task = await kds.fail({
        ...transitionInput('fail'),
        metadata: { requestId, source: 'http_api', reasonCode: reason!.code, reasonNote: reason!.note },
      })
      await new InventoryRepository(transaction).releaseRemakeMaterials(
        task.id,
        `重新制作任务未开始即失败：${reason!.note}`,
      )
      const exceptionId = await insertKdsException(transaction, target, context.employeeId, 'production_failed', reason!, [
        'manager_review', 'inventory_review', 'remake_or_cancel_decision',
      ])
      exceptionEvidence = {
        id: exceptionId,
        exceptionId,
        type: 'reported',
        exceptionKind: 'production_rejection',
        reasonCode: reason!.code,
        reasonNote: reason!.note,
        orderId: target.orderId,
        orderItemId: target.orderItemId,
        kdsTaskId: task.id,
        originalOrderItemId: target.orderItemId,
        originalKdsTaskId: task.id,
        actorId: context.employeeId,
        actorRoleId: 'normalized_employee',
        occurredAt: new Date().toISOString(),
        managerDisposition: null,
        remakeKdsTaskId: null,
        financialTruth: 'unchanged_pending_review',
        inventoryTruth: 'unchanged_pending_review',
        requiredActions: ['manager_review', 'inventory_review', 'remake_or_cancel_decision'],
      }
    } else {
      if (task.status !== 'ready') {
        throw new CommerceKdsRequestError(
          'KDS_NOT_READY_FOR_DELIVERY',
          '该出品尚未制作完成，不能确认送达',
          409,
        )
      }
      orderItem = await order.markDelivered(target.orderItemId, context.employeeId)
    }

    const result: KdsActionResult = {
      task,
      target,
      orderItem,
      fulfillmentStatus: fulfillmentStatus(task, orderItem),
      exceptionEvidence,
    }
    const actionName = action === 'pickupAndDeliver' ? 'deliver' : action
    return {
      result,
      auditEvents: [{
        actor: { type: 'employee', employeeId: context.employeeId },
        action: `kds.${actionName}`,
        objectType: 'kds_task',
        objectId: task.id,
        businessDate: context.businessDate,
        afterData: kdsActionResultToJson(result),
        requestId,
      }],
      outboxMessages: [{
        aggregateType: 'kds_task',
        aggregateId: task.id,
        aggregateVersion: kdsVersion(result.fulfillmentStatus),
        eventType: `kds.${actionName}.v1`,
        payload: kdsActionResultToJson(result),
        headers: { requestId },
      }],
    }
  })
}

async function executeManagerCancellation(
  options: CommerceKdsApiOptions,
  context: CommerceKdsRequestContext,
  taskId: string,
  idempotencyKey: string,
  requestId: string,
  reason: KdsExceptionReason,
): Promise<CommandExecution<KdsActionResult>> {
  return options.commandExecutor.execute({
    scope: context.scope,
    operationScope: 'commerce.kds.manager_cancel',
    idempotencyKey,
    requestFingerprint: JSON.stringify({ taskId, employeeId: context.employeeId, reason }),
    resultCodec: kdsActionResultCodec,
  }, async (transaction) => {
    const target = await lockKdsCommandTarget(transaction, taskId)
    await new NormalizedKdsAuthorization().assertCanActOnTask({
      transaction,
      employeeId: context.employeeId,
      staffSessionId: context.staffSessionId,
      deviceAccessLeaseId: context.deviceAccessLeaseId,
      action: 'manager_cancel',
      stationCode: target.task.stationCode,
      tableId: target.tableId,
    })
    const task = await options.createKdsRepository(transaction).cancel({
      taskId,
      actorEmployeeId: context.employeeId,
      eventIdempotencyKey: `${idempotencyKey}:manager-cancel`,
      metadata: {
        requestId,
        source: 'manager_exception_api',
        reasonCode: reason.code,
        reasonNote: reason.note,
        financialTruth: 'unchanged_pending_review',
        inventoryTruth: 'unchanged_pending_review',
      },
    })
    await new InventoryRepository(transaction).releaseRemakeMaterials(
      task.id,
      `重新制作任务被终止：${reason.note}`,
    )
    const exceptionId = await insertKdsException(
      transaction,
      target,
      context.employeeId,
      'manager_cancelled',
      reason,
      ['financial_review', 'inventory_review', 'guest_communication'],
    )
    const result: KdsActionResult = {
      task,
      target,
      orderItem: null,
      fulfillmentStatus: 'cancelled',
      exceptionEvidence: {
        id: exceptionId,
        exceptionId,
        type: 'manager_disposition',
        exceptionKind: 'production_rejection',
        reasonCode: reason.code,
        reasonNote: reason.note,
        orderId: target.orderId,
        orderItemId: target.orderItemId,
        kdsTaskId: task.id,
        originalOrderItemId: target.orderItemId,
        originalKdsTaskId: task.id,
        actorId: context.employeeId,
        actorRoleId: 'normalized_employee',
        occurredAt: new Date().toISOString(),
        managerDisposition: 'cancelled',
        remakeKdsTaskId: null,
        financialTruth: 'unchanged_pending_review',
        inventoryTruth: 'unchanged_pending_review',
        requiredActions: ['financial_review', 'inventory_review', 'guest_communication'],
      },
    }
    const evidence = kdsActionResultToJson(result)
    return {
      result,
      auditEvents: [{
        actor: { type: 'employee', employeeId: context.employeeId },
        action: 'kds.manager_cancelled',
        objectType: 'kds_task',
        objectId: task.id,
        businessDate: context.businessDate,
        afterData: evidence,
        requestId,
      }],
      outboxMessages: [{
        aggregateType: 'kds_task',
        aggregateId: task.id,
        aggregateVersion: 4,
        eventType: 'kds.manager_cancelled.v1',
        payload: evidence,
        headers: { requestId },
      }],
    }
  })
}

async function executeKdsRemake(
  options: CommerceKdsApiOptions,
  context: CommerceKdsRequestContext,
  taskId: string,
  idempotencyKey: string,
  requestId: string,
  reason: KdsExceptionReason,
): Promise<CommandExecution<KdsActionResult>> {
  return options.commandExecutor.execute({
    scope: context.scope,
    operationScope: 'commerce.kds.remake',
    idempotencyKey,
    requestFingerprint: JSON.stringify({ taskId, employeeId: context.employeeId, reason }),
    resultCodec: kdsActionResultCodec,
  }, async (transaction) => {
    const target = await lockKdsCommandTarget(transaction, taskId)
    if (target.task.status !== 'failed') {
      throw new CommerceKdsRequestError(
        'KDS_REMAKE_NOT_AVAILABLE',
        '只有制作失败的出品可以重新制作；已取消的出品请先由收银或值班同事确认后续处理。',
        409,
      )
    }
    await new NormalizedKdsAuthorization().assertCanActOnTask({
      transaction,
      employeeId: context.employeeId,
      staffSessionId: context.staffSessionId,
      deviceAccessLeaseId: context.deviceAccessLeaseId,
      action: 'manager_remake',
      stationCode: target.task.stationCode,
      tableId: target.tableId,
    })
    const exception = await transaction.query<{ id: string; reason_code: string; reason_note: string }>(`
      SELECT exception.id,exception.reason_code,exception.reason_note
      FROM mbox.kds_exceptions AS exception
      WHERE exception.tenant_id=$1::uuid AND exception.store_id=$2::uuid
        AND exception.kds_task_id=$3::uuid AND exception.status IN ('open','remediating')
      ORDER BY exception.occurred_at DESC, exception.id DESC
      LIMIT 1
      FOR UPDATE OF exception
    `, [transaction.scope.tenantId, transaction.scope.storeId, taskId])
    const exceptionRow = exception.rows[0]
    if (exceptionRow === undefined) {
      throw new CommerceKdsRequestError('KDS_EXCEPTION_NOT_FOUND', '没有找到这项制作失败的异常记录，请刷新后重试', 409)
    }
    const exceptionId = exceptionRow.id
    const item = await transaction.query<{ status: string }>(`
      SELECT item.status
      FROM mbox.order_items AS item
      WHERE item.tenant_id=$1::uuid AND item.store_id=$2::uuid AND item.id=$3::uuid
      FOR UPDATE OF item
    `, [transaction.scope.tenantId, transaction.scope.storeId, target.orderItemId])
    if (item.rows[0] === undefined || item.rows[0].status === 'delivered' || item.rows[0].status === 'cancelled') {
      throw new CommerceKdsRequestError('KDS_REMAKE_ITEM_CLOSED', '对应商品已送达或已取消，不能重新制作', 409)
    }
    const remake = await options.createKdsRepository(transaction).create({
      orderItemId: target.orderItemId,
      remakeOfTaskId: taskId,
      stationCode: target.task.stationCode,
      quantity: target.task.quantity,
      priority: target.task.priority,
      dueAt: target.task.dueAt,
      eventIdempotencyKey: `${idempotencyKey}:remake-created`,
    })
    const remakeReservations = await new InventoryRepository(transaction).reserveRemakeMaterials({
      orderItemId: target.orderItemId,
      originalTaskId: taskId,
      remakeTaskId: remake.id,
    })
    // The failed task remains in the append-only event/exception history, but
    // is terminally replaced so it does not remain an active KDS blocker once
    // the replacement task is delivered.
    const superseded = await transaction.query(`
      UPDATE mbox.kds_tasks
      SET status='cancelled',cancelled_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='failed'
    `, [transaction.scope.tenantId, transaction.scope.storeId, taskId])
    if (superseded.rowCount !== 1) throw new CommerceKdsRequestError('KDS_REMAKE_CHANGED', '原制作任务状态已变化，请刷新后重试', 409)
    const supersededEvent = await transaction.query(`
      INSERT INTO mbox.kds_task_events(
        tenant_id,store_id,kds_task_id,event_type,from_status,to_status,actor_employee_id,metadata,idempotency_key
      ) VALUES($1::uuid,$2::uuid,$3::uuid,'task.remade','failed','cancelled',$4::uuid,$5::jsonb,$6)
    `, [
      transaction.scope.tenantId,
      transaction.scope.storeId,
      taskId,
      context.employeeId,
      JSON.stringify({ remakeTaskId: remake.id, remakeInventoryReservations: remakeReservations.map((item) => item.id) }),
      `${idempotencyKey}:remake-superseded`,
    ])
    if (supersededEvent.rowCount !== 1) throw new Error('KDS remake history event was not recorded')
    const resolved = await transaction.query(`
      UPDATE mbox.kds_exceptions
      SET status='resolved', financial_truth_status='no_action_required', inventory_truth_status='no_action_required',
        resolved_by_employee_id=$4::uuid, resolved_at=clock_timestamp(),
        resolution_note=$5
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status IN ('open','remediating')
    `, [
      transaction.scope.tenantId,
      transaction.scope.storeId,
      exceptionId,
      context.employeeId,
      `重新制作：${reason.note}；原失败：${exceptionRow.reason_code} ${exceptionRow.reason_note}`,
    ])
    if (resolved.rowCount !== 1) throw new CommerceKdsRequestError('KDS_EXCEPTION_CHANGED', '出品异常已被其他同事处理，请刷新后确认', 409)
    const result: KdsActionResult = {
      task: remake,
      target,
      orderItem: null,
      fulfillmentStatus: 'pending',
      exceptionEvidence: {
        id: exceptionId,
        exceptionId,
        type: 'remade',
        exceptionKind: 'production_rejection',
        reasonCode: reason.code,
        reasonNote: reason.note,
        orderId: target.orderId,
        orderItemId: target.orderItemId,
        kdsTaskId: remake.id,
        originalOrderItemId: target.orderItemId,
        originalKdsTaskId: taskId,
        actorId: context.employeeId,
        actorRoleId: 'normalized_employee',
        occurredAt: new Date().toISOString(),
        managerDisposition: 'remade',
        remakeKdsTaskId: remake.id,
        remakeInventoryReservations: remakeReservations.map((item) => ({
          inventoryItemId: item.inventoryItemId,
          quantity: item.quantity,
        })),
        financialTruth: 'no_action_required',
        inventoryTruth: 'no_action_required',
        requiredActions: [],
      },
    }
    const evidence = kdsActionResultToJson(result)
    return {
      result,
      auditEvents: [{
        actor: { type: 'employee', employeeId: context.employeeId },
        action: 'kds.exception_remade',
        objectType: 'kds_exception',
        objectId: exceptionId,
        businessDate: context.businessDate,
        afterData: evidence,
        requestId,
      }],
      outboxMessages: [{
        aggregateType: 'kds_task',
        aggregateId: remake.id,
        aggregateVersion: 1,
        eventType: 'kds.exception.remade.v1',
        payload: evidence,
        headers: { requestId },
      }],
    }
  })
}

async function insertKdsException(
  transaction: ScopedTransaction,
  target: KdsCommandTarget,
  employeeId: string,
  kind: 'production_failed' | 'manager_cancelled',
  reason: KdsExceptionReason,
  requiredActions: readonly string[],
): Promise<string> {
  const id = randomUUID()
  const inserted = await transaction.query(`
    INSERT INTO mbox.kds_exceptions (
      id, tenant_id, store_id, kds_task_id, order_item_id, exception_type,
      reason_code, reason_note, status, financial_truth_status,
      inventory_truth_status, required_actions, reported_by_employee_id
    ) VALUES (
      $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6,
      $7, $8, 'open', 'unchanged_pending_review',
      'unchanged_pending_review', $9::jsonb, $10::uuid
    )
  `, [
    id,
    transaction.scope.tenantId,
    transaction.scope.storeId,
    target.task.id,
    target.orderItemId,
    kind,
    reason.code,
    reason.note,
    JSON.stringify(requiredActions),
    employeeId,
  ])
  if (inserted.rowCount !== 1) throw new Error('KDS exception evidence was not recorded')
  return id
}

async function lockKdsCommandTarget(
  transaction: ScopedTransaction,
  taskId: string,
): Promise<KdsCommandTarget> {
  // Lock the authoritative task by its scoped unique key first. Keeping the
  // descriptive joins out of this statement prevents PostgreSQL from choosing
  // a tenant-wide nested-loop plan as a store accumulates orders.
  const selectedTask = await transaction.query<KdsTaskLockRow>(`
    SELECT task.id, task.order_item_id, task.remake_of_task_id, task.station_code, task.status,
      task.priority, task.quantity, task.assigned_employee_id,
      task.due_at::text, task.next_action_at::text,
      task.accepted_at::text, task.ready_at::text, task.cancelled_at::text,
      task.created_at::text
    FROM mbox.kds_tasks AS task
    WHERE task.tenant_id = $1::uuid
      AND task.store_id = $2::uuid
      AND task.id = $3::uuid
    FOR UPDATE OF task
  `, [transaction.scope.tenantId, transaction.scope.storeId, taskId])
  const taskRow = selectedTask.rows[0]
  if (selectedTask.rowCount !== 1 || taskRow === undefined) throw new KdsTaskNotFoundError(taskId)

  const selectedDetail = await transaction.query<KdsTargetDetailRow>(`
    SELECT item.id AS order_item_id, ordering.id AS order_id,
      ordering.table_session_id, table_session.table_id,
      venue_table.code AS table_code, item.product_id,
      COALESCE(item.product_snapshot ->> 'name', product.name) AS product_name,
      COALESCE(
        NULLIF(item.product_snapshot ->> 'specification', ''),
        NULLIF(item.product_snapshot -> 'source' ->> 'specification', ''),
        ''
      ) AS specification,
      item.product_snapshot, ordering.note AS fulfillment_note
    FROM mbox.order_items AS item
    JOIN mbox.orders AS ordering
      ON ordering.tenant_id = item.tenant_id
     AND ordering.store_id = item.store_id
     AND ordering.id = item.order_id
    JOIN mbox.table_sessions AS table_session
      ON table_session.tenant_id = ordering.tenant_id
     AND table_session.store_id = ordering.store_id
     AND table_session.id = ordering.table_session_id
    JOIN mbox.tables AS venue_table
      ON venue_table.tenant_id = table_session.tenant_id
     AND venue_table.store_id = table_session.store_id
     AND venue_table.id = table_session.table_id
    JOIN mbox.products AS product
      ON product.tenant_id = item.tenant_id
     AND product.store_id = item.store_id
     AND product.id = item.product_id
    WHERE item.tenant_id = $1::uuid
      AND item.store_id = $2::uuid
      AND item.id = $3::uuid
  `, [transaction.scope.tenantId, transaction.scope.storeId, taskRow.order_item_id])
  const detailRow = selectedDetail.rows[0]
  if (selectedDetail.rowCount !== 1 || detailRow === undefined) throw new KdsTaskNotFoundError(taskId)
  return {
    orderItemId: detailRow.order_item_id,
    orderId: detailRow.order_id,
    tableSessionId: detailRow.table_session_id,
    tableId: detailRow.table_id,
    tableCode: detailRow.table_code,
    productId: detailRow.product_id,
    productName: detailRow.product_name,
    specification: detailRow.specification,
    fulfillmentNote: detailRow.fulfillment_note ?? '',
    queuedAt: taskRow.created_at,
    task: {
      id: taskRow.id,
      orderItemId: taskRow.order_item_id,
      remakeOfTaskId: taskRow.remake_of_task_id,
      stationCode: taskRow.station_code,
      status: taskRow.status,
      priority: taskRow.priority,
      quantity: taskRow.quantity,
      assignedEmployeeId: taskRow.assigned_employee_id,
      dueAt: taskRow.due_at,
      nextActionAt: taskRow.next_action_at,
      acceptedAt: taskRow.accepted_at,
      readyAt: taskRow.ready_at,
      cancelledAt: taskRow.cancelled_at,
    },
  }
}

async function requirePermission(
  options: CommerceKdsApiOptions,
  context: CommerceKdsRequestContext,
  permission: string,
): Promise<void> {
  const access = await resolveStaffAccess(options, context)
  if (!access.permissions.includes(permission)) throw new CommerceKdsCapabilityError(permission)
}

async function requireAnyPermission(
  options: CommerceKdsApiOptions,
  context: CommerceKdsRequestContext,
  permissions: readonly string[],
): Promise<void> {
  const access = await resolveStaffAccess(options, context)
  if (!permissions.some((permission) => access.permissions.includes(permission))) {
    throw new CommerceKdsCapabilityError(permissions.join(' | '))
  }
}

function resolveStaffAccess(
  options: CommerceKdsApiOptions,
  context: CommerceKdsRequestContext,
) {
  return options.staffAccessTransactions.run(context.scope, async (transaction) => (
    new StaffAccessRepository(transaction).resolve(context.employeeId)
  ), { readOnly: true })
}

async function readTableSessionId(
  options: CommerceKdsApiOptions,
  scope: Readonly<StoreScope>,
  body: JsonObject,
): Promise<string> {
  const tableSessionId = readOptionalString(body.tableSessionId, 'tableSessionId', 80)
  if (tableSessionId !== null) return readUuid(tableSessionId, 'tableSessionId')
  const tableId = readOptionalString(body.tableId, 'tableId', 80)
  if (tableId === null) {
    throw new CommerceKdsRequestError(
      'TABLE_SESSION_REQUIRED',
      '请选择已开台的桌次后再下单',
    )
  }
  if (!options.resolveOpenTableSessionId) {
    throw new CommerceKdsRequestError(
      'TABLE_SESSION_REQUIRED',
      '当前订单接口需要桌次编号，请刷新桌台后重试',
      409,
    )
  }
  const resolved = await options.resolveOpenTableSessionId(scope, tableId)
  if (resolved === null) {
    throw new CommerceKdsRequestError(
      'TABLE_NOT_OPEN',
      '桌台尚未开台或已经翻台，请先开台后再下单',
      409,
    )
  }
  return readUuid(resolved, 'tableSessionId')
}

function readOrderInput(body: JsonObject) {
  const source = body.items ?? body.lines
  if (!Array.isArray(source) || source.length < 1 || source.length > 50) {
    throw new CommerceKdsRequestError('ORDER_ITEMS_INVALID', '订单商品数量必须在1至50项之间')
  }
  const seen = new Set<string>()
  const lines = source.map((value, index) => {
    const line = readObject(value, `items[${index}]`)
    const productId = readUuid(readRequiredString(line.productId, `items[${index}].productId`, 80), `items[${index}].productId`)
    if (seen.has(productId)) {
      throw new CommerceKdsRequestError(
        'ORDER_DUPLICATE_PRODUCT',
        '购物车中有重复商品，请先合并数量再提交',
      )
    }
    seen.add(productId)
    const quantity = readInteger(line.quantity, `items[${index}].quantity`, 1, 999)
    const note = readOptionalString(line.note, `items[${index}].note`, 300)
    return { productId, quantity, note }
  })
  const settlementMode = readOptionalString(body.settlementMode, 'settlementMode', 32)
  if (settlementMode !== null && !['immediate_payment', 'table_tab'].includes(settlementMode)) {
    throw new CommerceKdsRequestError('SETTLEMENT_MODE_INVALID', '结算方式无效')
  }
  const orderMode = readOptionalString(body.orderMode, 'orderMode', 16) ?? 'paid'
  if (!['paid', 'gift'].includes(orderMode)) {
    throw new CommerceKdsRequestError('ORDER_MODE_INVALID', '订单类型无效')
  }
  const giftReason = readOptionalString(body.giftReason, 'giftReason', 200)
  if (orderMode === 'gift' && (giftReason?.length ?? 0) < 2) {
    throw new CommerceKdsRequestError('GIFT_REASON_REQUIRED', '请填写至少2个字的赠送原因')
  }
  return {
    lines,
    note: readOptionalString(body.fulfillmentNote ?? body.note, 'fulfillmentNote', 500),
    settlementMode: (settlementMode ?? 'table_tab') as 'immediate_payment' | 'table_tab',
    orderMode: orderMode as 'paid' | 'gift',
    giftReason,
    kdsOverride: readKdsOverride(body.kdsOverride),
  }
}

async function resolveEmployeeGiftAuthorization(
  options: CommerceKdsApiOptions,
  context: CommerceKdsRequestContext,
) {
  return options.staffAccessTransactions.run(context.scope, async (transaction) => {
    const repository = new StaffAccessRepository(transaction)
    await repository.assertPermission(context.employeeId, 'order.gift')
    const authority = await repository.resolveApprovalAuthority(context.employeeId, 'order.gift')
    if (authority === null || authority.amountMinor === null || authority.amountMinor < 1
      || !authority.allowFullGift || authority.calculationMode !== 'full_gift') {
      throw new CommerceKdsRequestError(
        'GIFT_LIMIT_UNAVAILABLE',
        '当前岗位未配置可用的商品赠送额度，请联系店长或管理员',
        403,
      )
    }
    return { sourceType: 'employee' as const, sourceId: authority.id }
  }, { readOnly: true })
}

function giftOrderNote(reason: string, fulfillmentNote: string | null): string {
  return fulfillmentNote === null
    ? `赠送原因：${reason}`
    : `赠送原因：${reason}\n出品备注：${fulfillmentNote}`
}

function readKdsAction(value: unknown): KdsAction {
  if (typeof value !== 'string' || ![
    'accept', 'start', 'complete', 'completeAndDeliver', 'pickUp',
    'pickupAndDeliver', 'deliver', 'fail',
  ].includes(value)) {
    throw new CommerceKdsRequestError('KDS_ACTION_INVALID', 'KDS操作无效')
  }
  return value as KdsAction
}

function commerceResponse(
  execution: CommandExecution<SubmittedCommerceResult>,
  orderMode: 'paid' | 'gift' = 'paid',
) {
  const order = execution.value.order
  const kdsByItem = new Map(execution.value.kdsTasks.map((task) => [task.orderItemId, task]))
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
    orderMode,
    items: order.items.map((item) => {
      const source = isJsonObject(item.productSnapshot.source) ? item.productSnapshot.source : {}
      const task = kdsByItem.get(item.id)
      return {
        id: item.id,
        skuId: item.productId,
        productId: item.productId,
        name: typeof item.productSnapshot.name === 'string' ? item.productSnapshot.name : '',
        specification: typeof source.specification === 'string' ? source.specification : '',
        quantity: item.quantity,
        unitListPriceAmount: item.unitPriceMinor,
        unitSalePriceAmount: Math.max(0, item.unitPriceMinor - Math.floor(item.discountAmountMinor / item.quantity)),
        unitCostAmount: readMoney(item.costSnapshot.unitCostAmount),
        stationId: item.fulfillmentStation,
        configVersion: readVersion(source.configVersion),
        fulfillmentStatus: compatibleItemStatus(item, task),
        kdsTaskId: task?.id ?? null,
        addedBy: order.createdByEmployeeId ?? 'system',
        addedAt: item.createdAt,
        note: item.note,
        productSnapshot: item.productSnapshot,
      }
    }),
    fulfillmentNote: order.note ?? '',
    amounts: {
      grossAmount: order.subtotalAmountMinor,
      discountAmount: orderMode === 'gift' ? 0 : order.discountAmountMinor,
      giftAmount: orderMode === 'gift' ? order.discountAmountMinor : 0,
      payableAmount: order.totalAmountMinor,
    },
    revision: 1,
    createdBy: order.createdByEmployeeId ?? 'system',
    createdAt: order.createdAt,
    submittedBy: order.createdByEmployeeId,
    submittedAt: order.submittedAt,
    fulfilledAt: null,
    paymentNextStep: execution.value.paymentNextStep,
    kdsTasks: execution.value.kdsTasks,
    inventoryConsumptions: execution.value.inventoryConsumptions,
    meta: { replayed: execution.replayed },
  }
}

function kdsResponse(execution: CommandExecution<KdsActionResult>) {
  const result = execution.value
  const task = result.task
  return {
    id: task.id,
    orderId: result.target.orderId,
    orderItemId: result.target.orderItemId,
    tableSessionId: result.target.tableSessionId,
    tableCode: result.target.tableCode,
    stationId: task.stationCode,
    stationCode: task.stationCode,
    itemName: result.target.productName,
    productId: result.target.productId,
    specification: result.target.specification,
    quantity: task.quantity,
    fulfillmentNote: result.target.fulfillmentNote,
    status: compatibleKdsStatus(result),
    normalizedStatus: task.status,
    priority: task.priority,
    dueAt: task.dueAt,
    workstation: null,
    productionSla: { targetSeconds: 0, dueAt: task.dueAt },
    pickupSla: null,
    deliveryServiceTask: null,
    remakeOf: task.remakeOfTaskId,
    exceptionEvents: result.exceptionEvidence === null ? [] : [result.exceptionEvidence],
    queuedAt: result.target.queuedAt,
    startedAt: task.acceptedAt,
    startedBy: task.assignedEmployeeId,
    completedAt: task.readyAt,
    completedBy: task.readyAt === null ? null : task.assignedEmployeeId,
    pickedUpAt: null,
    pickedUpBy: null,
    deliveredAt: result.orderItem?.status === 'delivered' ? new Date().toISOString() : null,
    deliveredBy: result.orderItem?.status === 'delivered' ? task.assignedEmployeeId : null,
    fulfillmentStatus: result.fulfillmentStatus,
    deliveredOrderItem: result.orderItem,
    meta: { replayed: execution.replayed },
  }
}

function compatibleKdsStatus(result: KdsActionResult) {
  if (result.fulfillmentStatus === 'delivered') return 'delivered'
  if (result.task.status === 'pending') return 'queued'
  if (result.task.status === 'accepted' || result.task.status === 'preparing') return 'preparing'
  if (result.task.status === 'ready') return 'completed'
  return result.task.status
}

function fulfillmentStatus(
  task: KdsTask,
  orderItem: OrderItem | null,
): KdsActionResult['fulfillmentStatus'] {
  if (orderItem?.status === 'delivered') return 'delivered'
  if (task.status === 'ready') return 'ready'
  if (task.status === 'cancelled') return 'cancelled'
  if (task.status === 'failed') return 'failed'
  if (task.status === 'accepted' || task.status === 'preparing') return 'in_progress'
  return 'pending'
}

function kdsVersion(status: KdsActionResult['fulfillmentStatus']): number {
  if (status === 'pending') return 1
  if (status === 'in_progress') return 2
  if (status === 'ready') return 3
  return 4
}

const kdsActionResultCodec: JsonCodec<KdsActionResult> = {
  encode: kdsActionResultToJson,
  decode: (value) => {
    if (!isJsonObject(value) || !isJsonObject(value.task) || !isJsonObject(value.target)) {
      throw new TypeError('Stored KDS action result is invalid')
    }
    if (typeof value.task.id !== 'string' || typeof value.fulfillmentStatus !== 'string') {
      throw new TypeError('Stored KDS action result is incomplete')
    }
    return value as unknown as KdsActionResult
  },
}

function kdsActionResultToJson(result: KdsActionResult): JsonObject {
  return {
    task: kdsTaskToJson(result.task),
    target: {
      orderItemId: result.target.orderItemId,
      orderId: result.target.orderId,
      tableSessionId: result.target.tableSessionId,
      tableId: result.target.tableId,
      tableCode: result.target.tableCode,
      productId: result.target.productId,
      productName: result.target.productName,
      specification: result.target.specification,
      fulfillmentNote: result.target.fulfillmentNote,
      queuedAt: result.target.queuedAt,
      task: kdsTaskToJson(result.target.task),
    },
    orderItem: result.orderItem === null ? null : orderItemToJson(result.orderItem),
    fulfillmentStatus: result.fulfillmentStatus,
    exceptionEvidence: result.exceptionEvidence,
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

function orderItemToJson(item: OrderItem): JsonObject {
  return {
    id: item.id,
    orderId: item.orderId,
    productId: item.productId,
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
  }
}

function deterministicPublicId(scope: Readonly<StoreScope>, idempotencyKey: string): string {
  return `order-${createHash('sha256')
    .update(`${scope.tenantId}:${scope.storeId}:${idempotencyKey}`)
    .digest('hex')
    .slice(0, 24)}`
}

async function resolveContext(
  options: CommerceKdsApiOptions,
  request: FastifyRequest,
): Promise<CommerceKdsRequestContext> {
  const context = await options.resolveContext(request)
  readUuid(context.scope.tenantId, 'tenantId')
  readUuid(context.scope.storeId, 'storeId')
  readUuid(context.employeeId, 'employeeId')
  readUuid(context.staffSessionId, 'staffSessionId')
  readUuid(context.deviceAccessLeaseId, 'deviceAccessLeaseId')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(context.businessDate)) {
    throw new CommerceKdsRequestError('BUSINESS_DATE_INVALID', '营业日格式无效', 500)
  }
  return context
}

function readAssistedOrderContextToken(request: FastifyRequest, body: JsonObject): string {
  const raw = request.headers['x-assisted-order-context']
  if (Array.isArray(raw)) {
    throw new CommerceKdsRequestError('ASSISTED_CONTEXT_INVALID', '协助点单授权格式无效')
  }
  const header = raw?.trim() || null
  const bodyToken = readOptionalString(body.assistedOrderContextToken, 'assistedOrderContextToken', 256)
  if (header !== null && bodyToken !== null && header !== bodyToken) {
    throw new CommerceKdsRequestError('ASSISTED_CONTEXT_INVALID', '协助点单授权不一致')
  }
  const token = header ?? bodyToken
  if (token === null || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
    throw new CommerceKdsRequestError('ASSISTED_CONTEXT_REQUIRED', '请先从当前桌台进入协助点单')
  }
  return token
}

function readKdsOverride(value: unknown) {
  if (value === undefined || value === null) return undefined
  const override = readObject(value, 'kdsOverride')
  return {
    priority: readOptionalInteger(override.priority, 'kdsOverride.priority', 0, 1_000),
    dueAt: readOptionalIsoTimestamp(override.dueAt, 'kdsOverride.dueAt'),
    reason: readRequiredString(override.reason, 'kdsOverride.reason', 300),
  }
}

function readExceptionReason(body: JsonObject): KdsExceptionReason {
  return {
    code: readRequiredString(body.reasonCode, 'reasonCode', 64),
    note: readRequiredString(body.reasonNote ?? body.reason, 'reasonNote', 500),
  }
}

function readOptionalUuid(value: unknown, name: string): string | null {
  const text = readOptionalString(value, name, 80)
  return text === null ? null : readUuid(text, name)
}

function compatibleItemStatus(item: OrderItem, task: KdsTask | undefined) {
  if (item.status === 'delivered') return 'delivered'
  if (!task) return 'draft'
  if (task.status === 'pending') return 'queued'
  if (task.status === 'accepted' || task.status === 'preparing') return 'preparing'
  if (task.status === 'ready') return 'completed'
  return 'draft'
}

function readMoney(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0
}

function readVersion(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : 1
}

function assertActorBinding(body: JsonObject, employeeId: string): void {
  const actorId = readOptionalString(body.actorId, 'actorId', 80)
  if (actorId !== null && actorId !== employeeId) throw new CommerceKdsActorBindingError()
}

function readIdempotencyKey(request: FastifyRequest, body: JsonObject): string {
  const rawHeader = request.headers['idempotency-key']
  if (Array.isArray(rawHeader)) {
    throw new CommerceKdsRequestError('IDEMPOTENCY_KEY_INVALID', '提交标识不能重复')
  }
  const header = rawHeader?.trim() || null
  const bodyValue = readOptionalString(body.idempotencyKey, 'idempotencyKey', 128)
  if (header !== null && bodyValue !== null && header !== bodyValue) {
    throw new CommerceKdsRequestError(
      'IDEMPOTENCY_KEY_CONFLICT',
      '请求头与正文中的提交标识不一致',
    )
  }
  const key = header ?? bodyValue
  if (key === null || key.length < 8 || key.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new CommerceKdsRequestError(
      'IDEMPOTENCY_KEY_INVALID',
      '请提供8至128位有效提交标识',
    )
  }
  return key
}

function readObject(value: unknown, name: string): JsonObject {
  if (!isJsonObject(value)) throw new CommerceKdsRequestError('REQUEST_INVALID', `${name}格式无效`)
  return value
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRequiredString(value: unknown, name: string, maxLength: number): string {
  const normalized = readOptionalString(value, name, maxLength)
  if (normalized === null) throw new CommerceKdsRequestError('REQUEST_INVALID', `${name}不能为空`)
  return normalized
}

function readOptionalString(value: unknown, name: string, maxLength: number): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new CommerceKdsRequestError('REQUEST_INVALID', `${name}必须是文本`)
  const normalized = value.trim()
  if (normalized.length < 1 || normalized.length > maxLength) {
    throw new CommerceKdsRequestError('REQUEST_INVALID', `${name}长度无效`)
  }
  return normalized
}

function readInteger(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new CommerceKdsRequestError('REQUEST_INVALID', `${name}必须是${min}至${max}之间的整数`)
  }
  return Number(value)
}

function readOptionalInteger(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined
  return readInteger(value, name, min, max)
}

function readOptionalIsoTimestamp(value: unknown, name: string): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new CommerceKdsRequestError('REQUEST_INVALID', `${name}必须是有效时间`)
  }
  return new Date(value).toISOString()
}

function readUuid(value: string, name: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new CommerceKdsRequestError('REQUEST_INVALID', `${name}格式无效`)
  }
  return value
}

async function handleRoute(
  reply: FastifyReply,
  operation: () => Promise<FastifyReply>,
): Promise<FastifyReply> {
  try {
    return await operation()
  } catch (error) {
    const mapped = mapError(error)
    if (mapped.statusCode >= 500) {
      const referenceId = safeReferenceId(reply.request.id)
      mapped.body.error.referenceId = referenceId
      reply.request.log.error({ errorCode: safeErrorCode(error), referenceId }, 'normalized commerce request failed')
    }
    return reply.code(mapped.statusCode).send(mapped.body)
  }
}

function safeReferenceId(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 64)
  return normalized.length > 0 ? normalized : 'unknown-request'
}

function safeErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code.slice(0, 64)
  }
  return error instanceof Error ? error.name.slice(0, 64) : 'UNKNOWN_ERROR'
}

function mapError(error: unknown): { statusCode: number; body: ApiErrorBody } {
  if (error instanceof NormalizedAuthenticationRequiredError || error instanceof StaffSessionNotFoundError) {
    return apiError(401, 'AUTH_REQUIRED', '登录信息无效或已过期，请重新登录')
  }
  if (error instanceof TrustedStoreScopeError || error instanceof NormalizedStoreUnavailableError) {
    return apiError(403, 'STORE_ACCESS_FORBIDDEN', error.message)
  }
  if (error instanceof CommerceKdsActorBindingError) {
    return apiError(403, 'ACTOR_BINDING_FORBIDDEN', error.message)
  }
  if (error instanceof CommerceKdsCapabilityError || error instanceof StaffAccessDeniedError) {
    return apiError(403, 'STAFF_ACCESS_FORBIDDEN', '当前员工无权执行此操作')
  }
  if (error instanceof EmployeeTableAccessDeniedError) {
    return apiError(403, 'TABLE_ACCESS_FORBIDDEN', error.message)
  }
  if (error instanceof StaffNotFoundError) {
    return apiError(403, 'STAFF_ACCESS_FORBIDDEN', '当前员工无权执行此操作')
  }
  if (error instanceof KdsAuthorizationError) {
    return apiError(403, error.code, '当前员工无权执行该出品操作')
  }
  if (error instanceof AssistedOrderContextDeniedError) {
    return apiError(403, error.code, error.message)
  }
  if (error instanceof CommerceKdsRequestError) {
    return apiError(error.statusCode, error.code, error.message)
  }
  if (error instanceof TypeError) return apiError(400, 'REQUEST_INVALID', error.message)
  if (error instanceof KdsTaskNotFoundError) return apiError(404, 'KDS_TASK_NOT_FOUND', error.message)
  if (error instanceof OrderProductUnavailableError) {
    return apiError(409, 'ORDER_PRODUCT_UNAVAILABLE', '订单中有商品已下架或价格失效，请刷新后重试')
  }
  if (error instanceof TableSessionUnavailableForOrderError) {
    return apiError(409, 'TABLE_SESSION_UNAVAILABLE', '桌次未开台或已经结束，请刷新后重试')
  }
  if (error instanceof InventoryRecipeMissingError || error instanceof InventoryBalanceMissingError) {
    return apiError(409, 'INVENTORY_CONFIGURATION_INCOMPLETE', '商品库存配置不完整，请联系值班经理')
  }
  if (error instanceof InsufficientInventoryError) {
    return apiError(409, 'INVENTORY_INSUFFICIENT', '部分商品库存不足，请调整订单后重试')
  }
  if (error instanceof FulfillmentCapacityUnavailableError) {
    return apiError(409, error.code, error.message)
  }
  if (error instanceof PricingAuthorizationDeniedError) {
    return apiError(403, 'PRICING_AUTHORIZATION_DENIED', '本次赠送超过当前岗位额度，或赠送权限已失效')
  }
  if (error instanceof KdsTransitionError) {
    return apiError(409, 'KDS_TRANSITION_CONFLICT', '出品状态已经变化，请刷新后重试')
  }
  if (error instanceof OrderDeliveryBlockedError) {
    return apiError(409, 'ORDER_ITEM_NOT_READY', '该商品尚未完成制作或已被处理，请刷新后重试')
  }
  if (error instanceof IdempotencyConflictError) {
    return apiError(409, 'IDEMPOTENCY_CONFLICT', '同一个提交标识不能用于不同操作')
  }
  if (error instanceof IdempotencyInProgressError) {
    return apiError(409, 'IDEMPOTENCY_IN_PROGRESS', '该操作正在处理中，请稍后刷新')
  }
  if (error instanceof IdempotencyRecordError) {
    return apiError(500, 'IDEMPOTENCY_STORAGE_ERROR', '请求处理记录异常，请稍后重试')
  }
  return apiError(500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试')
}

function apiError(statusCode: number, code: string, message: string) {
  return { statusCode, body: { error: { code, message } } }
}
