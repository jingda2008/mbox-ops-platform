import {randomUUID} from 'node:crypto'
import Fastify,{type FastifyInstance} from 'fastify'
import {Pool} from 'pg'
import {beforeAll,afterAll,describe,it,expect} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {registerActivityCustomerRefundRoutes} from './activity-customer-refund-api.js'
import {ActivityPaymentService} from './activity-payment-service.js'
import {RefundRepository} from './refund-repository.js'
import {PaymentRepository} from './payment-repository.js'
import {PostgresCashierWorkbenchQuery} from './cashier-workbench-query.js'
import {ActivityServiceRepository,activityCredential} from './activity-service-repository.js'
const database=process.env.TEST_NORMALIZED_DATABASE_URL
;(database?describe:describe.skip)('customer activity refunds use the original review queue',()=>{
 const scope={tenantId:randomUUID(),storeId:randomUUID()},employee=randomUUID(),reviewer=randomUUID(),customer=randomUUID(),other=randomUUID()
 let admin:Pool,runtime:Pool,runner:ScopedPostgresTransactionRunner,app:FastifyInstance
 beforeAll(async()=>{
  await runNormalizedMigrations(database!);admin=new Pool({connectionString:database});runtime=new Pool({connectionString:process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL??database});runner=new ScopedPostgresTransactionRunner(runtime)
  await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'Refund test')",[scope.tenantId]);await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1::uuid,$2,$1::text,'Refund test')",[scope.storeId,scope.tenantId])
  await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,'REVIEW','审核员工')",[employee,scope.tenantId,scope.storeId])
  await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,'REVIEWER','独立复核员工')",[reviewer,scope.tenantId,scope.storeId])
  for(const id of [customer,other])await admin.query("INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1::uuid,$2,$3,$1::text)",[id,scope.tenantId,scope.storeId])
  app=Fastify();await registerActivityCustomerRefundRoutes(app,{transactions:runner,resolvePublicContext:req=>({scope,customerId:req.headers['x-other']?other:customer,businessDate:'2026-10-22',tableSessionId:null,actorRef:'self-test'}),handle:async(reply,action)=>{try{return await action()}catch(e){const error=e as {message:string;code?:string;statusCode?:number};return reply.code(error.statusCode??409).send({error:{code:error.code??'CONFLICT',message:error.message}})}}});await app.ready()
 })
 afterAll(async()=>{await app?.close();await runtime?.end();await admin?.end()})
 async function fixture(parent?:{activity:string;id:string},used=false,options:{pending?:boolean;legacy?:boolean}={}){
  const activity=parent?.activity??randomUUID(),id=randomUUID(),payment=randomUUID()
  if(!parent)await admin.query(`INSERT INTO mbox.community_activities(id,tenant_id,store_id,public_id,activity_kind,title,summary,starts_at,ends_at,assembly_location,capacity,fee_amount_minor,registration_payment_mode,payment_rule_text,safety_policy_version,safety_acknowledgement_text,safety_requirements,refund_policy_version,refund_policy_summary,activity_details,included_items,participation_requirements,contact_instructions,status,published_at,created_by_employee_id,approved_by_employee_id)
    VALUES($1::uuid,$2,$3,$1::text,'member_night','退款测试活动','保留顾客本人申请',clock_timestamp()+interval '1 hour',clock_timestamp()+interval '3 hours','MBOX',30,1000,'full_required','须全额预付','refund-safety-v1','已阅读安全要求',ARRAY['注意安全'],'refund-policy-v1','未使用可申请审核','退款测试详情，整份申请保留真实顾客，原付款进入人工审核。',ARRAY['活动入场'],ARRAY['准时到场'],'店内核对','published',clock_timestamp(),$4,$4)`,[activity,scope.tenantId,scope.storeId,employee])
  await admin.query(`INSERT INTO mbox.community_activity_registrations(id,tenant_id,store_id,public_id,activity_id,customer_id,party_size,status,payment_choice,payment_status,fee_amount_minor,amount_due_minor,paid_amount_minor,currency,contact_snapshot,safety_acknowledgement,idempotency_key,refund_policy_snapshot,payment_due_at,seat_hold_expires_at,requested_payment_choice,requested_payment_method,requested_amount_due_minor,acknowledged_safety_policy_version,acknowledged_refund_policy_version,terms_acknowledged_at,terms_acknowledgement_source,service_version,reserved_seats,max_participants,includes_admission,purchase_kind,parent_registration_id)
    VALUES($1::uuid,$2,$3,$1::text,$4,$5,1,'payment_pending','full','pending',1000,1000,0,'CNY',NULL,'{"acknowledged":true,"policyVersion":"refund-safety-v1"}',$1::text,'{"policyVersion":"refund-policy-v1","summary":"未使用可申请审核"}',clock_timestamp()+interval '15 minutes',clock_timestamp()+interval '15 minutes','full','jsapi',1000,'refund-safety-v1','refund-policy-v1',clock_timestamp(),'mini_program',3,$6,1,$7,$8,$9)`,[id,scope.tenantId,scope.storeId,activity,customer,parent?0:1,!parent,parent?'single_dish':'admission_package',parent?.id??null])
  if (options.legacy) await admin.query('UPDATE mbox.community_activity_registrations SET service_version=1 WHERE id=$1',[id])
  if (options.pending) {
   await admin.query("INSERT INTO mbox.payments(id,tenant_id,store_id,payable_kind,activity_registration_id,activity_registration_cycle,public_id,provider,method,amount_minor,currency,status) VALUES($1::uuid,$2,$3,'activity_registration',$4,1,$1::text,'postar','jsapi',1000,'CNY','created')",[payment,scope.tenantId,scope.storeId,id])
   await admin.query('UPDATE mbox.community_activity_registrations SET payment_id=$2 WHERE id=$1',[id,payment])
  } else {
   await admin.query("INSERT INTO mbox.payments(id,tenant_id,store_id,payable_kind,activity_registration_id,activity_registration_cycle,public_id,provider,method,amount_minor,currency,status,provider_transaction_id,succeeded_at) VALUES($1::uuid,$2,$3,'activity_registration',$4,1,$1::text,'postar','jsapi',1000,'CNY','succeeded',$1::text,clock_timestamp())",[payment,scope.tenantId,scope.storeId,id])
   await admin.query("UPDATE mbox.community_activity_registrations SET payment_id=$2,status='confirmed',payment_status='paid',paid_amount_minor=1000 WHERE id=$1",[id,payment])
  }
  if(used)await admin.query('INSERT INTO mbox.activity_admission_batches(tenant_id,store_id,registration_id,operation_key,quantity,employee_id) VALUES($1,$2,$3,$4,1,$5)',[scope.tenantId,scope.storeId,id,randomUUID(),employee])
  return{id,activity,payment}
 }
 const post=(id:string,key=randomUUID(),headers={})=>app.inject({method:'POST',url:`/public/mini/activity-registrations/${id}/refund-request`,headers:{'idempotency-key':key,...headers},payload:{reason:'行程变动申请整份退订'}})
 const paymentView=(id:string,owner=customer)=>new ActivityPaymentService(runner,undefined as never,undefined as never)
  .get({scope,customerId:owner,businessDate:'2026-10-22',actorRef:'self-test'},id)
 const compensation=(paymentId:string)=>runner.run(scope,tx=>new RefundRepository(tx).requestActivity({paymentId,publicId:randomUUID(),reason:'已与顾客核对保留履约',requestedByEmployeeId:employee,amountMinor:200,disposition:'retain_fulfillment',customerConfirmed:true}))
 async function completeRefund(paymentId:string,refund:{id:string;amountMinor:number}) {
  await runner.run(scope,tx=>new RefundRepository(tx).approve(refund.id,reviewer,'核对原付款与售后方案'))
  await runner.run(scope,tx=>new RefundRepository(tx).beginExecution(refund.id))
  const reference=refund.id.replaceAll('-','')
  await admin.query("UPDATE mbox.refunds SET merchant_refund_id=$2,provider_submission_started_at=clock_timestamp(),provider_submission_state='submitted' WHERE id=$1",[refund.id,reference])
  await runner.run(scope,async tx=>{
   const repo=new RefundRepository(tx)
   await repo.completeProviderExecution({refundPublicId:reference,provider:'postar',succeeded:true,providerRefundId:`RF${reference}`,originalProviderTransactionId:paymentId,reportedAmountMinor:refund.amountMinor,reportedCurrency:'CNY',providerSnapshot:{localTest:true}})
   await repo.syncPaymentRefundStatus(paymentId)
   await new PaymentRepository(tx).syncActivityRegistrationRefundStatus(paymentId)
  })
 }
 it('keeps the real requester, replays the original receipt, and appears in the existing cashier queue',async()=>{
  const f=await fixture(),key=randomUUID();const first=await post(f.id,key);expect(first.statusCode,first.body).toBe(200);expect(first.json().data).toMatchObject({status:'requested',amountMinor:1000})
  const replay=await post(f.id,key);expect(replay.json().meta.replayed).toBe(true)
  const stored=(await admin.query('SELECT id,requested_by_employee_id,requested_by_customer_id,status FROM mbox.refunds WHERE payment_id=$1',[f.payment])).rows
  expect(stored).toHaveLength(1);expect(stored[0]).toMatchObject({requested_by_employee_id:null,requested_by_customer_id:customer,status:'requested'})
  const view=await new PostgresCashierWorkbenchQuery(runner).get({scope,employeeId:employee,businessDate:'2026-10-22',capabilities:['refund.approve','refund.execute','community.activity.cashier','community.activity.view'],limit:100})
  expect(JSON.stringify(view)).toContain('顾客本人');expect(JSON.stringify(view)).toContain(first.json().data.refundPublicId)
  const again=await post(f.id);expect(again.json().error.code).toBe('ACTIVITY_REFUND_PENDING')
  const approved=await runner.run(scope,tx=>new RefundRepository(tx).approve(stored[0].id,employee,'核对未使用权益，批准退款'));expect(approved.status).toBe('approved');expect(approved.requestedByCustomerId).toBe(customer)
 })
 it('returns the current exact refund ID and terminal status while an old command still replays its original receipt',async()=>{
  const f=await fixture(),key=randomUUID(),service=new ActivityPaymentService(runner,undefined as never,undefined as never),context={scope,customerId:customer,businessDate:'2026-10-22',actorRef:'self-test'}
  expect(await service.get(context,f.id)).toMatchObject({refundPublicId:null,refundStatus:null,refundRejectionReason:null,canRequestFullRefund:true,refundRequestBlockReason:null})
  const first=await post(f.id,key),firstId=first.json().data.refundPublicId
  expect(await service.get(context,f.id)).toMatchObject({refundPublicId:firstId,refundStatus:'requested',refundRejectionReason:null,canRequestFullRefund:false,refundRequestBlockReason:'refund_in_progress'})
  const refund=(await admin.query('SELECT id FROM mbox.refunds WHERE public_id=$1',[firstId])).rows[0]
  await runner.run(scope,tx=>new RefundRepository(tx).reject(refund.id,employee,'顾客确认原行程仍可继续'))
  expect(await service.get(context,f.id)).toMatchObject({refundPublicId:firstId,refundStatus:'rejected',resolutionState:'confirmed',refundRejectionReason:'顾客确认原行程仍可继续',canRequestFullRefund:true,refundRequestBlockReason:null})
  const replay=await post(f.id,key);expect(replay.json().meta.replayed).toBe(true);expect(replay.json().data).toMatchObject({refundPublicId:firstId,status:'requested'})
  const second=await post(f.id);expect(second.statusCode,second.body).toBe(200);expect(second.json().data.refundPublicId).not.toBe(firstId)
  expect(await service.get(context,f.id)).toMatchObject({refundPublicId:second.json().data.refundPublicId,refundStatus:'requested',refundRejectionReason:null,canRequestFullRefund:false})
 })
 it('rejects another customer and refuses used entitlements or a valid dependent add-on',async()=>{
  const plain=await fixture();expect((await post(plain.id,randomUUID(),{'x-other':'yes'})).statusCode).toBe(404)
  const used=await fixture(undefined,true);expect((await post(used.id)).json().error.code).toBe('ACTIVITY_USED_REFUND_REVIEW')
  const parent=await fixture();await fixture(parent);expect((await post(parent.id)).json().error.code).toBe('ACTIVITY_DEPENDENT_REFUND_REVIEW')
  await expect(paymentView(plain.id,other)).rejects.toMatchObject({statusCode:404})
  expect(await paymentView(used.id)).toMatchObject({canRequestFullRefund:false,refundRequestBlockReason:'rights_used'})
  expect(await paymentView(parent.id)).toMatchObject({canRequestFullRefund:false,refundRequestBlockReason:'active_addons'})
 })
 it('blocks a redeemed meal even when no kitchen line was required',async()=>{
  const f=await fixture()
  await admin.query("INSERT INTO mbox.activity_meals(tenant_id,store_id,registration_id,business_date,number,redeemed_by_employee_id) VALUES($1,$2,$3,'2026-10-22',1,$4)",[scope.tenantId,scope.storeId,f.id,employee])
  expect(await paymentView(f.id)).toMatchObject({canRequestFullRefund:false,refundRequestBlockReason:'rights_used'})
  expect((await post(f.id)).json().error.code).toBe('ACTIVITY_USED_REFUND_REVIEW')
 })
 it('does not advertise self-refund for a legacy or unpaid registration',async()=>{
  const legacy=await fixture(undefined,false,{legacy:true}),pending=await fixture(undefined,false,{pending:true})
  expect(await paymentView(legacy.id)).toMatchObject({canRequestFullRefund:false,refundRequestBlockReason:'legacy_registration'})
  expect(await paymentView(pending.id)).toMatchObject({canRequestFullRefund:false,refundRequestBlockReason:'payment_not_refundable'})
  expect((await post(legacy.id)).statusCode).toBe(409)
  expect((await post(pending.id)).statusCode).toBe(409)
 })
 it.each(['requested','approved','processing','failed'] as const)('blocks self-refund throughout a reserved compensation in %s',async state=>{
  const f=await fixture(),refund=await compensation(f.payment)
  if(state!=='requested')await runner.run(scope,tx=>new RefundRepository(tx).approve(refund.id,reviewer,'补偿保留原履约'))
  if(state==='processing'||state==='failed')await runner.run(scope,tx=>new RefundRepository(tx).beginExecution(refund.id))
  if(state==='failed'){
   const reference=refund.id.replaceAll('-','')
   await admin.query("UPDATE mbox.refunds SET merchant_refund_id=$2,provider_submission_started_at=clock_timestamp(),provider_submission_state='submitted' WHERE id=$1",[refund.id,reference])
   await runner.run(scope,tx=>new RefundRepository(tx).completeProviderExecution({refundPublicId:reference,provider:'postar',succeeded:false,providerRefundId:`RF${reference}`,originalProviderTransactionId:f.payment,reportedAmountMinor:refund.amountMinor,reportedCurrency:'CNY',providerSnapshot:{localTest:true}}))
  }
  expect(await paymentView(f.id)).toMatchObject({refundStatus:state,canRequestFullRefund:false,refundRequestBlockReason:'compensation_review_required'})
  expect((await post(f.id)).json().error.code).toBe('ACTIVITY_COMPENSATION_DISPOSITION_REQUIRED')
 })
 it('re-enables an unused full request after compensation rejection but keeps completed compensation blocked',async()=>{
  const f=await fixture(),rejected=await compensation(f.payment)
  await runner.run(scope,tx=>new RefundRepository(tx).reject(rejected.id,reviewer,'未发生补偿，按未使用整份退订处理'))
  expect(await paymentView(f.id)).toMatchObject({refundStatus:'rejected',refundRejectionReason:'未发生补偿，按未使用整份退订处理',canRequestFullRefund:true})
  const succeeded=await compensation(f.payment);await completeRefund(f.payment,succeeded)
  expect(await paymentView(f.id)).toMatchObject({registrationStatus:'confirmed',refundStatus:'succeeded',refundRejectionReason:null,serviceRefundDisposition:'retain_fulfillment',canRequestFullRefund:false,refundRequestBlockReason:'compensation_review_required'})
  expect((await post(f.id)).statusCode).toBe(409)
 })
 it('projects a whole refund success as terminal and never exposes another full request',async()=>{
  const f=await fixture(),response=await post(f.id),refund=(await admin.query('SELECT id,amount_minor FROM mbox.refunds WHERE public_id=$1',[response.json().data.refundPublicId])).rows[0]
  await completeRefund(f.payment,{id:refund.id,amountMinor:Number(refund.amount_minor)})
  expect(await paymentView(f.id)).toMatchObject({registrationStatus:'refunded',refundStatus:'succeeded',resolutionState:'refunded',serviceRefundDisposition:null,canRequestFullRefund:false,refundRequestBlockReason:'payment_not_refundable'})
 })
 it('retains one reservation for concurrent different requests and prevents use while review is pending',async()=>{
  const f=await fixture();const results=await Promise.all([post(f.id),post(f.id)]);expect(results.map(r=>r.statusCode).sort()).toEqual([200,409])
  expect(Number((await admin.query('SELECT count(*) FROM mbox.refunds WHERE payment_id=$1',[f.payment])).rows[0].count)).toBe(1)
  const token=(await admin.query('SELECT credential_token::text FROM mbox.community_activity_registrations WHERE id=$1',[f.id])).rows[0].credential_token
  await expect(runner.run(scope,tx=>new ActivityServiceRepository(tx).door(f.id,{action:'admit',arrivedCount:1,credential:activityCredential(f.id,token)},randomUUID(),employee,'2026-10-22'))).rejects.toThrow()
 })
})
