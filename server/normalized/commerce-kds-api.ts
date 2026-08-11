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
  KDS_PREPARE_PERMISSION,
} from './fulfillment-query-service.js'
import {
  InventoryBalanceMissingError,
  InventoryRecipeMissingError,
  InsufficientInventoryError,
} from './inventory-repository.js'
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
type KdsRepositoryPort = Pick<KdsRepository, 'accept' | 'startPreparing' | 'markReady' | 'cancel' | 'fail'>
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
  }
}

interface KdsTaskLockRow extends Record<string, unknown> {
  id: string
  order_item_id: string
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

export const commerceKdsApiPlugin: FastifyPluginAsync<CommerceKdsApiOptions> = async (
  app,
  options,
) => {
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
      note: input.note,
      settlementMode: input.settlementMode,
      createdByEmployeeId: context.employeeId,
      assistedOrderContext: {
        token: assistedToken,
        employeeId: context.employeeId,
        staffSessionId: context.staffSessionId,
        deviceAccessLeaseId: context.deviceAccessLeaseId,
      },
      kdsOverride: input.kdsOverride,
    })
    return reply.code(execution.replayed ? 200 : 201).send(commerceResponse(execution))
  }))

  app.get('/commerce/fulfillment', async (request, reply) => handleRoute(reply, async () => {
    const context = await resolveContext(options, request)
    await requireAnyPermission(options, context, [
      'order.view',
      KDS_PREPARE_PERMISSION,
      KDS_DELIVER_PERMISSION,
      FULFILLMENT_VIEW_ALL_PERMISSION,
    ])
    const view = await options.fulfillmentQuery.getStaffWorkQueue(context.scope, context.employeeId)
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
      task = await kds.startPreparing(transitionInput('start'))
    } else if (action === 'complete') {
      if (task.status === 'pending') task = await kds.accept(transitionInput('accept'))
      if (task.status === 'accepted') task = await kds.startPreparing(transitionInput('start'))
      task = await kds.markReady(transitionInput('complete'))
    } else if (action === 'fail') {
      task = await kds.fail({
        ...transitionInput('fail'),
        metadata: { requestId, source: 'http_api', reasonCode: reason!.code, reasonNote: reason!.note },
      })
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
    SELECT task.id, task.order_item_id, task.station_code, task.status,
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
      COALESCE(item.product_snapshot -> 'source' ->> 'specification', '') AS specification,
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
  return {
    lines,
    note: readOptionalString(body.fulfillmentNote ?? body.note, 'fulfillmentNote', 500),
    settlementMode: (settlementMode ?? 'table_tab') as 'immediate_payment' | 'table_tab',
    kdsOverride: readKdsOverride(body.kdsOverride),
  }
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

function commerceResponse(execution: CommandExecution<SubmittedCommerceResult>) {
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
      discountAmount: order.discountAmountMinor,
      giftAmount: 0,
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
    remakeOf: null,
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
      reply.request.log.error({ errorCode: safeErrorCode(error) }, 'normalized commerce request failed')
    }
    return reply.code(mapped.statusCode).send(mapped.body)
  }
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
  if (error instanceof PricingAuthorizationDeniedError) {
    return apiError(403, 'PRICING_AUTHORIZATION_DENIED', '折扣或赠送授权无效')
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
