import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import Fastify from 'fastify'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {NormalizedCommandExecutor,appendOutboxMessage} from './command-executor.js'
import {PaymentCommandService} from './payment-command-service.js'
import {NormalizedPaymentCapabilityAuthorization} from './payment-security-policy.js'
import {NormalizedProviderObservationAuthority} from './provider-verification-observation.js'
import {ItemAfterSalesCommandService} from './item-after-sales-command-service.js'
import {ItemAfterSalesOperatingEffects} from './item-after-sales-operating-effects.js'
import {readCheckoutPrintSummary} from './checkout-print-summary.js'
import {readTableSessionClosureState} from './table-session-closure-blockers.js'
import {readBusinessDayBlockerFacts} from './business-day-blocker-facts.js'
import {listTablePaymentOrdersForSession} from './commerce-kds-api.js'
import {orderNeedsCollectionSql} from './order-collection-sql.js'
import {ItemQuantityFulfillmentRepository} from './item-quantity-fulfillment-repository.js'
import {normalizedOperationsApiPlugin} from './normalized-operations-api.js'
import {TableSessionRepository,TableSessionCommandService} from './table-session-repository.js'
import {ServiceTaskRepository} from './service-task-repository.js'
import {PrintTicketSourceRepository} from './print-ticket-source.js'

// Recheck at f8306c7718e011f451af5f0eb29f0e8e16dbd532.
// A passing STILL REPRODUCES assertion confirms the defect remains; it is not a fix acceptance.
// Seed only immutable product/table facts; all money and after-sales transitions
// below use real command services, real permissions, and separate decision actors.
const url=process.env.TEST_NORMALIZED_DATABASE_URL
;(url?describe:describe.skip)('120-guest money recheck: defect reproduction, not fix acceptance',()=>{
  let pool:Pool,runner:ScopedPostgresTransactionRunner,money:PaymentCommandService,afterSales:ItemAfterSalesCommandService,date:string
  const scope={tenantId:randomUUID(),storeId:randomUUID()},area=randomUUID(),product=randomUUID(),requester=randomUUID(),cashier=randomUUID()
  beforeAll(async()=>{
    await runNormalizedMigrations(url!)
    pool=new Pool({connectionString:url,max:8});runner=new ScopedPostgresTransactionRunner(pool)
    const commands=new NormalizedCommandExecutor(runner)
    money=new PaymentCommandService(commands,new NormalizedPaymentCapabilityAuthorization(),new NormalizedProviderObservationAuthority())
    afterSales=new ItemAfterSalesCommandService(commands,new ItemAfterSalesOperatingEffects())
    await pool.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'120 money audit')",[scope.tenantId,`money-${scope.tenantId}`])
    await pool.query("INSERT INTO mbox.stores(id,tenant_id,code,name,timezone,business_day_cutoff) VALUES($1,$2,'money','money audit','Asia/Shanghai','06:00')",[scope.storeId,scope.tenantId])
    date=await runner.run(scope,async tx=>(await tx.query<{date:string}>('SELECT mbox.current_operating_business_date($1,$2)::text AS date',[scope.tenantId,scope.storeId])).rows[0].date)
    await pool.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'A','Audit','indoor')",[area,scope.tenantId,scope.storeId])
    await pool.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station) VALUES($1,$2,$3,'WATER','水','drink','bar')",[product,scope.tenantId,scope.storeId])
    const device=randomUUID()
    await pool.query("INSERT INTO mbox.devices(id,tenant_id,store_id,code,name,device_type,station_code,connectivity_status) VALUES($1,$2,$3,'audit-printer','隔离票据目标','printer','cashier','offline')",[device,scope.tenantId,scope.storeId])
    await pool.query("INSERT INTO mbox.printer_routes(tenant_id,store_id,code,name,station_code,printer_device_id) VALUES($1,$2,'cashier','审计收银','cashier',$3)",[scope.tenantId,scope.storeId,device])
    for(const id of [requester,cashier]){
      await pool.query('INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,$4,$4)',[id,scope.tenantId,scope.storeId,id])
      const role=randomUUID()
      await pool.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,$4,'Audit actor')",[role,scope.tenantId,scope.storeId,`M_${role.replaceAll('-','').toUpperCase()}`])
      await pool.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 minute')",[scope.tenantId,scope.storeId,id,role])
      const codes=id===requester?['refund.request','table.view_all']:['payment.manual.cash.record','payment.collect.all_tables','refund.approve','refund.execute','table.view_all','table.close']
      for(const code of codes){
        const permission=(await pool.query("INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category) VALUES($1,$2,$3,$3,'operations') ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET name=EXCLUDED.name RETURNING id",[scope.tenantId,scope.storeId,code])).rows[0].id
        await pool.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[scope.tenantId,scope.storeId,role,permission])
      }
      if(id===cashier)await pool.query("INSERT INTO mbox.role_approval_limits(tenant_id,store_id,role_id,approval_code,amount_minor,currency) VALUES($1,$2,$3,'refund.approve',100000,'CNY')",[scope.tenantId,scope.storeId,role])
    }
  },30000)
  afterAll(async()=>{await pool?.end()})
  const metadata=(employeeId=cashier)=>({scope,actor:{type:'employee' as const,employeeId},businessDate:date,idempotencyKey:randomUUID(),requestFingerprint:randomUUID()})
  async function fixture(bundle=false,capturedMinor=4000){
    const table=randomUUID(),session=randomUUID(),order=randomUUID(),item=randomUUID(),task=randomUUID(),parent=bundle?randomUUID():item
    await pool.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,$5,$5,8)",[table,scope.tenantId,scope.storeId,area,`T${table.slice(0,8)}`])
    await pool.query('INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1,$2,$3,$4,$5,$6,4)',[session,scope.tenantId,scope.storeId,table,session,date])
    await pool.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,submitted_at,subtotal_amount_minor,total_amount_minor) VALUES($1,$2,$3,$4,$5,'staff_assisted','submitted',clock_timestamp(),4000,4000)",[order,scope.tenantId,scope.storeId,session,order])
    if(bundle)await pool.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot) VALUES($1,$2,$3,$4,$5,1,4000,4000,'none','{"name":"40元套餐","inventoryControlMode":"not_managed"}')`,[parent,scope.tenantId,scope.storeId,order,product])
    await pool.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,parent_order_item_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot) VALUES($1,$2,$3,$4,$5,$6,5,$7,$8,'bar','{"name":"水","singlePriceReferenceMinor":800,"inventoryControlMode":"not_managed"}')`,[item,scope.tenantId,scope.storeId,order,product,bundle?parent:null,bundle?0:800,bundle?0:4000])
    await pool.query("INSERT INTO mbox.kds_tasks(id,tenant_id,store_id,order_item_id,station_code,quantity,status) VALUES($1,$2,$3,$4,'bar',5,'pending')",[task,scope.tenantId,scope.storeId,item])
    if(bundle){
      const food=randomUUID()
      await pool.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,parent_order_item_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot) VALUES($1,$2,$3,$4,$5,$6,1,0,0,'kitchen','{"name":"小食","singlePriceReferenceMinor":2000,"inventoryControlMode":"not_managed"}')`,[food,scope.tenantId,scope.storeId,order,product,parent])
      await pool.query("INSERT INTO mbox.kds_tasks(id,tenant_id,store_id,order_item_id,station_code,quantity,status) VALUES($1,$2,$3,$4,'kitchen',1,'pending')",[randomUUID(),scope.tenantId,scope.storeId,food])
    }
    const payment=(await money.recordManual({...metadata(),orderId:order,...(capturedMinor===4000?{}:{orderIds:[order],amountMinor:capturedMinor}),publicId:randomUUID(),provider:'cash',method:'cash',evidence:{collectedByEmployeeId:cashier,receiptReference:randomUUID()}})).value
    return {session,order,item,task,parent,payment}
  }
  async function stop(f:Awaited<ReturnType<typeof fixture>>,quantity:number){
    const original=(await afterSales.request({scope,employeeId:requester,businessDate:date,orderItemId:f.item,quantity,reason:'顾客要求部分退品',idempotencyKey:randomUUID()})).value
    await afterSales.decide({scope,employeeId:cashier,businessDate:date,caseId:original.caseId,decision:'approved',reason:'核对原价和保留商品后批准',idempotencyKey:randomUUID()})
    for(const refund of original.refunds)await completeRefund(refund.id)
    return original
  }
  async function completeRefund(refundId:string){
    await money.beginRefundExecution({...metadata(),refundId})
    return money.recordManualRefundResult({...metadata(),refundId,succeeded:true,receiptReference:''})
  }
  async function compensate(f:Awaited<ReturnType<typeof fixture>>,amountMinor:number){
    const refund=(await money.requestRefund({...metadata(requester),paymentId:f.payment.id,publicId:randomUUID(),purpose:'service_compensation',reason:'因等待较久补偿顾客',allocations:[{orderItemId:f.parent,amountMinor}]})).value
    await money.approveRefund({...metadata(),refundId:refund.id,decisionReason:'核对服务问题，同意补偿'})
    await completeRefund(refund.id)
  }
  const summary=(order:string)=>runner.run(scope,tx=>readCheckoutPrintSummary(tx,[order]))
  const due=(session:string)=>runner.run(scope,tx=>listTablePaymentOrdersForSession(tx,session))
  const closure=(session:string)=>runner.run(scope,tx=>readTableSessionClosureState(tx,session))
  const status=(order:string)=>pool.query('SELECT payment_status FROM mbox.orders WHERE id=$1',[order]).then(r=>r.rows[0].payment_status)
  const daySummary=()=>runner.run(scope,async tx=>(await tx.query<{summary:{outstandingMinor:string}}> ('SELECT mbox.operating_day_summary($1,$2,$3) AS summary',[scope.tenantId,scope.storeId,date])).rows[0].summary)
  const bill=(session:string)=>runner.run(scope,async tx=>{
    const source=await appendOutboxMessage(tx,{aggregateType:'manual_print_request',aggregateId:randomUUID(),aggregateVersion:1,eventType:'manual.table-bill.requested.v1',payload:{tableSessionId:session}})
    return (await new PrintTicketSourceRepository(tx,true).materializeManualTableBill(source,session,'审计收银员'))[0].printSnapshot
  })

  it('control: ordinary service compensation does not create a new bill debt',async()=>{
    const f=await fixture();await compensate(f,100)
    expect(await summary(f.order)).toMatchObject({receivable:4000,received:4000,refunded:100,net:3900,due:0,state:'paid'})
    expect(await due(f.session)).toEqual([])
  })

  it('SIM120-02 STILL REPRODUCES: compensation after quantity refund creates false printed debt',async()=>{
    const f=await fixture();await stop(f,1)
    expect(await summary(f.order)).toMatchObject({receivable:3200,received:4000,refunded:800,net:3200,due:0,state:'paid'})
    await compensate(f,100)
    const totals=await summary(f.order),collectible=await due(f.session)
    expect(totals).toMatchObject({receivable:3200,received:4000,refunded:900,net:3100,due:100,state:'partial'})
    expect(collectible).toEqual([])
    const ticket=await bill(f.session)
    expect(ticket.title).toBe('预结账单')
    expect(ticket.lines).toEqual(expect.arrayContaining([expect.objectContaining({name:'尚未收款',totalAmountMinor:100})]))
    expect((await pool.query('SELECT count(*)::int n FROM mbox.order_recollection_authorizations WHERE order_id=$1',[f.order])).rows[0].n).toBe(0)
    expect((await pool.query("SELECT count(*)::int n,sum(amount_minor)::int amount FROM mbox.reconciliation_entries WHERE payment_id=$1 AND entry_type='refund'",[f.payment.id])).rows[0]).toEqual({n:2,amount:-900})
    console.log('MONEY_RECHECK',JSON.stringify({issue:'SIM120-02',verdict:'still_reproduces',totals,collectible,ticketTitle:ticket.title,ticketOutstanding:ticket.lines.filter(line=>line.name==='尚未收款')}))
  })

  it('SIM120-01 STILL REPRODUCES: normal close succeeds with 400 fen retained bundle debt',async()=>{
    const f=await fixture(true),stopped=await stop(f,2)
    expect(stopped.refunds).toEqual([])
    expect(await status(f.order)).toBe('paid')
    expect(await summary(f.order)).toMatchObject({receivable:4400,received:4000,refunded:0,due:400,state:'partial'})
    expect(await due(f.session)).toEqual(expect.arrayContaining([expect.objectContaining({id:f.order,outstandingAmountMinor:400})]))
    const close=await closure(f.session)
    expect(close.outstandingAmountMinor).toBe(0)
    expect(close.blockers.some(b=>b.code==='ORDER_UNSETTLED')).toBe(false)
    expect(await runner.run(scope,tx=>readBusinessDayBlockerFacts(tx,f.session,'ORDER_UNSETTLED'))).toEqual([])
    expect((await runner.run(scope,tx=>tx.query(`SELECT ${orderNeedsCollectionSql('o')} AS needs FROM mbox.orders o WHERE id=$1`,[f.order]))).rows[0].needs).toBe(true)
    // Complete the retained physical portions through the original quantity
    // fulfillment repository; no direct terminal-state SQL shortcuts.
    const tasks=(await pool.query('SELECT task.id,task.order_item_id FROM mbox.kds_tasks task JOIN mbox.order_items item ON item.id=task.order_item_id WHERE item.order_id=$1',[f.order])).rows
    for(const task of tasks)await runner.run(scope,async tx=>{
      const fulfillment=new ItemQuantityFulfillmentRepository(tx)
      const target={taskId:task.id,itemId:task.order_item_id,employeeId:cashier,quantity:task.order_item_id===f.item?3:1}
      await fulfillment.complete({...target,eventKey:randomUUID()})
      await fulfillment.deliver({...target,eventKey:randomUUID()})
    })
    expect((await closure(f.session)).blockers).toEqual([])
    const app=Fastify(),commands=new NormalizedCommandExecutor(runner)
    await app.register(normalizedOperationsApiPlugin,{
      operationsQuery:{getStaffView:async()=>{throw new Error('unused read port')}},
      tableSessions:new TableSessionCommandService(commands),commandExecutor:commands,
      resolveContext:()=>({scope,employeeId:cashier,businessDate:date,capabilities:['table.close']}),
      createTableSessionRepository:tx=>new TableSessionRepository(tx),createServiceTaskRepository:tx=>new ServiceTaskRepository(tx),
    })
    try{
      for(const transition of ['begin-closing','close']){
        const response=await app.inject({method:'POST',url:`/table-sessions/${f.session}/${transition}`,headers:{'idempotency-key':randomUUID()},payload:{}})
        expect(response.statusCode,response.body).toBe(200)
      }
      expect((await pool.query('SELECT status FROM mbox.table_sessions WHERE id=$1',[f.session])).rows[0].status).toBe('closed')
      expect(await summary(f.order)).toMatchObject({due:400,state:'partial'})
      console.log('MONEY_RECHECK',JSON.stringify({issue:'SIM120-01',scenario:'bundle',verdict:'still_reproduces',tableStatus:'closed',paymentStatus:await status(f.order),totals:await summary(f.order),closure:await closure(f.session)}))
    }finally{await app.close()}
  })

  it('SIM120-01 and SIM120-03 STILL REPRODUCE: 2400 fen due hidden from closure and day report says 1600',async()=>{
    const before=Number((await daySummary()).outstandingMinor)
    const f=await fixture(false,1600)
    expect(await status(f.order)).toBe('partially_paid')
    await stop(f,1)
    expect(await status(f.order)).toBe('partially_refunded')
    expect(await summary(f.order)).toMatchObject({receivable:3200,received:1600,refunded:800,net:800,due:2400,state:'partial'})
    const close=await closure(f.session)
    expect(close.outstandingAmountMinor).toBe(0)
    expect(close.blockers.some(b=>b.code==='ORDER_UNSETTLED')).toBe(false)
    expect(await runner.run(scope,tx=>readBusinessDayBlockerFacts(tx,f.session,'ORDER_UNSETTLED'))).toEqual([])
    // The daily report independently uses gross receipts unless a recollection
    // authorization is active; it omits 8 yuan actually returned to this guest.
    expect(Number((await daySummary()).outstandingMinor)-before).toBe(1600)
    console.log('MONEY_RECHECK',JSON.stringify({issues:['SIM120-01','SIM120-03'],scenario:'partial_receipt_return',verdict:'still_reproduces',totals:await summary(f.order),closure:close,dailyOutstandingDelta:Number((await daySummary()).outstandingMinor)-before}))
  })
})
