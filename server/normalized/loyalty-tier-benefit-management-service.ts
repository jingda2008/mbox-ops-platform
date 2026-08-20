import { createHash } from 'node:crypto'
import type { AuditActor, JsonCodec, JsonObject, NormalizedCommandExecutor } from './command-executor.js'
import { CustomerExperienceRequestError } from './customer-experience-repository.js'
import type { ScopedPostgresTransactionRunner, ScopedTransaction, StoreScope } from './transaction-runner.js'

type Tier = 'member' | 'silver' | 'gold'
type RevocationPolicy = 'revoke_unreserved' | 'protect_until_expiry'

export interface TierBenefitStaffContext {
  scope: Readonly<StoreScope>
  employeeId: string
  businessDate: string
}

export interface TierBenefitRuleInput {
  ruleCode: string
  eligibleTier: Tier
  inheritToHigherTiers: boolean
  grantOnEntry: boolean
  grantOnRetention: boolean
  benefitDefinitionId: string
  quantity: number
  validityDays: number
  revocationPolicy: RevocationPolicy
  enabled: boolean
}

type TransactionRunner = Pick<ScopedPostgresTransactionRunner, 'run'>

export class LoyaltyTierBenefitManagementService {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly commands: Pick<NormalizedCommandExecutor, 'execute'>,
  ) {}

  configuration(context: TierBenefitStaffContext) {
    return this.transactions.run(context.scope, async (transaction) => {
      // A scoped transaction owns one PostgreSQL client. Keep these reads
      // sequential: pg rejects overlapping queries on one client in its next
      // major version, and transaction-level concurrency adds no useful
      // parallelism here.
      const policies = await transaction.query<{
          id: string; tier_policy_version_id: string; tier_policy_version: number
          version: number; status: string; effective_from: string | null; effective_until: string | null
          drafted_by_employee_id: string; approved_by_employee_id: string | null; approved_at: string | null
          published_by_employee_id: string | null; published_at: string | null
          publication_mode: string; reason: string
        }>(`
          SELECT policy.id,policy.tier_policy_version_id,tier.version AS tier_policy_version,
            policy.version,policy.status,policy.effective_from::text,policy.effective_until::text,
            policy.drafted_by_employee_id,policy.approved_by_employee_id,policy.approved_at::text,
            policy.published_by_employee_id,policy.published_at::text,policy.publication_mode,policy.reason
          FROM mbox.loyalty_tier_benefit_policy_versions policy
          JOIN mbox.loyalty_tier_policy_versions tier
            ON tier.tenant_id=policy.tenant_id AND tier.store_id=policy.store_id
           AND tier.id=policy.tier_policy_version_id
          WHERE policy.tenant_id=$1::uuid AND policy.store_id=$2::uuid
          ORDER BY tier.version DESC,policy.version DESC,policy.id DESC
        `, [transaction.scope.tenantId, transaction.scope.storeId])
      const rules = await transaction.query<{
          id: string; policy_version_id: string; rule_code: string; eligible_tier: Tier
          inherit_to_higher_tiers: boolean; grant_on_entry: boolean; grant_on_retention: boolean
          benefit_definition_id: string; benefit_name: string; quantity: number; validity_days: number
          revocation_policy: RevocationPolicy; enabled: boolean
        }>(`
          SELECT rule.id,rule.policy_version_id,rule.rule_code,rule.eligible_tier,
            rule.inherit_to_higher_tiers,rule.grant_on_entry,rule.grant_on_retention,
            rule.benefit_definition_id,definition.name AS benefit_name,
            rule.quantity,rule.validity_days,rule.revocation_policy,rule.enabled
          FROM mbox.loyalty_tier_benefit_rules rule
          JOIN mbox.loyalty_benefit_definitions definition
            ON definition.tenant_id=rule.tenant_id AND definition.store_id=rule.store_id
           AND definition.id=rule.benefit_definition_id
          WHERE rule.tenant_id=$1::uuid AND rule.store_id=$2::uuid
          ORDER BY rule.policy_version_id,rule.rule_code,rule.id
        `, [transaction.scope.tenantId, transaction.scope.storeId])
      const definitions = await transaction.query<{
          id: string; benefit_code: string; name: string; benefit_kind: string
          validity_days: number; requires_employee_fulfillment: boolean
          cost_amount_minor: string | number; currency: string; status: string; display_snapshot: unknown
        }>(`
          SELECT id,benefit_code,name,benefit_kind,validity_days,requires_employee_fulfillment,
            cost_amount_minor,currency,status,display_snapshot
          FROM mbox.loyalty_benefit_definitions
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid
          ORDER BY status,name,id
        `, [transaction.scope.tenantId, transaction.scope.storeId])
      const tierPolicies = await transaction.query<{
          id: string; version: number; status: string; effective_from: string | null; effective_until: string | null
        }>(`
          SELECT id,version,status,effective_from::text,effective_until::text
          FROM mbox.loyalty_tier_policy_versions
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND status='published'
          ORDER BY version DESC,id DESC
        `, [transaction.scope.tenantId, transaction.scope.storeId])
      const rulesByPolicy = new Map<string, unknown[]>()
      for (const rule of rules.rows) {
        const target = rulesByPolicy.get(rule.policy_version_id) ?? []
        target.push({
          id: rule.id, ruleCode: rule.rule_code, eligibleTier: rule.eligible_tier,
          inheritToHigherTiers: rule.inherit_to_higher_tiers,
          grantOnEntry: rule.grant_on_entry, grantOnRetention: rule.grant_on_retention,
          benefitDefinitionId: rule.benefit_definition_id, benefitName: rule.benefit_name,
          quantity: rule.quantity, validityDays: rule.validity_days,
          revocationPolicy: rule.revocation_policy, enabled: rule.enabled,
        })
        rulesByPolicy.set(rule.policy_version_id, target)
      }
      return {
        policies: policies.rows.map((row) => ({
          id: row.id, tierPolicyVersionId: row.tier_policy_version_id,
          tierPolicyVersion: row.tier_policy_version, version: row.version, status: row.status,
          effectiveFrom: row.effective_from, effectiveUntil: row.effective_until,
          draftedByEmployeeId: row.drafted_by_employee_id,
          approvedByEmployeeId: row.approved_by_employee_id, approvedAt: row.approved_at,
          publishedByEmployeeId: row.published_by_employee_id, publishedAt: row.published_at,
          publicationMode: row.publication_mode, reason: row.reason,
          rules: rulesByPolicy.get(row.id) ?? [],
        })),
        definitions: definitions.rows.map((row) => ({
          id: row.id, benefitCode: row.benefit_code, name: row.name,
          benefitKind: row.benefit_kind, validityDays: row.validity_days,
          requiresEmployeeFulfillment: row.requires_employee_fulfillment,
          costAmountMinor: Number(row.cost_amount_minor), currency: row.currency,
          status: row.status,
          display: isObject(row.display_snapshot) ? row.display_snapshot : {},
        })),
        tierPolicies: tierPolicies.rows.map((row) => ({
          id: row.id, version: row.version, status: row.status,
          effectiveFrom: row.effective_from, effectiveUntil: row.effective_until,
        })),
      }
    }, { readOnly: true })
  }

  draft(context: TierBenefitStaffContext, input: Readonly<{
    tierPolicyVersionId: string
    reason: string
    rules: readonly Readonly<TierBenefitRuleInput>[]
    idempotencyKey: string
  }>) {
    assertRules(input.rules)
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'loyalty.tier-benefit-policy.draft',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<{ id: string; version: number; status: string; ruleCount: number }>(),
    }, async (transaction) => {
      await transaction.query(`SELECT id FROM mbox.stores WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`, [
        transaction.scope.tenantId, transaction.scope.storeId,
      ])
      const tierPolicy = (await transaction.query<{ id: string }>(`
        SELECT id FROM mbox.loyalty_tier_policy_versions
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='published'
        FOR SHARE
      `, [transaction.scope.tenantId, transaction.scope.storeId, input.tierPolicyVersionId])).rows[0]
      if (!tierPolicy) throw requestError(
        '自动权益只能关联已正式发布的等级规则版本', 'LOYALTY_TIER_BENEFIT_TIER_POLICY_UNAVAILABLE',
      )
      await assertBenefitDefinitions(transaction, input.rules)
      const policy = requiredRow((await transaction.query<{ id: string; version: number; status: string }>(`
        WITH next_version AS (
          SELECT COALESCE(max(version),0)+1 AS version
          FROM mbox.loyalty_tier_benefit_policy_versions
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND tier_policy_version_id=$3::uuid
        )
        INSERT INTO mbox.loyalty_tier_benefit_policy_versions(
          tenant_id,store_id,tier_policy_version_id,version,status,drafted_by_employee_id,reason
        ) SELECT $1::uuid,$2::uuid,$3::uuid,version,'draft',$4::uuid,$5 FROM next_version
        RETURNING id,version,status
      `, [
        transaction.scope.tenantId, transaction.scope.storeId, input.tierPolicyVersionId,
        context.employeeId, input.reason,
      ])).rows[0], 'Tier benefit policy draft')
      for (const rule of input.rules) await insertRule(transaction, policy.id, rule)
      const result = { ...policy, ruleCount: input.rules.length }
      return outcome(result, context, 'loyalty.tier-benefit-policy.drafted', policy.id,
        { version: policy.version, ruleCount: input.rules.length, reason: input.reason })
    })
  }

  approve(context: TierBenefitStaffContext, input: Readonly<{
    policyId: string; reason: string; idempotencyKey: string
  }>) {
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'loyalty.tier-benefit-policy.approve',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<{ id: string; version: number; status: string; ruleCount: number }>(),
    }, async (transaction) => {
      const validation = await validatePolicyRules(transaction, input.policyId)
      const row = (await transaction.query<{ id: string; version: number; status: string }>(`
        UPDATE mbox.loyalty_tier_benefit_policy_versions
        SET status='approved',approved_by_employee_id=$4::uuid,
          approved_at=clock_timestamp(),reason=$5
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
          AND status='draft' AND drafted_by_employee_id<>$4::uuid
        RETURNING id,version,status
      `, [transaction.scope.tenantId, transaction.scope.storeId, input.policyId, context.employeeId, input.reason])).rows[0]
      if (!row) throw requestError(
        '只有他人起草且规则完整的草稿可以审批', 'LOYALTY_TIER_BENEFIT_APPROVAL_DENIED',
      )
      const result = { ...row, ruleCount: validation.ruleCount }
      return outcome(result, context, 'loyalty.tier-benefit-policy.approved', row.id,
        { version: row.version, ruleCount: validation.ruleCount, reason: input.reason })
    })
  }

  publish(context: TierBenefitStaffContext, input: Readonly<{
    policyId: string; effectiveFrom: string; effectiveUntil: string | null
    reason: string; idempotencyKey: string
  }>) {
    assertWindow(input.effectiveFrom, input.effectiveUntil)
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'loyalty.tier-benefit-policy.publish',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<{ id: string; version: number; status: string; ruleCount: number }>(),
    }, async (transaction) => {
      const policy = (await transaction.query<{
        id: string; version: number; status: string; tier_policy_version_id: string
        drafted_by_employee_id: string; approved_by_employee_id: string
      }>(`
        SELECT id,version,status,tier_policy_version_id,drafted_by_employee_id,approved_by_employee_id
        FROM mbox.loyalty_tier_benefit_policy_versions
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid FOR UPDATE
      `, [transaction.scope.tenantId, transaction.scope.storeId, input.policyId])).rows[0]
      if (!policy || policy.status!=='approved') throw requestError(
        '只有已独立审批的等级权益政策可以发布', 'LOYALTY_TIER_BENEFIT_NOT_APPROVED',
      )
      if (context.employeeId===policy.drafted_by_employee_id
        || context.employeeId===policy.approved_by_employee_id) throw requestError(
        '起草人和审批人不能执行正式发布', 'LOYALTY_TIER_BENEFIT_PUBLISHER_NOT_INDEPENDENT',
      )
      const tierPolicy = (await transaction.query<{
        effective_from: string; effective_until: string | null
      }>(`
        SELECT effective_from::text,effective_until::text
        FROM mbox.loyalty_tier_policy_versions
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='published'
        FOR SHARE
      `, [transaction.scope.tenantId, transaction.scope.storeId, policy.tier_policy_version_id])).rows[0]
      if (!tierPolicy) throw requestError(
        '关联等级规则已不可发布', 'LOYALTY_TIER_BENEFIT_TIER_POLICY_UNAVAILABLE',
      )
      assertContainedWindow(input.effectiveFrom, input.effectiveUntil, tierPolicy)
      const validation = await validatePolicyRules(transaction, input.policyId)
      const previous = (await transaction.query<{
        id: string; effective_from: string; effective_until: string | null
      }>(`
        SELECT id,effective_from::text,effective_until::text
        FROM mbox.loyalty_tier_benefit_policy_versions
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND tier_policy_version_id=$3::uuid
          AND status='published'
        ORDER BY effective_from DESC,id DESC LIMIT 1 FOR UPDATE
      `, [transaction.scope.tenantId, transaction.scope.storeId, policy.tier_policy_version_id])).rows[0]
      assertAppend(previous, input.effectiveFrom)
      await transaction.query(
        'SET CONSTRAINTS mbox.loyalty_tier_benefit_policy_no_published_overlap_excl DEFERRED',
      )
      const row = requiredRow((await transaction.query<{ id: string; version: number; status: string }>(`
        UPDATE mbox.loyalty_tier_benefit_policy_versions
        SET status='published',effective_from=$4::timestamptz,effective_until=$5::timestamptz,
          published_by_employee_id=$6::uuid,published_at=clock_timestamp(),
          publication_mode='separated',reason=$7
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='approved'
        RETURNING id,version,status
      `, [
        transaction.scope.tenantId, transaction.scope.storeId, input.policyId,
        input.effectiveFrom, input.effectiveUntil, context.employeeId, input.reason,
      ])).rows[0], 'Tier benefit policy publication')
      if (previous) await transaction.query(`
        UPDATE mbox.loyalty_tier_benefit_policy_versions SET effective_until=$4::timestamptz
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='published'
      `, [transaction.scope.tenantId, transaction.scope.storeId, previous.id, input.effectiveFrom])
      const result = { ...row, ruleCount: validation.ruleCount }
      return outcome(result, context, 'loyalty.tier-benefit-policy.published', row.id,
        { version: row.version, ruleCount: validation.ruleCount,
          effectiveFrom: input.effectiveFrom, reason: input.reason })
    })
  }
}

async function insertRule(transaction: ScopedTransaction, policyId: string, rule: Readonly<TierBenefitRuleInput>) {
  await transaction.query(`
    INSERT INTO mbox.loyalty_tier_benefit_rules(
      tenant_id,store_id,policy_version_id,rule_code,eligible_tier,inherit_to_higher_tiers,
      grant_on_entry,grant_on_retention,benefit_definition_id,quantity,validity_days,
      revocation_policy,enabled
    ) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9::uuid,$10,$11,$12,$13)
  `, [
    transaction.scope.tenantId, transaction.scope.storeId, policyId, rule.ruleCode,
    rule.eligibleTier, rule.inheritToHigherTiers, rule.grantOnEntry, rule.grantOnRetention,
    rule.benefitDefinitionId, rule.quantity, rule.validityDays, rule.revocationPolicy, rule.enabled,
  ])
}

async function assertBenefitDefinitions(transaction: ScopedTransaction, rules: readonly Readonly<TierBenefitRuleInput>[]) {
  const ids = [...new Set(rules.map((rule) => rule.benefitDefinitionId))]
  const result = await transaction.query<{ id: string }>(`
    SELECT id FROM mbox.loyalty_benefit_definitions
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=ANY($3::uuid[]) AND status='active'
    FOR SHARE
  `, [transaction.scope.tenantId, transaction.scope.storeId, ids])
  if (result.rows.length!==ids.length) throw requestError(
    '部分权益定义不存在或未启用', 'LOYALTY_TIER_BENEFIT_DEFINITION_UNAVAILABLE',
  )
}

async function validatePolicyRules(transaction: ScopedTransaction, policyId: string) {
  const row = requiredRow((await transaction.query<{
    rule_count: number; enabled_count: number; invalid_count: number
  }>(`
    SELECT count(rule.id)::integer AS rule_count,
      count(rule.id) FILTER (WHERE rule.enabled)::integer AS enabled_count,
      count(rule.id) FILTER (WHERE rule.enabled AND definition.status<>'active')::integer AS invalid_count
    FROM mbox.loyalty_tier_benefit_rules rule
    JOIN mbox.loyalty_benefit_definitions definition
      ON definition.tenant_id=rule.tenant_id AND definition.store_id=rule.store_id
     AND definition.id=rule.benefit_definition_id
    WHERE rule.tenant_id=$1::uuid AND rule.store_id=$2::uuid AND rule.policy_version_id=$3::uuid
  `, [transaction.scope.tenantId, transaction.scope.storeId, policyId])).rows[0], 'Tier benefit rule validation')
  if (row.rule_count<1 || row.enabled_count<1 || row.invalid_count>0) throw requestError(
    '政策必须包含至少一条启用且引用有效定义的强类型规则', 'LOYALTY_TIER_BENEFIT_RULES_INVALID',
  )
  return { ruleCount: row.rule_count }
}

function assertRules(rules: readonly Readonly<TierBenefitRuleInput>[]) {
  if (rules.length<1 || rules.length>100) throw requestError(
    '等级权益政策必须包含1至100条规则', 'LOYALTY_TIER_BENEFIT_RULES_INVALID',
  )
  if (new Set(rules.map((rule) => rule.ruleCode)).size!==rules.length) throw requestError(
    '等级权益规则代码不能重复', 'LOYALTY_TIER_BENEFIT_RULES_INVALID',
  )
  for (const rule of rules) {
    if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(rule.ruleCode)
      || !['member','silver','gold'].includes(rule.eligibleTier)
      || !['revoke_unreserved','protect_until_expiry'].includes(rule.revocationPolicy)
      || !Number.isSafeInteger(rule.quantity) || rule.quantity<1 || rule.quantity>100
      || !Number.isSafeInteger(rule.validityDays) || rule.validityDays<1 || rule.validityDays>366
      || (!rule.grantOnEntry && !rule.grantOnRetention)) throw requestError(
      '等级权益规则字段不符合强类型约束', 'LOYALTY_TIER_BENEFIT_RULES_INVALID',
    )
  }
}

function assertWindow(from: string, until: string | null) {
  const start = Date.parse(from); const end = until===null ? null : Date.parse(until)
  if (!Number.isFinite(start) || (end!==null && (!Number.isFinite(end) || end<=start))) throw requestError(
    '等级权益生效区间不正确', 'LOYALTY_TIER_BENEFIT_WINDOW_INVALID',
  )
}

function assertContainedWindow(
  from: string,
  until: string | null,
  tier: Readonly<{ effective_from: string; effective_until: string | null }>,
) {
  if (Date.parse(from)<Date.parse(tier.effective_from)
    || (tier.effective_until!==null && (until===null || Date.parse(until)>Date.parse(tier.effective_until)))) {
    throw requestError('等级权益生效区间必须包含在关联等级规则内', 'LOYALTY_TIER_BENEFIT_WINDOW_OUTSIDE_TIER_POLICY')
  }
}

function assertAppend(
  previous: Readonly<{ effective_from: string; effective_until: string | null }> | undefined,
  from: string,
) {
  if (!previous) return
  if (Date.parse(from)<=Date.parse(previous.effective_from)) throw requestError(
    '新版本只能在最后一个已发布版本之后排期', 'LOYALTY_TIER_BENEFIT_RELEASE_ORDER_INVALID',
  )
  if (previous.effective_until!==null && Date.parse(previous.effective_until)<Date.parse(from)) throw requestError(
    '发布会造成等级权益生效空档', 'LOYALTY_TIER_BENEFIT_RELEASE_GAP',
  )
}

function outcome<Result>(
  result: Result,
  context: TierBenefitStaffContext,
  action: string,
  objectId: string,
  afterData: JsonObject,
) {
  const actor: AuditActor = { type: 'employee', employeeId: context.employeeId }
  return {
    result,
    auditEvents: [{ actor, action, objectType: 'loyalty_tier_benefit_policy_version',
      objectId, businessDate: context.businessDate, afterData }],
    outboxMessages: [{
      businessEventKey: `${action}:${objectId}`,
      aggregateType: 'loyalty_tier_benefit_policy_version', aggregateId: objectId,
      aggregateVersion: 1, eventType: `${action}.v1`, payload: afterData,
    }],
  }
}

function requestError(message: string, code: string) {
  return new CustomerExperienceRequestError(message, code, 409)
}

function fingerprint(value: unknown) {
  return createHash('sha256').update(stable(value)).digest('hex')
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (isObject(value)) return `{${Object.keys(value).toSorted().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

function isObject(value: unknown): value is JsonObject {
  return typeof value==='object' && value!==null && !Array.isArray(value)
}

function objectCodec<Value>(): JsonCodec<Value> {
  return {
    encode: (value) => value as unknown as JsonObject,
    decode: (value) => {
      if (!isObject(value)) throw new TypeError('Stored tier benefit result is invalid')
      return value as unknown as Value
    },
  }
}

function requiredRow<Row>(row: Row | undefined, label: string): Row {
  if (!row) throw new Error(`${label} did not return a row`)
  return row
}
