import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import {
  assertEmployeeTableSessionAccess,
  assertEmployeeTableSessionReadAccess,
} from './employee-table-access.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

integration('employee table-session read access PostgreSQL integration', () => {
  const tenantId = randomUUID()
  const storeId = randomUUID()
  const areaId = randomUUID()
  const tableId = randomUUID()
  const tableSessionId = randomUUID()
  const employeeId = randomUUID()
  const roleId = randomUUID()
  const scope = { tenantId, storeId }
  let pool: Pool
  let transactions: ScopedPostgresTransactionRunner

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 4 })
    transactions = new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    const suffix = tenantId.replaceAll('-', '').slice(0, 10)

    await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Read Access Test Tenant')`, [
      tenantId, `read-access-${suffix}`,
    ])
    await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,$3,'Read Access Test Store')`, [
      storeId, tenantId, `read-store-${suffix}`,
    ])
    await pool.query(`
      INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type,sort_order)
      VALUES($1,$2,$3,'MAIN','主区域','indoor',1)
    `, [areaId, tenantId, storeId])
    await pool.query(`
      INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity)
      VALUES($1,$2,$3,$4,'R01','只读测试桌',4)
    `, [tableId, tenantId, storeId, areaId])
    await pool.query(`
      INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name,status)
      VALUES($1,$2,$3,$4,'测试服务员','active')
    `, [employeeId, tenantId, storeId, `read-staff-${suffix}`])
    await pool.query(`
      INSERT INTO mbox.roles(id,tenant_id,store_id,code,name)
      VALUES($1,$2,$3,'READ_ACCESS','只读测试角色')
    `, [roleId, tenantId, storeId])
    await pool.query(`
      INSERT INTO mbox.table_assignments(tenant_id,store_id,table_id,employee_id,role_id,assignment_type,reason)
      VALUES($1,$2,$3,$4,$5,'primary','测试本桌查看权限')
    `, [tenantId, storeId, tableId, employeeId, roleId])
    await pool.query(`
      INSERT INTO mbox.table_sessions(
        id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status,opened_by_employee_id
      ) VALUES($1,$2,$3,$4,$5,CURRENT_DATE,2,'open',$6)
    `, [tableSessionId, tenantId, storeId, tableId, `read-session-${suffix}`, employeeId])
  })

  afterAll(async () => pool?.end())

  it('permits the no-lock read guard in a real PostgreSQL READ ONLY transaction', async () => {
    await expect(transactions.run(scope, async (transaction) => (
      assertEmployeeTableSessionReadAccess(transaction, {
        employeeId, tableSessionId, includeTableViewAll: false,
      })
    ), { readOnly: true })).resolves.toBeUndefined()
  })

  it('documents the PostgreSQL failure avoided by the read guard', async () => {
    await expect(transactions.run(scope, async (transaction) => (
      assertEmployeeTableSessionAccess(transaction, {
        employeeId, tableSessionId, includeTableViewAll: false,
      })
    ), { readOnly: true })).rejects.toMatchObject({ code: '25006' })
  })
})
