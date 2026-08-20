import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { LoyaltyAccrualRepository } from './loyalty-accrual-repository.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import { CustomerExperienceRequestError } from './customer-experience-repository.js'
import { LoyaltyTierBenefitManagementService } from './loyalty-tier-benefit-management-service.js'
import { LoyaltyTierBenefitRepository } from './loyalty-tier-benefit-repository.js'
import { PostgresMembershipConfigurationDraftRepository } from './membership-configuration-draft-repository.js'
import { MembershipConfigurationDraftService } from './membership-configuration-draft-service.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip
const tierEventAt = new Date(Date.now() + 5 * 60_000).toISOString()
const tierBenefitRedeemedAt = new Date(Date.parse(tierEventAt) + 60_000).toISOString()
const tierBenefitExpirySweepAt = new Date(Date.parse(tierEventAt) + 31 * 24 * 60 * 60_000).toISOString()

const ids = {
  tenant: randomUUID(), store: randomUUID(), drafter: randomUUID(), approver: randomUUID(),
  publisher: randomUUID(),
  tierPolicy: randomUUID(), unpublishedTierPolicy: randomUUID(),
  silverDefinition: randomUUID(), inheritedDefinition: randomUUID(),
  benefitPolicy: randomUUID(), silverRule: randomUUID(), inheritedRule: randomUUID(),
} as const

integration('loyalty tier benefit repository PostgreSQL integration', () => {
  let pool: Pool
  let runner: ScopedPostgresTransactionRunner
  let configuration: MembershipConfigurationDraftService

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 4 })
    runner = new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    configuration = new MembershipConfigurationDraftService(
      new PostgresMembershipConfigurationDraftRepository(runner, { tenantId: ids.tenant, storeId: ids.store }),
    )
    await seed(pool)
    await approveTierBenefit(configuration, ids.benefitPolicy, ids.approver, '独立审批首版等级权益策略')
    await pool.query(`
      UPDATE mbox.loyalty_tier_benefit_policy_versions
      SET status='published',effective_from='2026-08-01T00:00:00Z',
        published_by_employee_id=$2,published_at='2026-08-01T00:01:00Z',publication_mode='separated'
      WHERE id=$1
    `, [ids.benefitPolicy, ids.publisher])
  })

  afterAll(async () => pool?.end())

  it('requires maker-checker publication and at least one active typed rule', async () => {
    const noRulePolicy = randomUUID()
    await pool.query(`
      INSERT INTO mbox.loyalty_tier_benefit_policy_versions(
        id,tenant_id,store_id,tier_policy_version_id,version,status,
        drafted_by_employee_id,reason
      ) VALUES($1,$2,$3,$4,2,'draft',$5,'无规则草稿不能发布')
    `, [noRulePolicy, ids.tenant, ids.store, ids.tierPolicy, ids.drafter])
    await expect(configuration.preview('tier_benefits',noRulePolicy,ids.approver))
      .rejects.toMatchObject({code:'MEMBERSHIP_CONFIGURATION_INVALID'})

    const selfApproved = randomUUID()
    await pool.query(`
      INSERT INTO mbox.loyalty_tier_benefit_policy_versions(
        id,tenant_id,store_id,tier_policy_version_id,version,status,
        drafted_by_employee_id,reason
      ) VALUES($1,$2,$3,$4,3,'draft',$5,'同人起草与审批应被拒绝')
    `, [selfApproved, ids.tenant, ids.store, ids.tierPolicy, ids.drafter])
    await pool.query(`
      INSERT INTO mbox.loyalty_tier_benefit_rules(
        tenant_id,store_id,policy_version_id,rule_code,eligible_tier,
        benefit_definition_id,quantity,validity_days
      ) VALUES($1,$2,$3,'SELF_APPROVAL_RULE','silver',$4,1,30)
    `, [ids.tenant, ids.store, selfApproved, ids.silverDefinition])
    const selfPreview=await configuration.preview('tier_benefits',selfApproved,ids.drafter)
    const selfDraft=await configuration.get('tier_benefits',selfApproved)
    await expect(configuration.approve({domain:'tier_benefits',publicId:selfApproved,
      expectedRevision:selfDraft.revision,approverEmployeeId:ids.drafter,
      reason:'同一贡献者不得审批',impactPreviewPublicId:selfPreview.publicId}))
      .rejects.toMatchObject({code:'MEMBERSHIP_CONFIGURATION_SELF_APPROVAL_DENIED'})
  })

  it('keeps an unpublished tier-benefit policy a strict no-op', async () => {
    const member = await createMember(pool, 'member')
    await pool.query(`UPDATE mbox.loyalty_accounts SET current_tier='silver' WHERE id=$1`, [member.account])
    const eventId = await createTierEvent(pool, member.membership, ids.unpublishedTierPolicy, 'member', 'silver', 'unpublished-policy')
    const result = await scoped((repository) => repository.reconcileTierEvent(eventId))
    expect(result).toEqual({
      granted: 0, revocationPending: 0, reactivated: 0,
      revoked: 0, fulfilled: 0, expired: 0,
    })
    expect(await count(pool, 'mbox.membership_tier_benefit_grants', member.membership)).toBe(0)
  })

  it('provides a three-person operating workflow and keeps the current benefit policy until cut-over', async () => {
    const service = new LoyaltyTierBenefitManagementService(runner, new NormalizedCommandExecutor(runner))
    const context = (employeeId: string) => ({
      scope: { tenantId: ids.tenant, storeId: ids.store }, employeeId, businessDate: '2026-08-16',
    })
    const draft = await service.draft(context(ids.drafter), {
      tierPolicyVersionId: ids.tierPolicy,
      reason: '新增白银会员保级权益版本',
      rules: [{
        ruleCode: 'SILVER_RETENTION', eligibleTier: 'silver', inheritToHigherTiers: false,
        grantOnEntry: false, grantOnRetention: true, benefitDefinitionId: ids.silverDefinition,
        quantity: 1, validityDays: 14, revocationPolicy: 'revoke_unreserved', enabled: true,
      }],
      idempotencyKey: 'tier-benefit-management-draft-0001',
    })
    await expect(service.approve(context(ids.drafter), {
      policyId: draft.value.id, reason: '本人不得审批',
      idempotencyKey: 'tier-benefit-management-self-approve-0001',
    })).rejects.toMatchObject<CustomerExperienceRequestError>({ code: 'LOYALTY_TIER_BENEFIT_APPROVAL_DENIED' })
    const approved = await approveTierBenefit(configuration,draft.value.id,ids.approver,
      '已核对权益定义、数量、有效期和降级处理')
    expect(approved).toMatchObject({ status: 'approved' })
    await expect(service.publish(context(ids.approver), {
      policyId: draft.value.id, effectiveFrom: '2026-09-01T00:00:00Z', effectiveUntil: null,
      reason: '审批人不能发布', idempotencyKey: 'tier-benefit-management-self-publish-0001',
    })).rejects.toMatchObject<CustomerExperienceRequestError>({
      code: 'LOYALTY_TIER_BENEFIT_PUBLISHER_NOT_INDEPENDENT',
    })
    const published = await service.publish(context(ids.publisher), {
      policyId: draft.value.id, effectiveFrom: '2026-09-01T00:00:00Z', effectiveUntil: null,
      reason: '最高授权人员确认排期发布', idempotencyKey: 'tier-benefit-management-publish-0001',
    })
    expect(published.value).toMatchObject({ status: 'published', ruleCount: 1 })
    const policyConfiguration = await service.configuration(context(ids.publisher))
    expect(policyConfiguration.policies.find((policy) => policy.id===draft.value.id)).toMatchObject({
      status: 'published', publishedByEmployeeId: ids.publisher,
      rules: [expect.objectContaining({ ruleCode: 'SILVER_RETENTION', validityDays: 14 })],
    })
    expect(policyConfiguration.policies.find((policy) => policy.id===ids.benefitPolicy)?.effectiveUntil)
      .toBe('2026-09-01 00:00:00+00')
  })

  it('issues exact and inherited entry benefits in the same tier evaluation and replays idempotently', async () => {
    const member = await createMember(pool, 'member')
    await pool.query(`
      INSERT INTO mbox.loyalty_growth_ledger(
        tenant_id,store_id,membership_id,customer_id,entry_type,growth_delta,
        balance_after,source_id,reason,idempotency_key,occurred_at
      ) VALUES($1,$2,$3,$4,'adjust',150,150,'tier-benefit-upgrade',
        '测试成长值达到白银等级','tier-benefit-growth-upgrade',$5::timestamptz)
    `, [ids.tenant, ids.store, member.membership, member.customer, tierEventAt])
    await runner.run({ tenantId: ids.tenant, storeId: ids.store }, async (transaction) => {
      await new LoyaltyAccrualRepository(transaction).evaluateMembershipTier(
        member.membership, tierEventAt, 'tier-benefit-upgrade',
      )
    })
    const grants = await pool.query(`
      SELECT rule.rule_code,grant_row.status,benefit.quantity_total,
        benefit.benefit_definition_id::text,benefit.authorization_source,
        benefit.benefit_snapshot->>'internalOnly' AS leaked_internal
      FROM mbox.membership_tier_benefit_grants grant_row
      JOIN mbox.loyalty_tier_benefit_rules rule ON rule.id=grant_row.rule_id
      JOIN mbox.benefits benefit ON benefit.id=grant_row.benefit_id
      WHERE grant_row.membership_id=$1 ORDER BY rule.rule_code
    `, [member.membership])
    expect(grants.rows).toEqual([
      {
        rule_code: 'MEMBER_INHERITED', status: 'active', quantity_total: 1,
        benefit_definition_id: ids.inheritedDefinition, authorization_source: {}, leaked_internal: null,
      },
      {
        rule_code: 'SILVER_ENTRY', status: 'active', quantity_total: 2,
        benefit_definition_id: ids.silverDefinition, authorization_source: {}, leaked_internal: null,
      },
    ])
    const event = await pool.query<{ id: string }>(`
      SELECT id FROM mbox.membership_tier_events
      WHERE membership_id=$1 AND source_id='tier-benefit-upgrade'
    `, [member.membership])
    await scoped((repository) => repository.reconcileTierEvent(event.rows[0]!.id))
    expect(await count(pool, 'mbox.membership_tier_benefit_grants', member.membership)).toBe(2)
    expect(await count(pool, 'mbox.membership_tier_benefit_events', member.membership)).toBe(2)
  })

  it('revokes only unused downgrade rights and defers reserved rights without deleting fulfilled facts', async () => {
    const unused = await memberWithIssuedSilverBenefits(pool, 'unused')
    const reserved = await memberWithIssuedSilverBenefits(pool, 'reserved')
    const fulfilled = await memberWithIssuedSilverBenefits(pool, 'fulfilled')

    const reservedBenefit = await benefitForRule(pool, reserved.membership, 'SILVER_ENTRY')
    await pool.query(`
      UPDATE mbox.benefits SET status='reserved',quantity_reserved=1 WHERE id=$1
    `, [reservedBenefit])
    const fulfilledBenefit = await benefitForRule(pool, fulfilled.membership, 'SILVER_ENTRY')
    await pool.query(`
      UPDATE mbox.benefits SET status='redeemed',quantity_redeemed=quantity_total,
        redeemed_at=$2::timestamptz WHERE id=$1
    `, [fulfilledBenefit, tierBenefitRedeemedAt])

    await downgrade(pool, unused, 'unused-down')
    await downgrade(pool, reserved, 'reserved-down')
    await downgrade(pool, fulfilled, 'fulfilled-down')

    expect(await grantAndBenefit(pool, unused.membership, 'SILVER_ENTRY'))
      .toMatchObject({ grant_status: 'revoked', benefit_status: 'revoked', quantity_redeemed: 0 })
    expect(await grantAndBenefit(pool, reserved.membership, 'SILVER_ENTRY'))
      .toMatchObject({ grant_status: 'revocation_pending', benefit_status: 'reserved', quantity_reserved: 1 })
    expect(await grantAndBenefit(pool, fulfilled.membership, 'SILVER_ENTRY'))
      .toMatchObject({ grant_status: 'fulfilled', benefit_status: 'redeemed', quantity_redeemed: 2 })

    await pool.query(`
      UPDATE mbox.benefits SET status='issued',quantity_reserved=0 WHERE id=$1
    `, [reservedBenefit])
    expect(await grantAndBenefit(pool, reserved.membership, 'SILVER_ENTRY'))
      .toMatchObject({ grant_status: 'revoked', benefit_status: 'revoked', quantity_reserved: 0 })
    const evidence = await pool.query(`
      SELECT event_type,count(*)::integer AS count
      FROM mbox.membership_tier_benefit_events event_row
      JOIN mbox.membership_tier_benefit_grants grant_row ON grant_row.id=event_row.grant_id
      WHERE grant_row.membership_id=ANY($1::uuid[]) AND event_row.event_type IN ('revocation_pending','revoked','fulfilled')
      GROUP BY event_type ORDER BY event_type
    `, [[unused.membership, reserved.membership, fulfilled.membership]])
    expect(evidence.rows).toEqual([
      { event_type: 'fulfilled', count: 1 },
      { event_type: 'revocation_pending', count: 1 },
      { event_type: 'revoked', count: 2 },
    ])
  })

  it('expires due unreserved tier benefits once and writes an immutable expiry event', async () => {
    const member = await memberWithIssuedSilverBenefits(pool, 'expiry')
    const [first, concurrent] = await Promise.all([
      scoped((repository) => repository.expireDue(tierBenefitExpirySweepAt)),
      scoped((repository) => repository.expireDue(tierBenefitExpirySweepAt)),
    ])
    const replay = await scoped((repository) => repository.expireDue(tierBenefitExpirySweepAt))
    expect(first + concurrent).toBeGreaterThanOrEqual(2)
    expect(replay).toBe(0)
    const expired = await pool.query(`
      SELECT grant_row.status,benefit.status AS benefit_status,event_row.event_type
      FROM mbox.membership_tier_benefit_grants grant_row
      JOIN mbox.benefits benefit ON benefit.id=grant_row.benefit_id
      JOIN mbox.membership_tier_benefit_events event_row ON event_row.grant_id=grant_row.id
      WHERE grant_row.membership_id=$1 AND event_row.event_type='expired'
      ORDER BY grant_row.id
    `, [member.membership])
    expect(expired.rows).toHaveLength(2)
    expect(expired.rows.every((row) => row.status === 'expired'
      && row.benefit_status === 'expired' && row.event_type === 'expired')).toBe(true)
    await expect(pool.query(`
      UPDATE mbox.membership_tier_benefit_events SET reason='tamper' WHERE grant_id=(
        SELECT id FROM mbox.membership_tier_benefit_grants WHERE membership_id=$1 LIMIT 1
      )
    `, [member.membership])).rejects.toThrow(/append-only|immutable|change/i)
  })

  function scoped<T>(operation: (repository: LoyaltyTierBenefitRepository) => Promise<T>): Promise<T> {
    return runner.run({ tenantId: ids.tenant, storeId: ids.store }, (transaction) => (
      operation(new LoyaltyTierBenefitRepository(transaction))
    ))
  }
})

async function approveTierBenefit(
  configuration: MembershipConfigurationDraftService, policyId: string,
  approverEmployeeId: string, reason: string,
) {
  const draft = await configuration.get('tier_benefits', policyId)
  const preview = await configuration.preview('tier_benefits', policyId, approverEmployeeId)
  return configuration.approve({ domain: 'tier_benefits', publicId: policyId,
    expectedRevision: draft.revision, approverEmployeeId, reason,
    impactPreviewPublicId: preview.publicId })
}

interface MemberIds { customer: string; membership: string; account: string }

async function seed(pool: Pool): Promise<void> {
  const suffix = ids.tenant.replaceAll('-', '').slice(0, 10)
  await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Tier Benefit Tenant')`, [ids.tenant, `tb-${suffix}`])
  await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,$3,'Tier Benefit Store')`, [ids.store, ids.tenant, `tb-${suffix}`])
  await pool.query(`
    INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name,status) VALUES
      ($1,$4,$5,$6,'Benefit Drafter','active'),($2,$4,$5,$7,'Benefit Approver','active'),
      ($3,$4,$5,$8,'Benefit Publisher','active')
  `, [ids.drafter, ids.approver, ids.publisher, ids.tenant, ids.store,
    `TBD-${suffix}`, `TBA-${suffix}`, `TBP-${suffix}`])
  await pool.query(`
    INSERT INTO mbox.loyalty_tier_policy_versions(
      id,tenant_id,store_id,version,status,evaluation_window_months,tier_period_months,downgrade_grace_days,
      silver_upgrade_growth,silver_retain_growth,gold_upgrade_growth,gold_retain_growth,
      silver_points_multiplier_numerator,silver_points_multiplier_denominator,
      gold_points_multiplier_numerator,gold_points_multiplier_denominator,
      effective_from,drafted_by_employee_id,approved_by_employee_id,approved_at,
      published_by_employee_id,published_at,publication_mode,reason
    ) VALUES
      ($1,$3,$4,1,'published',12,12,7,100,80,300,240,11,10,12,10,
        '2026-08-01T00:00:00Z',$5,$6,'2026-08-01T00:00:00Z',$7,'2026-08-01T00:01:00Z',
        'separated','已独立审批发布会员等级规则'),
      ($2,$3,$4,2,'draft',12,12,7,120,90,360,280,11,10,12,10,
        NULL,$5,NULL,NULL,NULL,NULL,'separated','未发布等级规则测试')
  `, [ids.tierPolicy, ids.unpublishedTierPolicy, ids.tenant, ids.store,
    ids.drafter, ids.approver, ids.publisher])
  await pool.query(`
    INSERT INTO mbox.loyalty_benefit_definitions(
      id,tenant_id,store_id,public_id,benefit_code,name,benefit_kind,validity_days,
      requires_employee_fulfillment,cost_amount_minor,currency,status,display_snapshot
    ) VALUES
      ($1,$3,$4,$5,'SILVER_ENTRY','白银入级权益','tier_benefit',30,false,0,'CNY','active',
        '{"title":"白银入级权益"}'::jsonb),
      ($2,$3,$4,$6,'MEMBER_INHERITED','会员通用权益','tier_benefit',30,false,0,'CNY','active',
        '{"title":"会员通用权益"}'::jsonb)
  `, [
    ids.silverDefinition, ids.inheritedDefinition, ids.tenant, ids.store,
    `tier-benefit-silver-${suffix}`, `tier-benefit-member-${suffix}`,
  ])
  await pool.query(`
    INSERT INTO mbox.loyalty_tier_benefit_policy_versions(
      id,tenant_id,store_id,tier_policy_version_id,version,status,drafted_by_employee_id,reason
    ) VALUES($1,$2,$3,$4,1,'draft',$5,'会员等级自动权益草稿')
  `, [ids.benefitPolicy, ids.tenant, ids.store, ids.tierPolicy, ids.drafter])
  await pool.query(`
    INSERT INTO mbox.loyalty_tier_benefit_rules(
      id,tenant_id,store_id,policy_version_id,rule_code,eligible_tier,
      inherit_to_higher_tiers,grant_on_entry,grant_on_retention,
      benefit_definition_id,quantity,validity_days,revocation_policy
    ) VALUES
      ($1,$3,$4,$5,'SILVER_ENTRY','silver',false,true,false,$6,2,30,'revoke_unreserved'),
      ($2,$3,$4,$5,'MEMBER_INHERITED','member',true,true,false,$7,1,30,'protect_until_expiry')
  `, [
    ids.silverRule, ids.inheritedRule, ids.tenant, ids.store, ids.benefitPolicy,
    ids.silverDefinition, ids.inheritedDefinition,
  ])
}

async function createMember(pool: Pool, tier: 'member' | 'silver' | 'gold'): Promise<MemberIds> {
  const value = { customer: randomUUID(), membership: randomUUID(), account: randomUUID() }
  const suffix = value.customer.replaceAll('-', '').slice(0, 14)
  await pool.query(`
    INSERT INTO mbox.customers(id,tenant_id,store_id,public_id,status)
    VALUES($1,$2,$3,$4,'active')
  `, [value.customer, ids.tenant, ids.store, `tbc-${suffix}`])
  await pool.query(`
    INSERT INTO mbox.customer_memberships(id,tenant_id,store_id,customer_id,member_no,level,status)
    VALUES($1,$2,$3,$4,$5,$6,'active')
  `, [value.membership, ids.tenant, ids.store, value.customer, `MBXTB${suffix.toUpperCase()}`, tier])
  await pool.query(`
    INSERT INTO mbox.loyalty_accounts(id,tenant_id,store_id,membership_id,customer_id,current_tier)
    VALUES($1,$2,$3,$4,$5,$6)
  `, [value.account, ids.tenant, ids.store, value.membership, value.customer, tier])
  return value
}

async function createTierEvent(
  pool: Pool,
  membershipId: string,
  policyId: string,
  fromTier: 'member' | 'silver' | 'gold',
  toTier: 'member' | 'silver' | 'gold',
  sourceId: string,
): Promise<string> {
  const inserted = await pool.query<{ id: string }>(`
    INSERT INTO mbox.membership_tier_events(
      tenant_id,store_id,membership_id,policy_version_id,event_type,from_tier,to_tier,
      evaluated_growth,reason,source_type,source_id,occurred_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,0,'测试已发布等级权益闭环',
      'approved_correction',$8,$9::timestamptz) RETURNING id
  `, [
    ids.tenant, ids.store, membershipId, policyId,
    fromTier === toTier ? 'retained' : TIER_RANK[toTier] > TIER_RANK[fromTier] ? 'upgraded' : 'downgraded',
    fromTier, toTier, sourceId, tierEventAt,
  ])
  return inserted.rows[0]!.id
}

async function memberWithIssuedSilverBenefits(pool: Pool, source: string): Promise<MemberIds> {
  const member = await createMember(pool, 'silver')
  const eventId = await createTierEvent(pool, member.membership, ids.tierPolicy, 'member', 'silver', source)
  const transaction = new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
  await transaction.run({ tenantId: ids.tenant, storeId: ids.store }, (scope) => (
    new LoyaltyTierBenefitRepository(scope).reconcileTierEvent(eventId)
  ))
  return member
}

async function downgrade(pool: Pool, member: MemberIds, source: string): Promise<void> {
  await pool.query(`UPDATE mbox.loyalty_accounts SET current_tier='member' WHERE id=$1`, [member.account])
  await pool.query(`UPDATE mbox.customer_memberships SET level='member' WHERE id=$1`, [member.membership])
  const eventId = await createTierEvent(pool, member.membership, ids.tierPolicy, 'silver', 'member', source)
  const transaction = new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
  await transaction.run({ tenantId: ids.tenant, storeId: ids.store }, (scope) => (
    new LoyaltyTierBenefitRepository(scope).reconcileTierEvent(eventId)
  ))
}

async function benefitForRule(pool: Pool, membershipId: string, ruleCode: string): Promise<string> {
  const result = await pool.query<{ id: string }>(`
    SELECT benefit.id FROM mbox.membership_tier_benefit_grants grant_row
    JOIN mbox.loyalty_tier_benefit_rules rule ON rule.id=grant_row.rule_id
    JOIN mbox.benefits benefit ON benefit.id=grant_row.benefit_id
    WHERE grant_row.membership_id=$1 AND rule.rule_code=$2
  `, [membershipId, ruleCode])
  return result.rows[0]!.id
}

async function grantAndBenefit(pool: Pool, membershipId: string, ruleCode: string) {
  const result = await pool.query(`
    SELECT grant_row.status AS grant_status,benefit.status AS benefit_status,
      benefit.quantity_reserved,benefit.quantity_redeemed
    FROM mbox.membership_tier_benefit_grants grant_row
    JOIN mbox.loyalty_tier_benefit_rules rule ON rule.id=grant_row.rule_id
    JOIN mbox.benefits benefit ON benefit.id=grant_row.benefit_id
    WHERE grant_row.membership_id=$1 AND rule.rule_code=$2
  `, [membershipId, ruleCode])
  return result.rows[0]
}

async function count(pool: Pool, table: string, membershipId: string): Promise<number> {
  const membershipJoin = table.endsWith('_events')
    ? 'JOIN mbox.membership_tier_benefit_grants grant_row ON grant_row.id=event_row.grant_id WHERE grant_row.membership_id=$1'
    : 'WHERE membership_id=$1'
  const alias = table.endsWith('_events') ? ' event_row' : ''
  const result = await pool.query<{ count: number }>(
    `SELECT count(*)::integer AS count FROM ${table}${alias} ${membershipJoin}`,
    [membershipId],
  )
  return result.rows[0]?.count ?? 0
}

const TIER_RANK = { member: 0, silver: 1, gold: 2 } as const
