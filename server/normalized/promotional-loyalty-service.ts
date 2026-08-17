import { createHash } from 'node:crypto'
import type { AuditEvent, JsonCodec, JsonValue, NormalizedCommandExecutor } from './command-executor.js'
import type { ScopedPostgresTransactionRunner, ScopedTransaction, StoreScope } from './transaction-runner.js'

export const PROMOTION_TRIGGER_KINDS = Object.freeze([
  'activity_payment',
  'activity_check_in',
  'activity_completion',
] as const)
export const PROMOTION_STACKING_MODES = Object.freeze([
  'stackable',
  'exclusive_highest',
  'exclusive_first',
] as const)
export const PROMOTION_REFUND_POLICIES = Object.freeze([
  'reverse_on_any_refund',
  'reverse_on_full_refund',
] as const)
export const PROMOTION_MEMBER_LEVELS = Object.freeze(['member', 'silver', 'gold'] as const)

export type PromotionTriggerKind = (typeof PROMOTION_TRIGGER_KINDS)[number]
export type PromotionStackingMode = (typeof PROMOTION_STACKING_MODES)[number]
export type PromotionRefundPolicy = (typeof PROMOTION_REFUND_POLICIES)[number]
export type PromotionMemberLevel = (typeof PROMOTION_MEMBER_LEVELS)[number]
export type PromotionPolicyStatus = 'draft' | 'approved' | 'published' | 'retired'

export interface PromotionalLoyaltyStaffContext {
  scope: Readonly<StoreScope>
  employeeId: string
  businessDate: string
}

export interface PromotionRuleInput {
  ruleCode: string
  triggerKind: PromotionTriggerKind
  points: number
  perMemberAwardLimit: number
  minimumPaidAmountMinor: number
  enabled: boolean
}

export interface PromotionPolicyDraftInput {
  campaignCode: string
  name: string
  activityId: string
  stackingGroup: string
  stackingMode: PromotionStackingMode
  priority: number
  storeBudgetPoints: number
  perMemberPointsLimit: number
  pointValidityDays: number
  refundPolicy: PromotionRefundPolicy
  budgetReuseAfterRefund: boolean
  memberLimitReuseAfterRefund: boolean
  eligibleMemberLevels: readonly PromotionMemberLevel[]
  rules: readonly Readonly<PromotionRuleInput>[]
  reason: string
  idempotencyKey: string
}

export interface PromotionRuleView extends PromotionRuleInput {
  id: string
}

export interface PromotionPolicyView {
  id: string
  campaignCode: string
  version: number
  name: string
  activityId: string
  activityTitle: string
  stackingGroup: string
  stackingMode: PromotionStackingMode
  priority: number
  storeBudgetPoints: number
  perMemberPointsLimit: number
  pointValidityDays: number
  refundPolicy: PromotionRefundPolicy
  budgetReuseAfterRefund: boolean
  memberLimitReuseAfterRefund: boolean
  eligibleMemberLevels: PromotionMemberLevel[]
  status: PromotionPolicyStatus
  effectiveFrom: string | null
  effectiveUntil: string | null
  draftedByEmployeeId: string
  approvedByEmployeeId: string | null
  approvedAt: string | null
  publishedByEmployeeId: string | null
  publishedAt: string | null
  reason: string
  rules: PromotionRuleView[]
  awardedPoints: number
  remainingBudgetPoints: number
  deferredTriggerCount: number
}

export interface PromotionConfigurationView {
  policies: PromotionPolicyView[]
  activities: Array<{
    id: string
    publicId: string
    title: string
    startsAt: string
    status: string
  }>
}

interface PolicyRow extends Record<string, unknown> {
  id: string
  campaign_code: string
  version: number
  name: string
  activity_id: string
  activity_title: string
  stacking_group: string
  stacking_mode: PromotionStackingMode
  priority: number
  store_budget_points: number
  per_member_points_limit: number
  point_validity_days: number
  refund_policy: PromotionRefundPolicy
  budget_reuse_after_refund: boolean
  member_limit_reuse_after_refund: boolean
  eligible_member_levels: PromotionMemberLevel[]
  status: PromotionPolicyStatus
  effective_from: string | null
  effective_until: string | null
  drafted_by_employee_id: string
  approved_by_employee_id: string | null
  approved_at: string | null
  published_by_employee_id: string | null
  published_at: string | null
  reason: string
  awarded_points: string | number
  deferred_trigger_count: string | number
}

interface RuleRow extends Record<string, unknown> {
  id: string
  policy_version_id: string
  rule_code: string
  trigger_kind: PromotionTriggerKind
  points: number
  per_member_award_limit: number
  minimum_paid_amount_minor: string | number
  enabled: boolean
}

export class PromotionalLoyaltyError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 409) {
    super(message)
    this.name = 'PromotionalLoyaltyError'
  }
}

type TransactionRunner = Pick<ScopedPostgresTransactionRunner, 'run'>

export class PromotionalLoyaltyService {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly commands: Pick<NormalizedCommandExecutor, 'execute'>,
  ) {}

  configuration(context: PromotionalLoyaltyStaffContext): Promise<PromotionConfigurationView> {
    return this.transactions.run(context.scope, async (transaction) => {
      const policies = await transaction.query<PolicyRow>(`
        SELECT policy.id,policy.campaign_code,policy.version,policy.name,
          policy.activity_id,activity.title AS activity_title,
          policy.stacking_group,policy.stacking_mode,policy.priority,
          policy.store_budget_points,policy.per_member_points_limit,
          policy.point_validity_days,policy.refund_policy,policy.budget_reuse_after_refund,
          policy.member_limit_reuse_after_refund,
          policy.eligible_member_levels,
          policy.status,policy.effective_from::text,policy.effective_until::text,
          policy.drafted_by_employee_id,policy.approved_by_employee_id,
          policy.approved_at::text,policy.published_by_employee_id,
          policy.published_at::text,policy.reason,
          (COALESCE(award.awarded_points,0)-CASE WHEN policy.budget_reuse_after_refund
            THEN COALESCE(reversed.reversed_points,0) ELSE 0 END)::bigint AS awarded_points,
          COALESCE(deferred.deferred_count,0)::integer AS deferred_trigger_count
        FROM mbox.loyalty_promotion_policy_versions policy
        JOIN mbox.community_activities activity
          ON activity.tenant_id=policy.tenant_id AND activity.store_id=policy.store_id
         AND activity.id=policy.activity_id
        LEFT JOIN LATERAL (
          SELECT COALESCE(sum(item.awarded_points),0)::bigint AS awarded_points
          FROM mbox.loyalty_promotion_awards item
          WHERE item.tenant_id=policy.tenant_id AND item.store_id=policy.store_id
            AND item.policy_version_id=policy.id
        ) award ON true
        LEFT JOIN LATERAL (
          SELECT COALESCE(sum(application.reversed_points),0)::bigint AS reversed_points
          FROM mbox.loyalty_promotion_refund_applications application
          JOIN mbox.loyalty_promotion_awards item
            ON item.tenant_id=application.tenant_id AND item.store_id=application.store_id
           AND item.id=application.promotion_award_id
          WHERE item.tenant_id=policy.tenant_id AND item.store_id=policy.store_id
            AND item.policy_version_id=policy.id
        ) reversed ON true
        LEFT JOIN LATERAL (
          SELECT count(*)::integer AS deferred_count
          FROM mbox.loyalty_promotion_trigger_facts fact
          WHERE fact.tenant_id=policy.tenant_id AND fact.store_id=policy.store_id
            AND fact.activity_id=policy.activity_id AND fact.status='deferred'
        ) deferred ON true
        WHERE policy.tenant_id=$1::uuid AND policy.store_id=$2::uuid
        ORDER BY policy.created_at DESC,policy.id DESC
      `, [transaction.scope.tenantId, transaction.scope.storeId])
      const rules = await transaction.query<RuleRow>(`
        SELECT id,policy_version_id,rule_code,trigger_kind,points,
          per_member_award_limit,minimum_paid_amount_minor,enabled
        FROM mbox.loyalty_promotion_rules
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid
        ORDER BY policy_version_id,rule_code,id
      `, [transaction.scope.tenantId, transaction.scope.storeId])
      const rulesByPolicy = new Map<string, PromotionRuleView[]>()
      for (const row of rules.rows) {
        const list = rulesByPolicy.get(row.policy_version_id) ?? []
        list.push(mapRule(row))
        rulesByPolicy.set(row.policy_version_id, list)
      }
      const activities = await transaction.query<{
        id: string
        public_id: string
        title: string
        starts_at: string
        status: string
      }>(`
        SELECT id,public_id,title,starts_at::text,status
        FROM mbox.community_activities
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid
          AND status NOT IN ('cancelled','completed')
        ORDER BY starts_at,id
      `, [transaction.scope.tenantId, transaction.scope.storeId])
      return {
        policies: policies.rows.map((row) => mapPolicy(row, rulesByPolicy.get(row.id) ?? [])),
        activities: activities.rows.map((row) => ({
          id: row.id,
          publicId: row.public_id,
          title: row.title,
          startsAt: row.starts_at,
          status: row.status,
        })),
      }
    }, { readOnly: true })
  }

  draft(context: PromotionalLoyaltyStaffContext, input: Readonly<PromotionPolicyDraftInput>) {
    const normalized = normalizeDraft(input)
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'loyalty.promotion-policy.draft',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(normalized),
      resultCodec: objectCodec<PromotionPolicyView>(),
    }, async (transaction) => {
      const activity = (await transaction.query<{ id: string; title: string; status: string }>(`
        SELECT id,title,status FROM mbox.community_activities
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        FOR SHARE
      `, [transaction.scope.tenantId, transaction.scope.storeId, normalized.activityId])).rows[0]
      if (!activity) throw promotionError('活动不存在或不属于当前门店', 'LOYALTY_PROMOTION_ACTIVITY_NOT_FOUND', 404)
      if (activity.status === 'cancelled' || activity.status === 'completed') throw promotionError(
        '已取消或已结束的活动不能新建促销积分规则', 'LOYALTY_PROMOTION_ACTIVITY_TERMINAL',
      )
      await lockCampaign(transaction, normalized.campaignCode)
      const inserted = await transaction.query<{ id: string }>(`
        WITH next_version AS (
          SELECT COALESCE(max(version),0)+1 AS version
          FROM mbox.loyalty_promotion_policy_versions
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND campaign_code=$3
        )
        INSERT INTO mbox.loyalty_promotion_policy_versions(
          tenant_id,store_id,campaign_code,version,name,activity_id,
          stacking_group,stacking_mode,priority,store_budget_points,
          per_member_points_limit,point_validity_days,refund_policy,budget_reuse_after_refund,
          member_limit_reuse_after_refund,
          eligible_member_levels,status,drafted_by_employee_id,reason
        ) SELECT $1::uuid,$2::uuid,$3,version,$4,$5::uuid,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::text[],
          'draft',$16::uuid,$17 FROM next_version RETURNING id
      `, [
        transaction.scope.tenantId, transaction.scope.storeId, normalized.campaignCode,
        normalized.name, normalized.activityId, normalized.stackingGroup,
        normalized.stackingMode, normalized.priority, normalized.storeBudgetPoints,
        normalized.perMemberPointsLimit, normalized.pointValidityDays,
        normalized.refundPolicy, normalized.budgetReuseAfterRefund,
        normalized.memberLimitReuseAfterRefund, normalized.eligibleMemberLevels,
        context.employeeId, normalized.reason,
      ])
      const policyId = inserted.rows[0]?.id
      if (!policyId) throw new Error('Promotion policy draft was not inserted')
      for (const rule of normalized.rules) await insertRule(transaction, policyId, rule)
      const result = await loadPolicy(transaction, policyId)
      return outcome(context, result, 'loyalty.promotion-policy.drafted', normalized.reason)
    })
  }

  approve(context: PromotionalLoyaltyStaffContext, input: Readonly<{
    policyId: string
    reason: string
    idempotencyKey: string
  }>) {
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'loyalty.promotion-policy.approve',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<PromotionPolicyView>(),
    }, async (transaction) => {
      const policy = await policyForUpdate(transaction, input.policyId)
      if (policy.status !== 'draft' || policy.drafted_by_employee_id === context.employeeId) {
        throw promotionError('只有他人起草的促销积分草稿可以审批', 'LOYALTY_PROMOTION_APPROVAL_DENIED')
      }
      await validatePersistedRules(transaction, policy.id)
      const updated = await transaction.query(`
        UPDATE mbox.loyalty_promotion_policy_versions
        SET status='approved',approved_by_employee_id=$4::uuid,
          approved_at=clock_timestamp(),reason=$5
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
          AND status='draft' AND drafted_by_employee_id<>$4::uuid
      `, [transaction.scope.tenantId, transaction.scope.storeId, policy.id, context.employeeId, cleanReason(input.reason)])
      if (updated.rowCount !== 1) throw promotionError(
        '促销积分草稿状态已经变化，请刷新后重试', 'LOYALTY_PROMOTION_APPROVAL_CONFLICT',
      )
      return outcome(context, await loadPolicy(transaction, policy.id),
        'loyalty.promotion-policy.approved', input.reason)
    })
  }

  publish(context: PromotionalLoyaltyStaffContext, input: Readonly<{
    policyId: string
    effectiveFrom: string
    effectiveUntil: string | null
    reason: string
    idempotencyKey: string
  }>) {
    const effectiveFrom = timestamp(input.effectiveFrom, '生效时间')
    const effectiveUntil = input.effectiveUntil === null ? null : timestamp(input.effectiveUntil, '失效时间')
    if (Date.parse(effectiveFrom) <= Date.now()) throw promotionError(
      '促销积分只能安排未来生效，禁止对既有活动事实追溯发分',
      'LOYALTY_PROMOTION_RETROACTIVE_PUBLICATION_DENIED', 400,
    )
    if (effectiveUntil !== null && Date.parse(effectiveUntil) <= Date.parse(effectiveFrom)) {
      throw promotionError('失效时间必须晚于生效时间', 'LOYALTY_PROMOTION_INVALID_WINDOW', 400)
    }
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'loyalty.promotion-policy.publish',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint({ ...input, effectiveFrom, effectiveUntil }),
      resultCodec: objectCodec<PromotionPolicyView>(),
    }, async (transaction) => {
      const policy = await policyForUpdate(transaction, input.policyId)
      if (policy.status !== 'approved' || policy.approved_by_employee_id === null) throw promotionError(
        '只有已独立审批的促销积分规则可以发布', 'LOYALTY_PROMOTION_NOT_APPROVED',
      )
      if (context.employeeId === policy.drafted_by_employee_id
        || context.employeeId === policy.approved_by_employee_id) throw promotionError(
        '起草人和审批人不能执行正式发布', 'LOYALTY_PROMOTION_PUBLISHER_NOT_INDEPENDENT',
      )
      const activity = (await transaction.query<{ status: string }>(`
        SELECT status FROM mbox.community_activities
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid FOR SHARE
      `, [transaction.scope.tenantId, transaction.scope.storeId, policy.activity_id])).rows[0]
      if (!activity || !['published','full'].includes(activity.status)) throw promotionError(
        '促销积分只能关联已发布且仍可经营的活动',
        'LOYALTY_PROMOTION_ACTIVITY_NOT_PUBLISHED',
      )
      await validatePersistedRules(transaction, policy.id)
      await assertStackingCompatibility(transaction, policy, effectiveFrom, effectiveUntil)
      await closePriorVersion(transaction, policy, effectiveFrom)
      const updated = await transaction.query(`
        UPDATE mbox.loyalty_promotion_policy_versions
        SET status='published',effective_from=$4::timestamptz,effective_until=$5::timestamptz,
          published_by_employee_id=$6::uuid,published_at=clock_timestamp(),reason=$7
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='approved'
      `, [
        transaction.scope.tenantId, transaction.scope.storeId, policy.id,
        effectiveFrom, effectiveUntil, context.employeeId, cleanReason(input.reason),
      ])
      if (updated.rowCount !== 1) throw promotionError(
        '促销积分规则状态已经变化，请刷新后重试', 'LOYALTY_PROMOTION_PUBLISH_CONFLICT',
      )
      return outcome(context, await loadPolicy(transaction, policy.id),
        'loyalty.promotion-policy.published', input.reason)
    })
  }
}

async function loadPolicy(transaction: ScopedTransaction, policyId: string): Promise<PromotionPolicyView> {
  const result = await transaction.query<PolicyRow>(`
    SELECT policy.id,policy.campaign_code,policy.version,policy.name,
      policy.activity_id,activity.title AS activity_title,
      policy.stacking_group,policy.stacking_mode,policy.priority,
      policy.store_budget_points,policy.per_member_points_limit,
      policy.point_validity_days,policy.refund_policy,policy.budget_reuse_after_refund,
      policy.member_limit_reuse_after_refund,
      policy.eligible_member_levels,
      policy.status,policy.effective_from::text,policy.effective_until::text,
      policy.drafted_by_employee_id,policy.approved_by_employee_id,
      policy.approved_at::text,policy.published_by_employee_id,
      policy.published_at::text,policy.reason,
      (COALESCE((SELECT sum(award.awarded_points) FROM mbox.loyalty_promotion_awards award
        WHERE award.tenant_id=policy.tenant_id AND award.store_id=policy.store_id
          AND award.policy_version_id=policy.id),0)-CASE WHEN policy.budget_reuse_after_refund THEN
        COALESCE((SELECT sum(application.reversed_points)
          FROM mbox.loyalty_promotion_refund_applications application
          JOIN mbox.loyalty_promotion_awards award
            ON award.tenant_id=application.tenant_id AND award.store_id=application.store_id
           AND award.id=application.promotion_award_id
          WHERE award.tenant_id=policy.tenant_id AND award.store_id=policy.store_id
            AND award.policy_version_id=policy.id),0) ELSE 0 END)::bigint AS awarded_points,
      COALESCE((SELECT count(*) FROM mbox.loyalty_promotion_trigger_facts fact
        WHERE fact.tenant_id=policy.tenant_id AND fact.store_id=policy.store_id
          AND fact.activity_id=policy.activity_id AND fact.status='deferred'),0)::integer AS deferred_trigger_count
    FROM mbox.loyalty_promotion_policy_versions policy
    JOIN mbox.community_activities activity
      ON activity.tenant_id=policy.tenant_id AND activity.store_id=policy.store_id
     AND activity.id=policy.activity_id
    WHERE policy.tenant_id=$1::uuid AND policy.store_id=$2::uuid AND policy.id=$3::uuid
  `, [transaction.scope.tenantId, transaction.scope.storeId, policyId])
  const row = result.rows[0]
  if (!row) throw promotionError('促销积分规则不存在', 'LOYALTY_PROMOTION_POLICY_NOT_FOUND', 404)
  const rules = await transaction.query<RuleRow>(`
    SELECT id,policy_version_id,rule_code,trigger_kind,points,
      per_member_award_limit,minimum_paid_amount_minor,enabled
    FROM mbox.loyalty_promotion_rules
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND policy_version_id=$3::uuid
    ORDER BY rule_code,id
  `, [transaction.scope.tenantId, transaction.scope.storeId, policyId])
  return mapPolicy(row, rules.rows.map(mapRule))
}

async function policyForUpdate(transaction: ScopedTransaction, policyId: string) {
  const result = await transaction.query<{
    id: string
    campaign_code: string
    status: PromotionPolicyStatus
    activity_id: string
    stacking_group: string
    stacking_mode: PromotionStackingMode
    drafted_by_employee_id: string
    approved_by_employee_id: string | null
  }>(`
    SELECT id,campaign_code,status,activity_id,stacking_group,stacking_mode,
      drafted_by_employee_id,approved_by_employee_id
    FROM mbox.loyalty_promotion_policy_versions
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid FOR UPDATE
  `, [transaction.scope.tenantId, transaction.scope.storeId, policyId])
  const row = result.rows[0]
  if (!row) throw promotionError('促销积分规则不存在', 'LOYALTY_PROMOTION_POLICY_NOT_FOUND', 404)
  return row
}

async function validatePersistedRules(transaction: ScopedTransaction, policyId: string): Promise<void> {
  const result = await transaction.query<RuleRow>(`
    SELECT id,policy_version_id,rule_code,trigger_kind,points,
      per_member_award_limit,minimum_paid_amount_minor,enabled
    FROM mbox.loyalty_promotion_rules
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND policy_version_id=$3::uuid
    ORDER BY rule_code,id FOR SHARE
  `, [transaction.scope.tenantId, transaction.scope.storeId, policyId])
  if (result.rows.length === 0) throw promotionError(
    '至少需要一条促销积分规则', 'LOYALTY_PROMOTION_RULE_REQUIRED',
  )
  normalizeRules(result.rows.map((row) => mapRule(row)))
}

async function assertStackingCompatibility(
  transaction: ScopedTransaction,
  policy: Readonly<{
    id: string
    campaign_code: string
    activity_id: string
    stacking_group: string
    stacking_mode: PromotionStackingMode
  }>,
  effectiveFrom: string,
  effectiveUntil: string | null,
): Promise<void> {
  const conflicting = await transaction.query(`
    SELECT 1 FROM mbox.loyalty_promotion_policy_versions existing
    WHERE existing.tenant_id=$1::uuid AND existing.store_id=$2::uuid
      AND existing.id<>$3::uuid AND existing.status='published'
      AND existing.activity_id=$4::uuid AND existing.stacking_group=$5
      AND existing.stacking_mode<>$6
      AND tstzrange(existing.effective_from,existing.effective_until,'[)')
        && tstzrange($7::timestamptz,$8::timestamptz,'[)')
    LIMIT 1 FOR SHARE
  `, [
    transaction.scope.tenantId, transaction.scope.storeId, policy.id, policy.activity_id,
    policy.stacking_group, policy.stacking_mode, effectiveFrom, effectiveUntil,
  ])
  if (conflicting.rowCount !== 0) throw promotionError(
    '同一活动和叠加组在重叠时段内必须使用同一种叠加方式',
    'LOYALTY_PROMOTION_STACKING_CONFLICT',
  )
}

async function closePriorVersion(
  transaction: ScopedTransaction,
  policy: Readonly<{ id: string; campaign_code: string }>,
  effectiveFrom: string,
): Promise<void> {
  const prior = await transaction.query<{ id: string; effective_from: string }>(`
    SELECT id,effective_from::text FROM mbox.loyalty_promotion_policy_versions
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND campaign_code=$3
      AND id<>$4::uuid AND status='published'
      AND effective_from<$5::timestamptz
      AND (effective_until IS NULL OR effective_until>$5::timestamptz)
    ORDER BY effective_from DESC,id DESC LIMIT 1 FOR UPDATE
  `, [transaction.scope.tenantId, transaction.scope.storeId, policy.campaign_code, policy.id, effectiveFrom])
  const current = prior.rows[0]
  if (!current) return
  await transaction.query(`
    UPDATE mbox.loyalty_promotion_policy_versions SET effective_until=$4::timestamptz
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      AND effective_from<$4::timestamptz
      AND (effective_until IS NULL OR effective_until>$4::timestamptz)
  `, [transaction.scope.tenantId, transaction.scope.storeId, current.id, effectiveFrom])
}

async function insertRule(
  transaction: ScopedTransaction,
  policyId: string,
  rule: Readonly<PromotionRuleInput>,
): Promise<void> {
  const inserted = await transaction.query(`
    INSERT INTO mbox.loyalty_promotion_rules(
      tenant_id,store_id,policy_version_id,rule_code,trigger_kind,
      points,per_member_award_limit,minimum_paid_amount_minor,enabled
    ) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8::bigint,$9)
  `, [
    transaction.scope.tenantId, transaction.scope.storeId, policyId,
    rule.ruleCode, rule.triggerKind, rule.points, rule.perMemberAwardLimit,
    rule.minimumPaidAmountMinor, rule.enabled,
  ])
  if (inserted.rowCount !== 1) throw new Error('Promotion rule was not inserted')
}

async function lockCampaign(transaction: ScopedTransaction, campaignCode: string): Promise<void> {
  await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `loyalty-promotion:${transaction.scope.tenantId}:${transaction.scope.storeId}:${campaignCode}`,
  ])
}

function normalizeDraft(input: Readonly<PromotionPolicyDraftInput>): PromotionPolicyDraftInput {
  const campaignCode = businessCode(input.campaignCode, '活动积分编号')
  const stackingGroup = businessCode(input.stackingGroup, '叠加组')
  const name = text(input.name, '规则名称', 2, 80)
  const reason = cleanReason(input.reason)
  const levels = [...new Set(input.eligibleMemberLevels)]
  if (levels.length === 0 || levels.some((level) => !PROMOTION_MEMBER_LEVELS.includes(level))) {
    throw promotionError('至少选择一个有效会员等级', 'LOYALTY_PROMOTION_INVALID_AUDIENCE', 400)
  }
  const storeBudgetPoints = integer(input.storeBudgetPoints, '门店积分预算', 1, 10_000_000)
  const perMemberPointsLimit = integer(input.perMemberPointsLimit, '每会员积分上限', 1, 100_000)
  if (perMemberPointsLimit > storeBudgetPoints) throw promotionError(
    '每会员积分上限不能超过门店总预算', 'LOYALTY_PROMOTION_MEMBER_LIMIT_EXCEEDS_BUDGET', 400,
  )
  const rules = normalizeRules(input.rules)
  const maximumConfiguredExposure = rules
    .filter((rule) => rule.enabled)
    .reduce((total, rule) => total + rule.points * rule.perMemberAwardLimit, 0)
  if (maximumConfiguredExposure > perMemberPointsLimit) throw promotionError(
    '所有已启用规则的最大累计积分不能超过每会员积分上限',
    'LOYALTY_PROMOTION_RULE_EXCEEDS_MEMBER_LIMIT', 400,
  )
  return {
    ...input,
    campaignCode,
    name,
    stackingGroup,
    priority: integer(input.priority, '推荐优先级', 0, 10_000),
    storeBudgetPoints,
    perMemberPointsLimit,
    pointValidityDays: integer(input.pointValidityDays, '积分有效天数', 1, 730),
    budgetReuseAfterRefund: boolean(input.budgetReuseAfterRefund, '退款后预算是否释放'),
    memberLimitReuseAfterRefund: boolean(input.memberLimitReuseAfterRefund, '退款后个人限额是否释放'),
    eligibleMemberLevels: levels.toSorted(),
    rules,
    reason,
  }
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw promotionError(`${label}格式无效`, 'LOYALTY_PROMOTION_INVALID_INPUT', 400)
  return value
}

function normalizeRules(values: readonly Readonly<PromotionRuleInput>[]): PromotionRuleInput[] {
  if (values.length < 1 || values.length > 20) throw promotionError(
    '每个版本需要1至20条积分规则', 'LOYALTY_PROMOTION_INVALID_RULE_COUNT', 400,
  )
  const codes = new Set<string>()
  const rules = values.map((value) => {
    const ruleCode = businessCode(value.ruleCode, '规则编号')
    if (codes.has(ruleCode)) throw promotionError(
      '同一版本内规则编号不能重复', 'LOYALTY_PROMOTION_DUPLICATE_RULE_CODE', 400,
    )
    codes.add(ruleCode)
    if (!PROMOTION_TRIGGER_KINDS.includes(value.triggerKind)) throw promotionError(
      '触发条件无效', 'LOYALTY_PROMOTION_INVALID_TRIGGER', 400,
    )
    if (value.triggerKind !== 'activity_payment' && value.minimumPaidAmountMinor !== 0) {
      throw promotionError(
        '只有付款触发规则可以设置最低付款金额', 'LOYALTY_PROMOTION_PAYMENT_THRESHOLD_NOT_ALLOWED', 400,
      )
    }
    return {
      ruleCode,
      triggerKind: value.triggerKind,
      points: integer(value.points, '奖励积分', 1, 100_000),
      perMemberAwardLimit: integer(value.perMemberAwardLimit, '每会员发放次数', 1, 100),
      minimumPaidAmountMinor: integer(value.minimumPaidAmountMinor, '最低付款金额', 0, 100_000_000),
      enabled: boolean(value.enabled, '是否启用'),
    }
  })
  if (!rules.some((rule) => rule.enabled)) throw promotionError(
    '至少需要启用一条促销积分规则', 'LOYALTY_PROMOTION_ENABLED_RULE_REQUIRED', 400,
  )
  return rules
}

function mapRule(row: RuleRow): PromotionRuleView {
  return {
    id: row.id,
    ruleCode: row.rule_code,
    triggerKind: row.trigger_kind,
    points: Number(row.points),
    perMemberAwardLimit: Number(row.per_member_award_limit),
    minimumPaidAmountMinor: Number(row.minimum_paid_amount_minor),
    enabled: row.enabled,
  }
}

function mapPolicy(row: PolicyRow, rules: PromotionRuleView[]): PromotionPolicyView {
  const awardedPoints = Number(row.awarded_points)
  return {
    id: row.id,
    campaignCode: row.campaign_code,
    version: Number(row.version),
    name: row.name,
    activityId: row.activity_id,
    activityTitle: row.activity_title,
    stackingGroup: row.stacking_group,
    stackingMode: row.stacking_mode,
    priority: Number(row.priority),
    storeBudgetPoints: Number(row.store_budget_points),
    perMemberPointsLimit: Number(row.per_member_points_limit),
    pointValidityDays: Number(row.point_validity_days),
    refundPolicy: row.refund_policy,
    budgetReuseAfterRefund: row.budget_reuse_after_refund,
    memberLimitReuseAfterRefund: row.member_limit_reuse_after_refund,
    eligibleMemberLevels: [...row.eligible_member_levels],
    status: row.status,
    effectiveFrom: row.effective_from,
    effectiveUntil: row.effective_until,
    draftedByEmployeeId: row.drafted_by_employee_id,
    approvedByEmployeeId: row.approved_by_employee_id,
    approvedAt: row.approved_at,
    publishedByEmployeeId: row.published_by_employee_id,
    publishedAt: row.published_at,
    reason: row.reason,
    rules,
    awardedPoints,
    remainingBudgetPoints: Math.max(0, Number(row.store_budget_points) - awardedPoints),
    deferredTriggerCount: Number(row.deferred_trigger_count),
  }
}

function outcome(
  context: PromotionalLoyaltyStaffContext,
  result: PromotionPolicyView,
  action: string,
  reason: string,
) {
  const event: AuditEvent = {
    actor: { type: 'employee', employeeId: context.employeeId },
    action,
    objectType: 'loyalty_promotion_policy_version',
    objectId: result.id,
    businessDate: context.businessDate,
    reason,
    afterData: {
      campaignCode: result.campaignCode,
      version: result.version,
      status: result.status,
      activityId: result.activityId,
      storeBudgetPoints: result.storeBudgetPoints,
      perMemberPointsLimit: result.perMemberPointsLimit,
      stackingMode: result.stackingMode,
      budgetReuseAfterRefund: result.budgetReuseAfterRefund,
      memberLimitReuseAfterRefund: result.memberLimitReuseAfterRefund,
      ruleCount: result.rules.length,
    },
  }
  return { result, auditEvents: [event], outboxMessages: [] }
}

function promotionError(message: string, code: string, statusCode = 409): PromotionalLoyaltyError {
  return new PromotionalLoyaltyError(code, message, statusCode)
}

function cleanReason(value: string): string {
  return text(value, '原因', 2, 500)
}

function text(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== 'string') throw promotionError(`${label}格式无效`, 'LOYALTY_PROMOTION_INVALID_INPUT', 400)
  const normalized = value.trim()
  if (normalized.length < min || normalized.length > max) throw promotionError(
    `${label}长度必须在${min}至${max}个字符之间`, 'LOYALTY_PROMOTION_INVALID_INPUT', 400,
  )
  return normalized
}

function businessCode(value: unknown, label: string): string {
  const normalized = text(value, label, 3, 64).toUpperCase()
  if (!/^[A-Z0-9][A-Z0-9_.-]{2,63}$/.test(normalized)) throw promotionError(
    `${label}只能包含大写字母、数字、点、短横线和下划线`, 'LOYALTY_PROMOTION_INVALID_INPUT', 400,
  )
  return normalized
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw promotionError(
    `${label}必须是${min}至${max}之间的整数`, 'LOYALTY_PROMOTION_INVALID_INPUT', 400,
  )
  return Number(value)
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '' || !Number.isFinite(Date.parse(value))) {
    throw promotionError(`${label}格式无效`, 'LOYALTY_PROMOTION_INVALID_INPUT', 400)
  }
  return new Date(value).toISOString()
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).toSorted().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function objectCodec<Value>(): JsonCodec<Value> {
  return {
    encode: (value) => value as unknown as JsonValue,
    decode: (value) => value as Value,
  }
}
