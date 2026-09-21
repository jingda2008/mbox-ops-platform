import {randomUUID} from 'node:crypto'
import Fastify from 'fastify'
import {Pool} from 'pg'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner,type TransactionOptions,type ScopedTransaction,type StoreScope} from './transaction-runner.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {ItemQuantityFulfillmentRepository} from './item-quantity-fulfillment-repository.js'
import {QuantityRemakeRepository} from './quantity-remake-repository.js'
import {QuantityRemakeFulfillmentRepository} from './quantity-remake-fulfillment-repository.js'
import {pickupWorkflowApiPlugin} from './pickup-workflow-api.js'
import {OperationsQueryService} from './operations-query-service.js'
import {normalizedOperationsApiPlugin} from './normalized-operations-api.js'
import {StaffAccessRepository} from './staff-access-repository.js'
import type {OperatingHistory} from '../../src/shared/operating-history.js'
import type {PickupBoardData,PickupCommand,PickupCommandResult} from '../../src/shared/pickup-workflow.js'

const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const integration=databaseUrl?describe:describe.skip
integration('shared pickup delivery history respects work visibility without personal attribution',()=>{
  const tenantId=randomUUID(),storeId=randomUUID(),employeeId=randomUUID(),areaId=randomUUID(),productId=randomUUID(),roleId=randomUUID()
  const credentialId=randomUUID(),leaseId=randomUUID(),staffSessionId=randomUUID(),scope={tenantId,storeId}
  const currentEmployeeId=employeeId,currentSessionId=staffSessionId
  const reader=randomUUID(),backup=randomUUID(),unassigned=randomUUID(),allHistory=randomUUID(),manager=randomUUID(),denied=randomUUID()
  const roles=new Map<string,string>()
  let pool:Pool,runner:ScopedPostgresTransactionRunner,runtime:ScopedPostgresTransactionRunner,businessDate:string
  let historyActor=reader,historyScope:StoreScope=scope
  const app=Fastify({logger:{level:'error'}})
  beforeAll(async()=>{
    await runNormalizedMigrations(databaseUrl!);pool=new Pool({connectionString:databaseUrl,max:8});runner=new ScopedPostgresTransactionRunner(pool)
    runtime={run:<T>(s:StoreScope,operation:(tx:ScopedTransaction)=>Promise<T>,options?:TransactionOptions)=>runner.run(s,async tx=>{await tx.query('SET LOCAL ROLE mbox_runtime');return operation(tx)},options)} as ScopedPostgresTransactionRunner
    await pool.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Kitchen isolation')",[tenantId,`k-${tenantId}`])
    await pool.query("INSERT INTO mbox.stores(id,tenant_id,code,name,timezone,business_day_cutoff) VALUES($1,$2,'kitchen-store','Kitchen','Asia/Shanghai','06:00')",[storeId,tenantId])
    businessDate=await runner.run(scope,async tx=>(await tx.query<{date:string}>('SELECT mbox.current_operating_business_date($1,$2)::text AS date',[tenantId,storeId])).rows[0]!.date)
    await pool.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'K','K','indoor')",[areaId,tenantId,storeId])
    await pool.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,'cook','测试厨师')",[employeeId,tenantId,storeId])
    await pool.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'KITCHEN_TEST','Kitchen')",[roleId,tenantId,storeId])
    await pool.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 hour')",[tenantId,storeId,employeeId,roleId])
    for(const code of ['kds.prepare','kds.deliver','table.transfer','fulfillment.view_all','staff.access.configure','kds.exception.manage','order.history.view']){
      const permission=(await pool.query("INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category) VALUES($1,$2,$3,$3,'operations') ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET name=EXCLUDED.name RETURNING id",[tenantId,storeId,code])).rows[0].id
      await pool.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) VALUES($1,$2,$3,$4)',[tenantId,storeId,roleId,permission])
    }
    await pool.query(`INSERT INTO mbox.role_data_scopes(tenant_id,store_id,role_id,scope_key,effect,scope_value,value_kind,text_values,enabled) VALUES($1,$2,$3,'kds.station_codes','include','["kitchen"]','text_set',ARRAY['kitchen'],true)`,[tenantId,storeId,roleId])
    await pool.query("INSERT INTO mbox.store_daily_credentials(id,tenant_id,store_id,business_date,credential_hash,valid_from,valid_until,configured_by_employee_id) VALUES($1,$2,$3,current_date,'scrypt$kitchen-test',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '8 hours',$4)",[credentialId,tenantId,storeId,employeeId])
    await pool.query("INSERT INTO mbox.store_device_access_leases(id,tenant_id,store_id,daily_credential_id,business_date,device_key_hash,lease_token_hash,issued_at,expires_at) VALUES($1,$2,$3,$4,current_date,repeat('a',64),repeat('b',64),clock_timestamp()-interval '1 hour',clock_timestamp()+interval '8 hours')",[leaseId,tenantId,storeId,credentialId])
    // Session expiry is constrained to exactly six hours after issuance; all fixture times must share one statement timestamp.
    await pool.query("INSERT INTO mbox.staff_sessions(id,tenant_id,store_id,employee_id,device_access_lease_id,session_token_hash,issued_at,expires_at,online_lease_until) VALUES($1,$2,$3,$4,$5,repeat('c',64),statement_timestamp(),statement_timestamp()+interval '6 hours',statement_timestamp()+interval '30 minutes')",[staffSessionId,tenantId,storeId,employeeId,leaseId])
    await pool.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station) VALUES($1,$2,$3,'K-FOOD','测试薯条','food','kitchen')",[productId,tenantId,storeId])
    await app.register(pickupWorkflowApiPlugin,{enabled:true,prefix:'/api',staffAccessTransactions:runtime,commandExecutor:new NormalizedCommandExecutor(runtime),resolveContext:()=>({scope,employeeId:currentEmployeeId,staffSessionId:currentSessionId,deviceAccessLeaseId:leaseId,businessDate})})
    for(const [id,permissions] of [[reader,['order.history.view']],[backup,['order.history.view']],[unassigned,['order.history.view']],
      [allHistory,['order.history.all']],[manager,['order.history.view','table.view_all']],[denied,['table.view_all']]] as const)await actor(id,permissions)
    await app.register(normalizedOperationsApiPlugin,{operationsQuery:new OperationsQueryService(runtime),commandExecutor:new NormalizedCommandExecutor(runtime),
      tableSessions:{open:async()=>{throw new Error('History-only test')}},createTableSessionRepository:()=>{throw new Error('History-only test')},createServiceTaskRepository:()=>{throw new Error('History-only test')},
      resolveContext:async()=>({scope:historyScope,employeeId:historyActor,businessDate,capabilities:await runtime.run(historyScope,async tx=>(await new StaffAccessRepository(tx).resolve(historyActor)).permissions)})})
    const response=await configure();expect(response.statusCode,response.body).toBe(200)
  },30000)
  afterAll(async()=>{await app.close();await pool?.end()})
  async function actor(id:string,permissions:readonly string[],at:StoreScope=scope){
    const role=randomUUID();roles.set(id,role)
    await pool.query('INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,$4,$4)',[id,at.tenantId,at.storeId,`worker-${id.slice(0,8)}`])
    await pool.query('INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,$4,$4)',[role,at.tenantId,at.storeId,`HISTORY_${role.slice(0,8).toUpperCase()}`])
    await pool.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 hour')",[at.tenantId,at.storeId,id,role])
    for(const code of permissions){
      const permission=(await pool.query("INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category) VALUES($1,$2,$3,$3,'operations') ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET name=EXCLUDED.name RETURNING id",[at.tenantId,at.storeId,code])).rows[0].id
      await pool.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) VALUES($1,$2,$3,$4)',[at.tenantId,at.storeId,role,permission])
    }
  }
  async function assign(tableId:string,id=reader,type='primary'){
    return (await pool.query("INSERT INTO mbox.table_assignments(tenant_id,store_id,table_id,employee_id,role_id,assignment_type,starts_at,reason) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()-interval '1 hour','送达历史权限测试') RETURNING id",[tenantId,storeId,tableId,id,roles.get(id),type])).rows[0].id as string
  }
  async function history(id=reader,query='',at:StoreScope=scope){
    historyActor=id;historyScope=at
    const response=await app.inject(`/operations/history?workKind=delivered${query}`)
    expect(response.statusCode,response.body).toBe(200);return response.json().data as OperatingHistory
  }
  async function table(){const id=randomUUID();await pool.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,$5,$5,8)",[id,tenantId,storeId,areaId,`T${id.slice(0,8)}`]);return id}
  async function item(note='',stock=false,at?:{tableId:string;tableSessionId:string}){
    const tableId=at?.tableId??await table(),tableSessionId=at?.tableSessionId??randomUUID(),orderId=randomUUID(),itemId=randomUUID(),taskId=randomUUID()
    if(!at)await pool.query('INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1,$2,$3,$4,$5,$6,2)',[tableSessionId,tenantId,storeId,tableId,`s-${tableSessionId}`,businessDate])
    await pool.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,submitted_at,subtotal_amount_minor,total_amount_minor) VALUES($1,$2,$3,$4,$5,'staff_assisted','submitted',clock_timestamp(),5000,5000)",[orderId,tenantId,storeId,tableSessionId,`k-${orderId}`])
    await pool.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot,note) VALUES($1,$2,$3,$4,$5,5,1000,5000,'kitchen',$6::jsonb,$7)`,[itemId,tenantId,storeId,orderId,productId,JSON.stringify({name:'测试薯条',inventoryControlMode:stock?'tracked':'not_managed'}),note])
    await pool.query("INSERT INTO mbox.kds_tasks(id,tenant_id,store_id,order_item_id,station_code,quantity) VALUES($1,$2,$3,$4,'kitchen',5)",[taskId,tenantId,storeId,itemId])
    const stockId=randomUUID()
    if(stock){await pool.query("INSERT INTO mbox.inventory_items(id,tenant_id,store_id,sku,name,item_type,base_unit) VALUES($1,$2,$3,$4,'薯条材料','food','piece')",[stockId,tenantId,storeId,`K-${stockId}`])
      await pool.query('INSERT INTO mbox.inventory_balances(tenant_id,store_id,inventory_item_id,on_hand_quantity,reserved_quantity) VALUES($1,$2,$3,10,5)',[tenantId,storeId,stockId])
      await pool.query("INSERT INTO mbox.inventory_order_reservations(tenant_id,store_id,order_id,order_item_id,inventory_item_id,quantity,expires_at) VALUES($1,$2,$3,$4,$5,5,clock_timestamp()+interval '1 hour')",[tenantId,storeId,orderId,itemId,stockId])}
    return {taskId,itemId,tableId,tableSessionId,orderId,stockId}
  }
  async function board(){const response=await app.inject('/api/commerce/pickup-board');expect(response.statusCode,response.body).toBe(200);return response.json().data as PickupBoardData}
  const configure=(enabled=true,key=randomUUID())=>app.inject({method:'POST',url:'/api/commerce/pickup-board/device',headers:{'idempotency-key':key},payload:{enabled,label:'吧台共用平板'}})
  const command=(body:PickupCommand,key=randomUUID())=>app.inject({method:'POST',url:'/api/commerce/pickup-board/commands',headers:{'idempotency-key':key},payload:body})
  async function take(row:{tableSessionId:string},count?:number){const group=(await board()).tables.find(table=>table.tableSessionId===row.tableSessionId)!;expect(group).toBeDefined()
    return {action:'take',tableId:group.tableId,tableSessionId:group.tableSessionId,locationVersion:group.locationVersion,units:group.units.slice(0,count).map(unit=>({kind:unit.kind,unitId:unit.unitId,version:unit.version}))} as const}
  async function ok(body:PickupCommand,key?:string){const response=await command(body,key);expect(response.statusCode,response.body).toBe(200);return response.json().data as PickupCommandResult}
  const undo=(result:PickupCommandResult)=>({action:'undo',receiptId:result.receipt.receiptId,expectedRevision:result.receipt.revision,physicalStillAtPickupPoint:true} as const)
  async function ready(row:{itemId:string;taskId:string},quantity=5){return runtime.run(scope,tx=>new ItemQuantityFulfillmentRepository(tx).complete({...row,employeeId,quantity,eventKey:randomUUID()}))}


  it('includes only assigned shared deliveries with original time and no employee attribution, and removes an undone receipt',async()=>{
    const row=await item('无盐');await assign(row.tableId);await assign(row.tableId,backup,'backup');await ready(row,2)
    const taken=await ok(await take(row,1)),result=await history(),shared=result.sharedDeliveries!.find(entry=>entry.receiptId===taken.receipt.receiptId)!
    expect(result.orders).toEqual([]);expect(shared).toMatchObject({source:'shared_pickup_device',deliveredAt:taken.receipt.takenAt,items:[{itemId:row.itemId,quantity:1,itemNote:'无盐'}]})
    expect(JSON.stringify(shared)).not.toContain(employeeId);expect(JSON.stringify(shared)).not.toContain('测试厨师')
    expect(shared).not.toHaveProperty('workQuantity');expect(shared).not.toHaveProperty('deliveredBy')
    expect((await history(backup)).sharedDeliveries!.some(entry=>entry.receiptId===shared.receiptId)).toBe(true)
    expect((await history(unassigned)).sharedDeliveries).toEqual([])
    expect((await history(allHistory)).sharedDeliveries).toEqual([])
    expect((await history(employeeId)).orders).toEqual([])
    expect((await history(manager)).sharedDeliveries!.some(entry=>entry.receiptId===shared.receiptId)).toBe(true)
    await ok(undo(taken));expect((await history()).sharedDeliveries!.some(entry=>entry.receiptId===shared.receiptId)).toBe(false)
    const again=await ok(await take(row,1));const after=await history()
    expect(after.sharedDeliveries!.filter(entry=>entry.tableSessionId===row.tableSessionId).map(entry=>entry.receiptId)).toEqual([again.receipt.receiptId])
    expect(after.orders).toEqual([])
  })
  it('rechecks current assignments and history permissions, and rejects caller attempts to widen scope',async()=>{
    const row=await item();const assignment=await assign(row.tableId);await ready(row,1);const taken=await ok(await take(row))
    expect((await history()).sharedDeliveries!.some(entry=>entry.receiptId===taken.receipt.receiptId)).toBe(true)
    await pool.query("UPDATE mbox.table_assignments SET ends_at=clock_timestamp()-interval '1 second' WHERE id=$1",[assignment])
    const hidden=await history(reader,'&workEmployeeId=&sharedDeliveryScope[canViewAllTables]=true')
    expect(hidden.sharedDeliveries!.some(entry=>entry.receiptId===taken.receipt.receiptId)).toBe(false)
    const service=new OperationsQueryService(runtime)
    const attempted=await service.getOperatingHistory(scope,reader,{businessDate,table:'',employee:'',page:0,workKind:'delivered',workEmployeeId:employeeId,sharedDeliveryScope:{employeeId:manager,canViewAllTables:true}})
    expect(attempted.sharedDeliveries!.some(entry=>entry.receiptId===taken.receipt.receiptId)).toBe(false)
    historyActor=denied;historyScope=scope;expect((await app.inject('/operations/history?workKind=delivered')).statusCode).toBe(403)
    await expect(service.getOperatingHistory(scope,denied,{businessDate,table:'',employee:'',page:0,workKind:'delivered'})).rejects.toThrow('查询权限')
  })
  it('cannot expose a known shared receipt through another store even to an all-table history reader',async()=>{
    const row=await item();await ready(row,1);const taken=await ok(await take(row));expect((await history(manager)).sharedDeliveries!.some(entry=>entry.receiptId===taken.receipt.receiptId)).toBe(true)
    const foreignScope={tenantId,storeId:randomUUID()},foreignReader=randomUUID()
    await pool.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,$3,'Foreign history')",[foreignScope.storeId,tenantId,`foreign-${foreignScope.storeId}`])
    await actor(foreignReader,['order.history.all','table.view_all'],foreignScope)
    const foreign=await history(foreignReader,`&table=${taken.receipt.tableCode}`,foreignScope)
    expect(foreign.orders).toEqual([]);expect(foreign.sharedDeliveries).toEqual([])
  })
  it('retains personal legacy quantities separately and includes remake pickup without multiplying employee work',async()=>{
    const legacy=await item(),shared=await item();await assign(shared.tableId)
    for(const [actorId,quantity] of [[reader,2],[employeeId,3]] as const)await pool.query(`INSERT INTO mbox.audit_events(tenant_id,store_id,actor_type,actor_employee_id,action,object_type,object_id,business_date,after_snapshot)
      VALUES($1,$2,'employee',$3,'kds.deliver','kds_task',$4,$5,jsonb_build_object('affectedQuantity',$6::integer))`,[tenantId,storeId,actorId,legacy.taskId,businessDate,quantity])
    await ready(shared,1)
    const remake=await runtime.run(scope,tx=>new QuantityRemakeRepository(tx).create({itemId:shared.itemId,employeeId,quantity:1,originalGoodsLost:true,reason:'损坏实物重新制作',eventKey:randomUUID()}))
    await runtime.run(scope,tx=>new QuantityRemakeFulfillmentRepository(tx).act({taskId:remake.taskId,employeeId,action:'complete',quantity:1,eventKey:randomUUID()}))
    const taken=await ok(await take(shared)),result=await history()
    expect(result.orders.find(order=>order.id===legacy.orderId)?.items[0]).toMatchObject({workQuantity:2,deliveredBy:`worker-${reader.slice(0,8)}`})
    expect(result.orders.some(order=>order.id===shared.orderId)).toBe(false)
    expect(result.sharedDeliveries!.find(entry=>entry.receiptId===taken.receipt.receiptId)?.items).toMatchObject([{itemId:shared.itemId,kind:'remake',quantity:1}])
    await ok(undo(taken));expect((await history()).sharedDeliveries!.some(entry=>entry.receiptId===taken.receipt.receiptId)).toBe(false)
  })
})
