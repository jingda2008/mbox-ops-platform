import type { JsonObject } from './command-executor.js'
import type { ScopedTransaction, StoreScope } from './transaction-runner.js'
import { ScopedPostgresTransactionRunner } from './transaction-runner.js'

export interface ClaimedOutboxMessage {
  id: string
  messageKey: string
  aggregateType: string
  aggregateId: string
  aggregateVersion: number
  messageType: string
  payload: JsonObject
  headers: JsonObject
  attempts: number
  occurredAt: string
}

export interface OutboxBatchResult {
  claimed: number
  delivered: string[]
  failed: string[]
}

export type OutboxDelivery = (message: Readonly<ClaimedOutboxMessage>) => Promise<void>

interface OutboxRow extends Record<string, unknown> {
  id: string
  message_key: string
  aggregate_type: string
  aggregate_id: string
  aggregate_version: string | number
  message_type: string
  payload: JsonObject
  headers: JsonObject
  attempts: number
  occurred_at: string
}

type TransactionExecutor = Pick<ScopedPostgresTransactionRunner, 'run'>

export class OutboxDispatcher {
  constructor(private readonly transactions: TransactionExecutor) {}

  async runBatch(
    scope: Readonly<StoreScope>,
    workerId: string,
    deliver: OutboxDelivery,
    options: Readonly<{ limit?: number; staleLockMs?: number; retryDelayMs?: number }> = {},
  ): Promise<OutboxBatchResult> {
    if (workerId.trim().length < 3 || workerId.length > 128) {
      throw new TypeError('workerId must contain between 3 and 128 characters')
    }
    const limit = clampInteger(options.limit ?? 50, 1, 50, 'limit')
    const staleLockMs = clampInteger(options.staleLockMs ?? 60_000, 1_000, 30 * 60_000, 'staleLockMs')
    const retryDelayMs = clampInteger(options.retryDelayMs ?? 5_000, 1_000, 60 * 60_000, 'retryDelayMs')
    const claimed = await this.transactions.run(scope, (transaction) => (
      claimMessages(transaction, workerId, limit, staleLockMs)
    ))

    const result: OutboxBatchResult = { claimed: claimed.length, delivered: [], failed: [] }
    for (const message of claimed) {
      try {
        await deliver(message)
        const marked = await this.transactions.run(scope, (transaction) => (
          markDelivered(transaction, message.id, workerId)
        ))
        if (marked) result.delivered.push(message.id)
        else result.failed.push(message.id)
      } catch (error) {
        await this.transactions.run(scope, (transaction) => releaseFailed(
          transaction,
          message.id,
          workerId,
          retryDelayMs,
          safeFailureCode(error),
        ))
        result.failed.push(message.id)
      }
    }
    return result
  }
}

async function claimMessages(
  transaction: ScopedTransaction,
  workerId: string,
  limit: number,
  staleLockMs: number,
): Promise<ClaimedOutboxMessage[]> {
  const result = await transaction.query<OutboxRow>(`
    WITH candidates AS (
      SELECT id
      FROM mbox.outbox_messages
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND delivered_at IS NULL
        AND available_at <= clock_timestamp()
        AND (
          locked_at IS NULL
          OR locked_at < clock_timestamp() - ($5::bigint * interval '1 millisecond')
        )
      ORDER BY available_at, created_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT $4
    )
    UPDATE mbox.outbox_messages message
    SET locked_by = $3,
        locked_at = clock_timestamp(),
        attempts = message.attempts + 1
    FROM candidates
    WHERE message.tenant_id = $1::uuid
      AND message.store_id = $2::uuid
      AND message.id = candidates.id
    RETURNING message.id, message.message_key, message.aggregate_type,
      message.aggregate_id, message.aggregate_version, message.message_type,
      message.payload, message.headers, message.attempts, message.occurred_at::text
  `, [transaction.scope.tenantId, transaction.scope.storeId, workerId, limit, staleLockMs])
  return result.rows.map(mapMessage)
}

async function markDelivered(
  transaction: ScopedTransaction,
  messageId: string,
  workerId: string,
): Promise<boolean> {
  const result = await transaction.query(`
    UPDATE mbox.outbox_messages
    SET delivered_at = clock_timestamp(),
        locked_by = NULL,
        locked_at = NULL,
        last_error = NULL
    WHERE tenant_id = $1::uuid
      AND store_id = $2::uuid
      AND id = $3::uuid
      AND delivered_at IS NULL
      AND locked_by = $4
  `, [transaction.scope.tenantId, transaction.scope.storeId, messageId, workerId])
  return result.rowCount === 1
}

async function releaseFailed(
  transaction: ScopedTransaction,
  messageId: string,
  workerId: string,
  retryDelayMs: number,
  failureCode: string,
): Promise<void> {
  await transaction.query(`
    UPDATE mbox.outbox_messages
    SET locked_by = NULL,
        locked_at = NULL,
        available_at = clock_timestamp() + ($5::bigint * interval '1 millisecond'),
        last_error = $6
    WHERE tenant_id = $1::uuid
      AND store_id = $2::uuid
      AND id = $3::uuid
      AND delivered_at IS NULL
      AND locked_by = $4
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    messageId,
    workerId,
    retryDelayMs,
    failureCode,
  ])
}

function mapMessage(row: OutboxRow): ClaimedOutboxMessage {
  const version = Number(row.aggregate_version)
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new RangeError('Outbox aggregate version exceeds the supported integer range')
  }
  return {
    id: row.id,
    messageKey: row.message_key,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    aggregateVersion: version,
    messageType: row.message_type,
    payload: row.payload,
    headers: row.headers,
    attempts: row.attempts,
    occurredAt: row.occurred_at,
  }
}

function safeFailureCode(error: unknown): string {
  const rawName = error instanceof Error ? error.name : 'UnknownError'
  const name = rawName.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 48) || 'UnknownError'
  return `delivery_failed:${name}`
}

function clampInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}
