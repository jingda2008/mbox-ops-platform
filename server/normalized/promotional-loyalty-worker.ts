import { LoyaltyOperationalControlRepository } from './loyalty-operational-control-repository.js'
import type { PromotionRefundPolicy, PromotionStackingMode } from './promotional-loyalty-service.js'
import type { ScopedPostgresTransactionRunner, ScopedTransaction, StoreScope } from './transaction-runner.js'

interface TriggerFactRow extends Record<string, unknown> {
  id: string
  trigger_kind: 'activity_payment' | 'activity_check_in' | 'activity_completion'
  registration_id: string
  registration_cycle: number
  activity_id: string
  payment_id: string | null
  occurred_at: string
}

interface CandidateRow extends Record<string, unknown> {
  policy_version_id: string
  rule_id: string
  rule_code: string
  points: number
  per_member_award_limit: number
  minimum_paid_amount_minor: string | number
  campaign_code: string
  stacking_group: string
  stacking_mode: PromotionStackingMode
  priority: number
  store_budget_points: number
  per_member_points_limit: number
  point_validity_days: number
  refund_policy: PromotionRefundPolicy
  budget_reuse_after_refund: boolean
  member_limit_reuse_after_refund: boolean
  eligible_member_levels: string[]
  membership_id: string | null
  customer_id: string
  account_id: string | null
  member_level: string | null
  available_points: number | null
  pending_recovery_points: number | null
  growth_value: number | null
  paid_amount_minor: string | number
  payment_refunded: boolean
}

export interface PromotionAwardCandidate {
  policyVersionId: string
  ruleId: string
  ruleCode: string
  points: number
  perMemberAwardLimit: number
  campaignCode: string
  stackingGroup: string
  stackingMode: PromotionStackingMode
  priority: number
  storeBudgetPoints: number
  perMemberPointsLimit: number
  pointValidityDays: number
  refundPolicy: PromotionRefundPolicy
  budgetReuseAfterRefund: boolean
  memberLimitReuseAfterRefund: boolean
  membershipId: string
  customerId: string
  accountId: string
  availablePoints: number
  pendingRecoveryPoints: number
  growthValue: number
}

interface RefundFactRow extends Record<string, unknown> {
  id: string
  refund_id: string
  payment_id: string
  registration_id: string
  activity_id: string
  occurred_at: string
}

interface RefundAwardRow extends Record<string, unknown> {
  award_id: string
  policy_version_id: string
  membership_id: string
  customer_id: string
  account_id: string
  awarded_points: number
  credited_points: number
  available_points: number
  pending_recovery_points: number
  growth_value: number
  refund_policy: PromotionRefundPolicy
  payment_status: string
  source_ledger_entry_id: string
}

export interface PromotionalLoyaltyBatchResult {
  workerId: string
  claimed: number
  awarded: number
  deferred: number
  notApplicable: number
  reviewRequired: number
  paused: boolean
}

export interface PromotionalLoyaltyRefundBatchResult {
  workerId: string
  claimed: number
  applications: number
  reversedPoints: number
  deferred: number
  notApplicable: number
  reviewRequired: number
}

export class PromotionalLoyaltyWorker {
  constructor(private readonly transactions: Pick<ScopedPostgresTransactionRunner, 'run'>) {}

  async runTriggerBatch(
    scope: Readonly<StoreScope>,
    workerId: string,
    batchSize = 50,
  ): Promise<PromotionalLoyaltyBatchResult> {
    validateWorker(workerId, batchSize)
    const claim = await this.transactions.run(scope, async (transaction) => {
      const control = await new LoyaltyOperationalControlRepository(transaction).state('points_accrual', true)
      const rows = (await transaction.query<TriggerFactRow>(`
        WITH candidates AS (
          SELECT id FROM mbox.loyalty_promotion_trigger_facts
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid
            AND (status IN ('pending','deferred')
              OR (status='review_required' AND updated_at<clock_timestamp()-interval '10 minutes')
              OR (status='processing' AND claimed_at<clock_timestamp()-interval '10 minutes'))
          ORDER BY occurred_at,id FOR UPDATE SKIP LOCKED LIMIT $4
        )
        UPDATE mbox.loyalty_promotion_trigger_facts fact
        SET status='processing',worker_id=$3,claimed_at=clock_timestamp(),
          pause_control_version=NULL,resolution_code=NULL,resolved_at=NULL,
          updated_at=clock_timestamp()
        FROM candidates
        WHERE fact.tenant_id=$1::uuid AND fact.store_id=$2::uuid AND fact.id=candidates.id
        RETURNING fact.id,fact.trigger_kind,fact.registration_id,
          fact.registration_cycle,fact.activity_id,fact.payment_id,fact.occurred_at::text
      `, [scope.tenantId, scope.storeId, workerId, batchSize])).rows
      return { rows, paused: control.state === 'paused' }
    })
    const result: PromotionalLoyaltyBatchResult = {
      workerId,
      claimed: claim.rows.length,
      awarded: 0,
      deferred: 0,
      notApplicable: 0,
      reviewRequired: 0,
      paused: claim.paused,
    }
    for (const fact of claim.rows) {
      try {
        const resolved = await this.transactions.run(scope, (transaction) => this.processTrigger(transaction, fact, workerId))
        result.awarded += resolved.awarded
        if (resolved.status === 'deferred') {
          result.deferred += 1
          result.paused = true
        } else if (resolved.status === 'not_applicable') result.notApplicable += 1
      } catch {
        await markReviewRequired(this.transactions, scope, 'loyalty_promotion_trigger_facts', fact.id, workerId)
        result.reviewRequired += 1
      }
    }
    return result
  }

  async runRefundBatch(
    scope: Readonly<StoreScope>,
    workerId: string,
    batchSize = 50,
  ): Promise<PromotionalLoyaltyRefundBatchResult> {
    validateWorker(workerId, batchSize)
    const claimed = await this.transactions.run(scope, async (transaction) => (
      (await transaction.query<RefundFactRow>(`
        WITH candidates AS (
          SELECT id FROM mbox.loyalty_promotion_refund_facts
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid
            AND (status IN ('pending','deferred')
              OR (status='review_required' AND updated_at<clock_timestamp()-interval '10 minutes')
              OR (status='processing' AND claimed_at<clock_timestamp()-interval '10 minutes'))
          ORDER BY occurred_at,id FOR UPDATE SKIP LOCKED LIMIT $4
        )
        UPDATE mbox.loyalty_promotion_refund_facts fact
        SET status='processing',worker_id=$3,claimed_at=clock_timestamp(),
          resolution_code=NULL,resolved_at=NULL,updated_at=clock_timestamp()
        FROM candidates
        WHERE fact.tenant_id=$1::uuid AND fact.store_id=$2::uuid AND fact.id=candidates.id
        RETURNING fact.id,fact.refund_id,fact.payment_id,fact.registration_id,
          fact.activity_id,fact.occurred_at::text
      `, [scope.tenantId, scope.storeId, workerId, batchSize])).rows
    ))
    const result: PromotionalLoyaltyRefundBatchResult = {
      workerId,
      claimed: claimed.length,
      applications: 0,
      reversedPoints: 0,
      deferred: 0,
      notApplicable: 0,
      reviewRequired: 0,
    }
    for (const fact of claimed) {
      try {
        const resolved = await this.transactions.run(scope, (transaction) => this.processRefund(transaction, fact, workerId))
        result.applications += resolved.applications
        result.reversedPoints += resolved.reversedPoints
        if (resolved.status === 'deferred') result.deferred += 1
        else if (resolved.applications === 0) result.notApplicable += 1
      } catch {
        await markReviewRequired(this.transactions, scope, 'loyalty_promotion_refund_facts', fact.id, workerId)
        result.reviewRequired += 1
      }
    }
    return result
  }

  private async processTrigger(
    transaction: ScopedTransaction,
    fact: TriggerFactRow,
    workerId: string,
  ): Promise<{ status: 'applied' | 'not_applicable' | 'deferred'; awarded: number }> {
    await lockRegistration(transaction, fact.registration_id)
    if (await registrationHasSucceededRefund(transaction, fact.registration_id)) {
      await finishTrigger(transaction, fact.id, workerId, 'not_applicable', 'refunded', 0)
      return { status: 'not_applicable', awarded: 0 }
    }
    const control = await new LoyaltyOperationalControlRepository(transaction).state('points_accrual', true)
    if (control.state === 'paused') {
      await transaction.query(`
        UPDATE mbox.loyalty_promotion_trigger_facts
        SET status='deferred',worker_id=NULL,claimed_at=NULL,
          pause_control_version=$5,resolution_code='points_accrual_paused',
          resolved_at=NULL,updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
          AND status='processing' AND worker_id=$4
      `, [transaction.scope.tenantId, transaction.scope.storeId, fact.id, workerId, control.version])
      return { status: 'deferred', awarded: 0 }
    }
    const candidates = await this.candidates(transaction, fact)
    if (candidates.kind !== 'eligible') {
      await finishTrigger(transaction, fact.id, workerId, 'not_applicable', candidates.reason, 0)
      return { status: 'not_applicable', awarded: 0 }
    }
    const selected = selectStackedCandidates(candidates.items)
    let awarded = 0
    let limited = 0
    for (const candidate of selected) {
      const applied = await this.applyAward(transaction, fact, candidate)
      if (applied) awarded += 1
      else limited += 1
    }
    const resolution = awarded > 0
      ? (limited > 0 ? 'partially_awarded' : 'awarded')
      : (selected.length === 0 ? 'stacking_excluded' : 'limit_reached')
    await finishTrigger(
      transaction,
      fact.id,
      workerId,
      awarded > 0 ? 'applied' : 'not_applicable',
      resolution,
      awarded,
    )
    return { status: awarded > 0 ? 'applied' : 'not_applicable', awarded }
  }

  private async candidates(
    transaction: ScopedTransaction,
    fact: TriggerFactRow,
  ): Promise<
    | { kind: 'eligible'; items: PromotionAwardCandidate[] }
    | { kind: 'ineligible'; reason: 'non_member' | 'refunded' | 'no_matching_policy' }
  > {
    const result = await transaction.query<CandidateRow>(`
      SELECT policy.id AS policy_version_id,rule.id AS rule_id,rule.rule_code,
        rule.points,rule.per_member_award_limit,rule.minimum_paid_amount_minor,
        policy.campaign_code,policy.stacking_group,policy.stacking_mode,policy.priority,
        policy.store_budget_points,policy.per_member_points_limit,policy.point_validity_days,
        policy.refund_policy,policy.budget_reuse_after_refund,
        policy.member_limit_reuse_after_refund,policy.eligible_member_levels,
        membership.id AS membership_id,registration.customer_id,
        account.id AS account_id,membership.level AS member_level,
        account.available_points,account.pending_recovery_points,account.growth_value,
        COALESCE(payment.amount_minor,0)::bigint AS paid_amount_minor,
        EXISTS(
          SELECT 1 FROM mbox.refunds refund
          WHERE refund.tenant_id=registration.tenant_id AND refund.store_id=registration.store_id
            AND refund.payment_id=registration.payment_id AND refund.status='succeeded'
        ) AS payment_refunded
      FROM mbox.loyalty_promotion_trigger_facts fact
      JOIN mbox.community_activity_registrations registration
        ON registration.tenant_id=fact.tenant_id AND registration.store_id=fact.store_id
       AND registration.id=fact.registration_id
       AND registration.registration_cycle=fact.registration_cycle
       AND registration.activity_id=fact.activity_id
      LEFT JOIN mbox.payments payment
        ON payment.tenant_id=registration.tenant_id AND payment.store_id=registration.store_id
       AND payment.id=fact.payment_id AND payment.payable_kind='activity_registration'
       AND payment.activity_registration_id=registration.id AND payment.status IN ('succeeded','partially_refunded','refunded')
      LEFT JOIN mbox.customer_memberships membership
        ON membership.tenant_id=registration.tenant_id AND membership.store_id=registration.store_id
       AND membership.id=registration.membership_id AND membership.customer_id=registration.customer_id
       AND membership.status='active'
      LEFT JOIN mbox.loyalty_accounts account
        ON account.tenant_id=membership.tenant_id AND account.store_id=membership.store_id
       AND account.membership_id=membership.id AND account.customer_id=membership.customer_id
      JOIN mbox.loyalty_promotion_policy_versions policy
        ON policy.tenant_id=fact.tenant_id AND policy.store_id=fact.store_id
       AND policy.activity_id=fact.activity_id AND policy.status='published'
       AND policy.effective_from<=fact.occurred_at
       AND (policy.effective_until IS NULL OR policy.effective_until>fact.occurred_at)
      JOIN mbox.loyalty_promotion_rules rule
        ON rule.tenant_id=policy.tenant_id AND rule.store_id=policy.store_id
       AND rule.policy_version_id=policy.id AND rule.enabled
       AND rule.trigger_kind=fact.trigger_kind
      WHERE fact.tenant_id=$1::uuid AND fact.store_id=$2::uuid AND fact.id=$3::uuid
        AND (fact.trigger_kind<>'activity_payment'
          OR (payment.id IS NOT NULL AND payment.amount_minor>=rule.minimum_paid_amount_minor))
      ORDER BY policy.stacking_group,policy.priority DESC,rule.points DESC,policy.id,rule.id
    `, [transaction.scope.tenantId, transaction.scope.storeId, fact.id])
    if (result.rows.length === 0) return { kind: 'ineligible', reason: 'no_matching_policy' }
    const first = result.rows[0]!
    if (first.payment_refunded) return { kind: 'ineligible', reason: 'refunded' }
    if (first.membership_id === null || first.account_id === null || first.member_level === null
      || first.available_points === null || first.pending_recovery_points === null || first.growth_value === null) {
      return { kind: 'ineligible', reason: 'non_member' }
    }
    const items = result.rows
      .filter((row) => row.membership_id !== null && row.account_id !== null
        && row.available_points !== null && row.pending_recovery_points !== null
        && row.growth_value !== null && row.member_level !== null)
      .filter((row) => row.eligible_member_levels.includes(row.member_level!))
      .map((row): PromotionAwardCandidate => ({
        policyVersionId: row.policy_version_id,
        ruleId: row.rule_id,
        ruleCode: row.rule_code,
        points: Number(row.points),
        perMemberAwardLimit: Number(row.per_member_award_limit),
        campaignCode: row.campaign_code,
        stackingGroup: row.stacking_group,
        stackingMode: row.stacking_mode,
        priority: Number(row.priority),
        storeBudgetPoints: Number(row.store_budget_points),
        perMemberPointsLimit: Number(row.per_member_points_limit),
        pointValidityDays: Number(row.point_validity_days),
        refundPolicy: row.refund_policy,
        budgetReuseAfterRefund: row.budget_reuse_after_refund,
        memberLimitReuseAfterRefund: row.member_limit_reuse_after_refund,
        membershipId: row.membership_id!,
        customerId: row.customer_id,
        accountId: row.account_id!,
        availablePoints: Number(row.available_points),
        pendingRecoveryPoints: Number(row.pending_recovery_points),
        growthValue: Number(row.growth_value),
      }))
    return items.length === 0
      ? { kind: 'ineligible', reason: 'no_matching_policy' }
      : { kind: 'eligible', items }
  }

  private async applyAward(
    transaction: ScopedTransaction,
    fact: TriggerFactRow,
    candidate: PromotionAwardCandidate,
  ): Promise<boolean> {
    await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `loyalty-promotion-budget:${transaction.scope.tenantId}:${transaction.scope.storeId}:${candidate.policyVersionId}`,
    ])
    const policy = await transaction.query<{
      store_budget_points: number
      per_member_points_limit: number
      point_validity_days: number
      budget_reuse_after_refund: boolean
      member_limit_reuse_after_refund: boolean
      status: string
    }>(`
      SELECT store_budget_points,per_member_points_limit,point_validity_days,
        budget_reuse_after_refund,member_limit_reuse_after_refund,status
      FROM mbox.loyalty_promotion_policy_versions
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid FOR UPDATE
    `, [transaction.scope.tenantId, transaction.scope.storeId, candidate.policyVersionId])
    const lockedPolicy = policy.rows[0]
    if (!lockedPolicy || lockedPolicy.status !== 'published') return false
    const usage = (await transaction.query<{
      total_points: string | number
      member_points: string | number
      rule_awards: string | number
    }>(`
      WITH reversed AS (
        SELECT COALESCE(sum(application.reversed_points),0)::bigint AS points,
          COALESCE(sum(application.reversed_points) FILTER (
            WHERE reversed_award.membership_id=$4::uuid
          ),0)::bigint AS member_points,
          count(DISTINCT reversed_award.id) FILTER (
            WHERE reversed_award.membership_id=$4::uuid AND reversed_award.rule_id=$5::uuid
              AND application.reversed_points>0
          )::integer AS rule_awards
        FROM mbox.loyalty_promotion_refund_applications application
        JOIN mbox.loyalty_promotion_awards reversed_award
          ON reversed_award.tenant_id=application.tenant_id
         AND reversed_award.store_id=application.store_id
         AND reversed_award.id=application.promotion_award_id
        WHERE application.tenant_id=$1::uuid AND application.store_id=$2::uuid
          AND reversed_award.policy_version_id=$3::uuid
      )
      SELECT
        (COALESCE(sum(award.awarded_points),0)
          - CASE WHEN $6::boolean THEN (SELECT points FROM reversed) ELSE 0 END)::bigint AS total_points,
        (COALESCE(sum(award.awarded_points) FILTER (WHERE award.membership_id=$4::uuid),0)
          - CASE WHEN $7::boolean THEN (SELECT member_points FROM reversed) ELSE 0 END)::bigint AS member_points,
        (count(*) FILTER (WHERE award.membership_id=$4::uuid AND award.rule_id=$5::uuid)
          - CASE WHEN $7::boolean THEN (SELECT rule_awards FROM reversed) ELSE 0 END)::integer AS rule_awards
      FROM mbox.loyalty_promotion_awards award
      WHERE award.tenant_id=$1::uuid AND award.store_id=$2::uuid
        AND award.policy_version_id=$3::uuid
    `, [
      transaction.scope.tenantId, transaction.scope.storeId, candidate.policyVersionId,
      candidate.membershipId, candidate.ruleId, lockedPolicy.budget_reuse_after_refund,
      lockedPolicy.member_limit_reuse_after_refund,
    ])).rows[0]
    if (!usage) throw new Error('Promotion award usage could not be read')
    if (Number(usage.total_points) + candidate.points > Number(lockedPolicy.store_budget_points)
      || Number(usage.member_points) + candidate.points > Number(lockedPolicy.per_member_points_limit)
      || Number(usage.rule_awards) >= candidate.perMemberAwardLimit) return false

    const account = (await transaction.query<{
      available_points: number
      pending_recovery_points: number
      growth_value: number
    }>(`
      SELECT available_points,pending_recovery_points,growth_value
      FROM mbox.loyalty_accounts account
      JOIN mbox.customer_memberships membership
        ON membership.tenant_id=account.tenant_id AND membership.store_id=account.store_id
       AND membership.id=account.membership_id AND membership.customer_id=account.customer_id
       AND membership.status='active'
      WHERE account.tenant_id=$1::uuid AND account.store_id=$2::uuid AND account.id=$3::uuid
        AND account.membership_id=$4::uuid AND account.customer_id=$5::uuid FOR UPDATE OF account
    `, [
      transaction.scope.tenantId, transaction.scope.storeId, candidate.accountId,
      candidate.membershipId, candidate.customerId,
    ])).rows[0]
    if (!account) return false
    const recoveredDebt = Math.min(account.pending_recovery_points, candidate.points)
    const creditedPoints = candidate.points - recoveredDebt
    const balance = account.available_points + creditedPoints
    const pendingRecovery = account.pending_recovery_points - recoveredDebt
    const inserted = await transaction.query<{ id: string }>(`
      INSERT INTO mbox.loyalty_promotion_awards(
        tenant_id,store_id,trigger_fact_id,policy_version_id,rule_id,
        registration_id,registration_cycle,activity_id,payment_id,
        membership_id,customer_id,awarded_points,credited_points,recovered_debt_points,awarded_at
      ) VALUES(
        $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,$8::uuid,$9::uuid,
        $10::uuid,$11::uuid,$12,$13,$14,$15::timestamptz
      ) ON CONFLICT (tenant_id,store_id,trigger_fact_id,rule_id) DO NOTHING RETURNING id
    `, [
      transaction.scope.tenantId, transaction.scope.storeId, fact.id,
      candidate.policyVersionId, candidate.ruleId, fact.registration_id,
      fact.registration_cycle, fact.activity_id, fact.payment_id,
      candidate.membershipId, candidate.customerId, candidate.points,
      creditedPoints, recoveredDebt, fact.occurred_at,
    ])
    const awardId = inserted.rows[0]?.id
    if (!awardId) return true
    await transaction.query(`
      UPDATE mbox.loyalty_accounts
      SET available_points=$4,pending_recovery_points=$5,
        redemption_status=CASE WHEN $5=0 AND redemption_status='suspended' THEN 'active' ELSE redemption_status END
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
    `, [transaction.scope.tenantId, transaction.scope.storeId, candidate.accountId, balance, pendingRecovery])
    await transaction.query(`
      UPDATE mbox.customer_memberships SET points_balance=$4
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
    `, [transaction.scope.tenantId, transaction.scope.storeId, candidate.membershipId, balance])
    const ledger = await transaction.query<{ id: string; expires_at: string }>(`
      INSERT INTO mbox.loyalty_point_ledger(
        tenant_id,store_id,membership_id,customer_id,entry_type,points_delta,
        balance_after,source_type,source_id,reason,expires_at,
        promotion_award_id,idempotency_key,occurred_at
      ) VALUES(
        $1::uuid,$2::uuid,$3::uuid,$4::uuid,'earn',$5,$6,'campaign',$7,
        '已发布促销积分规则的权威活动触发奖励',
        $8::timestamptz+make_interval(days=>$9),$10::uuid,$11,$8::timestamptz
      ) RETURNING id,expires_at::text
    `, [
      transaction.scope.tenantId, transaction.scope.storeId, candidate.membershipId,
      candidate.customerId, candidate.points, account.available_points + candidate.points,
      awardId, fact.occurred_at, lockedPolicy.point_validity_days,
      awardId, `loyalty:promotion:${awardId}:earn`,
    ])
    const ledgerRow = ledger.rows[0]
    if (!ledgerRow) throw new Error('Promotion earn ledger was not inserted')
    await transaction.query(`
      UPDATE mbox.loyalty_promotion_awards SET source_ledger_entry_id=$4::uuid
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        AND source_ledger_entry_id IS NULL
    `, [transaction.scope.tenantId, transaction.scope.storeId, awardId, ledgerRow.id])
    if (creditedPoints > 0) {
      const lot = await transaction.query<{ id: string }>(`
        INSERT INTO mbox.loyalty_point_lots(
          tenant_id,store_id,membership_id,customer_id,source_ledger_entry_id,
          source_type,source_id,original_points,remaining_points,
          available_at,expires_at,status
        ) VALUES(
          $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,'promotion',$6,$7,$7,
          $8::timestamptz,$9::timestamptz,'available'
        ) RETURNING id
      `, [
        transaction.scope.tenantId, transaction.scope.storeId, candidate.membershipId,
        candidate.customerId, ledgerRow.id, awardId, creditedPoints,
        fact.occurred_at, ledgerRow.expires_at,
      ])
      const lotId = lot.rows[0]?.id
      if (!lotId) throw new Error('Promotion point lot was not inserted')
      await transaction.query(`
        INSERT INTO mbox.loyalty_point_lot_movements(
          tenant_id,store_id,lot_id,movement_type,points_delta,balance_after,
          source_type,source_id,idempotency_key,occurred_at
        ) VALUES($1::uuid,$2::uuid,$3::uuid,'grant',$4,$4,'promotion',$5,$6,$7::timestamptz)
      `, [
        transaction.scope.tenantId, transaction.scope.storeId, lotId, creditedPoints,
        awardId, `lot:promotion:${awardId}:grant`, fact.occurred_at,
      ])
    }
    if (recoveredDebt > 0) {
      await transaction.query(`
        INSERT INTO mbox.loyalty_point_ledger(
          tenant_id,store_id,membership_id,customer_id,entry_type,points_delta,
          balance_after,source_type,source_id,reason,promotion_award_id,
          idempotency_key,occurred_at
        ) VALUES(
          $1::uuid,$2::uuid,$3::uuid,$4::uuid,'reverse',$5,$6,'refund',$7,
          '促销积分优先抵扣历史退款待回收积分',$8::uuid,$9,$10::timestamptz
        )
      `, [
        transaction.scope.tenantId, transaction.scope.storeId, candidate.membershipId,
        candidate.customerId, -recoveredDebt, balance, awardId, awardId,
        `loyalty:promotion:${awardId}:recovery-debt`, fact.occurred_at,
      ])
    }
    return true
  }

  private async processRefund(
    transaction: ScopedTransaction,
    fact: RefundFactRow,
    workerId: string,
  ): Promise<{ status: 'processed' | 'deferred'; applications: number; reversedPoints: number }> {
    await lockRegistration(transaction, fact.registration_id)
    const unresolvedTrigger = await transaction.query(`
      SELECT 1 FROM mbox.loyalty_promotion_trigger_facts
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND registration_id=$3::uuid
        AND status IN ('pending','processing','deferred','review_required')
      LIMIT 1
    `, [transaction.scope.tenantId, transaction.scope.storeId, fact.registration_id])
    if ((unresolvedTrigger.rowCount ?? 0) > 0) {
      const deferred = await transaction.query(`
        UPDATE mbox.loyalty_promotion_refund_facts
        SET status='deferred',worker_id=NULL,claimed_at=NULL,
          resolution_code='promotion_trigger_pending',application_count=NULL,
          resolved_at=NULL,updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
          AND status='processing' AND worker_id=$4
      `, [transaction.scope.tenantId, transaction.scope.storeId, fact.id, workerId])
      if (deferred.rowCount !== 1) throw new Error('Promotion refund fact lost its processing claim')
      return { status: 'deferred', applications: 0, reversedPoints: 0 }
    }
    const awards = await transaction.query<RefundAwardRow>(`
      SELECT award.id AS award_id,award.policy_version_id,award.membership_id,
        award.customer_id,account.id AS account_id,award.awarded_points,
        award.credited_points,account.available_points,account.pending_recovery_points,
        account.growth_value,policy.refund_policy,payment.status AS payment_status,
        award.source_ledger_entry_id
      FROM mbox.loyalty_promotion_refund_facts fact
      JOIN mbox.refunds refund
        ON refund.tenant_id=fact.tenant_id AND refund.store_id=fact.store_id
       AND refund.id=fact.refund_id AND refund.payment_id=fact.payment_id
       AND refund.status='succeeded'
      JOIN mbox.payments payment
        ON payment.tenant_id=refund.tenant_id AND payment.store_id=refund.store_id
       AND payment.id=refund.payment_id AND payment.activity_registration_id=fact.registration_id
       AND payment.status IN ('partially_refunded','refunded')
      JOIN mbox.loyalty_promotion_awards award
        ON award.tenant_id=fact.tenant_id AND award.store_id=fact.store_id
       AND award.registration_id=fact.registration_id
      JOIN mbox.loyalty_promotion_policy_versions policy
        ON policy.tenant_id=award.tenant_id AND policy.store_id=award.store_id
       AND policy.id=award.policy_version_id
      JOIN mbox.loyalty_accounts account
        ON account.tenant_id=award.tenant_id AND account.store_id=award.store_id
       AND account.membership_id=award.membership_id AND account.customer_id=award.customer_id
      WHERE fact.tenant_id=$1::uuid AND fact.store_id=$2::uuid AND fact.id=$3::uuid
        AND (policy.refund_policy='reverse_on_any_refund' OR payment.status='refunded')
      ORDER BY award.awarded_at,award.id
      FOR UPDATE OF refund,payment,account
    `, [transaction.scope.tenantId, transaction.scope.storeId, fact.id])
    let applications = 0
    let reversedPoints = 0
    for (const award of awards.rows) {
      const applied = await this.reverseAward(transaction, fact, award)
      applications += applied.applied ? 1 : 0
      reversedPoints += applied.reversedPoints
    }
    await transaction.query(`
      UPDATE mbox.loyalty_promotion_refund_facts
      SET status='processed',worker_id=NULL,claimed_at=NULL,resolved_at=clock_timestamp(),
        resolution_code=$5,application_count=$6,updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        AND status='processing' AND worker_id=$4
    `, [
      transaction.scope.tenantId, transaction.scope.storeId, fact.id, workerId,
      applications > 0 ? 'reversed' : 'no_promotion_award', applications,
    ])
    return { status: 'processed', applications, reversedPoints }
  }

  private async reverseAward(
    transaction: ScopedTransaction,
    fact: RefundFactRow,
    award: RefundAwardRow,
  ): Promise<{ applied: boolean; reversedPoints: number }> {
    const existing = await transaction.query(`
      SELECT 1 FROM mbox.loyalty_promotion_refund_applications
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid
        AND promotion_award_id=$3::uuid AND refund_id=$4::uuid FOR UPDATE
    `, [transaction.scope.tenantId, transaction.scope.storeId, award.award_id, fact.refund_id])
    if (existing.rowCount === 1) return { applied: false, reversedPoints: 0 }
    const prior = (await transaction.query<{ reversed_points: string | number }>(`
      SELECT COALESCE(sum(reversed_points),0)::bigint AS reversed_points
      FROM mbox.loyalty_promotion_refund_applications
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND promotion_award_id=$3::uuid
    `, [transaction.scope.tenantId, transaction.scope.storeId, award.award_id])).rows[0]
    const remaining = Math.max(0, award.awarded_points - Number(prior?.reversed_points ?? 0))
    if (remaining === 0) {
      await insertRefundApplication(transaction, fact, award, 0, 0, 0)
      return { applied: true, reversedPoints: 0 }
    }
    const lot = (await transaction.query<{ id: string; remaining_points: number }>(`
      SELECT id,remaining_points FROM mbox.loyalty_point_lots
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid
        AND source_ledger_entry_id=$3::uuid FOR UPDATE
    `, [transaction.scope.tenantId, transaction.scope.storeId, award.source_ledger_entry_id])).rows[0]
    const account = (await transaction.query<{
      available_points: number
      pending_recovery_points: number
    }>(`
      SELECT available_points,pending_recovery_points
      FROM mbox.loyalty_accounts
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        AND membership_id=$4::uuid AND customer_id=$5::uuid FOR UPDATE
    `, [
      transaction.scope.tenantId, transaction.scope.storeId, award.account_id,
      award.membership_id, award.customer_id,
    ])).rows[0]
    if (!account) throw new Error('Promotion refund account is unavailable')
    const deducted = Math.min(remaining, lot?.remaining_points ?? 0)
    const debt = remaining - deducted
    const balance = account.available_points - deducted
    const pendingRecovery = account.pending_recovery_points + debt
    const applicationId = await insertRefundApplication(transaction, fact, award, remaining, deducted, debt)
    if (lot && deducted > 0) {
      const lotBalance = lot.remaining_points - deducted
      await transaction.query(`
        UPDATE mbox.loyalty_point_lots
        SET remaining_points=$4,status=CASE WHEN $4=0 THEN 'reversed' ELSE 'available' END,
          updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      `, [transaction.scope.tenantId, transaction.scope.storeId, lot.id, lotBalance])
      await transaction.query(`
        INSERT INTO mbox.loyalty_point_lot_movements(
          tenant_id,store_id,lot_id,movement_type,points_delta,balance_after,
          source_type,source_id,idempotency_key,occurred_at
        ) VALUES($1::uuid,$2::uuid,$3::uuid,'reverse',$4,$5,'refund',$6,$7,$8::timestamptz)
      `, [
        transaction.scope.tenantId, transaction.scope.storeId, lot.id, -deducted, lotBalance,
        fact.refund_id, `lot:promotion-refund:${applicationId}`, fact.occurred_at,
      ])
    }
    await transaction.query(`
      UPDATE mbox.loyalty_accounts
      SET available_points=$4,pending_recovery_points=$5,
        redemption_status=CASE WHEN $5>0 THEN 'suspended' ELSE redemption_status END
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
    `, [transaction.scope.tenantId, transaction.scope.storeId, award.account_id, balance, pendingRecovery])
    await transaction.query(`
      UPDATE mbox.customer_memberships SET points_balance=$4
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
    `, [transaction.scope.tenantId, transaction.scope.storeId, award.membership_id, balance])
    await transaction.query(`
      INSERT INTO mbox.loyalty_point_ledger(
        tenant_id,store_id,membership_id,customer_id,entry_type,points_delta,
        balance_after,source_type,source_id,reason,refund_id,
        promotion_award_id,promotion_refund_application_id,idempotency_key,occurred_at
      ) VALUES(
        $1::uuid,$2::uuid,$3::uuid,$4::uuid,'reverse',$5,$6,'refund',$7,
        '权威活动退款后的促销积分冲回',$8::uuid,$9::uuid,$10::uuid,$11,$12::timestamptz
      )
    `, [
      transaction.scope.tenantId, transaction.scope.storeId, award.membership_id,
      award.customer_id, -remaining, balance, fact.refund_id, fact.refund_id,
      award.award_id, applicationId, `loyalty:promotion-refund:${applicationId}`,
      fact.occurred_at,
    ])
    return { applied: true, reversedPoints: remaining }
  }
}

async function lockRegistration(transaction: ScopedTransaction, registrationId: string): Promise<void> {
  await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `loyalty-promotion-registration:${transaction.scope.tenantId}:${transaction.scope.storeId}:${registrationId}`,
  ])
}

async function registrationHasSucceededRefund(
  transaction: ScopedTransaction,
  registrationId: string,
): Promise<boolean> {
  const result = await transaction.query<{ refunded: boolean }>(`
    SELECT EXISTS(
      SELECT 1 FROM mbox.payments payment
      JOIN mbox.refunds refund
        ON refund.tenant_id=payment.tenant_id AND refund.store_id=payment.store_id
       AND refund.payment_id=payment.id AND refund.status='succeeded'
      WHERE payment.tenant_id=$1::uuid AND payment.store_id=$2::uuid
        AND payment.payable_kind='activity_registration'
        AND payment.activity_registration_id=$3::uuid
    ) AS refunded
  `, [transaction.scope.tenantId, transaction.scope.storeId, registrationId])
  return result.rows[0]?.refunded === true
}

export function selectStackedCandidates(
  candidates: readonly PromotionAwardCandidate[],
): PromotionAwardCandidate[] {
  const groups = new Map<string, PromotionAwardCandidate[]>()
  for (const candidate of candidates) {
    const current = groups.get(candidate.stackingGroup) ?? []
    current.push(candidate)
    groups.set(candidate.stackingGroup, current)
  }
  const selected: PromotionAwardCandidate[] = []
  for (const group of [...groups.values()]) {
    const mode = group[0]?.stackingMode
    if (group.some((candidate) => candidate.stackingMode !== mode)) {
      throw new Error('Published promotion stacking modes conflict')
    }
    if (mode === 'stackable') {
      selected.push(...group.toSorted(comparePriority))
    } else if (mode === 'exclusive_highest') {
      selected.push(group.toSorted((left, right) => (
        right.points - left.points || comparePriority(left, right)
      ))[0]!)
    } else if (mode === 'exclusive_first') {
      selected.push(group.toSorted(comparePriority)[0]!)
    }
  }
  return selected.toSorted(comparePriority)
}

function comparePriority(left: PromotionAwardCandidate, right: PromotionAwardCandidate): number {
  return right.priority - left.priority
    || left.campaignCode.localeCompare(right.campaignCode)
    || left.ruleCode.localeCompare(right.ruleCode)
    || left.ruleId.localeCompare(right.ruleId)
}

async function finishTrigger(
  transaction: ScopedTransaction,
  factId: string,
  workerId: string,
  status: 'applied' | 'not_applicable',
  resolutionCode: string,
  awardCount: number,
): Promise<void> {
  const updated = await transaction.query(`
    UPDATE mbox.loyalty_promotion_trigger_facts
    SET status=$5,worker_id=NULL,claimed_at=NULL,resolved_at=clock_timestamp(),
      resolution_code=$6,award_count=$7,updated_at=clock_timestamp()
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      AND status='processing' AND worker_id=$4
  `, [
    transaction.scope.tenantId, transaction.scope.storeId, factId, workerId,
    status, resolutionCode, awardCount,
  ])
  if (updated.rowCount !== 1) throw new Error('Promotion trigger fact lost its processing claim')
}

async function insertRefundApplication(
  transaction: ScopedTransaction,
  fact: RefundFactRow,
  award: RefundAwardRow,
  reversedPoints: number,
  deductedPoints: number,
  recoveryDebtPoints: number,
): Promise<string> {
  const inserted = await transaction.query<{ id: string }>(`
    INSERT INTO mbox.loyalty_promotion_refund_applications(
      tenant_id,store_id,promotion_award_id,refund_fact_id,refund_id,payment_id,
      registration_id,reversed_points,deducted_points,recovery_debt_points,applied_at
    ) VALUES(
      $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8,$9,$10,$11::timestamptz
    ) ON CONFLICT (tenant_id,store_id,promotion_award_id,refund_id) DO NOTHING RETURNING id
  `, [
    transaction.scope.tenantId, transaction.scope.storeId, award.award_id,
    fact.id, fact.refund_id, fact.payment_id, fact.registration_id,
    reversedPoints, deductedPoints, recoveryDebtPoints, fact.occurred_at,
  ])
  const id = inserted.rows[0]?.id
  if (id) return id
  const existing = await transaction.query<{ id: string }>(`
    SELECT id FROM mbox.loyalty_promotion_refund_applications
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid
      AND promotion_award_id=$3::uuid AND refund_id=$4::uuid
  `, [transaction.scope.tenantId, transaction.scope.storeId, award.award_id, fact.refund_id])
  const existingId = existing.rows[0]?.id
  if (!existingId) throw new Error('Promotion refund application was not recorded')
  return existingId
}

async function markReviewRequired(
  transactions: Pick<ScopedPostgresTransactionRunner, 'run'>,
  scope: Readonly<StoreScope>,
  table: 'loyalty_promotion_trigger_facts' | 'loyalty_promotion_refund_facts',
  id: string,
  workerId: string,
): Promise<void> {
  await transactions.run(scope, (transaction) => transaction.query(`
    UPDATE mbox.${table}
    SET status='review_required',worker_id=NULL,claimed_at=NULL,
      resolved_at=clock_timestamp(),resolution_code='processing_failed',
      updated_at=clock_timestamp()
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      AND status='processing' AND worker_id=$4
  `, [scope.tenantId, scope.storeId, id, workerId]))
}

function validateWorker(workerId: string, batchSize: number): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,95}$/.test(workerId)) throw new TypeError('workerId is invalid')
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new TypeError('batchSize is invalid')
}
