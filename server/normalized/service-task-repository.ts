import type { JsonObject } from './command-executor.js'
import type { ScopedTransaction } from './transaction-runner.js'

export type ServiceTaskStatus =
  | 'pending'
  | 'acknowledged'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'expired'

export type ServiceTaskPriority = 'low' | 'normal' | 'high' | 'urgent'
export type ServiceTaskSource = 'guest' | 'employee' | 'sop' | 'ai' | 'system'
export type TaskActor =
  | { readonly type: 'employee'; readonly employeeId: string }
  | { readonly type: 'guest' | 'system' | 'integration'; readonly employeeId?: never }

export interface ServiceTask {
  id: string
  tableId: string
  tableSessionId: string
  publicId: string
  taskType: string
  title: string
  detail: string | null
  priority: ServiceTaskPriority
  status: ServiceTaskStatus
  source: ServiceTaskSource
  requestedRoleCode: string | null
  assignedEmployeeId: string | null
  backupEmployeeId: string | null
  requestCount: number
  requestSnapshot: JsonObject
  dueAt: string | null
  escalateAt: string | null
  nextActionAt: string
  acknowledgedAt: string | null
  completedAt: string | null
  cancelledAt: string | null
  createdAt: string
  updatedAt: string
}

interface ServiceTaskRow extends Record<string, unknown> {
  id: string
  table_id: string
  table_session_id: string
  public_id: string
  task_type: string
  title: string
  detail: string | null
  priority: ServiceTaskPriority
  status: ServiceTaskStatus
  source: ServiceTaskSource
  requested_role_code: string | null
  assigned_employee_id: string | null
  backup_employee_id: string | null
  request_count: number
  request_snapshot: JsonObject
  due_at: string | null
  escalate_at: string | null
  next_action_at: string
  acknowledged_at: string | null
  completed_at: string | null
  cancelled_at: string | null
  created_at: string
  updated_at: string
  previous_status?: ServiceTaskStatus
}

export interface CreateServiceTaskInput {
  tableId: string
  tableSessionId: string
  publicId: string
  taskType: string
  title: string
  detail?: string | null
  priority?: ServiceTaskPriority
  source: ServiceTaskSource
  requestedRoleCode?: string | null
  assignedEmployeeId?: string | null
  backupEmployeeId?: string | null
  createdByEmployeeId?: string | null
  requestCount?: number
  requestSnapshot?: JsonObject
  dueAt?: string | null
  escalateAt?: string | null
  nextActionAt?: string | null
  actor: TaskActor
  eventIdempotencyKey?: string | null
}

export interface TaskQueueQuery {
  employeeId: string
  roleCodes: readonly string[]
  limit?: number
}

interface TransitionInput {
  taskId: string
  actor: TaskActor
  note?: string | null
  eventIdempotencyKey?: string | null
}

const ACTIVE_STATUSES: readonly ServiceTaskStatus[] = ['pending', 'acknowledged', 'in_progress']

const ALLOWED_TRANSITIONS: Readonly<Record<ServiceTaskStatus, readonly ServiceTaskStatus[]>> = {
  pending: ['acknowledged', 'in_progress', 'completed', 'cancelled', 'expired'],
  acknowledged: ['in_progress', 'completed', 'cancelled', 'expired'],
  in_progress: ['completed', 'cancelled', 'expired'],
  completed: [],
  cancelled: [],
  expired: [],
}

export class ServiceTaskNotFoundError extends Error {
  constructor(id: string) {
    super(`Service task was not found: ${id}`)
    this.name = 'ServiceTaskNotFoundError'
  }
}

export class ServiceTaskTransitionError extends Error {
  constructor(id: string, target: ServiceTaskStatus) {
    super(`Service task ${id} cannot transition to ${target} from its current status`)
    this.name = 'ServiceTaskTransitionError'
  }
}

export class ServiceTaskSessionMismatchError extends Error {
  constructor(tableId: string, tableSessionId: string) {
    super(`Active table session ${tableSessionId} does not belong to table ${tableId}`)
    this.name = 'ServiceTaskSessionMismatchError'
  }
}

export class ServiceTaskRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async create(input: Readonly<CreateServiceTaskInput>): Promise<ServiceTask> {
    validateCreateInput(input)
    const inserted = await this.transaction.query<ServiceTaskRow>(`
      INSERT INTO mbox.service_tasks (
        tenant_id, store_id, table_id, table_session_id, public_id,
        task_type, title, detail, priority, status, source,
        requested_role_code, assigned_employee_id, backup_employee_id,
        created_by_employee_id, request_count, request_snapshot,
        due_at, escalate_at, next_action_at
      ) SELECT
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5,
        $6, $7, $8, $9, 'pending', $10,
        $11, $12::uuid, $13::uuid, $14::uuid, $15, $16::jsonb,
        $17::timestamptz, $18::timestamptz,
        COALESCE($19::timestamptz, clock_timestamp())
      FROM mbox.table_sessions session
      WHERE session.tenant_id = $1::uuid
        AND session.store_id = $2::uuid
        AND session.id = $4::uuid
        AND session.table_id = $3::uuid
        AND session.status IN ('open', 'closing')
      RETURNING ${TASK_COLUMNS}
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.tableId,
      input.tableSessionId,
      input.publicId,
      input.taskType,
      input.title,
      input.detail ?? null,
      input.priority ?? 'normal',
      input.source,
      input.requestedRoleCode ?? null,
      input.assignedEmployeeId ?? null,
      input.backupEmployeeId ?? null,
      input.createdByEmployeeId ?? null,
      input.requestCount ?? 1,
      JSON.stringify(input.requestSnapshot ?? {}),
      input.dueAt ?? null,
      input.escalateAt ?? null,
      input.nextActionAt ?? null,
    ])
    const row = inserted.rows[0]
    if (inserted.rowCount !== 1 || row === undefined) {
      throw new ServiceTaskSessionMismatchError(input.tableId, input.tableSessionId)
    }
    await this.appendEvent({
      taskId: row.id,
      eventType: 'task.created',
      fromStatus: null,
      toStatus: 'pending',
      actor: input.actor,
      idempotencyKey: input.eventIdempotencyKey ?? null,
      metadata: { source: input.source },
    })
    return mapTask(row)
  }

  async findById(id: string): Promise<ServiceTask | null> {
    const result = await this.transaction.query<ServiceTaskRow>(`
      SELECT ${TASK_COLUMNS}
      FROM mbox.service_tasks
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND id = $3::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, id])
    return result.rows[0] === undefined ? null : mapTask(result.rows[0])
  }

  async findActiveByTableSession(tableSessionId: string): Promise<ServiceTask[]> {
    const result = await this.transaction.query<ServiceTaskRow>(`
      SELECT ${TASK_COLUMNS}
      FROM mbox.service_tasks
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND table_session_id = $3::uuid
        AND status = ANY($4::text[])
      ORDER BY
        CASE priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END DESC,
        created_at ASC,
        id ASC
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      tableSessionId,
      ACTIVE_STATUSES,
    ])
    return result.rows.map(mapTask)
  }

  async findQueueForEmployee(input: Readonly<TaskQueueQuery>): Promise<ServiceTask[]> {
    const limit = validateLimit(input.limit ?? 100, 200)
    const result = await this.transaction.query<ServiceTaskRow>(`
      SELECT ${TASK_COLUMNS}
      FROM mbox.service_tasks
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND status = ANY($3::text[])
        AND (
          assigned_employee_id = $4::uuid
          OR backup_employee_id = $4::uuid
          OR (
            assigned_employee_id IS NULL
            AND requested_role_code = ANY($5::text[])
          )
        )
      ORDER BY
        CASE priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END DESC,
        COALESCE(due_at, next_action_at) ASC,
        created_at ASC,
        id ASC
      LIMIT $6
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      ACTIVE_STATUSES,
      input.employeeId,
      [...input.roleCodes],
      limit,
    ])
    return result.rows.map(mapTask)
  }

  acknowledge(input: Readonly<TransitionInput>): Promise<ServiceTask> {
    return this.transition(input, 'acknowledged', ['pending'])
  }

  start(input: Readonly<TransitionInput>): Promise<ServiceTask> {
    return this.transition(input, 'in_progress', ['pending', 'acknowledged'])
  }

  complete(input: Readonly<TransitionInput>): Promise<ServiceTask> {
    return this.transition(input, 'completed', ['pending', 'acknowledged', 'in_progress'])
  }

  cancel(input: Readonly<TransitionInput>): Promise<ServiceTask> {
    return this.transition(input, 'cancelled', ['pending', 'acknowledged', 'in_progress'])
  }

  private async transition(
    input: Readonly<TransitionInput>,
    targetStatus: ServiceTaskStatus,
    allowedFrom: readonly ServiceTaskStatus[],
  ): Promise<ServiceTask> {
    for (const from of allowedFrom) {
      if (!ALLOWED_TRANSITIONS[from].includes(targetStatus)) {
        throw new TypeError(`Invalid repository transition definition: ${from} -> ${targetStatus}`)
      }
    }
    const employeeId = input.actor.type === 'employee' ? input.actor.employeeId : null
    const updated = await this.transaction.query<ServiceTaskRow>(`
      WITH candidate AS (
        SELECT id, status AS previous_status
        FROM mbox.service_tasks
        WHERE tenant_id = $1::uuid
          AND store_id = $2::uuid
          AND id = $3::uuid
          AND status = ANY($6::text[])
        FOR UPDATE
      ), updated AS (
      UPDATE mbox.service_tasks AS task
      SET status = $4,
          assigned_employee_id = CASE
            WHEN $5::uuid IS NOT NULL THEN COALESCE(assigned_employee_id, $5::uuid)
            ELSE assigned_employee_id
          END,
          acknowledged_at = CASE
            WHEN $4 IN ('acknowledged', 'in_progress', 'completed')
              THEN COALESCE(acknowledged_at, clock_timestamp())
            ELSE acknowledged_at
          END,
          completed_at = CASE WHEN $4 = 'completed' THEN clock_timestamp() ELSE completed_at END,
          cancelled_at = CASE WHEN $4 = 'cancelled' THEN clock_timestamp() ELSE cancelled_at END
      FROM candidate
      WHERE task.tenant_id = $1::uuid
        AND task.store_id = $2::uuid
        AND task.id = candidate.id
      RETURNING ${TASK_COLUMNS_PREFIXED}, candidate.previous_status
      )
      SELECT * FROM updated
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.taskId,
      targetStatus,
      employeeId,
      [...allowedFrom],
    ])
    const row = updated.rows[0]
    if (updated.rowCount !== 1 || row === undefined) {
      throw new ServiceTaskTransitionError(input.taskId, targetStatus)
    }
    const previousStatus = row.previous_status
    if (row.status !== targetStatus || previousStatus === undefined
      || !allowedFrom.includes(previousStatus)) {
      throw new Error(`Database returned an invalid service task transition for ${row.id}`)
    }
    await this.appendEvent({
      taskId: row.id,
      eventType: `task.${targetStatus}`,
      fromStatus: previousStatus,
      toStatus: targetStatus,
      actor: input.actor,
      note: input.note ?? null,
      idempotencyKey: input.eventIdempotencyKey ?? null,
      metadata: {},
    })
    return mapTask(row)
  }

  private async appendEvent(input: {
    taskId: string
    eventType: string
    fromStatus: ServiceTaskStatus | null
    toStatus: ServiceTaskStatus
    actor: TaskActor
    note?: string | null
    idempotencyKey: string | null
    metadata: JsonObject
  }): Promise<void> {
    const inserted = await this.transaction.query(`
      INSERT INTO mbox.service_task_events (
        tenant_id, store_id, service_task_id, event_type,
        from_status, to_status, actor_type, actor_employee_id,
        note, metadata, idempotency_key
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4,
        $5, $6, $7, $8::uuid, $9, $10::jsonb, $11
      )
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.taskId,
      input.eventType,
      input.fromStatus,
      input.toStatus,
      input.actor.type,
      input.actor.type === 'employee' ? input.actor.employeeId : null,
      input.note ?? null,
      JSON.stringify(input.metadata),
      input.idempotencyKey,
    ])
    if (inserted.rowCount !== 1) {
      throw new Error('Service task event insert did not affect exactly one row')
    }
  }
}

const TASK_COLUMNS = `
  id, table_id, table_session_id, public_id, task_type, title, detail,
  priority, status, source, requested_role_code, assigned_employee_id,
  backup_employee_id, request_count, request_snapshot,
  due_at::text, escalate_at::text, next_action_at::text,
  acknowledged_at::text, completed_at::text, cancelled_at::text,
  created_at::text, updated_at::text
`

const TASK_COLUMNS_PREFIXED = `
  task.id, task.table_id, task.table_session_id, task.public_id,
  task.task_type, task.title, task.detail, task.priority, task.status,
  task.source, task.requested_role_code, task.assigned_employee_id,
  task.backup_employee_id, task.request_count, task.request_snapshot,
  task.due_at::text, task.escalate_at::text, task.next_action_at::text,
  task.acknowledged_at::text, task.completed_at::text, task.cancelled_at::text,
  task.created_at::text, task.updated_at::text
`

function mapTask(row: ServiceTaskRow): ServiceTask {
  return {
    id: row.id,
    tableId: row.table_id,
    tableSessionId: row.table_session_id,
    publicId: row.public_id,
    taskType: row.task_type,
    title: row.title,
    detail: row.detail,
    priority: row.priority,
    status: row.status,
    source: row.source,
    requestedRoleCode: row.requested_role_code,
    assignedEmployeeId: row.assigned_employee_id,
    backupEmployeeId: row.backup_employee_id,
    requestCount: row.request_count,
    requestSnapshot: row.request_snapshot,
    dueAt: row.due_at,
    escalateAt: row.escalate_at,
    nextActionAt: row.next_action_at,
    acknowledgedAt: row.acknowledged_at,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function validateCreateInput(input: Readonly<CreateServiceTaskInput>): void {
  if (input.publicId.length < 8 || input.publicId.length > 128) {
    throw new TypeError('publicId must contain between 8 and 128 characters')
  }
  if (!/^[a-z][a-z0-9_.-]{1,63}$/.test(input.taskType)) {
    throw new TypeError('taskType has an invalid format')
  }
  if (input.title.trim().length === 0) throw new TypeError('title must not be blank')
  const count = input.requestCount ?? 1
  if (!Number.isInteger(count) || count < 1) throw new TypeError('requestCount must be a positive integer')
}

function validateLimit(value: number, maximum: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`limit must be an integer between 1 and ${maximum}`)
  }
  return value
}
