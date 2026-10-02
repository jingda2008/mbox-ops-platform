import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {beforeAll,afterAll,describe,it,expect} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner,type PostgresPool} from './transaction-runner.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {CashHandoverService,countCash} from './cash-handover-service.js'
const url=process.env.TEST_NORMALIZED_DATABASE_URL
;(url?describe:describe.skip)('native cash handover actual-count boundary',()=>{
 const tenantId=randomUUID(),storeId=randomUUID(),employeeId=randomUUID(),reviewer=randomUUID(),roleId=randomUUID(),areaId=randomUUID(),tableId=randomUUID(),sessionId=randomUUID(),orderId=randomUUID(),paymentId=randomUUID()
 const scope={tenantId,storeId};let pool:Pool,runner:ScopedPostgresTransactionRunner,service:CashHandoverService
 const context=(actor=employeeId,date='2026-09-27')=>({scope,employeeId:actor,businessDate:date})
 beforeAll(async()=>{
  await runNormalizedMigrations(url!);pool=new Pool({connectionString:url,max:6});runner=new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool);service=new CashHandoverService(runner,new NormalizedCommandExecutor(runner))
  await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'voucher test')`,[tenantId,'voucher-'+tenantId.slice(0,8)])
  await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,'voucher','voucher test')`,[storeId,tenantId])
  await pool.query(`INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'CASHIER','核销收银')`,[roleId,tenantId,storeId])
  for(const id of [employeeId,reviewer]){await pool.query(`INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,$4,'测试核销员')`,[id,tenantId,storeId,id]);await pool.query(`INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id) VALUES($1,$2,$3,$4)`,[tenantId,storeId,id,roleId])}
  for(const permission of ['reconciliation.view','payment.manual.cash.record','reconciliation.manage']){await pool.query(`INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name) VALUES($1,$2,$3,$3) ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET status='active'`,[tenantId,storeId,permission]);await pool.query(`INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code=$4 ON CONFLICT DO NOTHING`,[tenantId,storeId,roleId,permission])}

 await pool.query(`INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type,sort_order) VALUES($1,$2,$3,'CASH','cash','indoor',1)`,[areaId,tenantId,storeId])
 await pool.query(`INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,'CASH1','cash',4)`,[tableId,tenantId,storeId,areaId])
 await pool.query(`INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count,capacity_at_open,guest_profile_snapshot,status,opened_by_employee_id) VALUES($1,$2,$3,$4,$5,'2026-09-27',2,4,'{}','open',$6)`,[sessionId,tenantId,storeId,tableId,'cash-session-'+randomUUID(),employeeId])
 await pool.query(`INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,subtotal_amount_minor,discount_amount_minor,total_amount_minor) VALUES($1,$2,$3,$4,$5,'staff_assisted','submitted','unpaid',200,0,200)`,[orderId,tenantId,storeId,sessionId,'cash-order-'+randomUUID()])
 await pool.query(`INSERT INTO mbox.payments(id,tenant_id,store_id,order_id,public_id,provider,method,amount_minor,status) VALUES($1,$2,$3,$4,$5,'cash','cash',200,'created')`,[paymentId,tenantId,storeId,orderId,'cash-payment-'+randomUUID()])
 })
 afterAll(async()=>{await pool?.end()})
 it('keeps opening, movement, actual difference, dual control and cross-day receipt without manufacturing revenue',async()=>{
  const key='open-'+randomUUID(),input={action:'open' as const,amountMinor:10000,reason:'实际核对全部门店备用金'}
  const opened=await service.execute(context(),key,input);const id=opened.value.id as string
  expect((await service.execute(context(employeeId,'2026-09-28'),key,input)).replayed).toBe(true)
  await expect(service.execute(context(),'another-open-'+randomUUID(),input)).rejects.toThrow('已有进行中')
  await service.execute(context(),'move-'+randomUUID(),{action:'movement',id,expectedRevision:1,direction:'out',amountMinor:2000,reference:'BANK-REAL-001',reason:'实际银行交存现金记录'})
  const counted=await service.execute(context(),'count-'+randomUUID(),{action:'count',id,expectedRevision:2,denominations:{'5000':1,'1000':3,'100':1},reason:'实点现金多出一元待查'})
  expect(counted.value.count).toMatchObject({expectedMinor:8000,countedMinor:8100,differenceMinor:100})
  const approval={action:'approve' as const,id,expectedRevision:3,reviewCountedMinor:8100,reason:'独立实点确认并保留差异'}
  await expect(service.execute(context(),'self-'+randomUUID(),approval)).rejects.toThrow('另一名')
  const approved=await service.execute(context(reviewer),'approved-'+randomUUID(),approval)
  expect(approved.value.status).toBe('closed')
  expect((await pool.query('SELECT count(*)::int AS n FROM mbox.reconciliation_entries WHERE tenant_id=$1',[tenantId])).rows[0].n).toBe(0)
  await pool.query("UPDATE mbox.idempotency_records SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND idempotency_key=$2",[tenantId,key])
  expect((await service.execute(context(employeeId,'2026-09-29'),key,input)).value.id).toBe(id)
  const next=await service.execute(context(),'next-'+randomUUID(),{...input,amountMinor:8100});expect(next.value.openingDifferenceMinor).toBe(0)
 })
 it('requires a recount after new cash arrives, catches stale revision and bridges late cash to the next handover',async()=>{
  const row=(await service.view(context())).handovers[0]!,id=row.id as string
  await service.execute(context(),'count-'+randomUUID(),{action:'count',id,expectedRevision:1,denominations:{'5000':1,'1000':3,'100':1},reason:'第二次交接原现金实点'})
  await pool.query(`INSERT INTO mbox.reconciliation_entries(tenant_id,store_id,payment_id,entry_type,provider,provider_reference,amount_minor,business_date,occurred_at) VALUES($1,$2,$3,'payment','cash',$4,200,'2026-09-27',clock_timestamp())`,[tenantId,storeId,paymentId,'cash-ledger-'+randomUUID()])
  await expect(service.execute(context(reviewer),'approve-stale-'+randomUUID(),{action:'approve',id,expectedRevision:2,reviewCountedMinor:8100,reason:'现金已变化不可沿用旧盘点'})).rejects.toThrow('重新实点')
  await expect(service.execute(context(),'revision-'+randomUUID(),{action:'withdraw',id,expectedRevision:1,reason:'版本变化不允许覆盖原记录'})).rejects.toThrow('版本已变化')
  await service.execute(context(),'withdraw-'+randomUUID(),{action:'withdraw',id,expectedRevision:2,reason:'有新现金收款重新实点'})
  await service.execute(context(),'recount-'+randomUUID(),{action:'count',id,expectedRevision:3,denominations:{'5000':1,'1000':3,'100':3},reason:'新现金已纳入独立实点'})
  const result=await service.execute(context(reviewer),'approve-'+randomUUID(),{action:'approve',id,expectedRevision:4,reviewCountedMinor:8300,reason:'重新独立实点核对一致'})
  expect(result.value.count).toMatchObject({expectedMinor:8300,countedMinor:8300,differenceMinor:0})
  const next=await service.execute(context(),'bridge-'+randomUUID(),{action:'open',amountMinor:8000,reason:'实际收到现金少三元留痕'})
  expect(next.value.openingDifferenceMinor).toBe(-300)
  expect((await pool.query('SELECT count(*)::int AS n FROM mbox.reconciliation_entries WHERE tenant_id=$1',[tenantId])).rows[0].n).toBe(1)
 })
 it('refuses to combine foreign currency cash with renminbi',async()=>{
  await pool.query(`INSERT INTO mbox.reconciliation_entries(tenant_id,store_id,payment_id,entry_type,provider,provider_reference,amount_minor,currency,business_date,occurred_at) VALUES($1,$2,$3,'payment','cash',$4,100,'USD','2026-09-27',clock_timestamp())`,[tenantId,storeId,paymentId,'foreign-cash-'+randomUUID()])
  await expect(service.view(context())).rejects.toThrow('其他币种')
 })
 it('rejects invalid denomination quantities' ,()=>{expect(()=>countCash({'10000':-1})).toThrow();expect(()=>countCash({'3':1})).toThrow();expect(countCash({'10000':1,'50':2})).toBe(10100)})
})
