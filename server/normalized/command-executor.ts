import { createHash } from 'node:crypto'
import type { ScopedTransaction, StoreScope } from './transaction-runner.js'
import { ScopedPostgresTransactionRunner } from './transaction-runner.js'

export type JsonPrimitive = boolean | number | string | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
export interface JsonObject {
  readonly [key: string]: JsonValue
}

export interface JsonCodec<Value> {
  encode(value: Value): JsonValue
  decode(value: unknown): Value
}

export type AuditActor =
  | {
      type: 'employee'
      employeeId: string
      ref?: string
    }
  | {
      type: 'guest' | 'system' | 'integration' | 'support'
      employeeId?: never
      ref?: string
    }

export interface AuditEvent {
  actor: AuditActor
  action: string
  objectType: string
  objectId: string
  businessDate: string
  beforeData?: JsonObject | null
  afterData?: JsonObject | null
  reason?: string | null
  requestId?: string | null
  traceId?: string | null
  metadata?: JsonObject
  occurredAt?: string
}

export interface OutboxMessage {
  businessEventKey?: string
  eventId?: string
  aggregateType: string
  aggregateId: string
  aggregateVersion: number
  eventType: string
  payload: JsonObject
  headers?: JsonObject
  occurredAt?: string
  availableAt?: string
}

interface ExistingOutboxMessageRow extends Record<string, unknown> {
  message_key: string
  aggregate_type: string
  aggregate_id: string
  aggregate_version: string | number
  message_type: string
  payload: JsonObject
  headers: JsonObject
}

export interface CommandOutcome<Result> {
  result: Result
  auditEvents: readonly AuditEvent[]
  outboxMessages: readonly OutboxMessage[]
}

export interface IdempotentCommand<Result> {
  scope: Readonly<StoreScope>
  operationScope: string
  idempotencyKey: string
  requestFingerprint: string
  resultCodec: JsonCodec<Result>
  ttlMs?: number
  lockMs?: number
}

export interface CommandExecution<Result> {
  value: Result
  replayed: boolean
}

interface IdempotencyRow extends Record<string, unknown> {
  id: string
  request_sha256: string
  status: 'processing' | 'completed' | 'failed'
  response_snapshot: unknown
  is_expired: boolean
}

interface StoredResultEnvelope {
  result: unknown
}

const OPERATION_SCOPE_PATTERN = /^[a-z][a-z0-9_.-]{2,127}$/
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000
const DEFAULT_LOCK_MS = 30 * 1_000

export class IdempotencyConflictError extends Error {
  constructor(operationScope: string, idempotencyKey: string) {
    super(`Idempotency key conflicts with another request: ${operationScope}/${idempotencyKey}`)
    this.name = 'IdempotencyConflictError'
  }
}

export class IdempotencyInProgressError extends Error {
  constructor(operationScope: string, idempotencyKey: string) {
    super(`Idempotent command is already in progress: ${operationScope}/${idempotencyKey}`)
    this.name = 'IdempotencyInProgressError'
  }
}

export class IdempotencyRecordError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IdempotencyRecordError'
  }
}

export class OutboxMessageConflictError extends Error {
  constructor(messageKey: string) {
    super(`Outbox business event conflicts with different content: ${messageKey}`)
    this.name = 'OutboxMessageConflictError'
  }
}

export class NormalizedCommandExecutor {
  constructor(private readonly transactions: ScopedPostgresTransactionRunner) {}

  execute<Result>(
    command: Readonly<IdempotentCommand<Result>>,
    handler: (transaction: ScopedTransaction) => Promise<CommandOutcome<Result>>,
  ): Promise<CommandExecution<Result>> {
    validateCommand(command)
    return this.transactions.run(command.scope, async (transaction) => {
      const claim = await claimIdempotency(transaction, command)
      if (claim.kind === 'replay') {
        return {
          value: command.resultCodec.decode(readStoredResult(claim.responseBody)),
          replayed: true,
        }
      }

      const outcome = await handler(transaction)
      for (const auditEvent of outcome.auditEvents) {
        await appendAuditEvent(transaction, auditEvent)
      }
      for (const outboxMessage of outcome.outboxMessages) {
        await appendOutboxMessage(transaction, outboxMessage)
      }
      await completeIdempotency(transaction, command, outcome.result)
      return { value: outcome.result, replayed: false }
    })
  }
}

export function hashRequestFingerprint(requestFingerprint: string): string {
  if (requestFingerprint.length === 0) throw new TypeError('requestFingerprint must not be empty')
  return createHash('sha256').update(requestFingerprint, 'utf8').digest('hex')
}

async function claimIdempotency<Result>(
  transaction: ScopedTransaction,
  command: Readonly<IdempotentCommand<Result>>,
): Promise<{ kind: 'acquired' } | { kind: 'replay'; responseBody: unknown }> {
  const requestHash = hashRequestFingerprint(command.requestFingerprint)
  const values = [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    command.operationScope,
    command.idempotencyKey,
    requestHash,
    command.lockMs ?? DEFAULT_LOCK_MS,
    command.ttlMs ?? DEFAULT_TTL_MS,
  ] as const

  // A cleanup worker may delete an expired row after INSERT observes the conflict
  // but before the following SELECT locks it. Retry the claim in that narrow race.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const inserted = await transaction.query<{ id: string }>(`
      INSERT INTO mbox.idempotency_records (
        tenant_id, store_id, operation_scope, idempotency_key, request_sha256,
        status, locked_until, expires_at
      ) VALUES (
        $1::uuid, $2::uuid, $3, $4, $5, 'processing',
        clock_timestamp() + ($6::bigint * interval '1 millisecond'),
        clock_timestamp() + ($7::bigint * interval '1 millisecond')
      )
      ON CONFLICT (tenant_id, store_id, operation_scope, idempotency_key) DO NOTHING
      RETURNING id
    `, [...values])
    if (inserted.rowCount === 1) return { kind: 'acquired' }

    const selected = await transaction.query<IdempotencyRow>(`
      SELECT id, request_sha256, status, response_snapshot,
        expires_at <= clock_timestamp() AS is_expired
      FROM mbox.idempotency_records
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND operation_scope = $3
        AND idempotency_key = $4
      FOR UPDATE
    `, values.slice(0, 4))
    const record = selected.rows[0]
    if (selected.rowCount !== 1 || record === undefined) {
      if (attempt < 2) continue
      throw new IdempotencyRecordError('Idempotency record disappeared while claiming the command')
    }
    if (record.is_expired) {
      const reclaimed = await transaction.query<{ id: string }>(`
        UPDATE mbox.idempotency_records
        SET request_sha256 = $6,
            status = 'processing',
            response_status = NULL,
            response_snapshot = NULL,
            resource_type = NULL,
            resource_id = NULL,
            locked_until = clock_timestamp() + ($7::bigint * interval '1 millisecond'),
            expires_at = clock_timestamp() + ($8::bigint * interval '1 millisecond'),
            created_at = clock_timestamp(),
            updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid
          AND store_id = $2::uuid
          AND operation_scope = $3
          AND idempotency_key = $4
          AND id = $5::uuid
          AND expires_at <= clock_timestamp()
        RETURNING id
      `, [values[0], values[1], values[2], values[3], record.id, values[4], values[5], values[6]])
      if (reclaimed.rowCount !== 1) {
        throw new IdempotencyRecordError('Expired idempotency record could not be reclaimed')
      }
      return { kind: 'acquired' }
    }
    if (record.request_sha256 !== requestHash) {
      throw new IdempotencyConflictError(command.operationScope, command.idempotencyKey)
    }
    if (record.status === 'completed') return { kind: 'replay', responseBody: record.response_snapshot }
    if (record.status === 'processing') {
      throw new IdempotencyInProgressError(command.operationScope, command.idempotencyKey)
    }
    throw new IdempotencyRecordError(
      `Idempotency record is failed and cannot be replayed: ${command.operationScope}/${command.idempotencyKey}`,
    )
  }
  throw new IdempotencyRecordError('Idempotency claim retry budget was exhausted')
}

async function completeIdempotency<Result>(
  transaction: ScopedTransaction,
  command: Readonly<IdempotentCommand<Result>>,
  result: Result,
): Promise<void> {
  const responseBody = JSON.stringify({ result: command.resultCodec.encode(result) })
  const completed = await transaction.query(`
    UPDATE mbox.idempotency_records
    SET status = 'completed',
        response_status = 200,
        response_snapshot = $5::jsonb,
        locked_until = NULL,
        updated_at = clock_timestamp()
    WHERE tenant_id = $1::uuid
      AND store_id = $2::uuid
      AND operation_scope = $3
      AND idempotency_key = $4
      AND status = 'processing'
      AND request_sha256 = $6
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    command.operationScope,
    command.idempotencyKey,
    responseBody,
    hashRequestFingerprint(command.requestFingerprint),
  ])
  if (completed.rowCount !== 1) {
    throw new IdempotencyRecordError('Idempotency record could not be marked completed')
  }
}

export async function appendAuditEvent(
  transaction: ScopedTransaction,
  event: Readonly<AuditEvent>,
): Promise<void> {
  validateAuditEvent(event)
  const inserted = await transaction.query(`
    INSERT INTO mbox.audit_events (
      tenant_id, store_id, actor_type, actor_employee_id, actor_ref,
      action, object_type, object_id, before_snapshot, after_snapshot, reason,
      request_id, trace_id, occurred_at,
      business_date, metadata
    ) VALUES (
      $1::uuid, $2::uuid, $3, $4::uuid, $5,
      $6, $7, $8, $9::jsonb, $10::jsonb, $11,
      $12, $13, COALESCE($14::timestamptz, clock_timestamp()),
      $15::date, $16::jsonb
    )
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    event.actor.type,
    event.actor.type === 'employee' ? event.actor.employeeId : null,
    event.actor.ref ?? null,
    event.action,
    event.objectType,
    event.objectId,
    event.beforeData === undefined || event.beforeData === null ? null : JSON.stringify(event.beforeData),
    event.afterData === undefined || event.afterData === null ? null : JSON.stringify(event.afterData),
    event.reason ?? null,
    event.requestId ?? null,
    event.traceId ?? null,
    event.occurredAt ?? null,
    event.businessDate,
    JSON.stringify(event.metadata ?? {}),
  ])
  if (inserted.rowCount !== 1) throw new Error('Audit event insert did not affect exactly one row')
}

export async function appendOutboxMessage(
  transaction: ScopedTransaction,
  message: Readonly<OutboxMessage>,
): Promise<void> {
  validateOutboxMessage(message)
  const messageKey = outboxMessageKey(message)
  const inserted = await transaction.query<{ message_key: string }>(`
    INSERT INTO mbox.outbox_messages (
      tenant_id, store_id, message_key, aggregate_type, aggregate_id,
      aggregate_version, message_type, payload, headers, occurred_at, available_at
    ) VALUES (
      $1::uuid, $2::uuid, $3, $4, $5::uuid,
      $6::bigint, $7, $8::jsonb, $9::jsonb,
      COALESCE($10::timestamptz, clock_timestamp()),
      COALESCE($11::timestamptz, clock_timestamp())
    )
    ON CONFLICT (tenant_id, store_id, message_key) DO NOTHING
    RETURNING message_key
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    messageKey,
    message.aggregateType,
    message.aggregateId,
    message.aggregateVersion,
    message.eventType,
    JSON.stringify(message.payload),
    JSON.stringify(message.headers ?? {}),
    message.occurredAt ?? null,
    message.availableAt ?? null,
  ])
  if (inserted.rowCount === 1) return

  const existing = await transaction.query<ExistingOutboxMessageRow>(`
    SELECT message_key, aggregate_type, aggregate_id, aggregate_version,
      message_type, payload, headers
    FROM mbox.outbox_messages
    WHERE tenant_id = $1::uuid
      AND store_id = $2::uuid
      AND message_key = $3
  `, [transaction.scope.tenantId, transaction.scope.storeId, messageKey])
  const row = existing.rows[0]
  if (existing.rowCount !== 1 || row === undefined || !sameOutboxMessage(row, message)) {
    throw new OutboxMessageConflictError(messageKey)
  }
}

function outboxMessageKey(message: Readonly<OutboxMessage>): string {
  if (message.businessEventKey) return message.businessEventKey
  if (message.eventId) return message.eventId
  const identity = `${message.aggregateType}:${message.aggregateId}:${message.aggregateVersion}:${message.eventType}`
  return `outbox:${createHash('sha256').update(identity).digest('hex')}`
}

function readStoredResult(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || !Object.hasOwn(value, 'result')) {
    throw new IdempotencyRecordError('Completed idempotency record contains an invalid response body')
  }
  return (value as StoredResultEnvelope).result
}

function validateCommand<Result>(command: Readonly<IdempotentCommand<Result>>): void {
  if (!OPERATION_SCOPE_PATTERN.test(command.operationScope)) {
    throw new TypeError('operationScope must match ^[a-z][a-z0-9_.-]{2,127}$')
  }
  if (command.idempotencyKey.length < 8 || command.idempotencyKey.length > 128) {
    throw new TypeError('idempotencyKey must contain between 8 and 128 characters')
  }
  hashRequestFingerprint(command.requestFingerprint)
  positiveInteger('ttlMs', command.ttlMs ?? DEFAULT_TTL_MS)
  positiveInteger('lockMs', command.lockMs ?? DEFAULT_LOCK_MS)
}

function validateAuditEvent(event: Readonly<AuditEvent>): void {
  if (event.action.trim().length === 0) throw new TypeError('audit action must not be blank')
  if (event.objectType.trim().length === 0) throw new TypeError('audit objectType must not be blank')
  if (event.objectId.trim().length === 0) throw new TypeError('audit objectId must not be blank')
  if (
    event.beforeData === undefined
    && event.afterData === undefined
    && (event.reason === undefined || event.reason === null)
  ) {
    throw new TypeError('audit event requires beforeData, afterData, or reason')
  }
}

function validateOutboxMessage(message: Readonly<OutboxMessage>): void {
  if (message.aggregateType.trim().length === 0) throw new TypeError('aggregateType must not be blank')
  if (message.aggregateId.trim().length === 0) throw new TypeError('aggregateId must not be blank')
  positiveInteger('aggregateVersion', message.aggregateVersion)
  if (message.eventType.trim().length === 0) throw new TypeError('eventType must not be blank')
  const explicitKey = message.businessEventKey ?? message.eventId
  if (explicitKey !== undefined && (explicitKey.length < 8 || explicitKey.length > 160)) {
    throw new TypeError('outbox business event key must contain between 8 and 160 characters')
  }
}

function sameOutboxMessage(
  row: ExistingOutboxMessageRow,
  message: Readonly<OutboxMessage>,
): boolean {
  return row.aggregate_type === message.aggregateType
    && row.aggregate_id === message.aggregateId
    && Number(row.aggregate_version) === message.aggregateVersion
    && row.message_type === message.eventType
    && stableJson(row.payload) === stableJson(message.payload)
    && stableJson(row.headers) === stableJson(message.headers ?? {})
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`)
  return value
}
