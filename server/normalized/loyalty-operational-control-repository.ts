import type { ScopedTransaction } from './transaction-runner.js'

export const LOYALTY_OPERATIONAL_CAPABILITIES = Object.freeze([
  'points_accrual',
  'points_redemption',
  'wechat_notification',
] as const)

export type LoyaltyOperationalCapability = (typeof LOYALTY_OPERATIONAL_CAPABILITIES)[number]
export type LoyaltyOperationalState = 'active' | 'paused'

export interface LoyaltyOperationalStateView {
  capability: LoyaltyOperationalCapability
  state: LoyaltyOperationalState
  version: number
  reason: string | null
  reviewAt: string | null
  changedByEmployeeId: string | null
  changedAt: string | null
  pendingAccrualCount: number
}

interface ControlRow extends Record<string, unknown> {
  capability: LoyaltyOperationalCapability
  state: LoyaltyOperationalState
  control_version: number
  reason: string | null
  review_at: string | null
  changed_by_employee_id: string | null
  changed_at: string | null
  pending_accrual_count: number
}

export class LoyaltyPositiveAccrualPausedError extends Error {
  constructor(
    readonly controlVersion: number,
    readonly pauseReason: string | null,
  ) {
    super('Positive loyalty accrual is paused by the store operational control')
    this.name = 'LoyaltyPositiveAccrualPausedError'
  }
}

export class LoyaltyOperationalControlRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async states(lock = false): Promise<LoyaltyOperationalStateView[]> {
    if (lock) {
      await this.transaction.query(`
        SELECT capability FROM mbox.loyalty_operational_control_states
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid
          AND capability IN ('points_accrual','points_redemption','wechat_notification')
        ORDER BY capability
        FOR SHARE
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId])
    }
    const result = await this.transaction.query<ControlRow>(`
      SELECT capability.code AS capability,COALESCE(control.state,'active') AS state,
        COALESCE(control.control_version,0)::integer AS control_version,
        control.reason,control.review_at::text,control.changed_by_employee_id,
        control.changed_at::text,
        CASE WHEN capability.code='points_accrual' THEN (
          SELECT count(*)::integer FROM mbox.loyalty_accrual_deferred_orders deferred
          WHERE deferred.tenant_id=$1::uuid AND deferred.store_id=$2::uuid
            AND deferred.status IN ('pending','processing','review_required')
        ) ELSE 0 END AS pending_accrual_count
      FROM (VALUES('points_accrual'),('points_redemption'),('wechat_notification')) capability(code)
      LEFT JOIN mbox.loyalty_operational_control_states control
        ON control.tenant_id=$1::uuid AND control.store_id=$2::uuid
       AND control.capability=capability.code
      ORDER BY CASE capability.code WHEN 'points_accrual' THEN 1
        WHEN 'points_redemption' THEN 2 ELSE 3 END
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId])
    return result.rows.map(mapControl)
  }

  async state(capability: LoyaltyOperationalCapability, lock = false): Promise<LoyaltyOperationalStateView> {
    requireCapability(capability)
    if (lock) {
      await this.transaction.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [
        `loyalty-operational-control:${this.transaction.scope.tenantId}:${this.transaction.scope.storeId}:${capability}`,
      ])
    }
    const rows = await this.states(lock)
    const state = rows.find((item) => item.capability===capability)
    if (!state) throw new Error('Loyalty operational control state is unavailable')
    return state
  }

  async deferPaidOrderIfPaused(input: Readonly<{
    orderId: string
    paymentId: string
  }>): Promise<boolean> {
    const control = await this.state('points_accrual', true)
    if (control.state!=='paused') return false
    const inserted = await this.transaction.query(`
      INSERT INTO mbox.loyalty_accrual_deferred_orders(
        tenant_id,store_id,order_id,payment_id,policy_version_id,
        pause_control_version,payment_succeeded_at
      )
      SELECT ordering.tenant_id,ordering.store_id,ordering.id,payment.id,
        ordering.loyalty_policy_version_id,$5,payment.succeeded_at
      FROM mbox.orders ordering
      JOIN mbox.payments payment
        ON payment.tenant_id=ordering.tenant_id AND payment.store_id=ordering.store_id
       AND payment.order_id=ordering.id
      WHERE ordering.tenant_id=$1::uuid AND ordering.store_id=$2::uuid
        AND ordering.id=$3::uuid AND payment.id=$4::uuid
        AND ordering.payment_status='paid' AND payment.status='succeeded'
        AND payment.succeeded_at IS NOT NULL
        AND NOT EXISTS(
          SELECT 1 FROM mbox.loyalty_order_awards award
          WHERE award.tenant_id=ordering.tenant_id AND award.store_id=ordering.store_id
            AND award.order_id=ordering.id
        )
      ON CONFLICT (tenant_id,store_id,order_id) DO NOTHING
      RETURNING id
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.orderId,
      input.paymentId,
      control.version,
    ])
    if (inserted.rowCount===1) return true
    const existing = await this.transaction.query(`
      SELECT 1 FROM mbox.loyalty_accrual_deferred_orders
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid
        AND order_id=$3::uuid AND payment_id=$4::uuid
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,input.orderId,input.paymentId])
    return existing.rowCount===1
  }

  async assertPositiveAccrualActive(): Promise<void> {
    const control = await this.state('points_accrual', true)
    if (control.state === 'paused') {
      throw new LoyaltyPositiveAccrualPausedError(control.version, control.reason)
    }
  }
}

function mapControl(row: ControlRow): LoyaltyOperationalStateView {
  return {
    capability: row.capability,
    state: row.state,
    version: Number(row.control_version),
    reason: row.reason,
    reviewAt: row.review_at,
    changedByEmployeeId: row.changed_by_employee_id,
    changedAt: row.changed_at,
    pendingAccrualCount: Number(row.pending_accrual_count),
  }
}

function requireCapability(value: string): asserts value is LoyaltyOperationalCapability {
  if (!LOYALTY_OPERATIONAL_CAPABILITIES.includes(value as LoyaltyOperationalCapability)) {
    throw new TypeError('Unsupported loyalty operational capability')
  }
}
