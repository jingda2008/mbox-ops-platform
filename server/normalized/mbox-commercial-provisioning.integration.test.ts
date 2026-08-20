import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { Client } from 'pg'
import { describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { parseNormalizedCatalog, provisionNormalizedCatalog } from '../provision-normalized-catalog.js'
import { parseStoreProvisionConfig, provisionNormalizedStore } from '../provision-normalized-store.js'
import { inspectCommercialReadiness } from '../verify-normalized-commercial-readiness.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip
const sourceCommitSha = '27e9cba12947456ce83f8da16aa4eca63af731cf'

integration('current M-BOX commercial configuration', () => {
  it('loads the versioned store and catalog into a clean database with explicit validation controls', async () => {
    await runNormalizedMigrations(databaseUrl!)
    const storeSource = JSON.parse(await readFile(
      resolve('deploy/normalized-store/mbox-lujiazui.store.json'), 'utf8',
    )) as Record<string, Record<string, unknown>>
    const tenantId = randomUUID()
    const storeId = randomUUID()
    const suffix = tenantId.replaceAll('-', '').slice(0, 12)
    storeSource.tenant = {
      ...storeSource.tenant,
      id: tenantId,
      code: `commercial-${suffix}`,
    }
    storeSource.store = {
      ...storeSource.store,
      id: storeId,
      code: `commercial-${suffix}`,
    }
    const store = parseStoreProvisionConfig(storeSource)
    const catalog = parseNormalizedCatalog(JSON.parse(await readFile(
      resolve('config/menu-catalog-2026-07-27.json'), 'utf8',
    )))
    const environment = Object.fromEntries([
      ...store.employees.map((employee) => [employee.pinEnv, '5210']),
      [store.dailyCredentialEnv!, 'MBOX521'],
    ])

    await expectMigrationSeededRolePermissionsInConfig(databaseUrl!, store)

    const provisionedStore = await provisionNormalizedStore({
      databaseUrl: databaseUrl!, config: store, environment, sourceCommitSha,
    })
    const provisionedCatalog = await provisionNormalizedCatalog({
      databaseUrl: databaseUrl!, tenantId: store.tenant.id, storeId: store.store.id,
      catalog, sourceCommitSha,
    })
    const readiness = await inspectCommercialReadiness({
      databaseUrl: databaseUrl!, tenantId: store.tenant.id, storeId: store.store.id,
      expectedCommitSha: sourceCommitSha,
    })

    expect(provisionedStore).toMatchObject({ areaCount: 6, tableCount: 65, roleCount: 14, employeeCount: 13 })
    expect(provisionedCatalog).toMatchObject({ productCount: 81, activeProductCount: 81, bundleCount: 17 })
    expect(readiness.snapshot).toMatchObject({
      activeTables: 65,
      activeEmployees: 13,
      activeProducts: 81,
      productsMissingCurrentPrice: 0,
      productsMissingCost: 0,
      bundlesMissingComponents: 0,
      invalidBundleComponents: 0,
      financialRolesMissingLimits: [],
      kdsRolesMissingStationScopes: [],
      operationalRolesMissingPermissions: [],
      tablesMissingMinimumSpend: 0,
      tablesMissingLayout: 0,
    })
    expect(readiness.status).toBe('blocked')
    expect(readiness.issues).toEqual([
      expect.objectContaining({ severity: 'blocker', code: 'miniprogram.release_evidence_missing' }),
    ])
    expect(store.tables.every((table) => table.minimumSpendMinor === 0)).toBe(true)
    expect(store.tables.every((table) => Object.keys(table.layout ?? {}).length > 0)).toBe(true)
  }, 30_000)
})

async function expectMigrationSeededRolePermissionsInConfig(
  connectionString: string,
  store: ReturnType<typeof parseStoreProvisionConfig>,
) {
  const client = new Client({ connectionString, application_name: 'mbox-role-seed-contract-test' })
  await client.connect()
  try {
    await client.query('BEGIN')
    const tenantId = randomUUID()
    const storeId = randomUUID()
    const suffix = storeId.replaceAll('-', '').slice(0, 12)
    await client.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,$3)`, [
      tenantId, `role-seed-${suffix}`, 'Role seed contract',
    ])
    await client.query(`
      INSERT INTO mbox.stores(
        id,tenant_id,code,name,timezone,business_day_cutoff,currency
      ) VALUES($1,$2,$3,$4,$5,$6::time,$7)
    `, [
      storeId, tenantId, `role-seed-${suffix}`, 'Role seed contract',
      store.store.timezone, store.store.businessDayCutoff, store.store.currency,
    ])
    for (const role of store.roles) {
      await client.query(`
        INSERT INTO mbox.roles(
          tenant_id,store_id,code,name,capabilities,can_receive_tasks
        ) VALUES($1,$2,$3,$4,$5::text[],$6)
      `, [tenantId, storeId, role.code, role.name, role.permissions, role.canReceiveTasks])
    }
    const seeded = await client.query<{ role_code: string; permission_code: string }>(`
      SELECT role.code AS role_code,permission.code AS permission_code
      FROM mbox.role_permission_assignments assignment
      JOIN mbox.roles role ON role.tenant_id=assignment.tenant_id
        AND role.store_id=assignment.store_id AND role.id=assignment.role_id
      JOIN mbox.staff_permission_definitions permission
        ON permission.tenant_id=assignment.tenant_id AND permission.store_id=assignment.store_id
       AND permission.id=assignment.permission_id
      WHERE assignment.tenant_id=$1::uuid AND assignment.store_id=$2::uuid
      ORDER BY role.code,permission.code
    `, [tenantId, storeId])
    const configured = new Map(store.roles.map((role) => [role.code, new Set(role.permissions)]))
    const intentionalLeastPrivilegeOverrides = new Set([
      // Deputy managers may view the affected reservations but may not revise a published show.
      'DEPUT_MANAGER:performance.schedule.revise',
      // Membership merge approval remains outside the store manager role by explicit separation policy.
      'MANAGER:customer.membership.merge.approve',
    ])
    expect(seeded.rows.filter((row) => (
      !configured.get(row.role_code)?.has(row.permission_code)
      && !intentionalLeastPrivilegeOverrides.has(`${row.role_code}:${row.permission_code}`)
    )))
      .toEqual([])
  } finally {
    await client.query('ROLLBACK').catch(() => undefined)
    await client.end()
  }
}
