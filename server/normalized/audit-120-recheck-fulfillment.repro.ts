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
import {ServiceTaskRepository} from './service-task-repository.js'
import {OperationsQueryService} from './operations-query-service.js'
import {PostgresTableCustomerLeftTurnoverRepository} from './table-customer-left-turnover-repository.js'
import {actionableServiceTasks} from '../../src/normalized-ui/staff-actions/staff-actions-model.js'
import {prioritizeActionFact} from '../../src/normalized-ui/staff-actions/StaffActionsPanel.js'
import {PaymentCommandService,type RecordManualPaymentCommand} from './payment-command-service.js'
import {pickupWorkflowApiPlugin} from './pickup-workflow-api.js'
import type {PickupBoardData,PickupCommand} from '../../src/shared/pickup-workflow.js'
import {kitchenProductionApiPlugin} from './kitchen-production-api.js'
import {kitchenCompatibilityKey,type KitchenBoardData,type KitchenCommand} from '../../src/shared/kitchen-production.js'

const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const integration=databaseUrl?describe:describe.skip
integration('120 guests recheck defects on frozen f8306c7 current three-screen routes',()=>{
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
  afterAll(async()=>{await app.close();await pool?.end()})
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
  it('reproduces urgent complaint hidden behind eight assigned ordinary requests on service page',async()=>{
    const serviceRows=[]
    for(let index=0;index<24;index++)serviceRows.push(await item())
    const taskIds=[]
    for(let index=0;index<120;index++){
      const row=serviceRows[Math.floor(index/5)]!
      const task=await runtime.run(scope,tx=>new ServiceTaskRepository(tx).create({tableId:row.tableId,tableSessionId:row.tableSessionId,publicId:randomUUID(),taskType:index===119?'guest.complaint':'guest.custom',title:index===119?'紧急投诉需要店长':'普通送水需求',priority:index===119?'urgent':'normal',source:'guest',requestedRoleCode:index===119?'MANAGER':'SERVER',assignedEmployeeId:index<8?employeeId:null,actor:{type:'guest'}}))
      taskIds.push(task.id)
    }
    const data=await new OperationsQueryService(runtime).getStaffView(scope,employeeId)
    const selected=data.tasks.filter(task=>taskIds.includes(task.id))
    expect(selected).toHaveLength(120)
    expect(selected[0]?.id).toBe(taskIds[119])
    const pageOrder=actionableServiceTasks(selected,employeeId)
    expect(pageOrder.findIndex(task=>task.id===taskIds[119])).toBe(8)
    const visible=prioritizeActionFact(pageOrder,null,task=>task.id)
    expect(visible).toHaveLength(8)
    expect(visible.some(task=>task.id===taskIds[119])).toBe(false)
    console.log('SIM120-08',JSON.stringify({serverTaskCount:selected.length,serverUrgentIndex:0,pageUrgentIndex:8,defaultVisible:visible.length,urgentVisible:false,defectReproduced:true}))
    // Existing home-workbench deep link is a valid fallback, so this is not global data loss.
    expect(prioritizeActionFact(pageOrder,taskIds[119]!,task=>task.id)[0]?.id).toBe(taskIds[119])
  },120000)

  it('reproduces unresolved complaint cancellation by customer-left turnover without manager resolution',async()=>{
    const tableId=await table(),sessionId=randomUUID()
    await pool.query('INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1,$2,$3,$4,$5,$6,5)',[sessionId,tenantId,storeId,tableId,randomUUID(),businessDate])
    const complaint=await runtime.run(scope,tx=>new ServiceTaskRepository(tx).create({tableId,tableSessionId:sessionId,publicId:randomUUID(),taskType:'guest.complaint',title:'食品异物投诉要求后续答复',detail:'客人急事先走，投诉仍须跟进',priority:'urgent',source:'guest',requestedRoleCode:'MANAGER',actor:{type:'guest'}}))
    const turnoverEmployee=randomUUID(),turnoverRole=randomUUID()
    await pool.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,'turnover-only','只有翻台权的服务员')",[turnoverEmployee,tenantId,storeId])
    await pool.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'TURNOVER_ONLY','翻台服务员')",[turnoverRole,tenantId,storeId])
    await pool.query('INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,clock_timestamp())',[tenantId,storeId,turnoverEmployee,turnoverRole])
    await pool.query("INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code IN ('table.close','table.turnover_unsettled')",[tenantId,storeId,turnoverRole])
    await pool.query("INSERT INTO mbox.table_assignments(tenant_id,store_id,table_id,employee_id,role_id,assignment_type,starts_at,reason) VALUES($1,$2,$3,$4,$5,'primary',clock_timestamp(),'隔离现场分工核验')",[tenantId,storeId,tableId,turnoverEmployee,turnoverRole])
    const permission=await runtime.run(scope,tx=>tx.query("SELECT mbox.employee_has_effective_permission($1,$2,$3,'service.manage') AS allowed",[tenantId,storeId,turnoverEmployee]))
    expect(permission.rows[0]?.allowed).toBe(false)
    const result=await runtime.run(scope,tx=>new PostgresTableCustomerLeftTurnoverRepository(tx).close({scope,tableSessionId:sessionId,employeeId:turnoverEmployee,businessDate,reasonNote:'顾客已经离店立即翻台',idempotencyKey:randomUUID()}))
    expect(result.cancelledServiceTaskCount).toBe(1)
    expect((await runtime.run(scope,tx=>new ServiceTaskRepository(tx).findById(complaint.id)))?.status).toBe('cancelled')
    expect((await new OperationsQueryService(runtime).getStaffView(scope,employeeId)).tasks.some(task=>task.id===complaint.id)).toBe(false)
    const events=await pool.query('SELECT event_type,note FROM mbox.service_task_events WHERE service_task_id=$1 ORDER BY occurred_at',[complaint.id])
    expect(events.rows.map(event=>event.event_type)).toEqual(['task.created','customer_left_cancelled'])
    expect(events.rows[1]?.note).toBe('顾客已经离店立即翻台')
    console.log('SIM120-09',JSON.stringify({serviceManage:false,cancelledServiceTaskCount:result.cancelledServiceTaskCount,complaintStatus:'cancelled',events:events.rows,defectReproduced:true}))
  },30000)

  for(const currentPath of ['kitchen-ready','pickup-take'] as const)it(`SIM120-11 reproduces cash versus current ${currentPath} deadlock, then verifies same-key recovery`,async()=>{
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
    let orderLocked!:()=>void,sessionLocked!:()=>void,active=true
    const hasOrder=new Promise<void>(resolve=>{orderLocked=resolve}),hasSession=new Promise<void>(resolve=>{sessionLocked=resolve})
    const trace:string[]=[],databaseErrors:Array<{lane:string;code:unknown;message:unknown;detail:unknown}>=[]
    const wrapped=(lane:'cash'|'fulfillment')=>({run:<T>(s:StoreScope,operation:(tx:ScopedTransaction)=>Promise<T>,options?:TransactionOptions)=>runtime.run(s,async tx=>{
      if(active&&lane==='fulfillment')await hasOrder
      const hooked={...tx,query:async(sql:string,values?:readonly unknown[])=>{
        try{
          const result=await tx.query(sql,values)
          if(active&&lane==='cash'&&sql.includes('FOR SHARE OF ordering')){trace.push('cash holds order SHARE');orderLocked();await hasSession}
          if(active&&lane==='fulfillment'&&sql.includes('FROM mbox.table_sessions')&&sql.includes('FOR SHARE')){trace.push(`${currentPath} holds table session SHARE`);sessionLocked()}
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
      console.log('SIM120-11 initial',JSON.stringify({currentPath,trace,databaseErrors,cash:cash.status==='fulfilled'?{status:'fulfilled',paymentId:cash.value.value.id}:{status:'rejected',code:cash.reason.code,message:cash.reason.message},http,defectReproduced:databaseErrors.some(error=>error.code==='40P01')}))
      expect(databaseErrors.filter(error=>error.code==='40P01')).toHaveLength(1)
      expect(trace.slice(0,2)).toEqual(['cash holds order SHARE',`${currentPath} holds table session SHARE`])
      expect(Number(cash.status==='fulfilled')+Number(http?.statusCode===200)).toBe(1)
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
      console.log('SIM120-11 recovery',JSON.stringify({currentPath,payments:payments.rows,units:units.rows,sameKeyCashReplay:replayCash.replayed,sameKeyFulfillmentStatus:replayFulfillment.statusCode,secondDeliveryConfirmationRequired:false}))
    }finally{active=false;orderLocked();sessionLocked();await concurrentApp.close()}
  },30000)
})
