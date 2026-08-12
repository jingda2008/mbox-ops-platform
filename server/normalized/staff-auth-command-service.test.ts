import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import {
  InvalidStaffCredentialsError,
  ScryptCredentialHasher,
  StaffAuthCommandService,
  type AuthClock,
  type StaffLoginRateLimitAttempt,
  type StaffLoginRateLimiter,
} from './staff-auth-command-service.js'
import { StaffAccessDeniedError, StaffAccessRepository } from './staff-access-repository.js'
import {
  DeviceAccessDeniedError,
  StaffSessionNotFoundError,
} from './staff-session-repository.js'
import {
  ScopedPostgresTransactionRunner,
  type PostgresPool,
  type PostgresPoolClient,
} from './transaction-runner.js'

describe('ScryptCredentialHasher', () => {
  it('uses a random salt and verifies without retaining the plaintext PIN', async () => {
    const hasher = new ScryptCredentialHasher()
    const left = await hasher.hash('5210')
    const right = await hasher.hash('5210')

    expect(left).toMatch(/^scrypt\$16384\$8\$1\$/)
    expect(left).not.toBe(right)
    expect(left).not.toContain('5210')
    await expect(hasher.verify('5210', left)).resolves.toBe(true)
    await expect(hasher.verify('0000', left)).resolves.toBe(false)
  })
})

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip
const tenantId = 'd1000000-0000-4000-8000-000000000001'
const storeId = 'd1000000-0000-4000-8000-000000000002'
const adminId = 'd1000000-0000-4000-8000-000000000003'
const employeeOneId = 'd1000000-0000-4000-8000-000000000004'
const employeeTwoId = 'd1000000-0000-4000-8000-000000000005'
const suspendedEmployeeId = 'd1000000-0000-4000-8000-000000000006'
const adminRoleId = 'd1000000-0000-4000-8000-000000000011'
const serverRoleId = 'd1000000-0000-4000-8000-000000000012'
const businessDate = '2026-08-11'
const storeCredential = 'MBOX_TEST_2026'

integration('normalized staff authentication PostgreSQL integration', () => {
  let pool: Pool
  let runner: ScopedPostgresTransactionRunner
  let limiter: RecordingRateLimiter
  let clock: MutableClock
  let service: StaffAuthCommandService
  const hasher = new ScryptCredentialHasher()

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 8 })
    runner = new ScopedPostgresTransactionRunner(asPool(pool))
    await seedIdentityAndAccess(pool, hasher)
  })

  beforeEach(async () => {
    clock = new MutableClock('2026-08-11T10:00:00.000Z')
    limiter = new RecordingRateLimiter()
    service = new StaffAuthCommandService(
      runner,
      new NormalizedCommandExecutor(runner),
      limiter,
      hasher,
      undefined,
      clock,
    )
    await resetAuthenticationState(pool, hasher)
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('rejects a suspended employee even when the PIN hash matches', async () => {
    const device = await grantDevice(service, 'suspended-device')
    await expect(service.login({
      scope: { tenantId, storeId },
      deviceAccessToken: device.leaseToken,
      employeeCode: 'suspended',
      pin: '4444',
    })).rejects.toBeInstanceOf(InvalidStaffCredentialsError)
    expect(limiter.results.at(-1)).toBe(false)
  })

  it('resolves current permissions and gives employee deny precedence over role grants', async () => {
    await service.setEmployeePermissionOverride({
      ...metadata('staff-deny-order-create-0001'),
      employeeId: employeeOneId,
      permissionCode: 'order.create',
      effect: 'deny',
      reason: 'temporary risk control',
      configuredByEmployeeId: adminId,
      startsAt: clock.now().toISOString(),
    })
    const device = await grantDevice(service, 'deny-device')
    const loggedIn = await service.login({
      scope: { tenantId, storeId },
      deviceAccessToken: device.leaseToken,
      employeeCode: 'tom',
      pin: '2222',
    })

    expect(loggedIn.access.permissions).not.toContain('order.create')
    expect(loggedIn.access.deniedPermissions).toContain('order.create')
    await runner.run({ tenantId, storeId }, async (transaction) => {
      await expect(new StaffAccessRepository(transaction).assertPermission(
        employeeOneId,
        'order.create',
        clock.now().toISOString(),
      )).rejects.toBeInstanceOf(StaffAccessDeniedError)
    })

    const evidence = await pool.query<{ audits: string; outbox: string }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.audit_events
          WHERE action = 'staff.employee-permission-override.configured') AS audits,
        (SELECT count(*)::text FROM mbox.outbox_messages
          WHERE message_type = 'staff.employee-permission-override.configured.v1') AS outbox
    `)
    expect(evidence.rows[0]).toEqual({ audits: '1', outbox: '1' })
  })

  it('revokes a session immediately and rejects subsequent authentication', async () => {
    const device = await grantDevice(service, 'revoke-device')
    const loggedIn = await service.login({
      scope: { tenantId, storeId },
      deviceAccessToken: device.leaseToken,
      employeeCode: 'tom',
      pin: '2222',
    })
    await service.revokeSession({
      scope: { tenantId, storeId },
      sessionToken: loggedIn.sessionToken,
      actorEmployeeId: employeeOneId,
      businessDate,
      reason: 'employee signed out',
    })

    await expect(service.authenticateSession(
      { tenantId, storeId },
      loggedIn.sessionToken,
    )).rejects.toBeInstanceOf(StaffSessionNotFoundError)
  })

  it('enforces the six-hour hard expiry independently of heartbeat state', async () => {
    const device = await grantDevice(service, 'expiry-device')
    const loggedIn = await service.login({
      scope: { tenantId, storeId },
      deviceAccessToken: device.leaseToken,
      employeeCode: 'tom',
      pin: '2222',
    })
    expect(loggedIn.session.expiresAt).toBe('2026-08-11 16:00:00+00')

    clock.set('2026-08-11T15:59:59.000Z')
    await expect(service.heartbeat({ tenantId, storeId }, loggedIn.sessionToken)).resolves.toMatchObject({
      access: { employeeId: employeeOneId },
    })
    clock.set('2026-08-11T16:00:00.001Z')
    await expect(service.authenticateSession(
      { tenantId, storeId },
      loggedIn.sessionToken,
    )).rejects.toBeInstanceOf(StaffSessionNotFoundError)
  })

  it('logs in different employees concurrently without a process-wide queue', async () => {
    const [deviceOne, deviceTwo] = await Promise.all([
      grantDevice(service, 'concurrent-device-one'),
      grantDevice(service, 'concurrent-device-two'),
    ])
    const [one, two] = await Promise.all([
      service.login({
        scope: { tenantId, storeId },
        deviceAccessToken: deviceOne.leaseToken,
        employeeCode: 'tom',
        pin: '2222',
      }),
      service.login({
        scope: { tenantId, storeId },
        deviceAccessToken: deviceTwo.leaseToken,
        employeeCode: 'jerry',
        pin: '3333',
      }),
    ])

    expect(new Set([one.access.employeeId, two.access.employeeId])).toEqual(
      new Set([employeeOneId, employeeTwoId]),
    )
    expect(one.session.id).not.toBe(two.session.id)
    const sessions = await pool.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM mbox.staff_sessions
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND revoked_at IS NULL
    `, [tenantId, storeId])
    expect(sessions.rows[0]?.count).toBe('2')
  })

  it('keeps role scopes, approval limits and high-frequency navigation configurable and live', async () => {
    await service.setRoleDataScope({
      ...metadata('staff-role-scope-0001'),
      roleId: serverRoleId,
      scopeKey: 'area.ids',
      effect: 'include',
      scopeValue: ['lounge', 'vip'],
      enabled: true,
      configuredByEmployeeId: adminId,
    })
    await service.setRoleApprovalLimit({
      ...metadata('staff-role-limit-0001'),
      roleId: serverRoleId,
      approvalCode: 'gift.approve',
      amountMinor: 8800,
      currency: 'CNY',
      enabled: true,
      configuredByEmployeeId: adminId,
    })
    await service.setRoleNavigation({
      ...metadata('staff-role-navigation-0001'),
      roleId: serverRoleId,
      navigationCode: 'tasks',
      label: '任务',
      route: '/tasks',
      icon: 'list-checks',
      sortOrder: 1,
      enabled: true,
      configuredByEmployeeId: adminId,
    })

    const access = await runner.run({ tenantId, storeId }, (transaction) => (
      new StaffAccessRepository(transaction).resolve(employeeTwoId, clock.now().toISOString())
    ), { readOnly: true })
    expect(access.dataScopes).toContainEqual({
      key: 'area.ids',
      effect: 'include',
      value: ['lounge', 'vip'],
    })
    expect(access.approvalLimits).toContainEqual(expect.objectContaining({
      code: 'gift.approve',
      amountMinor: 8800,
    }))
    expect(access.navigation).toContainEqual(expect.objectContaining({ code: 'tasks', route: '/tasks' }))
  })

  it('creates a replacement employee session without asking for the daily store credential again', async () => {
    const device = await grantDevice(service, 'switch-device')
    const first = await service.login({
      scope: { tenantId, storeId },
      deviceAccessToken: device.leaseToken,
      employeeCode: 'tom',
      pin: '2222',
    })
    const switched = await service.switchEmployee({
      scope: { tenantId, storeId },
      currentSessionToken: first.sessionToken,
      employeeCode: 'jerry',
      pin: '3333',
    })

    expect(switched.access.employeeId).toBe(employeeTwoId)
    await expect(service.authenticateSession({ tenantId, storeId }, first.sessionToken))
      .rejects.toBeInstanceOf(StaffSessionNotFoundError)
  })

  it('keeps an issued six-hour session independent when the daily store credential rotates', async () => {
    const device = await grantDevice(service, 'credential-rotation-device')
    const loggedIn = await service.login({
      scope: { tenantId, storeId },
      deviceAccessToken: device.leaseToken,
      employeeCode: 'tom',
      pin: '2222',
    })
    await service.configureDailyStoreCredential({
      ...metadata('staff-daily-credential-rotate-0001'),
      credential: 'MBOX_ROTATED_2026',
      validFrom: '2026-08-11T00:00:00.000Z',
      validUntil: '2026-08-12T06:00:00.000Z',
    })

    await expect(service.authenticateSession({ tenantId, storeId }, loggedIn.sessionToken))
      .resolves.toMatchObject({ access: { employeeId: employeeOneId } })
    await expect(service.switchEmployee({
      scope: { tenantId, storeId },
      currentSessionToken: loggedIn.sessionToken,
      employeeCode: 'jerry',
      pin: '3333',
    })).rejects.toBeInstanceOf(DeviceAccessDeniedError)
  })

  it('forces tenant-store RLS and persists only hashes for staff secrets and bearer tokens', async () => {
    const device = await grantDevice(service, 'rls-security-device')
    await service.login({
      scope: { tenantId, storeId },
      deviceAccessToken: device.leaseToken,
      employeeCode: 'tom',
      pin: '2222',
    })
    const security = await pool.query<{
      protected_tables: string
      plaintext_pins: string
      plaintext_store_credentials: string
      invalid_token_hashes: string
      runtime_role_can_read_sessions: boolean
    }>(`
      SELECT
        (SELECT count(*)::text
         FROM pg_class AS c
         JOIN pg_namespace AS n ON n.oid = c.relnamespace
         WHERE n.nspname = 'mbox'
           AND c.relname = ANY(ARRAY[
             'staff_permission_definitions', 'role_permission_assignments',
             'employee_permission_overrides', 'role_data_scopes', 'role_approval_limits',
             'role_navigation_items', 'store_daily_credentials',
             'store_device_access_leases', 'staff_sessions'
           ])
           AND c.relrowsecurity = true AND c.relforcerowsecurity = true) AS protected_tables,
        (SELECT count(*)::text FROM mbox.employees WHERE pin_hash ~ '^\\d{4}$') AS plaintext_pins,
        (SELECT count(*)::text FROM mbox.store_daily_credentials
          WHERE credential_hash = $1) AS plaintext_store_credentials,
        ((SELECT count(*) FROM mbox.store_device_access_leases
          WHERE lease_token_hash !~ '^[0-9a-f]{64}$')
         + (SELECT count(*) FROM mbox.staff_sessions
          WHERE session_token_hash !~ '^[0-9a-f]{64}$'))::text AS invalid_token_hashes,
        has_table_privilege('mbox_runtime', 'mbox.staff_sessions', 'SELECT') AS runtime_role_can_read_sessions
    `, [storeCredential])
    expect(security.rows[0]).toEqual({
      protected_tables: '9',
      plaintext_pins: '0',
      plaintext_store_credentials: '0',
      invalid_token_hashes: '0',
      runtime_role_can_read_sessions: true,
    })
  })
})

async function seedIdentityAndAccess(pool: Pool, hasher: ScryptCredentialHasher) {
  const [adminPin, onePin, twoPin, suspendedPin] = await Promise.all([
    hasher.hash('1111'),
    hasher.hash('2222'),
    hasher.hash('3333'),
    hasher.hash('4444'),
  ])
  await pool.query(
    `INSERT INTO mbox.tenants (id, code, name)
     VALUES ($1::uuid, 'staff-test', 'Staff test tenant')`,
    [tenantId],
  )
  await pool.query(
    `INSERT INTO mbox.stores (id, tenant_id, code, name)
     VALUES ($2::uuid, $1::uuid, 'staff-test-store', 'Staff test store')`,
    [tenantId, storeId],
  )
  await pool.query(`
    INSERT INTO mbox.employees (id, tenant_id, store_id, employee_code, display_name, pin_hash, status)
    VALUES
      ($3::uuid, $1::uuid, $2::uuid, 'admin', 'Admin', $7, 'active'),
      ($4::uuid, $1::uuid, $2::uuid, 'tom', 'Tom', $8, 'active'),
      ($5::uuid, $1::uuid, $2::uuid, 'jerry', 'Jerry', $9, 'active'),
      ($6::uuid, $1::uuid, $2::uuid, 'suspended', 'Suspended', $10, 'suspended')
  `, [tenantId, storeId, adminId, employeeOneId, employeeTwoId, suspendedEmployeeId,
    adminPin, onePin, twoPin, suspendedPin])
  await pool.query(`
    INSERT INTO mbox.roles (id, tenant_id, store_id, code, name)
    VALUES
      ($3::uuid, $1::uuid, $2::uuid, 'ADMIN', 'Administrator'),
      ($4::uuid, $1::uuid, $2::uuid, 'SERVER', 'Server')
  `, [tenantId, storeId, adminRoleId, serverRoleId])
  await pool.query(`
    INSERT INTO mbox.employee_roles (tenant_id, store_id, employee_id, role_id, starts_at)
    VALUES
      ($1::uuid, $2::uuid, $5::uuid, $3::uuid, '2026-08-11T00:00:00.000Z'),
      ($1::uuid, $2::uuid, $6::uuid, $4::uuid, '2026-08-11T00:00:00.000Z'),
      ($1::uuid, $2::uuid, $7::uuid, $4::uuid, '2026-08-11T00:00:00.000Z'),
      ($1::uuid, $2::uuid, $8::uuid, $4::uuid, '2026-08-11T00:00:00.000Z')
  `, [tenantId, storeId, adminRoleId, serverRoleId, adminId, employeeOneId, employeeTwoId, suspendedEmployeeId])
  await pool.query(`
    INSERT INTO mbox.staff_permission_definitions (tenant_id, store_id, code, name)
    VALUES
      ($1::uuid, $2::uuid, 'staff.access.configure', 'Configure staff access'),
      ($1::uuid, $2::uuid, 'staff.session.revoke', 'Revoke staff session'),
      ($1::uuid, $2::uuid, 'order.create', 'Create order')
    ON CONFLICT (tenant_id, store_id, code) DO UPDATE
    SET name = EXCLUDED.name
  `, [tenantId, storeId])
  await pool.query(`
    INSERT INTO mbox.role_permission_assignments (tenant_id, store_id, role_id, permission_id)
    SELECT $1::uuid, $2::uuid, $3::uuid, id
    FROM mbox.staff_permission_definitions
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid
      AND code IN ('staff.access.configure', 'staff.session.revoke')
    ON CONFLICT (tenant_id, store_id, role_id, permission_id) DO NOTHING
  `, [tenantId, storeId, adminRoleId])
  await pool.query(`
    INSERT INTO mbox.role_permission_assignments (tenant_id, store_id, role_id, permission_id)
    SELECT $1::uuid, $2::uuid, $3::uuid, id
    FROM mbox.staff_permission_definitions
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND code = 'order.create'
    ON CONFLICT (tenant_id, store_id, role_id, permission_id) DO NOTHING
  `, [tenantId, storeId, serverRoleId])
}

async function resetAuthenticationState(pool: Pool, hasher: ScryptCredentialHasher) {
  const tables = [
    'staff_sessions',
    'store_device_access_leases',
    'store_daily_credentials',
    'employee_permission_overrides',
    'role_data_scopes',
    'role_approval_limits',
    'role_navigation_items',
    'idempotency_records',
  ] as const
  for (const table of tables) {
    await pool.query(
      `DELETE FROM mbox.${table} WHERE tenant_id = $1::uuid AND store_id = $2::uuid`,
      [tenantId, storeId],
    )
  }
  const credentialHash = await hasher.hash(storeCredential)
  await pool.query(`
    INSERT INTO mbox.store_daily_credentials (
      tenant_id, store_id, business_date, credential_hash,
      valid_from, valid_until, configured_by_employee_id
    ) VALUES (
      $1::uuid, $2::uuid, $3::date, $4,
      '2026-08-11T00:00:00.000Z'::timestamptz,
      '2026-08-12T06:00:00.000Z'::timestamptz,
      $5::uuid
    )
  `, [tenantId, storeId, businessDate, credentialHash, adminId])
}

async function grantDevice(service: StaffAuthCommandService, deviceKey: string) {
  return service.verifyDailyStoreCredential({
    scope: { tenantId, storeId },
    businessDate,
    credential: storeCredential,
    deviceKey: `${deviceKey}-tablet`,
  })
}

function metadata(idempotencyKey: string) {
  return {
    scope: { tenantId, storeId },
    actorEmployeeId: adminId,
    businessDate,
    idempotencyKey,
    requestFingerprint: `{"idempotencyKey":"${idempotencyKey}"}`,
    reason: 'integration access configuration',
  }
}

class RecordingRateLimiter implements StaffLoginRateLimiter {
  readonly attempts: StaffLoginRateLimitAttempt[] = []
  readonly results: boolean[] = []

  async consume(attempt: Readonly<StaffLoginRateLimitAttempt>) {
    this.attempts.push({ ...attempt })
    await Promise.resolve()
  }

  async recordResult(_attempt: Readonly<StaffLoginRateLimitAttempt>, succeeded: boolean) {
    this.results.push(succeeded)
    await Promise.resolve()
  }
}

class MutableClock implements AuthClock {
  private value: Date

  constructor(value: string) {
    this.value = new Date(value)
  }

  now() {
    return new Date(this.value)
  }

  set(value: string) {
    this.value = new Date(value)
  }
}

function asPool(pool: Pool): PostgresPool {
  return {
    connect: async () => asPoolClient(await pool.connect()),
    end: async () => pool.end(),
  }
}

function asPoolClient(client: PoolClient): PostgresPoolClient {
  return {
    query: (text, values) => client.query(text, values),
    release: (error) => client.release(error),
  }
}
