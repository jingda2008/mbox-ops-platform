import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {businessDayClosureCodec,closeAwaitingBusinessDays} from './business-day-closure.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {readTableSessionClosureState} from './table-session-closure-blockers.js'
import {readBusinessDayBlockerFacts} from './business-day-blocker-facts.js'
import {readOperatingHistory} from './operating-history-query.js'
import {recordManualBusinessDayEnd} from './manual-business-day-end-repository.js'
import {PostgresNormalizedBusinessClock} from './normalized-request-context.js'
import {ScopedPostgresTransactionRunner,type PostgresPool} from './transaction-runner.js'

const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const integration=databaseUrl ? describe:describe.skip

integration('business-day closure',()=>{
  const tenantId=randomUUID()
  const storeId=randomUUID()
  const areaId=randomUUID()
  const employeeId=randomUUID()
  const cleanTableId=randomUUID()
  const blockedTableId=randomUUID()
  const cleanSessionId=randomUUID()
  const blockedSessionId=randomUUID()
  const dayId=randomUUID()
  const orderId=randomUUID()
  const paymentId=randomUUID()
  const productId=randomUUID()
  const orderItemId=randomUUID()
  let pool:Pool
  let transactions:ScopedPostgresTransactionRunner
  let commands:NormalizedCommandExecutor


  beforeAll(async()=>{
    await runNormalizedMigrations(databaseUrl!)
    pool=new Pool({connectionString:databaseUrl,max:4})
    transactions=new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    commands=new NormalizedCommandExecutor(transactions)
    await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Business Day Tenant')`,
      [tenantId,`day-${tenantId.slice(0,8)}`])
    await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,$3,'Business Day Store')`,
      [storeId,tenantId,`day-${storeId.slice(0,8)}`])
    await pool.query(`INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type)
      VALUES($1,$2,$3,'MAIN','主区','indoor')`,[areaId,tenantId,storeId])
    await pool.query(`INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name)
      VALUES($1,$2,$3,'manager','店长')`,[employeeId,tenantId,storeId])
    await pool.query(`INSERT INTO mbox.employee_permission_overrides(
      tenant_id,store_id,employee_id,permission_id,effect,reason,configured_by_employee_id
    ) SELECT $1,$2,$3,permission.id,'grant','测试营业日结账权限',$3
      FROM mbox.staff_permission_definitions permission
      WHERE permission.tenant_id=$1 AND permission.store_id=$2 AND permission.code='business_day.close'`,
    [tenantId,storeId,employeeId])
    await pool.query(`INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity)
      VALUES($1,$3,$4,$5,'L01','L01',4),($2,$3,$4,$5,'VIP1','VIP1',8)`,
      [cleanTableId,blockedTableId,tenantId,storeId,areaId])
    await pool.query(`INSERT INTO mbox.business_days(id,tenant_id,store_id,business_date,status,rollover_at)
      VALUES($1,$2,$3,'2026-08-20','awaiting_close',clock_timestamp())`,[dayId,tenantId,storeId])
    await pool.query(`INSERT INTO mbox.table_sessions(
      id,tenant_id,store_id,table_id,public_id,business_date,guest_count,capacity_at_open,status,opened_by_employee_id)
      VALUES($1,$3,$4,$5,'business-day-clean','2026-08-20',2,4,'open',$7),
        ($2,$3,$4,$6,'business-day-blocked','2026-08-20',4,8,'closing',$7)`,
      [cleanSessionId,blockedSessionId,tenantId,storeId,cleanTableId,blockedTableId,employeeId])
    await pool.query(`INSERT INTO mbox.orders(
      id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,
      subtotal_amount_minor,total_amount_minor,created_by_employee_id,submitted_at)
      VALUES($1,$2,$3,$4,'business-day-order','staff_assisted','submitted','unpaid',12800,12800,$5,clock_timestamp())`,
      [orderId,tenantId,storeId,blockedSessionId,employeeId])
    await pool.query(`INSERT INTO mbox.products(
      id,tenant_id,store_id,code,name,category_code,fulfillment_station
    ) VALUES($1,$2,$3,'NO_FULFILLMENT','无需制作商品','service','none')`,[productId,tenantId,storeId])
    await pool.query(`INSERT INTO mbox.order_items(
      id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,
      discount_amount_minor,total_amount_minor,currency,fulfillment_station,product_snapshot,status
    ) VALUES($1,$2,$3,$4,$5,1,12800,0,12800,'CNY','none','{}'::jsonb,'submitted')`,
    [orderItemId,tenantId,storeId,orderId,productId])
    await pool.query(`INSERT INTO mbox.payments(
      id,tenant_id,store_id,order_id,public_id,provider,method,amount_minor,status
    ) VALUES($1,$2,$3,$4,'business-day-payment','postar','native_qr',12800,'pending')`,
    [paymentId,tenantId,storeId,orderId])
    await pool.query(`INSERT INTO mbox.payment_provider_actions(
      payment_id,tenant_id,store_id,presentation,initiated_by_type,initiated_by_ref,state,expires_at
    ) VALUES($1,$2,$3,'qr','employee',$4,'creating',clock_timestamp()+interval '5 minutes')`,
    [paymentId,tenantId,storeId,employeeId])
  })

  afterAll(async()=>{await pool?.end()})

  it('closes only safe tables, then closes the old day after blockers are resolved',async()=>{
    const first=await commands.execute({scope:{tenantId,storeId},operationScope:'business-day.close-pending',
      idempotencyKey:`close-old-day-${randomUUID()}`,requestFingerprint:'close-old-day-first',
      resultCodec:businessDayClosureCodec},async transaction=>closeAwaitingBusinessDays(
        transaction,{type:'employee',employeeId},'manual_pending_business_day_close'))
    expect(first.value).toMatchObject({closedBusinessDayCount:0,closedTableSessionCount:1,
      blockedTableSessionCount:1,businessDays:[{status:'awaiting_close',
        closedTableSessions:[{tableCode:'L01'}],blockers:[
          {tableCode:'VIP1',code:'ORDER_UNSETTLED',facts:[{
            type:'order',reference:'business-day-order',amountMinor:12800,
            employeeRelationLabel:'订单录入人',relatedEmployeeName:'店长',
          }]},

        ]}]})
    expect(first.value.businessDays.flatMap(day=>day.blockers).some(blocker=>blocker.code==='PAYMENT_PENDING')).toBe(false)
    const afterFirst=await pool.query(`SELECT id,status FROM mbox.table_sessions
      WHERE id=ANY($1::uuid[]) ORDER BY id`,[[cleanSessionId,blockedSessionId]])
    expect(afterFirst.rows.find(row=>row.id===cleanSessionId)?.status).toBe('closed')
    expect(afterFirst.rows.find(row=>row.id===blockedSessionId)?.status).toBe('closing')
    expect((await pool.query(`SELECT status FROM mbox.business_days WHERE id=$1`,[dayId])).rows[0]?.status)
      .toBe('awaiting_close')

    // The normal commerce/KDS path does not aggregate the order row to
    // `completed`. A paid submitted order with only non-fulfillment lines must
    // still be closable; the independent item/KDS blockers cover real prep.
    await pool.query(`UPDATE mbox.payments SET status='succeeded',provider_transaction_id='day-test-captured',
      succeeded_at=clock_timestamp() WHERE id=$1`,[paymentId])
    await pool.query(`UPDATE mbox.orders SET payment_status='paid' WHERE id=$1`,[orderId])
    const second=await commands.execute({scope:{tenantId,storeId},operationScope:'business-day.close-pending',
      idempotencyKey:`close-old-day-${randomUUID()}`,requestFingerprint:'close-old-day-second',
      resultCodec:businessDayClosureCodec},async transaction=>closeAwaitingBusinessDays(
        transaction,{type:'system',ref:'worker:business-day'},'automatic_business_day_rollover'))
    expect(second.value).toMatchObject({closedBusinessDayCount:1,closedTableSessionCount:1,
      blockedTableSessionCount:0,businessDays:[{status:'closed',closedTableSessions:[{tableCode:'VIP1'}]}]})
    expect((await pool.query(`SELECT status,close_reason FROM mbox.business_days WHERE id=$1`,[dayId])).rows[0])
      .toMatchObject({status:'closed',close_reason:'automatic_business_day_rollover'})
    expect(Number((await pool.query(`SELECT count(*) AS count FROM mbox.audit_events
      WHERE tenant_id=$1 AND store_id=$2 AND action IN ('table_session.closed_by_business_day','business_day.closed')`,
    [tenantId,storeId])).rows[0]?.count)).toBe(3)
    expect(Number((await pool.query(`SELECT count(*) AS count FROM mbox.outbox_messages
      WHERE tenant_id=$1 AND store_id=$2 AND message_type IN ('table_session.closed.v1','business_day.closed.v1')`,
    [tenantId,storeId])).rows[0]?.count)).toBe(3)
  })

  it('does not demand payment for zero-due gifts but retains their production blocker',async()=>{
    const session=randomUUID(),table=randomUUID(),order=randomUUID(),item=randomUUID()
    await pool.query(`INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity)
      VALUES($1,$2,$3,$4,'GIFT','GIFT',4)`,[table,tenantId,storeId,areaId])
    await pool.query(`INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count,capacity_at_open,status)
      VALUES($1,$2,$3,$4,$5,'2026-08-20',1,4,'open')`,[session,tenantId,storeId,table,`gift-${session}`])
    await pool.query(`INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,subtotal_amount_minor,discount_amount_minor,total_amount_minor)
      VALUES($1,$2,$3,$4,$5,'staff_assisted','submitted','unpaid',1000,1000,0)`,[order,tenantId,storeId,session,`gift-${order}`])
    await pool.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,discount_amount_minor,total_amount_minor,fulfillment_station,status,product_snapshot,cost_snapshot)
      VALUES($1,$2,$3,$4,$5,1,1000,1000,0,'bar','submitted','{}','{}')`,[item,tenantId,storeId,order,productId])
    const state=await transactions.run({tenantId,storeId},tx=>readTableSessionClosureState(tx,session))
    expect(state.blockers.map(row=>row.code)).not.toContain('ORDER_UNSETTLED')
    expect(state.blockers.map(row=>row.code)).toContain('ORDER_ITEM_UNRESOLVED')
    expect(state.outstandingAmountMinor).toBe(0)
    expect(await transactions.run({tenantId,storeId},tx=>readBusinessDayBlockerFacts(tx,session,'ORDER_UNSETTLED'))).toEqual([])
    expect((await pool.query(`SELECT payment_status FROM mbox.orders WHERE id=$1`,[order])).rows[0].payment_status).toBe('unpaid')
    const history=await transactions.run({tenantId,storeId},tx=>readOperatingHistory(tx,{businessDate:'2026-08-20',table:'GIFT',employee:'',page:0}),{readOnly:true})
    expect(history.orders).toHaveLength(1)
    expect(history.orders[0]).toMatchObject({totalMinor:0,items:[{quantity:1,unitPriceMinor:1000,totalMinor:0,status:'submitted'}]})
    expect(history.receipts).toEqual([])
    await pool.query("UPDATE mbox.order_items SET status='delivered' WHERE id=$1",[item])
    const readHistory=()=>transactions.run({tenantId,storeId},tx=>readOperatingHistory(tx,{businessDate:'2026-08-20',table:'GIFT',employee:'',page:0,exportAll:true}),{readOnly:true})
    expect((await readHistory()).orders[0]!.items[0]).toMatchObject({deliveredAt:null,deliveredBy:null})
    const task=randomUUID()
    await pool.query("INSERT INTO mbox.kds_tasks(id,tenant_id,store_id,order_item_id,station_code,status,quantity) VALUES($1,$2,$3,$4,'bar','ready',1)",[task,tenantId,storeId,item])
    await pool.query(`INSERT INTO mbox.audit_events(tenant_id,store_id,actor_type,actor_employee_id,action,object_type,object_id,business_date,occurred_at)
      VALUES($1,$2,'employee',$3,'kds.deliver','kds_task',$4,'2026-08-20','2026-08-20T15:01:02Z')`,[tenantId,storeId,employeeId,task])
    const delivered=(await readHistory()).orders[0]!.items[0]!
    expect(new Date(delivered.deliveredAt!).toISOString()).toBe('2026-08-20T15:01:02.000Z')
    expect(delivered.deliveredBy).toBeTruthy()
  })

  it('serializes a concurrent refund request with the authoritative table-session close lock',async()=>{
    const tableId=randomUUID()
    const sessionId=randomUUID()
    const raceOrderId=randomUUID()
    const racePaymentId=randomUUID()
    const refundId=randomUUID()
    await pool.query(`INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity)
      VALUES($1,$2,$3,$4,$5,$5,4)`,[tableId,tenantId,storeId,areaId,`R${tableId.slice(0,7)}`])
    await pool.query(`INSERT INTO mbox.table_sessions(
      id,tenant_id,store_id,table_id,public_id,business_date,guest_count,capacity_at_open,status,opened_by_employee_id
    ) VALUES($1,$2,$3,$4,$5,'2026-08-21',2,4,'open',$6)`,
    [sessionId,tenantId,storeId,tableId,`race-session-${sessionId}`,employeeId])
    await pool.query(`INSERT INTO mbox.orders(
      id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,
      subtotal_amount_minor,total_amount_minor,created_by_employee_id,submitted_at
    ) VALUES($1,$2,$3,$4,$5,'staff_assisted','submitted','paid',5000,5000,$6,clock_timestamp())`,
    [raceOrderId,tenantId,storeId,sessionId,`race-order-${raceOrderId}`,employeeId])
    await pool.query(`INSERT INTO mbox.payments(
      id,tenant_id,store_id,order_id,public_id,provider,provider_transaction_id,method,
      amount_minor,status,succeeded_at
    ) VALUES($1,$2,$3,$4,$5,'cash',$6,'cash',5000,'succeeded',clock_timestamp())`,
    [racePaymentId,tenantId,storeId,raceOrderId,`race-payment-${racePaymentId}`,`cash-${racePaymentId}`])

    const closingClient=await pool.connect()
    const refundClient=await pool.connect()
    try {
      await closingClient.query('BEGIN')
      await refundClient.query('BEGIN')
      const refundBackend=Number((await refundClient.query('SELECT pg_backend_pid() AS pid')).rows[0]?.pid)
      await closingClient.query(`SELECT status FROM mbox.table_sessions
        WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE`,[tenantId,storeId,sessionId])
      expect(Number((await closingClient.query(`SELECT count(*) AS count
        FROM mbox.refunds refund JOIN mbox.payments payment
          ON payment.tenant_id=refund.tenant_id AND payment.store_id=refund.store_id AND payment.id=refund.payment_id
        WHERE refund.tenant_id=$1 AND refund.store_id=$2 AND payment.order_id=$3
          AND refund.status IN ('requested','approved','processing')`,
      [tenantId,storeId,raceOrderId])).rows[0]?.count)).toBe(0)
      await closingClient.query(`UPDATE mbox.table_sessions SET status='closed',closed_by_employee_id=$4,
        closed_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,
      [tenantId,storeId,sessionId,employeeId])

      const refundOutcome=refundClient.query(`INSERT INTO mbox.refunds(
        id,tenant_id,store_id,payment_id,public_id,amount_minor,currency,status,reason,requested_by_employee_id
      ) VALUES($1,$2,$3,$4,$5,5000,'CNY','requested','并发关台测试',$6)`,
      [refundId,tenantId,storeId,racePaymentId,`race-refund-${refundId}`,employeeId])
        .then(()=>({ok:true as const,error:null}))
        .catch((error:unknown)=>({ok:false as const,error}))
      await waitForDatabaseBlock(pool,refundBackend)
      await closingClient.query('COMMIT')
      const outcome=await refundOutcome
      expect(outcome.ok).toBe(true)
      await refundClient.query('COMMIT')
    } finally {
      await closingClient.query('ROLLBACK').catch(()=>undefined)
      await refundClient.query('ROLLBACK').catch(()=>undefined)
      closingClient.release()
      refundClient.release()
    }
    expect((await pool.query(`SELECT status FROM mbox.table_sessions WHERE id=$1`,[sessionId])).rows[0]?.status)
      .toBe('closed')
    expect((await pool.query(`SELECT refund.created_at>=session.closed_at AS after_close
      FROM mbox.refunds refund JOIN mbox.payments payment ON payment.id=refund.payment_id
      JOIN mbox.orders ordering ON ordering.id=payment.order_id
      JOIN mbox.table_sessions session ON session.id=ordering.table_session_id
      WHERE refund.id=$1`,[refundId])).rows[0]?.after_close).toBe(true)

    // Reverse the ordering. If the refund transaction owns the shared fact
    // lock first, close must wait and then observe the committed blocker.
    const secondSessionId=randomUUID()
    const secondOrderId=randomUUID()
    const secondPaymentId=randomUUID()
    const secondRefundId=randomUUID()
    await pool.query(`INSERT INTO mbox.table_sessions(
      id,tenant_id,store_id,table_id,public_id,business_date,guest_count,capacity_at_open,status,opened_by_employee_id
    ) VALUES($1,$2,$3,$4,$5,'2026-08-21',2,4,'open',$6)`,
    [secondSessionId,tenantId,storeId,tableId,`race-session-${secondSessionId}`,employeeId])
    await pool.query(`INSERT INTO mbox.orders(
      id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,
      subtotal_amount_minor,total_amount_minor,created_by_employee_id,submitted_at
    ) VALUES($1,$2,$3,$4,$5,'staff_assisted','submitted','paid',5000,5000,$6,clock_timestamp())`,
    [secondOrderId,tenantId,storeId,secondSessionId,`race-order-${secondOrderId}`,employeeId])
    await pool.query(`INSERT INTO mbox.payments(
      id,tenant_id,store_id,order_id,public_id,provider,provider_transaction_id,method,
      amount_minor,status,succeeded_at
    ) VALUES($1,$2,$3,$4,$5,'cash',$6,'cash',5000,'succeeded',clock_timestamp())`,
    [secondPaymentId,tenantId,storeId,secondOrderId,`race-payment-${secondPaymentId}`,`cash-${secondPaymentId}`])
    const writerClient=await pool.connect()
    const waitingCloseClient=await pool.connect()
    try {
      await writerClient.query('BEGIN')
      await waitingCloseClient.query('BEGIN')
      await writerClient.query(`INSERT INTO mbox.refunds(
        id,tenant_id,store_id,payment_id,public_id,amount_minor,currency,status,reason,requested_by_employee_id
      ) VALUES($1,$2,$3,$4,$5,5000,'CNY','requested','先发生的退款请求',$6)`,
      [secondRefundId,tenantId,storeId,secondPaymentId,`race-refund-${secondRefundId}`,employeeId])
      const closeBackend=Number((await waitingCloseClient.query('SELECT pg_backend_pid() AS pid')).rows[0]?.pid)
      const closeLock=waitingCloseClient.query(`SELECT status FROM mbox.table_sessions
        WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE`,[tenantId,storeId,secondSessionId])
        .then(()=>({ok:true as const,error:null}))
        .catch((error:unknown)=>({ok:false as const,error}))
      await waitForDatabaseBlock(pool,closeBackend)
      await writerClient.query('COMMIT')
      expect((await closeLock).ok).toBe(true)
      expect(Number((await waitingCloseClient.query(`SELECT count(*) AS count
        FROM mbox.refunds WHERE tenant_id=$1 AND store_id=$2 AND id=$3
          AND status IN ('requested','approved','processing')`,
      [tenantId,storeId,secondRefundId])).rows[0]?.count)).toBe(1)
      await waitingCloseClient.query('ROLLBACK')
    } finally {
      await writerClient.query('ROLLBACK').catch(()=>undefined)
      await waitingCloseClient.query('ROLLBACK').catch(()=>undefined)
      writerClient.release()
      waitingCloseClient.release()
    }
    expect((await pool.query(`SELECT status FROM mbox.table_sessions WHERE id=$1`,[secondSessionId])).rows[0]?.status)
      .toBe('open')
  })

  it('keeps closed-table ownership and financial facts immutable while allowing monotonic refunds',async()=>{
    const openTableId=randomUUID()
    const closedTableId=randomUUID()
    const openSessionId=randomUUID()
    const closedSessionId=randomUUID()
    const immutableOrderId=randomUUID()
    const immutablePaymentId=randomUUID()
    const songRequestId=randomUUID()
    await pool.query(`INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity)
      VALUES($1,$3,$4,$5,$6,$6,4),($2,$3,$4,$5,$7,$7,4)`,[
      openTableId,closedTableId,tenantId,storeId,areaId,
      `O${openTableId.slice(0,7)}`,`C${closedTableId.slice(0,7)}`,
    ])
    await pool.query(`INSERT INTO mbox.table_sessions(
      id,tenant_id,store_id,table_id,public_id,business_date,guest_count,capacity_at_open,status,opened_by_employee_id
    ) VALUES($1,$3,$4,$5,$7,'2026-08-22',2,4,'open',$9),
      ($2,$3,$4,$6,$8,'2026-08-22',2,4,'open',$9)`,[
      openSessionId,closedSessionId,tenantId,storeId,openTableId,closedTableId,
      `immutable-open-${openSessionId}`,`immutable-closed-${closedSessionId}`,employeeId,
    ])
    await pool.query(`INSERT INTO mbox.orders(
      id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,
      subtotal_amount_minor,total_amount_minor,created_by_employee_id,submitted_at
    ) VALUES($1,$2,$3,$4,$5,'staff_assisted','submitted','paid',5000,5000,$6,clock_timestamp())`,[
      immutableOrderId,tenantId,storeId,closedSessionId,`immutable-order-${immutableOrderId}`,employeeId,
    ])
    await pool.query(`INSERT INTO mbox.payments(
      id,tenant_id,store_id,order_id,public_id,provider,provider_transaction_id,method,
      amount_minor,status,succeeded_at
    ) VALUES($1,$2,$3,$4,$5,'cash',$6,'cash',5000,'succeeded',clock_timestamp())`,[
      immutablePaymentId,tenantId,storeId,immutableOrderId,
      `immutable-payment-${immutablePaymentId}`,`cash-${immutablePaymentId}`,
    ])
    await pool.query(`UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp(),
      closed_by_employee_id=$2 WHERE id=$1`,[closedSessionId,employeeId])
    await pool.query(`INSERT INTO mbox.song_requests(
      id,tenant_id,store_id,table_session_id,song_title,status
    ) VALUES($1,$2,$3,$4,'测试点歌','requested')`,[
      songRequestId,tenantId,storeId,openSessionId,
    ])

    await expect(pool.query(`UPDATE mbox.song_requests SET table_session_id=$2 WHERE id=$1`,[
      songRequestId,closedSessionId,
    ])).rejects.toMatchObject({code:'23514'})
    await expect(pool.query(`UPDATE mbox.payments SET amount_minor=1 WHERE id=$1`,[
      immutablePaymentId,
    ])).rejects.toMatchObject({code:'23514'})

    await pool.query(`UPDATE mbox.payments SET status='partially_refunded' WHERE id=$1`,[immutablePaymentId])
    await pool.query(`UPDATE mbox.orders SET payment_status='partially_refunded' WHERE id=$1`,[immutableOrderId])
    await expect(pool.query(`UPDATE mbox.orders SET payment_status='paid' WHERE id=$1`,[
      immutableOrderId,
    ])).rejects.toMatchObject({code:'55000'})
    expect((await pool.query(`SELECT status,payment_status FROM mbox.orders WHERE id=$1`,[
      immutableOrderId,
    ])).rows[0]).toMatchObject({status:'submitted',payment_status:'partially_refunded'})
  })
  it('records a manual boundary once under concurrency without settling old orders or mutating its snapshot',async()=>{
    const scope={tenantId,storeId}
    const date=(await pool.query(`SELECT ((clock_timestamp() AT TIME ZONE timezone)-business_day_cutoff)::date::text AS day FROM mbox.stores WHERE id=$1`,[storeId])).rows[0].day as string
    const before=(await pool.query('SELECT status,payment_status FROM mbox.orders WHERE id=$1',[orderId])).rows[0]
    const newTable=randomUUID(),newSession=randomUUID(),oldOrder=randomUUID(),newOrder=randomUUID()
    await pool.query(`INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,'END1','日结测试',4)`,[newTable,tenantId,storeId,areaId])
    await pool.query(`INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count,capacity_at_open,status,opened_by_employee_id)
      VALUES($1,$2,$3,$4,$5,$6::date,1,4,'open',$7)`,[newSession,tenantId,storeId,newTable,`session-${newSession}`,date,employeeId])
    const addOrder=(id:string)=>pool.query(`INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,subtotal_amount_minor,total_amount_minor,created_by_employee_id)
      VALUES($1,$2,$3,$4,$5,'staff_assisted','submitted','unpaid',100,100,$6)`,[id,tenantId,storeId,newSession,`order-${id}`,employeeId])
    await addOrder(oldOrder)
    // Simulate an offline rollover worker leaving an older open-day marker.
    await pool.query(`UPDATE mbox.business_days SET status='awaiting_close' WHERE tenant_id=$1 AND store_id=$2 AND status='open'`,[tenantId,storeId])
    await pool.query(`INSERT INTO mbox.business_days(tenant_id,store_id,business_date,status) VALUES($1,$2,$3::date-1,'open')
      ON CONFLICT(tenant_id,store_id,business_date) DO UPDATE SET status='open'`,[tenantId,storeId,date])
    const results=await Promise.all([1,2].map(()=>transactions.run(scope,tx=>recordManualBusinessDayEnd(tx,{employeeId,expectedBusinessDate:date,reason:'员工提前结束测试'}))))
    expect(results[0]!.id).toBe(results[1]!.id)
    expect(results.map(row=>row.replayed).sort()).toEqual([false,true])
    const next=results[0]!.nextBusinessDate
    expect((await pool.query(`SELECT business_date::text FROM mbox.business_days WHERE tenant_id=$1 AND store_id=$2 AND status='open'`,[tenantId,storeId])).rows).toEqual([{business_date:next}])
    await addOrder(newOrder)
    const dates=(await pool.query('SELECT id,business_date::text FROM mbox.orders WHERE id=ANY($1::uuid[]) ORDER BY id',[[oldOrder,newOrder]])).rows
    expect(dates.find(row=>row.id===oldOrder).business_date).toBe(date)
    expect(dates.find(row=>row.id===newOrder).business_date).toBe(next)
    await expect(pool.query('UPDATE mbox.orders SET business_date=$2::date WHERE id=$1',[oldOrder,next])).rejects.toThrow('immutable')
    expect((await transactions.run(scope,tx=>tx.query<{day:string}>('SELECT mbox.current_operating_business_date($1,$2)::text AS day',[tenantId,storeId]),{readOnly:true})).rows[0]!.day).toBe(next)
    expect((await new PostgresNormalizedBusinessClock(transactions).current(scope)).businessDate).toBe(next)
    await expect(transactions.run(scope,tx=>recordManualBusinessDayEnd(tx,{employeeId,expectedBusinessDate:next,reason:'不得连续跳日'}))).rejects.toThrow('不能连续提前结束')
    expect((await pool.query('SELECT status,payment_status FROM mbox.orders WHERE id=$1',[orderId])).rows[0]).toEqual(before)
    await expect(pool.query(`UPDATE mbox.manual_business_day_ends SET ledger_snapshot='[]'::jsonb WHERE id=$1`,[results[0]!.id])).rejects.toThrow('immutable')
    const otherScope={tenantId,storeId:randomUUID()}
    expect((await transactions.run(otherScope,async tx=>{
      await tx.query('SET LOCAL ROLE mbox_runtime')
      return tx.query('SELECT * FROM mbox.manual_business_day_ends')
    },{readOnly:true})).rows).toEqual([])
  })
})

async function waitForDatabaseBlock(pool:Pool,backendPid:number):Promise<void>{
  for(let attempt=0;attempt<100;attempt+=1){
    const blocked=await pool.query(`SELECT cardinality(pg_blocking_pids($1::integer))>0 AS blocked`,[backendPid])
    if(blocked.rows[0]?.blocked===true)return
    await new Promise(resolve=>setTimeout(resolve,10))
  }
  throw new Error('并发写入没有等待桌次关台锁')
}
