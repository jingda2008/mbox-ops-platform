import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { appendOutboxMessage } from './command-executor.js'
import { PrintSourceWorker } from './print-source-worker.js'
import { PrintTicketSourceRepository } from './print-ticket-source.js'
import {DeliveryBatchRepository} from './delivery-batch-repository.js'
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
    expect((await pool.query('SELECT ticket_kind FROM mbox.print_source_jobs WHERE aggregate_id=$1 ORDER BY ticket_kind',[orderId])).rows).toEqual([{ticket_kind:'order_summary'},{ticket_kind:'production'}])
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
    expect(left.retrying+right.retrying).toBe(3)
    const rows=await pool.query("SELECT attempts,status,next_attempt_at>clock_timestamp() AS deferred FROM mbox.print_source_jobs WHERE tenant_id=$1",[scope.tenantId])
    expect(rows.rows).toEqual(Array.from({length:3},()=>({attempts:1,status:'retry',deferred:true})))
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
      ($1,$2,$3,$5,4,125,500,'kitchen','{"name":"测试小食","productKind":"single"}','preparing')`,[scope.tenantId,scope.storeId,order,drink,snack])
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
    expect(await worker.runBatch(scope,'actual-print-source')).toMatchObject({completed:3,dead:0,retrying:0})
    const jobs=await pool.query('SELECT station_code,status,printer_device_id FROM mbox.print_jobs WHERE tenant_id=$1 ORDER BY station_code',[scope.tenantId])
    expect(jobs.rows).toEqual([
      {station_code:'bar',status:'pending',printer_device_id:bar},
      {station_code:'cashier',status:'pending',printer_device_id:bar},
      {station_code:'cashier',status:'pending',printer_device_id:bar},
      {station_code:'kitchen',status:'pending',printer_device_id:kitchen},
    ])
    expect((await worker.runBatch(scope,'print-source-again')).examined).toBe(0)
    expect((await pool.query('SELECT status,payment_status FROM mbox.orders WHERE id=$1',[order])).rows[0]).toEqual({status:'fulfilling',payment_status:'paid'})
    // Unpaid tab: print a clearly uncollected pre-bill without a payment attempt.
    await pool.query("UPDATE mbox.orders SET payment_status='unpaid',settlement_mode='table_tab' WHERE id=$1",[order])
    await pool.query("UPDATE mbox.payments SET status='failed',succeeded_at=NULL WHERE id=$1",[payment])
    const source=await transactions.run(scope,tx=>appendOutboxMessage(tx,{aggregateType:'order',aggregateId:order,
      aggregateVersion:10,eventType:'print.test-fixture.v1',payload:{}}))
    const tabJobs=await transactions.run(scope,tx=>new PrintTicketSourceRepository(tx).materializeOrderSummary(source,order))
    expect(tabJobs).toHaveLength(2)
    const prebill=tabJobs.find(j=>j.printSnapshot.kind==='cashier_settlement')!
    expect(prebill.printSnapshot.title).toContain('未确认收款')
    expect(prebill.printSnapshot.totalAmountMinor).toBe(1500)
    expect(prebill.printerDeviceId).toBe(bar)
    expect(prebill.printSnapshot.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({name:'优惠前应付合计（套餐按套餐售价）',totalAmountMinor:1500}),
      expect.objectContaining({name:'优惠减免（已扣除）',totalAmountMinor:0}),
    ]))
    expect((await pool.query('SELECT status FROM mbox.payments WHERE order_id=$1',[order])).rows).toEqual([{status:'failed'}])
    // Policies are tenant/store scoped and override copies independently.
    await transactions.run(scope,async tx=>{
      await tx.query('SET LOCAL ROLE mbox_runtime')
      await tx.query("INSERT INTO mbox.print_ticket_policies(tenant_id,store_id,ticket_kind,enabled,copies) VALUES($1,$2,'order_summary',false,1),($1,$2,'cashier_settlement',true,2)",[scope.tenantId,scope.storeId])
    })
    const policySource=await transactions.run(scope,tx=>appendOutboxMessage(tx,{aggregateType:'order',aggregateId:order,
      aggregateVersion:11,eventType:'print.test-fixture.v1',payload:{}}))
    const policyJobs=await transactions.run(scope,tx=>new PrintTicketSourceRepository(tx).materializeOrderSummary(policySource,order))
    expect(policyJobs).toHaveLength(1)
    expect(policyJobs[0]).toMatchObject({copies:2,printerDeviceId:bar})
    expect(await transactions.run({tenantId:randomUUID(),storeId:randomUUID()},async tx=>{
      await tx.query('SET LOCAL ROLE mbox_runtime');return (await tx.query('SELECT * FROM mbox.print_ticket_policies')).rows
    })).toEqual([])
    // Completion alone no longer emits separate slips: explicitly confirm a batch.
    const snackItem=(await pool.query('SELECT id FROM mbox.order_items WHERE order_id=$1 AND product_id=$2',[order,snack])).rows[0].id
    const task=randomUUID()
    await pool.query("UPDATE mbox.order_items SET status='ready' WHERE id=$1",[snackItem])
    await pool.query("INSERT INTO mbox.kds_tasks(id,tenant_id,store_id,order_item_id,station_code,status,quantity,ready_at) VALUES($1,$2,$3,$4,'kitchen','ready',4,clock_timestamp())",[task,scope.tenantId,scope.storeId,snackItem])
    for(const version of [1,2])await transactions.run(scope,tx=>appendOutboxMessage(tx,{aggregateType:'kds_task',aggregateId:task,aggregateVersion:version,eventType:'kds.complete.v1',payload:{}}))
    expect((await worker.runBatch(scope,'no-unbatched-delivery')).completed).toBe(0)
    const deliveryEmployee=randomUUID()
    await pool.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,'BATCH-STAFF','配送员')",[deliveryEmployee,scope.tenantId,scope.storeId])
    await transactions.run(scope,async tx=>{
      const batch=await new DeliveryBatchRepository(tx).create(deliveryEmployee,[{taskId:task,quantity:2}])
      await appendOutboxMessage(tx,{aggregateType:'delivery_batch',aggregateId:batch.id,aggregateVersion:1,eventType:'delivery.batch.ready.v1',payload:batch})
    })
    await expect(transactions.run(scope,tx=>new DeliveryBatchRepository(tx).create(deliveryEmployee,[{taskId:task,quantity:3}]))).rejects.toThrow('超过')
    expect((await worker.runBatch(scope,'delivery-test')).completed).toBe(1)
    const delivery=(await pool.query("SELECT printer_device_id,print_snapshot FROM mbox.print_jobs WHERE tenant_id=$1 AND print_snapshot->>'kind'='delivery'",[scope.tenantId])).rows
    expect(delivery).toHaveLength(1)
    expect(delivery[0].printer_device_id).toBe(kitchen)
    expect(delivery[0].print_snapshot.lines[0].name).toBe('测试小食')
    expect(delivery[0].print_snapshot.lines[0].quantity).toBe(2)
    const batchResults=await Promise.allSettled([1,2].map(()=>transactions.run(scope,async tx=>{
      const batch=await new DeliveryBatchRepository(tx).create(deliveryEmployee,[{taskId:task,quantity:2}])
      await appendOutboxMessage(tx,{aggregateType:'delivery_batch',aggregateId:batch.id,aggregateVersion:1,eventType:'delivery.batch.ready.v1',payload:batch})
    })))
    expect(batchResults.filter(result=>result.status==='fulfilled')).toHaveLength(1)
    expect(batchResults.filter(result=>result.status==='rejected')).toHaveLength(1)
    expect((await worker.runBatch(scope,'second-delivery-batch')).completed).toBe(1)
    expect((await pool.query("SELECT print_snapshot->'lines'->0->>'quantity' AS quantity FROM mbox.print_jobs WHERE tenant_id=$1 AND print_snapshot->>'kind'='delivery'",[scope.tenantId])).rows).toEqual([{quantity:'2'},{quantity:'2'}])
    // A delayed generator must not ask the kitchen to make delivered dishes
    // again merely because a print queue recovered after electronic service.
    await pool.query("UPDATE mbox.order_items SET status='delivered' WHERE order_id=$1",[order])
    expect(await transactions.run(scope,tx=>new PrintTicketSourceRepository(tx).materializeOrderProduction(randomUUID(),order))).toEqual([])
    expect(await transactions.run(scope,tx=>new PrintTicketSourceRepository(tx).materializeDelivery(source,task))).toEqual([])
    // Final table document is generated only after closure, not on a partial payment.
    expect(await transactions.run(scope,tx=>new PrintTicketSourceRepository(tx).materializeTableSettlement(source,session))).toEqual([])
    await pool.query("UPDATE mbox.payments SET status='succeeded',succeeded_at=clock_timestamp() WHERE id=$1",[payment])
    await pool.query("UPDATE mbox.orders SET payment_status='paid' WHERE id=$1",[order])
    await pool.query("UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp() WHERE id=$1",[session])
    await transactions.run(scope,tx=>appendOutboxMessage(tx,{aggregateType:'table_session',aggregateId:session,aggregateVersion:3,eventType:'table_session.closed.v1',payload:{status:'closed'}}))
    expect((await worker.runBatch(scope,'table-close-test')).completed).toBe(1)
    const final=(await pool.query("SELECT print_snapshot FROM mbox.print_jobs WHERE tenant_id=$1 AND print_snapshot->>'kind'='table_settlement'",[scope.tenantId])).rows
    expect(final).toHaveLength(1)
    expect(final[0].print_snapshot.totalAmountMinor).toBe(1500)
    expect(final[0].print_snapshot.lines.map((l:{name:string})=>l.name)).toEqual(expect.arrayContaining(['测试酒','测试小食','累计成功收款','累计成功退款']))
    await pool.query("INSERT INTO mbox.print_ticket_policies(tenant_id,store_id,ticket_kind,enabled,copies) VALUES($1,$2,'order_summary',false,1) ON CONFLICT(tenant_id,store_id,ticket_kind) DO UPDATE SET enabled=false,copies=1",[scope.tenantId,scope.storeId])
    const manual=await transactions.run(scope,async tx=>{
      const requestId=randomUUID()
      const outboxId=await appendOutboxMessage(tx,{aggregateType:'manual_print_request',aggregateId:requestId,aggregateVersion:1,eventType:'manual.order-bill.requested.v1',payload:{orderId:order}})
      const repository=new PrintTicketSourceRepository(tx,true)
      const jobs=await repository.materializeManualOrderBill(outboxId,order,'测试收银员')
      const repeated=await repository.materializeManualOrderBill(outboxId,order,'测试收银员')
      expect(repeated.map(job=>job.id)).toEqual(jobs.map(job=>job.id))
      return jobs
    })
    expect(manual).toHaveLength(1)
    expect(manual[0].printSnapshot).toMatchObject({operatorLabel:'测试收银员',totalAmountMinor:null})
    expect(manual[0].printSnapshot.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({name:'测试酒',unitAmountMinor:1000,totalAmountMinor:1000}),
      expect.objectContaining({name:'已确认实际收款',totalAmountMinor:1500}),
      expect.objectContaining({name:'尚未收款',totalAmountMinor:0}),
    ]))
  })
  it('manually prints daily sales and totals without ending the business day, and reuses the same request snapshot',async()=>{
    const before=(await pool.query('SELECT count(*)::int AS count FROM mbox.manual_business_day_ends WHERE tenant_id=$1 AND store_id=$2',[scope.tenantId,scope.storeId])).rows[0].count
    const date=(await pool.query('SELECT min(business_date)::text AS date FROM mbox.orders WHERE tenant_id=$1 AND store_id=$2',[scope.tenantId,scope.storeId])).rows[0].date
    const jobs=await transactions.run(scope,async tx=>{
      const source=await appendOutboxMessage(tx,{aggregateType:'manual_print_request',aggregateId:randomUUID(),aggregateVersion:1,eventType:'manual.daily-report.requested.v1',payload:{businessDate:date}})
      const repository=new PrintTicketSourceRepository(tx,true)
      const first=await repository.materializeManualDailyReport(source,date,'日报员工')
      const second=await repository.materializeManualDailyReport(source,date,'日报员工')
      expect(second.map(job=>job.id)).toEqual(first.map(job=>job.id))
      return first
    })
    expect(jobs.length).toBeGreaterThan(0)
    expect(jobs.flatMap(job=>job.printSnapshot.lines).map(line=>line.name)).toEqual(expect.arrayContaining(['销售合计','实际收款','实际退款','净收','尚待收款']))
    expect(jobs[0].printSnapshot).toMatchObject({kind:'daily_settlement',operatorLabel:'日报员工',businessDate:date})
    expect((await pool.query('SELECT count(*)::int AS count FROM mbox.manual_business_day_ends WHERE tenant_id=$1 AND store_id=$2',[scope.tenantId,scope.storeId])).rows[0].count).toBe(before)
  })
  it('prints an immutable daily snapshot asynchronously to cashier while printers are offline',async()=>{
    const worker=new PrintSourceWorker(transactions)
    const employee=randomUUID(),boundary=randomUUID()
    await pool.query(`INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,'DAILY-END','日结员工')`,[employee,scope.tenantId,scope.storeId])
    await pool.query(`INSERT INTO mbox.manual_business_day_ends(id,tenant_id,store_id,business_date,next_business_date,calendar_business_date,employee_id,reason,ledger_snapshot)
      VALUES($1,$2,$3,CURRENT_DATE,CURRENT_DATE+1,CURRENT_DATE,$4,'隔离日结测试',$5::jsonb)`,
    [boundary,scope.tenantId,scope.storeId,employee,JSON.stringify([{provider:'cash',receivedMinor:'1000',refundedMinor:'1800',netMinor:'-800'}])])
    await transactions.run(scope,tx=>appendOutboxMessage(tx,{businessEventKey:`daily-end:${boundary}`,aggregateType:'manual_business_day_end',aggregateId:boundary,aggregateVersion:1,eventType:'business_day.manually_ended.v1',payload:{boundaryId:boundary}}))
    const source=(await pool.query(`SELECT status FROM mbox.print_source_jobs WHERE tenant_id=$1 AND aggregate_id=$2`,[scope.tenantId,boundary])).rows[0]
    expect(source.status).toBe('pending')
    await worker.runBatch(scope,'daily-end-test')
    const jobs=(await pool.query(`SELECT station_code,print_snapshot FROM mbox.print_jobs WHERE tenant_id=$1 AND print_snapshot->>'kind'='daily_settlement' AND print_snapshot->>'ticketReference'=$2`,[scope.tenantId,boundary])).rows
    expect(jobs).toHaveLength(1)
    expect(jobs[0].station_code).toBe('cashier')
    expect(jobs[0].print_snapshot.lines[0].note).toContain('净收 -8.00')
    expect(jobs[0].print_snapshot.totalAmountMinor).toBeNull()
    await worker.runBatch(scope,'daily-end-test-retry')
    expect((await pool.query(`SELECT count(*)::int AS n FROM mbox.print_jobs WHERE tenant_id=$1 AND print_snapshot->>'kind'='daily_settlement' AND print_snapshot->>'ticketReference'=$2`,[scope.tenantId,boundary])).rows[0].n).toBe(1)
  })
})
