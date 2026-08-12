import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import {
  parseStoreProvisionConfig,
  provisionNormalizedStore,
} from '../provision-normalized-store.js'
import { inspectCommercialReadiness } from '../verify-normalized-commercial-readiness.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip
const tenantId = 'ef000000-0000-4000-8000-000000000011'
const storeId = 'ef000000-0000-4000-8000-000000000012'

integration('normalized store provisioning', () => {
  let pool: Pool
  const config = parseStoreProvisionConfig({
    version: 'integration-v2',
    tenant: { id: tenantId, code: 'provision-integration-v2', name: 'Provision Integration' },
    store: { id: storeId, code: 'provision-store-v2', name: 'Provision Store' },
    dailyCredentialEnv: 'MBOX_STORE_DAILY_CREDENTIAL',
    bootstrapAdminEmployeeCode: 'provision-tom',
    areas: [{ code: 'indoor', name: '室内', type: 'indoor' }],
    tables: [{ code: 'P01', name: 'P01', areaCode: 'indoor', capacity: 4 }],
    roles: [{
      code: 'SERVER', name: '服务员', permissions: ['table.open', 'order.create', 'order.gift'],
      navigation: [{ code: 'live', label: '现场', route: '/staff/live', highFrequency: true }],
      dataScopes: [{ key: 'area.codes', effect: 'include', value: ['indoor'] }],
      approvalLimits: [{ code: 'order.gift', amountMinor: 8800, rules: { allowFullGift: true } }],
    }],
    employees: [{ code: 'provision-tom', name: 'Tom', roleCodes: ['SERVER'], pinEnv: 'MBOX_EMPLOYEE_PIN_TOM' }],
    reservationPolicy: {
      holdMinutes: 20,
      arrivalGraceMinutes: 10,
      maxAdvanceDays: 90,
      defaultDurationMinutes: 240,
      customerCancelCutoffMinutes: 120,
      depositMode: 'disabled',
    },
  })

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 2 })
  })

  afterAll(async () => {
    await pool.end()
  })

  it('applies an idempotent secret-free definition and stores only password hashes', async () => {
    const environment = {
      MBOX_EMPLOYEE_PIN_TOM: '5210',
      MBOX_STORE_DAILY_CREDENTIAL: 'MBOX521',
    }
    const sourceCommitSha = '27e9cba12947456ce83f8da16aa4eca63af731cf'
    const nextSourceCommitSha = '38fadcba2947456ce83f8da16aa4eca63af731cf'
    const first = await provisionNormalizedStore({ databaseUrl: databaseUrl!, config, environment,
      now: new Date('2026-08-11T12:00:00.000Z'), sourceCommitSha })
    const second = await provisionNormalizedStore({ databaseUrl: databaseUrl!, config, environment,
      now: new Date('2026-08-11T12:01:00.000Z'), sourceCommitSha })
    await provisionNormalizedStore({ databaseUrl: databaseUrl!, config, environment,
      now: new Date('2026-08-11T12:01:30.000Z'), sourceCommitSha: nextSourceCommitSha })
    expect(first).toMatchObject({ areaCount: 1, tableCount: 1, roleCount: 1, employeeCount: 1,
      dailyCredentialConfigured: true, configVersion: 'integration-v2' })
    expect(first.configSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(second.employeeIds['provision-tom']).toBe(first.employeeIds['provision-tom'])
    expect(second.configSha256).toBe(first.configSha256)

    const result = await pool.query<{
      pin_hash: string
      plaintext_pins: string
      active_roles: string
      role_history: string
      active_credentials: string
      permission_count: string
      navigation_count: string
      reservation_policy_count: string
      configuration_application_count: string
      configuration_sha256: string
      latest_source_commit_sha: string
      data_scope_count: string
      approval_limit_count: string
    }>(`SELECT
      (SELECT pin_hash FROM mbox.employees WHERE tenant_id=$1 AND store_id=$2 AND employee_code='provision-tom') AS pin_hash,
      (SELECT count(*)::text FROM mbox.employees WHERE tenant_id=$1 AND pin_hash='5210') AS plaintext_pins,
      (SELECT count(*)::text FROM mbox.employee_roles WHERE tenant_id=$1 AND ends_at IS NULL) AS active_roles,
      (SELECT count(*)::text FROM mbox.employee_roles WHERE tenant_id=$1) AS role_history,
      (SELECT count(*)::text FROM mbox.store_daily_credentials WHERE tenant_id=$1 AND revoked_at IS NULL) AS active_credentials,
      (SELECT count(*)::text FROM mbox.role_permission_assignments WHERE tenant_id=$1) AS permission_count,
      (SELECT count(*)::text FROM mbox.role_navigation_items WHERE tenant_id=$1) AS navigation_count,
      (SELECT count(*)::text FROM mbox.public_reservation_policies WHERE tenant_id=$1 AND store_id=$2) AS reservation_policy_count,
      (SELECT count(*)::text FROM mbox.store_configuration_applications WHERE tenant_id=$1 AND store_id=$2) AS configuration_application_count,
      (SELECT config_sha256 FROM mbox.store_configuration_applications
        WHERE tenant_id=$1 AND store_id=$2 AND config_version='integration-v2'
        ORDER BY applied_at DESC LIMIT 1) AS configuration_sha256,
      (SELECT source_commit_sha FROM mbox.store_configuration_applications
        WHERE tenant_id=$1 AND store_id=$2 AND config_version='integration-v2'
        ORDER BY applied_at DESC LIMIT 1) AS latest_source_commit_sha,
      (SELECT count(*)::text FROM mbox.role_data_scopes WHERE tenant_id=$1 AND store_id=$2) AS data_scope_count,
      (SELECT count(*)::text FROM mbox.role_approval_limits WHERE tenant_id=$1 AND store_id=$2) AS approval_limit_count`, [tenantId, storeId])
    expect(result.rows[0]?.pin_hash).toMatch(/^scrypt\$/)
    expect(result.rows[0]).toMatchObject({ plaintext_pins: '0', active_roles: '1', role_history: '1', active_credentials: '1',
      permission_count: '3', navigation_count: '1', reservation_policy_count: '1',
      configuration_application_count: '2', configuration_sha256: first.configSha256,
      latest_source_commit_sha: nextSourceCommitSha,
      data_scope_count: '1', approval_limit_count: '1' })

    const altered = parseStoreProvisionConfig({
      ...config,
      store: { ...config.store, name: 'Tampered Store Name' },
    })
    await expect(provisionNormalizedStore({
      databaseUrl: databaseUrl!, config: altered, environment,
      now: new Date('2026-08-11T12:02:00.000Z'), sourceCommitSha,
    })).rejects.toThrow(/same version|different content|already exists/i)
    const rollback = await pool.query<{ name: string; applications: string }>(`SELECT
      (SELECT name FROM mbox.stores WHERE tenant_id=$1 AND id=$2) AS name,
      (SELECT count(*)::text FROM mbox.store_configuration_applications
        WHERE tenant_id=$1 AND store_id=$2) AS applications`, [tenantId, storeId])
    expect(rollback.rows[0]).toEqual({ name: 'Provision Store', applications: '2' })

    const readiness = await inspectCommercialReadiness({
      databaseUrl: databaseUrl!, tenantId, storeId, expectedCommitSha: nextSourceCommitSha,
    })
    expect(readiness.status).toBe('blocked')
    expect(readiness.issues.filter((issue) => issue.severity === 'blocker').map((issue) => issue.code)).toEqual([
      'catalog.unversioned',
      'catalog.empty',
      'catalog.guest_empty',
      'catalog.recommendations_insufficient',
      'tables.minimum_spend_unconfirmed',
      'tables.layout_unconfirmed',
    ])
  })

  it('preserves a role configuration after an administrator has published it', async () => {
    const identity = await pool.query<{ role_id: string; employee_id: string }>(`
      SELECT role.id AS role_id, employee.id AS employee_id
      FROM mbox.roles role
      JOIN mbox.employees employee ON employee.tenant_id=role.tenant_id AND employee.store_id=role.store_id
      WHERE role.tenant_id=$1 AND role.store_id=$2 AND role.code='SERVER' AND employee.employee_code='provision-tom'
    `, [tenantId, storeId])
    const row = identity.rows[0]
    expect(row).toBeDefined()
    await pool.query(`DELETE FROM mbox.role_permission_assignments assignment
      USING mbox.staff_permission_definitions permission
      WHERE assignment.tenant_id=$1 AND assignment.store_id=$2 AND assignment.role_id=$3
        AND permission.tenant_id=assignment.tenant_id AND permission.store_id=assignment.store_id
        AND permission.id=assignment.permission_id AND permission.code='order.gift'`, [tenantId, storeId, row!.role_id])
    await pool.query(`INSERT INTO mbox.role_access_configuration_authorities(
      tenant_id, store_id, role_id, configuration_kind, configuration_code, configured_by_employee_id)
      VALUES ($1,$2,$3,'permission','order.gift',$4)`, [tenantId, storeId, row!.role_id, row!.employee_id])

    const upgradedConfig = parseStoreProvisionConfig({
      ...config,
      version: 'integration-v3',
      roles: config.roles.map((role) => ({
        ...role,
        permissions: [...role.permissions, 'table.close'],
      })),
    })
    await provisionNormalizedStore({
      databaseUrl: databaseUrl!, config: upgradedConfig,
      environment: { MBOX_EMPLOYEE_PIN_TOM: '5210', MBOX_STORE_DAILY_CREDENTIAL: 'MBOX521' },
      now: new Date('2026-08-11T12:03:00.000Z'),
      sourceCommitSha: '49fbdcba2947456ce83f8da16aa4eca63af731cf',
    })
    const state = await pool.query<{ gift_enabled: boolean; new_default_enabled: boolean }>(`SELECT
      EXISTS(SELECT 1 FROM mbox.role_permission_assignments assignment
        JOIN mbox.staff_permission_definitions permission
          ON permission.tenant_id=assignment.tenant_id AND permission.store_id=assignment.store_id AND permission.id=assignment.permission_id
        WHERE assignment.tenant_id=$1 AND assignment.store_id=$2 AND assignment.role_id=$3 AND permission.code='order.gift') AS gift_enabled,
      EXISTS(SELECT 1 FROM mbox.role_permission_assignments assignment
        JOIN mbox.staff_permission_definitions permission
          ON permission.tenant_id=assignment.tenant_id AND permission.store_id=assignment.store_id AND permission.id=assignment.permission_id
        WHERE assignment.tenant_id=$1 AND assignment.store_id=$2 AND assignment.role_id=$3 AND permission.code='table.close') AS new_default_enabled
    `, [tenantId, storeId, row!.role_id])
    expect(state.rows[0]).toEqual({ gift_enabled: false, new_default_enabled: true })
  })
})
