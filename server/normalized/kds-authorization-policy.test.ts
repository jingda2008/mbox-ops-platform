import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import type { ScopedTransaction } from './index.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'
import {
  KDS_DELIVER_CAPABILITY,
  KDS_PREPARE_CAPABILITY,
  KdsAuthorizationError,
  NormalizedKdsAuthorization,
} from './kds-authorization-policy.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const employeeId = '33333333-3333-4333-8333-333333333333'
const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL

describe('NormalizedKdsAuthorization', () => {
  it('requires an active employee and the database-backed KDS capability', async () => {
    const policy = new NormalizedKdsAuthorization()
    await expect(policy.assertCanPrepare({
      transaction: transaction([{ employee_status: 'departed', allowed: true }]),
      employeeId,
      action: 'claim',
    })).rejects.toMatchObject({ code: 'KDS_ACTOR_INACTIVE', action: 'claim' })

    await expect(policy.assertCanPrepare({
      transaction: transaction([{ employee_status: 'active', allowed: false }]),
      employeeId,
      action: 'cancel',
    })).rejects.toMatchObject({ code: 'KDS_EXCEPTION_FORBIDDEN', action: 'cancel' })

    await expect(policy.assertCanPrepare({
      transaction: transaction([{ employee_status: 'active', allowed: true }]),
      employeeId,
      action: 'complete',
    })).resolves.toBeUndefined()
  })

  it('derives authorization from normalized roles and overrides, never client role text', async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = []
    const policy = new NormalizedKdsAuthorization()
    await policy.assertCanPrepare({
      transaction: transaction([{ employee_status: 'active', allowed: true }], calls),
      employeeId,
      action: 'start',
    })

    expect(calls[0]?.sql).toContain('employee_permission_overrides')
    expect(calls[0]?.sql).toContain('role_permission_assignments')
    expect(calls[0]?.sql).toContain('employee_roles')
    expect(calls[0]?.sql).toContain('FOR SHARE')
    expect(calls[0]?.values).toEqual([tenantId, storeId, employeeId, KDS_PREPARE_CAPABILITY])
  })

  it('uses one stable error class for authorization failures', () => {
    const error = new KdsAuthorizationError('KDS_PREPARE_FORBIDDEN', 'accept')
    expect(error.name).toBe('KdsAuthorizationError')
    expect(error.code).toBe('KDS_PREPARE_FORBIDDEN')
  })
})

const postgresIntegration = databaseUrl ? describe : describe.skip

postgresIntegration('NormalizedKdsAuthorization PostgreSQL integration', () => {
  const integrationTenantId = '91510000-0000-4000-8000-000000000001'
  const integrationStoreId = '91510000-0000-4000-8000-000000000002'
  const authorizedEmployeeId = '91510000-0000-4000-8000-000000000003'
  const unauthorizedEmployeeId = '91510000-0000-4000-8000-000000000004'
  const roleId = '91510000-0000-4000-8000-000000000005'
  let permissionId: string
  let deliverPermissionId: string
  const areaId = '91510000-0000-4000-8000-000000000008'
  const assignedTableId = '91510000-0000-4000-8000-000000000009'
  const otherTableId = '91510000-0000-4000-8000-000000000010'
  const credentialId = '91510000-0000-4000-8000-000000000011'
  const leaseId = '91510000-0000-4000-8000-000000000012'
  const staffSessionId = '91510000-0000-4000-8000-000000000013'
  let pool: Pool
  let runner: ScopedPostgresTransactionRunner

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 2 })
    runner = new ScopedPostgresTransactionRunner(asPool(pool))
    await pool.query(`
      INSERT INTO mbox.tenants(id, code, name)
      VALUES ($1::uuid, 'kds-auth-test', 'KDS Authorization Test')
      ON CONFLICT (id) DO NOTHING
    `, [integrationTenantId])
    await pool.query(`
      INSERT INTO mbox.stores(id, tenant_id, code, name)
      VALUES ($1::uuid, $2::uuid, 'kds-auth-store', 'KDS Authorization Store')
      ON CONFLICT (id) DO NOTHING
    `, [integrationStoreId, integrationTenantId])
    await pool.query(`
      INSERT INTO mbox.employees(id, tenant_id, store_id, employee_code, display_name, status)
      VALUES
        ($1::uuid, $3::uuid, $4::uuid, 'KDS-AUTHORIZED', 'Authorized KDS Employee', 'active'),
        ($2::uuid, $3::uuid, $4::uuid, 'KDS-READONLY', 'Read-only KDS Employee', 'active')
      ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status
    `, [authorizedEmployeeId, unauthorizedEmployeeId, integrationTenantId, integrationStoreId])
    await pool.query(`
      INSERT INTO mbox.roles(id, tenant_id, store_id, code, name, capabilities, status)
      VALUES ($1::uuid, $2::uuid, $3::uuid, 'KDS_PRODUCER', 'KDS Producer', ARRAY[]::text[], 'active')
      ON CONFLICT (id) DO UPDATE SET capabilities = ARRAY[]::text[], status = 'active'
    `, [roleId, integrationTenantId, integrationStoreId])
    const permissions = await pool.query<{ id: string; code: string }>(`
      INSERT INTO mbox.staff_permission_definitions(
        tenant_id, store_id, code, name, category, status
      ) VALUES
        ($1::uuid, $2::uuid, $3, 'Prepare KDS', 'operations', 'active'),
        ($1::uuid, $2::uuid, $4, 'Deliver KDS', 'operations', 'active')
      ON CONFLICT (tenant_id, store_id, code) DO UPDATE
      SET name = EXCLUDED.name, category = EXCLUDED.category, status = 'active'
      RETURNING id, code
    `, [integrationTenantId, integrationStoreId, KDS_PREPARE_CAPABILITY, KDS_DELIVER_CAPABILITY])
    permissionId = permissions.rows.find(({ code }) => code === KDS_PREPARE_CAPABILITY)!.id
    deliverPermissionId = permissions.rows.find(({ code }) => code === KDS_DELIVER_CAPABILITY)!.id
    await pool.query(`
      INSERT INTO mbox.employee_roles(tenant_id, store_id, employee_id, role_id)
      VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)
      ON CONFLICT DO NOTHING
    `, [integrationTenantId, integrationStoreId, authorizedEmployeeId, roleId])
    await pool.query(`
      INSERT INTO mbox.role_permission_assignments(tenant_id, store_id, role_id, permission_id)
      VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)
      ON CONFLICT (tenant_id, store_id, role_id, permission_id) DO NOTHING
    `, [integrationTenantId, integrationStoreId, roleId, permissionId])
    await pool.query(`
      INSERT INTO mbox.role_permission_assignments(tenant_id, store_id, role_id, permission_id)
      VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)
      ON CONFLICT (tenant_id, store_id, role_id, permission_id) DO NOTHING
    `, [integrationTenantId, integrationStoreId, roleId, deliverPermissionId])
    await pool.query(`
      INSERT INTO mbox.role_data_scopes(
        tenant_id, store_id, role_id, scope_key, effect, scope_value, enabled
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'kds.station_codes', 'include', '["bar"]'::jsonb, true)
      ON CONFLICT (tenant_id, store_id, role_id, scope_key, effect)
      DO UPDATE SET scope_value = EXCLUDED.scope_value, enabled = true
    `, [integrationTenantId, integrationStoreId, roleId])
    await pool.query(`
      INSERT INTO mbox.areas(id, tenant_id, store_id, code, name, area_type)
      VALUES ($1::uuid, $2::uuid, $3::uuid, 'KDS', 'KDS', 'indoor')
      ON CONFLICT (id) DO NOTHING
    `, [areaId, integrationTenantId, integrationStoreId])
    await pool.query(`
      INSERT INTO mbox.tables(id, tenant_id, store_id, area_id, code, display_name, capacity)
      VALUES
        ($1::uuid, $3::uuid, $4::uuid, $5::uuid, 'KDS1', 'Assigned', 4),
        ($2::uuid, $3::uuid, $4::uuid, $5::uuid, 'KDS2', 'Other', 4)
      ON CONFLICT (id) DO NOTHING
    `, [assignedTableId, otherTableId, integrationTenantId, integrationStoreId, areaId])
    await pool.query(`
      INSERT INTO mbox.table_assignments(
        tenant_id, store_id, table_id, employee_id, role_id, assignment_type, reason
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'primary',
        'KDS授权测试主责任桌'
      )
      ON CONFLICT DO NOTHING
    `, [integrationTenantId, integrationStoreId, assignedTableId, authorizedEmployeeId, roleId])
    await pool.query(`
      INSERT INTO mbox.store_daily_credentials(
        id, tenant_id, store_id, business_date, credential_hash,
        valid_from, valid_until, configured_by_employee_id
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, current_date, 'scrypt$integration',
        clock_timestamp() - interval '1 hour', clock_timestamp() + interval '8 hours', $4::uuid
      ) ON CONFLICT (id) DO NOTHING
    `, [credentialId, integrationTenantId, integrationStoreId, authorizedEmployeeId])
    await pool.query(`
      INSERT INTO mbox.store_device_access_leases(
        id, tenant_id, store_id, daily_credential_id, business_date,
        device_key_hash, lease_token_hash, issued_at, expires_at
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, current_date,
        repeat('a', 64), repeat('b', 64), clock_timestamp() - interval '1 hour',
        clock_timestamp() + interval '8 hours'
      ) ON CONFLICT (id) DO NOTHING
    `, [leaseId, integrationTenantId, integrationStoreId, credentialId])
    await pool.query(`
      INSERT INTO mbox.staff_sessions(
        id, tenant_id, store_id, employee_id, device_access_lease_id,
        session_token_hash, issued_at, expires_at, online_lease_until
      ) SELECT
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
        repeat('c', 64), moment.now, moment.now + interval '6 hours',
        moment.now + interval '30 minutes'
      FROM (SELECT clock_timestamp() AS now) AS moment
      ON CONFLICT (id) DO NOTHING
    `, [staffSessionId, integrationTenantId, integrationStoreId, authorizedEmployeeId, leaseId])
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('allows normalized role permission, denies read-only staff, and rejects inactive staff', async () => {
    const policy = new NormalizedKdsAuthorization()
    const authorize = (actorId: string) => runner.run(
      { tenantId: integrationTenantId, storeId: integrationStoreId },
      (transaction) => policy.assertCanPrepare({ transaction, employeeId: actorId, action: 'start' }),
    )

    await expect(authorize(authorizedEmployeeId)).resolves.toBeUndefined()
    await expect(authorize(unauthorizedEmployeeId))
      .rejects.toMatchObject({ code: 'KDS_PREPARE_FORBIDDEN' })

    await pool.query(`
      UPDATE mbox.employees SET status = 'suspended'
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
    `, [integrationTenantId, integrationStoreId, authorizedEmployeeId])
    await expect(authorize(authorizedEmployeeId)).rejects.toMatchObject({ code: 'KDS_ACTOR_INACTIVE' })
  })

  it('uses real PostgreSQL scope and assignment rows to deny cross-station and cross-table actions', async () => {
    await pool.query(`
      UPDATE mbox.employees SET status = 'active'
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
    `, [integrationTenantId, integrationStoreId, authorizedEmployeeId])
    const policy = new NormalizedKdsAuthorization()
    const authorize = (stationCode: string, tableId: string, action: 'start' | 'deliver') => runner.run(
      { tenantId: integrationTenantId, storeId: integrationStoreId },
      (transaction) => policy.assertCanActOnTask({
        transaction,
        employeeId: authorizedEmployeeId,
        staffSessionId,
        deviceAccessLeaseId: leaseId,
        action,
        stationCode,
        tableId,
      }),
    )

    await expect(authorize('bar', assignedTableId, 'start')).resolves.toBeUndefined()
    await expect(authorize('kitchen', assignedTableId, 'start'))
      .rejects.toMatchObject({ code: 'KDS_STATION_FORBIDDEN' })
    await expect(authorize('bar', assignedTableId, 'deliver')).resolves.toBeUndefined()
    await expect(authorize('bar', otherTableId, 'deliver'))
      .rejects.toMatchObject({ code: 'KDS_TABLE_FORBIDDEN' })
  })
})

function transaction(
  rows: Record<string, unknown>[],
  calls: Array<{ sql: string; values: readonly unknown[] }> = [],
): ScopedTransaction {
  return {
    scope: { tenantId, storeId },
    query: async <Row extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), values: [...values] })
      return { rows: rows as Row[], rowCount: rows.length }
    },
  }
}

function asPool(pool: Pool): PostgresPool {
  return { connect: async () => pool.connect(), end: async () => pool.end() }
}
