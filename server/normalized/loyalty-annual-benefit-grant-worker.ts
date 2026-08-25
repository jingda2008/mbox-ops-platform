import { createHash } from 'node:crypto'
import type { ScopedPostgresTransactionRunner, ScopedTransaction, StoreScope } from './transaction-runner.js'

type Tier = 'member' | 'silver' | 'gold'
type RuleKind = 'birthday' | 'festival'

interface CandidateRow extends Record<string, unknown> {
  membership_id: string
  customer_id: string
  current_tier: Tier
  timezone: string
  policy_id: string
  rule_id: string
  rule_kind: RuleKind
  eligible_tier: Tier
  inherit_to_higher_tiers: boolean
  benefit_definition_id: string
  benefit_code: string
  benefit_kind: string
  display_snapshot: unknown
  product_id: string | null
  product_price_amount_minor: string | number | null
  product_price_currency: string | null
  quantity: number
  validity_days: number
  window_before_days: number
  window_after_days: number
  stack_group: string
  priority: number
  inventory_requirement: 'not_applicable' | 'strict_recipe'
  revocation_policy: 'cancel_before_redeem' | 'expire_only' | 'manual_compensation'
  feb29_policy: 'feb28' | 'mar01' | 'leap_year_only' | null
  substitute_product_ids: string[]
  birthday_month_day: unknown
  consent_status: 'granted' | 'withdrawn' | null
  starts_on: string | null
  ends_on: string | null
  today_on: string
  event_on: string
  window_starts_on: string
  window_ends_on: string
  window_end_exclusive: string
  tier_coverage_ends_at: string | null
}

export interface LoyaltyAnnualBenefitGrantBatch {
  workerId: string
  evaluatedAt: string
  candidates: number
  grantedBenefits: number
  executionBlockedRules: number
}

export class LoyaltyAnnualBenefitGrantWorker {
  constructor(
    private readonly transactions: ScopedPostgresTransactionRunner,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  runBatch(scope: Readonly<StoreScope>, workerId: string, batchSize = 200): Promise<LoyaltyAnnualBenefitGrantBatch> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,95}$/.test(workerId)) throw new TypeError('workerId is invalid')
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new TypeError('batchSize is invalid')
    const evaluatedAt = this.now()
    if (!Number.isFinite(Date.parse(evaluatedAt))) throw new TypeError('worker time is invalid')
    return this.transactions.run(scope, async (transaction) => {
      const blockedRules = await findExecutionBlockedRules(transaction, evaluatedAt)
      const blockedRuleIds = new Set(blockedRules.map((rule) => rule.ruleId))
      const candidates = await transaction.query<CandidateRow>(`
        WITH candidate_base AS (
          SELECT policy.tenant_id,policy.store_id,membership.id AS membership_id,membership.customer_id,
            period.tier AS current_tier,period.coverage_ends_at,
            membership.joined_at,policy.id AS policy_id,policy.timezone,rule.id AS rule_id,rule.rule_code,
            rule.rule_kind,rule.eligible_tier,rule.inherit_to_higher_tiers,
            rule.benefit_definition_id,definition.benefit_code,definition.benefit_kind,
            definition.display_snapshot,definition.product_id,
            price.amount_minor AS product_price_amount_minor,price.currency AS product_price_currency,
            rule.quantity,rule.validity_days,rule.window_before_days,rule.window_after_days,
            rule.stack_group,rule.priority,rule.inventory_requirement,rule.revocation_policy,rule.feb29_policy,
            COALESCE(substitutes.product_ids,ARRAY[]::uuid[]) AS substitute_product_ids,
            preference.preference_value #>> '{}' AS birthday_month_day,
            consent.status AS consent_status,
            ($4::timestamptz AT TIME ZONE policy.timezone)::date AS today_on
          FROM mbox.loyalty_annual_benefit_policy_versions policy
          JOIN mbox.loyalty_annual_benefit_rules rule
            ON rule.tenant_id=policy.tenant_id AND rule.store_id=policy.store_id
           AND rule.policy_version_id=policy.id AND rule.enabled AND rule.rule_kind IN ('birthday','festival')
          JOIN mbox.loyalty_benefit_definitions definition
            ON definition.tenant_id=rule.tenant_id AND definition.store_id=rule.store_id
           AND definition.id=rule.benefit_definition_id AND definition.status='active'
          LEFT JOIN LATERAL (
            SELECT amount_minor,currency FROM mbox.product_prices
            WHERE tenant_id=definition.tenant_id AND store_id=definition.store_id AND product_id=definition.product_id
              AND price_type='standard' AND valid_from<=$4::timestamptz
              AND (valid_until IS NULL OR valid_until>$4::timestamptz)
            ORDER BY valid_from DESC,id DESC LIMIT 1
          ) price ON definition.benefit_kind='gift_product'
          LEFT JOIN LATERAL (
            SELECT array_agg(substitute.product_id ORDER BY substitute.priority,substitute.product_id) AS product_ids
            FROM mbox.loyalty_annual_benefit_rule_substitutes substitute
            WHERE substitute.tenant_id=rule.tenant_id AND substitute.store_id=rule.store_id
              AND substitute.rule_id=rule.id
          ) substitutes ON true
          JOIN mbox.customer_memberships membership
            ON membership.tenant_id=policy.tenant_id AND membership.store_id=policy.store_id AND membership.status='active'
          JOIN mbox.loyalty_accounts account
            ON account.tenant_id=membership.tenant_id AND account.store_id=membership.store_id
           AND account.membership_id=membership.id AND account.customer_id=membership.customer_id
          JOIN LATERAL (
            SELECT tier,CASE WHEN status='grace' THEN grace_ends_at ELSE ends_at END AS coverage_ends_at
            FROM mbox.membership_tier_periods
            WHERE tenant_id=membership.tenant_id AND store_id=membership.store_id
              AND membership_id=membership.id AND status IN ('active','grace')
              AND starts_at<=$4::timestamptz
              AND CASE WHEN status='grace' THEN grace_ends_at>$4::timestamptz
                ELSE (ends_at IS NULL OR ends_at>$4::timestamptz) END
            ORDER BY starts_at DESC,id DESC LIMIT 1
          ) period ON true
          LEFT JOIN LATERAL (
            SELECT preference_value FROM mbox.customer_preferences
            WHERE tenant_id=membership.tenant_id AND store_id=membership.store_id
              AND customer_id=membership.customer_id AND preference_key='birthdayMonthDay'
            ORDER BY observed_at DESC,id DESC LIMIT 1
          ) preference ON true
          LEFT JOIN LATERAL (
            SELECT status FROM mbox.customer_annual_benefit_consents
            WHERE tenant_id=membership.tenant_id AND store_id=membership.store_id
              AND customer_id=membership.customer_id AND consent_type='birthday_month_day'
            ORDER BY consented_at DESC,id DESC LIMIT 1
          ) consent ON true
          WHERE policy.tenant_id=$1::uuid AND policy.store_id=$2::uuid AND policy.status='published'
            AND policy.effective_from<=$4::timestamptz
            AND (policy.effective_until IS NULL OR policy.effective_until>$4::timestamptz)
            AND (
              (definition.benefit_kind='gift_product' AND definition.product_id IS NOT NULL
                AND price.amount_minor IS NOT NULL AND rule.inventory_requirement='strict_recipe'
                AND EXISTS (
                  SELECT 1 FROM mbox.products product
                  WHERE product.tenant_id=definition.tenant_id AND product.store_id=definition.store_id
                    AND product.id=definition.product_id AND product.status='active'
                    AND product.cost_amount_minor IS NOT NULL
                )
                AND EXISTS (
                  SELECT 1 FROM mbox.recipes recipe JOIN mbox.recipe_items item
                    ON item.tenant_id=recipe.tenant_id AND item.store_id=recipe.store_id AND item.recipe_id=recipe.id
                  JOIN mbox.inventory_items inventory
                    ON inventory.tenant_id=item.tenant_id AND inventory.store_id=item.store_id
                   AND inventory.id=item.inventory_item_id AND inventory.status='active'
                  WHERE recipe.tenant_id=definition.tenant_id AND recipe.store_id=definition.store_id
                    AND recipe.product_id=definition.product_id AND recipe.status='active'
                )
                AND NOT EXISTS (
                  SELECT 1 FROM mbox.loyalty_annual_benefit_rule_substitutes substitute
                  LEFT JOIN mbox.products product
                    ON product.tenant_id=substitute.tenant_id AND product.store_id=substitute.store_id
                   AND product.id=substitute.product_id AND product.status='active'
                  WHERE substitute.tenant_id=rule.tenant_id AND substitute.store_id=rule.store_id
                    AND substitute.rule_id=rule.id AND (product.id IS NULL
                      OR product.cost_amount_minor IS NULL
                      OR NOT EXISTS (
                        SELECT 1 FROM mbox.product_prices substitute_price
                        WHERE substitute_price.tenant_id=product.tenant_id AND substitute_price.store_id=product.store_id
                          AND substitute_price.product_id=product.id AND substitute_price.price_type='standard'
                          AND substitute_price.valid_from<=$4::timestamptz
                          AND (substitute_price.valid_until IS NULL OR substitute_price.valid_until>$4::timestamptz)
                      )
                      OR NOT EXISTS (
                        SELECT 1 FROM mbox.recipes substitute_recipe
                        JOIN mbox.recipe_items substitute_item
                          ON substitute_item.tenant_id=substitute_recipe.tenant_id
                         AND substitute_item.store_id=substitute_recipe.store_id
                         AND substitute_item.recipe_id=substitute_recipe.id
                        JOIN mbox.inventory_items substitute_inventory
                          ON substitute_inventory.tenant_id=substitute_item.tenant_id
                         AND substitute_inventory.store_id=substitute_item.store_id
                         AND substitute_inventory.id=substitute_item.inventory_item_id
                         AND substitute_inventory.status='active'
                        WHERE substitute_recipe.tenant_id=product.tenant_id
                          AND substitute_recipe.store_id=product.store_id
                          AND substitute_recipe.product_id=product.id AND substitute_recipe.status='active'
                      ))
                ))
              OR (definition.benefit_kind<>'gift_product' AND rule.inventory_requirement='not_applicable')
            )
        ), candidate_cycles AS (
          SELECT candidate_base.*,cycle.cycle_year,occurrence.starts_on,occurrence.ends_on,
            CASE
              WHEN rule_kind<>'birthday' THEN NULL
              WHEN birthday_month_day='02-29' AND (
                cycle.cycle_year%400=0 OR (cycle.cycle_year%4=0 AND cycle.cycle_year%100<>0)
              ) THEN make_date(cycle.cycle_year,2,29)
              WHEN birthday_month_day='02-29' AND feb29_policy='feb28' THEN make_date(cycle.cycle_year,2,28)
              WHEN birthday_month_day='02-29' AND feb29_policy='mar01' THEN make_date(cycle.cycle_year,3,1)
              WHEN birthday_month_day ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
                AND to_char(to_date(cycle.cycle_year||'-'||birthday_month_day,'YYYY-MM-DD'),'MM-DD')=birthday_month_day
              THEN to_date(cycle.cycle_year||'-'||birthday_month_day,'YYYY-MM-DD')
              ELSE NULL
            END AS birthday_on
          FROM candidate_base
          CROSS JOIN LATERAL generate_series(
            extract(year FROM candidate_base.today_on)::integer-1,
            extract(year FROM candidate_base.today_on)::integer+1
          ) AS cycle(cycle_year)
          LEFT JOIN mbox.loyalty_annual_benefit_occurrences occurrence
            ON occurrence.tenant_id=candidate_base.tenant_id AND occurrence.store_id=candidate_base.store_id
           AND occurrence.rule_id=candidate_base.rule_id AND occurrence.cycle_year=cycle.cycle_year
        ), candidate_events AS (
          SELECT candidate_cycles.*,
            CASE WHEN rule_kind='festival' THEN starts_on ELSE birthday_on END AS event_on,
            CASE WHEN rule_kind='festival' THEN starts_on-window_before_days ELSE birthday_on-window_before_days END AS window_starts_on,
            CASE WHEN rule_kind='festival' THEN ends_on+window_after_days ELSE birthday_on+window_after_days END AS window_ends_on
          FROM candidate_cycles
        ), eligible_events AS (
          SELECT * FROM candidate_events
          WHERE event_on IS NOT NULL
            AND (rule_kind<>'birthday' OR consent_status='granted')
            AND (coverage_ends_at IS NULL OR
              ((window_ends_on+1)::timestamp AT TIME ZONE timezone)<=coverage_ends_at)
            AND (current_tier=eligible_tier OR (
              inherit_to_higher_tiers AND (current_tier,eligible_tier) IN (
                ('silver','member'),('gold','member'),('gold','silver')
              )
            ))
        )
        SELECT membership_id,customer_id,current_tier,timezone,policy_id,rule_id,rule_kind,eligible_tier,
          inherit_to_higher_tiers,benefit_definition_id,benefit_code,benefit_kind,display_snapshot,
          product_id,product_price_amount_minor,product_price_currency,quantity,validity_days,
          window_before_days,window_after_days,stack_group,priority,inventory_requirement,revocation_policy,
          feb29_policy,substitute_product_ids,birthday_month_day,consent_status,
          starts_on::text,ends_on::text,today_on::text,event_on::text,
          window_starts_on::text,window_ends_on::text,
          ((window_ends_on+1)::timestamp AT TIME ZONE timezone)::text AS window_end_exclusive,
          coverage_ends_at::text AS tier_coverage_ends_at
        FROM eligible_events candidate
        WHERE NOT (candidate.rule_id=ANY($5::uuid[]))
          AND today_on BETWEEN window_starts_on AND window_ends_on
          AND NOT EXISTS (
            SELECT 1 FROM eligible_events higher_priority
            WHERE higher_priority.membership_id=candidate.membership_id
              AND NOT (higher_priority.rule_id=ANY($5::uuid[]))
              AND higher_priority.stack_group=candidate.stack_group
              AND higher_priority.priority<candidate.priority
              AND daterange(higher_priority.window_starts_on,higher_priority.window_ends_on,'[]')
                && daterange(candidate.window_starts_on,candidate.window_ends_on,'[]')
          )
          AND NOT EXISTS (
            SELECT 1 FROM mbox.membership_annual_benefit_grants grant_row
            WHERE grant_row.tenant_id=$1::uuid AND grant_row.store_id=$2::uuid
              AND grant_row.membership_id=candidate.membership_id
              AND ((grant_row.rule_id=candidate.rule_id AND grant_row.cycle_key=candidate.event_on::text)
                OR (grant_row.status IN ('active','fulfilled','expired')
                  AND grant_row.stack_group=candidate.stack_group
                  AND daterange(grant_row.window_starts_on,grant_row.window_ends_on,'[]')
                    && daterange(candidate.window_starts_on,candidate.window_ends_on,'[]')))
          )
        ORDER BY joined_at,membership_id,priority,rule_code,event_on
        LIMIT $3
      `, [scope.tenantId, scope.storeId, batchSize, evaluatedAt, blockedRules.map((rule)=>rule.ruleId)])
      let grantedBenefits = 0
      for (const candidate of candidates.rows) {
        // 发布后的商品、价格、成本或配方可能在窗口内发生漂移。该规则已进入
        // execution-blocked 时必须整条跳过，让异常审计/outbox 能在本事务提交；
        // 不能继续调用 grantCandidate 后因缺价格抛错，或发放当前无法履约的权益。
        if (blockedRuleIds.has(candidate.rule_id)) continue
        const cycleKey = candidate.event_on
        if (await grantCandidate(transaction, candidate, cycleKey, evaluatedAt)) grantedBenefits += 1
      }
      if (grantedBenefits > 0) await transaction.query(`
        INSERT INTO mbox.audit_events(tenant_id,store_id,actor_type,actor_ref,action,object_type,object_id,business_date,metadata)
        SELECT $1::uuid,$2::uuid,'system',$3,'loyalty.annual-benefits.granted','loyalty_annual_benefit_grant_batch',$3,
          (($4::timestamptz AT TIME ZONE store.timezone)-make_interval(secs=>extract(epoch FROM store.business_day_cutoff)))::date,
          jsonb_build_object('candidates',$5::integer,'grantedBenefits',$6::integer,'evaluatedAt',$4::timestamptz)
        FROM mbox.stores store WHERE store.tenant_id=$1::uuid AND store.id=$2::uuid
      `, [scope.tenantId, scope.storeId, workerId, evaluatedAt, candidates.rows.length, grantedBenefits])
      if (blockedRules.length > 0) await recordExecutionBlockedRules(transaction, workerId, evaluatedAt, blockedRules)
      return {
        workerId, evaluatedAt, candidates: candidates.rows.length, grantedBenefits,
        executionBlockedRules: blockedRules.length,
      }
    })
  }
}

interface ExecutionBlockedRule {
  ruleId: string
  ruleCode: string
}

async function findExecutionBlockedRules(
  transaction: ScopedTransaction,
  evaluatedAt: string,
): Promise<ExecutionBlockedRule[]> {
  const result = await transaction.query<{ rule_id: string; rule_code: string }>(`
    SELECT rule.id AS rule_id,rule.rule_code
    FROM mbox.loyalty_annual_benefit_policy_versions policy
    JOIN mbox.loyalty_annual_benefit_rules rule
      ON rule.tenant_id=policy.tenant_id AND rule.store_id=policy.store_id
     AND rule.policy_version_id=policy.id AND rule.enabled
    JOIN mbox.loyalty_benefit_definitions definition
      ON definition.tenant_id=rule.tenant_id AND definition.store_id=rule.store_id
     AND definition.id=rule.benefit_definition_id
    LEFT JOIN mbox.products primary_product
      ON primary_product.tenant_id=definition.tenant_id AND primary_product.store_id=definition.store_id
     AND primary_product.id=definition.product_id AND primary_product.status='active'
    WHERE policy.tenant_id=$1::uuid AND policy.store_id=$2::uuid
      AND policy.status='published' AND policy.effective_from<=$3::timestamptz
      AND (policy.effective_until IS NULL OR policy.effective_until>$3::timestamptz)
      AND definition.benefit_kind='gift_product'
      AND (definition.status<>'active' OR primary_product.id IS NULL
        OR primary_product.cost_amount_minor IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM mbox.product_prices price
          WHERE price.tenant_id=primary_product.tenant_id AND price.store_id=primary_product.store_id
            AND price.product_id=primary_product.id AND price.price_type='standard'
            AND price.valid_from<=$3::timestamptz
            AND (price.valid_until IS NULL OR price.valid_until>$3::timestamptz)
        ) OR NOT EXISTS (
          SELECT 1 FROM mbox.recipes recipe
          JOIN mbox.recipe_items item
            ON item.tenant_id=recipe.tenant_id AND item.store_id=recipe.store_id AND item.recipe_id=recipe.id
          JOIN mbox.inventory_items inventory
            ON inventory.tenant_id=item.tenant_id AND inventory.store_id=item.store_id
           AND inventory.id=item.inventory_item_id AND inventory.status='active'
          WHERE recipe.tenant_id=primary_product.tenant_id AND recipe.store_id=primary_product.store_id
            AND recipe.product_id=primary_product.id AND recipe.status='active'
        ) OR EXISTS (
          SELECT 1 FROM mbox.loyalty_annual_benefit_rule_substitutes substitute
          LEFT JOIN mbox.products product
            ON product.tenant_id=substitute.tenant_id AND product.store_id=substitute.store_id
           AND product.id=substitute.product_id AND product.status='active'
          WHERE substitute.tenant_id=rule.tenant_id AND substitute.store_id=rule.store_id
            AND substitute.rule_id=rule.id AND (product.id IS NULL OR product.cost_amount_minor IS NULL
              OR NOT EXISTS (
                SELECT 1 FROM mbox.product_prices price
                WHERE price.tenant_id=product.tenant_id AND price.store_id=product.store_id
                  AND price.product_id=product.id AND price.price_type='standard'
                  AND price.valid_from<=$3::timestamptz
                  AND (price.valid_until IS NULL OR price.valid_until>$3::timestamptz)
              ) OR NOT EXISTS (
                SELECT 1 FROM mbox.recipes recipe
                JOIN mbox.recipe_items item
                  ON item.tenant_id=recipe.tenant_id AND item.store_id=recipe.store_id AND item.recipe_id=recipe.id
                JOIN mbox.inventory_items inventory
                  ON inventory.tenant_id=item.tenant_id AND inventory.store_id=item.store_id
                 AND inventory.id=item.inventory_item_id AND inventory.status='active'
                WHERE recipe.tenant_id=product.tenant_id AND recipe.store_id=product.store_id
                  AND recipe.product_id=product.id AND recipe.status='active'
              ))
        ))
    ORDER BY rule.rule_code,rule.id
  `, [transaction.scope.tenantId, transaction.scope.storeId, evaluatedAt])
  return result.rows.map((row) => ({ ruleId: row.rule_id, ruleCode: row.rule_code }))
}

async function recordExecutionBlockedRules(
  transaction: ScopedTransaction,
  workerId: string,
  evaluatedAt: string,
  blockedRules: readonly ExecutionBlockedRule[],
): Promise<void> {
  const ids=blockedRules.map((rule)=>rule.ruleId)
  const codes=blockedRules.map((rule)=>rule.ruleCode)
  await transaction.query(`
    WITH store_context AS (
      SELECT (($4::timestamptz AT TIME ZONE store.timezone)
        -make_interval(secs=>extract(epoch FROM store.business_day_cutoff)))::date AS business_date
      FROM mbox.stores store WHERE store.tenant_id=$1::uuid AND store.id=$2::uuid
    )
    INSERT INTO mbox.audit_events(
      tenant_id,store_id,actor_type,actor_ref,action,object_type,object_id,business_date,metadata
    ) SELECT $1::uuid,$2::uuid,'system',$3,'loyalty.annual-benefits.execution-blocked',
      'loyalty_annual_benefit_grant_batch',$3,store_context.business_date,
      jsonb_build_object('ruleIds',$5::uuid[],'ruleCodes',$6::text[],'evaluatedAt',$4::timestamptz,
        'reason','正式商品的售价、成本、配方或库存物料不可履约')
    FROM store_context
    WHERE NOT EXISTS (
      SELECT 1 FROM mbox.audit_events existing
      WHERE existing.tenant_id=$1::uuid AND existing.store_id=$2::uuid
        AND existing.action='loyalty.annual-benefits.execution-blocked'
        AND existing.business_date=store_context.business_date
        AND existing.metadata->'ruleIds'=to_jsonb($5::uuid[])
    )
  `, [transaction.scope.tenantId, transaction.scope.storeId, workerId, evaluatedAt, ids, codes])
  await transaction.query(`
    INSERT INTO mbox.outbox_messages(
      tenant_id,store_id,message_key,aggregate_type,aggregate_id,aggregate_version,message_type,payload
    ) SELECT $1::uuid,$2::uuid,
      'annual-benefit-execution-blocked:'||blocked.rule_id::text||':'||left($4::text,10),
      'loyalty_annual_benefit_rule',blocked.rule_id,1,'loyalty.annual-benefit.execution-blocked.v1',
      jsonb_build_object('ruleId',blocked.rule_id,'ruleCode',blocked.rule_code,'workerId',$3::text,
        'evaluatedAt',$4::timestamptz,'reason','execution_readiness_failed')
    FROM unnest($5::uuid[],$6::text[]) AS blocked(rule_id,rule_code)
    ON CONFLICT(tenant_id,store_id,message_key) DO NOTHING
  `, [transaction.scope.tenantId, transaction.scope.storeId, workerId, evaluatedAt, ids, codes])
}

async function grantCandidate(transaction: ScopedTransaction, row: CandidateRow, cycleKey: string, evaluatedAt: string): Promise<boolean> {
  const scope = transaction.scope
  await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `loyalty-annual-benefit:${scope.tenantId}:${scope.storeId}:${row.membership_id}:${row.stack_group}`,
  ])
  const prior = await transaction.query<{ id: string }>(`SELECT id FROM mbox.membership_annual_benefit_grants
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND membership_id=$3::uuid
      AND ((rule_id=$4::uuid AND cycle_key=$5)
        OR (status IN ('active','fulfilled','expired') AND stack_group=$6
          AND daterange(window_starts_on,window_ends_on,'[]')
          && daterange($7::date,$8::date,'[]')))
    ORDER BY priority,id LIMIT 1 FOR UPDATE`,
  [scope.tenantId, scope.storeId, row.membership_id, row.rule_id, cycleKey,
    row.stack_group, row.window_starts_on, row.window_ends_on])
  if (prior.rows[0]) return false
  const idempotencyKey = `annual-benefit:${row.policy_id}:${row.rule_id}:${row.membership_id}:${cycleKey}`
  const fingerprint = createHash('sha256').update([
    row.policy_id,row.rule_id,row.membership_id,row.customer_id,cycleKey,row.benefit_definition_id,row.quantity,row.validity_days,
  ].join('|')).digest('hex')
  const value = annualBenefitValue(row)
  const benefit = (await transaction.query<{ id: string; valid_from: string; valid_until: string }>(`
    INSERT INTO mbox.benefits(
      tenant_id,store_id,customer_id,benefit_code,benefit_type,status,value_amount_minor,currency,benefit_snapshot,quantity_total,valid_from,valid_until,
      issuance_reason,authorization_source,issuance_idempotency_key,issuance_fingerprint,benefit_definition_id,benefit_kind
    ) VALUES($1::uuid,$2::uuid,$3::uuid,$4,
      CASE $5 WHEN 'gift_product' THEN 'gift_product' WHEN 'activity_access' THEN 'access' ELSE 'other' END,
      'issued',$6::bigint,$7,$8::jsonb,$9,$10::timestamptz,
      LEAST($10::timestamptz+make_interval(days=>$11),$12::timestamptz),
      '已发布年度会员礼遇自动发放',jsonb_build_object('policyVersionId',$13::uuid,'ruleId',$14::uuid,
        'stackGroup',$15::text,'priority',$16::smallint,'windowStartsOn',$17::date,'windowEndsOn',$18::date,
        'inventoryRequirement',$19::text,'revocationPolicy',$20::text),$21,$22,$23::uuid,$5)
    RETURNING id,valid_from::text,valid_until::text
  `, [scope.tenantId, scope.storeId, row.customer_id, row.benefit_code, row.benefit_kind,
    value.amountMinor, value.currency, JSON.stringify(row.display_snapshot), row.quantity, evaluatedAt, row.validity_days,
    row.window_end_exclusive, row.policy_id, row.rule_id, row.stack_group, row.priority,
    row.window_starts_on, row.window_ends_on, row.inventory_requirement, row.revocation_policy,
    idempotencyKey, fingerprint, row.benefit_definition_id])).rows[0]
  if (!benefit) throw new Error('Annual benefit was not issued')
  const allowedProductIds = [...new Set([row.product_id, ...row.substitute_product_ids].filter((value): value is string => value !== null))]
  if (allowedProductIds.length > 0) await transaction.query(`INSERT INTO mbox.benefit_allowed_products(tenant_id,store_id,benefit_id,product_id)
    SELECT $1::uuid,$2::uuid,$3::uuid,product_id FROM unnest($4::uuid[]) product_id
    ON CONFLICT DO NOTHING`, [scope.tenantId, scope.storeId, benefit.id, allowedProductIds])
  const grant = await transaction.query(`INSERT INTO mbox.membership_annual_benefit_grants(
    tenant_id,store_id,membership_id,customer_id,policy_version_id,rule_id,cycle_key,benefit_id,status,granted_at,expires_at,
    stack_group,priority,window_starts_on,window_ends_on
  ) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,$8::uuid,'active',$9::timestamptz,$10::timestamptz,
    $11,$12,$13::date,$14::date)`,
  [scope.tenantId, scope.storeId, row.membership_id, row.customer_id, row.policy_id, row.rule_id, cycleKey,
    benefit.id, benefit.valid_from, benefit.valid_until,row.stack_group,row.priority,row.window_starts_on,row.window_ends_on])
  if (grant.rowCount !== 1) throw new Error('Annual benefit grant was not inserted')
  return true
}

function annualBenefitValue(row: CandidateRow): { amountMinor: number | null; currency: string | null } {
  if (row.benefit_kind !== 'gift_product') return { amountMinor: null, currency: null }
  const unit = Number(row.product_price_amount_minor)
  if (!Number.isSafeInteger(unit) || unit < 0 || row.product_price_currency === null
    || !/^[A-Z]{3}$/.test(row.product_price_currency) || !Number.isSafeInteger(unit * row.quantity)) {
    throw new Error('Annual gift benefit has no valid current standard price')
  }
  return { amountMinor: unit * row.quantity, currency: row.product_price_currency }
}
