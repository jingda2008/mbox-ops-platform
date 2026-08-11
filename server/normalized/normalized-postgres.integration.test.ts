import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import {
  NormalizedCommandExecutor,
  ScopedPostgresTransactionRunner,
  type JsonCodec,
  type PostgresPool,
} from './index.js'
import { ServiceTaskRepository } from './service-task-repository.js'
import { ServiceTaskSlaWorker } from './service-task-sla-worker.js'
import { TableSessionCommandService } from './table-session-repository.js'
import { OperationsQueryService } from './operations-query-service.js'
import { OutboxDispatcher } from './outbox-dispatcher.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip
const tenantId = '10000000-0000-4000-8000-000000000001'
const storeId = '10000000-0000-4000-8000-000000000002'
const areaId = '10000000-0000-4000-8000-000000000003'
const tableOneId = '10000000-0000-4000-8000-000000000004'
const tableTwoId = '10000000-0000-4000-8000-000000000005'
const employeeId = '10000000-0000-4000-8000-000000000006'
const roleId = '10000000-0000-4000-8000-000000000007'
const employeeRoleId = '10000000-0000-4000-8000-000000000008'
const tableAssignmentId = '10000000-0000-4000-8000-000000000009'

integration('normalized PostgreSQL transaction integration', () => {
  let nativePool: Pool
  let executor: NormalizedCommandExecutor

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    nativePool = new Pool({ connectionString: databaseUrl, max: 4 })
    const pool: PostgresPool = {
      connect: async () => nativePool.connect(),
      end: async () => nativePool.end(),
    }
    executor = new NormalizedCommandExecutor(new ScopedPostgresTransactionRunner(pool))
    await nativePool.query(`
      INSERT INTO mbox.tenants(id, code, name)
      VALUES ($1::uuid, 'integration-tenant', 'Integration Tenant')
      ON CONFLICT (id) DO NOTHING
    `, [tenantId])
    await nativePool.query(`
      INSERT INTO mbox.stores(id, tenant_id, code, name)
      VALUES ($1::uuid, $2::uuid, 'integration-store', 'Integration Store')
      ON CONFLICT (id) DO NOTHING
    `, [storeId, tenantId])
    await nativePool.query(`
      INSERT INTO mbox.areas(id, tenant_id, store_id, code, name, area_type)
      VALUES ($1::uuid, $2::uuid, $3::uuid, 'INTEGRATION', 'Integration Area', 'indoor')
      ON CONFLICT (id) DO NOTHING
    `, [areaId, tenantId, storeId])
    await nativePool.query(`
      INSERT INTO mbox.tables(id, tenant_id, store_id, area_id, code, display_name, capacity)
      VALUES
        ($1::uuid, $3::uuid, $4::uuid, $5::uuid, 'IT01', 'Integration Table 1', 4),
        ($2::uuid, $3::uuid, $4::uuid, $5::uuid, 'IT02', 'Integration Table 2', 4)
      ON CONFLICT (id) DO NOTHING
    `, [tableOneId, tableTwoId, tenantId, storeId, areaId])
    await nativePool.query(`
      INSERT INTO mbox.employees(id, tenant_id, store_id, employee_code, display_name)
      VALUES ($1::uuid, $2::uuid, $3::uuid, 'integration-employee', 'Integration Employee')
      ON CONFLICT (id) DO NOTHING
    `, [employeeId, tenantId, storeId])
    await nativePool.query(`
      INSERT INTO mbox.roles(id, tenant_id, store_id, code, name)
      VALUES ($1::uuid, $2::uuid, $3::uuid, 'MANAGER', 'Manager')
      ON CONFLICT (id) DO NOTHING
    `, [roleId, tenantId, storeId])
    await nativePool.query(`
      INSERT INTO mbox.employee_roles(id, tenant_id, store_id, employee_id, role_id)
      VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid)
      ON CONFLICT (id) DO NOTHING
    `, [employeeRoleId, tenantId, storeId, employeeId, roleId])
    await nativePool.query(`
      WITH definitions AS (
        INSERT INTO mbox.staff_permission_definitions(tenant_id, store_id, code, name)
        VALUES
          ($1::uuid, $2::uuid, 'table.view_all', 'View all tables'),
          ($1::uuid, $2::uuid, 'service.manage', 'Manage service tasks')
        ON CONFLICT (tenant_id, store_id, code) DO UPDATE SET name = EXCLUDED.name
        RETURNING id
      )
      INSERT INTO mbox.role_permission_assignments(tenant_id, store_id, role_id, permission_id)
      SELECT $1::uuid, $2::uuid, $3::uuid, definitions.id FROM definitions
      ON CONFLICT (tenant_id, store_id, role_id, permission_id) DO NOTHING
    `, [tenantId, storeId, roleId])
    await nativePool.query(`
      INSERT INTO mbox.table_assignments(
        id, tenant_id, store_id, table_id, employee_id, role_id, assignment_type, reason
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
        'primary', 'integration test responsibility assignment'
      )
      ON CONFLICT (id) DO NOTHING
    `, [tableAssignmentId, tenantId, storeId, tableOneId, employeeId, roleId])
  })

  afterAll(async () => {
    await nativePool?.end()
  })

  it('persists audit, outbox and idempotency result atomically and replays it', async () => {
    let handlerCalls = 0
    const command = {
      scope: { tenantId, storeId },
      operationScope: 'integration.command',
      idempotencyKey: 'normalized-integration-success-0001',
      requestFingerprint: '{"action":"create"}',
      resultCodec: stringCodec,
    } as const
    const execute = () => executor.execute(command, async () => {
      handlerCalls += 1
      return {
        result: 'created',
        auditEvents: [{
          actor: { type: 'system' as const },
          action: 'integration.created',
          objectType: 'integration_record',
          objectId: storeId,
          businessDate: '2026-08-11',
          afterData: { status: 'created' },
        }],
        outboxMessages: [{
          aggregateType: 'integration_record',
          aggregateId: storeId,
          aggregateVersion: 1,
          eventType: 'integration.created.v1',
          payload: { status: 'created' },
        }],
      }
    })

    await expect(execute()).resolves.toEqual({ value: 'created', replayed: false })
    await expect(execute()).resolves.toEqual({ value: 'created', replayed: true })
    expect(handlerCalls).toBe(1)

    const evidence = await nativePool.query<{ audits: string; messages: string; completed: string }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.audit_events WHERE action = 'integration.created') AS audits,
        (SELECT count(*)::text FROM mbox.outbox_messages WHERE message_type = 'integration.created.v1') AS messages,
        (SELECT count(*)::text FROM mbox.idempotency_records
          WHERE operation_scope = 'integration.command' AND status = 'completed') AS completed
    `)
    expect(evidence.rows[0]).toEqual({ audits: '1', messages: '1', completed: '1' })
  })

  it('rolls back audit and idempotency claim when outbox validation fails', async () => {
    const key = 'normalized-integration-rollback-0001'
    await expect(executor.execute({
      scope: { tenantId, storeId },
      operationScope: 'integration.rollback',
      idempotencyKey: key,
      requestFingerprint: '{"action":"rollback"}',
      resultCodec: stringCodec,
    }, async () => ({
      result: 'must-not-commit',
      auditEvents: [{
        actor: { type: 'system' as const },
        action: 'integration.rollback',
        objectType: 'integration_record',
        objectId: storeId,
        businessDate: '2026-08-11',
        reason: 'forced invalid outbox message type',
      }],
      outboxMessages: [{
        aggregateType: 'integration_record',
        aggregateId: storeId,
        aggregateVersion: 1,
        eventType: 'INVALID',
        payload: { status: 'invalid' },
      }],
    }))).rejects.toThrow()

    const evidence = await nativePool.query<{ audits: string; claims: string }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.audit_events WHERE action = 'integration.rollback') AS audits,
        (SELECT count(*)::text FROM mbox.idempotency_records WHERE idempotency_key = $1) AS claims
    `, [key])
    expect(evidence.rows[0]).toEqual({ audits: '0', claims: '0' })
  })

  it('rejects non-employee audit actors carrying an employee identity', async () => {
    await expect(nativePool.query(`
      INSERT INTO mbox.audit_events (
        tenant_id, store_id, actor_type, actor_employee_id,
        action, object_type, object_id, business_date
      ) VALUES (
        $1::uuid, $2::uuid, 'system', $3::uuid,
        'integration.invalid_actor', 'integration_record', $2, DATE '2026-08-11'
      )
    `, [tenantId, storeId, employeeId])).rejects.toMatchObject({ code: '23514' })
  })

  it('builds the staff operations view directly from normalized tables', async () => {
    const service = new OperationsQueryService(
      new ScopedPostgresTransactionRunner(asPool(nativePool)),
    )
    const view = await service.getStaffView(
      { tenantId, storeId }, employeeId,
    )

    expect(view.actor).toMatchObject({
      id: employeeId,
      roleCodes: ['MANAGER'],
      capabilities: expect.arrayContaining(['table.view_all', 'service.manage']),
    })
    expect(view.tables.map((table) => table.code)).toEqual(['IT01', 'IT02'])
    expect(view.tables.find((table) => table.code === 'IT01')?.assignedToActor).toBe(true)
  })

  it('opens different tables concurrently and records extra seats without a store-wide lock', async () => {
    const service = new TableSessionCommandService(executor)
    const open = (tableId: string, suffix: string) => service.open({
      scope: { tenantId, storeId },
      actor: { type: 'employee', employeeId },
      table: { kind: 'id', value: tableId },
      publicId: `integration-session-${suffix}`,
      businessDate: '2026-08-11',
      guestCount: suffix === 'one' ? 8 : 2,
      capacityOverrideReason: suffix === 'one' ? '现场加椅并保持通道畅通' : null,
      guestProfileSnapshot: { scene: 'integration' },
      openedByEmployeeId: employeeId,
      idempotencyKey: `normalized-table-open-${suffix}-0001`,
      requestFingerprint: JSON.stringify({ tableId, suffix }),
    })

    const [first, second] = await Promise.all([open(tableOneId, 'one'), open(tableTwoId, 'two')])
    expect(first.value.guestProfileSnapshot.extraSeatCount).toBe(4)
    expect(second.value.guestProfileSnapshot.extraSeatCount).toBe(0)
    expect(first.value.tableId).not.toBe(second.value.tableId)

    const live = await nativePool.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM mbox.table_sessions
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND status = 'open'
    `, [tenantId, storeId])
    expect(live.rows[0]?.count).toBe('2')
  })

  it('prevents a second active session on the same table', async () => {
    const service = new TableSessionCommandService(executor)
    await expect(service.open({
      scope: { tenantId, storeId },
      actor: { type: 'system' },
      table: { kind: 'id', value: tableOneId },
      publicId: 'integration-session-conflict',
      businessDate: '2026-08-11',
      guestCount: 2,
      idempotencyKey: 'normalized-table-open-conflict-0001',
      requestFingerprint: '{"table":"IT01","attempt":2}',
    })).rejects.toThrow('already has an active session')
  })

  it('writes service transitions with events and two SLA workers claim a task once', async () => {
    const session = await nativePool.query<{ id: string }>(`
      SELECT id FROM mbox.table_sessions
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND table_id = $3::uuid AND status = 'open'
    `, [tenantId, storeId, tableOneId])
    const tableSessionId = session.rows[0]!.id
    let completedTaskId = ''
    await new ScopedPostgresTransactionRunner(asPool(nativePool)).run({ tenantId, storeId }, async (transaction) => {
      const repository = new ServiceTaskRepository(transaction)
      const created = await repository.create({
        tableId: tableOneId,
        tableSessionId,
        publicId: 'integration-service-complete',
        taskType: 'water',
        title: 'Add water',
        source: 'guest',
        actor: { type: 'guest' },
        eventIdempotencyKey: 'service-create-integration-0001',
      })
      const completed = await repository.complete({
        taskId: created.id,
        actor: { type: 'system' },
        eventIdempotencyKey: 'service-complete-integration-0001',
      })
      completedTaskId = completed.id
    })
    const completedEvidence = await nativePool.query<{ status: string; events: string }>(`
      SELECT task.status,
        (SELECT count(*)::text FROM mbox.service_task_events event WHERE event.service_task_id = task.id) AS events
      FROM mbox.service_tasks task
      WHERE task.id = $1::uuid
    `, [completedTaskId])
    expect(completedEvidence.rows[0]).toEqual({ status: 'completed', events: '2' })

    await new ScopedPostgresTransactionRunner(asPool(nativePool)).run({ tenantId, storeId }, async (transaction) => {
      await new ServiceTaskRepository(transaction).create({
        tableId: tableOneId,
        tableSessionId,
        publicId: 'integration-service-sla-due',
        taskType: 'water',
        title: 'Overdue water',
        priority: 'normal',
        source: 'guest',
        actor: { type: 'guest' },
        nextActionAt: '2026-08-11T00:00:00.000Z',
        eventIdempotencyKey: 'service-sla-create-integration-0001',
      })
    })
    const worker = new ServiceTaskSlaWorker(new ScopedPostgresTransactionRunner(asPool(nativePool)))
    const [workerOne, workerTwo] = await Promise.all([
      worker.runBatch({ tenantId, storeId }, 'integration-worker-one'),
      worker.runBatch({ tenantId, storeId }, 'integration-worker-two'),
    ])
    expect(workerOne.claimed + workerTwo.claimed).toBe(1)
    expect([...workerOne.processed, ...workerTwo.processed]).toHaveLength(1)
  })

  it('lets two outbox workers claim different messages without duplicate delivery', async () => {
    await nativePool.query(`
      UPDATE mbox.outbox_messages
      SET delivered_at = COALESCE(delivered_at, clock_timestamp())
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
    `, [tenantId, storeId])
    const inserted = await nativePool.query<{ id: string }>(`
      INSERT INTO mbox.outbox_messages (
        tenant_id, store_id, message_key, aggregate_type, aggregate_id,
        aggregate_version, message_type, payload
      ) VALUES
        ($1::uuid, $2::uuid, 'integration-outbox-worker-message-1', 'integration_record', $2::uuid, 1, 'integration.dispatch.v1', '{}'::jsonb),
        ($1::uuid, $2::uuid, 'integration-outbox-worker-message-2', 'integration_record', $2::uuid, 2, 'integration.dispatch.v1', '{}'::jsonb)
      RETURNING id
    `, [tenantId, storeId])
    const delivered: string[] = []
    const dispatcher = new OutboxDispatcher(new ScopedPostgresTransactionRunner(asPool(nativePool)))
    const [first, second] = await Promise.all([
      dispatcher.runBatch({ tenantId, storeId }, 'integration-outbox-one', async (message) => {
        delivered.push(message.id)
      }, { limit: 1 }),
      dispatcher.runBatch({ tenantId, storeId }, 'integration-outbox-two', async (message) => {
        delivered.push(message.id)
      }, { limit: 1 }),
    ])

    expect(first.claimed + second.claimed).toBe(2)
    expect(new Set(delivered)).toEqual(new Set(inserted.rows.map((row) => row.id)))
    expect(first.failed).toEqual([])
    expect(second.failed).toEqual([])
  })
})

const stringCodec: JsonCodec<string> = {
  encode: (value) => value,
  decode: (value) => {
    if (typeof value !== 'string') throw new TypeError('stored result must be a string')
    return value
  },
}

function asPool(nativePool: Pool): PostgresPool {
  return {
    connect: async () => nativePool.connect(),
    end: async () => nativePool.end(),
  }
}
