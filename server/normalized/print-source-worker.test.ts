import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { appendOutboxMessage } from './command-executor.js'
import { PrintSourceWorker } from './print-source-worker.js'
import { PrintTicketSourceRepository } from './print-ticket-source.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip
integration('asynchronous print sources: committed events, isolation and recovery', () => {
  const scope = {tenantId: randomUUID(), storeId: randomUUID()}
  let pool: Pool
  let transactions: ScopedPostgresTransactionRunner
  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({connectionString: databaseUrl, max: 4})
    transactions = new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    await pool.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,'async-print-tests','Print tests')", [scope.tenantId])
    await pool.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,'async-print-store','Print store')", [scope.storeId,scope.tenantId])
  })
  afterAll(async () => pool?.end())

  it('queues one payment source for manual, callback and background confirmations, not pending or repeated successes', async () => {
    const paymentId = randomUUID()
    for (const [index,status] of ['pending','succeeded','succeeded'].entries()) {
      await transactions.run(scope, tx => appendOutboxMessage(tx, {
        aggregateType:'payment',aggregateId:paymentId,aggregateVersion:index+1,
        eventType:index===1?'payment.manual_succeeded.v1':'payment.provider_result.v1',
        payload:{status,orderId:randomUUID(),payableKind:'order'},
      }))
    }
    const rows=await pool.query('SELECT ticket_kind,status FROM mbox.print_source_jobs WHERE aggregate_id=$1',[paymentId])
    expect(rows.rows).toEqual([{ticket_kind:'payment',status:'pending'}])
  })

  it('does not print unpaid immediate orders and enrolls the later electronic fulfillment exactly once', async () => {
    const orderId=randomUUID()
    await transactions.run(scope,tx=>appendOutboxMessage(tx,{aggregateType:'order',aggregateId:orderId,aggregateVersion:1,
      eventType:'order.submitted.v1',payload:{kdsTaskIds:[]}}))
    expect((await pool.query('SELECT id FROM mbox.print_source_jobs WHERE aggregate_id=$1',[orderId])).rowCount).toBe(0)
    await transactions.run(scope,tx=>appendOutboxMessage(tx,{aggregateType:'order',aggregateId:orderId,aggregateVersion:2,
      eventType:'order.fulfillment_activated_after_payment.v1',payload:{kdsTaskCount:2}}))
    expect((await pool.query('SELECT ticket_kind FROM mbox.print_source_jobs WHERE aggregate_id=$1',[orderId])).rows).toEqual([{ticket_kind:'production'}])
  })

  it('rolls back source enrollment with the business transaction, never leaving a phantom receipt', async () => {
    const id=randomUUID()
    await expect(transactions.run(scope,async tx=>{
      await appendOutboxMessage(tx,{aggregateType:'refund',aggregateId:id,aggregateVersion:1,
        eventType:'refund.manual_succeeded.v1',payload:{status:'succeeded',orderId:randomUUID()}})
      throw new Error('rollback business')
    })).rejects.toThrow('rollback business')
    expect((await pool.query('SELECT id FROM mbox.print_source_jobs WHERE aggregate_id=$1',[id])).rowCount).toBe(0)
  })

  it('keeps already committed events when rendering fails, backs off durably and avoids immediate retries', async () => {
    // Previous tests deliberately refer to missing domain facts: rendering must
    // fail locally instead of manufacturing a ticket or rolling back the event.
    const before=Number((await pool.query('SELECT count(*) FROM mbox.outbox_messages WHERE tenant_id=$1',[scope.tenantId])).rows[0].count)
    const worker=new PrintSourceWorker(transactions)
    const [left,right]=await Promise.all([worker.runBatch(scope,'print-source-left'),worker.runBatch(scope,'print-source-right')])
    expect(left.retrying+right.retrying).toBe(2)
    const rows=await pool.query("SELECT attempts,status,next_attempt_at>clock_timestamp() AS deferred FROM mbox.print_source_jobs WHERE tenant_id=$1",[scope.tenantId])
    expect(rows.rows).toEqual([{attempts:1,status:'retry',deferred:true},{attempts:1,status:'retry',deferred:true}])
    expect((await worker.runBatch(scope,'print-source-restarted')).examined).toBe(0)
    expect(Number((await pool.query('SELECT count(*) FROM mbox.outbox_messages WHERE tenant_id=$1',[scope.tenantId])).rows[0].count)).toBe(before)
    expect((await worker.runBatch({tenantId:randomUUID(),storeId:randomUUID()},'print-source-foreign')).examined).toBe(0)
  })

  it('renders committed fulfilled orders to two stations and a receipt to the bar device without device I/O', async () => {
    const area=randomUUID(),table=randomUUID(),session=randomUUID(),order=randomUUID(),payment=randomUUID()
    const bar=randomUUID(),kitchen=randomUUID(),drink=randomUUID(),snack=randomUUID()
    await pool.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'AP','Print','indoor')",[area,scope.tenantId,scope.storeId])
    await pool.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,'AP01','AP01',4)",[table,scope.tenantId,scope.storeId,area])
    await pool.query("INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status) VALUES($1,$2,$3,$4,'async-print-session',CURRENT_DATE,2,'open')",[session,scope.tenantId,scope.storeId,table])
    await pool.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station) VALUES($1,$3,$4,'AP-DRINK','测试酒','drink','bar'),($2,$3,$4,'AP-SNACK','测试小食','food','kitchen')",[drink,snack,scope.tenantId,scope.storeId])
    await pool.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,subtotal_amount_minor,total_amount_minor,submitted_at) VALUES($1,$2,$3,$4,'async-print-order','staff_assisted','fulfilling','paid',1500,1500,clock_timestamp())",[order,scope.tenantId,scope.storeId,session])
    await pool.query(`INSERT INTO mbox.order_items(tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot,status)
      VALUES($1,$2,$3,$4,1,1000,1000,'bar','{"name":"测试酒","productKind":"single"}','preparing'),
      ($1,$2,$3,$5,1,500,500,'kitchen','{"name":"测试小食","productKind":"single"}','ready')`,[scope.tenantId,scope.storeId,order,drink,snack])
    await pool.query("INSERT INTO mbox.payments(id,tenant_id,store_id,order_id,public_id,provider,method,amount_minor,currency,status,succeeded_at,provider_transaction_id) VALUES($1,$2,$3,$4,'async-print-payment','cash','cash',1500,'CNY','succeeded',clock_timestamp(),'local-test-cash-receipt')",[payment,scope.tenantId,scope.storeId,order])
    await pool.query("INSERT INTO mbox.devices(id,tenant_id,store_id,code,name,device_type,station_code,connectivity_status) VALUES($1,$3,$4,'AP-BAR','吧台','printer','bar','offline'),($2,$3,$4,'AP-KITCHEN','厨房','printer','kitchen','offline')",[bar,kitchen,scope.tenantId,scope.storeId])
    await pool.query("INSERT INTO mbox.printer_routes(tenant_id,store_id,code,name,station_code,printer_device_id) VALUES($1,$2,'AP-BAR-ROUTE','吧台','bar',$3),($1,$2,'AP-CASH-ROUTE','收银','cashier',$3),($1,$2,'AP-KITCHEN-ROUTE','厨房','kitchen',$4)",[scope.tenantId,scope.storeId,bar,kitchen])
    await transactions.run(scope,async tx=>{
      await tx.query('SET LOCAL ROLE mbox_runtime')
      await appendOutboxMessage(tx,{aggregateType:'order',aggregateId:order,aggregateVersion:1,eventType:'order.submitted.v1',payload:{kdsTaskIds:[randomUUID(),randomUUID()]}})
      await appendOutboxMessage(tx,{aggregateType:'payment',aggregateId:payment,aggregateVersion:2,eventType:'payment.manual_succeeded.v1',payload:{status:'succeeded',orderId:order,payableKind:'order'}})
    })
    const worker=new PrintSourceWorker({run:(current,operation)=>transactions.run(current,async tx=>{
      await tx.query('SET LOCAL ROLE mbox_runtime');return operation(tx)
    })})
    expect(await worker.runBatch(scope,'actual-print-source')).toMatchObject({completed:2,dead:0,retrying:0})
    const jobs=await pool.query('SELECT station_code,status,printer_device_id FROM mbox.print_jobs WHERE tenant_id=$1 ORDER BY station_code',[scope.tenantId])
    expect(jobs.rows).toEqual([
      {station_code:'bar',status:'pending',printer_device_id:bar},
      {station_code:'cashier',status:'pending',printer_device_id:bar},
      {station_code:'kitchen',status:'pending',printer_device_id:kitchen},
    ])
    expect((await worker.runBatch(scope,'print-source-again')).examined).toBe(0)
    expect((await pool.query('SELECT status,payment_status FROM mbox.orders WHERE id=$1',[order])).rows[0]).toEqual({status:'fulfilling',payment_status:'paid'})
    // A delayed generator must not ask the kitchen to make delivered dishes
    // again merely because a print queue recovered after electronic service.
    await pool.query("UPDATE mbox.order_items SET status='delivered' WHERE order_id=$1",[order])
    expect(await transactions.run(scope,tx=>new PrintTicketSourceRepository(tx).materializeOrderProduction(randomUUID(),order))).toEqual([])
    expect((await pool.query('SELECT id FROM mbox.print_jobs WHERE tenant_id=$1',[scope.tenantId])).rowCount).toBe(3)
  })
})
