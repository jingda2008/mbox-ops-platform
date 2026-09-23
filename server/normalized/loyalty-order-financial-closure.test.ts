import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {afterAll,afterEach,beforeAll,describe,expect,it} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner,type PostgresPool} from './transaction-runner.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {PaymentCommandService} from './payment-command-service.js'
import {ItemQuantityRepository} from './item-quantity-repository.js'
import {ItemUnitInventoryRepository} from './item-unit-inventory-repository.js'
import {ItemQuantityReceivableRepository} from './item-quantity-receivable-repository.js'
import {ItemQuantityRefundRepository} from './item-quantity-refund-repository.js'
import {CustomerExperienceService} from './customer-experience-service.js'
import {LoyaltyOperationalControlService} from './loyalty-operational-control-service.js'
import {LoyaltyAccrualDeferredWorker} from './loyalty-accrual-deferred-worker.js'
import {NormalizedProviderObservationAuthority,VerifiedProviderObservationService} from './provider-verification-observation.js'
const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const integration=databaseUrl?describe:describe.skip
const base={tenant:randomUUID(),store:randomUUID(),area:randomUUID(),table:randomUUID(),session:randomUUID(),drafter:randomUUID(),approver:randomUUID(),publisher:randomUUID(),policy:randomUUID(),product:randomUUID()}
interface Scenario {customerId:string;membershipId:string;accountId:string;orderId:string;orderPublicId:string;orderItemId:string;paymentId:string;ineligibleItemId?:string}
const scope={tenantId:base.tenant,storeId:base.store}
integration('loyalty order financial closure PostgreSQL integration',()=>{
 let pool:Pool, runner:ScopedPostgresTransactionRunner, service:PaymentCommandService, customers:CustomerExperienceService,control:LoyaltyOperationalControlService, businessDate:string, observations:VerifiedProviderObservationService
 beforeAll(async()=>{
  await runNormalizedMigrations(databaseUrl!)
  pool=new Pool({connectionString:databaseUrl,max:8});runner=new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
  await seedBase(pool)
  businessDate=await runner.run(scope,async tx=>(await tx.query<{day:string}>('SELECT mbox.current_operating_business_date($1,$2)::text AS day',[base.tenant,base.store])).rows[0]!.day)
  const commands=new NormalizedCommandExecutor(runner)
  service=new PaymentCommandService(commands,{assertEmployeeCapability:async()=>{},assertEmployeeOrderAccess:async()=>{},assertRefundRequestLimit:async()=>{},assertRefundApproval:async()=>{}},new NormalizedProviderObservationAuthority())
  customers=new CustomerExperienceService(runner,commands,{updateProfile:async()=>{throw new Error('unused')}})
  control=new LoyaltyOperationalControlService(runner,commands);observations=new VerifiedProviderObservationService(runner)
 })
 afterEach(async()=>{
  if(control&&(await control.list(staff())).some(row=>row.capability==='points_accrual'&&row.state==='paused'))await pause('resume')
 })
 afterAll(async()=>pool?.end())
 const meta=(employeeId=base.approver)=>({scope,businessDate,actor:{type:'employee' as const,employeeId},idempotencyKey:randomUUID(),requestFingerprint:randomUUID()})
 const staff=(employeeId=base.approver)=>({scope,businessDate,employeeId})
 async function pay(s:Scenario,amountMinor?:number,others:Scenario[]=[]){return(await service.recordManual({...meta(),orderId:s.orderId,...(amountMinor===undefined&&others.length===0?{}:{orderIds:[s.orderId,...others.map(o=>o.orderId)],...(amountMinor===undefined?{}:{amountMinor})}),publicId:'cash-'+randomUUID(),provider:'cash',method:'cash',evidence:{receiptReference:'cash-'+randomUUID(),collectedByEmployeeId:base.approver}})).value}
 async function snapshot(s:Scenario){return(await pool.query(`SELECT a.available_points,a.growth_value,a.pending_recovery_points,w.eligible_amount_minor::text,w.reversed_amount_minor::text,w.payment_id AS award_payment_id,o.payment_status,mbox.order_receivable_amount(o.tenant_id,o.store_id,o.id)::text AS effective_minor,
 (SELECT count(*)::int FROM mbox.loyalty_award_refund_applications WHERE order_id=o.id) AS applications,
 (SELECT count(*)::int FROM mbox.loyalty_refund_reviews WHERE order_id=o.id) AS reviews,
 (SELECT count(*)::int FROM mbox.refunds WHERE order_id=o.id AND status='succeeded') AS refunds
 FROM mbox.loyalty_accounts a LEFT JOIN mbox.loyalty_order_awards w ON w.membership_id=a.membership_id JOIN mbox.orders o ON o.id=$2 WHERE a.id=$1`,[s.accountId,s.orderId])).rows[0]}
 async function requestRefund(s:Scenario,paymentId:string,amountMinor=2000){return(await service.requestRefund({...meta(base.drafter),paymentId,publicId:'refund-'+randomUUID(),reason:'真实资金闭环验证',purpose:'price_adjustment',allocations:[{orderItemId:s.orderItemId,amountMinor}]})).value}
 async function complete(refundId:string,succeeded=true){
  await service.beginRefundExecution({...meta(),refundId})
  const source=(await pool.query(`SELECT refund.public_id,refund.amount_minor::int,payment.provider,payment.provider_transaction_id FROM mbox.refunds refund JOIN mbox.payments payment ON payment.id=refund.payment_id WHERE refund.id=$1`,[refundId])).rows[0]
  if(source.provider==='postar'){
   const occurredAt=new Date().toISOString(),providerRefundId='pr-'+randomUUID(),integrationRef='financial-refund-test',providerSnapshot={signatureVerified:true,refundState:succeeded?'SUCCESS':'FAILED'}
   const verifiedObservationId=await observations.recordRefund({scope,provider:'postar',verificationKind:'callback_signature',providerEventId:'event-'+randomUUID(),integrationRef,refundPublicId:source.public_id,providerTransactionId:providerRefundId,originalProviderTransactionId:source.provider_transaction_id,reportedAmountMinor:source.amount_minor,reportedCurrency:'CNY',status:succeeded?'succeeded':'failed',occurredAt,evidence:providerSnapshot})
   const command={...meta(),actor:{type:'integration' as const,ref:integrationRef},verifiedObservationId,refundPublicId:source.public_id,provider:'postar' as const,providerRefundId,originalProviderTransactionId:source.provider_transaction_id,reportedAmountMinor:source.amount_minor,reportedCurrency:'CNY',succeeded,providerSnapshot,occurredAt}
   const result=await service.recordProviderRefundResult(command)
   expect((await service.recordProviderRefundResult(command)).replayed).toBe(true)
   return result
  }
  const command={...meta(),refundId,succeeded,receiptReference:'receipt-'+randomUUID(),providerSnapshot:{test:true}}
  const result=await service.recordManualRefundResult(command),replay=await service.recordManualRefundResult(command)
  expect(replay.replayed).toBe(true);return result
 }
 async function refund(s:Scenario,paymentId:string,amountMinor=2000){const r=await requestRefund(s,paymentId,amountMinor);await service.approveRefund({...meta(),refundId:r.id,decisionReason:'独立审核'});return complete(r.id)}
 async function stop(s:Scenario,quantity=1){return runner.run(scope,async tx=>{
  const held=await new ItemQuantityRepository(tx).hold({orderItemId:s.orderItemId,quantity,kind:'unpaid_stop',employeeId:base.drafter,businessDate,reason:'未付先停'})
  await new ItemUnitInventoryRepository(tx).disposeUnmadeUnits({itemId:s.orderItemId,unitIds:held.unitIds,employeeId:base.drafter,caseId:held.caseId})
  return new ItemQuantityReceivableRepository(tx).recordUnpaidReduction({caseId:held.caseId,employeeId:base.drafter,businessDate})
 })}
 async function quantityReturn(s:Scenario,quantity=1,beforeCompletion?:()=>Promise<unknown>){const prepared=await runner.run(scope,async tx=>{
  const held=await new ItemQuantityRepository(tx).hold({orderItemId:s.orderItemId,quantity,kind:'paid_return',employeeId:base.drafter,businessDate,reason:'已付按份退'})
  const repository=new ItemQuantityRefundRepository(tx),prepared=await repository.prepare(held.caseId)
  await repository.decide({caseId:held.caseId,employeeId:base.approver,decision:'approved',reason:'核对原份和原收款'})
  return prepared
 });await beforeCompletion?.();for(const id of prepared.refundIds)await complete(id)}
 async function pause(operation:'pause'|'resume'){
  const state=(await control.list(staff())).find(v=>v.capability==='points_accrual')!
  return control.set(staff(),{capability:'points_accrual',operation,reason:'资金奖励隔离测试',reviewAt:null,expectedVersion:state.version,idempotencyKey:randomUUID()})
 }
 async function initiate(s:Scenario){return(await service.initiate({...meta(),orderId:s.orderId,publicId:'online-'+randomUUID(),provider:'postar',method:'native_qr',principal:{type:'employee',employeeId:base.approver}})).value}
 async function capture(payment:{publicId:string;amountMinor:number}){
  const occurredAt=new Date().toISOString(),providerTransactionId='txn-'+randomUUID(),integrationRef='financial-fix-test',providerSnapshot={signatureVerified:true,tradeState:'SUCCESS'}
  const verifiedObservationId=await observations.recordPayment({scope,provider:'postar',verificationKind:'callback_signature',providerEventId:'event-'+randomUUID(),integrationRef,paymentPublicId:payment.publicId,providerTransactionId,reportedAmountMinor:payment.amountMinor,reportedCurrency:'CNY',status:'succeeded',settlementChannel:'wechat',occurredAt,evidence:providerSnapshot})
  return(await service.recordSucceededCallback({...meta(),actor:{type:'integration',ref:integrationRef},verifiedObservationId,paymentPublicId:payment.publicId,provider:'postar',providerTransactionId,reportedAmountMinor:payment.amountMinor,reportedCurrency:'CNY',settlementChannel:'wechat',providerSnapshot,occurredAt})).value
 }
 it('reverses both partial receipt sources and serializes replay while preserving the award anchor',async()=>{
  const s=await createScenario(pool),first=await pay(s,4000),last=await pay(s,4000)
  expect(await snapshot(s)).toMatchObject({available_points:80,award_payment_id:last.id})
  await refund(s,first.id);expect(await snapshot(s)).toMatchObject({available_points:60,growth_value:60,applications:1})
  await refund(s,last.id);await refund(s,first.id)
  expect(await snapshot(s)).toMatchObject({available_points:20,growth_value:20,applications:3,award_payment_id:last.id})
  const applications=await pool.query('SELECT payment_id FROM mbox.loyalty_award_refund_applications WHERE order_id=$1',[s.orderId])
  expect(applications.rows.filter(row=>row.payment_id===first.id)).toHaveLength(2)
 })
 it('uses unpaid reductions for automatic rewards and split settlement without changing original invoice',async()=>{
  const s=await createScenario(pool);await stop(s);await pay(s,3000);await pay(s,3000)
  expect(await snapshot(s)).toMatchObject({available_points:60,growth_value:60,eligible_amount_minor:'6000',payment_status:'paid'})
  expect((await pool.query('SELECT total_amount_minor::int amount FROM mbox.orders WHERE id=$1',[s.orderId])).rows[0].amount).toBe(8000)
 })
 it.each([1,4])('reverses succeeded paid quantity return of %i while preserving correct paid status',async quantity=>{
  const s=await createScenario(pool);await pay(s);await quantityReturn(s,quantity)
  expect(await snapshot(s)).toMatchObject({available_points:80-20*quantity,growth_value:80-20*quantity,applications:1,refunds:1})
  if(quantity===1)expect((await snapshot(s)).payment_status).toBe('paid')
 })
 it('awards each order only its allocation from one combined receipt and reverses only the refunded member',async()=>{
  const a=await createScenario(pool),b=await createScenario(pool),receipt=await pay(a,undefined,[b])
  expect(await snapshot(a)).toMatchObject({available_points:80,award_payment_id:receipt.id})
  expect(await snapshot(b)).toMatchObject({available_points:80,award_payment_id:receipt.id})
  await refund(a,receipt.id)
  expect(await snapshot(a)).toMatchObject({available_points:60,applications:1})
  expect(await snapshot(b)).toMatchObject({available_points:80,applications:0})
 })
 it('recovers paused split-payment award after refunds using every actual receipt, exactly once',async()=>{
  const s=await createScenario(pool);await stop(s);await pause('pause')
  const first=await pay(s,3000);await pay(s,3000);await refund(s,first.id)
  expect(await snapshot(s)).toMatchObject({available_points:0})
  await pause('resume');const worker=new LoyaltyAccrualDeferredWorker(runner)
  expect((await worker.runBatch(scope,'financial-deferred-worker')).reviewRequired).toEqual([])
  expect(await snapshot(s)).toMatchObject({available_points:40,growth_value:40,eligible_amount_minor:'6000',applications:1})
  await worker.runBatch(scope,'financial-deferred-worker')
  expect(await snapshot(s)).toMatchObject({available_points:40,applications:1})
 })
 it('recovers a fully returned paused order to zero without losing the original award and refund facts',async()=>{
  const s=await createScenario(pool);await pause('pause');await pay(s);await quantityReturn(s,4);await pause('resume')
  const result=await new LoyaltyAccrualDeferredWorker(runner).runBatch(scope,'fully-returned-worker')
  expect(result.reviewRequired).toEqual([])
  expect(await snapshot(s)).toMatchObject({available_points:0,growth_value:0,eligible_amount_minor:'8000',reversed_amount_minor:'8000',applications:1,refunds:1})
 })
 it('uses the same reduced basis for staff reconciliation and supplement across receipt sources',async()=>{
  const s=await createScenario(pool);await stop(s);await pause('pause')
  const first=await pay(s,3000);await pay(s,3000);await refund(s,first.id);await pause('resume')
  expect((await customers.loyaltyReconciliation(staff())).find(row=>row.orderPublicId===s.orderPublicId)).toMatchObject({eligibleAmountMinor:6000,expectedPoints:60})
  const request=await customers.requestLoyaltySupplement(staff(base.drafter),{orderPublicId:s.orderPublicId,reason:'核对缺失奖励',idempotencyKey:randomUUID()})
  const decision=await customers.decideLoyaltySupplement(staff(),{publicId:request.value.publicId,decision:'approve',reason:'核对成功收退款',idempotencyKey:randomUUID()})
  expect(decision.value).toMatchObject({pointsDelta:40,growthDelta:40})
  await new LoyaltyAccrualDeferredWorker(runner).runBatch(scope,'supplement-race-worker')
  expect(await snapshot(s)).toMatchObject({available_points:40,applications:1})
 })
 it('serializes simultaneous supplement approval and deferred worker recovery with both transactions waiting on the order',async()=>{
  const s=await createScenario(pool);await pause('pause')
  const receipt=await pay(s);await refund(s,receipt.id);await pause('resume')
  const request=await customers.requestLoyaltySupplement(staff(base.drafter),{orderPublicId:s.orderPublicId,reason:'并发恢复验证',idempotencyKey:randomUUID()})
  const command={publicId:request.value.publicId,decision:'approve' as const,reason:'独立复核',idempotencyKey:randomUUID()}
  const blocker=await pool.connect()
  let waiters=0
  await blocker.query('BEGIN')
  await blocker.query('SELECT id FROM mbox.orders WHERE id=$1 FOR UPDATE',[s.orderId])
  const competition=Promise.all([
    customers.decideLoyaltySupplement(staff(),command),
    new LoyaltyAccrualDeferredWorker(runner).runBatch(scope,'actual-concurrent-recovery-worker'),
  ]).then(value=>({value,error:null}),error=>({value:null,error}))
  try{
    for(let attempt=0;attempt<100&&waiters<2;attempt++){
      waiters=(await pool.query(`SELECT count(*)::int count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'`)).rows[0].count
      if(waiters<2)await new Promise(resolve=>setTimeout(resolve,10))
    }
  }finally{await blocker.query('COMMIT');blocker.release()}
  const result=await competition
  expect(waiters,'both business transactions must actually overlap').toBeGreaterThanOrEqual(2)
  expect(result.error).toBeNull()
  const [decision,worker]=result.value!
  expect(['executed','not_required']).toContain(decision.value.status)
  expect(worker.reviewRequired).toEqual([])
  expect(await snapshot(s)).toMatchObject({available_points:60,growth_value:60,applications:1})
  expect((await pool.query('SELECT count(*)::int count FROM mbox.loyalty_order_awards WHERE order_id=$1',[s.orderId])).rows[0].count).toBe(1)
  expect((await customers.decideLoyaltySupplement(staff(),command)).replayed).toBe(true)
  await new LoyaltyAccrualDeferredWorker(runner).runBatch(scope,'actual-concurrent-recovery-worker')
  expect(await snapshot(s)).toMatchObject({available_points:60,growth_value:60,applications:1})
 })
 it('preserves the deferred first-settlement anchor when a later excess receipt follows a succeeded sales refund',async()=>{
  const s=await createScenario(pool),pending=await initiate(s);await pause('pause')
  const original=await pay(s);await refund(s,original.id);await capture(pending)
  expect(await snapshot(s)).toMatchObject({available_points:0,growth_value:0,award_payment_id:null})
  await pause('resume')
  const request=await customers.requestLoyaltySupplement(staff(base.drafter),{orderPublicId:s.orderPublicId,reason:'晚到另一笔收款后补发',idempotencyKey:randomUUID()})
  const decision=await customers.decideLoyaltySupplement(staff(),{publicId:request.value.publicId,decision:'approve',reason:'核对原结清收款及退款',idempotencyKey:randomUUID()})
  expect(decision.value).toMatchObject({pointsDelta:60,growthDelta:60})
  expect(await snapshot(s)).toMatchObject({available_points:60,growth_value:60,applications:1,award_payment_id:original.id})
  await new LoyaltyAccrualDeferredWorker(runner).runBatch(scope,'late-excess-after-supplement')
  expect(await snapshot(s)).toMatchObject({available_points:60,growth_value:60,applications:1})
 })
 it('rechecks a newly created refund review when deciding an already pending supplement',async()=>{
  const s=await createScenario(pool,{ineligibleAmountMinor:2000}),pending=await initiate(s);await pause('pause')
  await pay(s,5000);const online=await capture(pending);await pause('resume')
  const request=await customers.requestLoyaltySupplement(staff(base.drafter),{orderPublicId:s.orderPublicId,reason:'先申请后出现退款待核',idempotencyKey:randomUUID()})
  await new LoyaltyAccrualDeferredWorker(runner).runBatch(scope,'review-before-old-approval')
  const refund=(await service.requestRefund({...meta(base.drafter),paymentId:online.id,publicId:'review-race-'+randomUUID(),reason:'跨超收混合退款',purpose:'price_adjustment',allocations:[{orderItemId:s.orderItemId,amountMinor:6000},{orderItemId:s.ineligibleItemId!,amountMinor:2000}]})).value
  await service.approveRefund({...meta(),refundId:refund.id,decisionReason:'核实渠道退款'});await complete(refund.id)
  await expect(customers.decideLoyaltySupplement(staff(),{publicId:request.value.publicId,decision:'approve',reason:'旧申请不能绕开新待核',idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'LOYALTY_REFUND_REVIEW_REQUIRED',statusCode:409})
  expect((await pool.query('SELECT status FROM mbox.loyalty_supplement_requests WHERE public_id=$1',[request.value.publicId])).rows[0].status).toBe('requested')
  expect(await snapshot(s)).toMatchObject({available_points:80,growth_value:80,applications:0,reviews:1,refunds:1})
 })
 it('does not apply failed refunds and applies concurrent cross-source completions once each',async()=>{
  const s=await createScenario(pool),first=await pay(s,4000),last=await pay(s,4000)
  const failed=await requestRefund(s,first.id);await service.approveRefund({...meta(),refundId:failed.id,decisionReason:'审核'});await complete(failed.id,false)
  expect(await snapshot(s)).toMatchObject({available_points:80,applications:0})
  const requests=await Promise.all([requestRefund(s,first.id),requestRefund(s,last.id)])
  for(const request of requests)await service.approveRefund({...meta(),refundId:request.id,decisionReason:'审核'})
  await Promise.all(requests.map(request=>complete(request.id)))
  expect(await snapshot(s)).toMatchObject({available_points:40,growth_value:40,applications:2})
 })
 it('does not reverse a proven excess collection even when the refund purpose names a sales adjustment',async()=>{
  const s=await createScenario(pool),online=await initiate(s),cash=await pay(s);await capture(online)
  await refund(s,cash.id,8000)
  expect(await snapshot(s)).toMatchObject({available_points:80,growth_value:80,reversed_amount_minor:'0',applications:1,payment_status:'paid'})
 })
 it('retains the quantity-refund review guard for an unresolved competing channel receipt',async()=>{
  const s=await createScenario(pool),online=await initiate(s);await pay(s)
  await expect(quantityReturn(s,1,()=>capture(online))).rejects.toThrow('先核对原成交金额与各原付款分摊')
  expect(await snapshot(s)).toMatchObject({available_points:80,growth_value:80,applications:0,refunds:0,payment_status:'paid'})
 })
 it.each([false,true])('does not replay a partial receipt refund already repaid before first full settlement, paused=%s',async paused=>{
  const s=await createScenario(pool)
  if(paused)await pause('pause')
  const first=await pay(s,4000);await refund(s,first.id)
  await service.authorizeRecollection({...meta(),orderId:s.orderId,reason:'测试前笔部分退款后收银确认补齐'})
  await pay(s,6000)
  if(paused){await pause('resume');await new LoyaltyAccrualDeferredWorker(runner).runBatch(scope,'repaid-deferred-worker')}
  expect(await snapshot(s)).toMatchObject({available_points:80,growth_value:80,eligible_amount_minor:'8000',payment_status:'paid',applications:0})
 })
 it('follows frozen item eligibility after an unpaid stop and never awards excluded merchandise',async()=>{
  const s=await createScenario(pool,{ineligibleAmountMinor:2000});await stop(s);await pay(s)
  expect(await snapshot(s)).toMatchObject({available_points:60,growth_value:60,eligible_amount_minor:'6000'})
 })
 it('uses the provider refund callback path for a paid quantity return and replays it once',async()=>{
  const s=await createScenario(pool);await capture(await initiate(s));await quantityReturn(s)
  expect(await snapshot(s)).toMatchObject({available_points:60,growth_value:60,applications:1,payment_status:'paid'})
 })
 it('keeps a mixed-eligibility refund across genuine excess pending review without rolling back money',async()=>{
  const s=await createScenario(pool,{ineligibleAmountMinor:2000}),pending=await initiate(s)
  await pay(s,5000);const online=await capture(pending)
  const request=(await service.requestRefund({...meta(base.drafter),paymentId:online.id,publicId:'mixed-'+randomUUID(),reason:'跨超收的混合商品退款',purpose:'price_adjustment',allocations:[{orderItemId:s.orderItemId,amountMinor:6000},{orderItemId:s.ineligibleItemId!,amountMinor:2000}]})).value
  await service.approveRefund({...meta(),refundId:request.id,decisionReason:'核实渠道退款'});await complete(request.id)
  expect(await snapshot(s)).toMatchObject({available_points:80,growth_value:80,applications:0,reviews:1,refunds:1})
  expect((await customers.loyaltyReconciliation(staff())).find(row=>row.orderPublicId===s.orderPublicId)).toMatchObject({status:'refund_review_required',reviewRefundPublicIds:[request.publicId]})
  await expect(customers.requestLoyaltySupplement(staff(base.drafter),{orderPublicId:s.orderPublicId,reason:'不能绕过待核',idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'LOYALTY_REFUND_REVIEW_REQUIRED',statusCode:409})
 })
 it('rejects a valid refund and valid award paired from different orders at the database boundary',async()=>{
  const a=await createScenario(pool),b=await createScenario(pool),payment=await pay(a)
  await pay(b);const refund=await requestRefund(a,payment.id)
  await service.approveRefund({...meta(),refundId:refund.id,decisionReason:'审核'});await complete(refund.id)
  const award=(await pool.query('SELECT id FROM mbox.loyalty_order_awards WHERE order_id=$1',[b.orderId])).rows[0].id
  await expect(pool.query(`INSERT INTO mbox.loyalty_award_refund_applications(tenant_id,store_id,award_id,refund_id,order_id,payment_id,eligible_refund_amount_minor,reversed_points,reversed_growth,applied_at) VALUES($1,$2,$3,$4,$5,$6,0,0,0,clock_timestamp())`,[base.tenant,base.store,award,refund.id,b.orderId,payment.id])).rejects.toMatchObject({code:'23503'})
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
