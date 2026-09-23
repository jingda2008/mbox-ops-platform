import {randomUUID} from 'node:crypto'
import Fastify from 'fastify'
import {Pool} from 'pg'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner,type TransactionOptions,type ScopedTransaction,type StoreScope} from './transaction-runner.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {KdsRepository} from './kds-repository.js'
import {OrderRepository} from './order-repository.js'
import {NormalizedPaymentCapabilityAuthorization} from './payment-security-policy.js'
import {PaymentCommandService,type RecordManualPaymentCommand} from './payment-command-service.js'
import {pickupWorkflowApiPlugin} from './pickup-workflow-api.js'
import type {PickupBoardData,PickupCommand} from '../../src/shared/pickup-workflow.js'
import {kitchenProductionApiPlugin} from './kitchen-production-api.js'
import {kitchenCompatibilityKey,type KitchenBoardData,type KitchenCommand} from '../../src/shared/kitchen-production.js'

const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
const integration=databaseUrl&&runtimeUrl?describe:describe.skip
integration('cash and current three-screen commands use one parent lock order',()=>{
  const tenantId=randomUUID(),storeId=randomUUID(),employeeId=randomUUID(),areaId=randomUUID(),productId=randomUUID(),roleId=randomUUID()
  const credentialId=randomUUID(),leaseId=randomUUID(),staffSessionId=randomUUID(),scope={tenantId,storeId}
  let pool:Pool,runtimePool:Pool,runner:ScopedPostgresTransactionRunner,runtime:ScopedPostgresTransactionRunner,businessDate:string
  const app=Fastify()
  beforeAll(async()=>{
    await runNormalizedMigrations(databaseUrl!);pool=new Pool({connectionString:databaseUrl,max:8});runner=new ScopedPostgresTransactionRunner(pool)
    runtimePool=new Pool({connectionString:runtimeUrl,max:8});runtime=new ScopedPostgresTransactionRunner(runtimePool)
    await pool.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Kitchen isolation')",[tenantId,`k-${tenantId}`])
    await pool.query("INSERT INTO mbox.stores(id,tenant_id,code,name,timezone,business_day_cutoff) VALUES($1,$2,'kitchen-store','Kitchen','Asia/Shanghai','06:00')",[storeId,tenantId])
    businessDate=await runner.run(scope,async tx=>(await tx.query<{date:string}>('SELECT mbox.current_operating_business_date($1,$2)::text AS date',[tenantId,storeId])).rows[0]!.date)
    await pool.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'K','K','indoor')",[areaId,tenantId,storeId])
    await pool.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,'cook','测试厨师')",[employeeId,tenantId,storeId])
    await pool.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'KITCHEN_TEST','Kitchen')",[roleId,tenantId,storeId])
    await pool.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 hour')",[tenantId,storeId,employeeId,roleId])
    for(const code of ['kds.prepare','kds.deliver','table.transfer','fulfillment.view_all','service.execute','service.manage','table.view_all','table.close','table.turnover_unsettled','staff.access.configure','payment.manual.cash.record','payment.collect.all_tables']){
      const permission=(await pool.query("INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category) VALUES($1,$2,$3,$3,'operations') ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET name=EXCLUDED.name RETURNING id",[tenantId,storeId,code])).rows[0].id
      await pool.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) VALUES($1,$2,$3,$4)',[tenantId,storeId,roleId,permission])
    }
    await pool.query(`INSERT INTO mbox.role_data_scopes(tenant_id,store_id,role_id,scope_key,effect,scope_value,value_kind,text_values,enabled) VALUES($1,$2,$3,'kds.station_codes','include','["kitchen"]','text_set',ARRAY['kitchen'],true)`,[tenantId,storeId,roleId])
    await pool.query("INSERT INTO mbox.store_daily_credentials(id,tenant_id,store_id,business_date,credential_hash,valid_from,valid_until,configured_by_employee_id) VALUES($1,$2,$3,current_date,'scrypt$kitchen-test',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '8 hours',$4)",[credentialId,tenantId,storeId,employeeId])
    await pool.query("INSERT INTO mbox.store_device_access_leases(id,tenant_id,store_id,daily_credential_id,business_date,device_key_hash,lease_token_hash,issued_at,expires_at) VALUES($1,$2,$3,$4,current_date,repeat('a',64),repeat('b',64),clock_timestamp()-interval '1 hour',clock_timestamp()+interval '8 hours')",[leaseId,tenantId,storeId,credentialId])
    // Session expiry is constrained to exactly six hours after issuance; all fixture times must share one statement timestamp.
    await pool.query("INSERT INTO mbox.staff_sessions(id,tenant_id,store_id,employee_id,device_access_lease_id,session_token_hash,issued_at,expires_at,online_lease_until) VALUES($1,$2,$3,$4,$5,repeat('c',64),statement_timestamp(),statement_timestamp()+interval '6 hours',statement_timestamp()+interval '30 minutes')",[staffSessionId,tenantId,storeId,employeeId,leaseId])
    await pool.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station) VALUES($1,$2,$3,'K-FOOD','测试薯条','food','kitchen')",[productId,tenantId,storeId])
    await app.register(kitchenProductionApiPlugin,{enabled:true,prefix:'/api',staffAccessTransactions:runtime,commandExecutor:new NormalizedCommandExecutor(runtime),resolveContext:()=>({scope,employeeId,staffSessionId,deviceAccessLeaseId:leaseId,businessDate}),createKdsRepository:tx=>new KdsRepository(tx),createOrderRepository:tx=>new OrderRepository(tx)})
    await app.register(pickupWorkflowApiPlugin,{enabled:true,prefix:'/api',staffAccessTransactions:runtime,commandExecutor:new NormalizedCommandExecutor(runtime),resolveContext:()=>({scope,employeeId,staffSessionId,deviceAccessLeaseId:leaseId,businessDate})})
  },30000)
  afterAll(async()=>{await app.close();await runtimePool?.end();await pool?.end()})
  async function table(){const id=randomUUID();await pool.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,$5,$5,8)",[id,tenantId,storeId,areaId,`T${id.slice(0,8)}`]);return id}
  async function item(note='',stock=false){
    const tableId=await table(),tableSessionId=randomUUID(),orderId=randomUUID(),itemId=randomUUID(),taskId=randomUUID()
    await pool.query('INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1,$2,$3,$4,$5,$6,5)',[tableSessionId,tenantId,storeId,tableId,`s-${tableSessionId}`,businessDate])
    await pool.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,submitted_at,subtotal_amount_minor,total_amount_minor) VALUES($1,$2,$3,$4,$5,'staff_assisted','submitted',clock_timestamp(),5000,5000)",[orderId,tenantId,storeId,tableSessionId,`k-${orderId}`])
    await pool.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot,note) VALUES($1,$2,$3,$4,$5,5,1000,5000,'kitchen',$6::jsonb,$7)`,[itemId,tenantId,storeId,orderId,productId,JSON.stringify({name:'测试薯条',inventoryControlMode:stock?'tracked':'not_managed'}),note])
    await pool.query("INSERT INTO mbox.kds_tasks(id,tenant_id,store_id,order_item_id,station_code,quantity) VALUES($1,$2,$3,$4,'kitchen',5)",[taskId,tenantId,storeId,itemId])
    const stockId=randomUUID()
    if(stock){await pool.query("INSERT INTO mbox.inventory_items(id,tenant_id,store_id,sku,name,item_type,base_unit) VALUES($1,$2,$3,$4,'薯条材料','food','piece')",[stockId,tenantId,storeId,`K-${stockId}`])
      await pool.query('INSERT INTO mbox.inventory_balances(tenant_id,store_id,inventory_item_id,on_hand_quantity,reserved_quantity) VALUES($1,$2,$3,10,5)',[tenantId,storeId,stockId])
      await pool.query("INSERT INTO mbox.inventory_order_reservations(tenant_id,store_id,order_id,order_item_id,inventory_item_id,quantity,expires_at) VALUES($1,$2,$3,$4,$5,5,clock_timestamp()+interval '1 hour')",[tenantId,storeId,orderId,itemId,stockId])}
    return {taskId,itemId,tableId,tableSessionId,orderId,stockId}
  }
  async function board(){const response=await app.inject('/api/commerce/kitchen-board');expect(response.statusCode,response.body).toBe(200);return response.json().data as KitchenBoardData}
  async function start(rows:Array<{taskId:string}>,equipment:string|null=null,quantity=2,action:'start'|'quick-ready'='start'){
    const current=await board(),selected=rows.map(row=>current.pending.find(item=>item.taskId===row.taskId)!)
    return {action,compatibilityKey:kitchenCompatibilityKey(selected[0]!),items:selected.map(row=>({taskId:row.taskId,quantity,expectedUnmade:row.unmade,tableId:row.tableId,tableSessionId:row.tableSessionId,locationVersion:row.locationVersion})),equipment,expectedSeconds:null} as KitchenCommand
  }
  function command(body:KitchenCommand,key=randomUUID()){return app.inject({method:'POST',url:'/api/commerce/kitchen-board/commands',headers:{'idempotency-key':key},payload:{employeeId,command:body}})}
  async function expectOk(body:KitchenCommand,key?:string){const response=await command(body,key);expect(response.statusCode,response.body).toBe(200);return response.json().data as {batchId:string;quantity:number;released:boolean}}
  for(const currentPath of ['kitchen-ready','pickup-take'] as const)it(`cash versus current ${currentPath} succeeds on the first attempt and replays once`,async()=>{
    const row=await item()
    const batch=await expectOk(await start([row],null,5,currentPath==='kitchen-ready'?'start':'quick-ready'))
    let body:KitchenCommand|PickupCommand,url:string
    if(currentPath==='kitchen-ready'){
      const current=(await board()).batches.find(value=>value.id===batch.batchId)!
      body={action:'ready',batchId:batch.batchId,expectedOwnershipVersion:current.ownershipVersion,items:[{taskId:row.taskId,tableId:row.tableId,tableSessionId:row.tableSessionId,locationVersion:0,unitIds:current.units.map(unit=>unit.unitId)}]}
      url='/api/commerce/kitchen-board/commands'
    }else{
      const device=await app.inject({method:'POST',url:'/api/commerce/pickup-board/device',headers:{'idempotency-key':randomUUID()},payload:{enabled:true,label:'隔离复核共用取餐屏'}})
      expect(device.statusCode,device.body).toBe(200)
      const response=await app.inject('/api/commerce/pickup-board')
      expect(response.statusCode,response.body).toBe(200)
      const group=(response.json().data as PickupBoardData).tables.find(value=>value.tableSessionId===row.tableSessionId)!
      expect(group.units).toHaveLength(5)
      body={action:'take',tableId:group.tableId,tableSessionId:group.tableSessionId,locationVersion:group.locationVersion,units:group.units.map(unit=>({kind:unit.kind,unitId:unit.unitId,version:unit.version}))}
      url='/api/commerce/pickup-board/commands'
    }
    let orderLocked!:()=>void,sessionLocked!:()=>void,requestSession!:()=>void,active=true,located=false
    const hasOrder=new Promise<void>(resolve=>{orderLocked=resolve}),hasSession=new Promise<void>(resolve=>{sessionLocked=resolve})
    const requestingSession=new Promise<void>(resolve=>{requestSession=resolve})
    const trace:string[]=[],databaseErrors:Array<{lane:string;code:unknown;message:unknown;detail:unknown}>=[]
    const wrapped=(lane:'cash'|'fulfillment')=>({run:<T>(s:StoreScope,operation:(tx:ScopedTransaction)=>Promise<T>,options?:TransactionOptions)=>runtime.run(s,async tx=>{
      if(active&&lane==='fulfillment')await hasOrder
      const hooked={...tx,query:async(sql:string,values?:readonly unknown[])=>{
        try{
          if(active&&lane==='cash'&&sql.includes('FOR UPDATE OF session'))requestSession()
          const result=await tx.query(sql,values)
          if(active&&lane==='cash'&&!located&&sql.includes('SELECT ordering.table_session_id')){located=true;trace.push('cash located order');orderLocked();await hasSession}
          if(active&&lane==='fulfillment'&&sql.includes('FROM mbox.table_sessions')&&sql.includes('FOR SHARE')){trace.push(`${currentPath} holds table session SHARE`);sessionLocked();await requestingSession}
          return result
        }catch(error){const detail=error as {code?:string;message?:string;detail?:string};databaseErrors.push({lane,code:detail.code,message:detail.message,detail:detail.detail});throw error}
      }} as ScopedTransaction
      return operation(hooked)
    },options)}) as ScopedPostgresTransactionRunner
    const cashService=new PaymentCommandService(new NormalizedCommandExecutor(wrapped('cash')),new NormalizedPaymentCapabilityAuthorization())
    const concurrentApp=Fastify(),context=()=>({scope,employeeId,staffSessionId,deviceAccessLeaseId:leaseId,businessDate})
    await concurrentApp.register(kitchenProductionApiPlugin,{enabled:true,prefix:'/api',staffAccessTransactions:runtime,commandExecutor:new NormalizedCommandExecutor(wrapped('fulfillment')),resolveContext:context,createKdsRepository:tx=>new KdsRepository(tx),createOrderRepository:tx=>new OrderRepository(tx)})
    await concurrentApp.register(pickupWorkflowApiPlugin,{enabled:true,prefix:'/api',staffAccessTransactions:runtime,commandExecutor:new NormalizedCommandExecutor(wrapped('fulfillment')),resolveContext:context})
    const cashKey=randomUUID(),fulfillmentKey=randomUUID()
    const cashInput:RecordManualPaymentCommand={scope,actor:{type:'employee',employeeId},businessDate,idempotencyKey:cashKey,requestFingerprint:cashKey,orderId:row.orderId,publicId:`cash-${cashKey}`,provider:'cash',method:'cash',evidence:{collectedByEmployeeId:employeeId,receiptReference:cashKey}}
    const submit=()=>concurrentApp.inject({method:'POST',url,headers:{'idempotency-key':fulfillmentKey},payload:currentPath==='kitchen-ready'?{employeeId,command:body}:body})
    try{
      const [cash,fulfillment]=await Promise.allSettled([cashService.recordManual(cashInput),submit()])
      active=false
      const http=fulfillment.status==='fulfilled'?{statusCode:fulfillment.value.statusCode,body:fulfillment.value.json()}:null
      expect(databaseErrors).toEqual([])
      expect(cash.status).toBe('fulfilled')
      expect(http?.statusCode,http?.body).toBe(200)
      expect(trace.slice(0,2)).toEqual(['cash located order',`${currentPath} holds table session SHARE`])
      const recoveredCash=await cashService.recordManual(cashInput)
      expect(recoveredCash.value.status).toBe('succeeded')
      const recoveredFulfillment=await submit()
      expect(recoveredFulfillment.statusCode,recoveredFulfillment.body).toBe(200)
      const replayCash=await cashService.recordManual(cashInput),replayFulfillment=await submit()
      expect(replayCash.replayed).toBe(true)
      expect(replayFulfillment.statusCode,replayFulfillment.body).toBe(200)
      if(currentPath==='pickup-take'){
        const receipt=recoveredFulfillment.json().data.receipt
        expect(receipt.deliverySource).toBe('pickup')
        expect(receipt.deliveryConfirmedAt).toBe(receipt.takenAt)
      }
      const payments=await pool.query("SELECT count(*)::int AS n,sum(amount_minor)::int AS amount FROM mbox.payments WHERE order_id=$1 AND status='succeeded'",[row.orderId])
      expect(payments.rows[0]).toEqual({n:1,amount:5000})
      const units=await pool.query('SELECT production_state,count(*)::int AS n FROM mbox.order_item_quantity_units WHERE order_item_id=$1 GROUP BY production_state',[row.itemId])
      expect(units.rows).toEqual([{production_state:currentPath==='kitchen-ready'?'ready':'delivered',n:5}])
      const entries=await pool.query("SELECT count(*)::int AS n FROM mbox.reconciliation_entries entry JOIN mbox.payments payment ON payment.id=entry.payment_id WHERE payment.order_id=$1 AND entry.entry_type='payment'",[row.orderId])
      expect(entries.rows[0]?.n).toBe(1)
    }finally{active=false;orderLocked();sessionLocked();requestSession();await concurrentApp.close()}
  },30000)
})
