import type { JsonObject } from './command-executor.js'
import type { ScopedTransaction } from './transaction-runner.js'
import type { FulfillmentStation, OrderItem } from './order-repository.js'
import {
  NormalizedKdsAuthorization,
  type KdsAuthorizationPort,
  type KdsEmployeeAction,
} from './kds-authorization-policy.js'

export type KdsStation = Exclude<FulfillmentStation, 'none'>
export type KdsStatus = 'pending' | 'accepted' | 'preparing' | 'ready' | 'cancelled' | 'failed'

export interface KdsTask {
  id: string
  orderItemId: string
  stationCode: KdsStation
  status: KdsStatus
  priority: number
  quantity: number
  assignedEmployeeId: string | null
  dueAt: string | null
  nextActionAt: string
  acceptedAt: string | null
  readyAt: string | null
  cancelledAt: string | null
}

export interface CreateKdsTaskInput {
  orderItemId: string
  stationCode: KdsStation
  quantity: number
  priority?: number
  dueAt?: string | null
  eventIdempotencyKey?: string | null
}

export interface KdsTransitionInput {
  taskId: string
  actorEmployeeId: string
  eventIdempotencyKey?: string | null
  metadata?: JsonObject
}

export interface ClaimPendingKdsInput {
  stationCode: KdsStation
  actorEmployeeId: string
  workerId: string
  limit?: number
}

interface KdsTaskRow extends Record<string, unknown> {
  id: string
  order_item_id: string
  station_code: KdsStation
  status: KdsStatus
  priority: number
  quantity: number
  assigned_employee_id: string | null
  due_at: string | null
  next_action_at: string
  accepted_at: string | null
  ready_at: string | null
  cancelled_at: string | null
  previous_status?: KdsStatus
}

interface ClaimedKdsRow extends KdsTaskRow {
  previous_status: 'pending'
}

const TASK_COLUMNS = `
  id, order_item_id, station_code, status, priority, quantity,
  assigned_employee_id, due_at, next_action_at::text,
  accepted_at::text, ready_at::text, cancelled_at::text
`

const TRANSITIONS: Readonly<Record<KdsStatus, readonly KdsStatus[]>> = {
  pending: ['accepted', 'cancelled', 'failed'],
  accepted: ['preparing', 'cancelled', 'failed'],
  preparing: ['ready', 'cancelled', 'failed'],
  ready: [],
  cancelled: [],
  failed: [],
}

export class KdsTransitionError extends Error {
  constructor(taskId: string, targetStatus: KdsStatus) {
    super(`KDS task cannot transition to ${targetStatus}: ${taskId}`)
    this.name = 'KdsTransitionError'
  }
}

export class KdsRepository {
  constructor(
    private readonly transaction: ScopedTransaction,
    private readonly authorization: KdsAuthorizationPort = new NormalizedKdsAuthorization(),
  ) {}

  async createForOrderItems(
    orderItems: readonly OrderItem[],
    options: Readonly<{ priority?: number; dueAt?: string | null }> = {},
  ): Promise<KdsTask[]> {
    const tasks: KdsTask[] = []
    for (const item of orderItems) {
      if (item.fulfillmentStation === 'none') continue
      tasks.push(await this.create({
        orderItemId: item.id,
        stationCode: item.fulfillmentStation,
        quantity: item.quantity,
        priority: options.priority,
        dueAt: options.dueAt,
        eventIdempotencyKey: `created:${item.id}:${item.fulfillmentStation}`,
      }))
    }
    return tasks
  }

  async create(input: Readonly<CreateKdsTaskInput>): Promise<KdsTask> {
    validateCreate(input)
    const inserted = await this.transaction.query<KdsTaskRow>(`
      INSERT INTO mbox.kds_tasks (
        tenant_id, store_id, order_item_id, station_code,
        status, priority, quantity, due_at, next_action_at
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4,
        'pending', $5, $6, $7::timestamptz, clock_timestamp()
      )
      RETURNING ${TASK_COLUMNS}
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.orderItemId,
      input.stationCode,
      input.priority ?? 100,
      input.quantity,
      input.dueAt ?? null,
    ])
    const row = requireOne(inserted, 'KDS task insert')
    await this.appendEvent({
      taskId: row.id,
      eventType: 'task.created',
      fromStatus: null,
      toStatus: 'pending',
      actorEmployeeId: null,
      idempotencyKey: input.eventIdempotencyKey ?? null,
      metadata: { orderItemId: row.order_item_id, stationCode: row.station_code },
    })
    return mapTask(row)
  }

  accept(input: Readonly<KdsTransitionInput>): Promise<KdsTask> {
    return this.transition(input, 'accepted', ['pending'])
  }

  startPreparing(input: Readonly<KdsTransitionInput>): Promise<KdsTask> {
    return this.transition(input, 'preparing', ['accepted'])
  }

  markReady(input: Readonly<KdsTransitionInput>): Promise<KdsTask> {
    return this.transition(input, 'ready', ['preparing'])
  }

  cancel(input: Readonly<KdsTransitionInput>): Promise<KdsTask> {
    return this.transition(input, 'cancelled', ['pending', 'accepted', 'preparing'])
  }

  fail(input: Readonly<KdsTransitionInput>): Promise<KdsTask> {
    return this.transition(input, 'failed', ['pending', 'accepted', 'preparing'])
  }

  async claimPending(input: Readonly<ClaimPendingKdsInput>): Promise<KdsTask[]> {
    validateClaim(input)
    await this.assertCanPrepare(input.actorEmployeeId, 'claim')
    const limit = input.limit ?? 50
    const claimed = await this.transaction.query<ClaimedKdsRow>(`
      WITH candidates AS (
        SELECT task.id, task.status AS previous_status
        FROM mbox.kds_tasks AS task
        WHERE task.tenant_id = $1::uuid
          AND task.store_id = $2::uuid
          AND task.station_code = $3
          AND task.status = 'pending'
          AND (task.assigned_employee_id IS NULL OR task.assigned_employee_id = $5::uuid)
          AND task.next_action_at <= clock_timestamp()
        ORDER BY task.priority DESC, task.next_action_at, task.created_at, task.id
        FOR UPDATE OF task SKIP LOCKED
        LIMIT $4
      ), updated AS (
        UPDATE mbox.kds_tasks AS task
        SET status = 'accepted',
            assigned_employee_id = $5::uuid,
            worker_locked_by = $6,
            worker_locked_at = clock_timestamp(),
            accepted_at = COALESCE(task.accepted_at, clock_timestamp()),
            updated_at = clock_timestamp()
        FROM candidates
        WHERE task.tenant_id = $1::uuid
          AND task.store_id = $2::uuid
          AND task.id = candidates.id
          AND task.status = candidates.previous_status
        RETURNING ${TASK_COLUMNS.replaceAll(/\bid\b/g, 'task.id')}, candidates.previous_status
      )
      SELECT * FROM updated
      ORDER BY priority DESC, next_action_at, id
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.stationCode,
      limit,
      input.actorEmployeeId,
      input.workerId,
    ])
    for (const row of claimed.rows) {
      await this.appendEvent({
        taskId: row.id,
        eventType: 'task.accepted',
        fromStatus: row.previous_status,
        toStatus: 'accepted',
        actorEmployeeId: input.actorEmployeeId,
        idempotencyKey: `claim:${input.workerId}:${row.id}`,
        metadata: { workerId: input.workerId, stationCode: input.stationCode },
      })
    }
    return claimed.rows.map(mapTask)
  }

  private async transition(
    input: Readonly<KdsTransitionInput>,
    targetStatus: KdsStatus,
    allowedFrom: readonly KdsStatus[],
  ): Promise<KdsTask> {
    validateTransition(input)
    for (const status of allowedFrom) {
      if (!TRANSITIONS[status].includes(targetStatus)) {
        throw new TypeError(`Invalid KDS transition definition: ${status} -> ${targetStatus}`)
      }
    }
    await this.assertCanPrepare(input.actorEmployeeId, actionForTargetStatus(targetStatus))
    const updated = await this.transaction.query<KdsTaskRow>(`
      WITH candidate AS (
        SELECT task.id, task.status AS previous_status
        FROM mbox.kds_tasks AS task
        WHERE task.tenant_id = $1::uuid
          AND task.store_id = $2::uuid
          AND task.id = $3::uuid
          AND task.status = ANY($6::text[])
          AND (task.assigned_employee_id IS NULL OR task.assigned_employee_id = $5::uuid)
        FOR UPDATE OF task
      ), updated AS (
        UPDATE mbox.kds_tasks AS task
        SET status = $4,
            assigned_employee_id = COALESCE(task.assigned_employee_id, $5::uuid),
            accepted_at = CASE
              WHEN $4 = 'accepted' THEN COALESCE(task.accepted_at, clock_timestamp())
              ELSE task.accepted_at
            END,
            ready_at = CASE WHEN $4 = 'ready' THEN clock_timestamp() ELSE task.ready_at END,
            cancelled_at = CASE WHEN $4 = 'cancelled' THEN clock_timestamp() ELSE task.cancelled_at END,
            updated_at = clock_timestamp()
        FROM candidate
        WHERE task.tenant_id = $1::uuid
          AND task.store_id = $2::uuid
          AND task.id = candidate.id
          AND task.status = candidate.previous_status
        RETURNING ${TASK_COLUMNS.replaceAll(/\bid\b/g, 'task.id')}, candidate.previous_status
      )
      SELECT * FROM updated
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.taskId,
      targetStatus,
      input.actorEmployeeId,
      [...allowedFrom],
    ])
    const row = updated.rows[0]
    if (updated.rowCount !== 1 || row === undefined || !row.previous_status) {
      throw new KdsTransitionError(input.taskId, targetStatus)
    }
    await this.appendEvent({
      taskId: row.id,
      eventType: `task.${targetStatus}`,
      fromStatus: row.previous_status,
      toStatus: targetStatus,
      actorEmployeeId: input.actorEmployeeId,
      idempotencyKey: input.eventIdempotencyKey ?? null,
      metadata: input.metadata ?? {},
    })
    return mapTask(row)
  }

  private assertCanPrepare(employeeId: string, action: KdsEmployeeAction): Promise<void> {
    return this.authorization.assertCanPrepare({
      transaction: this.transaction,
      employeeId,
      action,
    })
  }

  private async appendEvent(input: {
    taskId: string
    eventType: string
    fromStatus: KdsStatus | null
    toStatus: KdsStatus
    actorEmployeeId: string | null
    idempotencyKey: string | null
    metadata: JsonObject
  }): Promise<void> {
    const inserted = await this.transaction.query(`
      INSERT INTO mbox.kds_task_events (
        tenant_id, store_id, kds_task_id, event_type,
        from_status, to_status, actor_employee_id, metadata, idempotency_key
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4,
        $5, $6, $7::uuid, $8::jsonb, $9
      )
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.taskId,
      input.eventType,
      input.fromStatus,
      input.toStatus,
      input.actorEmployeeId,
      JSON.stringify(input.metadata),
      input.idempotencyKey,
    ])
    if (inserted.rowCount !== 1) throw new Error(`KDS event was not recorded: ${input.taskId}`)
  }
}

function actionForTargetStatus(targetStatus: KdsStatus): KdsEmployeeAction {
  switch (targetStatus) {
    case 'accepted': return 'accept'
    case 'preparing': return 'start'
    case 'ready': return 'complete'
    case 'cancelled': return 'cancel'
    case 'failed': return 'fail'
    case 'pending': throw new TypeError('Pending is not an employee KDS transition target')
  }
}

function validateCreate(input: Readonly<CreateKdsTaskInput>): void {
  requireUuid('orderItemId', input.orderItemId)
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 999) {
    throw new TypeError('quantity must be an integer between 1 and 999')
  }
  const priority = input.priority ?? 100
  if (!Number.isInteger(priority) || priority < 0 || priority > 1000) {
    throw new TypeError('priority must be an integer between 0 and 1000')
  }
}

function validateTransition(input: Readonly<KdsTransitionInput>): void {
  requireUuid('taskId', input.taskId)
  requireUuid('actorEmployeeId', input.actorEmployeeId)
}

function validateClaim(input: Readonly<ClaimPendingKdsInput>): void {
  requireUuid('actorEmployeeId', input.actorEmployeeId)
  if (input.workerId.trim().length < 3 || input.workerId.length > 128) {
    throw new TypeError('workerId must contain between 3 and 128 characters')
  }
  const limit = input.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new TypeError('limit must be an integer between 1 and 50')
  }
}

function requireUuid(name: string, value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError(`${name} must be a UUID`)
  }
}

function requireOne<Row extends Record<string, unknown>>(
  result: { rows: Row[]; rowCount: number | null },
  operation: string,
): Row {
  const row = result.rows[0]
  if (result.rowCount !== 1 || row === undefined) throw new Error(`${operation} did not affect exactly one row`)
  return row
}

function mapTask(row: KdsTaskRow): KdsTask {
  return {
    id: row.id,
    orderItemId: row.order_item_id,
    stationCode: row.station_code,
    status: row.status,
    priority: row.priority,
    quantity: row.quantity,
    assignedEmployeeId: row.assigned_employee_id,
    dueAt: row.due_at,
    nextActionAt: row.next_action_at,
    acceptedAt: row.accepted_at,
    readyAt: row.ready_at,
    cancelledAt: row.cancelled_at,
  }
}
