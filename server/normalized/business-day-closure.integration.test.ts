import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {businessDayClosureCodec,closeAwaitingBusinessDays} from './business-day-closure.js'
import {NormalizedCommandExecutor} from './command-executor.js'
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
  })

  afterAll(async()=>{await pool?.end()})

  it('closes only safe tables, then closes the old day after blockers are resolved',async()=>{
    const first=await commands.execute({scope:{tenantId,storeId},operationScope:'business-day.close-pending',
      idempotencyKey:`close-old-day-${randomUUID()}`,requestFingerprint:'close-old-day-first',
      resultCodec:businessDayClosureCodec},async transaction=>closeAwaitingBusinessDays(
        transaction,{type:'employee',employeeId},'manual_pending_business_day_close'))
    expect(first.value).toMatchObject({closedBusinessDayCount:0,closedTableSessionCount:1,
      blockedTableSessionCount:1,businessDays:[{status:'awaiting_close',
        closedTableSessions:[{tableCode:'L01'}],blockers:[{tableCode:'VIP1',code:'ORDER_UNSETTLED'}]}]})
    const afterFirst=await pool.query(`SELECT id,status FROM mbox.table_sessions
      WHERE id=ANY($1::uuid[]) ORDER BY id`,[[cleanSessionId,blockedSessionId]])
    expect(afterFirst.rows.find(row=>row.id===cleanSessionId)?.status).toBe('closed')
    expect(afterFirst.rows.find(row=>row.id===blockedSessionId)?.status).toBe('closing')
    expect((await pool.query(`SELECT status FROM mbox.business_days WHERE id=$1`,[dayId])).rows[0]?.status)
      .toBe('awaiting_close')

    await pool.query(`UPDATE mbox.orders SET status='completed',payment_status='paid',completed_at=clock_timestamp()
      WHERE id=$1`,[orderId])
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
})
