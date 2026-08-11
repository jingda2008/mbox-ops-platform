import type { JsonObject } from './command-executor.js'
import {
  ScopedPostgresTransactionRunner,
  type ScopedTransaction,
  type StoreScope,
} from './transaction-runner.js'
import type { ServiceTaskPriority, ServiceTaskStatus } from './service-task-repository.js'

interface DueTaskRow extends Record<string, unknown> {
  id: string
  status: ServiceTaskStatus
  priority: ServiceTaskPriority
  assigned_employee_id: string | null
  backup_employee_id: string | null
}

interface UpdatedTaskRow extends Record<string, unknown> {
  id: string
  status: ServiceTaskStatus
  priority: ServiceTaskPriority
  assigned_employee_id: string | null
  backup_employee_id: string | null
  next_action_at: string
}

export interface ServiceTaskSlaWorkerOptions {
  batchSize?: number
  retryDelayMs?: number
}

export interface ServiceTaskSlaResult {
  taskId: string
  action: 'backup_assigned' | 'escalated'
  status: ServiceTaskStatus
  priority: ServiceTaskPriority
  assignedEmployeeId: string | null
  nextActionAt: string
}

export interface ServiceTaskSlaBatch {
  workerId: string
  claimed: number
  processed: readonly ServiceTaskSlaResult[]
}

export class ServiceTaskSlaWorker {
  constructor(private readonly transactions: ScopedPostgresTransactionRunner) {}

  runBatch(
    scope: Readonly<StoreScope>,
    workerId: string,
    options: Readonly<ServiceTaskSlaWorkerOptions> = {},
  ): Promise<ServiceTaskSlaBatch> {
    validateWorkerId(workerId)
    const batchSize = validateBatchSize(options.batchSize ?? 50)
    const retryDelayMs = validateRetryDelay(options.retryDelayMs ?? 120_000)
    return this.transactions.run(scope, async (transaction) => {
      const due = await claimDueTasks(transaction, batchSize)
      const processed: ServiceTaskSlaResult[] = []
      for (const task of due) {
        processed.push(await processClaimedTask(transaction, task, workerId, retryDelayMs))
      }
      return { workerId, claimed: due.length, processed }
    })
  }
}

async function claimDueTasks(
  transaction: ScopedTransaction,
  batchSize: number,
): Promise<DueTaskRow[]> {
  const result = await transaction.query<DueTaskRow>(`
    SELECT task.id, task.status, task.priority, task.assigned_employee_id,
      CASE WHEN EXISTS (
        SELECT 1 FROM mbox.employees AS backup
        WHERE backup.tenant_id = task.tenant_id
          AND backup.store_id = task.store_id
          AND backup.id = task.backup_employee_id
          AND backup.status = 'active'
      ) THEN task.backup_employee_id ELSE NULL END AS backup_employee_id
    FROM mbox.service_tasks AS task
    WHERE task.tenant_id = $1::uuid
      AND task.store_id = $2::uuid
      AND task.status IN ('pending', 'acknowledged', 'in_progress')
      AND task.next_action_at <= clock_timestamp()
    ORDER BY
      CASE priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END DESC,
      task.next_action_at ASC,
      task.created_at ASC,
      task.id ASC
    FOR UPDATE SKIP LOCKED
    LIMIT $3
  `, [transaction.scope.tenantId, transaction.scope.storeId, batchSize])
  return result.rows
}

async function processClaimedTask(
  transaction: ScopedTransaction,
  task: DueTaskRow,
  workerId: string,
  retryDelayMs: number,
): Promise<ServiceTaskSlaResult> {
  const usesBackup = task.backup_employee_id !== null
    && task.backup_employee_id !== task.assigned_employee_id
  const nextPriority = usesBackup ? task.priority : escalatePriority(task.priority)
  const nextAssignedEmployeeId = usesBackup ? task.backup_employee_id : task.assigned_employee_id
  const eventType = usesBackup ? 'task.backup_assigned' : 'task.escalated'
  const updated = await transaction.query<UpdatedTaskRow>(`
    UPDATE mbox.service_tasks
    SET priority = $4,
        assigned_employee_id = $5::uuid,
        backup_employee_id = CASE WHEN $6::boolean THEN NULL ELSE backup_employee_id END,
        worker_locked_by = $7,
        worker_locked_at = clock_timestamp(),
        next_action_at = clock_timestamp() + ($8::bigint * interval '1 millisecond')
    WHERE tenant_id = $1::uuid
      AND store_id = $2::uuid
      AND id = $3::uuid
      AND status = $9
      AND next_action_at <= clock_timestamp()
    RETURNING id, status, priority, assigned_employee_id, backup_employee_id,
      next_action_at::text
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    task.id,
    nextPriority,
    nextAssignedEmployeeId,
    usesBackup,
    workerId,
    retryDelayMs,
    task.status,
  ])
  const row = updated.rows[0]
  if (updated.rowCount !== 1 || row === undefined) {
    throw new Error(`Claimed SLA task could not be updated: ${task.id}`)
  }

  const metadata: JsonObject = {
    workerId,
    previousPriority: task.priority,
    nextPriority: row.priority,
    previousAssignedEmployeeId: task.assigned_employee_id,
    assignedEmployeeId: row.assigned_employee_id,
    usedBackup: usesBackup,
  }
  const event = await transaction.query(`
    INSERT INTO mbox.service_task_events (
      tenant_id, store_id, service_task_id, event_type,
      from_status, to_status, actor_type, metadata
    ) VALUES (
      $1::uuid, $2::uuid, $3::uuid, $4,
      $5, $5, 'system', $6::jsonb
    )
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    task.id,
    eventType,
    task.status,
    JSON.stringify(metadata),
  ])
  if (event.rowCount !== 1) {
    throw new Error(`SLA event was not recorded for task: ${task.id}`)
  }

  const audit = await transaction.query(`
    INSERT INTO mbox.audit_events (
      tenant_id, store_id, actor_type, actor_ref, action,
      object_type, object_id, business_date, metadata
    )
    SELECT $1::uuid, $2::uuid, 'system', $3, $4,
      'service_task', $5,
      (
        (clock_timestamp() AT TIME ZONE store.timezone)
        - make_interval(secs => extract(epoch FROM store.business_day_cutoff))
      )::date,
      $6::jsonb
    FROM mbox.stores AS store
    WHERE store.tenant_id = $1::uuid AND store.id = $2::uuid
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    workerId,
    eventType,
    task.id,
    JSON.stringify(metadata),
  ])
  if (audit.rowCount !== 1) throw new Error(`SLA audit was not recorded for task: ${task.id}`)

  const outbox = await transaction.query(`
    INSERT INTO mbox.outbox_messages (
      tenant_id, store_id, message_key, aggregate_type, aggregate_id,
      aggregate_version, message_type, payload
    ) VALUES (
      $1::uuid, $2::uuid, $3, 'service_task', $4::uuid,
      1, $5, $6::jsonb
    )
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    `${eventType}:${task.id}:${row.next_action_at}`,
    task.id,
    `${eventType}.v1`,
    JSON.stringify({ taskId: task.id, ...metadata }),
  ])
  if (outbox.rowCount !== 1) throw new Error(`SLA outbox was not recorded for task: ${task.id}`)

  return {
    taskId: row.id,
    action: usesBackup ? 'backup_assigned' : 'escalated',
    status: row.status,
    priority: row.priority,
    assignedEmployeeId: row.assigned_employee_id,
    nextActionAt: row.next_action_at,
  }
}

function escalatePriority(priority: ServiceTaskPriority): ServiceTaskPriority {
  switch (priority) {
    case 'low': return 'normal'
    case 'normal': return 'high'
    case 'high':
    case 'urgent': return 'urgent'
  }
}

function validateWorkerId(workerId: string): void {
  if (workerId.trim().length < 3 || workerId.length > 128) {
    throw new TypeError('workerId must contain between 3 and 128 characters')
  }
}

function validateBatchSize(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 50) {
    throw new TypeError('batchSize must be an integer between 1 and 50')
  }
  return value
}

function validateRetryDelay(value: number): number {
  if (!Number.isInteger(value) || value < 1_000 || value > 24 * 60 * 60 * 1_000) {
    throw new TypeError('retryDelayMs must be between 1000 and 86400000 milliseconds')
  }
  return value
}
