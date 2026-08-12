import { describe, expect, it } from 'vitest'
import type {
  PostgresPool,
  PostgresPoolClient,
  PostgresQueryResult,
} from './index.js'
import { ScopedPostgresTransactionRunner } from './transaction-runner.js'
import { ServiceTaskSlaWorker } from './service-task-sla-worker.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const taskId = '33333333-3333-4333-8333-333333333333'
const backupId = '44444444-4444-4444-8444-444444444444'

interface FakeTask {
  id: string
  status: 'pending' | 'acknowledged' | 'in_progress'
  priority: 'low' | 'normal' | 'high' | 'urgent'
  assignedEmployeeId: string | null
  backupEmployeeId: string | null
  due: boolean
}

interface StagedTask extends FakeTask {
  nextActionAt: string
}

class WorkerPool implements PostgresPool {
  readonly tasks = new Map<string, FakeTask>()
  readonly locks = new Map<string, number>()
  readonly queries: string[] = []
  committedEvents = 0
  committedAudits = 0
  committedOutbox = 0
  failEvent = false
  private clientSequence = 0

  async connect(): Promise<PostgresPoolClient> {
    this.clientSequence += 1
    return new WorkerClient(this, this.clientSequence)
  }

  async end(): Promise<void> {}
}

class WorkerClient implements PostgresPoolClient {
  private started = false
  private contextSet = false
  private stagedTask: StagedTask | null = null
  private stagedEvents = 0
  private stagedAudits = 0
  private stagedOutbox = 0

  constructor(private readonly pool: WorkerPool, private readonly clientId: number) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    const sql = normalizeSql(text)
    this.pool.queries.push(sql)
    if (sql.startsWith('BEGIN ISOLATION LEVEL')) {
      this.started = true
      return result<Row>([])
    }
    if (sql.startsWith("SELECT set_config('app.tenant_id'")) {
      this.requireStarted()
      this.contextSet = true
      return result<Row>([])
    }
    if (sql === 'COMMIT') {
      this.requireContext()
      if (this.stagedTask !== null) {
        this.pool.tasks.set(this.stagedTask.id, {
          id: this.stagedTask.id,
          status: this.stagedTask.status,
          priority: this.stagedTask.priority,
          assignedEmployeeId: this.stagedTask.assignedEmployeeId,
          backupEmployeeId: this.stagedTask.backupEmployeeId,
          due: false,
        })
      }
      this.pool.committedEvents += this.stagedEvents
      this.pool.committedAudits += this.stagedAudits
      this.pool.committedOutbox += this.stagedOutbox
      this.releaseLocks()
      return result<Row>([])
    }
    if (sql === 'ROLLBACK') {
      this.stagedTask = null
      this.stagedEvents = 0
      this.stagedAudits = 0
      this.stagedOutbox = 0
      this.releaseLocks()
      return result<Row>([])
    }
    this.requireContext()

    if (sql.includes('FOR UPDATE SKIP LOCKED')) {
      const limit = Number(values[2])
      const claimed = [...this.pool.tasks.values()]
        .filter((task) => task.due && !this.pool.locks.has(task.id))
        .slice(0, limit)
      for (const task of claimed) this.pool.locks.set(task.id, this.clientId)
      return result<Row>(claimed.map((task) => ({
        id: task.id,
        status: task.status,
        priority: task.priority,
        assigned_employee_id: task.assignedEmployeeId,
        backup_employee_id: task.backupEmployeeId,
      }) as unknown as Row))
    }
    if (sql.startsWith('UPDATE mbox.service_tasks')) {
      const original = this.pool.tasks.get(String(values[2]))
      if (original === undefined || this.pool.locks.get(original.id) !== this.clientId) {
        return result<Row>([])
      }
      this.stagedTask = {
        ...original,
        priority: String(values[3]) as FakeTask['priority'],
        assignedEmployeeId: values[4] === null ? null : String(values[4]),
        backupEmployeeId: values[5] === true ? null : original.backupEmployeeId,
        nextActionAt: '2026-08-11T12:02:00.000Z',
      }
      return result<Row>([{
        id: original.id,
        status: original.status,
        priority: this.stagedTask.priority,
        assigned_employee_id: this.stagedTask.assignedEmployeeId,
        backup_employee_id: this.stagedTask.backupEmployeeId,
        next_action_at: this.stagedTask.nextActionAt,
      } as unknown as Row])
    }
    if (sql.startsWith('INSERT INTO mbox.service_task_events')) {
      if (this.pool.failEvent) throw new Error('event store unavailable')
      this.stagedEvents += 1
      return { rows: [], rowCount: 1 }
    }
    if (sql.startsWith('INSERT INTO mbox.audit_events')) {
      this.stagedAudits += 1
      return { rows: [], rowCount: 1 }
    }
    if (sql.startsWith('INSERT INTO mbox.outbox_messages')) {
      this.stagedOutbox += 1
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`Unexpected SQL: ${sql}`)
  }

  release(): void {
    this.releaseLocks()
  }

  private releaseLocks(): void {
    for (const [id, owner] of this.pool.locks) {
      if (owner === this.clientId) this.pool.locks.delete(id)
    }
  }

  private requireStarted(): void {
    if (!this.started) throw new Error('transaction not started')
  }

  private requireContext(): void {
    this.requireStarted()
    if (!this.contextSet) throw new Error('scope not set')
  }
}

describe('ServiceTaskSlaWorker', () => {
  it('claims at most 50 due tasks with row-level SKIP LOCKED semantics', async () => {
    const pool = new WorkerPool()
    pool.tasks.set(taskId, task())
    const worker = new ServiceTaskSlaWorker(new ScopedPostgresTransactionRunner(pool))

    const batch = await worker.runBatch({ tenantId, storeId }, 'sla-worker-a')

    expect(batch.claimed).toBe(1)
    expect(batch.processed[0]).toMatchObject({
      taskId,
      action: 'backup_assigned',
      assignedEmployeeId: backupId,
    })
    const claimSql = pool.queries.find((sql) => sql.includes('FOR UPDATE SKIP LOCKED'))
    expect(claimSql).toContain('LIMIT $3')
    expect(claimSql).toContain("status IN ('pending', 'acknowledged', 'in_progress')")
    expect(claimSql).toContain("backup.status = 'active'")
  })

  it('prevents two worker instances from processing the same due task', async () => {
    const pool = new WorkerPool()
    pool.tasks.set(taskId, task())
    const runner = new ScopedPostgresTransactionRunner(pool)
    const first = new ServiceTaskSlaWorker(runner)
    const second = new ServiceTaskSlaWorker(runner)

    const batches = await Promise.all([
      first.runBatch({ tenantId, storeId }, 'sla-worker-a'),
      second.runBatch({ tenantId, storeId }, 'sla-worker-b'),
    ])

    expect(batches.reduce((sum, batch) => sum + batch.claimed, 0)).toBe(1)
    expect(pool.committedEvents).toBe(1)
    expect(pool.committedAudits).toBe(1)
    expect(pool.committedOutbox).toBe(1)
    expect(pool.tasks.get(taskId)).toMatchObject({
      assignedEmployeeId: backupId,
      backupEmployeeId: null,
      due: false,
    })
  })

  it('rolls back the SLA update when its event cannot be appended', async () => {
    const pool = new WorkerPool()
    pool.tasks.set(taskId, task())
    pool.failEvent = true
    const worker = new ServiceTaskSlaWorker(new ScopedPostgresTransactionRunner(pool))

    await expect(worker.runBatch({ tenantId, storeId }, 'sla-worker-a'))
      .rejects.toThrow('event store unavailable')

    expect(pool.tasks.get(taskId)).toEqual(task())
    expect(pool.committedEvents).toBe(0)
    expect(pool.locks.size).toBe(0)
    expect(pool.queries).toContain('ROLLBACK')
  })

  it('rejects oversized batches instead of silently defeating the bounded claim', async () => {
    const pool = new WorkerPool()
    const worker = new ServiceTaskSlaWorker(new ScopedPostgresTransactionRunner(pool))

    expect(() => worker.runBatch({ tenantId, storeId }, 'sla-worker-a', { batchSize: 51 }))
      .toThrow('batchSize must be an integer between 1 and 50')
    expect(pool.queries).toHaveLength(0)
  })
})

function task(): FakeTask {
  return {
    id: taskId,
    status: 'pending',
    priority: 'normal',
    assignedEmployeeId: null,
    backupEmployeeId: backupId,
    due: true,
  }
}

function result<Row extends Record<string, unknown>>(rows: Row[]): PostgresQueryResult<Row> {
  return { rows, rowCount: rows.length }
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}
