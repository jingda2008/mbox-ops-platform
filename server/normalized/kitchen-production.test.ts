import {createHash,randomUUID} from 'node:crypto'
import Fastify from 'fastify'
import {Pool} from 'pg'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner,type TransactionOptions,type ScopedTransaction,type StoreScope} from './transaction-runner.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {KdsRepository} from './kds-repository.js'
import {OrderRepository} from './order-repository.js'
import {ItemQuantityRepository} from './item-quantity-repository.js'
import {ItemQuantityFulfillmentRepository} from './item-quantity-fulfillment-repository.js'
import {FulfillmentQueryService} from './fulfillment-query-service.js'
import {readKitchenSources} from './kitchen-production-query.js'
import {kitchenProductionApiPlugin} from './kitchen-production-api.js'
import {kitchenCompatibilityKey,type KitchenBoardData,type KitchenCommand} from '../../src/shared/kitchen-production.js'

const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const integration=databaseUrl?describe:describe.skip
integration('kitchen production real transaction boundary',()=>{
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
    for(const code of ['kds.prepare','kds.deliver','table.transfer','fulfillment.view_all']){
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
  },30000)
  afterAll(async()=>{await app.close();await pool?.end()})
  async function table(){const id=randomUUID();await pool.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,$5,$5,8)",[id,tenantId,storeId,areaId,`T${id.slice(0,8)}`]);return id}
  async function item(note='',stock=false){
    const tableId=await table(),tableSessionId=randomUUID(),orderId=randomUUID(),itemId=randomUUID(),taskId=randomUUID()
    await pool.query('INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1,$2,$3,$4,$5,$6,2)',[tableSessionId,tenantId,storeId,tableId,`s-${tableSessionId}`,businessDate])
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
  async function ready(batchId:string,quantity=1){const batch=(await board()).batches.find(row=>row.id===batchId)!,first=batch.units.find(unit=>unit.state==='started')!
    return {action:'ready',batchId,items:[{taskId:first.taskId,tableId:first.tableId,tableSessionId:first.tableSessionId,locationVersion:first.locationVersion,unitIds:batch.units.filter(unit=>unit.taskId===first.taskId&&unit.state==='started').slice(0,quantity).map(unit=>unit.unitId)}]} as const}
  async function expectOk(body:KitchenCommand,key?:string){const response=await command(body,key);expect(response.statusCode,response.body).toBe(200);return response.json().data as {batchId:string;quantity:number;released:boolean}}
  it('freezes cross-table originals, consumes exact inventory once, releases equipment independently and creates delivery notices without delivery',async()=>{
    const first=await item('',true),second=await item(),key=randomUUID(),body=await start([first,second],'炸篮 A')
    const created=await expectOk(body,key);expect(created.quantity).toBe(4)
    expect(await expectOk(body,key)).toEqual(created)
    const units=(await board()).batches.find(batch=>batch.id===created.batchId)!.units.map(unit=>unit.unitId)
    await item();expect((await board()).batches.find(batch=>batch.id===created.batchId)!.units.map(unit=>unit.unitId)).toEqual(units)
    expect((await pool.query('SELECT on_hand_quantity::text AS remaining FROM mbox.inventory_balances WHERE inventory_item_id=$1',[first.stockId])).rows[0].remaining).toBe('8.000000')
    expect((await command(await start([await item()],' 炸篮A '))).statusCode).toBe(409)
    await expectOk({action:'release',batchId:created.batchId})
    expect((await board()).batches.find(batch=>batch.id===created.batchId)!.units.filter(unit=>unit.state==='started')).toHaveLength(4)
    const selection=await ready(created.batchId),completeKey=randomUUID()
    await expectOk(selection,completeKey);await expectOk(selection,completeKey)
    const after=(await board()).batches.find(batch=>batch.id===created.batchId)!
    expect(after.units.filter(unit=>unit.state==='ready')).toHaveLength(1);expect(after.units.some(unit=>unit.state==='delivered')).toBe(false)
    expect((await pool.query("SELECT count(*)::int AS n FROM mbox.outbox_messages WHERE tenant_id=$1 AND store_id=$2 AND message_type='delivery.batch.ready.v1'",[tenantId,storeId])).rows[0].n).toBe(1)
    // Delete only the disposable generic cache; the immutable kitchen receipt still recovers the original intent.
    await pool.query("DELETE FROM mbox.idempotency_records WHERE tenant_id=$1 AND store_id=$2 AND operation_scope='commerce.kitchen.batch'",[tenantId,storeId])
    expect(await expectOk(body,key)).toEqual(created)
    const view=await new FulfillmentQueryService(runtime).getStaffWorkQueue(scope,employeeId,businessDate)
    expect(view.workItems.find(item=>item.taskId===selection.items[0]!.taskId)).toMatchObject({readyForDelivery:true,deliveryNoticeVersion:1})
    await expectOk(await ready(created.batchId))
    const nextView=await new FulfillmentQueryService(runtime).getStaffWorkQueue(scope,employeeId,businessDate)
    expect(nextView.workItems.find(item=>item.taskId===selection.items[0]!.taskId)).toMatchObject({readyForDelivery:true,deliveryNoticeVersion:2})
  })
  it('rejects incompatible notes and rolls the whole batch back when inventory for a later item fails',async()=>{
    const first=await item(),second=await item('不要盐')
    const incompatible=await start([first,second]);expect((await command(incompatible)).statusCode).toBe(409)
    expect((await board()).pending.find(item=>item.taskId===first.taskId)?.unmade).toBe(5)
    const missing=await item();await pool.query(`UPDATE mbox.order_items SET product_snapshot=product_snapshot||'{"inventoryControlMode":"tracked"}'::jsonb WHERE id=$1`,[missing.itemId])
    const body=await start([first,missing],'回滚设备');expect((await command(body)).statusCode).toBe(409)
    expect((await board()).pending.find(item=>item.taskId===first.taskId)?.unmade).toBe(5)
    expect((await board()).batches.some(batch=>batch.equipment==='回滚设备')).toBe(false)
  })
  it('concurrent stale starts cannot consume the next portions and bound portions cannot be completed by the legacy whole-item action',async()=>{
    const row=await item(),body=await start([row],null,3)
    const responses=await Promise.all([command(body),command(body)])
    expect(responses.map(response=>response.statusCode).sort()).toEqual([200,409])
    await expect(runtime.run(scope,tx=>new ItemQuantityFulfillmentRepository(tx).complete({itemId:row.itemId,taskId:row.taskId,employeeId,quantity:5,eventKey:randomUUID()}))).rejects.toMatchObject({code:'QUANTITY_UNAVAILABLE'})
    expect((await board()).pending.find(item=>item.taskId===row.taskId)?.unmade).toBe(2)
  })
  it('direct readiness selects only the requested unmade portions when legacy work is already started',async()=>{
    const row=await item('',true)
    const legacy=await runtime.run(scope,tx=>new ItemQuantityFulfillmentRepository(tx).start({itemId:row.itemId,taskId:row.taskId,employeeId,quantity:2,eventKey:randomUUID()}))
    const body=await start([row],null,2,'quick-ready'),key=randomUUID()
    const created=await expectOk(body,key)
    expect(await expectOk(body,key)).toEqual(created)
    const units=(await pool.query('SELECT id,production_state FROM mbox.order_item_quantity_units WHERE order_item_id=$1 ORDER BY unit_index',[row.itemId])).rows
    expect(units.filter(unit=>legacy.unitIds.includes(unit.id)).map(unit=>unit.production_state)).toEqual(['started','started'])
    expect(units.map(unit=>unit.production_state)).toEqual(['started','started','ready','ready','unmade'])
    const bound=(await pool.query('SELECT unit_id FROM mbox.kitchen_production_units WHERE batch_id=$1',[created.batchId])).rows
    expect(bound.map(unit=>unit.unit_id).sort()).toEqual(units.slice(2,4).map(unit=>unit.id).sort())
    expect((await pool.query('SELECT on_hand_quantity::text AS remaining FROM mbox.inventory_balances WHERE inventory_item_id=$1',[row.stockId])).rows[0].remaining).toBe('6.000000')
  })
  it('completes exact selections, rejects held portions and does not silently choose another portion',async()=>{
    const row=await item(),created=await expectOk(await start([row],null,5)),selection=await ready(created.batchId)
    await runtime.run(scope,tx=>new ItemQuantityRepository(tx).hold({orderItemId:row.itemId,quantity:5,kind:'unpaid_stop',allowMadeUnpaidHold:true,employeeId,businessDate,reason:'核对客人暂停要求'}))
    expect((await command(selection)).statusCode).toBe(409)
    expect((await board()).batches.find(batch=>batch.id===created.batchId)!.units.filter(unit=>unit.state==='ready')).toHaveLength(0)
    expect((await board()).legacyTaskIds).toContain(row.taskId)
  })
  it('requires current table location even after a transfer returns to the same table',async()=>{
    const row=await item(),created=await expectOk(await start([row])),selection=await ready(created.batchId),target=await table()
    for(const tableId of [target,row.tableId])await runtime.run(scope,async tx=>{await tx.query(`SELECT * FROM mbox.execute_table_customer_movement('whole_table_transfer',$1,NULL,$2,2,'{}','{}','{}',$3,'测试转桌原位置校验',$4,$5::char(64),NULL,NULL,'{}')`,[row.tableSessionId,tableId,employeeId,randomUUID(),createHash('sha256').update(tableId).digest('hex')])})
    expect((await command(selection)).json().error.code).toBe('KITCHEN_TABLE_MOVED')
    await expectOk(await ready(created.batchId))
  })
  it('full actual readiness releases equipment without a redundant unload and immutable bindings remain protected',async()=>{
    const row=await item(),body=await start([row],'整批设备',2),created=await expectOk(body)
    const response=await expectOk(await ready(created.batchId,2));expect(response.released).toBe(true)
    expect((await board()).batches.some(batch=>batch.id===created.batchId)).toBe(false)
    await expectOk(await start([await item()],'整批设备',1))
    await expect(runtime.run(scope,tx=>tx.query('DELETE FROM mbox.kitchen_production_units WHERE batch_id=$1',[created.batchId]))).rejects.toMatchObject({code:'42501'})
    expect(await runtime.run({...scope,storeId:randomUUID()},async tx=>(await tx.query('SELECT id FROM mbox.kitchen_production_batches')).rowCount,{readOnly:true})).toBe(0)
  })
  it('pausing new admission preserves batch visibility, readiness and replay of the original operation',async()=>{
    const row=await item(),body=await start([row]),key=randomUUID(),created=await expectOk(body,key)
    const paused=Fastify()
    await paused.register(kitchenProductionApiPlugin,{enabled:false,prefix:'/api',staffAccessTransactions:runtime,commandExecutor:new NormalizedCommandExecutor(runtime),resolveContext:()=>({scope,employeeId,staffSessionId,deviceAccessLeaseId:leaseId,businessDate}),createKdsRepository:tx=>new KdsRepository(tx),createOrderRepository:tx=>new OrderRepository(tx)})
    try{
      const send=(command:KitchenCommand,operationKey=randomUUID())=>paused.inject({method:'POST',url:'/api/commerce/kitchen-board/commands',headers:{'idempotency-key':operationKey},payload:{employeeId,command}})
      expect((await send(body,key)).json().data).toEqual(created)
      expect((await send(await start([row]))).json().error.code).toBe('KITCHEN_ADMISSION_PAUSED')
      expect((await paused.inject('/api/commerce/kitchen-board')).json().data.canStart).toBe(false)
      expect((await new FulfillmentQueryService(runtime,false).getStaffWorkQueue(scope,employeeId,businessDate)).actor.kitchenBatchBoardEnabled).toBe(true)
      const selection=await ready(created.batchId)
      const response=await send(selection);expect(response.statusCode,response.body).toBe(200)
    }finally{await paused.close()}
  })
  it('direct ready creates no fake heating timestamp, validates actor and denies revoked session including replay',async()=>{
    const row=await item(),body=await start([row],null,2,'quick-ready'),key=randomUUID(),result=await expectOk(body,key)
    expect((await pool.query('SELECT started_at,equipment FROM mbox.kitchen_production_batches WHERE id=$1',[result.batchId])).rows[0]).toEqual({started_at:null,equipment:null})
    const response=await app.inject({method:'POST',url:'/api/commerce/kitchen-board/commands',headers:{'idempotency-key':randomUUID()},payload:{employeeId:randomUUID(),command:body}})
    expect(response.statusCode).toBe(403)
    await pool.query('UPDATE mbox.staff_sessions SET revoked_at=clock_timestamp() WHERE id=$1',[staffSessionId])
    expect((await command(body,key)).statusCode).toBe(403)
  })
  it('bounds kitchen source lookups for a 120-order burst under RLS and preserves station/scope isolation',async()=>{
    const rows=[]
    for(let index=0;index<120;index++)rows.push(await item(`burst-${index}`))
    const expected=new Set(rows.map(row=>row.taskId))
    await runtime.run(scope,async tx=>{
      await tx.query("SET LOCAL statement_timeout='5s'")
      let sql='',values:readonly unknown[]=[]
      await readKitchenSources({scope,query:async(text,args)=>{sql=text;values=args??[];return {rows:[],rowCount:0}}},employeeId,businessDate)
      const result=await tx.query<{"QUERY PLAN":Array<{Plan:Record<string,unknown>}>}>(`EXPLAIN (ANALYZE,FORMAT JSON) ${sql}`,values)
      const scans:Array<Record<string,unknown>>=[]
      const visit=(node:Record<string,unknown>)=>{if(node['Relation Name']==='kds_tasks')scans.push(node);for(const child of (node.Plans??[]) as Array<Record<string,unknown>>)visit(child)}
      visit(result.rows[0]!['QUERY PLAN'][0]!.Plan)
      // The incident rescanned tasks 864,000 times for 120 orders. Reject that work amplification.
      expect(scans.length).toBeGreaterThan(0)
      expect(scans.every(scan=>Number(scan['Actual Loops'])<=1)).toBe(true)
      const sources=(await readKitchenSources(tx,employeeId,businessDate)).filter(row=>expected.has(row.taskId))
      expect(sources).toHaveLength(120)
      expect(sources.every(row=>row.eligible&&row.unmade===5&&row.canPrepare)).toBe(true)
      expect(await readKitchenSources(tx,employeeId,businessDate,'bar')).toEqual([])
    },{readOnly:true})
    expect(await runtime.run({...scope,storeId:randomUUID()},tx=>readKitchenSources(tx,employeeId,businessDate),{readOnly:true})).toEqual([])
  },30000)

})
