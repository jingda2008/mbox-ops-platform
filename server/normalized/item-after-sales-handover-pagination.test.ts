import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ItemAfterSalesHandoverQuery} from './item-after-sales-handover-query.js'
import {ItemQuantityRepository} from './item-quantity-repository.js'
import {ScopedPostgresTransactionRunner} from './transaction-runner.js'

const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const integration=databaseUrl?describe:describe.skip

// Use an isolated store with an exact three-case queue. The old regression
// paginated all earlier lifecycle tests' accumulated cases at two rows per
// page, so its runtime and prerequisites depended on unrelated test order.
integration('quantity after-sales handover pagination',()=>{
  let pool:Pool,runner:ScopedPostgresTransactionRunner
  const tenantId=randomUUID(),storeId=randomUUID(),tableId=randomUUID(),sessionId=randomUUID(),productId=randomUUID()
  const employeeId=randomUUID(),outsiderId=randomUUID(),reviewerId=randomUUID(),scope={tenantId,storeId}
  beforeAll(async()=>{
    await runNormalizedMigrations(databaseUrl!)
    pool=new Pool({connectionString:databaseUrl,max:4});runner=new ScopedPostgresTransactionRunner(pool)
    await pool.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Pagination test')",[tenantId,`pagination-${tenantId}`])
    await pool.query("INSERT INTO mbox.stores(id,tenant_id,code,name,timezone,business_day_cutoff) VALUES($1,$2,'pagination','Pagination store','Asia/Shanghai','06:00')",[storeId,tenantId])
    const areaId=randomUUID()
    await pool.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'Q','Q','indoor')",[areaId,tenantId,storeId])
    await pool.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,'Q01','Q01',8)",[tableId,tenantId,storeId,areaId])
    await pool.query("INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1,$2,$3,$4,$5,'2026-09-13',2)",[sessionId,tenantId,storeId,tableId,`pagination-${sessionId}`])
    await pool.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station) VALUES($1,$2,$3,'WATER','水','drink','bar')",[productId,tenantId,storeId])
    for(const [id,permission] of [[employeeId,'refund.request'],[outsiderId,'refund.request'],[reviewerId,'refund.approve']]){
      const roleId=randomUUID()
      await pool.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,$4,'Pagination employee')",[id,tenantId,storeId,`P-${id}`])
      await pool.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,$4,'Pagination role')",[roleId,tenantId,storeId,`P_${roleId.replaceAll('-','').toUpperCase()}`])
      await pool.query('INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id) VALUES($1,$2,$3,$4)',[tenantId,storeId,id,roleId])
      const permissionId=(await pool.query("INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category) VALUES($1,$2,$3,$3,'operations') ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET name=EXCLUDED.name RETURNING id",[tenantId,storeId,permission])).rows[0].id
      await pool.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[tenantId,storeId,roleId,permissionId])
    }
  })
  afterAll(async()=>{await pool?.end()})

  async function pausedCase(requesterId:string){
    const orderId=randomUUID(),itemId=randomUUID(),taskId=randomUUID()
    await pool.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,submitted_at,subtotal_amount_minor,total_amount_minor) VALUES($1,$2,$3,$4,$5,'staff_assisted','submitted',clock_timestamp(),4000,4000)",[orderId,tenantId,storeId,sessionId,`pagination-${orderId}`])
    await pool.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot) VALUES($1,$2,$3,$4,$5,5,800,4000,'bar','{"name":"水","inventoryControlMode":"not_managed"}')`,[itemId,tenantId,storeId,orderId,productId])
    await pool.query("INSERT INTO mbox.kds_tasks(id,tenant_id,store_id,order_item_id,station_code,quantity,status) VALUES($1,$2,$3,$4,'bar',5,'pending')",[taskId,tenantId,storeId,itemId])
    return runner.run(scope,tx=>new ItemQuantityRepository(tx).hold({orderItemId:itemId,quantity:1,kind:'paid_return',employeeId:requesterId,businessDate:'2026-09-12',reason:'上个营业日遗留暂停'}))
  }

  it('keeps rejected paused cases until explicit resume, with complete pagination and employee scope',async()=>{
    const first=await pausedCase(employeeId),second=await pausedCase(employeeId),created=await pausedCase(outsiderId)
    await runner.run(scope,tx=>new ItemQuantityRepository(tx).decide({caseId:created.caseId,employeeId:reviewerId,decision:'rejected',reason:'保留商品但尚未确认继续'}))
    const query=new ItemAfterSalesHandoverQuery(runner),own=await query.list({scope,employeeId:outsiderId,limit:1})
    expect(own.items.map(item=>item.caseId)).toEqual([created.caseId])
    expect(own.items[0]).toMatchObject({businessDate:'2026-09-12',status:'rejected',heldQuantity:1})
    expect(own.nextCursor).toBeNull()
    const page1=await query.list({scope,employeeId:reviewerId,limit:2})
    expect(page1.items).toHaveLength(2);expect(page1.nextCursor).not.toBeNull()
    const page2=await query.list({scope,employeeId:reviewerId,limit:2,cursor:page1.nextCursor!})
    expect(page2.items).toHaveLength(1);expect(page2.nextCursor).toBeNull()
    const allIds=[...page1.items,...page2.items].map(item=>item.caseId)
    expect(allIds.toSorted()).toEqual([first.caseId,second.caseId,created.caseId].toSorted())
    expect(new Set(allIds).size).toBe(3)
    await runner.run(scope,tx=>new ItemQuantityRepository(tx).resume({caseId:created.caseId,employeeId:outsiderId}))
    expect((await query.list({scope,employeeId:outsiderId})).items).toHaveLength(0)
    expect((await query.list({scope,employeeId:reviewerId})).items.map(item=>item.caseId).toSorted()).toEqual([first.caseId,second.caseId].toSorted())
  })
})
