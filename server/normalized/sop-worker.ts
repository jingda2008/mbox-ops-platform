import type { JsonObject } from './command-executor.js'
import type {
  AiScheduledExecutionPort,
  AiScheduledRequestRow,
  AiExecutionStatus,
} from './ai-capability-center.js'
import { matchesSopCondition } from './sop-repository.js'
import type { ScopedPostgresTransactionRunner, ScopedTransaction, StoreScope } from './transaction-runner.js'

export interface SopActionAssignment {
  requestedRoleCode: string | null
  assignedEmployeeId: string | null
}

export interface SopActionRequest {
  transaction: ScopedTransaction
  instanceId: string
  executionId: string
  actionName: string
  actionInput: JsonObject
  context: JsonObject
  phase: 'primary' | 'escalation'
  assignment: SopActionAssignment
  idempotencyKey: string
}

export type SopActionResult =
  | { state: 'completed'; output?: JsonObject; externalReference?: string | null }
  | { state: 'waiting'; output?: JsonObject; externalReference: string }

export interface SopActionPort {
  execute(request: Readonly<SopActionRequest>): Promise<SopActionResult>
}

export interface SopWorkerOptions {
  batchSize?: number
  retryDelayMs?: number
}

export interface SopWorkerItemResult {
  executionId: string
  instanceId: string
  outcome: 'completed' | 'waiting' | 'skipped' | 'failed'
}

export interface SopWorkerBatchResult {
  workerId: string
  claimed: number
  processed: readonly SopWorkerItemResult[]
}

interface ClaimedStepRow extends Record<string, unknown> {
  execution_id: string
  instance_id: string
  execution_status: 'pending' | 'waiting'
  attempt_count: number
  context_snapshot: JsonObject
  instance_end_condition: JsonObject
  current_step_order: number
  instance_version: string | number
  step_id: string
  step_order: number
  condition_snapshot: JsonObject
  action_name: string
  action_input: JsonObject
  requested_role_code: string | null
  assigned_employee_id: string | null
  escalation_after_ms: string | number | null
  escalation_role_code: string | null
  escalation_employee_id: string | null
  step_end_condition: JsonObject
  max_attempts: number
}

interface NextStepRow extends Record<string, unknown> {
  id: string
  step_order: number
  delay_ms: string | number
}

export class SopWorker {
  constructor(
    private readonly transactions: ScopedPostgresTransactionRunner,
    private readonly actions: SopActionPort,
  ) {}

  runBatch(
    scope: Readonly<StoreScope>,
    workerId: string,
    options: Readonly<SopWorkerOptions> = {},
  ): Promise<SopWorkerBatchResult> {
    validateWorkerId(workerId)
    const batchSize = boundedInteger(options.batchSize ?? 50, 'batchSize', 1, 50)
    const retryDelayMs = boundedInteger(options.retryDelayMs ?? 30_000, 'retryDelayMs', 1_000, 3_600_000)
    return this.transactions.run(scope, async (transaction) => {
      const claimed = await claimDueSteps(transaction, batchSize)
      const processed: SopWorkerItemResult[] = []
      for (const row of claimed) {
        processed.push(await processStep(transaction, this.actions, row, workerId, retryDelayMs))
      }
      return { workerId, claimed: claimed.length, processed }
    }, { isolation: 'read-committed' })
  }
}

export class AiScheduledExecutionWorker {
  constructor(
    private readonly transactions: ScopedPostgresTransactionRunner,
    private readonly executions: AiScheduledExecutionPort,
  ) {}

  runBatch(
    scope: Readonly<StoreScope>,
    workerId: string,
    options: Readonly<Pick<SopWorkerOptions, 'batchSize'>> = {},
  ): Promise<{ workerId: string; claimed: number; statuses: readonly AiExecutionStatus[] }> {
    validateWorkerId(workerId)
    const batchSize = boundedInteger(options.batchSize ?? 50, 'batchSize', 1, 50)
    return this.transactions.run(scope, async (transaction) => {
      const claimed = await claimDueAiExecutions(transaction, workerId, batchSize)
      const statuses: AiExecutionStatus[] = []
      for (const request of claimed) {
        statuses.push(await this.executions.executeClaimedScheduled(transaction, request, workerId))
      }
      return { workerId, claimed: claimed.length, statuses }
    }, { isolation: 'read-committed' })
  }
}

async function claimDueAiExecutions(
  transaction: ScopedTransaction,
  workerId: string,
  limit: number,
): Promise<AiScheduledRequestRow[]> {
  const result = await transaction.query<{
    id: string
    requested_by_employee_id: string
    tool_name: string
    arguments_snapshot: JsonObject
    run_at: string
    attempt_count: number
  }>(`
    WITH due AS (
      SELECT id
      FROM mbox.ai_execution_requests
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND status = 'scheduled' AND run_at <= clock_timestamp()
      ORDER BY run_at, created_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT $3
    )
    UPDATE mbox.ai_execution_requests AS request
    SET status = 'processing', attempt_count = attempt_count + 1,
        worker_locked_by = $4, worker_locked_at = clock_timestamp()
    FROM due
    WHERE request.tenant_id = $1::uuid AND request.store_id = $2::uuid
      AND request.id = due.id AND request.status = 'scheduled'
    RETURNING request.id, request.requested_by_employee_id, request.tool_name,
      request.arguments_snapshot, request.run_at::text, request.attempt_count
  `, [transaction.scope.tenantId, transaction.scope.storeId, limit, workerId])
  return result.rows.map((row) => ({
    id: row.id,
    requestedByEmployeeId: row.requested_by_employee_id,
    toolName: row.tool_name,
    arguments: row.arguments_snapshot,
    runAt: row.run_at,
    attemptCount: row.attempt_count,
  }))
}

async function claimDueSteps(
  transaction: ScopedTransaction,
  limit: number,
): Promise<ClaimedStepRow[]> {
  const result = await transaction.query<ClaimedStepRow>(`
    SELECT execution.id AS execution_id, execution.sop_instance_id AS instance_id,
      execution.status AS execution_status, execution.attempt_count,
      instance.context_snapshot, version.end_condition AS instance_end_condition,
      instance.current_step_order, instance.aggregate_version AS instance_version,
      step.id AS step_id, step.step_order, step.condition_snapshot,
      step.action_name, step.action_input, step.requested_role_code,
      step.assigned_employee_id, step.escalation_after_ms,
      step.escalation_role_code, step.escalation_employee_id,
      step.end_condition AS step_end_condition, step.max_attempts
    FROM mbox.sop_step_executions AS execution
    JOIN mbox.sop_instances AS instance
      ON instance.tenant_id = execution.tenant_id AND instance.store_id = execution.store_id
     AND instance.id = execution.sop_instance_id
    JOIN mbox.sop_rule_versions AS version
      ON version.tenant_id = instance.tenant_id AND version.store_id = instance.store_id
     AND version.id = instance.sop_rule_version_id
    JOIN mbox.sop_rule_steps AS step
      ON step.tenant_id = execution.tenant_id AND step.store_id = execution.store_id
     AND step.id = execution.sop_rule_step_id
    WHERE execution.tenant_id = $1::uuid AND execution.store_id = $2::uuid
      AND execution.status IN ('pending', 'waiting')
      AND execution.next_attempt_at <= clock_timestamp()
      AND instance.status = 'active'
      AND instance.current_step_order = step.step_order
    ORDER BY execution.next_attempt_at, execution.scheduled_at, execution.id
    FOR UPDATE OF execution, instance SKIP LOCKED
    LIMIT $3
  `, [transaction.scope.tenantId, transaction.scope.storeId, limit])
  return result.rows
}

async function processStep(
  transaction: ScopedTransaction,
  actions: SopActionPort,
  row: ClaimedStepRow,
  workerId: string,
  retryDelayMs: number,
): Promise<SopWorkerItemResult> {
  const phase = row.execution_status === 'waiting' ? 'escalation' : 'primary'
  const attempt = row.attempt_count + 1
  const marked = await transaction.query(`
    UPDATE mbox.sop_step_executions
    SET status = 'processing', attempt_count = $4,
        worker_locked_by = $5, worker_locked_at = clock_timestamp(),
        started_at = COALESCE(started_at, clock_timestamp())
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid
      AND id = $3::uuid AND status = $6
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    row.execution_id,
    attempt,
    workerId,
    row.execution_status,
  ])
  if (marked.rowCount !== 1) throw new Error(`Claimed SOP step could not be marked processing: ${row.execution_id}`)

  const instanceEnded = hasCondition(row.instance_end_condition)
    && matchesSopCondition(row.instance_end_condition, row.context_snapshot)
  if (instanceEnded || !matchesSopCondition(row.condition_snapshot, row.context_snapshot)) {
    return finishWithoutAction(
      transaction,
      row,
      workerId,
      instanceEnded ? 'instance_end_condition' : 'step_condition_not_met',
    )
  }

  try {
    const result = await actions.execute({
      transaction,
      instanceId: row.instance_id,
      executionId: row.execution_id,
      actionName: row.action_name,
      actionInput: row.action_input,
      context: row.context_snapshot,
      phase,
      assignment: phase === 'escalation'
        ? {
            requestedRoleCode: row.escalation_role_code ?? row.requested_role_code,
            assignedEmployeeId: row.escalation_employee_id ?? row.assigned_employee_id,
          }
        : {
            requestedRoleCode: row.requested_role_code,
            assignedEmployeeId: row.assigned_employee_id,
          },
      idempotencyKey: `sop:${row.execution_id}:${phase}`,
    })
    if (result.state === 'waiting') {
      const waitMs = row.escalation_after_ms === null ? retryDelayMs : Number(row.escalation_after_ms)
      await updateExecution(transaction, row.execution_id, 'waiting', {
        output: result.output ?? {},
        externalReference: result.externalReference,
        nextAttemptMs: waitMs,
        errorCode: null,
      })
      await appendEvidence(transaction, row, workerId, 'sop.step.waiting', {
        phase,
        externalReference: result.externalReference,
        nextAttemptMs: waitMs,
      })
      return { executionId: row.execution_id, instanceId: row.instance_id, outcome: 'waiting' }
    }

    await updateExecution(transaction, row.execution_id, 'completed', {
      output: result.output ?? {},
      externalReference: result.externalReference ?? null,
      errorCode: null,
    })
    const shouldEnd = hasCondition(row.step_end_condition) && matchesSopCondition(
      row.step_end_condition,
      { ...row.context_snapshot, actionResult: result.output ?? {} },
    )
    await advanceInstance(transaction, row, shouldEnd)
    await appendEvidence(transaction, row, workerId, 'sop.step.completed', {
      phase,
      externalReference: result.externalReference ?? null,
      endedInstance: shouldEnd,
    })
    return { executionId: row.execution_id, instanceId: row.instance_id, outcome: 'completed' }
  } catch (error) {
    const errorCode = safeErrorCode(error)
    if (attempt >= row.max_attempts) {
      await updateExecution(transaction, row.execution_id, 'failed', {
        output: {}, externalReference: null, errorCode,
      })
      await failInstance(transaction, row.instance_id)
      await appendEvidence(transaction, row, workerId, 'sop.step.failed', {
        phase, errorCode, attempt,
      })
      return { executionId: row.execution_id, instanceId: row.instance_id, outcome: 'failed' }
    }
    await updateExecution(transaction, row.execution_id, 'pending', {
      output: {}, externalReference: null, errorCode, nextAttemptMs: retryDelayMs,
    })
    await appendEvidence(transaction, row, workerId, 'sop.step.retry_scheduled', {
      phase, errorCode, attempt, nextAttemptMs: retryDelayMs,
    })
    return { executionId: row.execution_id, instanceId: row.instance_id, outcome: 'waiting' }
  }
}

async function finishWithoutAction(
  transaction: ScopedTransaction,
  row: ClaimedStepRow,
  workerId: string,
  reason: 'instance_end_condition' | 'step_condition_not_met',
): Promise<SopWorkerItemResult> {
  await updateExecution(transaction, row.execution_id, 'skipped', {
    output: { reason }, externalReference: null, errorCode: null,
  })
  await advanceInstance(transaction, row, reason === 'instance_end_condition')
  await appendEvidence(transaction, row, workerId, 'sop.step.skipped', { reason })
  return { executionId: row.execution_id, instanceId: row.instance_id, outcome: 'skipped' }
}

async function advanceInstance(
  transaction: ScopedTransaction,
  row: ClaimedStepRow,
  forceComplete: boolean,
): Promise<void> {
  const next = forceComplete ? undefined : (await transaction.query<NextStepRow>(`
    SELECT id, step_order, delay_ms
    FROM mbox.sop_rule_steps
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid
      AND sop_rule_version_id = (
        SELECT sop_rule_version_id FROM mbox.sop_instances
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      )
      AND step_order > $4
    ORDER BY step_order, id
    LIMIT 1
  `, [transaction.scope.tenantId, transaction.scope.storeId, row.instance_id, row.step_order])).rows[0]

  if (next === undefined) {
    const completed = await transaction.query(`
      UPDATE mbox.sop_instances
      SET status = 'completed', completed_at = clock_timestamp(),
          aggregate_version = aggregate_version + 1
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND id = $3::uuid AND status = 'active' AND current_step_order = $4
    `, [transaction.scope.tenantId, transaction.scope.storeId, row.instance_id, row.step_order])
    if (completed.rowCount !== 1) throw new Error(`SOP instance could not be completed: ${row.instance_id}`)
    return
  }

  const moved = await transaction.query(`
    UPDATE mbox.sop_instances
    SET current_step_order = $4, aggregate_version = aggregate_version + 1
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid
      AND id = $3::uuid AND status = 'active' AND current_step_order = $5
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    row.instance_id,
    next.step_order,
    row.step_order,
  ])
  if (moved.rowCount !== 1) throw new Error(`SOP instance could not advance: ${row.instance_id}`)
  const inserted = await transaction.query(`
    INSERT INTO mbox.sop_step_executions (
      tenant_id, store_id, sop_instance_id, sop_rule_step_id, scheduled_at, next_attempt_at
    ) VALUES (
      $1::uuid, $2::uuid, $3::uuid, $4::uuid,
      clock_timestamp() + ($5::bigint * interval '1 millisecond'),
      clock_timestamp() + ($5::bigint * interval '1 millisecond')
    )
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    row.instance_id,
    next.id,
    Number(next.delay_ms),
  ])
  if (inserted.rowCount !== 1) throw new Error(`Next SOP step could not be scheduled: ${next.id}`)
}

async function failInstance(transaction: ScopedTransaction, instanceId: string): Promise<void> {
  const result = await transaction.query(`
    UPDATE mbox.sop_instances
    SET status = 'failed', completed_at = clock_timestamp(), aggregate_version = aggregate_version + 1
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid
      AND id = $3::uuid AND status = 'active'
  `, [transaction.scope.tenantId, transaction.scope.storeId, instanceId])
  if (result.rowCount !== 1) throw new Error(`SOP instance could not be failed: ${instanceId}`)
}

async function updateExecution(
  transaction: ScopedTransaction,
  executionId: string,
  status: 'pending' | 'waiting' | 'completed' | 'skipped' | 'failed',
  input: {
    output: JsonObject
    externalReference: string | null
    errorCode: string | null
    nextAttemptMs?: number
  },
): Promise<void> {
  const terminal = ['completed', 'skipped', 'failed'].includes(status)
  const result = await transaction.query(`
    UPDATE mbox.sop_step_executions
    SET status = $4, output_snapshot = $5::jsonb, external_reference = $6,
        last_error_code = $7,
        next_attempt_at = CASE WHEN $8::bigint IS NULL THEN next_attempt_at
          ELSE clock_timestamp() + ($8::bigint * interval '1 millisecond') END,
        completed_at = CASE WHEN $9::boolean THEN clock_timestamp() ELSE NULL END,
        worker_locked_by = NULL, worker_locked_at = NULL
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid
      AND id = $3::uuid AND status = 'processing'
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    executionId,
    status,
    JSON.stringify(input.output),
    input.externalReference,
    input.errorCode,
    input.nextAttemptMs ?? null,
    terminal,
  ])
  if (result.rowCount !== 1) throw new Error(`SOP execution could not transition: ${executionId}`)
}

async function appendEvidence(
  transaction: ScopedTransaction,
  row: ClaimedStepRow,
  workerId: string,
  action: string,
  metadata: JsonObject,
): Promise<void> {
  const audit = await transaction.query(`
    INSERT INTO mbox.audit_events (
      tenant_id, store_id, actor_type, actor_ref, action,
      object_type, object_id, business_date, metadata
    ) SELECT $1::uuid, $2::uuid, 'system', $3, $4,
      'sop_step_execution', $5,
      (((clock_timestamp() AT TIME ZONE store.timezone) - store.business_day_cutoff)::date),
      $6::jsonb
    FROM mbox.stores AS store
    WHERE store.tenant_id = $1::uuid AND store.id = $2::uuid
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    workerId,
    action,
    row.execution_id,
    JSON.stringify(metadata),
  ])
  if (audit.rowCount !== 1) throw new Error(`SOP audit could not be appended: ${row.execution_id}`)
  const outbox = await transaction.query(`
    INSERT INTO mbox.outbox_messages (
      tenant_id, store_id, message_key, aggregate_type, aggregate_id,
      aggregate_version, message_type, payload
    ) VALUES ($1::uuid, $2::uuid, $3, 'sop_instance', $4::uuid, $5, $6, $7::jsonb)
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    `${action}:${row.execution_id}:${row.attempt_count + 1}`,
    row.instance_id,
    Number(row.instance_version) + 1,
    `${action}.v1`,
    JSON.stringify({
      instanceId: row.instance_id,
      executionId: row.execution_id,
      stepId: row.step_id,
      ...metadata,
    }),
  ])
  if (outbox.rowCount !== 1) throw new Error(`SOP outbox could not be appended: ${row.execution_id}`)
}

function safeErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error
    && typeof error.code === 'string' && /^[A-Z0-9_]{2,64}$/.test(error.code)) {
    return error.code
  }
  return 'ACTION_FAILED'
}

function hasCondition(value: JsonObject): boolean {
  return Object.keys(value).length > 0
}

function validateWorkerId(value: string): void {
  if (value.trim().length < 3 || value.length > 128) throw new TypeError('workerId is invalid')
}

function boundedInteger(value: number, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`${label} is invalid`)
  return value
}
