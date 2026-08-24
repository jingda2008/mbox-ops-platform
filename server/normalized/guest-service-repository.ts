import { createHash, randomUUID } from 'node:crypto'
import type { JsonObject } from './command-executor.js'
import { hashGuestBehaviorPrincipal } from './guest-behavior-repository.js'
import {
  ServiceTaskRepository,
  type ServiceTask,
} from './service-task-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'
import { lockBoundGuestTablePosition } from './guest-table-authority.js'

export type GuestServiceRequestType = 'call_staff' | 'complaint' | 'custom'
export type GuestServiceWorkflow = 'visible_then_complete' | 'manager_attention'

export interface GuestServiceRequestInput {
  tableSessionId: string
  customerId: string
  actorRef: string
  deviceFingerprint: string
  requestType: GuestServiceRequestType
  detail?: string | null
  relatedOrderPublicId?: string | null
}

export interface GuestServiceRequestAccepted {
  status: 'created' | 'merged'
  groupId: string
  requestCount: number
  task: ServiceTask
  workflow: GuestServiceWorkflow
}

export interface GuestServiceRequestRateLimited {
  status: 'rate_limited'
  dimension: 'table' | 'device'
  retryAt: string
}

export type GuestServiceRequestResult =
  | GuestServiceRequestAccepted
  | GuestServiceRequestRateLimited

export type GuestServiceFeedbackAction = 'confirm' | 'escalate'

export interface GuestServiceRequestView {
  publicId: string
  requestType: GuestServiceRequestType
  status: ServiceTask['status']
  publicServiceName: string | null
  requestCount: number
  createdAt: string
}

export interface GuestServiceFeedbackResult {
  taskId: string
  publicId: string
  action: GuestServiceFeedbackAction
  taskStatus: ServiceTask['status']
  changed: boolean
  occurredAt: string
}

export interface GuestServiceRepositoryOptions {
  deviceLimitPerMinute?: number
  tableLimitPerMinute?: number
  createPublicId?: () => string
  createServiceTaskRepository?: (transaction: ScopedTransaction) => Pick<
    ServiceTaskRepository,
    'create' | 'findById'
  >
}

interface TableContextRow extends Record<string, unknown> {
  table_id: string
  is_member: boolean
}

interface RateLimitRow extends Record<string, unknown> {
  request_count: number
  expires_at: string
}

interface RequestGroupRow extends Record<string, unknown> {
  id: string
  current_service_task_id: string | null
  request_count: number
}

interface GuestServiceViewRow extends Record<string, unknown> {
  public_id: string
  request_type: GuestServiceRequestType
  status: ServiceTask['status']
  public_service_name: string | null
  request_count: number
  created_at: string
}

interface FeedbackTaskRow extends Record<string, unknown> {
  task_id: string
  public_id: string
  request_group_id: string
  status: ServiceTask['status']
  priority: ServiceTask['priority']
}

interface FeedbackEventRow extends Record<string, unknown> {
  occurred_at: string
}

const ACTIVE_TASK_STATUSES = new Set(['pending', 'acknowledged', 'in_progress'])

export class GuestServiceSessionUnavailableError extends Error {
  constructor() {
    super('当前桌次已经结束，请重新扫描桌面二维码')
    this.name = 'GuestServiceSessionUnavailableError'
  }
}

export class GuestServiceRequestNotFoundError extends Error {
  constructor() {
    super('没有找到这项服务请求')
    this.name = 'GuestServiceRequestNotFoundError'
  }
}

export class GuestServiceFeedbackStateError extends Error {
  constructor(action: GuestServiceFeedbackAction) {
    super(action === 'confirm'
      ? '服务完成后才能确认结果'
      : '当前服务状态不能再次催办')
    this.name = 'GuestServiceFeedbackStateError'
  }
}

export class GuestServiceRepository {
  private readonly deviceLimitPerMinute: number
  private readonly tableLimitPerMinute: number
  private readonly createPublicId: () => string
  private readonly createTasks: GuestServiceRepositoryOptions['createServiceTaskRepository']

  constructor(
    private readonly transaction: ScopedTransaction,
    options: Readonly<GuestServiceRepositoryOptions> = {},
  ) {
    this.deviceLimitPerMinute = validateLimit(options.deviceLimitPerMinute ?? 5, 'deviceLimitPerMinute')
    this.tableLimitPerMinute = validateLimit(options.tableLimitPerMinute ?? 20, 'tableLimitPerMinute')
    this.createPublicId = options.createPublicId ?? randomUUID
    this.createTasks = options.createServiceTaskRepository
      ?? ((transaction) => new ServiceTaskRepository(transaction))
  }

  async request(input: Readonly<GuestServiceRequestInput>): Promise<GuestServiceRequestResult> {
    const detail = validateRequest(input)
    const tableId = await this.requireOpenTableMembership(
      input.tableSessionId,input.customerId,true,input.actorRef,
    )
    const relatedOrderId = await this.resolveRelatedOrderId(
      input.tableSessionId,
      input.requestType,
      input.relatedOrderPublicId ?? null,
    )
    const tableLimit = await this.consumeRateLimit(
      'table',
      hashGuestBehaviorPrincipal(`table:${input.tableSessionId}`),
      this.tableLimitPerMinute,
    )
    if (tableLimit !== null) return tableLimit
    const deviceLimit = await this.consumeRateLimit(
      'device',
      hashGuestBehaviorPrincipal(input.deviceFingerprint),
      this.deviceLimitPerMinute,
    )
    if (deviceLimit !== null) return deviceLimit

    const mergeKey = serviceMergeKey(input.requestType, detail, relatedOrderId)
    await this.transaction.query(`
      INSERT INTO mbox.guest_service_request_groups (
        tenant_id, store_id, table_session_id, customer_id, request_type, merge_key,
        related_order_id
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::uuid)
      ON CONFLICT (
        tenant_id, store_id, table_session_id, merge_key
      ) DO NOTHING
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.tableSessionId,
      input.customerId,
      input.requestType,
      mergeKey,
      relatedOrderId,
    ])
    const group = await this.lockGroup(input, mergeKey)
    const tasks = this.createTasks!(this.transaction)
    if (group.current_service_task_id !== null) {
      const current = await tasks.findById(group.current_service_task_id)
      if (current !== null && ACTIVE_TASK_STATUSES.has(current.status)) {
        const count = await this.markRequested(group.id, input.deviceFingerprint, false)
        return {
          status: 'merged',
          groupId: group.id,
          requestCount: count,
          task: current,
          workflow: workflowFor(input.requestType),
        }
      }
    }

    const presentation = taskPresentation(input.requestType, detail)
    const task = await tasks.create({
      tableId,
      tableSessionId: input.tableSessionId,
      publicId: this.createPublicId(),
      taskType: `guest.${input.requestType}`,
      title: presentation.title,
      detail,
      priority: presentation.priority,
      source: 'guest',
      requestedRoleCode: presentation.requestedRoleCode,
      requestSnapshot: {
        requestGroupId: group.id,
        interactionMode: workflowFor(input.requestType),
        attentionRequired: input.requestType === 'complaint',
      },
      actor: { type: 'guest' },
      eventIdempotencyKey: `guest-created:${group.id}:${group.request_count + 1}`,
    })
    const count = await this.markRequested(group.id, input.deviceFingerprint, true, task.id)
    return {
      status: 'created',
      groupId: group.id,
      requestCount: count,
      task,
      workflow: workflowFor(input.requestType),
    }
  }

  async listOwned(tableSessionId: string, customerId: string): Promise<GuestServiceRequestView[]> {
    await this.requireOpenTableMembership(tableSessionId, customerId, false)
    const result = await this.transaction.query<GuestServiceViewRow>(`
      SELECT task.public_id, request_group.request_type, task.status,
        public_profile.public_display_name AS public_service_name,
        request_group.request_count, task.created_at::text
      FROM mbox.guest_service_request_groups AS request_group
      JOIN mbox.service_tasks AS task
        ON task.tenant_id = request_group.tenant_id
       AND task.store_id = request_group.store_id
       AND task.id = request_group.current_service_task_id
      LEFT JOIN mbox.employee_customer_public_profiles AS public_profile
        ON public_profile.tenant_id = task.tenant_id
       AND public_profile.store_id = task.store_id
       AND public_profile.employee_id = task.assigned_employee_id
       AND public_profile.status = 'published'
       AND public_profile.effective_at <= clock_timestamp()
      WHERE request_group.tenant_id = $1::uuid
        AND request_group.store_id = $2::uuid
        AND request_group.table_session_id = $3::uuid
      ORDER BY task.created_at DESC, task.id DESC
      LIMIT 100
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      tableSessionId,
    ])
    return result.rows.map((row) => ({
      publicId: row.public_id,
      requestType: row.request_type,
      status: row.status,
      publicServiceName: row.public_service_name,
      requestCount: Number(row.request_count),
      createdAt: timestamp(row.created_at),
    }))
  }

  async feedback(input: Readonly<{
    tableSessionId: string
    customerId: string
    actorRef: string
    publicId: string
    action: GuestServiceFeedbackAction
  }>): Promise<GuestServiceFeedbackResult> {
    await this.requireOpenTableMembership(input.tableSessionId, input.customerId, true,input.actorRef)
    const task = await this.lockOwnedTask(input.tableSessionId, input.publicId)
    const eventType = input.action === 'confirm' ? 'guest.confirmed' : 'guest.escalated'
    const existing = await this.findFeedbackEvent(task.task_id, eventType)
    if (existing !== null) {
      return {
        taskId: task.task_id,
        publicId: task.public_id,
        action: input.action,
        taskStatus: task.status,
        changed: false,
        occurredAt: timestamp(existing.occurred_at),
      }
    }
    if (input.action === 'confirm' && task.status !== 'completed') {
      throw new GuestServiceFeedbackStateError(input.action)
    }
    if (input.action === 'escalate' && !ACTIVE_TASK_STATUSES.has(task.status)) {
      throw new GuestServiceFeedbackStateError(input.action)
    }
    if (input.action === 'escalate') {
      const updated = await this.transaction.query(`
        UPDATE mbox.service_tasks
        SET priority = 'urgent',
            escalate_at = COALESCE(escalate_at, clock_timestamp()),
            next_action_at = LEAST(next_action_at, clock_timestamp())
        WHERE tenant_id = $1::uuid
          AND store_id = $2::uuid
          AND id = $3::uuid
          AND status = ANY($4::text[])
      `, [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        task.task_id,
        [...ACTIVE_TASK_STATUSES],
      ])
      if (updated.rowCount !== 1) throw new GuestServiceFeedbackStateError(input.action)
    }
    const inserted = await this.transaction.query<FeedbackEventRow>(`
      INSERT INTO mbox.service_task_events (
        tenant_id, store_id, service_task_id, event_type,
        from_status, to_status, actor_type, actor_employee_id,
        note, metadata, idempotency_key
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4,
        $5, $5, 'guest', NULL,
        NULL, jsonb_build_object('requestGroupId', $6::text), $7
      )
      ON CONFLICT (tenant_id, store_id, service_task_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL
      DO NOTHING
      RETURNING occurred_at::text
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      task.task_id,
      eventType,
      task.status,
      task.request_group_id,
      `guest-feedback:${input.action}`,
    ])
    const occurredAt = inserted.rows[0]?.occurred_at
      ?? (await this.findFeedbackEvent(task.task_id, eventType))?.occurred_at
    if (occurredAt === undefined) throw new Error('Guest service feedback was not recorded')
    return {
      taskId: task.task_id,
      publicId: task.public_id,
      action: input.action,
      taskStatus: task.status,
      changed: inserted.rowCount === 1,
      occurredAt: timestamp(occurredAt),
    }
  }

  private async requireOpenTableMembership(
    tableSessionId: string,
    customerId: string,
    lock = true,
    actorRef?: string,
  ): Promise<string> {
    if (lock && !await lockBoundGuestTablePosition(this.transaction,{ tableSessionId,customerId,actorRef })) {
      throw new GuestServiceRequestNotFoundError()
    }
    const selected = await this.transaction.query<TableContextRow>(`
      SELECT session.table_id,EXISTS(
        SELECT 1 FROM mbox.table_session_customer_participations participation
        WHERE participation.tenant_id=session.tenant_id
          AND participation.store_id=session.store_id
          AND participation.table_session_id=session.id
          AND participation.table_id=session.table_id AND participation.left_at IS NULL
          AND mbox.canonical_customer_id(
            participation.tenant_id,participation.store_id,participation.customer_id
          )=mbox.canonical_customer_id(session.tenant_id,session.store_id,$4::uuid)
      ) AS is_member
      FROM mbox.table_sessions session
      WHERE session.tenant_id=$1::uuid AND session.store_id=$2::uuid
        AND session.id=$3::uuid AND session.status='open'
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      tableSessionId,
      customerId,
    ])
    const tableId = selected.rows[0]?.table_id
    if (selected.rowCount !== 1 || tableId === undefined) {
      throw new GuestServiceSessionUnavailableError()
    }
    if (selected.rows[0]?.is_member !== true) throw new GuestServiceRequestNotFoundError()
    return tableId
  }

  private async lockOwnedTask(
    tableSessionId: string,
    publicId: string,
  ): Promise<FeedbackTaskRow> {
    const selected = await this.transaction.query<FeedbackTaskRow>(`
      SELECT task.id AS task_id, task.public_id, request_group.id AS request_group_id,
        task.status, task.priority
      FROM mbox.guest_service_request_groups AS request_group
      JOIN mbox.service_tasks AS task
        ON task.tenant_id = request_group.tenant_id
       AND task.store_id = request_group.store_id
       AND task.id = request_group.current_service_task_id
      WHERE request_group.tenant_id = $1::uuid
        AND request_group.store_id = $2::uuid
        AND request_group.table_session_id = $3::uuid
        AND task.public_id = $4
      FOR UPDATE OF request_group, task
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      tableSessionId,
      publicId,
    ])
    const row = selected.rows[0]
    if (selected.rowCount !== 1 || row === undefined) throw new GuestServiceRequestNotFoundError()
    return row
  }

  private async findFeedbackEvent(taskId: string, eventType: string): Promise<FeedbackEventRow | null> {
    const selected = await this.transaction.query<FeedbackEventRow>(`
      SELECT occurred_at::text
      FROM mbox.service_task_events
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND service_task_id = $3::uuid
        AND event_type = $4
      ORDER BY occurred_at, id
      LIMIT 1
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      taskId,
      eventType,
    ])
    return selected.rows[0] ?? null
  }

  private async consumeRateLimit(
    dimension: 'table' | 'device',
    principalHash: string,
    maximum: number,
  ): Promise<GuestServiceRequestRateLimited | null> {
    const consumed = await this.transaction.query<RateLimitRow>(`
      INSERT INTO mbox.guest_request_rate_limits (
        tenant_id, store_id, dimension, action_kind, principal_hash,
        window_started_at, request_count, expires_at
      ) VALUES (
        $1::uuid, $2::uuid, $3, 'service_request', $4,
        date_trunc('minute', clock_timestamp()), 1,
        date_trunc('minute', clock_timestamp()) + interval '1 minute'
      )
      ON CONFLICT (
        tenant_id, store_id, dimension, action_kind, principal_hash, window_started_at
      ) DO UPDATE SET request_count = mbox.guest_request_rate_limits.request_count + 1
      RETURNING request_count, expires_at::text
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      dimension,
      principalHash,
    ])
    const row = consumed.rows[0]
    if (consumed.rowCount !== 1 || row === undefined) {
      throw new Error('Guest request rate limit was not recorded')
    }
    return row.request_count > maximum
      ? { status: 'rate_limited', dimension, retryAt: row.expires_at }
      : null
  }

  private async lockGroup(
    input: Readonly<GuestServiceRequestInput>,
    mergeKey: string,
  ): Promise<RequestGroupRow> {
    const selected = await this.transaction.query<RequestGroupRow>(`
      SELECT id, current_service_task_id, request_count
      FROM mbox.guest_service_request_groups
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND table_session_id = $3::uuid
        AND merge_key = $4
      FOR UPDATE
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.tableSessionId,
      mergeKey,
    ])
    const row = selected.rows[0]
    if (selected.rowCount !== 1 || row === undefined) {
      throw new Error('Guest service request group could not be locked')
    }
    return row
  }

  private async resolveRelatedOrderId(
    tableSessionId: string,
    requestType: GuestServiceRequestType,
    relatedOrderPublicId: string | null,
  ): Promise<string | null> {
    if (relatedOrderPublicId === null) return null
    if (requestType !== 'complaint') throw new TypeError('relatedOrderPublicId is allowed only for complaints')
    const result = await this.transaction.query<{ id: string }>(`
      SELECT id FROM mbox.orders
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid
        AND table_session_id=$3::uuid AND public_id=$4
      FOR KEY SHARE
    `, [
      this.transaction.scope.tenantId,this.transaction.scope.storeId,
      tableSessionId,relatedOrderPublicId,
    ])
    const id = result.rows[0]?.id
    if (!id) throw new GuestServiceRequestNotFoundError()
    return id
  }

  private async markRequested(
    groupId: string,
    deviceFingerprint: string,
    replaceTask: boolean,
    taskId?: string,
  ): Promise<number> {
    const updated = await this.transaction.query<{ request_count: number }>(`
      UPDATE mbox.guest_service_request_groups
      SET current_service_task_id = CASE WHEN $4::boolean THEN $5::uuid ELSE current_service_task_id END,
          request_count = request_count + 1,
          last_device_hash = $6,
          first_requested_at = COALESCE(first_requested_at, clock_timestamp()),
          last_requested_at = clock_timestamp(),
          aggregate_version = aggregate_version + 1
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND id = $3::uuid
      RETURNING request_count
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      groupId,
      replaceTask,
      taskId ?? null,
      hashGuestBehaviorPrincipal(deviceFingerprint),
    ])
    const count = updated.rows[0]?.request_count
    if (updated.rowCount !== 1 || count === undefined) {
      throw new Error('Guest service request group could not be updated')
    }
    return count
  }
}

function timestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value)
}

export function serviceMergeKey(
  requestType: GuestServiceRequestType,
  detail: string | null,
  relatedOrderId: string | null = null,
): string {
  const normalizedDetail = detail?.trim().replace(/\s+/g, ' ').toLocaleLowerCase('zh-CN') ?? ''
  const orderScope = relatedOrderId === null ? '' : `\norder:${relatedOrderId}`
  return createHash('sha256').update(`${requestType}\n${normalizedDetail}${orderScope}`, 'utf8').digest('hex')
}

function validateRequest(input: Readonly<GuestServiceRequestInput>): string | null {
  if (!['call_staff', 'complaint', 'custom'].includes(input.requestType)) {
    throw new TypeError('requestType is invalid')
  }
  const detail = input.detail?.trim() || null
  if (detail !== null && detail.length > 500) {
    throw new TypeError('detail must not exceed 500 characters')
  }
  if (input.requestType === 'custom' && (detail === null || detail.length < 2)) {
    throw new TypeError('custom service detail must contain at least 2 characters')
  }
  if (input.relatedOrderPublicId !== undefined && input.relatedOrderPublicId !== null
    && (typeof input.relatedOrderPublicId !== 'string'
      || !/^[A-Za-z0-9-]{8,128}$/.test(input.relatedOrderPublicId))) {
    throw new TypeError('relatedOrderPublicId is invalid')
  }
  hashGuestBehaviorPrincipal(input.actorRef)
  hashGuestBehaviorPrincipal(input.deviceFingerprint)
  return detail
}

function validateLimit(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new TypeError(`${name} must be an integer between 1 and 100`)
  }
  return value
}

function workflowFor(requestType: GuestServiceRequestType): GuestServiceWorkflow {
  return requestType === 'complaint' ? 'manager_attention' : 'visible_then_complete'
}

function taskPresentation(
  requestType: GuestServiceRequestType,
  detail: string | null,
): {
  title: string
  priority: 'normal' | 'high' | 'urgent'
  requestedRoleCode: string
  snapshot: JsonObject
} {
  if (requestType === 'complaint') {
    return {
      title: '客人希望值班经理马上关注',
      priority: 'urgent',
      requestedRoleCode: 'MANAGER',
      snapshot: {},
    }
  }
  if (requestType === 'custom') {
    return {
      title: detail === null ? '客人有一条个性需求' : '客人有一条个性需求',
      priority: 'high',
      requestedRoleCode: 'SERVER',
      snapshot: {},
    }
  }
  return {
    title: '客人正在等您',
    priority: 'normal',
    requestedRoleCode: 'SERVER',
    snapshot: {},
  }
}
