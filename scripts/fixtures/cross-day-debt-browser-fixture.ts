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
  const reviewOrderId=randomUUID(),zeroReviewOrderId=randomUUID(),creditOrderId=randomUUID()
  const originalBusinessDate=new Date(Date.parse(businessDate)-86400000).toISOString().slice(0,10)
  try{
    await runner.run(scope,async tx=>{
      const area=(await tx.query<{id:string}>('SELECT id FROM mbox.areas WHERE tenant_id=$1 AND store_id=$2 ORDER BY id LIMIT 1',[tenantId,storeId])).rows[0]!.id
      await tx.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,'DEBT01','跨日验收桌',4)",[tableId,tenantId,storeId,area])
      await tx.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station,inventory_control_mode) VALUES($1,$2,$3,'DEBT-BROWSER','已消费商品','test','none','not_managed')",[productId,tenantId,storeId])
      await tx.query("INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1,$2,$3,$4,'DEBT-OLD-SESSION',$5,2)",[sessionId,tenantId,storeId,tableId,originalBusinessDate])
      await tx.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,submitted_at,subtotal_amount_minor,total_amount_minor) VALUES($1,$2,$3,$4,'DEBT-BROWSER-ORIGINAL','staff_assisted','completed',clock_timestamp(),12000,12000)",[orderId,tenantId,storeId,sessionId])
      await tx.query(`INSERT INTO mbox.order_items(tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot,status) VALUES($1,$2,$3,$4,1,12000,12000,'none','{"name":"原单已消费商品","inventoryControlMode":"not_managed"}','delivered')`,[tenantId,storeId,orderId,productId])
      for (const [reviewId,publicId] of [[reviewOrderId,'DEBT-BROWSER-REVIEW'],[zeroReviewOrderId,'DEBT-BROWSER-NO-DEBT']]) {
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
    return {creditOrderId,reviewOrderId,zeroReviewOrderId,orderId,publicId:'DEBT-BROWSER-ORIGINAL',originalBusinessDate,tableId,originalSessionId:sessionId,currentSessionId,amountMinor:12000}
  }finally{await pool.end()}
}
