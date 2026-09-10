import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {describe,it,expect,beforeAll,afterAll} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner,type PostgresPool} from './transaction-runner.js'
import {OrderStockReturnRepository} from './order-stock-return-repository.js'
const url=process.env.TEST_NORMALIZED_DATABASE_URL
const integration=url?describe:describe.skip
integration('partial physical returns',()=>{
 const tenant=randomUUID(),store=randomUUID(),employee=randomUUID(),reviewer=randomUUID(),area=randomUUID(),table=randomUUID(),session=randomUUID(),product=randomUUID(),order=randomUUID(),item=randomUUID(),payment=randomUUID(),inventory=randomUUID(),movement=randomUUID()
 let pool:Pool,runner:ScopedPostgresTransactionRunner
 const scope={tenantId:tenant,storeId:store}
 beforeAll(async()=>{
  await runNormalizedMigrations(url!);pool=new Pool({connectionString:url});runner=new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
  await pool.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Return test')",[tenant,`return-${tenant}`])
  await pool.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,'return','Return test')",[store,tenant])
  await pool.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$3,$4,'RETURNER','退库员'),($2,$3,$4,'REVIEWER','复核员')",[employee,reviewer,tenant,store])
  await pool.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'A','A','indoor')",[area,tenant,store])
  await pool.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,'A1','A1',4)",[table,tenant,store,area])
  await pool.query("INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,status,guest_count) VALUES($1,$2,$3,$4,'return-session',CURRENT_DATE,'open',2)",[session,tenant,store,table])
  await pool.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station) VALUES($1,$2,$3,'BEER','瓶装啤酒','beer','bar')",[product,tenant,store])
  await pool.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,subtotal_amount_minor,total_amount_minor,submitted_at) VALUES($1,$2,$3,$4,'return-order','staff_assisted','fulfilling','paid',4000,4000,clock_timestamp())",[order,tenant,store,session])
  await pool.query("INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot,status) VALUES($1,$2,$3,$4,$5,4,1000,4000,'bar','{\"name\":\"瓶装啤酒\"}','delivered')",[item,tenant,store,order,product])
  await pool.query("INSERT INTO mbox.payments(id,tenant_id,store_id,order_id,public_id,provider,method,amount_minor,currency,status,succeeded_at,provider_transaction_id) VALUES($1,$2,$3,$4,'return-pay','cash','cash',4000,'CNY','succeeded',clock_timestamp(),'return-cash')",[payment,tenant,store,order])
  await pool.query("INSERT INTO mbox.inventory_items(id,tenant_id,store_id,sku,name,item_type,base_unit) VALUES($1,$2,$3,'BEER','瓶装啤酒','bottle','bottle')",[inventory,tenant,store])
  await pool.query("INSERT INTO mbox.inventory_movements(id,tenant_id,store_id,inventory_item_id,movement_type,quantity_delta,reference_type,reference_id,order_item_id,unit_cost_minor) VALUES($1,$2,$3,$4,'sale',-4,'order_item',$5,$5,300)",[movement,tenant,store,inventory,item])
  await pool.query("INSERT INTO mbox.inventory_balances(tenant_id,store_id,inventory_item_id,on_hand_quantity,last_movement_id) VALUES($1,$2,$3,6,$4)",[tenant,store,inventory,movement])
  await pool.query("INSERT INTO mbox.inventory_order_reservations(tenant_id,store_id,order_id,order_item_id,inventory_item_id,quantity,status,movement_id,consumed_at) VALUES($1,$2,$3,$4,$5,4,'consumed',$6,clock_timestamp())",[tenant,store,order,item,inventory,movement])
 })
 afterAll(async()=>pool?.end())
 const record=(quantity:number,extra:Record<string,unknown>={})=>runner.run(scope,tx=>new OrderStockReturnRepository(tx).record({orderItemId:item,employeeId:employee,quantity,disposition:'returned_unopened',reason:'顾客未开封实际退回',unopenedConfirmed:true,...extra}))
 it('does not restore inventory merely from a request or unconfirmed physical state',async()=>{
  await expect(record(2)).rejects.toThrow('尚无确认成功的退款')
  await expect(record(2,{unopenedConfirmed:false})).rejects.toThrow('必须确认')
  expect((await pool.query('SELECT on_hand_quantity::text AS q FROM mbox.inventory_balances WHERE inventory_item_id=$1',[inventory])).rows[0].q).toBe('6.000000')
 })
 it('records two partial returns and rejects concurrent excess without issuing another refund',async()=>{
  await pool.query(`INSERT INTO mbox.refunds(id,tenant_id,store_id,payment_id,public_id,provider_refund_id,amount_minor,currency,status,reason,requested_by_employee_id,approved_by_employee_id,decision_reason,completed_at)
   VALUES($1,$2,$3,$4,'return-refund','offline-return-voucher',4000,'CNY','succeeded','顾客退货',$5,$6,'实际现金退付',clock_timestamp())`,[randomUUID(),tenant,store,payment,employee,reviewer])
  await expect(record(1,{disposition:'unmade'})).rejects.toThrow('未制作退库须先停止出品')
  await expect(record(5)).rejects.toThrow('累计退回数量超过')
  await record(2)
  expect((await pool.query('SELECT on_hand_quantity::text AS q FROM mbox.inventory_balances WHERE inventory_item_id=$1',[inventory])).rows[0].q).toBe('8.000000')
  const results=await Promise.allSettled([record(2),record(2)])
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1)
  expect(results.filter(result=>result.status==='rejected')).toHaveLength(1)
  expect((await pool.query('SELECT on_hand_quantity::text AS q FROM mbox.inventory_balances WHERE inventory_item_id=$1',[inventory])).rows[0].q).toBe('10.000000')
  expect((await pool.query('SELECT count(*)::int AS n FROM mbox.refunds WHERE payment_id=$1',[payment])).rows[0].n).toBe(1)
  const returned=await pool.query("SELECT unit_cost_minor FROM mbox.inventory_movements WHERE order_item_id=$1 AND reference_type='order_stock_return'",[item])
  expect(returned.rows).toHaveLength(2)
  expect(returned.rows.every(row=>Number(row.unit_cost_minor)===300)).toBe(true)
 })
})
