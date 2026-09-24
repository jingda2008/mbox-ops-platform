import {createHash,randomUUID} from 'node:crypto'
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
import {kitchenProductionApiPlugin} from './kitchen-production-api.js'
import {KdsRepository} from './kds-repository.js'
import {OrderRepository} from './order-repository.js'
import {kitchenCompatibilityKey} from '../../src/shared/kitchen-production.js'
import {type PickupBoardData,type PickupCommand,type PickupCommandResult,type PickupUnit,type PickupReceipt} from '../../src/shared/pickup-workflow.js'

const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const integration=databaseUrl?describe:describe.skip
integration('three-screen runtime SQL security and atomic receipts',()=>{
  const tenantId=randomUUID(),storeId=randomUUID(),employeeId=randomUUID(),areaId=randomUUID(),productId=randomUUID(),roleId=randomUUID()
  const credentialId=randomUUID(),leaseId=randomUUID(),staffSessionId=randomUUID(),scope={tenantId,storeId}
  let currentSessionId=staffSessionId,currentEmployeeId=employeeId
  const otherTenantId=randomUUID(),otherStoreId=randomUUID(),siblingStoreId=randomUUID()
  const newTables=['kitchen_production_handoffs','pickup_devices','pickup_receipts','pickup_receipt_parts','pickup_undos','pickup_command_receipts'] as const
  let pool:Pool,runner:ScopedPostgresTransactionRunner,runtime:ScopedPostgresTransactionRunner,businessDate:string
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
    for(const code of ['kds.prepare','kds.deliver','table.transfer','fulfillment.view_all','staff.access.configure','kds.exception.manage']){
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
    await app.register(kitchenProductionApiPlugin,{enabled:true,prefix:'/api',staffAccessTransactions:runtime,commandExecutor:new NormalizedCommandExecutor(runtime),resolveContext:()=>({scope,employeeId:currentEmployeeId,staffSessionId:currentSessionId,deviceAccessLeaseId:leaseId,businessDate}),createKdsRepository:tx=>new KdsRepository(tx),createOrderRepository:tx=>new OrderRepository(tx)})
    await pool.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Separate tenant')",[otherTenantId,`outside-${otherTenantId}`])
    await pool.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,'outside','Separate store'),($3,$4,'sibling','Sibling store')",[otherStoreId,otherTenantId,siblingStoreId,tenantId])
    const configured=await configure();expect(configured.statusCode,configured.body).toBe(200)
    const row=await item();await ready(row,2);const picked=await ok(await take(row));await ok(undo(picked))
    // Populate handoff history through the actual API; no fabricated batch or task ownership.
    const production=await item(),pending=(await app.inject('/api/commerce/kitchen-board')).json().data.pending.find((part:{taskId:string})=>part.taskId===production.taskId)
    const started=await app.inject({method:'POST',url:'/api/commerce/kitchen-board/commands',headers:{'idempotency-key':randomUUID()},payload:{employeeId,command:{action:'start',compatibilityKey:kitchenCompatibilityKey(pending),items:[{taskId:pending.taskId,quantity:1,expectedUnmade:pending.unmade,tableId:pending.tableId,tableSessionId:pending.tableSessionId,locationVersion:pending.locationVersion}],equipment:null,expectedSeconds:null}}})
    expect(started.statusCode,started.body).toBe(200)
    const batchId=started.json().data.batchId,successorId=randomUUID(),successorSession=randomUUID()
    await pool.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,'successor','Security successor')",[successorId,tenantId,storeId])
    await pool.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 hour')",[tenantId,storeId,successorId,roleId])
    await pool.query("INSERT INTO mbox.staff_sessions(id,tenant_id,store_id,employee_id,device_access_lease_id,session_token_hash,issued_at,expires_at,online_lease_until) VALUES($1,$2,$3,$4,$5,$6,statement_timestamp(),statement_timestamp()+interval '6 hours',statement_timestamp()+interval '30 minutes')",[successorSession,tenantId,storeId,successorId,leaseId,createHash('sha256').update(successorSession).digest('hex')])
    currentEmployeeId=successorId;currentSessionId=successorSession
    const previewResponse=await app.inject(`/api/commerce/kitchen-board/handoff-preview?batchId=${batchId}`)
    expect(previewResponse.statusCode,previewResponse.body).toBe(200)
    const preview=previewResponse.json().data
    const handed=await app.inject({method:'POST',url:'/api/commerce/kitchen-board/commands',headers:{'idempotency-key':randomUUID()},payload:{employeeId:successorId,command:{action:'handoff',batchId,expectedBatches:preview.batches,expectedTasks:preview.tasks,physicalChecked:true,reason:'安全测试中实际核对后接班'}}})
    expect(handed.statusCode,handed.body).toBe(200)
    currentEmployeeId=employeeId;currentSessionId=staffSessionId
  },30000)
  afterAll(async()=>{await app.close();await pool?.end()})
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

  it('allows take and undo with an issued session after credential rotation, retaining receipt SQL guards',async()=>{
    await configure()
    const row=await item();await ready(row,1)
    try{
      await pool.query('UPDATE mbox.store_daily_credentials SET revoked_at=clock_timestamp() WHERE id=$1',[credentialId])
      const taken=await ok(await take(row,1))
      expect(taken.receipt.quantity).toBe(1)
      await ok(undo(taken))
      const group=(await board()).tables.find(group=>group.tableSessionId===row.tableSessionId)!
      expect(group.units).toHaveLength(1)
      await pool.query('UPDATE mbox.store_device_access_leases SET revoked_at=clock_timestamp() WHERE id=$1',[leaseId])
      await expect(runtime.run(scope,tx=>rawReceipt(tx,group.units,group.units[0]!))).rejects.toThrow('pickup source lease invalid')
      await pool.query('UPDATE mbox.store_device_access_leases SET revoked_at=NULL WHERE id=$1',[leaseId])
      await pool.query('UPDATE mbox.staff_sessions SET revoked_at=clock_timestamp() WHERE id=$1',[staffSessionId])
      await expect(runtime.run(scope,tx=>rawReceipt(tx,group.units,group.units[0]!))).rejects.toThrow('pickup source session invalid')
    }finally{
      await pool.query('UPDATE mbox.store_daily_credentials SET revoked_at=NULL WHERE id=$1',[credentialId])
      await pool.query('UPDATE mbox.store_device_access_leases SET revoked_at=NULL WHERE id=$1',[leaseId])
      await pool.query('UPDATE mbox.staff_sessions SET revoked_at=NULL WHERE id=$1',[staffSessionId])
    }
  })

  async function rawReceipt(tx:ScopedTransaction,units:PickupUnit[],table:Pick<PickupUnit,'tableId'|'tableSessionId'|'locationVersion'|'tableCode'>,receiptId=randomUUID()){
    const device=(await tx.query<{id:string;label:string}>('SELECT id,label FROM mbox.pickup_devices WHERE tenant_id=$1 AND store_id=$2 AND enabled',[tenantId,storeId])).rows[0]!
    const at=new Date().toISOString(),snapshot:PickupReceipt={receiptId,revision:1,tableId:table.tableId,tableCode:table.tableCode,tableSessionId:table.tableSessionId,takenAt:at,deliveryConfirmedAt:at,deliverySource:'pickup',source:{kind:'shared_pickup_device',deviceId:device.id,label:device.label},pickerEmployeeId:null,units,quantity:units.length,undo:null,canUndo:true,undoBlockedReason:null}
    await tx.query(`INSERT INTO mbox.pickup_receipts(id,tenant_id,store_id,table_session_id,table_id,location_version,device_id,authorized_employee_id,staff_session_id,device_access_lease_id,business_date,snapshot)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,[receiptId,tenantId,storeId,table.tableSessionId,table.tableId,table.locationVersion,device.id,employeeId,staffSessionId,leaseId,businessDate,JSON.stringify(snapshot)])
    return receiptId
  }
  async function rawPart(tx:ScopedTransaction,receiptId:string,unit:PickupUnit){
    return tx.query(`INSERT INTO mbox.pickup_receipt_parts(tenant_id,store_id,receipt_id,unit_id,remake_unit_id,original_unit_id,kds_task_id,expected_version)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[tenantId,storeId,receiptId,unit.kind==='original'?unit.unitId:null,unit.kind==='remake'?unit.unitId:null,unit.originalUnitId,unit.taskId,unit.version])
  }
  async function rawTaken(tx:ScopedTransaction,receiptId:string,unit:PickupUnit){
    const relation=unit.kind==='original'?'order_item_quantity_units':'quantity_remake_units'
    return tx.query(`UPDATE mbox.${relation} SET production_state='delivered',current_pickup_receipt_id=$2,fulfillment_revision=fulfillment_revision+1,updated_at=clock_timestamp() WHERE id=$1`,[unit.unitId,receiptId])
  }
  async function rawUndo(tx:ScopedTransaction,receiptId:string){
    return tx.query(`INSERT INTO mbox.pickup_undos(tenant_id,store_id,receipt_id,device_id,authorized_employee_id,staff_session_id,device_access_lease_id,physical_still_at_pickup_point)
      SELECT tenant_id,store_id,id,device_id,$2,$3,$4,true FROM mbox.pickup_receipts WHERE id=$1`,[receiptId,employeeId,staffSessionId,leaseId])
  }
  async function unitFacts(ids:string[]){return (await pool.query('SELECT id,production_state,current_pickup_receipt_id,fulfillment_revision::text FROM mbox.order_item_quantity_units WHERE id=ANY($1::uuid[]) ORDER BY id',[ids])).rows}
  async function readyUnits(count=2){const row=await item();await ready(row,count);const table=(await board()).tables.find(group=>group.tableSessionId===row.tableSessionId)!;return {row,table,units:table.units}}

  it('runs as a non-bypass role and hides every populated new relation from sibling stores and other tenants',async()=>{
    const role=await runtime.run(scope,async tx=>(await tx.query<{name:string;rolsuper:boolean;rolbypassrls:boolean}>(`SELECT current_user AS name,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`)).rows[0]!)
    expect(role).toEqual({name:'mbox_runtime',rolsuper:false,rolbypassrls:false})
    for(const relation of newTables){
      const flags=(await pool.query('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',[`mbox.${relation}`])).rows[0]
      expect(flags).toEqual({relrowsecurity:true,relforcerowsecurity:true})
      expect(await runtime.run(scope,async tx=>(await tx.query(`SELECT * FROM mbox.${relation}`)).rowCount,{readOnly:true})).toBeGreaterThan(0)
      for(const outside of [{tenantId,storeId:siblingStoreId},{tenantId:otherTenantId,storeId:otherStoreId}]){
        expect(await runtime.run(outside,async tx=>(await tx.query(`SELECT * FROM mbox.${relation}`)).rowCount,{readOnly:true})).toBe(0)
      }
    }
  })
  it('rejects attempts from either foreign scope to insert known valid rows into each populated new relation',async()=>{
    for(const relation of newTables){
      const original=(await pool.query(`SELECT to_jsonb(row) AS value FROM mbox.${relation} row WHERE tenant_id=$1 AND store_id=$2 LIMIT 1`,[tenantId,storeId])).rows[0].value as Record<string,unknown>
      const columns=(await pool.query<{name:string}>("SELECT attname AS name FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped AND attgenerated='' ORDER BY attnum",[`mbox.${relation}`])).rows.map(row=>row.name)
      const before=(await pool.query(`SELECT count(*)::int AS n FROM mbox.${relation}`)).rows[0].n
      for(const outside of [{tenantId,storeId:siblingStoreId},{tenantId:otherTenantId,storeId:otherStoreId}]){
        const copy={...original,...('id' in original?{id:randomUUID()}:{}),...('operation_key' in original?{operation_key:randomUUID()}:{}),...(relation==='pickup_devices'?{device_key_hash:randomUUID()}:{})}
        const names=columns.map(name=>`"${name}"`).join(',')
        const attempt=runtime.run(outside,tx=>tx.query(`INSERT INTO mbox.${relation}(${names}) SELECT ${names} FROM jsonb_populate_record(NULL::mbox.${relation},$1::jsonb)`,[JSON.stringify(copy)]))
        await expect(attempt).rejects.toMatchObject({code:expect.stringMatching(/^(42501|23514)$/)})
      }
      expect((await pool.query(`SELECT count(*)::int AS n FROM mbox.${relation}`)).rows[0].n).toBe(before)
    }
  })
  it('runtime cannot edit or delete any immutable handoff, pickup, part, undo or command receipt',async()=>{
    for(const relation of newTables.filter(table=>table!=='pickup_devices')){
      await expect(runtime.run(scope,tx=>tx.query(`DELETE FROM mbox.${relation} WHERE tenant_id=$1 AND store_id=$2`,[tenantId,storeId]))).rejects.toMatchObject({code:'42501'})
      await expect(runtime.run(scope,tx=>tx.query(`UPDATE mbox.${relation} SET tenant_id=tenant_id WHERE tenant_id=$1 AND store_id=$2`,[tenantId,storeId]))).rejects.toMatchObject({code:'42501'})
    }
    await expect(runtime.run(scope,tx=>tx.query('UPDATE mbox.pickup_devices SET device_key_hash=$1 WHERE tenant_id=$2 AND store_id=$3',[randomUUID(),tenantId,storeId]))).rejects.toMatchObject({code:'42501'})
  })
  it('empty, incomplete and unfulfilled receipts cannot commit and roll back even an earlier changed portion',async()=>{
    const {units,table}=await readyUnits(2),ids=units.map(unit=>unit.unitId),before=await unitFacts(ids)
    for(const mode of ['empty','missing-part','missing-transition'] as const){
      const receiptId=randomUUID()
      await expect(runtime.run(scope,async tx=>{
        await rawReceipt(tx,mode==='empty'?[]:units,table,receiptId)
        if(mode==='missing-part'){await rawPart(tx,receiptId,units[0]!);await rawTaken(tx,receiptId,units[0]!)}
        if(mode==='missing-transition')for(const unit of units)await rawPart(tx,receiptId,unit)
      })).rejects.toMatchObject({code:'23514'})
      expect((await pool.query('SELECT id FROM mbox.pickup_receipts WHERE id=$1',[receiptId])).rowCount).toBe(0)
      expect((await pool.query('SELECT receipt_id FROM mbox.pickup_receipt_parts WHERE receipt_id=$1',[receiptId])).rowCount).toBe(0)
      expect(await unitFacts(ids)).toEqual(before)
    }
  })
  it('cannot append a new portion to an already committed pickup receipt',async()=>{
    const {row,units}=await readyUnits(2),taken=await ok(await take(row,1)),receiptId=taken.receipt.receiptId
    const next=(await board()).tables.find(table=>table.tableSessionId===row.tableSessionId)!.units[0]!
    const ids=units.map(unit=>unit.unitId),before=await unitFacts(ids)
    await expect(runtime.run(scope,async tx=>{await rawPart(tx,receiptId,next);await rawTaken(tx,receiptId,next)})).rejects.toMatchObject({code:'23514'})
    expect((await pool.query('SELECT count(*)::int AS n FROM mbox.pickup_receipt_parts WHERE receipt_id=$1',[receiptId])).rows[0].n).toBe(1)
    expect(await unitFacts(ids)).toEqual(before)
    expect((await board()).history.find(receipt=>receipt.receiptId===receiptId)?.quantity).toBe(1)
  })
  it('cannot commit a receipt snapshot that repeats the same physical unit key',async()=>{
    const {units,table}=await readyUnits(1),unit=units[0]!,before=await unitFacts([unit.unitId]),receiptId=randomUUID()
    await expect(runtime.run(scope,async tx=>{await rawReceipt(tx,[unit,unit],table,receiptId);await rawPart(tx,receiptId,unit);await rawTaken(tx,receiptId,unit)})).rejects.toMatchObject({code:'23514'})
    expect((await pool.query('SELECT id FROM mbox.pickup_receipts WHERE id=$1',[receiptId])).rowCount).toBe(0)
    expect((await pool.query('SELECT receipt_id FROM mbox.pickup_receipt_parts WHERE receipt_id=$1',[receiptId])).rowCount).toBe(0)
    expect(await unitFacts([unit.unitId])).toEqual(before)
  })
  it('rejects a matching snapshot with a forged original task or root unit at the binding boundary',async()=>{
    const first=await readyUnits(1),other=await readyUnits(1)
    for(const altered of [{...first.units[0]!,taskId:other.units[0]!.taskId},{...first.units[0]!,originalUnitId:other.units[0]!.originalUnitId}]){
      const receiptId=randomUUID()
      await expect(runtime.run(scope,async tx=>{await rawReceipt(tx,[altered],first.table,receiptId);await rawPart(tx,receiptId,altered);await rawTaken(tx,receiptId,altered)})).rejects.toMatchObject({code:'23514'})
      expect((await pool.query('SELECT id FROM mbox.pickup_receipts WHERE id=$1',[receiptId])).rowCount).toBe(0)
    }
    expect((await unitFacts([first.units[0]!.unitId,other.units[0]!.unitId])).every(unit=>unit.production_state==='ready')).toBe(true)
  })
  it('rejects another table mixed into an otherwise matching SQL receipt and rolls back the first table transition',async()=>{
    const first=await readyUnits(1),other=await readyUnits(1),units=[first.units[0]!,other.units[0]!],before=await unitFacts(units.map(unit=>unit.unitId)),receiptId=randomUUID()
    await expect(runtime.run(scope,async tx=>{await rawReceipt(tx,units,first.table,receiptId);for(const unit of units){await rawPart(tx,receiptId,unit);await rawTaken(tx,receiptId,unit)}})).rejects.toMatchObject({code:'23514'})
    expect(await unitFacts(units.map(unit=>unit.unitId))).toEqual(before)
    expect((await pool.query('SELECT id FROM mbox.pickup_receipts WHERE id=$1',[receiptId])).rowCount).toBe(0)
  })
  it('an undo row without all exact physical reversals cannot commit or leave any partially reverted portion',async()=>{
    const {row}=await readyUnits(2),picked=await ok(await take(row)),ids=picked.receipt.units.map(unit=>unit.unitId),before=await unitFacts(ids)
    for(const count of [0,1]){
      await expect(runtime.run(scope,async tx=>{await rawUndo(tx,picked.receipt.receiptId);for(const unit of picked.receipt.units.slice(0,count))await tx.query("UPDATE mbox.order_item_quantity_units SET production_state='ready',current_pickup_receipt_id=NULL,fulfillment_revision=fulfillment_revision+1,updated_at=clock_timestamp() WHERE id=$1",[unit.unitId])})).rejects.toMatchObject({code:'23514'})
      expect(await unitFacts(ids)).toEqual(before)
      expect((await pool.query('SELECT id FROM mbox.pickup_undos WHERE receipt_id=$1',[picked.receipt.receiptId])).rowCount).toBe(0)
    }
  })
  it.each(['original','remake'] as const)('old %s undo credentials cannot rewind a newer pickup, including permanent replay after generic cache deletion',async(kind)=>{
    const {row}=await readyUnits(1)
    if(kind==='remake'){
      const remake=await runtime.run(scope,tx=>new QuantityRemakeRepository(tx).create({itemId:row.itemId,employeeId,quantity:1,originalGoodsLost:true,reason:'安全回归明确原实物损坏后重做',eventKey:randomUUID()}))
      await runtime.run(scope,tx=>new QuantityRemakeFulfillmentRepository(tx).act({taskId:remake.taskId,employeeId,action:'complete',quantity:1,eventKey:randomUUID()}))
    }
    const first=await ok(await take(row,1)),part=first.receipt.units[0]!,key=randomUUID(),body=undo(first)
    expect(part.kind).toBe(kind)
    const firstUndo=await ok(body,key),second=await ok(await take(row,1)),relation=kind==='original'?'order_item_quantity_units':'quantity_remake_units'
    const facts=async()=>(await pool.query(`SELECT production_state,current_pickup_receipt_id,fulfillment_revision::text FROM mbox.${relation} WHERE id=$1`,[part.unitId])).rows[0]
    const before=await facts();expect(before.current_pickup_receipt_id).toBe(second.receipt.receiptId)
    await pool.query("DELETE FROM mbox.idempotency_records WHERE tenant_id=$1 AND store_id=$2 AND operation_scope='commerce.pickup'",[tenantId,storeId])
    expect((await ok(body,key)).receipt.undo).toEqual(firstUndo.receipt.undo)
    expect(await facts()).toEqual(before)
    await expect(runtime.run(scope,tx=>tx.query(`UPDATE mbox.${relation} SET production_state='ready',current_pickup_receipt_id=NULL,fulfillment_revision=fulfillment_revision+1,updated_at=clock_timestamp() WHERE id=$1`,[part.unitId]))).rejects.toMatchObject({code:'23514'})
    expect(await facts()).toEqual(before)
  })
})
