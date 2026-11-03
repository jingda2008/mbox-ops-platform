import {randomUUID} from 'node:crypto'
import Fastify, {type FastifyRequest} from 'fastify'
import {printBridgeApiPlugin} from './print-bridge-api.js'
import {Pool} from 'pg'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {assertRuntimeDatabasePool} from './runtime-database-identity.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {StaffSessionNotFoundError} from './staff-session-repository.js'
import {StaffAccessRepository} from './staff-access-repository.js'
import {HardwareRepository} from './hardware-repository.js'
import {hardwareApiPlugin} from './hardware-api.js'

const database=process.env.TEST_NORMALIZED_DATABASE_URL,runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
;(database&&runtimeUrl?describe:describe.skip)('report and fulfillment source authorization with restricted LOGIN',()=>{
 const scope={tenantId:randomUUID(),storeId:randomUUID()},actor=randomUUID(),other=randomUUID(),role=randomUUID()
 const permissions=['order.bill.print','order.history.view','order.history.all','reconciliation.view','commercial.profit.view','inventory.receive','kds.deliver','printer.manage']
 let day:string,oldDay:string,area:string,product:string
 let admin:Pool,runtime:Pool,app:ReturnType<typeof Fastify>,transactions:ScopedPostgresTransactionRunner,beforeExecute:(()=>Promise<void>)|undefined
 const grant=async(codes:string[])=>{
  await admin.query('DELETE FROM mbox.role_permission_assignments WHERE tenant_id=$1 AND role_id=$2',[scope.tenantId,role])
  await admin.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code=ANY($4::text[])',[scope.tenantId,scope.storeId,role,codes])
 }
 const snapshot=async()=>{
  const result:Record<string,unknown>={}
  for(const name of ['orders','order_items','delivery_batches','delivery_batch_items','order_stock_returns','order_stock_return_movements','inventory_balances','inventory_movements','inventory_order_reservations','payments','refunds','devices','printer_routes','hardware_commands','print_ticket_policies','print_ticket_policy_inheritance','print_bridges','print_bridge_pairing_codes','print_jobs','print_job_events','audit_events','outbox_messages','idempotency_records'])result[name]=(await admin.query(`SELECT to_jsonb(t) row FROM mbox.${name} t WHERE tenant_id=$1 ORDER BY to_jsonb(t)::text`,[scope.tenantId])).rows
  return result
 }
 beforeAll(async()=>{
  await runNormalizedMigrations(database!);admin=new Pool({connectionString:database});runtime=new Pool({connectionString:runtimeUrl});await assertRuntimeDatabasePool(runtime,runtimeUrl!);transactions=new ScopedPostgresTransactionRunner(runtime)
  await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'Hardware recovery')",[scope.tenantId])
  await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1::uuid,$2,$1::text,'Hardware recovery')",[scope.storeId,scope.tenantId])
  await admin.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'HARDWARE','Hardware')",[role,scope.tenantId,scope.storeId])
  for(const id of [actor,other]){
   await admin.query('INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1::uuid,$2,$3,$1::text,$1::text)',[id,scope.tenantId,scope.storeId])
   await admin.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 day')",[scope.tenantId,scope.storeId,id,role])
  }
  for(const code of permissions)await admin.query('INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name) VALUES($1,$2,$3,$3) ON CONFLICT DO NOTHING',[scope.tenantId,scope.storeId,code])
  await grant(permissions)
  day=(await transactions.run(scope,tx=>tx.query<{date:string}>('SELECT mbox.current_operating_business_date($1,$2)::text date',[scope.tenantId,scope.storeId]))).rows[0]!.date
  oldDay=new Date(Date.parse(day)-10*86400000).toISOString().slice(0,10)
  area=randomUUID();product=randomUUID()
  await admin.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'A','Synthetic','indoor')",[area,scope.tenantId,scope.storeId])
  await admin.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station) VALUES($1,$2,$3,'BEER','Synthetic','beer','bar')",[product,scope.tenantId,scope.storeId])
  await transactions.run(scope,async tx=>{const repo=new HardwareRepository(tx);const printer=await repo.createDevice({code:'report-printer',name:'Synthetic',deviceType:'printer',stationCode:'cashier'});await repo.upsertPrinterRoute({code:'report-route',name:'Synthetic',stationCode:'cashier',printerDeviceId:printer.id})})
  const executor=new NormalizedCommandExecutor(transactions)
  const commands={execute:((...args:Parameters<NormalizedCommandExecutor['execute']>)=>{const hook=beforeExecute;beforeExecute=undefined;return (async()=>{await hook?.();return executor.execute(...args)})()}) as NormalizedCommandExecutor['execute']}
  const resolveContext=async(req:FastifyRequest)=>{
   const employeeId=String(req.headers['x-test-employee']??actor)
   const active=(await admin.query('SELECT status FROM mbox.employees WHERE id=$1',[employeeId])).rows[0]?.status
   if(active!=='active')throw new StaffSessionNotFoundError()
   const access=await transactions.run(scope,tx=>new StaffAccessRepository(tx).resolve(employeeId),{readOnly:true})
   return {scope,employeeId,businessDate:day,capabilities:access.permissions}
  }
  app=Fastify();await app.register(hardwareApiPlugin,{transactions,commands,resolveContext})
  await app.register(printBridgeApiPlugin,{scope,transactions,commands,resolveStaffContext:resolveContext,hashSecret:'isolated-source-access-test-secret',requireHttps:false})
  await app.ready()
 })
 afterAll(async()=>{await app?.close();await runtime?.end();await admin?.end()})
 const orderFixture=async(date=day,stock=false,unpaid=false)=>{
  const table=randomUUID(),session=randomUUID(),order=randomUUID(),item=randomUUID(),payment=randomUUID(),reviewer=other
  await admin.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1::uuid,$2,$3,$4,upper(substr(replace($1::text,'-',''),1,12)),$1::text,4)",[table,scope.tenantId,scope.storeId,area])
  await admin.query("INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,status,guest_count) VALUES($1::uuid,$2,$3,$4,$1::text,$5,'open',2)",[session,scope.tenantId,scope.storeId,table,date])
  await admin.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,subtotal_amount_minor,total_amount_minor,submitted_at) VALUES($1::uuid,$2,$3,$4,$1::text,'staff_assisted','fulfilling',$5,1000,1000,clock_timestamp())",[order,scope.tenantId,scope.storeId,session,unpaid?'unpaid':'paid'])
  await admin.query("INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot,status) VALUES($1,$2,$3,$4,$5,1,1000,1000,'bar','{\"name\":\"Synthetic\"}',$6)",[item,scope.tenantId,scope.storeId,order,product,stock?'delivered':'ready'])
  if(!unpaid)await admin.query("INSERT INTO mbox.payments(id,tenant_id,store_id,order_id,public_id,provider,method,amount_minor,currency,status,succeeded_at,provider_transaction_id) VALUES($1::uuid,$2,$3,$4,$1::text,'cash','cash',1000,'CNY','succeeded',clock_timestamp(),$1::text)",[payment,scope.tenantId,scope.storeId,order])
  if(stock){
   const inventory=randomUUID(),movement=randomUUID(),refund=randomUUID()
   await admin.query("INSERT INTO mbox.inventory_items(id,tenant_id,store_id,sku,name,item_type,base_unit) VALUES($1::uuid,$2,$3,$1::text,'Synthetic','bottle','bottle')",[inventory,scope.tenantId,scope.storeId])
   await admin.query("INSERT INTO mbox.inventory_movements(id,tenant_id,store_id,inventory_item_id,movement_type,quantity_delta,reference_type,reference_id,order_item_id,unit_cost_minor) VALUES($1,$2,$3,$4,'sale',-1,'order_item',$5,$5,300)",[movement,scope.tenantId,scope.storeId,inventory,item])
   await admin.query('INSERT INTO mbox.inventory_balances(tenant_id,store_id,inventory_item_id,on_hand_quantity,last_movement_id) VALUES($1,$2,$3,6,$4)',[scope.tenantId,scope.storeId,inventory,movement])
   await admin.query("INSERT INTO mbox.inventory_order_reservations(tenant_id,store_id,order_id,order_item_id,inventory_item_id,quantity,status,movement_id,consumed_at) VALUES($1,$2,$3,$4,$5,1,'consumed',$6,clock_timestamp())",[scope.tenantId,scope.storeId,order,item,inventory,movement])
   await admin.query("INSERT INTO mbox.refunds(id,tenant_id,store_id,payment_id,public_id,provider_refund_id,amount_minor,currency,status,reason,requested_by_employee_id,approved_by_employee_id,decision_reason,completed_at) VALUES($1::uuid,$2,$3,$4,$1::text,$1::text,1000,'CNY','succeeded','Synthetic',$5,$6,'Synthetic',clock_timestamp())",[refund,scope.tenantId,scope.storeId,payment,actor,reviewer])
   await admin.query("INSERT INTO mbox.refund_items(tenant_id,store_id,refund_id,order_item_id,amount_minor,currency) VALUES($1,$2,$3,$4,1000,'CNY')",[scope.tenantId,scope.storeId,refund,item])
  }
  const task=randomUUID()
  if(!stock)await admin.query("INSERT INTO mbox.kds_tasks(id,tenant_id,store_id,order_item_id,station_code,status,quantity,ready_at) VALUES($1,$2,$3,$4,'bar','ready',1,clock_timestamp())",[task,scope.tenantId,scope.storeId,item])
  return {order,item,session,task}
 }
 const send=(url:string,body:object,key=randomUUID(),employee=actor)=>app.inject({method:'POST',url,headers:{'idempotency-key':key,'x-test-employee':employee},payload:body})
 const reportFixture=async(kind:string,date=oldDay)=>{
  const f=await orderFixture(date)
  return {url:kind==='order'?`/hardware/orders/${f.order}/bill`:kind==='table'?`/hardware/table-sessions/${f.session}/bill`:kind==='day'?`/hardware/business-days/${date}/report`:'/hardware/operating-report',body:kind==='operating'?{period:'day',anchorDate:date}:{},...f}
 }
 for(const kind of ['order','table','day','operating']){
  const allowed=['order.bill.print','order.history.view','order.history.all',kind==='operating'?'commercial.profit.view':'reconciliation.view']
  const deniedCode=kind==='order'?403:400
  it.each(['history','source','stale-source'])(`${kind} report denies old receipt and tracking after %s revocation`,async mode=>{
   await grant(allowed);const f=await reportFixture(kind),key=randomUUID(),first=await send(f.url,f.body,key)
   expect([201,202]).toContain(first.statusCode)
   const before=await snapshot()
   const narrowed=mode==='history'?allowed.filter(p=>p!=='order.history.all'):['order.bill.print']
   try{
    if(mode==='stale-source')beforeExecute=()=>grant(narrowed);else await grant(narrowed)
    const response=await send(f.url,f.body,key);expect(response.statusCode,response.body).toBe(mode==='history'?deniedCode:403)
    const tracking=await app.inject(`/hardware/print-requests/${first.json().data.requestId}`)
    expect(tracking.statusCode,tracking.body).toBe(mode==='history'?deniedCode:403)
    expect((await send(f.url,f.body)).statusCode).toBe(mode==='history'?deniedCode:403)
    expect(await snapshot()).toEqual(before)
   }finally{beforeExecute=undefined;await grant(allowed)}
   const recovered=await send(f.url,f.body,key);expect(recovered.statusCode,recovered.body).toBe(200);expect(recovered.json()).toEqual({data:first.json().data,replayed:true});expect(await snapshot()).toEqual(before)
  })
  it(`${kind} status tracking independently rechecks historical source scope`,async()=>{
   await grant(allowed);const f=await reportFixture(kind),first=await send(f.url,f.body);expect([201,202]).toContain(first.statusCode)
   const before=await snapshot()
   try{await grant(allowed.filter(p=>p!=='order.history.all'));const response=await app.inject(`/hardware/print-requests/${first.json().data.requestId}`);expect(response.statusCode,response.body).toBe(deniedCode);expect(await snapshot()).toEqual(before)}finally{await grant(allowed)}
  })
  it(`${kind} enforces the exact three-operating-day boundary`,async()=>{
   await grant(allowed.filter(p=>p!=='order.history.all'))
   const earliest=new Date(Date.parse(day)-2*86400000).toISOString().slice(0,10),excluded=new Date(Date.parse(day)-3*86400000).toISOString().slice(0,10)
   const yes=await reportFixture(kind,earliest),no=await reportFixture(kind,excluded)
   const first=await send(yes.url,yes.body);expect([201,202]).toContain(first.statusCode)
   const before=await snapshot(),denied=await send(no.url,no.body);expect(denied.statusCode,denied.body).toBe(deniedCode);expect(await snapshot()).toEqual(before)
  })
  it(`${kind} first request rejects source permission revoked after context resolution`,async()=>{
   await grant(allowed);const f=await reportFixture(kind,day),before=await snapshot()
   try{beforeExecute=()=>grant(['order.bill.print']);const response=await send(f.url,f.body);expect(response.statusCode,response.body).toBe(403);expect(await snapshot()).toEqual(before)}finally{beforeExecute=undefined;await grant(allowed)}
  })
  it(`${kind} preserves current-window recovery and rejects same-key payload or actor changes`,async()=>{
   await grant(allowed.filter(p=>p!=='order.history.all'));const f=await reportFixture(kind,day),key=randomUUID(),first=await send(f.url,f.body,key);expect([201,202]).toContain(first.statusCode)
   const before=await snapshot();expect((await send(f.url,f.body,key)).json()).toEqual({data:first.json().data,replayed:true})
   expect((await send(f.url,f.body,key,other)).statusCode).toBe(409)
   expect((await app.inject({url:`/hardware/print-requests/${first.json().data.requestId}`,headers:{'x-test-employee':other}})).statusCode).toBe(403)
   expect((await send(f.url,{...f.body,reason:'changed'},key)).statusCode).toBe(409)
   expect(await snapshot()).toEqual(before)
  })
 }
 it.each(['history','stale-history','stale-operation'])('stock return rejects receipt after %s revocation without adding stock again',async mode=>{
  const allowed=['inventory.receive','order.history.view'];await grant(allowed)
  const f=await orderFixture(day,true),key=randomUUID(),url=`/operations/order-items/${f.item}/stock-return`,body={quantity:1,disposition:'returned_unopened',reason:'Synthetic return',unopenedConfirmed:true}
  const first=await send(url,body,key);expect(first.statusCode,first.body).toBe(201);const before=await snapshot()
  try{
   const narrow=()=>grant(mode==='stale-operation'?['order.history.view']:['inventory.receive'])
   if(mode==='history')await narrow();else beforeExecute=narrow
   const replay=await send(url,body,key);expect(replay.statusCode,replay.body).toBe(403);expect((await send(url,body)).statusCode).toBe(403);expect(await snapshot()).toEqual(before)
  }finally{beforeExecute=undefined;await grant(allowed)}
  expect((await send(url,body,key)).json()).toEqual({data:first.json().data,replayed:true});expect(await snapshot()).toEqual(before)
 })
 it('old unfinished stock work remains recoverable after the last unit is returned; revoked history still denies',async()=>{
  const allowed=['inventory.receive','order.history.view'];await grant(allowed)
  const f=await orderFixture(oldDay,true),url=`/operations/order-items/${f.item}/stock-return`,body={quantity:1,disposition:'returned_unopened',reason:'Synthetic old return',unopenedConfirmed:true},key=randomUUID()
  const first=await send(url,body,key);expect(first.statusCode,first.body).toBe(201)
  const before=await snapshot(),replay=await send(url,body,key);expect(replay.statusCode,replay.body).toBe(200);expect(replay.json()).toEqual({data:first.json().data,replayed:true})
  expect((await send(url,body)).statusCode).toBe(403)
  try{await grant(['inventory.receive']);expect((await send(url,body,key)).statusCode).toBe(403)}finally{await grant(allowed)}
  expect(await snapshot()).toEqual(before)
 })
 it('unverifiable old return receipts fail closed, while current all-history access can recover them',async()=>{
  const allowed=['inventory.receive','order.history.view'];await grant(allowed)
  const f=await orderFixture(oldDay,true),url=`/operations/order-items/${f.item}/stock-return`,body={quantity:1,disposition:'returned_unopened',reason:'Synthetic legacy return',unopenedConfirmed:true},key=randomUUID()
  const first=await send(url,body,key);expect(first.statusCode,first.body).toBe(201)
  const original=(await admin.query('SELECT response_snapshot FROM mbox.idempotency_records WHERE tenant_id=$1 AND idempotency_key=$2',[scope.tenantId,key])).rows[0].response_snapshot
  const proof=original.replayAuthorization
  for(const invalid of [undefined,{...proof,itemId:randomUUID()},{...proof,returnId:randomUUID()},{...proof,workException:false}]){
   const modified={...original,replayAuthorization:invalid}
   await admin.query('UPDATE mbox.idempotency_records SET response_snapshot=$3::jsonb WHERE tenant_id=$1 AND idempotency_key=$2',[scope.tenantId,key,JSON.stringify(modified)])
   const before=await snapshot();const replay=await send(url,body,key);expect(replay.statusCode,replay.body).toBe(403);expect(await snapshot()).toEqual(before)
  }
  await grant([...allowed,'order.history.all']);const before=await snapshot();expect((await send(url,body,key)).json()).toEqual({data:first.json().data,replayed:true});expect(await snapshot()).toEqual(before)
 })
 it.each(['receipt','fresh'])('delivery %s rechecks revoked permission but does not invent a table-owner restriction',async mode=>{
  await grant(['kds.deliver']);const f=await orderFixture(),url='/operations/delivery-batches',body={items:[{taskId:f.task,quantity:1}]},key=randomUUID()
  let first:Awaited<ReturnType<typeof send>>|undefined
  if(mode==='receipt'){first=await send(url,body,key);expect(first.statusCode,first.body).toBe(202)}
  const before=await snapshot()
  try{beforeExecute=()=>grant([]);const response=await send(url,body,key);expect(response.statusCode,response.body).toBe(403);expect(await snapshot()).toEqual(before)}finally{beforeExecute=undefined;await grant(['kds.deliver'])}
  if(first){await admin.query("UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp() WHERE id=$1",[f.session]);const replay=await send(url,body,key);expect(replay.statusCode,replay.body).toBe(200);expect(replay.json()).toEqual({data:first.json().data,replayed:true});expect(await snapshot()).toEqual(before)}
 })
 for(const kind of ['device-create','device-update','device-test','route-save','policy-save'])it.each(['receipt','fresh'])(`native ${kind} %s refreshes real permissions after context resolution`,async mode=>{
  await grant(['printer.manage'])
  const device={code:`n-${randomUUID()}`,name:'Synthetic',stationCode:'cashier',status:'active',printBridgeId:null,windowsQueueName:null,printProfile:null}
  const create=await send('/hardware/native-management/commands',{kind:'device-create',device,reason:'Synthetic fixture'},`native-business-${randomUUID()}`)
  expect(create.statusCode,create.body).toBe(200)
  const board=(await app.inject('/hardware/native-management')).json().data,printer=board.devices.find((d:any)=>d.id===create.json().data.row.id)
  const policy=board.policies.find((p:any)=>p.ticketKind==='cashier_payment')
  const body=kind==='device-create'?{kind,device:{...device,code:`n-${randomUUID()}`},reason:'Synthetic'}:kind==='device-update'?{kind,id:printer.id,device:{...device,name:'Changed'},expected:printer.configurationFingerprint,reason:'Synthetic'}:kind==='device-test'?{kind,id:printer.id,command:'ping',expected:printer.configurationFingerprint,reason:'Synthetic'}:kind==='route-save'?{kind,expected:null,reason:'Synthetic',route:{code:`r-${randomUUID()}`,name:'Synthetic',stationCode:'cashier',productCategoryCode:null,printerDeviceId:printer.id,copies:1,priority:100,status:'active'}}:{kind,expected:policy.configurationFingerprint,policy:{ticketKind:'cashier_payment',enabled:!policy.enabled,copies:1},reason:'Synthetic'}
  const key=`native-business-${randomUUID()}`,url='/hardware/native-management/commands'
  let first:Awaited<ReturnType<typeof send>>|undefined
  if(mode==='receipt'){first=await send(url,body,key);expect(first.statusCode,first.body).toBe(200)}
  const before=await snapshot()
  try{beforeExecute=()=>grant([]);const response=await send(url,body,key);expect(response.statusCode,response.body).toBe(403);expect(await snapshot()).toEqual(before)}finally{beforeExecute=undefined;await grant(['printer.manage'])}
  if(first){const recovered=await send(url,body,key);expect(recovered.statusCode,recovered.body).toBe(200);expect(recovered.json()).toEqual({data:first.json().data,meta:{replayed:true}});expect(await snapshot()).toEqual(before)}
 })
 it.each(['receipt','fresh'])('native bridge revocation %s rechecks real permissions without repeating the action',async mode=>{
  await grant(['printer.manage'])
  const pairing=await send('/hardware/print-bridges/pairing-code',{reason:'Synthetic pairing',ttlSeconds:600});expect(pairing.statusCode,pairing.body).toBe(201)
  const paired=await send('/print-bridge/pair',{pairingCode:pairing.json().data.pairingCode,name:'Synthetic bridge',hostname:'synthetic',softwareVersion:'1.0.0'});expect(paired.statusCode,paired.body).toBe(201)
  const id=paired.json().data.bridgeId,url=`/hardware/native-print-bridges/${id}/revoke`,body={kind:'bridge-revoke',id,reason:'Synthetic revoke'},key=`native-business-${randomUUID()}`
  let first:Awaited<ReturnType<typeof send>>|undefined
  if(mode==='receipt'){first=await send(url,body,key);expect(first.statusCode,first.body).toBe(200)}
  const before=await snapshot()
  try{beforeExecute=()=>grant([]);const response=await send(url,body,key);expect(response.statusCode,response.body).toBe(403);expect(await snapshot()).toEqual(before)}finally{beforeExecute=undefined;await grant(['printer.manage'])}
  if(first){expect((await send(url,body,key)).json()).toEqual({data:first.json().data,meta:{replayed:true}});expect(await snapshot()).toEqual(before)}
 })

 it('old unpaid orders keep their existing history exception for bill requests and status reads',async()=>{
  await grant(['order.bill.print','order.history.view']);const f=await orderFixture(oldDay,false,true),key=randomUUID(),url=`/hardware/orders/${f.order}/bill`
  const first=await send(url,{},key);expect(first.statusCode,first.body).toBe(202);const before=await snapshot()
  expect((await send(url,{},key)).json()).toEqual({data:first.json().data,replayed:true})
  expect((await app.inject(`/hardware/print-requests/${first.json().data.requestId}`)).statusCode).toBe(200);expect(await snapshot()).toEqual(before)
 })
 it('native recovery rejects an employee suspended after context resolution as an invalid session',async()=>{
  await grant(['printer.manage']);const key=`native-business-${randomUUID()}`,body={kind:'device-create',device:{code:`s-${randomUUID()}`,name:'Synthetic',stationCode:'cashier',status:'active',printBridgeId:null,windowsQueueName:null,printProfile:null},reason:'Synthetic'}
  const first=await send('/hardware/native-management/commands',body,key);expect(first.statusCode,first.body).toBe(200);const before=await snapshot()
  try{beforeExecute=async()=>{await admin.query("UPDATE mbox.employees SET status='suspended' WHERE id=$1",[actor])};expect((await send('/hardware/native-management/commands',body,key)).statusCode).toBe(401);expect(await snapshot()).toEqual(before)}finally{beforeExecute=undefined;await admin.query("UPDATE mbox.employees SET status='active' WHERE id=$1",[actor])}
  expect((await send('/hardware/native-management/commands',body,key)).json()).toEqual({data:first.json().data,meta:{replayed:true}});expect(await snapshot()).toEqual(before)
 })

})
