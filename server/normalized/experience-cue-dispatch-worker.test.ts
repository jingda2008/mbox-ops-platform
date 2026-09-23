import { describe, expect, it, vi } from 'vitest'
import { ExperienceCueDispatchWorker } from './experience-cue-dispatch-worker.js'
import type { ServiceTask } from './service-task-repository.js'
import type { PostgresPoolClient, PostgresQueryResult } from './transaction-runner.js'
import { ScopedPostgresTransactionRunner } from './transaction-runner.js'

const scope = {
  tenantId: '83000000-0000-4000-8000-000000000001',
  storeId: '83000000-0000-4000-8000-000000000002',
}
const cueId = '83000000-0000-4000-8000-000000000003'
const taskId = '83000000-0000-4000-8000-000000000004'

class CueClient implements PostgresPoolClient {
  readonly calls: string[] = []

  async query<Row extends Record<string, unknown>>(sql: string): Promise<PostgresQueryResult<Row>> {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    this.calls.push(normalized)
    if (normalized.startsWith('BEGIN') || normalized === 'COMMIT' || normalized === 'ROLLBACK'
      || normalized.startsWith("SELECT set_config('app.tenant_id'")) return result([])
    if (normalized.startsWith('WITH candidates AS')) return result([])
    if (normalized.startsWith('SELECT cue.id')) return result([{
      id: cueId,
      cue_code: 'comfort.check',
      action_kind: 'checkin',
      station: 'service',
      action_payload: { instruction: '确认第一轮是否合口味' },
      due_at: '2026-08-15T12:00:00.000Z',
      plan_public_id: 'experience-plan-test-0001',
      table_id: '83000000-0000-4000-8000-000000000005',
      table_session_id: '83000000-0000-4000-8000-000000000006',
    }])
    if (normalized.startsWith('UPDATE mbox.experience_plan_cues')) return result([{}])
    if (normalized.startsWith('INSERT INTO mbox.outbox_messages')) return result([{}])
    throw new Error(`Unexpected cue worker query: ${normalized}`)
  }

  release(): void {}
}

describe('ExperienceCueDispatchWorker', () => {
  it('turns a due experience cue into a role-routed service task exactly once', async () => {
    const client = new CueClient()
    const create = vi.fn(async (input) => serviceTask(input))
    const worker = new ExperienceCueDispatchWorker(runner(client), () => ({ create }))
    const batch = await worker.runBatch(scope, 'experience-cue-test')

    expect(batch).toEqual({ workerId: 'experience-cue-test', claimed: 1, dispatchedCueIds: [cueId], skippedCueIds: [] })
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      taskType: 'experience.checkin',
      title: '完成本桌体验回访',
      detail: '确认第一轮是否合口味',
      requestedRoleCode: 'SERVER',
      source: 'system',
      requestSnapshot: expect.objectContaining({ experienceCueId: cueId, station: 'service' }),
    }))
    expect(client.calls).toEqual(expect.arrayContaining([
      expect.stringContaining('FOR UPDATE OF cue SKIP LOCKED'),
      expect.stringContaining("SET status = 'dispatched'"),
      expect.stringContaining('customer.experience.cue.dispatched.v1'),
    ]))
  })
})

function runner(client: PostgresPoolClient) {
  return new ScopedPostgresTransactionRunner({ connect: async () => client, end: async () => undefined })
}

function serviceTask(input: Record<string, unknown>): ServiceTask {
  return {
    id: taskId,
    tableId: String(input.tableId),
    tableSessionId: String(input.tableSessionId),
    publicId: String(input.publicId),
    taskType: String(input.taskType),
    title: String(input.title),
    detail: typeof input.detail === 'string' ? input.detail : null,
    priority: 'normal',
    status: 'pending',
    source: 'system',
    requestedRoleCode: String(input.requestedRoleCode),
    assignedEmployeeId: null,
    backupEmployeeId: null,
    requestCount: 1,
    requestSnapshot: {},
    dueAt: String(input.dueAt),
    escalateAt: null,
    nextActionAt: String(input.dueAt),
    acknowledgedAt: null,
    completedAt: null,
    cancelledAt: null,
    createdAt: '2026-08-15T12:00:00.000Z',
    updatedAt: '2026-08-15T12:00:00.000Z',
  }
}

function result<Row extends Record<string, unknown>>(rows: Row[]): PostgresQueryResult<Row> {
  return { rows, rowCount: rows.length }
}
