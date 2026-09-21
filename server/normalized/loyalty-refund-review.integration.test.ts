import {randomUUID} from 'node:crypto'
import Fastify from 'fastify'
import {Pool} from 'pg'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {PaymentCommandService} from './payment-command-service.js'
import {CustomerExperienceService} from './customer-experience-service.js'
import {LoyaltyOperationalControlService} from './loyalty-operational-control-service.js'
import {LoyaltyAccrualDeferredWorker} from './loyalty-accrual-deferred-worker.js'
import {NormalizedProviderObservationAuthority,VerifiedProviderObservationService} from './provider-verification-observation.js'
import {LoyaltyRefundReviewService} from './loyalty-refund-review-service.js'
import {LoyaltyAccrualRepository} from './loyalty-accrual-repository.js'
import {registerLoyaltyRefundReviewRoutes} from './loyalty-refund-review-api.js'
import type {LoyaltyRefundReviewRequestInput} from '../../src/shared/loyalty-refund-review.js'
const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL,runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
const integration=databaseUrl&&runtimeUrl?describe:describe.skip
const base={tenant:randomUUID(),store:randomUUID(),area:randomUUID(),table:randomUUID(),session:randomUUID(),drafter:randomUUID(),approver:randomUUID(),publisher:randomUUID(),policy:randomUUID(),product:randomUUID()}
interface Scenario {customerId:string;membershipId:string;accountId:string;orderId:string;orderPublicId:string;orderItemId:string;paymentId:string;ineligibleItemId?:string}
const scope={tenantId:base.tenant,storeId:base.store}
integration('actual-goods refund reward review with restricted LOGIN',()=>{
 let pool:Pool,runtimePool:Pool,runner:ScopedPostgresTransactionRunner,service:PaymentCommandService,customers:CustomerExperienceService,control:LoyaltyOperationalControlService,reviews:LoyaltyRefundReviewService,businessDate:string,observations:VerifiedProviderObservationService
 const app=Fastify();let actor=base.approver
 beforeAll(async()=>{
  await runNormalizedMigrations(databaseUrl!)
  pool=new Pool({connectionString:databaseUrl,max:8});runtimePool=new Pool({connectionString:runtimeUrl,max:8});runner=new ScopedPostgresTransactionRunner(runtimePool)
  const identity=(await runtimePool.query('SELECT session_user,current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=session_user')).rows[0]
  expect(identity).toMatchObject({rolsuper:false,rolbypassrls:false});expect(identity.session_user).toBe(identity.current_user)
  await seedBase(pool);await grantPermissions()
  businessDate=await runner.run(scope,async tx=>(await tx.query<{day:string}>('SELECT mbox.current_operating_business_date($1,$2)::text AS day',[base.tenant,base.store])).rows[0]!.day)
  const commands=new NormalizedCommandExecutor(runner)
  // Payment fixtures exercise real commands/ledger, with original payment approval authorization supplied by the fixture.
  // Every new review operation below uses the real permission repository and real low-privilege LOGIN.
  service=new PaymentCommandService(commands,{assertEmployeeCapability:async()=>{},assertEmployeeOrderAccess:async()=>{},assertRefundRequestLimit:async()=>{},assertRefundApproval:async()=>{}},new NormalizedProviderObservationAuthority())
  customers=new CustomerExperienceService(runner,commands,{updateProfile:async()=>{throw new Error('unused')}})
  control=new LoyaltyOperationalControlService(runner,commands);observations=new VerifiedProviderObservationService(runner);reviews=new LoyaltyRefundReviewService(runner)
  await app.register(async api=>registerLoyaltyRefundReviewRoutes(api,{transactions:runner,resolveStaffContext:()=>staff(actor)}),{prefix:'/api'})
 },30000)
 afterAll(async()=>{await app.close();await runtimePool?.end();await pool?.end()})
 const meta=(employeeId=base.approver)=>({scope,businessDate,actor:{type:'employee' as const,employeeId},idempotencyKey:randomUUID(),requestFingerprint:randomUUID()})
 const staff=(employeeId=base.approver)=>({scope,businessDate,employeeId})
 async function grantPermissions(){
  const role=randomUUID();await pool.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'FINANCIAL_REVIEW_TEST','Synthetic finance reviewer')",[role,...Object.values(scope)])
  for(const employee of [base.drafter,base.approver,base.publisher])await pool.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 hour')",[...Object.values(scope),employee,role])
  for(const code of ['reconciliation.view','reconciliation.manage','loyalty.accrual.exception.view','loyalty.accrual.request','loyalty.accrual.approve']){
   const id=(await pool.query("INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category) VALUES($1,$2,$3,$3,'finance') ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET name=EXCLUDED.name RETURNING id",[...Object.values(scope),code])).rows[0].id
   await pool.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) VALUES($1,$2,$3,$4)',[...Object.values(scope),role,id])
  }
 }
 async function pay(s:Scenario,amountMinor?:number){return(await service.recordManual({...meta(),orderId:s.orderId,...(amountMinor===undefined?{}:{orderIds:[s.orderId],amountMinor}),publicId:'cash-'+randomUUID(),provider:'cash',method:'cash',evidence:{receiptReference:'cash-'+randomUUID(),collectedByEmployeeId:base.approver}})).value}
 async function snapshot(s:Scenario){return(await pool.query(`SELECT a.available_points,a.growth_value,a.pending_recovery_points,w.eligible_amount_minor::text,w.reversed_amount_minor::text,
  (SELECT count(*)::int FROM mbox.loyalty_order_awards WHERE order_id=$2) AS awards,
  (SELECT count(*)::int FROM mbox.loyalty_award_refund_applications WHERE order_id=$2) AS applications,
  (SELECT count(*)::int FROM mbox.loyalty_refund_reviews WHERE order_id=$2) AS reviews,
  (SELECT count(*)::int FROM mbox.loyalty_unresolved_refund_reviews WHERE order_id=$2) AS pending,
  (SELECT count(*)::int FROM mbox.refunds WHERE order_id=$2 AND status='succeeded') AS refunds,
  (SELECT count(*)::int FROM mbox.inventory_movements movement JOIN mbox.order_items item
    ON (item.tenant_id,item.store_id,item.id)=(movement.tenant_id,movement.store_id,movement.order_item_id) WHERE item.order_id=$2) AS inventory
  FROM mbox.loyalty_accounts a LEFT JOIN mbox.loyalty_order_awards w ON w.membership_id=a.membership_id WHERE a.id=$1`,[s.accountId,s.orderId])).rows[0]}
 async function complete(refundId:string){
  await service.beginRefundExecution({...meta(),refundId})
  const source=(await pool.query('SELECT refund.public_id,refund.amount_minor::int,payment.provider_transaction_id FROM mbox.refunds refund JOIN mbox.payments payment ON payment.id=refund.payment_id WHERE refund.id=$1',[refundId])).rows[0]
  const occurredAt=new Date().toISOString(),providerRefundId='pr-'+randomUUID(),integrationRef='review-refund-test',providerSnapshot={signatureVerified:true,refundState:'SUCCESS'}
  const verifiedObservationId=await observations.recordRefund({scope,provider:'postar',verificationKind:'callback_signature',providerEventId:'event-'+randomUUID(),integrationRef,refundPublicId:source.public_id,providerTransactionId:providerRefundId,originalProviderTransactionId:source.provider_transaction_id,reportedAmountMinor:source.amount_minor,reportedCurrency:'CNY',status:'succeeded',occurredAt,evidence:providerSnapshot})
  return service.recordProviderRefundResult({...meta(),actor:{type:'integration',ref:integrationRef},verifiedObservationId,refundPublicId:source.public_id,provider:'postar',providerRefundId,originalProviderTransactionId:source.provider_transaction_id,reportedAmountMinor:source.amount_minor,reportedCurrency:'CNY',succeeded:true,providerSnapshot,occurredAt})
 }
 async function refund(s:Scenario,paymentId:string,allocations:Array<{orderItemId:string;amountMinor:number}>){
  const r=(await service.requestRefund({...meta(base.drafter),paymentId,publicId:'refund-'+randomUUID(),reason:'实际商品归属测试退款',purpose:'price_adjustment',allocations})).value
  await service.approveRefund({...meta(),refundId:r.id,decisionReason:'独立核对原款'});await complete(r.id);return r
 }
 async function initiate(s:Scenario){return(await service.initiate({...meta(),orderId:s.orderId,publicId:'online-'+randomUUID(),provider:'postar',method:'native_qr',principal:{type:'employee',employeeId:base.approver}})).value}
 async function capture(payment:{publicId:string;amountMinor:number}){
  const occurredAt=new Date().toISOString(),providerTransactionId='txn-'+randomUUID(),integrationRef='financial-review-test',providerSnapshot={signatureVerified:true,tradeState:'SUCCESS'}
  const verifiedObservationId=await observations.recordPayment({scope,provider:'postar',verificationKind:'callback_signature',providerEventId:'event-'+randomUUID(),integrationRef,paymentPublicId:payment.publicId,providerTransactionId,reportedAmountMinor:payment.amountMinor,reportedCurrency:'CNY',status:'succeeded',settlementChannel:'wechat',occurredAt,evidence:providerSnapshot})
  return(await service.recordSucceededCallback({...meta(),actor:{type:'integration',ref:integrationRef},verifiedObservationId,paymentPublicId:payment.publicId,provider:'postar',providerTransactionId,reportedAmountMinor:payment.amountMinor,reportedCurrency:'CNY',settlementChannel:'wechat',providerSnapshot,occurredAt})).value
 }
 async function mixed(options:Parameters<typeof createScenario>[1]={}){
  const s=await createScenario(pool,{ineligibleAmountMinor:2000,...options}),pending=await initiate(s);await pay(s,5000);const online=await capture(pending)
  const r=await refund(s,online.id,[{orderItemId:s.orderItemId,amountMinor:6000},{orderItemId:s.ineligibleItemId!,amountMinor:2000}])
  return {s,r,online}
 }
 async function view(id:string){return(await reviews.list(staff())).find(r=>r.refundId===id)!}
 async function proposal(s:Scenario,id:string,eligible=2000):Promise<LoyaltyRefundReviewRequestInput>{
  const v=await view(id);return {basisVersion:v.basisVersion,reason:'财务逐笔核实真实退货商品及原退款凭证',allocations:[{orderItemId:s.orderItemId,salesRefundAmountMinor:eligible},...(3000-eligible>0?[{orderItemId:s.ineligibleItemId!,salesRefundAmountMinor:3000-eligible}]:[])]}
 }
 async function approve(requestId:string,basisVersion:string,key=randomUUID()){return reviews.decide(staff(),requestId,{basisVersion,decision:'approve',reason:'第二人核实实际退货商品与超收部分'},key)}

 it('separates actual goods from 50 excess, applies original carry once, and persists recovery receipts',async()=>{
  const {s,r}=await mixed({multiplierNumerator:3,multiplierDenominator:2})
  expect(await snapshot(s)).toMatchObject({available_points:120,growth_value:80,pending:1,applications:0})
  const v=await view(r.id);expect(v).toMatchObject({refundAmountMinor:8000,excessAmountMinor:5000,salesRefundAmountMinor:3000})
  const input=await proposal(s,r.id),key=randomUUID(),request=await reviews.request(staff(base.drafter),r.id,input,key)
  expect((await reviews.request(staff(base.drafter),r.id,input,key)).replayed).toBe(true)
  const decisionKey=randomUUID(),result=await approve(request.value.requestId,input.basisVersion,decisionKey)
  expect(result.value).toMatchObject({status:'approved',pointsDelta:-30,growthDelta:-20})
  expect(await snapshot(s)).toMatchObject({available_points:90,growth_value:60,awards:1,pending:0,applications:1,refunds:1,inventory:0,reversed_amount_minor:'2000'})
  // Expiring generic idempotency cache cannot discard the permanent financial receipt.
  await pool.query('DELETE FROM mbox.idempotency_records WHERE tenant_id=$1 AND store_id=$2 AND expires_at<clock_timestamp()',[base.tenant,base.store])
  expect((await approve(request.value.requestId,input.basisVersion,decisionKey)).replayed).toBe(true)
  expect((await reviews.request(staff(base.drafter),r.id,input,key)).value).toEqual(request.value)
  await expect(reviews.request(staff(base.drafter),r.id,{...input,reason:'另一内容不能复用原键'},key)).rejects.toMatchObject({name:'IdempotencyConflictError'})
  expect(await snapshot(s)).toMatchObject({available_points:90,applications:1,refunds:1,inventory:0})
  await expect(runner.run(scope,tx=>tx.query('UPDATE mbox.loyalty_refund_review_decisions SET reason=$1 WHERE request_id=$2',['attempt overwrite',request.value.requestId]))).rejects.toMatchObject({code:'42501'})
 })
 it('uses explicitly identified merchandise instead of inventing a proportional refund rule',async()=>{
  const {s,r}=await mixed(),input=await proposal(s,r.id,3000),request=await reviews.request(staff(base.drafter),r.id,input,randomUUID())
  await approve(request.value.requestId,input.basisVersion)
  expect(await snapshot(s)).toMatchObject({available_points:50,growth_value:50,pending:0,applications:1,reversed_amount_minor:'3000'})
 })
 it('rejects duplicate goods, excess sale amount, self review, superseded requests and cross scope',async()=>{
  const {s,r}=await mixed(),input=await proposal(s,r.id)
  await expect(reviews.request(staff(base.drafter),r.id,{...input,allocations:[input.allocations[0]!,input.allocations[0]!] },randomUUID())).rejects.toMatchObject({code:'LOYALTY_REVIEW_INVALID',commitDisposition:'not_committed'})
  await expect(reviews.request(staff(base.drafter),r.id,{...input,allocations:[{orderItemId:s.orderItemId,salesRefundAmountMinor:8000}]},randomUUID())).rejects.toMatchObject({code:'LOYALTY_REVIEW_INVALID'})
  const first=await reviews.request(staff(base.drafter),r.id,input,randomUUID())
  await expect(reviews.decide(staff(base.drafter),first.value.requestId,{basisVersion:input.basisVersion,decision:'approve',reason:'本人不能自审'},randomUUID())).rejects.toMatchObject({code:'LOYALTY_REVIEW_SELF_APPROVAL'})
  const second=await reviews.request(staff(base.drafter),r.id,input,randomUUID())
  await expect(approve(first.value.requestId,input.basisVersion)).rejects.toMatchObject({code:'LOYALTY_REVIEW_SUPERSEDED'})
  const alien=await runner.run({tenantId:randomUUID(),storeId:randomUUID()},tx=>tx.query('SELECT * FROM mbox.loyalty_refund_review_requests WHERE id=$1',[second.value.requestId]))
  expect(alien.rows).toEqual([])
  await reviews.decide(staff(),second.value.requestId,{basisVersion:input.basisVersion,decision:'reject',reason:'依据不足退回补证'},randomUUID())
  expect(await snapshot(s)).toMatchObject({available_points:80,pending:1,applications:0})
  await expect(approve(second.value.requestId,input.basisVersion)).rejects.toMatchObject({code:'LOYALTY_REVIEW_ALREADY_DECIDED'})
 })
 it('serializes concurrent approvals and lost-response replays without double reward or refund',async()=>{
  const {s,r}=await mixed(),input=await proposal(s,r.id),request=await reviews.request(staff(base.drafter),r.id,input,randomUUID())
  const key=randomUUID(),lock=await pool.connect();await lock.query('BEGIN');await lock.query('SELECT id FROM mbox.orders WHERE id=$1 FOR UPDATE',[s.orderId])
  const competing=Promise.all([approve(request.value.requestId,input.basisVersion,key),approve(request.value.requestId,input.basisVersion,key)])
  let waiting=0
  try{for(let n=0;n<100&&waiting<2;n++){waiting=(await pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rows[0].n;if(waiting<2)await new Promise(resolve=>setTimeout(resolve,10))}}
  finally{await lock.query('COMMIT');lock.release()}
  const results=await competing;expect(waiting).toBeGreaterThanOrEqual(2);expect(results.filter(r=>r.replayed)).toHaveLength(1)
  expect(results[0]!.value).toEqual(results[1]!.value)
  expect(await snapshot(s)).toMatchObject({available_points:60,growth_value:60,awards:1,applications:1,refunds:1,pending:0})
 })
 it('revalidates old proposals against later refunds, then resumes them in financial order',async()=>{
  const {s,r,online}=await mixed(),input=await proposal(s,r.id),old=await reviews.request(staff(base.drafter),r.id,input,randomUUID())
  const later=await refund(s,online.id,[{orderItemId:s.orderItemId,amountMinor:1000}])
  expect(await snapshot(s)).toMatchObject({pending:2,applications:0,refunds:2})
  await expect(approve(old.value.requestId,input.basisVersion)).rejects.toMatchObject({code:'LOYALTY_REVIEW_STALE'})
  const blocked=await view(later.id)
  await expect(reviews.request(staff(base.drafter),later.id,{basisVersion:blocked.basisVersion,reason:'必须先处理更早退款',allocations:[{orderItemId:s.orderItemId,salesRefundAmountMinor:1000}]},randomUUID())).rejects.toMatchObject({code:'LOYALTY_REVIEW_ORDER_BLOCKED'})
  const fresh=await proposal(s,r.id),request=await reviews.request(staff(base.drafter),r.id,fresh,randomUUID());await approve(request.value.requestId,fresh.basisVersion)
  const next=await view(later.id),nextRequest=await reviews.request(staff(base.drafter),later.id,{basisVersion:next.basisVersion,reason:'按原商品补齐后续退款归属',allocations:[{orderItemId:s.orderItemId,salesRefundAmountMinor:1000}]},randomUUID());await approve(nextRequest.value.requestId,next.basisVersion)
  expect(await snapshot(s)).toMatchObject({available_points:50,growth_value:50,pending:0,applications:2,refunds:2})
  await refund(s,online.id,[{orderItemId:s.orderItemId,amountMinor:1000}])
  expect(await snapshot(s)).toMatchObject({available_points:40,growth_value:40,pending:0,applications:3,refunds:3})
 })
 it('replays committed responses through the API and hides them after current permission revocation',async()=>{
  const {s,r}=await mixed(),input=await proposal(s,r.id),key=randomUUID();actor=base.drafter
  const response=await app.inject({method:'POST',url:`/api/staff/loyalty/refund-reviews/${r.id}/requests`,headers:{'idempotency-key':key},payload:input})
  expect(response.statusCode,response.body).toBe(200)
  const replay=await app.inject({method:'POST',url:`/api/staff/loyalty/refund-reviews/${r.id}/requests`,headers:{'idempotency-key':key},payload:input});expect(replay.json().meta.replayed).toBe(true)
  const conflict=await app.inject({method:'POST',url:`/api/staff/loyalty/refund-reviews/${r.id}/requests`,headers:{'idempotency-key':key},payload:{...input,reason:'different evidence'}});expect(conflict.statusCode).toBe(409);expect(conflict.json().error.commitDisposition).toBeUndefined()
  await pool.query("UPDATE mbox.employees SET status='suspended' WHERE id=$1",[base.drafter])
  try{const denied=await app.inject({method:'POST',url:`/api/staff/loyalty/refund-reviews/${r.id}/requests`,headers:{'idempotency-key':key},payload:input});expect(denied.statusCode).toBe(403);expect(denied.json().data).toBeUndefined();expect(denied.json().error.commitDisposition).toBeUndefined()}
  finally{await pool.query("UPDATE mbox.employees SET status='active' WHERE id=$1",[base.drafter]);actor=base.approver}
  const listed=await app.inject('/api/staff/loyalty/refund-reviews');expect(listed.statusCode,listed.body).toBe(200);expect(listed.json().meta.scopeKey).toBe(`${base.tenant}:${base.store}`)
 })

 it('carries fractional original reward numerators through review and later ordinary refunds',async()=>{
  const {s,r,online}=await mixed({multiplierNumerator:3,multiplierDenominator:2}),input=await proposal(s,r.id,2001),request=await reviews.request(staff(base.drafter),r.id,input,randomUUID())
  await approve(request.value.requestId,input.basisVersion)
  expect(await snapshot(s)).toMatchObject({available_points:89,growth_value:59,reversed_amount_minor:'2001'})
  await refund(s,online.id,[{orderItemId:s.orderItemId,amountMinor:1999}])
  expect(await snapshot(s)).toMatchObject({available_points:60,growth_value:40,reversed_amount_minor:'4000',applications:2,pending:0})
 })
 it('requires explicit historical per-refund goods evidence and preserves the already-applied reward',async()=>{
  const s=await createScenario(pool,{ineligibleAmountMinor:2000}),secondItem=randomUUID()
  await pool.query('UPDATE mbox.orders SET subtotal_amount_minor=12000,total_amount_minor=12000 WHERE id=$1',[s.orderId])
  await pool.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot,loyalty_eligible_at_submission,loyalty_eligibility_source,status)
    VALUES($1,$2,$3,$4,$5,1,2000,2000,'bar','{"inventoryControlMode":"not_managed"}',true,'catalog_product','submitted')`,[secondItem,base.tenant,base.store,s.orderId,base.product])
  const pending=await initiate(s),late=(await service.initiate({...meta(),orderId:s.orderId,orderIds:[s.orderId],amountMinor:3000,publicId:randomUUID(),provider:'postar',method:'native_qr',principal:{type:'employee',employeeId:base.approver}})).value
  await pay(s,5000);const online=await capture(pending)
  const historical=await refund(s,online.id,[{orderItemId:s.orderItemId,amountMinor:4000},{orderItemId:secondItem,amountMinor:2000}])
  expect(await snapshot(s)).toMatchObject({available_points:90,growth_value:90,applications:1,pending:0})
  const later=await capture(late),r=await refund(s,online.id,[{orderItemId:s.orderItemId,amountMinor:2000},{orderItemId:s.ineligibleItemId!,amountMinor:2000}])
  const v=await view(r.id);expect(v).toMatchObject({excessAmountMinor:2000,salesRefundAmountMinor:2000});expect(v.historicalRefunds).toHaveLength(1)
  expect(v.historicalRefunds[0]).toMatchObject({refundId:historical.id,salesRefundAmountMinor:1000})
  const input:LoyaltyRefundReviewRequestInput={basisVersion:v.basisVersion,reason:'原退款两件计分商品逐笔提供退货凭证',allocations:[{orderItemId:s.orderItemId,salesRefundAmountMinor:1000},{orderItemId:s.ineligibleItemId!,salesRefundAmountMinor:1000}]}
  await expect(reviews.request(staff(base.drafter),r.id,input,randomUUID())).rejects.toMatchObject({code:'LOYALTY_REVIEW_INVALID'})
  input.historicalAllocations=[{refundId:historical.id,allocations:[{orderItemId:s.orderItemId,salesRefundAmountMinor:500},{orderItemId:secondItem,salesRefundAmountMinor:500}]}]
  const requested=await reviews.request(staff(base.drafter),r.id,input,randomUUID());await approve(requested.value.requestId,input.basisVersion)
  expect(await snapshot(s)).toMatchObject({available_points:80,growth_value:80,applications:2,pending:0,refunds:2})
  const original=(await pool.query('SELECT eligible_refund_amount_minor::int amount FROM mbox.loyalty_award_refund_applications WHERE refund_id=$1',[historical.id])).rows[0]
  expect(original.amount).toBe(1000)
  // A later refund can now resume with persisted evidence, without asking to rewrite historical facts.
  await refund(s,later.id,[{orderItemId:s.orderItemId,amountMinor:1000}]);expect(await snapshot(s)).toMatchObject({available_points:70,growth_value:70,applications:3,pending:0})
  expect(await runner.run(scope,tx=>new LoyaltyAccrualRepository(tx).refundEconomicFacts({orderId:s.orderId,paymentId:online.id,refundId:historical.id}))).toMatchObject({total:6000,excess:5000})
 })
 it('unblocks an older supplement only after review approval, then worker replay preserves one award',async()=>{
  const s=await createScenario(pool,{ineligibleAmountMinor:2000}),pending=await initiate(s)
  const pause=async(operation:'pause'|'resume')=>{const value=(await control.list(staff())).find(row=>row.capability==='points_accrual')!;return control.set(staff(),{capability:'points_accrual',operation,reason:'验证待核闭环后补发接续',reviewAt:null,expectedVersion:value.version,idempotencyKey:randomUUID()})}
  await pause('pause');await pay(s,5000);const online=await capture(pending);await pause('resume')
  const supplemental=await customers.requestLoyaltySupplement(staff(base.drafter),{orderPublicId:s.orderPublicId,reason:'原缺奖记录申请补发',idempotencyKey:randomUUID()})
  await new LoyaltyAccrualDeferredWorker(runner).runBatch(scope,'review-closure-worker')
  const r=await refund(s,online.id,[{orderItemId:s.orderItemId,amountMinor:6000},{orderItemId:s.ineligibleItemId!,amountMinor:2000}]),decision={publicId:supplemental.value.publicId,decision:'approve' as const,reason:'核对原款与退款完成状态',idempotencyKey:randomUUID()}
  await expect(customers.decideLoyaltySupplement(staff(),decision)).rejects.toMatchObject({code:'LOYALTY_REFUND_REVIEW_REQUIRED'})
  const input=await proposal(s,r.id),requested=await reviews.request(staff(base.drafter),r.id,input,randomUUID());await approve(requested.value.requestId,input.basisVersion)
  expect((await customers.decideLoyaltySupplement(staff(),decision)).value.status).toBe('not_required')
  await new LoyaltyAccrualDeferredWorker(runner).runBatch(scope,'review-closure-worker')
  expect(await snapshot(s)).toMatchObject({available_points:60,growth_value:60,awards:1,applications:1,pending:0})
 })

 it('closes a later proven all-excess refund with no goods and no reward deduction',async()=>{
  const s=await createScenario(pool,{ineligibleAmountMinor:2000}),pending=await initiate(s)
  const extra=(await service.initiate({...meta(),orderId:s.orderId,orderIds:[s.orderId],amountMinor:5000,publicId:randomUUID(),provider:'postar',method:'native_qr',principal:{type:'employee',employeeId:base.approver}})).value
  await pay(s,5000);const online=await capture(pending)
  const r=await refund(s,online.id,[{orderItemId:s.orderItemId,amountMinor:6000},{orderItemId:s.ineligibleItemId!,amountMinor:2000}]);await capture(extra)
  const next=await refund(s,online.id,[{orderItemId:s.orderItemId,amountMinor:1000}])
  const input=await proposal(s,r.id),requested=await reviews.request(staff(base.drafter),r.id,input,randomUUID());await approve(requested.value.requestId,input.basisVersion)
  const v=await view(next.id);expect(v).toMatchObject({excessAmountMinor:1000,salesRefundAmountMinor:0,items:expect.any(Array)})
  const empty={basisVersion:v.basisVersion,reason:'核对第二笔纯超收原款，实际未退商品',allocations:[]},request=await reviews.request(staff(base.drafter),next.id,empty,randomUUID())
  expect((await approve(request.value.requestId,v.basisVersion)).value).toMatchObject({pointsDelta:0,growthDelta:0})
  expect(await snapshot(s)).toMatchObject({available_points:60,growth_value:60,pending:0,applications:2,refunds:2})
 })
 it('allows only one decision when independent reviewers concurrently submit distinct command keys',async()=>{
  const {s,r}=await mixed(),input=await proposal(s,r.id),request=await reviews.request(staff(base.drafter),r.id,input,randomUUID())
  const outcomes=await Promise.allSettled([approve(request.value.requestId,input.basisVersion),reviews.decide(staff(base.publisher),request.value.requestId,{basisVersion:input.basisVersion,decision:'approve',reason:'另一独立复核员并发提交'},randomUUID())])
  expect(outcomes.filter(outcome=>outcome.status==='fulfilled')).toHaveLength(1)
  expect(outcomes.find(outcome=>outcome.status==='rejected')).toMatchObject({reason:{code:'LOYALTY_REVIEW_ALREADY_DECIDED'}})
  expect(await snapshot(s)).toMatchObject({available_points:60,growth_value:60,applications:1,refunds:1,pending:0})
 })

})
async function createScenario(
  pool: Pool,
  options: Readonly<{ multiplierNumerator?: number; multiplierDenominator?: number; ineligibleAmountMinor?:number }> = {},
): Promise<Scenario> {
  const scenario: Scenario = {
    customerId: randomUUID(), membershipId: randomUUID(), accountId: randomUUID(),
    orderId: randomUUID(), orderPublicId: '', orderItemId: randomUUID(), paymentId: randomUUID(),
  }
  scenario.orderPublicId = `loyalty-consistency-${scenario.orderId.slice(0, 12)}`
  const memberNo = `MBX${scenario.membershipId.replaceAll('-', '').slice(0, 16).toUpperCase()}`
  await pool.query(`
    INSERT INTO mbox.customers(id,tenant_id,store_id,public_id,status)
    VALUES($1,$2,$3,$4,'active')
  `, [scenario.customerId, base.tenant, base.store, `customer-${scenario.customerId.slice(0, 12)}`])
  await pool.query(`
    INSERT INTO mbox.customer_memberships(id,tenant_id,store_id,customer_id,member_no,level,status)
    VALUES($1,$2,$3,$4,$5,'member','active')
  `, [scenario.membershipId, base.tenant, base.store, scenario.customerId, memberNo])
  await pool.query(`
    INSERT INTO mbox.loyalty_accounts(id,tenant_id,store_id,membership_id,customer_id)
    VALUES($1,$2,$3,$4,$5)
  `, [scenario.accountId, base.tenant, base.store, scenario.membershipId, scenario.customerId])
  await pool.query(`
    INSERT INTO mbox.orders(
      id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,
      subtotal_amount_minor,discount_amount_minor,total_amount_minor,currency,
      created_by_customer_id,submitted_at,settlement_mode,fulfillment_state,
      loyalty_policy_version_id,loyalty_points_multiplier_numerator,
      loyalty_points_multiplier_denominator
    ) VALUES($1,$2,$3,$4,$5,'guest_qr','submitted','unpaid',$10,0,$10,'CNY',$6,
      '2026-08-16T05:55:00Z','immediate_payment','active',$7,$8,$9)
  `, [
    scenario.orderId, base.tenant, base.store, base.session, scenario.orderPublicId,
    scenario.customerId, base.policy,
    options.multiplierNumerator ?? 1, options.multiplierDenominator ?? 1, 8000+(options.ineligibleAmountMinor??0),
  ])
  await pool.query(`
    INSERT INTO mbox.order_items(
      id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,
      discount_amount_minor,total_amount_minor,currency,fulfillment_station,
      product_snapshot,loyalty_eligible_at_submission,loyalty_eligibility_source,status
    ) VALUES($1,$2,$3,$4,$5,4,2000,0,8000,'CNY','bar','{"inventoryControlMode":"not_managed"}',true,'catalog_product','submitted')
  `, [scenario.orderItemId, base.tenant, base.store, scenario.orderId, base.product])
  if(options.ineligibleAmountMinor){
    scenario.ineligibleItemId=randomUUID()
    await pool.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,discount_amount_minor,total_amount_minor,currency,fulfillment_station,product_snapshot,loyalty_eligible_at_submission,loyalty_eligibility_source,status)
    VALUES($1,$2,$3,$4,$5,1,$6,0,$6,'CNY','bar','{"inventoryControlMode":"not_managed"}',false,'catalog_product','submitted')`,[scenario.ineligibleItemId,base.tenant,base.store,scenario.orderId,base.product,options.ineligibleAmountMinor])
  }
  return scenario
}

async function seedBase(pool: Pool) {
  const suffix = base.tenant.replaceAll('-', '').slice(0, 10)
  await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Loyalty Consistency Tenant')`,
    [base.tenant, `lc-${suffix}`])
  await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,$3,'Loyalty Consistency Store')`,
    [base.store, base.tenant, `lc-${suffix}`])
  await pool.query(`
    INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name,status) VALUES
      ($1,$4,$5,$6,'Consistency Drafter','active'),
      ($2,$4,$5,$7,'Consistency Approver','active'),
      ($3,$4,$5,$8,'Consistency Publisher','active')
  `, [
    base.drafter, base.approver, base.publisher, base.tenant, base.store,
    `LCD-${suffix}`, `LCA-${suffix}`, `LCP-${suffix}`,
  ])
  await pool.query(`
    INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type)
    VALUES($1,$2,$3,$4,'Consistency Area','bar')
  `, [base.area, base.tenant, base.store, `LCA-${suffix}`])
  await pool.query(`
    INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity,status)
    VALUES($1,$2,$3,$4,$5,'Consistency Table',4,'available')
  `, [base.table, base.tenant, base.store, base.area, `LCT-${suffix}`])
  await pool.query(`
    INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status)
    VALUES($1,$2,$3,$4,$5,'2026-08-16',2,'open')
  `, [base.session, base.tenant, base.store, base.table, `consistency-session-${suffix}`])
  await pool.query(`
    INSERT INTO mbox.loyalty_policy_versions(
      id,tenant_id,store_id,policy_code,version,status,
      points_numerator,points_denominator_minor,growth_numerator,growth_denominator_minor,
      rounding_mode,points_validity_months,effective_from,drafted_by_employee_id,
      approved_by_employee_id,approved_at,published_by_employee_id,published_at,
      publication_mode,reason
    ) VALUES($1,$2,$3,'BASE',1,'published',1,100,1,100,'floor',18,
      '2026-08-01T00:00:00Z',$4,$5,'2026-08-01T00:00:00Z',$6,'2026-08-01T00:01:00Z',
      'separated','退款与漏积分一致性测试规则')
  `, [base.policy, base.tenant, base.store, base.drafter, base.approver, base.publisher])
  await pool.query(`
    INSERT INTO mbox.products(
      id,tenant_id,store_id,code,name,category_code,fulfillment_station,status,loyalty_eligible
    ) VALUES($1,$2,$3,$4,'Consistency Product','drink','bar','active',true)
  `, [base.product, base.tenant, base.store, `LCP-${suffix}`])
}
