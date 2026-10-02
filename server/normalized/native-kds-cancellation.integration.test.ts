import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import Fastify from 'fastify'
import {beforeAll,afterAll,describe,it,expect} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner,type PostgresPool} from './transaction-runner.js'
import {assertRuntimeDatabasePool} from './runtime-database-identity.js'
import {KdsRepository} from './kds-repository.js'
import {OrderRepository} from './order-repository.js'
import {FulfillmentQueryService} from './fulfillment-query-service.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {commerceKdsApiPlugin} from './commerce-kds-api.js'
const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL,runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
const integration=databaseUrl&&runtimeUrl?describe:describe.skip
integration('native legacy failed KDS termination under actual runtime login',()=>{
  const tenantId = randomUUID()
  const storeId = randomUUID()
  const areaId = randomUUID()
  const tableId = randomUUID()
  const sessionId = randomUUID()
  const employeeId = randomUUID()
  const roleId = randomUUID()
  const productId = randomUUID()
  const orderId = randomUUID()
  const orderItemId = randomUUID()
  const taskId = randomUUID()
  let pool: Pool
  let transactions: ScopedPostgresTransactionRunner

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 4 })
    transactions = new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Closed KDS Tenant')`, [
      tenantId, `closed-kds-${tenantId.slice(0, 8)}`,
    ])
    await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,$3,'Closed KDS Store')`, [
      storeId, tenantId, `closed-kds-${storeId.slice(0, 8)}`,
    ])
    await pool.query(`INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type,sort_order)
      VALUES($1,$2,$3,'MAIN','主区','indoor',1)`, [areaId, tenantId, storeId])
    await pool.query(`INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity)
      VALUES($1,$2,$3,$4,'K01','K01',4)`, [tableId, tenantId, storeId, areaId])
    await pool.query(`INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name)
      VALUES($1,$2,$3,'manager','值班经理')`, [employeeId, tenantId, storeId])
    await pool.query(`INSERT INTO mbox.roles(id,tenant_id,store_id,code,name)
      VALUES($1,$2,$3,'MANAGER','值班经理')`, [roleId, tenantId, storeId])
    await pool.query(`INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id)
      VALUES($1,$2,$3,$4)`, [tenantId, storeId, employeeId, roleId])
    await pool.query(`INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name)
      VALUES($1,$2,'kds.exception.manage','处理出品异常')
      ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET status='active'`, [tenantId, storeId])
    await pool.query(`INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
      SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions
      WHERE tenant_id=$1 AND store_id=$2 AND code='kds.exception.manage'`, [tenantId, storeId, roleId])
    await pool.query(`INSERT INTO mbox.table_sessions(
      id,tenant_id,store_id,table_id,public_id,business_date,guest_count,capacity_at_open,
      guest_profile_snapshot,status,opened_by_employee_id
    ) VALUES($1,$2,$3,$4,$5,current_date-1,2,4,'{}','open',$6)`, [
      sessionId, tenantId, storeId, tableId, `session-${randomUUID()}`, employeeId,
    ])
    await pool.query(`INSERT INTO mbox.products(
      id,tenant_id,store_id,code,name,category_code,fulfillment_station,product_snapshot
    ) VALUES($1,$2,$3,$4,'历史测试品项','food','kitchen','{}')`, [
      productId, tenantId, storeId, `P-${randomUUID().slice(0, 8)}`,
    ])
    await pool.query(`INSERT INTO mbox.orders(
      id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,
      subtotal_amount_minor,discount_amount_minor,total_amount_minor
    ) VALUES($1,$2,$3,$4,$5,'staff_assisted','submitted','unpaid',100,0,100)`, [
      orderId, tenantId, storeId, sessionId, `order-${randomUUID()}`,
    ])
    await pool.query(`INSERT INTO mbox.order_items(
      id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,discount_amount_minor,
      total_amount_minor,fulfillment_station,product_snapshot,status
    ) VALUES($1,$2,$3,$4,$5,1,100,0,100,'kitchen','{}','submitted')`, [
      orderItemId, tenantId, storeId, orderId, productId,
    ])
    await pool.query(`INSERT INTO mbox.kds_tasks(
      id,tenant_id,store_id,order_item_id,station_code,status,quantity
    ) VALUES($1,$2,$3,$4,'kitchen','failed',1)`, [taskId, tenantId, storeId, orderItemId])
    await pool.query(`INSERT INTO mbox.kds_exceptions(tenant_id,store_id,kds_task_id,order_item_id,exception_type,reason_code,reason_note,required_actions,reported_by_employee_id) VALUES($1,$2,$3,$4,'production_failed','ingredient_missing','原商品缺料','["manager_review","inventory_review"]',$5)`,[tenantId,storeId,taskId,orderItemId,employeeId])
    await pool.query(`INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name) VALUES($1,$2,'fulfillment.view_all','查看全店履约') ON CONFLICT DO NOTHING`,[tenantId,storeId])
    await pool.query(`INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code='fulfillment.view_all'`,[tenantId,storeId,roleId])
    await pool.query("UPDATE mbox.employee_roles SET starts_at=clock_timestamp()-interval '1 hour' WHERE employee_id=$1",[employeeId])
    await pool.query(`UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp()
      WHERE id=$1`, [sessionId])
  })

  afterAll(async () => { await pool?.end() })

  it('keeps failure history and financial facts, exposes manager action, then replays exactly once',async()=>{
    const scope={tenantId,storeId},credentialId=randomUUID(),leaseId=randomUUID(),staffSessionId=randomUUID()
    await pool.query("INSERT INTO mbox.store_daily_credentials(id,tenant_id,store_id,business_date,credential_hash,valid_from,valid_until,configured_by_employee_id) VALUES($1,$2,$3,current_date,'scrypt$native-failed-kds',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '8 hours',$4)",[credentialId,tenantId,storeId,employeeId])
    await pool.query("INSERT INTO mbox.store_device_access_leases(id,tenant_id,store_id,daily_credential_id,business_date,device_key_hash,lease_token_hash,issued_at,expires_at) VALUES($1,$2,$3,$4,current_date,repeat(md5($1::uuid::text||'device'),2),repeat(md5($1::uuid::text||'lease'),2),clock_timestamp()-interval '1 hour',clock_timestamp()+interval '8 hours')",[leaseId,tenantId,storeId,credentialId])
    await pool.query("INSERT INTO mbox.staff_sessions(id,tenant_id,store_id,employee_id,device_access_lease_id,session_token_hash,issued_at,expires_at,online_lease_until) VALUES($1,$2,$3,$4,$5,repeat(md5($1::uuid::text||'session'),2),statement_timestamp(),statement_timestamp()+interval '6 hours',statement_timestamp()+interval '30 minutes')",[staffSessionId,tenantId,storeId,employeeId,leaseId])
    const runtimePool=new Pool({connectionString:runtimeUrl}),runner=new ScopedPostgresTransactionRunner(runtimePool);await assertRuntimeDatabasePool(runtimePool,runtimeUrl!)
    const day=await runner.run(scope,async tx=>(await tx.query<{day:string}>('SELECT mbox.current_operating_business_date($1,$2)::text AS day',[tenantId,storeId])).rows[0]!.day)
    const query=new FulfillmentQueryService(runner),context={scope,employeeId,staffSessionId,deviceAccessLeaseId:leaseId,businessDate:day},app=Fastify()
    await app.register(commerceKdsApiPlugin,{commerce:{submitOrder:async()=>{throw new Error('not used')}},fulfillmentQuery:query,commandExecutor:new NormalizedCommandExecutor(runner),staffAccessTransactions:runner,resolveContext:()=>context,createKdsRepository:tx=>new KdsRepository(tx),createOrderRepository:tx=>new OrderRepository(tx)})
    const key='native-fulfillment-'+randomUUID(),request={method:'POST' as const,url:`/commerce/native-kds/${taskId}/manager-cancel`,headers:{'idempotency-key':key},payload:{actorId:employeeId,reasonCode:'production_exception',reason:'主管核对不再重做，原账与库存另行复核'}}
    try{
      const before=await query.getStaffWorkQueue(scope,employeeId,day,{staffSessionId,deviceAccessLeaseId:leaseId});expect(before.workItems.find(r=>r.taskId===taskId)).toMatchObject({canManagerCancel:true,canRemake:false,kdsStatus:'failed'})
      await expect(runner.run(scope,tx=>tx.query("UPDATE mbox.kds_tasks SET status='cancelled',cancelled_at=clock_timestamp() WHERE id=$1",[taskId]))).rejects.toMatchObject({code:'55000'})
      await expect(runner.run(scope,async tx=>{await tx.query("SELECT set_config('app.kds_manager_cancel_task_id',$1,true)",[taskId]);await tx.query("UPDATE mbox.kds_tasks SET status='ready',ready_at=clock_timestamp() WHERE id=$1",[taskId])})).rejects.toMatchObject({code:'55000'})
      const first=await app.inject(request);expect(first.statusCode,first.body).toBe(200);expect(first.json()).toMatchObject({id:taskId,normalizedStatus:'cancelled',orderId,orderItemId})
      await pool.query('DELETE FROM mbox.idempotency_records WHERE tenant_id=$1 AND store_id=$2 AND idempotency_key=$3',[tenantId,storeId,key]);const retry=await app.inject(request);expect(retry.statusCode,retry.body).toBe(200);expect(retry.json().meta.replayed).toBe(true)
      expect((await pool.query("SELECT count(*)::int n FROM mbox.kds_task_events WHERE kds_task_id=$1 AND from_status='failed' AND to_status='cancelled'",[taskId])).rows[0].n).toBe(1)
      expect((await pool.query('SELECT status,payment_status,total_amount_minor FROM mbox.orders WHERE id=$1',[orderId])).rows[0]).toMatchObject({status:'submitted',payment_status:'unpaid',total_amount_minor:'100'})
      expect((await pool.query("SELECT status,financial_truth_status,inventory_truth_status FROM mbox.kds_exceptions WHERE kds_task_id=$1 AND exception_type='production_failed'",[taskId])).rows[0]).toMatchObject({status:'remediating',financial_truth_status:'unchanged_pending_review',inventory_truth_status:'unchanged_pending_review'})
      expect((await query.getStaffWorkQueue(scope,employeeId,day,{staffSessionId,deviceAccessLeaseId:leaseId})).workItems.some(r=>r.taskId===taskId)).toBe(false)
      await pool.query('UPDATE mbox.staff_sessions SET revoked_at=clock_timestamp() WHERE id=$1',[staffSessionId]);expect((await app.inject(request)).statusCode).toBe(403)
    }finally{await app.close();await runtimePool.end()}
  })
})
