import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import {
  AiCapabilityCenter,
  AiCapabilityValidationError,
  createCoreAiCapabilities,
  type CoreAiOperationsPort,
} from './ai-capability-center.js'
import { AiScheduledExecutionWorker } from './sop-worker.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip
const tenantId = '92500000-0000-4000-8000-000000000001'
const storeId = '92500000-0000-4000-8000-000000000002'
const employeeId = '92500000-0000-4000-8000-000000000003'
const scope = { tenantId, storeId }
const context = { scope, employeeId, businessDate: '2026-08-11' }

describe('core AI capability definitions', () => {
  it('requires guest count for table opening and never defaults to two', () => {
    const capability = createCoreAiCapabilities(fakeOperations()).find((item) => item.name === 'table.open')!
    expect(() => capability.validate({ tableCode: 'L01' }))
      .toThrow('开台前请说明人数，系统不会默认2人')
    expect(capability.validate({ tableCode: 'L01', guestCount: 3 }))
      .toEqual({ tableCode: 'L01', guestCount: 3 })
  })

  it('marks every configured financial action as human-only', () => {
    const definitions = createCoreAiCapabilities(fakeOperations())
    for (const name of ['refund.request', 'refund.approve', 'cash.confirm']) {
      expect(definitions.find((item) => item.name === name)).toMatchObject({
        requiresHumanConfirmation: true,
      })
    }
  })
})

integration('AI capability center PostgreSQL execution bus', () => {
  let pool: Pool
  let transactions: ScopedPostgresTransactionRunner
  let openTable: ReturnType<typeof vi.fn>
  let water: ReturnType<typeof vi.fn>
  let center: AiCapabilityCenter

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 8 })
    transactions = new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    await pool.query(`INSERT INTO mbox.tenants(id, code, name)
      VALUES ($1, 'ai-center', 'AI Center') ON CONFLICT (id) DO NOTHING`, [tenantId])
    await pool.query(`INSERT INTO mbox.stores(id, tenant_id, code, name)
      VALUES ($2, $1, 'ai-center-store', 'AI Center Store') ON CONFLICT (id) DO NOTHING`, [tenantId, storeId])
    await pool.query(`INSERT INTO mbox.employees(id, tenant_id, store_id, employee_code, display_name)
      VALUES ($3, $1, $2, 'manager-ai', '李艳') ON CONFLICT (id) DO NOTHING`, [tenantId, storeId, employeeId])
  })

  beforeEach(async () => {
    await clearProtectedRows(pool, [
      'outbox_messages', 'audit_events', 'idempotency_records',
      'ai_execution_requests', 'employee_permission_overrides',
    ])
    await grantPermissions(['ai.execute', 'ai.schedule', 'table.open', 'service.execute', 'refund.request'])
    openTable = vi.fn(async (input) => ({ tableCode: input.tableCode, guestCount: input.guestCount }))
    water = vi.fn(async (input) => ({
      tableCode: input.tableCode,
      assignedEmployeeName: input.assignedEmployeeName,
      quantity: input.quantity,
    }))
    center = new AiCapabilityCenter(
      new NormalizedCommandExecutor(transactions),
      createCoreAiCapabilities(operations()),
    )
  })

  afterAll(async () => pool?.end())

  it('executes an exact immediate command once with idempotency, audit and outbox', async () => {
    const input = {
      context,
      proposal: { toolName: 'table.open', arguments: { tableCode: 'L01', guestCount: 3 } },
      idempotencyKey: 'ai-open-table-0001',
      requestFingerprint: 'open:L01:3',
    } as const
    const first = await center.execute(input)
    const replay = await center.execute(input)
    expect(first).toMatchObject({ status: 'succeeded', replayed: false, result: { tableCode: 'L01', guestCount: 3 } })
    expect(replay).toMatchObject({ status: 'succeeded', replayed: true })
    expect(openTable).toHaveBeenCalledTimes(1)
    const evidence = await pool.query<{ audits: string; outbox: string }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.audit_events WHERE action = 'ai.execution.succeeded') AS audits,
        (SELECT count(*)::text FROM mbox.outbox_messages WHERE message_type = 'ai.execution.succeeded.v1') AS outbox
    `)
    expect(evidence.rows[0]).toEqual({ audits: '1', outbox: '1' })
  })

  it('returns candidates for ambiguous entities and never calls the domain port', async () => {
    const result = await center.execute({
      context,
      proposal: { toolName: 'table.open', arguments: { tableCode: 'L0', guestCount: 2 } },
      idempotencyKey: 'ai-open-ambiguous-0001',
      requestFingerprint: 'ambiguous:L0:2',
    })
    expect(result).toMatchObject({
      status: 'needs_clarification',
      candidates: [{ kind: 'table', value: 'L01' }, { kind: 'table', value: 'L07' }],
    })
    expect(openTable).not.toHaveBeenCalled()
  })

  it('persists financial actions for human confirmation and never executes them', async () => {
    const result = await center.execute({
      context,
      proposal: { toolName: 'refund.request', arguments: { orderPublicId: 'ORDER-001' } },
      idempotencyKey: 'ai-refund-human-0001',
      requestFingerprint: 'refund:ORDER-001',
    })
    expect(result).toMatchObject({
      status: 'requires_confirmation',
      requiresHumanConfirmation: true,
    })
    expect(openTable).not.toHaveBeenCalled()
    expect(water).not.toHaveBeenCalled()
  })

  it('schedules a five-minute command and rechecks permission before worker execution', async () => {
    const runAt = new Date(Date.now() + 5 * 60_000).toISOString()
    const scheduled = await center.execute({
      context,
      proposal: {
        toolName: 'service.water.assign',
        arguments: { tableCode: 'K2', employeeName: 'Tom', quantity: 2 },
        runAt,
      },
      idempotencyKey: 'ai-water-delay-0001',
      requestFingerprint: 'water:K2:Tom:2:five-minutes',
    })
    expect(scheduled).toMatchObject({ status: 'scheduled' })
    expect(water).not.toHaveBeenCalled()
    await pool.query(`
      UPDATE mbox.ai_execution_requests SET run_at = clock_timestamp() - interval '1 second'
      WHERE id = $1
    `, [scheduled.requestId])
    const worker = new AiScheduledExecutionWorker(transactions, center)
    const batches = await Promise.all([
      worker.runBatch(scope, 'ai-worker-a'),
      worker.runBatch(scope, 'ai-worker-b'),
    ])
    expect(batches.reduce((sum, batch) => sum + batch.claimed, 0)).toBe(1)
    expect(water).toHaveBeenCalledTimes(1)
    expect(batches.flatMap((batch) => batch.statuses)).toEqual(['succeeded'])
  })

  it('fails closed when permission is revoked after scheduling', async () => {
    const scheduled = await center.execute({
      context,
      proposal: {
        toolName: 'service.water.assign',
        arguments: { tableCode: 'K2', employeeName: 'Tom', quantity: 2 },
        runAt: new Date(Date.now() + 60_000).toISOString(),
      },
      idempotencyKey: 'ai-water-revoked-0001',
      requestFingerprint: 'water:permission-revoked',
    })
    await denyPermission('service.execute')
    await pool.query(`
      UPDATE mbox.ai_execution_requests SET run_at = clock_timestamp() - interval '1 second'
      WHERE id = $1
    `, [scheduled.requestId])
    const batch = await new AiScheduledExecutionWorker(transactions, center)
      .runBatch(scope, 'ai-worker-a')
    expect(batch.statuses).toEqual(['failed'])
    expect(water).not.toHaveBeenCalled()
  })

  it('rolls back the idempotency claim when required details are missing', async () => {
    await expect(center.execute({
      context,
      proposal: { toolName: 'table.open', arguments: { tableCode: 'L01' } },
      idempotencyKey: 'ai-open-missing-count-0001',
      requestFingerprint: 'missing-count',
    })).rejects.toBeInstanceOf(AiCapabilityValidationError)
    const records = await pool.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM mbox.idempotency_records
      WHERE tenant_id = $1 AND store_id = $2 AND idempotency_key = $3
    `, [tenantId, storeId, 'ai-open-missing-count-0001'])
    expect(records.rows[0]?.count).toBe('0')
  })

  function operations(): CoreAiOperationsPort {
    return {
      resolveTable: async (_transaction, code) => code === 'L0'
        ? { kind: 'ambiguous', candidates: ['L01', 'L07'] }
        : code === 'missing'
          ? { kind: 'not_found', candidates: [] }
          : { kind: 'exact', tableId: code === 'K2' ? '92500000-0000-4000-8000-000000000012' : '92500000-0000-4000-8000-000000000011', tableCode: code },
      resolveEmployee: async (_transaction, name) => name === 'Tom'
        ? { kind: 'exact', employeeId: '92500000-0000-4000-8000-000000000013', displayName: 'Tom' }
        : { kind: 'ambiguous', candidates: ['Tom', 'Tony'] },
      openTable,
      createWaterServiceTask: water,
    }
  }

  async function grantPermissions(permissions: readonly string[]) {
    for (const permission of permissions) {
      await pool.query(`
        INSERT INTO mbox.staff_permission_definitions (
          tenant_id, store_id, code, name, category, status
        ) VALUES ($1, $2, $3, $3, 'automation', 'active')
        ON CONFLICT (tenant_id, store_id, code) DO NOTHING
      `, [tenantId, storeId, permission])
      await pool.query(`
        INSERT INTO mbox.employee_permission_overrides (
          tenant_id, store_id, employee_id, permission_id, effect, reason,
          configured_by_employee_id
        ) SELECT $1, $2, $3, id, 'grant', 'AI center test grant', $3
        FROM mbox.staff_permission_definitions
        WHERE tenant_id = $1 AND store_id = $2 AND code = $4
      `, [tenantId, storeId, employeeId, permission])
    }
  }

  async function denyPermission(permission: string) {
    await pool.query(`
      UPDATE mbox.employee_permission_overrides
      SET effect = 'deny', reason = 'AI center test revoke'
      WHERE tenant_id = $1 AND store_id = $2 AND employee_id = $3
        AND permission_id = (
          SELECT id FROM mbox.staff_permission_definitions
          WHERE tenant_id = $1 AND store_id = $2 AND code = $4
        )
    `, [tenantId, storeId, employeeId, permission])
  }
})

function fakeOperations(): CoreAiOperationsPort {
  return {
    resolveTable: async () => ({ kind: 'not_found', candidates: [] }),
    resolveEmployee: async () => ({ kind: 'not_found', candidates: [] }),
    openTable: async () => ({}),
    createWaterServiceTask: async () => ({}),
  }
}

async function clearProtectedRows(pool: Pool, tables: readonly string[]) {
  const client = await pool.connect()
  try {
    await client.query("SET session_replication_role = 'replica'")
    for (const table of tables) {
      await client.query(`DELETE FROM mbox.${table} WHERE tenant_id = $1 AND store_id = $2`, [tenantId, storeId])
    }
  } finally {
    await client.query("SET session_replication_role = 'origin'").catch(() => undefined)
    client.release()
  }
}
