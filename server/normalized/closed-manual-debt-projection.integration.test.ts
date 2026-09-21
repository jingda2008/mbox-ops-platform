import {randomUUID} from 'node:crypto'
import {writeFileSync} from 'node:fs'
import {Pool} from 'pg'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner,type ScopedTransaction} from './transaction-runner.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {PaymentCommandService} from './payment-command-service.js'
import {NormalizedPaymentCapabilityAuthorization} from './payment-security-policy.js'
import {NormalizedProviderObservationAuthority,VerifiedProviderObservationService} from './provider-verification-observation.js'
import {PaymentRepository} from './payment-repository.js'
import {ReconciliationRepository} from './reconciliation-repository.js'

const adminUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
const evidencePath=process.env.SYS342_EVIDENCE_FILE
const providers=['cash','physical_pos','external_manual'] as const
type Provider=typeof providers[number]
const permission=(provider:Provider)=>provider==='cash'?'payment.manual.cash.record':provider==='physical_pos'?'payment.manual.pos.record':'payment.manual.external.record'
;(adminUrl&&runtimeUrl?describe:describe.skip)('closed historical manual debt projection, restricted LOGIN',()=>{
  let admin:Pool,runtime:Pool,runner:ScopedPostgresTransactionRunner,money:PaymentCommandService,date:string
  const scope={tenantId:randomUUID(),storeId:randomUUID()},area=randomUUID(),product=randomUUID(),cashier=randomUUID(),requester=randomUUID()
  const evidence:Array<Record<string,unknown>>=[]
  let cashierRole:string
  beforeAll(async()=>{
    await runNormalizedMigrations(adminUrl!)
    admin=new Pool({connectionString:adminUrl,max:4})
    runtime=new Pool({connectionString:runtimeUrl,max:5})
    runner=new ScopedPostgresTransactionRunner(runtime)
    const identity=(await runtime.query("SELECT session_user,current_user,current_database(),rolsuper,rolbypassrls,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname=session_user")).rows[0]
    expect(identity).toMatchObject({session_user:new URL(runtimeUrl!).username,current_user:new URL(runtimeUrl!).username,rolsuper:false,rolbypassrls:false,rolcreaterole:false,rolcreatedb:false})
    expect(Number((await admin.query('SELECT max(version) version FROM mbox.normalized_schema_migrations')).rows[0].version)).toBe(240)
    evidence.push({identity,migrations:(await admin.query("SELECT version,checksum FROM mbox.normalized_schema_migrations WHERE version IN ('239','240') ORDER BY version")).rows})
    money=service(runner)
    await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'SYS342 projection fixture')",[scope.tenantId,scope.tenantId])
    await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name,timezone,business_day_cutoff) VALUES($1,$2,'race','race','Asia/Shanghai','06:00')",[scope.storeId,scope.tenantId])
    date=await runner.run(scope,async tx=>(await tx.query<{date:string}>('SELECT mbox.current_operating_business_date($1,$2)::text date',[scope.tenantId,scope.storeId])).rows[0]!.date)
    await admin.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'A','A','indoor')",[area,scope.tenantId,scope.storeId])
    await admin.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station) VALUES($1,$2,$3,'RACE','Race fixture','drink','none')",[product,scope.tenantId,scope.storeId])
    for(const employeeId of [cashier,requester]){
      await admin.query('INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,$4,$4)',[employeeId,scope.tenantId,scope.storeId,employeeId])
      const role=randomUUID();if(employeeId===cashier)cashierRole=role
      await admin.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,$4,'fixture')",[role,scope.tenantId,scope.storeId,`R_${role.replaceAll('-','').toUpperCase()}`])
      await admin.query('INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id) VALUES($1,$2,$3,$4)',[scope.tenantId,scope.storeId,employeeId,role])
      const rights=employeeId===cashier?['payment.initiate.staff','payment.manual.cash.record','payment.manual.pos.record','payment.manual.external.record','payment.collect.all_tables','payment.recollect.authorize','reconciliation.view','refund.request','refund.approve','refund.execute']:['refund.request']
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
  const manual=(orderId:string,provider:Provider='cash')=>({...meta(),orderId,publicId:randomUUID(),provider,
    method:provider==='cash'?'cash' as const:provider==='physical_pos'?'card' as const:'manual' as const,
    evidence:{collectedByEmployeeId:cashier,receiptReference:randomUUID(),...(provider==='physical_pos'?{terminalId:'isolated-pos-fixture'}:{}),...(provider==='external_manual'?{externalMethodCode:'bank_transfer',collectionNote:'已独立核对系统外实际收款凭证'}:{})}})
  async function fixture(closed=true,compensation=100,authorize=true){
    const table=randomUUID(),session=randomUUID(),order=randomUUID(),item=randomUUID()
    await admin.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,$5,$5,4)",[table,scope.tenantId,scope.storeId,area,`T${table.slice(0,8)}`])
    await admin.query('INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1::uuid,$2,$3,$4,$1::text,$5,2)',[session,scope.tenantId,scope.storeId,table,date])
    await admin.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,submitted_at,subtotal_amount_minor,total_amount_minor) VALUES($1::uuid,$2,$3,$4,$1::text,'staff_assisted','submitted',clock_timestamp(),2500,2500)",[order,scope.tenantId,scope.storeId,session])
    await admin.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot) VALUES($1,$2,$3,$4,$5,1,2500,2500,'none','{"name":"25 yuan fixture","inventoryControlMode":"not_managed"}')`,[item,scope.tenantId,scope.storeId,order,product])
    const original=(await money.recordManual(manual(order))).value
    const refunds=[]
    for(const [purpose,amountMinor] of [['price_adjustment',2500-compensation],['service_compensation',compensation]] as const){
      if(amountMinor===0)continue
      const refund=(await money.requestRefund({...meta(requester),paymentId:original.id,publicId:randomUUID(),purpose,reason:'核对真实原收款及两种退款性质',allocations:[{orderItemId:item,amountMinor}]})).value
      await money.approveRefund({...meta(),refundId:refund.id,decisionReason:'异人核对退款商品金额及服务补偿'})
      await money.beginRefundExecution({...meta(),refundId:refund.id})
      await money.recordManualRefundResult({...meta(),refundId:refund.id,succeeded:true,receiptReference:randomUUID()})
      refunds.push(refund.id)
    }
    expect((await admin.query('SELECT payment_status FROM mbox.orders WHERE id=$1',[order])).rows[0].payment_status).toBe('refunded')
    if(authorize)await money.authorizeRecollection({...meta(),orderId:order,reason:'仅补收原普通退款，服务补偿继续有效'})
    // Explicit synthetic legacy closure. Payment/refund/authorization facts
    // use real restricted commands; this is not an old binary or live rail.
    if(closed)await admin.query("UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp(),closed_by_employee_id=$2 WHERE id=$1",[session,cashier])
    const authorization=authorize?(await money.authorizeRecollection({...meta(),orderId:order,reason:'重新核实历史普通欠款，原服务补偿保留'})).value:null
    return {order,session,item,original,refunds,authorization,amount:2500-compensation}
  }
  type Fixture=Awaited<ReturnType<typeof fixture>>
  async function snapshot(f:Fixture){
    return {
      row:(await admin.query("SELECT to_jsonb(o)-ARRAY['payment_status','updated_at'] row FROM mbox.orders o WHERE id=$1",[f.order])).rows[0].row,
      session:(await admin.query('SELECT to_jsonb(s) row FROM mbox.table_sessions s WHERE id=$1',[f.session])).rows[0].row,
      refunds:(await admin.query('SELECT to_jsonb(r) row FROM mbox.refunds r WHERE id=ANY($1::uuid[]) ORDER BY id',[f.refunds])).rows,
    }
  }
  async function balances(f:Fixture){return runner.run(scope,async tx=>(await tx.query(`SELECT
    mbox.order_collection_due_amount($1,$2,$3)::text due,mbox.order_consumption_settled($1,$2,$3) settled,
    (SELECT payment_status FROM mbox.orders WHERE id=$3) status,
    (SELECT sum(amount_minor)::text FROM mbox.reconciliation_entries WHERE payment_id IN (SELECT id FROM mbox.payments WHERE order_id=$3)) net,
    (SELECT count(*)::int FROM mbox.payments WHERE order_id=$3) payments,
    (SELECT count(*)::int FROM mbox.reconciliation_entries WHERE payment_id IN (SELECT id FROM mbox.payments WHERE order_id=$3)) entries`,[scope.tenantId,scope.storeId,f.order])).rows[0])}
  // Build the same pre-projection facts as recordManual, allowing negative
  // tests to alter one proof while the entire restricted transaction rolls back.
  async function prepare(tx:ScopedTransaction,f:Fixture,options:{ledger?:boolean;amount?:number;duplicate?:boolean;provider?:Provider;wrongCollector?:boolean;wrongReference?:boolean}={}){
    const input=manual(f.order,options.provider)
    const payment=await new PaymentRepository(tx).createForOrder({...input,providerTransactionId:input.evidence.receiptReference,initialStatus:'succeeded',principal:{type:'employee',employeeId:cashier}})
    if(options.ledger!==false)await new ReconciliationRepository(tx).append({paymentId:payment.id,entryType:'payment',provider:payment.provider,
      providerReference:payment.providerTransactionId!,amountMinor:options.amount??payment.amountMinor,currency:'CNY',businessDate:date,occurredAt:payment.succeededAt!,evidenceSnapshot:{...input.evidence,...(options.wrongCollector?{collectedByEmployeeId:requester}:{}),...(options.wrongReference?{receiptReference:randomUUID()}: {})}})
    if(options.duplicate)await new ReconciliationRepository(tx).append({paymentId:payment.id,entryType:'payment',provider:payment.provider,
      providerReference:randomUUID(),amountMinor:payment.amountMinor,currency:'CNY',businessDate:date,occurredAt:payment.succeededAt!,evidenceSnapshot:input.evidence})
    return payment
  }
  async function setPermission(tx:ScopedTransaction,code:string,enabled:boolean){
    if(enabled)throw new Error('Permission revocation is rolled back with the negative-test transaction')
    await tx.query(`DELETE FROM mbox.role_permission_assignments
      WHERE tenant_id=$1 AND store_id=$2 AND role_id=$3 AND permission_id IN
        (SELECT id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code=$4)`,[scope.tenantId,scope.storeId,cashierRole,code])
  }
  it.each(providers)('accepts exact authorized %s compensation-preserving projection and original-key replay',async provider=>{
    const f=await fixture(),before=await snapshot(f),input=manual(f.order,provider)
    expect(await balances(f)).toMatchObject({due:'2400',status:'refunded',net:'0',payments:1,entries:3})
    const result=await money.recordManual(input)
    expect(result.value).toMatchObject({amountMinor:2400,provider,status:'succeeded'})
    expect(await balances(f)).toEqual({due:'0',settled:true,status:'partially_refunded',net:'2400',payments:2,entries:4})
    expect(await snapshot(f)).toEqual(before)
    expect(await money.recordManual(input)).toMatchObject({replayed:true,value:{id:result.value.id}})
    expect((await admin.query('SELECT status,consumed_payment_id FROM mbox.order_recollection_authorizations WHERE id=$1',[f.authorization!.id])).rows[0]).toMatchObject({status:'consumed',consumed_payment_id:result.value.id})
    evidence.push({scenario:'closed-exact-manual',provider,net:2400,retainedCompensation:100,paymentStatus:'partially_refunded',replayed:true})
  })
  it('keeps the open control and original 236 fully paid recovery behavior',async()=>{
    for(const [closed,compensation] of [[false,100],[true,0]] as const){
      const f=await fixture(closed,compensation),before=await snapshot(f)
      await money.recordManual(manual(f.order))
      expect(await balances(f)).toMatchObject({due:'0',settled:true,status:compensation?'partially_refunded':'paid',net:String(2500-compensation),payments:2})
      expect(await snapshot(f)).toEqual(before)
    }
  })
  it('preserves the existing physical POS manual-method contract',async()=>{
    const f=await fixture()
    await money.recordManual({...manual(f.order,'physical_pos'),method:'manual'})
    expect(await balances(f)).toMatchObject({due:'0',status:'partially_refunded',net:'2400'})
  })
  it('allows a distinct authorized cashier to authorize the collecting employee',async()=>{
    const f=await fixture(),role=(await admin.query('SELECT role_id FROM mbox.employee_roles WHERE employee_id=$1',[requester])).rows[0].role_id
    await admin.query(`INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
      SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2
        AND code IN ('payment.collect.all_tables','payment.recollect.authorize') ON CONFLICT DO NOTHING`,[scope.tenantId,scope.storeId,role])
    const authorization=(await money.authorizeRecollection({...meta(requester),orderId:f.order,reason:'异岗收银明确授权，由原收款员工核实入账'})).value
    const payment=(await money.recordManual(manual(f.order))).value
    expect(authorization.authorizedByEmployeeId).toBe(requester)
    expect((await admin.query('SELECT authorization_id,collected_by_employee_id FROM mbox.closed_debt_manual_payment_admissions WHERE payment_id=$1',[payment.id])).rows[0]).toEqual({authorization_id:authorization.id,collected_by_employee_id:cashier})
  })
  it('rejects an inactive collector after legitimate INSERT and before projection',async()=>{
    const f=await fixture()
    await expect(runner.run(scope,async tx=>{
      await prepare(tx,f);await tx.query("UPDATE mbox.employees SET status='suspended' WHERE id=$1",[cashier])
      await new PaymentRepository(tx).syncOrderPaymentStatus(f.order)
    })).rejects.toMatchObject({code:'55000'})
  })
  it('checks each current recovery permission before returning a completed original-key receipt',async()=>{
    const f=await fixture(),input=manual(f.order)
    await money.recordManual(input)
    for(const code of ['payment.manual.cash.record','payment.collect.all_tables','payment.recollect.authorize']){
      await admin.query(`INSERT INTO mbox.employee_permission_overrides(tenant_id,store_id,employee_id,permission_id,effect,reason,configured_by_employee_id)
        SELECT $1,$2,$3,id,'deny','current original-receipt permission revocation',$3 FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code=$4`,[scope.tenantId,scope.storeId,cashier,code])
      try{await expect(money.recordManual(input)).rejects.toMatchObject({name:'PaymentAuthorizationError'})}
      finally{await admin.query('DELETE FROM mbox.employee_permission_overrides WHERE tenant_id=$1 AND store_id=$2 AND employee_id=$3',[scope.tenantId,scope.storeId,cashier])}
    }
    expect(await money.recordManual(input)).toMatchObject({replayed:true})
    expect(await balances(f)).toMatchObject({net:'2400',payments:2,entries:4})
  })
  it.each([true,false])('serializes simultaneous %s-key collection attempts without a second receipt',async sameKey=>{
    const f=await fixture(),input=manual(f.order)
    const results=await Promise.allSettled([money.recordManual(input),money.recordManual(sameKey?input:manual(f.order))])
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(sameKey?2:1)
    if(sameKey)expect(results.filter(r=>r.status==='fulfilled'&&r.value.replayed)).toHaveLength(1)
    expect(await balances(f)).toMatchObject({due:'0',net:'2400',payments:2,entries:4})
  })
  it.each([
    {name:'no ledger',options:{ledger:false}}, {name:'wrong ledger amount',options:{amount:2399}}, {name:'duplicate ledger',options:{duplicate:true}},
    {name:'ledger collector mismatch',options:{wrongCollector:true}}, {name:'ledger receipt reference mismatch',options:{wrongReference:true}},
  ])('rejects $name after a real authorized receipt INSERT',async({options})=>{
    const f=await fixture(),before=await balances(f)
    await expect(runner.run(scope,async tx=>{await prepare(tx,f,options);await new PaymentRepository(tx).syncOrderPaymentStatus(f.order)})).rejects.toMatchObject({code:'55000'})
    expect(await balances(f)).toEqual(before)
    expect((await admin.query('SELECT count(*)::int n FROM mbox.closed_debt_manual_payment_admissions WHERE order_id=$1',[f.order])).rows[0].n).toBe(0)
  })
  it.each([
    {name:'another payment',set:'consumed_payment_id=$2',value:(f:Fixture)=>f.original.id},
    {name:'wrong amount',set:'amount_minor=2401'},
    {name:'wrong currency',set:"currency='USD'"},
    {name:'expired before consumption',set:"expires_at=consumed_at-interval '1 second'"},
    {name:'authorization created after payment',set:"created_at=consumed_at+interval '1 second'"},
    {name:'not consumed',set:"status='cancelled'"},
  ])('rejects mutable authorization proof with $name',async variant=>{
    const f=await fixture()
    await expect(runner.run(scope,async tx=>{
      await prepare(tx,f)
      await tx.query(`UPDATE mbox.order_recollection_authorizations SET ${variant.set} WHERE id=$1`,[f.authorization!.id,...('value' in variant?[variant.value!(f)]:[])])
      await new PaymentRepository(tx).syncOrderPaymentStatus(f.order)
    })).rejects.toMatchObject({code:'55000'})
  })
  it.each(['payment.collect.all_tables','payment.recollect.authorize',...providers.map(permission)])('rejects current permission loss for %s at projection',async code=>{
    const f=await fixture(),provider=providers.find(p=>permission(p)===code)??'cash'
    await expect(runner.run(scope,async tx=>{
      await prepare(tx,f,{provider});await setPermission(tx,code,false)
      await new PaymentRepository(tx).syncOrderPaymentStatus(f.order)
    })).rejects.toMatchObject({code:'55000'})
  })
  it.each([
    {name:'wrong partial status',set:"payment_status='partially_paid'"},
    {name:'wrong full status',set:"payment_status='paid'"},
    {name:'order amount',set:"payment_status='partially_refunded',total_amount_minor=2600"},
    {name:'currency',set:"payment_status='partially_refunded',currency='USD'"},
    {name:'operating status',set:"payment_status='partially_refunded',status='completed'"},
    {name:'fulfillment',set:"payment_status='partially_refunded',fulfillment_state='cancelled'"},
  ])('rejects $name even with a real manual receipt',async({set})=>{
    const f=await fixture()
    await expect(runner.run(scope,async tx=>{await prepare(tx,f);await tx.query(`UPDATE mbox.orders SET ${set} WHERE id=$1`,[f.order])})).rejects.toMatchObject({code:'55000'})
  })
  it('rejects invented consumed authorization without a new receipt or ledger',async()=>{
    const f=await fixture()
    await expect(runner.run(scope,async tx=>{
      await tx.query("UPDATE mbox.order_recollection_authorizations SET status='consumed',consumed_payment_id=$2,consumed_at=clock_timestamp() WHERE id=$1",[f.authorization!.id,f.original.id])
      await tx.query("UPDATE mbox.orders SET payment_status='partially_refunded' WHERE id=$1",[f.order])
    })).rejects.toMatchObject({code:'55000'})
  })
  it('does not authorize a new post-close obligation or pure compensation recollection',async()=>{
    const noObligation=await fixture(true,100,false)
    await expect(money.recordManual(manual(noObligation.order))).rejects.toThrow()
    const pureCompensation=await fixture(false,2500,false)
    await expect(money.authorizeRecollection({...meta(),orderId:pureCompensation.order,reason:'试图撤销补偿的普通授权应拒绝'})).rejects.toThrow()
    await expect(money.recordManual(manual(pureCompensation.order))).rejects.toThrow()
  })
  it('rejects an unconsumed verified success on the original payment at projection',async()=>{
    const f=await fixture(false)
    const payment=(await money.initiate({...meta(),orderId:f.order,publicId:randomUUID(),provider:'postar',method:'native_qr',principal:{type:'employee',employeeId:cashier}})).value
    await admin.query("UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp(),closed_by_employee_id=$2 WHERE id=$1",[f.session,cashier])
    await money.closeUnpresentedClosedDebtPayment({...meta(),paymentId:payment.id,reason:'核对原本地尝试未曾送往渠道'})
    const observation=await new VerifiedProviderObservationService(runner).recordPayment({scope,provider:'postar',verificationKind:'callback_signature',providerEventId:randomUUID(),integrationRef:'fixture-verifier',paymentPublicId:payment.publicId,providerTransactionId:randomUUID(),reportedAmountMinor:2400,reportedCurrency:'CNY',status:'succeeded',occurredAt:new Date().toISOString(),evidence:{fixture:'trusted synthetic observation'}})
    await expect(money.recordManual(manual(f.order))).rejects.toThrow(/原付款结果尚未明确/)
    expect((await admin.query('SELECT consumed_at FROM mbox.verified_provider_observations WHERE id=$1',[observation])).rows[0].consumed_at).toBeNull()
  })
  it('keeps scope and trigger-only predicate access restricted',async()=>{
    const f=await fixture()
    await runner.run({tenantId:randomUUID(),storeId:randomUUID()},async tx=>{
      expect((await tx.query("UPDATE mbox.orders SET payment_status='partially_refunded' WHERE id=$1",[f.order])).rowCount).toBe(0)
    })
    expect((await runtime.query("SELECT has_function_privilege(current_user,'mbox.allow_closed_order_manual_debt_projection(jsonb,jsonb,uuid)','EXECUTE') allowed")).rows[0].allowed).toBe(false)
    expect((await runtime.query("SELECT has_function_privilege(current_user,'mbox.record_closed_debt_manual_payment_admission()','EXECUTE') allowed")).rows[0].allowed).toBe(false)
    for(const privilege of ['INSERT','UPDATE','DELETE','TRUNCATE']){
      expect((await runtime.query("SELECT has_table_privilege(current_user,'mbox.closed_debt_manual_payment_admissions',$1) allowed",[privilege])).rows[0].allowed).toBe(false)
    }
    await money.recordManual(manual(f.order))
    await runner.run({tenantId:randomUUID(),storeId:randomUUID()},async tx=>{
      expect((await tx.query('SELECT * FROM mbox.closed_debt_manual_payment_admissions WHERE order_id=$1',[f.order])).rows).toEqual([])
    })
    for(const sql of [
      'INSERT INTO mbox.closed_debt_manual_payment_admissions SELECT * FROM mbox.closed_debt_manual_payment_admissions WHERE false',
      'UPDATE mbox.closed_debt_manual_payment_admissions SET amount_minor=amount_minor',
      'DELETE FROM mbox.closed_debt_manual_payment_admissions',
      'TRUNCATE mbox.closed_debt_manual_payment_admissions',
    ])await expect(runner.run(scope,tx=>tx.query(sql))).rejects.toMatchObject({code:'42501'})
  })
  async function oldPending(f:Fixture){
    const id=randomUUID(),reference=randomUUID(),publicId=randomUUID(),evidence={collectedByEmployeeId:cashier,receiptReference:randomUUID()}
    evidence.receiptReference=reference
    await runner.run(scope,tx=>tx.query(`INSERT INTO mbox.payments(id,tenant_id,store_id,payable_kind,order_id,public_id,provider,method,amount_minor,currency,status,provider_snapshot)
      VALUES($1,$2,$3,'order',$4,$5,'cash','cash',2400,'CNY','pending',$6::jsonb)`,[id,scope.tenantId,scope.storeId,f.order,publicId,JSON.stringify(evidence)]))
    return {id,reference,publicId,evidence}
  }
  it('rejects the proven old-pending timestamp and consumed-authorization forgery despite a new ledger',async()=>{
    const f=await fixture(false),{id,reference,evidence}=await oldPending(f)
    await admin.query("UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp(),closed_by_employee_id=$2 WHERE id=$1",[f.session,cashier])
    const before=await balances(f)
    await expect(runner.run(scope,async tx=>{
      const p=(await tx.query<{succeeded_at:string}>("UPDATE mbox.payments SET created_at=clock_timestamp(),succeeded_at=clock_timestamp(),status='succeeded',provider_transaction_id=$2 WHERE id=$1 RETURNING succeeded_at::text",[id,reference])).rows[0]!
      await new ReconciliationRepository(tx).append({paymentId:id,entryType:'payment',provider:'cash',providerReference:reference,amountMinor:2400,currency:'CNY',businessDate:date,occurredAt:p.succeeded_at,evidenceSnapshot:evidence})
      await tx.query("UPDATE mbox.order_recollection_authorizations SET status='consumed',consumed_payment_id=$2,consumed_at=clock_timestamp() WHERE id=$1",[f.authorization!.id,id])
      expect((await tx.query('SELECT count(*)::int n FROM mbox.closed_debt_manual_payment_admissions WHERE payment_id=$1',[id])).rows[0]!.n).toBe(0)
      await new PaymentRepository(tx).syncOrderPaymentStatus(f.order)
    })).rejects.toMatchObject({code:'55000'})
    expect(await balances(f)).toEqual(before)
  })
  it.each(['nothing','update'] as const)('does not create false admission from INSERT ON CONFLICT DO %s',async conflict=>{
    const f=await fixture(false),{id,reference,publicId,evidence}=await oldPending(f)
    await runner.run(scope,tx=>tx.query("UPDATE mbox.payments SET status='failed' WHERE id=$1",[id]))
    await admin.query("UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp(),closed_by_employee_id=$2 WHERE id=$1",[f.session,cashier])
    const before=(await admin.query("SELECT to_jsonb(p)-'updated_at' row FROM mbox.payments p WHERE id=$1",[id])).rows[0].row
    await runner.run(scope,async tx=>{
      const result=await tx.query(`INSERT INTO mbox.payments(id,tenant_id,store_id,payable_kind,order_id,public_id,provider,provider_transaction_id,method,amount_minor,currency,status,provider_snapshot,succeeded_at)
        VALUES($1,$2,$3,'order',$4,$5,'cash',$6,'cash',2400,'CNY','succeeded',$7::jsonb,clock_timestamp())
        ON CONFLICT(id) DO ${conflict==='nothing'?'NOTHING':'UPDATE SET updated_at=clock_timestamp()'}`,[id,scope.tenantId,scope.storeId,f.order,publicId,reference,JSON.stringify(evidence)])
      expect(result.rowCount).toBe(conflict==='nothing'?0:1)
      expect((await tx.query('SELECT count(*)::int n FROM mbox.closed_debt_manual_payment_admissions WHERE payment_id=$1',[id])).rows[0]!.n).toBe(0)
    })
    expect((await admin.query("SELECT to_jsonb(p)-'updated_at' row FROM mbox.payments p WHERE id=$1",[id])).rows[0].row).toEqual(before)
  })
})
