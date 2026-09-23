import {randomUUID} from 'node:crypto'
import {writeFileSync} from 'node:fs'
import {Pool} from 'pg'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {loadNormalizedMigrations,runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner,type ScopedTransaction} from './transaction-runner.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {PaymentCommandService} from './payment-command-service.js'
import {NormalizedPaymentCapabilityAuthorization} from './payment-security-policy.js'
import {NormalizedProviderObservationAuthority,VerifiedProviderObservationService} from './provider-verification-observation.js'
import {PaymentRepository} from './payment-repository.js'
import {ReconciliationRepository} from './reconciliation-repository.js'

const adminUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
const evidencePath=process.env.SYS339_PROJECTION_EVIDENCE_FILE
;(adminUrl&&runtimeUrl?describe:describe.skip)('closed order verified financial projection, restricted LOGIN',()=>{
  let admin:Pool,runtime:Pool,runner:ScopedPostgresTransactionRunner,money:PaymentCommandService,date:string
  const scope={tenantId:randomUUID(),storeId:randomUUID()},area=randomUUID(),product=randomUUID(),cashier=randomUUID(),requester=randomUUID()
  const evidence:Array<Record<string,unknown>>=[]
  beforeAll(async()=>{
    await runNormalizedMigrations(adminUrl!)
    admin=new Pool({connectionString:adminUrl,max:4})
    runtime=new Pool({connectionString:runtimeUrl,max:5})
    runner=new ScopedPostgresTransactionRunner(runtime)
    const identity=(await runtime.query("SELECT session_user,current_user,current_database(),rolsuper,rolbypassrls,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname=session_user")).rows[0]
    expect(identity).toMatchObject({session_user:new URL(runtimeUrl!).username,current_user:new URL(runtimeUrl!).username,rolsuper:false,rolbypassrls:false,rolcreaterole:false,rolcreatedb:false})
    expect(Number((await admin.query('SELECT max(version) version FROM mbox.normalized_schema_migrations')).rows[0].version)).toBe(Number((await loadNormalizedMigrations()).at(-1)!.version))
    evidence.push({identity,migrations:(await admin.query("SELECT version,checksum FROM mbox.normalized_schema_migrations WHERE version IN ('238','239') ORDER BY version")).rows})
    money=service(runner)
    await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'independent SYS331 race')",[scope.tenantId,scope.tenantId])
    await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name,timezone,business_day_cutoff) VALUES($1,$2,'race','race','Asia/Shanghai','06:00')",[scope.storeId,scope.tenantId])
    date=await runner.run(scope,async tx=>(await tx.query<{date:string}>('SELECT mbox.current_operating_business_date($1,$2)::text date',[scope.tenantId,scope.storeId])).rows[0]!.date)
    await admin.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'A','A','indoor')",[area,scope.tenantId,scope.storeId])
    await admin.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station) VALUES($1,$2,$3,'RACE','Race fixture','drink','none')",[product,scope.tenantId,scope.storeId])
    for(const employeeId of [cashier,requester]){
      await admin.query('INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,$4,$4)',[employeeId,scope.tenantId,scope.storeId,employeeId])
      const role=randomUUID()
      await admin.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,$4,'fixture')",[role,scope.tenantId,scope.storeId,`R_${role.replaceAll('-','').toUpperCase()}`])
      await admin.query('INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id) VALUES($1,$2,$3,$4)',[scope.tenantId,scope.storeId,employeeId,role])
      const rights=employeeId===cashier?['payment.initiate.staff','payment.manual.cash.record','payment.collect.all_tables','payment.recollect.authorize','reconciliation.view','refund.request','refund.approve','refund.execute']:['refund.request']
      for(const code of rights){
        const permission=(await admin.query("INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category) VALUES($1,$2,$3,$3,'operations') ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET name=EXCLUDED.name RETURNING id",[scope.tenantId,scope.storeId,code])).rows[0].id
        await admin.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[scope.tenantId,scope.storeId,role,permission])
      }
      if(employeeId===cashier)await admin.query("INSERT INTO mbox.role_approval_limits(tenant_id,store_id,role_id,approval_code,amount_minor,currency) VALUES($1,$2,$3,'refund.approve',100000,'CNY')",[scope.tenantId,scope.storeId,role])
    }
  },30000)
  afterAll(async()=>{await runtime?.end();await admin?.end();if(evidencePath)writeFileSync(evidencePath,JSON.stringify(evidence,null,2)+'\n')})
  const service=(r:ScopedPostgresTransactionRunner)=>new PaymentCommandService(new NormalizedCommandExecutor(r),new NormalizedPaymentCapabilityAuthorization(),new NormalizedProviderObservationAuthority())
  const meta=(employeeId=cashier)=>({scope,actor:{type:'employee' as const,employeeId},businessDate:date,idempotencyKey:randomUUID(),requestFingerprint:randomUUID()})
  async function fixture(mode:'partial'|'paid'='partial',batch=true){
    const table=randomUUID(),session=randomUUID(),order=randomUUID(),item=randomUUID()
    await admin.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,$5,$5,4)",[table,scope.tenantId,scope.storeId,area,`T${table.slice(0,8)}`])
    await admin.query('INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1::uuid,$2,$3,$4,$1::text,$5,2)',[session,scope.tenantId,scope.storeId,table,date])
    await admin.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,submitted_at,subtotal_amount_minor,total_amount_minor,settlement_mode,fulfillment_state) VALUES($1::uuid,$2,$3,$4,$1::text,'staff_assisted','submitted',clock_timestamp(),4000,4000,'table_tab','active')",[order,scope.tenantId,scope.storeId,session])
    await admin.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot) VALUES($1,$2,$3,$4,$5,1,4000,4000,'none','{"name":"fixture","inventoryControlMode":"not_managed"}')`,[item,scope.tenantId,scope.storeId,order,product])
    const initiate=()=>money.initiate({...meta(),orderId:order,...(batch?{orderIds:[order]}:{}),publicId:randomUUID(),provider:'postar',method:'native_qr',principal:{type:'employee',employeeId:cashier}})
    // An ordinary pending original attempt may coexist with a later manual
    // collection. No recollection obligation is needed for this paid control.
    let pending=mode==='paid'?(await initiate()).value:undefined
    const original=(await money.recordManual({...meta(),orderId:order,publicId:randomUUID(),provider:'cash',method:'cash',evidence:{collectedByEmployeeId:cashier,receiptReference:randomUUID()}})).value
    const refund=async(amount:number)=>{
      const value=(await money.requestRefund({...meta(requester),paymentId:original.id,publicId:randomUUID(),purpose:'price_adjustment',reason:'原商品实际退款事实',allocations:[{orderItemId:item,amountMinor:amount}]})).value
      await money.approveRefund({...meta(),refundId:value.id,decisionReason:'异人审核原实收退款'})
      await money.beginRefundExecution({...meta(),refundId:value.id})
      await money.recordManualRefundResult({...meta(),refundId:value.id,succeeded:true,receiptReference:randomUUID()})
    }
    if(mode==='partial'){
      await refund(2000)
      await money.authorizeRecollection({...meta(),orderId:order,reason:'按原已确认退款义务补收'})
      pending=(await initiate()).value
      await refund(2000)
    }else await refund(4000)
    expect((await admin.query('SELECT payment_status FROM mbox.orders WHERE id=$1',[order])).rows[0].payment_status).toBe('refunded')
    // Deliberate legacy closed-row fixture. Every payment/refund above uses
    // real restricted commands; this is not an old binary or HTTP replay.
    const occurredAt=new Date((await admin.query('SELECT clock_timestamp() happened')).rows[0].happened).toISOString()
    await admin.query("UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp(),closed_by_employee_id=$2 WHERE id=$1",[session,cashier])
    const providerTransactionId=randomUUID(),integrationRef='sys339-projection'
    const verifiedObservationId=await new VerifiedProviderObservationService(runner).recordPayment({scope,provider:'postar',verificationKind:'callback_signature',providerEventId:randomUUID(),integrationRef,paymentPublicId:pending!.publicId,providerTransactionId,reportedAmountMinor:pending!.amountMinor,reportedCurrency:'CNY',status:'succeeded',occurredAt,evidence:{fixture:'trusted synthetic verifier, no live provider'}})
    const capture={...meta(),actor:{type:'integration' as const,ref:integrationRef},verifiedObservationId,paymentPublicId:pending!.publicId,provider:'postar' as const,providerTransactionId,reportedAmountMinor:pending!.amountMinor,reportedCurrency:'CNY',occurredAt}
    return {order,session,pending:pending!,original,capture,expected:mode==='paid'?'paid':'partially_refunded'}
  }
  type Fixture=Awaited<ReturnType<typeof fixture>>
  async function prepare(tx:ScopedTransaction,f:Fixture,options:{consume?:boolean;ledgerAmount?:number;ledger?:boolean}={}){
    if(options.consume!==false)await new NormalizedProviderObservationAuthority().consume({transaction:tx,observationId:f.capture.verifiedObservationId,operation:'payment.callback',idempotencyKey:f.capture.idempotencyKey,integrationRef:f.capture.actor.ref,provider:'postar',subjectPublicId:f.pending.publicId,providerTransactionId:f.capture.providerTransactionId,reportedAmountMinor:f.pending.amountMinor,reportedCurrency:'CNY',observedStatus:'payment_succeeded'})
    const applied=await new PaymentRepository(tx).applySucceededCallback({...f.capture,succeededAt:f.capture.occurredAt})
    expect(applied.applied).toBe(true)
    if(options.ledger!==false)await new ReconciliationRepository(tx).append({paymentId:f.pending.id,entryType:'payment',provider:'postar',providerReference:f.capture.providerTransactionId,amountMinor:options.ledgerAmount??f.pending.amountMinor,currency:'CNY',businessDate:date,occurredAt:f.capture.occurredAt})
  }
  const snapshot=async(f:Fixture)=>({
    order:(await admin.query('SELECT to_jsonb(o)-ARRAY[\'payment_status\',\'updated_at\'] row FROM mbox.orders o WHERE id=$1',[f.order])).rows[0].row,
    session:(await admin.query('SELECT to_jsonb(s) row FROM mbox.table_sessions s WHERE id=$1',[f.session])).rows[0].row,
  })
  it.each([true,false])('admits only the exact partial projection from a verified late receipt, batch=%s',async batch=>{
    const f=await fixture('partial',batch),before=await snapshot(f)
    await money.recordSucceededCallback(f.capture)
    expect((await admin.query('SELECT payment_status FROM mbox.orders WHERE id=$1',[f.order])).rows[0].payment_status).toBe(f.expected)
    expect(await snapshot(f)).toEqual(before)
    expect(await money.recordSucceededCallback(f.capture)).toMatchObject({replayed:true})
    expect((await admin.query("SELECT count(*)::int n FROM mbox.reconciliation_entries WHERE payment_id=$1 AND entry_type='payment'",[f.pending.id])).rows[0].n).toBe(1)
    expect((await admin.query("SELECT p.created_at<=p.succeeded_at AND p.succeeded_at<s.closed_at AND s.closed_at<e.created_at correct_sequence FROM mbox.payments p JOIN mbox.reconciliation_entries e ON e.payment_id=p.id AND e.entry_type='payment' JOIN mbox.table_sessions s ON s.id=$2 WHERE p.id=$1",[f.pending.id,f.session])).rows[0].correct_sequence).toBe(true)
    evidence.push({scenario:'verified-late-partial',batch,expected:f.expected,originalAmount:4000,totalRefunds:4000,lateReceipt:f.pending.amountMinor,orderAndSessionUnchanged:true,replay:true})
  })
  it('preserves a genuine original late full capture after full refund without inventing a recollection obligation',async()=>{
    const f=await fixture('paid'),before=await snapshot(f)
    expect((await admin.query('SELECT count(*)::int n FROM mbox.order_recollection_refund_obligations WHERE order_id=$1',[f.order])).rows[0].n).toBe(0)
    await money.recordSucceededCallback(f.capture)
    expect((await admin.query('SELECT payment_status FROM mbox.orders WHERE id=$1',[f.order])).rows[0].payment_status).toBe('paid')
    expect(await snapshot(f)).toEqual(before)
    evidence.push({scenario:'verified-late-full-no-obligation',expected:'paid',originalAmount:4000,totalRefunds:4000,lateReceipt:f.pending.amountMinor,obligations:0,orderAndSessionUnchanged:true})
  })
  it.each([
    {name:'no receipt',options:{ledger:false}},
    {name:'wrong receipt amount',options:{ledgerAmount:1999}},
    {name:'unconsumed observation',options:{consume:false}},
  ])('rejects $name even if the mutable payment says succeeded',async({options})=>{
    const f=await fixture()
    await expect(runner.run(scope,async tx=>{await prepare(tx,f,options);await new PaymentRepository(tx).syncOrderPaymentStatus(f.order)})).rejects.toMatchObject({code:'55000'})
    expect((await admin.query('SELECT consumed_at FROM mbox.verified_provider_observations WHERE id=$1',[f.capture.verifiedObservationId])).rows[0].consumed_at).toBeNull()
  })
  it('rejects a second receipt for the same payment instead of treating duplicated money as proof',async()=>{
    const f=await fixture()
    await expect(runner.run(scope,async tx=>{
      await prepare(tx,f)
      await new ReconciliationRepository(tx).append({paymentId:f.pending.id,entryType:'payment',provider:'postar',providerReference:randomUUID(),amountMinor:f.pending.amountMinor,currency:'CNY',businessDate:date,occurredAt:f.capture.occurredAt})
      await new PaymentRepository(tx).syncOrderPaymentStatus(f.order)
    })).rejects.toMatchObject({code:'55000'})
  })
  it('rejects a desired partial projection when the actual capture instead fully settles the original order',async()=>{
    const f=await fixture('paid')
    await expect(runner.run(scope,async tx=>{await prepare(tx,f);await tx.query("UPDATE mbox.orders SET payment_status='partially_refunded' WHERE id=$1",[f.order])})).rejects.toMatchObject({code:'55000'})
  })
  it('rejects a projection with no new receipt or consumed success at all',async()=>{
    const f=await fixture()
    await expect(runner.run(scope,tx=>tx.query("UPDATE mbox.orders SET payment_status='partially_refunded' WHERE id=$1",[f.order]))).rejects.toMatchObject({code:'55000'})
  })
  it.each([
    {name:'wrong projection',set:"payment_status='partially_paid'"},
    {name:'order amount',set:"payment_status='partially_refunded',total_amount_minor=4001"},
    {name:'operating status',set:"payment_status='partially_refunded',status='completed'"},
    {name:'currency',set:"payment_status='partially_refunded',currency='USD'"},
    {name:'fulfillment',set:"payment_status='partially_refunded',fulfillment_state='cancelled'"},
  ])('rejects $name piggybacked on an otherwise valid verified receipt',async({set})=>{
    const f=await fixture()
    await expect(runner.run(scope,async tx=>{await prepare(tx,f);await tx.query(`UPDATE mbox.orders SET ${set} WHERE id=$1`,[f.order])})).rejects.toMatchObject({code:'55000'})
  })
  it('keeps original table ownership immutable even with exact financial proof',async()=>{
    const f=await fixture(),g=await fixture()
    await expect(runner.run(scope,async tx=>{await prepare(tx,f);await tx.query("UPDATE mbox.orders SET payment_status='partially_refunded',table_session_id=$2 WHERE id=$1",[f.order,g.session])})).rejects.toMatchObject({code:'23514'})
  })
  it('does not disclose or update the other scope, or expose the trigger-only predicate',async()=>{
    const f=await fixture()
    await runner.run({tenantId:randomUUID(),storeId:randomUUID()},async tx=>{
      expect((await tx.query("UPDATE mbox.orders SET payment_status='partially_refunded' WHERE id=$1",[f.order])).rowCount).toBe(0)
    })
    const privilege=(await runtime.query("SELECT has_function_privilege(current_user,'mbox.allow_closed_order_verified_payment_projection(jsonb,jsonb,uuid)','EXECUTE') allowed")).rows[0]
    expect(privilege.allowed).toBe(false)
  })
})
