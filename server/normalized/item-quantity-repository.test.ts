import {readPackagedReturnEligibility} from './packaged-return-evidence.js'
import {RecollectionAuthorizationRepository} from './recollection-authorization-repository.js'
import {NormalizedKdsAuthorization} from './kds-authorization-policy.js'
import {QuantityRemakeCommandService} from './quantity-remake-command-service.js'
import {QuantityRemakeHandoverQuery,QuantityRemakeHandoverCommand} from './quantity-remake-handover.js'
import {QuantityRemakeFulfillmentRepository} from './quantity-remake-fulfillment-repository.js'
import {QuantityRemakeRepository} from './quantity-remake-repository.js'
import {OperationsQueryService} from './operations-query-service.js'
import {QuantityRedeliveryRepository} from './quantity-redelivery-repository.js'
import {ServiceTaskRepository} from './service-task-repository.js'
import {ItemAfterSalesReplacementRepository} from './item-after-sales-replacement-repository.js'
import {PostgresAutomaticTableTurnoverRepository} from './automatic-table-turnover-repository.js'
import {PostgresOrderCancellationRepository} from './order-cancellation-repository.js'
import {PostgresTableCustomerLeftTurnoverRepository} from './table-customer-left-turnover-repository.js'
import {tableManagementApiPlugin} from './table-management-api.js'
import {readTableSessionClosureState} from './table-session-closure-blockers.js'
import {readBusinessDayBlockerFacts} from './business-day-blocker-facts.js'
import {PostgresCashierWorkbenchQuery} from './cashier-workbench-query.js'
import {PaymentCommandService} from './payment-command-service.js'
import {NormalizedPaymentCapabilityAuthorization} from './payment-security-policy.js'
import {VerifiedProviderObservationService,NormalizedProviderObservationAuthority} from './provider-verification-observation.js'
import {listTablePaymentOrdersForSession,listTableOrderDetailsForSession} from './commerce-kds-api.js'
import Fastify from 'fastify'
import {itemAfterSalesApiPlugin} from './item-after-sales-api.js'
import {readOperatingHistory} from './operating-history-query.js'
import {executeQuantityKdsAction} from './quantity-kds-action.js'
import {DeliveryBatchRepository} from './delivery-batch-repository.js'
import {FulfillmentQueryService} from './fulfillment-query-service.js'
import {orderNeedsCollectionSql} from './order-collection-sql.js'
import {ItemAfterSalesOperatingEffects} from './item-after-sales-operating-effects.js'
import {PrintSourceWorker} from './print-source-worker.js'
import {PrintTicketSourceRepository} from './print-ticket-source.js'
import {appendOutboxMessage} from './command-executor.js'
import {ItemAfterSalesHandoverQuery} from './item-after-sales-handover-query.js'
import {ItemAfterSalesQuery} from './item-after-sales-query.js'
import {ItemAfterSalesCommandService} from './item-after-sales-command-service.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {ItemAfterSalesProgressRepository} from './item-after-sales-progress-repository.js'
import {RefundFulfillmentRepository} from './refund-fulfillment-repository.js'
import {PaymentRepository} from './payment-repository.js'
import {ItemQuantityRefundRepository} from './item-quantity-refund-repository.js'
import {RefundRepository} from './refund-repository.js'
import {ItemQuantityFulfillmentRepository} from './item-quantity-fulfillment-repository.js'
import {randomUUID} from 'node:crypto'
import {loadGuestTableOrders} from './guest-table-orders-query.js'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {Pool} from 'pg'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {ItemQuantityRepository} from './item-quantity-repository.js'
import {ItemQuantityReceivableRepository} from './item-quantity-receivable-repository.js'
import {ItemUnitInventoryRepository} from './item-unit-inventory-repository.js'
import {InventoryRepository} from './inventory-repository.js'

const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const integration=databaseUrl?describe:describe.skip
integration('quantity after-sales PostgreSQL candidate',()=>{
  let pool:Pool,runner:ScopedPostgresTransactionRunner
  let businessDate:string,nextBusinessDate:string
  const tenantId=randomUUID(),storeId=randomUUID(),areaId=randomUUID(),tableId=randomUUID(),sessionId=randomUUID(),productId=randomUUID(),employeeId=randomUUID(),reviewerId=randomUUID()
  const scope={tenantId,storeId}
  beforeAll(async()=>{
    await runNormalizedMigrations(databaseUrl!)
    pool=new Pool({connectionString:databaseUrl,max:8});runner=new ScopedPostgresTransactionRunner(pool)
    await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Quantity foundation')`,[tenantId,`q-${tenantId}`])
    await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name,timezone,business_day_cutoff) VALUES($1,$2,'q-store','Quantity store','Asia/Shanghai','06:00')`,[storeId,tenantId])
    // Use the same database business clock as the production guards; preserve next-day replays.
    const day = await runner.run(scope,async tx => (await tx.query<{today:string; tomorrow:string}>(`
      WITH day AS (SELECT mbox.current_operating_business_date($1::uuid,$2::uuid) AS value)
      SELECT value::text AS today,(value+1)::text AS tomorrow FROM day
    `,[tenantId,storeId])).rows[0]!,{readOnly:true})
    businessDate=day.today;nextBusinessDate=day.tomorrow
    await pool.query(`INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'Q','Q','indoor')`,[areaId,tenantId,storeId])
    await pool.query(`INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,'Q01','Q01',8)`,[tableId,tenantId,storeId,areaId])
    await pool.query(`INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1,$2,$3,$4,'quantity-session-001','${businessDate}',2)`,[sessionId,tenantId,storeId,tableId])
    for(const [id,code] of [[employeeId,'Q01'],[reviewerId,'Q02']])await pool.query(`INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,$4,$4)`,[id,tenantId,storeId,code])
    await pool.query(`INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station) VALUES($1,$2,$3,'Q-WATER','水','drink','bar')`,[productId,tenantId,storeId])
  })
  async function grantActor(id:string,codes:string[],limit:number|null=null){
    const roleId=randomUUID()
    await pool.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,$4,'Quantity actor')",[roleId,tenantId,storeId,`Q_${roleId.replaceAll('-','').toUpperCase()}`])
    // This fixture represents an already-active grant. PostgreSQL stores microseconds,
    // while the read-model authorization instant is a JavaScript millisecond.
    await pool.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 minute')",[tenantId,storeId,id,roleId])
    for(const code of codes){
      const permissionId=(await pool.query(`INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category) VALUES($1,$2,$3,$3,'operations') ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET name=EXCLUDED.name RETURNING id`,[tenantId,storeId,code])).rows[0].id
      await pool.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[tenantId,storeId,roleId,permissionId])
    }
    if(limit!==null)await pool.query("INSERT INTO mbox.role_approval_limits(tenant_id,store_id,role_id,approval_code,amount_minor,currency) VALUES($1,$2,$3,'refund.approve',$4,'CNY')",[tenantId,storeId,roleId,limit])
  }
  afterAll(async()=>{await pool?.end()})
  async function item(state='pending',discount=0,orderSessionId=sessionId){
    const orderId=randomUUID(),itemId=randomUUID(),taskId=randomUUID()
    await pool.query(`INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,submitted_at,subtotal_amount_minor,discount_amount_minor,total_amount_minor)
      VALUES($1,$2,$3,$4,$5,'staff_assisted','submitted',clock_timestamp(),4000,$6::bigint,4000-$6::bigint)`,[orderId,tenantId,storeId,orderSessionId,`quantity-${orderId}`,discount])
    await pool.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,discount_amount_minor,total_amount_minor,fulfillment_station,product_snapshot)
      VALUES($1,$2,$3,$4,$5,5,800,$6::bigint,4000-$6::bigint,'bar','{"name":"水","inventoryControlMode":"not_managed"}')`,[itemId,tenantId,storeId,orderId,productId,discount])
    await pool.query(`INSERT INTO mbox.kds_tasks(id,tenant_id,store_id,order_item_id,station_code,quantity,status) VALUES($1,$2,$3,$4,'bar',5,$5)`,[taskId,tenantId,storeId,itemId,state])
    return {orderId,itemId,taskId}
  }
  function hold(itemId:string,quantity:number,kind:'unpaid_stop'|'paid_return'='paid_return'){
    return runner.run(scope,tx=>new ItemQuantityRepository(tx).hold({orderItemId:itemId,quantity,kind,employeeId,businessDate:businessDate,reason:'客人停止所选数量'}),{isolation:'read-committed'})
  }
  async function stock(row:{orderId:string;itemId:string},kind:'reserved'|'direct_sale',quantity='5'){
    const stockId=randomUUID()
    await pool.query(`UPDATE mbox.order_items SET product_snapshot=product_snapshot||'{"inventoryControlMode":"tracked"}'::jsonb WHERE id=$1`,[row.itemId])
    await pool.query(`INSERT INTO mbox.inventory_items(id,tenant_id,store_id,sku,name,item_type,base_unit) VALUES($1,$2,$3,$4,'水库存','food','piece')`,[stockId,tenantId,storeId,`Q-${stockId}`])
    await pool.query(`INSERT INTO mbox.inventory_balances(tenant_id,store_id,inventory_item_id,on_hand_quantity,reserved_quantity)
      VALUES($1,$2,$3,$4::numeric,$5::numeric)`,[tenantId,storeId,stockId,kind==='reserved'?'10':'5',kind==='reserved'?quantity:'0'])
    if(kind==='reserved')await pool.query(`INSERT INTO mbox.inventory_order_reservations(tenant_id,store_id,order_id,order_item_id,inventory_item_id,quantity,expires_at)
      VALUES($1,$2,$3,$4,$5,$6::numeric,clock_timestamp()+interval '1 hour')`,[tenantId,storeId,row.orderId,row.itemId,stockId,quantity])
    else await pool.query(`INSERT INTO mbox.inventory_movements(tenant_id,store_id,inventory_item_id,movement_type,quantity_delta,reference_type,reference_id,order_item_id,unit_cost_minor)
      VALUES($1,$2,$3,'sale',-$4::numeric,'order_item',$5,$5,123)`,[tenantId,storeId,stockId,quantity,row.itemId])
    return stockId
  }
  async function balance(stockId:string){return (await pool.query('SELECT on_hand_quantity::text AS on_hand,reserved_quantity::text AS reserved FROM mbox.inventory_balances WHERE inventory_item_id=$1',[stockId])).rows[0]}
  async function payment(orderId:string,provider='cash',amount=4000){
    const id=randomUUID()
    await pool.query(`INSERT INTO mbox.payments(id,tenant_id,store_id,order_id,public_id,provider,method,amount_minor,currency,status,provider_transaction_id,succeeded_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'CNY','succeeded',$9,clock_timestamp())`,[id,tenantId,storeId,orderId,`quantity-payment-${id}`,provider,provider==='cash'?'cash':'native_qr',amount,`quantity-provider-${id}`])
    return id
  }
  async function pricedBundle(){
    const row=await item(),parent=randomUUID(),food=randomUUID()
    await pool.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot)
      VALUES($1,$2,$3,$4,$5,1,4000,4000,'none','{"name":"优惠套餐","inventoryControlMode":"not_managed"}')`,[parent,tenantId,storeId,row.orderId,productId])
    await pool.query(`UPDATE mbox.order_items SET parent_order_item_id=$2,unit_price_minor=0,total_amount_minor=0,product_snapshot=product_snapshot||'{"singlePriceReferenceMinor":800}'::jsonb WHERE id=$1`,[row.itemId,parent])
    await pool.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,parent_order_item_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot)
      VALUES($1,$2,$3,$4,$5,$6,1,0,0,'kitchen','{"name":"小食","singlePriceReferenceMinor":2000,"inventoryControlMode":"not_managed"}')`,[food,tenantId,storeId,row.orderId,productId,parent])
    return {...row,parent,food}
  }
  async function stopUnpaid(row:{itemId:string},quantity:number){
    const created=await hold(row.itemId,quantity,'unpaid_stop')
    await runner.run(scope,async tx=>{
      await new ItemUnitInventoryRepository(tx).disposeUnmadeUnits({itemId:row.itemId,unitIds:created.unitIds,employeeId,caseId:created.caseId})
      await new ItemQuantityReceivableRepository(tx).recordUnpaidReduction({caseId:created.caseId,employeeId,businessDate:businessDate})
    })
    return created
  }
  async function deliveredOriginal(){
    const row=await item('ready'),stockId=await stock(row,'direct_sale')
    await pool.query("UPDATE mbox.order_items SET status='delivered' WHERE id=$1",[row.itemId])
    return {...row,stockId}
  }
  async function redelivery<T>(operation:(repository:QuantityRedeliveryRepository,tx:import('./transaction-runner.js').ScopedTransaction)=>Promise<T>){
    return runner.run(scope,async tx=>{await tx.query('SET LOCAL ROLE mbox_runtime');return operation(new QuantityRedeliveryRepository(tx),tx)})
  }
  it('redelivers original physical goods in batches under runtime without new inventory or money movement',async()=>{
    await grantActor(employeeId,['refund.request','kds.deliver','fulfillment.view_all'])
    const row=await deliveredOriginal()
    const task=await redelivery(repo=>repo.request({itemId:row.itemId,employeeId,quantity:2,originalGoodsAvailable:true,reason:'原两瓶仍在吧台，重新送至客人',eventKey:randomUUID()}))
    expect(task).toMatchObject({status:'pending',pendingQuantity:2,deliveredQuantity:0})
    await expect(redelivery((_repo,tx)=>new ServiceTaskRepository(tx).complete({taskId:task.taskId,actor:{type:'employee',employeeId},note:'不能绕过实物份数',eventIdempotencyKey:randomUUID()}))).rejects.toThrow()
    const first=await redelivery(repo=>repo.complete({redeliveryId:task.id,employeeId,quantity:1,reason:'实际补送一瓶',eventKey:randomUUID()}))
    expect(first).toMatchObject({status:'in_progress',pendingQuantity:1,deliveredQuantity:1})
    const finished=await redelivery(repo=>repo.complete({redeliveryId:task.id,employeeId,reason:'余下一瓶已交付',eventKey:randomUUID()}))
    expect(finished).toMatchObject({status:'completed',pendingQuantity:0,deliveredQuantity:2})
    expect(await balance(row.stockId)).toEqual({on_hand:'5.000000',reserved:'0.000000'})
    expect((await pool.query('SELECT count(*)::int AS count FROM mbox.inventory_movements WHERE inventory_item_id=$1',[row.stockId])).rows[0].count).toBe(1)
    expect((await pool.query("SELECT count(*)::int AS count FROM mbox.order_item_quantity_units WHERE order_item_id=$1 AND production_state='delivered'",[row.itemId])).rows[0].count).toBe(5)
  })
  it('keeps paused original redelivery units pending while allowing actual remaining deliveries',async()=>{
    await grantActor(employeeId,['refund.request','kds.deliver','fulfillment.view_all'])
    const row=await deliveredOriginal();await payment(row.orderId)
    const task=await redelivery(repo=>repo.request({itemId:row.itemId,employeeId,quantity:2,originalGoodsAvailable:true,reason:'原两瓶仍在待送',eventKey:randomUUID()}))
    const held=await hold(row.itemId,1)
    const paused=await redelivery(repo=>repo.read(task.id))
    expect(paused).toMatchObject({pendingQuantity:2,pausedQuantity:1})
    await expect(redelivery(repo=>repo.complete({redeliveryId:task.id,employeeId,reason:'全部已送达',eventKey:randomUUID()}))).rejects.toThrow('部分原商品已暂停')
    expect(await redelivery(repo=>repo.complete({redeliveryId:task.id,employeeId,quantity:1,reason:'仅送未暂停的另一瓶',eventKey:randomUUID()}))).toMatchObject({status:'in_progress',pendingQuantity:1,pausedQuantity:1,deliveredQuantity:1})
    await redelivery(async(repo,tx)=>{await repo.lockForTask(task.taskId);return new ServiceTaskRepository(tx).cancel({taskId:task.taskId,actor:{type:'employee',employeeId},note:'客人不再需要本次补送',eventIdempotencyKey:randomUUID()})})
    expect(await redelivery(repo=>repo.read(task.id))).toMatchObject({status:'cancelled',pendingQuantity:0,deliveredQuantity:1,cancelledQuantity:1})
    expect((await pool.query('SELECT held_by_case_id FROM mbox.order_item_quantity_units WHERE id=$1',[held.unitIds[0]])).rows[0].held_by_case_id).toBe(held.caseId)
    expect(await balance(row.stockId)).toEqual({on_hand:'5.000000',reserved:'0.000000'})
  })
  it('rejects redelivery without actual original goods and prevents concurrently duplicating their pending units',async()=>{
    await grantActor(employeeId,['refund.request'])
    const row=await deliveredOriginal()
    const input={itemId:row.itemId,employeeId,quantity:5,originalGoodsAvailable:true,reason:'原实物仍在可以交付',eventKey:randomUUID()}
    await expect(redelivery(repo=>repo.request({...input,originalGoodsAvailable:false}))).rejects.toThrow()
    const attempts=await Promise.allSettled([redelivery(repo=>repo.request(input)),redelivery(repo=>repo.request({...input,eventKey:randomUUID()}))])
    expect(attempts.filter(result=>result.status==='fulfilled')).toHaveLength(1)
    expect(attempts.filter(result=>result.status==='rejected')).toHaveLength(1)
    expect(await balance(row.stockId)).toEqual({on_hand:'5.000000',reserved:'0.000000'})
  })
  it('recovers original redelivery HTTP commands after gate-off and exposes delivery counts without changing the old bill',async()=>{
    await grantActor(employeeId,['refund.request','kds.deliver','fulfillment.view_all'])
    const row=await deliveredOriginal()
    const runtimeTransactions={run:<T>(current:typeof scope,operation:(tx:import('./transaction-runner.js').ScopedTransaction)=>Promise<T>)=>runner.run(current,async tx=>{await tx.query('SET LOCAL ROLE mbox_runtime');return operation(tx)})} as ScopedPostgresTransactionRunner
    const commands=new NormalizedCommandExecutor(runtimeTransactions)
    const make=async(enabled:boolean)=>{const app=Fastify();await app.register(itemAfterSalesApiPlugin,{prefix:'/api',enabled,transactions:runner,commands,resolveContext:()=>({scope,employeeId,businessDate:businessDate,capabilities:['refund.request']})});return app}
    const live=await make(true),recovery=await make(false)
    try{
      const body={orderItemId:row.itemId,quantity:2,reason:'原实物仍在需再次送达',originalGoodsAvailable:true},headers={'idempotency-key':`redelivery-request-${randomUUID()}`},url='/api/commerce/item-after-sales/redeliveries'
      const initial=await live.inject({method:'POST',url,headers,payload:body});expect(initial.statusCode,initial.body).toBe(201)
      const result=initial.json().data
      const repeat=await recovery.inject({method:'POST',url,headers,payload:body});expect(repeat.statusCode,repeat.body).toBe(200);expect(repeat.json()).toEqual({data:result,replayed:true})
      const refused=await recovery.inject({method:'POST',url,headers:{'idempotency-key':randomUUID()},payload:body});expect(refused.statusCode).toBe(409);expect(refused.json().error.code).toBe('QUANTITY_BATCH_NOT_ENABLED')
      const workspace=await recovery.inject({method:'GET',url:`/api/commerce/item-after-sales/items/${row.itemId}`})
      expect(workspace.statusCode,workspace.body).toBe(200);expect(workspace.json().data).toMatchObject({canRequestRedelivery:false,canConfirmRedelivery:true,redeliveryAvailableQuantity:3,redeliveries:[{id:result.id,pendingQuantity:2}]})
      const delivery={method:'POST' as const,url:`${url}/${result.id}/complete`,headers:{'idempotency-key':randomUUID()},payload:{quantity:1,reason:'原一瓶已补送给客人'}}
      const actual=await recovery.inject(delivery);expect(actual.statusCode,actual.body).toBe(200);expect(actual.json().data).toMatchObject({deliveredQuantity:1,pendingQuantity:1})
      expect((await recovery.inject(delivery)).json()).toEqual({...actual.json(),replayed:true})
      expect(await balance(row.stockId)).toEqual({on_hand:'5.000000',reserved:'0.000000'})
      expect((await pool.query('SELECT total_amount_minor::text AS total FROM mbox.orders WHERE id=$1',[row.orderId])).rows[0].total).toBe('4000')
      const customer=randomUUID();await pool.query('INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1,$2,$3,$4)',[customer,tenantId,storeId,`redelivery-guest-${customer}`])
      const guest=(await runner.run(scope,tx=>loadGuestTableOrders(tx,sessionId,customer),{readOnly:true})).find(order=>order.publicId===`quantity-${row.orderId}`)!
      expect(guest.items[0]?.progressText).toBe('已送达记录 5 份 · 待补送 1 份')
      expect(JSON.stringify(guest)).not.toMatch(/redeliveryId|employeeId|unitIds|caseId/)
    }finally{await live.close();await recovery.close()}
  })
  it('removes stopped original units from redelivery while preserving the remaining physical delivery',async()=>{
    await grantActor(employeeId,['refund.request','kds.deliver','fulfillment.view_all']);await grantActor(reviewerId,['refund.approve'],100000)
    const row=await deliveredOriginal();await payment(row.orderId)
    const task=await redelivery(repo=>repo.request({itemId:row.itemId,employeeId,quantity:2,originalGoodsAvailable:true,reason:'原两瓶重新送达',eventKey:randomUUID()}))
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    const requested=await service.request({scope,employeeId,businessDate:businessDate,orderItemId:row.itemId,quantity:1,reason:'原一瓶客人不再需要',idempotencyKey:randomUUID()})
    await service.decide({scope,employeeId:reviewerId,businessDate:businessDate,caseId:requested.value.caseId,decision:'approved',reason:'同意退款，实物另行核对',idempotencyKey:randomUUID()})
    expect(await redelivery(repo=>repo.read(task.id))).toMatchObject({pendingQuantity:2,pausedQuantity:1})
    await grantActor(employeeId,['inventory.waste'])
    const heldUnits=(await pool.query('SELECT id FROM mbox.order_item_quantity_units WHERE held_by_case_id=$1',[requested.value.caseId])).rows.map(value=>value.id)
    await service.disposeMade({scope,employeeId,businessDate:businessDate,caseId:requested.value.caseId,unitIds:heldUnits,disposition:'used_loss',unopenedReceived:false,reason:'已耗用，保留原消耗不回库',idempotencyKey:randomUUID()})
    expect(await redelivery(repo=>repo.read(task.id))).toMatchObject({pendingQuantity:1,cancelledQuantity:1,pausedQuantity:0})
    expect(await redelivery(repo=>repo.complete({redeliveryId:task.id,employeeId,reason:'仅剩的一瓶已实际补送',eventKey:randomUUID()}))).toMatchObject({status:'completed',pendingQuantity:0,cancelledQuantity:1,deliveredQuantity:1})
    expect(await balance(row.stockId)).toEqual({on_hand:'5.000000',reserved:'0.000000'})
  })
  it('lets the existing store-wide delivery role receive and finish redelivery without requiring table-manager privileges',async()=>{
    const serverId=randomUUID(),observerId=randomUUID()
    for(const id of [serverId,observerId])await pool.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,$4,'补送岗位')",[id,tenantId,storeId,`R-${id}`])
    await grantActor(serverId,['refund.request','kds.deliver','service.view','service.execute'])
    await grantActor(observerId,['refund.request','service.view'])
    const row=await deliveredOriginal()
    const task=await redelivery(repo=>repo.request({itemId:row.itemId,employeeId,quantity:2,originalGoodsAvailable:true,reason:'原实物交给取送同事',eventKey:randomUUID()}))
    const view=await new OperationsQueryService(runner).getStaffView(scope,serverId)
    expect(view.actor.capabilities).not.toContain('table.view_all');expect(view.actor.capabilities).not.toContain('fulfillment.view_all')
    expect(view.tasks).toEqual(expect.arrayContaining([expect.objectContaining({id:task.taskId,originalOrderItemId:row.itemId})]))
    const observer=await new OperationsQueryService(runner).getStaffView(scope,observerId)
    expect(observer.tasks.some(value=>value.id===task.taskId)).toBe(false)
    const workspace=await new ItemAfterSalesQuery(runner).item({scope,employeeId:serverId,itemId:row.itemId})
    expect(workspace).toMatchObject({canConfirmRedelivery:true,canCancelRedelivery:true})
    await expect(redelivery(repo=>repo.complete({redeliveryId:task.id,employeeId:observerId,quantity:1,reason:'没有送达权限',eventKey:randomUUID()}))).rejects.toThrow()
    await redelivery(repo=>repo.complete({redeliveryId:task.id,employeeId:serverId,quantity:1,reason:'实际补送一瓶',eventKey:randomUUID()}))
    expect(await redelivery(repo=>repo.cancel({redeliveryId:task.id,employeeId:serverId,reason:'确认不再补送余下一瓶',eventKey:randomUUID()}))).toMatchObject({status:'cancelled',deliveredQuantity:1,cancelledQuantity:1})
  })
  async function remake<T>(operation:(repository:QuantityRemakeRepository,tx:import('./transaction-runner.js').ScopedTransaction)=>Promise<T>){
    return runner.run(scope,async tx=>{await tx.query('SET LOCAL ROLE mbox_runtime');return operation(new QuantityRemakeRepository(tx),tx)})
  }
  it('reserves a separate remake batch, consumes only actual new portions and releases unmade remainder without refunding old loss',async()=>{
    await grantActor(employeeId,['kds.exception.manage'])
    const row=await deliveredOriginal()
    await pool.query("UPDATE mbox.inventory_balances SET cost_status='complete',cost_basis='manual_correction',weighted_unit_cost_minor=222.123456 WHERE inventory_item_id=$1",[row.stockId])
    const batch=await remake(repo=>repo.create({itemId:row.itemId,employeeId,quantity:2,originalGoodsLost:true,reason:'两瓶已损坏，重新准备给客人',eventKey:randomUUID()}))
    expect(batch.units).toHaveLength(2);expect(batch.units.every(unit=>unit.production_state==='unmade')).toBe(true)
    expect(await balance(row.stockId)).toEqual({on_hand:'5.000000',reserved:'2.000000'})
    expect((await pool.query("SELECT count(*)::int n FROM mbox.order_item_unit_inventory WHERE unit_id=ANY($1::uuid[]) AND status='used_loss'",[batch.units.map(unit=>unit.unit_id)])).rows[0].n).toBe(2)
    const first=batch.units[0]!.id,second=batch.units[1]!.id
    await remake(repo=>repo.consume({batchId:batch.id,employeeId,unitIds:[first]}))
    await remake(repo=>repo.consume({batchId:batch.id,employeeId,unitIds:[first]}))
    expect(await balance(row.stockId)).toEqual({on_hand:'4.000000',reserved:'1.000000'})
    await expect(remake(repo=>repo.releaseUnmade({batchId:batch.id,unitIds:[first],reason:'已做的不能按未做退回'}))).rejects.toThrow('已开始重做')
    await remake(repo=>repo.releaseUnmade({batchId:batch.id,unitIds:[second],reason:'另一份尚未做，停止本批'}))
    await remake(repo=>repo.releaseUnmade({batchId:batch.id,unitIds:[second],reason:'同一实际停止结果重读'}))
    expect(await balance(row.stockId)).toEqual({on_hand:'4.000000',reserved:'0.000000'})
    const movements=(await pool.query('SELECT movement_type,quantity_delta::text,unit_cost_minor::text FROM mbox.inventory_movements WHERE inventory_item_id=$1 ORDER BY occurred_at,id',[row.stockId])).rows
    expect(movements).toHaveLength(2)
    expect(movements.find(value=>value.movement_type==='sale')).toMatchObject({quantity_delta:'-5.000000',unit_cost_minor:'123.000000'})
    expect(movements.find(value=>value.movement_type==='waste')).toMatchObject({quantity_delta:'-1.000000',unit_cost_minor:'222.123456'})
    expect((await pool.query("SELECT count(*)::int n FROM mbox.order_item_quantity_units WHERE order_item_id=$1 AND production_state='delivered'",[row.itemId])).rows[0].n).toBe(5)
    expect((await pool.query('SELECT total_amount_minor::text total FROM mbox.orders WHERE id=$1',[row.orderId])).rows[0].total).toBe('4000')
  })
  it('rolls back the entire new batch on insufficient stock and serializes competing remediation of the same physical units',async()=>{
    await grantActor(employeeId,['kds.exception.manage'])
    const row=await deliveredOriginal()
    await pool.query('UPDATE mbox.inventory_balances SET on_hand_quantity=1 WHERE inventory_item_id=$1',[row.stockId])
    const input={itemId:row.itemId,employeeId,quantity:2,originalGoodsLost:true,reason:'原两份已损坏需要重做',eventKey:randomUUID()}
    await expect(remake(repo=>repo.create(input))).rejects.toThrow('材料不足')
    expect((await pool.query('SELECT count(*)::int n FROM mbox.quantity_remake_batches WHERE order_item_id=$1',[row.itemId])).rows[0].n).toBe(0)
    expect((await pool.query('SELECT count(*)::int n FROM mbox.kds_tasks WHERE order_item_id=$1 AND remake_of_task_id IS NOT NULL',[row.itemId])).rows[0].n).toBe(0)
    expect(await balance(row.stockId)).toEqual({on_hand:'1.000000',reserved:'0.000000'})
    await pool.query('UPDATE mbox.inventory_balances SET on_hand_quantity=5 WHERE inventory_item_id=$1',[row.stockId])
    const outcomes=await Promise.allSettled([remake(repo=>repo.create({...input,quantity:5})),remake(repo=>repo.create({...input,quantity:5,eventKey:randomUUID()}))])
    expect(outcomes.filter(result=>result.status==='fulfilled')).toHaveLength(1)
    expect(outcomes.filter(result=>result.status==='rejected')).toHaveLength(1)
    expect(await balance(row.stockId)).toEqual({on_hand:'5.000000',reserved:'5.000000'})
  })
  it('captures actual current inventory cost for each newly made original portion while preserving unknown costs as unknown',async()=>{
    const row=await item(),stockId=await stock(row,'reserved')
    await pool.query("UPDATE mbox.inventory_balances SET cost_status='complete',cost_basis='manual_correction',weighted_unit_cost_minor=123.456789 WHERE inventory_item_id=$1",[stockId])
    await runner.run(scope,tx=>new ItemQuantityFulfillmentRepository(tx).complete({itemId:row.itemId,taskId:row.taskId,employeeId,quantity:1,eventKey:randomUUID()}))
    await pool.query("UPDATE mbox.inventory_balances SET cost_status='pending',cost_basis='none',weighted_unit_cost_minor=NULL WHERE inventory_item_id=$1",[stockId])
    await runner.run(scope,tx=>new ItemQuantityFulfillmentRepository(tx).complete({itemId:row.itemId,taskId:row.taskId,employeeId,quantity:1,eventKey:randomUUID()}))
    const movements=(await pool.query('SELECT unit_cost_minor::text AS cost FROM mbox.inventory_movements WHERE inventory_item_id=$1 ORDER BY occurred_at,id',[stockId])).rows
    expect(movements).toEqual([{cost:'123.456789'},{cost:null}])
  })
  it('does not let a new physical batch advance before its exact materials are consumed or after the original goods are paused',async()=>{
    await grantActor(employeeId,['kds.exception.manage'])
    const row=await deliveredOriginal()
    const batch=await remake(repo=>repo.create({itemId:row.itemId,employeeId,quantity:1,originalGoodsLost:true,reason:'原一份无法交付，按原料重做',eventKey:randomUUID()})),part=batch.units[0]!
    await expect(remake((_repo,tx)=>tx.query("UPDATE mbox.quantity_remake_units SET production_state='ready' WHERE id=$1",[part.id]))).rejects.toThrow('exact consumed materials')
    await hold(row.itemId,1)
    await expect(remake(repo=>repo.consume({batchId:batch.id,employeeId,unitIds:[part.id]}))).rejects.toThrow('暂停或停止')
    expect(await balance(row.stockId)).toEqual({on_hand:'5.000000',reserved:'1.000000'})
    await expect(remake((_repo,tx)=>tx.query("UPDATE mbox.quantity_remake_units SET cancelled_at=clock_timestamp(),cancel_reason='未核实材料' WHERE id=$1",[part.id]))).rejects.toThrow('material disposition')
    await remake(repo=>repo.releaseUnmade({batchId:batch.id,unitIds:[part.id],reason:'该份不再制作，释放本批预留'}))
    expect(await balance(row.stockId)).toEqual({on_hand:'5.000000',reserved:'0.000000'})
  })
  it('returns only the actual unopened new batch at its own cost and does not reverse original loss',async()=>{
    await grantActor(employeeId,['kds.exception.manage'])
    const row=await deliveredOriginal()
    await pool.query("UPDATE mbox.inventory_balances SET cost_status='complete',cost_basis='manual_correction',weighted_unit_cost_minor=222.123456 WHERE inventory_item_id=$1",[row.stockId])
    const batch=await remake(repo=>repo.create({itemId:row.itemId,employeeId,quantity:1,originalGoodsLost:true,reason:'原瓶损坏，重新提供一瓶',eventKey:randomUUID()})),unitIds=batch.units.map(unit=>unit.id)
    await remake(repo=>repo.consume({batchId:batch.id,employeeId,unitIds}))
    await pool.query('UPDATE mbox.inventory_balances SET weighted_unit_cost_minor=300 WHERE inventory_item_id=$1',[row.stockId])
    const disposition={batchId:batch.id,unitIds,employeeId,reason:'新的一瓶实际收回且未开封',disposition:'returned_unopened' as const,unopenedReceived:true}
    await expect(remake(repo=>repo.disposeMade({...disposition,unopenedReceived:false}))).rejects.toThrow('确已收回')
    await remake(repo=>repo.disposeMade(disposition));await remake(repo=>repo.disposeMade(disposition))
    expect(await balance(row.stockId)).toEqual({on_hand:'5.000000',reserved:'0.000000'})
    const movements=(await pool.query("SELECT movement_type,quantity_delta::text,unit_cost_minor::text FROM mbox.inventory_movements WHERE inventory_item_id=$1 ORDER BY occurred_at,id",[row.stockId])).rows
    expect(movements).toHaveLength(3)
    expect(movements.find(value=>value.movement_type==='return')).toMatchObject({quantity_delta:'1.000000',unit_cost_minor:'222.123456'})
    expect((await pool.query('SELECT weighted_unit_cost_minor::text AS cost FROM mbox.inventory_balances WHERE inventory_item_id=$1',[row.stockId])).rows[0].cost).toBe('284.424691')
    expect((await pool.query("SELECT status FROM mbox.order_item_unit_inventory WHERE unit_id=$1",[batch.units[0]!.unit_id])).rows[0].status).toBe('used_loss')
    await expect(remake(repo=>repo.disposeMade({...disposition,disposition:'used_loss'}))).rejects.toThrow('另一结果处置')
    await expect(remake(repo=>repo.consume({batchId:batch.id,employeeId,unitIds}))).rejects.toThrow('暂停或停止')
  })
  for(const onHand of [0,5])it(`preserves the actual old return cost in weighted balance when ${onHand} goods remain`,async()=>{
    await grantActor(employeeId,['refund.request','inventory.receive']);await grantActor(reviewerId,['refund.approve'],100000)
    const row=await deliveredOriginal();await payment(row.orderId)
    await pool.query("UPDATE mbox.inventory_balances SET on_hand_quantity=$2,cost_status='complete',cost_basis='manual_correction',weighted_unit_cost_minor=222 WHERE inventory_item_id=$1",[row.stockId,onHand])
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    const requested=await service.request({scope,employeeId,businessDate:businessDate,orderItemId:row.itemId,quantity:1,reason:'原一瓶未开封实际退货',idempotencyKey:randomUUID()})
    await service.decide({scope,employeeId:reviewerId,businessDate:businessDate,caseId:requested.value.caseId,decision:'approved',reason:'同意一瓶原付款退款',idempotencyKey:randomUUID()})
    const units=(await pool.query('SELECT id FROM mbox.order_item_quantity_units WHERE held_by_case_id=$1',[requested.value.caseId])).rows.map(value=>value.id)
    await service.disposeMade({scope,employeeId,businessDate:businessDate,caseId:requested.value.caseId,unitIds:units,disposition:'returned_unopened',unopenedReceived:true,reason:'实物已收回且未开封',idempotencyKey:randomUUID()})
    expect((await pool.query('SELECT on_hand_quantity::text AS quantity,weighted_unit_cost_minor::text AS cost FROM mbox.inventory_balances WHERE inventory_item_id=$1',[row.stockId])).rows[0]).toEqual({quantity:`${onHand+1}.000000`,cost:onHand===0?'123.000000':'205.500000'})
  })
  it('uses the latest made physical batch for redelivery and ends that pending delivery when its actual goods are disposed',async()=>{
    await grantActor(employeeId,['kds.exception.manage','refund.request'])
    const row=await deliveredOriginal(),batch=await remake(repo=>repo.create({itemId:row.itemId,employeeId,quantity:1,originalGoodsLost:true,reason:'原一份损坏，新批独立制作',eventKey:randomUUID()})),physical=batch.units[0]!
    expect((await new ItemAfterSalesQuery(runner).item({scope,employeeId,itemId:row.itemId})).redeliveryAvailableQuantity).toBe(4)
    await remake(repo=>repo.consume({batchId:batch.id,employeeId,unitIds:[physical.id]}))
    await remake((_repo,tx)=>tx.query("UPDATE mbox.quantity_remake_units SET production_state='delivered' WHERE id=$1",[physical.id]))
    const delivery=await redelivery(repo=>repo.request({itemId:row.itemId,employeeId,quantity:1,originalGoodsAvailable:true,reason:'新制作的一份实物仍在，补送给客人',eventKey:randomUUID()}))
    expect((await pool.query('SELECT source_remake_unit_id FROM mbox.quantity_redelivery_units WHERE redelivery_id=$1',[delivery.id])).rows[0].source_remake_unit_id).toBe(physical.id)
    await remake(repo=>repo.disposeMade({batchId:batch.id,unitIds:[physical.id],employeeId,reason:'该新批也确已无法交付，登记已消耗',disposition:'used_loss',unopenedReceived:false}))
    expect(await redelivery(repo=>repo.read(delivery.id))).toMatchObject({status:'cancelled',pendingQuantity:0,cancelledQuantity:1})
    expect((await new ItemAfterSalesQuery(runner).item({scope,employeeId,itemId:row.itemId})).redeliveryAvailableQuantity).toBe(4)
    expect(await balance(row.stockId)).toEqual({on_hand:'4.000000',reserved:'0.000000'})
  })
  it('makes and delivers only actual new-batch portions, with replay preserving old delivery history and material totals',async()=>{
    await grantActor(employeeId,['kds.exception.manage'])
    const row=await deliveredOriginal(),batch=await remake(repo=>repo.create({itemId:row.itemId,employeeId,quantity:3,originalGoodsLost:true,reason:'原三份无法交付，重新制作',eventKey:randomUUID()}))
    const input={taskId:batch.taskId,employeeId,quantity:2,eventKey:randomUUID(),action:'complete' as const}
    const act=(command:Parameters<QuantityRemakeFulfillmentRepository['act']>[0])=>remake((_repo,tx)=>new QuantityRemakeFulfillmentRepository(tx).act(command))
    const first=await act(input);expect(first.remakeUnitIds).toHaveLength(2)
    expect(await act(input)).toEqual({...first,replayed:true})
    expect(await balance(row.stockId)).toEqual({on_hand:'3.000000',reserved:'1.000000'})
    await expect(act({...input,quantity:1})).rejects.toThrow('不能变更')
    const sent=await act({...input,quantity:1,action:'deliver',eventKey:randomUUID()});expect(sent.remakeUnitIds).toEqual([first.remakeUnitIds[0]])
    expect((await remake(repo=>repo.read(batch.id))).units.map(unit=>unit.production_state)).toEqual(['delivered','ready','unmade'])
    await hold(row.itemId,1)
    await act({...input,quantity:1,eventKey:randomUUID()})
    expect(await balance(row.stockId)).toEqual({on_hand:'2.000000',reserved:'0.000000'})
    await act({...input,quantity:2,action:'deliver',eventKey:randomUUID()})
    expect((await remake(repo=>repo.read(batch.id))).units.map(unit=>unit.production_state)).toEqual(['delivered','delivered','delivered'])
    expect((await pool.query("SELECT count(*)::int n FROM mbox.order_item_quantity_units WHERE order_item_id=$1 AND production_state='delivered'",[row.itemId])).rows[0].n).toBe(5)
    expect((await pool.query('SELECT total_amount_minor::text total FROM mbox.orders WHERE id=$1',[row.orderId])).rows[0].total).toBe('4000')
  })
  it('binds delivery slips to the exact new physical units and never reuses the original shipment identity',async()=>{
    await grantActor(employeeId,['kds.exception.manage'])
    const row=await deliveredOriginal(),batch=await remake(repo=>repo.create({itemId:row.itemId,employeeId,quantity:3,originalGoodsLost:true,reason:'三份原实物损坏，另批重做',eventKey:randomUUID()}))
    const complete=(quantity:number)=>remake((_repo,tx)=>new QuantityRemakeFulfillmentRepository(tx).act({taskId:batch.taskId,employeeId,quantity,action:'complete',eventKey:randomUUID()}))
    const first=await complete(2)
    const slip=await remake((_repo,tx)=>new DeliveryBatchRepository(tx).create(employeeId,[{taskId:batch.taskId,quantity:2,remakeUnitIds:first.remakeUnitIds}]))
    expect(slip.items).toEqual([{taskId:batch.taskId,quantity:2}])
    expect(await remake((_repo,tx)=>new DeliveryBatchRepository(tx).originalForUnits(batch.taskId,first.remakeUnitIds,'remake'))).toEqual(slip)
    await expect(remake((_repo,tx)=>new DeliveryBatchRepository(tx).create(employeeId,[{taskId:batch.taskId,quantity:2,remakeUnitIds:first.remakeUnitIds}]))).rejects.toThrow('超过新实物')
    await expect(remake((_repo,tx)=>new DeliveryBatchRepository(tx).create(employeeId,[{taskId:batch.taskId,quantity:1,unitIds:[first.originalUnitIds[0]!]}]))).rejects.toThrow('旧实物')
    const last=await complete(1)
    const second=await remake((_repo,tx)=>new DeliveryBatchRepository(tx).create(employeeId,[{taskId:batch.taskId,quantity:1,remakeUnitIds:last.remakeUnitIds}]))
    expect(second.id).not.toBe(slip.id)
    expect((await pool.query('SELECT count(*)::int n FROM mbox.delivery_batch_remake_units WHERE kds_task_id=$1',[batch.taskId])).rows[0].n).toBe(3)
    expect((await pool.query('SELECT count(*)::int n FROM mbox.delivery_batch_quantity_units WHERE kds_task_id=$1',[batch.taskId])).rows[0].n).toBe(0)
    expect(await balance(row.stockId)).toEqual({on_hand:'2.000000',reserved:'0.000000'})
  })
  it('keeps remake work independent when a rejected source case explicitly resumes',async()=>{
    await grantActor(employeeId,['kds.exception.manage','refund.request'])
    const row=await deliveredOriginal(),batch=await remake(repo=>repo.create({itemId:row.itemId,employeeId,quantity:2,originalGoodsLost:true,reason:'原两份损坏，另批制作',eventKey:randomUUID()}))
    const created=await hold(row.itemId,1)
    await runner.run(scope,async tx=>{
      await new ItemQuantityRepository(tx).decide({caseId:created.caseId,employeeId,decision:'withdrawn',reason:'客人决定继续等待新批'})
      await new ItemAfterSalesOperatingEffects().apply(tx,{caseId:created.caseId,employeeId,action:'withdrawn',eventKey:randomUUID()})
    })
    expect((await pool.query('SELECT status FROM mbox.kds_tasks WHERE id=$1',[batch.taskId])).rows[0].status).toBe('pending')
    await expect(remake(repo=>repo.consume({batchId:batch.id,employeeId,unitIds:[batch.units[0]!.id]}))).rejects.toThrow('暂停或停止')
    await runner.run(scope,async tx=>{
      await new ItemQuantityRepository(tx).resume({caseId:created.caseId,employeeId})
      await new ItemAfterSalesOperatingEffects().apply(tx,{caseId:created.caseId,employeeId,action:'resume',eventKey:randomUUID()})
    })
    const resumed=(await pool.query("SELECT payload FROM mbox.outbox_messages WHERE tenant_id=$1 AND payload->>'caseId'=$2 AND payload->'ticket'->>'subtitle'='继续本批重做'",[tenantId,created.caseId])).rows
    expect(resumed).toHaveLength(1);expect(resumed[0].payload.ticket.lines[0]).toMatchObject({quantity:1,name:'继续本批重做：重做批次 · 水'})
    expect(resumed[0].payload.ticket.lines[0].note).toContain(batch.id)
    await remake(repo=>repo.consume({batchId:batch.id,employeeId,unitIds:[batch.units[0]!.id]}))
    expect(await balance(row.stockId)).toEqual({on_hand:'4.000000',reserved:'1.000000'})
    expect((await pool.query('SELECT status FROM mbox.order_item_unit_inventory WHERE unit_id=$1',[batch.units[0]!.unit_id])).rows[0].status).toBe('used_loss')
  })
  for(const made of [false,true])it(`settles the actual ${made?'made':'unmade'} replacement through the original refund case without reversing first-batch loss`,async()=>{
    await grantActor(employeeId,['kds.exception.manage','refund.request','inventory.receive']);await grantActor(reviewerId,['refund.approve'],100000)
    const row=await deliveredOriginal();await payment(row.orderId)
    const batch=await remake(repo=>repo.create({itemId:row.itemId,employeeId,quantity:1,originalGoodsLost:true,reason:'原一瓶损坏，另批提供',eventKey:randomUUID()})),part=batch.units[0]!
    if(made)await remake(repo=>repo.consume({batchId:batch.id,employeeId,unitIds:[part.id]}))
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    const requested=await service.request({scope,employeeId,businessDate:businessDate,orderItemId:row.itemId,quantity:1,reason:'客人取消原一份商品，按实际批次处理',idempotencyKey:randomUUID()}),caseId=requested.value.caseId
    await service.decide({scope,employeeId:reviewerId,businessDate:businessDate,caseId,decision:'approved',reason:'一次审核同意原商品退款',idempotencyKey:randomUUID()})
    await expect(remake((_repo,tx)=>tx.query('UPDATE mbox.order_item_quantity_units SET held_by_case_id=NULL,stopped_by_case_id=$2 WHERE id=$1',[part.unit_id,caseId]))).rejects.toThrow('dispose actual remake materials')
    const command={scope,employeeId,businessDate:businessDate,caseId,unitIds:[part.unit_id],disposition:'returned_unopened' as const,unopenedReceived:true,reason:made?'新瓶已实际收回且未开封':'新批尚未制作，取消本批预留',idempotencyKey:randomUUID()}
    await service.disposeMade(command);await service.disposeMade(command)
    expect(await balance(row.stockId)).toEqual({on_hand:'5.000000',reserved:'0.000000'})
    expect((await pool.query('SELECT status FROM mbox.order_item_unit_inventory WHERE unit_id=$1',[part.unit_id])).rows[0].status).toBe('used_loss')
    expect((await pool.query('SELECT status FROM mbox.quantity_remake_stocks WHERE remake_unit_id=$1',[part.id])).rows[0].status).toBe(made?'returned':'released')
    expect((await pool.query('SELECT status FROM mbox.kds_tasks WHERE id=$1',[batch.taskId])).rows[0].status).toBe('cancelled')
    expect((await pool.query('SELECT operationally_stopped,production_state FROM mbox.order_item_quantity_units WHERE id=$1',[part.unit_id])).rows[0]).toMatchObject({operationally_stopped:true,production_state:'delivered'})
    expect((await pool.query("SELECT count(*)::int n FROM mbox.inventory_movements WHERE inventory_item_id=$1 AND movement_type='return'",[row.stockId])).rows[0].n).toBe(made?1:0)
  })
  it('recovers the exact remake KDS batch and delivery slip without changing the original delivered item',async()=>{
    await grantActor(employeeId,['kds.exception.manage','fulfillment.view_all','kds.deliver'])
    const row=await deliveredOriginal(),batch=await remake(repo=>repo.create({itemId:row.itemId,employeeId,quantity:2,originalGoodsLost:true,reason:'两瓶原实物无法交付，重新提供',eventKey:randomUUID()}))
    const task={id:batch.taskId,orderItemId:row.itemId,remakeOfTaskId:row.taskId,stationCode:'bar' as const,status:'pending' as const,priority:100,quantity:2,assignedEmployeeId:null,dueAt:null,nextActionAt:new Date().toISOString(),acceptedAt:null,readyAt:null,cancelledAt:null}
    const action={task,action:'complete' as const,employeeId,quantity:1,eventKey:randomUUID()}
    const first=await remake((_repo,tx)=>executeQuantityKdsAction(tx,action))
    expect(first).toMatchObject({quantity:1,fulfillmentStatus:'in_progress',batch:{items:[{taskId:batch.taskId,quantity:1}]}})
    expect((await remake((_repo,tx)=>executeQuantityKdsAction(tx,action))).batch).toEqual(first.batch)
    await expect(remake((_repo,tx)=>executeQuantityKdsAction(tx,{...action,employeeId:reviewerId}))).rejects.toThrow('同一重做操作')
    const queue=await new FulfillmentQueryService(runner).getStaffWorkQueue(scope,employeeId,businessDate)
    const listed=queue.workItems.find(value=>value.taskId===batch.taskId)!
    expect(listed).toMatchObject({quantities:{total:2,unmade:1,ready:1,delivered:0},canDeliver:true,deliveryUnbatchedQuantity:0,item:{quantity:2,productName:'重做：水'}})
    expect(listed.item.totalAmountMinor).toBeUndefined()
    const guest=await runner.run(scope,tx=>loadGuestTableOrders(tx,sessionId,randomUUID()))
    const guestItem=guest.flatMap(order=>order.items).find(item=>item.id===row.itemId)!
    expect(guestItem.progressText).toContain('重新准备中 1 份');expect(guestItem.progressText).toContain('重做已备齐 1 份')
    expect(guestItem.totalAmountMinor).toBe(4000);expect(guestItem.quantity).toBe(5)

    await remake((_repo,tx)=>executeQuantityKdsAction(tx,{...action,action:'deliver',eventKey:randomUUID()}))
    await remake((_repo,tx)=>executeQuantityKdsAction(tx,{...action,eventKey:randomUUID()}))
    expect((await remake((_repo,tx)=>executeQuantityKdsAction(tx,{...action,action:'deliver',eventKey:randomUUID()}))).fulfillmentStatus).toBe('delivered')
    const after=await new FulfillmentQueryService(runner).getStaffWorkQueue(scope,employeeId,businessDate)
    expect(after.workItems.some(value=>value.taskId===batch.taskId)).toBe(false)
    expect((await pool.query("SELECT count(*)::int n FROM mbox.order_item_quantity_units WHERE order_item_id=$1 AND production_state='delivered'",[row.itemId])).rows[0].n).toBe(5)
    expect((await pool.query('SELECT count(*)::int n FROM mbox.delivery_batches batch JOIN mbox.delivery_batch_items item ON item.batch_id=batch.id WHERE item.kds_task_id=$1',[batch.taskId])).rows[0].n).toBe(2)
    expect(await balance(row.stockId)).toEqual({on_hand:'3.000000',reserved:'0.000000'})
  })
  it('keeps destroyed old physical portions out of original delivery while the replacement is pending',async()=>{
    await grantActor(employeeId,['kds.exception.manage','fulfillment.view_all','kds.deliver'])
    const row=await item('ready');await stock(row,'direct_sale')
    const batch=await remake(repo=>repo.create({itemId:row.itemId,employeeId,quantity:1,originalGoodsLost:true,reason:'备齐后其中一瓶损坏，另批替换',eventKey:randomUUID()}))
    const before=await new FulfillmentQueryService(runner).getStaffWorkQueue(scope,employeeId,businessDate)
    expect(before.workItems.find(value=>value.taskId===row.taskId)?.quantities).toMatchObject({total:5,ready:4,stopped:1})
    await expect(remake((_repo,tx)=>tx.query("UPDATE mbox.order_item_quantity_units SET production_state='delivered' WHERE id=$1",[batch.units[0]!.unit_id]))).rejects.toThrow('original physical history')
    await expect(remake((_repo,tx)=>new ItemQuantityFulfillmentRepository(tx).deliver({itemId:row.itemId,taskId:row.taskId,employeeId,quantity:5,eventKey:randomUUID()}))).rejects.toThrow('最多可送达4份')
    await remake((_repo,tx)=>new ItemQuantityFulfillmentRepository(tx).deliver({itemId:row.itemId,taskId:row.taskId,employeeId,quantity:4,eventKey:randomUUID()}))
    expect((await pool.query('SELECT status FROM mbox.kds_tasks WHERE id=$1',[batch.taskId])).rows[0].status).toBe('pending')
  })
  it.each(['order_cancel','customer_left','automatic_cutoff'] as const)('releases only unused replacement material on %s and retains actual new delivery and pending made goods',async kind=>{
    await grantActor(employeeId,['kds.exception.manage','order.cancel_unpaid','table.close','table.turnover_unsettled','refund.request','inventory.receive'])
    const source=await freshTableSession(),row=await item('ready',0,source.id),stockId=await stock(row,'direct_sale')
    const batch=await remake(repo=>repo.create({itemId:row.itemId,employeeId,quantity:3,originalGoodsLost:true,reason:'三份原商品损坏，按新批制作',eventKey:randomUUID()}))
    await remake((_repo,tx)=>new QuantityRemakeFulfillmentRepository(tx).act({taskId:batch.taskId,employeeId,action:'complete',quantity:2,eventKey:randomUUID()}))
    await remake((_repo,tx)=>new QuantityRemakeFulfillmentRepository(tx).act({taskId:batch.taskId,employeeId,action:'deliver',quantity:1,eventKey:randomUUID()}))
    const runtimeTransactions={run:<T>(current:typeof scope,operation:(tx:import('./transaction-runner.js').ScopedTransaction)=>Promise<T>)=>runner.run(current,async tx=>{await tx.query('SET LOCAL ROLE mbox_runtime');return operation(tx)})} as ScopedPostgresTransactionRunner
    if(kind==='automatic_cutoff'){
      await pool.query("UPDATE mbox.table_sessions SET business_date='2026-09-12' WHERE id=$1",[source.id])
      await pool.query("INSERT INTO mbox.store_automatic_table_turnover_policies(tenant_id,store_id,enabled,operating_starts_at) VALUES($1,$2,true,TIME '12:00') ON CONFLICT(tenant_id,store_id) DO UPDATE SET enabled=true",[tenantId,storeId])
    }
    const key=randomUUID(),close=()=>kind==='order_cancel'?new PostgresOrderCancellationRepository(runtimeTransactions).cancel({scope,employeeId,orderId:row.orderId,businessDate:businessDate,reasonCode:'guest_left',reasonNote:'客人离店，保留实际新批实物记录',idempotencyKey:key}):runtimeTransactions.run(scope,tx=>kind==='customer_left'?new PostgresTableCustomerLeftTurnoverRepository(tx).close({scope,employeeId,tableSessionId:source.id,businessDate:businessDate,reasonNote:'客人离店，保留实际新批实物记录',idempotencyKey:key}):new PostgresAutomaticTableTurnoverRepository(tx).close({scope,tableSessionId:source.id,businessDate:businessDate,reasonNote:'营业结束，原批及新批实物交接',idempotencyKey:key}))
    const first=await close();expect(await close()).toMatchObject({eventId:first.eventId,replayed:true})
    if(kind!=='order_cancel')expect(first).toMatchObject({deliveredUnpaidAmountMinor:800})
    expect(await balance(stockId)).toEqual({on_hand:'3.000000',reserved:'0.000000'})
    const current=await remake(repo=>repo.read(batch.id))
    expect(current.units.map(unit=>({state:unit.production_state,cancelled:!!unit.cancelled_at}))).toEqual([{state:'delivered',cancelled:false},{state:'ready',cancelled:false},{state:'unmade',cancelled:true}])
    expect((await pool.query('SELECT operationally_stopped FROM mbox.order_item_quantity_units WHERE id=$1',[batch.units[0]!.unit_id])).rows[0].operationally_stopped).toBe(false)
    await expect(remake((_repo,tx)=>new QuantityRemakeFulfillmentRepository(tx).act({taskId:batch.taskId,employeeId,action:'deliver',quantity:1,eventKey:randomUUID()}))).rejects.toThrow('任务已结束')
    const handover=new QuantityRemakeHandoverQuery(runner),visible=await handover.list({scope,employeeId})
    expect(visible.items.find(value=>value.batchId===batch.id)).toMatchObject({pendingQuantity:1,unitIds:[batch.units[1]!.id],canReceive:true})
    const disposals=new QuantityRemakeHandoverCommand(new NormalizedCommandExecutor(runtimeTransactions)),command={scope,employeeId,businessDate:businessDate,idempotencyKey:randomUUID(),batchId:batch.id,unitIds:[batch.units[1]!.id],disposition:'returned_unopened' as const,unopenedReceived:true,reason:'离店后新瓶实际收回且未开封'}
    const recorded=await disposals.dispose(command),recovered=await disposals.dispose(command)
    expect(recorded.value).toMatchObject({batchId:batch.id,itemId:row.itemId,remainingQuantity:0});expect(recovered).toMatchObject({replayed:true,value:recorded.value})
    expect((await handover.list({scope,employeeId})).items.some(value=>value.batchId===batch.id)).toBe(false)
    expect(await balance(stockId)).toEqual({on_hand:'4.000000',reserved:'0.000000'})
    expect((await pool.query("SELECT count(*)::int n FROM mbox.inventory_movements WHERE inventory_item_id=$1 AND movement_type='return'",[stockId])).rows[0].n).toBe(1)
  })
  it('creates an explicit successor only for the selected actual previous batch and retains every independent consumption',async()=>{
    await grantActor(employeeId,['kds.exception.manage'])
    const row=await deliveredOriginal(),first=await remake(repo=>repo.create({itemId:row.itemId,employeeId,quantity:2,originalGoodsLost:true,reason:'原两份无法交付，另批制作',eventKey:randomUUID()}))
    await remake((_repo,tx)=>new QuantityRemakeFulfillmentRepository(tx).act({taskId:first.taskId,employeeId,action:'complete',quantity:2,eventKey:randomUUID()}))
    const input={itemId:row.itemId,employeeId,quantity:1,originalGoodsLost:true,reason:'上一批其中一份做错，再准备一份',eventKey:randomUUID(),previousBatchId:first.id}
    const second=await remake(repo=>repo.create(input))
    expect(second.units.map(unit=>unit.unit_id)).toEqual([first.units[0]!.unit_id])
    const link=(await pool.query('SELECT generation,previous_remake_unit_id FROM mbox.quantity_remake_units WHERE id=$1',[second.units[0]!.id])).rows[0]
    expect(link).toEqual({generation:2,previous_remake_unit_id:first.units[0]!.id})
    const old=await remake(repo=>repo.read(first.id));expect(old.units.map(unit=>!!unit.cancelled_at)).toEqual([true,false])
    expect((await pool.query('SELECT status FROM mbox.kds_tasks WHERE id=$1',[first.taskId])).rows[0].status).toBe('ready')
    const source=(await pool.query('SELECT source_original_stock_id,source_remake_stock_id FROM mbox.quantity_remake_stocks WHERE remake_unit_id=$1',[second.units[0]!.id])).rows[0]
    expect(source.source_original_stock_id).toBeNull();expect(source.source_remake_stock_id).toBeTruthy()
    await remake(repo=>repo.consume({batchId:second.id,unitIds:[second.units[0]!.id],employeeId}))
    expect(await balance(row.stockId)).toEqual({on_hand:'2.000000',reserved:'0.000000'})
    const movements=(await pool.query('SELECT movement_type,quantity_delta::text FROM mbox.inventory_movements WHERE inventory_item_id=$1 ORDER BY occurred_at,id',[row.stockId])).rows
    expect(movements.filter(value=>value.movement_type==='sale')).toEqual([{movement_type:'sale',quantity_delta:'-5.000000'}])
    expect(movements.filter(value=>value.movement_type==='waste')).toHaveLength(3)
    await expect(remake(repo=>repo.create({...input,quantity:2,eventKey:randomUUID()}))).rejects.toThrow('当前可重新制作 1 份')
  })
  for(const disposition of ['released','returned'] as const)it(`starts a new physical generation after prior ${disposition} without rewriting that disposition as another loss`,async()=>{
    await grantActor(employeeId,['kds.exception.manage'])
    const row=await deliveredOriginal(),first=await remake(repo=>repo.create({itemId:row.itemId,employeeId,quantity:1,originalGoodsLost:true,reason:'原一份损坏需要重做',eventKey:randomUUID()})),part=first.units[0]!
    if(disposition==='released')await remake(repo=>repo.releaseUnmade({batchId:first.id,unitIds:[part.id],reason:'上批尚未制作，先结束预留'}))
    else{await remake(repo=>repo.consume({batchId:first.id,employeeId,unitIds:[part.id]}));await remake(repo=>repo.disposeMade({batchId:first.id,employeeId,unitIds:[part.id],reason:'上批实物已收回且未开封',disposition:'returned_unopened',unopenedReceived:true}))}
    const second=await remake(repo=>repo.create({itemId:row.itemId,employeeId,quantity:1,originalGoodsLost:true,reason:'原商品仍需提供，明确另开一批',eventKey:randomUUID(),previousBatchId:first.id}))
    expect((await pool.query('SELECT status FROM mbox.quantity_remake_stocks WHERE remake_unit_id=$1',[part.id])).rows[0].status).toBe(disposition)
    expect(await balance(row.stockId)).toEqual({on_hand:'5.000000',reserved:'1.000000'})
    await remake(repo=>repo.consume({batchId:second.id,employeeId,unitIds:second.units.map(unit=>unit.id)}))
    expect(await balance(row.stockId)).toEqual({on_hand:'4.000000',reserved:'0.000000'})
    await expect(remake(repo=>repo.create({itemId:row.itemId,employeeId,quantity:1,originalGoodsLost:true,reason:'旧批已接续不能再次使用',eventKey:randomUUID(),previousBatchId:first.id}))).rejects.toThrow('前一批已经接续')
  })
  it('rolls back prior remake loss when successor materials are insufficient and serializes competing successors',async()=>{
    await grantActor(employeeId,['kds.exception.manage'])
    const row=await deliveredOriginal(),first=await remake(repo=>repo.create({itemId:row.itemId,employeeId,quantity:3,originalGoodsLost:true,reason:'原三份需另批制作',eventKey:randomUUID()}))
    await remake(repo=>repo.consume({batchId:first.id,employeeId,unitIds:first.units.map(unit=>unit.id)}))
    const input={itemId:row.itemId,employeeId,quantity:3,originalGoodsLost:true,reason:'上一批仍不能交付需要再做',eventKey:randomUUID(),previousBatchId:first.id}
    await expect(remake(repo=>repo.create(input))).rejects.toThrow('材料不足')
    expect((await remake(repo=>repo.read(first.id))).units.every(unit=>!unit.cancelled_at)).toBe(true)
    expect((await pool.query('SELECT DISTINCT status FROM mbox.quantity_remake_stocks WHERE remake_unit_id=ANY($1::uuid[])',[first.units.map(unit=>unit.id)])).rows).toEqual([{status:'consumed'}])
    const other=await deliveredOriginal(),single=await remake(repo=>repo.create({itemId:other.itemId,employeeId,quantity:1,originalGoodsLost:true,reason:'另一原瓶需要重做',eventKey:randomUUID()}))
    await remake(repo=>repo.consume({batchId:single.id,employeeId,unitIds:single.units.map(unit=>unit.id)}))
    const next={...input,itemId:other.itemId,previousBatchId:single.id,quantity:1}
    const outcomes=await Promise.allSettled([remake(repo=>repo.create({...next,eventKey:randomUUID()})),remake(repo=>repo.create({...next,eventKey:randomUUID()}))])
    expect(outcomes.filter(value=>value.status==='fulfilled')).toHaveLength(1)
    expect((await pool.query('SELECT count(*)::int n FROM mbox.quantity_remake_units WHERE previous_remake_unit_id=$1',[single.units[0]!.id])).rows[0].n).toBe(1)
  })
  async function freshTableSession(){
    const id=randomUUID(),venueId=randomUUID()
    await pool.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,$5,'Quantity closure',8)",[venueId,tenantId,storeId,areaId,`Q-${venueId.slice(0,24)}`])
    await pool.query(`INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1,$2,$3,$4,$5,'${businessDate}',2)`,[id,tenantId,storeId,venueId,`quantity-closure-${id}`])
    return {id,tableId:venueId}
  }
  async function previewSession(source:string,target:{id:string;tableId:string}){
    const app=Fastify()
    await app.register(tableManagementApiPlugin,{transactions:runner,commands:{} as never,resolveContext:()=>({scope,employeeId,businessDate:businessDate,capabilities:['table.participation.manage']})})
    try{
      const result=await app.inject({method:'POST',url:`/table-management/sessions/${source}/participant-movements/preview`,payload:{movementKind:'participant_merge',targetTableId:target.tableId,targetTableSessionId:target.id,movedGuestCount:2,participantPublicIds:[]}})
      expect(result.statusCode).toBe(200)
      return result.json().data as {blockers:Array<{code:string;count:number}>}
    }finally{await app.close()}
  }
  async function mergeSession(source:string,target:{id:string;tableId:string}){
    return runner.run(scope,async tx=>{
      await tx.query('SET LOCAL ROLE mbox_runtime')
      return tx.query(`SELECT * FROM mbox.execute_table_customer_movement('participant_merge',$1::uuid,$2::uuid,$3::uuid,2,'{}'::uuid[],'{}'::text[],'{}'::text[],$4::uuid,'数量已完成，客人合桌',$5,repeat('a',64)::char(64),NULL,NULL,'{}')`,[source,target.id,target.tableId,employeeId,`quantity-merge-${randomUUID()}`])
    })
  }
  function cashInput(){return {publicId:`quantity-cash-${randomUUID()}`,provider:'cash' as const,method:'cash' as const,initialStatus:'succeeded' as const,
    principal:{type:'employee' as const,employeeId},providerTransactionId:`quantity-receipt-${randomUUID()}`,evidence:{receiptReference:'quantity test cash',collectedByEmployeeId:employeeId}}}
  for(const paid of [false,true])it(`pauses exact bundle components without treating their zero operational price as a free refund (${paid?'paid':'unpaid'})`,async()=>{
    await grantActor(employeeId,['refund.request','kds.deliver','fulfillment.view_all']);await grantActor(reviewerId,['refund.approve'],100000)
    const row=await item(),stockId=await stock(row,'reserved'),parentId=randomUUID(),siblingId=randomUUID(),siblingTaskId=randomUUID()
    await pool.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot)
      VALUES($1,$2,$3,$4,$5,1,4000,4000,'none','{"name":"原套餐","inventoryControlMode":"not_managed"}')`,[parentId,tenantId,storeId,row.orderId,productId])
    await pool.query(`UPDATE mbox.order_items SET parent_order_item_id=$2::uuid,unit_price_minor=0,total_amount_minor=0,
      product_snapshot=product_snapshot||jsonb_build_object('paidByParentOrderItemId',$2::uuid::text) WHERE id=$1`,[row.itemId,parentId])
    await pool.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,parent_order_item_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot)
      VALUES($1,$2,$3,$4,$5,$6,1,0,0,'kitchen','{"name":"套餐小食","inventoryControlMode":"not_managed"}')`,[siblingId,tenantId,storeId,row.orderId,productId,parentId])
    await pool.query(`INSERT INTO mbox.kds_tasks(id,tenant_id,store_id,order_item_id,station_code,quantity,status) VALUES($1,$2,$3,$4,'kitchen',1,'pending')`,[siblingTaskId,tenantId,storeId,siblingId])
    if(paid)await payment(row.orderId)
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    const input={scope,employeeId,businessDate:businessDate,orderItemId:row.itemId,quantity:2,reason:'套餐两瓶先暂停，金额按原套餐另行核对',idempotencyKey:`bundle-hold-${randomUUID()}`}
    const before=await new ItemAfterSalesQuery(runner).item({scope,employeeId,itemId:row.itemId})
    expect(before.canRequest).toBe(true)
    const request=await service.request(input),caseId=request.value.caseId
    expect(request.value).toMatchObject({kind:paid?'paid_return':'unpaid_stop',status:'requested',selectedQuantity:2,heldQuantity:2,stoppedQuantity:0,amountMinor:null,moneyComplete:false,refunds:[]})
    expect(await service.request(input)).toEqual({...request,replayed:true})
    expect(await balance(stockId)).toEqual({on_hand:'10.000000',reserved:'5.000000'})
    expect(await runner.run(scope,async tx=>(await tx.query('SELECT total_amount_minor::text AS total,mbox.order_receivable_amount(tenant_id,store_id,id)::text AS effective FROM mbox.orders WHERE id=$1',[row.orderId])).rows[0])).toEqual({total:'4000',effective:'4000'})
    const customer=randomUUID()
    await pool.query('INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1,$2,$3,$4)',[customer,tenantId,storeId,`bundle-guest-${customer}`])
    const guest=(await runner.run(scope,tx=>loadGuestTableOrders(tx,sessionId,customer),{readOnly:true})).find(order=>order.publicId===`quantity-${row.orderId}`)!
    expect(guest.items.find(value=>value.id===parentId)?.components).toEqual(expect.arrayContaining([expect.objectContaining({quantity:5,progressText:'暂停 2 份 · 准备中 3 份'})]))
    expect(guest.paymentAccess).toBe(paid?'not_required':'status_review')
    expect(JSON.stringify(guest)).not.toMatch(/quantity_facts|caseId|employeeId|requestedBy|refundId/)
    const review=await new ItemAfterSalesQuery(runner).item({scope,employeeId:reviewerId,itemId:row.itemId})
    expect(review.item).toMatchObject({bundle:true,includedInBundle:true});expect(review.cases[0]!.canApprove).toBe(false)
    await expect(service.decide({scope,employeeId:reviewerId,businessDate:businessDate,caseId,decision:'approved',reason:'不能把套餐组成行的零元当实际退款',idempotencyKey:`bundle-approve-${randomUUID()}`})).rejects.toThrow()
    expect((await pool.query('SELECT status,quantity FROM mbox.kds_tasks WHERE id=$1',[siblingTaskId])).rows[0]).toEqual({status:'pending',quantity:1})
    expect((await pool.query('SELECT station_code FROM mbox.item_after_sales_notices WHERE case_id=$1',[caseId])).rows).toEqual([{station_code:'bar'}])
    expect((await new ItemAfterSalesQuery(runner).item({scope,employeeId,itemId:parentId})).canRequest).toBe(false)
    await expect(service.request({...input,orderItemId:parentId,quantity:1,idempotencyKey:`bundle-header-${randomUUID()}`})).rejects.toThrow('套餐')
    const task={id:row.taskId,orderItemId:row.itemId,remakeOfTaskId:null,stationCode:'bar' as const,status:'pending' as const,priority:100,quantity:5,assignedEmployeeId:null,dueAt:null,nextActionAt:new Date().toISOString(),acceptedAt:null,readyAt:null,cancelledAt:null}
    await runner.run(scope,tx=>executeQuantityKdsAction(tx,{task,employeeId,action:'complete',quantity:3,eventKey:`bundle-complete-${randomUUID()}`}))
    expect(await balance(stockId)).toEqual({on_hand:'7.000000',reserved:'2.000000'})
    await service.decide({scope,employeeId,businessDate:businessDate,caseId,decision:'withdrawn',reason:'客人明确保留套餐，先撤回原申请',idempotencyKey:`bundle-withdraw-${randomUUID()}`})
    expect((await new ItemAfterSalesQuery(runner).item({scope,employeeId,itemId:row.itemId})).cases[0]).toMatchObject({status:'withdrawn',heldQuantity:2,canResume:true})
    await service.resume({scope,employeeId,businessDate:businessDate,caseId,reason:'已联系吧台，客人确认继续原两瓶',idempotencyKey:`bundle-resume-${randomUUID()}`})
    expect((await pool.query('SELECT count(*)::int AS count FROM mbox.order_item_quantity_units WHERE order_item_id=$1 AND held_by_case_id IS NOT NULL',[row.itemId])).rows[0].count).toBe(0)
    expect(await balance(stockId)).toEqual({on_hand:'7.000000',reserved:'2.000000'})
  })
  for(const revisedQuantity of [1,2,3])it(`revises an unreviewed paid case to ${revisedQuantity} units, retaining old holds and one new decision`,async()=>{
    await grantActor(employeeId,['refund.request']);await grantActor(reviewerId,['refund.approve'],100000)
    const row=await item(),stockId=await stock(row,'reserved');await payment(row.orderId)
    const runtimeTransactions={run:<T>(current:typeof scope,operation:(tx:import('./transaction-runner.js').ScopedTransaction)=>Promise<T>)=>runner.run(current,async tx=>{await tx.query('SET LOCAL ROLE mbox_runtime');return operation(tx)})} as ScopedPostgresTransactionRunner
    const commands=new NormalizedCommandExecutor(runtimeTransactions),service=new ItemAfterSalesCommandService(commands,new ItemAfterSalesOperatingEffects())
    const metadata={scope,employeeId,businessDate:businessDate,reason:'客人先停两瓶'}
    const original=await service.request({...metadata,orderItemId:row.itemId,quantity:2,idempotencyKey:`revise-source-${randomUUID()}`}),oldId=original.value.caseId
    const oldUnits=(await pool.query('SELECT unit_id FROM mbox.item_after_sales_case_units WHERE case_id=$1 ORDER BY unit_id',[oldId])).rows.map(unit=>unit.unit_id)
    const input={...metadata,caseId:oldId,quantity:revisedQuantity,reason:'现场重新确认数量，旧申请保留',idempotencyKey:`revision-${randomUUID()}`}
    const updated=await service.revise(input),newId=updated.value.caseId
    expect(updated.value).toMatchObject({revisesCaseId:oldId,status:'requested',selectedQuantity:revisedQuantity,heldQuantity:revisedQuantity,amountMinor:revisedQuantity*800})
    expect(await service.revise({...input,businessDate:nextBusinessDate})).toEqual({...updated,replayed:true})
    expect(await new ItemAfterSalesCommandService(commands,new ItemAfterSalesOperatingEffects(),false).revise(input)).toEqual({...updated,replayed:true})
    await expect(service.revise({...input,quantity:4})).rejects.toThrow('conflicts with another request')
    const old=await runner.run(scope,tx=>new ItemAfterSalesProgressRepository(tx).read(oldId))
    expect(old).toMatchObject({status:'withdrawn',revisedByCaseId:newId,heldQuantity:Math.max(0,2-revisedQuantity),stoppedQuantity:0,refunds:[{status:'cancelled'}]})
    const assigned=(await pool.query('SELECT unit_id FROM mbox.item_after_sales_case_units WHERE case_id=$1',[newId])).rows.map(unit=>unit.unit_id)
    expect(assigned.filter(id=>oldUnits.includes(id))).toHaveLength(Math.min(2,revisedQuantity))
    expect(await balance(stockId)).toEqual({on_hand:'10.000000',reserved:'5.000000'})
    await expect(service.decide({...metadata,employeeId:reviewerId,caseId:oldId,decision:'approved',idempotencyKey:`old-review-${randomUUID()}`})).rejects.toThrow()
    await expect(service.decide({...metadata,caseId:newId,decision:'approved',idempotencyKey:`self-review-${randomUUID()}`})).rejects.toThrow()
    const approved=await service.decide({...metadata,employeeId:reviewerId,caseId:newId,decision:'approved',idempotencyKey:`new-review-${randomUUID()}`})
    expect(approved.value).toMatchObject({status:'approved',stoppedQuantity:revisedQuantity,awaitingCashPayout:true,succeededMinor:0})
    expect(await balance(stockId)).toEqual({on_hand:'10.000000',reserved:`${5-revisedQuantity}.000000`})
    await expect(service.revise({...input,caseId:newId,idempotencyKey:`approved-revise-${randomUUID()}`})).rejects.toThrow('尚未审核')
    const workspace=await new ItemAfterSalesQuery(runner).item({scope,employeeId,itemId:row.itemId})
    expect(workspace.cases.find(value=>value.caseId===newId)!.canRevise).toBe(false)
    if(revisedQuantity===1){
      expect(workspace.cases.find(value=>value.caseId===oldId)).toMatchObject({heldQuantity:1,canResume:true})
      await service.resume({...metadata,caseId:oldId,reason:'客人确认保留减少的这一份',idempotencyKey:`old-remainder-${randomUUID()}`})
      expect((await pool.query('SELECT held_by_case_id,stopped_by_case_id FROM mbox.order_item_quantity_units WHERE order_item_id=$1 ORDER BY unit_index',[row.itemId])).rows.filter(unit=>unit.held_by_case_id)).toHaveLength(0)
      expect(await balance(stockId)).toEqual({on_hand:'10.000000',reserved:'4.000000'})
    }
  })
  it('rolls back a failed revision, denies another requester and leaves the original review usable',async()=>{
    await grantActor(employeeId,['refund.request']);await grantActor(reviewerId,['refund.request','refund.approve'],100000)
    const row=await item();await stock(row,'reserved');await payment(row.orderId)
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    const metadata={scope,employeeId,businessDate:businessDate,reason:'原申请待审核'}
    const original=await service.request({...metadata,orderItemId:row.itemId,quantity:2,idempotencyKey:`revision-fail-source-${randomUUID()}`}),caseId=original.value.caseId
    const input={...metadata,caseId,quantity:6,idempotencyKey:`revision-too-many-${randomUUID()}`}
    await expect(service.revise(input)).rejects.toThrow('当前最多')
    await expect(service.revise({...input,quantity:1,employeeId:reviewerId,idempotencyKey:`revision-other-${randomUUID()}`})).rejects.toThrow('本人')
    expect(await runner.run(scope,tx=>new ItemAfterSalesProgressRepository(tx).read(caseId))).toEqual(original.value)
    expect((await pool.query('SELECT count(*)::int n FROM mbox.item_after_sales_case_revisions WHERE previous_case_id=$1',[caseId])).rows[0].n).toBe(0)
    expect((await service.decide({...metadata,employeeId:reviewerId,caseId,decision:'approved',idempotencyKey:`revision-original-approve-${randomUUID()}`})).value).toMatchObject({status:'approved',stoppedQuantity:2,awaitingCashPayout:true})
  })
  it('serializes original approval against revision without approving both versions',async()=>{
    await grantActor(employeeId,['refund.request']);await grantActor(reviewerId,['refund.approve'],100000)
    const row=await item(),stockId=await stock(row,'reserved');await payment(row.orderId)
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    const metadata={scope,employeeId,businessDate:businessDate,reason:'并发修改和审核'}
    const source=await service.request({...metadata,orderItemId:row.itemId,quantity:2,idempotencyKey:`revision-race-source-${randomUUID()}`}),caseId=source.value.caseId
    const results=await Promise.allSettled([
      service.revise({...metadata,caseId,quantity:1,idempotencyKey:`revision-race-${randomUUID()}`}),
      service.decide({...metadata,employeeId:reviewerId,caseId,decision:'approved',idempotencyKey:`review-race-${randomUUID()}`}),
    ])
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1)
    const refunds=(await pool.query('SELECT status,amount_minor::text AS amount FROM mbox.refunds WHERE order_id=$1',[row.orderId])).rows
    if(results[0]!.status==='fulfilled'){
      expect(refunds.filter(refund=>refund.status==='requested')).toEqual([{status:'requested',amount:'800'}])
      expect(refunds.filter(refund=>refund.status==='approved')).toHaveLength(0)
      expect(await balance(stockId)).toEqual({on_hand:'10.000000',reserved:'5.000000'})
    }else{
      expect(refunds).toEqual([{status:'approved',amount:'1600'}])
      expect(await balance(stockId)).toEqual({on_hand:'10.000000',reserved:'3.000000'})
    }
  })
  it('revises an unknown partial discount to the original whole unpaid line without guessing a unit price',async()=>{
    await grantActor(employeeId,['refund.request'])
    const row=await item('pending',100),stockId=await stock(row,'reserved')
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    const metadata={scope,employeeId,businessDate:businessDate,reason:'先暂停含优惠的两份'}
    const original=await service.request({...metadata,orderItemId:row.itemId,quantity:2,idempotencyKey:`revise-discount-source-${randomUUID()}`})
    expect(original.value).toMatchObject({amountMinor:null,status:'requested',heldQuantity:2})
    const updated=await service.revise({...metadata,caseId:original.value.caseId,quantity:5,reason:'客人确认原行五份全部不要了',idempotencyKey:`revise-whole-discount-${randomUUID()}`})
    expect(updated.value).toMatchObject({amountMinor:3900,status:'completed',stoppedQuantity:5,physicalComplete:true,moneyComplete:true,refunds:[],revisesCaseId:original.value.caseId})
    expect(await balance(stockId)).toEqual({on_hand:'10.000000',reserved:'0.000000'})
    const facts=(await pool.query('SELECT case_id,amount_minor::text AS amount FROM mbox.item_receivable_adjustments WHERE order_id=$1',[row.orderId])).rows
    expect(facts).toEqual([{case_id:updated.value.caseId,amount:'3900'}])
    expect((await pool.query('SELECT count(*)::int n FROM mbox.order_item_quantity_units WHERE order_item_id=$1 AND original_amount_minor IS NULL',[row.itemId])).rows[0].n).toBe(5)
  })
  for(const discount of [0,100])it(`shows actual quantity progress to the guest and holds payment only when the item amount is unresolved (${discount})`,async()=>{
    await grantActor(employeeId,['refund.request'])
    const customer=randomUUID(),row=await item('pending',discount)
    await pool.query('INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1,$2,$3,$4)',[customer,tenantId,storeId,`quantity-guest-${customer}`])
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    await service.request({scope,employeeId,businessDate:businessDate,orderItemId:row.itemId,quantity:2,reason:'客人取消原商品两份',idempotencyKey:`guest-quantity-${randomUUID()}`})
    const guest=(await runner.run(scope,tx=>loadGuestTableOrders(tx,sessionId,customer),{readOnly:true})).find(order=>order.publicId===`quantity-${row.orderId}`)!
    expect(guest).toMatchObject({totalAmountMinor:4000-discount,receivableReductionMinor:discount?0:1600,settlementReviewRequired:discount>0,paymentAccess:discount?'status_review':'available',payableAmountMinor:discount?0:2400,
      items:[{quantity:5,totalAmountMinor:4000-discount,progressText:discount?'暂停 2 份 · 准备中 3 份':'已停止 2 份 · 准备中 3 份'}]})
    expect(JSON.stringify(guest)).not.toMatch(/caseId|employeeId|requestedBy|refundId|providerTransaction/)
  })
  async function replacementOrder(caseId:string,visitId=sessionId,failAfter=false,previousOrderId?:string){
    return runner.run(scope,async tx=>{
      await tx.query('SET LOCAL ROLE mbox_runtime')
      const repository=new ItemAfterSalesReplacementRepository(tx)
      await repository.lockSource({caseId,employeeId,tableSessionId:visitId,previousOrderId})
      const id=randomUUID()
      await tx.query(`INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,submitted_at,subtotal_amount_minor,total_amount_minor,created_by_employee_id)
        VALUES($1,$2,$3,$4,$5,'staff_assisted','submitted',clock_timestamp(),6000,6000,$6)`,[id,tenantId,storeId,visitId,`replacement-${id}`,employeeId])
      await tx.query(`INSERT INTO mbox.order_items(tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot)
        VALUES($1,$2,$3,$4,1,6000,6000,'bar','{"name":"正常价格的新商品","inventoryControlMode":"not_managed"}')`,[tenantId,storeId,id,productId])
      await repository.link({caseId,orderId:id,employeeId,previousOrderId})
      if(failAfter)throw new Error('replacement stock unavailable')
      return id
    })
  }
  it('links a separately priced replacement without refund approval and retains the link after revising or withdrawing the original case',async()=>{
    await grantActor(employeeId,['refund.request','order.create'])
    const row=await item(),stockId=await stock(row,'reserved');await payment(row.orderId)
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    const metadata={scope,employeeId,businessDate:businessDate,reason:'客人希望换另一种酒'}
    const original=await service.request({...metadata,orderItemId:row.itemId,quantity:2,idempotencyKey:`replacement-original-${randomUUID()}`})
    const caseId=original.value.caseId,newId=await replacementOrder(caseId)
    const progress=await runner.run(scope,tx=>new ItemAfterSalesProgressRepository(tx).read(caseId))
    expect(progress).toMatchObject({status:'requested',heldQuantity:2,succeededMinor:0,replacementOrder:{orderId:newId,sourceCaseId:caseId}})
    expect(await balance(stockId)).toEqual({on_hand:'10.000000',reserved:'5.000000'})
    const amounts=(await pool.query('SELECT total_amount_minor::text AS amount FROM mbox.orders WHERE id=ANY($1::uuid[]) ORDER BY total_amount_minor',[[row.orderId,newId]])).rows
    expect(amounts).toEqual([{amount:'4000'},{amount:'6000'}])
    expect((await pool.query("SELECT has_table_privilege('mbox_runtime','mbox.stores','UPDATE') AS permitted")).rows[0].permitted).toBe(false)
    await expect(runner.run(scope,async tx=>{await tx.query('SET LOCAL ROLE mbox_runtime');await tx.query(`INSERT INTO mbox.orders(tenant_id,store_id,table_session_id,public_id,channel,status,submitted_at,subtotal_amount_minor,total_amount_minor) VALUES($1,$2,$3,$4,'staff_assisted','submitted',clock_timestamp(),1,1)`,[randomUUID(),storeId,sessionId,`foreign-${randomUUID()}`])})).rejects.toThrow('scope mismatch')
    const newDetails=(await runner.run(scope,tx=>listTableOrderDetailsForSession(tx,sessionId))).find(value=>value.publicId===`replacement-${newId}`)!
    expect(newDetails).toMatchObject({replacementSource:{orderPublicId:`quantity-${row.orderId}`,orderItemId:row.itemId},totalAmountMinor:6000,items:[{quantity:1,totalAmountMinor:6000}]})
    await expect(runner.run(scope,async tx=>{await tx.query('SET LOCAL ROLE mbox_runtime');await tx.query('DELETE FROM mbox.item_after_sales_replacement_orders WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3',[tenantId,storeId,newId])})).rejects.toThrow()
    const revised=await service.revise({...metadata,caseId,quantity:1,idempotencyKey:`replacement-revise-${randomUUID()}`})
    expect(revised.value.replacementOrder).toMatchObject({orderId:newId,sourceCaseId:caseId})
    await expect(replacementOrder(revised.value.caseId)).rejects.toThrow('已有换品新单')
    const withdrawn=await service.decide({...metadata,caseId:revised.value.caseId,decision:'withdrawn',idempotencyKey:`replacement-withdraw-${randomUUID()}`})
    expect(withdrawn.value).toMatchObject({status:'withdrawn',replacementOrder:{orderId:newId},succeededMinor:0})
    expect((await pool.query('SELECT status,total_amount_minor::text AS amount FROM mbox.orders WHERE id=$1',[newId])).rows[0]).toEqual({status:'submitted',amount:'6000'})
    expect((await new ItemAfterSalesQuery(runner).item({scope,employeeId,itemId:row.itemId})).cases.every(value=>!value.canReplace)).toBe(true)
  })
  it('rolls back replacement association with a failed new order and serializes two different new orders for the same original case',async()=>{
    await grantActor(employeeId,['refund.request','order.create'])
    const row=await item(),original=await stopUnpaid(row,2)
    await expect(replacementOrder(original.caseId,sessionId,true)).rejects.toThrow('stock unavailable')
    expect((await pool.query('SELECT count(*)::int n FROM mbox.item_after_sales_replacement_orders WHERE case_id=$1',[original.caseId])).rows[0].n).toBe(0)
    const results=await Promise.allSettled([replacementOrder(original.caseId),replacementOrder(original.caseId)])
    expect(results.filter(value=>value.status==='fulfilled')).toHaveLength(1)
    expect(results.filter(value=>value.status==='rejected')).toHaveLength(1)
    expect((await pool.query('SELECT count(*)::int n FROM mbox.item_after_sales_replacement_orders WHERE case_id=$1',[original.caseId])).rows[0].n).toBe(1)
    const facts=await runner.run(scope,tx=>new ItemAfterSalesProgressRepository(tx).read(original.caseId))
    expect(facts).toMatchObject({stoppedQuantity:2,amountMinor:1600,succeededMinor:0,moneyComplete:true})
  })
  it('allows an explicit new replacement after its previous order is cancelled without losing either record or allowing a fork',async()=>{
    await grantActor(employeeId,['refund.request','order.create','order.cancel_unpaid'])
    const row=await item(),source=await stopUnpaid(row,1),first=await replacementOrder(source.caseId)
    await expect(replacementOrder(source.caseId,sessionId,false,first)).rejects.toThrow('已有换品新单')
    await new PostgresOrderCancellationRepository(runner).cancel({scope,employeeId,orderId:first,businessDate:businessDate,reasonCode:'other',reasonNote:'客人不要这份新商品，改选另一种',idempotencyKey:`replacement-cancel-${randomUUID()}`})
    const read=await new ItemAfterSalesQuery(runner).item({scope,employeeId,itemId:row.itemId})
    expect(read.cases.find(value=>value.caseId===source.caseId)).toMatchObject({canReplace:true,replacementOrder:{orderId:first,status:'cancelled'}})
    await expect(replacementOrder(source.caseId)).rejects.toThrow('已有换品新单')
    const attempts=await Promise.allSettled([replacementOrder(source.caseId,sessionId,false,first),replacementOrder(source.caseId,sessionId,false,first)])
    expect(attempts.filter(value=>value.status==='fulfilled')).toHaveLength(1)
    const latest=(await runner.run(scope,tx=>new ItemAfterSalesProgressRepository(tx).read(source.caseId))).replacementOrder!
    expect(latest.orderId).not.toBe(first);expect(latest.status).toBe('submitted')
    expect((await pool.query('SELECT count(*)::int n FROM mbox.item_after_sales_replacement_orders WHERE root_case_id=$1',[source.caseId])).rows[0].n).toBe(2)
    await expect(replacementOrder(source.caseId,sessionId,false,first)).rejects.toThrow('已有换品新单')
  })
  it('rejects another table visit, closed visits and an actor without order creation while preserving the original stop',async()=>{
    await grantActor(employeeId,['refund.request','order.create']);await grantActor(reviewerId,['refund.request'])
    const originalVisit=await freshTableSession(),otherVisit=await freshTableSession(),row=await item('pending',0,originalVisit.id),original=await stopUnpaid(row,1)
    await expect(replacementOrder(original.caseId,otherVisit.id)).rejects.toThrow('原桌次')
    await expect(runner.run(scope,tx=>new ItemAfterSalesReplacementRepository(tx).lockSource({caseId:original.caseId,employeeId:reviewerId,tableSessionId:originalVisit.id}))).rejects.toThrow()
    await pool.query("UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp() WHERE id=$1",[originalVisit.id])
    await expect(replacementOrder(original.caseId,originalVisit.id)).rejects.toThrow('原桌次已结束')
    expect((await pool.query('SELECT count(*)::int n FROM mbox.item_after_sales_replacement_orders WHERE case_id=$1',[original.caseId])).rows[0].n).toBe(0)
  })
  it('closes the remaining receivable and reservation after partial stop, exact collection and delivery',async()=>{
    await grantActor(employeeId,['refund.request','order.cancel_unpaid','table.transfer','table.participation.manage'])
    const source=await freshTableSession(),target=await freshTableSession(),row=await item('pending',0,source.id),stockId=await stock(row,'reserved')
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    await service.request({scope,employeeId,businessDate:businessDate,orderItemId:row.itemId,quantity:2,reason:'未制作两份不要了',idempotencyKey:`closure-stop-${randomUUID()}`})
    const state=()=>runner.run(scope,tx=>readTableSessionClosureState(tx,source.id))
    expect(await state()).toMatchObject({outstandingAmountMinor:2400})
    const reserved=await runner.run(scope,tx=>readBusinessDayBlockerFacts(tx,source.id,'INVENTORY_RESERVED'))
    expect(reserved).toHaveLength(1);expect(Number(reserved[0].quantityText!.split(' ')[0])).toBe(3)
    expect((await state()).blockers.some(value=>value.code==='INVENTORY_RESERVED')).toBe(true)
    expect((await previewSession(source.id,target)).blockers.map(value=>value.code)).toEqual(expect.arrayContaining(['ORDER_UNSETTLED','INVENTORY_RESERVED','KDS_ACTIVE']))
    await runner.run(scope,tx=>new PaymentRepository(tx).createForOrder({...cashInput(),orderId:row.orderId}))
    const afterPayment=(await previewSession(source.id,target)).blockers.map(value=>value.code)
    expect(afterPayment).not.toContain('ORDER_UNSETTLED');expect(afterPayment).toContain('INVENTORY_RESERVED')
    await runner.run(scope,tx=>new ItemQuantityFulfillmentRepository(tx).complete({itemId:row.itemId,taskId:row.taskId,employeeId,quantity:3,eventKey:`closure-complete-${randomUUID()}`}))
    await runner.run(scope,tx=>new ItemQuantityFulfillmentRepository(tx).deliver({itemId:row.itemId,taskId:row.taskId,employeeId,quantity:3,eventKey:`closure-deliver-${randomUUID()}`}))
    expect(await state()).toMatchObject({blockers:[],outstandingAmountMinor:0,outstandingOrderCount:0})
    expect(await runner.run(scope,tx=>readBusinessDayBlockerFacts(tx,source.id,'ORDER_UNSETTLED'))).toEqual([])
    expect(await runner.run(scope,tx=>readBusinessDayBlockerFacts(tx,source.id,'INVENTORY_RESERVED'))).toEqual([])
    expect((await previewSession(source.id,target)).blockers).toEqual([])
    await mergeSession(source.id,target)
    expect((await pool.query('SELECT status FROM mbox.table_sessions WHERE id=$1',[source.id])).rows[0].status).toBe('closed')
    expect(await balance(stockId)).toEqual({on_hand:'7.000000',reserved:'0.000000'})
    expect((await pool.query('SELECT quantity::text,status FROM mbox.inventory_order_reservations WHERE order_item_id=$1',[row.itemId])).rows[0]).toEqual({quantity:'5.000000',status:'reserved'})
  })
  it('all unpaid units stopped leaves no fictional collection or inventory blocker and permits table merge',async()=>{
    await grantActor(employeeId,['refund.request','order.cancel_unpaid','table.transfer','table.participation.manage'])
    const source=await freshTableSession(),target=await freshTableSession(),row=await item('pending',0,source.id),stockId=await stock(row,'reserved')
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    await service.request({scope,employeeId,businessDate:businessDate,orderItemId:row.itemId,quantity:5,reason:'未制作全部停止',idempotencyKey:`closure-all-${randomUUID()}`})
    expect(await runner.run(scope,tx=>readTableSessionClosureState(tx,source.id))).toMatchObject({blockers:[],outstandingAmountMinor:0,outstandingOrderCount:0})
    expect((await previewSession(source.id,target)).blockers).toEqual([])
    await mergeSession(source.id,target)
    expect((await pool.query('SELECT status FROM mbox.table_sessions WHERE id=$1',[source.id])).rows[0].status).toBe('closed')
    expect(await balance(stockId)).toEqual({on_hand:'10.000000',reserved:'0.000000'})
    expect((await pool.query('SELECT count(*)::int n FROM mbox.payments WHERE order_id=$1',[row.orderId])).rows[0].n).toBe(0)
  })
  it.each(['order_cancel','customer_left','automatic_cutoff'] as const)('releases only the remaining original units on %s after partial stop and delivery',async(kind)=>{
    await grantActor(employeeId,['refund.request','order.cancel_unpaid','table.close','table.turnover_unsettled'])
    const source=await freshTableSession(),row=await item('pending',0,source.id),stockId=await stock(row,'reserved')
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    const stopped=await service.request({scope,employeeId,businessDate:businessDate,orderItemId:row.itemId,quantity:2,reason:'未制作两份不要了',idempotencyKey:`whole-stop-${randomUUID()}`})
    await runner.run(scope,tx=>new ItemQuantityFulfillmentRepository(tx).complete({itemId:row.itemId,taskId:row.taskId,employeeId,quantity:1,eventKey:`whole-ready-${randomUUID()}`}))
    await runner.run(scope,tx=>new ItemQuantityFulfillmentRepository(tx).deliver({itemId:row.itemId,taskId:row.taskId,employeeId,quantity:1,eventKey:`whole-deliver-${randomUUID()}`}))
    expect(await balance(stockId)).toEqual({on_hand:'9.000000',reserved:'2.000000'})
    const key=`whole-close-${randomUUID()}`
    const runtimeTransactions={run:<T>(current:typeof scope,operation:(tx:import('./transaction-runner.js').ScopedTransaction)=>Promise<T>)=>runner.run(current,async tx=>{await tx.query('SET LOCAL ROLE mbox_runtime');return operation(tx)})} as ScopedPostgresTransactionRunner
    if(kind==='automatic_cutoff'){
      await pool.query("UPDATE mbox.table_sessions SET business_date='2026-09-12' WHERE id=$1",[source.id])
      await pool.query("INSERT INTO mbox.store_automatic_table_turnover_policies(tenant_id,store_id,enabled,operating_starts_at) VALUES($1,$2,true,TIME '12:00') ON CONFLICT(tenant_id,store_id) DO UPDATE SET enabled=true",[tenantId,storeId])
    }
    const close=()=>kind==='order_cancel'?new PostgresOrderCancellationRepository(runtimeTransactions).cancel({scope,employeeId,orderId:row.orderId,businessDate:businessDate,reasonCode:'guest_left',reasonNote:'已联系岗位确认客人离店',idempotencyKey:key}):runtimeTransactions.run(scope,tx=>kind==='customer_left'?new PostgresTableCustomerLeftTurnoverRepository(tx).close({scope,employeeId,tableSessionId:source.id,businessDate:businessDate,reasonNote:'已联系岗位确认客人离店',idempotencyKey:key}):new PostgresAutomaticTableTurnoverRepository(tx).close({scope,tableSessionId:source.id,businessDate:businessDate,reasonNote:'营业日结束保留原售后事实',idempotencyKey:key}))
    const original=await close(),replay=await close()
    expect(replay).toMatchObject({eventId:original.eventId,replayed:true})
    if(kind!=='order_cancel')expect(original).toMatchObject({deliveredUnpaidAmountMinor:800})
    expect(await balance(stockId)).toEqual({on_hand:'9.000000',reserved:'0.000000'})
    expect((await pool.query('SELECT quantity::text,status FROM mbox.inventory_order_reservations WHERE order_item_id=$1',[row.itemId])).rows[0]).toEqual({quantity:'5.000000',status:'reserved'})
    expect((await pool.query('SELECT production_state,operationally_stopped FROM mbox.order_item_quantity_units WHERE order_item_id=$1 ORDER BY unit_index',[row.itemId])).rows).toEqual([
      {production_state:'unmade',operationally_stopped:true},{production_state:'unmade',operationally_stopped:true},
      {production_state:'delivered',operationally_stopped:false},{production_state:'unmade',operationally_stopped:true},{production_state:'unmade',operationally_stopped:true}])
    expect((await runner.run(scope,tx=>new ItemAfterSalesProgressRepository(tx).read(stopped.value.caseId)))).toMatchObject({status:'completed',stoppedQuantity:2})
    expect((await pool.query("SELECT count(*)::int n FROM mbox.inventory_movements WHERE order_item_id=$1 AND movement_type='return'",[row.itemId])).rows[0].n).toBe(0)
    await expect(runner.run(scope,tx=>new ItemQuantityFulfillmentRepository(tx).complete({itemId:row.itemId,taskId:row.taskId,employeeId,quantity:1,eventKey:`late-whole-ready-${randomUUID()}`}))).rejects.toThrow()
  })
  it('keeps a paid refund and real made-goods return available after the original table is closed',async()=>{
    await grantActor(employeeId,['refund.request','table.close','table.turnover_unsettled','inventory.receive'])
    await grantActor(reviewerId,['refund.approve','refund.execute'],100000)
    const source=await freshTableSession(),row=await item('pending',0,source.id),stockId=await stock(row,'reserved')
    await runner.run(scope,async tx=>{const payments=new PaymentRepository(tx);await payments.createForOrder({...cashInput(),orderId:row.orderId});await payments.syncOrderPaymentStatus(row.orderId)})
    await runner.run(scope,tx=>new ItemQuantityFulfillmentRepository(tx).complete({itemId:row.itemId,taskId:row.taskId,employeeId,quantity:1,eventKey:`paid-close-ready-${randomUUID()}`}))
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    const requested=await service.request({scope,employeeId,businessDate:businessDate,orderItemId:row.itemId,quantity:5,reason:'全部停止，原现金退回待审核',idempotencyKey:`paid-close-request-${randomUUID()}`})
    expect(requested.value).toMatchObject({status:'requested',heldQuantity:5,madeQuantity:1})
    await runner.run(scope,tx=>new PostgresTableCustomerLeftTurnoverRepository(tx).close({scope,employeeId,tableSessionId:source.id,businessDate:businessDate,reasonNote:'客人已离店，原退款另行处理',idempotencyKey:`paid-close-${randomUUID()}`}))
    expect(await balance(stockId)).toEqual({on_hand:'9.000000',reserved:'0.000000'})
    const afterClose=await new ItemAfterSalesQuery(runner).item({scope,employeeId:reviewerId,itemId:row.itemId})
    expect(afterClose.canRequest).toBe(false);expect(afterClose.cases[0]).toMatchObject({canApprove:true,moneyComplete:false,physicalComplete:false})
    const approval=await service.decide({scope,employeeId:reviewerId,businessDate:businessDate,caseId:requested.value.caseId,decision:'approved',reason:'同意原付款一次退款审核',idempotencyKey:`paid-close-review-${randomUUID()}`})
    expect(approval.value).toMatchObject({status:'approved',heldQuantity:1,stoppedQuantity:4,physicalComplete:false})
    await manualResult(approval.value.refunds[0].id,true)
    expect(await runner.run(scope,tx=>new ItemAfterSalesProgressRepository(tx).read(requested.value.caseId))).toMatchObject({status:'approved',moneyComplete:true,physicalComplete:false})
    const made=(await pool.query("SELECT id FROM mbox.order_item_quantity_units WHERE order_item_id=$1 AND production_state='ready'",[row.itemId])).rows[0].id
    const receipt={scope,employeeId,businessDate:businessDate,caseId:requested.value.caseId,unitIds:[made],disposition:'returned_unopened' as const,unopenedReceived:true,reason:'实物已收回且未开封',idempotencyKey:`paid-close-return-${randomUUID()}`}
    expect((await service.disposeMade(receipt)).value).toMatchObject({status:'completed',moneyComplete:true,physicalComplete:true,succeededMinor:4000})
    expect((await service.disposeMade(receipt)).replayed).toBe(true)
    expect(await balance(stockId)).toEqual({on_hand:'10.000000',reserved:'0.000000'})
    expect((await pool.query("SELECT count(*)::int n FROM mbox.inventory_movements WHERE order_item_id=$1 AND movement_type='return'",[row.itemId])).rows[0].n).toBe(1)
    expect((await pool.query("SELECT count(*)::int n FROM mbox.audit_events WHERE object_id=$1 AND action='item_after_sales.approved'",[requested.value.caseId])).rows[0].n).toBe(1)
  })
  it.each(['requested','withdrawn'] as const)('finishes the held physical work from an original whole cancellation without pricing a %s partial-discount request',async(status)=>{
    await grantActor(employeeId,['refund.request','order.cancel_unpaid'])
    const source=await freshTableSession(),row=await item('pending',300,source.id),stockId=await stock(row,'reserved')
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    const request=await service.request({scope,employeeId,businessDate:businessDate,orderItemId:row.itemId,quantity:2,reason:'含原优惠的两份先停止制作',idempotencyKey:`cancel-price-${randomUUID()}`})
    expect(request.value).toMatchObject({status:'requested',amountMinor:null,heldQuantity:2})
    if(status==='withdrawn')await service.decide({scope,employeeId,businessDate:businessDate,caseId:request.value.caseId,decision:'withdrawn',reason:'暂不单品处理，保持暂停',idempotencyKey:`cancel-price-withdraw-${randomUUID()}`})
    const cancelled=await new PostgresOrderCancellationRepository(runner).cancel({scope,employeeId,orderId:row.orderId,businessDate:businessDate,reasonCode:'guest_left',reasonNote:'客人整单不要，原整单取消',idempotencyKey:`cancel-price-whole-${randomUUID()}`})
    const progress=await runner.run(scope,tx=>new ItemAfterSalesProgressRepository(tx).read(request.value.caseId))
    expect(progress).toMatchObject({status:status==='requested'?'completed':'withdrawn',amountMinor:null,heldQuantity:0,stoppedQuantity:2,physicalComplete:true,moneyComplete:true,closedByOrderCancellationId:cancelled.eventId})
    expect(await balance(stockId)).toEqual({on_hand:'10.000000',reserved:'0.000000'})
    expect((await pool.query('SELECT count(*)::int n FROM mbox.item_receivable_adjustments WHERE case_id=$1',[request.value.caseId])).rows[0].n).toBe(0)
    expect((await pool.query('SELECT count(*)::int n FROM mbox.refunds WHERE order_id=$1',[row.orderId])).rows[0].n).toBe(0)
  })
  it.each((['rejected','withdrawn'] as const).flatMap(decision=>[false,true].map(closeFirst=>({decision,closeFirst}))))('preserves $decision with closeFirst=$closeFirst while authorized inventory staff finish actual goods after departure',async({decision,closeFirst})=>{
    await grantActor(employeeId,['refund.request','table.close','table.turnover_unsettled','inventory.receive','inventory.waste'])
    await grantActor(reviewerId,['refund.approve'],100000)
    const source=await freshTableSession(),row=await item('pending',0,source.id),stockId=await stock(row,'reserved')
    await runner.run(scope,async tx=>{const payments=new PaymentRepository(tx);await payments.createForOrder({...cashInput(),orderId:row.orderId});await payments.syncOrderPaymentStatus(row.orderId)})
    await runner.run(scope,tx=>new ItemQuantityFulfillmentRepository(tx).complete({itemId:row.itemId,taskId:row.taskId,employeeId,quantity:2,eventKey:`declined-made-${randomUUID()}`}))
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    const request=await service.request({scope,employeeId,businessDate:businessDate,orderItemId:row.itemId,quantity:5,reason:'整行商品先暂停申请退款',idempotencyKey:`declined-request-${randomUUID()}`})
    const decide=()=>service.decide({scope,employeeId:decision==='withdrawn'?employeeId:reviewerId,businessDate:businessDate,caseId:request.value.caseId,decision,reason:'原退款不再执行，未确认继续制作',idempotencyKey:`declined-decision-${randomUUID()}`})
    if(!closeFirst)await decide()
    const read=async()=>(await new ItemAfterSalesQuery(runner).item({scope,employeeId,itemId:row.itemId})).cases.find(value=>value.caseId===request.value.caseId)!
    const made=(await pool.query("SELECT id FROM mbox.order_item_quantity_units WHERE order_item_id=$1 AND production_state='ready' ORDER BY unit_index",[row.itemId])).rows.map(value=>value.id)
    const receive={scope,employeeId,businessDate:businessDate,caseId:request.value.caseId,unitIds:[made[0]],disposition:'returned_unopened' as const,unopenedReceived:true,reason:'已核对这份未开封实物退回',idempotencyKey:`declined-receive-${randomUUID()}`}
    await expect(service.disposeMade(receive)).rejects.toThrow('先按原授权')
    await runner.run(scope,tx=>new PostgresTableCustomerLeftTurnoverRepository(tx).close({scope,employeeId,tableSessionId:source.id,businessDate:businessDate,reasonNote:'客人已离店，保持原退款决定',idempotencyKey:`declined-close-${randomUUID()}`}))
    if(closeFirst)await decide()
    expect(await read()).toMatchObject({status:decision,heldQuantity:2,stoppedQuantity:3,canResume:false,canDisposeMade:true})
    expect(await balance(stockId)).toEqual({on_hand:'8.000000',reserved:'0.000000'})
    const ordinary=await ordinaryServiceEmployee()
    await expect(service.disposeMade({...receive,employeeId:ordinary,idempotencyKey:`declined-forbidden-${randomUUID()}`})).rejects.toThrow('does not have permission')
    await service.disposeMade(receive)
    await service.disposeMade({...receive,unitIds:[made[1]],disposition:'used_loss',unopenedReceived:false,reason:'该份已耗用，保留原消耗不重复扣库存',idempotencyKey:`declined-used-${randomUUID()}`})
    const done=await read()
    expect(done).toMatchObject({status:decision,heldQuantity:0,stoppedQuantity:5,physicalComplete:true,succeededMinor:0})
    expect(await balance(stockId)).toEqual({on_hand:'9.000000',reserved:'0.000000'})
    expect((await pool.query("SELECT status FROM mbox.refunds WHERE order_id=$1",[row.orderId])).rows).toEqual([{status:decision==='withdrawn'?'cancelled':'rejected'}])
    await service.acknowledgeNotices({scope,employeeId,businessDate:businessDate,caseId:request.value.caseId,noticeIds:done.notices.map(value=>value.id),reason:'所有原岗位通知均已核实知悉',idempotencyKey:`declined-ack-${randomUUID()}`})
    expect((await new ItemAfterSalesHandoverQuery(runner).list({scope,employeeId,limit:100})).items.some(value=>value.caseId===request.value.caseId)).toBe(false)
  })
  it.each(['rejected','withdrawn'] as const)('requires actual inventory handling for legacy upfront-consumed unmade shares after %s and guest departure',async(decision)=>{
    await grantActor(employeeId,['refund.request','table.close','table.turnover_unsettled','inventory.receive','inventory.waste'])
    await grantActor(reviewerId,['refund.approve'],100000)
    const source=await freshTableSession(),row=await item('pending',0,source.id),stockId=await stock(row,'direct_sale')
    await runner.run(scope,async tx=>{const payments=new PaymentRepository(tx);await payments.createForOrder({...cashInput(),orderId:row.orderId});await payments.syncOrderPaymentStatus(row.orderId)})
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    const request=await service.request({scope,employeeId,businessDate:businessDate,orderItemId:row.itemId,quantity:2,reason:'原预扣库存商品先暂停',idempotencyKey:`upfront-request-${randomUUID()}`})
    await service.decide({scope,employeeId:decision==='withdrawn'?employeeId:reviewerId,businessDate:businessDate,caseId:request.value.caseId,decision,reason:'保留原退款决定，实物另行核对',idempotencyKey:`upfront-decision-${randomUUID()}`})
    await runner.run(scope,tx=>new PostgresTableCustomerLeftTurnoverRepository(tx).close({scope,employeeId,tableSessionId:source.id,businessDate:businessDate,reasonNote:'客人离店，原库存未确认收回',idempotencyKey:`upfront-close-${randomUUID()}`}))
    const read=async()=>(await new ItemAfterSalesQuery(runner).item({scope,employeeId,itemId:row.itemId})).cases.find(value=>value.caseId===request.value.caseId)!
    expect(await read()).toMatchObject({status:decision,heldQuantity:2,stoppedQuantity:0,canDisposeHeldUnmade:true})
    expect(await balance(stockId)).toEqual({on_hand:'5.000000',reserved:'0.000000'})
    const units=(await pool.query('SELECT id FROM mbox.order_item_quantity_units WHERE held_by_case_id=$1 ORDER BY unit_index',[request.value.caseId])).rows.map(value=>value.id)
    const receive={scope,employeeId,businessDate:businessDate,caseId:request.value.caseId,unitIds:[units[0]],disposition:'returned_unopened' as const,unopenedReceived:true,reason:'实物已收回且未开封，核对原预扣记录',idempotencyKey:`upfront-receive-${randomUUID()}`}
    await expect(service.disposeMade({...receive,unopenedReceived:false})).rejects.toThrow('需确认实物')
    await service.disposeMade(receive)
    expect((await service.disposeMade({...receive,businessDate:nextBusinessDate})).replayed).toBe(true)
    await service.disposeMade({...receive,unitIds:[units[1]],disposition:'used_loss',unopenedReceived:false,reason:'实物已耗用，不再重复扣库存',idempotencyKey:`upfront-used-${randomUUID()}`})
    expect(await read()).toMatchObject({status:decision,heldQuantity:0,stoppedQuantity:2,physicalComplete:true,succeededMinor:0})
    expect(await balance(stockId)).toEqual({on_hand:'6.000000',reserved:'0.000000'})
    expect((await pool.query("SELECT unit_cost_minor::text AS cost FROM mbox.inventory_movements WHERE order_item_id=$1 AND movement_type='return'",[row.itemId])).rows).toEqual([{cost:'123.000000'}])
    expect((await pool.query('SELECT status FROM mbox.refunds WHERE order_id=$1',[row.orderId])).rows).toEqual([{status:decision==='withdrawn'?'cancelled':'rejected'}])
  })
  it.each(['closed','succeeded'] as const)('keeps pending money separate from a table cancellation and follows the actual %s result',async(outcome)=>{
    await grantActor(employeeId,['refund.request','table.close','table.turnover_unsettled'])
    const source=await freshTableSession(),row=await item('pending',300,source.id),stockId=await stock(row,'reserved'),publicId=`closure-money-${randomUUID()}`
    await runner.run(scope,tx=>new PaymentRepository(tx).createForOrder({orderId:row.orderId,publicId,provider:'postar',method:'native_qr',initialStatus:'created',principal:{type:'employee',employeeId}}))
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    const request=await service.request({scope,employeeId,businessDate:businessDate,orderItemId:row.itemId,quantity:2,reason:'原付款还未确认，两份先不制作',idempotencyKey:`closure-money-request-${randomUUID()}`})
    expect(request.value).toMatchObject({kind:'payment_review',status:'requested',amountMinor:null})
    await runner.run(scope,tx=>new PostgresTableCustomerLeftTurnoverRepository(tx).close({scope,employeeId,tableSessionId:source.id,businessDate:businessDate,reasonNote:'客人离店，原付款保留查询',idempotencyKey:`closure-money-table-${randomUUID()}`}))
    const read=async()=>(await new ItemAfterSalesQuery(runner).item({scope,employeeId,itemId:row.itemId})).cases.find(value=>value.caseId===request.value.caseId)!
    expect(await read()).toMatchObject({status:'requested',heldQuantity:2,moneyComplete:false,canResolveUnpaid:false,closedByOrderCancellationId:null})
    expect(await runner.run(scope,async tx=>{await tx.query('SET LOCAL ROLE mbox_runtime');return (await tx.query<{done:boolean}>('SELECT mbox.complete_quantity_case_from_order_cancellation($1) AS done',[request.value.caseId])).rows[0].done})).toBe(false)
    const input={scope,employeeId,businessDate:businessDate,caseId:request.value.caseId,reason:'核对原付款后继续原单处理',idempotencyKey:`closure-money-resolve-${randomUUID()}`}
    await expect(service.resolveUnpaid(input)).rejects.toThrow('原付款仍有已收或未确认结果')
    await runner.run(scope,async tx=>{const payment=new PaymentRepository(tx);await payment.applyProviderQueryResult({paymentPublicId:publicId,provider:'postar',providerTransactionId:`closure-money-result-${randomUUID()}`,reportedAmountMinor:3700,reportedCurrency:'CNY',status:outcome});await payment.syncOrderPaymentStatus(row.orderId)})
    if(outcome==='closed'){
      expect(await read()).toMatchObject({canResolveUnpaid:true})
      expect((await service.resolveUnpaid(input)).value).toMatchObject({status:'completed',amountMinor:null,stoppedQuantity:2,heldQuantity:0,moneyComplete:true})
      expect((await service.resolveUnpaid({...input,businessDate:nextBusinessDate})).replayed).toBe(true)
    }else{
      expect(await read()).toMatchObject({canResolveUnpaid:false,status:'requested',heldQuantity:2})
      await expect(service.resolveUnpaid(input)).rejects.toThrow('原付款仍有已收或未确认结果')
    }
    expect(await balance(stockId)).toEqual({on_hand:'10.000000',reserved:'0.000000'})
    expect((await pool.query('SELECT count(*)::int n FROM mbox.item_receivable_adjustments WHERE case_id=$1',[request.value.caseId])).rows[0].n).toBe(0)
    expect((await pool.query('SELECT count(*)::int n FROM mbox.refunds WHERE order_id=$1',[row.orderId])).rows[0].n).toBe(0)
  })
  async function ordinaryServiceEmployee(){
    const id=randomUUID()
    await pool.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,$4,'普通在岗服务人员')",[id,tenantId,storeId,`S-${id}`])
    await grantActor(id,['refund.request'])
    expect((await pool.query("SELECT mbox.employee_has_effective_permission($1,$2,$3,'order.cancel_unpaid') AS allowed",[tenantId,storeId,id])).rows[0].allowed).toBe(false)
    return id
  }
  it('ordinary service staff can stop normal unpaid units without gaining whole-order cancellation or approval authority',async()=>{
    const serviceEmployee=await ordinaryServiceEmployee(),row=await item(),stockId=await stock(row,'reserved')
    const runtimeTransactions={run:<T>(current:typeof scope,operation:(tx:import('./transaction-runner.js').ScopedTransaction)=>Promise<T>)=>runner.run(current,async tx=>{await tx.query('SET LOCAL ROLE mbox_runtime');return operation(tx)})} as ScopedPostgresTransactionRunner
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runtimeTransactions),new ItemAfterSalesOperatingEffects())
    const result=await service.request({scope,employeeId:serviceEmployee,businessDate:businessDate,orderItemId:row.itemId,quantity:2,reason:'正常未付两份不要了',idempotencyKey:`staff-unpaid-${randomUUID()}`})
    expect(result.value).toMatchObject({kind:'unpaid_stop',status:'completed',stoppedQuantity:2,refunds:[]})
    expect(await balance(stockId)).toEqual({on_hand:'10.000000',reserved:'3.000000'})
    await expect(new PostgresOrderCancellationRepository(runtimeTransactions).cancel({scope,employeeId:serviceEmployee,orderId:row.orderId,businessDate:businessDate,reasonCode:'other',reasonNote:'不能因此越权取消整单',idempotencyKey:`staff-whole-${randomUUID()}`})).rejects.toThrow('lacks unpaid order cancellation permission')
    await expect(service.decide({scope,employeeId:serviceEmployee,businessDate:businessDate,caseId:result.value.caseId,decision:'approved',reason:'不能因此获得审核权',idempotencyKey:`staff-review-${randomUUID()}`})).rejects.toThrow('permission')
    await expect(service.disposeMade({scope,employeeId:serviceEmployee,businessDate:businessDate,caseId:result.value.caseId,unitIds:(await runner.run(scope,tx=>new ItemQuantityRepository(tx).readUnits(row.itemId))).slice(0,1).map(unit=>unit.id),disposition:'returned_unopened',unopenedReceived:true,reason:'不能因此获得实物入库权',idempotencyKey:`staff-stock-${randomUUID()}`})).rejects.toThrow('permission')
  })
  it('the same ordinary staff can finish a held stop once its original payment is definitively closed',async()=>{
    const serviceEmployee=await ordinaryServiceEmployee(),row=await item(),publicId=`staff-payment-${randomUUID()}`
    await runner.run(scope,tx=>new PaymentRepository(tx).createForOrder({orderId:row.orderId,publicId,provider:'postar',method:'native_qr',initialStatus:'created',principal:{type:'employee',employeeId}}))
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    const result=await service.request({scope,employeeId:serviceEmployee,businessDate:businessDate,orderItemId:row.itemId,quantity:2,reason:'付款未定先暂停两份',idempotencyKey:`staff-pending-${randomUUID()}`})
    const read=()=>new ItemAfterSalesQuery(runner).item({scope,employeeId:serviceEmployee,itemId:row.itemId})
    expect((await read()).cases[0].canResolveUnpaid).toBe(false)
    await runner.run(scope,tx=>new PaymentRepository(tx).applyProviderQueryResult({paymentPublicId:publicId,provider:'postar',providerTransactionId:`staff-provider-${randomUUID()}`,reportedAmountMinor:4000,reportedCurrency:'CNY',status:'closed'}))
    expect((await read()).cases[0].canResolveUnpaid).toBe(true)
    const resolved=await service.resolveUnpaid({scope,employeeId:serviceEmployee,businessDate:businessDate,caseId:result.value.caseId,reason:'原付款关闭，直接未付停菜',idempotencyKey:`staff-resolve-${randomUUID()}`})
    expect(resolved.value).toMatchObject({kind:'unpaid_stop',status:'completed',stoppedQuantity:2,refunds:[]})
  })
  it('keeps an unresolved unpaid stop out of collection, without blocking unrelated orders or treating withdrawal as resume',async()=>{
    const row=await item('pending',100),other=await item()
    const created=await hold(row.itemId,2,'unpaid_stop')
    expect(created.amountMinor).toBeNull()
    const collect=()=>runner.run(scope,tx=>new PaymentRepository(tx).createForOrder({...cashInput(),orderId:row.orderId}))
    await expect(collect()).rejects.toThrow('unpaid item stop requires settlement')
    await expect(runner.run(scope,tx=>new PaymentRepository(tx).createForOrders({...cashInput(),orderIds:[row.orderId,other.orderId]}))).rejects.toThrow('unpaid item stop requires settlement')
    expect((await pool.query('SELECT count(*)::int n FROM mbox.order_payment_allocations WHERE order_id=ANY($1::uuid[])',[[row.orderId,other.orderId]])).rows[0].n).toBe(0)
    await expect(runner.run(scope,tx=>new PaymentRepository(tx).createForOrder({...cashInput(),orderId:other.orderId}))).resolves.toMatchObject({amountMinor:4000})
    await runner.run(scope,tx=>new ItemQuantityRepository(tx).decide({caseId:created.caseId,employeeId,decision:'withdrawn',reason:'客人想再考虑'}))
    await expect(collect()).rejects.toThrow('unpaid item stop requires settlement')
    await runner.run(scope,tx=>new ItemQuantityRepository(tx).resume({caseId:created.caseId,employeeId}))
    await expect(collect()).resolves.toMatchObject({amountMinor:3900})
  })
  it('collects only the remaining three units and removes the paid order from collection work without rewriting its invoice',async()=>{
    const row=await item();await stopUnpaid(row,2)
    const result=await runner.run(scope,async tx=>{
      const payments=new PaymentRepository(tx)
      const paid=await payments.createForOrder({...cashInput(),orderId:row.orderId})
      const status=await payments.syncOrderPaymentStatus(row.orderId)
      const needed=(await tx.query<{needed:boolean}>(`SELECT ${orderNeedsCollectionSql('ordering')} AS needed FROM mbox.orders ordering WHERE id=$1`,[row.orderId])).rows[0].needed
      return {paid,status,needed}
    })
    expect(result).toMatchObject({paid:{amountMinor:2400},status:'paid',needed:false})
    expect((await pool.query('SELECT total_amount_minor::int original FROM mbox.orders WHERE id=$1',[row.orderId])).rows[0].original).toBe(4000)
    await expect(runner.run(scope,tx=>new PaymentRepository(tx).createForOrder({...cashInput(),orderId:row.orderId}))).rejects.toThrow('no outstanding balance')
  })
  it('refuses a legacy full-lot release after a partial unit release, even if another order makes the balance look sufficient',async()=>{
    const row=await item(),stockId=await stock(row,'reserved')
    await stopUnpaid(row,2)
    expect(await balance(stockId)).toEqual({on_hand:'10.000000',reserved:'3.000000'})
    // Another legitimate reservation uses the same SKU. The old full-lot guard
    // of reserved_quantity >= 5 would pass and steal two of these seven units.
    const other=await item()
    await pool.query(`INSERT INTO mbox.inventory_order_reservations(tenant_id,store_id,order_id,order_item_id,inventory_item_id,quantity,status,expires_at) VALUES($1,$2,$3,$4,$5,7,'reserved',clock_timestamp()+interval '1 hour')`,[tenantId,storeId,other.orderId,other.itemId,stockId])
    await pool.query('UPDATE mbox.inventory_balances SET reserved_quantity=10 WHERE inventory_item_id=$1',[stockId])
    await expect(runner.run(scope,tx=>new InventoryRepository(tx).releaseImmediatePaymentReservations(row.orderId,'legacy cancellation'))).rejects.toThrow('whole reservation transition refused')
    expect(await balance(stockId)).toEqual({on_hand:'10.000000',reserved:'10.000000'})
    expect((await pool.query("SELECT quantity::text,status FROM mbox.inventory_order_reservations WHERE order_item_id=$1",[other.itemId])).rows[0]).toEqual({quantity:'7.000000',status:'reserved'})
  })
  it('allocates a combined payment against remaining receivables, never against stopped quantities',async()=>{
    const first=await item(),second=await item();await stopUnpaid(first,2);await stopUnpaid(second,1)
    const collected=await runner.run(scope,async tx=>{
      const payments=new PaymentRepository(tx),paid=await payments.createForOrders({...cashInput(),orderIds:[first.orderId,second.orderId]})
      return {paid,statuses:await Promise.all([payments.syncOrderPaymentStatus(first.orderId),payments.syncOrderPaymentStatus(second.orderId)])}
    })
    expect(collected).toMatchObject({paid:{amountMinor:5600},statuses:['paid','paid']})
    const allocations=(await pool.query('SELECT order_id,amount_minor::int amount,outstanding_at_creation_minor::int outstanding FROM mbox.order_payment_allocations WHERE order_id=ANY($1::uuid[]) ORDER BY order_id',[[first.orderId,second.orderId]])).rows
    expect(allocations.find(row=>row.order_id===first.orderId)).toMatchObject({amount:2400,outstanding:2400})
    expect(allocations.find(row=>row.order_id===second.orderId)).toMatchObject({amount:3200,outstanding:3200})
  })
  it('reads the committed stop after waiting for its order lock, so a simultaneous cash collection cannot use the old amount',async()=>{
    const row=await item(),created=await hold(row.itemId,2,'unpaid_stop')
    let releaseStop!:()=>void,signalLocked!:()=>void,signalCollection!:()=>void
    const stopGate=new Promise<void>(resolve=>{releaseStop=resolve}),locked=new Promise<void>(resolve=>{signalLocked=resolve}),collectionEntered=new Promise<void>(resolve=>{signalCollection=resolve})
    const stopping=runner.run(scope,async tx=>{
      await new ItemUnitInventoryRepository(tx).disposeUnmadeUnits({itemId:row.itemId,unitIds:created.unitIds,employeeId,caseId:created.caseId})
      await new ItemQuantityReceivableRepository(tx).recordUnpaidReduction({caseId:created.caseId,employeeId,businessDate:businessDate})
      signalLocked();await stopGate
    })
    await locked
    const collecting=runner.run(scope,async tx=>{signalCollection();return new PaymentRepository(tx).createForOrder({...cashInput(),orderId:row.orderId})})
    await collectionEntered;releaseStop();await stopping
    expect(await collecting).toMatchObject({amountMinor:2400})
  })
  it('internal coordinator rolls back its case, money and stock when required operating effects fail, then replays a next-day retry',async()=>{
    await grantActor(employeeId,['refund.request','order.cancel_unpaid'])
    await grantActor(reviewerId,['refund.request','refund.approve'],5000)
    const row=await item(),stockId=await stock(row,'direct_sale'),key=`quantity-coordinator-${randomUUID()}`
    const input={scope,employeeId,businessDate:businessDate,idempotencyKey:key,reason:'客人未付款停止两瓶',orderItemId:row.itemId,quantity:2}
    const failed=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),{apply:async()=>{throw new Error('operational effect unavailable')}})
    await expect(failed.request(input)).rejects.toThrow('operational effect unavailable')
    expect((await pool.query('SELECT count(*)::int n FROM mbox.item_after_sales_cases WHERE order_id=$1',[row.orderId])).rows[0].n).toBe(0)
    expect(await balance(stockId)).toEqual({on_hand:'5.000000',reserved:'0.000000'})
    let effectCalls=0
    // This callback only observes the internal coordinator contract. It is not
    // an acceptance substitute for the production KDS/notification adapter.
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),{apply:async()=>{effectCalls++}})
    const result=await service.request(input);expect(result).toMatchObject({replayed:false,value:{status:'completed',moneyComplete:true,stoppedQuantity:2}})
    expect(await service.request({...input,businessDate:nextBusinessDate})).toEqual({...result,replayed:true})
    expect(effectCalls).toBe(1);expect(await balance(stockId)).toEqual({on_hand:'7.000000',reserved:'0.000000'})
    await expect(service.request({...input,quantity:3})).rejects.toThrow('conflicts with another request')
    const stranger=randomUUID();await pool.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,$4,'No capability')",[stranger,tenantId,storeId,`Q-${stranger}`])
    await expect(service.request({...input,employeeId:stranger,idempotencyKey:`quantity-denied-${stranger}`})).rejects.toThrow('does not have permission')
  })
  it('refunds selected units from their original combined-payment share without touching the other order',async()=>{
    const first=await item(),second=await item()
    const paid=await runner.run(scope,tx=>new PaymentRepository(tx).createForOrders({...cashInput(),orderIds:[first.orderId,second.orderId]}))
    const created=await hold(first.itemId,2)
    const prepared=await runner.run(scope,tx=>new ItemQuantityRefundRepository(tx).prepare(created.caseId))
    expect(prepared.status).toBe('prepared')
    const facts=(await pool.query('SELECT payment_id,order_id,amount_minor::int AS amount FROM mbox.refunds WHERE id=$1',[prepared.refundIds[0]])).rows[0]
    expect(facts).toEqual({payment_id:paid.id,order_id:first.orderId,amount:1600})
    const allocations=(await pool.query('SELECT order_item_id,amount_minor::int AS amount FROM mbox.refund_items WHERE refund_id=$1',[prepared.refundIds[0]])).rows
    expect(allocations).toEqual([{order_item_id:first.itemId,amount:1600}])
    expect((await pool.query('SELECT count(*)::int AS n FROM mbox.item_after_sales_cases WHERE order_id=$1',[second.orderId])).rows[0].n).toBe(0)
  })

  it('concurrent requests on two original orders in one payment use a consistent lock order',async()=>{
    const first=await item(),second=await item()
    await runner.run(scope,tx=>new PaymentRepository(tx).createForOrders({...cashInput(),orderIds:[first.orderId,second.orderId]}))
    const cases=await Promise.all([hold(first.itemId,1),hold(second.itemId,1)])
    const results=await Promise.all(cases.map(created=>runner.run(scope,async tx=>{
      await tx.query("SET LOCAL lock_timeout='3s'")
      return new ItemQuantityRefundRepository(tx).prepare(created.caseId)
    })))
    expect(results.map(result=>result.status)).toEqual(['prepared','prepared'])
  })

  it.each([1,3,5])('refunds partly paid original goods within captured capacity and preserves the remaining receivable (%s units)',async(quantity)=>{
    await grantActor(employeeId,['refund.request']);await grantActor(reviewerId,['refund.approve','refund.execute'],100000)
    const row=await item(),stockId=await stock(row,'reserved');await payment(row.orderId,'cash',1600)
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    const created=await service.request({scope,employeeId,businessDate:businessDate,orderItemId:row.itemId,quantity,reason:'按实付上限退所选商品',idempotencyKey:randomUUID()})
    const expected=Math.min(quantity*800,1600)
    expect(created.value.amountMinor).toBe(expected)
    expect(created.value.refunds).toHaveLength(1)
    const approve={scope,employeeId:reviewerId,businessDate:businessDate,caseId:created.value.caseId,decision:'approved' as const,reason:'核对实付上限并停止所选份数',idempotencyKey:randomUUID()}
    const approved=await service.decide(approve)
    expect(approved.value.stoppedQuantity).toBe(quantity)
    expect(await runner.run(scope,tx=>new ItemQuantityReceivableRepository(tx).readOrder(row.orderId))).toMatchObject({effectiveAmountMinor:4000-quantity*800})
    await manualResult(created.value.refunds[0]!.id,true)
    expect((await pool.query("SELECT sum(amount_minor)::int amount FROM mbox.refunds WHERE order_id=$1 AND status='succeeded'",[row.orderId])).rows[0].amount).toBe(expected)
    expect((await pool.query('SELECT total_amount_minor::int amount FROM mbox.orders WHERE id=$1',[row.orderId])).rows[0].amount).toBe(4000)
    expect(await service.decide({...approve,businessDate:nextBusinessDate})).toMatchObject({replayed:true})
    expect((await balance(stockId)).reserved).toBe(`${5-quantity}.000000`)
    const outstanding=4000-quantity*800-(1600-expected)
    expect((await runner.run(scope,tx=>tx.query(`SELECT ${orderNeedsCollectionSql('original')} AS needs FROM mbox.orders original WHERE id=$1`,[row.orderId]))).rows[0].needs).toBe(outstanding>0)
    if(outstanding)await runner.run(scope,tx=>new RecollectionAuthorizationRepository(tx).authorize({orderId:row.orderId,employeeId:reviewerId,reason:'收银确认剩余原商品款项，禁止重复收取已退款'}))
    const collection=await runner.run(scope,tx=>listTablePaymentOrdersForSession(tx,sessionId))
    if(outstanding)expect(collection.find(order=>order.id===row.orderId)).toMatchObject({outstandingAmountMinor:outstanding})
    else expect(collection.find(order=>order.id===row.orderId)).toBeUndefined()
  })

  it.each([[2,true],[3,true],[5,true],[2,false],[3,false],[5,false]] as const)('reprices a broken bundle at original single prices (%s stopped, paid=%s)',async(quantity,paid)=>{
    await grantActor(employeeId,['refund.request']);await grantActor(reviewerId,['refund.approve','refund.execute'],100000)
    const row=await pricedBundle(),parent=row.parent
    if(paid)await payment(row.orderId,'cash',4000)
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    const created=await service.request({scope,employeeId,businessDate:businessDate,orderItemId:row.itemId,quantity,reason:'套餐退部分水，保留商品按单点原价',idempotencyKey:randomUUID()})
    const remaining=(5-quantity)*800+2000,refund=paid?Math.max(0,4000-remaining):0
    expect(created.value.amountMinor).toBe(refund)
    const review=await new ItemAfterSalesQuery(runner).item({scope,employeeId:reviewerId,itemId:row.itemId})
    expect(review.cases[0]).toMatchObject({canApprove:paid,pricing:{policy:'broken_bundle',effectiveAmountMinor:remaining,refundAmountMinor:refund}})
    if(paid)await service.decide({scope,employeeId:reviewerId,businessDate:businessDate,caseId:created.value.caseId,decision:'approved',reason:'确认单点重算及本次差额',idempotencyKey:randomUUID()})
    expect(await runner.run(scope,tx=>new ItemQuantityReceivableRepository(tx).readOrder(row.orderId))).toMatchObject({originalAmountMinor:4000,effectiveAmountMinor:remaining})
    if(refund){
      expect((await pool.query('SELECT order_item_id FROM mbox.refund_items WHERE refund_id=$1',[created.value.refunds[0]!.id])).rows[0].order_item_id).toBe(parent)
      await manualResult(created.value.refunds[0]!.id,true)
    }else expect(created.value.refunds).toHaveLength(0)
    expect((await pool.query('SELECT total_amount_minor::int amount FROM mbox.order_items WHERE id=$1',[parent])).rows[0].amount).toBe(4000)
    expect((await pool.query('SELECT count(*)::int n FROM mbox.payments WHERE order_id=$1',[row.orderId])).rows[0].n).toBe(paid?1:0)
    const guest=(await runner.run(scope,tx=>loadGuestTableOrders(tx,sessionId,randomUUID()))).find(order=>order.publicId===`quantity-${row.orderId}`)!
    expect(guest.receivableReductionMinor??0).toBe(Math.max(0,4000-remaining))
    expect(guest.receivableIncreaseMinor??0).toBe(Math.max(0,remaining-4000))
    const details=(await runner.run(scope,tx=>listTableOrderDetailsForSession(tx,sessionId))).find(order=>order.publicId===`quantity-${row.orderId}`)!
    expect(details.totalAmountMinor!-(details.stoppedAmountMinor??0)+(details.receivableIncreaseMinor??0)).toBe(remaining)
    expect(details.stoppedAmountMinor??0).toBe(Math.max(0,4000-remaining))
    expect(details.receivableIncreaseMinor??0).toBe(Math.max(0,remaining-4000))

  })

  it('concurrent partial-payment requests reserve only the captured balance and can be approved in reverse order',async()=>{
    await grantActor(employeeId,['refund.request']);await grantActor(reviewerId,['refund.approve','refund.execute'],100000)
    const row=await item();await payment(row.orderId,'cash',800)
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    const request=()=>service.request({scope,employeeId,businessDate:businessDate,orderItemId:row.itemId,quantity:1,reason:'并发退一份，以实付扣除在途退款为上限',idempotencyKey:randomUUID()})
    const cases=await Promise.all([request(),request()])
    expect(cases.map(c=>c.value.amountMinor).sort()).toEqual([0,800])
    for(const current of cases.sort((a,b)=>a.value.amountMinor!-b.value.amountMinor!)){
      await service.decide({scope,employeeId:reviewerId,businessDate:businessDate,caseId:current.value.caseId,decision:'approved',reason:'批准当前金额，其他申请不重复占款',idempotencyKey:randomUUID()})
      for(const refund of current.value.refunds)await manualResult(refund.id,true)
    }
    expect((await pool.query("SELECT sum(amount_minor)::int amount FROM mbox.refunds WHERE order_id=$1 AND status='succeeded'",[row.orderId])).rows[0].amount).toBe(800)
    expect(await runner.run(scope,tx=>new ItemQuantityReceivableRepository(tx).readOrder(row.orderId))).toMatchObject({effectiveAmountMinor:2400})
  })

  it('sequential bundle returns subtract the current retained goods once and preserve original paid-parent facts',async()=>{
    await grantActor(employeeId,['refund.request']);await grantActor(reviewerId,['refund.approve','refund.execute'],100000)
    const row=await pricedBundle();await payment(row.orderId)
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    for(const [quantity,expectedRefund,effective] of [[3,400,3600],[1,800,2800],[1,800,2000]]){
      const created=await service.request({scope,employeeId,businessDate:businessDate,orderItemId:row.itemId,quantity,reason:'连续退套餐内水，每次保留原单价',idempotencyKey:randomUUID()})
      expect(created.value.amountMinor).toBe(expectedRefund)
      await service.decide({scope,employeeId:reviewerId,businessDate:businessDate,caseId:created.value.caseId,decision:'approved',reason:'确认本次保留商品和差额',idempotencyKey:randomUUID()})
      await manualResult(created.value.refunds[0]!.id,true)
      expect(await runner.run(scope,tx=>new ItemQuantityReceivableRepository(tx).readOrder(row.orderId))).toMatchObject({effectiveAmountMinor:effective})
    }
    expect((await pool.query("SELECT sum(amount_minor)::int amount FROM mbox.refunds WHERE order_id=$1 AND status='succeeded'",[row.orderId])).rows[0].amount).toBe(2000)
    expect((await pool.query('SELECT total_amount_minor::int amount FROM mbox.order_items WHERE id=$1',[row.parent])).rows[0].amount).toBe(4000)
  })

  it.each(['closed','succeeded'] as const)('recovers the original unknown-payment bundle request after payment is %s',async(outcome)=>{
    await grantActor(employeeId,['refund.request']);await grantActor(reviewerId,['refund.approve','refund.execute'],100000)
    const row=await pricedBundle(),publicId=`bundle-unknown-${randomUUID()}`
    await runner.run(scope,tx=>new PaymentRepository(tx).createForOrder({orderId:row.orderId,publicId,provider:'postar',method:'native_qr',initialStatus:'created',principal:{type:'employee',employeeId}}))
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    const original=await service.request({scope,employeeId,businessDate:businessDate,orderItemId:row.itemId,quantity:3,reason:'付款未知先暂停套餐三瓶',idempotencyKey:randomUUID()})
    const query=()=>new ItemAfterSalesQuery(runner).item({scope,employeeId:reviewerId,itemId:row.itemId})
    expect((await query()).cases[0]).toMatchObject({amountMinor:null,canApprove:false,canResolveUnpaid:false})
    await runner.run(scope,tx=>new PaymentRepository(tx).applyProviderQueryResult({paymentPublicId:publicId,provider:'postar',providerTransactionId:`bundle-result-${randomUUID()}`,reportedAmountMinor:4000,reportedCurrency:'CNY',status:outcome}))
    const preview=await query()
    expect(preview.cases[0]).toMatchObject({amountMinor:outcome==='closed'?0:400,canApprove:outcome==='succeeded',canResolveUnpaid:outcome==='closed',pricing:{effectiveAmountMinor:3600}})
    // Read previews cannot reserve money or write pricing facts.
    expect((await pool.query('SELECT count(*)::int n FROM mbox.item_after_sales_price_resolutions WHERE case_id=$1',[original.value.caseId])).rows[0].n).toBe(0)
    if(outcome==='closed'){
      await service.resolveUnpaid({scope,employeeId,businessDate:businessDate,caseId:original.value.caseId,reason:'原款已关闭，接续原套餐停止',idempotencyKey:randomUUID()})
    }else{
      await service.decide({scope,employeeId:reviewerId,businessDate:businessDate,caseId:original.value.caseId,decision:'approved',reason:'已到账按原单点差额退款',idempotencyKey:randomUUID()})
    }
    expect(await runner.run(scope,tx=>new ItemQuantityReceivableRepository(tx).readOrder(row.orderId))).toMatchObject({effectiveAmountMinor:3600})
    expect((await query()).cases[0]).toMatchObject({caseId:original.value.caseId,stoppedQuantity:3,heldQuantity:0})
    expect((await pool.query('SELECT count(*)::int n FROM mbox.item_after_sales_cases WHERE order_id=$1',[row.orderId])).rows[0].n).toBe(1)
  })

  it('keeps a merged multi-bundle line paused when original package membership cannot be proven',async()=>{
    await grantActor(employeeId,['refund.request']);await grantActor(reviewerId,['refund.approve'],100000)
    const row=await pricedBundle()
    await pool.query('UPDATE mbox.order_items SET quantity=2,unit_price_minor=2000 WHERE id=$1',[row.parent]);await payment(row.orderId)
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    const created=await service.request({scope,employeeId,businessDate:businessDate,orderItemId:row.itemId,quantity:1,reason:'原多份套餐未保存逐套归属，不能取消其他完整套餐优惠',idempotencyKey:randomUUID()})
    expect(created.value).toMatchObject({heldQuantity:1,stoppedQuantity:0,amountMinor:null,refunds:[]})
    expect((await new ItemAfterSalesQuery(runner).item({scope,employeeId:reviewerId,itemId:row.itemId})).cases[0].canApprove).toBe(false)
    expect(await runner.run(scope,tx=>new ItemQuantityReceivableRepository(tx).readOrder(row.orderId))).toMatchObject({effectiveAmountMinor:4000})
  })

  it('a competing bundle approval requires a refreshed original request and then refunds the corrected difference once',async()=>{
    await grantActor(employeeId,['refund.request']);await grantActor(reviewerId,['refund.approve','refund.execute'],100000)
    const row=await pricedBundle();await payment(row.orderId)
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    const request=(quantity:number)=>service.request({scope,employeeId,businessDate:businessDate,orderItemId:row.itemId,quantity,reason:'同时申请套餐内不同份数',idempotencyKey:randomUUID()})
    const first=await request(2),second=await request(1)
    const approve=(caseId:string)=>service.decide({scope,employeeId:reviewerId,businessDate:businessDate,caseId,decision:'approved',reason:'核对保留商品及当前价差',idempotencyKey:randomUUID()})
    await approve(first.value.caseId)
    await expect(approve(second.value.caseId)).rejects.toThrow('原付款或套餐保留商品已变化')
    const revised=await service.revise({scope,employeeId,businessDate:businessDate,caseId:second.value.caseId,quantity:1,reason:'刷新原暂停申请计价，不再重复选菜',idempotencyKey:randomUUID()})
    expect(revised.value.amountMinor).toBe(400)
    await approve(revised.value.caseId);await manualResult(revised.value.refunds[0]!.id,true)
    expect(await runner.run(scope,tx=>new ItemQuantityReceivableRepository(tx).readOrder(row.orderId))).toMatchObject({effectiveAmountMinor:3600})
    expect((await pool.query("SELECT sum(amount_minor)::int amount FROM mbox.refunds WHERE order_id=$1 AND status='succeeded'",[row.orderId])).rows[0].amount).toBe(400)
  })

  it('runtime pricing is scoped and canonical, with no direct money override permission',async()=>{
    const row=await pricedBundle();await payment(row.orderId)
    const created=await hold(row.itemId,3)
    const result=await runner.run(scope,async tx=>{await tx.query('SET LOCAL ROLE mbox_runtime');return new ItemQuantityRefundRepository(tx).prepare(created.caseId)})
    expect(result.status).toBe('prepared')
    expect((await pool.query('SELECT amount_minor::int amount FROM mbox.refunds WHERE id=$1',[result.refundIds[0]])).rows[0].amount).toBe(400)
    await expect(runner.run(scope,async tx=>{await tx.query('SET LOCAL ROLE mbox_runtime');await tx.query('UPDATE mbox.item_after_sales_price_resolutions SET refund_amount_minor=999999 WHERE case_id=$1',[created.caseId])})).rejects.toThrow('permission denied')
    await runner.run({tenantId:randomUUID(),storeId:randomUUID()},async tx=>{
      await tx.query('SET LOCAL ROLE mbox_runtime')
      expect((await tx.query('SELECT snapshot FROM mbox.item_after_sales_price_resolutions WHERE case_id=$1',[created.caseId])).rows).toHaveLength(0)
      expect((await tx.query('SELECT mbox.quote_after_sales_price($1) AS quote',[created.caseId])).rows[0].quote).toBeNull()
    })
  })

  it('a late successful payment unlocks one approval on the original paused case without restarting its goods',async()=>{
    await grantActor(employeeId,['refund.request']);await grantActor(reviewerId,['refund.approve'],100000)
    const row=await item(),publicId=`late-quantity-${randomUUID()}`
    await runner.run(scope,tx=>new PaymentRepository(tx).createForOrder({orderId:row.orderId,publicId,provider:'postar',method:'native_qr',initialStatus:'created',principal:{type:'employee',employeeId}}))
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    const created=await service.request({scope,employeeId,businessDate:businessDate,orderItemId:row.itemId,quantity:2,reason:'扫码付款还未返回，先停止',idempotencyKey:`late-pause-${randomUUID()}`})
    const read=()=>new ItemAfterSalesQuery(runner).item({scope,employeeId:reviewerId,itemId:row.itemId})
    expect(created.value).toMatchObject({kind:'payment_review',heldQuantity:2,refunds:[]})
    expect((await read()).cases[0].canApprove).toBe(false)
    await runner.run(scope,tx=>new PaymentRepository(tx).applySucceededCallback({paymentPublicId:publicId,provider:'postar',providerTransactionId:`late-provider-${randomUUID()}`,reportedAmountMinor:4000,reportedCurrency:'CNY'}))
    const reviewed=(await read()).cases[0]
    expect(reviewed).toMatchObject({canApprove:true,heldQuantity:2,refunds:[]})
    const approved=await service.decide({scope,employeeId:reviewerId,businessDate:businessDate,caseId:created.value.caseId,decision:'approved',reason:'确认原付款已成功，原路退两份',idempotencyKey:`late-review-${randomUUID()}`})
    expect(approved.value).toMatchObject({heldQuantity:0,stoppedQuantity:2,moneyComplete:false,refunds:[{amountMinor:1600,status:'processing'}]})
    expect((await pool.query('SELECT count(*)::int n FROM mbox.item_after_sales_cases WHERE order_id=$1',[row.orderId])).rows[0].n).toBe(1)
  })

  it('finishes the original pending-money stop after definitive closure, without a refund or temporary production resume',async()=>{
    await grantActor(employeeId,['refund.request','order.cancel_unpaid'])
    const row=await item(),stockId=await stock(row,'direct_sale'),publicId=`closed-quantity-${randomUUID()}`
    await runner.run(scope,tx=>new PaymentRepository(tx).createForOrder({orderId:row.orderId,publicId,provider:'postar',method:'native_qr',initialStatus:'created',principal:{type:'employee',employeeId}}))
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    const created=await service.request({scope,employeeId,businessDate:businessDate,orderItemId:row.itemId,quantity:2,reason:'等待原付款核对，先停两瓶',idempotencyKey:`close-pause-${randomUUID()}`})
    const read=()=>new ItemAfterSalesQuery(runner).item({scope,employeeId,itemId:row.itemId})
    expect((await read()).cases[0].canResolveUnpaid).toBe(false)
    const input={scope,employeeId,businessDate:businessDate,caseId:created.value.caseId,reason:'原付款已确认关闭，继续停止',idempotencyKey:`close-resolve-${randomUUID()}`}
    await expect(service.resolveUnpaid(input)).rejects.toThrow('原付款仍有已收或未确认结果')
    expect(await balance(stockId)).toEqual({on_hand:'5.000000',reserved:'0.000000'})
    await runner.run(scope,tx=>new PaymentRepository(tx).applyProviderQueryResult({paymentPublicId:publicId,provider:'postar',providerTransactionId:`closed-provider-${randomUUID()}`,reportedAmountMinor:4000,reportedCurrency:'CNY',status:'closed'}))
    expect((await read()).cases[0].canResolveUnpaid).toBe(true)
    const resolved=await service.resolveUnpaid(input)
    expect(resolved.value).toMatchObject({kind:'unpaid_stop',status:'completed',stoppedQuantity:2,heldQuantity:0,moneyComplete:true,refunds:[]})
    expect((await service.resolveUnpaid({...input,businessDate:nextBusinessDate})).replayed).toBe(true)
    expect(await balance(stockId)).toEqual({on_hand:'7.000000',reserved:'0.000000'})
    expect((await pool.query('SELECT kind,resolved_kind FROM mbox.item_after_sales_cases WHERE id=$1',[created.value.caseId])).rows[0]).toEqual({kind:'payment_review',resolved_kind:'unpaid_stop'})
    await expect(pool.query('UPDATE mbox.item_after_sales_cases SET resolved_kind=NULL WHERE id=$1',[created.value.caseId])).rejects.toThrow('cannot be rewritten')
    await expect(runner.run(scope,tx=>new PaymentRepository(tx).createForOrder({...cashInput(),orderId:row.orderId}))).resolves.toMatchObject({amountMinor:2400})
    expect((await pool.query("SELECT count(*)::int n FROM mbox.item_after_sales_events WHERE case_id=$1 AND event_type='quantity.resumed'",[created.value.caseId])).rows[0].n).toBe(0)
  })

  it.each([{quantity:2,collected:false},{quantity:2,collected:true},{quantity:5,collected:false}])('keeps $quantity stopped shares closed and exposes a late capture against effective receivables (remaining collected=$collected)',async({quantity,collected})=>{
    await grantActor(employeeId,['refund.request']);await grantActor(reviewerId,['refund.approve','refund.execute'],100000)
    const row=await item(),stockId=await stock(row,'direct_sale'),publicId=`late-after-stop-${randomUUID()}`
    await runner.run(scope,tx=>new PaymentRepository(tx).createForOrder({orderId:row.orderId,publicId,provider:'postar',method:'native_qr',initialStatus:'created',principal:{type:'employee',employeeId}}))
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    const request=(await service.request({scope,employeeId,businessDate:businessDate,orderItemId:row.itemId,quantity,reason:'原付款核对中先停止所选瓶数',idempotencyKey:`late-stop-request-${randomUUID()}`})).value
    const providerTransactionId=`late-confirmed-${randomUUID()}`
    await runner.run(scope,tx=>new PaymentRepository(tx).applyProviderQueryResult({paymentPublicId:publicId,provider:'postar',providerTransactionId,reportedAmountMinor:4000,reportedCurrency:'CNY',status:'closed'}))
    await service.resolveUnpaid({scope,employeeId,businessDate:businessDate,caseId:request.caseId,reason:'原付款已确认关闭，停止所选瓶数',idempotencyKey:`late-stop-resolve-${randomUUID()}`})
    if(collected)await runner.run(scope,tx=>new PaymentRepository(tx).createForOrder({...cashInput(),orderId:row.orderId}))
    const integrationRef='quantity-late-capture-isolated',occurredAt=new Date().toISOString()
    const verifiedObservationId=await new VerifiedProviderObservationService(runner).recordPayment({scope,provider:'postar',verificationKind:'callback_signature',providerEventId:`late-event-${randomUUID()}`,integrationRef,providerTransactionId,reportedAmountMinor:4000,reportedCurrency:'CNY',occurredAt,paymentPublicId:publicId,status:'succeeded'})
    const callback={...financialMetadata(),actor:{type:'integration' as const,ref:integrationRef},verifiedObservationId,paymentPublicId:publicId,provider:'postar' as const,providerTransactionId,reportedAmountMinor:4000,reportedCurrency:'CNY',occurredAt}
    const capture=await financialService().recordSucceededCallback(callback)
    expect((await financialService().recordSucceededCallback(callback)).replayed).toBe(true)
    const signals=()=>runner.run(scope,async tx=>{await tx.query('SET LOCAL ROLE mbox_runtime');return (await tx.query("SELECT signal FROM mbox.payment_financial_monitoring_signals WHERE subject_id=$1 AND signal='order_overcollected'",[row.orderId])).rows})
    expect(await signals()).toEqual([{signal:'order_overcollected'}])
    expect((await pool.query("SELECT count(*)::int n,sum(amount_minor)::int amount FROM mbox.reconciliation_entries WHERE payment_id=$1 AND entry_type='payment'",[capture.value.id])).rows[0]).toEqual({n:1,amount:4000})
    const excess=collected?4000:quantity*800
    const cashier=async()=>{
      const view=await new PostgresCashierWorkbenchQuery(runner).get({scope,employeeId:reviewerId,businessDate:businessDate,capabilities:['refund.request','refund.execute'],query:`quantity-${row.orderId}`,limit:20})
      return view.orders.find(order=>order.id===row.orderId)!.payments.find(payment=>payment.id===capture.value.id)!
    }
    const refundInput={...financialMetadata(),actor:{type:'employee' as const,employeeId},paymentId:capture.value.id,publicId:`late-refund-${randomUUID()}`,purpose:collected?'duplicate_payment' as const:'price_adjustment' as const,reason:'核对停止减免后的原多收款，商品保持原进度',allocations:[{orderItemId:row.itemId,amountMinor:excess}]}
    if(quantity===5){
      expect((await cashier()).refundableItems[0]).toMatchObject({fundsOnly:true,remainingRefundableMinor:4000})
      await expect(financialService().requestRefund({...refundInput,purpose:'return_goods'})).rejects.toThrow('cancelled')
      await expect(financialService().requestRefund({...refundInput,purpose:'service_compensation'})).rejects.toThrow('cancelled')
    }
    const refund=(await financialService().requestRefund(refundInput)).value
    if(quantity===5){
      expect((await cashier()).refundableItems[0]).toMatchObject({fundsOnly:true,remainingRefundableMinor:0})
      await expect(financialService().requestRefund({...refundInput,...financialMetadata(),actor:{type:'employee',employeeId},publicId:`late-duplicate-${randomUUID()}`})).rejects.toThrow('cancelled')
    }
    await financialService().approveRefund({...financialMetadata(),refundId:refund.id,decisionReason:'只退原多收款，不再次停止或退库'})
    expect(await signals()).toHaveLength(1)
    await onlineObservation(refund.id,true)
    expect(await signals()).toEqual([])
    expect((await new ItemAfterSalesQuery(runner).item({scope,employeeId,itemId:row.itemId})).cases[0]).toMatchObject({status:'completed',kind:'unpaid_stop',stoppedQuantity:quantity,heldQuantity:0,refunds:[]})
    expect(await balance(stockId)).toEqual({on_hand:`${5+quantity}.000000`,reserved:'0.000000'})
    expect((await pool.query("SELECT count(*)::int n FROM mbox.item_after_sales_events WHERE case_id=$1 AND event_type='quantity.resumed'",[request.caseId])).rows[0].n).toBe(0)
    expect((await pool.query('SELECT count(*)::int n FROM mbox.item_receivable_adjustments WHERE case_id=$1',[request.caseId])).rows[0].n).toBe(1)
    expect((await pool.query('SELECT payment_status FROM mbox.orders WHERE id=$1',[row.orderId])).rows[0].payment_status).toBe('paid')
    expect((await pool.query('SELECT status FROM mbox.payments WHERE id=$1',[capture.value.id])).rows[0].status).toBe(excess===4000?'refunded':'partially_refunded')
  })

  it('does not admit a generic cancelled item to quantity late-capture refunds without original waiver evidence',async()=>{
    const row=await item(),paymentId=await payment(row.orderId,'postar')
    await pool.query("UPDATE mbox.order_items SET status='cancelled' WHERE id=$1",[row.itemId])
    await pool.query("UPDATE mbox.payments SET provider_snapshot=provider_snapshot||'{\"lateSuccessAfterClose\":true}'::jsonb WHERE id=$1",[paymentId])
    await expect(runner.run(scope,tx=>new RefundRepository(tx).request({paymentId,publicId:`not-quantity-${randomUUID()}`,requestedByEmployeeId:employeeId,purpose:'price_adjustment',reason:'旧单无逐份减免原证据，不能套用数量入口',allocations:[{orderItemId:row.itemId,amountMinor:4000}]}))).rejects.toThrow('cancelled')
    expect((await pool.query('SELECT count(*)::int n FROM mbox.refunds WHERE payment_id=$1',[paymentId])).rows[0].n).toBe(0)
  })

  it('one independent approval applies an explicit multi-payment split and never guesses a channel order',async()=>{
    await grantActor(employeeId,['refund.request']);await grantActor(reviewerId,['refund.approve'],100000)
    const row=await item();const cash=await payment(row.orderId,'cash',2000),online=await payment(row.orderId,'postar',2000)
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    const created=await service.request({scope,employeeId,businessDate:businessDate,orderItemId:row.itemId,quantity:2,reason:'原两笔付款退两瓶',idempotencyKey:`split-request-${randomUUID()}`})
    expect(created.value.refunds).toHaveLength(0)
    const input={scope,employeeId:reviewerId,businessDate:businessDate,caseId:created.value.caseId,decision:'approved' as const,reason:'按两笔原付款各退八元',idempotencyKey:`split-review-${randomUUID()}`}
    await expect(service.decide({...input,funding:[{paymentId:cash,amountMinor:1601}]})).rejects.toThrow('合计必须等于')
    expect((await runner.run(scope,tx=>new ItemAfterSalesProgressRepository(tx).read(created.value.caseId))).refunds).toHaveLength(0)
    const funding=[{paymentId:cash,amountMinor:800},{paymentId:online,amountMinor:800}]
    const failing=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),{apply:async()=>{throw new Error('forced approval effect failure')}})
    await expect(failing.decide({...input,funding})).rejects.toThrow('forced approval effect failure')
    expect((await pool.query('SELECT status FROM mbox.item_after_sales_cases WHERE id=$1',[created.value.caseId])).rows[0].status).toBe('requested')
    expect((await pool.query('SELECT count(*)::int n FROM mbox.item_after_sales_case_refunds WHERE case_id=$1',[created.value.caseId])).rows[0].n).toBe(0)
    expect((await pool.query("SELECT count(*)::int n FROM mbox.refunds WHERE order_id=$1 AND auto_execute_requested_at IS NOT NULL",[row.orderId])).rows[0].n).toBe(0)
    const approved=await service.decide({...input,funding})
    expect(approved.value).toMatchObject({stoppedQuantity:2,physicalComplete:true,moneyComplete:false,awaitingCashPayout:true})
    expect(approved.value.refunds).toHaveLength(2)
    const statuses=new Map(approved.value.refunds.map(refund=>[refund.provider,refund.status]))
    expect(statuses.get('cash')).toBe('approved');expect(statuses.get('postar')).toBe('processing')
    expect((await service.decide({...input,funding:[...funding].reverse()})).replayed).toBe(true)
    expect((await pool.query("SELECT count(*)::int n FROM mbox.audit_events WHERE object_id=$1 AND action='item_after_sales.approved'",[created.value.caseId])).rows[0].n).toBe(1)
    await expect(runner.run(scope,tx=>new ItemQuantityRefundRepository(tx).prepare(created.value.caseId,[{paymentId:cash,amountMinor:1600}]))).rejects.toThrow('不能替换')
  })

  it('retains a completed stop in handover until the station knows, even when printing fails, without undoing stock or money',async()=>{
    await grantActor(employeeId,['refund.request','order.cancel_unpaid'])
    const row=await item(),stockId=await stock(row,'direct_sale')
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    const created=await service.request({scope,employeeId,businessDate:businessDate,orderItemId:row.itemId,quantity:1,reason:'客人停止一瓶',idempotencyKey:`notice-stop-${randomUUID()}`})
    expect(created.value).toMatchObject({status:'completed',moneyComplete:true,physicalComplete:true,unconfirmedNoticeCount:1})
    await pool.query(`UPDATE mbox.print_source_jobs SET status='dead' WHERE source_outbox_message_id IN (SELECT source_outbox_message_id FROM mbox.item_after_sales_notices WHERE case_id=$1)`,[created.value.caseId])
    const query=new ItemAfterSalesQuery(runner),read=()=>query.item({scope,employeeId,itemId:row.itemId})
    const current=(await read()).cases.find(value=>value.caseId===created.value.caseId)!
    expect(current.notices).toHaveLength(1);expect(current.notices[0]).toMatchObject({stationCode:'bar',printState:'attention'})
    const pending=()=>new ItemAfterSalesHandoverQuery(runner).list({scope,employeeId,limit:100})
    expect((await pending()).items.some(value=>value.caseId===current.caseId)).toBe(true)
    const input={scope,employeeId,businessDate:businessDate,caseId:current.caseId,noticeIds:current.notices.map(value=>value.id),reason:'已电话联系吧台确认本通知',idempotencyKey:`notice-ack-${randomUUID()}`}
    const acknowledged=await service.acknowledgeNotices(input)
    expect(acknowledged.value).toMatchObject({status:'completed',unconfirmedNoticeCount:0})
    expect((await service.acknowledgeNotices({...input,businessDate:nextBusinessDate})).replayed).toBe(true)
    expect((await pending()).items.some(value=>value.caseId===current.caseId)).toBe(false)
    expect(await balance(stockId)).toEqual({on_hand:'6.000000',reserved:'0.000000'})
    expect((await pool.query('SELECT count(*)::int n FROM mbox.item_receivable_adjustments WHERE case_id=$1',[current.caseId])).rows[0].n).toBe(1)
    expect((await pool.query("SELECT count(*)::int n FROM mbox.audit_events WHERE object_id=$1 AND action='item_after_sales.notice_ack'",[current.caseId])).rows[0].n).toBe(1)
  })

  it('acknowledges only shown notice versions and cannot acknowledge another case or discard later instructions',async()=>{
    const row=await item('pending',1)
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    const requested=await service.request({scope,employeeId,businessDate:businessDate,orderItemId:row.itemId,quantity:1,reason:'暂时停止核对',idempotencyKey:`notice-version-${randomUUID()}`})
    const first=(await new ItemAfterSalesQuery(runner).item({scope,employeeId,itemId:row.itemId})).cases[0]!.notices
    await service.decide({scope,employeeId,businessDate:businessDate,caseId:requested.value.caseId,decision:'withdrawn',reason:'客人考虑保留',idempotencyKey:`notice-withdraw-${randomUUID()}`})
    const input={scope,employeeId,businessDate:businessDate,caseId:requested.value.caseId,noticeIds:first.map(value=>value.id),reason:'只确认已展示的通知',idempotencyKey:`notice-version-ack-${randomUUID()}`}
    await expect(service.acknowledgeNotices({...input,noticeIds:[randomUUID()]})).rejects.toThrow('不属于原商品申请')
    expect((await service.acknowledgeNotices(input)).value).toMatchObject({status:'withdrawn',heldQuantity:1,unconfirmedNoticeCount:1})
    const remaining=(await new ItemAfterSalesQuery(runner).item({scope,employeeId,itemId:row.itemId})).cases[0]!
    expect(remaining.notices).toHaveLength(1);expect(remaining.notices[0].instruction).toBe('保持暂停，等明确继续')
  })

  it('prepares one exact cash refund and a single independent approval returns only selected stock',async()=>{
    const row=await item(),stockId=await stock(row,'direct_sale');await payment(row.orderId)
    const created=await hold(row.itemId,2)
    const prepare=()=>runner.run(scope,tx=>new ItemQuantityRefundRepository(tx).prepare(created.caseId))
    const prepared=await prepare();expect(prepared.status).toBe('prepared');expect(prepared.refundIds).toHaveLength(1)
    expect(await prepare()).toEqual({...prepared,replayed:true})
    const decide=(actor:string)=>runner.run(scope,tx=>new ItemQuantityRefundRepository(tx).decide({caseId:created.caseId,employeeId:actor,decision:'approved',reason:'原单退两瓶'}))
    await expect(decide(employeeId)).rejects.toThrow('另一位')
    const approved=await decide(reviewerId);expect(approved).toMatchObject({status:'approved',inventoryReview:false,replayed:false})
    expect(await decide(reviewerId)).toEqual({...approved,replayed:true})
    expect((await pool.query('SELECT status,amount_minor::int AS amount,auto_execute_requested_at,completed_at FROM mbox.refunds WHERE id=$1',[prepared.refundIds[0]])).rows[0]).toEqual({status:'approved',amount:1600,auto_execute_requested_at:null,completed_at:null})
    expect(await balance(stockId)).toEqual({on_hand:'7.000000',reserved:'0.000000'})
    expect((await pool.query('SELECT status,completed_at FROM mbox.item_after_sales_cases WHERE id=$1',[created.caseId])).rows[0]).toEqual({status:'approved',completed_at:null})
    expect(await prepare()).toEqual({...prepared,replayed:true})
    const progress=()=>runner.run(scope,tx=>new ItemAfterSalesProgressRepository(tx).synchronize(created.caseId))
    expect(await progress()).toMatchObject({status:'approved',physicalComplete:true,moneyComplete:false,awaitingCashPayout:true})
    await runner.run(scope,async tx=>{
      const refunds=new RefundRepository(tx);await refunds.beginExecution(prepared.refundIds[0])
      await refunds.completeManualExecution({refundId:prepared.refundIds[0],succeeded:true,receiptReference:''})
      await refunds.syncPaymentRefundStatus((await tx.query<{payment_id:string}>('SELECT payment_id FROM mbox.refunds WHERE id=$1',[prepared.refundIds[0]])).rows[0].payment_id)
      await new PaymentRepository(tx).syncOrderPaymentStatus(row.orderId)
      await new RefundFulfillmentRepository(tx).synchronize(row.orderId,prepared.refundIds[0])
      await new ItemAfterSalesProgressRepository(tx).synchronizeRefund(row.orderId,prepared.refundIds[0])
    })
    expect(await progress()).toMatchObject({status:'completed',physicalComplete:true,moneyComplete:true,succeededMinor:1600,heldQuantity:0,stoppedQuantity:2})
    expect(await balance(stockId)).toEqual({on_hand:'7.000000',reserved:'0.000000'})
    expect((await pool.query("SELECT count(*)::int n FROM mbox.audit_events WHERE object_id=$1 AND action='item_after_sales.completed'",[created.caseId])).rows[0].n).toBe(1)
  })
  it('one approved online refund queues original execution without an extra reviewer or provider call',async()=>{
    const row=await item();await payment(row.orderId,'postar')
    const created=await hold(row.itemId,1)
    const prepared=await runner.run(scope,tx=>new ItemQuantityRefundRepository(tx).prepare(created.caseId))
    await runner.run(scope,tx=>new ItemQuantityRefundRepository(tx).decide({caseId:created.caseId,employeeId:reviewerId,decision:'approved',reason:'同意原路退一瓶'}))
    expect((await pool.query('SELECT status,approved_by_employee_id,auto_execute_requested_at IS NOT NULL AS queued,provider_submission_state FROM mbox.refunds WHERE id=$1',[prepared.refundIds[0]])).rows[0]).toEqual({status:'processing',approved_by_employee_id:reviewerId,queued:true,provider_submission_state:'not_started'})
  })
  it('failed money stays open after physical return and does not restart goods or return stock twice',async()=>{
    const row=await item(),stockId=await stock(row,'direct_sale');await payment(row.orderId)
    const created=await hold(row.itemId,1),prepared=await runner.run(scope,tx=>new ItemQuantityRefundRepository(tx).prepare(created.caseId))
    await runner.run(scope,tx=>new ItemQuantityRefundRepository(tx).decide({caseId:created.caseId,employeeId:reviewerId,decision:'approved',reason:'原退货审核'}))
    await runner.run(scope,async tx=>{const refunds=new RefundRepository(tx);await refunds.beginExecution(prepared.refundIds[0]);await refunds.completeManualExecution({refundId:prepared.refundIds[0],succeeded:false,receiptReference:''})})
    const progress=()=>runner.run(scope,tx=>new ItemAfterSalesProgressRepository(tx).synchronize(created.caseId))
    expect(await progress()).toMatchObject({status:'approved',moneyComplete:false,physicalComplete:true,refundFailed:true,stoppedQuantity:1})
    await progress();expect(await balance(stockId)).toEqual({on_hand:'6.000000',reserved:'0.000000'})
    await expect(runner.run(scope,tx=>new ItemQuantityRepository(tx).resume({caseId:created.caseId,employeeId}))).rejects.toThrow('先处理原退款')
  })
  function financialService(){return new PaymentCommandService(new NormalizedCommandExecutor(runner),new NormalizedPaymentCapabilityAuthorization(),new NormalizedProviderObservationAuthority())}
  function financialMetadata(){return {scope,actor:{type:'employee' as const,employeeId:reviewerId},businessDate:businessDate,idempotencyKey:`quantity-finance-${randomUUID()}`,requestFingerprint:randomUUID()}}
  async function manualResult(refundId:string,succeeded:boolean){
    const service=financialService()
    await service.beginRefundExecution({...financialMetadata(),refundId})
    return service.recordManualRefundResult({...financialMetadata(),refundId,succeeded,receiptReference:''})
  }
  async function onlineObservation(refundId:string,succeeded:boolean,consume=true){
    const original=(await pool.query('SELECT refund.public_id,refund.amount_minor::int amount,refund.provider_refund_id,payment.provider_transaction_id FROM mbox.refunds refund JOIN mbox.payments payment ON payment.id=refund.payment_id WHERE refund.id=$1',[refundId])).rows[0]
    const providerRefundId=original.provider_refund_id??`q-terminal-${randomUUID()}`,integrationRef='quantity-isolated-fixture',occurredAt=new Date().toISOString()
    const verifiedObservationId=await new VerifiedProviderObservationService(runner).recordRefund({scope,provider:'postar',verificationKind:'active_query_binding',providerEventId:`quantity-observation-${randomUUID()}`,integrationRef,providerTransactionId:providerRefundId,
      reportedAmountMinor:original.amount,reportedCurrency:'CNY',occurredAt,refundPublicId:original.public_id,status:succeeded?'succeeded':'failed',originalProviderTransactionId:original.provider_transaction_id})
    if(consume)await financialService().recordProviderRefundResult({...financialMetadata(),actor:{type:'integration',ref:integrationRef},verifiedObservationId,refundPublicId:original.public_id,provider:'postar',providerRefundId,
      originalProviderTransactionId:original.provider_transaction_id,reportedAmountMinor:original.amount,reportedCurrency:'CNY',succeeded,occurredAt})
    return verifiedObservationId
  }
  it('retries only confirmed failed funding after another channel succeeded, with one original approval and one stock return',async()=>{
    await grantActor(employeeId,['refund.request']);await grantActor(reviewerId,['refund.approve','refund.execute'],100000)
    const row=await item(),stockId=await stock(row,'direct_sale'),cash=await payment(row.orderId,'cash',2000),online=await payment(row.orderId,'postar',2000)
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    const requested=await service.request({scope,employeeId,businessDate:businessDate,orderItemId:row.itemId,quantity:2,reason:'组合付款退两瓶',idempotencyKey:`retry-request-${randomUUID()}`}),caseId=requested.value.caseId
    const approved=await service.decide({scope,employeeId:reviewerId,businessDate:businessDate,caseId,decision:'approved',funding:[{paymentId:cash,amountMinor:800},{paymentId:online,amountMinor:800}],reason:'一次批准原分摊',idempotencyKey:`retry-review-${randomUUID()}`})
    const cashRefund=approved.value.refunds.find(refund=>refund.provider==='cash')!.id,onlineRefund=approved.value.refunds.find(refund=>refund.provider==='postar')!.id
    const input={scope,employeeId:reviewerId,businessDate:businessDate,caseId,refundId:onlineRefund,reason:'重试已核实失败的一笔',idempotencyKey:`retry-attempt-${randomUUID()}`}
    await expect(service.retryRefund(input)).rejects.toThrow('尚未确认失败')
    await manualResult(cashRefund,true)
    await onlineObservation(onlineRefund,false,false)
    await expect(service.retryRefund(input)).rejects.toThrow('尚未确认失败')
    await onlineObservation(onlineRefund,false)
    const facts=()=>runner.run(scope,tx=>new ItemAfterSalesProgressRepository(tx).read(caseId))
    expect(await facts()).toMatchObject({refundFailed:true,succeededMinor:800,physicalComplete:true,moneyComplete:false})
    const read=await new ItemAfterSalesQuery(runner).item({scope,employeeId:reviewerId,itemId:row.itemId})
    expect(read.cases[0].refunds.find(refund=>refund.id===onlineRefund)?.canRetry).toBe(true)
    await expect(service.retryRefund({...input,employeeId})).rejects.toThrow()
    const runtimeTransactions={run:<T>(current:typeof scope,operation:(tx:import('./transaction-runner.js').ScopedTransaction)=>Promise<T>)=>runner.run(current,async tx=>{await tx.query('SET LOCAL ROLE mbox_runtime');return operation(tx)})} as ScopedPostgresTransactionRunner
    const runtimeService=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runtimeTransactions),new ItemAfterSalesOperatingEffects())
    const attempts=await Promise.all([runtimeService.retryRefund(input),runtimeService.retryRefund({...input,idempotencyKey:`retry-other-${randomUUID()}`})])
    const replacements=(await pool.query('SELECT replacement_refund_id FROM mbox.item_after_sales_refund_retries WHERE case_id=$1',[caseId])).rows
    expect(replacements).toHaveLength(1)
    const replacement=replacements[0].replacement_refund_id
    for(const result of attempts)expect(result.value).toMatchObject({refundFailed:false,succeededMinor:800,moneyComplete:false})
    expect((await service.retryRefund({...input,businessDate:nextBusinessDate})).replayed).toBe(true)
    const original=(await pool.query('SELECT status,approved_by_employee_id FROM mbox.refunds WHERE id=$1',[onlineRefund])).rows[0]
    expect(original).toEqual({status:'failed',approved_by_employee_id:reviewerId})
    expect((await pool.query('SELECT payment_id,status,approved_by_employee_id,auto_execute_requested_at IS NOT NULL queued FROM mbox.refunds WHERE id=$1',[replacement])).rows[0]).toEqual({payment_id:online,status:'processing',approved_by_employee_id:reviewerId,queued:true})
    await onlineObservation(replacement,true)
    expect(await facts()).toMatchObject({status:'completed',succeededMinor:1600,refundFailed:false,moneyComplete:true,physicalComplete:true})
    expect(await balance(stockId)).toEqual({on_hand:'7.000000',reserved:'0.000000'})
    expect((await pool.query("SELECT count(*)::int n FROM mbox.audit_events WHERE object_id=$1 AND action='item_after_sales.approved'",[caseId])).rows[0].n).toBe(1)
    expect((await pool.query("SELECT count(*)::int n,sum(amount_minor)::int amount FROM mbox.reconciliation_entries WHERE refund_id=ANY($1::uuid[]) AND entry_type='refund'",[[cashRefund,onlineRefund,replacement]])).rows[0]).toEqual({n:2,amount:-1600})
    expect((await pool.query('SELECT count(*)::int n FROM mbox.item_after_sales_notices WHERE case_id=$1',[caseId])).rows[0].n).toBe(2)
    expect((await runner.run(scope,tx=>new ItemQuantityRefundRepository(tx).prepare(caseId,[{paymentId:cash,amountMinor:800},{paymentId:online,amountMinor:800}]))).refundIds.sort()).toEqual([cashRefund,replacement].sort())
    const closedHistory=await runner.run(scope,tx=>readOperatingHistory(tx,{businessDate:nextBusinessDate,earliestBusinessDate:nextBusinessDate,search:`quantity-${row.orderId}`,table:'',employee:'',page:0,allowFinancialSummary:false}))
    expect(closedHistory.orders).toHaveLength(0)
    await expect(service.retryRefund({...input,refundId:cashRefund,idempotencyKey:`retry-success-${randomUUID()}`})).rejects.toThrow('尚未确认失败')
  })
  it('requires manual failure evidence and preserves cash payout as an actual separate action after retry',async()=>{
    const row=await item();await payment(row.orderId)
    const created=await hold(row.itemId,1),prepared=await runner.run(scope,tx=>new ItemQuantityRefundRepository(tx).prepare(created.caseId))
    await runner.run(scope,tx=>new ItemQuantityRefundRepository(tx).decide({caseId:created.caseId,employeeId:reviewerId,decision:'approved',reason:'原单同意退一份'}))
    await manualResult(prepared.refundIds[0],false)
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    const result=await service.retryRefund({scope,employeeId:reviewerId,businessDate:businessDate,caseId:created.caseId,refundId:prepared.refundIds[0],reason:'现金未交付重试原退付',idempotencyKey:`retry-cash-${randomUUID()}`})
    expect(result.value).toMatchObject({awaitingCashPayout:true,moneyComplete:false,refundFailed:false})
    const replacement=result.value.refunds.find(refund=>refund.id!==prepared.refundIds[0])!
    expect(replacement.status).toBe('approved')
    expect(result.value.refunds.find(refund=>refund.id===prepared.refundIds[0])).toMatchObject({status:'failed',replacedByRefundId:replacement.id,canRetry:false})
    await manualResult(replacement.id,true)
    expect(await runner.run(scope,tx=>new ItemAfterSalesProgressRepository(tx).read(created.caseId))).toMatchObject({status:'completed',succeededMinor:800})
  })
  it('retries a confirmed failure after every original unit was already stopped',async()=>{
    await grantActor(employeeId,['refund.request']);await grantActor(reviewerId,['refund.approve','refund.execute'],100000)
    const row=await item(),stockId=await stock(row,'direct_sale');await payment(row.orderId)
    const created=await hold(row.itemId,5),prepared=await runner.run(scope,tx=>new ItemQuantityRefundRepository(tx).prepare(created.caseId))
    await new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects()).decide({scope,employeeId:reviewerId,businessDate:businessDate,caseId:created.caseId,decision:'approved',reason:'全部五份停止退款',idempotencyKey:`review-all-${randomUUID()}`})
    expect((await pool.query('SELECT status FROM mbox.order_items WHERE id=$1',[row.itemId])).rows[0].status).toBe('cancelled')
    await manualResult(prepared.refundIds[0],false)
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    const retried=await service.retryRefund({scope,employeeId:reviewerId,businessDate:businessDate,caseId:created.caseId,refundId:prepared.refundIds[0],reason:'原整行已停，只接续退款',idempotencyKey:`retry-all-${randomUUID()}`})
    const replacement=retried.value.refunds.find(refund=>refund.id!==prepared.refundIds[0])!
    await manualResult(replacement.id,true)
    expect(await runner.run(scope,tx=>new ItemAfterSalesProgressRepository(tx).read(created.caseId))).toMatchObject({status:'completed',succeededMinor:4000})
    expect(await balance(stockId)).toEqual({on_hand:'10.000000',reserved:'0.000000'})
  })
  it('retains the original approved failed amount while allowing an unrelated refund within the actual remainder',async()=>{
    await grantActor(employeeId,['refund.request']);await grantActor(reviewerId,['refund.approve','refund.execute'],100000)
    const row=await item(),paymentId=await payment(row.orderId)
    const created=await hold(row.itemId,2),prepared=await runner.run(scope,tx=>new ItemQuantityRefundRepository(tx).prepare(created.caseId))
    await runner.run(scope,tx=>new ItemQuantityRefundRepository(tx).decide({caseId:created.caseId,employeeId:reviewerId,decision:'approved',reason:'原两份一次审核'}))
    await manualResult(prepared.refundIds[0],false)
    const another=(amountMinor:number)=>runner.run(scope,tx=>new RefundRepository(tx).request({paymentId,publicId:`other-refund-${randomUUID()}`,requestedByEmployeeId:employeeId,purpose:'price_adjustment',reason:'独立差价只处理剩余金额',allocations:[{orderItemId:row.itemId,amountMinor}]}))
    await expect(another(4000)).rejects.toThrow('Cumulative refunds')
    await expect(another(800)).resolves.toMatchObject({amountMinor:800,status:'requested'})
    const read=await new ItemAfterSalesQuery(runner).item({scope,employeeId:reviewerId,itemId:row.itemId})
    expect(read.fundingSources[0].availableMinor).toBe(1600)
    const cashier=await new PostgresCashierWorkbenchQuery(runner).get({scope,employeeId:reviewerId,businessDate:businessDate,capabilities:['refund.request','refund.execute'],query:`quantity-${row.orderId}`,limit:20})
    expect(cashier.orders.find(order=>order.id===row.orderId)?.payments[0]).toMatchObject({reservedRefundAmountMinor:2400,remainingRefundableMinor:1600,refundableItems:[{remainingRefundableMinor:1600}]})
    for(const override of [{allocations:[{orderItemId:row.itemId,amountMinor:800}]},{requestedByEmployeeId:reviewerId},{purpose:'price_adjustment' as const},{quantityRetryOf:''}]){
      await expect(runner.run(scope,tx=>new RefundRepository(tx).request({quantityRetryOf:prepared.refundIds[0],paymentId,publicId:`bad-retry-${randomUUID()}`,requestedByEmployeeId:employeeId,purpose:'return_goods',reason:'不能改写原重试事实',allocations:[{orderItemId:row.itemId,amountMinor:1600}],...override}))).rejects.toThrow()
    }
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    const retried=await service.retryRefund({scope,employeeId:reviewerId,businessDate:businessDate,caseId:created.caseId,refundId:prepared.refundIds[0],reason:'原额度仍可接续',idempotencyKey:`retry-held-amount-${randomUUID()}`})
    expect(retried.value.refunds.filter(refund=>!refund.replacedByRefundId).map(refund=>refund.amountMinor)).toEqual([1600])
  })
  it('keeps failed quantity approval within its combined-payment share while another original order refunds independently',async()=>{
    await grantActor(employeeId,['refund.request']);await grantActor(reviewerId,['refund.approve','refund.execute'],100000)
    const first=await item(),second=await item()
    const paid=await runner.run(scope,tx=>new PaymentRepository(tx).createForOrders({...cashInput(),orderIds:[first.orderId,second.orderId]}))
    const created=await hold(first.itemId,2),prepared=await runner.run(scope,tx=>new ItemQuantityRefundRepository(tx).prepare(created.caseId))
    await runner.run(scope,tx=>new ItemQuantityRefundRepository(tx).decide({caseId:created.caseId,employeeId:reviewerId,decision:'approved',reason:'原合付第一单退两份'}))
    await manualResult(prepared.refundIds[0],false)
    const another=(orderItemId:string,amountMinor:number)=>runner.run(scope,tx=>new RefundRepository(tx).request({paymentId:paid.id,publicId:`batch-other-${randomUUID()}`,requestedByEmployeeId:employeeId,purpose:'price_adjustment',reason:'仅原单可退余额',allocations:[{orderItemId,amountMinor}]}))
    await expect(another(first.itemId,3200)).rejects.toThrow('可退分摊金额')
    await expect(another(second.itemId,4000)).resolves.toMatchObject({amountMinor:4000,orderId:second.orderId})
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    const retried=await service.retryRefund({scope,employeeId:reviewerId,businessDate:businessDate,caseId:created.caseId,refundId:prepared.refundIds[0],reason:'接续原合付分摊',idempotencyKey:`retry-batch-${randomUUID()}`})
    const current=retried.value.refunds.find(refund=>!refund.replacedByRefundId)!
    expect(current).toMatchObject({amountMinor:1600,status:'approved'})
    expect((await new ItemAfterSalesQuery(runner).item({scope,employeeId:reviewerId,itemId:first.itemId})).fundingSources[0].availableMinor).toBe(2400)
    // Failing the replacement again transfers the same approval to one new leaf.
    await manualResult(current.id,false)
    const repeated=await service.retryRefund({scope,employeeId:reviewerId,businessDate:businessDate,caseId:created.caseId,refundId:current.id,reason:'仍未交付，原失败再接续',idempotencyKey:`retry-batch-again-${randomUUID()}`})
    expect(repeated.value.refunds.filter(refund=>!refund.replacedByRefundId)).toHaveLength(1)
    expect((await new ItemAfterSalesQuery(runner).item({scope,employeeId:reviewerId,itemId:first.itemId})).fundingSources[0].availableMinor).toBe(2400)
    expect((await pool.query('SELECT count(*)::int n FROM mbox.item_after_sales_cases WHERE order_id=$1',[second.orderId])).rows[0].n).toBe(0)
  })
  it('refuses a failed flag without evidence or with contradictory verified success',async()=>{
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    for(const provider of ['cash','postar']){
      const row=await item();await payment(row.orderId,provider)
      const created=await hold(row.itemId,1),prepared=await runner.run(scope,tx=>new ItemQuantityRefundRepository(tx).prepare(created.caseId))
      await runner.run(scope,tx=>new ItemQuantityRefundRepository(tx).decide({caseId:created.caseId,employeeId:reviewerId,decision:'approved',reason:'原退货审核'}))
      if(provider==='cash')await runner.run(scope,async tx=>{const refunds=new RefundRepository(tx);await refunds.beginExecution(prepared.refundIds[0]);await refunds.completeManualExecution({refundId:prepared.refundIds[0],succeeded:false,receiptReference:''})})
      else {await onlineObservation(prepared.refundIds[0],false);await onlineObservation(prepared.refundIds[0],true,false)}
      const input={scope,employeeId:reviewerId,businessDate:businessDate,caseId:created.caseId,refundId:prepared.refundIds[0],reason:'不能把异常当失败',idempotencyKey:`retry-no-proof-${randomUUID()}`}
      await expect(service.retryRefund(input)).rejects.toThrow('尚未确认失败')
      expect((await pool.query('SELECT count(*)::int n FROM mbox.item_after_sales_refund_retries WHERE case_id=$1',[created.caseId])).rows[0].n).toBe(0)
    }
  })
  it('withdrawal closes the original refund and keeps goods paused until an explicit resume',async()=>{
    const row=await item();await payment(row.orderId)
    const created=await hold(row.itemId,1)
    const prepared=await runner.run(scope,tx=>new ItemQuantityRefundRepository(tx).prepare(created.caseId))
    await expect(runner.run(scope,tx=>new RefundRepository(tx).approve(prepared.refundIds[0],reviewerId,'绕过商品申请'))).rejects.toThrow('same single case approval')
    await runner.run(scope,tx=>new ItemQuantityRefundRepository(tx).decide({caseId:created.caseId,employeeId,decision:'withdrawn',reason:'客人继续保留'}))
    expect((await pool.query('SELECT status FROM mbox.refunds WHERE id=$1',[prepared.refundIds[0]])).rows[0].status).toBe('cancelled')
    expect((await runner.run(scope,tx=>new ItemQuantityRepository(tx).readUnits(row.itemId))).filter(unit=>unit.held_by_case_id)).toHaveLength(1)
    await expect(runner.run(scope,tx=>new RefundRepository(tx).approve(prepared.refundIds[0],reviewerId,'迟到审批'))).rejects.toThrow()
    expect((await runner.run(scope,tx=>new ItemQuantityRepository(tx).resume({caseId:created.caseId,employeeId}))).resumedQuantity).toBe(1)
  })
  it('keeps unknown original pricing and multiple funding allocations for review without creating refunds',async()=>{
    const discounted=await item('pending',333);await payment(discounted.orderId,'cash',3667)
    const price=await hold(discounted.itemId,1)
    expect(await runner.run(scope,tx=>new ItemQuantityRefundRepository(tx).prepare(price.caseId))).toMatchObject({status:'price_review',refundIds:[]})
    const split=await item();await payment(split.orderId,'cash',2000);await payment(split.orderId,'postar',2000)
    const funding=await hold(split.itemId,1)
    expect(await runner.run(scope,tx=>new ItemQuantityRefundRepository(tx).prepare(funding.caseId))).toMatchObject({status:'payment_review',refundIds:[]})
    await expect(runner.run(scope,tx=>new ItemQuantityRefundRepository(tx).decide({caseId:funding.caseId,employeeId:reviewerId,decision:'approved',reason:'直接猜分摊'}))).rejects.toThrow('原成交金额')
  })
  it('consumes only the three unheld units and releases only the two stopped units once',async()=>{
    const row=await item(),stockId=await stock(row,'reserved'),created=await hold(row.itemId,2,'unpaid_stop')
    const units=await runner.run(scope,tx=>new ItemQuantityRepository(tx).readUnits(row.itemId))
    const freeIds=units.filter(unit=>!unit.held_by_case_id).map(unit=>unit.id)
    await runner.run(scope,tx=>new ItemUnitInventoryRepository(tx).consumeUnheldUnits({itemId:row.itemId,unitIds:freeIds,employeeId,taskId:row.taskId}))
    expect(await balance(stockId)).toEqual({on_hand:'7.000000',reserved:'2.000000'})
    const stop=()=>runner.run(scope,tx=>new ItemUnitInventoryRepository(tx).disposeUnmadeUnits({itemId:row.itemId,unitIds:created.unitIds,employeeId,caseId:created.caseId}))
    expect(await stop()).toEqual({releasedRecords:2,returnedRecords:0})
    expect(await stop()).toEqual({releasedRecords:0,returnedRecords:0})
    expect(await balance(stockId)).toEqual({on_hand:'7.000000',reserved:'0.000000'})
    await expect(runner.run(scope,tx=>new ItemUnitInventoryRepository(tx).consumeUnheldUnits({itemId:row.itemId,unitIds:created.unitIds,employeeId,taskId:row.taskId}))).rejects.toThrow('暂停或停止')
  })
  it('returns an unmade directly deducted unit with original cost, without returning the whole line',async()=>{
    const row=await item(),stockId=await stock(row,'direct_sale'),created=await hold(row.itemId,1,'unpaid_stop')
    await runner.run(scope,tx=>new ItemUnitInventoryRepository(tx).disposeUnmadeUnits({itemId:row.itemId,unitIds:created.unitIds,employeeId,caseId:created.caseId}))
    expect(await balance(stockId)).toEqual({on_hand:'6.000000',reserved:'0.000000'})
    const returns=(await pool.query("SELECT quantity_delta::text AS quantity,unit_cost_minor::text AS cost FROM mbox.inventory_movements WHERE order_item_id=$1 AND movement_type='return'",[row.itemId])).rows
    expect(returns).toEqual([{quantity:'1.000000',cost:'123.000000'}])
  })
  it('fractional allocation sums to the exact original lot and unknown legacy evidence cannot auto-resume',async()=>{
    const row=await item();await stock(row,'reserved','0.333333')
    await hold(row.itemId,1)
    expect((await pool.query('SELECT sum(quantity)::text AS quantity FROM mbox.order_item_unit_inventory stock JOIN mbox.order_item_quantity_units unit ON unit.id=stock.unit_id WHERE unit.order_item_id=$1',[row.itemId])).rows[0].quantity).toBe('0.333333')
    const legacy=await item();await pool.query("UPDATE mbox.order_items SET product_snapshot='{}' WHERE id=$1",[legacy.itemId])
    const created=await hold(legacy.itemId,1)
    await runner.run(scope,tx=>new ItemQuantityRepository(tx).decide({caseId:created.caseId,employeeId,decision:'withdrawn',reason:'先核对库存'}))
    await expect(runner.run(scope,tx=>new ItemQuantityRepository(tx).resume({caseId:created.caseId,employeeId}))).rejects.toThrow('库存原始记录尚未核对')
  })
  it('refuses cross-order cases, whole-line stock replay and premature completion',async()=>{
    const row=await item(),other=await item();await stock(row,'reserved')
    const created=await hold(row.itemId,1,'unpaid_stop'),otherCase=await hold(other.itemId,1)
    await expect(pool.query('UPDATE mbox.order_item_quantity_units SET held_by_case_id=$2 WHERE id=$1',[created.unitIds[0],otherCase.caseId])).rejects.toThrow('original order')
    await expect(pool.query('UPDATE mbox.item_after_sales_cases SET order_id=$2 WHERE id=$1',[created.caseId,other.orderId])).rejects.toThrow('immutable')
    await expect(pool.query("UPDATE mbox.item_after_sales_cases SET status='completed',completed_at=clock_timestamp() WHERE id=$1",[created.caseId])).rejects.toThrow('receivable disposition')
    await expect(pool.query(`INSERT INTO mbox.inventory_movements(tenant_id,store_id,inventory_item_id,movement_type,quantity_delta,reference_type,reference_id,order_item_id)
      SELECT tenant_id,store_id,inventory_item_id,'sale',-quantity,'order_item',order_item_id,order_item_id FROM mbox.inventory_order_reservations WHERE order_item_id=$1`,[row.itemId])).rejects.toThrow('whole line movement refused')
    await runner.run(scope,tx=>new ItemQuantityRepository(tx).decide({caseId:created.caseId,employeeId,decision:'withdrawn',reason:'客人保留'}))
    await expect(runner.run(scope,tx=>new ItemUnitInventoryRepository(tx).disposeUnmadeUnits({itemId:row.itemId,unitIds:created.unitIds,employeeId,caseId:created.caseId}))).rejects.toThrow('撤回或拒绝')
  })
  it('requires physical unopened receipt and records the original cost for one made unit only',async()=>{
    const row=await item('preparing'),stockId=await stock(row,'direct_sale'),created=await hold(row.itemId,1)
    const disposition=(unopenedReceived:boolean)=>runner.run(scope,tx=>new ItemUnitInventoryRepository(tx).disposeMadeUnits({itemId:row.itemId,unitIds:created.unitIds,employeeId,caseId:created.caseId,disposition:'returned_unopened',unopenedReceived,reason:'实物未开封收回'}))
    await expect(disposition(true)).rejects.toThrow('审核')
    await runner.run(scope,tx=>new ItemQuantityRepository(tx).decide({caseId:created.caseId,employeeId:reviewerId,decision:'approved',reason:'原价原路退回'}))
    await expect(disposition(false)).rejects.toThrow('实物已经收回')
    expect(await disposition(true)).toEqual({disposedRecords:1,stoppedQuantity:1})
    expect(await disposition(true)).toEqual({disposedRecords:0,stoppedQuantity:0})
    expect(await balance(stockId)).toEqual({on_hand:'6.000000',reserved:'0.000000'})
    expect((await pool.query('SELECT production_state FROM mbox.order_item_quantity_units WHERE id=$1',[created.unitIds[0]])).rows[0].production_state).toBe('started')
    await expect(pool.query("UPDATE mbox.item_after_sales_cases SET status='completed',completed_at=clock_timestamp() WHERE id=$1",[created.caseId])).rejects.toThrow('refunds succeed')
  })
  it('does not reconstruct recipe material or deduct already consumed material again as loss',async()=>{
    const row=await item('preparing'),stockId=await stock(row,'direct_sale','0.333333'),created=await hold(row.itemId,2)
    await runner.run(scope,tx=>new ItemQuantityRepository(tx).decide({caseId:created.caseId,employeeId:reviewerId,decision:'approved',reason:'已制作部分按实际损耗'}))
    const dispose=(disposition:'used_loss'|'returned_unopened')=>runner.run(scope,tx=>new ItemUnitInventoryRepository(tx).disposeMadeUnits({itemId:row.itemId,unitIds:created.unitIds,employeeId,caseId:created.caseId,disposition,unopenedReceived:true,reason:'制作后不可还原物料'}))
    await expect(dispose('returned_unopened')).rejects.toThrow('配方成品不能恢复')
    expect(await dispose('used_loss')).toEqual({disposedRecords:2,stoppedQuantity:2})
    expect(await dispose('used_loss')).toEqual({disposedRecords:0,stoppedQuantity:0})
    expect(await balance(stockId)).toEqual({on_hand:'5.000000',reserved:'0.000000'})
    expect((await pool.query('SELECT count(*)::int n FROM mbox.inventory_movements WHERE order_item_id=$1',[row.itemId])).rows[0].n).toBe(1)
    await expect(dispose('returned_unopened')).rejects.toThrow('另一结果处置')
  })
  it('records exactly the stopped unpaid receivable once while preserving the original invoice',async()=>{
    const row=await item(),created=await hold(row.itemId,2,'unpaid_stop')
    const reduction=()=>runner.run(scope,tx=>new ItemQuantityReceivableRepository(tx).recordUnpaidReduction({caseId:created.caseId,employeeId,businessDate:businessDate}))
    await expect(reduction()).rejects.toThrow('库存处置')
    await runner.run(scope,tx=>new ItemUnitInventoryRepository(tx).disposeUnmadeUnits({itemId:row.itemId,unitIds:created.unitIds,employeeId,caseId:created.caseId}))
    const first=await reduction();expect(first).toMatchObject({amountMinor:1600,quantity:2,replayed:false})
    expect(await reduction()).toEqual({...first,replayed:true})
    expect(await runner.run(scope,tx=>new ItemAfterSalesProgressRepository(tx).synchronize(created.caseId))).toMatchObject({status:'completed',moneyComplete:true,physicalComplete:true})
    expect(await runner.run(scope,tx=>new ItemQuantityReceivableRepository(tx).readOrder(row.orderId))).toEqual({orderId:row.orderId,originalAmountMinor:4000,effectiveAmountMinor:2400,cancelledAmountMinor:1600})
    expect((await pool.query('SELECT quantity,total_amount_minor::int AS amount FROM mbox.order_items WHERE id=$1',[row.itemId])).rows[0]).toEqual({quantity:5,amount:4000})
    await expect(pool.query('UPDATE mbox.item_receivable_adjustments SET amount_minor=1 WHERE id=$1',[first.id])).rejects.toThrow()
  })
  it('completes and delivers only free quantities, then explicitly resumes the held remainder',async()=>{
    const row=await item(),stockId=await stock(row,'reserved'),created=await hold(row.itemId,2)
    const complete=(quantity:number,eventKey:string)=>runner.run(scope,tx=>new ItemQuantityFulfillmentRepository(tx).complete({itemId:row.itemId,taskId:row.taskId,employeeId,quantity,eventKey}))
    const delivery=(quantity:number,eventKey:string)=>runner.run(scope,tx=>new ItemQuantityFulfillmentRepository(tx).deliver({itemId:row.itemId,taskId:row.taskId,employeeId,quantity,eventKey}))
    const ready=await complete(3,'complete-free-three');expect(ready.quantity).toBe(3)
    expect(await complete(3,'complete-free-three')).toEqual({...ready,replayed:true})
    await expect(complete(1,'complete-held-one')).rejects.toThrow('最多可完成0份')
    expect((await delivery(2,'deliver-first-two')).quantity).toBe(2)
    await expect(delivery(2,'deliver-over-limit')).rejects.toThrow('最多可送达1份')
    expect((await delivery(1,'deliver-last-ready')).quantity).toBe(1)
    await runner.run(scope,tx=>new ItemQuantityRepository(tx).decide({caseId:created.caseId,employeeId,decision:'withdrawn',reason:'客人确认保留'}))
    await expect(complete(2,'complete-still-held')).rejects.toThrow('最多可完成0份')
    await runner.run(scope,tx=>new ItemQuantityRepository(tx).resume({caseId:created.caseId,employeeId}))
    expect((await complete(2,'complete-resumed-two')).quantity).toBe(2)
    expect((await delivery(2,'deliver-resumed-two')).quantity).toBe(2)
    expect(await balance(stockId)).toEqual({on_hand:'5.000000',reserved:'0.000000'})
    const units=await runner.run(scope,tx=>new ItemQuantityRepository(tx).readUnits(row.itemId))
    expect(units.every(unit=>unit.production_state==='delivered')).toBe(true)
  })
  it('concurrent requests cannot hold more than the original five units',async()=>{
    const row=await item()
    const results=await Promise.allSettled([hold(row.itemId,3),hold(row.itemId,3)])
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1)
    expect(results.filter(result=>result.status==='rejected')).toHaveLength(1)
    const units=await runner.run(scope,tx=>new ItemQuantityRepository(tx).readUnits(row.itemId))
    expect(units).toHaveLength(5);expect(units.filter(unit=>unit.held_by_case_id)).toHaveLength(3)
    expect(units.filter(unit=>!unit.held_by_case_id)).toHaveLength(2)
    expect((await pool.query('SELECT quantity,total_amount_minor::int AS amount FROM mbox.order_items WHERE id=$1',[row.itemId])).rows[0]).toEqual({quantity:5,amount:4000})
  })
  it('reject/withdraw keep the selected units paused until an explicit resume',async()=>{
    const row=await item(),created=await hold(row.itemId,2)
    await runner.run(scope,tx=>new ItemQuantityRepository(tx).decide({caseId:created.caseId,employeeId:reviewerId,decision:'rejected',reason:'客人改为保留'}))
    let units=await runner.run(scope,tx=>new ItemQuantityRepository(tx).readUnits(row.itemId))
    expect(units.filter(unit=>unit.held_by_case_id)).toHaveLength(2)
    const resumed=await runner.run(scope,tx=>new ItemQuantityRepository(tx).resume({caseId:created.caseId,employeeId}))
    expect(resumed.resumedQuantity).toBe(2)
    units=await runner.run(scope,tx=>new ItemQuantityRepository(tx).readUnits(row.itemId))
    expect(units.every(unit=>unit.held_by_case_id===null)).toBe(true)
    expect((await runner.run(scope,tx=>new ItemQuantityRepository(tx).resume({caseId:created.caseId,employeeId}))).resumedQuantity).toBe(0)
  })
  it.each(['closed_session','cancelled_order'] as const)('does not resume an old held item after %s, or present it as available to continue',async(closedKind)=>{
    await grantActor(employeeId,['refund.request','order.cancel_unpaid'])
    const source=await freshTableSession(),row=await item('pending',0,source.id)
    const created=await hold(row.itemId,2)
    await runner.run(scope,tx=>new ItemQuantityRepository(tx).decide({caseId:created.caseId,employeeId,decision:'withdrawn',reason:'暂不退款，但未确认继续制作'}))
    if(closedKind==='cancelled_order')await new PostgresOrderCancellationRepository(runner).cancel({scope,employeeId,orderId:row.orderId,businessDate:businessDate,reasonCode:'guest_left',reasonNote:'原整单已停止',idempotencyKey:`closed-resume-${randomUUID()}`})
    else await pool.query("UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp() WHERE id=$1",[source.id])
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    await expect(service.resume({scope,employeeId,caseId:created.caseId,businessDate:businessDate,reason:'旧页面点击继续',idempotencyKey:`resume-old-${randomUUID()}`})).rejects.toThrow('原桌次或商品已结束')
    const workspace=await new ItemAfterSalesQuery(runner).item({scope,employeeId,itemId:row.itemId})
    expect(workspace.canRequest).toBe(false)
    expect(workspace.cases.find(value=>value.caseId===created.caseId)).toMatchObject({canResume:false,heldQuantity:closedKind==='cancelled_order'?0:2,resumeUnavailableReason:closedKind==='cancelled_order'?null:'原桌次或商品已结束，不能继续原商品；原售后记录仍可核对。'})
    expect((await pool.query("SELECT count(*)::int n FROM mbox.item_after_sales_events WHERE case_id=$1 AND event_type='quantity.resumed'",[created.caseId])).rows[0].n).toBe(0)
  })
  it('cannot self-approve and does not represent approval as refund success',async()=>{
    const row=await item(),created=await hold(row.itemId,1)
    await expect(runner.run(scope,tx=>new ItemQuantityRepository(tx).decide({caseId:created.caseId,employeeId,decision:'approved',reason:'同意'}))).rejects.toThrow('另一位')
    await runner.run(scope,tx=>new ItemQuantityRepository(tx).decide({caseId:created.caseId,employeeId:reviewerId,decision:'approved',reason:'同意'}))
    expect((await pool.query('SELECT status,completed_at FROM mbox.item_after_sales_cases WHERE id=$1',[created.caseId])).rows[0]).toEqual({status:'approved',completed_at:null})
    expect((await pool.query('SELECT count(*)::int n FROM mbox.item_after_sales_case_refunds WHERE case_id=$1',[created.caseId])).rows[0].n).toBe(0)
  })
  it.each([false,true])('preserves a legacy failed task original exception path without partial quantity adoption (paid=%s)',async(paid)=>{
    const actor=await ordinaryServiceEmployee(),row=await item('failed'),stockId=await stock(row,'direct_sale')
    if(paid)await payment(row.orderId)
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    await expect(service.request({scope,employeeId:actor,businessDate:businessDate,orderItemId:row.itemId,quantity:1,reason:'旧失败单不能只拆一份再封死原重做入口',idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'QUANTITY_FACTS_CONFLICT'})
    const view=await new ItemAfterSalesQuery(runner).item({scope,employeeId:actor,itemId:row.itemId})
    expect(view.canRequest).toBe(false);expect(view.quantityEntryUnavailableReason).toContain('原异常入口保留')
    expect(view.units).toHaveLength(0);expect(view.cases).toHaveLength(0)
    expect((await pool.query('SELECT status FROM mbox.kds_tasks WHERE id=$1',[row.taskId])).rows).toEqual([{status:'failed'}])
    expect(await balance(stockId)).toEqual({on_hand:'5.000000',reserved:'0.000000'})
  })
  it('preserves production facts and cannot use ordinary unpaid stop for already made units',async()=>{
    const row=await item('preparing')
    await expect(hold(row.itemId,1,'unpaid_stop')).rejects.toThrow('已有制作记录')
    const created=await hold(row.itemId,1)
    expect(created).toMatchObject({unmade:0,madeReview:1,amountMinor:800})
    await expect(pool.query("UPDATE mbox.order_item_quantity_units SET production_state='unmade' WHERE order_item_id=$1",[row.itemId])).rejects.toThrow('cannot be rewound')
    await expect(pool.query('UPDATE mbox.order_item_quantity_units SET original_amount_minor=1 WHERE order_item_id=$1',[row.itemId])).rejects.toThrow('immutable')
  })
  it.each(['ready','delivered'] as const)('all staff can hold unpaid %s goods; existing operating authority waives only original shares, physical work remains separate',async(state)=>{
    const actor=await ordinaryServiceEmployee(),row=await item('ready'),stockId=await stock(row,'direct_sale')
    if(state==='delivered')await pool.query("UPDATE mbox.order_items SET status='delivered' WHERE id=$1",[row.itemId])
    const runtime={run:<T>(current:typeof scope,operation:(tx:import('./transaction-runner.js').ScopedTransaction)=>Promise<T>)=>runner.run(current,async tx=>{await tx.query('SET LOCAL ROLE mbox_runtime');return operation(tx)})} as ScopedPostgresTransactionRunner
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runtime),new ItemAfterSalesOperatingEffects())
    const request=await service.request({scope,employeeId:actor,businessDate:businessDate,orderItemId:row.itemId,quantity:2,reason:'客人不要这两瓶，先暂停原商品',idempotencyKey:randomUUID()})
    expect(request.value).toMatchObject({kind:'unpaid_stop',status:'requested',heldQuantity:2,stoppedQuantity:0,moneyComplete:false,refunds:[]})
    const decision={scope,employeeId:actor,businessDate:businessDate,caseId:request.value.caseId,decision:'approved' as const,reason:'按现有授权确认所选两瓶停止并免收',idempotencyKey:randomUUID()}
    await expect(service.decide(decision)).rejects.toThrow('does not have permission')
    await grantActor(actor,['order.cancel_unpaid','inventory.receive','inventory.waste'])
    if(state==='delivered'){
      await expect(service.decide({...decision,idempotencyKey:randomUUID()})).rejects.toThrow('order.settle_exception')
      await grantActor(actor,['order.settle_exception'])
    }
    const approved=await service.decide(decision)
    expect(approved.value).toMatchObject({status:'approved',moneyComplete:true,physicalComplete:false,heldQuantity:2,refunds:[]})
    expect((await new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runtime),new ItemAfterSalesOperatingEffects(),false).decide({...decision,businessDate:nextBusinessDate})).replayed).toBe(true)
    expect(await runner.run(scope,tx=>new ItemQuantityReceivableRepository(tx).readOrder(row.orderId))).toMatchObject({originalAmountMinor:4000,effectiveAmountMinor:2400})
    expect(await balance(stockId)).toEqual({on_hand:'5.000000',reserved:'0.000000'})
    const selected=(await pool.query('SELECT id,production_state FROM mbox.order_item_quantity_units WHERE held_by_case_id=$1 ORDER BY unit_index',[request.value.caseId])).rows
    expect(selected.map(unit=>unit.production_state)).toEqual([state,state])
    // Remaining goods can be paid while this original physical handover is open.
    const collected=await runner.run(scope,tx=>new PaymentRepository(tx).createForOrder({...cashInput(),orderId:row.orderId}))
    expect(collected.amountMinor).toBe(2400)
    const physical={scope,employeeId:actor,businessDate:businessDate,caseId:request.value.caseId,unitIds:[selected[0].id],disposition:'returned_unopened' as const,unopenedReceived:true,reason:'这瓶已实际收回且未开封',idempotencyKey:randomUUID()}
    await service.disposeMade(physical)
    expect((await service.disposeMade(physical)).replayed).toBe(true)
    const completed=await service.disposeMade({...physical,unitIds:[selected[1].id],disposition:'used_loss',unopenedReceived:false,reason:'另一瓶已开封，原耗用不再重复扣库',idempotencyKey:randomUUID()})
    expect(completed.value).toMatchObject({status:'completed',heldQuantity:0,stoppedQuantity:2,physicalComplete:true,moneyComplete:true,refunds:[]})
    expect(await balance(stockId)).toEqual({on_hand:'6.000000',reserved:'0.000000'})
    expect((await pool.query('SELECT count(*)::int n FROM mbox.item_receivable_adjustments WHERE case_id=$1',[request.value.caseId])).rows[0].n).toBe(1)
  })
  it.each(['ready','delivered'] as const)('lets the authorized requester reject an unpaid %s stop without refund approval or automatic resume',async(state)=>{
    const actor=await ordinaryServiceEmployee(),row=await item('ready'),stockId=await stock(row,'direct_sale')
    if(state==='delivered')await pool.query("UPDATE mbox.order_items SET status='delivered' WHERE id=$1",[row.itemId])
    const runtime={run:<T>(current:typeof scope,operation:(tx:import('./transaction-runner.js').ScopedTransaction)=>Promise<T>)=>runner.run(current,async tx=>{await tx.query('SET LOCAL ROLE mbox_runtime');return operation(tx)})} as ScopedPostgresTransactionRunner
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runtime),new ItemAfterSalesOperatingEffects())
    const request=await service.request({scope,employeeId:actor,businessDate:businessDate,orderItemId:row.itemId,quantity:2,reason:'先暂停这两份，现场核对后决定',idempotencyKey:randomUUID()})
    const decision={scope,employeeId:actor,businessDate:businessDate,caseId:request.value.caseId,decision:'rejected' as const,reason:'不同意免收，客人确认保留原商品',idempotencyKey:randomUUID()}
    await expect(service.decide(decision)).rejects.toThrow('does not have permission')
    await grantActor(actor,[state==='delivered'?'order.settle_exception':'order.cancel_unpaid'])
    const view=await new ItemAfterSalesQuery(runtime).item({scope,employeeId:actor,itemId:row.itemId})
    const rejected=await service.decide(decision)
    expect(view.cases.find(value=>value.caseId===request.value.caseId)?.canReject).toBe(true)
    expect(rejected.value).toMatchObject({kind:'unpaid_stop',status:'rejected',heldQuantity:2,stoppedQuantity:0,moneyComplete:false,refunds:[]})
    expect((await new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runtime),new ItemAfterSalesOperatingEffects(),false).decide({...decision,businessDate:nextBusinessDate})).replayed).toBe(true)
    expect(await runner.run(scope,tx=>new ItemQuantityReceivableRepository(tx).readOrder(row.orderId))).toMatchObject({originalAmountMinor:4000,effectiveAmountMinor:4000})
    expect(await balance(stockId)).toEqual({on_hand:'5.000000',reserved:'0.000000'})
    const resumed=await service.resume({scope,employeeId:actor,businessDate:businessDate,caseId:request.value.caseId,reason:'客人确认继续原商品，已通知岗位勿重做',idempotencyKey:randomUUID()})
    expect(resumed.value).toMatchObject({status:'rejected',heldQuantity:0,stoppedQuantity:0,refunds:[]})
    expect((await pool.query('SELECT DISTINCT production_state FROM mbox.order_item_quantity_units WHERE order_item_id=$1',[row.itemId])).rows).toEqual([{production_state:state}])
    expect((await pool.query('SELECT count(*)::int n FROM mbox.item_receivable_adjustments WHERE case_id=$1',[request.value.caseId])).rows[0].n).toBe(0)
    expect(await balance(stockId)).toEqual({on_hand:'5.000000',reserved:'0.000000'})
  })
  it('unpaid mixed made and unmade shares retain physical evidence, one operating decision and only the remaining receivable',async()=>{
    const actor=await ordinaryServiceEmployee();await grantActor(actor,['order.cancel_unpaid','inventory.waste'])
    const row=await item(),stockId=await stock(row,'reserved')
    await runner.run(scope,tx=>new ItemQuantityFulfillmentRepository(tx).complete({itemId:row.itemId,taskId:row.taskId,employeeId,quantity:2,eventKey:randomUUID()}))
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    const request=await service.request({scope,employeeId:actor,businessDate:businessDate,orderItemId:row.itemId,quantity:4,reason:'三份未做和一份已做都先暂停',idempotencyKey:randomUUID()})
    expect(request.value).toMatchObject({madeQuantity:1,heldQuantity:4,moneyComplete:false,stoppedQuantity:0})
    const view=(await new ItemAfterSalesQuery(runner).item({scope,employeeId:actor,itemId:row.itemId})).cases.find(value=>value.caseId===request.value.caseId)!
    expect(view.canApprove).toBe(true)
    const approved=await service.decide({scope,employeeId:actor,businessDate:businessDate,caseId:request.value.caseId,decision:'approved',reason:'现有取消权限确认四份不再收费',idempotencyKey:randomUUID()})
    expect(approved.value).toMatchObject({heldQuantity:1,stoppedQuantity:3,moneyComplete:true,physicalComplete:false,refunds:[]})
    expect(await balance(stockId)).toEqual({on_hand:'8.000000',reserved:'0.000000'})
    const collected=await runner.run(scope,tx=>new PaymentRepository(tx).createForOrder({...cashInput(),orderId:row.orderId}))
    expect(collected.amountMinor).toBe(800)
    const made=(await pool.query('SELECT id FROM mbox.order_item_quantity_units WHERE held_by_case_id=$1',[request.value.caseId])).rows[0].id
    const done=await service.disposeMade({scope,employeeId:actor,businessDate:businessDate,caseId:request.value.caseId,unitIds:[made],disposition:'used_loss',unopenedReceived:false,reason:'该份已开封耗用，无实物回库',idempotencyKey:randomUUID()})
    expect(done.value).toMatchObject({status:'completed',stoppedQuantity:4,moneyComplete:true,refunds:[]})
    expect(await balance(stockId)).toEqual({on_hand:'8.000000',reserved:'0.000000'})
  })
  it.each(['unknown_price','late_payment'] as const)('unpaid made stop does not invent a waiver for %s',async(mode)=>{
    const actor=await ordinaryServiceEmployee();await grantActor(actor,['order.cancel_unpaid','inventory.waste'])
    const row=await item('ready',mode==='unknown_price'?333:0),stockId=await stock(row,'direct_sale')
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    const request=await service.request({scope,employeeId:actor,businessDate:businessDate,orderItemId:row.itemId,quantity:2,reason:'先暂停并保留实际原成交事实',idempotencyKey:randomUUID()})
    if(mode==='late_payment')await payment(row.orderId)
    await expect(service.decide({scope,employeeId:actor,businessDate:businessDate,caseId:request.value.caseId,decision:'approved',reason:'金额或原支付事实未核定不能免收',idempotencyKey:randomUUID()})).rejects.toMatchObject({code:mode==='unknown_price'?'PRICE_REVIEW_REQUIRED':'QUANTITY_UNAVAILABLE'})
    const view=(await new ItemAfterSalesQuery(runner).item({scope,employeeId:actor,itemId:row.itemId})).cases.find(value=>value.caseId===request.value.caseId)!
    expect(view).toMatchObject({status:'requested',heldQuantity:2,canApprove:false,moneyComplete:false})
    expect(view.unpaidPaymentChanged).toBe(mode==='late_payment')
    expect((await pool.query('SELECT count(*)::int n FROM mbox.item_receivable_adjustments WHERE case_id=$1',[request.value.caseId])).rows[0].n).toBe(0)
    expect(await balance(stockId)).toEqual({on_hand:'5.000000',reserved:'0.000000'})
    if(mode==='late_payment'){
      const revision=await service.revise({scope,employeeId:actor,businessDate:businessDate,caseId:request.value.caseId,quantity:2,reason:'原付款已入账，保持暂停并按原款申请退款',idempotencyKey:randomUUID()})
      expect(revision.value).toMatchObject({kind:'paid_return',status:'requested',heldQuantity:2,moneyComplete:false})
      expect(revision.value.refunds).toHaveLength(1)
      expect(revision.value.refunds[0]).toMatchObject({status:'requested',amountMinor:1600})
      expect((await pool.query('SELECT id FROM mbox.order_item_quantity_units WHERE held_by_case_id=$1',[revision.value.caseId])).rows).toHaveLength(2)
      expect(await balance(stockId)).toEqual({on_hand:'5.000000',reserved:'0.000000'})
      return
    }
    await service.decide({scope,employeeId:actor,businessDate:businessDate,caseId:request.value.caseId,decision:'withdrawn',reason:'客人保留原商品，先撤回本次停止',idempotencyKey:randomUUID()})
    await service.resume({scope,employeeId:actor,businessDate:businessDate,caseId:request.value.caseId,reason:'明确继续原商品，勿重做或重复扣库',idempotencyKey:randomUUID()})
    expect((await pool.query('SELECT count(*)::int n FROM mbox.order_item_quantity_units WHERE held_by_case_id=$1',[request.value.caseId])).rows[0].n).toBe(0)
  })
  it('can promptly hold discounted goods while keeping unknown per-unit refund price for review',async()=>{
    const row=await item('pending',333),created=await hold(row.itemId,1)
    expect(created).toMatchObject({amountMinor:null,priceReviewRequired:true,unmade:1,madeReview:0})
    expect((await pool.query('SELECT count(*)::int n FROM mbox.order_item_quantity_units WHERE held_by_case_id=$1',[created.caseId])).rows[0].n).toBe(1)
  })
  it.each(['approved','rejected','withdrawn'] as const)('hands closed-visit physical work to an existing inventory role after %s without granting refund approval',async(decision)=>{
    await grantActor(employeeId,['refund.request','table.close','table.turnover_unsettled'])
    await grantActor(reviewerId,['refund.approve'],100000)
    const inventoryWorker=await ordinaryServiceEmployee();await grantActor(inventoryWorker,['inventory.waste'])
    const ordinary=await ordinaryServiceEmployee(),source=await freshTableSession(),row=await item('pending',0,source.id),stockId=await stock(row,'reserved')
    await runner.run(scope,async tx=>{const payments=new PaymentRepository(tx);await payments.createForOrder({...cashInput(),orderId:row.orderId});await payments.syncOrderPaymentStatus(row.orderId)})
    await runner.run(scope,tx=>new ItemQuantityFulfillmentRepository(tx).complete({itemId:row.itemId,taskId:row.taskId,employeeId,quantity:1,eventKey:`handover-ready-${randomUUID()}`}))
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    // Hold all units so the made share remains in this same original request.
    const request=await service.request({scope,employeeId,businessDate:businessDate,orderItemId:row.itemId,quantity:5,reason:'原商品需要售后处置',idempotencyKey:`handover-request-${randomUUID()}`})
    const list=async(id:string)=>{
      let cursor:{createdAt:string;id:string}|undefined
      do{const page=await new ItemAfterSalesHandoverQuery(runner).list({scope,employeeId:id,limit:100,cursor});if(page.items.some(value=>value.caseId===request.value.caseId))return true;cursor=page.nextCursor??undefined}while(cursor)
      return false
    }
    expect(await list(inventoryWorker)).toBe(false)
    await runner.run(scope,tx=>new PostgresTableCustomerLeftTurnoverRepository(tx).close({scope,employeeId,tableSessionId:source.id,businessDate:businessDate,reasonNote:'客人离店，交班接续原商品处置',idempotencyKey:`handover-close-${randomUUID()}`}))
    expect(await list(inventoryWorker)).toBe(false)
    await service.decide({scope,employeeId:decision==='withdrawn'?employeeId:reviewerId,businessDate:businessDate,caseId:request.value.caseId,decision,reason:'原审核决定，实物交接处理',idempotencyKey:`handover-decision-${randomUUID()}`})
    expect(await list(ordinary)).toBe(false);expect(await list(inventoryWorker)).toBe(true)
    expect((await new ItemAfterSalesHandoverQuery(runner).list({scope,employeeId:inventoryWorker,limit:100})).items.find(value=>value.caseId===request.value.caseId)).toMatchObject({physicalOnly:true})
    const workspace=await new ItemAfterSalesQuery(runner).item({scope,employeeId:inventoryWorker,itemId:row.itemId})
    expect(workspace).toMatchObject({canRecordUsed:true,canReceive:false,canExecuteRefund:false})
    expect(workspace.cases[0]).toMatchObject({canApprove:false,canReject:false,canResume:false})
    const made=(await pool.query("SELECT id FROM mbox.order_item_quantity_units WHERE order_item_id=$1 AND production_state='ready'",[row.itemId])).rows[0].id
    const done=await service.disposeMade({scope,employeeId:inventoryWorker,businessDate:nextBusinessDate,caseId:request.value.caseId,unitIds:[made],disposition:'used_loss',unopenedReceived:false,reason:'交班确认原商品已消耗，无实物回库',idempotencyKey:`handover-used-${randomUUID()}`})
    expect(done.value).toMatchObject({physicalComplete:true,heldQuantity:0,succeededMinor:0})
    expect(await balance(stockId)).toEqual({on_hand:'9.000000',reserved:'0.000000'})
    // The worker must still find their original notice acknowledgement after
    // finishing the last physical share or recovering across a page reload.
    expect(await list(inventoryWorker)).toBe(true)
    await service.acknowledgeNotices({scope,employeeId:inventoryWorker,businessDate:nextBusinessDate,caseId:request.value.caseId,noticeIds:(await new ItemAfterSalesQuery(runner).item({scope,employeeId:inventoryWorker,itemId:row.itemId})).cases[0].notices.map(value=>value.id),reason:'交班已联系原岗位核对全部通知',idempotencyKey:`handover-ack-${randomUUID()}`})
    expect(await list(inventoryWorker)).toBe(false)
    if(decision==='approved')expect(await list(reviewerId)).toBe(true)
  })

  it('persists one station-specific stop notice, filters a delayed original ticket and uses the existing print worker',async()=>{
    const printer=randomUUID()
    await pool.query("INSERT INTO mbox.devices(id,tenant_id,store_id,code,name,device_type,station_code,connectivity_status) VALUES($1,$2,$3,'Q-BAR','Test bar printer','printer','bar','offline')",[printer,tenantId,storeId])
    await pool.query("INSERT INTO mbox.printer_routes(tenant_id,store_id,code,name,station_code,printer_device_id) VALUES($1,$2,'Q-BAR-ROUTE','Bar','bar',$3)",[tenantId,storeId,printer])
    const row=await item();await payment(row.orderId)
    const runtimeTransactions={run:<T>(current:typeof scope,operation:(tx:import('./transaction-runner.js').ScopedTransaction)=>Promise<T>)=>runner.run(current,async tx=>{await tx.query('SET LOCAL ROLE mbox_runtime');return operation(tx)})} as ScopedPostgresTransactionRunner
    const effects=new ItemAfterSalesOperatingEffects(),service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runtimeTransactions),effects)
    const request={scope,employeeId,businessDate:businessDate,idempotencyKey:`quantity-notice-${randomUUID()}`,orderItemId:row.itemId,quantity:2,reason:'客人先暂停两瓶'}
    const created=await service.request(request),caseId=created.value.caseId
    await runner.run(scope,tx=>effects.apply(tx,{caseId,employeeId,action:'request',eventKey:'different-click-same-case'}))
    expect((await pool.query("SELECT count(*)::int n FROM mbox.print_source_jobs job JOIN mbox.outbox_messages message ON message.tenant_id=job.tenant_id AND message.store_id=job.store_id AND message.id=job.source_outbox_message_id WHERE job.tenant_id=$1 AND job.ticket_kind='production_notice' AND message.payload->>'caseId'=$2",[tenantId,caseId])).rows[0].n).toBe(1)
    const originalSource=await runner.run(scope,tx=>appendOutboxMessage(tx,{aggregateType:'order',aggregateId:row.orderId,aggregateVersion:1,eventType:'test.delayed.production',payload:{}}))
    const jobs=await runner.run(scope,tx=>new PrintTicketSourceRepository(tx).materializeOrderProduction(originalSource,row.orderId))
    expect(jobs).toHaveLength(1)
    const originalTicket=(await pool.query('SELECT print_snapshot FROM mbox.print_jobs WHERE source_outbox_message_id=$1',[originalSource])).rows[0].print_snapshot
    expect(originalTicket.lines).toMatchObject([{name:'水',quantity:3}])
    const worker=new PrintSourceWorker({run:(current,operation)=>runner.run(current,async tx=>{await tx.query('SET LOCAL ROLE mbox_runtime');return operation(tx)})})
    // Earlier lifecycle scenarios also enqueue legitimate notices. Drain the
    // bounded worker batches, instead of assuming this case is among the first 50.
    let completed=0,drained=false
    for(let batch=0;batch<20;batch++){
      const printed=await worker.runBatch(scope,'quantity-notice-test',50)
      expect(printed).toMatchObject({retrying:0,dead:0});completed+=printed.completed
      if(printed.examined<50){drained=true;break}
    }
    expect(drained).toBe(true);expect(completed).toBeGreaterThanOrEqual(1)
    const notice=(await pool.query("SELECT station_code,printer_device_id,print_snapshot FROM mbox.print_jobs WHERE tenant_id=$1 AND print_snapshot->>'kind'='production_notice' AND print_snapshot->>'note' LIKE '%'||$2||'%'",[tenantId,caseId])).rows
    expect(notice).toHaveLength(1);expect(notice[0]).toMatchObject({station_code:'bar',printer_device_id:printer,print_snapshot:{title:'商品处理通知',tableCode:'Q01',lines:[{quantity:2}]}})
    expect(notice[0].print_snapshot.subtitle).toContain('暂停')
    expect((await worker.runBatch(scope,'quantity-notice-restart')).examined).toBe(0)
    await service.decide({scope,employeeId:reviewerId,businessDate:businessDate,idempotencyKey:`quantity-notice-review-${randomUUID()}`,caseId,decision:'approved',reason:'同意原单停止两瓶'})
    expect((await runner.run(scope,tx=>new ItemAfterSalesProgressRepository(tx).read(caseId))).stoppedQuantity).toBe(2)
    expect(await worker.runBatch(scope,'quantity-notice-approved')).toMatchObject({completed:1,retrying:0,dead:0})
    expect((await pool.query("SELECT count(*)::int n FROM mbox.print_jobs WHERE tenant_id=$1 AND station_code='kitchen'",[tenantId])).rows[0].n).toBe(0)
  })

  it('a delayed remake delivery ticket contains only actual ready unheld new goods, without a second sale amount',async()=>{
    const row=await deliveredOriginal(),batch=await remake(repo=>repo.create({itemId:row.itemId,employeeId,quantity:3,originalGoodsLost:true,reason:'本批实际新实物配送',eventKey:randomUUID()}))
    const made=await remake((_repo,tx)=>new QuantityRemakeFulfillmentRepository(tx).act({taskId:batch.taskId,employeeId,quantity:3,action:'complete',eventKey:randomUUID()}))
    const slip=await remake((_repo,tx)=>new DeliveryBatchRepository(tx).create(employeeId,[{taskId:batch.taskId,quantity:3,remakeUnitIds:made.remakeUnitIds}]))
    await remake((_repo,tx)=>new QuantityRemakeFulfillmentRepository(tx).act({taskId:batch.taskId,employeeId,quantity:1,action:'deliver',eventKey:randomUUID()}))
    await remake(repo=>repo.disposeMade({batchId:batch.id,employeeId,unitIds:[made.remakeUnitIds[1]!],disposition:'used_loss',unopenedReceived:false,reason:'第二份实际损坏，不能再配送'}))
    const source=await runner.run(scope,tx=>appendOutboxMessage(tx,{aggregateType:'delivery_batch',aggregateId:slip.id,aggregateVersion:1,eventType:'test.delayed.remake.delivery',payload:{}}))
    const jobs=await remake((_repo,tx)=>new PrintTicketSourceRepository(tx).materializeDeliveryBatch(source,slip.id))
    expect(jobs).toHaveLength(1)
    const snapshot=(await pool.query('SELECT print_snapshot FROM mbox.print_jobs WHERE source_outbox_message_id=$1',[source])).rows[0].print_snapshot
    expect(snapshot.lines).toMatchObject([{name:'重做：水',quantity:1,unitAmountMinor:null,totalAmountMinor:null}]);expect(snapshot.totalAmountMinor).toBeNull()
    await remake((_repo,tx)=>new QuantityRemakeFulfillmentRepository(tx).act({taskId:batch.taskId,employeeId,quantity:1,action:'deliver',eventKey:randomUUID()}))
    const anotherSource=await runner.run(scope,tx=>appendOutboxMessage(tx,{aggregateType:'delivery_batch',aggregateId:slip.id,aggregateVersion:2,eventType:'test.late.remake.delivery',payload:{}}))
    expect(await remake((_repo,tx)=>new PrintTicketSourceRepository(tx).materializeDeliveryBatch(anotherSource,slip.id))).toEqual([])
    const preparing=await item('preparing');await stock(preparing,'direct_sale')
    await remake(repo=>repo.create({itemId:preparing.itemId,employeeId,quantity:2,originalGoodsLost:true,reason:'原两份已损坏，旧制作票不应重复打印',eventKey:randomUUID()}))
    const originalSource=await runner.run(scope,tx=>appendOutboxMessage(tx,{aggregateType:'order',aggregateId:preparing.orderId,aggregateVersion:1,eventType:'test.delayed.original.remade',payload:{}}))
    await remake((_repo,tx)=>new PrintTicketSourceRepository(tx).materializeOrderProduction(originalSource,preparing.orderId))
    expect((await pool.query('SELECT print_snapshot FROM mbox.print_jobs WHERE source_outbox_message_id=$1',[originalSource])).rows[0].print_snapshot.lines).toMatchObject([{name:'水',quantity:3}])
  })

  it('creates an authorized quantity remake once, recovers across disabled admission and rejects stale sessions or changed requests',async()=>{
    await grantActor(employeeId,['kds.exception.manage','fulfillment.view_all'])
    const credentialId=randomUUID(),leaseId=randomUUID(),staffSessionId=randomUUID()
    await pool.query("INSERT INTO mbox.store_daily_credentials(id,tenant_id,store_id,business_date,credential_hash,valid_from,valid_until,configured_by_employee_id) VALUES($1,$2,$3,current_date,'scrypt$quantity-remake-test',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '8 hours',$4)",[credentialId,tenantId,storeId,employeeId])
    await pool.query("INSERT INTO mbox.store_device_access_leases(id,tenant_id,store_id,daily_credential_id,business_date,device_key_hash,lease_token_hash,issued_at,expires_at) VALUES($1,$2,$3,$4,current_date,repeat('a',64),repeat('b',64),clock_timestamp()-interval '1 hour',clock_timestamp()+interval '8 hours')",[leaseId,tenantId,storeId,credentialId])
    await pool.query("INSERT INTO mbox.staff_sessions(id,tenant_id,store_id,employee_id,device_access_lease_id,session_token_hash,issued_at,expires_at,online_lease_until) VALUES($1,$2,$3,$4,$5,repeat('c',64),statement_timestamp(),statement_timestamp()+interval '6 hours',statement_timestamp()+interval '30 minutes')",[staffSessionId,tenantId,storeId,employeeId,leaseId])
    const runtime={run:<T>(current:typeof scope,operation:(tx:import('./transaction-runner.js').ScopedTransaction)=>Promise<T>)=>runner.run(current,async tx=>{await tx.query('SET LOCAL ROLE mbox_runtime');return operation(tx)})} as ScopedPostgresTransactionRunner
    const executor=new NormalizedCommandExecutor(runtime),command=new QuantityRemakeCommandService(executor,true),row=await deliveredOriginal()
    await pool.query("INSERT INTO mbox.role_data_scopes(tenant_id,store_id,role_id,scope_key,effect,scope_value,value_kind,text_values,enabled) SELECT tenant_id,store_id,role_id,'kds.station_codes','include','[\"bar\"]'::jsonb,'text_set',ARRAY['bar']::text[],true FROM mbox.employee_roles WHERE tenant_id=$1 AND store_id=$2 AND employee_id=$3 LIMIT 1",[tenantId,storeId,employeeId])
    const input={scope,employeeId,staffSessionId,deviceAccessLeaseId:leaseId,businessDate:businessDate,taskId:row.taskId,quantity:2,originalGoodsLost:true,reason:'实际损坏两瓶，原单不再收款',idempotencyKey:randomUUID()}
    await runner.run(scope,async tx=>{
      const policy=new NormalizedKdsAuthorization()
      await expect(policy.assertCanActOnTask({transaction:tx,...input,action:'quantity_remake',stationCode:'kitchen',tableId})).rejects.toMatchObject({code:'KDS_STATION_FORBIDDEN'})
      await policy.assertCanActOnTask({transaction:tx,...input,action:'quantity_remake',stationCode:'bar',tableId})
    })
    const first=await command.create(input)
    expect(first.value).toMatchObject({itemId:row.itemId,quantity:2});expect((await command.create(input)).replayed).toBe(true)
    expect(await balance(row.stockId)).toEqual({on_hand:'5.000000',reserved:'2.000000'})
    await expect(command.create({...input,quantity:1})).rejects.toThrow()
    const notices=(await pool.query("SELECT id,aggregate_id,payload FROM mbox.outbox_messages WHERE tenant_id=$1 AND payload->>'remakeBatchId'=$2",[tenantId,first.value.batchId])).rows
    expect(notices).toHaveLength(1);expect(notices[0].payload.ticket).toMatchObject({title:'重做通知',lines:[{quantity:2,totalAmountMinor:null}]})
    const batch=await remake(repo=>repo.read(first.value.batchId))
    await remake(repo=>repo.releaseUnmade({batchId:batch.id,unitIds:[batch.units[0]!.id],reason:'一份尚未做，本批不再制作'}))
    await remake((_repo,tx)=>new PrintTicketSourceRepository(tx).materializeProductionNotice(notices[0].id,notices[0].aggregate_id))
    expect((await pool.query('SELECT print_snapshot FROM mbox.print_jobs WHERE source_outbox_message_id=$1',[notices[0].id])).rows[0].print_snapshot.lines).toMatchObject([{quantity:1}])
    await pool.query("UPDATE mbox.staff_sessions SET revoked_at=clock_timestamp() WHERE id=$1",[staffSessionId])
    await expect(command.create({...input,idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'KDS_SESSION_INVALID'})
    expect((await new QuantityRemakeCommandService(executor,false).create({...input,businessDate:nextBusinessDate})).value).toEqual(first.value)
    await expect(new QuantityRemakeCommandService(executor,false).create({...input,idempotencyKey:randomUUID()})).rejects.toThrow('暂不新增')
    expect((await pool.query('SELECT count(*)::int n FROM mbox.quantity_remake_batches WHERE order_item_id=$1',[row.itemId])).rows[0].n).toBe(1)
  })

  it('same after-sales command records separate physical batches without second approval or duplicate stock',async()=>{
    await grantActor(employeeId,['refund.request','inventory.receive','inventory.waste'])
    await grantActor(reviewerId,['refund.approve'],100000)
    const row=await item('preparing'),stockId=await stock(row,'direct_sale');await payment(row.orderId)
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    const metadata={scope,employeeId,businessDate:businessDate,reason:'现场收回与实际消耗核对'}
    const created=await service.request({...metadata,idempotencyKey:`physical-request-${randomUUID()}`,orderItemId:row.itemId,quantity:2})
    const caseId=created.value.caseId
    await service.decide({...metadata,caseId,employeeId:reviewerId,decision:'approved',idempotencyKey:`physical-approved-${randomUUID()}`})
    const units=(await runner.run(scope,tx=>new ItemQuantityRepository(tx).readUnits(row.itemId))).filter(unit=>unit.held_by_case_id===caseId)
    const received={...metadata,caseId,unitIds:[units[0].id],disposition:'returned_unopened' as const,unopenedReceived:true,idempotencyKey:`physical-return-${randomUUID()}`}
    const first=await service.disposeMade(received)
    expect(first.value).toMatchObject({heldQuantity:1,stoppedQuantity:1,moneyComplete:false,awaitingCashPayout:true})
    expect((await service.disposeMade({...received,businessDate:nextBusinessDate})).replayed).toBe(true)
    const final=await service.disposeMade({...metadata,caseId,unitIds:[units[1].id],disposition:'used_loss',unopenedReceived:false,idempotencyKey:`physical-loss-${randomUUID()}`})
    expect(final.value).toMatchObject({heldQuantity:0,stoppedQuantity:2,physicalComplete:true,moneyComplete:false})
    expect(await balance(stockId)).toEqual({on_hand:'6.000000',reserved:'0.000000'})
    expect((await pool.query("SELECT count(*)::int AS n FROM mbox.item_after_sales_events WHERE case_id=$1 AND event_type LIKE 'operating.physical:%'",[caseId])).rows[0].n).toBe(2)
    const refunds=(await pool.query('SELECT status,approved_by_employee_id FROM mbox.refunds WHERE id=$1',[final.value.refunds[0].id])).rows
    expect(refunds).toEqual([{status:'approved',approved_by_employee_id:reviewerId}])
  })

  it('HTTP product workspace uses real permissions, one independent approval and original retry across dates',async()=>{
    await grantActor(employeeId,['refund.request','refund.approve'],100000)
    await grantActor(reviewerId,['refund.approve'],100000)
    const row=await item();await payment(row.orderId)
    let actor=employeeId,date=businessDate
    const app=Fastify()
    await app.register(itemAfterSalesApiPlugin,{prefix:'/api',transactions:runner,commands:new NormalizedCommandExecutor(runner),resolveContext:()=>({scope,employeeId:actor,businessDate:date,capabilities:[]})})
    try{
      const initial=await app.inject({method:'GET',url:`/api/commerce/item-after-sales/items/${row.itemId}`})
      expect(initial.statusCode).toBe(200);expect(initial.json().data.units).toEqual([])
      const url='/api/commerce/item-after-sales/requests',headers={'idempotency-key':`http-case-${randomUUID()}`},payload={orderItemId:row.itemId,quantity:2,reason:'客人两瓶不要了'}
      const invalid=await app.inject({method:'POST',url,headers,payload:{...payload,quantity:'2'}})
      expect(invalid.statusCode).toBe(400)
      const requested=await app.inject({method:'POST',url,headers,payload})
      expect(requested.statusCode).toBe(201)
      const caseId=requested.json().data.caseId
      date=nextBusinessDate
      const replay=await app.inject({method:'POST',url,headers,payload})
      expect(replay.statusCode).toBe(200);expect(replay.json()).toMatchObject({replayed:true,data:{caseId,businessDate:businessDate,heldQuantity:2}})
      const decisionUrl=`/api/commerce/item-after-sales/${caseId}/decision`
      expect((await app.inject({method:'POST',url:decisionUrl,headers:{'idempotency-key':`self-${randomUUID()}`},payload:{decision:'approved',reason:'本人不应自审'}})).statusCode).toBe(409)
      actor=reviewerId
      const approved=await app.inject({method:'POST',url:decisionUrl,headers:{'idempotency-key':`review-${randomUUID()}`},payload:{decision:'approved',reason:'同意原路退回两瓶'}})
      expect(approved.statusCode).toBe(200);expect(approved.json().data).toMatchObject({physicalComplete:true,moneyComplete:false,awaitingCashPayout:true})
      const detail=await app.inject({method:'GET',url:`/api/commerce/item-after-sales/items/${row.itemId}`})
      expect(detail.json().data.cases).toMatchObject([{caseId,canApprove:false,canReject:false,canResume:false,stoppedQuantity:2}])
      let pendingUrl='/api/commerce/item-after-sales/pending',found=false
      for(let page=0;page<20;page++){
        const pending=await app.inject({method:'GET',url:pendingUrl}),data=pending.json().data
        if(data.items.some((item:{caseId:string})=>item.caseId===caseId)){found=true;break}
        if(!data.nextCursor)break
        pendingUrl=`/api/commerce/item-after-sales/pending?${new URLSearchParams({cursorId:data.nextCursor.id,createdAt:data.nextCursor.createdAt})}`
      }
      expect(found).toBe(true)
    }finally{await app.close()}
  })

  it('disabling new quantity requests preserves original HTTP recovery, review, money and notice completion',async()=>{
    await grantActor(employeeId,['refund.request'])
    await grantActor(reviewerId,['refund.approve','refund.execute'],100000)
    const row=await item();await payment(row.orderId)
    let actor=employeeId,date=businessDate
    const enabled=Fastify(),recovery=Fastify(),commands=new NormalizedCommandExecutor(runner)
    for(const [app,flag] of [[enabled,true],[recovery,false]] as const)await app.register(itemAfterSalesApiPlugin,{enabled:flag,prefix:'/api',transactions:runner,commands,resolveContext:()=>({scope,employeeId:actor,businessDate:date,capabilities:[]})})
    try{
      const url='/api/commerce/item-after-sales/requests',headers={'idempotency-key':`rollback-case-${randomUUID()}`},payload={orderItemId:row.itemId,quantity:2,reason:'原已付款商品两份不再需要'}
      const requested=await enabled.inject({method:'POST',url,headers,payload})
      expect(requested.statusCode).toBe(201)
      const caseId=requested.json().data.caseId
      date=nextBusinessDate
      const access=await recovery.inject({method:'GET',url:'/api/commerce/item-after-sales/access'})
      expect(access.json().data).toMatchObject({enabled:false,recoveryAvailable:true})
      const detail=await recovery.inject({method:'GET',url:`/api/commerce/item-after-sales/items/${row.itemId}`})
      expect(detail.statusCode).toBe(200);expect(detail.json().data).toMatchObject({canRequest:false,cases:[{caseId,status:'requested',heldQuantity:2}]})
      const repeated=await recovery.inject({method:'POST',url,headers,payload})
      expect(repeated.statusCode).toBe(200);expect(repeated.json()).toMatchObject({replayed:true,data:{caseId,businessDate:businessDate}})
      const newRequest=await recovery.inject({method:'POST',url,headers:{'idempotency-key':`rollback-new-${randomUUID()}`},payload})
      expect(newRequest.statusCode).toBe(409);expect(newRequest.json().error.code).toBe('QUANTITY_BATCH_NOT_ENABLED')
      expect((await pool.query('SELECT count(*)::int n FROM mbox.item_after_sales_cases WHERE order_id=$1',[row.orderId])).rows[0].n).toBe(1)
      const altered=await recovery.inject({method:'POST',url,headers,payload:{...payload,quantity:3}})
      expect(altered.statusCode).toBe(409);expect(altered.json().error.code).toBe('IDEMPOTENCY_CONFLICT')
      actor=reviewerId
      const approved=await recovery.inject({method:'POST',url:`/api/commerce/item-after-sales/${caseId}/decision`,headers:{'idempotency-key':`rollback-approve-${randomUUID()}`},payload:{decision:'approved',reason:'继续原申请的一次审核'}})
      expect(approved.statusCode).toBe(200);expect(approved.json().data).toMatchObject({physicalComplete:true,moneyComplete:false,awaitingCashPayout:true})
      await manualResult(approved.json().data.refunds[0].id,true)
      const done=await recovery.inject({method:'GET',url:`/api/commerce/item-after-sales/items/${row.itemId}`})
      const current=done.json().data.cases.find((value:{caseId:string})=>value.caseId===caseId)
      expect(current).toMatchObject({status:'completed',moneyComplete:true,physicalComplete:true,succeededMinor:1600})
      actor=employeeId
      const ack=await recovery.inject({method:'POST',url:`/api/commerce/item-after-sales/${caseId}/notice-ack`,headers:{'idempotency-key':`rollback-ack-${randomUUID()}`},payload:{reason:'已联系原岗位确认通知知悉',noticeIds:current.notices.map((value:{id:string})=>value.id)}})
      expect(ack.statusCode).toBe(200)
    }finally{await enabled.close();await recovery.close()}
  })

  it('historical quantity facts show the effective receivable and stock recovery without rewriting the invoice',async()=>{
    const row=await item(),stockId=await stock(row,'direct_sale');await stopUnpaid(row,2)
    const date=(await pool.query('SELECT business_date::text AS date FROM mbox.orders WHERE id=$1',[row.orderId])).rows[0].date
    const history=await runner.run(scope,tx=>readOperatingHistory(tx,{businessDate:date,table:'',employee:'',page:0,search:`quantity-${row.orderId}`,allowFinancialSummary:true}))
    expect(history.orders).toHaveLength(1)
    expect(history.orders[0]).toMatchObject({totalMinor:4000,effectiveAmountMinor:2400,stoppedAmountMinor:1600,
      items:[{quantity:5,returnedQuantity:2,quantities:{total:5,held:0,stopped:2,delivered:0,usedLoss:0}}]})
    expect(await balance(stockId)).toEqual({on_hand:'7.000000',reserved:'0.000000'})
    const staffBefore=await runner.run(scope,tx=>listTablePaymentOrdersForSession(tx,sessionId))
    expect(staffBefore.find(order=>order.id===row.orderId)).toMatchObject({outstandingAmountMinor:2400})
    const details=await runner.run(scope,tx=>listTableOrderDetailsForSession(tx,sessionId))
    expect(details.find(order=>order.publicId===`quantity-${row.orderId}`)).toMatchObject({totalAmountMinor:4000,stoppedAmountMinor:1600,items:[{quantities:{stopped:2,pending:3}}]})
    await runner.run(scope,tx=>new PaymentRepository(tx).createForOrder({...cashInput(),orderId:row.orderId}))
    expect((await runner.run(scope,tx=>listTablePaymentOrdersForSession(tx,sessionId))).some(order=>order.id===row.orderId)).toBe(false)
  })

  it('prints the remaining receivable and the stopped reduction while retaining original line prices',async()=>{
    const printer=randomUUID()
    await pool.query("INSERT INTO mbox.devices(id,tenant_id,store_id,code,name,device_type,station_code,connectivity_status) VALUES($1,$2,$3,$4,'Test cashier printer','printer','cashier','offline')",[printer,tenantId,storeId,`Q-CASH-${printer}`])
    await pool.query("INSERT INTO mbox.printer_routes(tenant_id,store_id,code,name,station_code,printer_device_id) VALUES($1,$2,$3,'Cashier','cashier',$4)",[tenantId,storeId,`Q-CASH-${printer}`,printer])
    const row=await item();await stopUnpaid(row,2)
    const source=await runner.run(scope,tx=>appendOutboxMessage(tx,{aggregateType:'order',aggregateId:row.orderId,aggregateVersion:1,eventType:'test.quantity.bill',payload:{}}))
    const jobs=await runner.run(scope,tx=>new PrintTicketSourceRepository(tx,true).materializeManualOrderBill(source,row.orderId,'测试员工'))
    expect(jobs).toHaveLength(1)
    const snapshot=(await pool.query('SELECT print_snapshot FROM mbox.print_jobs WHERE source_outbox_message_id=$1',[source])).rows[0].print_snapshot
    expect(snapshot.lines.find((line:{name:string})=>line.name==='订单应付金额')).toMatchObject({totalAmountMinor:2400})
    expect(snapshot.lines.find((line:{name:string})=>line.name==='退菜减额（已扣除）')).toMatchObject({totalAmountMinor:1600})
    expect(snapshot.lines.find((line:{name:string})=>line.name==='尚未收款')).toMatchObject({totalAmountMinor:2400})
    expect(snapshot.lines.find((line:{name:string})=>line.name==='水')).toMatchObject({quantity:5,unitAmountMinor:800,totalAmountMinor:4000})
  })

  it('prints and collects a bundle single-price increase without a negative reduction or rewriting its invoice',async()=>{
    await grantActor(employeeId,['refund.request'])
    const row=await pricedBundle()
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    await service.request({scope,employeeId,businessDate:businessDate,orderItemId:row.itemId,quantity:2,reason:'未付套餐退两瓶，余项单点价44元',idempotencyKey:randomUUID()})
    const source=await runner.run(scope,tx=>appendOutboxMessage(tx,{aggregateType:'order',aggregateId:row.orderId,aggregateVersion:1,eventType:'test.bundle.bill',payload:{}}))
    const jobs=await runner.run(scope,tx=>new PrintTicketSourceRepository(tx,true).materializeManualOrderBill(source,row.orderId,'测试员工'))
    expect(jobs.length).toBeGreaterThan(0)
    const snapshot=(await pool.query('SELECT print_snapshot FROM mbox.print_jobs WHERE source_outbox_message_id=$1',[source])).rows[0].print_snapshot
    expect(snapshot.lines.find((line:{name:string})=>line.name==='订单应付金额')).toMatchObject({totalAmountMinor:4400})
    expect(snapshot.lines.find((line:{name:string})=>line.name==='套餐按单点价补差（已计入）')).toMatchObject({totalAmountMinor:400})
    expect(snapshot.lines.find((line:{name:string})=>line.name==='尚未收款')).toMatchObject({totalAmountMinor:4400})
    const date=(await pool.query('SELECT business_date::text AS date FROM mbox.orders WHERE id=$1',[row.orderId])).rows[0].date
    const history=await runner.run(scope,tx=>readOperatingHistory(tx,{businessDate:date,table:'',employee:'',page:0,search:`quantity-${row.orderId}`,allowFinancialSummary:true}))
    expect(history.orders[0]).toMatchObject({totalMinor:4000,effectiveAmountMinor:4400,stoppedAmountMinor:0,receivableIncreaseMinor:400})
    expect(await runner.run(scope,tx=>new PaymentRepository(tx).createForOrder({...cashInput(),orderId:row.orderId}))).toMatchObject({amountMinor:4400})
  })

  it('a new completion slip binds its own units rather than older unbatched goods, and replay keeps the original slip',async()=>{
    const row=await item()
    const task={id:row.taskId,orderItemId:row.itemId,remakeOfTaskId:null,stationCode:'bar' as const,status:'pending' as const,priority:100,quantity:5,assignedEmployeeId:null,dueAt:null,nextActionAt:new Date().toISOString(),acceptedAt:null,readyAt:null,cancelledAt:null}
    const old=await runner.run(scope,tx=>new ItemQuantityFulfillmentRepository(tx).complete({itemId:row.itemId,taskId:row.taskId,employeeId,quantity:2,eventKey:`old-ready-${randomUUID()}`}))
    const eventKey=`new-ready-${randomUUID()}`
    const current=await runner.run(scope,tx=>executeQuantityKdsAction(tx,{task,action:'complete',employeeId,quantity:1,eventKey}))
    expect(current.unitIds.some(id=>old.unitIds.includes(id))).toBe(false)
    expect((await pool.query('SELECT unit_id FROM mbox.delivery_batch_quantity_units WHERE batch_id=$1',[current.batch!.id])).rows.map(row=>row.unit_id)).toEqual(current.unitIds)
    const repeated=await runner.run(scope,tx=>executeQuantityKdsAction(tx,{task,action:'complete',employeeId,eventKey}))
    expect(repeated.unitIds).toEqual(current.unitIds);expect(repeated.batch).toEqual(current.batch)
    await expect(runner.run(scope,tx=>executeQuantityKdsAction(tx,{task,action:'complete',employeeId,quantity:2,eventKey}))).rejects.toThrow('另一动作')
    expect((await pool.query('SELECT count(*)::int n FROM mbox.delivery_batch_items WHERE kds_task_id=$1',[row.taskId])).rows[0].n).toBe(1)
    const oldBatch=await runner.run(scope,tx=>new DeliveryBatchRepository(tx).create(employeeId,[{taskId:row.taskId,quantity:2}]))
    expect((await pool.query('SELECT unit_id FROM mbox.delivery_batch_quantity_units WHERE batch_id=$1',[oldBatch.id])).rows.map(row=>row.unit_id).sort()).toEqual([...old.unitIds].sort())
  })

  it('partly ready goods remain deliverable while other units are held, and each slip binds unique original units',async()=>{
    await grantActor(employeeId,['kds.deliver','fulfillment.view_all'])
    const row=await item(),created=await hold(row.itemId,2)
    const task={id:row.taskId,orderItemId:row.itemId,remakeOfTaskId:null,stationCode:'bar' as const,status:'pending' as const,priority:100,quantity:5,assignedEmployeeId:null,dueAt:null,nextActionAt:new Date().toISOString(),acceptedAt:null,readyAt:null,cancelledAt:null}
    const completed=await runner.run(scope,async tx=>{
      await tx.query('SET LOCAL ROLE mbox_runtime')
      return executeQuantityKdsAction(tx,{task,action:'complete',employeeId,quantity:3,eventKey:`quantity-ready-${randomUUID()}`})
    })
    expect(completed).toMatchObject({quantity:3,fulfillmentStatus:'in_progress',batch:{items:[{taskId:row.taskId,quantity:3}]}})
    const assigned=(await pool.query('SELECT unit_id FROM mbox.delivery_batch_quantity_units WHERE batch_id=$1',[completed.batch!.id])).rows.map(row=>row.unit_id)
    expect(assigned).toHaveLength(3);expect(assigned.some(id=>created.unitIds.includes(id))).toBe(false)
    const query=new FulfillmentQueryService(runner)
    const work=(await query.getStaffWorkQueue(scope,employeeId,businessDate)).workItems.find(work=>work.taskId===row.taskId)
    expect(work).toMatchObject({kdsStatus:'preparing',readyForDelivery:true,canDeliver:true,deliveryUnbatchedQuantity:0,quantities:{total:5,ready:3,held:2,stopped:0}})
    await expect(runner.run(scope,tx=>new DeliveryBatchRepository(tx).create(employeeId,[{taskId:row.taskId,quantity:1}]))).rejects.toThrow('尚未安排配送')
    const delivered=await runner.run(scope,tx=>executeQuantityKdsAction(tx,{task,action:'deliver',employeeId,quantity:3,eventKey:`quantity-deliver-${randomUUID()}`}))
    expect(delivered).toMatchObject({quantity:3,fulfillmentStatus:'in_progress',batch:null})
    await runner.run(scope,async tx=>{
      await new ItemQuantityRepository(tx).decide({caseId:created.caseId,employeeId:reviewerId,decision:'rejected',reason:'客人确认继续'});
      await new ItemQuantityRepository(tx).resume({caseId:created.caseId,employeeId})
    })
    const remaining=await runner.run(scope,tx=>executeQuantityKdsAction(tx,{task,action:'complete',employeeId,quantity:2,eventKey:`quantity-rest-${randomUUID()}`}))
    expect(remaining.batch?.items).toEqual([{taskId:row.taskId,quantity:2}])
    expect((await pool.query('SELECT count(*)::int n FROM mbox.delivery_batch_quantity_units WHERE kds_task_id=$1',[row.taskId])).rows[0].n).toBe(5)
    const final=await runner.run(scope,tx=>executeQuantityKdsAction(tx,{task,action:'deliver',employeeId,eventKey:`quantity-final-${randomUUID()}`}))
    expect(final).toMatchObject({quantity:2,fulfillmentStatus:'delivered'})
    expect((await query.getStaffWorkQueue(scope,employeeId,businessDate)).workItems.some(work=>work.taskId===row.taskId)).toBe(false)
  })

  it('routes a linked refund through the original case while retaining the database decision guard',async()=>{
    await grantActor(employeeId,['refund.request']);await grantActor(reviewerId,['refund.approve','refund.execute'],100000)
    const row=await item('ready');await stock(row,'direct_sale');await payment(row.orderId)
    const service=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    const request=await service.request({scope,employeeId,businessDate,orderItemId:row.itemId,quantity:1,reason:'原售后入口分流验证',idempotencyKey:randomUUID()})
    const caseId=request.value.caseId
    const refundId=(await pool.query('SELECT refund_id FROM mbox.item_after_sales_case_refunds WHERE case_id=$1',[caseId])).rows[0].refund_id
    await expect(financialService().approveRefund({...financialMetadata(),actor:{type:'employee',employeeId},refundId,decisionReason:'自审不能看到原单关联'})).rejects.not.toHaveProperty('caseId')
    for(const decide of ['approveRefund','rejectRefund'] as const)await expect(financialService()[decide]({...financialMetadata(),refundId,decisionReason:'原售后入口分流验证'})).rejects.toMatchObject({code:'REFUND_REQUIRES_CASE_DECISION',refundId,caseId})
    await expect(pool.query("UPDATE mbox.refunds SET status='approved',approved_by_employee_id=$2,decision_reason='绕过测试' WHERE id=$1",[refundId,reviewerId])).rejects.toMatchObject({code:'23514'})
    expect((await pool.query('SELECT status FROM mbox.refunds WHERE id=$1',[refundId])).rows[0].status).toBe('requested')
    const workbench=await new PostgresCashierWorkbenchQuery(runner).get({scope,employeeId:reviewerId,businessDate,capabilities:['refund.request','refund.approve','refund.execute'],query:`quantity-${row.orderId}`,limit:20})
    expect(workbench.orders.find(order=>order.id===row.orderId)?.payments[0].refunds.find(refund=>refund.id===refundId)?.afterSalesCase).toEqual({caseId,orderItemId:row.itemId,status:'requested'})
    const input={scope,employeeId:reviewerId,businessDate,caseId,decision:'approved' as const,reason:'原售后整体批准验证',idempotencyKey:randomUUID()}
    const result=await service.decide(input)
    expect(result.value.status).toBe('approved')
    const workspace=await new ItemAfterSalesQuery(runner).item({scope,employeeId:reviewerId,itemId:row.itemId})
    expect(workspace.cases[0].notices.map(notice=>notice.phase)).toEqual(['request','approved'])
    expect((await service.decide(input)).replayed).toBe(true)
  })
  async function bottledStock(volume:string){
    const row=await item('ready'),stockId=randomUUID()
    await pool.query(`UPDATE mbox.order_items SET product_snapshot=product_snapshot||'{"inventoryControlMode":"tracked","source":{"salesSpecificationType":"whole_bottle"}}'::jsonb WHERE id=$1`,[row.itemId])
    await pool.query("INSERT INTO mbox.inventory_items(id,tenant_id,store_id,sku,name,item_type,base_unit,package_volume_ml) VALUES($1,$2,$3,$4,'整瓶水','bottle','ml',$5)",[stockId,tenantId,storeId,`bottle-${stockId}`,volume])
    await pool.query('INSERT INTO mbox.inventory_balances(tenant_id,store_id,inventory_item_id,on_hand_quantity) VALUES($1,$2,$3,5000)',[tenantId,storeId,stockId])
    await pool.query("INSERT INTO mbox.inventory_movements(tenant_id,store_id,inventory_item_id,movement_type,quantity_delta,reference_type,reference_id,order_item_id,unit_cost_minor) VALUES($1,$2,$3,'sale',-2500,'order_item',$4,$4,100)",[tenantId,storeId,stockId,row.itemId])
    await payment(row.orderId)
    const created=await hold(row.itemId,1)
    await runner.run(scope,tx=>new ItemUnitInventoryRepository(tx).initialize(row.itemId))
    await runner.run(scope,tx=>new ItemQuantityRefundRepository(tx).prepare(created.caseId))
    await runner.run(scope,tx=>new ItemQuantityRefundRepository(tx).decide({caseId:created.caseId,employeeId:reviewerId,decision:'approved',reason:'实物核对测试'}))
    return {...row,...created,stockId}
  }
  it('returns the original captured package once even after the current catalogue capacity changes',async()=>{
    const row=await bottledStock('500')
    await pool.query('UPDATE mbox.inventory_items SET package_volume_ml=330 WHERE id=$1',[row.stockId])
    const read=await new ItemAfterSalesQuery(runner).item({scope,employeeId:reviewerId,itemId:row.itemId})
    expect(read.units.find(unit=>unit.id===row.unitIds[0])?.returnEligibility).toMatchObject({canReturn:true})
    const dispose=()=>runner.run(scope,tx=>new ItemUnitInventoryRepository(tx).disposeMadeUnits({itemId:row.itemId,caseId:row.caseId,unitIds:row.unitIds,employeeId:reviewerId,disposition:'returned_unopened',unopenedReceived:true,reason:'原包装500ml未开封收回'}))
    const attempts=await Promise.allSettled([dispose(),dispose()])
    expect(attempts.some(result=>result.status==='fulfilled')).toBe(true)
    expect(await balance(row.stockId)).toEqual({on_hand:'5500.000000',reserved:'0.000000'})
    expect((await pool.query("SELECT count(*)::int n FROM mbox.inventory_movements WHERE inventory_item_id=$1 AND movement_type='return'",[row.stockId])).rows[0].n).toBe(1)
  })
  it('blocks contradictory 500 ml consumption and 330 ml packaging in both preview and execution without moving stock',async()=>{
    const row=await bottledStock('330')
    const preview=await runner.run(scope,tx=>readPackagedReturnEligibility(tx,row.unitIds))
    expect(preview.get(row.unitIds[0])!).toMatchObject({canReturn:false,reason:expect.stringMatching(/500.*330/)})
    await expect(runner.run(scope,tx=>new ItemUnitInventoryRepository(tx).disposeMadeUnits({itemId:row.itemId,caseId:row.caseId,unitIds:row.unitIds,employeeId:reviewerId,disposition:'returned_unopened',unopenedReceived:true,reason:'不允许规格冲突误回库'}))).rejects.toThrow(preview.get(row.unitIds[0])!.reason!)
    expect(await balance(row.stockId)).toEqual({on_hand:'5000.000000',reserved:'0.000000'})
    expect((await pool.query("SELECT count(*)::int n FROM mbox.inventory_movements WHERE inventory_item_id=$1 AND movement_type='return'",[row.stockId])).rows[0].n).toBe(0)
  })
  it('captures immutable reservation packaging and rejects contradictory whole-bottle edits while allowing glass recipes',async()=>{
    const row=await item(),stockId=await stock(row,'reserved')
    const before=(await pool.query('SELECT packaging_snapshot FROM mbox.inventory_order_reservations WHERE inventory_item_id=$1',[stockId])).rows[0].packaging_snapshot
    expect(before).toMatchObject({baseUnit:'piece',itemType:'food',packageVolumeMl:null})
    await expect(pool.query("UPDATE mbox.inventory_order_reservations SET packaging_snapshot='{}' WHERE inventory_item_id=$1",[stockId])).rejects.toMatchObject({code:'23514'})
    async function recipe(spec:string,quantity:number){
      const id=randomUUID(),recipeId=randomUUID(),inventoryId=randomUUID()
      await runner.run(scope,async tx=>{
        await tx.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station,product_snapshot) VALUES($1,$2,$3,$4,$4,'drink','bar',$5::jsonb)",[id,tenantId,storeId,`bottle-${id}`,JSON.stringify({salesSpecificationType:spec})])
        await tx.query("INSERT INTO mbox.inventory_items(id,tenant_id,store_id,sku,name,item_type,base_unit,package_volume_ml) VALUES($1,$2,$3,$4,'瓶装500','bottle','ml',500)",[inventoryId,tenantId,storeId,`bottle-${inventoryId}`])
        await tx.query("INSERT INTO mbox.recipes(id,tenant_id,store_id,product_id,version,status,effective_at) VALUES($1,$2,$3,$4,1,'active',clock_timestamp())",[recipeId,tenantId,storeId,id])
        await tx.query('INSERT INTO mbox.recipe_items(tenant_id,store_id,recipe_id,inventory_item_id,quantity) VALUES($1,$2,$3,$4,$5)',[tenantId,storeId,recipeId,inventoryId,quantity])
      })
      return {id,inventoryId}
    }
    const valid=await recipe('whole_bottle',500)
    await expect(pool.query('UPDATE mbox.inventory_items SET package_volume_ml=330 WHERE id=$1',[valid.inventoryId])).rejects.toMatchObject({code:'23514',constraint:'inventory_packaging_recipe_ck'})
    await expect(recipe('whole_bottle',330)).rejects.toMatchObject({constraint:'inventory_packaging_recipe_ck'})
    const glass=await recipe('glass',45)
    await expect(pool.query('UPDATE mbox.inventory_items SET package_volume_ml=330 WHERE id=$1',[glass.inventoryId])).resolves.toBeDefined()
    expect((await pool.query('SELECT packaging_snapshot FROM mbox.inventory_order_reservations WHERE inventory_item_id=$1',[stockId])).rows[0].packaging_snapshot).toEqual(before)
  })

})
