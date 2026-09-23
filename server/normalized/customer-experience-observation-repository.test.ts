import { assertRuntimeDatabasePool } from './runtime-database-identity.js'
import { CustomerExperienceService } from './customer-experience-service.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import {
  CustomerExperienceObservationRepository,
} from './customer-experience-observation-repository.js'
import {
  ScopedPostgresTransactionRunner,
  type PostgresPool,
  type ScopedTransaction,
} from './transaction-runner.js'

const scope = {
  tenantId: '83000000-0000-4000-8000-000000000001',
  storeId: '83000000-0000-4000-8000-000000000002',
}

describe('customer experience observation authorization', () => {
  it('stores an urgent draft without creating a service task or copying raw text into one', async () => {
    const statements: string[] = []
    const transaction: ScopedTransaction = {
      scope,
      async query<Row extends Record<string, unknown>>(sql: string) {
        statements.push(sql)
        if (sql.includes('FROM mbox.table_sessions session') && sql.includes('SELECT session.table_id')) {
          return result<Row>([{
            table_id: '83000000-0000-4000-8000-000000000003',
            order_id: null,
            schedule_id: null,
          }])
        }
        if (sql.includes('JOIN mbox.table_assignments assignment')) return result<Row>([{ allowed: true }])
        if (sql.includes('FROM mbox.orders orders') && sql.includes('JOIN mbox.order_items item')) return result<Row>([])
        if (sql.includes('INSERT INTO mbox.observation_inputs')) {
          return result<Row>([{ id: '83000000-0000-4000-8000-000000000006' }])
        }
        if (sql.includes('INSERT INTO mbox.observation_parse_runs')) return result<Row>([])
        if (sql.includes('FROM mbox.observation_match_candidates candidate')) return result<Row>([])
        throw new Error(`unexpected query: ${sql}`)
      },
    }

    await expect(new CustomerExperienceObservationRepository(transaction).parse({
      publicId: 'observation-urgent-draft-test',
      tableSessionId: '83000000-0000-4000-8000-000000000004',
      employeeId: '83000000-0000-4000-8000-000000000005',
      rawContent: '顾客原话包含不应进入任务详情的私人内容',
      inputKind: 'text',
      needsImmediateAction: true,
      allowAllTables: false,
      idempotencyKey: 'observation-urgent-draft-idempotency',
    })).resolves.toMatchObject({ needsImmediateAction: true, serviceTaskId: null })

    expect(statements.some((sql) => sql.includes('INSERT INTO mbox.service_tasks'))).toBe(false)
    expect(statements.some((sql) => sql.includes('INSERT INTO mbox.service_task_events'))).toBe(false)
  })

  it('rejects direct recording against another employee table before inserting evidence', async () => {
    const statements: string[] = []
    const transaction: ScopedTransaction = {
      scope,
      async query<Row extends Record<string, unknown>>(sql: string) {
        statements.push(sql)
        if (sql.includes('FROM mbox.table_sessions session') && sql.includes('SELECT session.table_id')) {
          return result<Row>([{
            table_id: '83000000-0000-4000-8000-000000000003',
            order_id: null,
            schedule_id: null,
          }])
        }
        if (sql.includes('JOIN mbox.table_assignments assignment')) {
          return result<Row>([{ allowed: false }])
        }
        throw new Error(`unexpected query: ${sql}`)
      },
    }

    await expect(new CustomerExperienceObservationRepository(transaction).parse({
      publicId: 'observation-scope-denied-test',
      tableSessionId: '83000000-0000-4000-8000-000000000004',
      employeeId: '83000000-0000-4000-8000-000000000005',
      rawContent: '这桌的酒剩了一半',
      inputKind: 'text',
      needsImmediateAction: false,
      allowAllTables: false,
      idempotencyKey: 'observation-scope-denied-idempotency',
    })).rejects.toMatchObject({ code: 'OBSERVATION_TABLE_SCOPE_DENIED', statusCode: 403 })

    expect(statements.some((sql) => sql.includes('INSERT INTO mbox.observation_inputs'))).toBe(false)
  })

  it('creates one minimal service task only after confirmed events are valid', async () => {
    const rawContent = '顾客原话包含不应进入服务任务的私人信息'
    const calls: Array<{ sql: string; values: readonly unknown[] }> = []
    const observationId = '83000000-0000-4000-8000-000000000006'
    const taskId = '83000000-0000-4000-8000-000000000007'
    const employeeId = '83000000-0000-4000-8000-000000000005'
    const transaction: ScopedTransaction = {
      scope,
      async query<Row extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []) {
        calls.push({ sql, values })
        if (sql.includes('FROM mbox.observation_inputs') && sql.includes('FOR UPDATE')) {
          return result<Row>([{
            id: observationId, public_id: 'observation-confirm-test',
            table_session_id: '83000000-0000-4000-8000-000000000004',
            raw_content: rawContent, input_kind: 'text', needs_immediate_action: true,
            service_task_id: null, parse_confidence: '0.4', status: 'draft',
          }])
        }
        if (sql.includes('JOIN mbox.table_assignments assignment')) return result<Row>([{ allowed: true }])
        if (sql.includes('FROM mbox.observation_match_candidates candidate')) return result<Row>([])
        if (sql.includes('FROM mbox.table_sessions session') && sql.includes('SELECT session.table_id')) {
          return result<Row>([{
            table_id: '83000000-0000-4000-8000-000000000003', order_id: null, schedule_id: null,
          }])
        }
        if (sql.includes('INSERT INTO mbox.service_tasks')) {
          return result<Row>([{
            id: taskId, table_id: '83000000-0000-4000-8000-000000000003',
            table_session_id: '83000000-0000-4000-8000-000000000004',
            public_id: `observation-task-${observationId}`, task_type: 'customer_experience.attention',
            title: '桌台体验情况需处理', detail: null, priority: 'high', status: 'pending',
            source: 'employee', requested_role_code: 'SERVER', assigned_employee_id: null,
            backup_employee_id: null, request_count: 1,
            request_snapshot: { source: 'confirmed_observation' }, due_at: null, escalate_at: null,
            next_action_at: '2026-08-16T00:00:00.000Z', acknowledged_at: null,
            completed_at: null, cancelled_at: null, created_at: '2026-08-16T00:00:00.000Z',
            updated_at: '2026-08-16T00:00:00.000Z',
          }])
        }
        if (sql.includes('INSERT INTO mbox.service_task_events')) return result<Row>([{}])
        if (sql.includes('INSERT INTO mbox.observation_events')) {
          return result<Row>([{
            id: '83000000-0000-4000-8000-000000000008',
            event_group_id: '83000000-0000-4000-8000-000000000009', revision_no: 1,
            expression_kind: 'staff_judgement', scope_kind: 'table', event_type: 'complaint',
            degree: 'unknown', reason_code: null, seat_label: null, customer_id: null,
            product_id: null, order_item_id: null, selected_candidate_id: null,
            confidence: '0.9', raw_excerpt: '顾客明确表示不满',
            needs_immediate_action: true, service_task_id: taskId,
          }])
        }
        if (sql.includes('UPDATE mbox.observation_inputs')) return result<Row>([])
        throw new Error(`unexpected query: ${sql}`)
      },
    }

    await expect(new CustomerExperienceObservationRepository(transaction).confirm({
      publicId: 'observation-confirm-test', employeeId, allowAllTables: false,
      events: [{
        expressionKind: 'staff_judgement', scopeKind: 'table', eventType: 'complaint',
        degree: 'unknown', reasonCode: null, seatLabel: null, customerId: null,
        candidateId: null, productId: null, confidence: 0.9, rawExcerpt: '顾客明确表示不满',
      }],
    })).resolves.toMatchObject({ status: 'confirmed', serviceTaskId: taskId })

    const taskInsert = calls.find((call) => call.sql.includes('INSERT INTO mbox.service_tasks'))
    expect(taskInsert).toBeDefined()
    expect(taskInsert?.values[7]).toBeNull()
    expect(JSON.stringify(taskInsert?.values)).not.toContain(rawContent)
    expect(calls.filter((call) => call.sql.includes('INSERT INTO mbox.service_tasks'))).toHaveLength(1)
    expect(calls.some((call) => call.sql.includes('INSERT INTO mbox.service_task_events'))).toBe(true)
  })

  it('lists only the latest confirmed event and redacts raw evidence without view permission', async () => {
    const values: readonly unknown[][] = []
    const observationId = '83000000-0000-4000-8000-000000000021'
    const transaction: ScopedTransaction = {
      scope,
      async query<Row extends Record<string, unknown>>(sql: string, queryValues: readonly unknown[] = []) {
        values.push(queryValues)
        if (sql.includes('JOIN mbox.table_assignments assignment')) return result<Row>([{ allowed: true }])
        if (sql.includes('FROM mbox.observation_inputs observation')) {
          return result<Row>([{
            id: observationId, public_id: 'observation-history-test', input_kind: 'text', raw_content: null,
            parse_confidence: '0.91', needs_immediate_action: true,
            service_task_id: '83000000-0000-4000-8000-000000000022', service_task_status: 'assigned',
            recorded_by: '服务员A', confirmed_by: '服务员A', confirmed_at: '2026-08-16T12:00:00.000Z',
          }])
        }
        if (sql.includes('DISTINCT ON (event.observation_input_id, event.event_group_id)')) {
          return result<Row>([{
            observation_input_id: observationId, id: '83000000-0000-4000-8000-000000000023',
            event_group_id: '83000000-0000-4000-8000-000000000024', revision_no: 2,
            expression_kind: 'customer_quote', scope_kind: 'product', event_type: 'too_sweet', degree: 'most',
            reason_code: null, seat_label: null, customer_id: null,
            product_id: '83000000-0000-4000-8000-000000000025',
            order_item_id: '83000000-0000-4000-8000-000000000026', selected_candidate_id: null,
            confidence: '0.91', raw_excerpt: null, needs_immediate_action: true,
            service_task_id: '83000000-0000-4000-8000-000000000022', product_name: '暮色鸡尾酒',
            created_at: '2026-08-16T12:01:00.000Z',
          }])
        }
        if (sql.includes('FROM mbox.observation_revisions revision')) {
          return result<Row>([{
            id: '83000000-0000-4000-8000-000000000027', observation_input_id: observationId,
            correction_reason: null, corrected_by: '店长A',
            before_snapshot: { eventType: 'other', rawExcerpt: '私密原话' },
            after_snapshot: { eventType: 'too_sweet', rawExcerpt: '私密原话' },
            created_at: '2026-08-16T12:02:00.000Z',
          }])
        }
        throw new Error(`unexpected query: ${sql}`)
      },
    }

    const rows = await new CustomerExperienceObservationRepository(transaction).recent({
      tableSessionId: '83000000-0000-4000-8000-000000000004',
      employeeId: '83000000-0000-4000-8000-000000000005',
      allowAllTables: false, includeRaw: false, limit: 5,
    })

    expect(rows).toMatchObject([{
      publicId: 'observation-history-test', rawContent: null, needsImmediateAction: true,
      serviceTaskStatus: 'assigned', events: [{ revision: 2, rawExcerpt: null, productName: '暮色鸡尾酒' }],
      revisions: [{ reason: '修订原因仅授权人员可见', before: { eventType: 'other' }, after: { eventType: 'too_sweet' } }],
    }])
    expect(JSON.stringify(rows)).not.toContain('私密原话')
    expect(values.some((entry) => entry.includes(false))).toBe(true)
  })
})

function result<Row extends Record<string, unknown>>(rows: Row[]) {
  return { rows, rowCount: rows.length }
}

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const runtimeDatabaseUrl = process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
const integration = databaseUrl && runtimeDatabaseUrl ? describe : describe.skip

integration('observation confirmation privacy with PostgreSQL', () => {
  let pool: Pool
  let runtime: Pool
  let transactions: ScopedPostgresTransactionRunner
  const tenantId = randomUUID()
  const storeId = randomUUID()
  const employeeId = randomUUID()
  const roleId = randomUUID()
  const tableId = randomUUID()
  const tableSessionId = randomUUID()
  const integrationScope = { tenantId, storeId }

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 4 })
    runtime = new Pool({ connectionString: runtimeDatabaseUrl, max: 16 })
    await assertRuntimeDatabasePool(runtime, runtimeDatabaseUrl!)
    transactions = new ScopedPostgresTransactionRunner(asPool(runtime))
    const areaId = randomUUID()
    await pool.query(`INSERT INTO mbox.tenants (id, code, name) VALUES ($1, $2, 'Observation privacy tenant')`, [
      tenantId, `observation-${tenantId.slice(0, 8)}`,
    ])
    await pool.query(`
      INSERT INTO mbox.stores (id, tenant_id, code, name)
      VALUES ($1, $2, $3, 'Observation privacy store')
    `, [storeId, tenantId, `observation-store-${storeId.slice(0, 8)}`])
    await pool.query(`
      INSERT INTO mbox.areas (id, tenant_id, store_id, code, name, area_type)
      VALUES ($1, $2, $3, 'OBS', 'Observation area', 'indoor')
    `, [areaId, tenantId, storeId])
    await pool.query(`
      INSERT INTO mbox.tables (id, tenant_id, store_id, area_id, code, display_name, capacity)
      VALUES ($1, $2, $3, $4, 'OBS1', 'Observation table', 6)
    `, [tableId, tenantId, storeId, areaId])
    await pool.query(`
      INSERT INTO mbox.employees (id, tenant_id, store_id, employee_code, display_name)
      VALUES ($1, $2, $3, 'OBS_SERVER', 'Observation Server')
    `, [employeeId, tenantId, storeId])
    await pool.query(`
      INSERT INTO mbox.roles (id, tenant_id, store_id, code, name)
      VALUES ($1, $2, $3, 'OBS_SERVER', 'Observation Server')
    `, [roleId, tenantId, storeId])
    await pool.query(`
      INSERT INTO mbox.table_assignments (
        tenant_id, store_id, table_id, employee_id, role_id, assignment_type, reason
      ) VALUES ($1, $2, $3, $4, $5, 'primary', '观察流程数据库测试')
    `, [tenantId, storeId, tableId, employeeId, roleId])
    await pool.query(`
      INSERT INTO mbox.table_sessions (
        id, tenant_id, store_id, table_id, public_id, business_date,
        guest_count, status, opened_by_employee_id
      ) VALUES ($1, $2, $3, $4, 'observation-session-db', CURRENT_DATE, 2, 'open', $5)
    `, [tableSessionId, tenantId, storeId, tableId, employeeId])
  })

  afterAll(async () => {
    await runtime?.end()
    await pool?.end()
  })

  it('creates no task at parse and creates a minimal task only after valid confirmation', async () => {
    const rawContent = '顾客原话包含不应进入任务详情的私密联系信息 13800138000'
    const draft = await transactions.run(integrationScope, (transaction) => (
      new CustomerExperienceObservationRepository(transaction).parse({
        publicId: 'observation-privacy-db-test', tableSessionId, employeeId,
        rawContent, inputKind: 'text', needsImmediateAction: true,
        allowAllTables: false, idempotencyKey: 'observation-privacy-db-key',
      })
    ))
    expect(draft.serviceTaskId).toBeNull()
    const before = await pool.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM mbox.service_tasks
      WHERE tenant_id=$1 AND store_id=$2 AND table_session_id=$3
    `, [tenantId, storeId, tableSessionId])
    expect(before.rows[0]?.count).toBe('0')

    const confirmed = await transactions.run(integrationScope, (transaction) => (
      new CustomerExperienceObservationRepository(transaction).confirm({
        publicId: draft.publicId, employeeId, allowAllTables: false,
        events: [{
          expressionKind: 'staff_judgement', scopeKind: 'table', eventType: 'complaint',
          degree: 'unknown', reasonCode: null, seatLabel: null, customerId: null,
          candidateId: null, productId: null, confidence: 0.9, rawExcerpt: '顾客表示需要立即处理',
        }],
      })
    ))
    expect(confirmed.serviceTaskId).not.toBeNull()
    const task = await pool.query<{ detail: string | null; request_snapshot: Record<string, unknown>; count: string }>(`
      SELECT detail, request_snapshot,
        count(*) OVER ()::text AS count
      FROM mbox.service_tasks
      WHERE tenant_id=$1 AND store_id=$2 AND table_session_id=$3
    `, [tenantId, storeId, tableSessionId])
    expect(task.rows[0]).toMatchObject({ detail: null, count: '1' })
    expect(task.rows[0]?.request_snapshot).toMatchObject({
      source: 'confirmed_observation', observationPublicId: draft.publicId,
      eventCount: 1, eventTypes: ['complaint'], scopeKinds: ['table'],
    })
    expect(JSON.stringify(task.rows[0])).not.toContain(rawContent)
  })

  it('serializes revisions through the confirmed input while preserving immutable event history', async () => {
    const replacement = {
      expressionKind: 'staff_judgement' as const, scopeKind: 'table' as const, eventType: 'complaint' as const,
      degree: 'unknown' as const, reasonCode: null, seatLabel: null, customerId: null,
      candidateId: null, productId: null, confidence: 0.9, rawExcerpt: '更正服务记录',
    }
    const draft = await transactions.run(integrationScope, tx => new CustomerExperienceObservationRepository(tx).parse({
      publicId: 'observation-revision-runtime', tableSessionId, employeeId, rawContent: '服务记录',
      inputKind: 'text', needsImmediateAction: false, allowAllTables: false, idempotencyKey: randomUUID(),
    }))
    await transactions.run(integrationScope, tx => new CustomerExperienceObservationRepository(tx).confirm({
      publicId: draft.publicId, employeeId, allowAllTables: false, events: [replacement],
    }))
    const original = (await pool.query(`SELECT event.id,event.raw_excerpt FROM mbox.observation_events event
      JOIN mbox.observation_inputs input ON input.id=event.observation_input_id WHERE input.public_id=$1`, [draft.publicId])).rows[0]!
    const revise = (reason: string) => transactions.run(integrationScope, tx => new CustomerExperienceObservationRepository(tx).revise({
      publicId: draft.publicId, previousEventId: original.id, employeeId, allowAllTables: false, reason, replacement,
    }))
    const outcomes = await Promise.allSettled([revise('第一次更正'), revise('同版本并发更正')])
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = outcomes.find(result => result.status === 'rejected')
    expect(rejected?.status === 'rejected' && rejected.reason).toMatchObject({code: 'OBSERVATION_REVISION_CONFLICT'})
    expect((await pool.query('SELECT raw_excerpt FROM mbox.observation_events WHERE id=$1', [original.id])).rows[0]?.raw_excerpt).toBe(original.raw_excerpt)
    await expect(transactions.run(integrationScope, tx => tx.query('UPDATE mbox.observation_events SET raw_excerpt=$2 WHERE id=$1', [original.id, '改写历史'])))
      .rejects.toMatchObject({code: '42501'})
  })

  it('rolls back before task creation when a confirmed product was not ordered by this table', async () => {
    const draft = await transactions.run(integrationScope, (transaction) => (
      new CustomerExperienceObservationRepository(transaction).parse({
        publicId: 'observation-invalid-db-test', tableSessionId, employeeId,
        rawContent: '这桌的未点商品需要处理', inputKind: 'text', needsImmediateAction: true,
        allowAllTables: false, idempotencyKey: 'observation-invalid-db-key',
      })
    ))
    await expect(transactions.run(integrationScope, (transaction) => (
      new CustomerExperienceObservationRepository(transaction).confirm({
        publicId: draft.publicId, employeeId, allowAllTables: false,
        events: [{
          expressionKind: 'staff_judgement', scopeKind: 'product', eventType: 'complaint',
          degree: 'unknown', reasonCode: null, seatLabel: null, customerId: null,
          candidateId: null, productId: randomUUID(), confidence: 0.8, rawExcerpt: '未点商品',
        }],
      })
    ))).rejects.toMatchObject({ code: 'OBSERVATION_PRODUCT_NOT_ORDERED' })
    const state = await pool.query<{ status: string; task_count: string }>(`
      SELECT observation.status,
        (SELECT count(*)::text FROM mbox.service_tasks task
          WHERE task.tenant_id=observation.tenant_id AND task.store_id=observation.store_id
            AND task.table_session_id=observation.table_session_id) AS task_count
      FROM mbox.observation_inputs observation
      WHERE observation.tenant_id=$1 AND observation.store_id=$2 AND observation.public_id=$3
    `, [tenantId, storeId, draft.publicId])
    expect(state.rows[0]).toEqual({ status: 'draft', task_count: '1' })
  })
  it('commits real service commands, UUID outbox aggregates and idempotent replay together', async () => {
    await pool.query(`INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at)
      VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 day')`,[tenantId,storeId,employeeId,roleId])
    await pool.query(`INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name)
      VALUES($1,$2,'observation.record','记录'),($1,$2,'observation.confirm','确认') ON CONFLICT(tenant_id,store_id,code) DO NOTHING`,[tenantId,storeId])
    await pool.query(`INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
      SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2
      AND code IN ('observation.record','observation.confirm')`,[tenantId,storeId,roleId])
    const service=new CustomerExperienceService(transactions,new NormalizedCommandExecutor(transactions),{updateProfile:async()=>{throw new Error('unused')}})
    const context={scope:integrationScope,employeeId,businessDate:new Date().toISOString().slice(0,10)}
    const input={tableSessionId,rawContent:'客人需要立即加水',inputKind:'text' as const,needsImmediateAction:true,idempotencyKey:randomUUID()}
    const parsed=await service.parseObservation(context,input)
    expect((await service.parseObservation(context,input)).value).toEqual(parsed.value)
    const confirmed=await service.confirmObservation(context,{publicId:parsed.value.publicId,idempotencyKey:randomUUID(),events:[{
      expressionKind:'staff_judgement',scopeKind:'table',eventType:'complaint',degree:'unknown',
      reasonCode:null,seatLabel:null,customerId:null,candidateId:null,productId:null,confidence:0.9,rawExcerpt:'需要加水',
    }]})
    expect(confirmed.value.serviceTaskId).not.toBeNull()
    const rows=await pool.query(`SELECT outbox.aggregate_id::text,observation.id::text, outbox.message_type AS event_type
      FROM mbox.observation_inputs observation JOIN mbox.outbox_messages outbox
        ON outbox.tenant_id=observation.tenant_id AND outbox.store_id=observation.store_id
        AND outbox.aggregate_id=observation.id WHERE observation.public_id=$1`,[parsed.value.publicId])
    expect(rows.rows).toHaveLength(2)
    expect(rows.rows.every(row=>row.aggregate_id===row.id)).toBe(true)
    expect(rows.rows.map(row=>row.event_type).sort()).toEqual(['customer.observation.confirmed.v1','customer.observation.parsed.v1'])
    const policy=await service.createRecommendationPolicy(context,{code:'DEFAULT',preferenceWeight:100,sceneWeight:60,marginWeight:50,priorityWeight:50,
      performanceWeight:50,inventoryWeight:50,capacityWeight:50,minimumGrossMarginBasisPoints:1500,
      preferenceHalfLifeDays:90,preferenceMaxAgeDays:730,preferenceMinEffectiveScore:1000,
      preferenceMinConfidenceBasisPoints:2500,explanationTemplate:'按人数和场景提供建议',displayConfiguration:{},draftReason:'服务事务回归',idempotencyKey:randomUUID()})
    const policyRows=await pool.query(`SELECT outbox.aggregate_id::text FROM mbox.recommendation_policy_versions policy
      JOIN mbox.outbox_messages outbox ON outbox.tenant_id=policy.tenant_id AND outbox.store_id=policy.store_id AND outbox.aggregate_id=policy.id
      WHERE policy.public_id=$1`,[policy.value.publicId])
    expect(policyRows.rows).toHaveLength(1)
  })


})

function asPool(pool: Pool): PostgresPool {
  return { connect: async () => pool.connect(), end: async () => pool.end() }
}
