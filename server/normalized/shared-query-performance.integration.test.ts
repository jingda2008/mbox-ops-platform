import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner,type ScopedTransaction,type StoreScope} from './transaction-runner.js'
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
    for(let round=0;round<3;round++){
      // Autovacuum can refresh each relation independently between requests.
      // Exercise both partial and complete statistics instead of relying on
      // a fresh fixture's underestimated row counts to avoid JIT compilation.
      if(round===1)await admin.query('ANALYZE mbox.orders')
      if(round===2)await admin.query('ANALYZE mbox.payments')
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

  it('reads the complete active visit once when the cashier looks up a table',async()=>{
    const start=performance.now()
    const view=await new PostgresCashierWorkbenchQuery(runner).get({scope,employeeId,businessDate:day,capabilities:permissions,query:'P1',limit:1})
    const elapsed=Math.round(performance.now()-start)
    console.info(JSON.stringify({check:'table-money-growth',orders:count+2,ms:elapsed}))
    expect(view.orders).toHaveLength(1)
    expect(view.selectedTable).toMatchObject({sessionId:session,money:{grossCollectedAmountMinor:count*100+150,
      refundedAmountMinor:0,cashPaymentCount:count+1,outstandingAmountMinor:250,unpaidOrderCount:1}})
    expect(elapsed).toBeLessThan(8000)
  },30000)

  it('keeps interactive query compilation settings local after commit and rollback',async()=>{
    const single=new Pool({connectionString:runtimeUrl,max:1})
    const serial=new ScopedPostgresTransactionRunner(single)
    try{
      await single.query('SET jit = on')
      for(const abort of [false,true]){
        const operation=serial.run(scope,async tx=>{
          const sameTransaction={run:async<Result>(_scope:Readonly<StoreScope>,handler:(transaction:ScopedTransaction)=>Promise<Result>)=>handler(tx)}
          const view=await new PostgresCashierWorkbenchQuery(sameTransaction as unknown as ScopedPostgresTransactionRunner).get({scope,employeeId,businessDate:day,capabilities:permissions,limit:50})
          expect(view.orders.map(o=>o.publicId)).toEqual(['old-unpaid','old-overcollected'])
          expect((await tx.query<{jit:string}>('SHOW jit')).rows[0]?.jit).toBe('off')
          if(abort)throw new Error('rollback-setting-probe')
        },{readOnly:true,isolation:'repeatable-read'})
        if(abort)await expect(operation).rejects.toThrow('rollback-setting-probe')
        else await operation
        expect((await single.query('SHOW jit')).rows[0]?.jit).toBe('on')
      }
    }finally{await single.end()}
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
      const started=performance.now()
      const expected=await tx.query('SELECT mbox.operating_day_summary($1,$2,$3::date) summary',[scope.tenantId,scope.storeId,'2026-01-01'])
      const actualSummary=await tx.query(operatingHistorySummariesSql,[scope.tenantId,scope.storeId,'2026-01-01','2026-01-01'])
      expect(actualSummary.rows).toEqual(expected.rows)
      expect(expected.rows[0]?.summary).toMatchObject({orderCount:count+2,outstandingMinor:'250',unsettledCount:1})
      const empty=await tx.query(operatingHistorySummariesSql,[scope.tenantId,scope.storeId,'2025-12-30','2025-12-31'])
      expect(empty.rows).toHaveLength(2)
      for(const row of empty.rows)expect(row.summary).toMatchObject({orderCount:0,outstandingMinor:'0'})
      const foreign=await tx.query(operatingHistorySummariesSql,[scope.tenantId,randomUUID(),'2026-01-01','2026-01-01'])
      expect(foreign.rows[0]?.summary).toMatchObject({orderCount:0,orderAmountMinor:'0'})
      console.info(JSON.stringify({check:'scoped-finance-summaries',orders:count+2,ms:Math.round(performance.now()-started)}))
      // SQL functions use a generic plan. EXPLAIN the function body itself to
      // detect repeated scans even on machines where the clock limit still passes.
      const definition=await tx.query<{prosrc:string}>("SELECT prosrc FROM pg_proc WHERE oid='mbox.operating_day_summaries(uuid,uuid,date,date)'::regprocedure")
      const body=definition.rows[0]!.prosrc.replaceAll('p_tenant','$1').replaceAll('p_store','$2').replaceAll('p_start','$3').replaceAll('p_end','$4')
      await tx.query("SET LOCAL plan_cache_mode=force_generic_plan")
      await tx.query("SET LOCAL jit=off")
      await tx.query('PREPARE report_scope_plan(uuid,uuid,date,date) AS '+body)
      try{
        type Node = {Plans?:Node[];'CTE Name'?:string;'Actual Rows':number;'Actual Loops':number;'Rows Removed by Filter'?:number}
        const plan=await tx.query<{'QUERY PLAN':{Plan:Node}[]}>(`EXPLAIN (ANALYZE, FORMAT JSON, TIMING OFF)
          EXECUTE report_scope_plan(mbox.current_tenant_id(),mbox.current_store_id(),'2026-01-01','2026-01-01')`)
        const scanned=(node:Node):number=>{
          const own=node['CTE Name']==='window_orders'?node['Actual Loops']*(node['Actual Rows']+(node['Rows Removed by Filter']??0)):0
          return own+(node.Plans??[]).reduce((n,child)=>n+scanned(child),0)
        }
        const visits=scanned(plan.rows[0]!['QUERY PLAN'][0]!.Plan)
        expect(visits).toBeGreaterThanOrEqual(count+2)
        expect(visits).toBeLessThan((count+2)*20)
        console.info(JSON.stringify({check:'day-summary-window-scans',orders:count+2,rowsVisited:visits}))
      }finally{await tx.query('DEALLOCATE report_scope_plan')}
    },{readOnly:true,isolation:'repeatable-read'})
  },60000)
})
