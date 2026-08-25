import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { LoyaltyAnnualBenefitGrantWorker } from './loyalty-annual-benefit-grant-worker.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const integration=databaseUrl?describe:describe.skip
const evaluatedAt='2026-08-25T12:00:00.000Z'
const ids={
  tenant:randomUUID(),store:randomUUID(),drafter:randomUUID(),approver:randomUUID(),publisher:randomUUID(),
  tierPolicy:randomUUID(),annualPolicy:randomUUID(),rule:randomUUID(),occurrence:randomUUID(),
  healthyPolicy:randomUUID(),product:randomUUID(),recipe:randomUUID(),inventory:randomUUID(),definition:randomUUID(),
  healthyDefinition:randomUUID(),healthyRule:randomUUID(),healthyOccurrence:randomUUID(),
  firstCustomer:randomUUID(),firstMembership:randomUUID(),firstAccount:randomUUID(),firstPeriod:randomUUID(),
  shortCustomer:randomUUID(),shortMembership:randomUUID(),shortAccount:randomUUID(),shortPeriod:randomUUID(),
  nextCustomer:randomUUID(),nextMembership:randomUUID(),nextAccount:randomUUID(),nextPeriod:randomUUID(),
  driftCustomer:randomUUID(),driftMembership:randomUUID(),driftAccount:randomUUID(),driftPeriod:randomUUID(),
} as const

integration('annual benefit grant worker PostgreSQL integrity',()=>{
  let pool:Pool
  let worker:LoyaltyAnnualBenefitGrantWorker

  beforeAll(async()=>{
    await runNormalizedMigrations(databaseUrl!)
    pool=new Pool({connectionString:databaseUrl,max:3})
    worker=new LoyaltyAnnualBenefitGrantWorker(
      new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool),()=>evaluatedAt,
    )
    await seedBase(pool)
    await seedMembership(pool,'first',ids.firstCustomer,ids.firstMembership,ids.firstAccount,ids.firstPeriod,'2026-09-10T00:00:00Z')
    await seedMembership(pool,'short',ids.shortCustomer,ids.shortMembership,ids.shortAccount,ids.shortPeriod,'2026-08-28T00:00:00Z')
  })

  afterAll(async()=>pool?.end())

  it('requires the tier period to cover the complete use window and never reissues a revoked rule cycle',async()=>{
    const first=await worker.runBatch({tenantId:ids.tenant,storeId:ids.store},'annual-grant-first')
    expect(first).toEqual({
      workerId:'annual-grant-first',evaluatedAt,candidates:1,grantedBenefits:1,executionBlockedRules:0,
    })
    const firstGrant=await pool.query<{ id:string }>(`
      SELECT id::text FROM mbox.membership_annual_benefit_grants
      WHERE tenant_id=$1 AND store_id=$2 AND membership_id=$3
    `,[ids.tenant,ids.store,ids.firstMembership])
    expect(firstGrant.rows).toHaveLength(1)
    await pool.query(`UPDATE mbox.membership_annual_benefit_grants SET status='revoked' WHERE id=$1`,[firstGrant.rows[0]?.id])

    await seedMembership(pool,'next',ids.nextCustomer,ids.nextMembership,ids.nextAccount,ids.nextPeriod,'2026-09-10T00:00:00Z')
    const second=await worker.runBatch({tenantId:ids.tenant,storeId:ids.store},'annual-grant-second')
    expect(second).toEqual({
      workerId:'annual-grant-second',evaluatedAt,candidates:1,grantedBenefits:1,executionBlockedRules:0,
    })
    const grants=await pool.query<{ membership_id:string; status:string }>(`
      SELECT membership_id::text,status FROM mbox.membership_annual_benefit_grants
      WHERE tenant_id=$1 AND store_id=$2 ORDER BY membership_id
    `,[ids.tenant,ids.store])
    expect(grants.rows).toEqual(expect.arrayContaining([
      {membership_id:ids.firstMembership,status:'revoked'},
      {membership_id:ids.nextMembership,status:'active'},
    ]))
    expect(grants.rows.some((row)=>row.membership_id===ids.shortMembership)).toBe(false)

    await expect(worker.runBatch({tenantId:ids.tenant,storeId:ids.store},'annual-grant-replay')).resolves.toEqual({
      workerId:'annual-grant-replay',evaluatedAt,candidates:0,grantedBenefits:0,executionBlockedRules:0,
    })
  })

  it('records a visible execution exception instead of silently skipping a published rule after price drift',async()=>{
    await pool.query(`UPDATE mbox.product_prices SET valid_until=$1::timestamptz
      WHERE tenant_id=$2 AND store_id=$3 AND product_id=$4`,[evaluatedAt,ids.tenant,ids.store,ids.product])
    await seedMembership(
      pool,'drift',ids.driftCustomer,ids.driftMembership,ids.driftAccount,ids.driftPeriod,'2026-09-10T00:00:00Z',
    )
    await pool.query(`UPDATE mbox.customer_memberships SET level='gold' WHERE id=$1`,[ids.driftMembership])
    await pool.query(`UPDATE mbox.loyalty_accounts SET current_tier='gold' WHERE id=$1`,[ids.driftAccount])
    await pool.query(`UPDATE mbox.membership_tier_periods SET tier='gold' WHERE id=$1`,[ids.driftPeriod])
    await seedHealthyRule(pool)
    const result=await worker.runBatch({tenantId:ids.tenant,storeId:ids.store},'annual-grant-drift',1)
    expect(result.grantedBenefits).toBe(1)
    expect(result.executionBlockedRules).toBe(1)
    const repeated=await worker.runBatch({tenantId:ids.tenant,storeId:ids.store},'annual-grant-drift-repeated')
    expect(repeated.executionBlockedRules).toBe(1)
    const evidence=await pool.query<{ audits:number; outbox:number }>(`
      SELECT
        (SELECT count(*)::integer FROM mbox.audit_events WHERE tenant_id=$1 AND store_id=$2
          AND action='loyalty.annual-benefits.execution-blocked') AS audits,
        (SELECT count(*)::integer FROM mbox.outbox_messages WHERE tenant_id=$1 AND store_id=$2
          AND message_type='loyalty.annual-benefit.execution-blocked.v1') AS outbox
    `,[ids.tenant,ids.store])
    expect(evidence.rows[0]).toEqual({audits:1,outbox:1})
    const driftGrant=await pool.query(`
      SELECT 1 FROM mbox.membership_annual_benefit_grants
      WHERE tenant_id=$1 AND store_id=$2 AND membership_id=$3
    `,[ids.tenant,ids.store,ids.driftMembership])
    expect(driftGrant.rows).toHaveLength(1)

    await pool.query(`INSERT INTO mbox.product_prices(
      tenant_id,store_id,product_id,price_type,amount_minor,currency,valid_from
    ) VALUES($1,$2,$3,'standard',2800,'CNY',$4::timestamptz)`,[
      ids.tenant,ids.store,ids.product,evaluatedAt,
    ])
    const recovered=await worker.runBatch({tenantId:ids.tenant,storeId:ids.store},'annual-grant-drift-recovered')
    expect(recovered).toMatchObject({grantedBenefits:0,executionBlockedRules:0})
  })
})

async function seedBase(pool:Pool):Promise<void>{
  const suffix=ids.tenant.replaceAll('-','').slice(0,10)
  await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Annual Grant Tenant')`,[ids.tenant,`ag-${suffix}`])
  await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,$3,'Annual Grant Store')`,[ids.store,ids.tenant,`ag-${suffix}`])
  await pool.query(`INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name,status) VALUES
    ($1,$4,$5,$6,'Annual Drafter','active'),($2,$4,$5,$7,'Annual Approver','active'),
    ($3,$4,$5,$8,'Annual Publisher','active')`,[
    ids.drafter,ids.approver,ids.publisher,ids.tenant,ids.store,`AD-${suffix}`,`AA-${suffix}`,`AP-${suffix}`,
  ])
  await pool.query(`INSERT INTO mbox.loyalty_tier_policy_versions(
    id,tenant_id,store_id,version,status,evaluation_window_months,tier_period_months,downgrade_grace_days,
    silver_upgrade_growth,silver_retain_growth,gold_upgrade_growth,gold_retain_growth,
    silver_points_multiplier_numerator,silver_points_multiplier_denominator,
    gold_points_multiplier_numerator,gold_points_multiplier_denominator,effective_from,
    drafted_by_employee_id,approved_by_employee_id,approved_at,published_by_employee_id,published_at,publication_mode,reason
  ) VALUES($1,$2,$3,1,'published',12,12,7,100,80,300,240,1,1,1,1,'2026-01-01T00:00:00Z',
    $4,$5,'2026-01-01T00:00:00Z',$6,'2026-01-02T00:00:00Z','separated','年度发放真实数据库测试')`,[
    ids.tierPolicy,ids.tenant,ids.store,ids.drafter,ids.approver,ids.publisher,
  ])
  await pool.query(`INSERT INTO mbox.products(
    id,tenant_id,store_id,code,name,category_code,fulfillment_station,cost_amount_minor,recommendation_beverage_family
  ) VALUES($1,$2,$3,'ANNUAL-GIFT','年度无酒精赠品','drink','bar',500,'non_alcoholic')`,[ids.product,ids.tenant,ids.store])
  await pool.query(`INSERT INTO mbox.product_prices(tenant_id,store_id,product_id,price_type,amount_minor,currency,valid_from)
    VALUES($1,$2,$3,'standard',2800,'CNY','2026-01-01T00:00:00Z')`,[ids.tenant,ids.store,ids.product])
  await pool.query(`INSERT INTO mbox.inventory_items(id,tenant_id,store_id,sku,name,item_type,base_unit)
    VALUES($1,$2,$3,'ANNUAL-BASE','年度赠品原料','ingredient','ml')`,[ids.inventory,ids.tenant,ids.store])
  await pool.query(`INSERT INTO mbox.recipes(id,tenant_id,store_id,product_id,version,yield_quantity,status,effective_at)
    VALUES($1,$2,$3,$4,1,1,'active','2026-01-01T00:00:00Z')`,[ids.recipe,ids.tenant,ids.store,ids.product])
  await pool.query(`INSERT INTO mbox.recipe_items(tenant_id,store_id,recipe_id,inventory_item_id,quantity)
    VALUES($1,$2,$3,$4,10)`,[ids.tenant,ids.store,ids.recipe,ids.inventory])
  await pool.query(`INSERT INTO mbox.loyalty_benefit_definitions(
    id,tenant_id,store_id,public_id,benefit_code,name,benefit_kind,product_id,validity_days,
    requires_employee_fulfillment,cost_amount_minor,currency,status,display_snapshot
  ) VALUES($1,$2,$3,'annual-definition-public','ANNUAL_FESTIVAL','年度节日礼遇','gift_product',$4,30,true,500,'CNY','active',
    '{"name":"年度节日礼遇"}'::jsonb)`,[ids.definition,ids.tenant,ids.store,ids.product])
  await pool.query(`INSERT INTO mbox.loyalty_annual_benefit_policy_versions(
    id,tenant_id,store_id,policy_code,version,status,timezone,drafted_by_employee_id,reason
  ) VALUES($1,$2,$3,'ANNUAL_TEST',1,'draft','Asia/Shanghai',$4,'年度礼遇发放测试')`,[
    ids.annualPolicy,ids.tenant,ids.store,ids.drafter,
  ])
  await pool.query(`INSERT INTO mbox.loyalty_annual_benefit_rules(
    id,tenant_id,store_id,policy_version_id,rule_code,title,rule_kind,eligible_tier,inherit_to_higher_tiers,
    benefit_definition_id,quantity,validity_days,window_before_days,window_after_days,
    requires_birthday_consent,requires_confirmed_occurrence,on_site_only,requires_table_session,
    member_daily_limit,table_daily_limit,alcohol_handling,stack_group,priority,inventory_requirement,
    revocation_policy,feb29_policy,enabled
  ) VALUES($1,$2,$3,$4,'FESTIVAL_GIFT','节日礼遇','festival','member',true,$5,1,30,0,6,
    false,true,true,true,1,1,'non_alcoholic_only','festival_gift',20,'strict_recipe','cancel_before_redeem',NULL,true)`,[
    ids.rule,ids.tenant,ids.store,ids.annualPolicy,ids.definition,
  ])
  await pool.query(`UPDATE mbox.loyalty_annual_benefit_policy_versions
    SET status='approved',approved_by_employee_id=$1,approved_at='2026-01-02T00:00:00Z'
    WHERE id=$2`,[ids.approver,ids.annualPolicy])
  await pool.query(`UPDATE mbox.loyalty_annual_benefit_policy_versions
    SET status='published',published_by_employee_id=$1,published_at='2026-01-03T00:00:00Z',
      effective_from='2026-01-03T00:00:00Z'
    WHERE id=$2`,[ids.publisher,ids.annualPolicy])
  await pool.query(`INSERT INTO mbox.loyalty_annual_benefit_occurrences(
    id,tenant_id,store_id,rule_id,cycle_year,starts_on,ends_on,confirmed_by_employee_id,confirmation_reference
  ) VALUES($1,$2,$3,$4,2026,'2026-08-25','2026-08-25',$5,'节日日期双人确认')`,[
    ids.occurrence,ids.tenant,ids.store,ids.rule,ids.approver,
  ])
}

async function seedHealthyRule(pool:Pool):Promise<void>{
  await pool.query(`INSERT INTO mbox.loyalty_annual_benefit_policy_versions(
    id,tenant_id,store_id,policy_code,version,status,timezone,drafted_by_employee_id,reason
  ) VALUES($1,$2,$3,'ANNUAL_HEALTHY',1,'draft','Asia/Shanghai',$4,'混合批次健康规则')`,[
    ids.healthyPolicy,ids.tenant,ids.store,ids.drafter,
  ])
  await pool.query(`INSERT INTO mbox.loyalty_benefit_definitions(
    id,tenant_id,store_id,public_id,benefit_code,name,benefit_kind,validity_days,
    requires_employee_fulfillment,cost_amount_minor,currency,status,display_snapshot
  ) VALUES($1,$2,$3,'annual-healthy-public','ANNUAL_HEALTHY','年度服务礼遇','service_experience',30,
    true,0,'CNY','active','{"name":"年度服务礼遇"}'::jsonb)`,[
    ids.healthyDefinition,ids.tenant,ids.store,
  ])
  await pool.query(`INSERT INTO mbox.loyalty_annual_benefit_rules(
    id,tenant_id,store_id,policy_version_id,rule_code,title,rule_kind,eligible_tier,inherit_to_higher_tiers,
    benefit_definition_id,quantity,validity_days,window_before_days,window_after_days,
    requires_birthday_consent,requires_confirmed_occurrence,on_site_only,requires_table_session,
    member_daily_limit,table_daily_limit,alcohol_handling,stack_group,priority,inventory_requirement,
    revocation_policy,feb29_policy,enabled
  ) VALUES($1,$2,$3,$4,'HEALTHY_SERVICE','正常服务礼遇','festival','gold',false,$5,1,30,0,6,
    false,true,true,true,1,1,'not_applicable','festival_gift',30,'not_applicable','expire_only',NULL,true)`,[
    ids.healthyRule,ids.tenant,ids.store,ids.healthyPolicy,ids.healthyDefinition,
  ])
  await pool.query(`UPDATE mbox.loyalty_annual_benefit_policy_versions
    SET status='approved',approved_by_employee_id=$1,approved_at='2026-01-02T00:00:00Z'
    WHERE id=$2`,[ids.approver,ids.healthyPolicy])
  await pool.query(`UPDATE mbox.loyalty_annual_benefit_policy_versions
    SET status='published',published_by_employee_id=$1,published_at='2026-01-03T00:00:00Z',
      effective_from='2026-01-03T00:00:00Z'
    WHERE id=$2`,[ids.publisher,ids.healthyPolicy])
  await pool.query(`INSERT INTO mbox.loyalty_annual_benefit_occurrences(
    id,tenant_id,store_id,rule_id,cycle_year,starts_on,ends_on,confirmed_by_employee_id,confirmation_reference
  ) VALUES($1,$2,$3,$4,2026,'2026-08-25','2026-08-25',$5,'健康规则混合批次测试')`,[
    ids.healthyOccurrence,ids.tenant,ids.store,ids.healthyRule,ids.approver,
  ])
}

async function seedMembership(
  pool:Pool,
  label:string,
  customerId:string,
  membershipId:string,
  accountId:string,
  periodId:string,
  endsAt:string,
):Promise<void>{
  const memberSuffix=membershipId.replaceAll('-','').slice(0,10).toUpperCase()
  await pool.query(`INSERT INTO mbox.customers(id,tenant_id,store_id,public_id,status)
    VALUES($1,$2,$3,$4,'active')`,[customerId,ids.tenant,ids.store,`annual-${label}-${memberSuffix}`])
  await pool.query(`INSERT INTO mbox.customer_memberships(
    id,tenant_id,store_id,customer_id,member_no,level,status,joined_at
  ) VALUES($1,$2,$3,$4,$5,'member','active','2026-01-01T00:00:00Z')`,[
    membershipId,ids.tenant,ids.store,customerId,`MBXAG${memberSuffix}`,
  ])
  await pool.query(`INSERT INTO mbox.loyalty_accounts(id,tenant_id,store_id,membership_id,customer_id,current_tier)
    VALUES($1,$2,$3,$4,$5,'member')`,[accountId,ids.tenant,ids.store,membershipId,customerId])
  await pool.query(`INSERT INTO mbox.membership_tier_periods(
    id,tenant_id,store_id,membership_id,policy_version_id,tier,starts_at,ends_at,status,qualification_growth
  ) VALUES($1,$2,$3,$4,$5,'member','2026-01-01T00:00:00Z',$6::timestamptz,'active',0)`,[
    periodId,ids.tenant,ids.store,membershipId,ids.tierPolicy,endsAt,
  ])
}
