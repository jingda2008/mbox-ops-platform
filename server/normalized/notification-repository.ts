import { createHash } from 'node:crypto'
import type { JsonObject, JsonValue } from './command-executor.js'
import type { ScopedTransaction } from './transaction-runner.js'

export type NotificationChannel = 'in_app' | 'wechat' | 'wecom' | 'headset' | 'printer' | 'sms'
export type NotificationRecipientType = 'employee' | 'customer' | 'role' | 'table' | 'integration'
export type NotificationStatus = 'pending' | 'sending' | 'delivered' | 'failed' | 'dead' | 'cancelled'

export interface NotificationRecipient {
  type: NotificationRecipientType
  id: string
}

export interface CreateNotificationInput {
  businessKey: string
  channel: NotificationChannel
  recipient: Readonly<NotificationRecipient>
  templateCode: string
  payload: JsonObject
  sourceOutboxMessageId?: string | null
  availableAt?: string
  maxAttempts?: number
}

export type OutboxNotificationInput = Omit<CreateNotificationInput, 'businessKey' | 'sourceOutboxMessageId'> & {
  sourceOutboxMessageId: string
}

export interface NotificationRecord {
  id: string
  businessKey: string
  sourceOutboxMessageId: string | null
  channel: NotificationChannel
  recipient: NotificationRecipient
  templateCode: string
  payload: JsonObject
  status: NotificationStatus
  availableAt: string
  deliveredAt: string | null
  attempts: number
  maxAttempts: number
  failureCode: string | null
  deadAt: string | null
  cancelledAt: string | null
  createdAt: string
  updatedAt: string
}

export interface NotificationListQuery {
  statuses?: readonly NotificationStatus[]
  recipient?: Readonly<NotificationRecipient>
  limit?: number
}

interface NotificationRow extends Record<string, unknown> {
  id: string
  business_key: string
  source_outbox_message_id: string | null
  channel: NotificationChannel
  recipient_type: NotificationRecipientType
  recipient_id: string
  template_code: string
  payload: JsonObject
  status: NotificationStatus
  available_at: string
  delivered_at: string | null
  attempts: number
  max_attempts: number
  last_error: string | null
  dead_at: string | null
  cancelled_at: string | null
  created_at: string
  updated_at: string
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const BUSINESS_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,159}$/
const TEMPLATE_CODE_PATTERN = /^[a-z][a-z0-9_.-]{2,95}$/
const INTEGRATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{2,95}$/
const MAX_PAYLOAD_BYTES = 8 * 1024
const MAX_PAYLOAD_DEPTH = 6
const MAX_PAYLOAD_KEYS = 64
const MAX_PAYLOAD_STRING = 500
const DENIED_KEY_PATTERN = /(?:^|_)(?:phone|mobile|email|id_?card|address|contact|openid|unionid|token|secret|password|credential|access_?key|request_?body|raw_?body|(?:customer|guest|recipient|employee)_?name)(?:$|_)/i
const SENSITIVE_VALUE_PATTERNS = [
  /(?:^|\D)1[3-9]\d{9}(?:\D|$)/,
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  /\b\d{17}[0-9Xx]\b/,
  /\b(?:sk|LTAI)[-_A-Za-z0-9.]{12,}\b/,
]

const CHANNEL_RECIPIENTS: Readonly<Record<NotificationChannel, readonly NotificationRecipientType[]>> = {
  in_app: ['employee', 'customer', 'role', 'table'],
  wechat: ['customer'],
  wecom: ['employee', 'role'],
  headset: ['employee', 'role'],
  printer: ['integration'],
  sms: ['customer'],
}

export class NotificationPolicyError extends Error {
  readonly code = 'NOTIFICATION_POLICY_REJECTED'
  constructor(message: string) {
    super(message)
    this.name = 'NotificationPolicyError'
  }
}

export class NotificationBusinessKeyConflictError extends Error {
  readonly code = 'NOTIFICATION_BUSINESS_KEY_CONFLICT'
  constructor(businessKey: string) {
    super(`Notification business key conflicts with different immutable content: ${businessKey}`)
    this.name = 'NotificationBusinessKeyConflictError'
  }
}

export class NotificationSourceOutboxError extends Error {
  readonly code = 'NOTIFICATION_SOURCE_OUTBOX_NOT_FOUND'
  constructor() {
    super('Notification source outbox message does not exist in this store scope')
    this.name = 'NotificationSourceOutboxError'
  }
}

export class NotificationNotFoundError extends Error {
  constructor() {
    super('Notification does not exist in this store scope')
    this.name = 'NotificationNotFoundError'
  }
}

export class NotificationRetryNotAllowedError extends Error {
  constructor() {
    super('Only failed notifications can be retried')
    this.name = 'NotificationRetryNotAllowedError'
  }
}

export class NotificationRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async create(input: Readonly<CreateNotificationInput>): Promise<NotificationRecord> {
    validateInput(input)
    const replay = await this.getByBusinessKey(input.businessKey, true)
    if (replay) {
      if (!sameImmutableContent(replay, input)) throw new NotificationBusinessKeyConflictError(input.businessKey)
      return replay
    }
    await assertRecipientEligible(this.transaction, input.channel, input.recipient)
    if (input.sourceOutboxMessageId) await assertSourceOutbox(this.transaction, input.sourceOutboxMessageId)

    const result = await this.transaction.query<NotificationRow>(`
      INSERT INTO mbox.notifications (
        tenant_id, store_id, business_key, source_outbox_message_id,
        channel, recipient_type, recipient_id, template_code, payload,
        status, available_at, max_attempts
      ) VALUES (
        $1::uuid, $2::uuid, $3, $4::uuid,
        $5, $6, $7, $8, $9::jsonb,
        'pending', COALESCE($10::timestamptz, clock_timestamp()), $11
      )
      ON CONFLICT (tenant_id, store_id, business_key) DO NOTHING
      RETURNING ${RETURNING_COLUMNS}
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.businessKey,
      input.sourceOutboxMessageId ?? null,
      input.channel,
      input.recipient.type,
      input.recipient.id,
      input.templateCode,
      JSON.stringify(input.payload),
      input.availableAt ?? null,
      input.maxAttempts ?? 5,
    ])
    const inserted = result.rows[0]
    if (inserted) return mapNotification(inserted)

    const existing = await this.getByBusinessKey(input.businessKey, true)
    if (!existing || !sameImmutableContent(existing, input)) {
      throw new NotificationBusinessKeyConflictError(input.businessKey)
    }
    return existing
  }

  async materializeFromOutbox(input: Readonly<OutboxNotificationInput>) {
    return this.create({
      ...input,
      businessKey: outboxNotificationBusinessKey(input),
    })
  }

  async getByBusinessKey(businessKey: string, lock = false): Promise<NotificationRecord | null> {
    const result = await this.transaction.query<NotificationRow>(`
      SELECT ${RETURNING_COLUMNS}
      FROM mbox.notifications
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND business_key = $3
      ${lock ? 'FOR UPDATE' : ''}
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, businessKey])
    return result.rows[0] ? mapNotification(result.rows[0]) : null
  }

  async list(query: Readonly<NotificationListQuery> = {}): Promise<NotificationRecord[]> {
    const statuses = query.statuses === undefined
      ? null
      : [...new Set(query.statuses.map(validateStatus))]
    if (statuses !== null && statuses.length === 0) return []
    if (query.recipient !== undefined) validateRecipient(query.recipient)
    const limit = boundedListLimit(query.limit ?? 50)
    const result = await this.transaction.query<NotificationRow>(`
      SELECT ${RETURNING_COLUMNS}
      FROM mbox.notifications
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND ($3::text[] IS NULL OR status = ANY($3::text[]))
        AND ($4::text IS NULL OR recipient_type = $4)
        AND ($5::text IS NULL OR recipient_id = $5)
      ORDER BY
        CASE status
          WHEN 'failed' THEN 0
          WHEN 'dead' THEN 1
          WHEN 'pending' THEN 2
          WHEN 'sending' THEN 3
          ELSE 4
        END,
        available_at,
        created_at DESC,
        id
      LIMIT $6
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      statuses,
      query.recipient?.type ?? null,
      query.recipient?.id ?? null,
      limit,
    ])
    return result.rows.map(mapNotification)
  }

  async retryFailed(id: string): Promise<NotificationRecord> {
    assertUuid(id, 'notificationId')
    const result = await this.transaction.query<NotificationRow>(`
      UPDATE mbox.notifications
      SET available_at = clock_timestamp(),
          last_error = NULL,
          locked_by = NULL,
          locked_at = NULL
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND id = $3::uuid
        AND status = 'failed'
      RETURNING ${RETURNING_COLUMNS}
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, id])
    const retried = result.rows[0]
    if (retried) return mapNotification(retried)

    const existing = await this.transaction.query<{ status: NotificationStatus }>(`
      SELECT status
      FROM mbox.notifications
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND id = $3::uuid
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, id])
    if (existing.rowCount !== 1) throw new NotificationNotFoundError()
    throw new NotificationRetryNotAllowedError()
  }

  async cancel(id: string): Promise<NotificationRecord | null> {
    assertUuid(id, 'notificationId')
    const result = await this.transaction.query<NotificationRow>(`
      UPDATE mbox.notifications
      SET status = 'cancelled',
          cancelled_at = clock_timestamp(),
          locked_by = NULL,
          locked_at = NULL,
          last_error = NULL
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND id = $3::uuid
        AND status IN ('pending', 'failed')
      RETURNING ${RETURNING_COLUMNS}
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, id])
    return result.rows[0] ? mapNotification(result.rows[0]) : null
  }
}

const NOTIFICATION_STATUSES: readonly NotificationStatus[] = [
  'pending', 'sending', 'delivered', 'failed', 'dead', 'cancelled',
]

function validateStatus(value: NotificationStatus): NotificationStatus {
  if (!NOTIFICATION_STATUSES.includes(value)) {
    throw new NotificationPolicyError('Notification status filter is invalid')
  }
  return value
}

function validateRecipient(value: Readonly<NotificationRecipient>): void {
  if (value.type === 'integration') {
    if (!INTEGRATION_ID_PATTERN.test(value.id)) {
      throw new NotificationPolicyError('Integration recipient must be a stable internal code')
    }
    return
  }
  assertUuid(value.id, 'recipient.id')
}

function boundedListLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new NotificationPolicyError('Notification list limit must be between 1 and 100')
  }
  return value
}

export function outboxNotificationBusinessKey(input: Readonly<OutboxNotificationInput>) {
  assertUuid(input.sourceOutboxMessageId, 'sourceOutboxMessageId')
  const digest = createHash('sha256')
    .update([
      input.sourceOutboxMessageId,
      input.channel,
      input.recipient.type,
      input.recipient.id,
      input.templateCode,
    ].join('\u001f'))
    .digest('hex')
    .slice(0, 32)
  return `outbox:${input.sourceOutboxMessageId}:${digest}`
}

const RETURNING_COLUMNS = `
  id, business_key, source_outbox_message_id, channel, recipient_type, recipient_id,
  template_code, payload, status, available_at::text, delivered_at::text,
  attempts, max_attempts, last_error, dead_at::text, cancelled_at::text,
  created_at::text, updated_at::text
`

async function assertSourceOutbox(transaction: ScopedTransaction, id: string) {
  assertUuid(id, 'sourceOutboxMessageId')
  const result = await transaction.query(`
    SELECT id
    FROM mbox.outbox_messages
    WHERE tenant_id = $1::uuid
      AND store_id = $2::uuid
      AND id = $3::uuid
    FOR KEY SHARE
  `, [transaction.scope.tenantId, transaction.scope.storeId, id])
  if (result.rowCount !== 1) throw new NotificationSourceOutboxError()
}

async function assertRecipientEligible(
  transaction: ScopedTransaction,
  channel: NotificationChannel,
  recipient: Readonly<NotificationRecipient>,
) {
  if (!CHANNEL_RECIPIENTS[channel].includes(recipient.type)) {
    throw new NotificationPolicyError(`Channel ${channel} does not support recipient type ${recipient.type}`)
  }
  if (recipient.type === 'integration') {
    if (!INTEGRATION_ID_PATTERN.test(recipient.id)) {
      throw new NotificationPolicyError('Integration recipient must be a stable internal code')
    }
    return
  }
  assertUuid(recipient.id, 'recipient.id')

  if (recipient.type === 'customer' && channel !== 'in_app') {
    const consentKey = channel === 'wechat' ? 'wechatNotifications' : 'smsNotifications'
    const result = await transaction.query(`
      SELECT customer.id
      FROM mbox.customers customer
      JOIN mbox.customer_profiles profile
        ON profile.tenant_id = customer.tenant_id
       AND profile.store_id = customer.store_id
       AND profile.customer_id = customer.id
      WHERE customer.tenant_id = $1::uuid
        AND customer.store_id = $2::uuid
        AND customer.id = $3::uuid
        AND customer.status = 'active'
        AND COALESCE(profile.consent_snapshot ->> $4, 'false') = 'true'
      FOR KEY SHARE OF customer
    `, [transaction.scope.tenantId, transaction.scope.storeId, recipient.id, consentKey])
    if (result.rowCount !== 1) {
      throw new NotificationPolicyError(`Customer has not consented to ${channel} notifications`)
    }
    return
  }

  if ((recipient.type === 'employee' || recipient.type === 'role') && channel !== 'in_app') {
    const capability = `notifications.receive.${channel}`
    const result = recipient.type === 'employee'
      ? await transaction.query(`
          SELECT employee.id
          FROM mbox.employees employee
          WHERE employee.tenant_id = $1::uuid
            AND employee.store_id = $2::uuid
            AND employee.id = $3::uuid
            AND employee.status = 'active'
            AND NOT EXISTS (
              SELECT 1
              FROM mbox.employee_permission_overrides denied
              JOIN mbox.staff_permission_definitions permission
                ON permission.tenant_id = denied.tenant_id
               AND permission.store_id = denied.store_id
               AND permission.id = denied.permission_id
               AND permission.code = $4
               AND permission.status = 'active'
              WHERE denied.tenant_id = employee.tenant_id
                AND denied.store_id = employee.store_id
                AND denied.employee_id = employee.id
                AND denied.effect = 'deny'
                AND denied.starts_at <= clock_timestamp()
                AND (denied.ends_at IS NULL OR denied.ends_at > clock_timestamp())
            )
            AND (
              EXISTS (
                SELECT 1
                FROM mbox.employee_permission_overrides granted
                JOIN mbox.staff_permission_definitions permission
                  ON permission.tenant_id = granted.tenant_id
                 AND permission.store_id = granted.store_id
                 AND permission.id = granted.permission_id
                 AND permission.code = $4
                 AND permission.status = 'active'
                WHERE granted.tenant_id = employee.tenant_id
                  AND granted.store_id = employee.store_id
                  AND granted.employee_id = employee.id
                  AND granted.effect = 'grant'
                  AND granted.starts_at <= clock_timestamp()
                  AND (granted.ends_at IS NULL OR granted.ends_at > clock_timestamp())
              )
              OR EXISTS (
                SELECT 1
                FROM mbox.employee_roles employee_role
                JOIN mbox.roles role
                  ON role.tenant_id = employee_role.tenant_id
                 AND role.store_id = employee_role.store_id
                 AND role.id = employee_role.role_id
                 AND role.status = 'active'
                WHERE employee_role.tenant_id = employee.tenant_id
                  AND employee_role.store_id = employee.store_id
                  AND employee_role.employee_id = employee.id
                  AND employee_role.starts_at <= clock_timestamp()
                  AND (employee_role.ends_at IS NULL OR employee_role.ends_at > clock_timestamp())
                  AND EXISTS (
                      SELECT 1
                      FROM mbox.role_permission_assignments assignment
                      JOIN mbox.staff_permission_definitions permission
                        ON permission.tenant_id = assignment.tenant_id
                       AND permission.store_id = assignment.store_id
                       AND permission.id = assignment.permission_id
                       AND permission.code = $4
                       AND permission.status = 'active'
                      WHERE assignment.tenant_id = role.tenant_id
                        AND assignment.store_id = role.store_id
                        AND assignment.role_id = role.id
                  )
              )
            )
          FOR KEY SHARE OF employee
        `, [transaction.scope.tenantId, transaction.scope.storeId, recipient.id, capability])
      : await transaction.query(`
          SELECT role.id
          FROM mbox.roles role
          WHERE role.tenant_id = $1::uuid
            AND role.store_id = $2::uuid
            AND role.id = $3::uuid
            AND role.status = 'active'
            AND role.can_receive_tasks = true
            AND EXISTS (
                SELECT 1
                FROM mbox.role_permission_assignments assignment
                JOIN mbox.staff_permission_definitions permission
                  ON permission.tenant_id = assignment.tenant_id
                 AND permission.store_id = assignment.store_id
                 AND permission.id = assignment.permission_id
                 AND permission.code = $4
                 AND permission.status = 'active'
                WHERE assignment.tenant_id = role.tenant_id
                  AND assignment.store_id = role.store_id
                  AND assignment.role_id = role.id
            )
          FOR KEY SHARE OF role
        `, [transaction.scope.tenantId, transaction.scope.storeId, recipient.id, capability])
    if (result.rowCount !== 1) {
      throw new NotificationPolicyError(`Recipient lacks permission for ${channel} notifications`)
    }
    return
  }

  const relation = recipientRelation(recipient.type)
  const result = await transaction.query(`
    SELECT id
    FROM ${relation.table}
    WHERE tenant_id = $1::uuid
      AND store_id = $2::uuid
      AND id = $3::uuid
      AND ${relation.activePredicate}
    FOR KEY SHARE
  `, [transaction.scope.tenantId, transaction.scope.storeId, recipient.id])
  if (result.rowCount !== 1) {
    throw new NotificationPolicyError(`Recipient is unavailable for ${recipient.type} notification`)
  }
}

function recipientRelation(type: Exclude<NotificationRecipientType, 'integration'>) {
  switch (type) {
    case 'employee': return { table: 'mbox.employees', activePredicate: "status = 'active'" }
    case 'customer': return { table: 'mbox.customers', activePredicate: "status = 'active'" }
    case 'role': return { table: 'mbox.roles', activePredicate: "status = 'active' AND can_receive_tasks = true" }
    case 'table': return { table: 'mbox.tables', activePredicate: "status <> 'retired'" }
  }
}

function validateInput(input: Readonly<CreateNotificationInput>) {
  if (!BUSINESS_KEY_PATTERN.test(input.businessKey)) {
    throw new NotificationPolicyError('businessKey must be a stable non-sensitive key between 8 and 160 characters')
  }
  if (!TEMPLATE_CODE_PATTERN.test(input.templateCode)) {
    throw new NotificationPolicyError('templateCode is invalid')
  }
  if (input.maxAttempts !== undefined && (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 20)) {
    throw new NotificationPolicyError('maxAttempts must be an integer between 1 and 20')
  }
  if (input.availableAt !== undefined && Number.isNaN(Date.parse(input.availableAt))) {
    throw new NotificationPolicyError('availableAt must be an ISO timestamp')
  }
  assertPrivacySafePayload(input.payload)
}

export function assertPrivacySafePayload(payload: JsonObject) {
  let keyCount = 0
  const inspect = (value: JsonValue, depth: number, path: string) => {
    if (depth > MAX_PAYLOAD_DEPTH) throw new NotificationPolicyError('Notification payload is too deeply nested')
    if (typeof value === 'string') {
      if (value.length > MAX_PAYLOAD_STRING) throw new NotificationPolicyError(`Notification payload string is too long at ${path}`)
      if (SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
        throw new NotificationPolicyError(`Notification payload contains direct personal or secret data at ${path}`)
      }
      return
    }
    if (value === null || typeof value === 'boolean') return
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new NotificationPolicyError(`Notification payload number is invalid at ${path}`)
      return
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => inspect(item, depth + 1, `${path}[${index}]`))
      return
    }
    for (const [key, item] of Object.entries(value)) {
      keyCount += 1
      if (keyCount > MAX_PAYLOAD_KEYS) throw new NotificationPolicyError('Notification payload contains too many fields')
      if (DENIED_KEY_PATTERN.test(key)) throw new NotificationPolicyError(`Notification payload field is not permitted: ${key}`)
      inspect(item, depth + 1, path ? `${path}.${key}` : key)
    }
  }
  inspect(payload, 0, '')
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new NotificationPolicyError('Notification payload exceeds 8 KiB')
  }
}

function sameImmutableContent(existing: NotificationRecord, input: Readonly<CreateNotificationInput>) {
  return existing.sourceOutboxMessageId === (input.sourceOutboxMessageId ?? null)
    && existing.channel === input.channel
    && existing.recipient.type === input.recipient.type
    && existing.recipient.id === input.recipient.id
    && existing.templateCode === input.templateCode
    && stableJson(existing.payload) === stableJson(input.payload)
    && existing.maxAttempts === (input.maxAttempts ?? 5)
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const entries = Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
}

function mapNotification(row: NotificationRow): NotificationRecord {
  return {
    id: row.id,
    businessKey: row.business_key,
    sourceOutboxMessageId: row.source_outbox_message_id,
    channel: row.channel,
    recipient: { type: row.recipient_type, id: row.recipient_id },
    templateCode: row.template_code,
    payload: row.payload,
    status: row.status,
    availableAt: row.available_at,
    deliveredAt: row.delivered_at,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    failureCode: row.last_error,
    deadAt: row.dead_at,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function assertUuid(value: string, label: string) {
  if (!UUID_PATTERN.test(value)) throw new NotificationPolicyError(`${label} must be an internal UUID`)
}
