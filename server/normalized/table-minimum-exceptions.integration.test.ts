import {randomUUID} from 'node:crypto'
import {beforeAll,afterAll,describe,it,expect} from 'vitest'
import {Pool} from 'pg'
import Fastify from 'fastify'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {OrderRepository} from './order-repository.js'
import {PostgresAutomaticTableTurnoverRepository} from './automatic-table-turnover-repository.js'
import {readTableSessionClosureState} from './table-session-closure-blockers.js'
import {TableManagementRepository} from './table-management-repository.js'
import {PostgresTableCustomerLeftTurnoverRepository} from './table-customer-left-turnover-repository.js'
import {TablePrepaymentRepository} from './table-prepayment-repository.js'
import {TableMinimumExceptionsRepository} from './table-minimum-exceptions.js'
import {tableManagementApiPlugin} from './table-management-api.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {ScopedPostgresTransactionRunner,type PostgresPool,type ScopedTransaction} from './transaction-runner.js'
const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const integration=databaseUrl?describe:describe.skip
integration('minimum spend staff exceptions and manager adjustments',()=>{
 const tenantId=randomUUID(),storeId=randomUUID(),areaId=randomUUID(),tableId=randomUUID(),tableSessionId=randomUUID(),managerId=randomUUID(),salespersonId=randomUUID(),productId=randomUUID(),missingCostProductId=randomUUID()
 let pool:Pool,runtimePool:Pool,transactions:ScopedPostgresTransactionRunner
 beforeAll(async()=>{await runNormalizedMigrations(databaseUrl!);pool=new Pool({connectionString:databaseUrl});runtimePool=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL?new Pool({connectionString:process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL}):pool;transactions=new ScopedPostgresTransactionRunner(runtimePool as unknown as PostgresPool);await seed();await permissions()})
 afterAll(async()=>{if(runtimePool&&runtimePool!==pool)await runtimePool.end();await pool?.end()})
 const run=<T>(fn:(tx:ScopedTransaction)=>Promise<T>)=>transactions.run({tenantId,storeId},fn)
 const submit=(sessionId:string,extra:Partial<Parameters<OrderRepository['createSubmitted']>[0]>={})=>run(tx=>new OrderRepository(tx).createSubmitted({tableSessionId:sessionId,publicId:randomUUID(),channel:'staff_assisted',createdByEmployeeId:managerId,lines:[{productId,quantity:1}],...extra}))
 const summary=(id:string)=>run(tx=>new TableMinimumExceptionsRepository(tx).snapshot(id))
 const lower=(id:string,expected:number,target:number,employeeId=managerId,reason='客人沟通后调整')=>run(tx=>new TableMinimumExceptionsRepository(tx).adjust({sessionId:id,employeeId,expectedMinimumMinor:expected,targetMinimumMinor:target,reason}))
 async function session(mode='order_gate'){
  const table=randomUUID(),id=randomUUID();await pool.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,$5,'低消测试',4)",[table,tenantId,storeId,areaId,'T'+table.slice(0,8)])
  await pool.query("INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status,minimum_spend_mode,minimum_spend_minor) VALUES($1,$2,$3,$4,$5,'2026-10-31',2,'open',$6,20000)",[id,tenantId,storeId,table,randomUUID(),mode]);return id
 }
 async function app(employeeId=managerId){const app=Fastify();await app.register(tableManagementApiPlugin,{commands:{} as never,nativeCommands:new NormalizedCommandExecutor(transactions),transactions,resolveContext:()=>({scope:{tenantId,storeId},employeeId,businessDate:'2026-10-31',capabilities:[]})});return app}
 async function permissions(){const role=randomUUID();await pool.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'MIN_MANAGER','低消负责人')",[role,tenantId,storeId]);await pool.query('INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id) VALUES($1,$2,$3,$4)',[tenantId,storeId,managerId,role]);
 for(const code of ['table.open','table.close','table.turnover_unsettled','table.transfer','order.minimum_spend.release','table.minimum_spend.adjust','table.view_all','order.create','refund.request','refund.approve']){
 const permission=(await pool.query("INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category) VALUES($1,$2,$3,$3,'operations') ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET name=EXCLUDED.name RETURNING id",[tenantId,storeId,code])).rows[0].id
 await pool.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[tenantId,storeId,role,permission])}
 }

 it('releases only the selected order, keeps payment unpaid and the next order gated',async()=>{
  const id=await session();await expect(submit(id,{channel:'guest_qr',createdByEmployeeId:undefined})).rejects.toMatchObject({name:'TableMinimumSpendNotMetError'})
  const order=await submit(id,{});expect(order.paymentStatus).toBe('unpaid');expect(order.totalAmountMinor).toBe(8800)
  await expect(submit(id,{channel:'guest_qr',createdByEmployeeId:undefined})).rejects.toMatchObject({name:'TableMinimumSpendNotMetError'})
  const state=await summary(id);expect(state).toMatchObject({effectiveMinimumMinor:20000,consumedMinor:8800,shortfallMinor:11200,differenceChargingEnabled:false})
  expect(state.history).toHaveLength(1);expect(state.history[0]).toMatchObject({kind:'release',employeeId:managerId,reason:'员工账号协助点单，自动放行本单低消拦截',beforeMinor:'20000',afterMinor:'20000',orderPublicId:order.publicId,shortfallMinor:'11200'})
  await expect(run(tx=>tx.query('UPDATE mbox.order_minimum_spend_releases SET reason=$4 WHERE(tenant_id,store_id,table_session_id)=($1,$2,$3)',[tenantId,storeId,id,'篡改记录']))).rejects.toThrow()
 })
 it('rejects absent authority and guest orders atomically',async()=>{
  const id=await session()
  await expect(submit(id,{createdByEmployeeId:salespersonId,})).rejects.toMatchObject({name:'StaffAccessDeniedError'})
  await expect(submit(id,{channel:'guest_qr'})).rejects.toMatchObject({name:'TableMinimumSpendNotMetError'})
  expect((await pool.query('SELECT count(*) n FROM mbox.orders WHERE table_session_id=$1',[id])).rows[0].n).toBe('0')
 })
 it('keeps immediate payment required even after releasing the merchandise threshold',async()=>{
  const id=await session(),order=await submit(id,{settlementMode:'immediate_payment',})
  expect(order.paymentStatus).toBe('unpaid');expect((await summary(id)).consumedMinor).toBe(0)
  expect((await pool.query('SELECT count(*) n FROM mbox.payments WHERE tenant_id=$1',[tenantId])).rows[0].n).toBe('0')
 })
 it('does not bypass prepaid funding even with release permission, or after canceling the minimum',async()=>{
  const id=await session('prepaid')
  await expect(submit(id,{})).rejects.toThrow()
  await lower(id,20000,0)
  await expect(submit(id,{})).rejects.toThrow()
  expect((await pool.query('SELECT count(*) n FROM mbox.orders WHERE table_session_id=$1',[id])).rows[0].n).toBe('0')
  expect((await summary(id)).history.filter(h=>h.kind==='release')).toHaveLength(0)
 })
 for(const mode of ['order_gate','prepaid'])it(`lowers and cancels ${mode} without modifying the original minimum or creating money`,async()=>{
  const id=await session(mode);const first=await lower(id,20000,15000);expect(first.after).toMatchObject({originalMinimumMinor:20000,effectiveMinimumMinor:15000,shortfallMinor:15000})
  await lower(id,15000,0);const state=await summary(id);expect(state).toMatchObject({originalMinimumMinor:20000,effectiveMinimumMinor:0,shortfallMinor:0,differenceChargingEnabled:false})
  expect(state.history).toHaveLength(2);expect(state.history.map(h=>[h.beforeMinor,h.afterMinor])).toEqual([['15000','0'],['20000','15000']])
  expect((await pool.query('SELECT count(*) n FROM mbox.payments WHERE prepaid_table_session_id=$1',[id])).rows[0].n).toBe('0')
  expect((await pool.query('SELECT count(*) n FROM mbox.refunds WHERE tenant_id=$1',[tenantId])).rows[0].n).toBe('0')
  await expect(run(tx=>tx.query('UPDATE mbox.table_minimum_spend_waivers SET reason=$4 WHERE(tenant_id,store_id,table_session_id)=($1,$2,$3)',[tenantId,storeId,id,'改写历史']))).rejects.toThrow()
 })
 it('rejects raising, stale edits, negative values, missing reason and unauthorized adjustment',async()=>{
  const id=await session()
  for(const target of [20001,20000,-1,0.5,Number.MAX_SAFE_INTEGER+1])await expect(lower(id,20000,target)).rejects.toThrow()
  await expect(lower(id,20000,0,salespersonId)).rejects.toMatchObject({name:'StaffAccessDeniedError'})
  await expect(lower(id,20000,0,managerId,' ')).rejects.toThrow()
  await lower(id,20000,15000);await expect(lower(id,20000,0)).rejects.toMatchObject({code:'TABLE_MINIMUM_CHANGED'})
  expect((await summary(id)).history).toHaveLength(1)
 })
 it('serializes concurrent adjustments so only one stale snapshot can commit',async()=>{
  const id=await session(),results=await Promise.allSettled([lower(id,20000,15000),lower(id,20000,10000)])
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);expect((await summary(id)).history).toHaveLength(1)
 })
 it('blocks ordinary close after release; cancellation resolves only minimum, never outstanding payments',async()=>{
  const id=await session();await submit(id,{})
  expect((await run(tx=>tx.query('SELECT mbox.table_prepayment_unsettled($1,$2,$3) pending',[tenantId,storeId,id]))).rows[0].pending).toBe(true)
  await expect(pool.query("UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp() WHERE id=$1",[id])).rejects.toThrow()
  await lower(id,20000,0)
  expect((await run(tx=>tx.query('SELECT mbox.table_prepayment_unsettled($1,$2,$3) pending',[tenantId,storeId,id]))).rows[0].pending).toBe(false)
  expect((await pool.query('SELECT payment_status FROM mbox.orders WHERE table_session_id=$1',[id])).rows[0].payment_status).toBe('unpaid')
  expect((await run(tx=>readTableSessionClosureState(tx,id))).blockers.some(b=>b.code==='ORDER_UNSETTLED')).toBe(true)
 })
 it('replays adjustment once, rejects altered replay, and stores both audit snapshots',async()=>{
  const id=await session(),api=await app(),key=randomUUID(),url=`/table-management/sessions/${id}/minimum-spend`
  try{
   const input={method:'POST' as const,url,headers:{'idempotency-key':key},payload:{expectedMinimumMinor:20000,targetMinimumMinor:15000,reason:'现场沟通调整'}}
   const first=await api.inject(input);expect(first.statusCode,first.body).toBe(200)
   expect((await api.inject(input)).json().meta.replayed).toBe(true)
   expect((await api.inject({...input,payload:{...input.payload,targetMinimumMinor:0}})).statusCode).toBe(409)
   const read=await api.inject({url});expect(read.json().data.history).toHaveLength(1)
   const audit=(await pool.query("SELECT * FROM mbox.audit_events WHERE object_id=$1 AND action='table.minimum_spend.lower'",[id])).rows
   expect(audit).toHaveLength(1);expect(audit[0].before_snapshot.effectiveMinimumMinor).toBe(20000);expect(audit[0].after_snapshot.effectiveMinimumMinor).toBe(15000)
   for(const field of ['differenceMinor','collectDifference','paymentStatus'])expect((await api.inject({...input,headers:{'idempotency-key':randomUUID()},payload:{...input.payload,[field]:true}})).statusCode).toBe(400)
  }finally{await api.close()}
 })
 it('keeps revoked and cross-store access out of minimum records and mutations',async()=>{
  const id=await session(),api=await app(salespersonId)
  try{expect((await api.inject({url:`/table-management/sessions/${id}/minimum-spend`})).statusCode).toBe(403);expect((await api.inject({method:'POST',url:`/table-management/sessions/${id}/minimum-spend`,headers:{'idempotency-key':randomUUID()},payload:{expectedMinimumMinor:20000,targetMinimumMinor:0,reason:'越权取消'}})).statusCode).toBe(403)}finally{await api.close()}
  await expect(transactions.run({tenantId,storeId:randomUUID()},tx=>new TableMinimumExceptionsRepository(tx).snapshot(id))).rejects.toThrow()
 })
 it('does not permit a normal settled historical session to be changed',async()=>{
  const id=await session();await pool.query("UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp() WHERE id=$1",[id])
  await expect(lower(id,20000,0)).rejects.toMatchObject({code:'TABLE_MINIMUM_SESSION_CLOSED'})
 })
 it('keeps the legacy waiver endpoint behind dedicated manager authority',async()=>{
  const id=await session('prepaid'),api=await app(salespersonId)
  try{const response=await api.inject({method:'POST',url:`/table-management/sessions/${id}/prepayment/waive`,headers:{'idempotency-key':randomUUID()},payload:{amountMinor:20000,reason:'旧入口越权'}});expect(response.statusCode).toBe(403)}finally{await api.close()}
  expect((await summary(id)).effectiveMinimumMinor).toBe(20000)
 })

 it('retains minimum and release history across transfer, physical turnover and a fresh table session',async()=>{
  const id=await session(),order=await submit(id)
  await lower(id,20000,18000)
  const target=randomUUID();await pool.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity,minimum_spend_minor) VALUES($1,$2,$3,$4,$5,'转桌目标',4,99999)",[target,tenantId,storeId,areaId,'T'+target.slice(0,8)])
  const moved=await run(tx=>new TableManagementRepository(tx).transfer({tableSessionId:id,targetTableId:target,transferredByEmployeeId:managerId,reason:'客人整桌换位置',idempotencyKey:randomUUID(),requestFingerprint:randomUUID()},{capture:async()=>({})}))
  expect(moved.tableSessionId).toBe(id);expect((await summary(id)).effectiveMinimumMinor).toBe(18000);expect((await summary(id)).history).toHaveLength(2)
  const businessDate=(await run(tx=>tx.query<{date:string}>('SELECT mbox.current_operating_business_date($1,$2)::text date',[tenantId,storeId]))).rows[0]!.date
  await pool.query('UPDATE mbox.table_sessions SET business_date=$2 WHERE id=$1',[id,businessDate])
  await run(tx=>new PostgresTableCustomerLeftTurnoverRepository(tx).close({scope:{tenantId,storeId},tableSessionId:id,employeeId:managerId,businessDate,reasonNote:'顾客离场，保留低消和应付待办',idempotencyKey:randomUUID()}))
  const api=await app();try{const list=(await api.inject({url:'/table-management/prepayments'})).json().data;expect(list.find((r:{id:string})=>r.id===id)).toMatchObject({status:'closed',unsettled:true})}finally{await api.close()}
  const next=await run(tx=>new TableManagementRepository(tx).open({tableId:target,publicId:randomUUID(),businessDate,guestCount:2,openedByEmployeeId:managerId,primaryServiceEmployeeId:managerId,minimumSpendMode:'order_gate',minimumSpendMinor:30000}))
  expect(await summary(next.id)).toMatchObject({effectiveMinimumMinor:30000,consumedMinor:0,history:[]})
  await lower(id,18000,0);expect((await summary(next.id)).effectiveMinimumMinor).toBe(30000)
  expect((await pool.query('SELECT payment_status FROM mbox.orders WHERE id=$1',[order.id])).rows[0].payment_status).toBe('unpaid')
 })
 it('recalculates the same table for staff orders, guest additions and cancelled merchandise',async()=>{
  const id=await session();const first=await submit(id)
  await submit(id,{channel:'guest_qr',createdByEmployeeId:undefined,lines:[{productId,quantity:2}]})
  expect((await summary(id)).shortfallMinor).toBe(0)
  // Approved cancellation of unpaid merchandise must reduce the shared qualification.
  await pool.query("UPDATE mbox.orders SET status='cancelled',cancelled_at=clock_timestamp() WHERE id=$1",[first.id])
  expect((await summary(id)).shortfallMinor).toBe(2400)
  expect((await run(tx=>tx.query('SELECT mbox.table_prepayment_unsettled($1,$2,$3) pending',[tenantId,storeId,id]))).rows[0].pending).toBe(true)
 })

 it('retains an unresolved automatic-cutoff minimum without attributing it to an employee',async()=>{
  const id=await session();await submit(id)
  await pool.query("INSERT INTO mbox.store_automatic_table_turnover_policies(tenant_id,store_id,enabled,operating_starts_at) VALUES($1,$2,true,TIME '12:00')",[tenantId,storeId])
  const businessDate=(await run(tx=>tx.query<{date:string}>('SELECT mbox.current_operating_business_date($1,$2)::text date',[tenantId,storeId]))).rows[0]!.date
  await pool.query('UPDATE mbox.table_sessions SET business_date=$2::date-1 WHERE id=$1',[id,businessDate])
  await run(tx=>new PostgresAutomaticTableTurnoverRepository(tx).close({scope:{tenantId,storeId},tableSessionId:id,businessDate,reasonNote:'营业日截止，低消与原应付留待核对',idempotencyKey:randomUUID()}))
  expect((await pool.query('SELECT employee_id FROM mbox.table_prepayment_turnovers WHERE table_session_id=$1',[id])).rows[0]).toMatchObject({employee_id:null})
  expect(await summary(id)).toMatchObject({status:'closed',effectiveMinimumMinor:20000})
  await lower(id,20000,0);expect((await summary(id)).effectiveMinimumMinor).toBe(0)
 })

 it('enforces minimum authority on direct legacy writes and preserves the original employee name',async()=>{
  const id=await session();await expect(run(tx=>new TablePrepaymentRepository(tx).waive(id,salespersonId,1000,'尝试直接写入旧减免'))).rejects.toMatchObject({code:'42501'})
  await submit(id);await lower(id,20000,15000)
  await pool.query("UPDATE mbox.employees SET display_name='改名后的负责人' WHERE id=$1",[managerId])
  try{expect((await summary(id)).history.every(h=>h.employeeName==='Cost Manager')).toBe(true)}finally{await pool.query("UPDATE mbox.employees SET display_name='Cost Manager' WHERE id=$1",[managerId])}
 })

  async function seed() {
    await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Cost Authority Tenant')`,
      [tenantId, `cost-${tenantId.slice(0, 8)}`])
    await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name)
      VALUES($1,$2,$3,'Cost Authority Store')`, [storeId, tenantId, `cost-${storeId.slice(0, 8)}`])
    await pool.query(`INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type)
      VALUES($1,$2,$3,'COST','Cost Area','indoor')`, [areaId, tenantId, storeId])
    await pool.query(`INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity)
      VALUES($1,$2,$3,$4,'COST1','Cost Table',4)`, [tableId, tenantId, storeId, areaId])
    await pool.query(`INSERT INTO mbox.table_sessions(
      id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status
    ) VALUES($1,$2,$3,$4,'cost-session-0001','2026-08-16',2,'open')`,
    [tableSessionId, tenantId, storeId, tableId])
    await pool.query(`INSERT INTO mbox.employees(
      id,tenant_id,store_id,employee_code,display_name
    ) VALUES($1,$3,$4,'COST_MANAGER','Cost Manager'),($2,$3,$4,'COST_SALES','Cost Sales')`,
    [managerId, salespersonId, tenantId, storeId])
    await pool.query(`INSERT INTO mbox.products(
      id,tenant_id,store_id,code,name,category_code,fulfillment_station,
      product_snapshot,status,cost_amount_minor
    ) VALUES
      ($1,$3,$4,'COST-001','Strong Cost Product','test','none','{}','active',1050),
      ($2,$3,$4,'COST-MISSING','Missing Cost Product','test','none','{}','active',NULL)`,
    [productId, missingCostProductId, tenantId, storeId])
    await pool.query(`INSERT INTO mbox.product_prices(
      tenant_id,store_id,product_id,price_type,amount_minor,currency,valid_from
    ) VALUES
      ($1,$2,$3,'standard',8800,'CNY','2020-01-01T00:00:00Z'),
      ($1,$2,$4,'standard',6600,'CNY','2020-01-01T00:00:00Z')`,
    [tenantId, storeId, productId, missingCostProductId])
  }
})
