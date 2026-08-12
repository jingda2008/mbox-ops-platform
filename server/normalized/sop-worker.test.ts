import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { SopRepository } from './sop-repository.js'
import { AiScheduledExecutionWorker, SopWorker, type SopActionPort } from './sop-worker.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip
const tenantId = '92400000-0000-4000-8000-000000000001'
const storeId = '92400000-0000-4000-8000-000000000002'
const employeeId = '92400000-0000-4000-8000-000000000003'
const scope = { tenantId, storeId }

describe('SOP worker validation', () => {
  it('rejects an unbounded batch before accessing PostgreSQL', () => {
    const transactions = { run: vi.fn() } as unknown as ScopedPostgresTransactionRunner
    const worker = new SopWorker(transactions, { execute: vi.fn() })
    expect(() => worker.runBatch(scope, 'sop-worker-a', { batchSize: 51 }))
      .toThrow('batchSize is invalid')
    expect(transactions.run).not.toHaveBeenCalled()
  })

  it('uses the same bounded validation for delayed AI commands', () => {
    const transactions = { run: vi.fn() } as unknown as ScopedPostgresTransactionRunner
    const worker = new AiScheduledExecutionWorker(transactions, { executeClaimedScheduled: vi.fn() })
    expect(() => worker.runBatch(scope, 'ai-worker-a', { batchSize: 0 }))
      .toThrow('batchSize is invalid')
    expect(transactions.run).not.toHaveBeenCalled()
  })
})

integration('SOP worker PostgreSQL concurrency', () => {
  let pool: Pool
  let transactions: ScopedPostgresTransactionRunner

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 8 })
    transactions = new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    await pool.query(`INSERT INTO mbox.tenants(id, code, name)
      VALUES ($1, 'sop-worker', 'SOP Worker') ON CONFLICT (id) DO NOTHING`, [tenantId])
    await pool.query(`INSERT INTO mbox.stores(id, tenant_id, code, name)
      VALUES ($2, $1, 'sop-worker-store', 'SOP Worker Store') ON CONFLICT (id) DO NOTHING`, [tenantId, storeId])
    await pool.query(`INSERT INTO mbox.employees(id, tenant_id, store_id, employee_code, display_name)
      VALUES ($3, $1, $2, 'worker-manager', '李艳') ON CONFLICT (id) DO NOTHING`, [tenantId, storeId, employeeId])
  })

  beforeEach(async () => {
    await clearProtectedRows(pool, [
      'outbox_messages', 'audit_events', 'sop_step_executions', 'sop_instances',
      'sop_rule_steps', 'sop_rule_versions', 'sop_rules',
    ])
  })

  afterAll(async () => pool?.end())

  it('uses SKIP LOCKED so concurrent workers execute a due step exactly once', async () => {
    await seedDueInstance()
    let calls = 0
    const actions: SopActionPort = {
      execute: async () => {
        calls += 1
        await new Promise((resolve) => setTimeout(resolve, 100))
        return { state: 'completed', output: { taskCreated: true }, externalReference: 'task-001' }
      },
    }
    const first = new SopWorker(transactions, actions)
    const second = new SopWorker(transactions, actions)
    const batches = await Promise.all([
      first.runBatch(scope, 'sop-worker-a'),
      second.runBatch(scope, 'sop-worker-b'),
    ])
    expect(batches.reduce((sum, batch) => sum + batch.claimed, 0)).toBe(1)
    expect(calls).toBe(1)
    const state = await pool.query<{
      execution_status: string
      instance_status: string
      audits: string
      outbox: string
    }>(`
      SELECT
        (SELECT status FROM mbox.sop_step_executions WHERE tenant_id = $1 LIMIT 1) AS execution_status,
        (SELECT status FROM mbox.sop_instances WHERE tenant_id = $1 LIMIT 1) AS instance_status,
        (SELECT count(*)::text FROM mbox.audit_events WHERE action = 'sop.step.completed') AS audits,
        (SELECT count(*)::text FROM mbox.outbox_messages WHERE message_type = 'sop.step.completed.v1') AS outbox
    `, [tenantId])
    expect(state.rows[0]).toEqual({
      execution_status: 'completed', instance_status: 'completed', audits: '1', outbox: '1',
    })
  })

  it('waits and then uses configured escalation assignment', async () => {
    await seedDueInstance({ escalationAfterMs: 1_000, escalationRoleCode: 'MANAGER' })
    const phases: string[] = []
    const assignments: Array<{ role: string | null; employee: string | null }> = []
    const actions: SopActionPort = {
      execute: async (request) => {
        phases.push(request.phase)
        assignments.push({
          role: request.assignment.requestedRoleCode,
          employee: request.assignment.assignedEmployeeId,
        })
        return request.phase === 'primary'
          ? { state: 'waiting', externalReference: 'task-001' }
          : { state: 'completed', output: { escalated: true } }
      },
    }
    const worker = new SopWorker(transactions, actions)
    expect((await worker.runBatch(scope, 'sop-worker-a')).processed[0]?.outcome).toBe('waiting')
    await pool.query(`
      UPDATE mbox.sop_step_executions SET next_attempt_at = clock_timestamp() - interval '1 second'
      WHERE tenant_id = $1 AND store_id = $2
    `, [tenantId, storeId])
    expect((await worker.runBatch(scope, 'sop-worker-a')).processed[0]?.outcome).toBe('completed')
    expect(phases).toEqual(['primary', 'escalation'])
    expect(assignments).toEqual([
      { role: 'WAITER', employee: null },
      { role: 'MANAGER', employee: null },
    ])
  })

  async function seedDueInstance(options: {
    escalationAfterMs?: number
    escalationRoleCode?: string
  } = {}) {
    await transactions.run(scope, async (transaction) => {
      const repository = new SopRepository(transaction)
      const rule = await repository.createRule({
        code: `worker-${Math.random().toString(16).slice(2)}`,
        name: 'Worker Test',
        createdByEmployeeId: employeeId,
      })
      const version = await repository.createDraftVersion({
        ruleId: rule.id,
        versionNumber: 1,
        triggerEvent: 'test.triggered',
        createdByEmployeeId: employeeId,
      })
      await repository.addStep({
        versionId: version.id,
        stepKey: 'execute',
        stepOrder: 1,
        name: '执行',
        actionName: 'service.task.create',
        actionInput: { taskType: 'water' },
        requestedRoleCode: 'WAITER',
        escalationAfterMs: options.escalationAfterMs,
        escalationRoleCode: options.escalationRoleCode,
      })
      await repository.publishVersion(version.id, employeeId)
      await repository.trigger({
        triggerEvent: 'test.triggered',
        triggerReference: `trigger-${Math.random()}`,
        businessDate: '2026-08-11',
        context: { tableCode: 'K2' },
      })
    })
  }
})

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
