import {CustomerExperienceService} from './customer-experience-service.js'
import {LoyaltyOperationalControlService} from './loyalty-operational-control-service.js'
import {LoyaltyAccrualDeferredWorker} from './loyalty-accrual-deferred-worker.js'
import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import Fastify from 'fastify'
import {afterAll,afterEach,beforeAll,describe,expect,it} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {NormalizedCommandExecutor,appendOutboxMessage} from './command-executor.js'
import {PaymentCommandService} from './payment-command-service.js'
import {NormalizedPaymentCapabilityAuthorization} from './payment-security-policy.js'
import {NormalizedProviderObservationAuthority,VerifiedProviderObservationService} from './provider-verification-observation.js'
import {ItemAfterSalesCommandService} from './item-after-sales-command-service.js'
import {ItemAfterSalesOperatingEffects} from './item-after-sales-operating-effects.js'
import {PostgresCashierWorkbenchQuery} from './cashier-workbench-query.js'
import {loadGuestTableOrders} from './guest-table-orders-query.js'
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

// Acceptance tests assert the repaired consumption projection with a real restricted LOGIN.
// Seed only immutable product/table facts; all money and after-sales transitions
// below use real command services, real permissions, and separate decision actors.
const url=process.env.TEST_NORMALIZED_DATABASE_URL,runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
;(url&&runtimeUrl?describe:describe.skip)('consumption due after quantity refunds and compensation',()=>{
  let pool:Pool,runtimePool:Pool,runner:ScopedPostgresTransactionRunner,money:PaymentCommandService,afterSales:ItemAfterSalesCommandService,date:string
  const scope={tenantId:randomUUID(),storeId:randomUUID()},area=randomUUID(),product=randomUUID(),requester=randomUUID(),cashier=randomUUID()
  beforeAll(async()=>{
    await runNormalizedMigrations(url!)
    pool=new Pool({connectionString:url,max:8});runtimePool=new Pool({connectionString:runtimeUrl,max:8});runner=new ScopedPostgresTransactionRunner(runtimePool)
    expect((await runtimePool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=session_user')).rows[0]).toEqual({rolsuper:false,rolbypassrls:false})
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
      const codes=id===requester?['refund.request','table.view_all']:['payment.initiate.staff','payment.manual.cash.record','payment.collect.all_tables','refund.request','refund.approve','refund.execute','table.view_all','table.close']
      for(const code of codes){
        const permission=(await pool.query("INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category) VALUES($1,$2,$3,$3,'operations') ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET name=EXCLUDED.name RETURNING id",[scope.tenantId,scope.storeId,code])).rows[0].id
        await pool.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[scope.tenantId,scope.storeId,role,permission])
      }
      if(id===cashier)await pool.query("INSERT INTO mbox.role_approval_limits(tenant_id,store_id,role_id,approval_code,amount_minor,currency) VALUES($1,$2,$3,'refund.approve',100000,'CNY')",[scope.tenantId,scope.storeId,role])
    }
  },30000)
  afterAll(async()=>{await runtimePool?.end();await pool?.end()})
  const metadata=(employeeId=cashier)=>({scope,actor:{type:'employee' as const,employeeId},businessDate:date,idempotencyKey:randomUUID(),requestFingerprint:randomUUID()})
  async function fixture(bundle=false,capturedMinor=4000,existingSession?:string,immediate=false,ineligibleMinor=0,wholeLineReturn=false){
    const table=randomUUID(),session=existingSession??randomUUID(),order=randomUUID(),item=randomUUID(),task=randomUUID(),parent=bundle?randomUUID():item
    if(!existingSession){
      await pool.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,$5,$5,8)",[table,scope.tenantId,scope.storeId,area,`T${table.slice(0,8)}`])
      await pool.query('INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1,$2,$3,$4,$5,$6,4)',[session,scope.tenantId,scope.storeId,table,session,date])
    }
    await pool.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,submitted_at,subtotal_amount_minor,total_amount_minor) VALUES($1,$2,$3,$4,$5,'staff_assisted','submitted',clock_timestamp(),4000,4000)",[order,scope.tenantId,scope.storeId,session,order])
    if(bundle)await pool.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot) VALUES($1,$2,$3,$4,$5,1,4000,4000,'none','{"name":"40元套餐","inventoryControlMode":"not_managed"}')`,[parent,scope.tenantId,scope.storeId,order,product])
    await pool.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,parent_order_item_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot) VALUES($1,$2,$3,$4,$5,$6,5,$7,$8,'bar','{"name":"水","singlePriceReferenceMinor":800,"inventoryControlMode":"not_managed"}')`,[item,scope.tenantId,scope.storeId,order,product,bundle?parent:null,bundle?0:800,bundle?0:4000])
    await pool.query("INSERT INTO mbox.kds_tasks(id,tenant_id,store_id,order_item_id,station_code,quantity,status) VALUES($1,$2,$3,$4,'bar',5,'pending')",[task,scope.tenantId,scope.storeId,item])
    if(bundle){
      const food=randomUUID()
      await pool.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,parent_order_item_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot) VALUES($1,$2,$3,$4,$5,$6,1,0,0,'kitchen','{"name":"小食","singlePriceReferenceMinor":2000,"inventoryControlMode":"not_managed"}')`,[food,scope.tenantId,scope.storeId,order,product,parent])
      await pool.query("INSERT INTO mbox.kds_tasks(id,tenant_id,store_id,order_item_id,station_code,quantity,status) VALUES($1,$2,$3,$4,'kitchen',1,'pending')",[randomUUID(),scope.tenantId,scope.storeId,food])
    }
    let second: string|undefined
    if(ineligibleMinor||wholeLineReturn){
      await pool.query('UPDATE mbox.order_items SET quantity=4,total_amount_minor=3200 WHERE id=$1',[item])
      await pool.query('UPDATE mbox.kds_tasks SET quantity=4 WHERE id=$1',[task])
      second=randomUUID()
      const secondProduct=randomUUID()
      await pool.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station) VALUES($1,$2,$3,$4,'Second product','drink','bar')",[secondProduct,scope.tenantId,scope.storeId,secondProduct])
      await pool.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot,loyalty_eligible_at_submission,loyalty_eligibility_source) VALUES($1,$2,$3,$4,$5,1,800,800,$7,'{"name":"Second product","inventoryControlMode":"not_managed"}',$6,'catalog_product')`,[second,scope.tenantId,scope.storeId,order,secondProduct,wholeLineReturn,wholeLineReturn?'bar':'none'])
    }
    const member=await seedMember(order,item,session)
    if(wholeLineReturn){
      await pool.query("INSERT INTO mbox.kds_tasks(id,tenant_id,store_id,order_item_id,station_code,quantity,status) VALUES($1,$2,$3,$4,'bar',1,'pending')",[randomUUID(),scope.tenantId,scope.storeId,second])
      const option=randomUUID()
      await pool.query(`INSERT INTO mbox.recommendation_options(id,tenant_id,store_id,recommendation_session_id,policy_version_id,product_id,rank,tier,amount_minor,cost_amount_minor,currency,total_score,explanation)
        SELECT $1,o.tenant_id,o.store_id,o.recommendation_session_id,o.policy_version_id,i.product_id,2,o.tier,800,0,o.currency,100,'独立8元推荐行'
        FROM mbox.recommendation_options o JOIN mbox.recommendation_behavior_events e ON e.recommendation_option_id=o.id
        JOIN mbox.order_items i ON i.id=$3 WHERE e.order_id=$2 AND e.event_type='ordered'`,[option,order,second])
      await pool.query(`INSERT INTO mbox.recommendation_behavior_events(tenant_id,store_id,recommendation_session_id,recommendation_option_id,customer_id,table_session_id,order_id,order_item_id,event_type,actor_type,actor_ref)
        SELECT tenant_id,store_id,recommendation_session_id,$1,customer_id,table_session_id,order_id,$2,'ordered','guest','synthetic-second-product'
        FROM mbox.recommendation_behavior_events WHERE order_id=$3 AND event_type='ordered'`,[option,second,order])
    }
    if(immediate){await pool.query("UPDATE mbox.orders SET settlement_mode='immediate_payment',fulfillment_state='awaiting_payment',fulfillment_activated_at=NULL,fulfillment_expires_at=clock_timestamp()+interval '10 minutes' WHERE id=$1",[order]);await pool.query('DELETE FROM mbox.kds_tasks WHERE id=$1',[task])}
    const payment=(await money.recordManual({...metadata(),orderId:order,...(capturedMinor===4000?{}:{orderIds:[order],amountMinor:capturedMinor}),publicId:randomUUID(),provider:'cash',method:'cash',evidence:{collectedByEmployeeId:cashier,receiptReference:randomUUID()}})).value
    return {session,order,item,task,parent,payment,second,...member}
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
  async function compensate(f:Awaited<ReturnType<typeof fixture>>,amountMinor:number,purpose:'service_compensation'|'price_adjustment'='service_compensation'){
    const refund=(await money.requestRefund({...metadata(requester),paymentId:f.payment.id,publicId:randomUUID(),purpose,reason:'依据实际情况核对原款退款',allocations:[{orderItemId:f.parent,amountMinor}]})).value
    await money.approveRefund({...metadata(),refundId:refund.id,decisionReason:'核对服务问题，同意补偿'})
    await completeRefund(refund.id)
  }
  const summary=(order:string)=>runner.run(scope,tx=>readCheckoutPrintSummary(tx,[order]))
  const due=(session:string)=>runner.run(scope,tx=>listTablePaymentOrdersForSession(tx,session))
  const cashierView=async(order:string)=>(await new PostgresCashierWorkbenchQuery(runner).get({scope,employeeId:cashier,businessDate:date,capabilities:['refund.execute','payment.manual.cash.record','payment.recollect.authorize'],query:order,limit:20})).orders.find(row=>row.id===order)
  const guestView=(session:string)=>runner.run(scope,tx=>loadGuestTableOrders(tx,session,requester))
  const closure=(session:string)=>runner.run(scope,tx=>readTableSessionClosureState(tx,session))
  const status=(order:string)=>pool.query('SELECT payment_status FROM mbox.orders WHERE id=$1',[order]).then(r=>r.rows[0].payment_status)
  const daySummary=()=>runner.run(scope,async tx=>(await tx.query<{summary:{outstandingMinor:string}}> ('SELECT mbox.operating_day_summary($1,$2,$3) AS summary',[scope.tenantId,scope.storeId,date])).rows[0].summary)
  const bill=(session:string)=>runner.run(scope,async tx=>{
    const source=await appendOutboxMessage(tx,{aggregateType:'manual_print_request',aggregateId:randomUUID(),aggregateVersion:1,eventType:'manual.table-bill.requested.v1',payload:{tableSessionId:session}})
    return (await new PrintTicketSourceRepository(tx,true).materializeManualTableBill(source,session,'审计收银员'))[0].printSnapshot
  })
  const authorize=(f:Awaited<ReturnType<typeof fixture>>)=>money.authorizeRecollection({...metadata(),orderId:f.order,reason:'确认仅收取保留商品剩余款项，服务补偿保持有效'})
  const collect=async(f:Awaited<ReturnType<typeof fixture>>,amountMinor?:number,orderIds?:string[])=>{
    const command={...metadata(),orderId:f.order,...(orderIds?{orderIds,amountMinor}:{}),publicId:randomUUID(),provider:'cash' as const,method:'cash' as const,evidence:{collectedByEmployeeId:cashier,receiptReference:randomUUID()}}
    const result=await money.recordManual(command)
    expect((await money.recordManual(command)).replayed).toBe(true)
    return result
  }
  async function deliver(f:Awaited<ReturnType<typeof fixture>>,quantity:number){
    await runner.run(scope,async tx=>{
      const repository=new ItemQuantityFulfillmentRepository(tx),target={taskId:f.task,itemId:f.item,employeeId:cashier,quantity}
      await repository.complete({...target,eventKey:randomUUID()});await repository.deliver({...target,eventKey:randomUUID()})
    })
  }
  async function closeSession(session:string){
    const app=Fastify(),commands=new NormalizedCommandExecutor(runner)
    await app.register(normalizedOperationsApiPlugin,{
      operationsQuery:{getStaffView:async()=>{throw new Error('unused read port')}},
      tableSessions:new TableSessionCommandService(commands),commandExecutor:commands,
      resolveContext:()=>({scope,employeeId:cashier,businessDate:date,capabilities:['table.close']}),
      createTableSessionRepository:tx=>new TableSessionRepository(tx),createServiceTaskRepository:tx=>new ServiceTaskRepository(tx),
    })
    try{for(const transition of ['begin-closing','close']){
      const response=await app.inject({method:'POST',url:`/table-sessions/${session}/${transition}`,headers:{'idempotency-key':randomUUID()},payload:{}})
      expect(response.statusCode,response.body).toBe(200)
    }}finally{await app.close()}
  }


  async function seedMember(order:string,item:string,session:string){
    const customer=randomUUID(),membership=randomUUID(),account=randomUUID(),policy=randomUUID(),publisher=randomUUID()
    await pool.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,$4,'Audit publisher')",[publisher,scope.tenantId,scope.storeId,publisher])
    await pool.query("INSERT INTO mbox.customers(id,tenant_id,store_id,public_id,status) VALUES($1::uuid,$2,$3,$1::text,'active')",[customer,scope.tenantId,scope.storeId])
    await pool.query("INSERT INTO mbox.customer_memberships(id,tenant_id,store_id,customer_id,member_no,level,status) VALUES($1,$2,$3,$4,$5,'member','active')",[membership,scope.tenantId,scope.storeId,customer,'MBX'+membership.replaceAll('-','').slice(0,16).toUpperCase()])
    await pool.query('INSERT INTO mbox.loyalty_accounts(id,tenant_id,store_id,membership_id,customer_id) VALUES($1,$2,$3,$4,$5)',[account,scope.tenantId,scope.storeId,membership,customer])
    await pool.query(`INSERT INTO mbox.loyalty_policy_versions(id,tenant_id,store_id,policy_code,version,status,points_numerator,points_denominator_minor,growth_numerator,growth_denominator_minor,rounding_mode,points_validity_months,effective_from,drafted_by_employee_id,approved_by_employee_id,approved_at,published_by_employee_id,published_at,publication_mode,reason)
      VALUES($1,$2,$3,$7,1,'published',1,100,1,100,'floor',18,'2026-08-01',$4,$5,'2026-08-01',$6,'2026-08-01','separated','既有一元一积分成长规则')`,[policy,scope.tenantId,scope.storeId,requester,cashier,publisher,'P'+policy.replaceAll('-','').toUpperCase()])
    await pool.query('UPDATE mbox.orders SET created_by_customer_id=$2,loyalty_policy_version_id=$3,loyalty_points_multiplier_numerator=1,loyalty_points_multiplier_denominator=1 WHERE id=$1',[order,customer,policy])
    await pool.query("UPDATE mbox.order_items SET loyalty_eligible_at_submission=true,loyalty_eligibility_source='catalog_product' WHERE id=$1",[item])
    const recommendation=randomUUID(),option=randomUUID(),recommendPolicy=randomUUID()
    await pool.query("INSERT INTO mbox.recommendation_policy_versions(id,tenant_id,store_id,public_id,policy_code,version,status,created_by_employee_id,draft_reason) VALUES($1::uuid,$2,$3,$1::text,$4,1,'draft',$5,'归属事实隔离夹具')",[recommendPolicy,scope.tenantId,scope.storeId,'R'+recommendPolicy.replaceAll('-','').toUpperCase(),publisher])
    await pool.query("INSERT INTO mbox.recommendation_sessions(id,tenant_id,store_id,public_id,customer_id,table_session_id,business_date,source,party_size,occasion,alcohol_preference,experience_level) VALUES($1::uuid,$2,$3,$1::text,$4,$5,$6,'guest_table',2,'friends','undecided','enhanced')",[recommendation,scope.tenantId,scope.storeId,customer,session,date])
    await pool.query("INSERT INTO mbox.recommendation_options(id,tenant_id,store_id,recommendation_session_id,policy_version_id,product_id,rank,tier,amount_minor,cost_amount_minor,currency,total_score,explanation) VALUES($1,$2,$3,$4,$5,$6,1,'enhanced',4000,0,'CNY',100,'合成推荐事实')",[option,scope.tenantId,scope.storeId,recommendation,recommendPolicy,product])
    await pool.query("INSERT INTO mbox.recommendation_behavior_events(tenant_id,store_id,recommendation_session_id,recommendation_option_id,customer_id,table_session_id,order_id,order_item_id,event_type,actor_type,actor_ref) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ordered','guest','synthetic-guest')",[scope.tenantId,scope.storeId,recommendation,option,customer,session,order,item])
    return {customer,membership,account}
  }
  async function rewards(f:Awaited<ReturnType<typeof fixture>>){return (await pool.query(`SELECT a.available_points,a.growth_value,o.payment_status,o.fulfillment_state,
    (SELECT count(*)::int FROM mbox.loyalty_order_awards WHERE order_id=o.id) awards,
    (SELECT count(*)::int FROM mbox.loyalty_accrual_deferred_orders WHERE order_id=o.id) deferred,
    (SELECT sum(amount_minor)::int FROM mbox.loyalty_order_item_basis WHERE order_id=o.id AND loyalty_eligible) eligible_basis,
    (SELECT count(*)::int FROM mbox.recommendation_behavior_events WHERE order_id=o.id AND event_type='paid') recommendation_paid,
    (SELECT count(*)::int FROM mbox.recommendation_behavior_events WHERE order_id=o.id AND event_type='refunded') recommendation_refunded,
    (SELECT COALESCE(sum(CASE WHEN event_type='paid' THEN attributed_amount_minor ELSE -attributed_amount_minor END),0)::int FROM mbox.recommendation_behavior_events WHERE order_id=o.id AND event_type IN ('paid','refunded')) recommendation_net
    FROM mbox.loyalty_accounts a JOIN mbox.orders o ON o.id=$2 WHERE a.id=$1`,[f.account,f.order])).rows[0]}
  it('control existing-award policy yields 31 points and growth after quantity return plus retained service compensation',async()=>{
    const f=await fixture();expect(await rewards(f)).toMatchObject({available_points:40,growth_value:40,awards:1,recommendation_paid:1})
    await stop(f,1);await compensate(f,100);expect((await rewards(f)).recommendation_net).toBe(3100)
    expect(await rewards(f)).toMatchObject({available_points:31,growth_value:31,awards:1})
  })
  it.each(['single','batch'] as const)('first award after 16 collected then 8 quantity refund plus 1 compensation then 24 collected: %s',async mode=>{
    const f=await fixture(false,1600);expect(await rewards(f)).toMatchObject({available_points:0,growth_value:0,awards:0})
    await stop(f,1);await compensate(f,100);expect((await authorize(f)).value.amountMinor).toBe(2400)
    await collect(f,2400,mode==='batch'?[f.order]:undefined)
    expect(await summary(f.order)).toMatchObject({due:0,net:3100});expect((await rewards(f)).recommendation_net).toBe(3100)
    expect(await rewards(f)).toMatchObject({available_points:31,growth_value:31,awards:1,recommendation_paid:1})
  })
  it('immediate partial order with service compensation accepts the legitimate final 24 and activates retained goods',async()=>{
    const f=await fixture(false,1600,undefined,true);await compensate(f,100);await authorize(f)
    const result=await collect(f)
    expect(result.value.amountMinor).toBe(2400);expect(await rewards(f)).toMatchObject({fulfillment_state:'active',available_points:39,growth_value:39,awards:1,recommendation_net:3900})
    expect((await pool.query('SELECT count(*)::int n FROM mbox.kds_tasks WHERE order_item_id=$1',[f.item])).rows[0].n).toBe(1)
  })


  it.each(['callback','query','batch_callback','batch_query'] as const)('settles retained compensation from a verified provider observation exactly once: %s',async mode=>{
    const f=await fixture(false,1600);await stop(f,1);await compensate(f,100);await authorize(f)
    const payment=(await money.initiate({...metadata(),orderId:f.order,...(mode.startsWith('batch')?{orderIds:[f.order]}:{}),publicId:randomUUID(),provider:'postar',method:'native_qr',principal:{type:'employee',employeeId:cashier}})).value
    expect(payment.amountMinor).toBe(2400)
    expect(await summary(f.order)).toMatchObject({due:2400,net:700,pending:2400})
    const occurredAt=new Date().toISOString(),providerTransactionId='financial-verified-'+randomUUID(),integrationRef='financial-local-verifier'
    const verifiedObservationId=await new VerifiedProviderObservationService(runner).recordPayment({scope,provider:'postar',verificationKind:mode.endsWith('query')?'active_query_binding':'callback_signature',providerEventId:randomUUID(),integrationRef,paymentPublicId:payment.publicId,providerTransactionId,reportedAmountMinor:2400,reportedCurrency:'CNY',status:'succeeded',settlementChannel:'wechat',occurredAt,evidence:{localTest:true}})
    const command={...metadata(),actor:{type:'integration' as const,ref:integrationRef},verifiedObservationId,paymentPublicId:payment.publicId,provider:'postar' as const,providerTransactionId,reportedAmountMinor:2400,reportedCurrency:'CNY',settlementChannel:'wechat' as const,providerSnapshot:{localTest:true},occurredAt}
    if(mode.endsWith('query')){
      await money.recordProviderQueryResult({...command,status:'succeeded'});expect((await money.recordProviderQueryResult({...command,status:'succeeded'})).replayed).toBe(true)
    }else{
      await money.recordSucceededCallback(command);expect((await money.recordSucceededCallback(command)).replayed).toBe(true)
    }
    expect(await summary(f.order)).toMatchObject({due:0,net:3100,pending:0})
    expect(await rewards(f)).toMatchObject({available_points:31,growth_value:31,awards:1,recommendation_paid:1,recommendation_net:3100,payment_status:'partially_refunded'})
  })

  it.each([1600,4000])('attributes an actually sold whole returned line once whether settlement precedes or follows the refund: %s',async captured=>{
    const f=await fixture(false,captured,undefined,false,0,true)
    await stop({...f,item:f.second!},1)
    expect((await pool.query('SELECT status FROM mbox.order_items WHERE id=$1',[f.second])).rows[0].status).toBe('cancelled')
    await compensate(f,100)
    if(captured===1600){await authorize(f);await collect(f)}
    expect(await summary(f.order)).toMatchObject({due:0,received:4000,refunded:900,net:3100})
    expect(await rewards(f)).toMatchObject({available_points:31,growth_value:31,awards:1,recommendation_paid:2,recommendation_refunded:2,recommendation_net:3100})
  })
  const staff=(employeeId=cashier)=>({scope,businessDate:date,employeeId})
  const customers=()=>new CustomerExperienceService(runner,new NormalizedCommandExecutor(runner),{updateProfile:async()=>{throw new Error('unused')}})
  async function pause(operation:'pause'|'resume'){
    const control=new LoyaltyOperationalControlService(runner,new NormalizedCommandExecutor(runner))
    const state=(await control.list(staff())).find(v=>v.capability==='points_accrual')!
    return control.set(staff(),{capability:'points_accrual',operation,reason:'isolated settlement regression',reviewAt:null,expectedVersion:state.version,idempotencyKey:randomUUID()})
  }
  afterEach(async()=>{
    if(runner&&(await new LoyaltyOperationalControlService(runner,new NormalizedCommandExecutor(runner)).list(staff())).some(v=>v.capability==='points_accrual'&&v.state==='paused'))await pause('resume')
  })
  it.each(['worker','supplement','race'] as const)('recovers historical compensation once after first legitimate settlement: %s',async mode=>{
    await pause('pause');const f=await fixture(false,1600)
    await stop(f,1);await compensate(f,100);await authorize(f);await collect(f)
    expect(await rewards(f)).toMatchObject({awards:0,deferred:1,available_points:0})
    await pause('resume')
    const worker=new LoyaltyAccrualDeferredWorker(runner)
    if(mode==='worker')await worker.runBatch(scope,'settled-consumption-worker')
    else{
      const service=customers(),request=await service.requestLoyaltySupplement(staff(requester),{orderPublicId:f.order,reason:'独立核对原商品与补偿',idempotencyKey:randomUUID()})
      const decision={publicId:request.value.publicId,decision:'approve' as const,reason:'复核原退款后补发',idempotencyKey:randomUUID()}
      await expect(service.decideLoyaltySupplement(staff(requester),decision)).rejects.toThrow()
      if(mode==='race'){
        const blocker=await pool.connect();await blocker.query('BEGIN');await blocker.query('SELECT id FROM mbox.orders WHERE id=$1 FOR UPDATE',[f.order])
        let waiters=0
        const competing=Promise.all([service.decideLoyaltySupplement(staff(),decision),worker.runBatch(scope,'settled-consumption-race')])
        try{for(let i=0;i<100&&waiters<2;i++){waiters=(await pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'")).rows[0].n;if(waiters<2)await new Promise(resolve=>setTimeout(resolve,10))}}
        finally{await blocker.query('COMMIT');blocker.release()}
        await competing;expect(waiters).toBeGreaterThanOrEqual(2)
      }else expect((await service.decideLoyaltySupplement(staff(),decision)).value).toMatchObject({pointsDelta:31,growthDelta:31})
      expect((await service.decideLoyaltySupplement(staff(),decision)).replayed).toBe(true)
    }
    await worker.runBatch(scope,'settled-consumption-repeat')
    expect(await rewards(f)).toMatchObject({available_points:31,growth_value:31,awards:1,recommendation_net:3100})
  })
  it('keeps frozen mixed item eligibility and does not award excluded merchandise',async()=>{
    const f=await fixture(false,1600,undefined,false,800);await stop(f,1);await compensate(f,100);await authorize(f);await collect(f)
    expect(await rewards(f)).toMatchObject({available_points:23,growth_value:23,awards:1,recommendation_net:2300})
    await compensate(f,100)
    expect(await rewards(f)).toMatchObject({available_points:22,growth_value:22,awards:1,recommendation_net:2200})
  })
  it('retains normal refunded-then-repaid reward policy without double reversing an earlier ordinary refund',async()=>{
    const f=await fixture(false,1600);await compensate(f,800,'price_adjustment');await authorize(f);await collect(f)
    expect(await rewards(f)).toMatchObject({available_points:40,growth_value:40,awards:1})
    expect(await summary(f.order)).toMatchObject({due:0,net:4000})
  })

  it.each(['partial','pending','expired'] as const)('keeps the confirmed ordinary recollection debt after payment permission becomes %s',async mode=>{
    const f=await fixture();await compensate(f,2000,'price_adjustment')
    expect(await summary(f.order)).toMatchObject({due:0,net:2000})
    const before=Number((await daySummary()).outstandingMinor)
    const authorization=(await authorize(f)).value
    expect(authorization.amountMinor).toBe(2000)
    if(mode==='partial')await collect(f,1000,[f.order])
    else if(mode==='pending'){
      const pending=(await money.initiate({...metadata(),orderId:f.order,publicId:randomUUID(),provider:'postar',method:'native_qr',principal:{type:'employee',employeeId:cashier}})).value
      expect(pending.status).toBe('pending')
      expect((await pool.query("SELECT count(*)::int n FROM mbox.reconciliation_entries WHERE payment_id=$1 AND entry_type='payment'",[pending.id])).rows[0].n).toBe(0)
    }else await pool.query("UPDATE mbox.order_recollection_authorizations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[authorization.id])
    const expected=mode==='partial'?1000:2000
    expect(await summary(f.order)).toMatchObject({due:expected,net:4000-expected})
    expect((await cashierView(f.order))?.outstandingAmountMinor).toBe(expected)
    expect((await closure(f.session)).outstandingAmountMinor).toBe(expected)
    expect((await guestView(f.session))[0].payableAmountMinor).toBe(0)
    expect(await due(f.session)).toEqual([])
    expect(await status(f.order)).toBe('partially_refunded')
    expect(await runner.run(scope,tx=>readBusinessDayBlockerFacts(tx,f.session,'ORDER_UNSETTLED'))).toEqual(expect.arrayContaining([expect.objectContaining({orderId:f.order,amountMinor:expected})]))
    expect((await runner.run(scope,tx=>tx.query<{needs:boolean}>(`SELECT ${orderNeedsCollectionSql('ordering')} AS needs FROM mbox.orders ordering WHERE id=$1`,[f.order]))).rows[0].needs).toBe(true)
    expect(Number((await daySummary()).outstandingMinor)-before).toBe(expected)
    await deliver(f,5)
    await expect(closeSession(f.session)).rejects.toThrow()
    if(mode!=='pending'){
      expect((await authorize(f)).value.amountMinor).toBe(expected);await collect(f)
      expect(await summary(f.order)).toMatchObject({due:0,net:4000})
      await closeSession(f.session)
      expect((await bill(f.session)).title).toBe('结账单')
    }
  })
  it('does not extend an old authorization to later ordinary refunds and rejects cross-order obligation facts',async()=>{
    const a=await fixture();await compensate(a,1000,'price_adjustment');const auth=(await authorize(a)).value;await collect(a)
    const b=await fixture();await compensate(b,1000,'price_adjustment')
    const otherRefund=(await pool.query("SELECT id FROM mbox.refunds WHERE order_id=$1 AND status='succeeded'",[b.order])).rows[0].id
    await expect(runner.run(scope,tx=>tx.query('INSERT INTO mbox.order_recollection_refund_obligations(tenant_id,store_id,order_id,refund_id,authorization_id) VALUES($1,$2,$3,$4,$5)',[scope.tenantId,scope.storeId,b.order,otherRefund,auth.id]))).rejects.toMatchObject({code:'23503'})
    await expect(runner.run(scope,tx=>tx.query('UPDATE mbox.order_recollection_authorizations SET order_id=$2 WHERE id=$1',[auth.id,b.order]))).rejects.toMatchObject({code:'23503'})
    await compensate(a,500,'price_adjustment')
    expect(await summary(a.order)).toMatchObject({due:0,net:3500})
    expect((await pool.query('SELECT count(*)::int n FROM mbox.order_recollection_refund_obligations WHERE order_id=$1',[a.order])).rows[0].n).toBe(1)
    expect((await authorize(a)).value.amountMinor).toBe(500)
    expect(await summary(a.order)).toMatchObject({due:500,net:3500})
    await collect(a);expect(await summary(a.order)).toMatchObject({due:0,net:4000})
    await expect(runner.run(scope,tx=>tx.query('DELETE FROM mbox.order_recollection_refund_obligations WHERE order_id=$1',[a.order]))).rejects.toMatchObject({code:'42501'})
  })
})
