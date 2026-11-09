import {StaffAccessRepository} from '../../server/normalized/staff-access-repository.js'
import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {ScopedPostgresTransactionRunner} from '../../server/normalized/transaction-runner.js'
import {PostgresAutomaticTableTurnoverRepository} from '../../server/normalized/automatic-table-turnover-repository.js'

/** Synthetic records, only in the browser runner's disposable localhost DB. */
export async function seedCrossDayDebtBrowserFixture(databaseUrl:string,tenantId:string,storeId:string,businessDate:string){
  const url=new URL(databaseUrl)
  if(!['localhost','127.0.0.1','::1','[::1]'].includes(url.hostname)||!url.pathname.startsWith('/mbox_normalized_browser_'))throw new Error('Disposable local browser database required')
  const pool=new Pool({connectionString:databaseUrl}),scope={tenantId,storeId},runner=new ScopedPostgresTransactionRunner(pool)
  const tableId=randomUUID(),sessionId=randomUUID(),currentSessionId=randomUUID(),orderId=randomUUID(),productId=randomUUID()
  const directOnlineOrderId=randomUUID(),directReviewOrderId=randomUUID(),reviewOrderId=randomUUID(),zeroReviewOrderId=randomUUID(),creditOrderId=randomUUID()
  const activeOrders:Array<{orderId:string;publicId:string;status:string}>=[]
  const originalBusinessDate=new Date(Date.parse(businessDate)-86400000).toISOString().slice(0,10)
  try{
    await runner.run(scope,async tx=>{
      // Production read-only inspection confirms Jerry's live collection overrides.
      // Reproduce those effective capabilities only inside this disposable fixture.
      const employees=(await tx.query<{id:string;employee_code:string}>("SELECT id,employee_code FROM mbox.employees WHERE employee_code IN('jerry','wuya')")).rows
      const employeeId=employees.find(e=>e.employee_code==='jerry')!.id,configuredByEmployeeId=employees.find(e=>e.employee_code==='wuya')!.id
      for(const permissionCode of ['payment.collect.all_tables','payment.manual.cash.record'])await new StaffAccessRepository(tx).setEmployeePermissionOverride({
        employeeId,permissionCode,effect:'grant',reason:'隔离夹具匹配线上服务员有效收款权限',configuredByEmployeeId,startsAt:new Date(Date.now()-60000).toISOString()})
      const area=(await tx.query<{id:string}>('SELECT id FROM mbox.areas WHERE tenant_id=$1 AND store_id=$2 ORDER BY id LIMIT 1',[tenantId,storeId])).rows[0]!.id
      await tx.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,'DEBT01','跨日验收桌',4)",[tableId,tenantId,storeId,area])
      const unfinishedProduct=randomUUID()
      await tx.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station,inventory_control_mode) VALUES($1,$2,$3,'PREP-COLLECT','未制作商品','test','bar','not_managed')",[unfinishedProduct,tenantId,storeId])
      for(const status of ['pending','accepted','preparing']){
        const table=randomUUID(),session=randomUUID(),order=randomUUID(),item=randomUUID(),publicId=`PREP-COLLECT-${status}`
        await tx.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,$5,$5,4)",[table,tenantId,storeId,area,`PREP-${status}`])
        await tx.query("INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1,$2,$3,$4,$5,$6,2)",[session,tenantId,storeId,table,`session-${status}`,businessDate])
        await tx.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,settlement_mode,submitted_at,subtotal_amount_minor,total_amount_minor) VALUES($1,$2,$3,$4,$5,'staff_assisted','submitted','table_tab',clock_timestamp(),6800,6800)",[order,tenantId,storeId,session,publicId])
        await tx.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot,status) VALUES($1,$2,$3,$4,$5,1,6800,6800,'bar','{"name":"制作前收款商品","inventoryControlMode":"not_managed"}','submitted')`,[item,tenantId,storeId,order,unfinishedProduct])
        await tx.query("INSERT INTO mbox.kds_tasks(tenant_id,store_id,order_item_id,station_code,quantity,status) VALUES($1,$2,$3,'bar',1,$4)",[tenantId,storeId,item,status])
        activeOrders.push({orderId:order,publicId,status})
      }
      await tx.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station,inventory_control_mode) VALUES($1,$2,$3,'DEBT-BROWSER','已消费商品','test','none','not_managed')",[productId,tenantId,storeId])
      await tx.query("INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1,$2,$3,$4,'DEBT-OLD-SESSION',$5,2)",[sessionId,tenantId,storeId,tableId,originalBusinessDate])
      await tx.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,submitted_at,subtotal_amount_minor,total_amount_minor) VALUES($1,$2,$3,$4,'DEBT-BROWSER-ORIGINAL','staff_assisted','completed',clock_timestamp(),12000,12000)",[orderId,tenantId,storeId,sessionId])
      await tx.query(`INSERT INTO mbox.order_items(tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot,status) VALUES($1,$2,$3,$4,1,12000,12000,'none','{"name":"原单已消费商品","inventoryControlMode":"not_managed"}','delivered')`,[tenantId,storeId,orderId,productId])
      for (const [reviewId,publicId] of [[directOnlineOrderId,'DEBT-BROWSER-DIRECT-ONLINE'],[directReviewOrderId,'DEBT-BROWSER-DIRECT'],[reviewOrderId,'DEBT-BROWSER-REVIEW'],[zeroReviewOrderId,'DEBT-BROWSER-NO-DEBT']]) {
        await tx.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,submitted_at,subtotal_amount_minor,total_amount_minor,note) VALUES($1,$2,$3,$4,$5,'staff_assisted','submitted',clock_timestamp(),131400,131400,'别出：隔离测试单')",[reviewId,tenantId,storeId,sessionId,publicId])
        await tx.query(`INSERT INTO mbox.order_items(tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot,status) VALUES($1,$2,$3,$4,1,131400,131400,'none','{"name":"待核对挂账商品","inventoryControlMode":"not_managed"}','submitted')`,[tenantId,storeId,reviewId,productId])
      }
      await tx.query('INSERT INTO mbox.store_automatic_table_turnover_policies(tenant_id,store_id,enabled) VALUES($1,$2,true) ON CONFLICT(tenant_id,store_id) DO UPDATE SET enabled=true',[tenantId,storeId])
      await new PostgresAutomaticTableTurnoverRepository(tx).close({scope,tableSessionId:sessionId,businessDate,reasonNote:'隔离跨日收款验收',idempotencyKey:randomUUID()})
      await tx.query("INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1,$2,$3,$4,'DEBT-NEW-SESSION',$5,3)",[currentSessionId,tenantId,storeId,tableId,businessDate])
      await tx.query('UPDATE mbox.table_sessions SET minimum_spend_minor=150000 WHERE id=$1',[currentSessionId])
      await tx.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,submitted_at,subtotal_amount_minor,total_amount_minor) VALUES($1,$2,$3,$4,'CREDIT-BROWSER-1100','staff_assisted','completed',clock_timestamp(),110000,110000)",[creditOrderId,tenantId,storeId,currentSessionId])
      await tx.query(`INSERT INTO mbox.order_items(tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot,status) VALUES($1,$2,$3,$4,1,110000,110000,'none','{"name":"员工协助点单1100元","inventoryControlMode":"not_managed"}','delivered')`,[tenantId,storeId,creditOrderId,productId])
    })
    return {directOnlineOrderId,directReviewOrderId,activeOrders,creditOrderId,reviewOrderId,zeroReviewOrderId,orderId,publicId:'DEBT-BROWSER-ORIGINAL',originalBusinessDate,tableId,originalSessionId:sessionId,currentSessionId,amountMinor:12000}
  }finally{await pool.end()}
}
