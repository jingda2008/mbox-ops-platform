import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import {
  matchesSopCondition,
  SopCommandService,
  SopRepository,
} from './sop-repository.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip
const tenantId = '92300000-0000-4000-8000-000000000001'
const storeId = '92300000-0000-4000-8000-000000000002'
const employeeId = '92300000-0000-4000-8000-000000000003'
const scope = { tenantId, storeId }

describe('SOP condition language', () => {
  it('supports nested all/any, paths, membership and numeric comparisons', () => {
    const facts = { table: { code: 'L01', guestCount: 4 }, event: 'table.opened' }
    expect(matchesSopCondition({
      all: [
        { fact: 'table.guestCount', operator: 'gte', value: 2 },
        { any: [
          { fact: 'table.code', operator: 'eq', value: 'L01' },
          { fact: 'table.code', operator: 'eq', value: 'K02' },
        ] },
      ],
    }, facts)).toBe(true)
    expect(matchesSopCondition({
      fact: 'table.code', operator: 'in', value: ['VIP1', 'VIP2'],
    }, facts)).toBe(false)
    expect(matchesSopCondition({ fact: 'missing', operator: 'not_exists' }, facts)).toBe(true)
  })

  it('fails closed for malformed or unknown operators', () => {
    expect(matchesSopCondition({ operator: 'eq', value: 1 }, {})).toBe(false)
    expect(matchesSopCondition({ fact: 'x', operator: 'execute_sql', value: 1 }, { x: 1 })).toBe(false)
  })
})

integration('SOP normalized repository', () => {
  let pool: Pool
  let transactions: ScopedPostgresTransactionRunner

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 8 })
    transactions = new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    await pool.query(`INSERT INTO mbox.tenants(id, code, name)
      VALUES ($1, 'sop-test', 'SOP Test') ON CONFLICT (id) DO NOTHING`, [tenantId])
    await pool.query(`INSERT INTO mbox.stores(id, tenant_id, code, name)
      VALUES ($2, $1, 'sop-store', 'SOP Store') ON CONFLICT (id) DO NOTHING`, [tenantId, storeId])
    await pool.query(`INSERT INTO mbox.employees(id, tenant_id, store_id, employee_code, display_name)
      VALUES ($3, $1, $2, 'manager-sop', '李艳') ON CONFLICT (id) DO NOTHING`, [tenantId, storeId, employeeId])
    await grantPermissions(pool, ['sop.execute'])
  })

  beforeEach(async () => {
    await clearProtectedRows(pool, [
      'outbox_messages', 'audit_events', 'idempotency_records', 'sop_step_executions',
      'sop_instances', 'sop_rule_steps', 'sop_rule_versions', 'sop_rules',
    ])
  })

  afterAll(async () => pool?.end())

  it('publishes an immutable version and creates only the first due step', async () => {
    const definition = await createPublishedDefinition(transactions)
    const instances = await transactions.run(scope, (transaction) => new SopRepository(transaction).trigger({
      triggerEvent: 'table.opened',
      triggerReference: 'table-session:L01:001',
      businessDate: '2026-08-11',
      context: { table: { code: 'L01', guestCount: 4 } },
    }))
    expect(instances).toHaveLength(1)
    const counts = await pool.query<{ executions: string; instances: string }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.sop_step_executions WHERE tenant_id = $1) AS executions,
        (SELECT count(*)::text FROM mbox.sop_instances WHERE tenant_id = $1) AS instances
    `, [tenantId])
    expect(counts.rows[0]).toEqual({ executions: '1', instances: '1' })
    await expect(pool.query(`
      UPDATE mbox.sop_rule_steps SET action_name = 'unsafe.changed'
      WHERE id = $1
    `, [definition.stepId])).rejects.toMatchObject({ code: '55000' })
  })

  it('is idempotent for the same trigger and records command audit/outbox with live permission', async () => {
    await createPublishedDefinition(transactions)
    const service = new SopCommandService(new NormalizedCommandExecutor(transactions))
    const input = {
      scope,
      employeeId,
      businessDate: '2026-08-11',
      idempotencyKey: 'sop-trigger-idempotent-0001',
      requestFingerprint: 'table-opened:L01:001',
      trigger: {
        triggerEvent: 'table.opened',
        triggerReference: 'table-session:L01:001',
        businessDate: '2026-08-11',
        context: { table: { code: 'L01', guestCount: 2 } },
      },
    } as const
    const first = await service.trigger(input)
    const replay = await service.trigger(input)
    expect(first.value).toHaveLength(1)
    expect(replay).toEqual({ value: first.value, replayed: true })
    const evidence = await pool.query<{ audits: string; outbox: string }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.audit_events WHERE action = 'sop.instance.started') AS audits,
        (SELECT count(*)::text FROM mbox.outbox_messages WHERE message_type = 'sop.instance.started.v1') AS outbox
    `)
    expect(evidence.rows[0]).toEqual({ audits: '1', outbox: '1' })
  })

  it('rechecks permission at execution time', async () => {
    await createPublishedDefinition(transactions)
    await pool.query(`
      UPDATE mbox.employee_permission_overrides
      SET effect = 'deny', reason = 'permission revoked for test'
      WHERE tenant_id = $1 AND store_id = $2 AND employee_id = $3
        AND permission_id = (
          SELECT id FROM mbox.staff_permission_definitions
          WHERE tenant_id = $1 AND store_id = $2 AND code = 'sop.execute'
        )
    `, [tenantId, storeId, employeeId])
    const service = new SopCommandService(new NormalizedCommandExecutor(transactions))
    await expect(service.trigger({
      scope,
      employeeId,
      businessDate: '2026-08-11',
      idempotencyKey: 'sop-trigger-denied-0001',
      requestFingerprint: 'denied',
      trigger: {
        triggerEvent: 'table.opened', triggerReference: 'denied',
        businessDate: '2026-08-11', context: {},
      },
    })).rejects.toMatchObject({ name: 'StaffAccessDeniedError' })
    await grantPermissions(pool, ['sop.execute'])
  })
})

async function createPublishedDefinition(transactions: ScopedPostgresTransactionRunner) {
  return transactions.run(scope, async (transaction) => {
    const repository = new SopRepository(transaction)
    const rule = await repository.createRule({
      code: `table-care-${Math.random().toString(16).slice(2)}`,
      name: '开台关怀',
      createdByEmployeeId: employeeId,
    })
    const version = await repository.createDraftVersion({
      ruleId: rule.id,
      versionNumber: 1,
      triggerEvent: 'table.opened',
      triggerCondition: { fact: 'table.guestCount', operator: 'gte', value: 1 },
      createdByEmployeeId: employeeId,
    })
    const step = await repository.addStep({
      versionId: version.id,
      stepKey: 'first-care',
      stepOrder: 1,
      name: '首次关怀',
      delayMs: 900_000,
      actionName: 'service.task.create',
      actionInput: { taskType: 'table.care' },
      requestedRoleCode: 'WAITER',
      escalationAfterMs: 300_000,
      escalationRoleCode: 'MANAGER',
    })
    await repository.addStep({
      versionId: version.id,
      stepKey: 'second-care',
      stepOrder: 2,
      name: '再次关怀',
      delayMs: 900_000,
      actionName: 'service.task.create',
      actionInput: { taskType: 'table.followup' },
    })
    await repository.publishVersion(version.id, employeeId)
    return { ruleId: rule.id, versionId: version.id, stepId: step.id }
  })
}

async function grantPermissions(pool: Pool, permissions: readonly string[]) {
  for (const permission of permissions) {
    await pool.query(`
      INSERT INTO mbox.staff_permission_definitions (
        tenant_id, store_id, code, name, category, status
      ) VALUES ($1, $2, $3, $3, 'automation', 'active')
      ON CONFLICT (tenant_id, store_id, code) DO NOTHING
    `, [tenantId, storeId, permission])
    await pool.query(`DELETE FROM mbox.employee_permission_overrides
      WHERE tenant_id = $1 AND store_id = $2 AND employee_id = $3
        AND permission_id = (
          SELECT id FROM mbox.staff_permission_definitions
          WHERE tenant_id = $1 AND store_id = $2 AND code = $4
        )`, [tenantId, storeId, employeeId, permission])
    await pool.query(`INSERT INTO mbox.employee_permission_overrides (
        tenant_id, store_id, employee_id, permission_id, effect, reason,
        configured_by_employee_id
      ) SELECT $1, $2, $3, id, 'grant', 'normalized test grant', $3
        FROM mbox.staff_permission_definitions
        WHERE tenant_id = $1 AND store_id = $2 AND code = $4
    `, [tenantId, storeId, employeeId, permission])
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
