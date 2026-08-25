import { randomUUID } from 'node:crypto'
import type { ScopedTransaction } from './transaction-runner.js'

export interface ActivityRecollectionAuthorization {
  id: string
  publicId: string
  activityRegistrationId: string
  sourceRefundId: string
  amountMinor: number
  currency: string
  reason: string
  authorizedByEmployeeId: string
  expiresAt: string
  createdAt: string
}

export class ActivityRecollectionAuthorizationRequiredError extends Error {
  constructor() {
    super('退款后的活动报名须先由收银确认“重新收款”后才能再次收款')
  }
}

export class ActivityRecollectionAuthorizationConflictError extends Error {
  constructor(message: string) {
    super(message)
  }
}

interface RefundableRegistrationRow extends Record<string, unknown> {
  id: string
  currency: string
  payment_id: string | null
  refund_id: string | null
  refund_amount_minor: string | number | null
  refund_status: string | null
}

interface AuthorizationRow extends Record<string, unknown> {
  id: string
  public_id: string
  activity_registration_id: string
  source_refund_id: string
  amount_minor: string | number
  currency: string
  reason: string
  authorized_by_employee_id: string
  expires_at: string
  created_at: string
}

/**
 * An activity refund is terminal until an authorized member of the cashier
 * team explicitly reopens exactly the refunded amount. This is deliberately
 * separate from the order recollection table: an activity is not an order.
 */
export class ActivityRecollectionAuthorizationRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async authorize(input: Readonly<{
    activityRegistrationPublicId: string
    employeeId: string
    reason: string
    ttlMinutes?: number
  }>): Promise<ActivityRecollectionAuthorization> {
    const reason = requireReason(input.reason)
    const ttlMinutes = boundedTtl(input.ttlMinutes ?? 30)
    const source = await this.lockRefundedRegistration(input.activityRegistrationPublicId)
    if (source.refund_id === null || source.refund_status !== 'succeeded'
      || source.refund_amount_minor === null || source.refund_amount_minor <= 0) {
      throw new ActivityRecollectionAuthorizationConflictError('当前活动报名没有可授权的退款后重新收款金额')
    }
    await this.transaction.query(`
      UPDATE mbox.activity_registration_recollection_authorizations
      SET status='cancelled',cancelled_at=clock_timestamp(),cancellation_reason='由新的重新收款授权替换'
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND activity_registration_id=$3::uuid
        AND status='active'
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, source.id])
    const inserted = await this.transaction.query<AuthorizationRow>(`
      INSERT INTO mbox.activity_registration_recollection_authorizations(
        tenant_id,store_id,public_id,activity_registration_id,source_refund_id,
        amount_minor,currency,status,reason,authorized_by_employee_id,expires_at
      ) VALUES (
        $1::uuid,$2::uuid,$3,$4::uuid,$5::uuid,$6::bigint,$7,'active',$8,$9::uuid,
        clock_timestamp()+make_interval(mins=>$10::int)
      )
      RETURNING id,public_id,activity_registration_id,source_refund_id,amount_minor,currency,
        reason,authorized_by_employee_id,expires_at::text,created_at::text
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      `activity-recollect-${randomUUID()}`,
      source.id,
      source.refund_id,
      source.refund_amount_minor,
      source.currency,
      reason,
      input.employeeId,
      ttlMinutes,
    ])
    const row = inserted.rows[0]
    if (inserted.rowCount !== 1 || row === undefined) {
      throw new ActivityRecollectionAuthorizationConflictError('活动重新收款授权未能创建')
    }
    return mapAuthorization(row)
  }

  async prepareForPayment(input: Readonly<{
    activityRegistrationId: string
    amountMinor: number
    currency: string
  }>): Promise<{ authorizationId: string | null }> {
    const registration = await this.transaction.query<{ status: string; payment_status: string }>(`
      SELECT status,payment_status
      FROM mbox.community_activity_registrations
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.activityRegistrationId])
    const current = registration.rows[0]
    if (current === undefined) throw new ActivityRecollectionAuthorizationConflictError('活动报名不存在')
    if (current.status !== 'refunded' && current.payment_status !== 'refunded') {
      return { authorizationId: null }
    }
    const selected = await this.transaction.query<AuthorizationRow>(`
      SELECT id,public_id,activity_registration_id,source_refund_id,amount_minor,currency,reason,
        authorized_by_employee_id,expires_at::text,created_at::text
      FROM mbox.activity_registration_recollection_authorizations
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND activity_registration_id=$3::uuid
        AND status='active' AND expires_at>clock_timestamp()
      ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.activityRegistrationId])
    const authorization = selected.rows[0]
    if (authorization === undefined || minor(authorization.amount_minor) !== input.amountMinor
      || authorization.currency !== input.currency) {
      throw new ActivityRecollectionAuthorizationRequiredError()
    }
    return { authorizationId: authorization.id }
  }

  async consume(authorizationId: string | null, paymentId: string): Promise<void> {
    if (authorizationId === null) return
    const result = await this.transaction.query(`
      UPDATE mbox.activity_registration_recollection_authorizations
      SET status='consumed',consumed_at=clock_timestamp(),consumed_payment_id=$4::uuid
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='active'
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, authorizationId, paymentId])
    if (result.rowCount !== 1) throw new ActivityRecollectionAuthorizationRequiredError()
  }

  private async lockRefundedRegistration(activityRegistrationPublicId: string): Promise<{
    id: string; currency: string; refund_id: string | null; refund_amount_minor: number | null; refund_status: string | null
  }> {
    const result = await this.transaction.query<RefundableRegistrationRow>(`
      SELECT registration.id,registration.currency,registration.payment_id,
        refund.id AS refund_id,refund.amount_minor AS refund_amount_minor,refund.status AS refund_status
      FROM mbox.community_activity_registrations registration
      LEFT JOIN mbox.refunds refund
        ON refund.tenant_id=registration.tenant_id AND refund.store_id=registration.store_id
       AND refund.payment_id=registration.payment_id AND refund.status='succeeded'
      WHERE registration.tenant_id=$1::uuid AND registration.store_id=$2::uuid
        AND registration.public_id=$3 AND registration.status='refunded' AND registration.payment_status='refunded'
      ORDER BY refund.completed_at DESC NULLS LAST,refund.id DESC LIMIT 1
      FOR UPDATE OF registration
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, activityRegistrationPublicId])
    const row = result.rows[0]
    if (row === undefined) throw new ActivityRecollectionAuthorizationConflictError('当前活动报名不是已完成退款状态')
    return {
      id: row.id,
      currency: row.currency,
      refund_id: row.refund_id,
      refund_amount_minor: row.refund_amount_minor === null ? null : minor(row.refund_amount_minor),
      refund_status: row.refund_status,
    }
  }
}

function mapAuthorization(row: AuthorizationRow): ActivityRecollectionAuthorization {
  return {
    id: row.id,
    publicId: row.public_id,
    activityRegistrationId: row.activity_registration_id,
    sourceRefundId: row.source_refund_id,
    amountMinor: minor(row.amount_minor),
    currency: row.currency,
    reason: row.reason,
    authorizedByEmployeeId: row.authorized_by_employee_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  }
}

function minor(value: string | number): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ActivityRecollectionAuthorizationConflictError('活动报名金额格式无效')
  }
  return parsed
}

function requireReason(value: string): string {
  const normalized = value.trim()
  if (normalized.length < 4 || normalized.length > 500) {
    throw new ActivityRecollectionAuthorizationConflictError('重新收款原因须为4至500个字符')
  }
  return normalized
}

function boundedTtl(value: number): number {
  if (!Number.isSafeInteger(value) || value < 5 || value > 120) {
    throw new ActivityRecollectionAuthorizationConflictError('重新收款授权有效期须为5至120分钟')
  }
  return value
}
