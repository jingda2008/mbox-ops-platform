import {PaymentFulfillmentRepository} from './payment-fulfillment-repository.js'
import {LoyaltyAccrualRepository} from './loyalty-accrual-repository.js'
import {ItemAfterSalesCommandService} from './item-after-sales-command-service.js'
import {ItemAfterSalesOperatingEffects} from './item-after-sales-operating-effects.js'
import {TableManagementRepository} from './table-management-repository.js'
import {PostgresTableCustomerLeftTurnoverRepository} from './table-customer-left-turnover-repository.js'
import Fastify from 'fastify'
import {NormalizedCommandExecutor} from './command-executor.js'
import {PaymentCommandService} from './payment-command-service.js'
import {CommerceCommandService} from './commerce-command-service.js'
import {NormalizedPaymentCapabilityAuthorization} from './payment-security-policy.js'
import {VerifiedProviderObservationService,NormalizedProviderObservationAuthority} from './provider-verification-observation.js'
import {seedActiveGuestTableAuthority} from './guest-table-authority.test-helper.js'
import {guestCommerceServiceApiPlugin} from './guest-commerce-service-api.js'
import {GuestSharedCartRepository} from './guest-shared-cart-repository.js'
import {RefundRepository} from './refund-repository.js'
import {randomUUID} from 'node:crypto'
import {beforeAll,afterAll,describe,it,expect} from 'vitest'
import {Pool} from 'pg'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {TablePrepaymentRepository} from './table-prepayment-repository.js'
import {PaymentRepository} from './payment-repository.js'
import {OrderRepository} from './order-repository.js'
import {readTableMinimumSpend} from './table-minimum-spend.js'
import {ScopedPostgresTransactionRunner,type PostgresPool} from './transaction-runner.js'
const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const integration=databaseUrl?describe:describe.skip
integration('table prepayment PostgreSQL authority',()=>{
 const customerId=randomUUID(),tenantId=randomUUID(),storeId=randomUUID(),areaId=randomUUID(),tableId=randomUUID(),tableSessionId=randomUUID(),managerId=randomUUID(),salespersonId=randomUUID(),productId=randomUUID(),missingCostProductId=randomUUID()
 let pool:Pool,runtimePool:Pool, transactions:ScopedPostgresTransactionRunner,actorRef:string
 beforeAll(async()=>{await runNormalizedMigrations(databaseUrl!);pool=new Pool({connectionString:databaseUrl});runtimePool=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL?new Pool({connectionString:process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL}):pool;transactions=new ScopedPostgresTransactionRunner(runtimePool as unknown as PostgresPool);await seed();actorRef=await seedActiveGuestTableAuthority(pool,{tenantId,storeId,tableSessionId,customerId})})
 afterAll(async()=>{if(runtimePool&&runtimePool!==pool)await runtimePool.end();await pool?.end()})
 const run=<T>(fn:(tx:Parameters<Parameters<typeof transactions.run>[1]>[0])=>Promise<T>)=>transactions.run({tenantId,storeId},fn)
 const order=()=>run(tx=>new OrderRepository(tx).createSubmitted({tableSessionId,publicId:randomUUID(),channel:'staff_assisted',createdByEmployeeId:managerId,lines:[{productId,quantity:1}]}))
 it('does not accept orders before prepayment and keeps rejected inserts atomic',async()=>{
   await expect(order()).rejects.toMatchObject({code:'TABLE_PREPAYMENT_REQUIRED'})
   expect(Number((await pool.query('SELECT count(*) n FROM mbox.orders WHERE tenant_id=$1',[tenantId])).rows[0].n)).toBe(0)
 })
 it('records independent prepayment and handles duplicate callbacks once',async()=>{
   const executor=new NormalizedCommandExecutor(transactions),app=Fastify()
   await app.register(guestCommerceServiceApiPlugin,{prefix:'/api',paymentActionSecret:'isolated-prepayment-action-secret-20261031',transactions,commandExecutor:executor,commerce:new CommerceCommandService(executor),payments:paymentService(),onlinePayments:{assertAvailable:()=>{},assertGuestJsapiReady:async()=> 'jsapi',create:async({paymentId}:{paymentId:string})=>({status:'pending',paymentId,payableKind:'table_prepayment',payload:{presentation:'jsapi'}})} as never,paymentMode:'wechat_jsapi',resolveGuestContext:()=>({scope:{tenantId,storeId},sessionKind:'table',customerId,tableSessionId,reservationId:null,tableCode:'COST1',tableDisplayName:'测试桌',businessDate:'2026-10-31',expiresAt:new Date(Date.now()+60000).toISOString(),capabilities:['guest.order.create','guest.session.read','guest.menu.read','guest.service.create'],actorRef})})
   let publicId:string
   try{
    const request={method:'POST' as const,url:'/api/guest/table-prepayment',headers:{'idempotency-key':randomUUID()},payload:{amountMinor:20000,sharedTableConsent:'v1'}}
    const denied=await app.inject({...request,payload:{amountMinor:20000}});expect(denied.statusCode).toBe(409)
    const first=await app.inject(request);expect(first.statusCode,first.body).toBe(200)
    const repeated=await app.inject(request);expect(repeated.statusCode,repeated.body).toBe(200);expect(repeated.json().data.paymentId).toBe(first.json().data.paymentId)
    const resumed=await app.inject({...request,headers:{'idempotency-key':randomUUID()},payload:{amountMinor:30000,sharedTableConsent:'v1'}});expect(resumed.statusCode,resumed.body).toBe(200);expect(resumed.json().data.paymentId).toBe(first.json().data.paymentId)
    const rows=(await pool.query('SELECT public_id,amount_minor::int FROM mbox.payments WHERE prepaid_table_session_id=$1',[tableSessionId])).rows;expect(rows).toHaveLength(1);expect(rows[0].amount_minor).toBe(20000);publicId=rows[0].public_id
   }finally{await app.close()}
   await capture(publicId!,20000)
   const record=(await pool.query('SELECT count(*) n FROM mbox.reconciliation_entries WHERE tenant_id=$1',[tenantId])).rows[0]
   expect(Number(record.n)).toBe(1)
   expect(await run(tx=>new TablePrepaymentRepository(tx).snapshot(tableSessionId,customerId))).toMatchObject({availableMinor:20000,receivedMinor:20000,qualifyingGoodsMinor:0,shortfallMinor:10000,differenceChargingEnabled:false})
 })
 it('allows incremental orders below minimum; allocates original receipt without extra cash',async()=>{
   await order()
   expect(await run(tx=>new TablePrepaymentRepository(tx).snapshot(tableSessionId,customerId))).toMatchObject({availableMinor:11200,qualifyingGoodsMinor:8800,shortfallMinor:1200})
   expect(Number((await pool.query('SELECT sum(amount_minor) amount FROM mbox.payments WHERE tenant_id=$1',[tenantId])).rows[0].amount)).toBe(20000)
 })
 it('does not charge or silently return shortfall on settlement',async()=>{
   await expect(run(tx=>new TablePrepaymentRepository(tx).requestUnusedRefunds(tableSessionId,managerId,'结束结算'))).rejects.toMatchObject({code:'TABLE_MINIMUM_REVIEW_REQUIRED'})
 })
 it('reserves funds atomically when two guests submit concurrently',async()=>{
   const results=await Promise.allSettled([order(),order()])
   expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
   expect(results.filter(r=>r.status==='rejected')).toHaveLength(1)
   expect((results.find(r=>r.status==='rejected') as PromiseRejectedResult).reason.code).toBe('TABLE_PREPAYMENT_INSUFFICIENT')
   expect(await run(tx=>new TablePrepaymentRepository(tx).snapshot(tableSessionId))).toMatchObject({availableMinor:2400,qualifyingGoodsMinor:17600,shortfallMinor:0})
 })
 it('requests surplus against original payment, and repeat settlement cannot reserve it twice',async()=>{
   const result=await run(tx=>new TablePrepaymentRepository(tx).requestUnusedRefunds(tableSessionId,managerId,'优惠后剩余余额退回'))
   expect(result.amountMinor).toBe(2400);expect(result.refundIds).toHaveLength(1)
   expect((await run(tx=>new TablePrepaymentRepository(tx).requestUnusedRefunds(tableSessionId,managerId,'重复结算'))).refundIds).toEqual([])
   expect(await run(tx=>new TablePrepaymentRepository(tx).snapshot(tableSessionId))).toMatchObject({availableMinor:0})
 })
 it('keeps pending refund as a closure blocker',async()=>{
   expect((await run(tx=>tx.query<{blocked:boolean}>('SELECT mbox.table_prepayment_unsettled($1,$2,$3) blocked',[tenantId,storeId,tableSessionId]))).rows[0]?.blocked).toBe(true)
 })
 it('enforces a separate refund reviewer and original provider identity',async()=>{
   const refund=(await pool.query('SELECT id,public_id,amount_minor,payment_id FROM mbox.refunds WHERE tenant_id=$1',[tenantId])).rows[0]
   await expect(run(tx=>new RefundRepository(tx).approve(refund.id,managerId,'本人审核'))).rejects.toThrow()
   await run(tx=>new RefundRepository(tx).approve(refund.id,salespersonId,'核实原支付和剩余金额'))
   await run(tx=>new RefundRepository(tx).beginExecution(refund.id))
   const payment=(await pool.query('SELECT provider_transaction_id FROM mbox.payments WHERE id=$1',[refund.payment_id])).rows[0]
   await expect(run(tx=>new RefundRepository(tx).completeProviderExecution({refundPublicId:refund.public_id,provider:'postar',providerRefundId:randomUUID(),originalProviderTransactionId:'wrong-original-reference',reportedAmountMinor:2400,reportedCurrency:'CNY',succeeded:true}))).rejects.toThrow()
   const scope={tenantId,storeId},providerRefundId=randomUUID(),occurredAt=new Date().toISOString(),integrationRef='postar-fixture-refund'
   const observed=await new VerifiedProviderObservationService(transactions).recordRefund({scope,provider:'postar',verificationKind:'callback_signature',providerEventId:randomUUID(),integrationRef,refundPublicId:refund.public_id,providerTransactionId:providerRefundId,originalProviderTransactionId:payment.provider_transaction_id,reportedAmountMinor:2400,reportedCurrency:'CNY',status:'succeeded',occurredAt})
   const command={scope,actor:{type:'integration' as const,ref:integrationRef},businessDate:'2026-10-31',idempotencyKey:randomUUID(),requestFingerprint:randomUUID(),verifiedObservationId:observed,refundPublicId:refund.public_id,provider:'postar' as const,providerRefundId,originalProviderTransactionId:payment.provider_transaction_id,reportedAmountMinor:2400,reportedCurrency:'CNY',succeeded:true,occurredAt}
   const service=paymentService();expect((await service.recordProviderRefundResult(command)).value.status).toBe('succeeded');expect((await service.recordProviderRefundResult(command)).replayed).toBe(true)
   expect(Number((await pool.query('SELECT sum(amount_minor) amount FROM mbox.reconciliation_entries WHERE tenant_id=$1',[tenantId])).rows[0].amount)).toBe(17600)
 })
 it('records waiver instead of charging a fee and rejects out-of-range waivers',async()=>{
   await expect(run(tx=>new TablePrepaymentRepository(tx).waive(tableSessionId,managerId,10001,'超额减免'))).rejects.toMatchObject({code:'TABLE_MINIMUM_WAIVER_INVALID'})
   await run(tx=>new TablePrepaymentRepository(tx).waive(tableSessionId,managerId,1000,'门店原因部分无法履约'))
   expect(await run(tx=>new TablePrepaymentRepository(tx).snapshot(tableSessionId))).toMatchObject({waiverMinor:1000,qualifyingGoodsMinor:17600,differenceChargingEnabled:false})
   expect(Number((await pool.query('SELECT sum(amount_minor) amount FROM mbox.payments WHERE tenant_id=$1',[tenantId])).rows[0].amount)).toBe(20000)
 })
 it('isolates store scopes, and disallows spending another payer funds without authority',async()=>{
   await expect(transactions.run({tenantId,storeId:randomUUID()},tx=>new TablePrepaymentRepository(tx).snapshot(tableSessionId))).rejects.toMatchObject({code:'TABLE_PREPAYMENT_SESSION_CLOSED'})
   const source=(await pool.query('SELECT id FROM mbox.payments WHERE tenant_id=$1',[tenantId])).rows[0]
   await expect(run(tx=>new TablePrepaymentRepository(tx).revoke(tableSessionId,randomUUID(),source.id))).rejects.toMatchObject({code:'TABLE_PREPAYMENT_OWNER_REQUIRED'})
 })
 it('revokes future sharing without moving or rewriting past allocations',async()=>{
   const source=(await pool.query('SELECT id FROM mbox.payments WHERE tenant_id=$1',[tenantId])).rows[0]
   await run(tx=>new TablePrepaymentRepository(tx).revoke(tableSessionId,customerId,source.id))
   await run(tx=>new TablePrepaymentRepository(tx).revoke(tableSessionId,customerId,source.id))
   expect(Number((await pool.query('SELECT sum(amount_minor) amount FROM mbox.table_prepayment_allocations WHERE tenant_id=$1',[tenantId])).rows[0].amount)).toBe(17600)
   expect((await run(tx=>new TablePrepaymentRepository(tx).snapshot(tableSessionId,customerId)))?.mySharedReceipts).toEqual([])
 })
 it('completes a real shared-cart transaction against prepaid balance and replays it once',async()=>{
   const source=await run(tx=>new PaymentRepository(tx).createForTablePrepayment({tableSessionId,customerId,publicId:randomUUID(),amountMinor:10000,provider:'postar',method:'jsapi'}))
   await capture(source.publicId,10000)
   const executor=new NormalizedCommandExecutor(transactions),commerce=new CommerceCommandService(executor)
   const app=Fastify();await app.register(guestCommerceServiceApiPlugin,{prefix:'/api',paymentActionSecret:'isolated-prepayment-action-secret-20261031',transactions,commandExecutor:executor,commerce,payments:paymentService(),onlinePayments:{} as never,paymentMode:'wechat_jsapi',resolveGuestContext:()=>({scope:{tenantId,storeId},sessionKind:'table',customerId,tableSessionId,reservationId:null,tableCode:'COST1',tableDisplayName:'测试桌',businessDate:'2026-10-31',expiresAt:new Date(Date.now()+60000).toISOString(),capabilities:['guest.order.create','guest.session.read','guest.menu.read','guest.service.create'],actorRef})})
   try{
     const cart=await run(async tx=>{const repo=new GuestSharedCartRepository(tx,customerId),current=await repo.readOpen(tableSessionId,`GSC${randomUUID().replace(/-/g,'').toUpperCase()}`);return repo.adjust(tableSessionId,current.publicId,{productId,delta:1,expectedGeneration:current.generation,expectedVersion:current.version,operationId:randomUUID(),actorSessionRef:actorRef})})
     const request={method:'POST' as const,url:'/api/guest/shared-cart/prepayment-settlement',headers:{'idempotency-key':randomUUID()},payload:{expectedGeneration:cart.generation,expectedVersion:cart.version,note:'少冰'}}
     const first=await app.inject(request);expect(first.statusCode,first.body).toBe(201);expect(first.json().data).toMatchObject({prepaymentSettlement:true,payment:null,order:{paymentStatus:'paid'},settlement:{payableAmountMinor:8800}})
     const second=await app.inject(request);expect(second.statusCode,second.body).toBe(200);expect(second.json().data.order.publicId).toBe(first.json().data.order.publicId)
     expect(await run(tx=>new TablePrepaymentRepository(tx).snapshot(tableSessionId))).toMatchObject({availableMinor:1200,qualifyingGoodsMinor:26400})
     expect((await pool.query('SELECT awarded_points FROM mbox.loyalty_order_awards WHERE tenant_id=$1',[tenantId])).rows).toEqual([{awarded_points:88}])
   }finally{await app.close()}
 })
 it('splits an item return over two original prepayment sources without restoring spent wallet credit',async()=>{
   const secondCustomer=randomUUID()
   await pool.query('INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1,$2,$3,$4)',[secondCustomer,tenantId,storeId,randomUUID()])
   const source=await run(tx=>new PaymentRepository(tx).createForTablePrepayment({tableSessionId,customerId:secondCustomer,publicId:randomUUID(),amountMinor:10000,provider:'postar',method:'jsapi'}));await capture(source.publicId,10000)
   const submitted=await run(async tx=>{const row=await new OrderRepository(tx).createSubmitted({tableSessionId,publicId:randomUUID(),channel:'guest_qr',createdByCustomerId:customerId,prepaymentSettlement:true,settlementMode:'immediate_payment',lines:[{productId,quantity:1}]});const fulfillment=new PaymentFulfillmentRepository(tx);await fulfillment.prepareSubmittedOrder(row,{priorityByOrderItemId:new Map(row.items.map(item=>[item.id,0])),dueAtByOrderItemId:new Map(row.items.map(item=>[item.id,null]))});const funding=await new TablePrepaymentRepository(tx).allocate(tableSessionId,row.id);expect((await fulfillment.activatePaidOrder(row.id,{paymentId:funding.paymentIds[0]})).activated).toBe(true);return row})
   const rewardPayment=(await pool.query('SELECT payment_id FROM mbox.table_prepayment_allocations WHERE order_id=$1 ORDER BY payment_id LIMIT 1',[submitted.id])).rows[0].payment_id
   expect(await run(tx=>new LoyaltyAccrualRepository(tx).recordPaidOrder({orderId:submitted.id,paymentId:rewardPayment,occurredAt:new Date().toISOString()}))).toMatchObject({applied:true,pointsDelta:88})
   const item=(await pool.query('SELECT id FROM mbox.order_items WHERE order_id=$1',[submitted.id])).rows[0].id
   const allocated=(await pool.query('SELECT payment_id,amount_minor::int FROM mbox.table_prepayment_allocations WHERE order_id=$1 ORDER BY payment_id',[submitted.id])).rows
   expect(allocated.map(r=>r.amount_minor).sort((a,b)=>a-b)).toEqual([1200,7600])
   const afterSales=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(transactions),new ItemAfterSalesOperatingEffects())
   const businessDate=(await run(tx=>tx.query<{date:string}>('SELECT mbox.current_operating_business_date($1,$2)::text date',[tenantId,storeId]))).rows[0]!.date
   const request=(await afterSales.request({scope:{tenantId,storeId},employeeId:managerId,businessDate,orderItemId:item,quantity:1,reason:'按原渠道退回未消费商品',idempotencyKey:randomUUID()})).value
   expect(request.refunds).toHaveLength(2)
   await expect(run(tx=>new TablePrepaymentRepository(tx).requestUnusedRefunds(tableSessionId,managerId,'退菜尚未确认不能提前结余'))).rejects.toMatchObject({code:'TABLE_PREPAYMENT_PENDING'})
   await afterSales.decide({scope:{tenantId,storeId},employeeId:salespersonId,businessDate,caseId:request.caseId,decision:'approved',reason:'逐笔核对原付款人和原份额',idempotencyKey:randomUUID()})
   const refunds=(await pool.query('SELECT payment_id,amount_minor::int FROM mbox.refunds WHERE id=ANY($1::uuid[]) ORDER BY payment_id',[request.refunds.map(r=>r.id)])).rows
   expect(refunds).toEqual(allocated)
   for(const returned of request.refunds){
     const original=(await pool.query('SELECT r.public_id,p.provider_transaction_id,r.amount_minor::int amount FROM mbox.refunds r JOIN mbox.payments p ON p.id=r.payment_id WHERE r.id=$1',[returned.id])).rows[0]
     await run(tx=>new RefundRepository(tx).beginExecution(returned.id))
     const scope={tenantId,storeId},providerRefundId=randomUUID(),occurredAt=new Date().toISOString(),integrationRef='postar-fixture-prepaid-goods'
     const observed=await new VerifiedProviderObservationService(transactions).recordRefund({scope,provider:'postar',verificationKind:'callback_signature',providerEventId:randomUUID(),integrationRef,refundPublicId:original.public_id,providerTransactionId:providerRefundId,originalProviderTransactionId:original.provider_transaction_id,reportedAmountMinor:original.amount,reportedCurrency:'CNY',status:'succeeded',occurredAt})
     const command={scope,actor:{type:'integration' as const,ref:integrationRef},businessDate,idempotencyKey:randomUUID(),requestFingerprint:randomUUID(),verifiedObservationId:observed,refundPublicId:original.public_id,provider:'postar' as const,providerRefundId,originalProviderTransactionId:original.provider_transaction_id,reportedAmountMinor:original.amount,reportedCurrency:'CNY',succeeded:true,occurredAt}
     expect((await paymentService().recordProviderRefundResult(command)).value.status).toBe('succeeded')
     expect((await paymentService().recordProviderRefundResult(command)).replayed).toBe(true)
   }
   expect((await pool.query('SELECT awarded_points,reversed_points FROM mbox.loyalty_order_awards WHERE order_id=$1',[submitted.id])).rows[0]).toEqual({awarded_points:88,reversed_points:88})

   expect(await run(tx=>new TablePrepaymentRepository(tx).snapshot(tableSessionId))).toMatchObject({availableMinor:2400,qualifyingGoodsMinor:26400})
 })
 it('moves the same session to another table while retaining its minimum, original funds and allocations',async()=>{
   const target=randomUUID();await pool.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity,minimum_spend_minor) VALUES($1,$2,$3,$4,$5,'新桌',4,99999)",[target,tenantId,storeId,areaId,'T'+target.slice(0,8)])
   const before=await run(tx=>new TablePrepaymentRepository(tx).snapshot(tableSessionId))
   const input={tableSessionId,targetTableId:target,transferredByEmployeeId:managerId,reason:'顾客整桌移位',idempotencyKey:randomUUID(),requestFingerprint:randomUUID()}
   const moved=await run(tx=>new TableManagementRepository(tx).transfer(input,{capture:async()=>({})}))
   expect(moved.tableSessionId).toBe(tableSessionId)
   expect(await run(tx=>new TablePrepaymentRepository(tx).snapshot(tableSessionId))).toEqual(before)
   expect((await pool.query('SELECT table_id,minimum_spend_minor::int,minimum_spend_mode FROM mbox.table_sessions WHERE id=$1',[tableSessionId])).rows[0]).toEqual({table_id:target,minimum_spend_minor:10000,minimum_spend_mode:'prepaid'})
 })
 it('physically turns over a table with unresolved prepayment, preserves late capture on the old session and starts clean',async()=>{
   const table=randomUUID(),session=randomUUID()
   const businessDate=(await run(tx=>tx.query<{date:string}>('SELECT mbox.current_operating_business_date($1,$2)::text date',[tenantId,storeId]))).rows[0]!.date
   await pool.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,$5,'待核对桌',4)",[table,tenantId,storeId,areaId,'T'+table.slice(0,8)])
   await pool.query("INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count,minimum_spend_mode,minimum_spend_minor) VALUES($1,$2,$3,$4,$5,$6,2,'prepaid',5000)",[session,tenantId,storeId,table,randomUUID(),businessDate])
   const payment=await run(tx=>new PaymentRepository(tx).createForTablePrepayment({tableSessionId:session,customerId,publicId:randomUUID(),amountMinor:5000,provider:'postar',method:'jsapi'}))
   const input={scope:{tenantId,storeId},tableSessionId:session,employeeId:managerId,businessDate,reasonNote:'顾客已离场，原预付款留待核对',idempotencyKey:randomUUID()}
   expect(await run(tx=>new PostgresTableCustomerLeftTurnoverRepository(tx).close(input))).toMatchObject({pendingPaymentCount:1,replayed:false})
   expect(await run(tx=>new PostgresTableCustomerLeftTurnoverRepository(tx).close(input))).toMatchObject({replayed:true})
   await capture(payment.publicId,5000)
   expect(await run(tx=>new TablePrepaymentRepository(tx).snapshot(session))).toMatchObject({availableMinor:5000,shortfallMinor:5000})
   const next=await run(tx=>new TableManagementRepository(tx).open({tableId:table,publicId:randomUUID(),businessDate,guestCount:2,openedByEmployeeId:managerId,primaryServiceEmployeeId:managerId,minimumSpendMode:'prepaid',minimumSpendMinor:6000}))
   expect(await run(tx=>new TablePrepaymentRepository(tx).snapshot(next.id))).toMatchObject({receivedMinor:0,availableMinor:0,minimumMinor:6000})
   await run(tx=>new TablePrepaymentRepository(tx).waive(session,managerId,5000,'门店批准退回未消费款'))
   expect(await run(tx=>new TablePrepaymentRepository(tx).requestUnusedRefunds(session,managerId,'原付款人未消费退款'))).toMatchObject({amountMinor:5000,differenceChargingEnabled:false})
 })
 it('keeps original payer authority after a customer merge without rewriting the payment source',async()=>{
   const original=randomUUID(),canonical=randomUUID()
   for(const id of [original,canonical])await pool.query('INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1,$2,$3,$4)',[id,tenantId,storeId,randomUUID()])
   const payment=await run(tx=>new PaymentRepository(tx).createForTablePrepayment({tableSessionId,customerId:original,publicId:randomUUID(),amountMinor:100,provider:'postar',method:'jsapi'}))
   await pool.query("UPDATE mbox.customers SET status='merged',merged_into_customer_id=$2 WHERE id=$1",[original,canonical])
   expect((await run(tx=>new TablePrepaymentRepository(tx).snapshot(tableSessionId,canonical)))?.mySharedReceipts.map(r=>r.id)).toContain(payment.id)
   await run(tx=>new TablePrepaymentRepository(tx).revoke(tableSessionId,canonical,payment.id))
   expect((await pool.query('SELECT prepaid_customer_id FROM mbox.payments WHERE id=$1',[payment.id])).rows[0].prepaid_customer_id).toBe(original)
 })
 function paymentService(){return new PaymentCommandService(new NormalizedCommandExecutor(transactions),new NormalizedPaymentCapabilityAuthorization(),new NormalizedProviderObservationAuthority())}
 async function capture(publicId:string,amount:number){
   const scope={tenantId,storeId},integrationRef='postar-fixture-callback',providerTransactionId=randomUUID(),occurredAt=new Date().toISOString()
   const observation=await new VerifiedProviderObservationService(transactions).recordPayment({scope,provider:'postar',verificationKind:'callback_signature',providerEventId:randomUUID(),integrationRef,paymentPublicId:publicId,providerTransactionId,reportedAmountMinor:amount,reportedCurrency:'CNY',status:'succeeded',occurredAt})
   const command={scope,actor:{type:'integration' as const,ref:integrationRef},businessDate:'2026-10-31',idempotencyKey:randomUUID(),requestFingerprint:randomUUID(),verifiedObservationId:observation,paymentPublicId:publicId,provider:'postar' as const,providerTransactionId,reportedAmountMinor:amount,reportedCurrency:'CNY',occurredAt}
   const service=paymentService();expect((await service.recordSucceededCallback(command)).value.status).toBe('succeeded');expect((await service.recordSucceededCallback(command)).replayed).toBe(true)
 }
  async function seed() {
    await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Cost Authority Tenant')`,
      [tenantId, `cost-${tenantId.slice(0, 8)}`])
    await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name)
      VALUES($1,$2,$3,'Cost Authority Store')`, [storeId, tenantId, `cost-${storeId.slice(0, 8)}`])
    await pool.query(`INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1,$2,$3,$4)`,[customerId,tenantId,storeId,randomUUID()])
    await pool.query(`INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type)
      VALUES($1,$2,$3,'COST','Cost Area','indoor')`, [areaId, tenantId, storeId])
    await pool.query(`INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity)
      VALUES($1,$2,$3,$4,'COST1','Cost Table',4)`, [tableId, tenantId, storeId, areaId])
    await pool.query(`INSERT INTO mbox.table_sessions(
      id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status,minimum_spend_mode,minimum_spend_minor
    ) VALUES($1,$2,$3,$4,'cost-session-0001','2026-08-16',2,'open','prepaid',10000)`,
    [tableSessionId, tenantId, storeId, tableId])
    await pool.query('UPDATE mbox.table_sessions SET guest_cart_protocol_version=2 WHERE id=$1',[tableSessionId])
    await pool.query(`INSERT INTO mbox.table_session_customers(tenant_id,store_id,table_session_id,customer_id,relationship) VALUES($1,$2,$3,$4,'primary')`,[tenantId,storeId,tableSessionId,customerId])
    await pool.query(`INSERT INTO mbox.employees(
      id,tenant_id,store_id,employee_code,display_name
    ) VALUES($1,$3,$4,'COST_MANAGER','Cost Manager'),($2,$3,$4,'COST_SALES','Cost Sales')`,
    [managerId, salespersonId, tenantId, storeId])
    for(const employee of [managerId,salespersonId]){
      const role=randomUUID();await pool.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,$4,'测试岗位')",[role,tenantId,storeId,'R_'+role.replaceAll('-','').toUpperCase()])
      await pool.query('INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id) VALUES($1,$2,$3,$4)',[tenantId,storeId,employee,role])
      for(const code of ['refund.request','refund.approve','refund.execute','table.view_all','table.close','table.turnover_unsettled','table.open','table.transfer']){
        const permission=(await pool.query("INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category) VALUES($1,$2,$3,$3,'operations') ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET name=EXCLUDED.name RETURNING id",[tenantId,storeId,code])).rows[0].id
        await pool.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[tenantId,storeId,role,permission])
      }
      await pool.query("INSERT INTO mbox.role_approval_limits(tenant_id,store_id,role_id,approval_code,amount_minor,currency) VALUES($1,$2,$3,'refund.approve',100000,'CNY')",[tenantId,storeId,role])
    }
    const policy=randomUUID(),membership=randomUUID(),publisher=randomUUID()
    await pool.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,'LOYALTY_PUBLISHER','政策发布')",[publisher,tenantId,storeId])
    await pool.query("INSERT INTO mbox.customer_memberships(id,tenant_id,store_id,customer_id,member_no,level,status) VALUES($1,$2,$3,$4,$5,'member','active')",[membership,tenantId,storeId,customerId,'MBX'+membership.replaceAll('-','').slice(0,12).toUpperCase()])
    await pool.query('INSERT INTO mbox.loyalty_accounts(tenant_id,store_id,membership_id,customer_id) VALUES($1,$2,$3,$4)',[tenantId,storeId,membership,customerId])
    await pool.query(`INSERT INTO mbox.loyalty_policy_versions(id,tenant_id,store_id,policy_code,version,status,points_numerator,points_denominator_minor,growth_numerator,growth_denominator_minor,rounding_mode,points_validity_months,effective_from,drafted_by_employee_id,approved_by_employee_id,approved_at,published_by_employee_id,published_at,publication_mode,reason)
      VALUES($1,$2,$3,'BASE',1,'published',1,100,1,100,'floor',18,'2020-01-01',$4,$5,'2020-01-01',$6,'2020-01-02','separated','预收商品权益原路回退测试')`,[policy,tenantId,storeId,managerId,salespersonId,publisher])
    await pool.query(`INSERT INTO mbox.products(
      id,tenant_id,store_id,code,name,category_code,fulfillment_station,
      product_snapshot,status,cost_amount_minor
    ) VALUES
      ($1,$3,$4,'COST-001','Strong Cost Product','test','none','{}','active',1050),
      ($2,$3,$4,'COST-MISSING','Missing Cost Product','test','none','{}','active',NULL)`,
    [productId, missingCostProductId, tenantId, storeId])
    await pool.query(`INSERT INTO mbox.product_prices(
      tenant_id,store_id,product_id,price_type,amount_minor,currency,valid_from
    ) VALUES
      ($1,$2,$3,'standard',8800,'CNY','2020-01-01T00:00:00Z'),
      ($1,$2,$4,'standard',6600,'CNY','2020-01-01T00:00:00Z')`,
    [tenantId, storeId, productId, missingCostProductId])
  }
})
