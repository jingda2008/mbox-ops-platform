import {randomUUID} from 'node:crypto'
import Fastify,{type FastifyInstance} from 'fastify'
import {Pool} from 'pg'
import {beforeAll,afterAll,describe,it,expect} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {assertRuntimeDatabasePool} from './runtime-database-identity.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {nativeBenefitExceptionsApiPlugin} from './native-benefit-exceptions-api.js'
const database=process.env.TEST_NORMALIZED_DATABASE_URL,runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
;(database&&runtimeUrl?describe:describe.skip)('native benefit exceptions restricted transactions',()=>{
 const scope={tenantId:randomUUID(),storeId:randomUUID()},employee=randomUUID(),role=randomUUID(),area=randomUUID(),table=randomUUID(),session=randomUUID(),customer=randomUUID(),product=randomUUID()
 let admin:Pool,runtime:Pool,app:FastifyInstance
 const root='/staff/native-benefit-exceptions'
 const send=(action:string,payload:object,key=`native-business-${randomUUID()}`)=>app.inject({method:'POST',url:root+'/commands/'+action,headers:{'idempotency-key':key},payload})
 const get=async()=>{const r=await app.inject({method:'GET',url:root});expect(r.statusCode,r.body).toBe(200);return r.json().data}
 beforeAll(async()=>{
  await runNormalizedMigrations(database!);admin=new Pool({connectionString:database});runtime=new Pool({connectionString:runtimeUrl});await assertRuntimeDatabasePool(runtime,runtimeUrl!)
  await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'Benefit native')",[scope.tenantId]);await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1::uuid,$2,$1::text,'Benefit native')",[scope.storeId,scope.tenantId])
  await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,'STAFF','经理')",[employee,scope.tenantId,scope.storeId]);await admin.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'MANAGER','经理')",[role,scope.tenantId,scope.storeId]);await admin.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 day')",[scope.tenantId,scope.storeId,employee,role])
  for(const code of['loyalty.redemption.exception','table.view_all']){await admin.query('INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name) VALUES($1,$2,$3,$3) ON CONFLICT DO NOTHING',[scope.tenantId,scope.storeId,code]);await admin.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code=$4',[scope.tenantId,scope.storeId,role,code])}
  await admin.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'AREA','大厅','indoor')",[area,scope.tenantId,scope.storeId]);await admin.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,'T01','桌台',4)",[table,scope.tenantId,scope.storeId,area]);await admin.query("INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1,$2,$3,$4,'native-benefit-session','2026-10-01',2)",[session,scope.tenantId,scope.storeId,table])
  await admin.query("INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1,$2,$3,'benefit-member')",[customer,scope.tenantId,scope.storeId]);await admin.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station) VALUES($1,$2,$3,'GIFT','礼遇商品','test','bar')",[product,scope.tenantId,scope.storeId])
  const transactions=new ScopedPostgresTransactionRunner(runtime);app=Fastify();await app.register(nativeBenefitExceptionsApiPlugin,{transactions,commands:new NormalizedCommandExecutor(transactions),resolveStaffContext:()=>({scope,employeeId:employee,businessDate:'2026-10-01'})});await app.ready()
 })
 afterAll(async()=>{await app?.close();await runtime?.end();await admin?.end()})
 async function fixture(itemStatus='submitted'){
  const benefit=randomUUID(),order=randomUUID(),item=randomUUID(),intent=randomUUID()
  await admin.query("INSERT INTO mbox.benefits(id,tenant_id,store_id,customer_id,benefit_code,benefit_type,status,quantity_total,quantity_redeemed,redeemed_at) VALUES($1,$2,$3,$4,'GIFT','gift_product','redeemed',1,1,clock_timestamp())",[benefit,scope.tenantId,scope.storeId,customer])
  await admin.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,subtotal_amount_minor,discount_amount_minor,total_amount_minor,currency,created_by_employee_id,submitted_at,settlement_mode,fulfillment_state) VALUES($1::uuid,$2,$3,$4,$1::text,'cashier','submitted','paid',0,0,0,'CNY',$5,clock_timestamp(),'immediate_payment','active')",[order,scope.tenantId,scope.storeId,session,employee])
  await admin.query("INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,discount_amount_minor,total_amount_minor,currency,fulfillment_station,product_snapshot,status) VALUES($1,$2,$3,$4,$5,1,0,0,0,'CNY','bar','{}',$6)",[item,scope.tenantId,scope.storeId,order,product,itemStatus])
  await admin.query("INSERT INTO mbox.complimentary_fulfillment_intents(id,tenant_id,store_id,order_id,benefit_id,status,attempt_count,last_error_code,last_error_at) VALUES($1,$2,$3,$4,$5,'failed',10,'physical_fulfillment_lines_missing',clock_timestamp())",[intent,scope.tenantId,scope.storeId,order,benefit])
  const row=(await get()).items.find((r:any)=>r.id===intent);return{intent,order,benefit,row,body:{intentId:intent,expected:{orderId:order,benefitId:benefit,tableSessionId:session,updatedAt:row.updatedAt,attemptCount:row.attemptCount},reason:'核对原礼遇与现场实物',compensationReference:null as string|null}}
 }
 it('retries the original task once, returns old receipt after later failure and checks current table scope',async()=>{
  const f=await fixture(),key=`native-business-${randomUUID()}`,first=await send('retry',f.body,key);expect(first.statusCode,first.body).toBe(200)
  await admin.query("UPDATE mbox.complimentary_fulfillment_intents SET status='failed',attempt_count=11 WHERE id=$1",[f.intent])
  expect((await send('retry',f.body,key)).json()).toMatchObject({data:first.json().data,meta:{replayed:true,protocol:1}});expect((await send('retry',f.body)).json().error.commitDisposition).toBe('not_committed')
  expect((await admin.query('SELECT attempt_count FROM mbox.complimentary_fulfillment_intents WHERE id=$1',[f.intent])).rows[0].attempt_count).toBe(11)
  await admin.query("DELETE FROM mbox.role_permission_assignments WHERE role_id=$1 AND permission_id IN(SELECT id FROM mbox.staff_permission_definitions WHERE code='table.view_all')",[role]);expect((await send('retry',f.body,key)).statusCode).toBe(403)
  await admin.query("INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code='table.view_all'",[scope.tenantId,scope.storeId,role])
 })
 it('cancels or records actual compensation once without restoring consumed benefit or creating money',async()=>{
  for(const action of['cancel_release','external_compensation']){
   const f=await fixture(),body={...f.body,compensationReference:action==='external_compensation'?'现场补偿凭证-123':null},key=`native-business-${randomUUID()}`
   const result=await send(action,body,key);expect(result.statusCode,result.body).toBe(200);expect(result.json().data.result).toMatchObject({intentId:f.intent,orderId:f.order,benefitId:f.benefit,status:action==='cancel_release'?'cancelled':'compensated',cancelledOrderItemCount:1})
   expect((await send(action,body,key)).json().meta.replayed).toBe(true)
   expect((await admin.query('SELECT status,quantity_redeemed FROM mbox.benefits WHERE id=$1',[f.benefit])).rows[0]).toMatchObject({status:'redeemed',quantity_redeemed:1})
   expect((await admin.query('SELECT count(*)::int AS count FROM mbox.payments WHERE order_id=$1',[f.order])).rows[0].count).toBe(0)
   expect((await admin.query('SELECT count(*)::int AS count FROM mbox.complimentary_fulfillment_resolution_events WHERE intent_id=$1',[f.intent])).rows[0].count).toBe(1)
  }
 })
 it('rejects changed source and already preparing physical goods without cancelling the order',async()=>{
  const f=await fixture();await admin.query('UPDATE mbox.complimentary_fulfillment_intents SET attempt_count=11 WHERE id=$1',[f.intent]);expect((await send('cancel_release',f.body)).json().error).toMatchObject({code:'COMPLIMENTARY_FULFILLMENT_STATE_CHANGED',commitDisposition:'not_committed'})
  const started=await fixture('preparing'),reply=await send('cancel_release',started.body);expect(reply.statusCode,reply.body).toBe(409);expect(reply.json().error.code).toContain('ALREADY_PREPARING');expect((await admin.query('SELECT status FROM mbox.orders WHERE id=$1',[started.order])).rows[0].status).toBe('submitted')
 })
})
