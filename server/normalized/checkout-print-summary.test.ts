import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { appendOutboxMessage } from './command-executor.js'
import { readCheckoutPrintSummary } from './checkout-print-summary.js'
import { PrintTicketSourceRepository } from './print-ticket-source.js'
import { HardwareRepository } from './hardware-repository.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const url = process.env.TEST_NORMALIZED_DATABASE_URL
;(url ? describe : describe.skip)('checkout bill confirmed funds and complete totals', () => {
  const scope = { tenantId: randomUUID(), storeId: randomUUID() }
  const table = randomUUID(), employee = randomUUID(), product = randomUUID()
  let pool: Pool, transactions: ScopedPostgresTransactionRunner
  beforeAll(async () => {
    await runNormalizedMigrations(url!)
    pool = new Pool({ connectionString: url })
    transactions = new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    await pool.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'Checkout print tests')", [scope.tenantId])
    await pool.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,'checkout','Checkout')", [scope.storeId,scope.tenantId])
    const area = randomUUID(), device = randomUUID()
    await pool.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'VIP','VIP','indoor')", [area,scope.tenantId,scope.storeId])
    await pool.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,'VIP3','VIP3',8)", [table,scope.tenantId,scope.storeId,area])
    await pool.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,'cashier','测试收银员')", [employee,scope.tenantId,scope.storeId])
    await pool.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station) VALUES($1,$2,$3,'test','测试商品','drink','bar')", [product,scope.tenantId,scope.storeId])
    await pool.query("INSERT INTO mbox.devices(id,tenant_id,store_id,code,name,device_type,station_code,connectivity_status) VALUES($1,$2,$3,'bar','测试打印机','printer','bar','offline')", [device,scope.tenantId,scope.storeId])
    await pool.query("INSERT INTO mbox.printer_routes(tenant_id,store_id,code,name,station_code,printer_device_id) VALUES($1,$2,'cashier','收银','cashier',$3)", [scope.tenantId,scope.storeId,device])
  })
  afterAll(async () => pool?.end())

  async function fixture(amounts = [18800,20000,7600,268000]) {
    const session = randomUUID(), fixtureTable = randomUUID(), orders: string[] = []
    await pool.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) SELECT $1::uuid,tenant_id,store_id,area_id,'T'||upper(left(replace($1::text,'-',''),12)),'VIP3',8 FROM mbox.tables WHERE id=$2", [fixtureTable,table])
    await pool.query("INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status) VALUES($1::uuid,$2,$3,$4,$1::text,CURRENT_DATE,8,'open')", [session,scope.tenantId,scope.storeId,fixtureTable])
    for (const amount of amounts) {
      const id = randomUUID(); orders.push(id)
      await pool.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,subtotal_amount_minor,total_amount_minor,submitted_at) VALUES($1::uuid,$2,$3,$4,$1::text,'staff_assisted','submitted','unpaid',$5,$5,clock_timestamp())", [id,scope.tenantId,scope.storeId,session,amount])
      await pool.query(`INSERT INTO mbox.order_items(tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot,status)
        VALUES($1,$2,$3,$4,1,$5,$5,'bar','{"name":"测试商品","productKind":"single"}','preparing')`, [scope.tenantId,scope.storeId,id,product,amount])
    }
    return {session,orders}
  }
  async function payment(order: string, amount: number, status = 'succeeded') {
    const id = randomUUID()
    await pool.query(`INSERT INTO mbox.payments(id,tenant_id,store_id,order_id,public_id,provider,method,amount_minor,status,succeeded_at,provider_transaction_id)
      VALUES($1::uuid,$2,$3,$4,$1::text,'cash','cash',$5,$6,CASE WHEN $6='succeeded' THEN clock_timestamp() END,CASE WHEN $6='succeeded' THEN $1::text END)`, [id,scope.tenantId,scope.storeId,order,amount,status])
    return id
  }
  async function bill(session: string, source?: string) {
    return transactions.run(scope, async tx => {
      const sourceId = source ?? await appendOutboxMessage(tx,{aggregateType:'manual_print_request',aggregateId:randomUUID(),aggregateVersion:1,eventType:'manual.table-bill.requested.v1',payload:{tableSessionId:session}})
      const jobs = await new PrintTicketSourceRepository(tx,true).materializeManualTableBill(sourceId,session,'测试收银员')
      return {sourceId,jobs,snapshot:jobs[0]!.printSnapshot}
    })
  }
  async function orderBill(order: string) {
    return transactions.run(scope,async tx=>{
      const source=await appendOutboxMessage(tx,{aggregateType:'manual_print_request',aggregateId:randomUUID(),aggregateVersion:1,eventType:'manual.order-bill.requested.v1',payload:{orderId:order}})
      return (await new PrintTicketSourceRepository(tx,true).materializeManualOrderBill(source,order,'测试收银员'))[0].printSnapshot
    })
  }
  const summary = (orders: string[]) => transactions.run(scope,tx=>readCheckoutPrintSummary(tx,orders),{readOnly:true})

  it('prints the complete VIP3 unpaid total prominently and does not treat pending money as paid', async () => {
    const {session,orders}=await fixture()
    await payment(orders[3],268000,'pending')
    const result=await bill(session)
    expect(result.snapshot).toMatchObject({title:'预结账单',checkoutState:'unpaid',totalAmountMinor:314400})
    expect(result.snapshot.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({name:'尚未收款',totalAmountMinor:314400}),
      expect.objectContaining({name:'桌次实际收款',totalAmountMinor:0}),
    ]))
    expect(await summary(orders)).toMatchObject({receivable:314400,received:0,due:314400,pending:268000,state:'unpaid'})
  })

  it('keeps partial receipts as pre-checkout, then creates a new paid bill without rewriting the old one', async () => {
    const {session,orders}=await fixture([10000])
    await payment(orders[0],4000)
    const before=await bill(session)
    expect(before.snapshot).toMatchObject({title:'预结账单',checkoutState:'partial',totalAmountMinor:10000})
    expect(await summary(orders)).toMatchObject({received:4000,due:6000})
    expect(await orderBill(orders[0])).toMatchObject({title:'预结账单',checkoutState:'partial',totalAmountMinor:10000})
    await payment(orders[0],6000)
    const after=await bill(session)
    expect(after.snapshot).toMatchObject({title:'结账单',checkoutState:'paid',totalAmountMinor:10000})
    expect(await orderBill(orders[0])).toMatchObject({title:'结账单',checkoutState:'paid',totalAmountMinor:10000})
    expect(after.snapshot.ticketReference).not.toBe(before.snapshot.ticketReference)
    await expect(bill(session,before.sourceId)).rejects.toThrow('幂等键')
    expect((await pool.query('SELECT print_snapshot FROM mbox.print_jobs WHERE id=$1',[before.jobs[0].id])).rows[0].print_snapshot).toEqual(before.snapshot)
    await pool.query("UPDATE mbox.print_jobs SET status='printed',printed_at=clock_timestamp() WHERE id=$1",[before.jobs[0].id])
    const copy=await transactions.run(scope,tx=>new HardwareRepository(tx).reprintPrintJob(before.jobs[0].id,employee,'原单补打','checkout-snapshot-reprint'))
    expect(copy.printSnapshot).toMatchObject({title:'预结账单',checkoutState:'partial',totalAmountMinor:10000})
  })

  it('never lets one overpaid order hide an unpaid order in the same table', async () => {
    const {session,orders}=await fixture([10000,10000])
    await payment(orders[0],20000)
    expect(await summary(orders)).toMatchObject({receivable:20000,received:20000,due:10000,state:'partial'})
    expect((await bill(session)).snapshot.title).toBe('预结账单')
  })

  it('counts a merged payment once, using its original order allocations', async () => {
    const {session,orders}=await fixture()
    await transactions.run(scope,async tx=>{
      const batch=randomUUID()
      await tx.query("INSERT INTO mbox.order_payment_batches(id,tenant_id,store_id,table_session_id,created_by_employee_id,amount_minor,currency) VALUES($1,$2,$3,$4,$5,314400,'CNY')",[batch,scope.tenantId,scope.storeId,session,employee])
      for (const [position,order] of orders.entries()) await tx.query(`INSERT INTO mbox.order_payment_allocations(tenant_id,store_id,batch_id,order_id,amount_minor,outstanding_at_creation_minor,position)
        SELECT $1,$2,$3,id,total_amount_minor,total_amount_minor,$5 FROM mbox.orders WHERE id=$4`,[scope.tenantId,scope.storeId,batch,order,position])
      const id=randomUUID()
      await tx.query("INSERT INTO mbox.payments(id,tenant_id,store_id,order_id,order_batch_id,payable_kind,public_id,provider,method,amount_minor,status,succeeded_at,provider_transaction_id) VALUES($1::uuid,$2,$3,NULL,$4,'order_batch',$1::text,'cash','cash',314400,'succeeded',clock_timestamp(),$1::text)",[id,scope.tenantId,scope.storeId,batch])
    })
    expect(await summary(orders)).toMatchObject({received:314400,due:0,state:'paid'})
    expect((await bill(session)).snapshot).toMatchObject({title:'结账单',totalAmountMinor:314400})
  })

  it('reports refunded money separately without inventing a new collection', async () => {
    const {session,orders}=await fixture([10000])
    const pid=await payment(orders[0],10000)
    const approver=randomUUID()
    await pool.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,'approver','退款审核员')",[approver,scope.tenantId,scope.storeId])
    await pool.query("INSERT INTO mbox.refunds(tenant_id,store_id,payment_id,order_id,public_id,amount_minor,status,reason,requested_by_employee_id,completed_at,approved_by_employee_id,decision_reason,provider_refund_id) VALUES($1,$2,$3,$4,$5,2000,'succeeded','test refund',$6,clock_timestamp(),$7,'approved test','test-refund')",[scope.tenantId,scope.storeId,pid,orders[0],randomUUID(),employee,approver])
    expect(await summary(orders)).toMatchObject({received:10000,refunded:2000,net:8000,due:0,state:'paid'})
    expect((await bill(session)).snapshot.lines).toEqual(expect.arrayContaining([expect.objectContaining({name:'桌次实际退款',totalAmountMinor:2000})]))
  })

  it('excludes cancelled orders from the payable sum and does not label a zero-value bill as actually paid', async () => {
    const {session,orders}=await fixture([10000,5000])
    await pool.query("UPDATE mbox.orders SET status='cancelled',cancelled_at=clock_timestamp() WHERE id=$1",[orders[1]])
    expect((await bill(session)).snapshot).toMatchObject({title:'预结账单',totalAmountMinor:10000})
    const zero=await fixture([0])
    expect((await bill(zero.session)).snapshot).toMatchObject({title:'预结账单',totalAmountMinor:0})
  })
})
