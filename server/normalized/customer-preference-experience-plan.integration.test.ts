import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { CustomerExperienceRepository } from './customer-experience-repository.js'
import { CustomerPreferenceRepository } from './customer-preference-repository.js'
import { ExperiencePlanActivationRepository } from './experience-plan-activation-repository.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const integration=databaseUrl?describe:describe.skip
const id={
  tenant:randomUUID(),store:randomUUID(),otherStore:randomUUID(),canonical:randomUUID(),merged:randomUUID(),
  area:randomUUID(),tableTabTable:randomUUID(),paymentTable:randomUUID(),
  tableTabSession:randomUUID(),paymentSession:randomUUID(),product:randomUUID(),policy:randomUUID(),
  policyDrafter:randomUUID(),policyApprover:randomUUID(),policyPublisher:randomUUID(),
  tableTabRecommendation:randomUUID(),paymentRecommendation:randomUUID(),
  tableTabOption:randomUUID(),paymentOption:randomUUID(),tableTabOrder:randomUUID(),paymentOrder:randomUUID(),
  tableTabItem:randomUUID(),paymentItem:randomUUID(),payment:randomUUID(),
}
const suffix=id.tenant.replaceAll('-','').slice(0,12)

integration('canonical preference and experience plan activation PostgreSQL authority',()=>{
  let pool:Pool
  let runner:ScopedPostgresTransactionRunner
  beforeAll(async()=>{
    await runNormalizedMigrations(databaseUrl!)
    pool=new Pool({connectionString:databaseUrl,max:8})
    runner=new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    await seed(pool)
  })
  afterAll(async()=>pool?.end())

  it('aggregates only explicit canonical-family evidence with decay, contrary evidence and withdrawal',async()=>{
    const support=await run((transaction)=>new CustomerPreferenceRepository(transaction).declare({
      publicId:'preference-wine-support-explicit',customerId:id.merged,key:'beverage.family',value:'wine',
      polarity:'supports',validUntil:'2027-08-16T00:00:00.000Z',idempotencyKey:'preference-wine-support-001',
    }))
    expect(support.canonicalCustomerId).toBe(id.canonical)
    expect(support.facts).toContainEqual(expect.objectContaining({key:'beverage.family',value:'wine',status:'active'}))

    const contrary=await run((transaction)=>new CustomerPreferenceRepository(transaction).declare({
      publicId:'preference-wine-contrary-explicit',customerId:id.canonical,key:'beverage.family',value:'wine',
      polarity:'contradicts',validUntil:'2027-08-16T00:00:00.000Z',idempotencyKey:'preference-wine-contrary-002',
    }))
    expect(contrary.facts).toContainEqual(expect.objectContaining({
      key:'beverage.family',value:'wine',status:'suppressed',supportingEvidenceCount:1,contraryEvidenceCount:1,
    }))

    const restored=await run((transaction)=>new CustomerPreferenceRepository(transaction).withdraw({
      publicId:'preference-wine-withdraw-contrary',customerId:id.merged,
      sourcePublicId:'preference-wine-contrary-explicit',reason:'顾客本人确认相反记录不准确',
      idempotencyKey:'preference-wine-withdraw-003',
    }))
    expect(restored.facts).toContainEqual(expect.objectContaining({key:'beverage.family',value:'wine',status:'active'}))
    expect(restored.sources.find((source)=>source.publicId==='preference-wine-contrary-explicit')?.withdrawn).toBe(true)

    const columns=await pool.query<{column_name:string;data_type:string}>(`
      SELECT column_name,data_type FROM information_schema.columns
      WHERE table_schema='mbox' AND table_name='customer_preference_facts'
    `)
    expect(columns.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({column_name:'support_score'}),expect.objectContaining({column_name:'contrary_score'}),
      expect.objectContaining({column_name:'next_recalculation_at'}),
    ]))
  })

  it('creates one active deferred plan concurrently and never creates a plan from selection alone',async()=>{
    const intent=await run((transaction)=>new CustomerExperienceRepository(transaction).createExperiencePlan({
      context:{customerId:id.merged,tableSessionId:id.tableTabSession,businessDate:'2026-08-16',actorRef:'guest-plan-test',partySize:2},
      recommendationPublicId:'recommendation-table-tab-086',selectedProductId:id.product,
      publicId:'experience-intent-only-086',promiseSummary:'按有效订单安排本桌体验',
    }))
    expect(intent).toMatchObject({state:'intent',plan:null})
    expect(Number((await pool.query(`SELECT count(*) FROM mbox.customer_experience_plans WHERE tenant_id=$1 AND store_id=$2`,[id.tenant,id.store])).rows[0].count)).toBe(0)

    const reference=await run((transaction)=>new CustomerExperienceRepository(transaction).recordRecommendationOrdered({
      recommendationPublicId:'recommendation-table-tab-086',selectedProductId:id.product,
      customerId:id.merged,tableSessionId:id.tableTabSession,businessDate:'2026-08-16',
      orderId:id.tableTabOrder,orderPublicId:'order-table-tab-086',actorRef:'guest-order-test',
    }))
    const attempts=await Promise.all([
      run((transaction)=>new ExperiencePlanActivationRepository(transaction).recordOrderedNonCritical({reference,orderId:id.tableTabOrder,actorRef:'guest-order-test'})),
      run((transaction)=>new ExperiencePlanActivationRepository(transaction).recordOrderedNonCritical({reference,orderId:id.tableTabOrder,actorRef:'guest-order-test'})),
    ])
    expect(attempts.map((result)=>result.state)).toEqual(['active','active'])
    const facts=await pool.query(`
      SELECT count(DISTINCT plan.id)::integer AS plans,count(cue.id)::integer AS cues
      FROM mbox.customer_experience_plans plan LEFT JOIN mbox.experience_plan_cues cue
        ON cue.experience_plan_id=plan.id WHERE plan.order_id=$1
    `,[id.tableTabOrder])
    expect(facts.rows[0].plans).toBe(1)
    expect(facts.rows[0].cues).toBeGreaterThan(0)
  })

  it('keeps immediate-payment plans inert through unknown results, activates on authority and cancels on full refund',async()=>{
    const reference=await run((transaction)=>new CustomerExperienceRepository(transaction).recordRecommendationOrdered({
      recommendationPublicId:'recommendation-payment-086',selectedProductId:id.product,
      customerId:id.merged,tableSessionId:id.paymentSession,businessDate:'2026-08-16',
      orderId:id.paymentOrder,orderPublicId:'order-payment-086',actorRef:'guest-payment-order',
    }))
    const planned=await run((transaction)=>new ExperiencePlanActivationRepository(transaction).recordOrderedNonCritical({
      reference,orderId:id.paymentOrder,actorRef:'guest-payment-order',
    }))
    expect(planned).toMatchObject({state:'planned',cueCount:0})
    const unknown=await run((transaction)=>new ExperiencePlanActivationRepository(transaction).activatePaidNonCritical(id.paymentOrder,null))
    expect(unknown.state).toBe('failed')
    expect(await cueCount(id.paymentOrder)).toBe(0)
    await expect(pool.query(`
      INSERT INTO mbox.experience_plan_cues(
        tenant_id,store_id,experience_plan_id,cue_code,sequence_no,trigger_kind,
        action_kind,station,action_payload
      )SELECT tenant_id,store_id,id,'forged.before.payment',99,'manual','service','service','{}'
      FROM mbox.customer_experience_plans WHERE order_id=$1
    `,[id.paymentOrder])).rejects.toThrow(/activated ordered plan/)

    await pool.query(`
      INSERT INTO mbox.payments(
        id,tenant_id,store_id,order_id,public_id,provider,provider_transaction_id,
        method,amount_minor,currency,status,succeeded_at
      )VALUES($1,$2,$3,$4,'experience-payment-086','cash','experience-provider-086',
        'cash',8800,'CNY','succeeded',clock_timestamp())
    `,[id.payment,id.tenant,id.store,id.paymentOrder])
    await pool.query(`UPDATE mbox.orders SET payment_status='paid' WHERE id=$1`,[id.paymentOrder])
    const activated=await run((transaction)=>new ExperiencePlanActivationRepository(transaction)
      .activatePaidNonCritical(id.paymentOrder,id.payment))
    expect(activated.state).toBe('active')
    expect(await cueCount(id.paymentOrder)).toBeGreaterThan(0)

    await pool.query(`UPDATE mbox.payments SET status='refunded' WHERE id=$1`,[id.payment])
    await pool.query(`UPDATE mbox.orders SET payment_status='refunded' WHERE id=$1`,[id.paymentOrder])
    const cancelled=await run((transaction)=>new ExperiencePlanActivationRepository(transaction)
      .cancelAfterFullRefund(id.paymentOrder,id.payment))
    expect(cancelled.state).toBe('cancelled')
    const remaining=await pool.query(`
      SELECT count(*) FILTER(WHERE cue.status IN ('pending','ready'))::integer AS runnable,
        count(*) FILTER(WHERE cue.status='skipped')::integer AS skipped
      FROM mbox.experience_plan_cues cue JOIN mbox.customer_experience_plans plan
        ON plan.id=cue.experience_plan_id WHERE plan.order_id=$1
    `,[id.paymentOrder])
    expect(remaining.rows[0].runnable).toBe(0)
    expect(remaining.rows[0].skipped).toBeGreaterThan(0)
  })

  it('enforces tenant-store RLS on preference and activation evidence',async()=>{
    const own=await runtimeCount(id.store)
    const other=await runtimeCount(id.otherStore)
    expect(own.declarations).toBe(2)
    expect(own.activationEvents).toBeGreaterThan(0)
    expect(other).toEqual({declarations:0,activationEvents:0})
  })

  function run<Result>(operation:(transaction:Parameters<Parameters<ScopedPostgresTransactionRunner['run']>[1]>[0])=>Promise<Result>){
    return runner.run({tenantId:id.tenant,storeId:id.store},operation)
  }
  async function cueCount(orderId:string){
    const result=await pool.query(`SELECT count(*)::integer AS count FROM mbox.experience_plan_cues cue JOIN mbox.customer_experience_plans plan ON plan.id=cue.experience_plan_id WHERE plan.order_id=$1`,[orderId])
    return result.rows[0].count as number
  }
  async function runtimeCount(storeId:string){
    return runner.run({tenantId:id.tenant,storeId},async(transaction)=>{
      await transaction.query('SET LOCAL ROLE mbox_runtime')
      const result=await transaction.query<{declarations:number;activation_events:number}>(`
        SELECT (SELECT count(*) FROM mbox.customer_preference_declarations)::integer AS declarations,
          (SELECT count(*) FROM mbox.experience_plan_activation_events)::integer AS activation_events
      `)
      return {declarations:result.rows[0]!.declarations,activationEvents:result.rows[0]!.activation_events}
    },{readOnly:true})
  }
})

async function seed(pool:Pool){
  await pool.query(`INSERT INTO mbox.tenants(id,code,name)VALUES($1,$2,'Preference Plan Tenant')`,[id.tenant,`preference_plan_${suffix}`])
  await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name)VALUES($1,$3,$4,'Preference Plan Store'),($2,$3,$5,'Other Store')`,[id.store,id.otherStore,id.tenant,`preference_store_${suffix}`,`preference_other_${suffix}`])
  await pool.query(`INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name)VALUES
    ($1,$4,$5,$6,'偏好测试起草人'),($2,$4,$5,$7,'偏好测试审批人'),($3,$4,$5,$8,'偏好测试发布人')`,[
    id.policyDrafter,id.policyApprover,id.policyPublisher,id.tenant,id.store,
    `PREF_D_${suffix}`,`PREF_A_${suffix}`,`PREF_P_${suffix}`,
  ])
  await pool.query(`INSERT INTO mbox.customers(id,tenant_id,store_id,public_id,status)VALUES($1,$2,$3,'preference-canonical-086','active')`,[id.canonical,id.tenant,id.store])
  await pool.query(`INSERT INTO mbox.customers(id,tenant_id,store_id,public_id,status,merged_into_customer_id)VALUES($1,$2,$3,'preference-merged-086','merged',$4)`,[id.merged,id.tenant,id.store,id.canonical])
  await pool.query(`INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type)VALUES($1,$2,$3,'PREF','偏好测试区','indoor')`,[id.area,id.tenant,id.store])
  await pool.query(`INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity)VALUES($1,$3,$4,$5,'PT1','PT1',4),($2,$3,$4,$5,'PT2','PT2',4)`,[id.tableTabTable,id.paymentTable,id.tenant,id.store,id.area])
  await pool.query(`INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status)VALUES($1,$3,$4,$5,'preference-table-tab-session','2026-08-16',2,'open'),($2,$3,$4,$6,'preference-payment-session','2026-08-16',2,'open')`,[id.tableTabSession,id.paymentSession,id.tenant,id.store,id.tableTabTable,id.paymentTable])
  await pool.query(`INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station,product_kind,cost_amount_minor,recommendation_enabled,recommendation_beverage_family,recommendation_scene_tags,recommendation_priority)VALUES($1,$2,$3,'PREF_WINE','偏好红酒套餐','test','none','bundle',3000,true,'wine',ARRAY['friends']::text[],20)`,[id.product,id.tenant,id.store])
  await pool.query(`INSERT INTO mbox.product_prices(tenant_id,store_id,product_id,price_type,amount_minor,currency,valid_from)VALUES($1,$2,$3,'standard',8800,'CNY',clock_timestamp()-interval '1 day')`,[id.tenant,id.store,id.product])
  await pool.query(`INSERT INTO mbox.recommendation_policy_versions(
    id,tenant_id,store_id,public_id,policy_code,version,status,
    created_by_employee_id,approved_by_employee_id,published_by_employee_id,
    approved_at,published_at,effective_from,draft_reason,approval_reason,
    publication_reason,publication_mode,explanation_template
  )VALUES(
    $1,$2,$3,'preference-default-policy-086','DEFAULT',1,'published',
    $4,$5,$6,clock_timestamp(),clock_timestamp(),clock_timestamp()-interval '1 minute',
    '偏好聚合测试规则起草','偏好衰减参数独立复核','第三人发布用于偏好聚合集成测试',
    'separated','偏好聚合测试'
  )`,[id.policy,id.tenant,id.store,id.policyDrafter,id.policyApprover,id.policyPublisher])
  await pool.query(`UPDATE mbox.customer_experience_features SET rollout_state='pilot',reason='仅偏好聚合集成测试开放'
    WHERE tenant_id=$1 AND store_id=$2 AND feature_code='recommendation.engine'`,[id.tenant,id.store])
  await pool.query(`INSERT INTO mbox.recommendation_sessions(id,tenant_id,store_id,public_id,customer_id,table_session_id,business_date,source,party_size,occasion,alcohol_preference,experience_level,service_intensity)VALUES($1,$3,$4,'recommendation-table-tab-086',$5,$6,'2026-08-16','guest_table',2,'friends','undecided','enhanced','balanced'),($2,$3,$4,'recommendation-payment-086',$5,$7,'2026-08-16','guest_table',2,'friends','undecided','enhanced','balanced')`,[id.tableTabRecommendation,id.paymentRecommendation,id.tenant,id.store,id.merged,id.tableTabSession,id.paymentSession])
  await pool.query(`INSERT INTO mbox.recommendation_options(id,tenant_id,store_id,recommendation_session_id,policy_version_id,product_id,rank,tier,amount_minor,cost_amount_minor,currency,total_score,explanation)VALUES($1,$3,$4,$5,$7,$8,1,'enhanced',8800,3000,'CNY',100,'测试推荐'),($2,$3,$4,$6,$7,$8,1,'enhanced',8800,3000,'CNY',100,'测试推荐')`,[id.tableTabOption,id.paymentOption,id.tenant,id.store,id.tableTabRecommendation,id.paymentRecommendation,id.policy,id.product])
  await pool.query(`INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,subtotal_amount_minor,discount_amount_minor,total_amount_minor,currency,created_by_customer_id,submitted_at,settlement_mode,fulfillment_state)VALUES($1,$3,$4,$5,'order-table-tab-086','guest_qr','submitted','unpaid',8800,0,8800,'CNY',$7,clock_timestamp(),'table_tab','active'),($2,$3,$4,$6,'order-payment-086','guest_qr','submitted','unpaid',8800,0,8800,'CNY',$7,clock_timestamp(),'immediate_payment','awaiting_payment')`,[id.tableTabOrder,id.paymentOrder,id.tenant,id.store,id.tableTabSession,id.paymentSession,id.merged])
  await pool.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,discount_amount_minor,total_amount_minor,currency,fulfillment_station,product_snapshot,status,unit_cost_minor_at_submission,total_cost_minor_at_submission,cost_source,cost_reference_product_id,cost_reference_product_updated_at)VALUES($1,$3,$4,$5,$7,1,8800,0,8800,'CNY','none','{}','submitted',3000,3000,'catalog_product',$7,clock_timestamp()),($2,$3,$4,$6,$7,1,8800,0,8800,'CNY','none','{}','submitted',3000,3000,'catalog_product',$7,clock_timestamp())`,[id.tableTabItem,id.paymentItem,id.tenant,id.store,id.tableTabOrder,id.paymentOrder,id.product])
}
