import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {PaymentCommandService} from './payment-command-service.js'
import {NormalizedPaymentCapabilityAuthorization} from './payment-security-policy.js'
import {NormalizedProviderObservationAuthority,VerifiedProviderObservationService} from './provider-verification-observation.js'
import {PostgresCashierWorkbenchQuery} from './cashier-workbench-query.js'
import {PostgresAutomaticTableTurnoverRepository} from './automatic-table-turnover-repository.js'
import {readOperatingHistory} from './operating-history-query.js'
import {PaymentFulfillmentRepository} from './payment-fulfillment-repository.js'
import {OnlinePaymentService} from './online-payment-service.js'
import {readCheckoutPrintSummary} from './checkout-print-summary.js'
import {PaymentRepository} from './payment-repository.js'

const url=process.env.TEST_NORMALIZED_DATABASE_URL,runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
;(url&&runtimeUrl?describe:describe.skip)('cross-day ordinary debt, restricted runtime LOGIN',()=>{
  let pool:Pool,runtime:Pool,runner:ScopedPostgresTransactionRunner,money:PaymentCommandService,date:string,yesterday:string
  const scope={tenantId:randomUUID(),storeId:randomUUID()},area=randomUUID(),product=randomUUID(),cashier=randomUUID(),other=randomUUID()
  const capabilities=['payment.history.collect','payment.initiate.staff','payment.manual.cash.record','payment.manual.pos.record','payment.manual.external.record','reconciliation.view']
  beforeAll(async()=>{
    await runNormalizedMigrations(url!)
    pool=new Pool({connectionString:url,max:8});runtime=new Pool({connectionString:runtimeUrl,max:8});runner=new ScopedPostgresTransactionRunner(runtime)
    expect((await runtime.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=session_user')).rows[0]).toEqual({rolsuper:false,rolbypassrls:false})
    money=new PaymentCommandService(new NormalizedCommandExecutor(runner),new NormalizedPaymentCapabilityAuthorization(),new NormalizedProviderObservationAuthority())
    await pool.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'debt fixture')",[scope.tenantId])
    await pool.query("INSERT INTO mbox.stores(id,tenant_id,code,name,timezone,business_day_cutoff) VALUES($1,$2,'debt','debt','Asia/Shanghai','06:00')",[scope.storeId,scope.tenantId])
    date=await runner.run(scope,async tx=>(await tx.query<{date:string}>('SELECT mbox.current_operating_business_date($1,$2)::text date',[scope.tenantId,scope.storeId])).rows[0]!.date)
    yesterday=new Date(Date.parse(date)-86400000).toISOString().slice(0,10)
    await pool.query("INSERT INTO mbox.store_automatic_table_turnover_policies(tenant_id,store_id,enabled) VALUES($1,$2,true)",[scope.tenantId,scope.storeId])
    await pool.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'A','A','indoor')",[area,scope.tenantId,scope.storeId])
    await pool.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station) VALUES($1,$2,$3,'DEBT','fixture','drink','none')",[product,scope.tenantId,scope.storeId])
    for(const employeeId of [cashier,other]){
      await pool.query('INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,$4,$4)',[employeeId,scope.tenantId,scope.storeId,employeeId])
      const role=randomUUID()
      await pool.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,$4,'fixture')",[role,scope.tenantId,scope.storeId,`D_${role.replaceAll('-','').toUpperCase()}`])
      await pool.query('INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id) VALUES($1,$2,$3,$4)',[scope.tenantId,scope.storeId,employeeId,role])
      for(const code of employeeId===cashier?capabilities:['payment.initiate.staff','payment.manual.cash.record']){
        const permission=(await pool.query("INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category) VALUES($1,$2,$3,$3,'finance') ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET name=EXCLUDED.name RETURNING id",[scope.tenantId,scope.storeId,code])).rows[0].id
        await pool.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[scope.tenantId,scope.storeId,role,permission])
      }
    }
  },30000)
  afterAll(async()=>{await runtime?.end();await pool?.end()})
  const meta=(employeeId=cashier)=>({scope,actor:{type:'employee' as const,employeeId},businessDate:date,idempotencyKey:randomUUID(),requestFingerprint:randomUUID()})
  async function fixture(options:{partial?:boolean;paid?:number;delivered?:boolean;discount?:number;close?:boolean}={}){
    const table=randomUUID(),session=randomUUID(),order=randomUUID(),item=randomUUID(),amount=10000-(options.discount??0)
    await pool.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,$5,$5,4)",[table,scope.tenantId,scope.storeId,area,`T${table.slice(0,8)}`])
    await pool.query('INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1::uuid,$2,$3,$4,$1::text,$5,2)',[session,scope.tenantId,scope.storeId,table,yesterday])
    await pool.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,submitted_at,subtotal_amount_minor,discount_amount_minor,total_amount_minor) VALUES($1::uuid,$2,$3,$4,$1::text,'staff_assisted',$5,clock_timestamp(),10000,$6,$7)",[order,scope.tenantId,scope.storeId,session,options.partial||options.delivered===false?'submitted':'completed',options.discount??0,amount])
    await pool.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot,status) VALUES($1,$2,$3,$4,$5,1,$6,$6,'none','{"name":"fixture","inventoryControlMode":"not_managed"}',$7)`,[item,scope.tenantId,scope.storeId,order,product,options.partial?5000:10000,options.delivered===false?'submitted':'delivered'])
    if(options.partial)await pool.query(`INSERT INTO mbox.order_items(tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot,status) VALUES($1,$2,$3,$4,1,5000,5000,'none','{"name":"undelivered"}','submitted')`,[scope.tenantId,scope.storeId,order,product])
    if(options.paid)await pool.query("INSERT INTO mbox.payments(tenant_id,store_id,order_id,public_id,provider,provider_transaction_id,method,amount_minor,currency,status,succeeded_at) VALUES($1,$2,$3,$4,'cash',$4,'cash',$5,'CNY','succeeded',clock_timestamp())",[scope.tenantId,scope.storeId,order,randomUUID(),options.paid])
    if(options.close!==false)await close(session)
    return {table,session,order,item,amount}
  }
  const close=(tableSessionId:string)=>runner.run(scope,tx=>new PostgresAutomaticTableTurnoverRepository(tx).close({scope,tableSessionId,businessDate:date,reasonNote:'自动截止保留原消费欠款',idempotencyKey:`cutoff:${tableSessionId}`}))
  const view=(orderId:string,extra:Record<string,unknown>={})=>new PostgresCashierWorkbenchQuery(runner).get({scope,employeeId:cashier,businessDate:date,capabilities,query:orderId,limit:50,...extra})
  const cash=(orderId:string,expectedOutstandingMinor:number,amountMinor?:number,employeeId=cashier)=>({ ...meta(employeeId),orderId,expectedOutstandingMinor,...(amountMinor===undefined?{}:{amountMinor}),publicId:randomUUID(),provider:'cash' as const,method:'cash' as const,evidence:{collectedByEmployeeId:employeeId,receiptReference:randomUUID()}})
  async function online(orderId:string,expectedOutstandingMinor:number){return (await money.initiate({...meta(),orderId,expectedOutstandingMinor,publicId:randomUUID(),provider:'postar',method:'native_qr',principal:{type:'employee',employeeId:cashier}})).value}
  async function confirm(payment:Awaited<ReturnType<typeof online>>){
    const occurredAt=new Date().toISOString(),providerTransactionId=randomUUID(),integrationRef='postar-active-query'
    const proof=await new VerifiedProviderObservationService(runner).recordPayment({scope,provider:'postar',verificationKind:'callback_signature',providerEventId:randomUUID(),integrationRef,paymentPublicId:payment.publicId,providerTransactionId,reportedAmountMinor:payment.amountMinor,reportedCurrency:'CNY',status:'succeeded',occurredAt,evidence:{fixture:true}})
    const command={scope,actor:{type:'integration' as const,ref:integrationRef},businessDate:date,idempotencyKey:randomUUID(),requestFingerprint:randomUUID(),verifiedObservationId:proof,paymentPublicId:payment.publicId,provider:'postar' as const,providerTransactionId,reportedAmountMinor:payment.amountMinor,reportedCurrency:'CNY',occurredAt}
    return {command,result:await money.recordSucceededCallback(command)}
  }
  it('retains and finds an ordinary unpaid invoice after real cutoff, without refund authorization',async()=>{
    const f=await fixture(),row=(await view(f.order)).orders[0]!
    expect(row).toMatchObject({businessDate:yesterday,tableSessionStatus:'closed',outstandingAmountMinor:10000,closedDebtRecovery:{kind:'consumption',status:'available'}})
    expect((await pool.query('SELECT count(*)::int count FROM mbox.order_recollection_authorizations WHERE order_id=$1',[f.order])).rows[0].count).toBe(0)
    await close(f.session)
    expect((await pool.query('SELECT count(*)::int count FROM mbox.order_carryover_debts WHERE order_id=$1',[f.order])).rows[0].count).toBe(1)
  })
  it('collects only delivered items from a partially retired order',async()=>{
    const f=await fixture({partial:true}),row=(await view(f.order)).orders[0]!
    expect(row).toMatchObject({status:'cancelled',outstandingAmountMinor:5000,totalAmountMinor:5000,closedDebtRecovery:{status:'available'}})
    await money.recordManual(cash(f.order,5000))
    expect((await view(f.order)).orders[0]).toMatchObject({outstandingAmountMinor:0,paymentStatus:'paid'})
    expect(await runner.run(scope,tx=>readCheckoutPrintSummary(tx,[f.order]))).toMatchObject({receivable:5000,received:5000,due:0,state:'paid',carryover:true})
  })
  it('keeps partial-delivery discounts in visible review rather than guessing a collectible amount',async()=>{
    const f=await fixture({partial:true,discount:1000})
    expect((await view(f.order)).orders[0]?.closedDebtRecovery).toMatchObject({status:'ineligible',reviewReason:expect.stringContaining('部分履约')})
    await expect(money.recordManual(cash(f.order,5000))).rejects.toThrow()
  })
  it('does not turn unfulfilled abandoned carts or fully paid orders into debt',async()=>{
    for(const options of [{delivered:false},{paid:10000}]){
      const f=await fixture(options)
      expect((await pool.query('SELECT count(*)::int count FROM mbox.order_carryover_debts WHERE order_id=$1',[f.order])).rows[0].count).toBe(0)
    }
  })
  it('uses actual outstanding balance and supports partial receipts with exact retry recovery',async()=>{
    const f=await fixture({paid:2000}),command=cash(f.order,8000,3000)
    const first=await money.recordManual(command),again=await money.recordManual(command)
    expect(first.value.amountMinor).toBe(3000);expect(again.replayed).toBe(true);expect(again.value.id).toBe(first.value.id)
    expect((await view(f.order)).orders[0]?.outstandingAmountMinor).toBe(5000)
    await expect(money.recordManual(cash(f.order,8000))).rejects.toThrow('变化')
    await money.recordManual(cash(f.order,5000))
    expect((await view(f.order)).orders[0]?.outstandingAmountMinor).toBe(0)
  })
  it('serializes concurrent cashiers, retains receipt replay, and rejects over-collection',async()=>{
    const f=await fixture(),a=cash(f.order,10000),b=cash(f.order,10000)
    const results=await Promise.allSettled([money.recordManual(a),money.recordManual(b)])
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
    const winner=results[0]!.status==='fulfilled'?a:b
    expect((await money.recordManual(winner)).replayed).toBe(true)
    await expect(money.recordManual(cash(f.order,10000,10001))).rejects.toThrow()
  })
  it('creates an online payment, consumes verified callback once and keeps the original day and closed table',async()=>{
    const f=await fixture(),payment=await online(f.order,10000)
    const {command}=await confirm(payment)
    expect((await money.recordSucceededCallback(command)).replayed).toBe(true)
    expect((await view(f.order)).orders[0]).toMatchObject({businessDate:yesterday,tableSessionStatus:'closed',outstandingAmountMinor:0})
    const entries=(await pool.query('SELECT business_date::text,amount_minor::text FROM mbox.reconciliation_entries WHERE payment_id=$1',[payment.id])).rows
    expect(entries).toEqual([{business_date:date,amount_minor:'10000'}])
    expect((await pool.query('SELECT status FROM mbox.order_items WHERE id=$1',[f.item])).rows[0].status).toBe('delivered')
  })
  it('retains late duplicate funds as excess after cash recovery without reissuing goods',async()=>{
    const f=await fixture(),payment=await online(f.order,10000)
    await money.recordManual(cash(f.order,10000))
    await confirm(payment)
    expect((await view(f.order)).orders[0]).toMatchObject({outstandingAmountMinor:0,overCollectedAmountMinor:10000})
    expect((await pool.query("SELECT signal FROM mbox.payment_financial_monitoring_signals WHERE subject_id=$1 AND signal='order_overcollected'",[f.order])).rows).toHaveLength(1)
  })
  it('does not grant collection through a former/current table assignment or another store',async()=>{
    const f=await fixture()
    await expect(money.recordManual(cash(f.order,10000,undefined,other))).rejects.toThrow()
    await expect(money.recordManual({...cash(f.order,10000),scope:{tenantId:scope.tenantId,storeId:randomUUID()}})).rejects.toThrow()
    await expect(runner.run(scope,tx=>tx.query('UPDATE mbox.order_carryover_debts SET receivable_minor=1 WHERE order_id=$1',[f.order]))).rejects.toThrow()
  })
  it('requires a fresh exact balance and a positive, bounded partial amount',async()=>{
    const f=await fixture()
    const absent=cash(f.order,10000);delete (absent as {expectedOutstandingMinor?:number}).expectedOutstandingMinor
    await expect(money.recordManual(absent)).rejects.toThrow('变化')
    for(const amount of [0,-1,10001,1.5,Number.MAX_SAFE_INTEGER+1])await expect(money.recordManual(cash(f.order,10000,amount))).rejects.toThrow()
    expect((await view(f.order)).orders[0]?.outstandingAmountMinor).toBe(10000)
  })
  it('records POS and external receipts against the remaining debt in separate installments',async()=>{
    const f=await fixture()
    await money.recordManual({...cash(f.order,10000,4000),provider:'physical_pos',method:'card',evidence:{collectedByEmployeeId:cashier,receiptReference:randomUUID(),terminalId:'LOCAL-POS-01'}})
    await money.recordManual({...cash(f.order,6000),provider:'external_manual',method:'manual',evidence:{collectedByEmployeeId:cashier,receiptReference:randomUUID(),externalMethodCode:'other',collectionNote:'隔离外部实收凭据'}})
    expect((await view(f.order)).orders[0]?.outstandingAmountMinor).toBe(0)
  })
  it('checks current historical permission when replaying an online initiation receipt',async()=>{
    const f=await fixture(),command={...meta(),orderId:f.order,expectedOutstandingMinor:10000,publicId:randomUUID(),provider:'postar' as const,method:'native_qr' as const,principal:{type:'employee' as const,employeeId:cashier}}
    const first=await money.initiate(command)
    expect((await money.initiate(command)).value.id).toBe(first.value.id)
    const removed=(await pool.query(`DELETE FROM mbox.role_permission_assignments a USING mbox.staff_permission_definitions p,mbox.employee_roles r
      WHERE (a.tenant_id,a.store_id,a.permission_id)=(p.tenant_id,p.store_id,p.id) AND (a.tenant_id,a.store_id,a.role_id)=(r.tenant_id,r.store_id,r.role_id)
        AND r.employee_id=$1 AND p.code='payment.history.collect' RETURNING a.*`,[cashier])).rows
    try{await expect(money.initiate(command)).rejects.toThrow();await expect(money.recordManual(cash(f.order,10000))).rejects.toThrow()}
    finally{for(const a of removed)await pool.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) VALUES($1,$2,$3,$4)',[a.tenant_id,a.store_id,a.role_id,a.permission_id])}
    expect((await money.initiate(command)).replayed).toBe(true)
  })
  it('keeps the original table closed and a new guest session unchanged, with no fulfillment effects',async()=>{
    const f=await fixture(),newSession=randomUUID()
    await pool.query('INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1::uuid,$2,$3,$4,$1::text,$5,3)',[newSession,scope.tenantId,scope.storeId,f.table,date])
    const before=(await pool.query('SELECT * FROM mbox.table_sessions WHERE id=$1',[newSession])).rows[0]
    await money.recordManual(cash(f.order,10000))
    expect((await pool.query('SELECT * FROM mbox.table_sessions WHERE id=$1',[newSession])).rows[0]).toEqual(before)
    const effects=await runner.run(scope,async tx=>({activation:await new PaymentFulfillmentRepository(tx).activatePaidOrder(f.order),release:await new PaymentFulfillmentRepository(tx).releaseAfterDefinitiveFailure(f.order,'local failure replay')}))
    expect(effects.activation).toMatchObject({activated:false,financialAttributionEligible:false,inventoryConsumptions:[],kdsTasks:[]})
    expect(effects.release).toMatchObject({released:false,reservationCount:0})
    expect((await pool.query("SELECT * FROM mbox.outbox_messages WHERE aggregate_type='order' AND aggregate_id=$1",[f.order])).rows).toHaveLength(0)
    expect((await pool.query('SELECT * FROM mbox.loyalty_order_awards WHERE order_id=$1',[f.order])).rows).toHaveLength(0)
  })
  it('shows partial-consumption sales on the original day and posted collection only on receipt day',async()=>{
    const f=await fixture({partial:true})
    const before=await runner.run(scope,tx=>readOperatingHistory(tx,{businessDate:date,table:'',employee:'',page:0}))
    await money.recordManual(cash(f.order,5000))
    const [today,original]=await runner.run(scope,async tx=>Promise.all([readOperatingHistory(tx,{businessDate:date,table:'',employee:'',page:0}),readOperatingHistory(tx,{businessDate:yesterday,table:'',employee:'',page:0})]))
    const historical=(data:typeof today)=>data.receipts.reduce((sum,row)=>sum+(row.historicalCollectionMinor??0),0)
    expect(historical(today)-historical(before)).toBe(5000)
    expect(today.summary?.orderAmountMinor).toBe(before.summary?.orderAmountMinor)
    expect(original.orders.find(order=>order.id===f.order)?.effectiveAmountMinor).toBe(5000)
    const dbSummary=await runner.run(scope,async tx=>(await tx.query<{summary:unknown}>('SELECT mbox.operating_day_summary($1,$2,$3) summary',[scope.tenantId,scope.storeId,yesterday])).rows[0]!.summary)
    expect(original.summary).toEqual(dbSummary)
  })
  it('does not resurrect genuinely cancelled records when their table later closes',async()=>{
    const f=await fixture({close:false})
    await pool.query("UPDATE mbox.orders SET status='cancelled' WHERE id=$1",[f.order])
    await close(f.session)
    expect((await pool.query('SELECT * FROM mbox.order_carryover_debts WHERE order_id=$1',[f.order])).rows).toHaveLength(0)
    await pool.query("UPDATE mbox.table_sessions SET status='closed' WHERE id=$1",[f.session])
    expect((await pool.query('SELECT * FROM mbox.order_carryover_debts WHERE order_id=$1',[f.order])).rows).toHaveLength(0)
  })
  it('allows partial online collection and retains late settlement authority',async()=>{
    const f=await fixture(),first=await money.initiate({...meta(),orderId:f.order,expectedOutstandingMinor:10000,amountMinor:3000,publicId:randomUUID(),provider:'postar',method:'auth_code',principal:{type:'employee',employeeId:cashier}})
    expect(first.value.amountMinor).toBe(3000)
    await confirm(first.value)
    expect((await view(f.order)).orders[0]?.outstandingAmountMinor).toBe(7000)
    await money.recordManual(cash(f.order,7000))
    expect((await view(f.order)).orders[0]?.outstandingAmountMinor).toBe(0)
  })
  it('creates and replays a provider QR from original debt after the product is no longer for sale',async()=>{
    const f=await fixture(),payment=await online(f.order,10000),calls:unknown[]=[]
    const unavailable=async()=>{throw new Error('Unexpected provider operation')}
    const config={provider:'postar' as const,environment:'test' as const,agencyId:'SYNTHETIC',merchantId:'SYNTHETIC',publicKey:'synthetic-unused-with-adapter',callbackUrl:'https://example.test/unused',timeoutMs:1000,wechat:null}
    const service=new OnlinePaymentService(runner,'local-cross-day-debt-provider-secret',config,{
      createPayment:async request=>{calls.push(request);return {paymentIntentId:request.paymentIntentId,providerTransactionId:null,status:'processing',amount:request.amount,currency:request.currency,merchantId:'SYNTHETIC',occurredAt:new Date().toISOString(),paymentPayload:{code_url:'https://example.test/synthetic-qr'}}},
      queryPayment:unavailable,closePayment:unavailable,requestRefund:unavailable,queryRefund:unavailable,
    })
    const input={scope,paymentId:payment.id,principal:{type:'employee' as const,employeeId:cashier},clientIp:'127.0.0.1',operatorId:cashier,idempotencyKey:randomUUID()}
    // No product price exists in this fixture: it is an original consumed debt,
    // not a fresh sale. The adapter is entirely in-process, with no network I/O.
    expect(await service.create(input)).toMatchObject({paymentId:payment.id,presentation:'qr',status:'pending'})
    expect(await service.create(input)).toMatchObject({paymentId:payment.id,presentation:'qr'})
    expect(calls).toHaveLength(1)
    await money.recordManual(cash(f.order,10000))
    await expect(service.create(input)).rejects.toThrow()
    expect(calls).toHaveLength(1)
  })
  it('releases an unresolved original attempt explicitly, preserving late capture and the audit trail',async()=>{
    const f=await fixture(),first=await online(f.order,10000)
    const command={...meta(),paymentId:first.id,reason:'核对后放开新的收款尝试，原结果继续追踪'}
    await money.releaseUnresolvedForRetry(command)
    const replacement=await online(f.order,10000)
    expect(replacement.id).not.toBe(first.id)
    await confirm(replacement);await confirm(first)
    expect((await view(f.order)).orders[0]?.overCollectedAmountMinor).toBe(10000)
  })
  it('rejects direct paid projection without a matching ledger and rejects edits to financial identity',async()=>{
    const f=await fixture(),reference=randomUUID()
    await expect(runner.run(scope,async tx=>{
      await tx.query(`INSERT INTO mbox.payments(tenant_id,store_id,order_id,public_id,provider,provider_transaction_id,method,amount_minor,currency,status,succeeded_at,provider_snapshot)
        VALUES($1,$2,$3,$4,'cash',$4,'cash',10000,'CNY','succeeded',clock_timestamp(),$5::jsonb)`,[scope.tenantId,scope.storeId,f.order,reference,JSON.stringify({collectedByEmployeeId:cashier,receiptReference:reference})])
      await tx.query("UPDATE mbox.orders SET payment_status='paid' WHERE tenant_id=$1 AND store_id=$2 AND id=$3",[scope.tenantId,scope.storeId,f.order])
    })).rejects.toThrow()
    expect((await view(f.order)).orders[0]?.outstandingAmountMinor).toBe(10000)
    for(const mutation of ["payment_status='paid'","total_amount_minor=1","currency='USD'","status='submitted'","table_session_id=NULL"])
      await expect(runner.run(scope,tx=>tx.query(`UPDATE mbox.orders SET ${mutation} WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[scope.tenantId,scope.storeId,f.order]))).rejects.toThrow()
  })
  it('denies creation of provider actions by a collector without the historical permission',async()=>{
    const f=await fixture(),payment=await online(f.order,10000),service=new OnlinePaymentService(runner,'local-cross-day-debt-provider-secret',null)
    await expect(service.create({scope,paymentId:payment.id,principal:{type:'employee',employeeId:other},clientIp:'127.0.0.1',operatorId:other,idempotencyKey:randomUUID()})).rejects.toThrow()
    expect((await pool.query('SELECT * FROM mbox.payment_provider_actions WHERE payment_id=$1',[payment.id])).rows).toHaveLength(0)
  })
  it('applies an original whole-table payment that arrives after closure to every original allocation',async()=>{
    const f=await fixture({close:false}),secondOrder=randomUUID()
    await pool.query(`INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,submitted_at,subtotal_amount_minor,total_amount_minor)
      VALUES($1::uuid,$2,$3,$4,$1::text,'staff_assisted','completed',clock_timestamp(),6000,6000)`,[secondOrder,scope.tenantId,scope.storeId,f.session])
    await pool.query(`INSERT INTO mbox.order_items(tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot,status)
      VALUES($1,$2,$3,$4,1,6000,6000,'none','{"name":"second consumed item","inventoryControlMode":"not_managed"}','delivered')`,[scope.tenantId,scope.storeId,secondOrder,product])
    const original=await runner.run(scope,tx=>new PaymentRepository(tx).createForOrders({orderId:f.order,orderIds:[f.order,secondOrder],publicId:randomUUID(),provider:'postar',method:'native_qr',initialStatus:'pending',principal:{type:'employee',employeeId:cashier}}))
    await close(f.session)
    expect((await view(secondOrder)).orders[0]?.outstandingAmountMinor).toBe(6000)
    await confirm(original)
    for(const id of [f.order,secondOrder])expect((await view(id)).orders[0]).toMatchObject({tableSessionStatus:'closed',outstandingAmountMinor:0,paymentStatus:'paid'})
    expect((await pool.query('SELECT amount_minor::int FROM mbox.reconciliation_entries WHERE payment_id=$1',[original.id])).rows).toEqual([{amount_minor:16000}])
  })
  it.each(['cash','postar'] as const)('preserves approved %s refunds after the original collector loses collection permission',async provider=>{
    const f=await fixture(),payment=provider==='cash'?(await money.recordManual(cash(f.order,10000))).value:(await confirm(await online(f.order,10000))).result.value
    for(const [employeeId,codes] of [[other,['refund.request']],[cashier,['refund.approve','refund.execute']]] as const){
      for(const code of codes)await pool.query(`INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
        SELECT p.tenant_id,p.store_id,r.role_id,p.id FROM mbox.staff_permission_definitions p JOIN mbox.employee_roles r
          ON (r.tenant_id,r.store_id)=(p.tenant_id,p.store_id)
        WHERE r.employee_id=$1 AND p.code=$2 ON CONFLICT DO NOTHING`,[employeeId,code])
    }
    await pool.query(`INSERT INTO mbox.role_approval_limits(tenant_id,store_id,role_id,approval_code,amount_minor,currency)
      SELECT tenant_id,store_id,role_id,'refund.approve',100000,'CNY' FROM mbox.employee_roles WHERE employee_id=$1 ON CONFLICT DO NOTHING`,[cashier])
    const refund=(await money.requestRefund({...meta(other),paymentId:payment.id,publicId:randomUUID(),purpose:'price_adjustment',reason:'补收后原商品价差核对退款',allocations:[{orderItemId:f.item,amountMinor:2000}]})).value
    await money.approveRefund({...meta(),refundId:refund.id,decisionReason:'异人核对已补收原商品退款'})
    await money.beginRefundExecution({...meta(),refundId:refund.id})
    const removed=(await pool.query(`DELETE FROM mbox.role_permission_assignments a USING mbox.staff_permission_definitions p,mbox.employee_roles r
      WHERE (a.tenant_id,a.store_id,a.permission_id)=(p.tenant_id,p.store_id,p.id) AND (a.tenant_id,a.store_id,a.role_id)=(r.tenant_id,r.store_id,r.role_id)
        AND r.employee_id=$1 AND p.code='payment.history.collect' RETURNING a.*`,[cashier])).rows
    try{
      if(provider==='cash')await money.recordManualRefundResult({...meta(),refundId:refund.id,succeeded:true,receiptReference:randomUUID()})
      else {
        const occurredAt=new Date().toISOString(),providerRefundId=randomUUID(),integrationRef='cross-day-refund-fixture'
        const verifiedObservationId=await new VerifiedProviderObservationService(runner).recordRefund({scope,provider:'postar',verificationKind:'callback_signature',providerEventId:randomUUID(),integrationRef,refundPublicId:refund.publicId,providerTransactionId:providerRefundId,originalProviderTransactionId:payment.providerTransactionId!,reportedAmountMinor:2000,reportedCurrency:'CNY',status:'succeeded',occurredAt,evidence:{fixture:true}})
        await money.recordProviderRefundResult({...meta(),actor:{type:'integration',ref:integrationRef},verifiedObservationId,refundPublicId:refund.publicId,provider:'postar',providerRefundId,originalProviderTransactionId:payment.providerTransactionId!,reportedAmountMinor:2000,reportedCurrency:'CNY',succeeded:true,occurredAt})
      }
      expect((await view(f.order)).orders[0]).toMatchObject({paymentStatus:'partially_refunded',outstandingAmountMinor:0})
      await expect(money.recordManual(cash(f.order,2000))).rejects.toThrow()
    }finally{for(const a of removed)await pool.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) VALUES($1,$2,$3,$4)',[a.tenant_id,a.store_id,a.role_id,a.permission_id])}
  })
  it('paginates the complete cross-day unpaid scope beyond 100 records',async()=>{
    const ids=[];for(let n=0;n<102;n++)ids.push((await fixture()).order)
    const first=await view('',{collectionScope:'unsettled',limit:100,page:0}),second=await view('',{collectionScope:'unsettled',limit:100,page:1})
    const found=new Set([...first.orders,...second.orders].map(o=>o.id))
    expect(ids.every(id=>found.has(id))).toBe(true)
    expect(first.pagination!.totalCount).toBeGreaterThanOrEqual(102)
    expect(first.orders.some(a=>second.orders.some(b=>a.id===b.id))).toBe(false)
    const empty=await view('',{collectionScope:'unsettled',limit:100,page:100})
    expect(empty.orders).toHaveLength(0)
    expect(empty.pagination!.totalCount).toBe(first.pagination!.totalCount)
    expect(empty.pagination!.totalOutstandingMinor).toBe(first.pagination!.totalOutstandingMinor)
  },30000)
})
