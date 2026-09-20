import {randomUUID} from 'node:crypto'
import {Client} from 'pg'

/** Opt-in throwaway browser database only; never store configuration or production seed. */
export async function seedKitchenBrowserFixture(databaseUrl:string,tenantId:string,storeId:string,businessDate:string){
  const client=new Client({connectionString:databaseUrl});await client.connect()
  try{
    await client.query('BEGIN')
    const areaId=(await client.query('SELECT id FROM mbox.areas WHERE tenant_id=$1 AND store_id=$2 ORDER BY id LIMIT 1',[tenantId,storeId])).rows[0].id
    const waiter=(await client.query("SELECT id FROM mbox.employees WHERE tenant_id=$1 AND store_id=$2 AND employee_code='tom'",[tenantId,storeId])).rows[0].id
    const waiterRole=(await client.query('SELECT role_id FROM mbox.employee_roles WHERE tenant_id=$1 AND store_id=$2 AND employee_id=$3 ORDER BY starts_at LIMIT 1',[tenantId,storeId,waiter])).rows[0].role_id
    const productId=randomUUID(),productName='隔离合批薯条'
    await client.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station,inventory_control_mode) VALUES($1,$2,$3,'KITCHEN-BROWSER-FRIES',$4,'food','kitchen','not_managed')",[productId,tenantId,storeId,productName])
    const taskIds:string[]=[]
    for(let index=0;index<30;index++){
      const tableId=randomUUID(),sessionId=randomUUID(),code=`K${String(index+1).padStart(2,'0')}`
      await client.query('INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,$5,$5,8)',[tableId,tenantId,storeId,areaId,code])
      await client.query("INSERT INTO mbox.table_assignments(tenant_id,store_id,table_id,employee_id,role_id,assignment_type,starts_at,reason,created_by_employee_id) VALUES($1,$2,$3,$4,$5,'primary',clock_timestamp()-interval '1 hour','隔离后厨取送验收',$4)",[tenantId,storeId,tableId,waiter,waiterRole])
      await client.query('INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1,$2,$3,$4,$5,$6,2)',[sessionId,tenantId,storeId,tableId,`kitchen-test-${sessionId}`,businessDate])
      for(let order=0;order<2;order++){
        const orderId=randomUUID(),itemId=randomUUID(),taskId=randomUUID();taskIds.push(taskId)
        await client.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,submitted_at,subtotal_amount_minor,total_amount_minor,created_at) VALUES($1,$2,$3,$4,$5,'staff_assisted','submitted',clock_timestamp(),3000,3000,clock_timestamp()-interval '2 minutes'+$6::int*interval '2 seconds')",[orderId,tenantId,storeId,sessionId,`KDS-${code}-${order+1}`,index*2+order])
        await client.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot,note) VALUES($1,$2,$3,$4,$5,3,1000,3000,'kitchen',$6::jsonb,$7)`,[itemId,tenantId,storeId,orderId,productId,JSON.stringify({name:productName,inventoryControlMode:'not_managed'}),index%10===9?'不要盐':''])
        await client.query("INSERT INTO mbox.kds_tasks(id,tenant_id,store_id,order_item_id,station_code,quantity) VALUES($1,$2,$3,$4,'kitchen',3)",[taskId,tenantId,storeId,itemId])
      }
    }
    await client.query('COMMIT');return {productName,taskIds,orders:60,portions:180,tables:30}
  }catch(error){await client.query('ROLLBACK');throw error}finally{await client.end()}
}
