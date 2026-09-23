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
import {localUnpresentedPaymentSql,lockClosedDebtPaymentTargets} from './closed-debt-recovery.js'

const url=process.env.TEST_NORMALIZED_DATABASE_URL,runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
;(url&&runtimeUrl?describe:describe.skip)('batch historical local-close recovery, restricted LOGIN',()=>{
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

  async function fixture(count=1,options:{withoutObligation?:number;leaveOpen?:boolean;immediate?:boolean}={}){
    const table=randomUUID(),session=randomUUID(),orders:Array<{id:string;item:string}>=[]
    await pool.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,$5,$5,4)",[table,scope.tenantId,scope.storeId,area,`T${table.slice(0,8)}`])
    await pool.query('INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1::uuid,$2,$3,$4,$1::text,$5,2)',[session,scope.tenantId,scope.storeId,table,date])
    for(let n=0;n<count;n++){
      const order=randomUUID(),item=randomUUID()
      await pool.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,submitted_at,subtotal_amount_minor,total_amount_minor,settlement_mode,fulfillment_state) VALUES($1::uuid,$2,$3,$4,$1::text,'staff_assisted','submitted',clock_timestamp(),4000,4000,$5,$6)",[order,scope.tenantId,scope.storeId,session,options.immediate?'immediate_payment':'table_tab',options.immediate?'awaiting_payment':'active'])
      await pool.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot) VALUES($1,$2,$3,$4,$5,1,4000,4000,$6,'{"name":"fixture","inventoryControlMode":"not_managed"}')`,[item,scope.tenantId,scope.storeId,order,product,options.immediate?'bar':'none'])
      orders.push({id:order,item})
    }
    const orderIds=orders.map(o=>o.id)
    const paidOrderIds=orderIds.filter((_,index)=>index!==options.withoutObligation)
    const paid=await post('/payments/manual',{orderId:paidOrderIds[0],orderIds:paidOrderIds,provider:'cash',method:'cash'});expect(paid.statusCode,paid.body).toBe(201)
    if(options.immediate){
      const customer=randomUUID(),plan=randomUUID()
      await pool.query('INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1::uuid,$2,$3,$1::text)',[customer,scope.tenantId,scope.storeId])
      // Existing completed plan is a valid administrative historical fixture;
      // initial activation and KDS creation above are actual business commands.
      await pool.query(`INSERT INTO mbox.customer_experience_plans(id,tenant_id,store_id,public_id,table_session_id,customer_id,business_date,plan_state,party_size,occasion,alcohol_preference,service_intensity,promise_summary,created_by_actor_type,created_by_actor_ref,order_id,order_item_id,selected_product_id,payment_id,activation_gate,activation_idempotency_key,activated_at,completed_at)
        VALUES($1::uuid,$2,$3,$1::text,$4,$5,$6,'completed',2,'friends','undecided','balanced','原有完成体验计划','employee',$7,$8,$9,$10,$11,'verified_payment',$1::text,clock_timestamp(),clock_timestamp())`,[plan,scope.tenantId,scope.storeId,session,customer,date,cashier,orders[0]!.id,orders[0]!.item,product,paid.json().data.id])
    }
    for(const [index,order] of orders.entries()){
      if(options.withoutObligation===index)continue
      const refund=(await money.requestRefund({...meta(requester),paymentId:paid.json().data.id,publicId:randomUUID(),purpose:'price_adjustment',reason:'同批原商品真实退款',allocations:[{orderItemId:order.item,amountMinor:2000}]})).value
      await money.approveRefund({...meta(),refundId:refund.id,decisionReason:'异人审核原退款'})
      await money.beginRefundExecution({...meta(),refundId:refund.id});await money.recordManualRefundResult({...meta(),refundId:refund.id,succeeded:true,receiptReference:randomUUID()})
      expect((await authorize(order.id)).statusCode).toBe(201)
    }
    // A no-obligation member is an original unpaid sale; its positive allocation
    // is created by the regular open-table batch API, not by altering facts.
    const pending=(await money.initiate({...meta(),orderId:orderIds[0]!,orderIds,publicId:randomUUID(),provider:'postar',method:'native_qr',principal:{type:'employee',employeeId:cashier}})).value
    if(!options.leaveOpen)await pool.query("UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp(),closed_by_employee_id=$2 WHERE id=$1",[session,cashier])
    return {orders,orderIds,session,pending,originalPaymentId:paid.json().data.id}
  }
  it.each([1,2])('closes an entirely unpresented %s-order batch and recovers each original order',async count=>{
    const f=await fixture(count),key=randomUUID(),response=await closeLocal(f.pending.id,key)
    expect(response.statusCode,response.body).toBe(201)
    expect(response.json().data).toMatchObject({id:f.pending.id,status:'closed',payableKind:'order_batch',amountMinor:2000*count})
    for(const orderId of f.orderIds){expect((await authorize(orderId)).statusCode).toBe(201);expect((await manual(orderId)).json().data.amountMinor).toBe(2000)}
    const replay=await closeLocal(f.pending.id,key);expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().meta.replayed).toBe(true)
    expect((await pool.query('SELECT status FROM mbox.table_sessions WHERE id=$1',[f.session])).rows[0].status).toBe('closed')
    expect((await pool.query('SELECT payment_status FROM mbox.orders WHERE id=ANY($1::uuid[])',[f.orderIds])).rows.every(r=>r.payment_status==='paid')).toBe(true)
    expect((await pool.query('SELECT count(*)::int n FROM mbox.reconciliation_entries WHERE payment_id=$1',[f.pending.id])).rows[0].n).toBe(0)
  })
  it('allows a settled member but requires at least one remaining historical debt',async()=>{
    const f=await fixture(2,{leaveOpen:true})
    expect((await authorize(f.orderIds[0]!)).statusCode).toBe(201)
    expect((await manual(f.orderIds[0]!)).statusCode).toBe(201)
    await pool.query("UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp(),closed_by_employee_id=$2 WHERE id=$1",[f.session,cashier])
    const response=await closeLocal(f.pending.id);expect(response.statusCode,response.body).toBe(201)
    expect((await authorize(f.orderIds[0]!)).statusCode).toBe(409)
    expect((await authorize(f.orderIds[1]!)).statusCode).toBe(201)
    expect((await manual(f.orderIds[1]!)).json().data.amountMinor).toBe(2000)
    const all=await fixture(2,{leaveOpen:true})
    for(const order of all.orderIds){expect((await authorize(order)).statusCode).toBe(201);expect((await manual(order)).statusCode).toBe(201)}
    await pool.query("UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp(),closed_by_employee_id=$2 WHERE id=$1",[all.session,cashier])
    expect((await closeLocal(all.pending.id)).statusCode).toBe(409)
  })
  it('rejects the entire batch if an actual allocated member has no historical obligation',async()=>{
    const f=await fixture(2,{withoutObligation:1})
    const allocations=(await pool.query('SELECT order_id,amount_minor::int amount FROM mbox.order_payment_allocations WHERE batch_id=$1 ORDER BY amount_minor',[f.pending.orderBatchId])).rows
    expect(allocations.map(row=>row.amount)).toEqual([2000,4000])
    expect(new Set(allocations.map(row=>row.order_id))).toEqual(new Set(f.orderIds))
    expect((await closeLocal(f.pending.id)).statusCode).toBe(409)
    expect((await pool.query('SELECT status FROM mbox.payments WHERE id=$1',[f.pending.id])).rows[0].status).toBe('pending')
  })
  it('rejects open sessions and proves cross-session members cannot be fabricated after creation',async()=>{
    const f=await fixture(2,{leaveOpen:true})
    expect((await closeLocal(f.pending.id)).statusCode).toBe(409)
    const otherTable=await fixture(1,{leaveOpen:true})
    // Migration 129 preserves order/session ownership even for maintenance SQL.
    await expect(pool.query('UPDATE mbox.orders SET table_session_id=$2 WHERE id=$1',[f.orderIds[1],otherTable.session])).rejects.toMatchObject({code:'23514'})
  })
  it.each(['total','session'] as const)('preserves database rejection of mismatched immutable batch %s',async kind=>{
    const f=await fixture(1,{leaveOpen:true})
    const target=kind==='session'?(await fixture(1,{leaveOpen:true})).orderIds[0]:f.orderIds[0]
    await expect(runner.run(scope,async tx=>{
      const batch=randomUUID()
      await tx.query(`INSERT INTO mbox.order_payment_batches(id,tenant_id,store_id,table_session_id,created_by_employee_id,amount_minor,currency) VALUES($1,$2,$3,$4,$5,2000,'CNY')`,[batch,scope.tenantId,scope.storeId,f.session,cashier])
      await tx.query(`INSERT INTO mbox.order_payment_allocations(tenant_id,store_id,batch_id,order_id,position,amount_minor,outstanding_at_creation_minor) VALUES($1,$2,$3,$4,0,$5,2000)`,[scope.tenantId,scope.storeId,batch,target,kind==='total'?1000:2000])
    })).rejects.toMatchObject({code:'23514'})
  })
  it('rejects database-valid historical bigint amounts before converting them to JSON numbers',async()=>{
    const f=await fixture(1,{leaveOpen:true}),batch=randomUUID(),payment=randomUUID(),amount='9007199254740993'
    // Normal application amounts already reject this range. PostgreSQL bigint
    // can retain an imported historical value, so recovery must fail safely.
    await runner.run(scope,async tx=>{
      await tx.query(`INSERT INTO mbox.order_payment_batches(id,tenant_id,store_id,table_session_id,created_by_employee_id,amount_minor,currency) VALUES($1,$2,$3,$4,$5,$6::bigint,'CNY')`,[batch,scope.tenantId,scope.storeId,f.session,cashier,amount])
      await tx.query(`INSERT INTO mbox.order_payment_allocations(tenant_id,store_id,batch_id,order_id,position,amount_minor,outstanding_at_creation_minor) VALUES($1,$2,$3,$4,0,$5::bigint,$5::bigint)`,[scope.tenantId,scope.storeId,batch,f.orderIds[0],amount])
      await tx.query(`INSERT INTO mbox.payments(id,tenant_id,store_id,payable_kind,order_batch_id,public_id,provider,method,amount_minor,currency,status) VALUES($1::uuid,$2,$3,'order_batch',$4,$1::text,'postar','native_qr',$5::bigint,'CNY','pending')`,[payment,scope.tenantId,scope.storeId,batch,amount])
    })
    await pool.query("UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp(),closed_by_employee_id=$2 WHERE id=$1",[f.session,cashier])
    expect((await closeLocal(payment)).statusCode).toBe(409)
    expect((await pool.query('SELECT amount_minor::text,status FROM mbox.payments WHERE id=$1',[payment])).rows[0]).toEqual({amount_minor:amount,status:'pending'})
    expect(await runner.run(scope,async tx=>(await tx.query<{safe:boolean}>(`SELECT ${localUnpresentedPaymentSql()} safe FROM mbox.payments payment CROSS JOIN mbox.table_sessions session WHERE payment.id=$1 AND session.id=$2`,[payment,f.session])).rows[0]!.safe)).toBe(false)
  })
  it('requires all four current permissions even on exact replay after both debts settle',async()=>{
    const f=await fixture(2),key=randomUUID()
    expect((await closeLocal(f.pending.id,key)).statusCode).toBe(201)
    for(const order of f.orderIds){await authorize(order);expect((await manual(order)).statusCode).toBe(201)}
    expect((await closeLocal(f.pending.id,key)).statusCode).toBe(200)
    const path=`/payments/${f.pending.id}/close-unpresented-history`,body={reason:'核对仅本地未外送尝试，不代表渠道退款'}
    expect((await post(path,body,key,other)).statusCode).toBe(403)
    expect((await post(path,body,key,cashier,{tenantId:randomUUID(),storeId:randomUUID()})).statusCode).toBe(403)
    expect((await post(path,{reason:'修改原命令理由不得重用原键'},key)).statusCode).toBe(409)
    for(const code of ['payment.initiate.staff','reconciliation.view','payment.collect.all_tables','payment.recollect.authorize']){
      await pool.query("INSERT INTO mbox.employee_permission_overrides(tenant_id,store_id,employee_id,permission_id,effect,reason,configured_by_employee_id) SELECT $1,$2,$3,id,'deny','SYS331 current permission revoked',$3 FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code=$4",[scope.tenantId,scope.storeId,cashier,code])
      try{expect((await closeLocal(f.pending.id,key)).statusCode,code).toBe(403)}finally{await pool.query('DELETE FROM mbox.employee_permission_overrides WHERE tenant_id=$1 AND store_id=$2 AND employee_id=$3',[scope.tenantId,scope.storeId,cashier])}
    }
    const audit=(await pool.query("SELECT after_snapshot FROM mbox.audit_events WHERE object_id=$1 AND action='payment.closed_debt_local_attempt_closed'",[f.pending.id])).rows
    expect(audit).toHaveLength(1)
    expect(audit[0].after_snapshot).toMatchObject({payableKind:'order_batch',amountMinor:4000,providerContacted:false})
    expect(audit[0].after_snapshot.orders.map((row:{orderId:string})=>row.orderId).sort()).toEqual([...f.orderIds].sort())
  })
  it.each(['creating','failed','lease','observation'] as const)('rejects %s evidence for any part of the entire payment',async kind=>{
    const f=await fixture(2)
    if(kind==='creating'||kind==='failed'){
      await runner.run(scope,tx=>new PaymentProviderActionRepository(tx,'fixture-secret-32-characters-long').claim(f.pending.id,'qr',new Date(Date.now()+60000).toISOString(),{type:'employee',employeeId:cashier}))
      if(kind==='failed')await pool.query("UPDATE mbox.payment_provider_actions SET state='failed' WHERE payment_id=$1",[f.pending.id])
    }else if(kind==='lease')await pool.query("INSERT INTO mbox.payment_reconciliation_states(tenant_id,store_id,payment_id,lease_until) VALUES($1,$2,$3,clock_timestamp()+interval '1 minute')",[scope.tenantId,scope.storeId,f.pending.id])
    else await new VerifiedProviderObservationService(runner).recordPayment({scope,provider:'postar',verificationKind:'active_query_binding',providerEventId:randomUUID(),integrationRef:'batch-history',paymentPublicId:f.pending.publicId,providerTransactionId:randomUUID(),reportedAmountMinor:f.pending.amountMinor,reportedCurrency:'CNY',status:'pending',occurredAt:new Date().toISOString(),evidence:{}})
    expect((await closeLocal(f.pending.id)).statusCode).toBe(409)
  })
  it('serializes provider preparation before local close',async()=>{
    const f=await fixture(2)
    let ready!:()=>void,release!:()=>void
    const held=new Promise<void>(r=>{ready=r}),continueClaim=new Promise<void>(r=>{release=r})
    const claim=runner.run(scope,async tx=>{
      await new PaymentProviderActionRepository(tx,'fixture-secret-32-characters-long').claim(f.pending.id,'qr',new Date(Date.now()+60000).toISOString(),{type:'employee',employeeId:cashier})
      ready();await continueClaim
    })
    await held
    const close=closeLocal(f.pending.id)
    try{await expect.poll(waitingRuntimeLocks,{timeout:2000,interval:10}).toBeGreaterThan(0)}finally{release()}
    await claim;expect((await close).statusCode).toBe(409)
  })
  it('serializes local close before provider preparation without reaching an external call',async()=>{
    const f=await fixture(2)
    let ready!:()=>void,release!:()=>void,calls=0
    const held=new Promise<void>(r=>{ready=r}),continueClose=new Promise<void>(r=>{release=r})
    const close=runner.run(scope,async tx=>{
      await lockClosedDebtPaymentTargets(tx,f.pending.id)
      await new PaymentRepository(tx).closeUnpresentedClosedDebtPayment(f.pending.id)
      ready();await continueClose
    })
    await held
    const claim=runner.run(scope,tx=>new PaymentProviderActionRepository(tx,'fixture-secret-32-characters-long').claim(f.pending.id,'qr',new Date(Date.now()+60000).toISOString(),{type:'employee',employeeId:cashier})).then(()=>{calls++},error=>error)
    try{await expect.poll(waitingRuntimeLocks,{timeout:2000,interval:10}).toBeGreaterThan(0)}finally{release()}
    await close;expect(await claim).toBeInstanceOf(Error);expect(calls).toBe(0)
  })
  async function success(f:Awaited<ReturnType<typeof fixture>>){
    const occurredAt=new Date().toISOString(),providerTransactionId=randomUUID(),integrationRef='batch-history'
    const verifiedObservationId=await new VerifiedProviderObservationService(runner).recordPayment({scope,provider:'postar',verificationKind:'active_query_binding',providerEventId:randomUUID(),integrationRef,paymentPublicId:f.pending.publicId,providerTransactionId,reportedAmountMinor:f.pending.amountMinor,reportedCurrency:'CNY',status:'succeeded',occurredAt,evidence:{}})
    const input={...meta(),actor:{type:'integration' as const,ref:integrationRef},verifiedObservationId,paymentPublicId:f.pending.publicId,provider:'postar' as const,providerTransactionId,reportedAmountMinor:f.pending.amountMinor,reportedCurrency:'CNY',occurredAt,status:'succeeded' as const}
    return ()=>money.recordProviderQueryResult(input)
  }
  it('orders provider result locks before order locks, concurrently with local close',async()=>{
    const f=await fixture(2),apply=await success(f),holder=await pool.connect()
    await holder.query('BEGIN');await holder.query('SELECT id FROM mbox.orders WHERE id=$1 FOR UPDATE',[[...f.orderIds].sort()[0]])
    const result=apply()
    await expect.poll(waitingRuntimeLocks,{timeout:2000,interval:10}).toBeGreaterThanOrEqual(1)
    const close=closeLocal(f.pending.id)
    try{await expect.poll(waitingRuntimeLocks,{timeout:2000,interval:10}).toBeGreaterThanOrEqual(2)}finally{await holder.query('ROLLBACK');holder.release()}
    expect((await result).value.status).toBe('succeeded');expect((await close).statusCode).toBe(409)
    expect((await pool.query('SELECT count(*)::int n FROM mbox.reconciliation_entries WHERE payment_id=$1',[f.pending.id])).rows[0].n).toBe(1)
  })
  it('serializes identical local-close commands into one audit and one persistent receipt',async()=>{
    const f=await fixture(2),key=randomUUID(),responses=await Promise.all([closeLocal(f.pending.id,key),closeLocal(f.pending.id,key)])
    expect(responses.map(response=>response.statusCode).sort()).toEqual([200,201])
    expect(responses.filter(response=>response.json().meta.replayed)).toHaveLength(1)
    expect((await pool.query("SELECT count(*)::int n FROM mbox.audit_events WHERE object_id=$1 AND action='payment.closed_debt_local_attempt_closed'",[f.pending.id])).rows[0].n).toBe(1)
  })
  it('retains late batch money once without changing original activated fulfillment or experience',async()=>{
    const f=await fixture(2,{immediate:true})
    const snapshot=async()=>({
      orders:(await pool.query('SELECT id,status,fulfillment_state,fulfillment_activated_at FROM mbox.orders WHERE id=ANY($1::uuid[]) ORDER BY id',[f.orderIds])).rows,
      tasks:(await pool.query('SELECT to_jsonb(task) value FROM mbox.kds_tasks task JOIN mbox.order_items item ON item.id=task.order_item_id WHERE item.order_id=ANY($1::uuid[]) ORDER BY task.id',[f.orderIds])).rows,
      plans:(await pool.query('SELECT to_jsonb(plan) value FROM mbox.customer_experience_plans plan WHERE order_id=ANY($1::uuid[]) ORDER BY id',[f.orderIds])).rows,
      planEvents:(await pool.query('SELECT to_jsonb(event) value FROM mbox.experience_plan_activation_events event WHERE order_id=ANY($1::uuid[]) ORDER BY id',[f.orderIds])).rows,
      reservations:(await pool.query('SELECT to_jsonb(reservation) value FROM mbox.inventory_order_reservations reservation WHERE order_id=ANY($1::uuid[]) ORDER BY id',[f.orderIds])).rows,
    })
    const before=await snapshot();expect(before.orders.every(row=>row.fulfillment_state==='active')).toBe(true);expect(before.tasks).toHaveLength(2);expect(before.plans).toHaveLength(1)
    expect((await closeLocal(f.pending.id)).statusCode).toBe(201)
    for(const order of f.orderIds){await authorize(order);expect((await manual(order)).statusCode).toBe(201)}
    const apply=await success(f)
    const latePayment=(await apply()).value;expect(latePayment.status).toBe('succeeded');expect((await apply()).replayed).toBe(true)
    expect(await snapshot()).toEqual(before)
    expect((await pool.query('SELECT count(*)::int n,sum(amount_minor)::int amount FROM mbox.reconciliation_entries WHERE payment_id=$1',[f.pending.id])).rows[0]).toEqual({n:1,amount:4000})
    expect((await pool.query('SELECT order_id,amount_minor::int amount FROM mbox.order_payment_facts WHERE id=$1 ORDER BY order_id',[f.pending.id])).rows).toEqual([...f.orderIds].sort().map(order_id=>({order_id,amount:2000})))
    for(const order of f.orders){
      const refund=(await money.requestRefund({...meta(requester),paymentId:f.pending.id,publicId:randomUUID(),purpose:'price_adjustment',reason:'退回迟到的真实重复到账，不重复售后出品',allocations:[{orderItemId:order.item,amountMinor:2000}]})).value
      await money.approveRefund({...meta(),refundId:refund.id,decisionReason:'异人核对迟到到账与实际溢收'})
      const providerRefundReference=randomUUID(),occurredAt=new Date().toISOString(),integrationRef='batch-history'
      await money.beginRefundExecution({...meta(),refundId:refund.id})
      const verifiedObservationId=await new VerifiedProviderObservationService(runner).recordRefund({scope,provider:'postar',verificationKind:'active_query_binding',providerEventId:randomUUID(),integrationRef,refundPublicId:refund.publicId,providerTransactionId:providerRefundReference,originalProviderTransactionId:latePayment.providerTransactionId!,reportedAmountMinor:2000,reportedCurrency:'CNY',status:'succeeded',occurredAt,evidence:{}})
      await money.recordProviderRefundResult({...meta(),actor:{type:'integration',ref:integrationRef},verifiedObservationId,refundPublicId:refund.publicId,provider:'postar',providerRefundId:providerRefundReference,originalProviderTransactionId:latePayment.providerTransactionId!,reportedAmountMinor:2000,reportedCurrency:'CNY',succeeded:true,occurredAt})
    }
    expect(await snapshot()).toEqual(before)
    expect((await pool.query('SELECT sum(amount_minor)::int net FROM mbox.reconciliation_entries WHERE payment_id=$1',[f.pending.id])).rows[0].net).toBe(0)
  })
})
