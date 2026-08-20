import { createHash } from 'node:crypto'
import type { JsonObject } from './command-executor.js'
import { ServiceTaskRepository, type ServiceTask } from './service-task-repository.js'
import type { ScopedPostgresTransactionRunner, ScopedTransaction, StoreScope } from './transaction-runner.js'

interface DueExperienceCue extends Record<string, unknown> {
  id: string
  cue_code: string
  action_kind: string
  station: ExperienceStation
  action_payload: JsonObject
  due_at: string
  plan_public_id: string
  table_id: string
  table_session_id: string
}

type ExperienceStation = 'host' | 'service' | 'bar' | 'cold_kitchen' | 'stage' | 'manager' | 'marketing'

type TaskRepositoryPort = Pick<ServiceTaskRepository, 'create'>

export interface ExperienceCueDispatchBatch {
  workerId: string
  claimed: number
  dispatchedCueIds: readonly string[]
  skippedCueIds: readonly string[]
}

export class ExperienceCueDispatchWorker {
  constructor(
    private readonly transactions: ScopedPostgresTransactionRunner,
    private readonly createTasks: (transaction: ScopedTransaction) => TaskRepositoryPort = (transaction) => new ServiceTaskRepository(transaction),
  ) {}

  runBatch(scope: Readonly<StoreScope>, workerId: string, batchSize = 50): Promise<ExperienceCueDispatchBatch> {
    validateWorkerId(workerId)
    validateBatchSize(batchSize)
    return this.transactions.run(scope, async (transaction) => {
      const skippedCueIds = await skipClosedPlans(transaction, batchSize)
      const due = await claimDue(transaction, batchSize)
      const tasks = this.createTasks(transaction)
      const dispatchedCueIds: string[] = []
      for (const cue of due) {
        const instruction = publicInstruction(cue.action_payload)
        const task = await tasks.create({
          tableId: cue.table_id,
          tableSessionId: cue.table_session_id,
          publicId: deterministicTaskPublicId(cue.id),
          taskType: `experience.${cue.action_kind}`,
          title: cueTitle(cue.action_kind),
          detail: instruction,
          priority: cue.action_kind === 'welcome' || cue.station === 'manager' ? 'high' : 'normal',
          source: 'system',
          requestedRoleCode: stationRole(cue.station),
          requestSnapshot: {
            experienceCueId: cue.id,
            cueCode: cue.cue_code,
            experiencePlanPublicId: cue.plan_public_id,
            station: cue.station,
          },
          dueAt: cue.due_at,
          actor: { type: 'system' },
          eventIdempotencyKey: `experience-cue-dispatch:${cue.id}`,
        })
        await markDispatched(transaction, cue, task, workerId)
        dispatchedCueIds.push(cue.id)
      }
      return { workerId, claimed: due.length, dispatchedCueIds, skippedCueIds }
    })
  }
}

async function skipClosedPlans(transaction: ScopedTransaction, batchSize: number): Promise<string[]> {
  const result = await transaction.query<{ id: string }>(`
    WITH candidates AS (
      SELECT cue.id
      FROM mbox.experience_plan_cues AS cue
      JOIN mbox.customer_experience_plans AS plan
        ON plan.tenant_id = cue.tenant_id AND plan.store_id = cue.store_id
       AND plan.id = cue.experience_plan_id
      JOIN mbox.table_sessions AS session
        ON session.tenant_id = plan.tenant_id AND session.store_id = plan.store_id
       AND session.id = plan.table_session_id
      WHERE cue.tenant_id = $1::uuid AND cue.store_id = $2::uuid
        AND cue.status IN ('pending', 'ready')
        AND (plan.plan_state IN ('completed', 'cancelled') OR session.status NOT IN ('open', 'closing'))
      ORDER BY cue.created_at, cue.id
      FOR UPDATE OF cue SKIP LOCKED
      LIMIT $3
    )
    UPDATE mbox.experience_plan_cues AS cue
    SET status = 'skipped', updated_at = clock_timestamp(),
      action_payload = action_payload || '{"skipReason":"table_or_plan_closed"}'::jsonb
    FROM candidates
    WHERE cue.tenant_id = $1::uuid AND cue.store_id = $2::uuid AND cue.id = candidates.id
    RETURNING cue.id
  `, [transaction.scope.tenantId, transaction.scope.storeId, batchSize])
  return result.rows.map((row) => row.id)
}

async function claimDue(transaction: ScopedTransaction, batchSize: number): Promise<DueExperienceCue[]> {
  const result = await transaction.query<DueExperienceCue>(`
    SELECT cue.id, cue.cue_code, cue.action_kind, cue.station,
      cue.action_payload, cue.due_at::text,
      plan.public_id AS plan_public_id, plan.table_session_id,
      session.table_id
    FROM mbox.experience_plan_cues AS cue
    JOIN mbox.customer_experience_plans AS plan
      ON plan.tenant_id = cue.tenant_id AND plan.store_id = cue.store_id
     AND plan.id = cue.experience_plan_id
    JOIN mbox.table_sessions AS session
      ON session.tenant_id = plan.tenant_id AND session.store_id = plan.store_id
     AND session.id = plan.table_session_id
    WHERE cue.tenant_id = $1::uuid AND cue.store_id = $2::uuid
      AND cue.status IN ('pending', 'ready')
      AND cue.due_at IS NOT NULL AND cue.due_at <= clock_timestamp()
      AND plan.plan_state = 'active' AND session.status IN ('open', 'closing')
    ORDER BY cue.due_at, cue.sequence_no, cue.id
    FOR UPDATE OF cue SKIP LOCKED
    LIMIT $3
  `, [transaction.scope.tenantId, transaction.scope.storeId, batchSize])
  return result.rows
}

async function markDispatched(
  transaction: ScopedTransaction,
  cue: DueExperienceCue,
  task: ServiceTask,
  workerId: string,
): Promise<void> {
  await transaction.query(`
    UPDATE mbox.experience_plan_cues
    SET status = 'dispatched', service_task_id = $4::uuid,
      updated_at = clock_timestamp(),
      action_payload = action_payload || jsonb_build_object('dispatchedBy', $5, 'dispatchedAt', clock_timestamp())
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      AND status IN ('pending', 'ready')
  `, [transaction.scope.tenantId, transaction.scope.storeId, cue.id, task.id, workerId])
  await transaction.query(`
    INSERT INTO mbox.outbox_messages (
      tenant_id, store_id, message_key, aggregate_type, aggregate_id,
      aggregate_version, message_type, payload
    ) VALUES (
      $1::uuid, $2::uuid, $3, 'experience_plan_cue', $4::uuid,
      1, 'customer.experience.cue.dispatched.v1',
      jsonb_build_object(
        'cueId', $4::uuid, 'cueCode', $5, 'serviceTaskPublicId', $6,
        'experiencePlanPublicId', $7, 'station', $8, 'workerId', $9
      )
    ) ON CONFLICT (tenant_id, store_id, message_key) DO NOTHING
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    `experience-cue-dispatched:${cue.id}`,
    cue.id,
    cue.cue_code,
    task.publicId,
    cue.plan_public_id,
    cue.station,
    workerId,
  ])
}

function stationRole(station: ExperienceStation): string {
  return {
    host: 'GREETER',
    service: 'SERVER',
    bar: 'BARTENDER',
    cold_kitchen: 'KITCHEN',
    stage: 'STAGE_OPS',
    manager: 'MANAGER',
    marketing: 'MARKETING',
  }[station]
}

function cueTitle(actionKind: string): string {
  return ({
    welcome: '完成本桌体验确认', service: '完成本桌服务安排', drink: '准备本桌酒水节点',
    food: '准备本桌冷食节点', music: '衔接当晚演出节点', interaction: '执行本桌互动节点',
    checkin: '完成本桌体验回访', upsell: '确认是否需要延续体验', farewell: '完成离店收尾',
  } as Record<string, string>)[actionKind] ?? '执行本桌体验节点'
}

function publicInstruction(payload: JsonObject): string {
  const value = payload.instruction
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 2_000) : '请按本桌体验安排执行，并记录实际结果。'
}

function deterministicTaskPublicId(cueId: string): string {
  return `experience-task-${createHash('sha256').update(cueId).digest('hex').slice(0, 24)}`
}

function validateWorkerId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/.test(value)) throw new TypeError('workerId must be a stable internal identifier')
}

function validateBatchSize(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 50) throw new TypeError('batchSize must be an integer between 1 and 50')
}
