import { createHash, randomUUID } from 'node:crypto'
import type { JsonObject } from './command-executor.js'
import { hashGuestBehaviorPrincipal } from './guest-behavior-repository.js'
import {
  ServiceTaskRepository,
  type ServiceTask,
} from './service-task-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'

export type GuestServiceRequestType = 'call_staff' | 'complaint' | 'custom'
export type GuestServiceWorkflow = 'visible_then_complete' | 'manager_attention'

export interface GuestServiceRequestInput {
  tableSessionId: string
  customerId: string
  actorRef: string
  deviceFingerprint: string
  requestType: GuestServiceRequestType
  detail?: string | null
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

const ACTIVE_TASK_STATUSES = new Set(['pending', 'acknowledged', 'in_progress'])

export class GuestServiceSessionUnavailableError extends Error {
  constructor() {
    super('当前桌次已经结束，请重新扫描桌面二维码')
    this.name = 'GuestServiceSessionUnavailableError'
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
    const tableId = await this.requireOpenTableMembership(input.tableSessionId, input.customerId)
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

    const mergeKey = serviceMergeKey(input.requestType, detail)
    await this.transaction.query(`
      INSERT INTO mbox.guest_service_request_groups (
        tenant_id, store_id, table_session_id, customer_id, request_type, merge_key
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6)
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

  private async requireOpenTableMembership(tableSessionId: string, customerId: string): Promise<string> {
    const selected = await this.transaction.query<TableContextRow>(`
      SELECT session.table_id
      FROM mbox.table_sessions AS session
      JOIN mbox.table_session_customers AS membership
        ON membership.tenant_id = session.tenant_id
       AND membership.store_id = session.store_id
       AND membership.table_session_id = session.id
       AND membership.customer_id = $4::uuid
      WHERE session.tenant_id = $1::uuid
        AND session.store_id = $2::uuid
        AND session.id = $3::uuid
        AND session.status = 'open'
      FOR UPDATE OF session
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
    return tableId
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

export function serviceMergeKey(requestType: GuestServiceRequestType, detail: string | null): string {
  const normalizedDetail = detail?.trim().replace(/\s+/g, ' ').toLocaleLowerCase('zh-CN') ?? ''
  return createHash('sha256').update(`${requestType}\n${normalizedDetail}`, 'utf8').digest('hex')
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
