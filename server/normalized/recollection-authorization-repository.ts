import { randomUUID } from 'node:crypto'
import type { ScopedTransaction } from './transaction-runner.js'

export interface OrderRecollectionAuthorization {
  id: string
  publicId: string
  orderId: string
  amountMinor: number
  currency: string
  reason: string
  authorizedByEmployeeId: string
  expiresAt: string
  createdAt: string
}

export class RecollectionAuthorizationRequiredError extends Error {
  constructor() {
    super('退款后的订单须先由收银确认“重新收款”后才能再次扣款')
  }
}

export class RecollectionAuthorizationConflictError extends Error {
  constructor(message: string) {
    super(message)
  }
}

interface BalanceRow extends Record<string, unknown> {
  total_amount_minor: string | number
  gross_paid_minor: string | number
  refunded_minor: string | number
  currency: string
  status: string
}

interface AuthorizationRow extends Record<string, unknown> {
  id: string
  public_id: string
  order_id: string
  amount_minor: string | number
  currency: string
  reason: string
  authorized_by_employee_id: string
  expires_at: string
  created_at: string
}

/**
 * Refunds are a financial fact, not permission to silently charge again.
 * This repository creates one short-lived, audited authorization for the
 * current outstanding balance and atomically consumes it with the replacement
 * payment.  It purposely has no “automatic re-open after refund” behavior.
 */
export class RecollectionAuthorizationRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async authorize(input: Readonly<{
    orderId: string
    employeeId: string
    reason: string
    ttlMinutes?: number
  }>): Promise<OrderRecollectionAuthorization> {
    const reason = requireReason(input.reason)
    const ttlMinutes = boundedTtl(input.ttlMinutes ?? 30)
    const balance = await this.lockBalance(input.orderId)
    const outstandingMinor = outstanding(balance)
    if (balance.status === 'draft' || balance.status === 'cancelled' || balance.refunded_minor <= 0 || outstandingMinor <= 0) {
      throw new RecollectionAuthorizationConflictError('当前订单没有可授权的退款后重新收款余额')
    }

    await this.transaction.query(`
      UPDATE mbox.order_recollection_authorizations
      SET status='cancelled', cancelled_at=clock_timestamp(),
          cancellation_reason='由新的重新收款授权替换'
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND order_id=$3::uuid
        AND status='active'
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.orderId])

    const inserted = await this.transaction.query<AuthorizationRow>(`
      INSERT INTO mbox.order_recollection_authorizations(
        tenant_id,store_id,public_id,order_id,amount_minor,currency,status,
        reason,authorized_by_employee_id,expires_at
      ) VALUES (
        $1::uuid,$2::uuid,$3,$4::uuid,$5::bigint,$6,'active',$7,$8::uuid,
        clock_timestamp()+make_interval(mins=>$9::int)
      )
      RETURNING id,public_id,order_id,amount_minor,currency,reason,
        authorized_by_employee_id,expires_at::text,created_at::text
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      `recollect-${randomUUID()}`,
      input.orderId,
      outstandingMinor,
      balance.currency,
      reason,
      input.employeeId,
      ttlMinutes,
    ])
    const row = inserted.rows[0]
    if (!row) throw new RecollectionAuthorizationConflictError('重新收款授权未能创建')
    return mapAuthorization(row)
  }

  /**
   * The caller already holds the authoritative order lock and settlement
   * snapshot. Normal unpaid orders do not touch this table at all; only a
   * successful refund activates the additional authorization check.
   */
  async prepareForPayment(input: Readonly<{
    orderId: string
    outstandingMinor: number
    refundedMinor: number
    currency: string
  }>): Promise<{ authorizationId: string | null }> {
    if (input.outstandingMinor <= 0 || input.refundedMinor <= 0) return { authorizationId: null }
    const selected = await this.transaction.query<AuthorizationRow>(`
      SELECT id,public_id,order_id,amount_minor,currency,reason,authorized_by_employee_id,
        expires_at::text,created_at::text
      FROM mbox.order_recollection_authorizations
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND order_id=$3::uuid
        AND status='active' AND expires_at>clock_timestamp()
      ORDER BY created_at DESC,id DESC
      LIMIT 1
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.orderId])
    const authorization = selected.rows[0]
    if (!authorization || safeMinor(authorization.amount_minor) !== input.outstandingMinor || authorization.currency !== input.currency) {
      throw new RecollectionAuthorizationRequiredError()
    }
    return { authorizationId: authorization.id }
  }

  async consume(authorizationId: string | null, paymentId: string): Promise<void> {
    if (authorizationId === null) return
    const updated = await this.transaction.query(`
      UPDATE mbox.order_recollection_authorizations
      SET status='consumed', consumed_at=clock_timestamp(), consumed_payment_id=$4::uuid
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='active'
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, authorizationId, paymentId])
    if (updated.rowCount !== 1) throw new RecollectionAuthorizationRequiredError()
  }

  private async lockBalance(orderId: string): Promise<{
    total_amount_minor: number; gross_paid_minor: number; refunded_minor: number; currency: string; status: string
  }> {
    const result = await this.transaction.query<BalanceRow>(`
      SELECT ordering.total_amount_minor,ordering.currency,ordering.status,
        COALESCE((
          SELECT SUM(payment.amount_minor) FROM mbox.payments payment
          WHERE payment.tenant_id=ordering.tenant_id AND payment.store_id=ordering.store_id
            AND payment.order_id=ordering.id AND payment.status IN ('succeeded','partially_refunded','refunded')
        ),0)::bigint AS gross_paid_minor,
        COALESCE((
          SELECT SUM(refund_row.amount_minor) FROM mbox.refunds refund_row
          JOIN mbox.payments payment
            ON payment.tenant_id=refund_row.tenant_id AND payment.store_id=refund_row.store_id
           AND payment.id=refund_row.payment_id
          WHERE refund_row.tenant_id=ordering.tenant_id AND refund_row.store_id=ordering.store_id
            AND payment.order_id=ordering.id AND refund_row.status='succeeded'
        ),0)::bigint AS refunded_minor
      FROM mbox.orders ordering
      WHERE ordering.tenant_id=$1::uuid AND ordering.store_id=$2::uuid AND ordering.id=$3::uuid
      FOR UPDATE OF ordering
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, orderId])
    const row = result.rows[0]
    if (!row) throw new RecollectionAuthorizationConflictError('订单不存在')
    return {
      total_amount_minor: safeMinor(row.total_amount_minor),
      gross_paid_minor: safeMinor(row.gross_paid_minor),
      refunded_minor: safeMinor(row.refunded_minor),
      currency: row.currency,
      status: row.status,
    }
  }
}

function outstanding(balance: { total_amount_minor: number; gross_paid_minor: number; refunded_minor: number }): number {
  return Math.max(0, balance.total_amount_minor - balance.gross_paid_minor + balance.refunded_minor)
}

function mapAuthorization(row: AuthorizationRow): OrderRecollectionAuthorization {
  return {
    id: row.id,
    publicId: row.public_id,
    orderId: row.order_id,
    amountMinor: safeMinor(row.amount_minor),
    currency: row.currency,
    reason: row.reason,
    authorizedByEmployeeId: row.authorized_by_employee_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  }
}

function safeMinor(value: string | number): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new RecollectionAuthorizationConflictError('订单金额格式无效')
  return parsed
}

function requireReason(value: string): string {
  const normalized = value.trim()
  if (normalized.length < 4 || normalized.length > 500) {
    throw new RecollectionAuthorizationConflictError('重新收款原因须为4至500个字符')
  }
  return normalized
}

function boundedTtl(value: number): number {
  if (!Number.isSafeInteger(value) || value < 5 || value > 120) {
    throw new RecollectionAuthorizationConflictError('重新收款授权有效期须为5至120分钟')
  }
  return value
}
