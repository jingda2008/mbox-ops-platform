import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {PaymentCommandService} from './payment-command-service.js'
import {NormalizedPaymentCapabilityAuthorization} from './payment-security-policy.js'
import {NormalizedProviderObservationAuthority} from './provider-verification-observation.js'
import {ItemAfterSalesCommandService} from './item-after-sales-command-service.js'
import {ItemAfterSalesOperatingEffects} from './item-after-sales-operating-effects.js'
import {RecommendationFinancialAttributionRepository} from './recommendation-financial-attribution-repository.js'
import {CustomerExperienceAnalyticsRepository} from './customer-experience-analytics-repository.js'
import {readCheckoutPrintSummary} from './checkout-print-summary.js'

const url=process.env.TEST_NORMALIZED_DATABASE_URL,runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
;(url&&runtimeUrl?describe:describe.skip)('recommendation recollection attribution, restricted LOGIN',()=>{
  let pool:Pool,runtimePool:Pool,runner:ScopedPostgresTransactionRunner,money:PaymentCommandService,afterSales:ItemAfterSalesCommandService,date:string
  const scope={tenantId:randomUUID(),storeId:randomUUID()},area=randomUUID(),product=randomUUID(),requester=randomUUID(),cashier=randomUUID()
  beforeAll(async()=>{
    await runNormalizedMigrations(url!)
    pool=new Pool({connectionString:url,max:8});runtimePool=new Pool({connectionString:runtimeUrl,max:8});runner=new ScopedPostgresTransactionRunner(runtimePool)
    expect((await runtimePool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=session_user')).rows[0]).toEqual({rolsuper:false,rolbypassrls:false})
    const commands=new NormalizedCommandExecutor(runner)
    money=new PaymentCommandService(commands,new NormalizedPaymentCapabilityAuthorization(),new NormalizedProviderObservationAuthority())
    afterSales=new ItemAfterSalesCommandService(commands,new ItemAfterSalesOperatingEffects())
    await pool.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'120 money audit')",[scope.tenantId,`money-${scope.tenantId}`])
    await pool.query("INSERT INTO mbox.stores(id,tenant_id,code,name,timezone,business_day_cutoff) VALUES($1,$2,'money','money audit','Asia/Shanghai','06:00')",[scope.storeId,scope.tenantId])
    date=await runner.run(scope,async tx=>(await tx.query<{date:string}>('SELECT mbox.current_operating_business_date($1,$2)::text AS date',[scope.tenantId,scope.storeId])).rows[0].date)
    await pool.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'A','Audit','indoor')",[area,scope.tenantId,scope.storeId])
    await pool.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station) VALUES($1,$2,$3,'WATER','水','drink','bar')",[product,scope.tenantId,scope.storeId])
    const device=randomUUID()
    await pool.query("INSERT INTO mbox.devices(id,tenant_id,store_id,code,name,device_type,station_code,connectivity_status) VALUES($1,$2,$3,'audit-printer','隔离票据目标','printer','cashier','offline')",[device,scope.tenantId,scope.storeId])
    await pool.query("INSERT INTO mbox.printer_routes(tenant_id,store_id,code,name,station_code,printer_device_id) VALUES($1,$2,'cashier','审计收银','cashier',$3)",[scope.tenantId,scope.storeId,device])
    for(const id of [requester,cashier]){
      await pool.query('INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,$4,$4)',[id,scope.tenantId,scope.storeId,id])
      const role=randomUUID()
      await pool.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,$4,'Audit actor')",[role,scope.tenantId,scope.storeId,`M_${role.replaceAll('-','').toUpperCase()}`])
      await pool.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 minute')",[scope.tenantId,scope.storeId,id,role])
      const codes=id===requester?['refund.request','table.view_all']:['payment.initiate.staff','payment.manual.cash.record','payment.collect.all_tables','refund.request','refund.approve','refund.execute','table.view_all','table.close']
      for(const code of codes){
        const permission=(await pool.query("INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category) VALUES($1,$2,$3,$3,'operations') ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET name=EXCLUDED.name RETURNING id",[scope.tenantId,scope.storeId,code])).rows[0].id
        await pool.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[scope.tenantId,scope.storeId,role,permission])
      }
      if(id===cashier)await pool.query("INSERT INTO mbox.role_approval_limits(tenant_id,store_id,role_id,approval_code,amount_minor,currency) VALUES($1,$2,$3,'refund.approve',100000,'CNY')",[scope.tenantId,scope.storeId,role])
    }
  },30000)
  afterAll(async()=>{await runtimePool?.end();await pool?.end()})
  const metadata=(employeeId=cashier)=>({scope,actor:{type:'employee' as const,employeeId},businessDate:date,idempotencyKey:randomUUID(),requestFingerprint:randomUUID()})
  async function fixture(bundle=false,capturedMinor=4000,existingSession?:string,immediate=false,ineligibleMinor=0,wholeLineReturn=false,withRecommendation=true,orderDaysAgo=0){
    const table=randomUUID(),session=existingSession??randomUUID(),order=randomUUID(),item=randomUUID(),task=randomUUID(),parent=bundle?randomUUID():item
    if(!existingSession){
      await pool.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,$5,$5,8)",[table,scope.tenantId,scope.storeId,area,`T${table.slice(0,8)}`])
      await pool.query('INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1,$2,$3,$4,$5,$6,4)',[session,scope.tenantId,scope.storeId,table,session,date])
    }
    await pool.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,submitted_at,subtotal_amount_minor,total_amount_minor) VALUES($1,$2,$3,$4,$5,'staff_assisted','submitted',clock_timestamp()-make_interval(days=>$6::integer),4000,4000)",[order,scope.tenantId,scope.storeId,session,order,orderDaysAgo])
    if(bundle)await pool.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot) VALUES($1,$2,$3,$4,$5,1,4000,4000,'none','{"name":"40元套餐","inventoryControlMode":"not_managed"}')`,[parent,scope.tenantId,scope.storeId,order,product])
    await pool.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,parent_order_item_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot) VALUES($1,$2,$3,$4,$5,$6,5,$7,$8,'bar','{"name":"水","singlePriceReferenceMinor":800,"inventoryControlMode":"not_managed"}')`,[item,scope.tenantId,scope.storeId,order,product,bundle?parent:null,bundle?0:800,bundle?0:4000])
    await pool.query("INSERT INTO mbox.kds_tasks(id,tenant_id,store_id,order_item_id,station_code,quantity,status) VALUES($1,$2,$3,$4,'bar',5,'pending')",[task,scope.tenantId,scope.storeId,item])
    if(bundle){
      const food=randomUUID()
      await pool.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,parent_order_item_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot) VALUES($1,$2,$3,$4,$5,$6,1,0,0,'kitchen','{"name":"小食","singlePriceReferenceMinor":2000,"inventoryControlMode":"not_managed"}')`,[food,scope.tenantId,scope.storeId,order,product,parent])
      await pool.query("INSERT INTO mbox.kds_tasks(id,tenant_id,store_id,order_item_id,station_code,quantity,status) VALUES($1,$2,$3,$4,'kitchen',1,'pending')",[randomUUID(),scope.tenantId,scope.storeId,food])
    }
    let second: string|undefined
    if(ineligibleMinor||wholeLineReturn){
      await pool.query('UPDATE mbox.order_items SET quantity=4,total_amount_minor=3200 WHERE id=$1',[item])
      await pool.query('UPDATE mbox.kds_tasks SET quantity=4 WHERE id=$1',[task])
      second=randomUUID()
      const secondProduct=randomUUID()
      await pool.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station) VALUES($1,$2,$3,$4,'Second product','drink','bar')",[secondProduct,scope.tenantId,scope.storeId,secondProduct])
      await pool.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot,loyalty_eligible_at_submission,loyalty_eligibility_source) VALUES($1,$2,$3,$4,$5,1,800,800,$7,'{"name":"Second product","inventoryControlMode":"not_managed"}',$6,'catalog_product')`,[second,scope.tenantId,scope.storeId,order,secondProduct,wholeLineReturn,wholeLineReturn?'bar':'none'])
    }
    const member=withRecommendation?await seedMember(order,item,session):{customer:randomUUID(),membership:randomUUID(),account:randomUUID()}
    if(wholeLineReturn){
      await pool.query("INSERT INTO mbox.kds_tasks(id,tenant_id,store_id,order_item_id,station_code,quantity,status) VALUES($1,$2,$3,$4,'bar',1,'pending')",[randomUUID(),scope.tenantId,scope.storeId,second])
      const option=randomUUID()
      await pool.query(`INSERT INTO mbox.recommendation_options(id,tenant_id,store_id,recommendation_session_id,policy_version_id,product_id,rank,tier,amount_minor,cost_amount_minor,currency,total_score,explanation)
        SELECT $1,o.tenant_id,o.store_id,o.recommendation_session_id,o.policy_version_id,i.product_id,2,o.tier,800,0,o.currency,100,'独立8元推荐行'
        FROM mbox.recommendation_options o JOIN mbox.recommendation_behavior_events e ON e.recommendation_option_id=o.id
        JOIN mbox.order_items i ON i.id=$3 WHERE e.order_id=$2 AND e.event_type='ordered'`,[option,order,second])
      await pool.query(`INSERT INTO mbox.recommendation_behavior_events(tenant_id,store_id,recommendation_session_id,recommendation_option_id,customer_id,table_session_id,order_id,order_item_id,event_type,actor_type,actor_ref)
        SELECT tenant_id,store_id,recommendation_session_id,$1,customer_id,table_session_id,order_id,$2,'ordered','guest','synthetic-second-product'
        FROM mbox.recommendation_behavior_events WHERE order_id=$3 AND event_type='ordered'`,[option,second,order])
    }
    if(immediate){await pool.query("UPDATE mbox.orders SET settlement_mode='immediate_payment',fulfillment_state='awaiting_payment',fulfillment_activated_at=NULL,fulfillment_expires_at=clock_timestamp()+interval '10 minutes' WHERE id=$1",[order]);await pool.query('DELETE FROM mbox.kds_tasks WHERE id=$1',[task])}
    const payment=(await money.recordManual({...metadata(),orderId:order,...(capturedMinor===4000?{}:{orderIds:[order],amountMinor:capturedMinor}),publicId:randomUUID(),provider:'cash',method:'cash',evidence:{collectedByEmployeeId:cashier,receiptReference:randomUUID()}})).value
    return {session,order,item,task,parent,payment,second,...member}
  }
  async function stop(f:Awaited<ReturnType<typeof fixture>>,quantity:number){
    const original=(await afterSales.request({scope,employeeId:requester,businessDate:date,orderItemId:f.item,quantity,reason:'顾客要求部分退品',idempotencyKey:randomUUID()})).value
    await afterSales.decide({scope,employeeId:cashier,businessDate:date,caseId:original.caseId,decision:'approved',reason:'核对原价和保留商品后批准',idempotencyKey:randomUUID()})
    for(const refund of original.refunds)await completeRefund(refund.id)
    return original
  }
  async function completeRefund(refundId:string){
    await money.beginRefundExecution({...metadata(),refundId})
    return money.recordManualRefundResult({...metadata(),refundId,succeeded:true,receiptReference:''})
  }
  async function compensate(f:Awaited<ReturnType<typeof fixture>>,amountMinor:number,purpose:'service_compensation'|'price_adjustment'='service_compensation'){
    const refund=(await money.requestRefund({...metadata(requester),paymentId:f.payment.id,publicId:randomUUID(),purpose,reason:'依据实际情况核对原款退款',allocations:[{orderItemId:f.parent,amountMinor}]})).value
    await money.approveRefund({...metadata(),refundId:refund.id,decisionReason:'核对服务问题，同意补偿'})
    await completeRefund(refund.id)
  }
  const authorize=(f:Awaited<ReturnType<typeof fixture>>)=>money.authorizeRecollection({...metadata(),orderId:f.order,reason:'确认仅收取保留商品剩余款项，服务补偿保持有效'})
  const collect=async(f:Awaited<ReturnType<typeof fixture>>,amountMinor?:number,orderIds?:string[])=>{
    const command={...metadata(),orderId:f.order,...(orderIds?{orderIds,amountMinor}:{}),publicId:randomUUID(),provider:'cash' as const,method:'cash' as const,evidence:{collectedByEmployeeId:cashier,receiptReference:randomUUID()}}
    const result=await money.recordManual(command)
    expect((await money.recordManual(command)).replayed).toBe(true)
    return result
  }
  async function seedMember(order:string,item:string,session:string){
    const customer=randomUUID(),membership=randomUUID(),account=randomUUID(),policy=randomUUID(),publisher=randomUUID()
    await pool.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,$4,'Audit publisher')",[publisher,scope.tenantId,scope.storeId,publisher])
    await pool.query("INSERT INTO mbox.customers(id,tenant_id,store_id,public_id,status) VALUES($1::uuid,$2,$3,$1::text,'active')",[customer,scope.tenantId,scope.storeId])
    await pool.query("INSERT INTO mbox.customer_memberships(id,tenant_id,store_id,customer_id,member_no,level,status) VALUES($1,$2,$3,$4,$5,'member','active')",[membership,scope.tenantId,scope.storeId,customer,'MBX'+membership.replaceAll('-','').slice(0,16).toUpperCase()])
    await pool.query('INSERT INTO mbox.loyalty_accounts(id,tenant_id,store_id,membership_id,customer_id) VALUES($1,$2,$3,$4,$5)',[account,scope.tenantId,scope.storeId,membership,customer])
    await pool.query(`INSERT INTO mbox.loyalty_policy_versions(id,tenant_id,store_id,policy_code,version,status,points_numerator,points_denominator_minor,growth_numerator,growth_denominator_minor,rounding_mode,points_validity_months,effective_from,drafted_by_employee_id,approved_by_employee_id,approved_at,published_by_employee_id,published_at,publication_mode,reason)
      VALUES($1,$2,$3,$7,1,'published',1,100,1,100,'floor',18,'2026-08-01',$4,$5,'2026-08-01',$6,'2026-08-01','separated','既有一元一积分成长规则')`,[policy,scope.tenantId,scope.storeId,requester,cashier,publisher,'P'+policy.replaceAll('-','').toUpperCase()])
    await pool.query('UPDATE mbox.orders SET created_by_customer_id=$2,loyalty_policy_version_id=$3,loyalty_points_multiplier_numerator=1,loyalty_points_multiplier_denominator=1 WHERE id=$1',[order,customer,policy])
    await pool.query("UPDATE mbox.order_items SET loyalty_eligible_at_submission=true,loyalty_eligibility_source='catalog_product' WHERE id=$1",[item])
    const recommendation=randomUUID(),option=randomUUID(),recommendPolicy=randomUUID()
    await pool.query("INSERT INTO mbox.recommendation_policy_versions(id,tenant_id,store_id,public_id,policy_code,version,status,created_by_employee_id,draft_reason) VALUES($1::uuid,$2,$3,$1::text,$4,1,'draft',$5,'归属事实隔离夹具')",[recommendPolicy,scope.tenantId,scope.storeId,'R'+recommendPolicy.replaceAll('-','').toUpperCase(),publisher])
    await pool.query("INSERT INTO mbox.recommendation_sessions(id,tenant_id,store_id,public_id,customer_id,table_session_id,business_date,source,party_size,occasion,alcohol_preference,experience_level) VALUES($1::uuid,$2,$3,$1::text,$4,$5,$6,'guest_table',2,'friends','undecided','enhanced')",[recommendation,scope.tenantId,scope.storeId,customer,session,date])
    await pool.query("INSERT INTO mbox.recommendation_options(id,tenant_id,store_id,recommendation_session_id,policy_version_id,product_id,rank,tier,amount_minor,cost_amount_minor,currency,total_score,explanation) VALUES($1,$2,$3,$4,$5,$6,1,'enhanced',4000,0,'CNY',100,'合成推荐事实')",[option,scope.tenantId,scope.storeId,recommendation,recommendPolicy,product])
    await pool.query("INSERT INTO mbox.recommendation_behavior_events(tenant_id,store_id,recommendation_session_id,recommendation_option_id,customer_id,table_session_id,order_id,order_item_id,event_type,actor_type,actor_ref) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ordered','guest','synthetic-guest')",[scope.tenantId,scope.storeId,recommendation,option,customer,session,order,item])
    return {customer,membership,account}
  }

  async function facts(f:Awaited<ReturnType<typeof fixture>>){
    return runner.run(scope,async tx=>({
      summary:await readCheckoutPrintSummary(tx,[f.order]),
      events:(await tx.query<{id:string;event_type:string;attributed_amount_minor:string}>(`SELECT id,event_type,attributed_amount_minor::text FROM mbox.recommendation_behavior_events WHERE order_id=$1 AND event_type IN ('paid','refunded') ORDER BY id`,[f.order])).rows,
      restored:(await tx.query<{refund_id:string;amount_minor:string;order_item_id:string;recollection_payment_id:string}>(`SELECT refund_id,amount_minor::text,order_item_id,recollection_payment_id FROM mbox.order_recollection_item_restorations WHERE order_id=$1 ORDER BY amount_minor`,[f.order])).rows,
    }))
  }
  const restore=(f:Awaited<ReturnType<typeof fixture>>,paymentId:string)=>runner.run(scope,tx=>new RecommendationFinancialAttributionRepository(tx).restoreRecollectedForOrder({orderId:f.order,paymentId,actorRef:'bounded-history-review'}))
  async function fullReport(f:Awaited<ReturnType<typeof fixture>>,daysAgo=0){
    const code=(await pool.query(`SELECT t.code FROM mbox.table_sessions s JOIN mbox.tables t ON t.id=s.table_id WHERE s.id=$1`,[f.session])).rows[0].code
    return runner.run(scope,async tx=>(await new CustomerExperienceAnalyticsRepository(tx).dashboard({
      from:new Date(Date.now()-(daysAgo+1)*86400000).toISOString(),until:new Date(Date.now()-(daysAgo-1)*86400000).toISOString(),
      productId:null,employeeId:null,partySize:null,occasion:null,performancePhase:null,tableCode:code,packageProductId:null,recommendationOutcome:'all',
    })),{readOnly:true})
  }
  const report=async(f:Awaited<ReturnType<typeof fixture>>)=>(await fullReport(f)).recommendation
  it.each(['already-awarded','first-award','batch'] as const)('restores ordinary authorized refund attribution without another sale: %s',async mode=>{
    const f=await fixture(false,mode==='first-award'?1600:4000)
    await compensate(f,mode==='first-award'?800:2000,'price_adjustment')
    const original=await facts(f)
    await authorize(f)
    const paid=await collect(f,undefined,mode==='batch'?[f.order]:undefined)
    const after=await facts(f)
    expect(after.summary).toMatchObject({due:0,net:4000})
    expect(after.restored.map(r=>Number(r.amount_minor))).toEqual([mode==='first-award'?800:2000])
    for(const event of original.events)expect(after.events).toContainEqual(event)
    const replayed=await Promise.all([restore(f,paid.value.id),restore(f,paid.value.id)])
    expect(replayed).toEqual([{recorded:0},{recorded:0}])
    const rows=await report(f)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({paid:1,refunded:1,paidAmountMinor:mode==='first-award'?4800:6000,refundedAmountMinor:mode==='first-award'?800:2000})
    expect(rows[0]!.paidAmountMinor-rows[0]!.refundedAmountMinor).toBe(4000)
  })
  it('does not restore on partial collection or an unresolved online attempt',async()=>{
    const f=await fixture();await compensate(f,2000,'price_adjustment');await authorize(f)
    const partial=await collect(f,1000,[f.order]);expect(await restore(f,partial.value.id)).toEqual({recorded:0})
    await authorize(f)
    const pending=(await money.initiate({...metadata(),orderId:f.order,publicId:randomUUID(),provider:'postar',method:'native_qr',principal:{type:'employee',employeeId:cashier}})).value
    expect(await restore(f,pending.id)).toEqual({recorded:0})
    expect((await facts(f)).restored).toEqual([])
    expect((await facts(f)).summary).toMatchObject({net:3000,due:1000,pending:1000})
  })
  it('binds the final confirmed receipt rather than an earlier partial collection',async()=>{
    const f=await fixture();await compensate(f,2000,'price_adjustment');await authorize(f)
    const partial=await collect(f,1000,[f.order]);await authorize(f);const final=await collect(f)
    const fact=(await facts(f)).restored[0]!
    const validity=await runner.run(scope,async tx=>(await tx.query<{partial:boolean;final:boolean}>(`
      SELECT mbox.order_recollection_item_restoration_valid($1,$2,$3,$4,$5,$6) partial,
        mbox.order_recollection_item_restoration_valid($1,$2,$3,$4,$5,$7) final`,
      [scope.tenantId,scope.storeId,f.order,fact.refund_id,f.item,partial.value.id,final.value.id])).rows[0])
    expect(validity).toEqual({partial:false,final:true})
    expect(fact.recollection_payment_id).toBe(final.value.id)
  })
  it.each(['pending','unconsumed-success'] as const)('does not treat full local receipts as cleared while an online fact is unresolved: %s',async mode=>{
    const f=await fixture();await compensate(f,2000,'price_adjustment');await authorize(f);const paid=await collect(f)
    const original=(await facts(f)).restored[0]!,online=randomUUID()
    await pool.query(`INSERT INTO mbox.payments(id,tenant_id,store_id,order_id,public_id,provider,method,amount_minor,status)
      VALUES($1,$2,$3,$4,$6,'postar','native_qr',1,$5)`,[online,scope.tenantId,scope.storeId,f.order,mode==='pending'?'pending':'closed',randomUUID()])
    if(mode==='unconsumed-success')await pool.query(`INSERT INTO mbox.verified_provider_observations(
      tenant_id,store_id,provider,subject_kind,payment_id,verification_kind,provider_event_id,integration_ref,
      observed_status,provider_transaction_id,reported_amount_minor,reported_currency,evidence_sha256,occurred_at)
      VALUES($1,$2,'postar','payment',$3,'active_query_binding',$4,'isolated-test-authority',
        'payment_succeeded',$5,1,'CNY',$6,clock_timestamp())`,[scope.tenantId,scope.storeId,online,randomUUID(),randomUUID(),'a'.repeat(64)])
    const validity=await runner.run(scope,async tx=>(await tx.query<{settled:boolean;valid:boolean}>(`
      SELECT mbox.order_consumption_settled($1,$2,$3) settled,
        mbox.order_recollection_item_restoration_valid($1,$2,$3,$4,$5,$6) valid`,
      [scope.tenantId,scope.storeId,f.order,original.refund_id,f.item,paid.value.id])).rows[0])
    expect(validity).toEqual({settled:true,valid:false})
    expect((await facts(f)).restored).toEqual([original])
  })
  it('keeps quantity returns and retained service compensation negative',async()=>{
    const f=await fixture();await stop(f,1);await compensate(f,100)
    expect(await restore(f,f.payment.id)).toEqual({recorded:0})
    expect((await facts(f)).restored).toEqual([])
    const rows=await report(f);expect(rows[0]).toMatchObject({paid:1,refunded:2,paidAmountMinor:4000,refundedAmountMinor:900})
  })
  it('does not reuse an old obligation for a later refund and restores each newly authorized refund only once',async()=>{
    const f=await fixture();await compensate(f,2000,'price_adjustment');await authorize(f);const recollected=await collect(f)
    await compensate(f,100,'price_adjustment')
    expect(await restore(f,recollected.value.id)).toEqual({recorded:0})
    expect((await facts(f)).restored).toHaveLength(1)
    let rows=await report(f);expect(rows[0]!.paidAmountMinor-rows[0]!.refundedAmountMinor).toBe(3900)
    await authorize(f);await collect(f)
    expect((await facts(f)).restored.map(r=>Number(r.amount_minor))).toEqual([100,2000])
    rows=await report(f);expect(rows[0]).toMatchObject({paid:1,refunded:2,paidAmountMinor:6100,refundedAmountMinor:2100})
  })
  it('keeps two recommended items and their original refund allocations separate',async()=>{
    const f=await fixture(false,4000,undefined,false,0,true)
    const refund=(await money.requestRefund({...metadata(requester),paymentId:f.payment.id,publicId:randomUUID(),purpose:'price_adjustment',reason:'核对两商品原分摊退款',allocations:[{orderItemId:f.item,amountMinor:1600},{orderItemId:f.second!,amountMinor:400}]})).value
    await money.approveRefund({...metadata(),refundId:refund.id,decisionReason:'异人核准原分摊'});await completeRefund(refund.id)
    await authorize(f);await collect(f)
    expect((await facts(f)).restored).toEqual(expect.arrayContaining([
      expect.objectContaining({order_item_id:f.item,amount_minor:'1600'}),expect.objectContaining({order_item_id:f.second,amount_minor:'400'}),
    ]))
    const rows=await report(f);expect(rows).toHaveLength(2)
    expect(rows.map(r=>r.paidAmountMinor-r.refundedAmountMinor).sort((a,b)=>a-b)).toEqual([800,3200])
    expect(rows.map(r=>r.paid)).toEqual([1,1])
  })
  it('rejects forged amount, item, receipt, foreign scope, and all edits of correction facts',async()=>{
    const f=await fixture();await compensate(f,2000,'price_adjustment');await authorize(f);const paid=await collect(f)
    const source=(await runner.run(scope,tx=>tx.query<Record<string,unknown>>('SELECT * FROM mbox.order_recollection_item_restorations WHERE order_id=$1',[f.order]))).rows[0]!
    async function forged(overrides:Record<string,unknown>){
      const row={...source,...overrides}
      return runner.run(scope,tx=>tx.query(`INSERT INTO mbox.order_recollection_item_restorations(tenant_id,store_id,refund_id,order_id,order_item_id,recollection_payment_id,reconciliation_entry_id,amount_minor,currency,settled_at,ledger_occurred_at,actor_ref) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,['tenant_id','store_id','refund_id','order_id','order_item_id','recollection_payment_id','reconciliation_entry_id','amount_minor','currency','settled_at','ledger_occurred_at','actor_ref'].map(k=>row[k])))
    }
    await expect(forged({amount_minor:2001})).rejects.toMatchObject({code:'23514'})
    await expect(forged({order_item_id:randomUUID()})).rejects.toMatchObject({code:'23514'})
    await expect(forged({recollection_payment_id:f.payment.id})).rejects.toMatchObject({code:'23514'})
    await expect(forged({store_id:randomUUID()})).rejects.toThrow()
    await expect(runner.run(scope,tx=>tx.query('UPDATE mbox.order_recollection_item_restorations SET amount_minor=1 WHERE order_id=$1',[f.order]))).rejects.toMatchObject({code:'42501'})
    await expect(runner.run(scope,tx=>tx.query('DELETE FROM mbox.order_recollection_item_restorations WHERE order_id=$1',[f.order]))).rejects.toMatchObject({code:'42501'})
    expect(await runner.run({tenantId:randomUUID(),storeId:randomUUID()},async tx=>(await tx.query('SELECT * FROM mbox.order_recollection_item_restorations')).rows)).toEqual([])
    await expect(pool.query('UPDATE mbox.order_recollection_item_restorations SET amount_minor=1 WHERE order_id=$1',[f.order])).rejects.toMatchObject({code:'55000'})
    await expect(pool.query('DELETE FROM mbox.order_recollection_item_restorations WHERE order_id=$1',[f.order])).rejects.toMatchObject({code:'55000'})
    expect(await restore(f,paid.value.id)).toEqual({recorded:0})
  })
  it('restores a non-member sale without recommendation events and previews all server-derived amounts',async()=>{
    const f=await fixture(false,4000,undefined,false,0,false,false)
    await compensate(f,2000,'price_adjustment');await authorize(f)
    const before=await runner.run(scope,tx=>new RecommendationFinancialAttributionRepository(tx).previewRecollectedForOrder({orderId:f.order}),{readOnly:true})
    expect(before).toMatchObject({eligible:false,recommendationDeltaMinor:0,blockReasons:['collection_not_settled']})
    const paid=await collect(f)
    const preview=await runner.run(scope,tx=>new RecommendationFinancialAttributionRepository(tx).previewRecollectedForOrder({orderId:f.order}),{readOnly:true})
    expect(preview).toMatchObject({eligible:true,recoveryPaymentId:paid.value.id,recommendationCurrentMinor:0,recommendationDeltaMinor:0})
    expect(preview.items).toEqual([expect.objectContaining({amountMinor:2000,restored:true,recoverable:true})])
    const report=await fullReport(f)
    expect(report.recommendation).toEqual([])
    expect(report.products).toEqual([expect.objectContaining({paidOrderCount:1,soldQuantity:5,paidRevenueMinor:6000,refundedAmountMinor:2000})])
  })
  it('keeps proven restoration preview stable after a later ordinary refund',async()=>{
    const f=await fixture();await compensate(f,2000,'price_adjustment');await authorize(f);await collect(f)
    await compensate(f,100,'price_adjustment')
    const preview=await runner.run(scope,tx=>new RecommendationFinancialAttributionRepository(tx).previewRecollectedForOrder({orderId:f.order}),{readOnly:true})
    expect(preview).toMatchObject({eligible:true,recommendationCurrentMinor:3900,recommendationExpectedMinor:3900,recommendationDeltaMinor:0})
    expect(preview.items.every(item=>item.restored)).toBe(true)
  })

  it.each(['already-awarded','first-award'] as const)('keeps cross-date refunds and recollections in their original order cohort: %s',async mode=>{
    const f=await fixture(false,mode==='already-awarded'?4000:1600,undefined,false,0,false,true,2)
    await compensate(f,mode==='already-awarded'?2000:800,'price_adjustment');await authorize(f);await collect(f)
    const originalPeriod=await fullReport(f,2),refundPeriod=await fullReport(f,0)
    expect(originalPeriod.products.reduce((sum,row)=>sum+row.paidRevenueMinor-row.refundedAmountMinor,0)).toBe(4000)
    expect(originalPeriod.products[0]).toMatchObject({paidOrderCount:1,soldQuantity:5})
    expect(refundPeriod.products).toEqual([])
  })

})
