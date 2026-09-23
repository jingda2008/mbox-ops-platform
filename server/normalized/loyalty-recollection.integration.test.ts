import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {afterAll,afterEach,beforeAll,describe,expect,it} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {PaymentCommandService} from './payment-command-service.js'
import {NormalizedPaymentCapabilityAuthorization} from './payment-security-policy.js'
import {NormalizedProviderObservationAuthority,VerifiedProviderObservationService} from './provider-verification-observation.js'
import {LoyaltyAccrualRepository} from './loyalty-accrual-repository.js'
import {LoyaltyRecollectionRepository} from './loyalty-recollection-repository.js'
import {RecommendationFinancialAttributionRepository} from './recommendation-financial-attribution-repository.js'
import {LoyaltyOperationalControlService} from './loyalty-operational-control-service.js'
import {LoyaltyAccrualDeferredWorker} from './loyalty-accrual-deferred-worker.js'
import {LoyaltyRefundReviewService} from './loyalty-refund-review-service.js'

const url=process.env.TEST_NORMALIZED_DATABASE_URL,runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
;(url&&runtimeUrl?describe:describe.skip)('loyalty ordinary recollection, real restricted LOGIN',()=>{
 let pool:Pool,runtime:Pool,runner:ScopedPostgresTransactionRunner,money:PaymentCommandService,date:string
 const scope={tenantId:randomUUID(),storeId:randomUUID()},area=randomUUID(),product=randomUUID(),cashier=randomUUID(),requester=randomUUID(),publisher=randomUUID()
 beforeAll(async()=>{
  await runNormalizedMigrations(url!);pool=new Pool({connectionString:url,max:8});runtime=new Pool({connectionString:runtimeUrl,max:8});runner=new ScopedPostgresTransactionRunner(runtime)
  expect((await runtime.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=session_user')).rows[0]).toEqual({rolsuper:false,rolbypassrls:false})
  money=new PaymentCommandService(new NormalizedCommandExecutor(runner),new NormalizedPaymentCapabilityAuthorization(),new NormalizedProviderObservationAuthority())
  await pool.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'recollection fixture')",[scope.tenantId])
  await pool.query("INSERT INTO mbox.stores(id,tenant_id,code,name,timezone,business_day_cutoff) VALUES($1,$2,'restore','restore','Asia/Shanghai','06:00')",[scope.storeId,scope.tenantId])
  date=await runner.run(scope,async tx=>(await tx.query<{date:string}>('SELECT mbox.current_operating_business_date($1,$2)::text date',[scope.tenantId,scope.storeId])).rows[0]!.date)
  await pool.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'A','A','indoor')",[area,scope.tenantId,scope.storeId])
  await pool.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station) VALUES($1,$2,$3,'RESTORE','商品','drink','none')",[product,scope.tenantId,scope.storeId])
  for(const employeeId of [cashier,requester,publisher]){
   await pool.query('INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,$4,$4)',[employeeId,scope.tenantId,scope.storeId,employeeId])
   const role=randomUUID();await pool.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,$4,'fixture')",[role,scope.tenantId,scope.storeId,'R_'+role.replaceAll('-','').toUpperCase()])
   await pool.query('INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id) VALUES($1,$2,$3,$4)',[scope.tenantId,scope.storeId,employeeId,role])
   for(const code of [...(employeeId===cashier?['payment.initiate.staff','payment.manual.cash.record','payment.collect.all_tables','payment.recollect.authorize','refund.approve','refund.execute']:['refund.request']),...['reconciliation.view','reconciliation.manage','loyalty.accrual.exception.view','loyalty.accrual.request','loyalty.accrual.approve']]){
    const permission=(await pool.query("INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category) VALUES($1,$2,$3,$3,'operations') ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET name=EXCLUDED.name RETURNING id",[scope.tenantId,scope.storeId,code])).rows[0].id
    await pool.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[scope.tenantId,scope.storeId,role,permission])
   }
   if(employeeId===cashier)await pool.query("INSERT INTO mbox.role_approval_limits(tenant_id,store_id,role_id,approval_code,amount_minor,currency) VALUES($1,$2,$3,'refund.approve',100000,'CNY')",[scope.tenantId,scope.storeId,role])
  }
 },30000)
 afterAll(async()=>{await runtime?.end();await pool?.end()})
 const meta=(employeeId=cashier)=>({scope,actor:{type:'employee' as const,employeeId},businessDate:date,idempotencyKey:randomUUID(),requestFingerprint:randomUUID()})
 async function fixture(captured=4000,denominator=100,mixed=false){
  const table=randomUUID(),session=randomUUID(),order=randomUUID(),item=randomUUID(),customer=randomUUID(),membership=randomUUID(),account=randomUUID(),policy=randomUUID()
  await pool.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,$5,$5,2)",[table,scope.tenantId,scope.storeId,area,'T'+table.slice(0,8)])
  await pool.query('INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1::uuid,$2,$3,$4,$1::text,$5,1)',[session,scope.tenantId,scope.storeId,table,date])
  await pool.query("INSERT INTO mbox.customers(id,tenant_id,store_id,public_id,status) VALUES($1::uuid,$2,$3,$1::text,'active')",[customer,scope.tenantId,scope.storeId])
  await pool.query("INSERT INTO mbox.customer_memberships(id,tenant_id,store_id,customer_id,member_no,level,status) VALUES($1,$2,$3,$4,$5,'member','active')",[membership,scope.tenantId,scope.storeId,customer,'MBX'+membership.replaceAll('-','').slice(0,16).toUpperCase()])
  await pool.query('INSERT INTO mbox.loyalty_accounts(id,tenant_id,store_id,membership_id,customer_id) VALUES($1,$2,$3,$4,$5)',[account,scope.tenantId,scope.storeId,membership,customer])
  await pool.query(`INSERT INTO mbox.loyalty_policy_versions(id,tenant_id,store_id,policy_code,version,status,points_numerator,points_denominator_minor,growth_numerator,growth_denominator_minor,rounding_mode,points_validity_months,effective_from,drafted_by_employee_id,approved_by_employee_id,approved_at,published_by_employee_id,published_at,publication_mode,reason)
   VALUES($1,$2,$3,$4,1,'published',1,$8,1,$8,'floor',18,'2026-08-01',$5,$6,'2026-08-01',$7,'2026-08-01','separated','原冻结积分成长规则')`,[policy,scope.tenantId,scope.storeId,'P'+policy.replaceAll('-','').toUpperCase(),requester,cashier,publisher,denominator])
  await pool.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,submitted_at,subtotal_amount_minor,total_amount_minor,created_by_customer_id,loyalty_policy_version_id,loyalty_points_multiplier_numerator,loyalty_points_multiplier_denominator) VALUES($1::uuid,$2,$3,$4,$1::text,'staff_assisted','submitted',clock_timestamp(),4000,4000,$5,$6,1,1)",[order,scope.tenantId,scope.storeId,session,customer,policy])
  await pool.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot,loyalty_eligible_at_submission,loyalty_eligibility_source) VALUES($1,$2,$3,$4,$5,1,$6,$6,'none','{"name":"商品","inventoryControlMode":"not_managed"}',true,'catalog_product')`,[item,scope.tenantId,scope.storeId,order,product,mixed?3000:4000])
  const excludedItem=randomUUID()
  if(mixed){
   const excludedProduct=randomUUID()
   await pool.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station) VALUES($1::uuid,$2,$3,$1::text,'不计分商品','drink','none')",[excludedProduct,scope.tenantId,scope.storeId])
   await pool.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot,loyalty_eligible_at_submission,loyalty_eligibility_source) VALUES($1,$2,$3,$4,$5,1,1000,1000,'none','{"name":"不计分商品","inventoryControlMode":"not_managed"}',false,'catalog_product')`,[excludedItem,scope.tenantId,scope.storeId,order,excludedProduct])
  }
  const f={order,item,customer,membership,account,policy,session}
  const pending=mixed?(await money.initiate({...meta(),orderId:order,publicId:randomUUID(),provider:'postar',method:'native_qr',principal:{type:'employee',employeeId:cashier}})).value:null
  const payment=(await cash(f,captured===4000?undefined:captured)).value
  if(pending){
   const integrationRef='mixed-recollection-fixture',providerTransactionId=randomUUID(),occurredAt=new Date().toISOString()
   const observed=await new VerifiedProviderObservationService(runner).recordPayment({scope,provider:'postar',verificationKind:'callback_signature',providerEventId:randomUUID(),integrationRef,paymentPublicId:pending.publicId,providerTransactionId,reportedAmountMinor:4000,reportedCurrency:'CNY',status:'succeeded',occurredAt,evidence:{}})
   const online=await money.recordSucceededCallback({...meta(),actor:{type:'integration',ref:integrationRef},verifiedObservationId:observed,paymentPublicId:pending.publicId,provider:'postar',providerTransactionId,reportedAmountMinor:4000,reportedCurrency:'CNY',occurredAt})
   return {...f,payment:online.value,excludedItem}
  }
  return {...f,payment,excludedItem}
 }
 const cash=(f:{order:string},amountMinor?:number)=>money.recordManual({...meta(),orderId:f.order,...(amountMinor===undefined?{}:{orderIds:[f.order],amountMinor}),publicId:randomUUID(),provider:'cash',method:'cash',evidence:{collectedByEmployeeId:cashier,receiptReference:randomUUID()}})
 const authorize=(f:{order:string})=>money.authorizeRecollection({...meta(),orderId:f.order,reason:'核对原普通退款，明确补收原消费余额'})
 async function pause(operation:'pause'|'resume'){
  const controls=new LoyaltyOperationalControlService(runner,new NormalizedCommandExecutor(runner)),context={scope,businessDate:date,employeeId:cashier}
  const state=(await controls.list(context)).find(s=>s.capability==='points_accrual')!
  return controls.set(context,{capability:'points_accrual',operation,reason:'限定隔离恢复边界',reviewAt:null,expectedVersion:state.version,idempotencyKey:randomUUID()})
 }
 afterEach(async()=>{
  if(runner&&(await new LoyaltyOperationalControlService(runner,new NormalizedCommandExecutor(runner)).list({scope,businessDate:date,employeeId:cashier})).some(s=>s.capability==='points_accrual'&&s.state==='paused'))await pause('resume')
 })
 async function refund(f:{item:string},paymentId:string,amountMinor:number,purpose:'price_adjustment'|'service_compensation'='price_adjustment'){
  const r=(await money.requestRefund({...meta(requester),paymentId,publicId:randomUUID(),purpose,reason:'真实商品金额核对退款',allocations:[{orderItemId:f.item,amountMinor}]})).value
  await money.approveRefund({...meta(),refundId:r.id,decisionReason:'异人核对商品及原收款'})
  await money.beginRefundExecution({...meta(),refundId:r.id});await money.recordManualRefundResult({...meta(),refundId:r.id,succeeded:true,receiptReference:randomUUID()})
  return r
 }
 const state=async(f:{order:string;account:string})=>(await pool.query(`SELECT a.available_points,a.pending_recovery_points,a.growth_value,
  (SELECT count(*)::int FROM mbox.loyalty_order_awards WHERE order_id=$1) awards,
  (SELECT count(*)::int FROM mbox.loyalty_recollection_restorations WHERE order_id=$1) restored,
  (SELECT sum(amount_minor)::int FROM mbox.order_payment_facts WHERE order_id=$1 AND succeeded_at IS NOT NULL AND status IN ('succeeded','partially_refunded','refunded')) gross,
  (SELECT COALESCE(sum(amount_minor),0)::int FROM mbox.order_refund_facts WHERE order_id=$1 AND status='succeeded') refunds
  FROM mbox.loyalty_accounts a WHERE a.id=$2`,[f.order,f.account])).rows[0]
 it.each(['single','batch','callback','query'] as const)('restores only reversed original rewards on actual recollection: %s',async mode=>{
  const f=await fixture();await refund(f,f.payment.id,2000);expect(await state(f)).toMatchObject({available_points:20,growth_value:20})
  await authorize(f)
  if(mode==='single'||mode==='batch')await cash(f,mode==='batch'?2000:undefined)
  else{
   const p=(await money.initiate({...meta(),orderId:f.order,publicId:randomUUID(),provider:'postar',method:'native_qr',principal:{type:'employee',employeeId:cashier}})).value
   const occurredAt=new Date().toISOString(),providerTransactionId=randomUUID(),integrationRef='recollection-test'
   const observed=await new VerifiedProviderObservationService(runner).recordPayment({scope,provider:'postar',verificationKind:mode==='query'?'active_query_binding':'callback_signature',providerEventId:randomUUID(),integrationRef,paymentPublicId:p.publicId,providerTransactionId,reportedAmountMinor:2000,reportedCurrency:'CNY',status:'succeeded',occurredAt,evidence:{}})
   const command={...meta(),actor:{type:'integration' as const,ref:integrationRef},verifiedObservationId:observed,paymentPublicId:p.publicId,provider:'postar' as const,providerTransactionId,reportedAmountMinor:2000,reportedCurrency:'CNY',occurredAt}
   if(mode==='query'){await money.recordProviderQueryResult({...command,status:'succeeded'});expect((await money.recordProviderQueryResult({...command,status:'succeeded'})).replayed).toBe(true)}
   else{await money.recordSucceededCallback(command);expect((await money.recordSucceededCallback(command)).replayed).toBe(true)}
  }
  expect(await state(f)).toMatchObject({available_points:40,growth_value:40,awards:1,restored:1,gross:6000,refunds:2000})
  const applications=(await pool.query('SELECT reversed_points FROM mbox.loyalty_award_refund_applications WHERE order_id=$1',[f.order])).rows
  expect(applications).toEqual([{reversed_points:20}])
  const positiveLedgers=(await pool.query(`SELECT points.entry_type,points.refund_id,points.source_type,
    points.source_id=restored.id::text AS bound_to_restoration,growth.refund_id AS growth_refund_id,
    restored.refund_id IS NOT NULL AS original_refund_preserved
    FROM mbox.loyalty_recollection_restorations restored
    JOIN mbox.loyalty_point_ledger points ON points.source_id=restored.id::text
    JOIN mbox.loyalty_growth_ledger growth ON growth.source_id=restored.id::text
    WHERE restored.order_id=$1`,[f.order])).rows
  expect(positiveLedgers).toEqual([{entry_type:'restore',refund_id:null,source_type:'order',bound_to_restoration:true,growth_refund_id:null,original_refund_preserved:true}])
 })
 it('keeps the first-award control and three successive refund/recollection cycles correct',async()=>{
  const first=await fixture(1600);await refund(first,first.payment.id,800);await authorize(first);await cash(first)
  expect(await state(first)).toMatchObject({available_points:40,growth_value:40,awards:1,restored:0,gross:4800,refunds:800})
  const f=await fixture();let receipt=f.payment
  for(let cycle=0;cycle<3;cycle++){
   await refund(f,receipt.id,2000);expect(await state(f)).toMatchObject({available_points:20,growth_value:20})
   await authorize(f);receipt=(await cash(f)).value
   expect(await state(f)).toMatchObject({available_points:40,growth_value:40,awards:1,restored:cycle+1})
  }
  expect((await pool.query('SELECT reversed_amount_minor::text,restored_amount_minor::text FROM mbox.loyalty_order_awards WHERE order_id=$1',[f.order])).rows[0]).toEqual({reversed_amount_minor:'6000',restored_amount_minor:'6000'})
 })
 it('does not recover partial or pending receipts, compensation, or a new unapproved refund',async()=>{
  const f=await fixture();await refund(f,f.payment.id,2000);await authorize(f);await cash(f,1000)
  expect(await state(f)).toMatchObject({available_points:20,growth_value:20,restored:0})
  await authorize(f);await cash(f)
  expect(await state(f)).toMatchObject({available_points:40,growth_value:40,restored:1})
  await refund(f,f.payment.id,100,'service_compensation')
  expect(await state(f)).toMatchObject({available_points:39,growth_value:39,restored:1})
  await refund(f,f.payment.id,100)
  expect((await runner.run(scope,tx=>new LoyaltyRecollectionRepository(tx).previewOrderRecovery({orderId:f.order}))).status).toBe('not_required')
  expect(await state(f)).toMatchObject({available_points:38,growth_value:38,restored:1})
 })
 it('releases original unpaid recovery debt without awarding a second full order',async()=>{
  const f=await fixture();await runner.run(scope,tx=>new LoyaltyAccrualRepository(tx).adjustPoints({customerId:f.customer,pointsDelta:-40,sourceType:'manual',sourceId:randomUUID(),reason:'既有积分消耗边界',idempotencyKey:randomUUID(),occurredAt:new Date().toISOString(),employeeId:cashier}))
  await refund(f,f.payment.id,2000);expect(await state(f)).toMatchObject({available_points:0,pending_recovery_points:20,growth_value:20})
  await authorize(f);await cash(f)
  expect(await state(f)).toMatchObject({available_points:0,pending_recovery_points:0,growth_value:40,restored:1})
 })
 it('serializes independent restoration requests and preserves original policy and lot expiry',async()=>{
  const f=await fixture(),before=(await pool.query('SELECT id,expires_at::text FROM mbox.loyalty_point_lots WHERE membership_id=$1',[f.membership])).rows[0]
  await refund(f,f.payment.id,2000);await authorize(f);await pause('pause');const paid=await cash(f);await pause('resume')
  const blocker=await pool.connect();await blocker.query('BEGIN');await blocker.query('SELECT id FROM mbox.orders WHERE id=$1 FOR UPDATE',[f.order])
  const competing=Promise.all([1,2].map(()=>runner.run(scope,tx=>new LoyaltyRecollectionRepository(tx).applyApprovedRecovery({orderId:f.order,paymentId:paid.value.id,actorRef:'test-replay',occurredAt:new Date().toISOString()}))))
  try{await expect.poll(async()=>Number((await pool.query("SELECT count(*) n FROM pg_stat_activity WHERE datname=current_database() AND usename=$1 AND wait_event_type='Lock'",[new URL(runtimeUrl!).username])).rows[0].n),{timeout:2000,interval:10}).toBeGreaterThanOrEqual(2)}finally{await blocker.query('COMMIT');blocker.release()}
  const results=await competing;expect(results.map(r=>r.applied).sort()).toEqual([false,true])
  expect((await pool.query('SELECT id,expires_at::text,remaining_points FROM mbox.loyalty_point_lots WHERE membership_id=$1',[f.membership])).rows).toEqual([{...before,remaining_points:40}])
  await expect(runner.run(scope,tx=>tx.query('DELETE FROM mbox.loyalty_recollection_restorations WHERE order_id=$1',[f.order]))).rejects.toMatchObject({code:'42501'})
  expect(await state(f)).toMatchObject({available_points:40,growth_value:40,restored:1,awards:1})
  const otherScope={tenantId:randomUUID(),storeId:randomUUID()}
  expect((await runner.run(otherScope,tx=>new LoyaltyRecollectionRepository(tx).previewOrderRecovery({orderId:f.order}))).status).toBe('not_required')
  expect((await runner.run(scope,tx=>new RecommendationFinancialAttributionRepository(tx).previewRecollectedForOrder({orderId:f.order}))).items.every(i=>i.restored)).toBe(true)
 })
 it.each([300,10000])('restores the original exact fraction including zero integer delta: denominator %s',async denominator=>{
  const f=await fixture(4000,denominator),before=await state(f)
  const carry=(await pool.query('SELECT reward_kind,denominator::text,remainder_numerator::text FROM mbox.loyalty_reward_carry_balances WHERE membership_id=$1 ORDER BY reward_kind',[f.membership])).rows
  await refund(f,f.payment.id,2000);await authorize(f);await cash(f)
  expect(await state(f)).toMatchObject({available_points:before.available_points,growth_value:before.growth_value,restored:1,awards:1})
  expect((await pool.query('SELECT reward_kind,denominator::text,remainder_numerator::text FROM mbox.loyalty_reward_carry_balances WHERE membership_id=$1 ORDER BY reward_kind',[f.membership])).rows).toEqual(carry)
 })
 it('defers existing-award restoration during pause and resumes once, including a reused deferred anchor',async()=>{
  await pause('pause');const f=await fixture();await pause('resume')
  const worker=new LoyaltyAccrualDeferredWorker(runner);await worker.runBatch(scope,'loyalty-recovery-first')
  expect(await state(f)).toMatchObject({available_points:40,growth_value:40})
  const anchor=(await pool.query('SELECT payment_id FROM mbox.loyalty_accrual_deferred_orders WHERE order_id=$1',[f.order])).rows[0].payment_id
  await refund(f,f.payment.id,2000);await authorize(f);await pause('pause');await cash(f)
  expect(await state(f)).toMatchObject({available_points:20,growth_value:20,restored:0})
  expect((await runner.run(scope,tx=>new LoyaltyRecollectionRepository(tx).previewOrderRecovery({orderId:f.order}))).status).toBe('ineligible')
  expect((await pool.query('SELECT payment_id,status FROM mbox.loyalty_accrual_deferred_orders WHERE order_id=$1',[f.order])).rows[0]).toEqual({payment_id:anchor,status:'pending'})
  await pause('resume');await worker.runBatch(scope,'loyalty-recovery-resume');await worker.runBatch(scope,'loyalty-recovery-repeat')
  expect(await state(f)).toMatchObject({available_points:40,growth_value:40,restored:1,awards:1})
 })
 it('does not extend already expired returned lots when historical recovery is applied later',async()=>{
  const f=await fixture();await refund(f,f.payment.id,2000);await authorize(f);await pause('pause');const receipt=await cash(f);await pause('resume')
  const expiry=(await pool.query('SELECT expires_at::text FROM mbox.loyalty_point_lots WHERE membership_id=$1',[f.membership])).rows[0].expires_at
  const afterExpiry=new Date(Date.parse(expiry)+1000).toISOString()
  const result=await runner.run(scope,tx=>new LoyaltyRecollectionRepository(tx).applyApprovedRecovery({orderId:f.order,paymentId:receipt.value.id,actorRef:'historical-expiry-test',occurredAt:afterExpiry}))
  expect(result).toMatchObject({applied:true,pointsDelta:20,availablePointsDelta:0,growthDelta:20})
  expect((await pool.query('SELECT expired_points,original_expires_at::text FROM mbox.loyalty_recollection_restorations WHERE order_id=$1',[f.order])).rows[0]).toEqual({expired_points:20,original_expires_at:expiry})
  expect(await state(f)).toMatchObject({available_points:20,growth_value:40,restored:1})
 })
 it('preserves an earlier factual settlement while later unapproved refunds reduce the final net contribution',async()=>{
  const f=await fixture();await refund(f,f.payment.id,2000);await authorize(f);await pause('pause');const receipt=await cash(f)
  await refund(f,f.payment.id,1000);expect(await state(f)).toMatchObject({available_points:10,growth_value:10,restored:0})
  await pause('resume')
  const applied=await runner.run(scope,tx=>new LoyaltyRecollectionRepository(tx).applyApprovedRecovery({orderId:f.order,paymentId:receipt.value.id,actorRef:'historical-after-refund',occurredAt:new Date().toISOString()}))
  expect(applied).toMatchObject({applied:true,pointsDelta:20,growthDelta:20})
  expect(await state(f)).toMatchObject({available_points:30,growth_value:30,gross:6000,refunds:3000,restored:1})
 })
 it('marks later-recorded backdated debt offsets as rule pending instead of treating the original debt as unpaid',async()=>{
  const f=await fixture()
  await runner.run(scope,tx=>new LoyaltyAccrualRepository(tx).adjustPoints({customerId:f.customer,pointsDelta:-40,sourceType:'manual',sourceId:randomUUID(),reason:'原积分已合法消耗',idempotencyKey:randomUUID(),occurredAt:new Date().toISOString(),employeeId:cashier}))
  await refund(f,f.payment.id,2000)
  const earlierOccurredAt=new Date(Date.now()-86400000).toISOString()
  await runner.run(scope,tx=>new LoyaltyAccrualRepository(tx).adjustPoints({customerId:f.customer,pointsDelta:20,sourceType:'manual',sourceId:randomUUID(),reason:'后入账的原日期积分补正',idempotencyKey:randomUUID(),occurredAt:earlierOccurredAt,employeeId:cashier}))
  expect(await state(f)).toMatchObject({available_points:0,pending_recovery_points:0,growth_value:20})
  await authorize(f);await cash(f)
  const preview=await runner.run(scope,tx=>new LoyaltyRecollectionRepository(tx).previewOrderRecovery({orderId:f.order}))
  expect(preview).toMatchObject({status:'rule_pending',blockReasons:['LOYALTY_RECOLLECTION_DEBT_EXPIRY_RULE_PENDING']})
  expect(await state(f)).toMatchObject({available_points:0,pending_recovery_points:0,growth_value:20,restored:0,gross:6000,refunds:2000})
 })
 it('keeps deferred restoration retryable while another payment is pending, then resumes after its verified outcome',async()=>{
  const f=await fixture();await refund(f,f.payment.id,2000);await authorize(f);await pause('pause');await cash(f)
  await refund(f,f.payment.id,1000);await authorize(f)
  const pending=(await money.initiate({...meta(),orderId:f.order,publicId:randomUUID(),provider:'postar',method:'native_qr',principal:{type:'employee',employeeId:cashier}})).value
  await pause('resume')
  expect(await runner.run(scope,tx=>new LoyaltyRecollectionRepository(tx).previewOrderRecovery({orderId:f.order}))).toMatchObject({status:'ineligible',blockReasons:['PAYMENT_OUTCOME_UNRESOLVED']})
  const worker=new LoyaltyAccrualDeferredWorker(runner);await worker.runBatch(scope,'recovery-pending-payment')
  expect((await pool.query('SELECT status FROM mbox.loyalty_accrual_deferred_orders WHERE order_id=$1',[f.order])).rows[0]).toEqual({status:'review_required'})
  expect(await state(f)).toMatchObject({available_points:10,growth_value:10,restored:0})
  const occurredAt=new Date().toISOString(),providerTransactionId=randomUUID(),integrationRef='pending-recovery-test'
  const observed=await new VerifiedProviderObservationService(runner).recordPayment({scope,provider:'postar',verificationKind:'active_query_binding',providerEventId:randomUUID(),integrationRef,paymentPublicId:pending.publicId,providerTransactionId,reportedAmountMinor:1000,reportedCurrency:'CNY',status:'succeeded',occurredAt,evidence:{}})
  await money.recordProviderQueryResult({...meta(),actor:{type:'integration',ref:integrationRef},verifiedObservationId:observed,paymentPublicId:pending.publicId,provider:'postar',providerTransactionId,reportedAmountMinor:1000,reportedCurrency:'CNY',occurredAt,status:'succeeded'})
  // Only advance the local retry timer; all money and reward facts above use real low-privilege commands.
  await pool.query("UPDATE mbox.loyalty_accrual_deferred_orders SET updated_at=clock_timestamp()-interval '11 minutes' WHERE order_id=$1",[f.order])
  await worker.runBatch(scope,'recovery-payment-resolved')
  expect((await pool.query('SELECT status FROM mbox.loyalty_accrual_deferred_orders WHERE order_id=$1',[f.order])).rows[0]).toEqual({status:'applied'})
  expect(await state(f)).toMatchObject({available_points:40,growth_value:40,restored:2,awards:1})
 })
 it('blocks restoration on an unconsumed verified refund success and retries only after formal refund accounting',async()=>{
  const f=await fixture();await refund(f,f.payment.id,2000);await authorize(f);await pause('pause')
  const payment=(await money.initiate({...meta(),orderId:f.order,publicId:randomUUID(),provider:'postar',method:'native_qr',principal:{type:'employee',employeeId:cashier}})).value
  const integrationRef='refund-observation-recovery',providerTransactionId=randomUUID(),occurredAt=new Date().toISOString()
  const observations=new VerifiedProviderObservationService(runner)
  const paymentObservation=await observations.recordPayment({scope,provider:'postar',verificationKind:'callback_signature',providerEventId:randomUUID(),integrationRef,paymentPublicId:payment.publicId,providerTransactionId,reportedAmountMinor:2000,reportedCurrency:'CNY',status:'succeeded',occurredAt,evidence:{}})
  await money.recordSucceededCallback({...meta(),actor:{type:'integration',ref:integrationRef},verifiedObservationId:paymentObservation,paymentPublicId:payment.publicId,provider:'postar',providerTransactionId,reportedAmountMinor:2000,reportedCurrency:'CNY',occurredAt})
  const pendingRefund=(await money.requestRefund({...meta(requester),paymentId:payment.id,publicId:randomUUID(),purpose:'price_adjustment',reason:'验证退款真实商品归属',allocations:[{orderItemId:f.item,amountMinor:1000}]})).value
  await money.approveRefund({...meta(),refundId:pendingRefund.id,decisionReason:'异人复核原商品退款'})
  await money.beginRefundExecution({...meta(),refundId:pendingRefund.id})
  const providerRefundId=randomUUID(),refundAt=new Date().toISOString()
  const refundObservation=await observations.recordRefund({scope,provider:'postar',verificationKind:'callback_signature',providerEventId:randomUUID(),integrationRef,refundPublicId:pendingRefund.publicId,providerTransactionId:providerRefundId,originalProviderTransactionId:providerTransactionId,reportedAmountMinor:1000,reportedCurrency:'CNY',status:'succeeded',occurredAt:refundAt,evidence:{}})
  await pause('resume')
  expect(await runner.run(scope,tx=>new LoyaltyRecollectionRepository(tx).previewOrderRecovery({orderId:f.order}))).toMatchObject({status:'ineligible',blockReasons:['REFUND_OUTCOME_UNRESOLVED']})
  const worker=new LoyaltyAccrualDeferredWorker(runner);await worker.runBatch(scope,'recovery-unconsumed-refund')
  expect((await pool.query('SELECT status FROM mbox.loyalty_accrual_deferred_orders WHERE order_id=$1',[f.order])).rows[0]).toEqual({status:'review_required'})
  expect(await state(f)).toMatchObject({available_points:20,growth_value:20,restored:0})
  await money.recordProviderRefundResult({...meta(),actor:{type:'integration',ref:integrationRef},verifiedObservationId:refundObservation,refundPublicId:pendingRefund.publicId,provider:'postar',providerRefundId,originalProviderTransactionId:providerTransactionId,reportedAmountMinor:1000,reportedCurrency:'CNY',succeeded:true,occurredAt:refundAt})
  await pool.query("UPDATE mbox.loyalty_accrual_deferred_orders SET updated_at=clock_timestamp()-interval '11 minutes' WHERE order_id=$1",[f.order])
  await worker.runBatch(scope,'recovery-refund-consumed')
  expect((await pool.query('SELECT status FROM mbox.loyalty_accrual_deferred_orders WHERE order_id=$1',[f.order])).rows[0]).toEqual({status:'applied'})
  expect(await state(f)).toMatchObject({available_points:30,growth_value:30,restored:1,awards:1,gross:6000,refunds:3000})
 })
 it('restores only financially reviewed eligible goods when one ordinary refund combines mixed eligibility and excess receipts',async()=>{
  const f=await fixture(2000,100,true)
  expect(await state(f)).toMatchObject({available_points:30,growth_value:30,gross:6000,refunds:0})
  const originalAward=(await pool.query('SELECT id,eligible_amount_minor::text,awarded_points,awarded_growth FROM mbox.loyalty_order_awards WHERE order_id=$1',[f.order])).rows[0]
  const r=(await money.requestRefund({...meta(requester),paymentId:f.payment.id,publicId:randomUUID(),purpose:'price_adjustment',reason:'混合资格商品退款含原超收部分',allocations:[{orderItemId:f.item,amountMinor:2000},{orderItemId:f.excludedItem,amountMinor:1000}]})).value
  await money.approveRefund({...meta(),refundId:r.id,decisionReason:'异人确认原款与总退款金额'});await money.beginRefundExecution({...meta(),refundId:r.id})
  const providerRefundId=randomUUID(),integrationRef='mixed-review-refund',occurredAt=new Date().toISOString(),originalProviderTransactionId=f.payment.providerTransactionId!
  const observed=await new VerifiedProviderObservationService(runner).recordRefund({scope,provider:'postar',verificationKind:'callback_signature',providerEventId:randomUUID(),integrationRef,refundPublicId:r.publicId,providerTransactionId:providerRefundId,originalProviderTransactionId,reportedAmountMinor:3000,reportedCurrency:'CNY',status:'succeeded',occurredAt,evidence:{}})
  await money.recordProviderRefundResult({...meta(),actor:{type:'integration',ref:integrationRef},verifiedObservationId:observed,refundPublicId:r.publicId,provider:'postar',providerRefundId,originalProviderTransactionId,reportedAmountMinor:3000,reportedCurrency:'CNY',succeeded:true,occurredAt})
  const reviews=new LoyaltyRefundReviewService(runner),staff=(employeeId:string)=>({scope,businessDate:date,employeeId})
  const view=(await reviews.list(staff(cashier))).find(v=>v.refundId===r.id)!
  expect(view).toMatchObject({excessAmountMinor:2000,salesRefundAmountMinor:1000})
  const proposal={basisVersion:view.basisVersion,reason:'财务明确实际销售退款为计分商品六元与不计分商品四元，另二十元为超收返还',allocations:[{orderItemId:f.item,salesRefundAmountMinor:600},{orderItemId:f.excludedItem,salesRefundAmountMinor:400}]}
  const request=await reviews.request(staff(requester),r.id,proposal,randomUUID()),decisionKey=randomUUID()
  const decision={basisVersion:view.basisVersion,decision:'approve' as const,reason:'第二人核实具体商品退款分配与超收凭证'}
  await reviews.decide(staff(cashier),request.value.requestId,decision,decisionKey)
  expect(await state(f)).toMatchObject({available_points:24,growth_value:24,restored:0,gross:6000,refunds:3000})
  await authorize(f);const receipt=await cash(f);expect(receipt.value.amountMinor).toBe(1000)
  expect(await state(f)).toMatchObject({available_points:30,growth_value:30,restored:1,awards:1,gross:7000,refunds:3000})
  expect((await pool.query('SELECT id,eligible_amount_minor::text,awarded_points,awarded_growth FROM mbox.loyalty_order_awards WHERE order_id=$1',[f.order])).rows[0]).toEqual(originalAward)
  expect((await pool.query('SELECT eligible_amount_minor::int,points_delta,growth_delta FROM mbox.loyalty_recollection_restorations WHERE order_id=$1',[f.order])).rows).toEqual([{eligible_amount_minor:600,points_delta:6,growth_delta:6}])
  const facts=(await pool.query(`SELECT application.eligible_refund_amount_minor::int AS original_eligible_refund_minor,
    application.reversed_points,application.reversed_growth,restored.eligible_amount_minor::int AS restored_eligible_minor,
    restored.points_delta,restored.growth_delta FROM mbox.loyalty_award_refund_applications application
    JOIN mbox.loyalty_recollection_restorations restored ON restored.application_id=application.id WHERE application.order_id=$1`,[f.order])).rows
  expect(facts).toEqual([{original_eligible_refund_minor:600,reversed_points:6,reversed_growth:6,restored_eligible_minor:600,points_delta:6,growth_delta:6}])
  console.info('synthetic mixed actual-goods recovery',JSON.stringify({refundMinor:3000,excessReturnedMinor:2000,salesRefundMinor:1000,eligibleGoodsMinor:600,excludedGoodsMinor:400,recollectedMinor:receipt.value.amountMinor,facts}))
  expect((await reviews.decide(staff(cashier),request.value.requestId,decision,decisionKey)).replayed).toBe(true)
  expect(await state(f)).toMatchObject({available_points:30,growth_value:30,restored:1})
 })
 it('preserves the legacy per-order-rounded award through two separately rounded partial refund/recollection cycles',async()=>{
  const f=await fixture(4000,300)
  // Explicit synthetic pre-108 model: its floor(4000/300)=13 original ledger/lot
  // matches the legacy award, which has neither exact contribution nor carry.
  // This is not claimed as execution of an old binary.
  await pool.query("UPDATE mbox.loyalty_order_awards SET calculation_model='per_order_rounded' WHERE order_id=$1",[f.order])
  await pool.query('DELETE FROM mbox.loyalty_order_reward_contributions WHERE order_id=$1',[f.order])
  await pool.query('DELETE FROM mbox.loyalty_reward_carry_balances WHERE membership_id=$1',[f.membership])
  const expiry=(await pool.query('SELECT expires_at::text FROM mbox.loyalty_point_lots WHERE membership_id=$1',[f.membership])).rows[0].expires_at
  let receipt=f.payment
  for(const [amount,reversed] of [[333,1],[777,2]]){
   await refund(f,f.payment.id,amount!);expect(await state(f)).toMatchObject({available_points:13-reversed!,growth_value:13-reversed!})
   await authorize(f);receipt=(await cash(f)).value
   expect(receipt.amountMinor).toBe(amount);expect(await state(f)).toMatchObject({available_points:13,growth_value:13,awards:1})
  }
  expect(await state(f)).toMatchObject({available_points:13,growth_value:13,restored:2,gross:5110,refunds:1110})
  expect((await pool.query('SELECT calculation_model,reversed_amount_minor::int,restored_amount_minor::int,reversed_points,restored_points FROM mbox.loyalty_order_awards WHERE order_id=$1',[f.order])).rows[0]).toEqual({calculation_model:'per_order_rounded',reversed_amount_minor:1110,restored_amount_minor:1110,reversed_points:3,restored_points:3})
  expect((await pool.query('SELECT remaining_points,expires_at::text FROM mbox.loyalty_point_lots WHERE membership_id=$1',[f.membership])).rows).toEqual([{remaining_points:13,expires_at:expiry}])
  expect((await pool.query('SELECT count(*)::int n FROM mbox.loyalty_reward_carry_balances WHERE membership_id=$1',[f.membership])).rows[0]).toEqual({n:0})
 })
})
