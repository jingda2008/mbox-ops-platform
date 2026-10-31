import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {StaffBootstrapQuery} from './staff-bootstrap-query.js'
import {PostgresCashierWorkbenchQuery} from './cashier-workbench-query.js'
import {OperationsQueryService} from './operations-query-service.js'
import {orderCollectionBalancesCtesSql} from './order-collection-balances-sql.js'
import {operatingHistorySummariesSql} from './operating-history-summary-sql.js'

const adminUrl=process.env.TEST_NORMALIZED_DATABASE_URL,runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
;(adminUrl&&runtimeUrl?describe:describe.skip)('shared query performance with restricted runtime and growing history',()=>{
  const scope={tenantId:randomUUID(),storeId:randomUUID()},employeeId=randomUUID(),otherId=randomUUID(),area=randomUUID(),role=randomUUID()
  const table=randomUUID(),session=randomUUID(),overpaid=randomUUID(),day='2026-10-25',count=5000
  const permissions=['reconciliation.view','order.history.all','order.history.view']
  let admin:Pool,pool:Pool,runner:ScopedPostgresTransactionRunner
  beforeAll(async()=>{
    await runNormalizedMigrations(adminUrl!)
    admin=new Pool({connectionString:adminUrl,max:1});pool=new Pool({connectionString:runtimeUrl,max:4})
    runner=new ScopedPostgresTransactionRunner(pool)
    expect((await pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=session_user')).rows[0]).toEqual({rolsuper:false,rolbypassrls:false})
    await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Synthetic query performance')",[scope.tenantId,'perf-'+scope.tenantId])
    await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name,timezone,business_day_cutoff) VALUES($1,$2,'perf','Synthetic query performance','Asia/Shanghai','06:00')",[scope.storeId,scope.tenantId])
    await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$3,$4,'finance','Synthetic finance'),($2,$3,$4,'restricted','Synthetic restricted')",[employeeId,otherId,scope.tenantId,scope.storeId])
    await admin.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'PERF_FINANCE','Synthetic finance')",[role,scope.tenantId,scope.storeId])
    await admin.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,now()-interval '1 minute')",[scope.tenantId,scope.storeId,employeeId,role])
    for(const code of permissions){
      const p=(await admin.query("INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category) VALUES($1,$2,$3,$3,'operations') ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET name=EXCLUDED.name RETURNING id",[scope.tenantId,scope.storeId,code])).rows[0].id
      await admin.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) VALUES($1,$2,$3,$4)',[scope.tenantId,scope.storeId,role,p])
    }
    await admin.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'P','Synthetic','indoor')",[area,scope.tenantId,scope.storeId])
    await admin.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,'P1','Synthetic',4)",[table,scope.tenantId,scope.storeId,area])
    await admin.query("INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1,$2,$3,$4,'perf-session','2026-01-01',1)",[session,scope.tenantId,scope.storeId,table])
    await admin.query(`INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,subtotal_amount_minor,total_amount_minor,created_at,submitted_at)
      SELECT gen_random_uuid(),$1,$2,$3,'perf-order-'||n,'staff_assisted','submitted','paid',100,100,'2026-01-01T01:00:00Z','2026-01-01T01:00:00Z'
      FROM generate_series(1,$4::int) n`,[scope.tenantId,scope.storeId,session,count])
    await admin.query(`INSERT INTO mbox.payments(id,tenant_id,store_id,order_id,public_id,provider,method,amount_minor,status,succeeded_at,provider_transaction_id)
      SELECT gen_random_uuid(),tenant_id,store_id,id,'receipt-'||public_id,'cash','cash',100,'succeeded','2026-01-01T01:00:00Z','receipt-'||public_id
      FROM mbox.orders WHERE tenant_id=$1 AND store_id=$2`,[scope.tenantId,scope.storeId])
    await admin.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,subtotal_amount_minor,total_amount_minor) VALUES($1,$2,$3,$4,'old-unpaid','staff_assisted','submitted',250,250)",[randomUUID(),scope.tenantId,scope.storeId,session])
    await admin.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,subtotal_amount_minor,total_amount_minor) VALUES($1,$2,$3,$4,'old-overcollected','staff_assisted','submitted','paid',100,100)",[overpaid,scope.tenantId,scope.storeId,session])
    await admin.query("INSERT INTO mbox.payments(id,tenant_id,store_id,order_id,public_id,provider,method,amount_minor,status,succeeded_at,provider_transaction_id) VALUES($1,$2,$3,$4,'late-extra-receipt','cash','cash',150,'succeeded','2026-01-01T01:00:00Z','late-extra-receipt')",[randomUUID(),scope.tenantId,scope.storeId,overpaid])
  },60000)
  afterAll(async()=>{await pool?.end();await admin?.end()})

  it('keeps historical debt while excluding 5000 paid orders under simultaneous page queries',async()=>{
    const timings:number[]=[]
    for(let round=0;round<2;round++){
      const run=async(name:string,operation:()=>Promise<unknown>)=>{const at=performance.now();const value=await operation();const ms=performance.now()-at;timings.push(ms);console.info(JSON.stringify({check:'shared-query-growth',round,name,orders:count+2,ms:Math.round(ms)}));return value}
      const [workspace,cashier,history]=await Promise.all([
        run('workspace',()=>new StaffBootstrapQuery(runner).get(scope,employeeId,day)),
        run('cashier',()=>new PostgresCashierWorkbenchQuery(runner).get({scope,employeeId,businessDate:day,capabilities:permissions,limit:50})),
        run('history',()=>new OperationsQueryService(runner).getOperatingHistory(scope,employeeId,{businessDate:day,table:'',employee:'',page:0})),
      ]) as [Awaited<ReturnType<StaffBootstrapQuery['get']>>,Awaited<ReturnType<PostgresCashierWorkbenchQuery['get']>>,Awaited<ReturnType<OperationsQueryService['getOperatingHistory']>>]
      expect(workspace.view.domainSummaries.find(s=>s.key==='payments')?.carryoverCount).toBe(1)
      expect(cashier.orders.map(o=>o.publicId)).toEqual(['old-unpaid','old-overcollected'])
      expect(history.orders.map(o=>o.publicId)).toEqual(['old-unpaid'])
    }
    // A bounded regression guard, not a claim about production peak capacity.
    expect(Math.max(...timings)).toBeLessThan(8000)
  },60000)

  it('retains recently captured historical receipts and excludes them again after the six-hour window',async()=>{
    const receipt=(await admin.query("SELECT id FROM mbox.payments WHERE tenant_id=$1 AND store_id=$2 AND public_id='receipt-perf-order-1'",[scope.tenantId,scope.storeId])).rows[0].id
    const query=()=>new PostgresCashierWorkbenchQuery(runner).get({scope,employeeId,businessDate:day,capabilities:permissions,limit:50})
    try{
      await admin.query("UPDATE mbox.payments SET succeeded_at=clock_timestamp()-interval '5 hours 59 minutes' WHERE id=$1",[receipt])
      const recent=await query();expect(recent.orders.map(o=>o.publicId).sort()).toEqual(['old-overcollected','old-unpaid','perf-order-1'])
      expect(recent.orders.find(o=>o.publicId==='perf-order-1')?.paymentStatus).toBe('paid')
      await admin.query("UPDATE mbox.payments SET succeeded_at=clock_timestamp()-interval '6 hours 1 minute' WHERE id=$1",[receipt])
      expect((await query()).orders.map(o=>o.publicId)).toEqual(['old-unpaid','old-overcollected'])
    }finally{await admin.query("UPDATE mbox.payments SET succeeded_at='2026-01-01T01:00:00Z' WHERE id=$1",[receipt])}
  },60000)

  it('retains financial authorization and tenant/store isolation',async()=>{
    await expect(new OperationsQueryService(runner).getOperatingHistory(scope,otherId,{businessDate:day,table:'',employee:'',page:0})).rejects.toThrow('权限')
    await runner.run(scope,async tx=>{
      const actual=await tx.query(`WITH ${orderCollectionBalancesCtesSql} SELECT count(*)::int n,count(*) FILTER(WHERE amount>0)::int due,sum(amount)::text amount FROM collection_balances`,[scope.tenantId,scope.storeId])
      expect(actual.rows).toEqual([{n:count+2,due:1,amount:'250'}])
      expect((await tx.query(`WITH ${orderCollectionBalancesCtesSql} SELECT * FROM collection_balances`,[randomUUID(),randomUUID()])).rows).toEqual([])
      const expected=await tx.query('SELECT mbox.operating_day_summary($1,$2,$3::date) summary',[scope.tenantId,scope.storeId,'2026-01-01'])
      const actualSummary=await tx.query(operatingHistorySummariesSql,[scope.tenantId,scope.storeId,'2026-01-01','2026-01-01'])
      expect(actualSummary.rows).toEqual(expected.rows)
    },{readOnly:true,isolation:'repeatable-read'})
  },60000)
})
