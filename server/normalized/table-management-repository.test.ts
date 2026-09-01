import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import {
  StaffAccessDeniedError,StaffAccessRepository,type EffectiveStaffAccess,
} from './staff-access-repository.js'
import {
  CapacityOverrideReasonRequiredError,
  TableManagementCommandService,
  TableManagementConflictError,
  TableManagementRepository,
  canViewAllTables,
} from './table-management-repository.js'
import { ScopedPostgresTransactionRunner, type PostgresPool, type ScopedTransaction } from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

describe('table management authorization rules', () => {
  it('treats table.open as store-wide action permission, independent of responsibility assignment', () => {
    expect(canViewAllTables(access(['table.open'], ['WAITER']))).toBe(true)
    expect(canViewAllTables(access([], ['STORE_MANAGER']))).toBe(true)
    expect(canViewAllTables(access([], ['WAITER']))).toBe(false)
  })

  it('maps a permission revoked inside the movement transaction to staff access denied', async () => {
    const scope={ tenantId:randomUUID(),storeId:randomUUID() }
    const participantPublicId='participant-permission-race'
    const transaction={ scope,query:async <Row extends Record<string,unknown>>(sql:string) => {
      if (sql.includes('pg_advisory_xact_lock')) return { rows:[] as Row[],rowCount:0 }
      if (sql.includes('FROM mbox.table_customer_movement_events event')) {
        return { rows:[] as Row[],rowCount:0 }
      }
      if (sql.includes('participation.public_id=ANY')) return { rows:[{
        id:randomUUID(),public_id:participantPublicId,participation_role:'companion',
        confirmation_state:'confirmed',
      } as Row],rowCount:1 }
      if (sql.includes('execute_table_customer_movement')) throw Object.assign(new Error('revoked'),{ code:'42501' })
      throw new Error(`Unexpected query: ${sql}`)
    } }
    await expect(new TableManagementRepository(transaction).moveParticipants({
      movementKind:'participant_merge',sourceTableSessionId:randomUUID(),
      targetTableSessionId:randomUUID(),targetTableId:randomUUID(),movedGuestCount:1,
      participantPublicIds:[participantPublicId],movedByEmployeeId:randomUUID(),
      reason:'顾客确认并桌',idempotencyKey:'permission-race-0001',requestFingerprint:'permission-race',
    })).rejects.toBeInstanceOf(StaffAccessDeniedError)
  })

  it('preserves an existing area layout when an ordinary edit omits layoutSnapshot', async () => {
    const areaId = randomUUID()
    const query = vi.fn(async <Row extends Record<string, unknown>>(_sql: string, _values: readonly unknown[] = []) => ({
      rows: [{
        id: areaId, code: 'OUTSIDE', name: '室外区', area_type: 'outdoor', sort_order: 10,
        layout_snapshot: { mapVersion: 2, xPct: 12 }, status: 'active',
        created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-02T00:00:00.000Z',
      } as Row],
      rowCount: 1,
    }))
    const transaction: ScopedTransaction = {
      scope: { tenantId: randomUUID(), storeId: randomUUID() },
      query,
    }

    const result = await new TableManagementRepository(transaction).updateArea({
      areaId, name: '室外区', areaType: 'outdoor', sortOrder: 10, status: 'active',
    })

    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0]?.[0]).toContain('layout_snapshot = COALESCE($7::jsonb, layout_snapshot)')
    expect(query.mock.calls[0]?.[1]?.[6]).toBeNull()
    expect(result.layoutSnapshot).toEqual({ mapVersion: 2, xPct: 12 })
  })
})

integration('normalized table management PostgreSQL concurrency', () => {
  const tenantId = randomUUID()
  const storeId = randomUUID()
  const areaId = randomUUID()
  const employeeOneId = randomUUID()
  const employeeTwoId = randomUUID()
  const managerRoleId = randomUUID()
  const bartenderRoleId = randomUUID()
  const sameTableId = randomUUID()
  const parallelOneId = randomUUID()
  const parallelTwoId = randomUUID()
  const capacityTableId = randomUUID()
  const assignmentTableId = randomUUID()
  const batchOneId = randomUUID()
  const batchTwoId = randomUUID()
  const transferSourceId = randomUUID()
  const transferTargetId = randomUUID()
  let pool: Pool
  let transactions: ScopedPostgresTransactionRunner
  let commands: TableManagementCommandService

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 12 })
    transactions = new ScopedPostgresTransactionRunner(asPool(pool))
    commands = new TableManagementCommandService(new NormalizedCommandExecutor(transactions))

    await pool.query(`INSERT INTO mbox.tenants(id, code, name) VALUES ($1, $2, 'Table Test Tenant')`,
      [tenantId, `table-test-${tenantId.slice(0, 8)}`])
    await pool.query(`INSERT INTO mbox.stores(id, tenant_id, code, name) VALUES ($1, $2, $3, 'Table Test Store')`,
      [storeId, tenantId, `table-store-${storeId.slice(0, 8)}`])
    await pool.query(`
      INSERT INTO mbox.areas(id, tenant_id, store_id, code, name, area_type, sort_order)
      VALUES ($1, $2, $3, 'MAIN', '主区域', 'indoor', 10)
    `, [areaId, tenantId, storeId])
    await pool.query(`
      INSERT INTO mbox.employees(id, tenant_id, store_id, employee_code, display_name) VALUES
        ($1, $3, $4, 'manager-one', '李艳'),
        ($2, $3, $4, 'backup-two', '候补员工')
    `, [employeeOneId, employeeTwoId, tenantId, storeId])
    await pool.query(`
      INSERT INTO mbox.roles(id, tenant_id, store_id, code, name) VALUES
        ($1, $3, $4, 'STORE_MANAGER', '店长'),
        ($2, $3, $4, 'BARTENDER', '调酒师')
    `, [managerRoleId, bartenderRoleId, tenantId, storeId])
    await pool.query(`
      INSERT INTO mbox.employee_roles(tenant_id, store_id, employee_id, role_id, starts_at) VALUES
        ($1, $2, $3, $4, '2026-01-01T00:00:00Z')
    `, [tenantId, storeId, employeeOneId, managerRoleId])
    await pool.query(`
      INSERT INTO mbox.tables(id, tenant_id, store_id, area_id, code, display_name, capacity) VALUES
        ($1, $10, $11, $12, 'SAME', '冲突桌', 4),
        ($2, $10, $11, $12, 'P01', '并行桌1', 4),
        ($3, $10, $11, $12, 'P02', '并行桌2', 4),
        ($4, $10, $11, $12, 'CAP', '加座桌', 4),
        ($5, $10, $11, $12, 'ASN', '分配桌', 4),
        ($6, $10, $11, $12, 'SRC', '转桌源', 4),
        ($7, $10, $11, $12, 'DST', '转桌目标', 6),
        ($8, $10, $11, $12, 'B01', '批量桌1', 4),
        ($9, $10, $11, $12, 'B02', '批量桌2', 4)
    `, [sameTableId, parallelOneId, parallelTwoId, capacityTableId, assignmentTableId,
      transferSourceId, transferTargetId, batchOneId, batchTwoId, tenantId, storeId, areaId])
    await pool.query(`
      INSERT INTO mbox.staff_permission_definitions(tenant_id, store_id, code, name)
      VALUES
        ($1, $2, 'table.open', '开台'),
        ($1, $2, 'table.view_all', '查看全店桌台'),
        ($1, $2, 'table.manage', '管理桌台'),
        ($1, $2, 'table.assignment.manage', '管理责任分配'),
        ($1, $2, 'table.transfer', '转桌')
      ON CONFLICT (tenant_id, store_id, code) DO UPDATE SET name = EXCLUDED.name
    `, [tenantId, storeId])
    await pool.query(`
      INSERT INTO mbox.role_permission_assignments(tenant_id, store_id, role_id, permission_id)
      SELECT $1, $2, $3, id FROM mbox.staff_permission_definitions
      WHERE tenant_id = $1 AND store_id = $2 AND code LIKE 'table.%'
    `, [tenantId, storeId, managerRoleId])
    const accessSeed = await pool.query<{ permission_count: string }>(`
      SELECT count(*)::text AS permission_count
      FROM mbox.role_permission_assignments
      WHERE tenant_id = $1 AND store_id = $2 AND role_id = $3
    `, [tenantId, storeId, managerRoleId])
    expect(accessSeed.rows[0]?.permission_count).toBe('6')
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('allows only one concurrent open on the same table', async () => {
    const results = await Promise.allSettled([
      commands.open(openCommand(sameTableId, 2, 'same-a')),
      commands.open(openCommand(sameTableId, 2, 'same-b')),
    ])
    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    if (fulfilled.length !== 1) {
      throw new Error(results.map((result) => result.status === 'fulfilled'
        ? 'fulfilled'
        : `${result.reason instanceof Error ? result.reason.name : 'Error'}:${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
      ).join(' | '))
    }
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const sessions = await pool.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM mbox.table_sessions
      WHERE tenant_id = $1 AND store_id = $2 AND table_id = $3 AND status = 'open'
    `, [tenantId, storeId, sameTableId])
    expect(sessions.rows[0]?.count).toBe('1')
  })

  it('opens different tables concurrently without a store-wide queue', async () => {
    const started = performance.now()
    const [first, second] = await Promise.all([
      commands.open(openCommand(parallelOneId, 2, 'parallel-a')),
      commands.open(openCommand(parallelTwoId, 3, 'parallel-b')),
    ])
    expect(first.value.tableId).toBe(parallelOneId)
    expect(second.value.tableId).toBe(parallelTwoId)
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  it('requires and audits an explicit employee reason when capacity is exceeded', async () => {
    await expect(commands.open(openCommand(capacityTableId, 6, 'capacity-no-reason')))
      .rejects.toBeInstanceOf(CapacityOverrideReasonRequiredError)

    const opened = await commands.open({
      ...openCommand(capacityTableId, 6, 'capacity-with-reason'),
      capacityOverrideReason: '临时增加两把安全座椅，店长现场确认通道不受阻',
    })
    expect(opened.value).toMatchObject({
      capacityAtOpen: 4,
      capacityOverrideReason: '临时增加两把安全座椅，店长现场确认通道不受阻',
      capacityOverriddenByEmployeeId: employeeOneId,
    })
    const evidence = await pool.query<{ payload_reason: string; actor_employee_id: string }>(`
      SELECT after_snapshot ->> 'capacityOverrideReason' AS payload_reason,
        actor_employee_id::text
      FROM mbox.audit_events
      WHERE tenant_id = $1 AND store_id = $2 AND object_id = $3
        AND action = 'table.session.opened'
    `, [tenantId, storeId, opened.value.id])
    expect(evidence.rows[0]).toEqual({
      payload_reason: '临时增加两把安全座椅，店长现场确认通道不受阻',
      actor_employee_id: employeeOneId,
    })
  })

  it('prevents overlapping primary assignments and permits a backup cross-position assignment', async () => {
    const startsAt = '2026-08-11T12:00:00.000Z'
    const endsAt = '2026-08-11T18:00:00.000Z'
    const results = await Promise.allSettled([
      commands.assign(assignmentCommand(employeeOneId, managerRoleId, 'primary', startsAt, endsAt, 'primary-a')),
      commands.assign(assignmentCommand(employeeTwoId, bartenderRoleId, 'primary', startsAt, endsAt, 'primary-b')),
    ])
    const fulfilledAssignments = results.filter((result) => result.status === 'fulfilled')
    if (fulfilledAssignments.length !== 1) {
      throw new Error(results.map((result) => result.status === 'fulfilled'
        ? 'fulfilled'
        : `${result.reason instanceof Error ? result.reason.name : 'Error'}:${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
      ).join(' | '))
    }
    const rejected = results.find((result) => result.status === 'rejected')
    expect(rejected?.status === 'rejected' ? rejected.reason : null).toBeInstanceOf(TableManagementConflictError)

    const primaryEmployeeId = fulfilledAssignments[0]!.value.value.employeeId
    const backupEmployeeId = primaryEmployeeId === employeeOneId ? employeeTwoId : employeeOneId
    const backup = await commands.assign(assignmentCommand(
      backupEmployeeId, bartenderRoleId, 'backup', startsAt, endsAt, 'backup-cross-role',
    ))
    expect(backup.value).toMatchObject({
      employeeId: backupEmployeeId,
      roleCode: 'BARTENDER',
      assignmentType: 'backup',
    })
  })

  it('publishes a multi-table roster atomically and rolls every table back on one conflict', async () => {
    const startsAt = '2026-08-16T10:00:00.000Z'
    const endsAt = '2026-08-16T18:00:00.000Z'
    await commands.assign({
      ...base('batch-blocker'), tableId: batchTwoId, employeeId: employeeOneId,
      roleId: managerRoleId, assignmentType: 'primary', startsAt, endsAt,
      reason: '预置主服务冲突',
    })

    await expect(commands.assignMany({
      ...base('batch-primary-conflict'), tableIds: [batchOneId, batchTwoId],
      employeeId: employeeTwoId, roleId: bartenderRoleId, assignmentType: 'primary',
      startsAt, endsAt, reason: '整区主服务安排',
    })).rejects.toBeInstanceOf(TableManagementConflictError)
    const partial = await pool.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM mbox.table_assignments
      WHERE tenant_id = $1 AND store_id = $2 AND table_id = $3 AND employee_id = $4
    `, [tenantId, storeId, batchOneId, employeeTwoId])
    expect(partial.rows[0]?.count).toBe('0')

    const published = await commands.assignMany({
      ...base('batch-backup-success'), tableIds: [batchTwoId, batchOneId],
      employeeId: employeeTwoId, roleId: bartenderRoleId, assignmentType: 'backup',
      startsAt, endsAt, reason: '整区候补服务安排',
    })
    expect(published.value.assignments.map((assignment) => assignment.tableCode).toSorted())
      .toEqual(['B01', 'B02'])
    const audit = await pool.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM mbox.audit_events
      WHERE tenant_id = $1 AND store_id = $2 AND object_id = $3
        AND action = 'table.assignment.batch_created'
    `, [tenantId, storeId, published.value.id])
    expect(audit.rows[0]?.count).toBe('1')
  })

  it('shows all areas to table.open staff even when no table is assigned to them', async () => {
    const rows = await transactions.run({ tenantId, storeId }, async (transaction) => {
      const liveAccess = await new StaffAccessRepository(transaction).resolve(employeeOneId)
      return new TableManagementRepository(transaction).listTables(liveAccess, '2026-08-11T13:00:00.000Z')
    }, { readOnly: true })
    expect(rows.map((row) => row.code)).toEqual(expect.arrayContaining(['P01', 'P02', 'DST']))
    expect(rows.find((row) => row.code === 'DST')?.assignedToActor).toBe(false)
  })

  it('locks source and target, transfers the session, and preserves ownership through the session id', async () => {
    const opened = await commands.open(openCommand(transferSourceId, 2, 'transfer-source'))
    const transferred = await commands.transfer({
      ...base('transfer-session'),
      tableSessionId: opened.value.id,
      targetTableId: transferTargetId,
      reason: '客人希望更靠近舞台，目标桌已确认空闲',
    })
    expect(transferred.value).toMatchObject({
      tableSessionId: opened.value.id,
      sourceTableId: transferSourceId,
      targetTableId: transferTargetId,
      ownershipSnapshot: {
        ownershipModel: 'table_session_reference',
        orderCount: 0,
        serviceTaskCount: 0,
      },
    })
    const session = await pool.query<{ table_id: string }>(`
      SELECT table_id::text FROM mbox.table_sessions WHERE id = $1
    `, [opened.value.id])
    expect(session.rows[0]?.table_id).toBe(transferTargetId)
  })

  function base(suffix: string) {
    return {
      scope: { tenantId, storeId },
      actor: { type: 'employee' as const, employeeId: employeeOneId },
      businessDate: '2026-08-11',
      reason: '现场经营操作',
      idempotencyKey: `table-test-${suffix}-${randomUUID()}`,
      requestFingerprint: JSON.stringify({ suffix, nonce: randomUUID() }),
    }
  }

  function openCommand(tableId: string, guestCount: number, suffix: string) {
    return {
      ...base(suffix),
      tableId,
      publicId: `session-${suffix}-${randomUUID()}`,
      guestCount,
      guestProfileSnapshot: { scene: 'test' },
    }
  }

  function assignmentCommand(
    employeeId: string,
    roleId: string,
    assignmentType: 'primary' | 'backup',
    startsAt: string,
    endsAt: string,
    suffix: string,
  ) {
    return {
      ...base(suffix),
      tableId: assignmentTableId,
      employeeId,
      roleId,
      assignmentType,
      startsAt,
      endsAt,
      reason: '当班责任区安排',
    }
  }
})

function access(permissions: string[], roleCodes: string[]): EffectiveStaffAccess {
  return {
    employeeId: randomUUID(), employeeCode: 'test', displayName: '测试员工', roleCodes,
    roleNames: roleCodes, permissions, deniedPermissions: [], dataScopes: [],
    approvalLimits: [], navigation: [], resolvedAt: new Date().toISOString(),
  }
}

function asPool(pool: Pool): PostgresPool {
  return {
    connect: async () => pool.connect(),
    end: async () => pool.end(),
  }
}
