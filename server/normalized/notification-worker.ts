import type { JsonObject } from './command-executor.js'
import type { ScopedTransaction, StoreScope } from './transaction-runner.js'
import { ScopedPostgresTransactionRunner } from './transaction-runner.js'
import type { NotificationChannel, NotificationRecipientType } from './notification-repository.js'

export interface ClaimedNotification {
  id: string
  businessKey: string
  channel: NotificationChannel
  recipientType: NotificationRecipientType
  recipientId: string
  templateCode: string
  payload: JsonObject
  attempts: number
  maxAttempts: number
}

export interface NotificationDeliveryRequest extends ClaimedNotification {
  idempotencyKey: string
}

export interface NotificationBatchResult {
  claimed: number
  delivered: string[]
  retrying: string[]
  dead: string[]
  lost: string[]
}

export type NotificationDelivery = (request: Readonly<NotificationDeliveryRequest>) => Promise<void>

interface NotificationRow extends Record<string, unknown> {
  id: string
  business_key: string
  channel: NotificationChannel
  recipient_type: NotificationRecipientType
  recipient_id: string
  template_code: string
  payload: JsonObject
  attempts: number
  max_attempts: number
}

interface ClaimedNotificationBatch {
  claimed: ClaimedNotification[]
  exhausted: string[]
}

type TransactionExecutor = Pick<ScopedPostgresTransactionRunner, 'run'>

export class NotificationDeliveryError extends Error {
  readonly stableCode: string
  constructor(stableCode: string) {
    super('Notification delivery failed')
    this.name = 'NotificationDeliveryError'
    this.stableCode = normalizeFailureCode(stableCode)
  }
}

export class NotificationWorker {
  constructor(private readonly transactions: TransactionExecutor) {}

  async runBatch(
    scope: Readonly<StoreScope>,
    workerId: string,
    deliver: NotificationDelivery,
    options: Readonly<{
      limit?: number
      staleLockMs?: number
      baseRetryDelayMs?: number
      maxRetryDelayMs?: number
    }> = {},
  ): Promise<NotificationBatchResult> {
    validateWorkerId(workerId)
    const limit = clampInteger(options.limit ?? 50, 1, 50, 'limit')
    const staleLockMs = clampInteger(options.staleLockMs ?? 60_000, 1_000, 30 * 60_000, 'staleLockMs')
    const baseRetryDelayMs = clampInteger(options.baseRetryDelayMs ?? 5_000, 1_000, 60 * 60_000, 'baseRetryDelayMs')
    const maxRetryDelayMs = clampInteger(options.maxRetryDelayMs ?? 15 * 60_000, baseRetryDelayMs, 24 * 60 * 60_000, 'maxRetryDelayMs')
    const batch = await this.transactions.run(scope, (transaction) => claim(
      transaction, workerId, limit, staleLockMs,
    ))
    const result: NotificationBatchResult = {
      claimed: batch.claimed.length,
      delivered: [],
      retrying: [],
      dead: [...batch.exhausted],
      lost: [],
    }

    for (const notification of batch.claimed) {
      try {
        await deliver({ ...notification, idempotencyKey: notification.businessKey })
        const delivered = await this.transactions.run(scope, (transaction) => markDelivered(
          transaction, notification.id, workerId,
        ))
        if (delivered) result.delivered.push(notification.id)
        else result.lost.push(notification.id)
      } catch (error) {
        const terminal = notification.attempts >= notification.maxAttempts
        const marked = await this.transactions.run(scope, (transaction) => markFailure(
          transaction,
          notification,
          workerId,
          stableFailureCode(error),
          terminal,
          exponentialDelay(baseRetryDelayMs, maxRetryDelayMs, notification.attempts),
        ))
        if (marked) (terminal ? result.dead : result.retrying).push(notification.id)
        else result.lost.push(notification.id)
      }
    }
    return result
  }
}

async function claim(
  transaction: ScopedTransaction,
  workerId: string,
  limit: number,
  staleLockMs: number,
): Promise<ClaimedNotificationBatch> {
  const exhausted = await transaction.query<{ id: string }>(`
    WITH candidates AS (
      SELECT id
      FROM mbox.notifications
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND status = 'sending'
        AND attempts >= max_attempts
        AND locked_at < clock_timestamp() - ($4::bigint * interval '1 millisecond')
      ORDER BY locked_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT $3
    )
      UPDATE mbox.notifications
      SET status = 'dead',
          dead_at = clock_timestamp(),
          locked_by = NULL,
          locked_at = NULL,
          last_error = COALESCE(last_error, 'delivery_failed:worker_lost')
      FROM candidates
      WHERE notifications.tenant_id = $1::uuid
        AND notifications.store_id = $2::uuid
        AND notifications.id = candidates.id
      RETURNING notifications.id
  `, [transaction.scope.tenantId, transaction.scope.storeId, limit, staleLockMs])
  const result = await transaction.query<NotificationRow>(`
    WITH candidates AS (
      SELECT id
      FROM mbox.notifications
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND attempts < max_attempts
        AND (
          (status IN ('pending', 'failed') AND available_at <= clock_timestamp())
          OR (
            status = 'sending'
            AND locked_at < clock_timestamp() - ($5::bigint * interval '1 millisecond')
          )
        )
      ORDER BY available_at, created_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT $4
    )
    UPDATE mbox.notifications notification
    SET status = 'sending',
        locked_by = $3,
        locked_at = clock_timestamp(),
        attempts = notification.attempts + 1,
        last_error = NULL
    FROM candidates
    WHERE notification.tenant_id = $1::uuid
      AND notification.store_id = $2::uuid
      AND notification.id = candidates.id
    RETURNING notification.id, notification.business_key, notification.channel,
      notification.recipient_type, notification.recipient_id, notification.template_code,
      notification.payload, notification.attempts, notification.max_attempts
  `, [transaction.scope.tenantId, transaction.scope.storeId, workerId, limit, staleLockMs])
  return {
    claimed: result.rows.map(mapClaimed),
    exhausted: exhausted.rows.map((row) => row.id),
  }
}

async function markDelivered(transaction: ScopedTransaction, id: string, workerId: string) {
  const result = await transaction.query(`
    UPDATE mbox.notifications
    SET status = 'delivered',
        delivered_at = clock_timestamp(),
        locked_by = NULL,
        locked_at = NULL,
        last_error = NULL
    WHERE tenant_id = $1::uuid
      AND store_id = $2::uuid
      AND id = $3::uuid
      AND status = 'sending'
      AND locked_by = $4
  `, [transaction.scope.tenantId, transaction.scope.storeId, id, workerId])
  return result.rowCount === 1
}

async function markFailure(
  transaction: ScopedTransaction,
  notification: Readonly<ClaimedNotification>,
  workerId: string,
  failureCode: string,
  terminal: boolean,
  retryDelayMs: number,
): Promise<boolean> {
  const result = await transaction.query(`
    UPDATE mbox.notifications
    SET status = CASE WHEN $5::boolean THEN 'dead' ELSE 'failed' END,
        dead_at = CASE WHEN $5::boolean THEN clock_timestamp() ELSE NULL END,
        available_at = CASE
          WHEN $5::boolean THEN available_at
          ELSE clock_timestamp() + ($6::bigint * interval '1 millisecond')
        END,
        locked_by = NULL,
        locked_at = NULL,
        last_error = $7
    WHERE tenant_id = $1::uuid
      AND store_id = $2::uuid
      AND id = $3::uuid
      AND status = 'sending'
      AND locked_by = $4
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    notification.id,
    workerId,
    terminal,
    retryDelayMs,
    failureCode,
  ])
  return result.rowCount === 1
}

function mapClaimed(row: NotificationRow): ClaimedNotification {
  return {
    id: row.id,
    businessKey: row.business_key,
    channel: row.channel,
    recipientType: row.recipient_type,
    recipientId: row.recipient_id,
    templateCode: row.template_code,
    payload: row.payload,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
  }
}

function stableFailureCode(error: unknown) {
  if (error instanceof NotificationDeliveryError) return error.stableCode
  return 'delivery_failed:unknown'
}

function normalizeFailureCode(value: string) {
  const normalized = value.trim().toLowerCase()
  if (!/^[a-z][a-z0-9_.:-]{2,95}$/.test(normalized)) return 'delivery_failed:invalid_code'
  return normalized
}

function exponentialDelay(baseMs: number, maximumMs: number, attempts: number) {
  const exponent = Math.max(0, Math.min(attempts - 1, 20))
  return Math.min(maximumMs, baseMs * (2 ** exponent))
}

function validateWorkerId(workerId: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/.test(workerId)) {
    throw new TypeError('workerId must be a stable internal identifier between 3 and 128 characters')
  }
}

function clampInteger(value: number, minimum: number, maximum: number, label: string) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}
