import {randomUUID} from 'node:crypto'
import Fastify from 'fastify'
import {Pool} from 'pg'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner,type ScopedTransaction} from './transaction-runner.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {catalogApiPlugin} from './catalog-api.js'
import {PaymentFulfillmentRepository,buildFulfillmentPlan} from './payment-fulfillment-repository.js'
import {InventoryRepository} from './inventory-repository.js'
import {OrderRepository,type OrderItem} from './order-repository.js'

const url=process.env.TEST_NORMALIZED_DATABASE_URL
const integration=url?describe:describe.skip
integration('optional product sales portions with real transactions and runtime RLS',()=>{
  const tenantId=randomUUID(),storeId=randomUUID(),employeeId=randomUUID(),roleId=randomUUID(),areaId=randomUUID()
  const scope={tenantId,storeId}
  let pool:Pool,runner:ScopedPostgresTransactionRunner
  const app=Fastify()
  const run=<T,>(fn:(tx:ScopedTransaction)=>Promise<T>)=>runner.run(scope,async tx=>{await tx.query('SET LOCAL ROLE mbox_runtime');return fn(tx)})
  beforeAll(async()=>{
    await runNormalizedMigrations(url!);pool=new Pool({connectionString:url,max:8});runner=new ScopedPostgresTransactionRunner(pool)
    await pool.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'sale quantity')",[tenantId,`q-${tenantId}`])
    await pool.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,'quantity','quantity')",[storeId,tenantId])
    await pool.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'Q','Q','indoor')",[areaId,tenantId,storeId])
    await pool.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,'quantity','数量管理员')",[employeeId,tenantId,storeId])
    await pool.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'QUANTITY','数量管理')",[roleId,tenantId,storeId])
    await pool.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 hour')",[tenantId,storeId,employeeId,roleId])
    await pool.query("INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code='catalog.product.manage'",[tenantId,storeId,roleId])
    const transactions={run:<T,>(storeScope:typeof scope,fn:(tx:ScopedTransaction)=>Promise<T>,options?:Parameters<typeof runner.run>[2])=>runner.run(storeScope,async tx=>{await tx.query('SET LOCAL ROLE mbox_runtime');return fn(tx)},options)}
    await app.register(catalogApiPlugin,{prefix:'/api',transactions,commandExecutor:new NormalizedCommandExecutor(transactions),resolveContext:()=>({scope,employeeId,businessDate:'2026-10-24',capabilities:[]}),resolveGuestContext:()=>({scope})})
  },30000)
  afterAll(async()=>{await app.close();await pool?.end()})
  async function product(remaining:number|null=null,hidden=false){
    const id=randomUUID()
    await pool.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station,inventory_control_mode,guest_visible,sale_remaining_quantity,cost_amount_minor) VALUES($1,$2,$3,$4,'测试菜品','food','kitchen','not_managed',$5,$6,100)",[id,tenantId,storeId,`Q${id.replaceAll('-','')}`,!hidden,remaining])
    return id
  }
  async function order(productId:string,quantity=1){
    const tableId=randomUUID(),sessionId=randomUUID(),orderId=randomUUID(),itemId=randomUUID()
    await pool.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,$5,'Q',4)",[tableId,tenantId,storeId,areaId,`T${tableId.slice(0,8)}`])
    await pool.query("INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1,$2,$3,$4,$5,current_date,2)",[sessionId,tenantId,storeId,tableId,`Q${sessionId}`])
    await pool.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,submitted_at,subtotal_amount_minor,total_amount_minor,settlement_mode,fulfillment_state,fulfillment_expires_at) VALUES($1,$2,$3,$4,$5,'staff_assisted','submitted',clock_timestamp(),1000,1000,'immediate_payment','awaiting_payment',clock_timestamp()+interval '10 minutes')",[orderId,tenantId,storeId,sessionId,`Q${orderId}`])
    await pool.query("INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot) VALUES($1,$2,$3,$4,$5,$6,1000,1000*$6,'kitchen','{\"name\":\"测试菜品\",\"inventoryControlMode\":\"not_managed\"}')",[itemId,tenantId,storeId,orderId,productId,quantity])
    const item=(await run(tx=>new OrderRepository(tx).getSubmittedForFulfillment(orderId))).items[0]!
    return {orderId,item}
  }
  const remaining=(id:string)=>pool.query('SELECT sale_remaining_quantity AS n FROM mbox.products WHERE id=$1',[id]).then(r=>r.rows[0].n)
  const reserve=(row:{orderId:string;item:OrderItem})=>run(tx=>new InventoryRepository(tx).reserveForImmediatePaymentOrder(row.orderId,[row.item]))
  const release=(row:{orderId:string})=>run(tx=>new InventoryRepository(tx).releaseImmediatePaymentReservations(row.orderId,'test checkout cancelled'))
  const state=(id:string)=>app.inject(`/api/catalog/products/${id}/sale-quantity`).then(r=>r.json().data as {remaining:number|null;reserved:number;version:string})
  async function save(id:string,n:number|null,version?:string,key=randomUUID()){
    const expectedVersion=version??(await state(id)).version
    return app.inject({method:'POST',url:`/api/catalog/products/${id}/sale-quantity`,headers:{'idempotency-key':key},payload:{remaining:n,expectedVersion}})
  }
  it('null preserves existing not-managed flow without a new ledger',async()=>{
    const id=await product(),row=await order(id,20);await reserve(row);await release(row)
    expect(await remaining(id)).toBeNull()
    expect((await pool.query('SELECT count(*)::int AS n FROM mbox.product_sale_quantity_allocations WHERE order_id=$1',[row.orderId])).rows[0].n).toBe(0)
  })
  it('reserves hidden card dishes, consumes once on payment, and never restocks paid refunds',async()=>{
    const id=await product(5,true),row=await order(id,2);await reserve(row);await reserve(row)
    expect(await remaining(id)).toBe(3)
    expect((await state(id)).reserved).toBe(2)
    await run(tx=>new InventoryRepository(tx).consumeImmediatePaymentReservations(row.orderId))
    await run(tx=>new InventoryRepository(tx).consumeImmediatePaymentReservations(row.orderId));await release(row)
    expect(await remaining(id)).toBe(3)
    expect((await state(id)).reserved).toBe(0)
  })
  it('releases only once and re-reserves correctly on an allowed payment retry',async()=>{
    const id=await product(4),row=await order(id,3);await reserve(row);await release(row);await release(row)
    expect(await remaining(id)).toBe(4);await reserve(row);expect(await remaining(id)).toBe(1)
  })
  it('table-tab orders consume the same product pool and are idempotent',async()=>{
    const id=await product(4),row=await order(id,2)
    await run(tx=>new InventoryRepository(tx).consumeForOrderItems([row.item]));await run(tx=>new InventoryRepository(tx).consumeForOrderItems([row.item]))
    expect(await remaining(id)).toBe(2);await release(row);expect(await remaining(id)).toBe(2)
  })
  it('two simultaneous orders cannot both buy the last portion',async()=>{
    const id=await product(1),a=await order(id),b=await order(id)
    const results=await Promise.allSettled([reserve(a),reserve(b)])
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
    expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);expect(await remaining(id)).toBe(0)
  })
  it('insufficient and later failed transactions do not leave deductions',async()=>{
    const id=await product(2),row=await order(id,3)
    await expect(reserve(row)).rejects.toThrow();expect(await remaining(id)).toBe(2)
    const one=await order(id)
    await expect(run(async tx=>{await new InventoryRepository(tx).reserveForImmediatePaymentOrder(one.orderId,[one.item]);throw new Error('later validation failed')})).rejects.toThrow('later validation')
    expect(await remaining(id)).toBe(2)
  })
  it('manual replenishment rejects stale screens and replays a saved command only once',async()=>{
    const id=await product(5),old=await state(id),row=await order(id);await reserve(row)
    expect((await save(id,10,old.version)).statusCode).toBe(409);expect(await remaining(id)).toBe(4)
    const version=(await state(id)).version,key=randomUUID()
    const ok=await save(id,10,version,key);expect(ok.statusCode,ok.body).toBe(200)
    expect((await save(id,10,version,key)).statusCode).toBe(200)
    await release(row);expect(await remaining(id)).toBe(11)
  })
  it('clear and re-enable isolates old holds; null old orders are not charged retroactively',async()=>{
    const id=await product(5),row=await order(id,2);await reserve(row)
    expect((await save(id,null)).statusCode).toBe(200);expect((await save(id,8)).statusCode).toBe(200)
    await release(row);expect(await remaining(id)).toBe(8)
    const unlimited=await product(),old=await order(unlimited);await reserve(old);await save(unlimited,4)
    await run(tx=>new InventoryRepository(tx).consumeImmediatePaymentReservations(old.orderId));expect(await remaining(unlimited)).toBe(4)
  })
  it('real order creation serializes capped product locks before price shared locks',async()=>{
    const id=await product(1)
    await pool.query("INSERT INTO mbox.product_prices(tenant_id,store_id,product_id,price_type,amount_minor,valid_from) VALUES($1,$2,$3,'standard',1000,clock_timestamp()-interval '1 hour')",[tenantId,storeId,id])
    const a=await order(id),b=await order(id)
    async function submit(original:string){
      const tableSessionId=(await pool.query('SELECT table_session_id FROM mbox.orders WHERE id=$1',[original])).rows[0].table_session_id
      return run(async tx=>{
        await tx.query("SET LOCAL lock_timeout='3s'")
        const submitted=await new OrderRepository(tx).createSubmitted({tableSessionId,publicId:`Q${randomUUID()}`,channel:'staff_assisted',createdByEmployeeId:employeeId,lines:[{productId:id,quantity:1}]})
        await new InventoryRepository(tx).consumeForOrderItems(submitted.items)
        return submitted
      })
    }
    const results=await Promise.allSettled([submit(a.orderId),submit(b.orderId)])
    expect(results.filter(r=>r.status==='fulfilled'),JSON.stringify(results)).toHaveLength(1)
    const failed=results.find(r=>r.status==='rejected') as PromiseRejectedResult
    expect(failed.reason.name).toBe('OrderProductUnavailableError')
    expect(await remaining(id)).toBe(0)
  })
  it('original checkout cancellation releases the cap and cannot revive cancelled fulfillment',async()=>{
    const id=await product(5),fixture=await order(id)
    await pool.query("INSERT INTO mbox.product_prices(tenant_id,store_id,product_id,price_type,amount_minor,valid_from) VALUES($1,$2,$3,'standard',1000,clock_timestamp()-interval '1 hour')",[tenantId,storeId,id])
    const session=(await pool.query('SELECT table_session_id FROM mbox.orders WHERE id=$1',[fixture.orderId])).rows[0].table_session_id
    const submitted=await run(async tx=>{
      const order=await new OrderRepository(tx).createSubmitted({tableSessionId:session,publicId:`Q${randomUUID()}`,channel:'staff_assisted',settlementMode:'immediate_payment',createdByEmployeeId:employeeId,lines:[{productId:id,quantity:2}]})
      await new PaymentFulfillmentRepository(tx).prepareSubmittedOrder(order,buildFulfillmentPlan(order.items))
      return order
    })
    expect(await remaining(id)).toBe(3)
    await run(tx=>new PaymentFulfillmentRepository(tx).abandonGuestSelfCheckout(submitted.id,'customer cancelled checkout'))
    await run(tx=>new PaymentFulfillmentRepository(tx).abandonGuestSelfCheckout(submitted.id,'customer cancelled checkout'))
    expect(await remaining(id)).toBe(5)
    await expect(run(tx=>new PaymentFulfillmentRepository(tx).ensureReservationBeforePayment(submitted.id))).rejects.toThrow()
    expect(await remaining(id)).toBe(5)
  })
  it('fixed bundle contents and repeated lines cannot bypass one shared count',async()=>{
    const id=await product(2),bundle=await product(null),a=await order(id,2),b=await order(id)
    await pool.query("UPDATE mbox.products SET product_kind='bundle',fulfillment_station='none' WHERE id=$1",[bundle])
    await pool.query('INSERT INTO mbox.product_bundle_components(tenant_id,store_id,bundle_product_id,component_product_id,quantity,sort_order) VALUES($1,$2,$3,$4,3,0)',[tenantId,storeId,bundle,id])
    expect((await run(tx=>tx.query<{available:boolean}>('SELECT mbox.product_sale_quantity_available($1,$2,$3) AS available',[tenantId,storeId,bundle]))).rows[0]?.available).toBe(false)
    await expect(run(tx=>new InventoryRepository(tx).consumeForOrderItems([a.item,b.item]))).rejects.toThrow()
    expect(await remaining(id)).toBe(2)
  })
  it('permission removal blocks reads, new writes and successful receipt replays',async()=>{
    const id=await product(),version=(await state(id)).version,key=randomUUID()
    expect((await save(id,7,version,key)).statusCode).toBe(200)
    await pool.query("DELETE FROM mbox.role_permission_assignments WHERE tenant_id=$1 AND store_id=$2 AND role_id=$3",[tenantId,storeId,roleId])
    try{
      expect((await app.inject(`/api/catalog/products/${id}/sale-quantity`)).statusCode).toBe(403)
      expect((await save(id,7,version,key)).statusCode).toBe(403)
      expect(await remaining(id)).toBe(7)
    }finally{await pool.query("INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code='catalog.product.manage'",[tenantId,storeId,roleId])}
  })
  it('zero blocks sales, invalid values are rejected, and runtime cannot see another store',async()=>{
    const id=await product(0),row=await order(id);await expect(reserve(row)).rejects.toThrow()
    for(const n of [-1,1.5,1000001])expect((await save(id,n)).statusCode).toBe(400)
    const cross=await runner.run({...scope,storeId:randomUUID()},async tx=>{await tx.query('SET LOCAL ROLE mbox_runtime');return tx.query('SELECT * FROM mbox.product_sale_quantity_allocations')})
    expect(cross.rows).toEqual([])
  })
})
