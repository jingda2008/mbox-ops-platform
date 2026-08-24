import type { ScopedTransaction } from './transaction-runner.js'
import { WechatLoyaltyNotificationRepository } from './wechat-loyalty-notification-repository.js'
import { LoyaltyTierBenefitRepository } from './loyalty-tier-benefit-repository.js'
import { LoyaltyOperationalControlRepository } from './loyalty-operational-control-repository.js'

interface AwardContextRow extends Record<string, unknown> {
  order_id: string
  customer_id: string | null
  payment_id: string
  policy_version_id: string | null
  membership_id: string | null
  account_id: string | null
  available_points: number | null
  pending_recovery_points: number | null
  growth_value: number | null
  points_numerator: number | null
  points_denominator_minor: number | null
  growth_numerator: number | null
  growth_denominator_minor: number | null
  rounding_mode: 'floor' | 'nearest' | null
  points_validity_months: number | null
  points_multiplier_numerator: number | null
  points_multiplier_denominator: number | null
  eligible_amount_minor: string | number
  currency: string
}

interface AwardRow extends Record<string, unknown> {
  id: string
  membership_id: string
  customer_id: string
  order_id: string
  payment_id: string
  policy_version_id: string
  eligible_amount_minor: string | number
  awarded_points: number
  awarded_growth: number
  reversed_amount_minor: string | number
  reversed_points: number
  reversed_growth: number
  currency: string
  available_points: number
  pending_recovery_points: number
  growth_value: number
  refund_amount_minor: string | number
  calculation_model: 'per_order_rounded' | 'exact_carry'
}

interface ExactContributionRow extends Record<string, unknown> {
  points_numerator_per_minor: string | number
  points_denominator: string | number
  growth_numerator_per_minor: string | number
  growth_denominator: string | number
  rounding_mode: 'floor' | 'nearest'
  reversed_eligible_amount_minor: string | number
}

interface SupplementExecutionContextRow extends Record<string, unknown> {
  request_id: string
  public_id: string
  requested_membership_id: string
  requested_customer_id: string
  requested_policy_version_id: string
  order_id: string
  order_customer_id: string
  currency: string
  policy_version_id: string
  membership_id: string
  membership_customer_id: string
  points_numerator: number
  points_denominator_minor: number
  growth_numerator: number
  growth_denominator_minor: number
  rounding_mode: 'floor' | 'nearest'
  points_validity_months: number
  points_multiplier_numerator: number
  points_multiplier_denominator: number
  eligible_amount_minor: string | number
}

interface LoyaltyAccountRow extends Record<string, unknown> {
  id: string
  available_points: number
  pending_recovery_points: number
  growth_value: number
}

export interface LoyaltyAccrualResult {
  applied: boolean
  membershipId: string | null
  pointsDelta: number
  growthDelta: number
  pendingRecoveryPoints: number
}

export interface LoyaltySupplementExecutionResult extends LoyaltyAccrualResult {
  status: 'executed' | 'not_required'
}

const NO_OP: LoyaltyAccrualResult = Object.freeze({
  applied: false,
  membershipId: null,
  pointsDelta: 0,
  growthDelta: 0,
  pendingRecoveryPoints: 0,
})

export class LoyaltyAccrualRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async recordPaidOrder(input: Readonly<{
    orderId: string
    paymentId: string
    occurredAt: string
  }>): Promise<LoyaltyAccrualResult> {
    if (await new LoyaltyOperationalControlRepository(this.transaction).deferPaidOrderIfPaused({
      orderId: input.orderId,
      paymentId: input.paymentId,
    })) return NO_OP
    const selected = await this.transaction.query<AwardContextRow>(`
      WITH RECURSIVE ancestry AS (
        SELECT customer.id, customer.merged_into_customer_id
        FROM mbox.orders ordering
        JOIN mbox.customers customer
          ON customer.tenant_id=ordering.tenant_id AND customer.store_id=ordering.store_id
         AND customer.id=ordering.created_by_customer_id
        WHERE ordering.tenant_id=$1::uuid AND ordering.store_id=$2::uuid
          AND ordering.id=$3::uuid
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
      ), eligible AS (
        SELECT COALESCE(SUM(item.total_amount_minor), 0)::bigint AS amount_minor
        FROM mbox.order_items item
        WHERE item.tenant_id=$1::uuid AND item.store_id=$2::uuid AND item.order_id=$3::uuid
          AND item.parent_order_item_id IS NULL AND item.status <> 'cancelled'
          AND item.total_amount_minor > 0 AND item.loyalty_eligible_at_submission
          AND NOT EXISTS (
            SELECT 1 FROM mbox.pricing_authorizations authz
            WHERE authz.tenant_id=item.tenant_id AND authz.store_id=item.store_id
              AND authz.order_id=item.order_id AND authz.status='consumed'
              AND authz.kind='gift'
          )
      )
      SELECT ordering.id AS order_id, ordering.created_by_customer_id AS customer_id,
        payment.id AS payment_id, ordering.loyalty_policy_version_id AS policy_version_id,
        membership.id AS membership_id, account.id AS account_id,
        account.available_points, account.pending_recovery_points, account.growth_value,
        policy.points_numerator, policy.points_denominator_minor,
        policy.growth_numerator, policy.growth_denominator_minor,
        policy.rounding_mode, policy.points_validity_months,
        eligible.amount_minor AS eligible_amount_minor, ordering.currency,
        ordering.loyalty_points_multiplier_numerator AS points_multiplier_numerator,
        ordering.loyalty_points_multiplier_denominator AS points_multiplier_denominator
      FROM mbox.orders ordering
      JOIN mbox.payments payment
        ON payment.tenant_id=ordering.tenant_id AND payment.store_id=ordering.store_id
       AND payment.id=$4::uuid AND payment.order_id=ordering.id AND payment.status='succeeded'
      JOIN mbox.loyalty_policy_versions policy
        ON policy.tenant_id=ordering.tenant_id AND policy.store_id=ordering.store_id
       AND policy.id=ordering.loyalty_policy_version_id
      JOIN mbox.customer_memberships membership
        ON membership.tenant_id=ordering.tenant_id AND membership.store_id=ordering.store_id
       AND membership.customer_id IN (SELECT id FROM family) AND membership.status='active'
      JOIN mbox.loyalty_accounts account
        ON account.tenant_id=membership.tenant_id AND account.store_id=membership.store_id
       AND account.membership_id=membership.id
      CROSS JOIN eligible
      WHERE ordering.tenant_id=$1::uuid AND ordering.store_id=$2::uuid
        AND ordering.id=$3::uuid AND ordering.payment_status='paid'
      ORDER BY membership.joined_at, membership.id LIMIT 1
      FOR UPDATE OF ordering, payment, policy, membership, account
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.orderId, input.paymentId])
    const row = selected.rows[0]
    if (!row || row.customer_id == null || row.policy_version_id == null
      || row.membership_id == null || row.account_id == null
      || row.points_numerator == null || row.points_denominator_minor == null
      || row.growth_numerator == null || row.growth_denominator_minor == null
      || row.rounding_mode == null || row.points_validity_months == null
      || row.points_multiplier_numerator == null || row.points_multiplier_denominator == null
      || row.available_points == null || row.pending_recovery_points == null || row.growth_value == null) {
      return NO_OP
    }
    const existing = await this.transaction.query<{ id: string }>(`
      SELECT id FROM mbox.loyalty_order_awards
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND order_id=$3::uuid
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.orderId])
    if (existing.rowCount === 1) return NO_OP

    const eligibleAmountMinor = money(row.eligible_amount_minor)
    const pointsSpec = exactRewardSpec(
      row.points_numerator, row.points_denominator_minor,
      row.points_multiplier_numerator, row.points_multiplier_denominator,
    )
    const growthSpec = exactRewardSpec(row.growth_numerator, row.growth_denominator_minor, 1, 1)
    const points = await this.applyExactCarry({
      membershipId: row.membership_id, policyVersionId: row.policy_version_id, currency: row.currency,
      rewardKind: 'points', denominator: pointsSpec.denominator, roundingMode: row.rounding_mode,
      numeratorDelta: BigInt(eligibleAmountMinor) * pointsSpec.numeratorPerMinor,
    })
    const growth = await this.applyExactCarry({
      membershipId: row.membership_id, policyVersionId: row.policy_version_id, currency: row.currency,
      rewardKind: 'growth', denominator: growthSpec.denominator, roundingMode: row.rounding_mode,
      numeratorDelta: BigInt(eligibleAmountMinor) * growthSpec.numeratorPerMinor,
    })
    const recoveredDebt = Math.min(row.pending_recovery_points, points)
    const creditedPoints = points - recoveredDebt
    const availablePoints = row.available_points + creditedPoints
    const pendingRecoveryPoints = row.pending_recovery_points - recoveredDebt
    const growthValue = row.growth_value + growth
    const awardInserted = await this.transaction.query<{ id: string }>(`
      INSERT INTO mbox.loyalty_order_awards (
        tenant_id, store_id, membership_id, customer_id, order_id, payment_id,
        policy_version_id, eligible_amount_minor, awarded_points, awarded_growth, currency, awarded_at,calculation_model
      ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::bigint,$9,$10,$11,$12::timestamptz,'exact_carry')
      RETURNING id
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId,
      row.membership_id, row.customer_id, row.order_id, row.payment_id,
      row.policy_version_id, eligibleAmountMinor, points, growth, row.currency, input.occurredAt,
    ])
    const awardId = awardInserted.rows[0]?.id
    if (!awardId) throw new Error('Loyalty order award was not inserted')
    await this.transaction.query(`
      INSERT INTO mbox.loyalty_order_reward_contributions (
        tenant_id,store_id,award_id,membership_id,customer_id,order_id,payment_id,policy_version_id,currency,
        eligible_amount_minor,points_numerator_per_minor,points_denominator,
        growth_numerator_per_minor,growth_denominator,rounding_mode
      ) VALUES (
        $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::uuid,$9,$10::bigint,
        $11::bigint,$12::bigint,$13::bigint,$14::bigint,$15
      )
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId, awardId,
      row.membership_id, row.customer_id, row.order_id, row.payment_id, row.policy_version_id,
      row.currency, eligibleAmountMinor, pointsSpec.numeratorPerMinor.toString(), pointsSpec.denominator.toString(),
      growthSpec.numeratorPerMinor.toString(), growthSpec.denominator.toString(), row.rounding_mode,
    ])
    await this.transaction.query(`
      UPDATE mbox.loyalty_accounts
      SET available_points=$4, pending_recovery_points=$5, growth_value=$6,
          redemption_status=CASE WHEN $5=0 AND redemption_status='suspended' THEN 'active' ELSE redemption_status END
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId, row.account_id,
      availablePoints, pendingRecoveryPoints, growthValue,
    ])
    await this.mirrorLegacyMembership(row.membership_id, availablePoints, growthValue)
    if (points > 0) {
      const earned = await this.transaction.query<{ id: string; expires_at: string }>(`
        INSERT INTO mbox.loyalty_point_ledger (
          tenant_id, store_id, membership_id, customer_id, entry_type, points_delta,
          balance_after, source_type, source_id, reason, expires_at, policy_version_id,
          order_id, payment_id, idempotency_key, occurred_at
        ) VALUES (
          $1::uuid,$2::uuid,$3::uuid,$4::uuid,'earn',$5,$6,'order',$7,
          '权威付款确认后的消费积分', $8::timestamptz + make_interval(months => $9),
          $10::uuid,$11::uuid,$12::uuid,$13,$8::timestamptz
        )
        RETURNING id, expires_at::text
      `, [
        this.transaction.scope.tenantId, this.transaction.scope.storeId,
        row.membership_id, row.customer_id, points, row.available_points + points, row.order_id,
        input.occurredAt, row.points_validity_months, row.policy_version_id,
        row.order_id, row.payment_id, `loyalty:order:${row.order_id}:points`,
      ])
      const earnedRow = earned.rows[0]
      if (!earnedRow) throw new Error('Loyalty earn ledger was not inserted')
      if (creditedPoints > 0) {
        await this.createPointLot({
          membershipId: row.membership_id,
          customerId: row.customer_id,
          sourceLedgerEntryId: earnedRow.id,
          sourceType: 'order',
          sourceId: row.order_id,
          points: creditedPoints,
          availableAt: input.occurredAt,
          expiresAt: earnedRow.expires_at,
          idempotencyKey: `lot:order:${row.order_id}`,
        })
      }
      if (recoveredDebt > 0) {
        await this.transaction.query(`
          INSERT INTO mbox.loyalty_point_ledger (
            tenant_id, store_id, membership_id, customer_id, entry_type, points_delta,
            balance_after, source_type, source_id, reason, policy_version_id,
            order_id, payment_id, idempotency_key, occurred_at
          ) VALUES (
            $1::uuid,$2::uuid,$3::uuid,$4::uuid,'reverse',$5,$6,'refund',$7,
            '新获得积分优先抵扣历史退款待回收积分',$8::uuid,$9::uuid,$10::uuid,$11,$12::timestamptz
          )
        `, [
          this.transaction.scope.tenantId, this.transaction.scope.storeId,
          row.membership_id, row.customer_id, -recoveredDebt, availablePoints,
          `recovery-debt:${row.order_id}`, row.policy_version_id, row.order_id, row.payment_id,
          `loyalty:order:${row.order_id}:recovery-debt`, input.occurredAt,
        ])
      }
    }
    if (growth > 0) {
      await this.transaction.query(`
        INSERT INTO mbox.loyalty_growth_ledger (
          tenant_id, store_id, membership_id, customer_id, entry_type, growth_delta,
          balance_after, policy_version_id, order_id, payment_id, source_id, reason,
          idempotency_key, occurred_at
        ) VALUES (
          $1::uuid,$2::uuid,$3::uuid,$4::uuid,'earn',$5,$6,$7::uuid,$8::uuid,$9::uuid,$8,
          '权威付款确认后的消费成长值',$10,$11::timestamptz
        )
      `, [
        this.transaction.scope.tenantId, this.transaction.scope.storeId,
        row.membership_id, row.customer_id, growth, growthValue, row.policy_version_id,
        row.order_id, row.payment_id, `loyalty:order:${row.order_id}:growth`, input.occurredAt,
      ])
    }
    await this.evaluateMembershipTier(row.membership_id, input.occurredAt, row.order_id)
    if (creditedPoints > 0) {
      await new WechatLoyaltyNotificationRepository(this.transaction).enqueuePointsCredited({
        awardId,
        pointsChange: creditedPoints,
        balanceAfter: availablePoints,
        occurredAt: input.occurredAt,
      })
    }
    return { applied: true, membershipId: row.membership_id, pointsDelta: creditedPoints, growthDelta: growth, pendingRecoveryPoints }
  }

  async reverseSucceededRefund(input: Readonly<{
    orderId: string
    paymentId: string
    refundId: string
    occurredAt: string
  }>): Promise<LoyaltyAccrualResult> {
    return this.applySucceededRefund(input, true)
  }

  private async applySucceededRefund(input: Readonly<{
    orderId: string
    paymentId: string
    refundId: string
    occurredAt: string
  }>, evaluateTier: boolean): Promise<LoyaltyAccrualResult> {
    const lockedRefund = await this.transaction.query<{
      refund_currency: string
      payment_currency: string
    }>(`
      SELECT refund.currency AS refund_currency, payment.currency AS payment_currency
      FROM mbox.orders ordering
      JOIN mbox.payments payment
        ON payment.tenant_id=ordering.tenant_id AND payment.store_id=ordering.store_id
       AND payment.id=$4::uuid AND payment.order_id=ordering.id
       AND payment.succeeded_at IS NOT NULL
       AND payment.status IN ('succeeded','partially_refunded','refunded')
      JOIN mbox.refunds refund
        ON refund.tenant_id=payment.tenant_id AND refund.store_id=payment.store_id
       AND refund.id=$5::uuid AND refund.payment_id=payment.id AND refund.status='succeeded'
      WHERE ordering.tenant_id=$1::uuid AND ordering.store_id=$2::uuid
        AND ordering.id=$3::uuid
      FOR UPDATE OF ordering, payment, refund
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId,
      input.orderId, input.paymentId, input.refundId,
    ])
    const refundFact = lockedRefund.rows[0]
    if (!refundFact) return NO_OP
    if (refundFact.refund_currency !== refundFact.payment_currency) {
      throw new Error('Succeeded refund currency does not match its authoritative payment')
    }
    const existingApplication = await this.transaction.query<{ id: string }>(`
      SELECT id FROM mbox.loyalty_award_refund_applications
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND refund_id=$3::uuid
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.refundId])
    if (existingApplication.rowCount === 1) return NO_OP

    const selected = await this.transaction.query<AwardRow>(`
      WITH eligible_refund AS (
        SELECT COALESCE(SUM(refund_item.amount_minor), 0)::bigint AS amount_minor
        FROM mbox.refund_items refund_item
        JOIN mbox.order_items item
          ON item.tenant_id=refund_item.tenant_id AND item.store_id=refund_item.store_id
         AND item.id=refund_item.order_item_id AND item.order_id=$3::uuid
        WHERE refund_item.tenant_id=$1::uuid AND refund_item.store_id=$2::uuid
          AND refund_item.refund_id=$5::uuid AND item.parent_order_item_id IS NULL
          AND item.loyalty_eligible_at_submission
      )
      SELECT award.id, award.membership_id, award.customer_id, award.order_id, award.payment_id,
        award.policy_version_id, award.eligible_amount_minor, award.awarded_points,
        award.awarded_growth, award.reversed_amount_minor, award.reversed_points,
        award.reversed_growth, award.currency, award.calculation_model, account.available_points,
        account.pending_recovery_points, account.growth_value,
        eligible_refund.amount_minor AS refund_amount_minor
      FROM mbox.loyalty_order_awards award
      JOIN mbox.loyalty_accounts account
        ON account.tenant_id=award.tenant_id AND account.store_id=award.store_id
       AND account.membership_id=award.membership_id
      CROSS JOIN eligible_refund
      WHERE award.tenant_id=$1::uuid AND award.store_id=$2::uuid
        AND award.order_id=$3::uuid AND award.payment_id=$4::uuid
      FOR UPDATE OF award, account
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId,
      input.orderId, input.paymentId, input.refundId,
    ])
    const row = selected.rows[0]
    if (!row) return NO_OP
    if (row.currency !== refundFact.refund_currency) {
      throw new Error('Succeeded refund currency does not match its loyalty award')
    }
    const eligible = money(row.eligible_amount_minor)
    const targetAmount = money(row.reversed_amount_minor) + money(row.refund_amount_minor)
    if (targetAmount > eligible) {
      throw new Error('Succeeded eligible refunds exceed the authoritative loyalty award amount')
    }
    let targetPoints: number
    let targetGrowth: number
    let pointsToReverse: number
    let growthToReverse: number
    if (row.calculation_model === 'exact_carry') {
      const contribution = (await this.transaction.query<ExactContributionRow>(`
        SELECT points_numerator_per_minor,points_denominator,growth_numerator_per_minor,
          growth_denominator,rounding_mode,reversed_eligible_amount_minor
        FROM mbox.loyalty_order_reward_contributions
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND order_id=$3::uuid AND payment_id=$4::uuid
        FOR UPDATE
      `, [
        this.transaction.scope.tenantId, this.transaction.scope.storeId, row.order_id, row.payment_id,
      ])).rows[0]
      if (!contribution) throw new Error('Exact-carry loyalty award is missing its original contribution fact')
      if (money(contribution.reversed_eligible_amount_minor) + money(row.refund_amount_minor) !== targetAmount) {
        throw new Error('Exact-carry loyalty contribution refund amount no longer matches its award')
      }
      const pointsDelta = await this.applyExactCarry({
        membershipId: row.membership_id, policyVersionId: row.policy_version_id, currency: row.currency,
        rewardKind: 'points', denominator: bigint(contribution.points_denominator, 'points carry denominator'),
        roundingMode: contribution.rounding_mode,
        numeratorDelta: -BigInt(money(row.refund_amount_minor))
          * bigint(contribution.points_numerator_per_minor, 'points contribution numerator'),
      })
      const growthDelta = await this.applyExactCarry({
        membershipId: row.membership_id, policyVersionId: row.policy_version_id, currency: row.currency,
        rewardKind: 'growth', denominator: bigint(contribution.growth_denominator, 'growth carry denominator'),
        roundingMode: contribution.rounding_mode,
        numeratorDelta: -BigInt(money(row.refund_amount_minor))
          * bigint(contribution.growth_numerator_per_minor, 'growth contribution numerator'),
      })
      if (pointsDelta > 0 || growthDelta > 0) throw new Error('Exact-carry refund unexpectedly increased a reward')
      pointsToReverse = -pointsDelta
      growthToReverse = -growthDelta
      targetPoints = row.reversed_points + pointsToReverse
      targetGrowth = row.reversed_growth + growthToReverse
      await this.transaction.query(`
        UPDATE mbox.loyalty_order_reward_contributions
        SET reversed_eligible_amount_minor=$4::bigint
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND order_id=$3::uuid
      `, [
        this.transaction.scope.tenantId, this.transaction.scope.storeId, row.order_id, targetAmount,
      ])
    } else {
      targetPoints = eligible === 0 ? 0 : proportional(row.awarded_points, targetAmount, eligible)
      targetGrowth = eligible === 0 ? 0 : proportional(row.awarded_growth, targetAmount, eligible)
      pointsToReverse = Math.max(0, targetPoints - row.reversed_points)
      growthToReverse = Math.max(0, targetGrowth - row.reversed_growth)
    }

    const applicationInserted = await this.transaction.query<{ id: string }>(`
      INSERT INTO mbox.loyalty_award_refund_applications (
        tenant_id, store_id, award_id, refund_id, order_id, payment_id,
        eligible_refund_amount_minor, reversed_points, reversed_growth, applied_at
      ) VALUES (
        $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::bigint,$8,$9,$10::timestamptz
      )
      RETURNING id
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId,
      row.id, input.refundId, row.order_id, row.payment_id,
      money(row.refund_amount_minor), pointsToReverse, growthToReverse, input.occurredAt,
    ])
    const refundApplicationId = applicationInserted.rows[0]?.id
    if (!refundApplicationId) throw new Error('Loyalty refund application was not inserted')

    await this.transaction.query(`
      UPDATE mbox.loyalty_order_awards
      SET reversed_amount_minor=$4::bigint, reversed_points=$5, reversed_growth=$6
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId,
      row.id, targetAmount, targetPoints, targetGrowth,
    ])

    if (pointsToReverse === 0 && growthToReverse === 0) {
      return {
        applied: true,
        membershipId: row.membership_id,
        pointsDelta: 0,
        growthDelta: 0,
        pendingRecoveryPoints: row.pending_recovery_points,
      }
    }

    const deductedPoints = await this.consumePointLots(
      row.membership_id,
      pointsToReverse,
      'reverse',
      'refund',
      input.refundId,
      `lot:refund:${input.refundId}`,
      input.occurredAt,
    )
    const recoveryDebt = pointsToReverse - deductedPoints
    const availablePoints = row.available_points - deductedPoints
    const pendingRecoveryPoints = row.pending_recovery_points + recoveryDebt
    const growthValue = Math.max(0, row.growth_value - growthToReverse)
    await this.transaction.query(`
      UPDATE mbox.loyalty_accounts
      SET available_points=$4, pending_recovery_points=$5, growth_value=$6,
        redemption_status=CASE WHEN $5 > 0 THEN 'suspended' ELSE redemption_status END
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND membership_id=$3::uuid
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId,
      row.membership_id, availablePoints, pendingRecoveryPoints, growthValue,
    ])
    await this.mirrorLegacyMembership(row.membership_id, availablePoints, growthValue)
    if (pointsToReverse > 0) {
      await this.transaction.query(`
        INSERT INTO mbox.loyalty_point_ledger (
          tenant_id, store_id, membership_id, customer_id, entry_type, points_delta,
          balance_after, source_type, source_id, reason, policy_version_id,
          order_id, payment_id, refund_id, idempotency_key, occurred_at
        ) VALUES (
          $1::uuid,$2::uuid,$3::uuid,$4::uuid,'reverse',$5,$6,'refund',$7,
          '权威退款成功后的原政策积分冲回',$8::uuid,$9::uuid,$10::uuid,$11::uuid,$12,$13::timestamptz
        )
      `, [
        this.transaction.scope.tenantId, this.transaction.scope.storeId,
        row.membership_id, row.customer_id, -pointsToReverse, availablePoints,
        input.refundId, row.policy_version_id, row.order_id, row.payment_id,
        input.refundId, `loyalty:refund:${input.refundId}:points`, input.occurredAt,
      ])
    }
    if (growthToReverse > 0) {
      await this.transaction.query(`
        INSERT INTO mbox.loyalty_growth_ledger (
          tenant_id, store_id, membership_id, customer_id, entry_type, growth_delta,
          balance_after, policy_version_id, order_id, payment_id, refund_id,
          source_id, reason, idempotency_key, occurred_at
        ) VALUES (
          $1::uuid,$2::uuid,$3::uuid,$4::uuid,'reverse',$5,$6,$7::uuid,$8::uuid,$9::uuid,$10::uuid,
          $10,'权威退款成功后的原政策成长值冲回',$11,$12::timestamptz
        )
      `, [
        this.transaction.scope.tenantId, this.transaction.scope.storeId,
        row.membership_id, row.customer_id, -growthToReverse, growthValue,
        row.policy_version_id, row.order_id, row.payment_id, input.refundId,
        `loyalty:refund:${input.refundId}:growth`, input.occurredAt,
      ])
    }
    if (evaluateTier) {
      await this.evaluateMembershipTier(row.membership_id, input.occurredAt, input.refundId)
    }
    if (pointsToReverse > 0) {
      await new WechatLoyaltyNotificationRepository(this.transaction).enqueuePointsReversed({
        refundApplicationId,
        pointsChange: -pointsToReverse,
        balanceAfter: availablePoints,
        occurredAt: input.occurredAt,
      })
    }
    return {
      applied: true,
      membershipId: row.membership_id,
      pointsDelta: -pointsToReverse,
      growthDelta: -growthToReverse,
      pendingRecoveryPoints,
    }
  }

  private async applyExactCarry(input: Readonly<{
    membershipId: string
    policyVersionId: string
    currency: string
    rewardKind: 'points' | 'growth'
    denominator: bigint
    roundingMode: 'floor' | 'nearest'
    numeratorDelta: bigint
  }>): Promise<number> {
    assertPostgresBigInt(input.denominator, 'loyalty carry denominator')
    if (input.denominator <= 0n) throw new RangeError('Loyalty carry denominator must be positive')
    assertPostgresBigInt(input.numeratorDelta, 'loyalty carry contribution')
    await this.transaction.query(`
      INSERT INTO mbox.loyalty_reward_carry_balances (
        tenant_id,store_id,membership_id,policy_version_id,currency,reward_kind,denominator,rounding_mode
      ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7::bigint,$8)
      ON CONFLICT (tenant_id,store_id,membership_id,policy_version_id,currency,reward_kind) DO NOTHING
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId, input.membershipId,
      input.policyVersionId, input.currency, input.rewardKind, input.denominator.toString(), input.roundingMode,
    ])
    const selected = await this.transaction.query<{
      id: string; denominator: string | number; remainder_numerator: string | number
      rounding_mode: 'floor' | 'nearest'
    }>(`
      SELECT id,denominator,remainder_numerator,rounding_mode
      FROM mbox.loyalty_reward_carry_balances
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND membership_id=$3::uuid
        AND policy_version_id=$4::uuid AND currency=$5 AND reward_kind=$6
      FOR UPDATE
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId, input.membershipId,
      input.policyVersionId, input.currency, input.rewardKind,
    ])
    const carry = selected.rows[0]
    if (!carry || carry.rounding_mode !== input.roundingMode) {
      throw new Error('Loyalty exact carry identity does not match its frozen policy')
    }
    const previousDenominator = bigint(carry.denominator, 'loyalty carry denominator')
    const denominator = leastCommonMultiple(previousDenominator, input.denominator)
    const total = bigint(carry.remainder_numerator, 'loyalty carry remainder')
      * (denominator / previousDenominator)
      + input.numeratorDelta * (denominator / input.denominator)
    const settled = roundExact(total, denominator, input.roundingMode)
    const remainder = total - settled * denominator
    assertPostgresBigInt(remainder, 'loyalty carry remainder')
    await this.transaction.query(`
      UPDATE mbox.loyalty_reward_carry_balances
      SET remainder_numerator=$4::bigint,denominator=$5::bigint
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId, carry.id, remainder.toString(), denominator.toString(),
    ])
    return safeRewardInteger(settled, 'Exact loyalty carry reward')
  }

  async executeApprovedSupplement(input: Readonly<{
    requestId: string
    occurredAt: string
  }>): Promise<LoyaltySupplementExecutionResult> {
    const selected = await this.transaction.query<SupplementExecutionContextRow>(`
      WITH RECURSIVE ancestry AS (
        SELECT customer.id, customer.merged_into_customer_id
        FROM mbox.loyalty_supplement_requests request
        JOIN mbox.orders ordering
          ON ordering.tenant_id=request.tenant_id AND ordering.store_id=request.store_id
         AND ordering.id=request.order_id
        JOIN mbox.customers customer
          ON customer.tenant_id=ordering.tenant_id AND customer.store_id=ordering.store_id
         AND customer.id=ordering.created_by_customer_id
        WHERE request.tenant_id=$1::uuid AND request.store_id=$2::uuid
          AND request.id=$3::uuid
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
      ), eligible AS (
        SELECT COALESCE(SUM(item.total_amount_minor),0)::bigint AS amount_minor
        FROM mbox.loyalty_supplement_requests request
        JOIN mbox.order_items item
          ON item.tenant_id=request.tenant_id AND item.store_id=request.store_id
         AND item.order_id=request.order_id
        WHERE request.tenant_id=$1::uuid AND request.store_id=$2::uuid
          AND request.id=$3::uuid AND item.parent_order_item_id IS NULL
          AND item.status<>'cancelled' AND item.total_amount_minor>0
          AND item.loyalty_eligible_at_submission
          AND NOT EXISTS (
            SELECT 1 FROM mbox.pricing_authorizations authz
            WHERE authz.tenant_id=item.tenant_id AND authz.store_id=item.store_id
              AND authz.order_id=item.order_id AND authz.status='consumed' AND authz.kind='gift'
          )
      )
      SELECT request.id AS request_id, request.public_id,
        request.membership_id AS requested_membership_id,
        request.customer_id AS requested_customer_id,
        request.policy_version_id AS requested_policy_version_id,
        ordering.id AS order_id, ordering.created_by_customer_id AS order_customer_id,
        ordering.currency, ordering.loyalty_policy_version_id AS policy_version_id,
        membership.id AS membership_id, membership.customer_id AS membership_customer_id,
        policy.points_numerator, policy.points_denominator_minor,
        policy.growth_numerator, policy.growth_denominator_minor,
        policy.rounding_mode, policy.points_validity_months,
        ordering.loyalty_points_multiplier_numerator AS points_multiplier_numerator,
        ordering.loyalty_points_multiplier_denominator AS points_multiplier_denominator,
        eligible.amount_minor AS eligible_amount_minor
      FROM mbox.loyalty_supplement_requests request
      JOIN mbox.orders ordering
        ON ordering.tenant_id=request.tenant_id AND ordering.store_id=request.store_id
       AND ordering.id=request.order_id
      JOIN mbox.loyalty_policy_versions policy
        ON policy.tenant_id=request.tenant_id AND policy.store_id=request.store_id
       AND policy.id=ordering.loyalty_policy_version_id
      JOIN mbox.customer_memberships membership
        ON membership.tenant_id=request.tenant_id AND membership.store_id=request.store_id
       AND membership.customer_id IN (SELECT id FROM family) AND membership.status='active'
      CROSS JOIN eligible
      WHERE request.tenant_id=$1::uuid AND request.store_id=$2::uuid
        AND request.id=$3::uuid AND request.status='approved'
        AND ordering.payment_status IN ('paid','partially_refunded','refunded')
        AND ordering.created_by_customer_id IS NOT NULL
        AND ordering.loyalty_policy_version_id IS NOT NULL
      ORDER BY membership.joined_at, membership.id LIMIT 1
      FOR UPDATE OF request, ordering, membership, policy
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.requestId])
    const row = selected.rows[0]
    if (!row) throw new Error('Approved loyalty supplement no longer has an authoritative eligible order')
    if (row.requested_membership_id !== row.membership_id
      || row.requested_customer_id !== row.order_customer_id
      || row.requested_policy_version_id !== row.policy_version_id) {
      throw new Error('Approved loyalty supplement anchors no longer match the authoritative order')
    }

    const payments = await this.transaction.query<{ id: string }>(`
      SELECT id FROM mbox.payments
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND order_id=$3::uuid
        AND succeeded_at IS NOT NULL
        AND status IN ('succeeded','partially_refunded','refunded')
      ORDER BY succeeded_at, id
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, row.order_id])
    if (payments.rowCount !== 1 || !payments.rows[0]) {
      throw new Error('Approved loyalty supplement requires exactly one authoritative succeeded payment')
    }
    const paymentId = payments.rows[0].id
    const refunds = await this.transaction.query<{ id: string; completed_at: string | null }>(`
      SELECT id, completed_at::text
      FROM mbox.refunds
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND payment_id=$3::uuid
        AND status='succeeded'
      ORDER BY completed_at, id
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, paymentId])
    if (refunds.rows.some((refund) => refund.completed_at === null)) {
      throw new Error('Succeeded historical refund is missing its authoritative completion time')
    }

    const accountSelected = await this.transaction.query<LoyaltyAccountRow>(`
      SELECT id, available_points, pending_recovery_points, growth_value
      FROM mbox.loyalty_accounts
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND membership_id=$3::uuid
        AND customer_id=$4::uuid
      FOR UPDATE
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId,
      row.membership_id, row.membership_customer_id,
    ])
    const account = accountSelected.rows[0]
    if (!account) throw new Error('Approved loyalty supplement no longer has an authoritative loyalty account')

    const existingAward = await this.transaction.query<AwardRow>(`
      SELECT award.id, award.membership_id, award.customer_id, award.order_id, award.payment_id,
        award.policy_version_id, award.eligible_amount_minor, award.awarded_points,
        award.awarded_growth, award.reversed_amount_minor, award.reversed_points,
        award.reversed_growth, award.currency, 0 AS available_points,
        0 AS pending_recovery_points, 0 AS growth_value, 0 AS refund_amount_minor
      FROM mbox.loyalty_order_awards award
      WHERE award.tenant_id=$1::uuid AND award.store_id=$2::uuid AND award.order_id=$3::uuid
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, row.order_id])
    const award = existingAward.rows[0]
    const eligibleAmountMinor = money(row.eligible_amount_minor)
    const expectedPoints = applyMultiplier(calculateReward(
      eligibleAmountMinor, row.points_numerator, row.points_denominator_minor, row.rounding_mode,
    ), row.points_multiplier_numerator, row.points_multiplier_denominator, row.rounding_mode)
    const expectedGrowth = calculateReward(
      eligibleAmountMinor, row.growth_numerator, row.growth_denominator_minor, row.rounding_mode,
    )
    if (award && (award.membership_id !== row.membership_id
      || award.customer_id !== row.order_customer_id
      || award.payment_id !== paymentId
      || award.policy_version_id !== row.policy_version_id
      || award.currency !== row.currency
      || money(award.eligible_amount_minor) !== eligibleAmountMinor
      || award.awarded_points > expectedPoints
      || award.awarded_growth > expectedGrowth)) {
      throw new Error('Existing loyalty award does not match the authoritative supplement facts')
    }

    const existingPoints = award?.awarded_points ?? 0
    const existingGrowth = award?.awarded_growth ?? 0
    const pointsToAward = expectedPoints - existingPoints
    const growthToAward = expectedGrowth - existingGrowth
    const alreadyComplete = pointsToAward === 0 && growthToAward === 0
    if (!alreadyComplete) {
      await new LoyaltyOperationalControlRepository(this.transaction).assertPositiveAccrualActive()
    }
    if (!alreadyComplete && award) {
      const applications = await this.transaction.query<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM mbox.loyalty_award_refund_applications
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND award_id=$3::uuid
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, award.id])
      if (Number(applications.rows[0]?.count ?? 0) > 0) {
        throw new Error('A partially awarded order with applied refunds requires manual integrity review')
      }
    }

    let awardId = award?.id
    if (!awardId) {
      const insertedAward = await this.transaction.query<{ id: string }>(`
        INSERT INTO mbox.loyalty_order_awards (
          tenant_id, store_id, membership_id, customer_id, order_id, payment_id,
          policy_version_id, eligible_amount_minor, awarded_points, awarded_growth,
          currency, awarded_at
        ) VALUES (
          $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,
          $8::bigint,$9,$10,$11,$12::timestamptz
        ) RETURNING id
      `, [
        this.transaction.scope.tenantId, this.transaction.scope.storeId,
        row.membership_id, row.order_customer_id, row.order_id, paymentId,
        row.policy_version_id, eligibleAmountMinor, expectedPoints, expectedGrowth,
        row.currency, input.occurredAt,
      ])
      awardId = insertedAward.rows[0]?.id
      if (!awardId) throw new Error('Approved loyalty supplement did not create its authoritative award')
    } else if (!alreadyComplete) {
      await this.transaction.query(`
        UPDATE mbox.loyalty_order_awards
        SET awarded_points=$4, awarded_growth=$5
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      `, [
        this.transaction.scope.tenantId, this.transaction.scope.storeId,
        awardId, expectedPoints, expectedGrowth,
      ])
    }

    const recoveredDebt = Math.min(account.pending_recovery_points, pointsToAward)
    const creditedPoints = pointsToAward - recoveredDebt
    const availablePoints = account.available_points + creditedPoints
    const pendingRecoveryPoints = account.pending_recovery_points - recoveredDebt
    const growthValue = account.growth_value + growthToAward
    if (!alreadyComplete) {
      await this.transaction.query(`
        UPDATE mbox.loyalty_accounts
        SET available_points=$4, pending_recovery_points=$5, growth_value=$6,
            redemption_status=CASE WHEN $5=0 AND redemption_status='suspended' THEN 'active' ELSE redemption_status END
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND membership_id=$3::uuid
      `, [
        this.transaction.scope.tenantId, this.transaction.scope.storeId,
        row.membership_id, availablePoints, pendingRecoveryPoints, growthValue,
      ])
      await this.mirrorLegacyMembership(row.membership_id, availablePoints, growthValue)
    }
    if (pointsToAward > 0) {
      const ledger = await this.transaction.query<{ id: string; expires_at: string }>(`
        INSERT INTO mbox.loyalty_point_ledger (
          tenant_id, store_id, membership_id, customer_id, entry_type, points_delta,
          balance_after, source_type, source_id, reason, expires_at, policy_version_id,
          order_id, payment_id, idempotency_key, occurred_at
        ) VALUES (
          $1::uuid,$2::uuid,$3::uuid,$4::uuid,'supplement',$5,$6,'order',$7,
          '双人审批后的漏积分补发',$8::timestamptz + make_interval(months => $9),
          $10::uuid,$11::uuid,$12::uuid,$13,$8::timestamptz
        ) RETURNING id, expires_at::text
      `, [
        this.transaction.scope.tenantId, this.transaction.scope.storeId,
        row.membership_id, row.order_customer_id, pointsToAward,
        account.available_points + pointsToAward, row.public_id,
        input.occurredAt, row.points_validity_months, row.policy_version_id,
        row.order_id, paymentId, `loyalty:supplement:${row.request_id}:points`,
      ])
      const entry = ledger.rows[0]
      if (!entry) throw new Error('Loyalty supplement ledger was not inserted')
      if (creditedPoints > 0) {
        await this.createPointLot({
          membershipId: row.membership_id,
          customerId: row.order_customer_id,
          sourceLedgerEntryId: entry.id,
          sourceType: 'supplement',
          sourceId: row.public_id,
          points: creditedPoints,
          availableAt: input.occurredAt,
          expiresAt: entry.expires_at,
          idempotencyKey: `lot:supplement:${row.request_id}`,
        })
      }
      if (recoveredDebt > 0) {
        await this.transaction.query(`
          INSERT INTO mbox.loyalty_point_ledger (
            tenant_id, store_id, membership_id, customer_id, entry_type, points_delta,
            balance_after, source_type, source_id, reason, policy_version_id,
            order_id, idempotency_key, occurred_at
          ) VALUES (
            $1::uuid,$2::uuid,$3::uuid,$4::uuid,'reverse',$5,$6,'refund',$7,
            '补发积分优先抵扣历史退款待回收积分',$8::uuid,$9::uuid,$10,$11::timestamptz
          )
        `, [
          this.transaction.scope.tenantId, this.transaction.scope.storeId,
          row.membership_id, row.order_customer_id, -recoveredDebt, availablePoints,
          `recovery-debt:${row.public_id}`, row.policy_version_id, row.order_id,
          `loyalty:supplement:${row.request_id}:recovery-debt`, input.occurredAt,
        ])
      }
    }
    if (growthToAward > 0) {
      await this.transaction.query(`
        INSERT INTO mbox.loyalty_growth_ledger (
          tenant_id, store_id, membership_id, customer_id, entry_type, growth_delta,
          balance_after, policy_version_id, order_id, payment_id, source_id,
          reason, idempotency_key, occurred_at
        ) VALUES (
          $1::uuid,$2::uuid,$3::uuid,$4::uuid,'supplement',$5,$6,$7::uuid,$8::uuid,$9::uuid,$10,
          '双人审批后的漏成长值补发',$11,$12::timestamptz
        )
      `, [
        this.transaction.scope.tenantId, this.transaction.scope.storeId,
        row.membership_id, row.order_customer_id, growthToAward, growthValue,
        row.policy_version_id, row.order_id, paymentId, row.public_id,
        `loyalty:supplement:${row.request_id}:growth`, input.occurredAt,
      ])
    }

    let tierRelevantChange = growthToAward > 0
    for (const refund of refunds.rows) {
      const refundApplication = await this.applySucceededRefund({
        orderId: row.order_id,
        paymentId,
        refundId: refund.id,
        occurredAt: refund.completed_at!,
      }, false)
      tierRelevantChange ||= refundApplication.growthDelta !== 0
    }

    const status = alreadyComplete ? 'not_required' : 'executed'
    const executed = await this.transaction.query(`
      UPDATE mbox.loyalty_supplement_requests
      SET status=$4, executed_at=$5::timestamptz
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='approved'
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId,
      row.request_id, status, input.occurredAt,
    ])
    if (executed.rowCount !== 1) throw new Error('Loyalty supplement execution lost its state transition')
    if (tierRelevantChange) {
      await this.evaluateMembershipTier(row.membership_id, input.occurredAt, row.public_id)
    }
    const finalAccount = await this.transaction.query<LoyaltyAccountRow>(`
      SELECT id, available_points, pending_recovery_points, growth_value
      FROM mbox.loyalty_accounts
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND membership_id=$3::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, row.membership_id])
    const final = finalAccount.rows[0]
    if (!final) throw new Error('Loyalty account disappeared during supplement execution')
    return {
      status,
      applied: status === 'executed',
      membershipId: row.membership_id,
      pointsDelta: final.available_points - account.available_points,
      growthDelta: final.growth_value - account.growth_value,
      pendingRecoveryPoints: final.pending_recovery_points,
    }
  }

  async adjustPoints(input: Readonly<{
    customerId: string
    pointsDelta: number
    reason: string
    sourceType: 'order' | 'activity' | 'benefit' | 'campaign' | 'service_recovery' | 'manual'
    sourceId: string
    employeeId: string
    idempotencyKey: string
    occurredAt: string
  }>): Promise<{
    membershipId: string
    ledgerEntryId: string
    balance: number
    delta: number
    pendingRecoveryPoints: number
  }> {
    if (!Number.isSafeInteger(input.pointsDelta) || input.pointsDelta === 0) {
      throw new TypeError('Manual loyalty adjustment must be a non-zero safe integer')
    }
    if (input.pointsDelta > 0) {
      await new LoyaltyOperationalControlRepository(this.transaction).assertPositiveAccrualActive()
    }
    const selected = await this.transaction.query<{
      membership_id: string
      account_id: string
      available_points: number
      pending_recovery_points: number
      growth_value: number
      policy_version_id: string | null
      points_validity_months: number | null
    }>(`
      SELECT membership.id AS membership_id, account.id AS account_id,
        account.available_points, account.pending_recovery_points, account.growth_value,
        policy.id AS policy_version_id, policy.points_validity_months
      FROM mbox.customer_memberships membership
      JOIN mbox.loyalty_accounts account
        ON account.tenant_id=membership.tenant_id AND account.store_id=membership.store_id
       AND account.membership_id=membership.id
      LEFT JOIN LATERAL (
        SELECT version.id, version.points_validity_months
        FROM mbox.loyalty_policy_versions version
        WHERE version.tenant_id=membership.tenant_id AND version.store_id=membership.store_id
          AND version.policy_code='BASE' AND version.status='published'
          AND version.effective_from <= $4::timestamptz
          AND (version.effective_until IS NULL OR version.effective_until > $4::timestamptz)
        ORDER BY version.version DESC, version.id DESC LIMIT 1
      ) policy ON true
      WHERE membership.tenant_id=$1::uuid AND membership.store_id=$2::uuid
        AND membership.customer_id=$3::uuid AND membership.status='active'
      ORDER BY membership.joined_at, membership.id LIMIT 1
      FOR UPDATE OF membership, account
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.customerId, input.occurredAt])
    const row = selected.rows[0]
    if (!row) throw new Error('Active loyalty account was not found')

    let balance = row.available_points
    let pendingRecoveryPoints = row.pending_recovery_points
    let creditedPoints = input.pointsDelta
    if (input.pointsDelta > 0) {
      const recoveredDebt = Math.min(pendingRecoveryPoints, input.pointsDelta)
      creditedPoints = input.pointsDelta - recoveredDebt
      pendingRecoveryPoints -= recoveredDebt
      balance += creditedPoints
    } else {
      const requested = Math.abs(input.pointsDelta)
      if (row.available_points < requested) throw new RangeError('Loyalty points balance is insufficient')
      const consumed = await this.consumePointLots(
        row.membership_id,
        requested,
        'redeem',
        'system',
        input.sourceId,
        `lot:adjust:${input.idempotencyKey}`,
        input.occurredAt,
      )
      if (consumed !== requested) throw new Error('Loyalty point lots do not match the account balance')
      balance -= requested
    }
    await this.transaction.query(`
      UPDATE mbox.loyalty_accounts
      SET available_points=$4, pending_recovery_points=$5,
          redemption_status=CASE WHEN $5=0 AND redemption_status='suspended' THEN 'active' ELSE redemption_status END
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId,
      row.account_id, balance, pendingRecoveryPoints,
    ])
    await this.mirrorLegacyMembership(row.membership_id, balance, row.growth_value)
    const ledger = await this.transaction.query<{ id: string; expires_at: string | null }>(`
      INSERT INTO mbox.loyalty_point_ledger (
        tenant_id, store_id, membership_id, customer_id, entry_type,
        points_delta, balance_after, source_type, source_id, reason,
        expires_at, policy_version_id, created_by_employee_id, idempotency_key, occurred_at
      ) VALUES (
        $1::uuid,$2::uuid,$3::uuid,$4::uuid,'adjust',$5,$6,$7,$8,$9,
        CASE WHEN $5 > 0 THEN $10::timestamptz + make_interval(months => $11) ELSE NULL END,
        $12::uuid,$13::uuid,$14,$10::timestamptz
      ) RETURNING id, expires_at::text
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId,
      row.membership_id, input.customerId, input.pointsDelta, balance,
      input.sourceType, input.sourceId, input.reason, input.occurredAt,
      row.points_validity_months ?? 18, row.policy_version_id, input.employeeId, input.idempotencyKey,
    ])
    const entry = ledger.rows[0]
    if (!entry) throw new Error('Manual loyalty adjustment ledger was not inserted')
    if (creditedPoints > 0) {
      await this.createPointLot({
        membershipId: row.membership_id,
        customerId: input.customerId,
        sourceLedgerEntryId: entry.id,
        sourceType: 'adjust',
        sourceId: input.sourceId,
        points: creditedPoints,
        availableAt: input.occurredAt,
        expiresAt: entry.expires_at,
        idempotencyKey: `lot:adjust:${input.idempotencyKey}`,
      })
    }
    return {
      membershipId: row.membership_id,
      ledgerEntryId: entry.id,
      balance,
      delta: creditedPoints,
      pendingRecoveryPoints,
    }
  }

  private async mirrorLegacyMembership(membershipId: string, points: number, growth: number): Promise<void> {
    await this.transaction.query(`
      UPDATE mbox.customer_memberships
      SET points_balance=$4, lifetime_points=$5
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, membershipId, points, growth])
  }

  private async createPointLot(input: Readonly<{
    membershipId: string
    customerId: string
    sourceLedgerEntryId: string
    sourceType: 'order' | 'supplement' | 'adjust' | 'restore'
    sourceId: string
    points: number
    availableAt: string
    expiresAt: string | null
    idempotencyKey: string
  }>): Promise<void> {
    const inserted = await this.transaction.query<{ id: string }>(`
      INSERT INTO mbox.loyalty_point_lots (
        tenant_id, store_id, membership_id, customer_id, source_ledger_entry_id,
        source_type, source_id, original_points, remaining_points,
        available_at, expires_at, status
      ) VALUES (
        $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8,$8,
        $9::timestamptz,$10::timestamptz,'available'
      ) RETURNING id
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId,
      input.membershipId, input.customerId, input.sourceLedgerEntryId,
      input.sourceType, input.sourceId, input.points, input.availableAt, input.expiresAt,
    ])
    const lot = inserted.rows[0]
    if (!lot) throw new Error('Loyalty point lot was not inserted')
    const movementSourceType = input.sourceType === 'adjust' ? 'manual' : input.sourceType
    await this.transaction.query(`
      INSERT INTO mbox.loyalty_point_lot_movements (
        tenant_id, store_id, lot_id, movement_type, points_delta, balance_after,
        source_type, source_id, idempotency_key, occurred_at
      ) VALUES ($1::uuid,$2::uuid,$3::uuid,'grant',$4,$4,$5,$6,$7,$8::timestamptz)
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId, lot.id,
      input.points, movementSourceType, input.sourceId, input.idempotencyKey, input.availableAt,
    ])
  }

  async evaluateMembershipTier(
    membershipId: string,
    occurredAt: string,
    sourceId: string,
    sourceType: 'automatic_growth' | 'period_review' = 'automatic_growth',
  ): Promise<void> {
    const selected = await this.transaction.query<{
      policy_id: string
      evaluation_window_months: number
      tier_period_months: number
      downgrade_grace_days: number
      silver_upgrade_growth: number
      silver_retain_growth: number
      gold_upgrade_growth: number
      gold_retain_growth: number
      current_tier: 'member' | 'silver' | 'gold'
      rolling_growth: string | number
      period_id: string | null
      period_ends_at: string | null
      period_grace_ends_at: string | null
    }>(`
      SELECT policy.id AS policy_id, policy.evaluation_window_months,
        policy.tier_period_months, policy.downgrade_grace_days,
        policy.silver_upgrade_growth, policy.silver_retain_growth,
        policy.gold_upgrade_growth, policy.gold_retain_growth,
        account.current_tier,
        COALESCE((
          SELECT SUM(ledger.growth_delta)
          FROM mbox.loyalty_growth_ledger ledger
          WHERE ledger.tenant_id=account.tenant_id AND ledger.store_id=account.store_id
            AND ledger.membership_id=account.membership_id
            AND ledger.occurred_at >= $4::timestamptz - make_interval(months => policy.evaluation_window_months)
            AND ledger.occurred_at <= $4::timestamptz
        ),0)::bigint AS rolling_growth,
        period.id AS period_id, period.ends_at::text AS period_ends_at,
        period.grace_ends_at::text AS period_grace_ends_at
      FROM mbox.loyalty_accounts account
      JOIN mbox.loyalty_tier_policy_versions policy
        ON policy.tenant_id=account.tenant_id AND policy.store_id=account.store_id
       AND policy.status='published' AND policy.effective_from <= $4::timestamptz
       AND (policy.effective_until IS NULL OR policy.effective_until > $4::timestamptz)
      LEFT JOIN mbox.membership_tier_periods period
        ON period.tenant_id=account.tenant_id AND period.store_id=account.store_id
       AND period.membership_id=account.membership_id AND period.status IN ('active','grace')
      WHERE account.tenant_id=$1::uuid AND account.store_id=$2::uuid
        AND account.membership_id=$3::uuid
      ORDER BY policy.version DESC, policy.id DESC LIMIT 1
      FOR UPDATE OF account, policy
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, membershipId, occurredAt])
    const row = selected.rows[0]
    if (!row) return
    const tierBenefits = new LoyaltyTierBenefitRepository(this.transaction)
    await tierBenefits.expireMembershipDue(membershipId, occurredAt)
    const growth = Math.max(0, Number(row.rolling_growth))
    const rank = { member: 0, silver: 1, gold: 2 } as const
    let target: 'member' | 'silver' | 'gold' = growth >= row.gold_upgrade_growth
      ? 'gold' : growth >= row.silver_upgrade_growth ? 'silver' : 'member'
    let eventType: 'upgraded' | 'downgraded' | 'retained' | null = null
    if (rank[target] > rank[row.current_tier]) {
      eventType = 'upgraded'
    } else if (rank[target] < rank[row.current_tier]) {
      const reviewAt = row.period_grace_ends_at ?? row.period_ends_at
      if (reviewAt === null || Date.parse(reviewAt) > Date.parse(occurredAt)) return
      if (row.current_tier === 'gold' && growth >= row.gold_retain_growth) target = 'gold'
      else if (row.current_tier === 'silver' && growth >= row.silver_retain_growth) target = 'silver'
      eventType = target === row.current_tier ? 'retained' : 'downgraded'
    } else {
      const reviewAt = row.period_grace_ends_at ?? row.period_ends_at
      if (row.period_id === null || reviewAt === null || Date.parse(reviewAt) > Date.parse(occurredAt)) return
      eventType = 'retained'
    }

    if (row.period_id !== null) {
      await this.transaction.query(`
        UPDATE mbox.membership_tier_periods
        SET status='completed', review_growth=$4, review_result=$5, reviewed_at=$6::timestamptz
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      `, [
        this.transaction.scope.tenantId, this.transaction.scope.storeId,
        row.period_id, growth, eventType, occurredAt,
      ])
    }
    if (target !== row.current_tier) {
      await this.transaction.query(`
        UPDATE mbox.loyalty_accounts SET current_tier=$4
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND membership_id=$3::uuid
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, membershipId, target])
      await this.transaction.query(`
        UPDATE mbox.customer_memberships SET level=$4
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, membershipId, target])
    }
    if (target !== 'member') {
      await this.transaction.query(`
        INSERT INTO mbox.membership_tier_periods (
          tenant_id, store_id, membership_id, policy_version_id, tier,
          starts_at, ends_at, grace_ends_at, status, qualification_growth
        ) VALUES (
          $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6::timestamptz,
          $6::timestamptz + make_interval(months => $7),
          $6::timestamptz + make_interval(months => $7, days => $8),
          'active',$9
        )
      `, [
        this.transaction.scope.tenantId, this.transaction.scope.storeId,
        membershipId, row.policy_id, target, occurredAt,
        row.tier_period_months, row.downgrade_grace_days, growth,
      ])
    }
    const insertedEvent = await this.transaction.query<{ id: string }>(`
      WITH inserted AS (
        INSERT INTO mbox.membership_tier_events (
          tenant_id, store_id, membership_id, policy_version_id, event_type,
          from_tier, to_tier, evaluated_growth, reason, source_type, source_id, occurred_at
        ) VALUES (
          $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,
          '按已发布等级规则和成长值事实自动评估',$9,$10,$11::timestamptz
        ) ON CONFLICT (tenant_id, store_id, membership_id, source_type, source_id, event_type)
          DO NOTHING
        RETURNING id
      )
      SELECT id FROM inserted
      UNION ALL
      SELECT id FROM mbox.membership_tier_events
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND membership_id=$3::uuid
        AND source_type=$9 AND source_id=$10 AND event_type=$5
      LIMIT 1
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId,
      membershipId, row.policy_id, eventType, row.current_tier, target,
      growth, sourceType, sourceId, occurredAt,
    ])
    const tierEventId = insertedEvent.rows[0]?.id
    if (!tierEventId) throw new Error('Membership tier event was not resolved')
    await tierBenefits.reconcileTierEvent(tierEventId)
  }

  private async consumePointLots(
    membershipId: string,
    requestedPoints: number,
    movementType: 'redeem' | 'expire' | 'reverse',
    sourceType: 'refund' | 'redemption' | 'system',
    sourceId: string,
    idempotencyPrefix: string,
    occurredAt: string,
  ): Promise<number> {
    if (requestedPoints <= 0) return 0
    const lots = await this.transaction.query<{ id: string; remaining_points: number }>(`
      SELECT id, remaining_points
      FROM mbox.loyalty_point_lots
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND membership_id=$3::uuid
        AND status='available' AND remaining_points > 0
        AND (expires_at IS NULL OR expires_at > $4::timestamptz)
      ORDER BY expires_at NULLS LAST, available_at, id
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, membershipId, occurredAt])
    let remaining = requestedPoints
    for (const lot of lots.rows) {
      if (remaining === 0) break
      const consumed = Math.min(lot.remaining_points, remaining)
      const balanceAfter = lot.remaining_points - consumed
      await this.transaction.query(`
        UPDATE mbox.loyalty_point_lots
        SET remaining_points=$4,
            status=CASE WHEN $4=0 THEN $5 ELSE 'available' END
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      `, [
        this.transaction.scope.tenantId, this.transaction.scope.storeId,
        lot.id, balanceAfter, movementType === 'reverse' ? 'reversed' : 'consumed',
      ])
      await this.transaction.query(`
        INSERT INTO mbox.loyalty_point_lot_movements (
          tenant_id, store_id, lot_id, movement_type, points_delta, balance_after,
          source_type, source_id, idempotency_key, occurred_at
        ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10::timestamptz)
      `, [
        this.transaction.scope.tenantId, this.transaction.scope.storeId, lot.id,
        movementType, -consumed, balanceAfter, sourceType, sourceId,
        `${idempotencyPrefix}:${lot.id}`, occurredAt,
      ])
      remaining -= consumed
    }
    return requestedPoints - remaining
  }
}

function money(value: string | number): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new RangeError('Loyalty money amount is outside the safe integer range')
  return parsed
}

function bigint(value: string | number, label: string): bigint {
  try {
    const parsed = BigInt(value)
    assertPostgresBigInt(parsed, label)
    return parsed
  } catch {
    throw new RangeError(`${label} is outside the supported integer range`)
  }
}

function exactRewardSpec(
  numerator: number,
  denominatorMinor: number,
  multiplierNumerator: number,
  multiplierDenominator: number,
): Readonly<{ numeratorPerMinor: bigint; denominator: bigint }> {
  if (![numerator, denominatorMinor, multiplierNumerator, multiplierDenominator]
    .every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new RangeError('Loyalty exact reward policy contains an invalid ratio')
  }
  const numeratorPerMinor = BigInt(numerator) * BigInt(multiplierNumerator)
  const denominator = BigInt(denominatorMinor) * BigInt(multiplierDenominator)
  assertPostgresBigInt(numeratorPerMinor, 'loyalty reward numerator per minor')
  assertPostgresBigInt(denominator, 'loyalty reward denominator')
  return { numeratorPerMinor, denominator }
}

function roundExact(value: bigint, denominator: bigint, rounding: 'floor' | 'nearest'): bigint {
  if (rounding === 'floor') return floorDiv(value, denominator)
  return floorDiv(value + denominator / 2n, denominator)
}

function floorDiv(value: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError('Loyalty reward denominator must be positive')
  if (value >= 0n) return value / denominator
  return -((-value + denominator - 1n) / denominator)
}

function leastCommonMultiple(left: bigint, right: bigint): bigint {
  const divisor = greatestCommonDivisor(left, right)
  const result = (left / divisor) * right
  assertPostgresBigInt(result, 'loyalty carry common denominator')
  return result
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let dividend = left < 0n ? -left : left
  let divisor = right < 0n ? -right : right
  while (divisor !== 0n) [dividend, divisor] = [divisor, dividend % divisor]
  return dividend
}

function safeRewardInteger(value: bigint, label: string): number {
  const numeric = Number(value)
  if (!Number.isSafeInteger(numeric) || Math.abs(numeric) > 2_000_000_000) {
    throw new RangeError(`${label} is outside the supported range`)
  }
  return numeric
}

function assertPostgresBigInt(value: bigint, label: string): void {
  if (value < -9_223_372_036_854_775_808n || value > 9_223_372_036_854_775_807n) {
    throw new RangeError(`${label} is outside the PostgreSQL bigint range`)
  }
}

function calculateReward(
  amountMinor: number,
  numerator: number,
  denominatorMinor: number,
  rounding: 'floor' | 'nearest',
): number {
  const scaled = BigInt(amountMinor) * BigInt(numerator)
  const denominator = BigInt(denominatorMinor)
  const result = rounding === 'nearest'
    ? (scaled + denominator / 2n) / denominator
    : scaled / denominator
  const value = Number(result)
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_000_000_000) {
    throw new RangeError('Calculated loyalty reward is outside the supported range')
  }
  return value
}

function proportional(total: number, amount: number, base: number): number {
  if (total === 0 || amount === 0) return 0
  if (amount >= base) return total
  return Number((BigInt(total) * BigInt(amount)) / BigInt(base))
}

function applyMultiplier(
  base: number,
  numerator: number,
  denominator: number,
  rounding: 'floor' | 'nearest',
): number {
  if (!Number.isSafeInteger(base) || base < 0
    || !Number.isSafeInteger(numerator) || numerator < 1
    || !Number.isSafeInteger(denominator) || denominator < 1) {
    throw new RangeError('Loyalty multiplier is outside the supported range')
  }
  const scaled = BigInt(base) * BigInt(numerator)
  const divisor = BigInt(denominator)
  const result = rounding === 'nearest' ? (scaled + divisor / 2n) / divisor : scaled / divisor
  const value = Number(result)
  if (!Number.isSafeInteger(value) || value > 2_000_000_000) {
    throw new RangeError('Multiplied loyalty reward is outside the supported range')
  }
  return value
}
