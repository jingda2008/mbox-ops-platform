import {randomUUID} from 'node:crypto'
import {Client} from 'pg'

/** Isolated browser fixture only. Its not-managed items do not establish inventory acceptance. */
export async function seedThreeScreenBrowserFixture(databaseUrl:string,tenantId:string,storeId:string,businessDate:string){
  const db=new Client({connectionString:databaseUrl});await db.connect()
  try{
    await db.query('BEGIN')
    const areaId=(await db.query('SELECT id FROM mbox.areas WHERE tenant_id=$1 AND store_id=$2 ORDER BY id LIMIT 1',[tenantId,storeId])).rows[0].id
    const waiter=(await db.query("SELECT id FROM mbox.employees WHERE tenant_id=$1 AND store_id=$2 AND employee_code='tom'",[tenantId,storeId])).rows[0].id
    const role=(await db.query('SELECT role_id FROM mbox.employee_roles WHERE tenant_id=$1 AND store_id=$2 AND employee_id=$3 ORDER BY starts_at LIMIT 1',[tenantId,storeId,waiter])).rows[0].role_id
    const products={bar:{id:randomUUID(),name:'三屏测试鸡尾酒'},kitchen:{id:randomUUID(),name:'三屏测试小食'}}
    for(const station of ['bar','kitchen'] as const)await db.query(`INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station,inventory_control_mode)
      VALUES($1,$2,$3,$4,$5,'test',$6,'not_managed')`,[products[station].id,tenantId,storeId,`THREE-SCREEN-${station}`,products[station].name,station])
    const tables=[]
    for(let index=0;index<20;index++){
      const tableId=randomUUID(),sessionId=randomUUID(),code=`TS${String(index+1).padStart(2,'0')}`
      await db.query('INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,$5,$5,8)',[tableId,tenantId,storeId,areaId,code])
      await db.query("INSERT INTO mbox.table_assignments(tenant_id,store_id,table_id,employee_id,role_id,assignment_type,starts_at,reason,created_by_employee_id) VALUES($1,$2,$3,$4,$5,'primary',clock_timestamp()-interval '1 hour','三屏隔离验收',$4)",[tenantId,storeId,tableId,waiter,role])
      await db.query('INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1,$2,$3,$4,$5,$6,2)',[sessionId,tenantId,storeId,tableId,`three-screen-${sessionId}`,businessDate])
      const tasks=[]
      for(const station of ['bar','kitchen'] as const){
        const orderId=randomUUID(),itemId=randomUUID(),taskId=randomUUID()
        const note=index===19?'此单请完整核对：酱料与装饰分别放置，确认桌号后再取走，不与其他桌的出品混放。':''
        await db.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,submitted_at,subtotal_amount_minor,total_amount_minor,created_at) VALUES($1,$2,$3,$4,$5,'staff_assisted','submitted',clock_timestamp(),2000,2000,clock_timestamp()-interval '5 minutes'+$6::int*interval '2 seconds')",[orderId,tenantId,storeId,sessionId,`TS-${code}-${station}`,index])
        await db.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot,note) VALUES($1,$2,$3,$4,$5,2,1000,2000,$6,$7::jsonb,$8)`,[itemId,tenantId,storeId,orderId,products[station].id,station,JSON.stringify({name:products[station].name,inventoryControlMode:'not_managed'}),note])
        await db.query('INSERT INTO mbox.kds_tasks(id,tenant_id,store_id,order_item_id,station_code,quantity) VALUES($1,$2,$3,$4,$5,2)',[taskId,tenantId,storeId,itemId,station])
        tasks.push({taskId,itemId,orderId,station})
      }
      tables.push({tableId,tableSessionId:sessionId,code,tasks})
    }
    await db.query('COMMIT')
    return {tables,products,orders:40,portions:80}
  }catch(error){await db.query('ROLLBACK');throw error}finally{await db.end()}
}
