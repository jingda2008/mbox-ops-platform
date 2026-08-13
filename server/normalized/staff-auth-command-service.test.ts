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
import { StaffAccessManagementService } from './staff-access-management-service.js'
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
  let accessManagement: StaffAccessManagementService
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
    const executor = new NormalizedCommandExecutor(runner)
    service = new StaffAuthCommandService(
      runner,
      executor,
      limiter,
      hasher,
      undefined,
      clock,
    )
    accessManagement = new StaffAccessManagementService(runner, executor)
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

  it('publishes an employee permission exception atomically and verifies its effective state', async () => {
    const before = await accessManagement.getOverview({ scope: { tenantId, storeId }, actorEmployeeId: adminId })
    expect(before.roles.find((role) => role.id === serverRoleId)).toMatchObject({ memberCount: 2 })
    expect(before.employees.find((employee) => employee.id === employeeOneId)?.overrides).toEqual([])
    expect(before.configurationDefinitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'approval_limit', code: 'order.gift' }),
      expect.objectContaining({ kind: 'data_scope', code: 'kds.station_codes' }),
      expect.objectContaining({ kind: 'navigation', code: 'commerce' }),
    ]))

    const result = await accessManagement.deployPermissions({
      scope: { tenantId, storeId }, actorEmployeeId: adminId, businessDate,
      idempotencyKey: 'staff-access-integration-0001',
      requestFingerprint: 'tom-order-create-deny-v1',
      reason: '临时风控验证',
      changes: [{ kind: 'employee_override', employeeId: employeeOneId, permissionCode: 'order.create', effect: 'deny' }],
    })

    expect(result.status).toBe('verified')
    expect(result.changes).toEqual([expect.objectContaining({
      kind: 'employee_override', targetId: employeeOneId, applied: true,
      affectedEmployeeCount: 1, effectiveEmployeeCount: 0,
    })])
    expect(result.overview.employees.find((employee) => employee.id === employeeOneId)?.overrides).toEqual([
      expect.objectContaining({ permissionCode: 'order.create', effect: 'deny', reason: '临时风控验证' }),
    ])

    const replay = await accessManagement.deployPermissions({
      scope: { tenantId, storeId }, actorEmployeeId: adminId, businessDate,
      idempotencyKey: 'staff-access-integration-0001',
      requestFingerprint: 'tom-order-create-deny-v1',
      reason: '临时风控验证',
      changes: [{ kind: 'employee_override', employeeId: employeeOneId, permissionCode: 'order.create', effect: 'deny' }],
    })
    expect(replay.replayed).toBe(true)
    expect(replay.overview.employees.find((employee) => employee.id === employeeOneId)?.overrides).toEqual([
      expect.objectContaining({ permissionCode: 'order.create', effect: 'deny' }),
    ])
    const evidence = await pool.query<{ audits: string; outbox: string }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.audit_events
          WHERE action='staff.permission-deployment.verified'
            AND object_id=$1) AS audits,
        (SELECT count(*)::text FROM mbox.outbox_messages
          WHERE message_type='staff.permission-deployment.verified.v1'
            AND aggregate_id=$1::uuid) AS outbox
    `, [adminId])
    expect(evidence.rows[0]).toEqual({ audits: '1', outbox: '1' })
  })

  it('publishes approval, data-scope, and navigation configuration in one verified transaction', async () => {
    const result = await accessManagement.deployPermissions({
      scope: { tenantId, storeId }, actorEmployeeId: adminId, businessDate,
      idempotencyKey: 'staff-access-policy-integration-0001',
      requestFingerprint: 'server-access-policy-v1', reason: '服务员岗位边界验收',
      changes: [
        { kind: 'role_approval_limit', roleId: serverRoleId, approvalCode: 'order.gift', amountMinor: 8_800, currency: 'CNY', rules: { requiresReason: true }, enabled: true },
        { kind: 'role_data_scope', roleId: serverRoleId, scopeKey: 'kds.station_codes', effect: 'include', scopeValue: ['bar'], enabled: true },
        { kind: 'role_navigation', roleId: serverRoleId, navigationCode: 'commerce', label: '取送', route: '/staff/fulfillment', icon: null, sortOrder: 10, enabled: true, displayConfig: { highFrequency: true } },
      ],
    })

    expect(result.status).toBe('verified')
    expect(result.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'role_approval_limit', configurationCode: 'order.gift:CNY', applied: true, effectiveEmployeeCount: 2 }),
      expect.objectContaining({ kind: 'role_data_scope', configurationCode: 'kds.station_codes:include', applied: true, effectiveEmployeeCount: 2 }),
      expect.objectContaining({ kind: 'role_navigation', configurationCode: 'commerce', applied: true, effectiveEmployeeCount: 2 }),
    ]))
    const role = result.overview.roles.find((entry) => entry.id === serverRoleId)
    expect(role?.approvalLimits).toContainEqual(expect.objectContaining({ code: 'order.gift', amountMinor: 8_800, enabled: true }))
    expect(role?.dataScopes).toContainEqual(expect.objectContaining({ key: 'kds.station_codes', value: ['bar'], enabled: true }))
    expect(role?.navigation).toContainEqual(expect.objectContaining({ code: 'commerce', label: '取送', enabled: true }))
  })

  it('rolls back an entry that the role cannot actually use', async () => {
    await expect(accessManagement.deployPermissions({
      scope: { tenantId, storeId }, actorEmployeeId: adminId, businessDate,
      idempotencyKey: 'staff-access-route-lockout-0001',
      requestFingerprint: 'server-payment-route-v1', reason: '入口越权验证',
      changes: [{ kind: 'role_navigation', roleId: serverRoleId, navigationCode: 'payments', label: '收银', route: '/staff/payments', icon: null, sortOrder: 10, enabled: true, displayConfig: {} }],
    })).rejects.toThrow('缺少使用/staff/payments所需权限')
    const overview = await accessManagement.getOverview({ scope: { tenantId, storeId }, actorEmployeeId: adminId })
    expect(overview.roles.find((entry) => entry.id === serverRoleId)?.navigation).toEqual([])
  })

  it('rejects configuration codes and routes that are not registered by the server catalog', async () => {
    await expect(accessManagement.deployPermissions({
      scope: { tenantId, storeId }, actorEmployeeId: adminId, businessDate,
      idempotencyKey: 'staff-access-unknown-config-0001',
      requestFingerprint: 'unknown-config-v1', reason: '伪造配置验证',
      changes: [{ kind: 'role_data_scope', roleId: serverRoleId, scopeKey: 'unknown.scope', effect: 'include', scopeValue: ['all'], enabled: true }],
    })).rejects.toThrow('未登记的配置能力')

    await expect(accessManagement.deployPermissions({
      scope: { tenantId, storeId }, actorEmployeeId: adminId, businessDate,
      idempotencyKey: 'staff-access-route-tamper-0001',
      requestFingerprint: 'route-tamper-v1', reason: '伪造入口验证',
      changes: [{ kind: 'role_navigation', roleId: serverRoleId, navigationCode: 'commerce', label: '取送', route: '/staff/payments', icon: null, sortOrder: 10, enabled: true, displayConfig: {} }],
    })).rejects.toThrow('入口地址与服务端目录不一致')
  })

  it('rejects forged scope values and approval policies outside the server catalog', async () => {
    await expect(accessManagement.deployPermissions({
      scope: { tenantId, storeId }, actorEmployeeId: adminId, businessDate,
      idempotencyKey: 'staff-access-scope-value-tamper-0001',
      requestFingerprint: 'scope-value-tamper-v1', reason: '伪造范围验证',
      changes: [{
        kind: 'role_data_scope', roleId: serverRoleId, scopeKey: 'kds.station_codes',
        effect: 'include', scopeValue: ['forged-station'], enabled: true,
      }],
    })).rejects.toThrow('数据范围包含未登记选项')

    await expect(accessManagement.deployPermissions({
      scope: { tenantId, storeId }, actorEmployeeId: adminId, businessDate,
      idempotencyKey: 'staff-access-approval-currency-tamper-0001',
      requestFingerprint: 'approval-currency-tamper-v1', reason: '伪造额度验证',
      changes: [{
        kind: 'role_approval_limit', roleId: serverRoleId, approvalCode: 'order.gift',
        amountMinor: 8_800, currency: 'USD', rules: { requiresReason: true }, enabled: true,
      }],
    })).rejects.toThrow('审批额度币种与服务端目录不一致')

    await expect(accessManagement.deployPermissions({
      scope: { tenantId, storeId }, actorEmployeeId: adminId, businessDate,
      idempotencyKey: 'staff-access-approval-reason-tamper-0001',
      requestFingerprint: 'approval-reason-tamper-v1', reason: '赠送留痕验证',
      changes: [{
        kind: 'role_approval_limit', roleId: serverRoleId, approvalCode: 'order.gift',
        amountMinor: 8_800, currency: 'CNY', rules: { requiresReason: false }, enabled: true,
      }],
    })).rejects.toThrow('审批额度必须保留操作原因')
  })

  it('rejects enabled approval or scope configuration when the role lacks its required permission', async () => {
    await pool.query(`
      DELETE FROM mbox.role_permission_assignments assignment
      USING mbox.staff_permission_definitions permission
      WHERE assignment.tenant_id=$1::uuid AND assignment.store_id=$2::uuid
        AND assignment.role_id=$3::uuid
        AND permission.tenant_id=assignment.tenant_id AND permission.store_id=assignment.store_id
        AND permission.id=assignment.permission_id AND permission.code='order.gift'
    `, [tenantId, storeId, serverRoleId])

    await expect(accessManagement.deployPermissions({
      scope: { tenantId, storeId }, actorEmployeeId: adminId, businessDate,
      idempotencyKey: 'staff-access-approval-prerequisite-0001',
      requestFingerprint: 'approval-prerequisite-v1', reason: '缺少权限验证',
      changes: [{
        kind: 'role_approval_limit', roleId: serverRoleId, approvalCode: 'order.gift',
        amountMinor: 8_800, currency: 'CNY', rules: { requiresReason: true }, enabled: true,
      }],
    })).rejects.toThrow('缺少配置order.gift所需权限')

    await pool.query(`
      INSERT INTO mbox.role_permission_assignments (tenant_id, store_id, role_id, permission_id)
      SELECT $1::uuid, $2::uuid, $3::uuid, id
      FROM mbox.staff_permission_definitions
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND code='order.gift'
      ON CONFLICT (tenant_id, store_id, role_id, permission_id) DO NOTHING
    `, [tenantId, storeId, serverRoleId])
  })

  it('does not let an unrelated legacy navigation entry block an employee exception', async () => {
    await pool.query(`
      INSERT INTO mbox.role_navigation_items (
        tenant_id, store_id, role_id, navigation_code, label, route,
        enabled, display_config, configured_by_employee_id
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'legacy', '旧入口', '/staff/legacy', true, '{}'::jsonb, $4::uuid)
    `, [tenantId, storeId, serverRoleId, adminId])

    for (let index = 0; index < 8; index += 1) {
      const effect = index % 2 === 0 ? 'deny' : 'grant'
      const result = await accessManagement.deployPermissions({
        scope: { tenantId, storeId }, actorEmployeeId: adminId, businessDate,
        idempotencyKey: `staff-access-legacy-route-exception-${String(index).padStart(4, '0')}`,
        requestFingerprint: `tom-legacy-route-exception-${effect}-${index}`, reason: '员工例外独立发布',
        changes: [{ kind: 'employee_override', employeeId: employeeOneId, permissionCode: 'order.create', effect }],
      })

      expect(result.status).toBe('verified')
      expect(result.changes).toEqual([expect.objectContaining({
        kind: 'employee_override', targetId: employeeOneId, applied: true,
      })])
    }
  })

  it('rolls back a deployment that would remove the final access administrator', async () => {
    await expect(accessManagement.deployPermissions({
      scope: { tenantId, storeId }, actorEmployeeId: adminId, businessDate,
      idempotencyKey: 'staff-access-lockout-0001',
      requestFingerprint: 'remove-final-admin-v1',
      reason: '验证管理员保底',
      changes: [{ kind: 'role_permission', roleId: adminRoleId, permissionCode: 'staff.access.configure', enabled: false }],
    })).rejects.toThrow('门店没有任何权限管理员')

    const overview = await accessManagement.getOverview({ scope: { tenantId, storeId }, actorEmployeeId: adminId })
    expect(overview.roles.find((role) => role.id === adminRoleId)?.permissionCodes).toContain('staff.access.configure')
    const failedEvidence = await pool.query<{ audits: string; outbox: string }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.audit_events
          WHERE action='staff.permission-deployment.verified'
            AND reason='验证管理员保底') AS audits,
        (SELECT count(*)::text FROM mbox.outbox_messages
          WHERE message_key='staff-permission-deployment:staff-access-lockout-0001') AS outbox
    `)
    expect(failedEvidence.rows[0]).toEqual({ audits: '0', outbox: '0' })
  })

  it('rolls back and emits no verified evidence when the stored permission fails post-write verification', async () => {
    await pool.query(`
      CREATE OR REPLACE FUNCTION mbox.test_ignore_server_permission_delete()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.role_id = '${serverRoleId}'::uuid THEN RETURN NULL; END IF;
        RETURN OLD;
      END
      $$;
      DROP TRIGGER IF EXISTS test_ignore_server_permission_delete
        ON mbox.role_permission_assignments;
      CREATE TRIGGER test_ignore_server_permission_delete
        BEFORE DELETE ON mbox.role_permission_assignments
        FOR EACH ROW EXECUTE FUNCTION mbox.test_ignore_server_permission_delete();
    `)
    try {
      await expect(accessManagement.deployPermissions({
        scope: { tenantId, storeId }, actorEmployeeId: adminId, businessDate,
        idempotencyKey: 'staff-access-post-write-verification-0001',
        requestFingerprint: 'server-order-create-disable-v1', reason: '写入后复核回滚验证',
        changes: [{ kind: 'role_permission', roleId: serverRoleId, permissionCode: 'order.create', enabled: false }],
      })).rejects.toThrow('权限写入后复核不一致，已回滚全部修改')
    } finally {
      await pool.query(`
        DROP TRIGGER IF EXISTS test_ignore_server_permission_delete
          ON mbox.role_permission_assignments;
        DROP FUNCTION IF EXISTS mbox.test_ignore_server_permission_delete();
      `)
    }

    const state = await pool.query<{ assignment: string; authority: string; audits: string; outbox: string }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.role_permission_assignments assignment
          JOIN mbox.staff_permission_definitions permission
            ON permission.tenant_id=assignment.tenant_id AND permission.store_id=assignment.store_id
            AND permission.id=assignment.permission_id
          WHERE assignment.tenant_id=$1::uuid AND assignment.store_id=$2::uuid
            AND assignment.role_id=$3::uuid AND permission.code='order.create') AS assignment,
        (SELECT count(*)::text FROM mbox.role_access_configuration_authorities
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND role_id=$3::uuid
            AND configuration_kind='permission' AND configuration_code='order.create') AS authority,
        (SELECT count(*)::text FROM mbox.audit_events
          WHERE action='staff.permission-deployment.verified' AND reason='写入后复核回滚验证') AS audits,
        (SELECT count(*)::text FROM mbox.outbox_messages
          WHERE message_key='staff-permission-deployment:staff-access-post-write-verification-0001') AS outbox
    `, [tenantId, storeId, serverRoleId])
    expect(state.rows[0]).toEqual({ assignment: '1', authority: '0', audits: '0', outbox: '0' })
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
      ($1::uuid, $2::uuid, 'order.create', 'Create order'),
      ($1::uuid, $2::uuid, 'order.gift', 'Gift order items'),
      ($1::uuid, $2::uuid, 'kds.prepare', 'Prepare KDS items')
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
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid
      AND code IN ('order.create', 'order.gift', 'kds.prepare')
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
    'role_access_configuration_authorities',
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
