import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {readOperatingHistory} from './operating-history-query.js'
import {PostgresCashierWorkbenchQuery} from './cashier-workbench-query.js'
import {ScopedPostgresTransactionRunner,type PostgresPool} from './transaction-runner.js'

const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const integration=databaseUrl?describe:describe.skip
integration('order center complete table search',()=>{
  const scope={tenantId:randomUUID(),storeId:randomUUID()},area=randomUUID(),employee=randomUUID()
  let pool:Pool,runner:ScopedPostgresTransactionRunner,date:string
  beforeAll(async()=>{
    await runNormalizedMigrations(databaseUrl!)
    pool=new Pool({connectionString:databaseUrl,max:2})
    runner=new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    await pool.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Table search')",[scope.tenantId,scope.tenantId])
    await pool.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,'search','Table search')",[scope.storeId,scope.tenantId])
    await pool.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,'reader','Reader')",[employee,scope.tenantId,scope.storeId])
    await pool.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'TEST','大厅','indoor')",[area,scope.tenantId,scope.storeId])
    date=await runner.run(scope,async tx=>(await tx.query<{date:string}>('SELECT mbox.current_operating_business_date($1,$2)::text AS date',[scope.tenantId,scope.storeId])).rows[0]!.date)
    for(const [code,publicId] of [['A5','actual-a-five'],['B2','order-b2-ca546-sample'],['W1','order-one'],['W10','order-ten'],['C1','canonical'],['C01','literal-old'],['888','numeric-table'],['B3','order-888-amount']] as const){
      const table=randomUUID(),session=randomUUID(),order=randomUUID()
      await pool.query('INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,$5,$5,4)',[table,scope.tenantId,scope.storeId,area,code])
      await pool.query("INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,status,guest_count) VALUES($1,$2,$3,$4,$5,$6,'open',2)",[session,scope.tenantId,scope.storeId,table,`visit-${code}`,date])
      await pool.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,subtotal_amount_minor,total_amount_minor,submitted_at) VALUES($1,$2,$3,$4,$5,'staff_assisted','submitted','unpaid',88800,88800,clock_timestamp())",[order,scope.tenantId,scope.storeId,session,publicId])
    }
    // A code in another store must not shadow this store's approved alias.
    const other=randomUUID(),otherArea=randomUUID()
    await pool.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,'other','Other store')",[other,scope.tenantId])
    await pool.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'OTHER','Other','indoor')",[otherArea,scope.tenantId,other])
    await pool.query("INSERT INTO mbox.tables(tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,'A05','A05',4)",[scope.tenantId,other,otherArea])
  },30000)
  afterAll(async()=>{await pool?.end()})
  const read=(extra:Record<string,unknown>)=>runner.run(scope,tx=>readOperatingHistory(tx,{businessDate:date,table:'',employee:'',page:0,allowFinancialSummary:false,...extra}),{readOnly:true})
  it('does not return newer B2 orders whose public ID contains a5',async()=>{
    for(const search of ['a5','A5','a05']){
      const result=await read({search})
      expect(result.orders.map(order=>order.tableCode)).toEqual(['A5'])
      expect(result.orders[0].publicId).toBe('actual-a-five')
    }
  })
  it('matches W1 exactly, supports approved W01 aliases and keeps export consistent',async()=>{
    for(const extra of [{search:'W1'},{search:'w01'},{table:'w1'},{table:'W01'},{search:'W1',exportAll:true}]){
      expect((await read(extra)).orders.map(order=>order.tableCode)).toEqual(['W1'])
    }
    expect((await read({search:'W'})).orders.map(order=>order.tableCode).sort()).toEqual(['W1','W10'])
  })
  it('prefers real literal codes over aliases without joining different tables',async()=>{
    expect((await read({search:'c01'})).orders.map(order=>order.tableCode)).toEqual(['C01'])
    expect((await read({search:'c1'})).orders.map(order=>order.tableCode)).toEqual(['C1'])
  })
  it('prioritizes numeric table codes while preserving amount and order ID searches',async()=>{
    expect((await read({search:'888'})).orders.map(order=>order.tableCode)).toEqual(['888'])
    expect((await read({search:'888.00'})).orders).toHaveLength(8)
    expect((await read({search:'order-b2-ca546-sample'})).orders.map(order=>order.tableCode)).toEqual(['B2'])
    expect((await read({search:'ca546'})).orders.map(order=>order.tableCode)).toEqual(['B2'])
    expect((await read({search:"' OR 1=1 --"})).orders).toEqual([])
  })
  it('applies the same exact table priority to cashier and preserves table authorization',async()=>{
    const cashier=new PostgresCashierWorkbenchQuery(runner)
    const input={scope,employeeId:employee,businessDate:date,capabilities:['reconciliation.view','community.activity.cashier'],limit:100}
    for(const query of ['a5','A05','w1','w01','C01']){
      const result=await cashier.get({...input,query})
      expect(result.orders.map(order=>order.tableCode)).toEqual([query.toLowerCase().startsWith('a')?'A5':query==='C01'?'C01':'W1'])
      expect(result.activityRegistrations).toEqual([])
    }
    expect((await cashier.get({...input,query:'ca546'})).orders.map(order=>order.tableCode)).toEqual(['B2'])
    expect((await cashier.get({...input,query:'888.00'})).orders).toHaveLength(8)
    expect((await cashier.get({...input,query:'A5',capabilities:['payment.manual.cash.record']})).orders).toEqual([])
  })
})
