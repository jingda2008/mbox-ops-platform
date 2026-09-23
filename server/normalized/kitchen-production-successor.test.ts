import {createHash,randomUUID} from 'node:crypto'
import Fastify from 'fastify'
import {Pool} from 'pg'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner,type TransactionOptions,type ScopedTransaction,type StoreScope} from './transaction-runner.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {KdsRepository} from './kds-repository.js'
import {OrderRepository} from './order-repository.js'
import {QuantityRemakeRepository} from './quantity-remake-repository.js'
import {QuantityRemakeFulfillmentRepository} from './quantity-remake-fulfillment-repository.js'
import {kitchenProductionApiPlugin} from './kitchen-production-api.js'
import {kitchenCompatibilityKey,type KitchenBoardData,type KitchenCommand,type KitchenHandoffPreview,type ProductionStation} from '../../src/shared/kitchen-production.js'

const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const integration=databaseUrl?describe:describe.skip
integration('production station and successor transaction boundary',()=>{
  const tenantId=randomUUID(),storeId=randomUUID(),employeeId=randomUUID(),areaId=randomUUID(),productId=randomUUID(),roleId=randomUUID()
  const credentialId=randomUUID(),leaseId=randomUUID(),staffSessionId=randomUUID(),scope={tenantId,storeId}
  let pool:Pool,runner:ScopedPostgresTransactionRunner,runtime:ScopedPostgresTransactionRunner,businessDate:string
  const app=Fastify()
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
    for(const code of ['kds.prepare','kds.exception.manage','kds.deliver','table.transfer','fulfillment.view_all']){
      const permission=(await pool.query("INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category) VALUES($1,$2,$3,$3,'operations') ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET name=EXCLUDED.name RETURNING id",[tenantId,storeId,code])).rows[0].id
      await pool.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) VALUES($1,$2,$3,$4)',[tenantId,storeId,roleId,permission])
    }
    await pool.query(`INSERT INTO mbox.role_data_scopes(tenant_id,store_id,role_id,scope_key,effect,scope_value,value_kind,text_values,enabled) VALUES($1,$2,$3,'kds.station_codes','include','["kitchen","bar"]','text_set',ARRAY['kitchen','bar'],true)`,[tenantId,storeId,roleId])
    await pool.query("INSERT INTO mbox.store_daily_credentials(id,tenant_id,store_id,business_date,credential_hash,valid_from,valid_until,configured_by_employee_id) VALUES($1,$2,$3,current_date,'scrypt$kitchen-test',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '8 hours',$4)",[credentialId,tenantId,storeId,employeeId])
    await pool.query("INSERT INTO mbox.store_device_access_leases(id,tenant_id,store_id,daily_credential_id,business_date,device_key_hash,lease_token_hash,issued_at,expires_at) VALUES($1,$2,$3,$4,current_date,repeat('a',64),repeat('b',64),clock_timestamp()-interval '1 hour',clock_timestamp()+interval '8 hours')",[leaseId,tenantId,storeId,credentialId])
    // Session expiry is constrained to exactly six hours after issuance; all fixture times must share one statement timestamp.
    await pool.query("INSERT INTO mbox.staff_sessions(id,tenant_id,store_id,employee_id,device_access_lease_id,session_token_hash,issued_at,expires_at,online_lease_until) VALUES($1,$2,$3,$4,$5,repeat('c',64),statement_timestamp(),statement_timestamp()+interval '6 hours',statement_timestamp()+interval '30 minutes')",[staffSessionId,tenantId,storeId,employeeId,leaseId])
    await pool.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station) VALUES($1,$2,$3,'K-FOOD','测试薯条','food','kitchen')",[productId,tenantId,storeId])
    await app.register(kitchenProductionApiPlugin,{enabled:true,barEnabled:true,prefix:'/api',staffAccessTransactions:runtime,commandExecutor:new NormalizedCommandExecutor(runtime),resolveContext:()=>({scope,employeeId,staffSessionId,deviceAccessLeaseId:leaseId,businessDate}),createKdsRepository:tx=>new KdsRepository(tx),createOrderRepository:tx=>new OrderRepository(tx)})
  },30000)
  afterAll(async()=>{await app.close();await pool?.end()})
  async function table(){const id=randomUUID();await pool.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,$5,$5,8)",[id,tenantId,storeId,areaId,`T${id.slice(0,8)}`]);return id}
  async function item(note='',stock=false,station:ProductionStation='kitchen'){
    const tableId=await table(),tableSessionId=randomUUID(),orderId=randomUUID(),itemId=randomUUID(),taskId=randomUUID()
    await pool.query('INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1,$2,$3,$4,$5,$6,2)',[tableSessionId,tenantId,storeId,tableId,`s-${tableSessionId}`,businessDate])
    await pool.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,submitted_at,subtotal_amount_minor,total_amount_minor) VALUES($1,$2,$3,$4,$5,'staff_assisted','submitted',clock_timestamp(),5000,5000)",[orderId,tenantId,storeId,tableSessionId,`k-${orderId}`])
    await pool.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot,note) VALUES($1,$2,$3,$4,$5,5,1000,5000,$8,$6::jsonb,$7)`,[itemId,tenantId,storeId,orderId,productId,JSON.stringify({name:'测试薯条',inventoryControlMode:stock?'tracked':'not_managed'}),note,station])
    await pool.query("INSERT INTO mbox.kds_tasks(id,tenant_id,store_id,order_item_id,station_code,quantity) VALUES($1,$2,$3,$4,$5,5)",[taskId,tenantId,storeId,itemId,station])
    const stockId=randomUUID()
    if(stock){await pool.query("INSERT INTO mbox.inventory_items(id,tenant_id,store_id,sku,name,item_type,base_unit) VALUES($1,$2,$3,$4,'薯条材料','food','piece')",[stockId,tenantId,storeId,`K-${stockId}`])
      await pool.query('INSERT INTO mbox.inventory_balances(tenant_id,store_id,inventory_item_id,on_hand_quantity,reserved_quantity) VALUES($1,$2,$3,10,5)',[tenantId,storeId,stockId])
      await pool.query("INSERT INTO mbox.inventory_order_reservations(tenant_id,store_id,order_id,order_item_id,inventory_item_id,quantity,expires_at) VALUES($1,$2,$3,$4,$5,5,clock_timestamp()+interval '1 hour')",[tenantId,storeId,orderId,itemId,stockId])}
    return {taskId,itemId,tableId,tableSessionId,orderId,stockId}
  }
  async function board(station:ProductionStation='kitchen',client=app){const response=await client.inject(`/api/commerce/kitchen-board?station=${station}`);expect(response.statusCode,response.body).toBe(200);return response.json().data as KitchenBoardData}
  async function start(rows:Array<{taskId:string}>,equipment:string|null=null,quantity=2,action:'start'|'quick-ready'='start',station:ProductionStation='kitchen'){
    const current=await board(station),selected=rows.map(row=>current.pending.find(item=>item.taskId===row.taskId)!)
    return {action,compatibilityKey:kitchenCompatibilityKey(selected[0]!),items:selected.map(row=>({taskId:row.taskId,quantity,expectedUnmade:row.unmade,tableId:row.tableId,tableSessionId:row.tableSessionId,locationVersion:row.locationVersion})),equipment,expectedSeconds:null} as KitchenCommand
  }
  function command(body:KitchenCommand,key=randomUUID(),stationCode:ProductionStation='kitchen',client=app,actor=employeeId){return client.inject({method:'POST',url:'/api/commerce/kitchen-board/commands',headers:{'idempotency-key':key},payload:{employeeId:actor,command:body,stationCode}})}
  async function ready(batchId:string,quantity=1,station:ProductionStation='kitchen',client=app){const batch=(await board(station,client)).batches.find(row=>row.id===batchId)!,first=batch.units.find(unit=>unit.state==='started')!
    return {action:'ready',batchId,expectedOwnershipVersion:batch.ownershipVersion,items:[{taskId:first.taskId,tableId:first.tableId,tableSessionId:first.tableSessionId,locationVersion:first.locationVersion,unitIds:batch.units.filter(unit=>unit.taskId===first.taskId&&unit.state==='started').slice(0,quantity).map(unit=>unit.unitId)}]} as const}
  async function expectOk(body:KitchenCommand,key?:string,station:ProductionStation='kitchen',client=app,actor=employeeId){const response=await command(body,key,station,client,actor);expect(response.statusCode,response.body).toBe(200);return response.json().data as {batchId:string;quantity:number;released:boolean}}
  async function successor(barEnabled=true){
    const id=randomUUID(),session=randomUUID(),client=Fastify()
    await pool.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,$4,'接班员工')",[id,tenantId,storeId,`cook-${id}`])
    await pool.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 hour')",[tenantId,storeId,id,roleId])
    await pool.query("INSERT INTO mbox.staff_sessions(id,tenant_id,store_id,employee_id,device_access_lease_id,session_token_hash,issued_at,expires_at,online_lease_until) VALUES($1,$2,$3,$4,$5,$6,statement_timestamp(),statement_timestamp()+interval '6 hours',statement_timestamp()+interval '30 minutes')",[session,tenantId,storeId,id,leaseId,createHash('sha256').update(session).digest('hex')])
    await client.register(kitchenProductionApiPlugin,{enabled:true,barEnabled,prefix:'/api',staffAccessTransactions:runtime,commandExecutor:new NormalizedCommandExecutor(runtime),resolveContext:()=>({scope,employeeId:id,staffSessionId:session,deviceAccessLeaseId:leaseId,businessDate}),createKdsRepository:tx=>new KdsRepository(tx),createOrderRepository:tx=>new OrderRepository(tx)})
    return {id,session,client}
  }
  async function handoff(batchId:string,client=app,station:ProductionStation='kitchen'):Promise<Extract<KitchenCommand,{action:'handoff'}>>{
    const response=await client.inject(`/api/commerce/kitchen-board/handoff-preview?batchId=${batchId}&station=${station}`)
    expect(response.statusCode,response.body).toBe(200)
    const preview=response.json().data as KitchenHandoffPreview
    return {action:'handoff',batchId,expectedBatches:preview.batches,expectedTasks:preview.tasks,physicalChecked:true,reason:'现场核对全部关联出品与设备后接班'}
  }
  it('SYS314 hands over connected split batches from a departed cook without consuming inventory again and permanently replays the receipt',async()=>{
    const row=await item('',true),a=await expectOk(await start([row],'接班设备一',2)),b=await expectOk(await start([row],'接班设备二',2)),next=await successor()
    const old=await ready(a.batchId,2),body=await handoff(a.batchId,next.client),key=randomUUID()
    expect(body.expectedBatches.map(batch=>batch.batchId).sort()).toEqual([a.batchId,b.batchId].sort())
    await pool.query("UPDATE mbox.employees SET status='departed' WHERE id=$1",[employeeId])
    try{
      expect((await command(old,randomUUID(),'kitchen',next.client,next.id)).statusCode).toBe(409)
      const receipt=await expectOk(body,key,'kitchen',next.client,next.id)
      const after=await board('kitchen',next.client)
      for(const id of [a.batchId,b.batchId])expect(after.batches.find(batch=>batch.id===id)).toMatchObject({employeeId:next.id,createdByEmployeeId:employeeId,ownershipVersion:1})
      expect((await pool.query('SELECT assigned_employee_id FROM mbox.kds_tasks WHERE id=$1',[row.taskId])).rows[0].assigned_employee_id).toBe(next.id)
      expect((await pool.query('SELECT on_hand_quantity::text AS quantity FROM mbox.inventory_balances WHERE inventory_item_id=$1',[row.stockId])).rows[0].quantity).toBe('6.000000')
      await expectOk(await ready(a.batchId,2,'kitchen',next.client),undefined,'kitchen',next.client,next.id)
      await expectOk({action:'release',batchId:b.batchId,expectedOwnershipVersion:1},undefined,'kitchen',next.client,next.id)
      await pool.query("DELETE FROM mbox.idempotency_records WHERE tenant_id=$1 AND store_id=$2 AND operation_scope='commerce.kitchen.batch'",[tenantId,storeId])
      expect(await expectOk(body,key,'kitchen',next.client,next.id)).toEqual(receipt)
      expect((await command({...body,reason:'另一接班原因'},key,'kitchen',next.client,next.id)).statusCode).toBe(409)
      expect((await command(old)).statusCode).toBe(403)
    }finally{await next.client.close();await pool.query("UPDATE mbox.employees SET status='active' WHERE id=$1",[employeeId])}
  })
  it('rejects an incomplete or changed connected scope and serializes competing successors',async()=>{
    const row=await item(),a=await expectOk(await start([row],null,1)),next=await successor(),other=await successor()
    try{
      const stale=await handoff(a.batchId,next.client)
      await expectOk(await start([row],null,1))
      expect((await command(stale,randomUUID(),'kitchen',next.client,next.id)).json().error.code).toBe('KITCHEN_HANDOFF_CHANGED')
      const body=await handoff(a.batchId,next.client)
      expect((await command({...body,expectedBatches:body.expectedBatches.slice(0,1)},randomUUID(),'kitchen',next.client,next.id)).statusCode).toBe(409)
      const responses=await Promise.all([command(body,randomUUID(),'kitchen',next.client,next.id),command(body,randomUUID(),'kitchen',other.client,other.id)])
      expect(responses.map(response=>response.statusCode).sort()).toEqual([200,409])
      expect((await pool.query('SELECT count(*)::int AS n FROM mbox.kitchen_production_handoffs WHERE batch_id=$1',[a.batchId])).rows[0].n).toBe(1)
    }finally{await next.client.close();await other.client.close()}
  })
  it('rejects original ready and release requests after A to B to A ownership, while fresh version continues',async()=>{
    const row=await item(),a=await expectOk(await start([row],'往返交接',2)),old=await ready(a.batchId,1),next=await successor()
    try{
      await expectOk(await handoff(a.batchId,next.client),undefined,'kitchen',next.client,next.id)
      await expectOk(await handoff(a.batchId))
      expect((await command(old)).json().error.code).toBe('KITCHEN_OWNER_CHANGED')
      expect((await command({action:'release',batchId:a.batchId})).json().error.code).toBe('KITCHEN_OWNER_CHANGED')
      expect((await board()).batches.find(batch=>batch.id===a.batchId)?.ownershipVersion).toBe(2)
      await expectOk(await ready(a.batchId,2))
    }finally{await next.client.close()}
  })
  it('rechecks handoff exception permission and session before replay and preserves immutable original evidence',async()=>{
    const row=await item(),a=await expectOk(await start([row])),next=await successor(),body=await handoff(a.batchId,next.client),key=randomUUID()
    try{
      await expectOk(body,key,'kitchen',next.client,next.id)
      const permission=(await pool.query("SELECT id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code='kds.exception.manage'",[tenantId,storeId])).rows[0].id
      const override=randomUUID()
      await pool.query("INSERT INTO mbox.employee_permission_overrides(id,tenant_id,store_id,employee_id,permission_id,effect,reason,configured_by_employee_id) VALUES($1,$2,$3,$4,$5,'deny','接班权限撤回测试',$6)",[override,tenantId,storeId,next.id,permission,employeeId])
      expect((await board('kitchen',next.client)).canHandoff).toBe(false)
      expect((await command(body,key,'kitchen',next.client,next.id)).statusCode).toBe(403)
      expect((await next.client.inject(`/api/commerce/kitchen-board/handoff-preview?batchId=${a.batchId}`)).statusCode).toBe(403)
      await pool.query('DELETE FROM mbox.employee_permission_overrides WHERE id=$1',[override])
      await pool.query("UPDATE mbox.staff_sessions SET revoked_at=clock_timestamp() WHERE id=$1",[next.session])
      expect((await command(body,key,'kitchen',next.client,next.id)).statusCode).toBe(403)
      await expect(runtime.run(scope,tx=>tx.query('DELETE FROM mbox.kitchen_production_handoffs WHERE batch_id=$1',[a.batchId]))).rejects.toMatchObject({code:'42501'})
      expect(await runtime.run({...scope,storeId:randomUUID()},async tx=>(await tx.query('SELECT id FROM mbox.kitchen_production_handoffs')).rowCount,{readOnly:true})).toBe(0)
    }finally{await next.client.close()}
  })
  it('bar has station-scoped equipment and admission while existing bar batches recover under pause',async()=>{
    const food=await item(),drink=await item('',false,'bar'),key=randomUUID()
    const kitchen=await expectOk(await start([food],'共同编号',2),key)
    const barBody=await start([drink],'共同编号',2,'start','bar'),bar=await expectOk(barBody,key,'bar')
    expect(bar.batchId).not.toBe(kitchen.batchId)
    expect((await board('bar')).batches.every(batch=>batch.stationCode==='bar')).toBe(true)
    expect((await board()).batches.some(batch=>batch.id===bar.batchId)).toBe(false)
    const paused=Fastify();await paused.register(kitchenProductionApiPlugin,{enabled:true,barEnabled:false,prefix:'/api',staffAccessTransactions:runtime,commandExecutor:new NormalizedCommandExecutor(runtime),resolveContext:()=>({scope,employeeId,staffSessionId,deviceAccessLeaseId:leaseId,businessDate}),createKdsRepository:tx=>new KdsRepository(tx),createOrderRepository:tx=>new OrderRepository(tx)})
    try{
      expect((await board('bar',paused)).canStart).toBe(false)
      const pending=await start([drink],null,1,'start','bar')
      expect((await command(pending,randomUUID(),'bar',paused)).json().error.code).toBe('KITCHEN_ADMISSION_PAUSED')
      await expectOk(await ready(bar.batchId,2,'bar'),undefined,'bar',paused)
      await pool.query("DELETE FROM mbox.idempotency_records WHERE tenant_id=$1 AND store_id=$2 AND operation_scope='commerce.kitchen.batch'",[tenantId,storeId])
      expect(await expectOk(barBody,key,'bar',paused)).toEqual(bar)
      // A permitted kitchen key containing a bar-looking prefix must not collide
      // with the internally namespaced bar receipt.
      await expectOk(await start([food],null,1),`bar:${key}`)
      expect(await expectOk(await start([food],null,1),undefined)).toBeDefined()
    }finally{await paused.close()}
  })
  it('enforces station authorization for reads, new starts and recovery',async()=>{
    const row=await item('',false,'bar'),body=await start([row],null,1,'start','bar'),key=randomUUID()
    await expectOk(body,key,'bar')
    await pool.query(`UPDATE mbox.role_data_scopes SET scope_value='["kitchen"]',text_values=ARRAY['kitchen'] WHERE tenant_id=$1 AND store_id=$2 AND role_id=$3 AND scope_key='kds.station_codes'`,[tenantId,storeId,roleId])
    try{
      expect((await app.inject('/api/commerce/kitchen-board?station=bar')).statusCode).toBe(403)
      expect((await command(body,key,'bar')).statusCode).toBe(403)
      expect((await command(body,randomUUID(),'bar')).statusCode).toBe(403)
    }finally{await pool.query(`UPDATE mbox.role_data_scopes SET scope_value='["kitchen","bar"]',text_values=ARRAY['kitchen','bar'] WHERE tenant_id=$1 AND store_id=$2 AND role_id=$3 AND scope_key='kds.station_codes'`,[tenantId,storeId,roleId])}
  })
  it('database rejects skipped handoff versions and foreign scope arrays before any ownership fact is committed',async()=>{
    const row=await item(),a=await expectOk(await start([row])),next=await successor()
    try{
      const insert=(version:number,ids:string[])=>runtime.run(scope,tx=>tx.query(`INSERT INTO mbox.kitchen_production_handoffs
        (tenant_id,store_id,batch_id,ownership_version,from_employee_id,to_employee_id,actor_employee_id,operation_key,reason,physical_checked,affected_task_ids,affected_batch_ids)
        VALUES($1,$2,$3,$4,$5,$6,$6,$7,'真实隔离数据库版本约束测试',true,$8::uuid[],$9::uuid[])`,[tenantId,storeId,a.batchId,version,employeeId,next.id,randomUUID(),ids,[a.batchId]]))
      await expect(insert(2,[row.taskId])).rejects.toMatchObject({code:'23514'})
      await expect(insert(1,[randomUUID()])).rejects.toMatchObject({code:'23514'})
      expect((await board()).batches.find(batch=>batch.id===a.batchId)?.ownershipVersion).toBe(0)
      expect((await pool.query('SELECT assigned_employee_id FROM mbox.kds_tasks WHERE id=$1',[row.taskId])).rows[0].assigned_employee_id).toBe(employeeId)
    }finally{await next.client.close()}
  })
  it('SYS315 removes all remade originals, retains only valid remaining portions, and never silently clears occupied equipment',async()=>{
    const partial=await item(),a=await expectOk(await start([partial],null,5))
    const first=await runtime.run(scope,tx=>new QuantityRemakeRepository(tx).create({itemId:partial.itemId,employeeId,quantity:2,originalGoodsLost:true,reason:'两份出品制作失败重新制作',eventKey:randomUUID()}))
    let current=(await board()).batches.find(batch=>batch.id===a.batchId)!
    expect(current.units.filter(unit=>unit.state==='started'&&!unit.stopped)).toHaveLength(3)
    expect(current.units.filter(unit=>unit.stopped)).toHaveLength(2)
    await runtime.run(scope,tx=>new QuantityRemakeFulfillmentRepository(tx).act({taskId:first.taskId,employeeId,action:'start',quantity:2,eventKey:randomUUID()}))
    await runtime.run(scope,tx=>new QuantityRemakeRepository(tx).create({itemId:partial.itemId,employeeId,quantity:2,previousBatchId:first.id,originalGoodsLost:true,reason:'第二批实物失败接续第三批',eventKey:randomUUID()}))
    current=(await board()).batches.find(batch=>batch.id===a.batchId)!
    expect(current.units).toHaveLength(5);expect(current.units.filter(unit=>!unit.stopped)).toHaveLength(3)
    const valid=current.units.filter(unit=>!unit.stopped),unit=valid[0]!
    await expectOk({action:'ready',batchId:a.batchId,expectedOwnershipVersion:0,items:[{taskId:unit.taskId,tableId:unit.tableId,tableSessionId:unit.tableSessionId,locationVersion:unit.locationVersion,unitIds:valid.map(part=>part.unitId)}]})
    expect((await board()).batches.some(batch=>batch.id===a.batchId)).toBe(false)
    const all=await item(),occupied=await expectOk(await start([all],'原失败设备',5))
    await runtime.run(scope,tx=>new QuantityRemakeRepository(tx).create({itemId:all.itemId,employeeId,quantity:5,originalGoodsLost:true,reason:'本锅失败全部重新制作',eventKey:randomUUID()}))
    expect((await board()).batches.find(batch=>batch.id===occupied.batchId)).toMatchObject({releasedAt:null})
    expect((await command(await start([await item()],'原失败设备',1))).json().error.code).toBe('KITCHEN_EQUIPMENT_BUSY')
    await expectOk({action:'release',batchId:occupied.batchId,expectedOwnershipVersion:0})
    expect((await board()).batches.some(batch=>batch.id===occupied.batchId)).toBe(false)
    expect((await pool.query('SELECT count(*)::int AS n FROM mbox.kitchen_production_units WHERE batch_id=$1',[occupied.batchId])).rows[0].n).toBe(5)
  })
})
