import { randomUUID } from 'node:crypto'
import type { JsonObject } from './command-executor.js'
import { FulfillmentCapacityRepository } from './fulfillment-capacity-repository.js'
import { InventoryRepository } from './inventory-repository.js'
import { KdsRepository } from './kds-repository.js'
import { OrderRepository, type SubmittedOrder } from './order-repository.js'
import { PaymentFulfillmentRepository } from './payment-fulfillment-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'
import { LoyaltyOperationalControlRepository } from './loyalty-operational-control-repository.js'
import { lockBoundGuestTablePosition } from './guest-table-authority.js'

export type RedemptionFulfillmentKind = 'product' | 'benefit' | 'activity' | 'service'
export type RedemptionStatus = 'authorizing' | 'awaiting_fulfillment' | 'fulfilled' | 'cancelled' | 'failed' | 'expired'
export type RedemptionFailureCode =
  | 'customer_cancelled'
  | 'product_unavailable'
  | 'benefit_unavailable'
  | 'activity_unavailable'
  | 'service_unavailable'
  | 'fulfillment_rejected'
  | 'fulfillment_timeout'
  | 'technical_failure'
export type RedemptionRecoveryState = 'not_required' | 'manual_review' | 'restored'

export interface RedemptionExpiryBatch {
  claimed: number
  expired: number
  manualReview: number
  expiredPublicIds: readonly string[]
  manualReviewPublicIds: readonly string[]
}

export class LoyaltyRedemptionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 409,
  ) {
    super(message)
    this.name = 'LoyaltyRedemptionError'
  }
}

export interface RedemptionCatalogView {
  controlState: 'disabled' | 'pilot' | 'enabled' | 'paused'
  availablePoints: number
  currentTier: 'member' | 'silver' | 'gold'
  items: readonly RedemptionCatalogItemView[]
}

export interface RedemptionCatalogItemView {
  publicId: string
  name: string
  fulfillmentKind: RedemptionFulfillmentKind
  pointsRequired: number
  costAmountMinor: number
  currency: string
  remainingInventory: number | null
  remainingDailyInventory: number | null
  memberDailyLimit: number
  memberRolling30DayLimit: number
  memberLifetimeLimit: number | null
  minimumTier: 'member' | 'silver' | 'gold'
  requiresTableSession: boolean
  requiresEmployeeFulfillment: boolean
  cancellationAllowedBeforeFulfillment: boolean
  availableUntil: string | null
  eligible: boolean
  ineligibleReason: string | null
  display: JsonObject
}

export interface MemberRedemptionView {
  publicId: string
  catalogItemPublicId: string
  name: string
  fulfillmentKind: RedemptionFulfillmentKind
  pointsUsed: number
  status: RedemptionStatus
  orderPublicId: string | null
  expiresAt: string
  fulfilledAt: string | null
  entitlementKind: 'benefit' | 'activity' | 'service' | null
  entitlementStatus: 'issued' | 'consumed' | 'cancelled' | null
  failureCode: RedemptionFailureCode | null
  recoveryState: RedemptionRecoveryState
  recoveryRequestedAt: string | null
  recoveredAt: string | null
  pointsRestored: number
  createdAt: string
  display: JsonObject
}

interface MembershipRow extends Record<string, unknown> {
  membership_id: string
  customer_id: string
  account_id: string
  available_points: number
  pending_recovery_points: number
  redemption_status: 'active' | 'suspended' | 'closed'
  current_tier: 'member' | 'silver' | 'gold'
  growth_value: number
}

interface CatalogRow extends Record<string, unknown> {
  control_state: 'disabled' | 'pilot' | 'enabled' | 'paused'
  public_id: string
  name: string
  fulfillment_kind: RedemptionFulfillmentKind
  product_id: string | null
  benefit_definition_id: string | null
  activity_id: string | null
  points_required: number
  cost_amount_minor: string | number
  currency: string
  total_inventory: number | null
  daily_inventory: number | null
  total_consumed: number
  daily_consumed: number
  member_daily_limit: number
  member_rolling_30_day_limit: number
  member_lifetime_limit: number | null
  member_daily_count: number
  member_rolling_count: number
  member_lifetime_count: number
  minimum_tier: 'member' | 'silver' | 'gold'
  requires_table_session: boolean
  requires_employee_fulfillment: boolean
  cancellation_allowed_before_fulfillment: boolean
  restore_expired_points_days: number
  available_until: string | null
  fulfillment_timeout_minutes: number
  display_snapshot: unknown
  catalog_item_id: string
  catalog_version_id: string
}

interface RedemptionRow extends Record<string, unknown> {
  id: string
  public_id: string
  catalog_item_public_id: string
  name: string
  fulfillment_kind: RedemptionFulfillmentKind
  points_used: number
  status: RedemptionStatus
  order_id: string | null
  order_public_id: string | null
  order_item_id: string | null
  expires_at: string
  fulfilled_at: string | null
  created_at: string
  entitlement_kind?: 'benefit' | 'activity' | 'service' | null
  entitlement_status?: 'issued' | 'consumed' | 'cancelled' | null
  display_snapshot: unknown
  membership_id?: string
  customer_id?: string
  catalog_item_id?: string
  cancellation_allowed_before_fulfillment?: boolean
  restore_expired_points_days?: number
  business_date?: string
  failure_code: RedemptionFailureCode | null
  recovery_state: RedemptionRecoveryState
  recovery_requested_at: string | null
  recovered_at: string | null
  points_restored: number
}

interface RedemptionResolutionRow extends RedemptionRow {
  membership_id: string
  customer_id: string
  cancellation_allowed_before_fulfillment: boolean
  restore_expired_points_days: number
  business_date: string
  catalog_item_id: string
}

export class LoyaltyRedemptionRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async catalog(customerId: string, businessDate: string, now: string): Promise<RedemptionCatalogView> {
    const membership = await this.membership(customerId, false)
    const control = await this.controlState(now)
    if (!membership) return { controlState: control, availablePoints: 0, currentTier: 'member', items: [] }
    if (!['pilot', 'enabled'].includes(control)) {
      return {
        controlState: control,
        availablePoints: membership.available_points,
        currentTier: membership.current_tier,
        items: [],
      }
    }
    const rows = await this.catalogRows(membership.membership_id, businessDate, now, false)
    return {
      controlState: control,
      availablePoints: membership.available_points,
      currentTier: membership.current_tier,
      items: rows.map((row) => catalogView(row, membership)),
    }
  }

  async listMine(customerId: string): Promise<readonly MemberRedemptionView[]> {
    const membership = await this.membership(customerId, false)
    if (!membership) return []
    const result = await this.transaction.query<RedemptionRow>(`
      SELECT redemption.id, redemption.public_id,
        item.public_id AS catalog_item_public_id, item.name,
        redemption.fulfillment_kind, redemption.points_used, redemption.status,
        redemption.order_id, ordering.public_id AS order_public_id,
        redemption.order_item_id, redemption.expires_at::text,
        redemption.fulfilled_at::text, redemption.created_at::text,
        redemption.failure_code,redemption.recovery_state,
        redemption.recovery_requested_at::text,redemption.recovered_at::text,
        redemption.points_restored,
        item.display_snapshot, entitlement.entitlement_kind, entitlement.status AS entitlement_status
      FROM mbox.member_redemptions redemption
      JOIN mbox.redemption_catalog_items item
        ON item.tenant_id=redemption.tenant_id AND item.store_id=redemption.store_id
       AND item.id=redemption.catalog_item_id
      LEFT JOIN mbox.orders ordering
        ON ordering.tenant_id=redemption.tenant_id AND ordering.store_id=redemption.store_id
       AND ordering.id=redemption.order_id
      LEFT JOIN mbox.member_redemption_entitlements entitlement
        ON entitlement.tenant_id=redemption.tenant_id AND entitlement.store_id=redemption.store_id
       AND entitlement.redemption_id=redemption.id
      WHERE redemption.tenant_id=$1::uuid AND redemption.store_id=$2::uuid
        AND redemption.membership_id=$3::uuid
      ORDER BY redemption.created_at DESC, redemption.id DESC
      LIMIT 100
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, membership.membership_id])
    return result.rows.map(redemptionView)
  }

  async create(input: Readonly<{
    customerId: string
    catalogItemPublicId: string
    tableSessionId: string | null
    businessDate: string
    now: string
    idempotencyKey: string
    requestFingerprint: string
    actorRef?: string
  }>): Promise<MemberRedemptionView> {
    const membership = await this.membership(input.customerId, true)
    if (!membership) throw new LoyaltyRedemptionError('LOYALTY_MEMBERSHIP_REQUIRED', '请先加入会员后再兑换')
    if (membership.redemption_status !== 'active' || membership.pending_recovery_points > 0) {
      throw new LoyaltyRedemptionError('LOYALTY_REDEMPTION_SUSPENDED', '账户存在待处理积分，请联系门店后再兑换')
    }
    const control = await this.controlState(input.now, true)
    if (!['pilot', 'enabled'].includes(control)) {
      throw new LoyaltyRedemptionError('LOYALTY_REDEMPTION_DISABLED', '积分兑换当前未开放')
    }
    const rows = await this.catalogRows(membership.membership_id, input.businessDate, input.now, true, input.catalogItemPublicId)
    const item = rows[0]
    if (!item) throw new LoyaltyRedemptionError('LOYALTY_REDEMPTION_ITEM_UNAVAILABLE', '兑换项不存在或当前不可用')
    const eligibility = catalogView(item, membership)
    if (!eligibility.eligible) throw new LoyaltyRedemptionError(
      'LOYALTY_REDEMPTION_INELIGIBLE', eligibility.ineligibleReason ?? '当前不符合兑换条件',
    )
    if (item.requires_table_session) await this.assertCustomerTableSession(
      input.customerId,input.tableSessionId,input.actorRef,
    )
    if (membership.available_points < item.points_required) {
      throw new LoyaltyRedemptionError('LOYALTY_POINTS_INSUFFICIENT', '可用积分不足')
    }
    await this.reserveCatalogInventory(item, input.businessDate)

    const publicId = `RED-${randomUUID()}`
    const inserted = await this.transaction.query<{ id: string }>(`
      INSERT INTO mbox.member_redemptions (
        tenant_id, store_id, public_id, membership_id, customer_id,
        catalog_item_id, catalog_version_id, table_session_id, business_date, points_used,
        status, fulfillment_kind, expires_at, idempotency_key, request_fingerprint
      ) VALUES (
        $1::uuid,$2::uuid,$3,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::uuid,$9::date,$10,
        'authorizing',$11,$12::timestamptz + make_interval(mins => $13),$14,$15
      ) RETURNING id
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId, publicId,
      membership.membership_id, membership.customer_id, item.catalog_item_id,
      item.catalog_version_id, input.tableSessionId, input.businessDate,
      item.points_required, item.fulfillment_kind, input.now, item.fulfillment_timeout_minutes,
      input.idempotencyKey, input.requestFingerprint,
    ])
    const redemptionId = inserted.rows[0]?.id
    if (!redemptionId) throw new Error('Loyalty redemption was not inserted')

    let order: SubmittedOrder | null = null
    if (item.fulfillment_kind === 'product') {
      if (!item.product_id || !input.tableSessionId) throw new LoyaltyRedemptionError(
        'LOYALTY_REDEMPTION_PRODUCT_CONFIGURATION_INVALID', '兑换商品配置不完整',
      )
      order = await new OrderRepository(this.transaction).createSubmitted({
        tableSessionId: input.tableSessionId,
        publicId: `ORD-${randomUUID()}`,
        channel: 'guest_qr',
        settlementMode: 'immediate_payment',
        lines: [{ productId: item.product_id, quantity: 1 }],
        note: `积分兑换 ${publicId}`,
        createdByCustomerId: membership.customer_id,
      })
      const plan = {
        priorityByOrderItemId: new Map(order.items.map((line) => [line.id, line.fulfillmentPriority ?? 100])),
        dueAtByOrderItemId: new Map(order.items.map((line) => [line.id, line.fulfillmentDueAt ?? null])),
      }
      await new PaymentFulfillmentRepository(this.transaction).prepareSubmittedOrder(order, plan)
      const parent = order.items.find((line) => line.parentOrderItemId === null)
      if (!parent) throw new Error('Points redemption order has no billable parent item')
      await this.bindPointsOrder(redemptionId, item.points_required, order, parent.id)
      await this.consumePoints(membership, redemptionId, publicId, item.points_required, input.now, order.id)
      await this.activatePointsOrder(order.id)
      await new FulfillmentCapacityRepository(this.transaction).activateForPaidOrder(order.id)
      await new InventoryRepository(this.transaction).consumeImmediatePaymentReservations(order.id, {
        reason: 'points redemption authorized',
        metadata: { redemptionPublicId: publicId },
      })
      await new KdsRepository(this.transaction).createForOrderItems(order.items)
      await this.updateRedemptionOrder(redemptionId, order.id, parent.id)
    } else {
      await this.consumePoints(membership, redemptionId, publicId, item.points_required, input.now, null)
      await this.transaction.query(`
        UPDATE mbox.member_redemptions
        SET status='awaiting_fulfillment'
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='authorizing'
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, redemptionId])
    }
    await this.event(redemptionId, 'authorized', 'authorizing', 'awaiting_fulfillment', 'customer', input.customerId,
      '积分批次已原子扣减并生成履约授权', `redemption-authorized:${redemptionId}`)
    return this.getById(redemptionId)
  }

  async cancel(input: Readonly<{
    customerId: string
    publicId: string
    now: string
    reason: string
    idempotencyKey: string
  }>): Promise<MemberRedemptionView> {
    const membership = await this.membership(input.customerId, true)
    if (!membership) throw new LoyaltyRedemptionError('LOYALTY_MEMBERSHIP_REQUIRED', '未找到会员账户')
    const selected = await this.transaction.query<RedemptionRow>(`
      SELECT redemption.id, redemption.public_id, item.public_id AS catalog_item_public_id,
        item.name, redemption.fulfillment_kind, redemption.points_used, redemption.status,
        redemption.order_id, ordering.public_id AS order_public_id, redemption.order_item_id,
        redemption.expires_at::text, redemption.fulfilled_at::text, redemption.created_at::text,
        redemption.failure_code,redemption.recovery_state,
        redemption.recovery_requested_at::text,redemption.recovered_at::text,
        redemption.points_restored,
        item.display_snapshot, redemption.membership_id, redemption.customer_id,
        redemption.catalog_item_id, redemption.business_date::text,
        item.cancellation_allowed_before_fulfillment,
        item.restore_expired_points_days
      FROM mbox.member_redemptions redemption
      JOIN mbox.redemption_catalog_items item
        ON item.tenant_id=redemption.tenant_id AND item.store_id=redemption.store_id
       AND item.id=redemption.catalog_item_id
      LEFT JOIN mbox.orders ordering
        ON ordering.tenant_id=redemption.tenant_id AND ordering.store_id=redemption.store_id
       AND ordering.id=redemption.order_id
      WHERE redemption.tenant_id=$1::uuid AND redemption.store_id=$2::uuid
        AND redemption.public_id=$3 AND redemption.membership_id=$4::uuid
      FOR UPDATE OF redemption, item
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.publicId, membership.membership_id])
    const row = selected.rows[0]
    if (!row) throw new LoyaltyRedemptionError('LOYALTY_REDEMPTION_NOT_FOUND', '兑换记录不存在', 404)
    if (row.status === 'cancelled') return redemptionView(row)
    if (row.status !== 'awaiting_fulfillment' || row.cancellation_allowed_before_fulfillment !== true) {
      throw new LoyaltyRedemptionError('LOYALTY_REDEMPTION_CANNOT_CANCEL', '该兑换已进入履约或不允许在线取消')
    }
    const resolution = await this.lockResolution(input.publicId)
    if (!resolution || resolution.membership_id !== membership.membership_id) throw new LoyaltyRedemptionError(
      'LOYALTY_REDEMPTION_NOT_FOUND', '兑换记录不存在', 404,
    )
    const safety = await this.recoverySafety(resolution, false)
    if (!safety.safe) throw new LoyaltyRedemptionError(
      'LOYALTY_REDEMPTION_CANNOT_CANCEL', safety.reason,
    )
    await this.restoreUnfulfilled(
      resolution,membership,'cancelled','customer_cancelled',input.reason,input.now,
      { source: 'customer', employeeId: null, workerId: null },input.idempotencyKey,
    )
    return this.getById(resolution.id)
  }

  async fulfill(input: Readonly<{
    publicId: string
    employeeId: string
    now: string
    reason: string
    idempotencyKey: string
  }>): Promise<MemberRedemptionView> {
    const selected = await this.transaction.query<RedemptionRow & {
      benefit_definition_id: string | null
      activity_id: string | null
    }>(`
      SELECT redemption.id, redemption.public_id, item.public_id AS catalog_item_public_id,
        item.name, redemption.fulfillment_kind, redemption.points_used, redemption.status,
        redemption.order_id, ordering.public_id AS order_public_id, redemption.order_item_id,
        redemption.expires_at::text, redemption.fulfilled_at::text, redemption.created_at::text,
        redemption.failure_code,redemption.recovery_state,
        redemption.recovery_requested_at::text,redemption.recovered_at::text,
        redemption.points_restored,
        item.display_snapshot, redemption.membership_id, redemption.customer_id,
        redemption.catalog_item_id, item.benefit_definition_id, item.activity_id
      FROM mbox.member_redemptions redemption
      JOIN mbox.redemption_catalog_items item
        ON item.tenant_id=redemption.tenant_id AND item.store_id=redemption.store_id
       AND item.id=redemption.catalog_item_id
      LEFT JOIN mbox.orders ordering
        ON ordering.tenant_id=redemption.tenant_id AND ordering.store_id=redemption.store_id
       AND ordering.id=redemption.order_id
      WHERE redemption.tenant_id=$1::uuid AND redemption.store_id=$2::uuid
        AND redemption.public_id=$3
      FOR UPDATE OF redemption, item
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.publicId])
    const row = selected.rows[0]
    if (!row) throw new LoyaltyRedemptionError('LOYALTY_REDEMPTION_NOT_FOUND', '兑换记录不存在', 404)
    if (row.status === 'fulfilled') return redemptionView(row)
    if (row.status !== 'awaiting_fulfillment') throw new LoyaltyRedemptionError(
      'LOYALTY_REDEMPTION_NOT_FULFILLABLE', '兑换记录当前不可交付',
    )
    if (row.fulfillment_kind === 'product') {
      if (!row.order_item_id) throw new Error('Product redemption has no order item')
      await new OrderRepository(this.transaction).markDelivered(row.order_item_id, input.employeeId)
    } else if (row.fulfillment_kind === 'benefit') {
      const benefitId = await this.issueBenefit(row, input.employeeId, input.now)
      await this.issueEntitlement(row.id, 'benefit', input.employeeId, input.now, benefitId, null)
    } else if (row.fulfillment_kind === 'activity') {
      if (!row.activity_id) throw new Error('Activity redemption target is missing')
      await this.issueEntitlement(row.id, 'activity', input.employeeId, input.now, null, row.activity_id)
    } else {
      await this.issueEntitlement(row.id, 'service', input.employeeId, input.now, null, null)
    }
    await this.transaction.query(`
      UPDATE mbox.member_redemptions
      SET status='fulfilled', fulfilled_by_employee_id=$4::uuid, fulfilled_at=$5::timestamptz
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, row.id, input.employeeId, input.now])
    await this.event(row.id, 'fulfilled', 'awaiting_fulfillment', 'fulfilled', 'employee', input.employeeId,
      input.reason, input.idempotencyKey)
    return this.getById(row.id)
  }

  async fail(input: Readonly<{
    publicId: string
    employeeId: string
    now: string
    failureCode: Exclude<RedemptionFailureCode, 'customer_cancelled'>
    reason: string
    confirmedUnfulfilled: boolean
    idempotencyKey: string
  }>): Promise<MemberRedemptionView> {
    if (!input.confirmedUnfulfilled) throw new LoyaltyRedemptionError(
      'LOYALTY_REDEMPTION_UNFULFILLED_CONFIRMATION_REQUIRED',
      '必须确认顾客尚未收到商品、权益或服务后才能返还积分',
    )
    const membership = await this.membershipForRedemption(input.publicId)
    const row = await this.lockResolution(input.publicId)
    if (!row || !membership) throw new LoyaltyRedemptionError(
      'LOYALTY_REDEMPTION_NOT_FOUND', '兑换记录不存在', 404,
    )
    if (row.status === 'failed') {
      if (row.recovery_state === 'restored') return this.getById(row.id)
      throw new LoyaltyRedemptionError(
        'LOYALTY_REDEMPTION_HISTORICAL_REVIEW_REQUIRED',
        '该历史失败记录没有强类型返还证据，禁止自动补返，请进入人工对账',
      )
    }
    if (row.status !== 'awaiting_fulfillment') throw new LoyaltyRedemptionError(
      'LOYALTY_REDEMPTION_NOT_RECOVERABLE', '该兑换当前不能执行失败返还',
    )
    const safety = await this.recoverySafety(row, true)
    if (!safety.safe) throw new LoyaltyRedemptionError(
      'LOYALTY_REDEMPTION_RECOVERY_REVIEW_REQUIRED', safety.reason,
    )
    await this.restoreUnfulfilled(
      row, membership, 'failed', input.failureCode, input.reason, input.now,
      { source: 'employee', employeeId: input.employeeId, workerId: null },
      input.idempotencyKey,
    )
    return this.getById(row.id)
  }

  async expireDue(now: string, workerId: string, limit = 100): Promise<RedemptionExpiryBatch> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new TypeError('limit is invalid')
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,95}$/.test(workerId)) throw new TypeError('workerId is invalid')
    const due = await this.transaction.query<{ public_id: string }>(`
      SELECT public_id FROM mbox.member_redemptions
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid
        AND status='awaiting_fulfillment' AND recovery_state='not_required'
        AND expires_at<=$3::timestamptz
      ORDER BY expires_at,id LIMIT $4
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, now, limit])
    const expiredPublicIds: string[] = []
    const manualReviewPublicIds: string[] = []
    for (const candidate of due.rows) {
      const membership = await this.membershipForRedemption(candidate.public_id)
      const row = await this.lockResolution(candidate.public_id)
      if (!row || !membership || row.status !== 'awaiting_fulfillment'
        || row.recovery_state !== 'not_required' || Date.parse(row.expires_at) > Date.parse(now)) continue
      const safety = await this.recoverySafety(row, false)
      if (!safety.safe) {
        await this.markRecoveryReview(row, workerId, now, safety.reason)
        manualReviewPublicIds.push(row.public_id)
        continue
      }
      await this.restoreUnfulfilled(
        row, membership, 'expired', 'fulfillment_timeout', '兑换超过已发布履约时限且确认尚未开始履约', now,
        { source: 'worker', employeeId: null, workerId },
        `redemption-timeout:${row.id}`,
      )
      expiredPublicIds.push(row.public_id)
    }
    return {
      claimed: due.rows.length,
      expired: expiredPublicIds.length,
      manualReview: manualReviewPublicIds.length,
      expiredPublicIds,
      manualReviewPublicIds,
    }
  }

  private async membershipForRedemption(publicId: string): Promise<MembershipRow | null> {
    const result = await this.transaction.query<MembershipRow>(`
      SELECT membership.id AS membership_id,membership.customer_id,
        account.id AS account_id,account.available_points,account.pending_recovery_points,
        account.redemption_status,account.current_tier,account.growth_value
      FROM mbox.member_redemptions redemption
      JOIN mbox.customer_memberships membership
        ON membership.tenant_id=redemption.tenant_id AND membership.store_id=redemption.store_id
       AND membership.id=redemption.membership_id
      JOIN mbox.loyalty_accounts account
        ON account.tenant_id=membership.tenant_id AND account.store_id=membership.store_id
       AND account.membership_id=membership.id AND account.customer_id=membership.customer_id
      WHERE redemption.tenant_id=$1::uuid AND redemption.store_id=$2::uuid
        AND redemption.public_id=$3
      FOR UPDATE OF membership,account
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, publicId])
    return result.rows[0] ?? null
  }

  private async lockResolution(publicId: string): Promise<RedemptionResolutionRow | null> {
    const result = await this.transaction.query<RedemptionResolutionRow>(`
      SELECT redemption.id,redemption.public_id,item.public_id AS catalog_item_public_id,item.name,
        redemption.fulfillment_kind,redemption.points_used,redemption.status,
        redemption.order_id,ordering.public_id AS order_public_id,redemption.order_item_id,
        redemption.expires_at::text,redemption.fulfilled_at::text,redemption.created_at::text,
        redemption.failure_code,redemption.recovery_state,
        redemption.recovery_requested_at::text,redemption.recovered_at::text,
        redemption.points_restored,item.display_snapshot,redemption.membership_id,
        redemption.customer_id,redemption.catalog_item_id,redemption.business_date::text,
        item.cancellation_allowed_before_fulfillment,item.restore_expired_points_days
      FROM mbox.member_redemptions redemption
      JOIN mbox.redemption_catalog_items item
        ON item.tenant_id=redemption.tenant_id AND item.store_id=redemption.store_id
       AND item.id=redemption.catalog_item_id
      LEFT JOIN mbox.orders ordering
        ON ordering.tenant_id=redemption.tenant_id AND ordering.store_id=redemption.store_id
       AND ordering.id=redemption.order_id
      WHERE redemption.tenant_id=$1::uuid AND redemption.store_id=$2::uuid
        AND redemption.public_id=$3
      FOR UPDATE OF redemption,item
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, publicId])
    return result.rows[0] ?? null
  }

  private async recoverySafety(
    row: RedemptionResolutionRow,
    employeeConfirmed: boolean,
  ): Promise<{ safe: true } | { safe: false; reason: string }> {
    if (row.fulfillment_kind !== 'product') {
      const entitlement = await this.transaction.query(`
        SELECT id FROM mbox.member_redemption_entitlements
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND redemption_id=$3::uuid
        LIMIT 1
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, row.id])
      return entitlement.rowCount === 0
        ? { safe: true }
        : { safe: false, reason: '该兑换已经生成权益或服务凭证，必须先人工核对实际履约情况' }
    }
    if (!row.order_id || !row.order_item_id) return {
      safe: false, reason: '商品兑换缺少权威订单关联，不能自动返还积分',
    }
    const item = await this.transaction.query<{ status: string }>(`
      SELECT status FROM mbox.order_items
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND order_id=$3::uuid AND id=$4::uuid
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, row.order_id, row.order_item_id])
    if (!item.rows[0] || item.rows[0].status === 'delivered') return {
      safe: false, reason: '商品已交付或订单事实不完整，禁止返还积分',
    }
    const tasks = await this.transaction.query<{ status: string }>(`
      SELECT status FROM mbox.kds_tasks
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND order_item_id=$3::uuid
      ORDER BY id FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, row.order_item_id])
    if (tasks.rows.some((task) => ['preparing','ready'].includes(task.status))) return {
      safe: false, reason: '商品已进入制作或待送达状态，必须先处理出品异常并确认顾客未收到商品',
    }
    if (!employeeConfirmed && tasks.rows.some((task) => ['cancelled','failed'].includes(task.status))) return {
      safe: false, reason: '出品曾失败或被取消，需要授权员工核对库存与实际交付后处理',
    }
    return { safe: true }
  }

  private async markRecoveryReview(
    row: RedemptionResolutionRow,
    workerId: string,
    now: string,
    reason: string,
  ): Promise<void> {
    const updated = await this.transaction.query(`
      UPDATE mbox.member_redemptions SET failure_code='fulfillment_timeout',
        recovery_state='manual_review',recovery_source='worker',
        recovery_requested_at=$4::timestamptz,recovered_by_worker_id=$5
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        AND status='awaiting_fulfillment' AND recovery_state='not_required'
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, row.id, now, workerId])
    if (updated.rowCount !== 1) return
    await this.event(
      row.id, 'recovery_review_required', 'awaiting_fulfillment', 'awaiting_fulfillment',
      'system', workerId, reason, `redemption-timeout-review:${row.id}`,
    )
    await this.auditRecovery(row, workerId, now, 'loyalty.redemption.recovery_review_required', 0)
  }

  private async restoreUnfulfilled(
    row: RedemptionResolutionRow,
    membership: MembershipRow,
    terminalStatus: 'cancelled' | 'failed' | 'expired',
    failureCode: RedemptionFailureCode,
    reason: string,
    now: string,
    actor: Readonly<{
      source: 'customer' | 'employee' | 'worker'
      employeeId: string | null
      workerId: string | null
    }>,
    idempotencyKey: string,
  ): Promise<void> {
    if (row.order_id) await this.cancelPendingProductOrder(row.order_id, reason)
    const restored = await this.restorePoints(
      membership,row.id,row.public_id,row.points_used,row.restore_expired_points_days,now,
    )
    await this.releaseCatalogInventory(row.catalog_item_id, row.business_date)
    const updated = await this.transaction.query(`
      UPDATE mbox.member_redemptions SET status=$4,failure_code=$5,failure_reason=$6,
        cancelled_at=$7::timestamptz,recovery_state='restored',recovery_source=$8,
        recovery_requested_at=COALESCE(recovery_requested_at,$7::timestamptz),
        recovered_at=$7::timestamptz,recovered_by_employee_id=$9::uuid,
        recovered_by_worker_id=$10,points_restored=$11,points_restored_at=$7::timestamptz,
        catalog_inventory_released_at=$7::timestamptz
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        AND status='awaiting_fulfillment'
    `, [
      this.transaction.scope.tenantId,this.transaction.scope.storeId,row.id,terminalStatus,
      failureCode,reason,now,actor.source,actor.employeeId,actor.workerId,restored,
    ])
    if (updated.rowCount !== 1) throw new Error('Redemption lost its recovery transition')
    await this.event(
      row.id,'points_restored','awaiting_fulfillment',terminalStatus,
      actor.source === 'worker' ? 'system' : actor.source,
      actor.employeeId ?? actor.workerId ?? row.customer_id,
      '积分已按原兑换批次返还',`${idempotencyKey}:points-restored`,
    )
    await this.event(
      row.id,terminalStatus === 'expired' ? 'expired' : terminalStatus,
      'awaiting_fulfillment',terminalStatus,
      actor.source === 'worker' ? 'system' : actor.source,
      actor.employeeId ?? actor.workerId ?? row.customer_id,
      reason,idempotencyKey,
    )
    if (actor.source === 'worker') await this.auditRecovery(
      row,actor.workerId!,now,'loyalty.redemption.expired',restored,
    )
  }

  private async auditRecovery(
    row: RedemptionResolutionRow,
    workerId: string,
    now: string,
    action: string,
    restoredPoints: number,
  ): Promise<void> {
    await this.transaction.query(`
      INSERT INTO mbox.audit_events(
        tenant_id,store_id,actor_type,actor_ref,action,object_type,object_id,business_date,metadata
      ) SELECT $1::uuid,$2::uuid,'system',$3,$4,'member_redemption',$5,
        (($6::timestamptz AT TIME ZONE store.timezone)
          -make_interval(secs=>extract(epoch FROM store.business_day_cutoff)))::date,
        jsonb_build_object('restoredPoints',$7::integer)
      FROM mbox.stores store WHERE store.tenant_id=$1::uuid AND store.id=$2::uuid
    `, [
      this.transaction.scope.tenantId,this.transaction.scope.storeId,workerId,action,
      row.public_id,now,restoredPoints,
    ])
  }

  private async membership(customerId: string, lock: boolean): Promise<MembershipRow | null> {
    const result = await this.transaction.query<MembershipRow>(`
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
      )
      SELECT membership.id AS membership_id, membership.customer_id,
        account.id AS account_id, account.available_points, account.pending_recovery_points,
        account.redemption_status, account.current_tier, account.growth_value
      FROM mbox.customer_memberships membership
      JOIN mbox.loyalty_accounts account
        ON account.tenant_id=membership.tenant_id AND account.store_id=membership.store_id
       AND account.membership_id=membership.id
      WHERE membership.tenant_id=$1::uuid AND membership.store_id=$2::uuid
        AND membership.customer_id IN (SELECT id FROM family) AND membership.status='active'
      ORDER BY membership.joined_at, membership.id LIMIT 1
      ${lock ? 'FOR UPDATE OF membership, account' : ''}
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, customerId])
    return result.rows[0] ?? null
  }

  private async controlState(now: string, lock = false): Promise<'disabled' | 'pilot' | 'enabled' | 'paused'> {
    const emergency = await new LoyaltyOperationalControlRepository(this.transaction)
      .state('points_redemption', lock)
    if (emergency.state==='paused') return 'paused'
    const result = await this.transaction.query<{ state: 'disabled' | 'pilot' | 'enabled' | 'paused' }>(`
      SELECT state FROM mbox.loyalty_redemption_controls
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid
        AND (state<>'pilot' OR (
          (pilot_starts_at IS NULL OR pilot_starts_at<=$3::timestamptz)
          AND (pilot_ends_at IS NULL OR pilot_ends_at>$3::timestamptz)
        ))
      ${lock ? 'FOR UPDATE' : ''}
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, now])
    return result.rows[0]?.state ?? 'disabled'
  }

  private catalogRows(
    membershipId: string,
    businessDate: string,
    now: string,
    lock: boolean,
    publicId?: string,
  ): Promise<readonly CatalogRow[]> {
    return this.transaction.query<CatalogRow>(`
      SELECT control.state AS control_state, item.public_id, item.name,
        item.fulfillment_kind, item.product_id, item.benefit_definition_id,
        item.activity_id, item.points_required, item.cost_amount_minor, item.currency,
        item.total_inventory, item.daily_inventory,
        COALESCE(balance.total_consumed,0) AS total_consumed,
        COALESCE(day_balance.consumed,0) AS daily_consumed,
        item.member_daily_limit, item.member_rolling_30_day_limit,
        item.member_lifetime_limit, item.minimum_tier, item.requires_table_session,
        item.requires_employee_fulfillment, item.cancellation_allowed_before_fulfillment,
        item.restore_expired_points_days, item.available_until::text,
        item.fulfillment_timeout_minutes, item.display_snapshot,
        item.id AS catalog_item_id, item.catalog_version_id,
        COALESCE(member_count.daily_count,0) AS member_daily_count,
        COALESCE(member_count.rolling_count,0) AS member_rolling_count,
        COALESCE(member_count.lifetime_count,0) AS member_lifetime_count
      FROM mbox.redemption_catalog_items item
      JOIN mbox.redemption_catalog_versions version
        ON version.tenant_id=item.tenant_id AND version.store_id=item.store_id
       AND version.id=item.catalog_version_id AND version.status='published'
       AND version.effective_from<=$4::timestamptz
       AND (version.effective_until IS NULL OR version.effective_until>$4::timestamptz)
      JOIN mbox.loyalty_redemption_controls control
        ON control.tenant_id=item.tenant_id AND control.store_id=item.store_id
      LEFT JOIN mbox.redemption_inventory_balances balance
        ON balance.tenant_id=item.tenant_id AND balance.store_id=item.store_id
       AND balance.catalog_item_id=item.id
      LEFT JOIN mbox.redemption_daily_inventory day_balance
        ON day_balance.tenant_id=item.tenant_id AND day_balance.store_id=item.store_id
       AND day_balance.catalog_item_id=item.id AND day_balance.business_date=$3::date
      LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE redemption.business_date=$3::date)::integer AS daily_count,
          count(*) FILTER (WHERE redemption.created_at>=$4::timestamptz - interval '30 days')::integer AS rolling_count,
          count(*)::integer AS lifetime_count
        FROM mbox.member_redemptions redemption
        WHERE redemption.tenant_id=item.tenant_id AND redemption.store_id=item.store_id
          AND redemption.catalog_item_id=item.id AND redemption.membership_id=$5::uuid
          AND redemption.status IN ('authorizing','awaiting_fulfillment','fulfilled')
      ) member_count ON true
      WHERE item.tenant_id=$1::uuid AND item.store_id=$2::uuid
        AND item.status='active' AND item.available_from<=$4::timestamptz
        AND (item.available_until IS NULL OR item.available_until>$4::timestamptz)
        AND ($6::text IS NULL OR item.public_id=$6)
      ORDER BY item.points_required, item.name, item.id
      ${lock ? 'FOR UPDATE OF item, version, control' : ''}
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId,
      businessDate, now, membershipId, publicId ?? null,
    ]).then((result) => result.rows)
  }

  private async assertCustomerTableSession(
    customerId: string,tableSessionId: string | null,actorRef?: string,
  ): Promise<void> {
    if (!tableSessionId) throw new LoyaltyRedemptionError('LOYALTY_REDEMPTION_TABLE_REQUIRED', '该兑换需要先扫码进入已开台桌次')
    if (actorRef!==undefined) {
      if (!await lockBoundGuestTablePosition(this.transaction,{ tableSessionId,customerId,actorRef })) {
        throw new LoyaltyRedemptionError(
          'LOYALTY_REDEMPTION_TABLE_INVALID','桌次无效或当前会员未加入该桌次',
        )
      }
      return
    }
    const result = await this.transaction.query<{ participation_id: string | null }>(`
      SELECT mbox.lock_active_table_customer_position($1::uuid,$2::uuid) AS participation_id
    `, [tableSessionId,customerId])
    if (result.rows[0]?.participation_id === null) throw new LoyaltyRedemptionError(
      'LOYALTY_REDEMPTION_TABLE_INVALID', '桌次无效或当前会员未加入该桌次',
    )
  }

  private async reserveCatalogInventory(item: CatalogRow, businessDate: string): Promise<void> {
    if (item.total_inventory !== null) {
      const total = await this.transaction.query(`
        INSERT INTO mbox.redemption_inventory_balances (tenant_id,store_id,catalog_item_id,total_consumed)
        VALUES ($1::uuid,$2::uuid,$3::uuid,1)
        ON CONFLICT (tenant_id,store_id,catalog_item_id) DO UPDATE
        SET total_consumed=mbox.redemption_inventory_balances.total_consumed+1
        WHERE mbox.redemption_inventory_balances.total_consumed<$4
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, item.catalog_item_id, item.total_inventory])
      if (total.rowCount !== 1) throw new LoyaltyRedemptionError('LOYALTY_REDEMPTION_SOLD_OUT', '该兑换项已兑完')
    }
    if (item.daily_inventory !== null) {
      const daily = await this.transaction.query(`
        INSERT INTO mbox.redemption_daily_inventory (tenant_id,store_id,catalog_item_id,business_date,consumed)
        VALUES ($1::uuid,$2::uuid,$3::uuid,$4::date,1)
        ON CONFLICT (tenant_id,store_id,catalog_item_id,business_date) DO UPDATE
        SET consumed=mbox.redemption_daily_inventory.consumed+1
        WHERE mbox.redemption_daily_inventory.consumed<$5
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, item.catalog_item_id, businessDate, item.daily_inventory])
      if (daily.rowCount !== 1) throw new LoyaltyRedemptionError('LOYALTY_REDEMPTION_DAILY_SOLD_OUT', '该兑换项今日已兑完')
    }
  }

  private async consumePoints(
    membership: MembershipRow,
    redemptionId: string,
    publicId: string,
    points: number,
    now: string,
    orderId: string | null,
  ): Promise<void> {
    const lots = await this.transaction.query<{ id: string; remaining_points: number }>(`
      SELECT id, remaining_points FROM mbox.loyalty_point_lots
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND membership_id=$3::uuid
        AND status='available' AND remaining_points>0
        AND (expires_at IS NULL OR expires_at>$4::timestamptz)
      ORDER BY expires_at NULLS LAST, available_at, id FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, membership.membership_id, now])
    let remaining = points
    for (const lot of lots.rows) {
      if (remaining === 0) break
      const used = Math.min(remaining, lot.remaining_points)
      const after = lot.remaining_points - used
      await this.transaction.query(`
        UPDATE mbox.loyalty_point_lots SET remaining_points=$4,
          status=CASE WHEN $4=0 THEN 'consumed' ELSE 'available' END
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, lot.id, after])
      await this.transaction.query(`
        INSERT INTO mbox.redemption_point_allocations
          (tenant_id,store_id,redemption_id,point_lot_id,points)
        VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5)
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, redemptionId, lot.id, used])
      await this.transaction.query(`
        INSERT INTO mbox.loyalty_point_lot_movements (
          tenant_id,store_id,lot_id,movement_type,points_delta,balance_after,
          source_type,source_id,idempotency_key,occurred_at
        ) VALUES ($1::uuid,$2::uuid,$3::uuid,'redeem',$4,$5,'redemption',$6,$7,$8::timestamptz)
      `, [
        this.transaction.scope.tenantId, this.transaction.scope.storeId, lot.id,
        -used, after, publicId, `lot:redeem:${redemptionId}:${lot.id}`, now,
      ])
      remaining -= used
    }
    if (remaining !== 0) throw new LoyaltyRedemptionError('LOYALTY_POINT_LOTS_INCONSISTENT', '积分批次与可用余额不一致，请联系门店')
    const balance = membership.available_points - points
    await this.transaction.query(`
      UPDATE mbox.loyalty_accounts SET available_points=$4
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, membership.account_id, balance])
    await this.transaction.query(`
      UPDATE mbox.customer_memberships SET points_balance=$4
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, membership.membership_id, balance])
    await this.transaction.query(`
      INSERT INTO mbox.loyalty_point_ledger (
        tenant_id,store_id,membership_id,customer_id,entry_type,points_delta,
        balance_after,source_type,source_id,reason,order_id,idempotency_key,occurred_at
      ) VALUES (
        $1::uuid,$2::uuid,$3::uuid,$4::uuid,'redeem',$5,$6,'redemption',$7,
        '会员确认积分兑换后的批次扣减',$8::uuid,$9,$10::timestamptz
      )
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId,
      membership.membership_id, membership.customer_id, -points, balance,
      publicId, orderId, `loyalty:redemption:${redemptionId}`, now,
    ])
  }

  private async bindPointsOrder(redemptionId: string, points: number, order: SubmittedOrder, orderItemId: string): Promise<void> {
    await this.transaction.query(`
      INSERT INTO mbox.loyalty_redemption_order_items (
        tenant_id,store_id,redemption_id,order_id,order_item_id,points_used
      ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6)
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, redemptionId, order.id, orderItemId, points])
    await this.transaction.query(`
      UPDATE mbox.order_items
      SET discount_amount_minor=unit_price_minor*quantity, total_amount_minor=0,
        pricing_kind='points_redemption', loyalty_eligible_at_submission=false
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND order_id=$3::uuid
        AND id=$4::uuid AND parent_order_item_id IS NULL
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, order.id, orderItemId])
    const updated = await this.transaction.query(`
      UPDATE mbox.orders SET discount_amount_minor=subtotal_amount_minor, total_amount_minor=0
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, order.id])
    if (updated.rowCount !== 1) throw new Error('Points redemption order totals were not updated')
  }

  private async activatePointsOrder(orderId: string): Promise<void> {
    const updated = await this.transaction.query(`
      UPDATE mbox.orders SET fulfillment_state='active', fulfillment_expires_at=NULL,
        fulfillment_activated_at=clock_timestamp(), fulfillment_released_at=NULL
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        AND settlement_mode='immediate_payment' AND payment_status='unpaid'
        AND fulfillment_state='awaiting_payment' AND total_amount_minor=0
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, orderId])
    if (updated.rowCount !== 1) throw new Error('Points redemption fulfillment activation failed')
  }

  private async updateRedemptionOrder(redemptionId: string, orderId: string, orderItemId: string): Promise<void> {
    const updated = await this.transaction.query(`
      UPDATE mbox.member_redemptions
      SET status='awaiting_fulfillment', order_id=$4::uuid, order_item_id=$5::uuid
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='authorizing'
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, redemptionId, orderId, orderItemId])
    if (updated.rowCount !== 1) throw new Error('Points redemption lost its order binding transition')
  }

  private async restorePoints(
    membership: MembershipRow,
    redemptionId: string,
    publicId: string,
    points: number,
    restoreDays: number,
    now: string,
  ): Promise<number> {
    const allocations = await this.transaction.query<{
      point_lot_id: string; points: number; expires_at: string | null
    }>(`
      SELECT allocation.point_lot_id,allocation.points,lot.expires_at::text
      FROM mbox.redemption_point_allocations allocation
      JOIN mbox.loyalty_point_lots lot
        ON lot.tenant_id=allocation.tenant_id AND lot.store_id=allocation.store_id
       AND lot.id=allocation.point_lot_id
      WHERE allocation.tenant_id=$1::uuid AND allocation.store_id=$2::uuid
        AND allocation.redemption_id=$3::uuid AND allocation.restored_at IS NULL
      ORDER BY lot.expires_at NULLS LAST, lot.available_at, lot.id
      FOR UPDATE OF lot
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, redemptionId])
    const allocatedPoints = allocations.rows.reduce((total, allocation) => total + Number(allocation.points), 0)
    if (allocatedPoints !== points) throw new Error('Redemption point allocations are incomplete or already restored')
    for (const allocation of allocations.rows) {
      const updated = await this.transaction.query<{ remaining_points: number }>(`
        UPDATE mbox.loyalty_point_lots
        SET remaining_points=remaining_points+$4, status='available',
          expires_at=CASE WHEN expires_at IS NOT NULL AND expires_at<=$5::timestamptz
            THEN $5::timestamptz + make_interval(days => $6) ELSE expires_at END
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
          AND remaining_points+$4<=original_points
        RETURNING remaining_points
      `, [
        this.transaction.scope.tenantId, this.transaction.scope.storeId,
        allocation.point_lot_id, allocation.points, now, restoreDays,
      ])
      const after = updated.rows[0]?.remaining_points
      if (after === undefined) throw new Error('Point lot restoration exceeded its original amount')
      const movement = await this.transaction.query<{ id: string }>(`
        INSERT INTO mbox.loyalty_point_lot_movements (
          tenant_id,store_id,lot_id,movement_type,points_delta,balance_after,
          source_type,source_id,idempotency_key,occurred_at
        ) VALUES ($1::uuid,$2::uuid,$3::uuid,'restore',$4,$5,'redemption',$6,$7,$8::timestamptz)
        RETURNING id
      `, [
        this.transaction.scope.tenantId, this.transaction.scope.storeId,
        allocation.point_lot_id, allocation.points, after, publicId,
        `lot:restore:${redemptionId}:${allocation.point_lot_id}`, now,
      ])
      const movementId = movement.rows[0]?.id
      if (!movementId) throw new Error('Point restoration movement was not recorded')
      const marked = await this.transaction.query(`
        UPDATE mbox.redemption_point_allocations
        SET restored_at=$5::timestamptz,restoration_movement_id=$4::uuid
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid
          AND redemption_id=$3::uuid AND point_lot_id=$6::uuid AND restored_at IS NULL
      `, [
        this.transaction.scope.tenantId,this.transaction.scope.storeId,redemptionId,
        movementId,now,allocation.point_lot_id,
      ])
      if (marked.rowCount !== 1) throw new Error('Point allocation lost its restoration transition')
    }
    const account = await this.transaction.query<{ available_points: number }>(`
      UPDATE mbox.loyalty_accounts SET available_points=available_points+$4
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      RETURNING available_points
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, membership.account_id, points])
    const balance = account.rows[0]?.available_points
    if (!Number.isSafeInteger(balance)) throw new Error('Loyalty account restoration did not return a balance')
    await this.transaction.query(`
      UPDATE mbox.customer_memberships SET points_balance=$4
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, membership.membership_id, balance])
    await this.transaction.query(`
      INSERT INTO mbox.loyalty_point_ledger (
        tenant_id,store_id,membership_id,customer_id,entry_type,points_delta,
        balance_after,source_type,source_id,reason,idempotency_key,occurred_at
      ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'restore',$5,$6,
        'redemption',$7,'未履约兑换取消后按原积分批次返还',$8,$9::timestamptz)
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId,
      membership.membership_id, membership.customer_id, points, balance,
      publicId, `loyalty:redemption:${redemptionId}:restore`, now,
    ])
    return points
  }

  private async cancelPendingProductOrder(orderId: string, reason: string): Promise<void> {
    const tasks = await this.transaction.query<{ id: string; status: string }>(`
      SELECT task.id, task.status FROM mbox.kds_tasks task
      JOIN mbox.order_items item
        ON item.tenant_id=task.tenant_id AND item.store_id=task.store_id
       AND item.id=task.order_item_id
      WHERE task.tenant_id=$1::uuid AND task.store_id=$2::uuid AND item.order_id=$3::uuid
      ORDER BY task.id FOR UPDATE OF task
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, orderId])
    if (tasks.rows.some((task) => ['preparing', 'ready'].includes(task.status))) {
      throw new LoyaltyRedemptionError('LOYALTY_REDEMPTION_ALREADY_PREPARING', '商品已开始制作，不能在线取消')
    }
    for (const task of tasks.rows) {
      if (['cancelled', 'failed'].includes(task.status)) continue
      await this.transaction.query(`
        UPDATE mbox.kds_tasks SET status='cancelled', cancelled_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, task.id])
      await this.transaction.query(`
        INSERT INTO mbox.kds_task_events (
          tenant_id,store_id,kds_task_id,event_type,from_status,to_status,metadata,idempotency_key
        ) VALUES ($1::uuid,$2::uuid,$3::uuid,'redemption.cancelled',$4,'cancelled',$5::jsonb,$6)
      `, [
        this.transaction.scope.tenantId, this.transaction.scope.storeId, task.id,
        task.status, JSON.stringify({ reason }), `redemption-cancel:${task.id}`,
      ])
    }
    const reservations = await this.transaction.query<{
      id: string
      inventory_item_id: string
      order_item_id: string
      quantity: string
    }>(`
      SELECT id, inventory_item_id, order_item_id, quantity::text
      FROM mbox.inventory_order_reservations
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND order_id=$3::uuid AND status='consumed'
      ORDER BY inventory_item_id, order_item_id FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, orderId])
    for (const reservation of reservations.rows) {
      const movement = await this.transaction.query<{ id: string }>(`
        INSERT INTO mbox.inventory_movements (
          tenant_id,store_id,inventory_item_id,movement_type,quantity_delta,
          reference_type,reference_id,order_item_id,reason
        ) VALUES ($1::uuid,$2::uuid,$3::uuid,'return',$4::numeric,
          'order_item',$5::uuid,$5::uuid,$6) RETURNING id
      `, [
        this.transaction.scope.tenantId, this.transaction.scope.storeId,
        reservation.inventory_item_id, reservation.quantity, reservation.order_item_id,
        `积分兑换取消：${reason}`,
      ])
      await this.transaction.query(`
        UPDATE mbox.inventory_balances SET on_hand_quantity=on_hand_quantity+$4::numeric,
          last_movement_id=$5::uuid
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND inventory_item_id=$3::uuid
      `, [
        this.transaction.scope.tenantId, this.transaction.scope.storeId,
        reservation.inventory_item_id, reservation.quantity, movement.rows[0]!.id,
      ])
      const returned = await this.transaction.query(`
        UPDATE mbox.inventory_order_reservations
        SET status='returned',return_movement_id=$4::uuid,returned_at=clock_timestamp(),
          release_reason=$5,updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='consumed'
      `, [
        this.transaction.scope.tenantId,this.transaction.scope.storeId,reservation.id,
        movement.rows[0]!.id,`积分兑换未履约返库：${reason}`,
      ])
      if (returned.rowCount !== 1) throw new Error('Consumed redemption inventory lost its return transition')
    }
    await this.transaction.query(`
      UPDATE mbox.order_items SET status='cancelled'
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND order_id=$3::uuid AND status<>'delivered'
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, orderId])
    await this.transaction.query(`
      UPDATE mbox.orders SET status='cancelled', fulfillment_state='cancelled',
        fulfillment_activated_at=NULL, fulfillment_released_at=clock_timestamp(), cancelled_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, orderId])
  }

  private async releaseCatalogInventory(catalogItemId: string, businessDate: string): Promise<void> {
    await this.transaction.query(`
      UPDATE mbox.redemption_inventory_balances SET total_consumed=total_consumed-1
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND catalog_item_id=$3::uuid AND total_consumed>0
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, catalogItemId])
    await this.transaction.query(`
      UPDATE mbox.redemption_daily_inventory SET consumed=consumed-1
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND catalog_item_id=$3::uuid
        AND business_date=$4::date AND consumed>0
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, catalogItemId, businessDate])
  }

  private async issueBenefit(
    row: RedemptionRow & { benefit_definition_id: string | null },
    employeeId: string,
    now: string,
  ): Promise<string> {
    if (!row.benefit_definition_id || !row.customer_id) throw new Error('Benefit redemption definition is missing')
    const inserted = await this.transaction.query<{ id: string }>(`
      INSERT INTO mbox.benefits (
        tenant_id,store_id,customer_id,benefit_code,benefit_type,status,
        benefit_snapshot,valid_from,valid_until,issued_by_employee_id,
        benefit_definition_id,benefit_kind
      ) SELECT $1::uuid,$2::uuid,$3::uuid,definition.benefit_code,
        CASE definition.benefit_kind
          WHEN 'gift_product' THEN 'gift_product'
          WHEN 'activity_access' THEN 'access'
          ELSE 'other' END,
        'issued', jsonb_build_object('name',definition.name),$5::timestamptz,
        $5::timestamptz + make_interval(days => definition.validity_days),$4::uuid,
        definition.id,definition.benefit_kind
      FROM mbox.loyalty_benefit_definitions definition
      WHERE definition.tenant_id=$1::uuid AND definition.store_id=$2::uuid
        AND definition.id=$6::uuid AND definition.status='active'
      RETURNING id
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId,
      row.customer_id, employeeId, now, row.benefit_definition_id,
    ])
    if (inserted.rowCount !== 1) throw new LoyaltyRedemptionError(
      'LOYALTY_BENEFIT_DEFINITION_UNAVAILABLE', '权益定义已停用，暂不能交付',
    )
    return inserted.rows[0]!.id
  }

  private async issueEntitlement(
    redemptionId: string,
    kind: 'benefit' | 'activity' | 'service',
    employeeId: string,
    now: string,
    benefitId: string | null,
    activityId: string | null,
  ): Promise<void> {
    const inserted = await this.transaction.query(`
      INSERT INTO mbox.member_redemption_entitlements (
        tenant_id,store_id,redemption_id,entitlement_kind,benefit_id,activity_id,
        status,issued_by_employee_id,issued_at
      ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6::uuid,'issued',$7::uuid,$8::timestamptz)
      ON CONFLICT (tenant_id,store_id,redemption_id) DO NOTHING
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId,
      redemptionId, kind, benefitId, activityId, employeeId, now,
    ])
    if (inserted.rowCount !== 1) throw new LoyaltyRedemptionError(
      'LOYALTY_REDEMPTION_ENTITLEMENT_EXISTS', '该兑换已经生成履约权益',
    )
  }

  private async event(
    redemptionId: string,
    eventType: string,
    fromStatus: string | null,
    toStatus: string,
    actorType: 'customer' | 'employee' | 'system',
    actorRef: string,
    reason: string,
    idempotencyKey: string,
  ): Promise<void> {
    await this.transaction.query(`
      INSERT INTO mbox.redemption_fulfillment_events (
        tenant_id,store_id,redemption_id,event_type,from_status,to_status,
        actor_type,actor_ref,reason,idempotency_key
      ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (tenant_id,store_id,redemption_id,idempotency_key) DO NOTHING
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId,
      redemptionId, eventType, fromStatus, toStatus, actorType, actorRef, reason, idempotencyKey,
    ])
  }

  private async getById(redemptionId: string): Promise<MemberRedemptionView> {
    const result = await this.transaction.query<RedemptionRow>(`
      SELECT redemption.id, redemption.public_id,
        item.public_id AS catalog_item_public_id, item.name,
        redemption.fulfillment_kind, redemption.points_used, redemption.status,
        redemption.order_id, ordering.public_id AS order_public_id,
        redemption.order_item_id, redemption.expires_at::text,
        redemption.fulfilled_at::text, redemption.created_at::text,
        redemption.failure_code,redemption.recovery_state,
        redemption.recovery_requested_at::text,redemption.recovered_at::text,
        redemption.points_restored,
        item.display_snapshot, entitlement.entitlement_kind, entitlement.status AS entitlement_status
      FROM mbox.member_redemptions redemption
      JOIN mbox.redemption_catalog_items item
        ON item.tenant_id=redemption.tenant_id AND item.store_id=redemption.store_id
       AND item.id=redemption.catalog_item_id
      LEFT JOIN mbox.orders ordering
        ON ordering.tenant_id=redemption.tenant_id AND ordering.store_id=redemption.store_id
       AND ordering.id=redemption.order_id
      LEFT JOIN mbox.member_redemption_entitlements entitlement
        ON entitlement.tenant_id=redemption.tenant_id AND entitlement.store_id=redemption.store_id
       AND entitlement.redemption_id=redemption.id
      WHERE redemption.tenant_id=$1::uuid AND redemption.store_id=$2::uuid
        AND redemption.id=$3::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, redemptionId])
    const row = result.rows[0]
    if (!row) throw new Error('Loyalty redemption disappeared after mutation')
    return redemptionView(row)
  }
}

function catalogView(row: CatalogRow, membership: MembershipRow): RedemptionCatalogItemView {
  const tierRank = { member: 0, silver: 1, gold: 2 }
  const remainingInventory = row.total_inventory === null ? null : Math.max(0, row.total_inventory - row.total_consumed)
  const remainingDailyInventory = row.daily_inventory === null ? null : Math.max(0, row.daily_inventory - row.daily_consumed)
  let ineligibleReason: string | null = null
  if (membership.redemption_status !== 'active' || membership.pending_recovery_points > 0) ineligibleReason = '账户存在待处理积分'
  else if (membership.available_points < row.points_required) ineligibleReason = '可用积分不足'
  else if (tierRank[membership.current_tier] < tierRank[row.minimum_tier]) ineligibleReason = `仅限${tierLabel(row.minimum_tier)}会员`
  else if (remainingInventory === 0) ineligibleReason = '已兑完'
  else if (remainingDailyInventory === 0) ineligibleReason = '今日已兑完'
  else if (row.member_daily_count >= row.member_daily_limit) ineligibleReason = '今日兑换次数已达上限'
  else if (row.member_rolling_count >= row.member_rolling_30_day_limit) ineligibleReason = '近30天兑换次数已达上限'
  else if (row.member_lifetime_limit !== null && row.member_lifetime_count >= row.member_lifetime_limit) ineligibleReason = '该兑换项已达个人总上限'
  return {
    publicId: row.public_id,
    name: row.name,
    fulfillmentKind: row.fulfillment_kind,
    pointsRequired: row.points_required,
    costAmountMinor: money(row.cost_amount_minor),
    currency: row.currency,
    remainingInventory,
    remainingDailyInventory,
    memberDailyLimit: row.member_daily_limit,
    memberRolling30DayLimit: row.member_rolling_30_day_limit,
    memberLifetimeLimit: row.member_lifetime_limit,
    minimumTier: row.minimum_tier,
    requiresTableSession: row.requires_table_session,
    requiresEmployeeFulfillment: row.requires_employee_fulfillment,
    cancellationAllowedBeforeFulfillment: row.cancellation_allowed_before_fulfillment,
    availableUntil: row.available_until,
    eligible: ineligibleReason === null,
    ineligibleReason,
    display: jsonObject(row.display_snapshot),
  }
}

function redemptionView(row: RedemptionRow): MemberRedemptionView {
  return {
    publicId: row.public_id,
    catalogItemPublicId: row.catalog_item_public_id,
    name: row.name,
    fulfillmentKind: row.fulfillment_kind,
    pointsUsed: row.points_used,
    status: row.status,
    orderPublicId: row.order_public_id,
    expiresAt: row.expires_at,
    fulfilledAt: row.fulfilled_at,
    entitlementKind: row.entitlement_kind ?? null,
    entitlementStatus: row.entitlement_status ?? null,
    failureCode: row.failure_code,
    recoveryState: row.recovery_state,
    recoveryRequestedAt: row.recovery_requested_at,
    recoveredAt: row.recovered_at,
    pointsRestored: row.points_restored,
    createdAt: row.created_at,
    display: jsonObject(row.display_snapshot),
  }
}

function jsonObject(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : {}
}

function money(value: string | number): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new RangeError('Redemption money is outside the safe integer range')
  return parsed
}

function tierLabel(value: 'member' | 'silver' | 'gold'): string {
  return value === 'gold' ? '金卡' : value === 'silver' ? '银卡' : '普通'
}
