import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {PaymentCommandService} from './payment-command-service.js'
import {NormalizedPaymentCapabilityAuthorization} from './payment-security-policy.js'
import {NormalizedProviderObservationAuthority} from './provider-verification-observation.js'
import {PostgresCashierWorkbenchQuery} from './cashier-workbench-query.js'
import {StaffAccessRepository} from './staff-access-repository.js'
const url=process.env.TEST_NORMALIZED_DATABASE_URL,runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
;(url&&runtimeUrl?describe:describe.skip)('cashier whole historical batch eligibility, restricted LOGIN',()=>{
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
  async function fixture(count=2,options:{unqualifiedLast?:boolean;settleCount?:number;singlePayment?:boolean}={}){
    const table=randomUUID(),session=randomUUID(),orders:string[]=[]
    await pool.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,$5,$5,4)",[table,scope.tenantId,scope.storeId,area,`T${table.slice(0,8)}`])
    await pool.query('INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1::uuid,$2,$3,$4,$1::text,$5,2)',[session,scope.tenantId,scope.storeId,table,date])
    for(let index=0;index<count;index++){
      const order=randomUUID(),item=randomUUID();orders.push(order)
      await pool.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,submitted_at,subtotal_amount_minor,total_amount_minor) VALUES($1::uuid,$2,$3,$4,$1::text,'staff_assisted','submitted',clock_timestamp(),4000,4000)",[order,scope.tenantId,scope.storeId,session])
      await pool.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot) VALUES($1,$2,$3,$4,$5,1,4000,4000,'none','{"name":"fixture","inventoryControlMode":"not_managed"}')`,[item,scope.tenantId,scope.storeId,order,product])
      if(options.unqualifiedLast&&index===count-1)continue
      const paid=(await money.recordManual({...meta(),orderId:order,publicId:randomUUID(),provider:'cash',method:'cash',evidence:{collectedByEmployeeId:cashier,receiptReference:randomUUID()}})).value
      const refund=(await money.requestRefund({...meta(requester),paymentId:paid.id,publicId:randomUUID(),purpose:'price_adjustment',reason:'原订单金额核对退款',allocations:[{orderItemId:item,amountMinor:(index+1)*1000}]})).value
      await money.approveRefund({...meta(),refundId:refund.id,decisionReason:'异人核准原退款'})
      await money.beginRefundExecution({...meta(),refundId:refund.id});await money.recordManualRefundResult({...meta(),refundId:refund.id,succeeded:true,receiptReference:randomUUID()})
      await money.authorizeRecollection({...meta(),orderId:order,reason:'原关桌前明确补收义务'})
    }
    const pending=(await money.initiate({...meta(),orderId:orders[0]!,...(options.singlePayment?{}:{orderIds:orders}),publicId:randomUUID(),provider:'postar',method:'native_qr',principal:{type:'employee',employeeId:cashier}})).value
    expect(pending.payableKind).toBe(options.singlePayment?'order':'order_batch')
    for(const orderId of orders.slice(0,options.settleCount??0)){
      await money.authorizeRecollection({...meta(),orderId,reason:'核对原欠款后现金结清其中一单'})
      await money.recordManual({...meta(),orderId,publicId:randomUUID(),provider:'cash',method:'cash',evidence:{collectedByEmployeeId:cashier,receiptReference:randomUUID()}})
    }
    // This admin-only fixture represents an already closed legacy session. All
    // actual money, refund and pending batch facts were created by low LOGIN.
    await pool.query("UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp(),closed_by_employee_id=$2 WHERE id=$1",[session,cashier])
    return {session,orders,pending}
  }
  const view=async(orderId:string)=>{
    const actual=await runner.run(scope,tx=>new StaffAccessRepository(tx).resolve(cashier))
    return (await new PostgresCashierWorkbenchQuery(runner).get({scope,employeeId:cashier,businessDate:date,capabilities:actual.permissions,query:orderId,limit:1})).orders[0]!
  }
  it.each([1,2])('projects full payment and every allocation even when only one of %i orders is queried',async count=>{
    const f=await fixture(count),row=await view(f.orders[0]!)
    expect(row.closedDebtRecovery?.pendingPaymentIds).toContain(f.pending.id)
    expect(row.closedDebtRecovery?.closableUnpresentedPaymentIds).toContain(f.pending.id)
    expect(row.closedDebtRecovery).toMatchObject({closableUnpresentedPayments:[{paymentId:f.pending.id,payableKind:'order_batch',totalAmountMinor:count===1?1000:3000,currency:'CNY',orderIds:expect.arrayContaining(f.orders),orderPublicIds:expect.arrayContaining(f.orders)}]})
    expect(row.payments.find(payment=>payment.id===f.pending.id)?.amountMinor).toBe(1000)
  })
  it('includes an already settled member in the whole-batch disclosure without giving it new collection rights',async()=>{
    const f=await fixture(2,{settleCount:1}),settled=await view(f.orders[0]!),due=await view(f.orders[1]!)
    expect(settled.closedDebtRecovery?.status).toBe('settled')
    expect(settled.outstandingAmountMinor).toBe(0)
    expect(due.closedDebtRecovery?.status).toBe('pending_payment')
    expect(due.closedDebtRecovery?.closableUnpresentedPayments).toEqual([expect.objectContaining({paymentId:f.pending.id,totalAmountMinor:3000,orderIds:expect.arrayContaining(f.orders)})])
  })
  it('does not offer a new local void when every member is already settled',async()=>{
    const f=await fixture(2,{settleCount:2}),row=await view(f.orders[0]!)
    expect(row.closedDebtRecovery).toMatchObject({status:'settled',closableUnpresentedPaymentIds:[],closableUnpresentedPayments:[]})
  })
  it('preserves the original single-order action and discloses its exact payment amount',async()=>{
    const f=await fixture(1,{singlePayment:true}),row=await view(f.orders[0]!)
    expect(row.closedDebtRecovery?.closableUnpresentedPaymentIds).toEqual([f.pending.id])
    expect(row.closedDebtRecovery?.closableUnpresentedPayments).toEqual([{paymentId:f.pending.id,payableKind:'order',totalAmountMinor:1000,currency:'CNY',orderIds:f.orders,orderPublicIds:f.orders}])
  })
  it('hides the whole batch when a different allocation lacks an original historical obligation',async()=>{
    const f=await fixture(2,{unqualifiedLast:true}),row=await view(f.orders[0]!)
    expect(row.closedDebtRecovery?.status).toBe('pending_payment')
    expect(row.closedDebtRecovery?.closableUnpresentedPaymentIds).toEqual([])
  })
  it('revokes the same whole-batch action for each current required permission',async()=>{
    const f=await fixture(2)
    for(const code of ['payment.initiate.staff','reconciliation.view','payment.collect.all_tables','payment.recollect.authorize']){
      await pool.query("INSERT INTO mbox.employee_permission_overrides(tenant_id,store_id,employee_id,permission_id,effect,reason,configured_by_employee_id) SELECT $1,$2,$3,id,'deny','test current revocation',$3 FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code=$4",[scope.tenantId,scope.storeId,cashier,code])
      try{const recovery=(await view(f.orders[0]!)).closedDebtRecovery;expect(recovery?.closableUnpresentedPaymentIds).toEqual([]);expect(recovery?.closableUnpresentedPayments).toEqual([])}finally{await pool.query('DELETE FROM mbox.employee_permission_overrides WHERE tenant_id=$1 AND store_id=$2 AND employee_id=$3',[scope.tenantId,scope.storeId,cashier])}
    }
    expect((await view(f.orders[0]!)).closedDebtRecovery?.closableUnpresentedPaymentIds).toContain(f.pending.id)
  })
})
