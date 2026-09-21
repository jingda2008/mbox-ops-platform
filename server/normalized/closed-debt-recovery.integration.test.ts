import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import Fastify from 'fastify'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {PaymentCommandService} from './payment-command-service.js'
import {NormalizedPaymentCapabilityAuthorization} from './payment-security-policy.js'
import {NormalizedProviderObservationAuthority,VerifiedProviderObservationService} from './provider-verification-observation.js'
import {paymentApiPlugin} from './payment-api.js'
import {PostgresCashierWorkbenchQuery} from './cashier-workbench-query.js'
import {PaymentProviderActionRepository} from './payment-provider-action-repository.js'
import {PaymentRepository} from './payment-repository.js'
import {lockClosedDebtRecovery} from './closed-debt-recovery.js'
import {StaffAccessRepository} from './staff-access-repository.js'

const url=process.env.TEST_NORMALIZED_DATABASE_URL,runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
;(url&&runtimeUrl?describe:describe.skip)('closed historical debt recovery, restricted LOGIN',()=>{
  let pool:Pool,runtimePool:Pool,runner:ScopedPostgresTransactionRunner,money:PaymentCommandService,date:string
  const scope={tenantId:randomUUID(),storeId:randomUUID()},area=randomUUID(),product=randomUUID(),requester=randomUUID(),cashier=randomUUID(),other=randomUUID()
  const capabilities=['payment.initiate.staff','payment.manual.cash.record','payment.collect.all_tables','payment.recollect.authorize','reconciliation.view','refund.request','refund.approve','refund.execute']
  beforeAll(async()=>{
    await runNormalizedMigrations(url!)
    pool=new Pool({connectionString:url,max:8});runtimePool=new Pool({connectionString:runtimeUrl,max:8});runner=new ScopedPostgresTransactionRunner(runtimePool)
    expect((await runtimePool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=session_user')).rows[0]).toEqual({rolsuper:false,rolbypassrls:false})
    money=new PaymentCommandService(new NormalizedCommandExecutor(runner),new NormalizedPaymentCapabilityAuthorization(),new NormalizedProviderObservationAuthority())
    await pool.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'closed debt fixture')",[scope.tenantId,scope.tenantId])
    await pool.query("INSERT INTO mbox.stores(id,tenant_id,code,name,timezone,business_day_cutoff) VALUES($1,$2,'debt','closed debt','Asia/Shanghai','06:00')",[scope.storeId,scope.tenantId])
    date=await runner.run(scope,async tx=>(await tx.query<{date:string}>('SELECT mbox.current_operating_business_date($1,$2)::text date',[scope.tenantId,scope.storeId])).rows[0]!.date)
    await pool.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'A','A','indoor')",[area,scope.tenantId,scope.storeId])
    await pool.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station) VALUES($1,$2,$3,'DEBT','Fixture','drink','none')",[product,scope.tenantId,scope.storeId])
    for(const employeeId of [cashier,requester,other]){
      await pool.query('INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,$4,$4)',[employeeId,scope.tenantId,scope.storeId,employeeId])
      const role=randomUUID()
      await pool.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,$4,'fixture')",[role,scope.tenantId,scope.storeId,`D_${role.replaceAll('-','').toUpperCase()}`])
      await pool.query('INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id) VALUES($1,$2,$3,$4)',[scope.tenantId,scope.storeId,employeeId,role])
      for(const code of employeeId===cashier?capabilities:['refund.request','payment.manual.cash.record']){
        const permission=(await pool.query("INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category) VALUES($1,$2,$3,$3,'operations') ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET name=EXCLUDED.name RETURNING id",[scope.tenantId,scope.storeId,code])).rows[0].id
        await pool.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[scope.tenantId,scope.storeId,role,permission])
      }
      if(employeeId===cashier)await pool.query("INSERT INTO mbox.role_approval_limits(tenant_id,store_id,role_id,approval_code,amount_minor,currency) VALUES($1,$2,$3,'refund.approve',100000,'CNY')",[scope.tenantId,scope.storeId,role])
    }
  },30000)
  afterAll(async()=>{await runtimePool?.end();await pool?.end()})
  const meta=(employeeId=cashier)=>({scope,actor:{type:'employee' as const,employeeId},businessDate:date,idempotencyKey:randomUUID(),requestFingerprint:randomUUID()})
  async function app(employeeId=cashier,currentScope=scope){
    const server=Fastify({logger:{level:'error'}}),context=()=>({scope:currentScope,actor:{type:'employee' as const,employeeId},employeeId,businessDate:date,capabilities})
    const unused=async()=>{throw new Error('unused port')}
    await server.register(paymentApiPlugin,{commands:money,providerVerifier:{verifyPaymentCallback:unused,verifyRefundCallback:unused},providerObservations:new VerifiedProviderObservationService(runner),reconciliationQuery:{list:unused},cashierWorkbenchQuery:new PostgresCashierWorkbenchQuery(runner),orderCancellation:{cancel:unused},orderSettlementException:{settle:unused},resolveActorContext:context,resolveStaffContext:context,resolveProviderBusinessDate:()=>date})
    return server
  }
  async function post(path:string,payload:object={},key=randomUUID(),employeeId=cashier,currentScope=scope){const server=await app(employeeId,currentScope);try{return await server.inject({method:'POST',url:path,headers:{'idempotency-key':key},payload})}finally{await server.close()}}
  const authorize=(order:string,key=randomUUID())=>post(`/orders/${order}/recollection-authorizations`,{reason:'核对关桌前原退款及真实剩欠，单独补收'},key)
  const manual=(order:string,key=randomUUID(),employeeId=cashier,currentScope=scope)=>post('/payments/manual',{orderId:order,provider:'cash',method:'cash'},key,employeeId,currentScope)
  const closeLocal=(paymentId:string,key=randomUUID())=>post(`/payments/${paymentId}/close-unpresented-history`,{reason:'核对仅本地未外送尝试，不代表渠道退款'},key)
  const waitingRuntimeLocks=async()=>Number((await pool.query("SELECT count(*) n FROM pg_stat_activity WHERE datname=current_database() AND usename=$1 AND wait_event_type='Lock'",[new URL(runtimeUrl!).username])).rows[0].n)
  const view=async(order:string)=>(await new PostgresCashierWorkbenchQuery(runner).get({scope,employeeId:cashier,businessDate:date,capabilities,query:order,limit:20})).orders.find(row=>row.id===order)!
  async function fixture(kind:'partial'|'pending'|'ordinary'='partial',originalDate=date){
    const table=randomUUID(),session=randomUUID(),order=randomUUID(),item=randomUUID()
    await pool.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,$5,$5,4)",[table,scope.tenantId,scope.storeId,area,`T${table.slice(0,8)}`])
    await pool.query('INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1,$2,$3,$4,$6,$5,2)',[session,scope.tenantId,scope.storeId,table,originalDate,session])
    await pool.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,submitted_at,subtotal_amount_minor,total_amount_minor) VALUES($1,$2,$3,$4,$5,'staff_assisted','submitted',clock_timestamp(),4000,4000)",[order,scope.tenantId,scope.storeId,session,order])
    await pool.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot) VALUES($1,$2,$3,$4,$5,1,4000,4000,'none','{"name":"fixture","inventoryControlMode":"not_managed"}')`,[item,scope.tenantId,scope.storeId,order,product])
    const originalKey=randomUUID(),paid=await manual(order,originalKey);expect(paid.statusCode,paid.body).toBe(201)
    let pending:{id:string;publicId:string}|undefined
    if(kind!=='ordinary'){
      const refund=(await money.requestRefund({...meta(requester),paymentId:paid.json().data.id,publicId:randomUUID(),purpose:'price_adjustment',reason:'原始财务调价退款',allocations:[{orderItemId:item,amountMinor:2000}]})).value
      await money.approveRefund({...meta(),refundId:refund.id,decisionReason:'异人核准原退款'})
      await money.beginRefundExecution({...meta(),refundId:refund.id});await money.recordManualRefundResult({...meta(),refundId:refund.id,succeeded:true,receiptReference:randomUUID()})
      expect((await authorize(order)).statusCode).toBe(201)
      if(kind==='partial')await money.recordManual({...meta(),orderId:order,orderIds:[order],amountMinor:1000,publicId:randomUUID(),provider:'cash',method:'cash',evidence:{collectedByEmployeeId:cashier,receiptReference:randomUUID()}})
      else pending=(await money.initiate({...meta(),orderId:order,publicId:randomUUID(),provider:'postar',method:'native_qr',principal:{type:'employee',employeeId:cashier}})).value
    }
    // Synthetic fixture preserves the closed-with-debt legacy fact. The separate
    // dump-restore acceptance reproduces actual 234 HTTP closure before upgrade.
    await pool.query("UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp(),closed_by_employee_id=$2 WHERE id=$1",[session,cashier])
    return {order,session,item,pending,originalKey,originalPaymentId:paid.json().data.id}
  }
  it('recovers only the ten-yuan balance, writes current-day audit/ledger, leaves closed table unchanged and replays',async()=>{
    const originalDate=new Date(Date.parse(`${date}T12:00:00Z`)-86400000).toISOString().slice(0,10)
    const f=await fixture('partial',originalDate);expect((await view(f.order)).closedDebtRecovery?.status).toBe('authorization_required')
    const auth=await authorize(f.order);expect(auth.statusCode,auth.body).toBe(201)
    expect((await view(f.order)).closedDebtRecovery?.status).toBe('available')
    const key=randomUUID(),paid=await manual(f.order,key);expect(paid.statusCode,paid.body).toBe(201);expect(paid.json().data.amountMinor).toBe(1000)
    expect((await manual(f.order,key)).json().meta.replayed).toBe(true)
    expect((await view(f.order)).outstandingAmountMinor).toBe(0)
    expect((await manual(f.order)).statusCode).toBe(409)
    expect((await pool.query('SELECT status FROM mbox.table_sessions WHERE id=$1',[f.session])).rows[0].status).toBe('closed')
    const ledger=(await pool.query('SELECT business_date::text,evidence_snapshot FROM mbox.reconciliation_entries WHERE payment_id=$1',[paid.json().data.id])).rows
    expect(ledger).toHaveLength(1);expect(ledger[0]).toMatchObject({business_date:date})
    const audit=(await pool.query("SELECT business_date::text,after_snapshot FROM mbox.audit_events WHERE object_id=$1 AND action='payment.closed_debt_recovered'",[paid.json().data.id])).rows[0]
    expect(audit).toMatchObject({business_date:date,after_snapshot:{tableSessionId:f.session,originalBusinessDate:originalDate,collectionBusinessDate:date}})
    expect((await pool.query('SELECT o.business_date::text order_day,s.business_date::text session_day FROM mbox.orders o JOIN mbox.table_sessions s ON s.id=o.table_session_id WHERE o.id=$1',[f.order])).rows[0]).toEqual({order_day:originalDate,session_day:originalDate})
    const oldDay=await runner.run(scope,async tx=>(await tx.query<{summary:{outstandingMinor:string}}> ('SELECT mbox.operating_day_summary($1,$2,$3) summary',[scope.tenantId,scope.storeId,originalDate])).rows[0]!.summary)
    expect(oldDay.outstandingMinor).toBe('0')
    expect((await pool.query("SELECT count(*)::int n FROM mbox.audit_events WHERE object_id=$1 AND action='payment.closed_debt_recovered'",[paid.json().data.id])).rows[0].n).toBe(1)
  })
  it('blocks pending until explicit proof-bound local close, then reauthorizes and collects once',async()=>{
    const f=await fixture('pending'),payment=f.pending!
    expect((await view(f.order)).closedDebtRecovery).toMatchObject({status:'pending_payment',pendingPaymentIds:[payment.id],closableUnpresentedPaymentIds:[payment.id]})
    expect((await authorize(f.order)).statusCode).toBe(409);expect((await manual(f.order)).statusCode).toBe(409)
    const key=randomUUID(),closed=await closeLocal(payment.id,key);expect(closed.statusCode,closed.body).toBe(201);expect(closed.json().data.status).toBe('closed')
    expect((await closeLocal(payment.id,key)).json().meta.replayed).toBe(true)
    expect((await authorize(f.order)).statusCode).toBe(201)
    expect((await manual(f.order)).json().data.amountMinor).toBe(2000)
  })
  it('matches local-close visibility to current command permissions without requiring provider query permission',async()=>{
    const f=await fixture('pending'),payment=f.pending!
    const actualView=async()=>{
      const access=await runner.run(scope,tx=>new StaffAccessRepository(tx).resolve(cashier),{readOnly:true})
      const result=await new PostgresCashierWorkbenchQuery(runner).get({scope,employeeId:cashier,businessDate:date,capabilities:access.permissions,query:f.order,limit:20})
      return {permissions:access.permissions,order:result.orders.find(row=>row.id===f.order)!}
    }
    const queryPermission=(await pool.query("INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category) VALUES($1,$2,'payment.query','query','operations') ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET name=EXCLUDED.name RETURNING id",[scope.tenantId,scope.storeId])).rows[0].id
    for(const code of ['payment.initiate.staff','reconciliation.view','payment.collect.all_tables','payment.recollect.authorize']){
      await pool.query("INSERT INTO mbox.employee_permission_overrides(tenant_id,store_id,employee_id,permission_id,effect,reason,configured_by_employee_id,starts_at) VALUES($1,$2,$3,$4,'grant','query-only visibility fixture',$3,clock_timestamp()-interval '1 minute')",[scope.tenantId,scope.storeId,cashier,queryPermission])
      await pool.query("INSERT INTO mbox.employee_permission_overrides(tenant_id,store_id,employee_id,permission_id,effect,reason,configured_by_employee_id,starts_at) SELECT $1,$2,$3,id,'deny','current command permission withdrawn',$3,clock_timestamp()-interval '1 minute' FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code=$4",[scope.tenantId,scope.storeId,cashier,code])
      try{
        const denied=await actualView()
        expect(denied.permissions).toContain('payment.query');expect(denied.permissions).not.toContain(code)
        expect(denied.order.closedDebtRecovery?.closableUnpresentedPaymentIds,code).toEqual([])
        expect((await closeLocal(payment.id)).statusCode,code).toBe(403)
      }finally{await pool.query('DELETE FROM mbox.employee_permission_overrides WHERE tenant_id=$1 AND store_id=$2 AND employee_id=$3',[scope.tenantId,scope.storeId,cashier])}
    }
    const allowed=await actualView()
    expect(allowed.permissions).not.toContain('payment.query')
    expect(allowed.order.closedDebtRecovery?.closableUnpresentedPaymentIds).toEqual([payment.id])
    expect((await closeLocal(payment.id)).statusCode).toBe(201)
  })
  it('keeps unknown/failed provider actions and retry-released attempts blocked',async()=>{
    const f=await fixture('pending'),payment=f.pending!
    await runner.run(scope,tx=>new PaymentProviderActionRepository(tx,'fixture-secret-32-characters-long').claim(payment.id,'qr',new Date(Date.now()+60000).toISOString(),{type:'employee',employeeId:cashier}))
    await pool.query("UPDATE mbox.payment_provider_actions SET state='failed' WHERE payment_id=$1",[payment.id])
    await pool.query("UPDATE mbox.payments SET retry_released_at=clock_timestamp(),retry_released_by_employee_id=$2,retry_release_reason='legacy retry release' WHERE id=$1",[payment.id,cashier])
    expect((await view(f.order)).closedDebtRecovery).toMatchObject({status:'pending_payment',closableUnpresentedPaymentIds:[]})
    expect((await closeLocal(payment.id)).statusCode).toBe(409);expect((await manual(f.order)).statusCode).toBe(409)
  })
  it('rejects foreign scope, unauthorized collector, changed payload, and revoked access on exact replay',async()=>{
    const f=await fixture();expect((await authorize(f.order)).statusCode).toBe(201)
    expect((await manual(f.order,randomUUID(),other)).statusCode).toBe(403)
    expect((await manual(f.order,randomUUID(),cashier,{tenantId:randomUUID(),storeId:randomUUID()})).statusCode).toBe(403)
    const key=randomUUID(),paid=await manual(f.order,key);expect(paid.statusCode,paid.body).toBe(201)
    const changed=await post('/payments/manual',{orderId:f.order,provider:'cash',method:'cash',receiptReference:'different-reference'},key)
    expect(changed.statusCode).toBe(409)
    for(const code of ['payment.manual.cash.record','payment.recollect.authorize','payment.collect.all_tables']){
      await pool.query("INSERT INTO mbox.employee_permission_overrides(tenant_id,store_id,employee_id,permission_id,effect,reason,configured_by_employee_id) SELECT $1,$2,$3,id,'deny','test current revocation',$3 FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code=$4",[scope.tenantId,scope.storeId,cashier,code])
      try{expect((await manual(f.order,key)).statusCode,code).toBe(403)}finally{await pool.query("DELETE FROM mbox.employee_permission_overrides WHERE tenant_id=$1 AND store_id=$2 AND employee_id=$3",[scope.tenantId,scope.storeId,cashier])}
    }
  })
  it('retains exact ordinary receipt after normal closure without giving new closed-session collection rights',async()=>{
    const f=await fixture('ordinary');expect((await manual(f.order,f.originalKey)).json().meta.replayed).toBe(true)
    expect((await manual(f.order)).statusCode).toBe(403);expect((await authorize(f.order)).statusCode).toBe(403)
  })
  it('replays historical authorization and local close after settlement but rechecks each current permission',async()=>{
    const f=await fixture('pending'),closeKey=randomUUID(),authKey=randomUUID()
    expect((await closeLocal(f.pending!.id,closeKey)).statusCode).toBe(201)
    expect((await authorize(f.order,authKey)).statusCode).toBe(201)
    expect((await manual(f.order)).statusCode).toBe(201)
    expect((await view(f.order)).outstandingAmountMinor).toBe(0)
    const operations=[
      {replay:()=>authorize(f.order,authKey),permissions:['payment.recollect.authorize','payment.collect.all_tables']},
      {replay:()=>closeLocal(f.pending!.id,closeKey),permissions:['payment.initiate.staff','reconciliation.view','payment.recollect.authorize','payment.collect.all_tables']},
    ]
    for(const operation of operations){
      const restored=await operation.replay();expect(restored.statusCode,restored.body).toBe(200);expect(restored.json().meta.replayed).toBe(true)
      for(const code of operation.permissions){
        await pool.query("INSERT INTO mbox.employee_permission_overrides(tenant_id,store_id,employee_id,permission_id,effect,reason,configured_by_employee_id) SELECT $1,$2,$3,id,'deny','test replay current revocation',$3 FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code=$4",[scope.tenantId,scope.storeId,cashier,code])
        try{expect((await operation.replay()).statusCode,code).toBe(403)}finally{await pool.query('DELETE FROM mbox.employee_permission_overrides WHERE tenant_id=$1 AND store_id=$2 AND employee_id=$3',[scope.tenantId,scope.storeId,cashier])}
      }
    }
  })
  it('serializes simultaneous historical collections and exact-key requests',async()=>{
    const f=await fixture();expect((await authorize(f.order)).statusCode).toBe(201)
    const key=randomUUID(),same=await Promise.all([manual(f.order,key),manual(f.order,key)])
    expect(same.map(r=>r.statusCode).sort()).toEqual([200,201]);expect(new Set(same.map(r=>r.json().data.id)).size).toBe(1)
    const g=await fixture();expect((await authorize(g.order)).statusCode).toBe(201)
    const competing=await Promise.all([manual(g.order),manual(g.order)])
    expect(competing.map(r=>r.statusCode).sort()).toEqual([201,409])
  })
  it('keeps verified success awaiting application blocked, including after a local close',async()=>{
    const f=await fixture('pending'),payment=f.pending!
    expect((await closeLocal(payment.id)).statusCode).toBe(201)
    const providerTransactionId=randomUUID(),occurredAt=new Date().toISOString(),integrationRef='closed-debt-fixture'
    const observation=await new VerifiedProviderObservationService(runner).recordPayment({scope,provider:'postar',verificationKind:'active_query_binding',providerEventId:randomUUID(),integrationRef,paymentPublicId:payment.publicId,providerTransactionId,reportedAmountMinor:2000,reportedCurrency:'CNY',status:'succeeded',occurredAt,evidence:{}})
    expect((await view(f.order)).closedDebtRecovery?.status).toBe('pending_payment')
    expect((await authorize(f.order)).statusCode).toBe(409)
    const applied=await money.recordProviderQueryResult({...meta(),actor:{type:'integration',ref:integrationRef},verifiedObservationId:observation,paymentPublicId:payment.publicId,provider:'postar',providerTransactionId,reportedAmountMinor:2000,reportedCurrency:'CNY',occurredAt,status:'succeeded'})
    expect(applied.value.status).toBe('succeeded');expect((await view(f.order)).outstandingAmountMinor).toBe(0)
    expect((await manual(f.order)).statusCode).toBe(409)
  })
  it('rejects an unconsumed success observation before local cancellation',async()=>{
    const f=await fixture('pending'),payment=f.pending!
    await new VerifiedProviderObservationService(runner).recordPayment({scope,provider:'postar',verificationKind:'active_query_binding',providerEventId:randomUUID(),integrationRef:'closed-debt-fixture',paymentPublicId:payment.publicId,providerTransactionId:randomUUID(),reportedAmountMinor:2000,reportedCurrency:'CNY',status:'succeeded',occurredAt:new Date().toISOString(),evidence:{}})
    expect((await view(f.order)).closedDebtRecovery?.closableUnpresentedPaymentIds).toEqual([])
    expect((await closeLocal(payment.id)).statusCode).toBe(409)
  })
  it('serializes provider claim before local close and refuses the late local close',async()=>{
    const f=await fixture('pending'),payment=f.pending!
    let ready!:()=>void,release!:()=>void
    const held=new Promise<void>(r=>{ready=r}),continueClaim=new Promise<void>(r=>{release=r})
    const claim=runner.run(scope,async tx=>{
      const repo=new PaymentProviderActionRepository(tx,'fixture-secret-32-characters-long')
      await repo.resolvePaymentContext(payment.id,{type:'employee',employeeId:cashier})
      await repo.claim(payment.id,'qr',new Date(Date.now()+60000).toISOString(),{type:'employee',employeeId:cashier})
      ready();await continueClaim
    })
    await held
    const close=closeLocal(payment.id)
    try{await expect.poll(waitingRuntimeLocks,{timeout:2000,interval:10}).toBeGreaterThan(0)}finally{release()}
    await claim
    expect((await close).statusCode).toBe(409)
    expect((await pool.query('SELECT status FROM mbox.payments WHERE id=$1',[payment.id])).rows[0].status).toBe('pending')
  })
  it('serializes local close before a provider claim; the claim cannot reach an external call',async()=>{
    const f=await fixture('pending'),payment=f.pending!
    let ready!:()=>void,release!:()=>void,calls=0
    const held=new Promise<void>(r=>{ready=r}),continueClose=new Promise<void>(r=>{release=r})
    const close=runner.run(scope,async tx=>{
      await lockClosedDebtRecovery(tx,f.order)
      await new PaymentRepository(tx).closeUnpresentedClosedDebtPayment(payment.id)
      ready();await continueClose
    })
    await held
    const claim=runner.run(scope,tx=>new PaymentProviderActionRepository(tx,'fixture-secret-32-characters-long').claim(payment.id,'qr',new Date(Date.now()+60000).toISOString(),{type:'employee',employeeId:cashier})).then(()=>{calls++},error=>error)
    try{await expect.poll(waitingRuntimeLocks,{timeout:2000,interval:10}).toBeGreaterThan(0)}finally{release()}
    await close
    expect(await claim).toBeInstanceOf(Error);expect(calls).toBe(0)
    expect((await pool.query('SELECT count(*)::int n FROM mbox.payment_provider_actions WHERE payment_id=$1',[payment.id])).rows[0].n).toBe(0)
  })
  it('DB guard rejects unmatched authorization, new online receipts, wrong actor, and immutable order changes',async()=>{
    const f=await fixture();expect((await authorize(f.order)).statusCode).toBe(201)
    const direct=(amount=1000,provider='cash',employeeId=cashier)=>runner.run(scope,tx=>tx.query(`INSERT INTO mbox.payments(tenant_id,store_id,payable_kind,order_id,public_id,provider,method,amount_minor,currency,status,succeeded_at,provider_snapshot)
      VALUES($1,$2,'order',$3,$4,$5,$6,$7,'CNY','succeeded',clock_timestamp(),$8::jsonb)`,[scope.tenantId,scope.storeId,f.order,randomUUID(),provider,provider==='cash'?'cash':'native_qr',amount,JSON.stringify({collectedByEmployeeId:employeeId,receiptReference:randomUUID()})]))
    await expect(direct(2000)).rejects.toMatchObject({code:'55000'})
    await expect(direct(1000,'postar')).rejects.toMatchObject({code:'55000'})
    await expect(direct(1000,'cash',other)).rejects.toMatchObject({code:'55000'})
    await expect(runner.run(scope,async tx=>{
      const batch=randomUUID()
      await tx.query('INSERT INTO mbox.order_payment_batches(id,tenant_id,store_id,table_session_id,created_by_employee_id,amount_minor,currency) VALUES($1,$2,$3,$4,$5,1000,\'CNY\')',[batch,scope.tenantId,scope.storeId,f.session,cashier])
      await tx.query('INSERT INTO mbox.order_payment_allocations(tenant_id,store_id,batch_id,order_id,amount_minor,outstanding_at_creation_minor,position) VALUES($1,$2,$3,$4,1000,1000,0)',[scope.tenantId,scope.storeId,batch,f.order])
      await tx.query("INSERT INTO mbox.payments(tenant_id,store_id,payable_kind,order_batch_id,public_id,provider,method,amount_minor,currency,status,succeeded_at) VALUES($1,$2,'order_batch',$3,$4,'cash','cash',1000,'CNY','succeeded',clock_timestamp())",[scope.tenantId,scope.storeId,batch,randomUUID()])
    })).rejects.toMatchObject({code:'55000'})
    await expect(runner.run(scope,tx=>tx.query("UPDATE mbox.orders SET total_amount_minor=1,payment_status='paid' WHERE id=$1",[f.order]))).rejects.toMatchObject({code:'55000'})
    await pool.query("UPDATE mbox.order_recollection_authorizations SET expires_at=clock_timestamp()-interval '1 second' WHERE order_id=$1 AND status='active'",[f.order])
    await expect(direct()).rejects.toMatchObject({code:'55000'})
    expect((await runner.run(scope,tx=>tx.query<{allowed:boolean}>("SELECT has_function_privilege(current_user,'mbox.allow_closed_debt_manual_payment(jsonb,uuid)','EXECUTE') allowed"))).rows[0]!.allowed).toBe(false)
  })
  it('does not use a new post-closure ordinary refund as old debt or lose the original successful receipt',async()=>{
    const f=await fixture();expect((await authorize(f.order)).statusCode).toBe(201)
    const key=randomUUID();expect((await manual(f.order,key)).statusCode).toBe(201)
    const refund=(await money.requestRefund({...meta(requester),paymentId:f.originalPaymentId,publicId:randomUUID(),purpose:'price_adjustment',reason:'原桌关闭后新核准的独立调价',allocations:[{orderItemId:f.item,amountMinor:100}]})).value
    await money.approveRefund({...meta(),refundId:refund.id,decisionReason:'异人审核新的独立退款'})
    await money.beginRefundExecution({...meta(),refundId:refund.id});await money.recordManualRefundResult({...meta(),refundId:refund.id,succeeded:true,receiptReference:randomUUID()})
    expect((await view(f.order)).closedDebtRecovery?.status).toBe('ineligible')
    expect((await manual(f.order,key)).json().meta.replayed).toBe(true)
    expect((await authorize(f.order)).statusCode).toBe(409)
    expect((await manual(f.order)).statusCode).toBe(409)
  })
})
