import {randomUUID} from 'node:crypto'
import Fastify,{type FastifyInstance} from 'fastify'
import {Pool} from 'pg'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {PaymentCommandService} from './payment-command-service.js'
import {NormalizedPaymentCapabilityAuthorization} from './payment-security-policy.js'
import {NormalizedProviderObservationAuthority} from './provider-verification-observation.js'
import {LoyaltyAccrualRepository} from './loyalty-accrual-repository.js'
import {PaymentRepository} from './payment-repository.js'
import {ReconciliationRepository} from './reconciliation-repository.js'
import {registerOrderFinancialRecoveryRoutes} from './order-financial-recovery-api.js'
import type {OrderFinancialRecoveryPreview} from '../../src/shared/order-financial-recovery.js'
const url=process.env.TEST_NORMALIZED_DATABASE_URL,runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
const loyaltyRights=['reconciliation.view','reconciliation.manage','loyalty.accrual.exception.view','loyalty.accrual.request','loyalty.accrual.approve']
;(url&&runtimeUrl?describe:describe.skip)('order financial recovery API with real restricted LOGIN',()=>{
 let pool:Pool,runtime:Pool,runner:ScopedPostgresTransactionRunner,money:PaymentCommandService,date:string,app:FastifyInstance
 const scope={tenantId:randomUUID(),storeId:randomUUID()},area=randomUUID(),product=randomUUID(),cashier=randomUUID(),requester=randomUUID(),publisher=randomUUID(),financeOnly=randomUUID(),financeReviewer=randomUUID()
 beforeAll(async()=>{
  await runNormalizedMigrations(url!);pool=new Pool({connectionString:url,max:8});runtime=new Pool({connectionString:runtimeUrl,max:8});runner=new ScopedPostgresTransactionRunner(runtime)
  expect((await runtime.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=session_user')).rows[0]).toEqual({rolsuper:false,rolbypassrls:false})
  money=new PaymentCommandService(new NormalizedCommandExecutor(runner),new NormalizedPaymentCapabilityAuthorization(),new NormalizedProviderObservationAuthority())
  await pool.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'recollection fixture')",[scope.tenantId])
  await pool.query("INSERT INTO mbox.stores(id,tenant_id,code,name,timezone,business_day_cutoff) VALUES($1,$2,'restore','restore','Asia/Shanghai','06:00')",[scope.storeId,scope.tenantId])
  date=await runner.run(scope,async tx=>(await tx.query<{date:string}>('SELECT mbox.current_operating_business_date($1,$2)::text date',[scope.tenantId,scope.storeId])).rows[0]!.date)
  await pool.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'A','A','indoor')",[area,scope.tenantId,scope.storeId])
  await pool.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station) VALUES($1,$2,$3,'RESTORE','商品','drink','none')",[product,scope.tenantId,scope.storeId])
  for(const employeeId of [cashier,requester,publisher,financeOnly,financeReviewer]){
   await pool.query('INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,$4,$4)',[employeeId,scope.tenantId,scope.storeId,employeeId])
   const role=randomUUID();await pool.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,$4,'fixture')",[role,scope.tenantId,scope.storeId,'R_'+role.replaceAll('-','').toUpperCase()])
   await pool.query('INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id) VALUES($1,$2,$3,$4)',[scope.tenantId,scope.storeId,employeeId,role])
   for(const code of employeeId===cashier?['payment.initiate.staff','payment.manual.cash.record','payment.collect.all_tables','payment.recollect.authorize','refund.approve','refund.execute',...loyaltyRights]:employeeId===requester?['refund.request',...loyaltyRights]:['reconciliation.view','reconciliation.manage']){
    const permission=(await pool.query("INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category) VALUES($1,$2,$3,$3,'operations') ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET name=EXCLUDED.name RETURNING id",[scope.tenantId,scope.storeId,code])).rows[0].id
    await pool.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[scope.tenantId,scope.storeId,role,permission])
   }
   if(employeeId===cashier)await pool.query("INSERT INTO mbox.role_approval_limits(tenant_id,store_id,role_id,approval_code,amount_minor,currency) VALUES($1,$2,$3,'refund.approve',100000,'CNY')",[scope.tenantId,scope.storeId,role])
  }
  app=Fastify();await app.register(async api=>registerOrderFinancialRecoveryRoutes(api,{transactions:runner,resolveStaffContext:()=>({scope:activeScope,employeeId:actor,businessDate:date})}),{prefix:'/api'})
 },30000)
 afterAll(async()=>{await app?.close();await runtime?.end();await pool?.end()})
 const meta=(employeeId=cashier)=>({scope,actor:{type:'employee' as const,employeeId},businessDate:date,idempotencyKey:randomUUID(),requestFingerprint:randomUUID()})
 async function fixture(withMember=true,denominator=100,captured=4000,withRecommendation=false){
  const table=randomUUID(),session=randomUUID(),order=randomUUID(),item=randomUUID(),customer=randomUUID(),membership=randomUUID(),account=randomUUID(),policy=randomUUID()
  await pool.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,$5,$5,2)",[table,scope.tenantId,scope.storeId,area,'T'+table.slice(0,8)])
  await pool.query('INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1::uuid,$2,$3,$4,$1::text,$5,1)',[session,scope.tenantId,scope.storeId,table,date])
  await pool.query("INSERT INTO mbox.customers(id,tenant_id,store_id,public_id,status) VALUES($1::uuid,$2,$3,$1::text,'active')",[customer,scope.tenantId,scope.storeId])
  if(withMember)await pool.query("INSERT INTO mbox.customer_memberships(id,tenant_id,store_id,customer_id,member_no,level,status) VALUES($1,$2,$3,$4,$5,'member','active')",[membership,scope.tenantId,scope.storeId,customer,'MBX'+membership.replaceAll('-','').slice(0,16).toUpperCase()])
  if(withMember)await pool.query('INSERT INTO mbox.loyalty_accounts(id,tenant_id,store_id,membership_id,customer_id) VALUES($1,$2,$3,$4,$5)',[account,scope.tenantId,scope.storeId,membership,customer])
  await pool.query(`INSERT INTO mbox.loyalty_policy_versions(id,tenant_id,store_id,policy_code,version,status,points_numerator,points_denominator_minor,growth_numerator,growth_denominator_minor,rounding_mode,points_validity_months,effective_from,drafted_by_employee_id,approved_by_employee_id,approved_at,published_by_employee_id,published_at,publication_mode,reason)
   VALUES($1,$2,$3,$4,1,'published',1,$8,1,$8,'floor',18,'2026-08-01',$5,$6,'2026-08-01',$7,'2026-08-01','separated','原冻结积分成长规则')`,[policy,scope.tenantId,scope.storeId,'P'+policy.replaceAll('-','').toUpperCase(),requester,cashier,publisher,denominator])
  await pool.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,submitted_at,subtotal_amount_minor,total_amount_minor,created_by_customer_id,loyalty_policy_version_id,loyalty_points_multiplier_numerator,loyalty_points_multiplier_denominator) VALUES($1::uuid,$2,$3,$4,$1::text,'staff_assisted','submitted',clock_timestamp(),4000,4000,$5,$6,1,1)",[order,scope.tenantId,scope.storeId,session,customer,withMember?policy:null])
  await pool.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot,loyalty_eligible_at_submission,loyalty_eligibility_source) VALUES($1,$2,$3,$4,$5,1,4000,4000,'none','{"name":"商品","inventoryControlMode":"not_managed"}',true,'catalog_product')`,[item,scope.tenantId,scope.storeId,order,product])
  const f={order,item,customer,membership,account,policy,session}
  if(withRecommendation)await seedRecommendation(f)
  const payment=(await cash(f,captured===4000?undefined:captured)).value
  return {...f,payment}
 }
 async function seedRecommendation(f:{customer:string;session:string;order:string;item:string}){
   const recommendation=randomUUID(),option=randomUUID(),policy=randomUUID()
   await pool.query("INSERT INTO mbox.recommendation_policy_versions(id,tenant_id,store_id,public_id,policy_code,version,status,created_by_employee_id,draft_reason) VALUES($1::uuid,$2,$3,$1::text,$4,1,'draft',$5,'恢复入口合成推荐事实')",[policy,scope.tenantId,scope.storeId,'R'+policy.replaceAll('-','').toUpperCase(),publisher])
   await pool.query("INSERT INTO mbox.recommendation_sessions(id,tenant_id,store_id,public_id,customer_id,table_session_id,business_date,source,party_size,occasion,alcohol_preference,experience_level) VALUES($1::uuid,$2,$3,$1::text,$4,$5,$6,'guest_table',2,'friends','undecided','enhanced')",[recommendation,scope.tenantId,scope.storeId,f.customer,f.session,date])
   await pool.query("INSERT INTO mbox.recommendation_options(id,tenant_id,store_id,recommendation_session_id,policy_version_id,product_id,rank,tier,amount_minor,cost_amount_minor,currency,total_score,explanation) VALUES($1,$2,$3,$4,$5,$6,1,'enhanced',4000,0,'CNY',100,'合成推荐事实')",[option,scope.tenantId,scope.storeId,recommendation,policy,product])
   await pool.query("INSERT INTO mbox.recommendation_behavior_events(tenant_id,store_id,recommendation_session_id,recommendation_option_id,customer_id,table_session_id,order_id,order_item_id,event_type,actor_type,actor_ref) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ordered','guest','synthetic-guest')",[scope.tenantId,scope.storeId,recommendation,option,f.customer,f.session,f.order,f.item])
 }
 const cash=(f:{order:string},amountMinor?:number)=>money.recordManual({...meta(),orderId:f.order,...(amountMinor===undefined?{}:{orderIds:[f.order],amountMinor}),publicId:randomUUID(),provider:'cash',method:'cash',evidence:{collectedByEmployeeId:cashier,receiptReference:randomUUID()}})
 const authorize=(f:{order:string})=>money.authorizeRecollection({...meta(),orderId:f.order,reason:'核对原普通退款，明确补收原消费余额'})
 async function refund(f:{item:string},paymentId:string,amountMinor:number,purpose:'price_adjustment'|'service_compensation'='price_adjustment'){
  const r=(await money.requestRefund({...meta(requester),paymentId,publicId:randomUUID(),purpose,reason:'真实商品金额核对退款',allocations:[{orderItemId:f.item,amountMinor}]})).value
  await money.approveRefund({...meta(),refundId:r.id,decisionReason:'异人核对商品及原收款'})
  await money.beginRefundExecution({...meta(),refundId:r.id});await money.recordManualRefundResult({...meta(),refundId:r.id,succeeded:true,receiptReference:randomUUID()})
  return r
 }
 let actor=cashier,activeScope=scope
 const post=(path:string,payload:unknown,key=randomUUID())=>app.inject({method:'POST',url:'/api'+path,headers:{'idempotency-key':key},payload})
 async function view(orderId:string){const response=await app.inject({method:'GET',url:`/api/staff/order-financial-recovery?orderPublicId=${orderId}`});expect(response.statusCode,response.body).toBe(200);return response.json().data.orders[0] as OrderFinancialRecoveryPreview}
 const request=(v:OrderFinancialRecoveryPreview,dimensions:'all'|'attribution'|'loyalty',key=randomUUID())=>post(`/staff/order-financial-recovery/${v.orderId}/requests`,{basisVersion:v.basisVersion,dimensions,reason:'核对原付款退款及明确补收凭据'},key)
 const decide=(id:string,version:string,key=randomUUID(),decision='approve')=>post(`/staff/order-financial-recovery-requests/${id}/decisions`,{basisVersion:version,decision,reason:'独立复核原贡献与补收证据'},key)
 // Historical fixture composition: real restricted repositories append the original
 // collection and ledger without today's post-collection recovery hook. No original
 // payment/refund/award is overwritten. This is not a genuine old-binary upgrade test.
 async function historicalCash(orderId:string){return runner.run(scope,async tx=>{
   const payments=new PaymentRepository(tx),reference=randomUUID(),evidence={collectedByEmployeeId:cashier,receiptReference:reference}
   const payment=await payments.createForOrder({orderId,publicId:randomUUID(),provider:'cash',method:'cash',providerTransactionId:reference,evidence,initialStatus:'succeeded',principal:{type:'employee',employeeId:cashier}})
   await new ReconciliationRepository(tx).append({paymentId:payment.id,entryType:'payment',provider:'cash',providerReference:reference,amountMinor:payment.amountMinor,currency:payment.currency,businessDate:date,occurredAt:payment.succeededAt!,evidenceSnapshot:evidence})
   await payments.syncOrderPaymentStatus(orderId);return payment
 })}
 async function historical(withMember=true){const f=await fixture(withMember);await refund(f,f.payment.id,2000);await authorize(f);await historicalCash(f.order);return f}
 async function deny(employeeId:string,code:string){await pool.query("INSERT INTO mbox.employee_permission_overrides(tenant_id,store_id,employee_id,permission_id,effect,reason,configured_by_employee_id) SELECT $1,$2,$3,id,'deny','test current revocation',$3 FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code=$4",[scope.tenantId,scope.storeId,employeeId,code])}
 async function clearDeny(employeeId:string){await pool.query('DELETE FROM mbox.employee_permission_overrides WHERE tenant_id=$1 AND store_id=$2 AND employee_id=$3',[scope.tenantId,scope.storeId,employeeId])}
 const counts=async(orderId:string)=>(await pool.query(`SELECT
   (SELECT count(*)::int FROM mbox.order_recollection_item_restorations WHERE order_id=$1) item_restorations,
   (SELECT count(*)::int FROM mbox.loyalty_recollection_restorations WHERE order_id=$1) loyalty_restorations,
   (SELECT count(*)::int FROM mbox.order_financial_recovery_requests WHERE order_id=$1) requests,
   (SELECT count(*)::int FROM mbox.order_financial_recovery_decisions WHERE order_id=$1) decisions,
   (SELECT count(*)::int FROM mbox.payments WHERE order_id=$1) payments,
   (SELECT count(*)::int FROM mbox.refunds WHERE order_id=$1) refunds`,[orderId])).rows[0]

 it('previews original awarded-equals-expected net deficit and restores only its missing contribution through another actor',async()=>{
   const f=await historical();actor=requester
   const v=await view(f.order);expect(v.availableDimensions).toContain('all');expect(v.loyalty).toMatchObject({status:'ready',pointsDelta:20,growthDelta:20,availablePointsDelta:20})
   const key=randomUUID(),created=await request(v,'all',key);expect(created.statusCode,created.body).toBe(200)
   const id=created.json().data.requestId;expect((await decide(id,v.basisVersion)).json().error.code).toBe('ORDER_RECOVERY_SELF_APPROVAL')
   actor=cashier;const approved=await decide(id,v.basisVersion);expect(approved.statusCode,approved.body).toBe(200);expect(approved.json().data).toMatchObject({status:'approved',pointsDelta:20,growthDelta:20,itemAmountMinor:2000})
   expect(await counts(f.order)).toMatchObject({item_restorations:1,loyalty_restorations:1,requests:1,decisions:1,payments:2,refunds:1})
   expect((await pool.query('SELECT available_points,growth_value FROM mbox.loyalty_accounts WHERE id=$1',[f.account])).rows[0]).toEqual({available_points:40,growth_value:40})
 })
 it('keeps positive fractional reward contribution recoverable even when integer points and growth are zero',async()=>{
   const f=await fixture(true,10000);await refund(f,f.payment.id,2000);await authorize(f);await historicalCash(f.order);actor=requester
   const v=await view(f.order);expect(v.loyalty).toMatchObject({status:'ready',eligibleAmountMinor:2000,pointsDelta:0,growthDelta:0});expect(v.availableDimensions).toContain('all')
   const created=await request(v,'all');expect(created.statusCode,created.body).toBe(200);actor=cashier
   const approved=await decide(created.json().data.requestId,v.basisVersion);expect(approved.statusCode,approved.body).toBe(200)
   expect(approved.json().data).toMatchObject({status:'approved',pointsDelta:0,growthDelta:0,itemAmountMinor:2000})
   expect((await pool.query('SELECT restored_eligible_amount_minor::text amount FROM mbox.loyalty_order_reward_contributions WHERE order_id=$1',[f.order])).rows[0]).toEqual({amount:'2000'})
   expect((await view(f.order)).loyalty).toMatchObject({status:'not_required',eligibleAmountMinor:0})
   expect(await counts(f.order)).toMatchObject({loyalty_restorations:1,decisions:1,payments:2,refunds:1})
 })
 it('lets financial-only actors recover a nonmember original order, masks loyalty, and rejects self review or a dimensions escalation',async()=>{
   const f=await historical(false);actor=financeOnly
   const v=await view(f.order);expect(v.availableDimensions).toEqual(['attribution']);expect(v.loyalty).toMatchObject({status:'permission_required',memberNo:null,policyVersionId:null})
   expect((await request(v,'all')).statusCode).toBe(403)
   const created=await request(v,'attribution'),id=created.json().data.requestId;expect(created.statusCode,created.body).toBe(200)
   expect((await decide(id,v.basisVersion)).json().error.code).toBe('ORDER_RECOVERY_SELF_APPROVAL')
   actor=financeReviewer;const approved=await decide(id,v.basisVersion);expect(approved.statusCode,approved.body).toBe(200);expect(approved.json().data).toMatchObject({itemAmountMinor:2000,pointsDelta:0,growthDelta:0})
   expect(await counts(f.order)).toMatchObject({item_restorations:1,loyalty_restorations:0,payments:2,refunds:1})
 })
 it('discovers and approves only recommendation/item attribution when the member already has full rewards',async()=>{
   const f=await fixture(true,100,1600,true);await refund(f,f.payment.id,800);await authorize(f);const paid=await historicalCash(f.order)
   // The original first-settlement behavior awards the correct 40 member points,
   // but its gross recommendation paid event minus the earlier refund is only 32.
   await runner.run(scope,async tx=>{
     await tx.query(`INSERT INTO mbox.recommendation_behavior_events
       (tenant_id,store_id,recommendation_session_id,recommendation_option_id,customer_id,table_session_id,order_id,order_item_id,payment_id,attributed_amount_minor,attributed_currency,event_type,actor_type,actor_ref,evidence_snapshot)
       SELECT original.tenant_id,original.store_id,original.recommendation_session_id,original.recommendation_option_id,original.customer_id,original.table_session_id,original.order_id,original.order_item_id,$4,item.amount_minor,'CNY','paid','system','legacy-original-settlement','{"source":"authoritative_order_payment"}'::jsonb
       FROM mbox.recommendation_behavior_events original JOIN mbox.loyalty_order_item_basis item
         ON (item.tenant_id,item.store_id,item.order_id,item.order_item_id)=(original.tenant_id,original.store_id,original.order_id,original.order_item_id)
       WHERE original.tenant_id=$1 AND original.store_id=$2 AND original.order_id=$3 AND original.event_type='ordered'`,[scope.tenantId,scope.storeId,f.order,paid.id])
     await new LoyaltyAccrualRepository(tx).recordPaidOrder({orderId:f.order,paymentId:paid.id,occurredAt:paid.succeededAt!})
   })
   actor=financeOnly;const v=await view(f.order);expect(v.attribution).toMatchObject({recommendationCurrentMinor:3200,recommendationExpectedMinor:4000,recommendationDeltaMinor:800});expect(v.availableDimensions).toEqual(['attribution'])
   const created=await request(v,'attribution');actor=financeReviewer;const approved=await decide(created.json().data.requestId,v.basisVersion)
   expect(approved.statusCode,approved.body).toBe(200);expect(approved.json().data).toMatchObject({recommendationAmountMinor:800,pointsDelta:0,growthDelta:0})
   expect((await pool.query('SELECT available_points,growth_value FROM mbox.loyalty_accounts WHERE id=$1',[f.account])).rows[0]).toEqual({available_points:40,growth_value:40})
 })
 it('keeps uncertain debt and expiry rules blocked while allowing the determined attribution dimension',async()=>{
   const f=await fixture()
   await runner.run(scope,tx=>new LoyaltyAccrualRepository(tx).adjustPoints({customerId:f.customer,pointsDelta:-40,sourceType:'manual',sourceId:randomUUID(),reason:'既有已消费积分测试',idempotencyKey:randomUUID(),occurredAt:new Date().toISOString(),employeeId:cashier}))
   await refund(f,f.payment.id,2000)
   await runner.run(scope,tx=>new LoyaltyAccrualRepository(tx).adjustPoints({customerId:f.customer,pointsDelta:10,sourceType:'manual',sourceId:randomUUID(),reason:'后续其他来源抵债测试',idempotencyKey:randomUUID(),occurredAt:new Date().toISOString(),employeeId:cashier}))
   await authorize(f);await historicalCash(f.order);actor=requester
   const v=await view(f.order);expect(v.loyalty.status).toBe('rule_pending');expect(v.availableDimensions).toEqual(['attribution'])
   expect((await request(v,'all')).json().error.code).toBe('ORDER_RECOVERY_BLOCKED')
   const created=await request(v,'attribution');actor=cashier;const approved=await decide(created.json().data.requestId,v.basisVersion)
   expect(approved.statusCode,approved.body).toBe(200);expect(approved.json().data).toMatchObject({pointsDelta:0,growthDelta:0,itemAmountMinor:2000})
   expect((await view(f.order)).loyalty.status).toBe('rule_pending')
   expect(await counts(f.order)).toMatchObject({item_restorations:1,loyalty_restorations:0})
 })
 it('persists original request and decision receipts beyond generic cache and denies changed body or current revoked authority',async()=>{
   const f=await historical();actor=requester;const v=await view(f.order),requestKey=randomUUID(),created=await request(v,'all',requestKey),id=created.json().data.requestId
   actor=cashier;const key=randomUUID(),approved=await decide(id,v.basisVersion,key);expect(approved.statusCode,approved.body).toBe(200)
   await pool.query('DELETE FROM mbox.idempotency_records WHERE tenant_id=$1 AND store_id=$2',[scope.tenantId,scope.storeId])
   expect((await decide(id,v.basisVersion,key)).json().meta.replayed).toBe(true)
   expect((await decide(id,v.basisVersion,key,'reject')).statusCode).toBe(409)
   await deny(cashier,'loyalty.accrual.approve');try{expect((await decide(id,v.basisVersion,key)).statusCode).toBe(403)}finally{await clearDeny(cashier)}
   actor=requester;expect((await request(v,'all',requestKey)).json().meta.replayed).toBe(true)
   await deny(requester,'reconciliation.manage');try{expect((await request(v,'all',requestKey)).statusCode).toBe(403)}finally{await clearDeny(requester)}
   actor=financeOnly;expect((await decide(id,v.basisVersion,key)).statusCode).toBe(403)
   activeScope={tenantId:randomUUID(),storeId:randomUUID()};try{expect((await decide(id,v.basisVersion,key)).statusCode).toBe(403)}finally{activeScope=scope}
   expect(await counts(f.order)).toMatchObject({item_restorations:1,loyalty_restorations:1,requests:1,decisions:1})
 })
 it('rejects a stale approval after a new actual refund without modifying the original request',async()=>{
   const f=await historical();actor=requester;const v=await view(f.order),created=await request(v,'all'),id=created.json().data.requestId
   await refund(f,f.payment.id,100,'service_compensation');actor=cashier
   const refused=await decide(id,v.basisVersion);expect(refused.statusCode,refused.body).toBe(409);expect(refused.json().error).toMatchObject({code:'ORDER_RECOVERY_STALE',commitDisposition:'not_committed'})
   expect(await counts(f.order)).toMatchObject({decisions:0,item_restorations:0,loyalty_restorations:0})
   expect((await decide(id,v.basisVersion,randomUUID(),'reject')).statusCode).toBe(200)
 })
 it('serializes simultaneous approval keys and preserves immutable scoped receipts',async()=>{
   const f=await historical(false);actor=financeOnly;const v=await view(f.order),created=await request(v,'attribution'),id=created.json().data.requestId
   actor=financeReviewer;const key=randomUUID(),same=await Promise.all([decide(id,v.basisVersion,key),decide(id,v.basisVersion,key)])
   expect(same.every(r=>r.statusCode===200)).toBe(true);expect(same.map(r=>r.json().meta.replayed).sort()).toEqual([false,true])
   const other=await decide(id,v.basisVersion);expect(other.statusCode).toBe(409)
   for(const permission of ['reconciliation.view','reconciliation.manage']){await deny(financeReviewer,permission);try{expect((await decide(id,v.basisVersion,key)).statusCode).toBe(403)}finally{await clearDeny(financeReviewer)}}
   await expect(runner.run(scope,tx=>tx.query('DELETE FROM mbox.order_financial_recovery_requests WHERE id=$1',[id]))).rejects.toMatchObject({code:'42501'})
   expect(await counts(f.order)).toMatchObject({item_restorations:1,requests:1,decisions:1})
 })
 it('serializes different decision keys on the same original request',async()=>{
   const f=await historical(false);actor=financeOnly;const v=await view(f.order),created=await request(v,'attribution')
   actor=financeReviewer;const results=await Promise.all([decide(created.json().data.requestId,v.basisVersion),decide(created.json().data.requestId,v.basisVersion)])
   expect(results.map(r=>r.statusCode).sort()).toEqual([200,409]);expect(await counts(f.order)).toMatchObject({item_restorations:1,requests:1,decisions:1,payments:2,refunds:1})
 })

})
