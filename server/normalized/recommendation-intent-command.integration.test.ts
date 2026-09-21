import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {IdempotencyConflictError,NormalizedCommandExecutor} from './command-executor.js'
import {CustomerExperienceService} from './customer-experience-service.js'
import {seedActiveGuestTableAuthority} from './guest-table-authority.test-helper.js'
import {ScopedPostgresTransactionRunner} from './transaction-runner.js'

const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL

// Actual restricted LOGIN and real command transactions. Admin creates only
// base recommendation/guest identity fixtures and reads assertions. Session
// issuance is a persisted fixture, not an HTTP authentication acceptance test.
;(databaseUrl&&runtimeUrl?describe:describe.skip)('recommendation intent command with a real restricted LOGIN',()=>{
  let admin:Pool,runtime:Pool,runner:ScopedPostgresTransactionRunner,service:CustomerExperienceService
  const applicationName=`recommendation-intent-${randomUUID()}`
  beforeAll(async()=>{
    await runNormalizedMigrations(databaseUrl!)
    admin=new Pool({connectionString:databaseUrl,max:4})
    runtime=new Pool({connectionString:runtimeUrl,max:4,application_name:applicationName})
    runner=new ScopedPostgresTransactionRunner(runtime)
    service=new CustomerExperienceService(runner,new NormalizedCommandExecutor(runner),{
      updateProfile:async()=>{throw new Error('Intent must not update the customer profile')},
    })
    expect((await runtime.query(`SELECT current_user=session_user AS direct_login,
      rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication,
      has_table_privilege(current_user,'mbox.recommendation_options','SELECT') AS option_select,
      has_any_column_privilege(current_user,'mbox.recommendation_options','UPDATE') AS option_update
      FROM pg_roles WHERE rolname=current_user`)).rows[0]).toEqual({
      direct_login:true,rolsuper:false,rolbypassrls:false,rolcreatedb:false,
      rolcreaterole:false,rolreplication:false,option_select:true,option_update:false,
    })
  },30000)
  afterAll(async()=>{await runtime?.end();await admin?.end()})

  async function fixture(){
    const id={tenant:randomUUID(),store:randomUUID(),area:randomUUID(),table:randomUUID(),
      session:randomUUID(),customer:randomUUID(),otherCustomer:randomUUID(),
      product:randomUUID(),otherProduct:randomUUID(),policy:randomUUID(),
      drafter:randomUUID(),approver:randomUUID(),publisher:randomUUID(),
      recommendation:randomUUID(),option:randomUUID()}
    const scope={tenantId:id.tenant,storeId:id.store},businessDate='2026-09-21'
    await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Intent fixture')",[id.tenant,`intent-${id.tenant}`])
    await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,'intent','Intent fixture')",[id.store,id.tenant])
    await admin.query(`INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name)
      VALUES($1,$4,$5,'DRAFT','Drafter'),($2,$4,$5,'APPROVE','Approver'),($3,$4,$5,'PUBLISH','Publisher')`,
    [id.drafter,id.approver,id.publisher,id.tenant,id.store])
    await admin.query(`INSERT INTO mbox.customers(id,tenant_id,store_id,public_id)
      VALUES($1,$3,$4,'intent-owner'),($2,$3,$4,'intent-other')`,[id.customer,id.otherCustomer,id.tenant,id.store])
    await admin.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'INTENT','Intent fixture','indoor')",[id.area,id.tenant,id.store])
    await admin.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,'I01','I01',4)",[id.table,id.tenant,id.store,id.area])
    await admin.query(`INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status)
      VALUES($1,$2,$3,$4,'intent-table',$5::date,2,'open')`,[id.session,id.tenant,id.store,id.table,businessDate])
    await admin.query(`INSERT INTO mbox.table_session_customers(tenant_id,store_id,table_session_id,customer_id,relationship)
      VALUES($1,$2,$3,$4,'primary'),($1,$2,$3,$5,'guest')`,[id.tenant,id.store,id.session,id.customer,id.otherCustomer])
    const authority={tenantId:id.tenant,storeId:id.store,tableSessionId:id.session}
    const actorRef=await seedActiveGuestTableAuthority(admin,{...authority,customerId:id.customer})
    const otherActorRef=await seedActiveGuestTableAuthority(admin,{...authority,customerId:id.otherCustomer})
    await admin.query(`INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station,product_kind,cost_amount_minor)
      VALUES($1,$3,$4,'OPTION','Original option','test','none','bundle',3000),
            ($2,$3,$4,'OTHER','Not an option','test','none','bundle',2000)`,[id.product,id.otherProduct,id.tenant,id.store])
    await admin.query(`INSERT INTO mbox.recommendation_policy_versions(
      id,tenant_id,store_id,public_id,policy_code,version,status,
      created_by_employee_id,approved_by_employee_id,published_by_employee_id,
      approved_at,published_at,effective_from,draft_reason,approval_reason,
      publication_reason,publication_mode,explanation_template)
      VALUES($1,$2,$3,'intent-policy','DEFAULT',1,'published',$4,$5,$6,
        clock_timestamp(),clock_timestamp(),clock_timestamp()-interval '1 minute',
        'Test drafting','Independent approval','Third-party publication','separated','Fixture option')`,
    [id.policy,id.tenant,id.store,id.drafter,id.approver,id.publisher])
    const recommendationPublicId=`recommendation-${id.recommendation}`
    await admin.query(`INSERT INTO mbox.recommendation_sessions(id,tenant_id,store_id,public_id,customer_id,
      table_session_id,business_date,source,party_size,occasion,alcohol_preference,experience_level,service_intensity)
      VALUES($1,$2,$3,$4,$5,$6,$7::date,'guest_table',2,'friends','undecided','enhanced','balanced')`,
    [id.recommendation,id.tenant,id.store,recommendationPublicId,id.customer,id.session,businessDate])
    await admin.query(`INSERT INTO mbox.recommendation_options(id,tenant_id,store_id,recommendation_session_id,
      policy_version_id,product_id,rank,tier,amount_minor,cost_amount_minor,currency,total_score,explanation)
      VALUES($1,$2,$3,$4,$5,$6,1,'enhanced',8800,3000,'CNY',100,'Original immutable option')`,
    [id.option,id.tenant,id.store,id.recommendation,id.policy,id.product])
    return {id,scope,otherActorRef,context:{scope,customerId:id.customer,tableSessionId:id.session,
      businessDate,actorRef,partySize:2},input:{recommendationPublicId,selectedProductId:id.product,
      promiseSummary:'本桌选择原推荐套餐，尚未下单付款',idempotencyKey:randomUUID()}}
  }
  type Fixture=Awaited<ReturnType<typeof fixture>>
  async function facts(f:Fixture){
    const [recommendation,options,receipts,audits,outbox,created]=await Promise.all([
      admin.query('SELECT to_jsonb(row) AS fact FROM mbox.recommendation_sessions row WHERE tenant_id=$1 ORDER BY id',[f.id.tenant]),
      admin.query('SELECT to_jsonb(row) AS fact FROM mbox.recommendation_options row WHERE tenant_id=$1 ORDER BY id',[f.id.tenant]),
      admin.query("SELECT to_jsonb(row) AS fact FROM mbox.idempotency_records row WHERE tenant_id=$1 AND operation_scope='customer.experience.intent.select' ORDER BY id",[f.id.tenant]),
      admin.query("SELECT to_jsonb(row) AS fact FROM mbox.audit_events row WHERE tenant_id=$1 AND action='customer.experience.intent.selected' ORDER BY id",[f.id.tenant]),
      admin.query("SELECT to_jsonb(row) AS fact FROM mbox.outbox_messages row WHERE tenant_id=$1 AND message_type='customer.experience.intent.selected.v1' ORDER BY id",[f.id.tenant]),
      admin.query(`SELECT (SELECT count(*)::int FROM mbox.customer_experience_plans WHERE tenant_id=$1) AS plans,
        (SELECT count(*)::int FROM mbox.experience_plan_cues WHERE tenant_id=$1) AS cues,
        (SELECT count(*)::int FROM mbox.orders WHERE tenant_id=$1) AS orders,
        (SELECT count(*)::int FROM mbox.payments WHERE tenant_id=$1) AS payments,
        (SELECT count(*)::int FROM mbox.reconciliation_entries WHERE tenant_id=$1) AS ledger`,[f.id.tenant]),
    ])
    return {recommendation:recommendation.rows,options:options.rows,receipts:receipts.rows,
      audits:audits.rows,outbox:outbox.rows,created:created.rows[0]}
  }
  it('serializes the original key once, binds the original recommendation UUID, and changes no option or fulfillment facts',async()=>{
    const f=await fixture(),before=await facts(f),gate=await admin.connect()
    await gate.query('BEGIN')
    await gate.query('SELECT id FROM mbox.table_sessions WHERE id=$1 FOR UPDATE',[f.id.session])
    const attempts=Promise.allSettled([service.createPlan(f.context,f.input),service.createPlan(f.context,f.input)])
    try{
      const until=Date.now()+2000
      let waiting=0
      while(Date.now()<until){
        waiting=(await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname=current_database() AND application_name=$1 AND wait_event_type='Lock'`,[applicationName])).rows[0].n
        if(waiting===2)break
        await new Promise(resolve=>setTimeout(resolve,10))
      }
      expect(waiting,'both real command backends must reach the concurrent lock chain').toBe(2)
    }finally{await gate.query('ROLLBACK');gate.release()}
    const results=await attempts,after=await facts(f)
    const failure=results.find(result=>result.status==='rejected')
    if(failure?.status==='rejected'){
      // The pre-fix red run reaches the wrong aggregate after the selection
      // UPDATE. Assert complete rollback before propagating the real failure;
      // this test never accepts the old failure as desired behavior.
      expect(after).toEqual(before)
      console.info('INTENT_COMMAND_ATOMIC_ROLLBACK',JSON.stringify({recommendationUnchanged:true,
        optionsUnchanged:true,receipts:after.receipts.length,audits:after.audits.length,
        outbox:after.outbox.length,created:after.created}))
      throw failure.reason
    }
    const completed=results.map(result=>{
      if(result.status!=='fulfilled')throw new Error('Concurrent intent unexpectedly rejected')
      return result.value
    })
    expect(completed.map(result=>result.replayed).sort()).toEqual([false,true])
    expect(completed[0]!.value).toEqual(completed[1]!.value)
    expect(completed[0]!.value).toMatchObject({state:'intent',recommendationPublicId:f.input.recommendationPublicId,
      selectedProduct:{productId:f.id.product,amountMinor:8800,currency:'CNY'},plan:null})
    expect(after.recommendation[0]!.fact).toMatchObject({selected_product_id:f.id.product,
      experience_intent_summary:f.input.promiseSummary,selection_idempotency_key:completed[0]!.value.intentPublicId})
    expect(after.recommendation[0]!.fact.completed_at).not.toBeNull()
    expect(after.options).toEqual(before.options)
    expect(after.receipts).toHaveLength(1);expect(after.receipts[0]!.fact.status).toBe('completed')
    expect(after.audits).toHaveLength(1)
    expect(after.audits[0]!.fact).toMatchObject({object_type:'recommendation_session',object_id:f.id.recommendation,
      actor_type:'guest',actor_ref:f.context.actorRef})
    expect(after.outbox).toHaveLength(1)
    expect(after.outbox[0]!.fact).toMatchObject({aggregate_type:'recommendation_session',aggregate_id:f.id.recommendation,
      payload:{tableSessionId:f.id.session,selectedProductId:f.id.product,planCreated:false}})
    expect(after.created).toEqual({plans:0,cues:0,orders:0,payments:0,ledger:0})
    await expect(service.createPlan(f.context,{...f.input,promiseSummary:'同一原键改承诺'})).rejects.toBeInstanceOf(IdempotencyConflictError)
    await expect(service.createPlan({...f.context,customerId:f.id.otherCustomer,actorRef:f.otherActorRef},f.input)).rejects.toBeInstanceOf(IdempotencyConflictError)
    expect(await facts(f)).toEqual(after)
    expect((await service.createPlan(f.context,f.input)).replayed).toBe(true)
    expect(await facts(f)).toEqual(after)
  })
  it.each(['option','customer','scope','guest'] as const)('rejects the wrong %s without any recommendation, receipt, audit or outbox writes',async(kind)=>{
    const f=await fixture(),foreign=kind==='scope'?await fixture():null
    const context=kind==='customer'?{...f.context,customerId:f.id.otherCustomer,actorRef:f.otherActorRef}
      :kind==='scope'?foreign!.context:kind==='guest'?{...f.context,actorRef:`guest-session:${randomUUID()}`}:f.context
    const input=kind==='option'?{...f.input,selectedProductId:f.id.otherProduct}:f.input
    const before=await facts(f),foreignBefore=foreign?await facts(foreign):null
    await expect(service.createPlan(context,input)).rejects.toMatchObject({code:kind==='option'
      ?'RECOMMENDATION_SELECTION_INVALID':kind==='guest'?'TABLE_CUSTOMER_MISMATCH':'RECOMMENDATION_EXPIRED'})
    expect(await facts(f)).toEqual(before)
    if(foreign)expect(await facts(foreign)).toEqual(foreignBefore)
  })
})
