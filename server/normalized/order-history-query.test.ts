import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {afterAll,beforeAll,describe,it,expect} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {readOperatingHistory} from './operating-history-query.js'
import {OperationsQueryService} from './operations-query-service.js'
import {ScopedPostgresTransactionRunner,type PostgresPool} from './transaction-runner.js'
import Fastify from 'fastify'
import {hardwareApiPlugin} from './hardware-api.js'
import {NormalizedCommandExecutor} from './command-executor.js'

const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const integration=databaseUrl?describe:describe.skip
integration('order history SQL scope and session identity',()=>{
 const scope={tenantId:randomUUID(),storeId:randomUUID()}
 const reader=randomUUID(),manager=randomUUID(),denied=randomUUID()
 let pool:Pool,transactions:ScopedPostgresTransactionRunner
 beforeAll(async()=>{
  await runNormalizedMigrations(databaseUrl!)
  pool=new Pool({connectionString:databaseUrl,max:2})
  transactions=new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
  const area=randomUUID(),table=randomUUID(),product=randomUUID()
  await pool.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'History test')",[scope.tenantId,`history-${scope.tenantId}`])
  await pool.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,'history','History store')",[scope.storeId,scope.tenantId])
  for(const [id,code,permission] of [[reader,'READER','order.history.view'],[manager,'MANAGER','order.history.all'],[denied,'DENIED',null]] as const){
   const role=randomUUID()
   await pool.query('INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,$4,$4)',[id,scope.tenantId,scope.storeId,code])
   await pool.query('INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,$4,$4)',[role,scope.tenantId,scope.storeId,code])
   await pool.query('INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id) VALUES($1,$2,$3,$4)',[scope.tenantId,scope.storeId,id,role])
   if(permission)await pool.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code=$4',[scope.tenantId,scope.storeId,role,permission])
  }
  await pool.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'TEST','大厅','indoor')",[area,scope.tenantId,scope.storeId])
  await pool.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,'W01','W01',4)",[table,scope.tenantId,scope.storeId,area])
  await pool.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station) VALUES($1,$2,$3,'TEST','测试酒','drink','bar')",[product,scope.tenantId,scope.storeId])
  for(const [index,date,payment] of [[1,'2026-09-01','paid'],[2,'2026-09-01','unpaid'],[3,'2026-09-10','paid']] as const){
   const session=randomUUID(),order=randomUUID()
   await pool.query("INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,status,guest_count) VALUES($1,$2,$3,$4,$5,$6,'open',2)",[session,scope.tenantId,scope.storeId,table,`history-session-${index}`,date])
   await pool.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,subtotal_amount_minor,total_amount_minor,submitted_at) VALUES($1,$2,$3,$4,$5,'staff_assisted','fulfilling',$6,13600,13600,clock_timestamp())",[order,scope.tenantId,scope.storeId,session,`history-order-${index}`,payment])
   await pool.query("INSERT INTO mbox.order_items(tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot,status) VALUES($1,$2,$3,$4,1,13600,13600,'bar','{\"name\":\"测试酒\"}','submitted')",[scope.tenantId,scope.storeId,order,product])
   if(payment==='paid')await pool.query(`INSERT INTO mbox.payments(tenant_id,store_id,order_id,public_id,provider,method,amount_minor,currency,status,succeeded_at,provider_transaction_id)
     VALUES($1,$2,$3,$4,'cash','cash',13600,'CNY','succeeded',clock_timestamp(),$4)`,[scope.tenantId,scope.storeId,order,`history-payment-${index}`])
   await pool.query("UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp() WHERE id=$1",[session])
  }
 })
 afterAll(async()=>{await pool?.end()})
 const read=(extra:Record<string,unknown>={})=>transactions.run(scope,tx=>readOperatingHistory(tx,{
  businessDate:'2026-09-01',endDate:'2026-09-10',table:'',employee:'',page:0,
  earliestBusinessDate:'2026-09-08',allowFinancialSummary:false,...extra,
 }),{readOnly:true,isolation:'repeatable-read'})
 it('hides old settled orders but retains old unpaid without exposing store ledger',async()=>{
  const result=await read()
  expect(result.orders.map(order=>order.publicId).sort()).toEqual(['history-order-2','history-order-3'])
  expect(result.receipts).toEqual([])
  expect(result.financialSummaryVisible).toBe(false)
  expect(result.orders[0].items[0].name).toBe('测试酒')
  expect(new Set(result.orders.map(order=>order.tableSessionId)).size).toBe(2)
 })
 it('allows all-history scope and applies amount, status, area and parameterized search',async()=>{
  expect((await read({earliestBusinessDate:null})).orders).toHaveLength(3)
  expect((await read({search:'136.00',area:'大厅',paymentStatus:'paid'})).orders.map(order=>order.publicId)).toEqual(['history-order-3'])
  expect((await read({search:"' OR 1=1 --"})).orders).toEqual([])
 })
 it('keeps older unresolved orders in the current-day view and export',async()=>{
  const result=await read({businessDate:'2026-09-10',exportAll:true})
  expect(result.orders).toHaveLength(2)
  expect(result.hasMore).toBe(false)
 })
 it('enforces fresh account permissions and ignores caller-supplied scope overrides',async()=>{
  const service=new OperationsQueryService(transactions)
  const filter={businessDate:'2026-09-01',endDate:'2026-09-10',table:'',employee:'',page:0,earliestBusinessDate:null,allowFinancialSummary:true}
  await expect(service.getOperatingHistory(scope,denied,filter)).rejects.toThrow('查询权限')
  const scoped=await service.getOperatingHistory(scope,reader,filter)
  expect(scoped.receipts).toEqual([])
  expect(scoped.financialSummaryVisible).toBe(false)
  expect((await service.getOperatingHistory(scope,manager,filter)).orders).toHaveLength(3)
 })
 it('requires independent print authority, retains history scope and replays one bill request without duplicating paper jobs',async()=>{
  const app=Fastify()
  await app.register(hardwareApiPlugin,{transactions,commands:new NormalizedCommandExecutor(transactions),
   resolveContext:()=>({scope,employeeId:reader,businessDate:'2026-09-10',capabilities:['order.history.view','order.bill.print']})})
  try{
   const orders=(await pool.query('SELECT id,public_id FROM mbox.orders WHERE tenant_id=$1 AND store_id=$2',[scope.tenantId,scope.storeId])).rows
   const current=orders.find(row=>row.public_id==='history-order-3')!.id
   const old=orders.find(row=>row.public_id==='history-order-1')!.id
   const send=(id:string,key:string)=>app.inject({method:'POST',url:`/hardware/orders/${id}/bill`,payload:{},headers:{'idempotency-key':key}})
   expect((await send(current,'manual-bill-permission-test')).statusCode).toBe(403)
   await pool.query(`INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
    SELECT er.tenant_id,er.store_id,er.role_id,p.id FROM mbox.employee_roles er JOIN mbox.staff_permission_definitions p
    ON p.tenant_id=er.tenant_id AND p.store_id=er.store_id AND p.code='order.bill.print'
    WHERE er.tenant_id=$1 AND er.store_id=$2 AND er.employee_id=$3`,[scope.tenantId,scope.storeId,reader])
   expect((await send(old,'manual-bill-old-history-test')).statusCode).toBe(403)
   const device=randomUUID()
   await pool.query("INSERT INTO mbox.devices(id,tenant_id,store_id,code,name,device_type,station_code,connectivity_status) VALUES($1,$2,$3,'HISTORY-PRINT','账单打印机','printer','cashier','offline')",[device,scope.tenantId,scope.storeId])
   await pool.query("INSERT INTO mbox.printer_routes(tenant_id,store_id,code,name,station_code,printer_device_id) VALUES($1,$2,'HISTORY-BILL','账单','cashier',$3)",[scope.tenantId,scope.storeId,device])
   const first=await send(current,'manual-bill-once-test')
   expect(first.statusCode,first.body).toBe(202)
   const again=await send(current,'manual-bill-once-test')
   expect(again.statusCode,again.body).toBe(200)
   expect(again.json().data.jobIds).toEqual(first.json().data.jobIds)
   expect(again.json().replayed).toBe(true)
   const counts=await pool.query('SELECT count(*)::int AS n FROM mbox.print_jobs WHERE tenant_id=$1 AND store_id=$2',[scope.tenantId,scope.storeId])
   expect(counts.rows[0].n).toBe(1)
  }finally{await app.close()}
 })
})
