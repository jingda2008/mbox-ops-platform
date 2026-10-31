import {randomUUID} from 'node:crypto'
import {beforeAll,afterAll,describe,it,expect} from 'vitest'
import {Pool} from 'pg'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {OrderRepository} from './order-repository.js'
import {readTableMinimumSpend} from './table-minimum-spend.js'
import {ScopedPostgresTransactionRunner,type PostgresPool} from './transaction-runner.js'
const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const integration=databaseUrl?describe:describe.skip
integration('minimum spend PostgreSQL authority',()=>{
 const tenantId=randomUUID(),storeId=randomUUID(),areaId=randomUUID(),tableId=randomUUID(),tableSessionId=randomUUID(),managerId=randomUUID(),salespersonId=randomUUID(),productId=randomUUID(),missingCostProductId=randomUUID()
 let pool:Pool,runtimePool:Pool, transactions:ScopedPostgresTransactionRunner
 beforeAll(async()=>{await runNormalizedMigrations(databaseUrl!);pool=new Pool({connectionString:databaseUrl});runtimePool=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL?new Pool({connectionString:process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL}):pool;transactions=new ScopedPostgresTransactionRunner(runtimePool as unknown as PostgresPool);await seed()})
 afterAll(async()=>{if(runtimePool&&runtimePool!==pool)await runtimePool.end();await pool?.end()})
 it('checks exact boundary, leaves no rejected orders, and permits later small additions',async()=>{
  await pool.query('UPDATE mbox.table_sessions SET minimum_spend_minor=8801 WHERE id=$1',[tableSessionId])
  const order=()=>transactions.run({tenantId,storeId},tx=>new OrderRepository(tx).createSubmitted({tableSessionId,publicId:randomUUID(),channel:'guest_qr',lines:[{productId,quantity:1}]}))
  await expect(order()).rejects.toMatchObject({name:'TableMinimumSpendNotMetError',details:{shortfallMinor:1}})
  expect(Number((await pool.query('SELECT count(*) n FROM mbox.orders WHERE tenant_id=$1',[tenantId])).rows[0].n)).toBe(0)
  await pool.query('UPDATE mbox.table_sessions SET minimum_spend_minor=8800 WHERE id=$1',[tableSessionId])
  await order()
  const summary=await transactions.run({tenantId,storeId},tx=>readTableMinimumSpend(tx,tableSessionId,0))
  expect(summary).toMatchObject({minimumMinor:8800,consumedMinor:8800,shortfallMinor:0})
  await pool.query('UPDATE mbox.table_sessions SET minimum_spend_minor=17600 WHERE id=$1',[tableSessionId])
  await order()
  const summary2=await transactions.run({tenantId,storeId},tx=>readTableMinimumSpend(tx,tableSessionId,1))
  expect(summary2).toMatchObject({consumedMinor:17600,shortfallMinor:0})
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
