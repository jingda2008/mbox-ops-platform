import { createHash } from 'node:crypto'
import type { AuditActor, JsonCodec, JsonObject, NormalizedCommandExecutor } from './command-executor.js'
import type { ScopedPostgresTransactionRunner, ScopedTransaction, StoreScope } from './transaction-runner.js'

export const ANNUAL_BENEFIT_RULE_KINDS = Object.freeze([
  'birthday', 'festival', 'priority_seating', 'daily_snack',
] as const)
export const ANNUAL_BENEFIT_TIERS = Object.freeze(['member', 'silver', 'gold'] as const)
export const ANNUAL_BENEFIT_ALCOHOL_HANDLING = Object.freeze([
  'not_applicable', 'non_alcoholic_only', 'staff_compliance_required',
] as const)
export const ANNUAL_BENEFIT_INVENTORY_REQUIREMENTS = Object.freeze([
  'not_applicable', 'strict_recipe',
] as const)
export const ANNUAL_BENEFIT_REVOCATION_POLICIES = Object.freeze([
  'cancel_before_redeem', 'expire_only', 'manual_compensation',
] as const)
export const ANNUAL_BENEFIT_FEB29_POLICIES = Object.freeze([
  'feb28', 'mar01', 'leap_year_only',
] as const)

export type AnnualBenefitRuleKind = (typeof ANNUAL_BENEFIT_RULE_KINDS)[number]
export type AnnualBenefitTier = (typeof ANNUAL_BENEFIT_TIERS)[number]
export type AnnualBenefitAlcoholHandling = (typeof ANNUAL_BENEFIT_ALCOHOL_HANDLING)[number]
export type AnnualBenefitInventoryRequirement = (typeof ANNUAL_BENEFIT_INVENTORY_REQUIREMENTS)[number]
export type AnnualBenefitRevocationPolicy = (typeof ANNUAL_BENEFIT_REVOCATION_POLICIES)[number]
export type AnnualBenefitFeb29Policy = (typeof ANNUAL_BENEFIT_FEB29_POLICIES)[number]

export interface AnnualBenefitSubstituteInput {
  productId: string
  priority: number
  reason: string
}

export interface AnnualBenefitStaffContext {
  scope: Readonly<StoreScope>
  employeeId: string
  businessDate: string
}

export interface AnnualBenefitRuleInput {
  ruleCode: string
  title: string
  ruleKind: AnnualBenefitRuleKind
  eligibleTier: AnnualBenefitTier
  inheritToHigherTiers: boolean
  benefitDefinitionId: string
  quantity: number
  validityDays: number
  windowBeforeDays: number
  windowAfterDays: number
  onSiteOnly: boolean
  requiresTableSession: boolean
  memberDailyLimit: number
  tableDailyLimit: number
  alcoholHandling: AnnualBenefitAlcoholHandling
  stackGroup: string
  priority: number
  inventoryRequirement: AnnualBenefitInventoryRequirement
  revocationPolicy: AnnualBenefitRevocationPolicy
  feb29Policy: AnnualBenefitFeb29Policy | null
  substitutes: readonly AnnualBenefitSubstituteInput[]
  reservationHoldMinutes: number | null
  redemptionHoldMinutes: number | null
  enabled: boolean
}

export class AnnualBenefitPolicyError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 409) {
    super(message)
    this.name = 'AnnualBenefitPolicyError'
  }
}

type TransactionRunner = Pick<ScopedPostgresTransactionRunner, 'run'>

export class LoyaltyAnnualBenefitService {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly commands: Pick<NormalizedCommandExecutor, 'execute'>,
  ) {}

  configuration(context: AnnualBenefitStaffContext) {
    return this.transactions.run(context.scope, async (transaction) => {
      const policies = await transaction.query<{
          id: string; policy_code: string; version: number; status: string; timezone: string
          effective_from: string | null; effective_until: string | null; drafted_by_employee_id: string
          approved_by_employee_id: string | null; approved_at: string | null
          published_by_employee_id: string | null; published_at: string | null; reason: string
        }>(`SELECT id,policy_code,version,status,timezone,effective_from::text,effective_until::text,
            drafted_by_employee_id,approved_by_employee_id,approved_at::text,published_by_employee_id,
            published_at::text,reason FROM mbox.loyalty_annual_benefit_policy_versions
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid ORDER BY policy_code,version DESC,id DESC`,
          [transaction.scope.tenantId, transaction.scope.storeId])
      const rules = await transaction.query<{
          id: string; policy_version_id: string; rule_code: string; title: string; rule_kind: AnnualBenefitRuleKind
          eligible_tier: AnnualBenefitTier; inherit_to_higher_tiers: boolean; benefit_definition_id: string
          quantity: number; validity_days: number; window_before_days: number; window_after_days: number
          on_site_only: boolean; requires_table_session: boolean; member_daily_limit: number; table_daily_limit: number
          alcohol_handling: AnnualBenefitAlcoholHandling; reservation_hold_minutes: number | null
          redemption_hold_minutes: number | null; stack_group: string; priority: number
          inventory_requirement: AnnualBenefitInventoryRequirement; revocation_policy: AnnualBenefitRevocationPolicy
          feb29_policy: AnnualBenefitFeb29Policy | null; substitutes: unknown; enabled: boolean
        }>(`SELECT id,policy_version_id,rule_code,title,rule_kind,eligible_tier,inherit_to_higher_tiers,
            benefit_definition_id,quantity,validity_days,window_before_days,window_after_days,on_site_only,
            requires_table_session,member_daily_limit,table_daily_limit,alcohol_handling,reservation_hold_minutes,
            redemption_hold_minutes,stack_group,priority,inventory_requirement,revocation_policy,feb29_policy,
            COALESCE((SELECT jsonb_agg(jsonb_build_object(
              'productId',substitute.product_id,'priority',substitute.priority,'reason',substitute.reason
            ) ORDER BY substitute.priority,substitute.product_id)
              FROM mbox.loyalty_annual_benefit_rule_substitutes substitute
              WHERE substitute.tenant_id=rule.tenant_id AND substitute.store_id=rule.store_id
                AND substitute.rule_id=rule.id),'[]'::jsonb) AS substitutes,enabled
          FROM mbox.loyalty_annual_benefit_rules rule
          WHERE rule.tenant_id=$1::uuid AND rule.store_id=$2::uuid
          ORDER BY policy_version_id,rule_code,id`, [transaction.scope.tenantId, transaction.scope.storeId])
      const occurrences = await transaction.query<{
          id: string; rule_id: string; cycle_year: number; starts_on: string; ends_on: string
          confirmed_by_employee_id: string; confirmation_reference: string; confirmed_at: string
        }>(`SELECT id,rule_id,cycle_year,starts_on::text,ends_on::text,confirmed_by_employee_id,
            confirmation_reference,confirmed_at::text FROM mbox.loyalty_annual_benefit_occurrences
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid ORDER BY cycle_year DESC,starts_on,rule_id`,
          [transaction.scope.tenantId, transaction.scope.storeId])
      const definitions = await transaction.query<{ id: string; name: string; benefit_kind: string; status: string }>(
          `SELECT id,name,benefit_kind,status FROM mbox.loyalty_benefit_definitions
            WHERE tenant_id=$1::uuid AND store_id=$2::uuid ORDER BY status,name,id`,
          [transaction.scope.tenantId, transaction.scope.storeId],
        )
      const products = await transaction.query<{ id: string; name: string; status: string }>(`
        SELECT product.id,product.name,product.status
        FROM mbox.products product
        WHERE product.tenant_id=$1::uuid AND product.store_id=$2::uuid
          AND product.status='active'
          AND product.recommendation_beverage_family='non_alcoholic'
          AND EXISTS (
            SELECT 1 FROM mbox.recipes recipe JOIN mbox.recipe_items item
              ON item.tenant_id=recipe.tenant_id AND item.store_id=recipe.store_id AND item.recipe_id=recipe.id
            WHERE recipe.tenant_id=product.tenant_id AND recipe.store_id=product.store_id
              AND recipe.product_id=product.id AND recipe.status='active'
          )
        ORDER BY product.name,product.id
      `, [transaction.scope.tenantId, transaction.scope.storeId])
      return {
        policies: policies.rows.map((row) => ({
          id: row.id, policyCode: row.policy_code, version: row.version, status: row.status,
          timezone: row.timezone, effectiveFrom: row.effective_from, effectiveUntil: row.effective_until,
          draftedByEmployeeId: row.drafted_by_employee_id, approvedByEmployeeId: row.approved_by_employee_id,
          approvedAt: row.approved_at, publishedByEmployeeId: row.published_by_employee_id,
          publishedAt: row.published_at, reason: row.reason,
        })),
        rules: rules.rows.map((row) => ({
          id: row.id, policyVersionId: row.policy_version_id, ruleCode: row.rule_code, title: row.title,
          ruleKind: row.rule_kind, eligibleTier: row.eligible_tier, inheritToHigherTiers: row.inherit_to_higher_tiers,
          benefitDefinitionId: row.benefit_definition_id, quantity: row.quantity, validityDays: row.validity_days,
          windowBeforeDays: row.window_before_days, windowAfterDays: row.window_after_days,
          onSiteOnly: row.on_site_only, requiresTableSession: row.requires_table_session,
          memberDailyLimit: row.member_daily_limit, tableDailyLimit: row.table_daily_limit,
          alcoholHandling: row.alcohol_handling, reservationHoldMinutes: row.reservation_hold_minutes,
          redemptionHoldMinutes: row.redemption_hold_minutes, stackGroup: row.stack_group, priority: row.priority,
          inventoryRequirement: row.inventory_requirement, revocationPolicy: row.revocation_policy,
          feb29Policy: row.feb29_policy, substitutes: row.substitutes, enabled: row.enabled,
        })),
        occurrences: occurrences.rows.map((row) => ({
          id: row.id, ruleId: row.rule_id, cycleYear: row.cycle_year, startsOn: row.starts_on,
          endsOn: row.ends_on, confirmedByEmployeeId: row.confirmed_by_employee_id,
          confirmationReference: row.confirmation_reference, confirmedAt: row.confirmed_at,
        })),
        definitions: definitions.rows.map((row) => ({
          id: row.id, name: row.name, benefitKind: row.benefit_kind, status: row.status,
        })),
        products: products.rows,
      }
    }, { readOnly: true })
  }

  draft(context: AnnualBenefitStaffContext, input: Readonly<{
    policyCode: string; timezone: string; reason: string; rules: readonly AnnualBenefitRuleInput[]; idempotencyKey: string
  }>) {
    validateRules(input.rules)
    const normalized = { ...input, policyCode: code(input.policyCode), timezone: timezone(input.timezone), reason: reason(input.reason) }
    return this.commands.execute({
      scope: context.scope, operationScope: 'loyalty.annual-benefit.draft', idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(normalized), resultCodec: objectCodec<{ id: string; version: number; status: string; ruleCount: number }>(),
    }, async (transaction) => {
      await assertDefinitions(transaction, normalized.rules)
      const policy = (await transaction.query<{ id: string; version: number; status: string }>(`
        WITH next_version AS (
          SELECT COALESCE(max(version),0)+1 AS version FROM mbox.loyalty_annual_benefit_policy_versions
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND policy_code=$3
        ) INSERT INTO mbox.loyalty_annual_benefit_policy_versions(
          tenant_id,store_id,policy_code,version,status,timezone,drafted_by_employee_id,reason
        ) SELECT $1::uuid,$2::uuid,$3,version,'draft',$4,$5::uuid,$6 FROM next_version
          RETURNING id,version,status
      `, [transaction.scope.tenantId, transaction.scope.storeId, normalized.policyCode,
        normalized.timezone, context.employeeId, normalized.reason])).rows[0]
      if (!policy) throw new Error('Annual benefit policy draft was not inserted')
      for (const rule of normalized.rules) await insertRule(transaction, policy.id, rule)
      const result = { ...policy, ruleCount: normalized.rules.length }
      return outcome(context, result, 'loyalty.annual-benefit.drafted', policy.id,
        { policyCode: normalized.policyCode, version: policy.version, ruleCount: result.ruleCount })
    })
  }

  approve(context: AnnualBenefitStaffContext, input: Readonly<{ policyId: string; reason: string; idempotencyKey: string }>) {
    return this.commands.execute({
      scope: context.scope, operationScope: 'loyalty.annual-benefit.approve', idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input), resultCodec: objectCodec<{ id: string; status: string }>(),
    }, async (transaction) => {
      await validatePolicy(transaction, input.policyId)
      const row = (await transaction.query<{ id: string; status: string }>(`
        UPDATE mbox.loyalty_annual_benefit_policy_versions SET status='approved',approved_by_employee_id=$4::uuid,
          approved_at=clock_timestamp(),reason=$5 WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
          AND status='draft' AND drafted_by_employee_id<>$4::uuid RETURNING id,status
      `, [transaction.scope.tenantId, transaction.scope.storeId, input.policyId, context.employeeId, reason(input.reason)])).rows[0]
      if (!row) throw failure('只有他人起草且规则完整的年度礼遇草稿可以审批', 'ANNUAL_BENEFIT_APPROVAL_DENIED')
      return outcome(context, row, 'loyalty.annual-benefit.approved', row.id, { reason: reason(input.reason) })
    })
  }

  publish(context: AnnualBenefitStaffContext, input: Readonly<{
    policyId: string; effectiveFrom: string; effectiveUntil: string | null; reason: string; idempotencyKey: string
  }>) {
    const effectiveFrom = timestamp(input.effectiveFrom, '生效时间')
    const effectiveUntil = input.effectiveUntil === null ? null : timestamp(input.effectiveUntil, '失效时间')
    if (Date.parse(effectiveFrom) <= Date.now()) throw failure('年度礼遇只能安排未来生效，禁止追溯生成权益', 'ANNUAL_BENEFIT_RETROACTIVE_PUBLICATION_DENIED', 400)
    if (effectiveUntil !== null && Date.parse(effectiveUntil) <= Date.parse(effectiveFrom)) throw failure('失效时间必须晚于生效时间', 'ANNUAL_BENEFIT_WINDOW_INVALID', 400)
    return this.commands.execute({
      scope: context.scope, operationScope: 'loyalty.annual-benefit.publish', idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint({ ...input, effectiveFrom, effectiveUntil }), resultCodec: objectCodec<{ id: string; status: string }>(),
    }, async (transaction) => {
      const policy = (await transaction.query<{
        id: string; policy_code: string; status: string; drafted_by_employee_id: string; approved_by_employee_id: string | null
      }>(`SELECT id,policy_code,status,drafted_by_employee_id,approved_by_employee_id
          FROM mbox.loyalty_annual_benefit_policy_versions WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid FOR UPDATE`,
      [transaction.scope.tenantId, transaction.scope.storeId, input.policyId])).rows[0]
      if (!policy || policy.status !== 'approved' || policy.approved_by_employee_id === null) throw failure('只有已独立审批的年度礼遇政策可以发布', 'ANNUAL_BENEFIT_NOT_APPROVED')
      if ([policy.drafted_by_employee_id, policy.approved_by_employee_id].includes(context.employeeId)) throw failure('起草人和审批人不能正式发布年度礼遇', 'ANNUAL_BENEFIT_PUBLISHER_NOT_INDEPENDENT')
      await validatePolicy(transaction, policy.id)
      const previous = (await transaction.query<{ id: string; effective_from: string; effective_until: string | null }>(`
        SELECT id,effective_from::text,effective_until::text FROM mbox.loyalty_annual_benefit_policy_versions
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND policy_code=$3 AND status='published'
        ORDER BY effective_from DESC,id DESC LIMIT 1 FOR UPDATE
      `, [transaction.scope.tenantId, transaction.scope.storeId, policy.policy_code])).rows[0]
      if (previous && Date.parse(effectiveFrom) <= Date.parse(previous.effective_from)) throw failure('新版本必须晚于当前已发布版本', 'ANNUAL_BENEFIT_RELEASE_ORDER_INVALID')
      if (previous?.effective_until !== null && previous?.effective_until !== undefined
        && Date.parse(previous.effective_until) < Date.parse(effectiveFrom)) {
        throw failure('新版本会造成已发布年度礼遇规则中断，不能发布', 'ANNUAL_BENEFIT_RELEASE_GAP', 400)
      }
      await transaction.query('SET CONSTRAINTS mbox.loyalty_annual_benefit_policy_no_published_overlap_excl DEFERRED')
      const row = (await transaction.query<{ id: string; status: string }>(`
        UPDATE mbox.loyalty_annual_benefit_policy_versions SET status='published',effective_from=$4::timestamptz,
          effective_until=$5::timestamptz,published_by_employee_id=$6::uuid,published_at=clock_timestamp(),reason=$7
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='approved' RETURNING id,status
      `, [transaction.scope.tenantId, transaction.scope.storeId, policy.id, effectiveFrom, effectiveUntil, context.employeeId, reason(input.reason)])).rows[0]
      if (!row) throw failure('年度礼遇政策状态已经变化，请刷新后重试', 'ANNUAL_BENEFIT_PUBLISH_CONFLICT')
      if (previous) await transaction.query(`UPDATE mbox.loyalty_annual_benefit_policy_versions SET effective_until=$4::timestamptz
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='published'`,
      [transaction.scope.tenantId, transaction.scope.storeId, previous.id, effectiveFrom])
      return outcome(context, row, 'loyalty.annual-benefit.published', row.id, { effectiveFrom, effectiveUntil })
    })
  }

  confirmFestivalOccurrence(context: AnnualBenefitStaffContext, input: Readonly<{
    ruleId: string; cycleYear: number; startsOn: string; endsOn: string; confirmationReference: string; idempotencyKey: string
  }>) {
    const startsOn = date(input.startsOn, '开始日期'); const endsOn = date(input.endsOn, '结束日期')
    if (startsOn > endsOn || Number(startsOn.slice(0, 4)) !== input.cycleYear || Number(endsOn.slice(0, 4)) !== input.cycleYear) {
      throw failure('节日日期必须在同一自然年且结束不早于开始', 'ANNUAL_BENEFIT_OCCURRENCE_WINDOW_INVALID', 400)
    }
    return this.commands.execute({
      scope: context.scope, operationScope: 'loyalty.annual-benefit.occurrence.confirm', idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint({ ...input, startsOn, endsOn }), resultCodec: objectCodec<{ id: string; cycleYear: number }>(),
    }, async (transaction) => {
      const row = (await transaction.query<{ id: string; cycle_year: number }>(`
        INSERT INTO mbox.loyalty_annual_benefit_occurrences(
          tenant_id,store_id,rule_id,cycle_year,starts_on,ends_on,confirmed_by_employee_id,confirmation_reference
        ) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::date,$6::date,$7::uuid,$8)
        RETURNING id,cycle_year
      `, [transaction.scope.tenantId, transaction.scope.storeId, input.ruleId, input.cycleYear,
        startsOn, endsOn, context.employeeId, reference(input.confirmationReference)])).rows[0]
      if (!row) throw new Error('Annual benefit occurrence was not inserted')
      return outcome(context, { id: row.id, cycleYear: row.cycle_year }, 'loyalty.annual-benefit.occurrence.confirmed', row.id,
        { ruleId: input.ruleId, cycleYear: row.cycle_year, startsOn, endsOn })
    })
  }
}

async function insertRule(transaction: ScopedTransaction, policyId: string, rule: AnnualBenefitRuleInput) {
  await transaction.query(`INSERT INTO mbox.loyalty_annual_benefit_rules(
    tenant_id,store_id,policy_version_id,rule_code,title,rule_kind,eligible_tier,inherit_to_higher_tiers,
    benefit_definition_id,quantity,validity_days,window_before_days,window_after_days,requires_birthday_consent,
    requires_confirmed_occurrence,on_site_only,requires_table_session,member_daily_limit,table_daily_limit,
    alcohol_handling,reservation_hold_minutes,redemption_hold_minutes,stack_group,priority,
    inventory_requirement,revocation_policy,feb29_policy,enabled
  ) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9::uuid,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)`, [
    transaction.scope.tenantId, transaction.scope.storeId, policyId, rule.ruleCode, rule.title, rule.ruleKind,
    rule.eligibleTier, rule.inheritToHigherTiers, rule.benefitDefinitionId, rule.quantity, rule.validityDays,
    rule.windowBeforeDays, rule.windowAfterDays, rule.ruleKind === 'birthday', rule.ruleKind === 'festival',
    rule.onSiteOnly, rule.requiresTableSession, rule.memberDailyLimit, rule.tableDailyLimit,
    rule.alcoholHandling, rule.reservationHoldMinutes, rule.redemptionHoldMinutes, rule.stackGroup,
    rule.priority, rule.inventoryRequirement, rule.revocationPolicy, rule.feb29Policy, rule.enabled,
  ])
  if (rule.substitutes.length > 0) await transaction.query(`
    INSERT INTO mbox.loyalty_annual_benefit_rule_substitutes(
      tenant_id,store_id,rule_id,product_id,priority,reason
    )
    SELECT $1::uuid,$2::uuid,created.id,substitute.product_id,substitute.priority,substitute.reason
    FROM mbox.loyalty_annual_benefit_rules created
    CROSS JOIN jsonb_to_recordset($5::jsonb) AS substitute(product_id uuid,priority smallint,reason text)
    WHERE created.tenant_id=$1::uuid AND created.store_id=$2::uuid
      AND created.policy_version_id=$3::uuid AND created.rule_code=$4
  `, [transaction.scope.tenantId, transaction.scope.storeId, policyId, rule.ruleCode,
    JSON.stringify(rule.substitutes.map((item) => ({ product_id: item.productId, priority: item.priority, reason: item.reason })))])
}

async function assertDefinitions(transaction: ScopedTransaction, rules: readonly AnnualBenefitRuleInput[]) {
  const ids = [...new Set(rules.map((rule) => rule.benefitDefinitionId))]
  const result = await transaction.query<{ id: string; benefit_kind: string; product_id: string | null }>(`SELECT id,benefit_kind,product_id FROM mbox.loyalty_benefit_definitions
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=ANY($3::uuid[]) AND status='active' FOR SHARE`,
  [transaction.scope.tenantId, transaction.scope.storeId, ids])
  if (result.rows.length !== ids.length) throw failure('部分权益定义不存在或未启用', 'ANNUAL_BENEFIT_DEFINITION_UNAVAILABLE')
  const definitions = new Map(result.rows.map((row) => [row.id, row]))
  const productIds = [...new Set(rules.flatMap((rule) => [
    definitions.get(rule.benefitDefinitionId)?.product_id ?? null,
    ...rule.substitutes.map((item) => item.productId),
  ]).filter((value): value is string => value !== null))]
  const productRows = productIds.length === 0 ? [] : (await transaction.query<{
    id: string; recommendation_beverage_family: string
  }>(`
    SELECT product.id,product.recommendation_beverage_family
    FROM mbox.products product
    WHERE product.tenant_id=$1::uuid AND product.store_id=$2::uuid
      AND product.id=ANY($3::uuid[]) AND product.status='active'
      AND product.cost_amount_minor IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM mbox.product_prices price
        WHERE price.tenant_id=product.tenant_id AND price.store_id=product.store_id
          AND price.product_id=product.id AND price.price_type='standard'
          AND price.valid_from<=clock_timestamp()
          AND (price.valid_until IS NULL OR price.valid_until>clock_timestamp())
      )
      AND EXISTS (
        SELECT 1 FROM mbox.recipes recipe
        JOIN mbox.recipe_items item
          ON item.tenant_id=recipe.tenant_id AND item.store_id=recipe.store_id AND item.recipe_id=recipe.id
        JOIN mbox.inventory_items inventory
          ON inventory.tenant_id=item.tenant_id AND inventory.store_id=item.store_id
         AND inventory.id=item.inventory_item_id AND inventory.status='active'
        WHERE recipe.tenant_id=product.tenant_id AND recipe.store_id=product.store_id
          AND recipe.product_id=product.id AND recipe.status='active'
      )
    FOR SHARE OF product
  `, [transaction.scope.tenantId, transaction.scope.storeId, productIds])).rows
  const eligibleProducts = new Set(productRows.map((row) => row.id))
  const nonAlcoholicProducts = new Set(productRows
    .filter((row) => row.recommendation_beverage_family === 'non_alcoholic').map((row) => row.id))
  for (const rule of rules) {
    const definition = definitions.get(rule.benefitDefinitionId)
    if (!definition) throw failure('部分权益定义不存在或未启用', 'ANNUAL_BENEFIT_DEFINITION_UNAVAILABLE')
    if (rule.ruleKind === 'priority_seating' && definition.benefit_kind !== 'reservation_priority') {
      throw failure('优先订座必须关联“预约优先”权益定义', 'ANNUAL_BENEFIT_PRIORITY_DEFINITION_INVALID', 400)
    }
    if (rule.ruleKind === 'daily_snack' && (definition.benefit_kind !== 'gift_product' || definition.product_id === null)) {
      throw failure('每日点心必须关联已绑定商品的赠品权益定义', 'ANNUAL_BENEFIT_DAILY_SNACK_DEFINITION_INVALID', 400)
    }
    if (definition.benefit_kind === 'gift_product') {
      if (definition.product_id === null || rule.inventoryRequirement !== 'strict_recipe'
        || !eligibleProducts.has(definition.product_id)
        || rule.substitutes.some((item) => !eligibleProducts.has(item.productId))) {
        throw failure('赠品及替代品必须已启用，并具有当前标准售价、正式成本、正式配方和有效库存物料', 'ANNUAL_BENEFIT_GIFT_RECIPE_INVALID', 400)
      }
      if (rule.alcoholHandling === 'staff_compliance_required' && rule.substitutes.length === 0) {
        throw failure('需员工酒水合规核验的礼遇必须配置无酒精替代品', 'ANNUAL_BENEFIT_ALCOHOL_SUBSTITUTE_REQUIRED', 400)
      }
      if (rule.alcoholHandling === 'staff_compliance_required'
        && rule.substitutes.some((item) => !nonAlcoholicProducts.has(item.productId))) {
        throw failure('酒水合规替代品必须在商品主数据中明确标记为无酒精', 'ANNUAL_BENEFIT_ALCOHOL_SUBSTITUTE_INVALID', 400)
      }
      if (rule.alcoholHandling === 'non_alcoholic_only'
        && !nonAlcoholicProducts.has(definition.product_id)) {
        throw failure('仅无酒精礼遇的主商品必须在商品主数据中明确标记为无酒精', 'ANNUAL_BENEFIT_NON_ALCOHOLIC_PRODUCT_INVALID', 400)
      }
    } else if (rule.inventoryRequirement !== 'not_applicable' || rule.substitutes.length > 0) {
      throw failure('非赠品礼遇不得配置库存或商品替代品', 'ANNUAL_BENEFIT_NON_GIFT_INVENTORY_INVALID', 400)
    }
  }
}

async function validatePolicy(transaction: ScopedTransaction, policyId: string) {
  const result = await transaction.query<{ total: number; enabled: number; invalid: number; invalid_execution: number }>(`
    SELECT count(rule.id)::integer AS total,count(rule.id) FILTER(WHERE rule.enabled)::integer AS enabled,
      count(rule.id) FILTER(WHERE rule.enabled AND definition.status<>'active')::integer AS invalid,
      count(rule.id) FILTER(WHERE rule.enabled AND (
        (definition.benefit_kind='gift_product' AND (
          definition.product_id IS NULL OR rule.inventory_requirement<>'strict_recipe'
          OR NOT EXISTS (
            SELECT 1 FROM mbox.products product JOIN mbox.recipes recipe
              ON recipe.tenant_id=product.tenant_id AND recipe.store_id=product.store_id
             AND recipe.product_id=product.id AND recipe.status='active'
            JOIN mbox.recipe_items item
              ON item.tenant_id=recipe.tenant_id AND item.store_id=recipe.store_id AND item.recipe_id=recipe.id
            JOIN mbox.inventory_items inventory
              ON inventory.tenant_id=item.tenant_id AND inventory.store_id=item.store_id
             AND inventory.id=item.inventory_item_id AND inventory.status='active'
            WHERE product.tenant_id=rule.tenant_id AND product.store_id=rule.store_id
              AND product.id=definition.product_id AND product.status='active'
              AND product.cost_amount_minor IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM mbox.product_prices price
                WHERE price.tenant_id=product.tenant_id AND price.store_id=product.store_id
                  AND price.product_id=product.id AND price.price_type='standard'
                  AND price.valid_from<=clock_timestamp()
                  AND (price.valid_until IS NULL OR price.valid_until>clock_timestamp())
              )
          )
          OR (rule.alcohol_handling='staff_compliance_required' AND NOT EXISTS (
            SELECT 1 FROM mbox.loyalty_annual_benefit_rule_substitutes substitute
            WHERE substitute.tenant_id=rule.tenant_id AND substitute.store_id=rule.store_id AND substitute.rule_id=rule.id
          ))
          OR (rule.alcohol_handling='non_alcoholic_only' AND NOT EXISTS (
            SELECT 1 FROM mbox.products primary_product
            WHERE primary_product.tenant_id=rule.tenant_id AND primary_product.store_id=rule.store_id
              AND primary_product.id=definition.product_id
              AND primary_product.recommendation_beverage_family='non_alcoholic'
          ))
          OR EXISTS (
            SELECT 1 FROM mbox.loyalty_annual_benefit_rule_substitutes substitute
            LEFT JOIN mbox.products product
              ON product.tenant_id=substitute.tenant_id AND product.store_id=substitute.store_id
             AND product.id=substitute.product_id AND product.status='active'
            WHERE substitute.tenant_id=rule.tenant_id AND substitute.store_id=rule.store_id
              AND substitute.rule_id=rule.id AND (product.id IS NULL
                OR product.cost_amount_minor IS NULL
                OR NOT EXISTS (
                  SELECT 1 FROM mbox.product_prices price
                  WHERE price.tenant_id=product.tenant_id AND price.store_id=product.store_id
                    AND price.product_id=product.id AND price.price_type='standard'
                    AND price.valid_from<=clock_timestamp()
                    AND (price.valid_until IS NULL OR price.valid_until>clock_timestamp())
                )
                OR (rule.alcohol_handling='staff_compliance_required'
                  AND product.recommendation_beverage_family<>'non_alcoholic') OR NOT EXISTS (
                SELECT 1 FROM mbox.recipes recipe JOIN mbox.recipe_items item
                  ON item.tenant_id=recipe.tenant_id AND item.store_id=recipe.store_id AND item.recipe_id=recipe.id
                JOIN mbox.inventory_items inventory
                  ON inventory.tenant_id=item.tenant_id AND inventory.store_id=item.store_id
                 AND inventory.id=item.inventory_item_id AND inventory.status='active'
                WHERE recipe.tenant_id=product.tenant_id AND recipe.store_id=product.store_id
                  AND recipe.product_id=product.id AND recipe.status='active'
              ))
          )
        ))
        OR (definition.benefit_kind<>'gift_product' AND (
          rule.inventory_requirement<>'not_applicable' OR EXISTS (
            SELECT 1 FROM mbox.loyalty_annual_benefit_rule_substitutes substitute
            WHERE substitute.tenant_id=rule.tenant_id AND substitute.store_id=rule.store_id AND substitute.rule_id=rule.id
          )
        ))
      ))::integer AS invalid_execution
    FROM mbox.loyalty_annual_benefit_rules rule JOIN mbox.loyalty_benefit_definitions definition
      ON definition.tenant_id=rule.tenant_id AND definition.store_id=rule.store_id AND definition.id=rule.benefit_definition_id
    WHERE rule.tenant_id=$1::uuid AND rule.store_id=$2::uuid AND rule.policy_version_id=$3::uuid`,
  [transaction.scope.tenantId, transaction.scope.storeId, policyId])
  const row = result.rows[0]
  if (!row || row.total < 1 || row.enabled < 1 || row.invalid > 0 || row.invalid_execution > 0) {
    throw failure('年度礼遇政策必须包含可履约的当前售价、正式成本、配方、替代品和库存规则', 'ANNUAL_BENEFIT_RULES_INVALID')
  }
  const priorityConflict = await transaction.query(`
    SELECT 1
    FROM mbox.loyalty_annual_benefit_rules birthday
    JOIN mbox.loyalty_annual_benefit_rules festival
      ON festival.tenant_id=birthday.tenant_id AND festival.store_id=birthday.store_id
     AND festival.policy_version_id=birthday.policy_version_id
    WHERE birthday.tenant_id=$1::uuid AND birthday.store_id=$2::uuid
      AND birthday.policy_version_id=$3::uuid
      AND birthday.enabled AND festival.enabled
      AND birthday.rule_kind='birthday' AND festival.rule_kind='festival'
      AND birthday.priority>=festival.priority
    LIMIT 1
  `, [transaction.scope.tenantId, transaction.scope.storeId, policyId])
  if (priorityConflict.rows[0]) {
    throw failure('生日与节日礼遇重叠时必须由生日规则优先', 'ANNUAL_BENEFIT_STACK_PRIORITY_INVALID')
  }
}

function validateRules(rules: readonly AnnualBenefitRuleInput[]) {
  if (rules.length < 1 || rules.length > 100 || new Set(rules.map((rule) => rule.ruleCode)).size !== rules.length) {
    throw failure('年度礼遇规则数量或编号不正确', 'ANNUAL_BENEFIT_RULES_INVALID', 400)
  }
  if (rules.filter((rule) => rule.enabled && rule.ruleKind === 'priority_seating').length > 1) {
    throw failure('同一年度礼遇政策只能启用一条优先订座规则', 'ANNUAL_BENEFIT_PRIORITY_RULE_AMBIGUOUS', 400)
  }
  const birthdayPriorities = rules.filter((rule) => rule.enabled && rule.ruleKind === 'birthday').map((rule) => rule.priority)
  const festivalPriorities = rules.filter((rule) => rule.enabled && rule.ruleKind === 'festival').map((rule) => rule.priority)
  if (birthdayPriorities.length > 0 && festivalPriorities.length > 0
    && Math.max(...birthdayPriorities) >= Math.min(...festivalPriorities)) {
    throw failure('生日礼遇与节日礼遇同窗时必须由生日礼遇优先', 'ANNUAL_BENEFIT_STACK_PRIORITY_INVALID', 400)
  }
  for (const rule of rules) {
    if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(rule.ruleCode) || rule.title.trim().length < 2 || rule.title.trim().length > 120
      || !ANNUAL_BENEFIT_RULE_KINDS.includes(rule.ruleKind) || !ANNUAL_BENEFIT_TIERS.includes(rule.eligibleTier)
      || !ANNUAL_BENEFIT_ALCOHOL_HANDLING.includes(rule.alcoholHandling)
      || !ANNUAL_BENEFIT_INVENTORY_REQUIREMENTS.includes(rule.inventoryRequirement)
      || !ANNUAL_BENEFIT_REVOCATION_POLICIES.includes(rule.revocationPolicy)
      || !/^[a-z][a-z0-9_.-]{1,63}$/.test(rule.stackGroup)
      || ![rule.quantity,rule.validityDays,rule.windowBeforeDays,rule.windowAfterDays,rule.memberDailyLimit,rule.tableDailyLimit,rule.priority].every(Number.isSafeInteger)
      || rule.quantity < 1 || rule.quantity > 100 || rule.validityDays < 1 || rule.validityDays > 366
      || rule.priority < 1 || rule.priority > 32767
      || rule.windowBeforeDays < 0 || rule.windowBeforeDays > 90 || rule.windowAfterDays < 0 || rule.windowAfterDays > 90
      || rule.memberDailyLimit < 1 || rule.memberDailyLimit > 100 || rule.tableDailyLimit < 1 || rule.tableDailyLimit > 100) {
      throw failure('年度礼遇规则字段不符合约束', 'ANNUAL_BENEFIT_RULES_INVALID', 400)
    }
    if ((rule.ruleKind === 'birthday' && (rule.feb29Policy === null || !ANNUAL_BENEFIT_FEB29_POLICIES.includes(rule.feb29Policy)))
      || (rule.ruleKind !== 'birthday' && rule.feb29Policy !== null)
      || (['birthday','festival'].includes(rule.ruleKind) && rule.stackGroup !== 'festival_gift')) {
      throw failure('生日/节日礼遇必须明确同组优先级及2月29日处理规则', 'ANNUAL_BENEFIT_CALENDAR_POLICY_INVALID', 400)
    }
    if (rule.substitutes.length > 20
      || new Set(rule.substitutes.map((item) => item.productId)).size !== rule.substitutes.length
      || rule.substitutes.some((item) => !Number.isSafeInteger(item.priority) || item.priority < 1 || item.priority > 32767
        || item.reason.trim().length < 2 || item.reason.trim().length > 240)) {
      throw failure('年度礼遇替代品配置不正确', 'ANNUAL_BENEFIT_SUBSTITUTES_INVALID', 400)
    }
    if ((rule.ruleKind === 'priority_seating' && (!Number.isSafeInteger(rule.reservationHoldMinutes)
      || rule.reservationHoldMinutes === null || rule.reservationHoldMinutes < 5 || rule.reservationHoldMinutes > 30))
      || (rule.ruleKind !== 'priority_seating' && rule.reservationHoldMinutes !== null)) {
      throw failure('优先订座保留时间必须为5至30分钟，其他礼遇不得填写该字段', 'ANNUAL_BENEFIT_PRIORITY_HOLD_INVALID', 400)
    }
    if ((rule.ruleKind === 'daily_snack' && (!Number.isSafeInteger(rule.redemptionHoldMinutes)
      || rule.redemptionHoldMinutes === null || rule.redemptionHoldMinutes < 5 || rule.redemptionHoldMinutes > 30))
      || (rule.ruleKind !== 'daily_snack' && rule.redemptionHoldMinutes !== null)) {
      throw failure('每日点心暂留时间必须为5至30分钟，其他礼遇不得填写该字段', 'ANNUAL_BENEFIT_DAILY_SNACK_HOLD_INVALID', 400)
    }
    if (rule.ruleKind === 'priority_seating' && (rule.onSiteOnly || rule.requiresTableSession
      || rule.inventoryRequirement !== 'not_applicable' || rule.substitutes.length > 0)) {
      throw failure('优先订座仅用于预约排队，不应要求已到店桌台', 'ANNUAL_BENEFIT_PRIORITY_SHAPE_INVALID', 400)
    }
    if (rule.ruleKind === 'daily_snack' && (!rule.onSiteOnly || !rule.requiresTableSession
      || rule.alcoholHandling !== 'not_applicable' || rule.validityDays !== 1
      || rule.inventoryRequirement !== 'strict_recipe'
      || rule.windowBeforeDays !== 0 || rule.windowAfterDays !== 0
      || rule.quantity > rule.memberDailyLimit || rule.quantity > rule.tableDailyLimit)) {
      throw failure('每日点心必须到店关联桌台，且不得配置酒水处理', 'ANNUAL_BENEFIT_DAILY_SNACK_SHAPE_INVALID', 400)
    }
  }
}

function code(value: string) { if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(value)) throw failure('年度礼遇政策编号不正确', 'ANNUAL_BENEFIT_POLICY_CODE_INVALID', 400); return value }
function timezone(value: string) { if (!/^[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?$/.test(value)) throw failure('时区格式不正确', 'ANNUAL_BENEFIT_TIMEZONE_INVALID', 400); try { new Intl.DateTimeFormat('en-CA',{timeZone:value}).format() } catch { throw failure('时区不受支持', 'ANNUAL_BENEFIT_TIMEZONE_INVALID', 400) }; return value }
function reason(value: string) { const result=value.trim(); if(result.length<2||result.length>500) throw failure('说明长度不正确','ANNUAL_BENEFIT_REASON_INVALID',400); return result }
function reference(value: string) { const result=value.trim(); if(result.length<2||result.length>240) throw failure('节日确认依据长度不正确','ANNUAL_BENEFIT_CONFIRMATION_REFERENCE_INVALID',400); return result }
function timestamp(value: string, label: string) { if (!Number.isFinite(Date.parse(value))) throw failure(`${label}格式不正确`,'ANNUAL_BENEFIT_TIMESTAMP_INVALID',400); return new Date(value).toISOString() }
function date(value: string, label: string) { if (!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))) throw failure(`${label}格式不正确`,'ANNUAL_BENEFIT_DATE_INVALID',400); return value }
function failure(message: string, code: string, statusCode = 409) { return new AnnualBenefitPolicyError(code,message,statusCode) }

function outcome<Result>(context: AnnualBenefitStaffContext, result: Result, action: string, objectId: string, afterData: JsonObject) {
  const actor: AuditActor = { type: 'employee', employeeId: context.employeeId }
  return { result, auditEvents: [{ actor, action, objectType: 'loyalty_annual_benefit_policy', objectId, businessDate: context.businessDate, afterData }], outboxMessages: [{
    businessEventKey: `${action}:${objectId}`, aggregateType: 'loyalty_annual_benefit_policy', aggregateId: objectId,
    aggregateVersion: 1, eventType: `${action}.v1`, payload: afterData,
  }] }
}
function fingerprint(value: unknown) { return createHash('sha256').update(stable(value)).digest('hex') }
function stable(value: unknown): string { if(Array.isArray(value)) return `[${value.map(stable).join(',')}]`; if(isObject(value)) return `{${Object.keys(value).toSorted().map((key)=>`${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`; return JSON.stringify(value) ?? 'null' }
function isObject(value: unknown): value is JsonObject { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function objectCodec<Value>(): JsonCodec<Value> { return { encode:(value)=>value as unknown as JsonObject, decode:(value)=>{ if(!isObject(value)) throw new TypeError('Stored annual benefit result is invalid'); return value as unknown as Value } } }
