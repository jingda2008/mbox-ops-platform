import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto'
import type { PaymentMethod, PaymentProvider } from './payment-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'
import { lockBoundGuestTablePosition } from './guest-table-authority.js'

export type ProviderPresentation = 'jsapi' | 'qr' | 'barcode'
export type ProviderActionPayload = Readonly<Record<string, unknown>>

export interface ProviderPaymentContext {
  id: string
  payableKind: 'order' | 'activity_registration' | 'order_batch'
  orderId: string | null
  orderPublicId: string | null
  activityRegistrationId: string | null
  activityRegistrationPublicId: string | null
  publicId: string
  provider: PaymentProvider
  providerTransactionId: string | null
  method: PaymentMethod
  amountMinor: number
  currency: string
  status: string
  customerId: string | null
  tableSessionId: string | null
  tableCode: string | null
  createdAt: string
}

export type AutomaticPaymentQueryOutcome = 'processing' | 'error' | 'terminal'
export type AutomaticRefundQueryOutcome = 'processing' | 'error' | 'terminal'

export type PaymentPrincipal =
  | { type: 'employee'; employeeId: string }
  | { type: 'guest'; tableSessionId: string | null; customerId: string; guestSessionId?: string }

interface ContextRow extends Record<string, unknown> {
  id: string
  payable_kind: ProviderPaymentContext['payableKind']
  order_id: string | null
  order_public_id: string | null
  activity_registration_id: string | null
  activity_registration_public_id: string | null
  public_id: string
  provider: PaymentProvider
  provider_transaction_id: string | null
  method: PaymentMethod
  amount_minor: string | number
  currency: string
  status: string
  customer_id: string | null
  table_session_id: string | null
  table_code: string | null
  created_at: string
}

interface ActionRow extends Record<string, unknown> {
  presentation: ProviderPresentation
  initiated_by_type: PaymentPrincipal['type']
  initiated_by_ref: string
  state: 'creating' | 'ready' | 'unknown' | 'failed' | 'consumed'
  ciphertext: Buffer | null
  nonce: Buffer | null
  auth_tag: Buffer | null
  expires_at: string
  updated_at: string
  request_idempotency_key: string | null
  request_fingerprint: string | null
}

export class ProviderPaymentInProgressError extends Error {
  constructor() {
    super('付款正在发起，请勿重复操作')
    this.name = 'ProviderPaymentInProgressError'
  }
}

export class ProviderPaymentMethodConflictError extends Error {
  constructor(message = '这笔订单已有其他付款方式正在处理，请先核对付款状态') {
    super(message)
    this.name = 'ProviderPaymentMethodConflictError'
  }
}

export class ProviderPaymentUnknownError extends Error {
  constructor() {
    super('支付结果暂时无法确认，请先查单，不要重复收款')
    this.name = 'ProviderPaymentUnknownError'
  }
}

// The public order id alone is never enough to resume a guest payment.  Keep
// these two failures explicit so the HTTP boundary can fail closed without
// logging an expected cross-table race as an internal error.
export class GuestOrderPaymentAccessError extends Error {
  constructor(readonly reason: 'order_not_in_current_table' | 'guest_not_at_current_table') {
    super(reason === 'order_not_in_current_table'
      ? '这笔订单不属于当前桌位，请重新扫描桌面二维码后核对'
      : '当前客人未关联到这桌，请重新扫描桌面二维码')
    this.name = 'GuestOrderPaymentAccessError'
  }
}

/**
 * A passive status read is deliberately narrower than a provider query. The
 * employee who created a presentation may observe its result, but cannot use
 * an opaque payment id to inspect another employee's payment.
 */
export class ProviderPaymentStatusAccessError extends Error {
  constructor() {
    super('当前员工无权查看这笔协助收款状态')
    this.name = 'ProviderPaymentStatusAccessError'
  }
}

export class WechatPaymentIdentityRequiredError extends Error {
  constructor() {
    super('微信支付身份需要刷新，请重新进入小程序后再试')
    this.name = 'WechatPaymentIdentityRequiredError'
  }
}

export class PaymentProviderActionRepository {
  private readonly key: Buffer

  constructor(
    private readonly transaction: ScopedTransaction,
    secret: string,
  ) {
    this.key = createHash('sha256').update(secret).update(':payment-provider-action:v1').digest()
  }

  async resolvePaymentContext(
    paymentId: string,
    principal: Readonly<PaymentPrincipal>,
    options: Readonly<{ lock?: boolean }> = {},
  ): Promise<ProviderPaymentContext> {
    const lockClause = options.lock === false ? '' : 'FOR SHARE OF payment'
    const result = await this.transaction.query<ContextRow>(`
      SELECT payment.id, payment.payable_kind, payment.order_id,
        ordering.public_id AS order_public_id,
        payment.activity_registration_id,
        activity_registration.public_id AS activity_registration_public_id,
        payment.public_id, payment.provider, payment.provider_transaction_id,
        payment.method, payment.amount_minor,
        payment.currency, payment.status, payment.created_at::text,
        activity_registration.customer_id,
        COALESCE(ordering.table_session_id,payment_batch.table_session_id) AS table_session_id, venue_table.code AS table_code
      FROM mbox.payments payment
      LEFT JOIN mbox.orders ordering
        ON ordering.tenant_id = payment.tenant_id
       AND ordering.store_id = payment.store_id
       AND ordering.id = payment.order_id
      LEFT JOIN mbox.order_payment_batches payment_batch
        ON payment_batch.tenant_id=payment.tenant_id AND payment_batch.store_id=payment.store_id AND payment_batch.id=payment.order_batch_id
      LEFT JOIN mbox.table_sessions table_session
        ON table_session.tenant_id = payment.tenant_id
       AND table_session.store_id = payment.store_id
       AND table_session.id = COALESCE(ordering.table_session_id,payment_batch.table_session_id)
      LEFT JOIN mbox.tables venue_table
        ON venue_table.tenant_id = table_session.tenant_id
       AND venue_table.store_id = table_session.store_id
       AND venue_table.id = table_session.table_id
      LEFT JOIN mbox.community_activity_registrations activity_registration
        ON activity_registration.tenant_id = payment.tenant_id
       AND activity_registration.store_id = payment.store_id
       AND activity_registration.id = payment.activity_registration_id
      WHERE payment.tenant_id = $1::uuid
        AND payment.store_id = $2::uuid
        AND payment.id = $3::uuid
      ${lockClause}
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, paymentId])
    const row = result.rows[0]
    if (row === undefined) throw new Error('支付记录不存在')
    await this.assertAccess(row, principal)
    return mapContext(row)
  }

  async resolvePaymentContextForSystem(
    paymentId: string,
    options: Readonly<{ lock?: boolean }> = {},
  ): Promise<ProviderPaymentContext> {
    const lockClause = options.lock === false ? '' : 'FOR SHARE OF payment'
    const result = await this.transaction.query<ContextRow>(`
      SELECT payment.id, payment.payable_kind, payment.order_id,
        ordering.public_id AS order_public_id,
        payment.activity_registration_id,
        activity_registration.public_id AS activity_registration_public_id,
        payment.public_id, payment.provider, payment.provider_transaction_id,
        payment.method, payment.amount_minor,
        payment.currency, payment.status, payment.created_at::text,
        activity_registration.customer_id,
        COALESCE(ordering.table_session_id,payment_batch.table_session_id) AS table_session_id, venue_table.code AS table_code
      FROM mbox.payments payment
      LEFT JOIN mbox.orders ordering
        ON ordering.tenant_id = payment.tenant_id
       AND ordering.store_id = payment.store_id
       AND ordering.id = payment.order_id
      LEFT JOIN mbox.order_payment_batches payment_batch
        ON payment_batch.tenant_id=payment.tenant_id AND payment_batch.store_id=payment.store_id AND payment_batch.id=payment.order_batch_id
      LEFT JOIN mbox.table_sessions table_session
        ON table_session.tenant_id = payment.tenant_id
       AND table_session.store_id = payment.store_id
       AND table_session.id = COALESCE(ordering.table_session_id,payment_batch.table_session_id)
      LEFT JOIN mbox.tables venue_table
        ON venue_table.tenant_id = table_session.tenant_id
       AND venue_table.store_id = table_session.store_id
       AND venue_table.id = table_session.table_id
      LEFT JOIN mbox.community_activity_registrations activity_registration
        ON activity_registration.tenant_id = payment.tenant_id
       AND activity_registration.store_id = payment.store_id
       AND activity_registration.id = payment.activity_registration_id
      WHERE payment.tenant_id = $1::uuid
        AND payment.store_id = $2::uuid
        AND payment.id = $3::uuid
      ${lockClause}
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, paymentId])
    const row = result.rows[0]
    if (row === undefined) throw new Error('支付记录不存在')
    return mapContext(row)
  }

  async listStalePendingPostarPaymentIds(
    minAgeSeconds: number,
    limit: number,
  ): Promise<string[]> {
    await this.seedAutomaticReconciliationStates(false, minAgeSeconds)
    const result = await this.transaction.query<{ id: string }>(`
      WITH due AS (
        SELECT state.payment_id
        FROM mbox.payment_reconciliation_states state
        JOIN mbox.payments payment
          ON payment.tenant_id=state.tenant_id AND payment.store_id=state.store_id
         AND payment.id=state.payment_id
        WHERE state.tenant_id=$1::uuid AND state.store_id=$2::uuid
          AND state.phase<>'stopped'
          AND state.next_query_at<=clock_timestamp()
          AND (state.lease_until IS NULL OR state.lease_until<clock_timestamp())
          AND payment.provider='postar' AND payment.status IN ('created','pending')
          AND payment.created_at<=clock_timestamp()-make_interval(secs=>$3::integer)
          AND NOT EXISTS (
            SELECT 1 FROM mbox.orders ordering
            WHERE ordering.tenant_id=payment.tenant_id AND ordering.store_id=payment.store_id
              AND ordering.id=payment.order_id AND ordering.channel='guest_qr'
              AND ordering.settlement_mode='immediate_payment' AND payment.method='jsapi'
          )
        ORDER BY state.next_query_at,payment.created_at,payment.id
        FOR UPDATE OF state SKIP LOCKED
        LIMIT $4::integer
      )
      UPDATE mbox.payment_reconciliation_states state
      SET last_queried_at=clock_timestamp(),lease_until=clock_timestamp()+interval '2 minutes',
        total_query_count=state.total_query_count+1,updated_at=clock_timestamp()
      FROM due
      WHERE state.payment_id=due.payment_id
      RETURNING state.payment_id AS id
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, minAgeSeconds, limit])
    return result.rows.map((row) => row.id)
  }

  private async seedAutomaticReconciliationStates(
    guestImmediate: boolean,
    minAgeSeconds: number,
  ): Promise<void> {
    await this.transaction.query(`
      INSERT INTO mbox.payment_reconciliation_states(
        payment_id,tenant_id,store_id,phase,next_query_at,released_at
      )
      SELECT payment.id,payment.tenant_id,payment.store_id,
        CASE WHEN payment.retry_released_at IS NOT NULL
          OR COALESCE(ordering.status='cancelled',false)
          OR COALESCE(action.expires_at<=clock_timestamp(),true)
          OR abandonment.payment_id IS NOT NULL
          THEN 'released' ELSE 'interactive' END,
        clock_timestamp(),
        CASE WHEN payment.retry_released_at IS NOT NULL
          OR COALESCE(ordering.status='cancelled',false)
          OR COALESCE(action.expires_at<=clock_timestamp(),true)
          OR abandonment.payment_id IS NOT NULL
          THEN clock_timestamp() ELSE NULL END
      FROM mbox.payments payment
      LEFT JOIN mbox.orders ordering
        ON ordering.tenant_id=payment.tenant_id AND ordering.store_id=payment.store_id
       AND ordering.id=payment.order_id
      LEFT JOIN mbox.payment_provider_actions action
        ON action.tenant_id=payment.tenant_id AND action.store_id=payment.store_id
       AND action.payment_id=payment.id
      LEFT JOIN mbox.guest_immediate_checkout_abandonment_events abandonment
        ON abandonment.tenant_id=payment.tenant_id AND abandonment.store_id=payment.store_id
       AND abandonment.payment_id=payment.id
      WHERE payment.tenant_id = $1::uuid
        AND payment.store_id = $2::uuid
        AND payment.provider = 'postar'
        AND payment.status IN ('created', 'pending')
        AND payment.created_at <= clock_timestamp() - make_interval(secs => $3::integer)
        AND (COALESCE(ordering.channel='guest_qr' AND ordering.settlement_mode='immediate_payment'
              AND payment.method='jsapi',false)=$4::boolean)
      ON CONFLICT (payment_id) DO UPDATE SET
        phase=CASE
          WHEN mbox.payment_reconciliation_states.phase='interactive'
            AND (EXCLUDED.phase='released') THEN 'released'
          ELSE mbox.payment_reconciliation_states.phase END,
        released_at=CASE
          WHEN mbox.payment_reconciliation_states.phase='interactive'
            AND EXCLUDED.phase='released'
          THEN COALESCE(mbox.payment_reconciliation_states.released_at,clock_timestamp())
          ELSE mbox.payment_reconciliation_states.released_at END,
        updated_at=CASE
          WHEN mbox.payment_reconciliation_states.phase='interactive'
            AND EXCLUDED.phase='released' THEN clock_timestamp()
          ELSE mbox.payment_reconciliation_states.updated_at END
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, minAgeSeconds, guestImmediate])
  }

  async listStaleProcessingPostarRefundIds(
    minAgeSeconds: number,
    limit: number,
  ): Promise<string[]> {
    await this.transaction.query(`
      INSERT INTO mbox.refund_reconciliation_states(
        refund_id,tenant_id,store_id,next_query_at
      )
      SELECT refund.id,refund.tenant_id,refund.store_id,clock_timestamp()
      FROM mbox.refunds refund
      JOIN mbox.payments payment
        ON payment.tenant_id=refund.tenant_id AND payment.store_id=refund.store_id
       AND payment.id=refund.payment_id
      WHERE refund.tenant_id=$1::uuid AND refund.store_id=$2::uuid
        AND refund.status='processing'
        AND refund.provider_submission_state IN ('submitting','submitted')
        AND refund.merchant_refund_id IS NOT NULL
        AND payment.provider='postar'
        AND refund.updated_at<=clock_timestamp()-make_interval(secs=>$3::integer)
      ON CONFLICT (refund_id) DO NOTHING
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, minAgeSeconds])
    // StarPay's refund-query contract supports the original refund date for
    // only 60 days. Stop provider I/O after that boundary while retaining the
    // refund itself as an explicit finance-review item.
    await this.transaction.query(`
      UPDATE mbox.refund_reconciliation_states state
      SET phase='stopped',lease_until=NULL,
        automatic_query_stopped_at=COALESCE(automatic_query_stopped_at,clock_timestamp()),
        stop_reason='provider_query_window_expired',updated_at=clock_timestamp()
      FROM mbox.refunds refund
      WHERE state.tenant_id=$1::uuid AND state.store_id=$2::uuid
        AND refund.tenant_id=state.tenant_id AND refund.store_id=state.store_id
        AND refund.id=state.refund_id AND state.phase<>'stopped'
        AND refund.status='processing'
        AND refund.provider_submission_started_at<=clock_timestamp()-interval '60 days'
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId])
    const result = await this.transaction.query<{ id: string }>(`
      WITH due AS (
        SELECT state.refund_id
        FROM mbox.refund_reconciliation_states state
        JOIN mbox.refunds refund
          ON refund.tenant_id=state.tenant_id AND refund.store_id=state.store_id
         AND refund.id=state.refund_id
        JOIN mbox.payments payment
          ON payment.tenant_id=refund.tenant_id AND payment.store_id=refund.store_id
         AND payment.id=refund.payment_id
        WHERE state.tenant_id=$1::uuid AND state.store_id=$2::uuid
          AND state.phase<>'stopped'
          AND state.next_query_at<=clock_timestamp()
          AND (state.lease_until IS NULL OR state.lease_until<clock_timestamp())
          AND refund.status='processing'
          AND refund.provider_submission_state IN ('submitting','submitted')
          AND refund.merchant_refund_id IS NOT NULL
          AND payment.provider='postar'
          AND refund.updated_at<=clock_timestamp()-make_interval(secs=>$3::integer)
        ORDER BY state.next_query_at,refund.updated_at,refund.id
        FOR UPDATE OF state SKIP LOCKED
        LIMIT $4::integer
      )
      UPDATE mbox.refund_reconciliation_states state
      SET last_queried_at=clock_timestamp(),lease_until=clock_timestamp()+interval '2 minutes',
        total_query_count=state.total_query_count+1,updated_at=clock_timestamp()
      FROM due
      WHERE state.refund_id=due.refund_id
      RETURNING state.refund_id AS id
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, minAgeSeconds, limit])
    return result.rows.map((row) => row.id)
  }

  async recordAutomaticRefundQueryOutcome(
    refundId: string,
    outcome: AutomaticRefundQueryOutcome,
    observedStatus?: string,
  ): Promise<void> {
    const result = await this.transaction.query<{ total_query_count: number }>(`
      SELECT total_query_count
      FROM mbox.refund_reconciliation_states
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND refund_id=$3::uuid
        AND phase<>'stopped'
      FOR UPDATE
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,refundId])
    const row = result.rows[0]
    if (row === undefined) return
    if (outcome === 'terminal') {
      await this.transaction.query(`
        UPDATE mbox.refund_reconciliation_states
        SET phase='stopped',lease_until=NULL,last_observed_status=$4,
          automatic_query_stopped_at=clock_timestamp(),stop_reason='provider_terminal_result',
          updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND refund_id=$3::uuid
      `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,refundId,observedStatus ?? null])
      return
    }
    const count = row.total_query_count
    const phase = count >= 12 ? 'finance_review' : 'active'
    const delay = count <= 1 ? '1 minute'
      : count === 2 ? '5 minutes'
        : count === 3 ? '15 minutes'
          : count <= 5 ? '1 hour' : '6 hours'
    await this.transaction.query(`
      UPDATE mbox.refund_reconciliation_states
      SET phase=$4,next_query_at=clock_timestamp()+$5::interval,lease_until=NULL,
        last_observed_status=COALESCE($6,last_observed_status),
        consecutive_processing_count=CASE WHEN $7='processing'
          THEN consecutive_processing_count+1 ELSE 0 END,
        consecutive_error_count=CASE WHEN $7='error'
          THEN consecutive_error_count+1 ELSE 0 END,
        updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND refund_id=$3::uuid
    `, [
      this.transaction.scope.tenantId,this.transaction.scope.storeId,refundId,
      phase,delay,observedStatus ?? null,outcome,
    ])
  }

  async listStaleGuestImmediateCheckoutPaymentCandidates(
    minAgeSeconds: number,
    limit: number,
  ): Promise<Array<{ id: string; createdAt: string; operationallyAbandoned: boolean }>> {
    await this.seedAutomaticReconciliationStates(true, minAgeSeconds)
    const result = await this.transaction.query<{
      id: string
      created_at: string
      operationally_abandoned: boolean
    }>(`
      WITH due AS (
        SELECT state.payment_id
        FROM mbox.payment_reconciliation_states state
        JOIN mbox.payments payment
          ON payment.tenant_id=state.tenant_id AND payment.store_id=state.store_id
         AND payment.id=state.payment_id
        JOIN mbox.orders ordering
          ON ordering.tenant_id=payment.tenant_id AND ordering.store_id=payment.store_id
         AND ordering.id=payment.order_id
        WHERE state.tenant_id=$1::uuid AND state.store_id=$2::uuid
          AND state.phase<>'stopped'
          AND state.next_query_at<=clock_timestamp()
          AND (state.lease_until IS NULL OR state.lease_until<clock_timestamp())
          AND payment.provider='postar' AND payment.method='jsapi'
          AND payment.status IN ('created','pending')
          AND ordering.channel='guest_qr' AND ordering.settlement_mode='immediate_payment'
          AND (payment.created_at<=clock_timestamp()-make_interval(secs=>$3::integer)
            OR ordering.status='cancelled'
            OR EXISTS (SELECT 1 FROM mbox.guest_immediate_checkout_abandonment_events abandonment
              WHERE abandonment.tenant_id=payment.tenant_id AND abandonment.store_id=payment.store_id
                AND abandonment.payment_id=payment.id))
        ORDER BY state.next_query_at,payment.created_at,payment.id
        FOR UPDATE OF state SKIP LOCKED
        LIMIT $4::integer
      ), claimed AS (
        UPDATE mbox.payment_reconciliation_states state
        SET last_queried_at=clock_timestamp(),lease_until=clock_timestamp()+interval '2 minutes',
          total_query_count=state.total_query_count+1,updated_at=clock_timestamp()
        FROM due WHERE state.payment_id=due.payment_id
        RETURNING state.payment_id
      )
      SELECT payment.id,payment.created_at::text,
        (ordering.status='cancelled' OR EXISTS (
          SELECT 1 FROM mbox.guest_immediate_checkout_abandonment_events AS abandonment
          WHERE abandonment.tenant_id=payment.tenant_id AND abandonment.store_id=payment.store_id
            AND abandonment.payment_id=payment.id
        )) AS operationally_abandoned
      FROM mbox.payments AS payment
      JOIN mbox.orders AS ordering
        ON ordering.tenant_id=payment.tenant_id AND ordering.store_id=payment.store_id
       AND ordering.id=payment.order_id
      JOIN claimed ON claimed.payment_id=payment.id
      ORDER BY payment.created_at,payment.id
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,minAgeSeconds,limit])
    return result.rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      operationallyAbandoned: row.operationally_abandoned === true,
    }))
  }

  async recordAutomaticPaymentQueryOutcome(
    paymentId: string,
    outcome: AutomaticPaymentQueryOutcome,
    observedStatus?: string,
    forceReleased = false,
  ): Promise<void> {
    const locked = await this.transaction.query<{
      phase: 'interactive' | 'released' | 'finance_review' | 'stopped'
      released_query_count: number
      operationally_released: boolean
      tracking_window_expired: boolean
      recent_payment: boolean
    }>(`
      SELECT state.phase,state.released_query_count,
        ($4::boolean OR payment.retry_released_at IS NOT NULL
          OR COALESCE(ordering.status='cancelled',false)
          OR COALESCE(action.expires_at<=clock_timestamp(),true)
          OR abandonment.payment_id IS NOT NULL) AS operationally_released,
        payment.created_at<=clock_timestamp()-interval '7 days' AS tracking_window_expired,
        payment.created_at>clock_timestamp()-interval '24 hours' AS recent_payment
      FROM mbox.payment_reconciliation_states state
      JOIN mbox.payments payment
        ON payment.tenant_id=state.tenant_id AND payment.store_id=state.store_id
       AND payment.id=state.payment_id
      LEFT JOIN mbox.orders ordering
        ON ordering.tenant_id=payment.tenant_id AND ordering.store_id=payment.store_id
       AND ordering.id=payment.order_id
      LEFT JOIN mbox.payment_provider_actions action
        ON action.tenant_id=payment.tenant_id AND action.store_id=payment.store_id
       AND action.payment_id=payment.id
      LEFT JOIN mbox.guest_immediate_checkout_abandonment_events abandonment
        ON abandonment.tenant_id=payment.tenant_id AND abandonment.store_id=payment.store_id
       AND abandonment.payment_id=payment.id
      WHERE state.tenant_id=$1::uuid AND state.store_id=$2::uuid AND state.payment_id=$3::uuid
      FOR UPDATE OF state
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,paymentId,forceReleased])
    const row = locked.rows[0]
    if (row === undefined || row.phase === 'stopped') return
    if (outcome === 'terminal') {
      await this.transaction.query(`
        UPDATE mbox.payment_reconciliation_states
        SET phase='stopped',next_query_at=NULL,lease_until=NULL,last_observed_status=$4,
          automatic_query_stopped_at=clock_timestamp(),stop_reason='provider_terminal_result',
          updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND payment_id=$3::uuid
      `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,paymentId,observedStatus ?? null])
      return
    }
    const released = forceReleased || row.operationally_released || row.phase !== 'interactive'
    const releasedQueryCount = row.released_query_count + (released ? 1 : 0)
    // Xingyi does not expose one universal expiry timestamp for every channel.
    // Preserve a conservative seven-day financial window while moving a
    // released payment to hours/days instead of page-speed polling.
    const stop = released && row.tracking_window_expired
    const confirmedApplicationFailure = outcome === 'error' && observedStatus === 'succeeded'
    const delay = confirmedApplicationFailure ? '1 minute' : !released ? '30 seconds'
      : outcome === 'error'
        ? row.recent_payment
          ? releasedQueryCount <= 3 ? '1 minute' : '5 minutes'
          : '1 hour'
        : releasedQueryCount === 1 ? '5 minutes'
          : releasedQueryCount === 2 ? '15 minutes'
            : releasedQueryCount === 3 ? '1 hour'
              : releasedQueryCount <= 5 ? '6 hours' : '24 hours'
    await this.transaction.query(`
      UPDATE mbox.payment_reconciliation_states
      SET phase=$4,next_query_at=CASE WHEN $5::boolean THEN NULL
          ELSE clock_timestamp()+$6::interval END,
        lease_until=NULL,last_observed_status=COALESCE($7,last_observed_status),
        consecutive_processing_count=CASE WHEN $8='processing'
          THEN consecutive_processing_count+1 ELSE 0 END,
        consecutive_error_count=CASE WHEN $8='error'
          THEN consecutive_error_count+1 ELSE 0 END,
        released_query_count=$9,
        released_at=CASE WHEN $10::boolean THEN COALESCE(released_at,clock_timestamp()) ELSE released_at END,
        automatic_query_stopped_at=CASE WHEN $5::boolean THEN clock_timestamp() ELSE NULL END,
        stop_reason=CASE WHEN $5::boolean THEN 'finance_review_required' ELSE NULL END,
        updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND payment_id=$3::uuid
    `, [
      this.transaction.scope.tenantId,this.transaction.scope.storeId,paymentId,
      stop ? 'stopped' : released ? 'released' : 'interactive',stop,delay,
      observedStatus ?? null,outcome,releasedQueryCount,released,
    ])
  }

  async resolveInitiatedPaymentStatus(
    paymentId: string,
    principal: Readonly<PaymentPrincipal>,
  ): Promise<ProviderPaymentContext> {
    const context = await this.resolvePaymentContext(paymentId, principal, { lock: false })
    const action = await this.transaction.query<{
      initiated_by_type: PaymentPrincipal['type']
      initiated_by_ref: string
    }>(`
      SELECT initiated_by_type, initiated_by_ref::text
      FROM mbox.payment_provider_actions
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND payment_id = $3::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, paymentId])
    const owner = action.rows[0]
    if (owner === undefined
      || owner.initiated_by_type !== principal.type
      || owner.initiated_by_ref !== principalReference(principal)) {
      throw new ProviderPaymentStatusAccessError()
    }
    return context
  }

  async resolveOrderForGuest(
    orderPublicId: string,
    principal: Extract<PaymentPrincipal, { type: 'guest' }>,
  ): Promise<{ orderId: string; activePaymentId: string | null }> {
    if (principal.tableSessionId === null) {
      throw new GuestOrderPaymentAccessError('guest_not_at_current_table')
    }
    const linked = await this.transaction.query<{ order_id: string; payment_id: string | null }>(`
      SELECT ordering.id AS order_id,
        (
          SELECT payment.id
          FROM mbox.payments payment
          WHERE payment.tenant_id = ordering.tenant_id
            AND payment.store_id = ordering.store_id
            AND payment.order_id = ordering.id
            AND payment.status IN ('created', 'pending')
            AND payment.retry_released_at IS NULL
          ORDER BY payment.created_at DESC, payment.id DESC
          LIMIT 1
        ) AS payment_id
      FROM mbox.orders ordering
      WHERE ordering.tenant_id = $1::uuid
        AND ordering.store_id = $2::uuid
        AND ordering.public_id = $3
        AND ordering.table_session_id = $4::uuid
        AND ordering.status NOT IN ('draft', 'cancelled')
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      orderPublicId,
      principal.tableSessionId,
    ])
    const row = linked.rows[0]
    if (row === undefined) throw new GuestOrderPaymentAccessError('order_not_in_current_table')
    if (principal.guestSessionId===undefined || !await lockBoundGuestTablePosition(this.transaction,{
      tableSessionId:principal.tableSessionId,customerId:principal.customerId,
      actorRef:`guest-session:${principal.guestSessionId}`,
    })) throw new GuestOrderPaymentAccessError('guest_not_at_current_table')
    return { orderId: row.order_id, activePaymentId: row.payment_id }
  }

  async resolveActivePaymentForOrder(
    orderId: string,
    principal: Readonly<PaymentPrincipal>,
  ): Promise<ProviderPaymentContext | null> {
    const result = await this.transaction.query<ContextRow>(`
      SELECT payment.id, payment.payable_kind, payment.order_id,
        ordering.public_id AS order_public_id,
        NULL::uuid AS activity_registration_id,
        NULL::text AS activity_registration_public_id,
        payment.public_id, payment.provider, payment.provider_transaction_id,
        payment.method, payment.amount_minor,
        payment.currency, payment.status, payment.created_at::text,
        NULL::uuid AS customer_id,
        COALESCE(ordering.table_session_id,payment_batch.table_session_id) AS table_session_id, venue_table.code AS table_code
      FROM mbox.payments payment
      JOIN mbox.orders ordering
        ON ordering.tenant_id = payment.tenant_id
       AND ordering.store_id = payment.store_id
       AND ordering.id = payment.order_id
      JOIN mbox.table_sessions table_session
        ON table_session.tenant_id = ordering.tenant_id
       AND table_session.store_id = ordering.store_id
       AND table_session.id = ordering.table_session_id
      JOIN mbox.tables venue_table
        ON venue_table.tenant_id = table_session.tenant_id
       AND venue_table.store_id = table_session.store_id
       AND venue_table.id = table_session.table_id
      WHERE payment.tenant_id = $1::uuid
        AND payment.store_id = $2::uuid
        AND payment.order_id = $3::uuid
        AND payment.status IN ('created', 'pending')
        AND payment.retry_released_at IS NULL
      ORDER BY payment.created_at DESC, payment.id DESC
      LIMIT 1
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, orderId])
    const row = result.rows[0]
    if (row === undefined) return null
    await this.assertAccess(row, principal)
    return mapContext(row)
  }

  async claim(
    paymentId: string,
    presentation: ProviderPresentation,
    expiresAt: string,
    principal: Readonly<PaymentPrincipal>,
    idempotencyKey?: string,
    sensitiveRequestBinding?: string,
    clientNetworkSnapshot: Readonly<Record<string, string>> = {},
  ): Promise<{ claimed: true } | { claimed: false; payload: ProviderActionPayload; expiresAt: string }> {
    if (idempotencyKey !== undefined && (idempotencyKey.length < 8 || idempotencyKey.length > 128)) {
      throw new TypeError('payment action idempotency key must contain between 8 and 128 characters')
    }
    const sensitiveBindingHash = sensitiveRequestBinding === undefined ? null : createHmac('sha256', this.key)
      .update('provider-sensitive-binding:v1:').update(sensitiveRequestBinding).digest('hex')
    const requestFingerprint = idempotencyKey === undefined ? null : createHash('sha256').update(JSON.stringify({
      paymentId,
      presentation,
      principalType: principal.type,
      principalRef: principalReference(principal),
      sensitiveBindingHash,
    })).digest('hex')
    const inserted = await this.transaction.query(`
      INSERT INTO mbox.payment_provider_actions (
        payment_id, tenant_id, store_id, presentation,
        initiated_by_type, initiated_by_ref, state, expires_at,
        request_idempotency_key, request_fingerprint, client_network_snapshot
      ) VALUES ($3::uuid, $1::uuid, $2::uuid, $4, $5, $6::uuid, 'creating', $7::timestamptz, $8, $9, $10::jsonb)
      ON CONFLICT (tenant_id, store_id, payment_id) DO NOTHING
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      paymentId,
      presentation,
      principal.type,
      principalReference(principal),
      expiresAt,
      idempotencyKey ?? null,
      requestFingerprint,
      JSON.stringify(clientNetworkSnapshot),
    ])
    if (inserted.rowCount === 1) return { claimed: true }
    const selected = await this.transaction.query<ActionRow>(`
      SELECT presentation, initiated_by_type, initiated_by_ref,
        state, ciphertext, nonce, auth_tag,
        expires_at::text, updated_at::text,
        request_idempotency_key, request_fingerprint
      FROM mbox.payment_provider_actions
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND payment_id = $3::uuid
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, paymentId])
    const action = selected.rows[0]
    if (action === undefined) throw new Error('支付动作抢占失败')
    if (action.presentation !== presentation) throw new ProviderPaymentMethodConflictError()
    if (idempotencyKey !== undefined && action.request_idempotency_key === idempotencyKey
      && action.request_fingerprint !== requestFingerprint) {
      throw new ProviderPaymentMethodConflictError('同一幂等键的活动支付请求内容不一致')
    }
    if (presentation === 'jsapi' && (
      action.initiated_by_type !== principal.type
      || action.initiated_by_ref !== principalReference(principal)
    )) {
      throw new ProviderPaymentMethodConflictError()
    }
    if (action.state === 'ready') {
      if (Date.parse(action.expires_at) <= Date.now()) throw new ProviderPaymentUnknownError()
      return {
        claimed: false,
        payload: this.decrypt(paymentId, action),
        expiresAt: action.expires_at,
      }
    }
    if (action.state === 'unknown') throw new ProviderPaymentUnknownError()
    if (action.state === 'failed') throw new Error('这次支付发起已失败，请重新建立付款')
    if (action.state === 'consumed') throw new Error('这笔订单已经完成付款，请勿重复支付')
    throw new ProviderPaymentInProgressError()
  }

  async complete(
    paymentId: string,
    presentation: ProviderPresentation,
    payload: ProviderActionPayload,
    expiresAt: string,
    providerTransactionId: string | null,
  ): Promise<void> {
    const encrypted = this.encrypt(paymentId, presentation, payload)
    const updated = await this.transaction.query(`
      WITH action_updated AS (
        UPDATE mbox.payment_provider_actions
        SET state = 'ready', ciphertext = $5, nonce = $6, auth_tag = $7,
            expires_at = $8::timestamptz, last_error_code = NULL,
            updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid
          AND payment_id = $3::uuid AND presentation = $4 AND state = 'creating'
        RETURNING payment_id
      )
      UPDATE mbox.payments payment
      SET provider_transaction_id = COALESCE($9, payment.provider_transaction_id),
          provider_snapshot = payment.provider_snapshot || jsonb_build_object(
            'providerStatus', 'created',
            'providerPresentation', $4,
            'providerOrderCreatedAt', clock_timestamp()::text
          ),
          updated_at = clock_timestamp()
      FROM action_updated
      WHERE payment.tenant_id = $1::uuid AND payment.store_id = $2::uuid
        AND payment.id = action_updated.payment_id
      RETURNING payment.id
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      paymentId,
      presentation,
      encrypted.ciphertext,
      encrypted.nonce,
      encrypted.authTag,
      expiresAt,
      providerTransactionId,
    ])
    if (updated.rowCount !== 1) throw new Error('支付渠道结果没有安全写回')
  }

  /**
   * Removes only the caller's just-created, provider-free claim.  This is
   * deliberately narrower than a general action delete: a ready/unknown
   * action may have reached the channel and must instead be queried.
   */
  async abandonUnsubmittedClaim(paymentId: string): Promise<void> {
    await this.transaction.query(`
      DELETE FROM mbox.payment_provider_actions
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND payment_id=$3::uuid
        AND state='creating' AND ciphertext IS NULL AND nonce IS NULL AND auth_tag IS NULL
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, paymentId])
  }

  async markUnknown(paymentId: string, errorCode: string): Promise<void> {
    await this.transaction.query(`
      UPDATE mbox.payment_provider_actions
      SET state = 'unknown', ciphertext = NULL, nonce = NULL, auth_tag = NULL,
          last_error_code = $4, updated_at = clock_timestamp()
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND payment_id = $3::uuid AND state = 'creating'
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, paymentId, errorCode.slice(0, 128)])
  }

  async markFailed(paymentId: string, errorCode: string): Promise<void> {
    await this.transaction.query(`
      WITH action_updated AS (
        UPDATE mbox.payment_provider_actions
        SET state = 'failed', ciphertext = NULL, nonce = NULL, auth_tag = NULL,
            last_error_code = $4, updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid
          AND payment_id = $3::uuid AND state = 'creating'
        RETURNING payment_id
      )
      , payment_updated AS (
        UPDATE mbox.payments payment
        SET status = 'failed',
            provider_snapshot = payment.provider_snapshot || jsonb_build_object(
              'providerStatus', 'rejected', 'errorCode', $4
            ),
            updated_at = clock_timestamp()
        FROM action_updated
        WHERE payment.tenant_id = $1::uuid AND payment.store_id = $2::uuid
          AND payment.id = action_updated.payment_id
          AND payment.status IN ('created', 'pending')
        RETURNING payment.order_id, payment.activity_registration_id, payment.payable_kind
      )
      UPDATE mbox.orders ordering
      SET payment_status = 'unpaid', updated_at = clock_timestamp()
      FROM payment_updated
      WHERE ordering.tenant_id = $1::uuid AND ordering.store_id = $2::uuid
        AND ordering.id = payment_updated.order_id
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, paymentId, errorCode.slice(0, 128)])
    await this.transaction.query(`
      UPDATE mbox.community_activity_registrations registration
      SET status='cancelled', payment_status='expired', amount_due_minor=0,
        payment_due_at=NULL, seat_hold_expires_at=NULL,
        cancelled_at=COALESCE(cancelled_at, clock_timestamp()), updated_at=clock_timestamp()
      FROM mbox.payments payment
      WHERE payment.tenant_id=$1::uuid AND payment.store_id=$2::uuid AND payment.id=$3::uuid
        AND payment.payable_kind='activity_registration'
        AND registration.tenant_id=payment.tenant_id AND registration.store_id=payment.store_id
        AND registration.id=payment.activity_registration_id
        AND registration.status='payment_pending' AND registration.payment_status='pending'
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, paymentId])
  }

  private async assertAccess(row: Readonly<ContextRow>, principal: Readonly<PaymentPrincipal>): Promise<void> {
    if (principal.type === 'employee') return
    if (row.payable_kind === 'activity_registration') {
      if (row.customer_id === null) throw new Error('活动报名支付缺少客户归属')
      const owned = await this.transaction.query<{ owned: boolean }>(`
        WITH RECURSIVE ancestry AS (
          SELECT id, merged_into_customer_id FROM mbox.customers
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
          UNION ALL
          SELECT parent.id, parent.merged_into_customer_id
          FROM mbox.customers parent JOIN ancestry child ON child.merged_into_customer_id=parent.id
          WHERE parent.tenant_id=$1::uuid AND parent.store_id=$2::uuid
        ), canonical AS (
          SELECT id FROM ancestry WHERE merged_into_customer_id IS NULL LIMIT 1
        ), family AS (
          SELECT id FROM canonical
          UNION ALL
          SELECT child.id FROM mbox.customers child JOIN family parent ON child.merged_into_customer_id=parent.id
          WHERE child.tenant_id=$1::uuid AND child.store_id=$2::uuid
        ) SELECT $4::uuid IN (SELECT id FROM family) AS owned
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, principal.customerId, row.customer_id])
      if (owned.rows[0]?.owned !== true) throw new Error('活动报名不属于当前客人')
      return
    }
    if (row.table_session_id === null || principal.tableSessionId !== row.table_session_id) {
      throw new GuestOrderPaymentAccessError('order_not_in_current_table')
    }
    if (principal.guestSessionId===undefined || !await lockBoundGuestTablePosition(this.transaction,{
      tableSessionId:row.table_session_id,customerId:principal.customerId,
      actorRef:`guest-session:${principal.guestSessionId}`,
    })) throw new GuestOrderPaymentAccessError('guest_not_at_current_table')
  }

  private encrypt(paymentId: string, presentation: ProviderPresentation, payload: ProviderActionPayload) {
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce)
    cipher.setAAD(this.actionAad(paymentId, presentation))
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
    return { ciphertext, nonce, authTag: cipher.getAuthTag() }
  }

  private decrypt(paymentId: string, row: ActionRow): ProviderActionPayload {
    if (row.ciphertext === null || row.nonce === null || row.auth_tag === null) {
      throw new ProviderPaymentUnknownError()
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, row.nonce)
      decipher.setAAD(this.actionAad(paymentId, row.presentation))
      decipher.setAuthTag(row.auth_tag)
      const decoded = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8')
      const payload: unknown = JSON.parse(decoded)
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new Error('invalid')
      return payload as ProviderActionPayload
    } catch {
      throw new ProviderPaymentUnknownError()
    }
  }

  private actionAad(paymentId: string, presentation: ProviderPresentation): Buffer {
    return Buffer.from(`${this.transaction.scope.tenantId}:${this.transaction.scope.storeId}:${paymentId}:${presentation}`)
  }
}

function mapContext(row: ContextRow): ProviderPaymentContext {
  const amountMinor = Number(row.amount_minor)
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error('支付金额无效')
  return {
    id: row.id,
    payableKind: row.payable_kind,
    orderId: row.order_id,
    orderPublicId: row.order_public_id,
    activityRegistrationId: row.activity_registration_id,
    activityRegistrationPublicId: row.activity_registration_public_id,
    publicId: row.public_id,
    provider: row.provider,
    providerTransactionId: row.provider_transaction_id,
    method: row.method,
    amountMinor,
    currency: row.currency,
    status: row.status,
    customerId: row.customer_id,
    tableSessionId: row.table_session_id,
    tableCode: row.table_code,
    createdAt: row.created_at,
  }
}

function principalReference(principal: Readonly<PaymentPrincipal>): string {
  return principal.type === 'employee' ? principal.employeeId : principal.customerId
}
