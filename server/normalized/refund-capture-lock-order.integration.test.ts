import {randomUUID} from 'node:crypto'
import {mkdirSync,writeFileSync} from 'node:fs'
import {Pool} from 'pg'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {ScopedPostgresTransactionRunner,type PostgresPool,type PostgresPoolClient,type PostgresQueryResult} from './transaction-runner.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {PaymentCommandService} from './payment-command-service.js'
import {RefundRepository} from './refund-repository.js'
import {ItemQuantityFulfillmentRepository} from './item-quantity-fulfillment-repository.js'
import {NormalizedPaymentCapabilityAuthorization} from './payment-security-policy.js'
import {NormalizedProviderObservationAuthority,VerifiedProviderObservationService} from './provider-verification-observation.js'

const adminUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
const output=process.env.SYS339_EVIDENCE_DIR
const save=(name:string,value:unknown)=>{if(output)writeFileSync(`${output}/${name}.json`,JSON.stringify(value,null,2)+'\n')}
const sourceSha=process.env.SYS339_SOURCE_SHA??'local-source'
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r});return{promise,resolve}}
const errorData=(error:unknown)=>error instanceof Error?Object.fromEntries([...new Set(['name','message','stack',...Object.getOwnPropertyNames(error)])].map(key=>[key,(error as unknown as Record<string,unknown>)[key]])):error
const settled=<T>(p:Promise<T>)=>p.then(value=>({status:'fulfilled' as const,value}),error=>({status:'rejected' as const,error:errorData(error)}))

;(adminUrl&&runtimeUrl?describe:describe.skip)('refund completion and capture parent lock order, actual restricted LOGIN',()=>{
  let admin:Pool,runtime:Pool,runner:ScopedPostgresTransactionRunner,money:PaymentCommandService,date:string
  const scope={tenantId:randomUUID(),storeId:randomUUID()},area=randomUUID(),product=randomUUID(),cashier=randomUUID(),requester=randomUUID()
  let identity:unknown
  beforeAll(async()=>{
    await runNormalizedMigrations(adminUrl!)
    admin=new Pool({connectionString:adminUrl,max:4})
    runtime=new Pool({connectionString:runtimeUrl,max:5})
    runner=new ScopedPostgresTransactionRunner(runtime)
    identity=(await runtime.query("SELECT session_user,current_user,current_database(),rolsuper,rolbypassrls,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname=session_user")).rows[0]
    expect(identity).toMatchObject({session_user:new URL(runtimeUrl!).username,current_user:new URL(runtimeUrl!).username,rolsuper:false,rolbypassrls:false,rolcreaterole:false,rolcreatedb:false})
    expect(Number((await admin.query('SELECT max(version) version FROM mbox.normalized_schema_migrations')).rows[0].version)).toBe(241)
    if(output)mkdirSync(output,{recursive:true})
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
  afterAll(async()=>{await runtime?.end();await admin?.end()})
  const service=(r:ScopedPostgresTransactionRunner)=>new PaymentCommandService(new NormalizedCommandExecutor(r),new NormalizedPaymentCapabilityAuthorization(),new NormalizedProviderObservationAuthority())
  const meta=(employeeId=cashier)=>({scope,actor:{type:'employee' as const,employeeId},businessDate:date,idempotencyKey:randomUUID(),requestFingerprint:randomUUID()})
  async function fixture(memberCount=1,singleOriginal=false,secondRequested=false,captureKind:'callback'|'query'='callback'){
    const table=randomUUID(),session=randomUUID(),order=randomUUID(),item=randomUUID()
    await admin.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,$5,$5,4)",[table,scope.tenantId,scope.storeId,area,`T${table.slice(0,8)}`])
    await admin.query('INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1::uuid,$2,$3,$4,$1::text,$5,2)',[session,scope.tenantId,scope.storeId,table,date])
    await admin.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,submitted_at,subtotal_amount_minor,total_amount_minor,settlement_mode,fulfillment_state) VALUES($1::uuid,$2,$3,$4,$1::text,'staff_assisted','submitted',clock_timestamp(),4000,4000,'immediate_payment','awaiting_payment')",[order,scope.tenantId,scope.storeId,session])
    await admin.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot) VALUES($1,$2,$3,$4,$5,1,4000,4000,'bar','{"name":"fixture","inventoryControlMode":"tracked"}')`,[item,scope.tenantId,scope.storeId,order,product])
    const orders=[order],extras:Array<{order:string;item:string}>=[]
    for(let index=1;index<memberCount;index++){
      const extra=randomUUID(),extraItem=randomUUID()
      await admin.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,submitted_at,subtotal_amount_minor,total_amount_minor,settlement_mode,fulfillment_state) VALUES($1::uuid,$2,$3,$4,$1::text,'staff_assisted','submitted',clock_timestamp(),1000,1000,'table_tab','active')",[extra,scope.tenantId,scope.storeId,session])
      await admin.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot) VALUES($1,$2,$3,$4,$5,1,1000,1000,'none','{"name":"extra fixture","inventoryControlMode":"not_managed"}')`,[extraItem,scope.tenantId,scope.storeId,extra,product])
      orders.push(extra);extras.push({order:extra,item:extraItem})
    }
    const stock=randomUUID()
    await admin.query("INSERT INTO mbox.inventory_items(id,tenant_id,store_id,sku,name,item_type,base_unit) VALUES($1,$2,$3,$4,'Original material','food','piece')",[stock,scope.tenantId,scope.storeId,`R-${stock}`])
    await admin.query('INSERT INTO mbox.inventory_balances(tenant_id,store_id,inventory_item_id,on_hand_quantity,reserved_quantity) VALUES($1,$2,$3,10,1)',[scope.tenantId,scope.storeId,stock])
    await admin.query("INSERT INTO mbox.inventory_order_reservations(tenant_id,store_id,order_id,order_item_id,inventory_item_id,quantity,expires_at) VALUES($1,$2,$3,$4,$5,1,clock_timestamp()+interval '1 hour')",[scope.tenantId,scope.storeId,order,item,stock])
    const original=(await money.recordManual({...meta(),orderId:order,...(singleOriginal?{}:{orderIds:orders}),publicId:randomUUID(),provider:'cash',method:'cash',evidence:{collectedByEmployeeId:cashier,receiptReference:randomUUID()}})).value
    expect(original).toMatchObject({payableKind:singleOriginal?'order':'order_batch',amountMinor:4000+(singleOriginal?0:extras.length*1000),status:'succeeded'})
    const task=(await admin.query('SELECT id FROM mbox.kds_tasks WHERE order_item_id=$1',[item])).rows[0]
    expect(task).toBeDefined()
    await runner.run(scope,tx=>new ItemQuantityFulfillmentRepository(tx).complete({itemId:item,taskId:task.id,employeeId:cashier,quantity:1,eventKey:randomUUID()}))
    await runner.run(scope,tx=>new ItemQuantityFulfillmentRepository(tx).deliver({itemId:item,taskId:task.id,employeeId:cashier,quantity:1,eventKey:randomUUID()}))
    const prepareRefund=async(approve=true)=>{
      const refund=(await money.requestRefund({...meta(requester),paymentId:original.id,publicId:randomUUID(),purpose:'price_adjustment',reason:'原实收现金按原商品分配退20元',allocations:[{orderItemId:item,amountMinor:2000}]})).value
      if(!approve)return refund
      await money.approveRefund({...meta(),refundId:refund.id,decisionReason:'异人核对原剩余实收20元'})
      await money.beginRefundExecution({...meta(),refundId:refund.id})
      return refund
    }
    const first=await prepareRefund()
    await money.recordManualRefundResult({...meta(),refundId:first.id,succeeded:true,receiptReference:randomUUID()})
    await money.authorizeRecollection({...meta(),orderId:order,reason:'商品仍履约，确认原退20元需要补收'})
    if(!singleOriginal)for(const extra of extras){
      const refund=(await money.requestRefund({...meta(requester),paymentId:original.id,publicId:randomUUID(),purpose:'price_adjustment',reason:'同批次第二订单原价差退五元',allocations:[{orderItemId:extra.item,amountMinor:500}]})).value
      await money.approveRefund({...meta(),refundId:refund.id,decisionReason:'第二订单原分配异人审核'})
      await money.beginRefundExecution({...meta(),refundId:refund.id})
      await money.recordManualRefundResult({...meta(),refundId:refund.id,succeeded:true,receiptReference:randomUUID()})
      await money.authorizeRecollection({...meta(),orderId:extra.order,reason:'第二订单仍履约授权补收五元'})
    }
    const pending=(await money.initiate({...meta(),orderId:order,orderIds:orders,publicId:randomUUID(),provider:'postar',method:'native_qr',principal:{type:'employee',employeeId:cashier}})).value
    expect(pending).toMatchObject({payableKind:'order_batch',amountMinor:2000+(memberCount-1)*(singleOriginal?1000:500),status:'pending'})
    const second=await prepareRefund(!secondRequested)
    // Explicit synthetic historical closure, same valid row shape as development fixture.
    // Not an old234 binary/history replay. All payment/refund/approval facts above are actual runtime commands.
    await admin.query("UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp(),closed_by_employee_id=$2 WHERE id=$1",[session,cashier])
    const occurredAt=new Date().toISOString(),providerTransactionId=randomUUID(),integrationRef='sys339-lock-order-fixture'
    const verifiedObservationId=await new VerifiedProviderObservationService(runner).recordPayment({scope,provider:'postar',verificationKind:captureKind==='query'?'active_query_binding':'callback_signature',providerEventId:randomUUID(),integrationRef,paymentPublicId:pending.publicId,providerTransactionId,reportedAmountMinor:pending.amountMinor,reportedCurrency:'CNY',status:'succeeded',occurredAt,evidence:{fixture:'synthetic trusted verifier observation; no live provider'}})
    const captureInput={...meta(),actor:{type:'integration' as const,ref:integrationRef},verifiedObservationId,paymentPublicId:pending.publicId,provider:'postar' as const,providerTransactionId,reportedAmountMinor:pending.amountMinor,reportedCurrency:'CNY',occurredAt}
    const refundInput={...meta(),refundId:second.id,succeeded:true,receiptReference:randomUUID()}
    const f={table,session,order,item,stock,orders,original,first,second,pending,captureInput,refundInput,captureKind}
    expect(await facts(f)).toMatchObject({order:{payment_status:'partially_refunded'},session:{status:'closed'},pending:{status:'pending'},secondRefund:{status:secondRequested?'requested':'processing'}})
    return f
  }
  function applyCapture(target:PaymentCommandService,f:Awaited<ReturnType<typeof fixture>>){
    return f.captureKind==='query'?target.recordProviderQueryResult({...f.captureInput,status:'succeeded'})
      :target.recordSucceededCallback(f.captureInput)
  }
  async function facts(f:{session:string;order:string;stock:string;item:string;original:{id:string};pending:{id:string};second:{id:string}}){
    return {
      order:(await admin.query('SELECT id,status,payment_status,fulfillment_state FROM mbox.orders WHERE id=$1',[f.order])).rows[0],
      session:(await admin.query('SELECT id,status,business_date,closed_at FROM mbox.table_sessions WHERE id=$1',[f.session])).rows[0],
      pending:(await admin.query('SELECT id,status,provider_transaction_id FROM mbox.payments WHERE id=$1',[f.pending.id])).rows[0],
      original:(await admin.query('SELECT id,status,provider_transaction_id FROM mbox.payments WHERE id=$1',[f.original.id])).rows[0],
      secondRefund:(await admin.query('SELECT id,status,completed_at FROM mbox.refunds WHERE id=$1',[f.second.id])).rows[0],
      physical:{
        order:(await admin.query("SELECT to_jsonb(o)-'payment_status'-'updated_at' fact FROM mbox.orders o WHERE id=$1",[f.order])).rows,
        items:(await admin.query('SELECT to_jsonb(x) fact FROM mbox.order_items x WHERE id=$1',[f.item])).rows,
        units:(await admin.query('SELECT to_jsonb(x) fact FROM mbox.order_item_quantity_units x WHERE order_item_id=$1 ORDER BY id',[f.item])).rows,
        tasks:(await admin.query('SELECT to_jsonb(x) fact FROM mbox.kds_tasks x WHERE order_item_id=$1 ORDER BY id',[f.item])).rows,
        events:(await admin.query('SELECT to_jsonb(x) fact FROM mbox.kds_task_events x WHERE kds_task_id IN(SELECT id FROM mbox.kds_tasks WHERE order_item_id=$1) ORDER BY id',[f.item])).rows,
        stock:(await admin.query('SELECT to_jsonb(x) fact FROM mbox.inventory_balances x WHERE inventory_item_id=$1',[f.stock])).rows,
        reservations:(await admin.query('SELECT to_jsonb(x) fact FROM mbox.inventory_order_reservations x WHERE order_item_id=$1 ORDER BY id',[f.item])).rows,
        movements:(await admin.query('SELECT to_jsonb(x) fact FROM mbox.inventory_movements x WHERE inventory_item_id=$1 ORDER BY id',[f.stock])).rows,
      },
      ledger:(await admin.query('SELECT payment_id,refund_id,entry_type,amount_minor::text,currency FROM mbox.reconciliation_entries WHERE payment_id=ANY($1::uuid[]) ORDER BY occurred_at,id',[[f.original.id,f.pending.id]])).rows,
    }
  }
  it('sequential control: original remaining refund and delayed capture are valid commands',async()=>{
    const f=await fixture(),before=await facts(f)
    const capture=await settled(applyCapture(money,f))
    const refund=await settled(money.recordManualRefundResult(f.refundInput))
    const after=await facts(f)
    const replay=await settled(applyCapture(money,f))
    const refundReplay=await settled(money.recordManualRefundResult(f.refundInput))
    save('sequential-control',{sourceSha,identity,scope,fixtureSource:'synthetic closed row; runtime financial commands; no actual provider signature verification',fixture:f,before,capture,refund,after,replay,refundReplay,afterReplay:await facts(f)})
    expect(capture.status).toBe('fulfilled');expect(refund.status).toBe('fulfilled')
    expect(after.pending.status).toBe('succeeded');expect(after.secondRefund.status).toBe('succeeded')
    expect(after.ledger.filter(r=>r.payment_id===f.pending.id&&r.entry_type==='payment')).toHaveLength(1)
    expect(after.ledger.filter(r=>r.refund_id===f.second.id&&r.entry_type==='refund')).toHaveLength(1)
    expect(after.ledger.find(r=>r.payment_id===f.pending.id&&r.entry_type==='payment')).toMatchObject({amount_minor:String(f.pending.amountMinor),currency:'CNY',refund_id:null})
    expect(after.ledger.find(r=>r.refund_id===f.second.id&&r.entry_type==='refund')).toMatchObject({amount_minor:'-2000',currency:'CNY',payment_id:f.original.id})
    expect(replay).toMatchObject({status:'fulfilled',value:{replayed:true}})
    expect(refundReplay).toMatchObject({status:'fulfilled',value:{replayed:true}})
  })
  it.each([{members:1,single:false},{members:2,single:false},{members:2,single:true}])(
    'concurrent completion: $members member batch, original single=$single must both commit',async({members,single})=>{
    const f=await fixture(members,single,false,single?'query':'callback'),before=await facts(f),events:Array<Record<string,unknown>>=[],blocks:Array<unknown>=[]
    const refundLane=lane('refund',sql=>/FROM mbox\.orders/.test(sql)&&sql.includes('FOR UPDATE'),events)
    const captureLane=lane('capture',sql=>sql.includes('FROM mbox.order_payment_batches batch')&&sql.includes('FOR UPDATE OF session'),events)
    const refundService=service(new ScopedPostgresTransactionRunner(refundLane.pool))
    const captureService=service(new ScopedPostgresTransactionRunner(captureLane.pool))
    const refundResult=settled(refundService.recordManualRefundResult(f.refundInput))
    let captureResult:ReturnType<typeof settled>|undefined,barrierError:unknown
    try{
      await expect.poll(()=>refundLane.hit,{timeout:2000,interval:10}).toBe(true)
      captureResult=settled(applyCapture(captureService,f))
      // Pause only AFTER the refund's real order lock. Before the fix capture
      // acquires its session, completing the inverse edge; with parent ordering
      // it waits for refund's existing session lock. Both are observed directly.
      await expect.poll(async()=>{
        const snapshot=await blocking([refundLane.pid!,captureLane.pid!].filter(Boolean));blocks.push(snapshot)
        return captureLane.hit || snapshot.some(row=>row.pid===captureLane.pid&&row.blockers.includes(refundLane.pid!))
      },{timeout:2000,interval:10}).toBe(true)
    }catch(error){barrierError=errorData(error)}finally{
      refundLane.resume.resolve();captureLane.resume.resolve()
    }
    const refund=await refundResult,capture=captureResult?await captureResult:null,after=await facts(f)
    save(`concurrent-${members}-${single}`,{sourceSha,identity,scope,before,refund,capture,after,barrierError,
      backendPids:{refund:refundLane.pid,capture:captureLane.pid},blockingSnapshots:blocks,queries:events})
    expect(barrierError,'the actual business lock interleaving must be reached').toBeUndefined()
    if(!single){const originalLocks=events.filter(event=>event.lane==='refund'&&String(event.sql).includes('ORDER BY o.id FOR UPDATE OF o'));expect(originalLocks.length).toBeGreaterThan(0);expect(originalLocks[0]!.rowCount).toBe(members)}
    expect([refund.status,capture?.status],'both original commands must succeed without retrying a deadlock').toEqual(['fulfilled','fulfilled'])
    expect(after.pending.status).toBe('succeeded');expect(after.secondRefund.status).toBe('succeeded')
    expect(after.ledger.filter(r=>r.payment_id===f.pending.id&&r.entry_type==='payment')).toHaveLength(1)
    expect(after.ledger.filter(r=>r.refund_id===f.second.id&&r.entry_type==='refund')).toHaveLength(1)
    expect(after.ledger.find(r=>r.payment_id===f.pending.id&&r.entry_type==='payment')).toMatchObject({amount_minor:String(f.pending.amountMinor),currency:'CNY',refund_id:null})
    expect(after.ledger.find(r=>r.refund_id===f.second.id&&r.entry_type==='refund')).toMatchObject({amount_minor:'-2000',currency:'CNY',payment_id:f.original.id})
    expect(after.session).toEqual(before.session)
    expect(before.physical.units).toHaveLength(1);expect(before.physical.units[0]!.fact.production_state).toBe('delivered')
    expect(before.physical.movements.length).toBeGreaterThan(0);expect(after.physical).toEqual(before.physical)
    expect(await applyCapture(money,f)).toMatchObject({replayed:true})
    expect(await money.recordManualRefundResult(f.refundInput)).toMatchObject({replayed:true})
    expect(await facts(f)).toEqual(after)
  })
  it('allows the opposite real lock arrival: batch capture first, ordinary refund waits on its parent',async()=>{
    const f=await fixture(2,true),before=await facts(f),events:Array<Record<string,unknown>>=[]
    const captureLane=lane('capture-first',sql=>sql.includes('FROM mbox.order_payment_batches batch')&&sql.includes('FOR UPDATE OF session'),events)
    const refundLane=lane('refund-second',()=>false,events)
    const captureService=service(new ScopedPostgresTransactionRunner(captureLane.pool))
    const refundService=service(new ScopedPostgresTransactionRunner(refundLane.pool))
    const capture=settled(applyCapture(captureService,f))
    let refund:ReturnType<typeof settled>|undefined
    try{
      await expect.poll(()=>captureLane.hit,{timeout:2000,interval:10}).toBe(true)
      refund=settled(refundService.recordManualRefundResult(f.refundInput))
      await expect.poll(async()=>{
        const rows=await blocking([refundLane.pid!,captureLane.pid!].filter(Boolean))
        return rows.some(row=>row.pid===refundLane.pid&&row.blockers.includes(captureLane.pid!))
      },{timeout:2000,interval:10}).toBe(true)
    }finally{captureLane.resume.resolve();refundLane.resume.resolve()}
    const captured=await capture,refunded=refund?await refund:null,after=await facts(f)
    save('capture-first',{sourceSha,identity,scope,before,after,captured,refunded,queries:events})
    expect(captured.status).toBe('fulfilled');expect(refunded?.status).toBe('fulfilled')
    expect(after.physical).toEqual(before.physical);expect(after.session).toEqual(before.session)
    expect(await applyCapture(money,f)).toMatchObject({replayed:true})
    expect(await money.recordManualRefundResult(f.refundInput)).toMatchObject({replayed:true})
    expect(await facts(f)).toEqual(after)
  })
  it.each(['approval-first','execution-first'] as const)('keeps approval and execution serialized without a reverse refund lock: %s',async mode=>{
    const f=await fixture(),before=await facts(f),events:Array<Record<string,unknown>>=[]
    const approvalLane=lane('approval',sql=>sql.includes('approval_context.approval_limit_minor'),events)
    const executionLane=lane('execution',sql=>/FROM mbox\.orders/.test(sql)&&sql.includes('FOR UPDATE'),events)
    const approving=service(new ScopedPostgresTransactionRunner(approvalLane.pool))
    const executing=service(new ScopedPostgresTransactionRunner(executionLane.pool))
    let approval:ReturnType<typeof settled>|undefined,execution:ReturnType<typeof settled>|undefined,barrierError:unknown
    const approvalInput={...meta(),refundId:f.second.id,decisionReason:'重复审批仍须检查当前状态'}
    const startApproval=()=>settled(approving.approveRefund(approvalInput))
    const executionInput={...meta(),refundId:f.second.id}
    const startExecution=()=>settled(executing.beginRefundExecution(executionInput))
    try{
      if(mode==='approval-first'){
        approval=startApproval();await expect.poll(()=>approvalLane.hit,{timeout:2000,interval:10}).toBe(true)
        execution=startExecution();await expect.poll(()=>executionLane.hit,{timeout:2000,interval:10}).toBe(true)
      }else{
        execution=startExecution();await expect.poll(()=>executionLane.hit,{timeout:2000,interval:10}).toBe(true)
        approval=startApproval();await expect.poll(()=>approvalLane.hit,{timeout:2000,interval:10}).toBe(true)
      }
    }catch(error){barrierError=errorData(error)}finally{approvalLane.resume.resolve();executionLane.resume.resolve()}
    const approved=approval?await approval:null,executed=execution?await execution:null,after=await facts(f)
    save(mode,{sourceSha,identity,scope,before,after,approved,executed,barrierError,queries:events})
    expect(barrierError).toBeUndefined()
    expect(executed).toMatchObject({status:'fulfilled',value:{value:{status:'processing'}}})
    expect(approved).toMatchObject({status:'rejected',error:{name:'RefundTransitionError'}})
    expect(after).toEqual(before)
    expect((await admin.query('SELECT count(*)::int n FROM mbox.idempotency_records WHERE tenant_id=$1 AND store_id=$2 AND idempotency_key=$3',[scope.tenantId,scope.storeId,approvalInput.idempotencyKey])).rows[0].n).toBe(0)
    expect((await admin.query("SELECT count(*)::int n FROM mbox.idempotency_records WHERE tenant_id=$1 AND store_id=$2 AND idempotency_key=$3 AND status='completed'",[scope.tenantId,scope.storeId,executionInput.idempotencyKey])).rows[0].n).toBe(1)
    expect(await money.beginRefundExecution(executionInput)).toMatchObject({replayed:true})
    expect(await facts(f)).toEqual(after)
  })
  it('preserves current approval permission, self-decision and amount limits after removing the early child lock',async()=>{
    const f=await fixture(1,false,true),before=await facts(f)
    await expect(money.approveRefund({...meta(requester),refundId:f.second.id,decisionReason:'本人没有审核权限'})).rejects.toMatchObject({name:'PaymentAuthorizationError'})
    for(const decision of ['approve','reject'] as const){
      await expect(runner.run(scope,tx=>new RefundRepository(tx)[decision](f.second.id,requester,'锁后仍禁止本人决策'))).rejects.toMatchObject({name:'RefundTransitionError'})
    }
    await admin.query("UPDATE mbox.role_approval_limits SET amount_minor=100 WHERE tenant_id=$1 AND store_id=$2 AND approval_code='refund.approve'",[scope.tenantId,scope.storeId])
    try{await expect(money.approveRefund({...meta(),refundId:f.second.id,decisionReason:'金额超过当前限额'})).rejects.toMatchObject({name:'PaymentAuthorizationError'})}
    finally{await admin.query("UPDATE mbox.role_approval_limits SET amount_minor=100000 WHERE tenant_id=$1 AND store_id=$2 AND approval_code='refund.approve'",[scope.tenantId,scope.storeId])}
    await expect(admin.query('UPDATE mbox.refunds SET amount_minor=amount_minor+1 WHERE id=$1',[f.second.id])).rejects.toMatchObject({code:'23514'})
    await expect(admin.query("UPDATE mbox.refunds SET currency='USD' WHERE id=$1",[f.second.id])).rejects.toMatchObject({code:'23514'})
    expect(await facts(f)).toEqual(before)
    expect(await money.approveRefund({...meta(),refundId:f.second.id,decisionReason:'合法异人且现权限额度满足'})).toMatchObject({value:{status:'approved'}})
  })
  it('accepts the reverse sequential order: refund first, verified late capture second',async()=>{
    const f=await fixture(),before=await facts(f)
    await money.recordManualRefundResult(f.refundInput)
    expect((await facts(f)).order.payment_status).toBe('refunded')
    await applyCapture(money,f)
    const after=await facts(f)
    expect(after.pending.status).toBe('succeeded');expect(after.secondRefund.status).toBe('succeeded')
    expect(after.order.payment_status).toBe('partially_refunded')
    expect(after.session).toEqual(before.session);expect(after.physical).toEqual(before.physical)
  })
  async function blocking(pids:number[]){
    return (await admin.query<{pid:number;blockers:number[]}>(`SELECT pid,usename,state,wait_event_type,wait_event,pg_blocking_pids(pid) blockers,query FROM pg_stat_activity WHERE pid=ANY($1::int[]) ORDER BY pid`,[pids])).rows
  }
  function lane(name:string,match:(sql:string)=>boolean,events:Array<Record<string,unknown>>){
    const result={pid:undefined as number|undefined,hit:false,resume:deferred(),pool:null as unknown as PostgresPool}
    result.pool={
      async connect(){
        const client=await runtime.connect()
        result.pid=Number((await client.query('SELECT pg_backend_pid() pid')).rows[0].pid)
        return {
          async query<Row extends Record<string,unknown>>(sql:string,values?:unknown[]):Promise<PostgresQueryResult<Row>>{
            const event:Record<string,unknown>={lane:name,pid:result.pid,sql,values,startedAt:new Date().toISOString()};events.push(event)
            try{
              const query=await client.query(sql,values);event.finishedAt=new Date().toISOString();event.rowCount=query.rowCount
              if(!result.hit&&match(sql)){
                result.hit=true;event.barrier='paused AFTER actual business query acquired its rows';await result.resume.promise;event.releasedAt=new Date().toISOString()
              }
              return query as PostgresQueryResult<Row>
            }catch(error){event.error=errorData(error);throw error}
          },
          release(error?:Error|boolean){client.release(error)},
        } satisfies PostgresPoolClient
      },
      async end(){},
    }
    return result
  }
})
