import { createHash } from 'node:crypto'
import { appendAuditEvent, appendOutboxMessage } from './command-executor.js'
import { assertEmployeeTableSessionAccess } from './employee-table-access.js'
import { InventoryRepository } from './inventory-repository.js'
import { StaffAccessRepository } from './staff-access-repository.js'
import type {
  ScopedPostgresTransactionRunner,
  ScopedTransaction,
  StoreScope,
} from './transaction-runner.js'

type TransactionRunner = Pick<ScopedPostgresTransactionRunner, 'run'>

export type ComplimentaryFulfillmentResolutionAction =
  | 'cancel_release'
  | 'external_compensation'

export interface ResolveComplimentaryFulfillmentInput {
  scope: Readonly<StoreScope>
  employeeId: string
  businessDate: string
  intentId: string
  action: ComplimentaryFulfillmentResolutionAction
  reason: string
  compensationReference: string | null
  idempotencyKey: string
}

export interface ComplimentaryFulfillmentResolutionResult {
  id: string
  intentId: string
  orderId: string
  benefitId: string
  status: 'cancelled' | 'compensated'
  action: ComplimentaryFulfillmentResolutionAction
  reason: string
  compensationReference: string | null
  resolvedByEmployeeId: string
  resolvedAt: string
  releasedInventoryReservationCount: number
  releasedCapacityReservationCount: number
  cancelledKdsTaskCount: number
  cancelledOrderItemCount: number
  replayed: boolean
}

interface IntentScopeRow extends Record<string, unknown> {
  table_session_id: string
}

interface LockedIntentRow extends Record<string, unknown> {
  id: string
  order_id: string
  benefit_id: string
  table_session_id: string
  status: string
  attempt_count: number
  last_error_code: string | null
  total_amount_minor: string
  order_status: string
  payment_status: string
  fulfillment_state: string
}

interface ResolutionEventRow extends Record<string, unknown> {
  id: string
  intent_id: string
  order_id: string
  benefit_id: string
  action: ComplimentaryFulfillmentResolutionAction
  reason: string
  compensation_reference: string | null
  employee_id: string
  request_fingerprint: string
  released_inventory_reservation_count: number
  released_capacity_reservation_count: number
  cancelled_kds_task_count: number
  cancelled_order_item_count: number
  created_at: string
}

interface KdsTaskRow extends Record<string, unknown> {
  id: string
  status: string
}

export class ComplimentaryFulfillmentResolutionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ComplimentaryFulfillmentResolutionError'
  }
}

export class ComplimentaryFulfillmentResolutionService {
  constructor(private readonly transactions: TransactionRunner) {}

  async resolve(
    input: Readonly<ResolveComplimentaryFulfillmentInput>,
  ): Promise<ComplimentaryFulfillmentResolutionResult> {
    validateInput(input)
    const requestFingerprint = fingerprint(input)
    return this.transactions.run(input.scope, async (transaction) => {
      await new StaffAccessRepository(transaction)
        .assertPermission(input.employeeId, 'loyalty.redemption.exception')
      await transaction.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`complimentary-resolution:${transaction.scope.tenantId}:${transaction.scope.storeId}:${input.idempotencyKey}`],
      )
      const replay = await findResolutionByIdempotencyKey(transaction, input.idempotencyKey)
      if (replay !== null) {
        if (replay.request_fingerprint !== requestFingerprint
          || replay.intent_id !== input.intentId
          || replay.employee_id !== input.employeeId) {
          throw failure('COMPLIMENTARY_FULFILLMENT_IDEMPOTENCY_CONFLICT', '相同幂等键对应了不同的结案请求')
        }
        return mapResolution(replay, true)
      }
      const scoped = await transaction.query<IntentScopeRow>(`
        SELECT order_row.table_session_id
        FROM mbox.complimentary_fulfillment_intents intent
        JOIN mbox.orders order_row
          ON order_row.tenant_id=intent.tenant_id AND order_row.store_id=intent.store_id
         AND order_row.id=intent.order_id
        WHERE intent.tenant_id=$1::uuid AND intent.store_id=$2::uuid AND intent.id=$3::uuid
      `, [transaction.scope.tenantId, transaction.scope.storeId, input.intentId])
      const tableSessionId = scoped.rows[0]?.table_session_id
      if (!tableSessionId) throw failure('COMPLIMENTARY_FULFILLMENT_NOT_FOUND', '礼遇履约异常不存在')
      await assertEmployeeTableSessionAccess(transaction, {
        employeeId: input.employeeId,
        tableSessionId,
        allTablePermissionCodes: ['table.view_all'],
        lockTableSession: true,
      })
      const intent = await lockIntent(transaction, input.intentId)
      if (intent === null || intent.table_session_id !== tableSessionId) {
        throw failure('COMPLIMENTARY_FULFILLMENT_STATE_CHANGED', '礼遇履约状态已变化，请刷新后处理')
      }
      if (intent.status !== 'failed') {
        throw failure(
          'COMPLIMENTARY_FULFILLMENT_NOT_TERMINAL',
          intent.status === 'retry' || intent.status === 'pending'
            ? '系统仍在重试；只有自动重试已停止后才能取消或补偿结案'
            : '该礼遇履约已处理，不能重复结案',
        )
      }
      if (Number(intent.total_amount_minor) !== 0
        || intent.payment_status !== 'paid'
        || intent.fulfillment_state !== 'active'
        || intent.order_status === 'cancelled') {
        throw failure('COMPLIMENTARY_FULFILLMENT_ORDER_INVALID', '仅可处理仍有效的零元礼遇订单')
      }
      const paymentEvidence = await transaction.query<{ id: string }>(`
        SELECT id FROM mbox.payments
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND order_id=$3::uuid
          AND status IN ('succeeded','partially_refunded','refunded')
        ORDER BY id FOR UPDATE
      `, [transaction.scope.tenantId, transaction.scope.storeId, intent.order_id])
      if (paymentEvidence.rows.length !== 0) {
        throw failure('COMPLIMENTARY_FULFILLMENT_PAYMENT_EXISTS', '订单存在真实支付事实，禁止按零元礼遇结案')
      }
      const orderItems = await transaction.query<{ id: string; status: string }>(`
        SELECT id,status FROM mbox.order_items
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND order_id=$3::uuid
        ORDER BY id FOR UPDATE
      `, [transaction.scope.tenantId, transaction.scope.storeId, intent.order_id])
      if (orderItems.rows.some((item) => ['preparing','ready','delivered'].includes(item.status))) {
        throw failure('COMPLIMENTARY_FULFILLMENT_ALREADY_PREPARING', '商品行已开始制作、等待送达或已经送达，不能释放原订单')
      }
      const tasks = await transaction.query<KdsTaskRow>(`
        SELECT task.id,task.status FROM mbox.kds_tasks task
        JOIN mbox.order_items item
          ON item.tenant_id=task.tenant_id AND item.store_id=task.store_id
         AND item.id=task.order_item_id
        WHERE task.tenant_id=$1::uuid AND task.store_id=$2::uuid AND item.order_id=$3::uuid
        ORDER BY task.id FOR UPDATE OF task
      `, [transaction.scope.tenantId, transaction.scope.storeId, intent.order_id])
      if (tasks.rows.some((task) => ['preparing', 'ready'].includes(task.status))) {
        throw failure('COMPLIMENTARY_FULFILLMENT_ALREADY_PREPARING', '商品已开始制作或等待送达，不能释放库存；请转出品后补偿处理')
      }
      const consumed = await transaction.query<{ id: string }>(`
        SELECT id FROM mbox.inventory_order_reservations
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND order_id=$3::uuid
          AND status IN ('consumed','returned')
        ORDER BY id FOR UPDATE
      `, [transaction.scope.tenantId, transaction.scope.storeId, intent.order_id])
      if (consumed.rows.length !== 0) {
        throw failure('COMPLIMENTARY_FULFILLMENT_INVENTORY_CONSUMED', '库存已经实扣或返库，必须人工核对实物后走出品后补偿流程')
      }
      const reason = input.reason.trim()
      let cancelledKdsTaskCount = 0
      for (const task of tasks.rows) {
        if (['cancelled', 'failed'].includes(task.status)) continue
        const cancelled = await transaction.query(`
          UPDATE mbox.kds_tasks SET status='cancelled',cancelled_at=clock_timestamp()
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
            AND status IN ('pending','accepted')
        `, [transaction.scope.tenantId, transaction.scope.storeId, task.id])
        if (cancelled.rowCount !== 1) {
          throw failure('COMPLIMENTARY_FULFILLMENT_KDS_CHANGED', '出品任务状态已变化，请刷新后重新处理')
        }
        cancelledKdsTaskCount += 1
        await transaction.query(`
          INSERT INTO mbox.kds_task_events(
            tenant_id,store_id,kds_task_id,event_type,from_status,to_status,
            actor_employee_id,metadata,idempotency_key
          ) VALUES($1::uuid,$2::uuid,$3::uuid,'benefit.fulfillment-resolved',$4,'cancelled',
            $5::uuid,$6::jsonb,$7)
        `, [
          transaction.scope.tenantId, transaction.scope.storeId, task.id, task.status,
          input.employeeId, JSON.stringify({ intentId: input.intentId, action: input.action, reason }),
          `benefit-resolution:${input.intentId}:${task.id}`,
        ])
      }
      const releasedInventoryReservationCount=await new InventoryRepository(transaction)
        .releaseImmediatePaymentReservations(intent.order_id,`礼遇出品异常结案：${reason}`)
      const releasedCapacity = await transaction.query(`
        UPDATE mbox.fulfillment_capacity_reservations
        SET status='released',expires_at=NULL,activated_at=NULL,released_at=clock_timestamp(),
          release_reason=$4,updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND order_id=$3::uuid
          AND status IN ('reserved','active')
      `, [transaction.scope.tenantId, transaction.scope.storeId, intent.order_id,
        `礼遇出品异常结案：${reason}`])
      const cancelledItems = await transaction.query(`
        UPDATE mbox.order_items SET status='cancelled'
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND order_id=$3::uuid
          AND status<>'cancelled'
      `, [transaction.scope.tenantId, transaction.scope.storeId, intent.order_id])
      const cancelledOrderItemCount=cancelledItems.rowCount ?? 0
      if (cancelledOrderItemCount < 1) {
        throw failure('COMPLIMENTARY_FULFILLMENT_ORDER_EMPTY', '礼遇订单没有可结案的商品行')
      }
      const cancelledOrder = await transaction.query(`
        UPDATE mbox.orders
        SET status='cancelled',payment_status='unpaid',fulfillment_state='cancelled',
          fulfillment_expires_at=NULL,fulfillment_activated_at=NULL,
          fulfillment_released_at=clock_timestamp(),cancelled_at=clock_timestamp(),
          updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
          AND total_amount_minor=0 AND payment_status='paid' AND fulfillment_state='active'
          AND status<>'cancelled'
      `, [transaction.scope.tenantId, transaction.scope.storeId, intent.order_id])
      if (cancelledOrder.rowCount !== 1) {
        throw failure('COMPLIMENTARY_FULFILLMENT_ORDER_CHANGED', '礼遇订单状态已变化，结案已回滚')
      }
      const terminalStatus = input.action === 'cancel_release' ? 'cancelled' : 'compensated'
      const resolutionReference = input.action === 'external_compensation'
        ? input.compensationReference!.trim() : null
      const releasedCapacityReservationCount=releasedCapacity.rowCount ?? 0
      await updateBenefitFulfillmentProjection(
        transaction, intent, input.action,
      )
      const resolved = await transaction.query(`
        UPDATE mbox.complimentary_fulfillment_intents
        SET status=$4,resolved_by_employee_id=$5::uuid,resolved_at=clock_timestamp(),
          resolution_code=$6,resolution_reason=$7,compensation_reference=$8
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='failed'
      `, [
        transaction.scope.tenantId, transaction.scope.storeId, input.intentId,
        terminalStatus, input.employeeId, input.action, reason, resolutionReference,
      ])
      if (resolved.rowCount !== 1) {
        throw failure('COMPLIMENTARY_FULFILLMENT_STATE_CHANGED', '礼遇履约状态已变化，结案已回滚')
      }
      const inserted = await transaction.query<ResolutionEventRow>(`
        INSERT INTO mbox.complimentary_fulfillment_resolution_events(
          tenant_id,store_id,intent_id,order_id,benefit_id,action,reason,
          compensation_reference,employee_id,idempotency_key,request_fingerprint,
          released_inventory_reservation_count,released_capacity_reservation_count,
          cancelled_kds_task_count,cancelled_order_item_count
        ) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8,$9::uuid,$10,$11,
          $12,$13,$14,$15)
        RETURNING id,intent_id,order_id,benefit_id,action,reason,compensation_reference,
          employee_id,request_fingerprint,released_inventory_reservation_count,
          released_capacity_reservation_count,cancelled_kds_task_count,
          cancelled_order_item_count,created_at::text
      `, [
        transaction.scope.tenantId, transaction.scope.storeId, input.intentId,
        intent.order_id, intent.benefit_id, input.action, reason, resolutionReference,
        input.employeeId, input.idempotencyKey, requestFingerprint,
        releasedInventoryReservationCount, releasedCapacityReservationCount,
        cancelledKdsTaskCount, cancelledOrderItemCount,
      ])
      const resolution = inserted.rows[0]
      if (!resolution) throw new Error('Complimentary fulfillment resolution event was not returned')
      await appendAuditEvent(transaction, {
        actor: { type: 'employee', employeeId: input.employeeId },
        action: input.action === 'cancel_release'
          ? 'loyalty.complimentary-fulfillment.cancelled'
          : 'loyalty.complimentary-fulfillment.compensated',
        objectType: 'complimentary_fulfillment_intent', objectId: input.intentId,
        businessDate: input.businessDate,
        beforeData: {
          status: intent.status, attemptCount: intent.attempt_count,
          lastErrorCode: intent.last_error_code, orderId: intent.order_id,
        },
        afterData: {
          status: terminalStatus, action: input.action,
          compensationReference: resolutionReference,
          releasedInventoryReservationCount,
          releasedCapacityReservationCount,
          cancelledKdsTaskCount, cancelledOrderItemCount,
        },
        reason,
      })
      await appendOutboxMessage(transaction, {
        businessEventKey: `benefit-gift-fulfillment-resolved:${input.intentId}`,
        aggregateType: 'order', aggregateId: intent.order_id, aggregateVersion: 3,
        eventType: 'benefit.gift.fulfillment-resolved.v1',
        payload: {
          intentId: input.intentId, orderId: intent.order_id, benefitId: intent.benefit_id,
          action: input.action, status: terminalStatus, employeeId: input.employeeId,
          compensationReference: resolutionReference,
        },
      })
      return mapResolution(resolution, false)
    })
  }
}

async function lockIntent(
  transaction: ScopedTransaction,
  intentId: string,
): Promise<LockedIntentRow | null> {
  const locked = await transaction.query<LockedIntentRow>(`
    SELECT intent.id,intent.order_id,intent.benefit_id,intent.status,intent.attempt_count,
      intent.last_error_code,order_row.table_session_id,order_row.total_amount_minor::text,
      order_row.status AS order_status,order_row.payment_status,order_row.fulfillment_state
    FROM mbox.complimentary_fulfillment_intents intent
    JOIN mbox.orders order_row
      ON order_row.tenant_id=intent.tenant_id AND order_row.store_id=intent.store_id
     AND order_row.id=intent.order_id
    WHERE intent.tenant_id=$1::uuid AND intent.store_id=$2::uuid AND intent.id=$3::uuid
    FOR UPDATE OF intent,order_row
  `, [transaction.scope.tenantId, transaction.scope.storeId, intentId])
  return locked.rows[0] ?? null
}

async function findResolutionByIdempotencyKey(
  transaction: ScopedTransaction,
  idempotencyKey: string,
): Promise<ResolutionEventRow | null> {
  const result = await transaction.query<ResolutionEventRow>(`
    SELECT id,intent_id,order_id,benefit_id,action,reason,compensation_reference,
      employee_id,request_fingerprint,released_inventory_reservation_count,
      released_capacity_reservation_count,cancelled_kds_task_count,
      cancelled_order_item_count,created_at::text
    FROM mbox.complimentary_fulfillment_resolution_events
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND idempotency_key=$3
    LIMIT 1
  `, [transaction.scope.tenantId, transaction.scope.storeId, idempotencyKey])
  return result.rows[0] ?? null
}

async function updateBenefitFulfillmentProjection(
  transaction: ScopedTransaction,
  intent: LockedIntentRow,
  action: ComplimentaryFulfillmentResolutionAction,
): Promise<void> {
  if (action === 'cancel_release') {
    await transaction.query(`
      UPDATE mbox.annual_daily_snack_claims
      SET status='cancelled_after_redemption',updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND gift_order_id=$3::uuid
        AND status='redeemed'
    `, [transaction.scope.tenantId, transaction.scope.storeId, intent.order_id])
    await transaction.query(`
      UPDATE mbox.membership_annual_benefit_grants
      SET status='revoked',updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND benefit_id=$3::uuid
        AND status='active'
    `, [transaction.scope.tenantId, transaction.scope.storeId, intent.benefit_id])
    return
  }
  await transaction.query(`
    UPDATE mbox.annual_daily_snack_claims
    SET status='compensated',fulfilled_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND gift_order_id=$3::uuid
      AND status='redeemed'
  `, [transaction.scope.tenantId, transaction.scope.storeId, intent.order_id])
  await transaction.query(`
    UPDATE mbox.membership_annual_benefit_grants
    SET status='fulfilled',updated_at=clock_timestamp()
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND benefit_id=$3::uuid
      AND status='active'
  `, [transaction.scope.tenantId, transaction.scope.storeId, intent.benefit_id])
}

function mapResolution(
  row: ResolutionEventRow,
  replayed: boolean,
): ComplimentaryFulfillmentResolutionResult {
  return {
    id: row.id,
    intentId: row.intent_id,
    orderId: row.order_id,
    benefitId: row.benefit_id,
    status: row.action === 'cancel_release' ? 'cancelled' : 'compensated',
    action: row.action,
    reason: row.reason,
    compensationReference: row.compensation_reference,
    resolvedByEmployeeId: row.employee_id,
    resolvedAt: row.created_at,
    releasedInventoryReservationCount: Number(row.released_inventory_reservation_count),
    releasedCapacityReservationCount: Number(row.released_capacity_reservation_count),
    cancelledKdsTaskCount: Number(row.cancelled_kds_task_count),
    cancelledOrderItemCount: Number(row.cancelled_order_item_count),
    replayed,
  }
}

function fingerprint(input: Readonly<ResolveComplimentaryFulfillmentInput>): string {
  return createHash('sha256').update(JSON.stringify({
    intentId: input.intentId,
    action: input.action,
    reason: input.reason.trim(),
    compensationReference: input.compensationReference?.trim() ?? null,
  })).digest('hex')
}

function validateInput(input: Readonly<ResolveComplimentaryFulfillmentInput>): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.intentId)) {
    throw failure('COMPLIMENTARY_FULFILLMENT_REQUEST_INVALID', '履约任务格式不正确')
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.employeeId)) {
    throw failure('COMPLIMENTARY_FULFILLMENT_REQUEST_INVALID', '员工身份格式不正确')
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate)) {
    throw failure('COMPLIMENTARY_FULFILLMENT_REQUEST_INVALID', '营业日格式不正确')
  }
  if (!['cancel_release', 'external_compensation'].includes(input.action)) {
    throw failure('COMPLIMENTARY_FULFILLMENT_REQUEST_INVALID', '不支持的礼遇结案方式')
  }
  const reasonLength = input.reason.trim().length
  if (reasonLength < 2 || reasonLength > 500) {
    throw failure('COMPLIMENTARY_FULFILLMENT_REQUEST_INVALID', '结案原因必须为2至500个字')
  }
  const compensationReference = input.compensationReference?.trim() ?? ''
  if (input.action === 'cancel_release' && compensationReference.length !== 0) {
    throw failure('COMPLIMENTARY_FULFILLMENT_REQUEST_INVALID', '取消释放不能填写线下补偿凭证')
  }
  if (input.action === 'external_compensation'
    && (compensationReference.length < 2 || compensationReference.length > 200)) {
    throw failure('COMPLIMENTARY_FULFILLMENT_REQUEST_INVALID', '线下补偿必须填写2至200个字的凭证或事件编号')
  }
  if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 128) {
    throw failure('COMPLIMENTARY_FULFILLMENT_REQUEST_INVALID', '幂等键格式不正确')
  }
}

function failure(code: string, message: string): ComplimentaryFulfillmentResolutionError {
  return new ComplimentaryFulfillmentResolutionError(code, message)
}
