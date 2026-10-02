import Fastify from 'fastify'
import {tableManagementApiPlugin} from './table-management-api.js'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { NormalizedCommandExecutor, IdempotencyConflictError } from './command-executor.js'
import {
  StaffAccessDeniedError,StaffAccessRepository,type EffectiveStaffAccess,
} from './staff-access-repository.js'
import {
  AssignmentNotCommittedError,
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
    expect(accessSeed.rows[0]?.permission_count).toBe('8')
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

  it('replays guarded assignments after cache deletion and a new business day without duplicate audit or outbox', async () => {
    const command = assignmentCommand(employeeOneId, managerRoleId, 'backup',
      '2026-10-01T10:00:00Z', '2026-10-01T18:00:00Z', 'guarded-durable')
    const first = await commands.assign(command, true)
    await pool.query(`DELETE FROM mbox.idempotency_records WHERE tenant_id=$1 AND store_id=$2 AND idempotency_key=$3`,
      [tenantId, storeId, command.idempotencyKey])
    const replay = await commands.assign({ ...command, businessDate: '2026-10-02' }, true)
    expect(replay).toEqual({ value: first.value, replayed: true })
    const counts = (await pool.query(`SELECT
      (SELECT count(*)::int FROM mbox.table_assignments WHERE id=$3::uuid) AS assignments,
      (SELECT count(*)::int FROM mbox.audit_events WHERE tenant_id=$1 AND store_id=$2 AND object_id=$3::text) AS audits,
      (SELECT count(*)::int FROM mbox.outbox_messages WHERE tenant_id=$1 AND store_id=$2 AND aggregate_id=$3::uuid) AS messages`,
      [tenantId, storeId, first.value.id])).rows[0]
    expect(counts).toEqual({ assignments: 1, audits: 1, messages: 1 })
  })

  it('refuses modified guarded requests even after their cache expires', async () => {
    const command = assignmentCommand(employeeOneId, managerRoleId, 'backup',
      '2026-10-02T10:00:00Z', '2026-10-02T18:00:00Z', 'guarded-key-conflict')
    await commands.assign(command, true)
    await pool.query(`UPDATE mbox.idempotency_records SET created_at=clock_timestamp()-interval '2 days', expires_at=clock_timestamp()-interval '1 second'
      WHERE tenant_id=$1 AND store_id=$2 AND idempotency_key=$3`, [tenantId, storeId, command.idempotencyKey])
    await expect(commands.assign({ ...command, requestFingerprint: 'different-payload',
      endsAt: '2026-10-02T19:00:00Z' }, true)).rejects.toBeInstanceOf(IdempotencyConflictError)
  })

  it('replays an original guarded end without overwriting a later, shorter responsibility period', async () => {
    const created = await commands.assign(assignmentCommand(employeeOneId, managerRoleId, 'backup',
      '2026-10-03T10:00:00Z', '2026-10-03T18:00:00Z', 'guarded-end-setup'), true)
    const original = { ...base('guarded-end'), assignmentId: created.value.id, endsAt: '2026-10-03T17:00:00Z' }
    const ended = await commands.endAssignment(original, true)
    await commands.endAssignment({ ...base('guarded-end-later'), assignmentId: created.value.id, endsAt: '2026-10-03T16:00:00Z' }, true)
    await pool.query(`DELETE FROM mbox.idempotency_records WHERE tenant_id=$1 AND store_id=$2 AND idempotency_key=$3`,
      [tenantId, storeId, original.idempotencyKey])
    expect(await commands.endAssignment(original, true)).toEqual({ value: ended.value, replayed: true })
    const row = (await pool.query('SELECT ends_at FROM mbox.table_assignments WHERE id=$1', [created.value.id])).rows[0]
    expect(row.ends_at.toISOString()).toBe('2026-10-03T16:00:00.000Z')
  })

  it('rolls an entire guarded batch back on conflict and allows a corrected request', async () => {
    const common = { employeeId: employeeOneId, roleId: managerRoleId, assignmentType: 'primary' as const,
      startsAt: '2026-10-04T10:00:00Z', endsAt: '2026-10-04T18:00:00Z' }
    const sorted = [batchOneId, batchTwoId].sort()
    await commands.assign({ ...base('guarded-batch-blocker'), ...common, tableId: sorted[1]! })
    const command = { ...base('guarded-batch-conflict'), ...common,
      tableIds: sorted, employeeId: employeeTwoId, roleId: bartenderRoleId }
    await expect(commands.assignMany(command, true)).rejects.toBeInstanceOf(AssignmentNotCommittedError)
    const count = (await pool.query(`SELECT count(*)::int AS count FROM mbox.table_assignments
      WHERE tenant_id=$1 AND store_id=$2 AND employee_id=$3 AND starts_at=$4`,
      [tenantId, storeId, employeeTwoId, common.startsAt])).rows[0]
    expect(count.count).toBe(0)
    const corrected = await commands.assignMany({ ...command, ...base('guarded-batch-corrected'), assignmentType: 'backup' }, true)
    expect(corrected.value.assignments).toHaveLength(2)
    await pool.query(`DELETE FROM mbox.idempotency_records WHERE tenant_id=$1 AND store_id=$2 AND idempotency_key=$3`,
      [tenantId, storeId, command.idempotencyKey])
  })

  it('checks live permissions before returning even a cached guarded success', async () => {
    const command = assignmentCommand(employeeOneId, managerRoleId, 'backup',
      '2026-10-05T10:00:00Z', '2026-10-05T18:00:00Z', 'guarded-revocation')
    const first = await commands.assign(command, true)
    await pool.query(`UPDATE mbox.employee_roles SET ends_at=clock_timestamp()-interval '1 second'
      WHERE tenant_id=$1 AND store_id=$2 AND employee_id=$3`, [tenantId, storeId, employeeOneId])
    try {
      await expect(commands.assign(command, true)).rejects.toBeInstanceOf(StaffAccessDeniedError)
    } finally {
      await pool.query(`UPDATE mbox.employee_roles SET ends_at=NULL
        WHERE tenant_id=$1 AND store_id=$2 AND employee_id=$3`, [tenantId, storeId, employeeOneId])
    }
    expect(await commands.assign(command, true)).toEqual({ value: first.value, replayed: true })
  })

  it('serializes a concurrent guarded duplicate into one assignment and one replay', async () => {
    const command = assignmentCommand(employeeOneId, managerRoleId, 'backup',
      '2026-10-06T10:00:00Z', '2026-10-06T18:00:00Z', 'guarded-concurrent')
    const results = await Promise.all([commands.assign(command, true), commands.assign(command, true)])
    expect(results[0]!.value).toEqual(results[1]!.value)
    expect(results.map((result) => result.replayed).sort()).toEqual([false, true])
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
    const command = {
      ...base('transfer-session'), tableSessionId: opened.value.id,
      targetTableId: transferTargetId, expectedSourceTableId: transferSourceId, expectedLocationVersion: 0,
      reason: '客人希望更靠近舞台，目标桌已确认空闲',
    }
    const transferred = await commands.transfer(command)
    const replay = await commands.transfer(command)
    expect(replay.value).toEqual(transferred.value)
    await expect(commands.transfer({ ...command, ...base('stale-transfer'), targetTableId: transferSourceId }))
      .rejects.toBeInstanceOf(TableManagementConflictError)
    // A -> B -> A is still a changed location; source id alone cannot detect it.
    await commands.transfer({ ...base('move-back'), tableSessionId: opened.value.id,
      targetTableId: transferSourceId, expectedSourceTableId: transferTargetId, expectedLocationVersion: 1 })
    await expect(commands.transfer({ ...command, ...base('aba-stale-transfer') }))
      .rejects.toBeInstanceOf(TableManagementConflictError)
    await commands.transfer({ ...command, ...base('fresh-transfer'), expectedLocationVersion: 2 })
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

  it('native configuration preserves layouts, guards busy tables and stale revisions, and retains exact receipts',async()=>{
    const runtimePool=new Pool({connectionString:process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL??databaseUrl,max:4})
    const runtime=new ScopedPostgresTransactionRunner(asPool(runtimePool)),executor=new NormalizedCommandExecutor(runtime)
    const app=Fastify();await app.register(tableManagementApiPlugin,{transactions:runtime,nativeCommands:executor,commands:new TableManagementCommandService(executor),resolveContext:()=>({scope:{tenantId,storeId},employeeId:employeeOneId,businessDate:'2026-08-11',capabilities:['table.manage']})})
    const send=(action:string,payload:object,key='native-business-'+randomUUID())=>app.inject({method:'POST',url:'/table-management/native-configuration/'+action,headers:{'idempotency-key':key},payload})
    try{
      const created=await send('area-create',{code:'NATIVE-CONFIG',name:'原生配置区域',areaType:'indoor',sortOrder:10,status:'active',reason:'原区域配置核对'})
      expect(created.statusCode,created.body).toBe(200);const area=created.json().data.result
      const table=await send('table-create',{code:'NATIVE-01',displayName:'原生桌',areaId:area.id,capacity:4,minimumSpendMinor:null,status:'available',reason:'原桌配置核对'})
      expect(table.statusCode,table.body).toBe(200);const id=table.json().data.result.id
      await pool.query("UPDATE mbox.tables SET layout_snapshot='{\"xPct\":25,\"yPct\":35}'::jsonb WHERE id=$1",[id])
      const board=await app.inject({method:'GET',url:'/table-management/native-configuration'});expect(board.statusCode,board.body).toBe(200);const row=board.json().data.tables.find((r:{id:string})=>r.id===id)
      const input={code:row.code,displayName:'调整后的桌牌名称',areaId:area.id,tableId:id,capacity:6,minimumSpendMinor:1200,status:'available',expectedUpdatedAt:row.updatedAt,reason:'现场调整容量'},key='native-business-'+randomUUID()
      const update=await send('table-update',input,key);expect(update.statusCode,update.body).toBe(200);expect(update.json().data.result).toMatchObject({id,capacity:6,layoutSnapshot:{xPct:25,yPct:35}})
      expect((await send('table-update',{...input,capacity:8})).statusCode).toBe(409)
      await pool.query('DELETE FROM mbox.idempotency_records WHERE tenant_id=$1 AND store_id=$2 AND expires_at<=clock_timestamp()',[tenantId,storeId])
      const replay=await send('table-update',input,key);expect(replay.json().data).toEqual(update.json().data);expect(replay.json().meta.replayed).toBe(true)
      await commands.open(openCommand(id,2,'native-config-busy'))
      expect((await send('table-update',{...input,expectedUpdatedAt:update.json().data.result.updatedAt})).statusCode).toBe(409)
      expect((await send('area-update',{areaId:area.id,name:area.name,areaType:'indoor',sortOrder:10,status:'paused',expectedUpdatedAt:area.updatedAt,reason:'计划暂停此区域'})).statusCode).toBe(409)
      const rename=await send('area-update',{areaId:area.id,name:'原区域更名',areaType:'indoor',sortOrder:20,status:'active',expectedUpdatedAt:area.updatedAt,reason:'仅修改区域名称'})
      expect(rename.statusCode,rename.body).toBe(200)
      await pool.query("UPDATE mbox.employees SET status='suspended' WHERE id=$1",[employeeOneId])
      expect((await send('table-update',input,key)).statusCode).toBe(403)
    }finally{await pool.query("UPDATE mbox.employees SET status='active' WHERE id=$1",[employeeOneId]);await app.close();await runtimePool.end()}
  })

  it('rechecks area status after a concurrent table lock instead of opening from an obsolete joined snapshot',async()=>{
    const area=await commands.createArea({...base('race-area'),code:'AREA-RACE',name:'状态竞态区',areaType:'indoor',sortOrder:0,status:'active'})
    const table=await commands.createTable({...base('race-table'),areaId:area.value.id,code:'AREA-RACE-T',displayName:'竞态桌',capacity:4,status:'available'})
    const marker='native-area-race-'+randomUUID(),rp=new Pool({connectionString:process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL??databaseUrl,application_name:marker,max:1})
    const runtime=new ScopedPostgresTransactionRunner(asPool(rp)),service=new TableManagementCommandService(new NormalizedCommandExecutor(runtime)),locked=await pool.connect()
    let result:Promise<unknown>|null=null
    try{
      await locked.query('BEGIN');await locked.query('SELECT id FROM mbox.tables WHERE id=$1 FOR UPDATE',[table.value.id])
      result=service.open(openCommand(table.value.id,2,'area-race-open')).then(v=>({ok:true,v}),e=>({ok:false,e}))
      let blocked=false
      for(let i=0;i<100;i++){const q=await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",[marker]);if(q.rowCount){blocked=true;break}await new Promise(r=>setTimeout(r,10))}
      expect(blocked).toBe(true)
      await locked.query("UPDATE mbox.areas SET status='paused' WHERE id=$1",[area.value.id]);await locked.query('COMMIT')
      const outcome=await result as {ok:boolean;e:unknown};expect(outcome.ok).toBe(false);expect(outcome.e).toBeInstanceOf(TableManagementConflictError)
      expect((await pool.query('SELECT 1 FROM mbox.table_sessions WHERE table_id=$1',[table.value.id])).rowCount).toBe(0)
    }finally{await locked.query('ROLLBACK');locked.release();if(result)await result;await rp.end()}
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
