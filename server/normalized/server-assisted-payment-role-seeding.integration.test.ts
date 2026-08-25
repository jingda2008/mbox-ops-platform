import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'

const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const integration=databaseUrl?describe:describe.skip

integration('SERVER assigned-table service role template',()=>{
  let pool:Pool
  const tenantId=randomUUID()
  const storeId=randomUUID()
  const roleId=randomUUID()

  beforeAll(async()=>{
    await runNormalizedMigrations(databaseUrl!)
    pool=new Pool({connectionString:databaseUrl,max:2})
  })

  afterAll(async()=>pool?.end())

  it('grants a newly created SERVER only assigned-table payment and member fulfillment capabilities',async()=>{
    const suffix=tenantId.replaceAll('-','').slice(0,10)
    await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'New Store Payment Tenant')`,[
      tenantId,`nsp-${suffix}`,
    ])
    await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,$3,'New Store Payment')`,[
      storeId,tenantId,`nsp-${suffix}`,
    ])
    await pool.query(`INSERT INTO mbox.roles(id,tenant_id,store_id,code,name,status)
      VALUES($1,$2,$3,'SERVER','服务员','active')`,[roleId,tenantId,storeId])
    const permissions=await pool.query<{ code:string }>(`
      SELECT permission.code
      FROM mbox.role_permission_assignments assignment
      JOIN mbox.staff_permission_definitions permission
        ON permission.tenant_id=assignment.tenant_id AND permission.store_id=assignment.store_id
       AND permission.id=assignment.permission_id
      WHERE assignment.tenant_id=$1 AND assignment.store_id=$2 AND assignment.role_id=$3
        AND permission.code IN (
          'payment.initiate.staff','payment.collect.all_tables','loyalty.redemption.fulfill',
          'benefit.cancel','table.view_all'
        )
      ORDER BY permission.code
    `,[tenantId,storeId,roleId])
    expect(permissions.rows).toEqual([
      {code:'loyalty.redemption.fulfill'},
      {code:'payment.initiate.staff'},
    ])
  })
})
