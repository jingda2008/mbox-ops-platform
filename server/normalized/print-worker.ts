import type { JsonObject } from './command-executor.js'
import { normalizeHardwareFailureCode, type ConnectivityStatus, type HardwareStation } from './hardware-repository.js'
import type { ScopedTransaction, StoreScope } from './transaction-runner.js'
import type { ScopedPostgresTransactionRunner } from './transaction-runner.js'

export interface PrintAdapterRequest {
  jobId: string
  idempotencyKey: string
  printerDeviceId: string
  printerCode: string
  stationCode: HardwareStation
  copies: number
  printSnapshot: JsonObject
  containsPriorityNote: boolean
}

export interface PrintAdapter {
  print(request: Readonly<PrintAdapterRequest>): Promise<void>
}

export interface PrintBatchResult {
  claimed: number
  printed: string[]
  retrying: string[]
  dead: string[]
  lost: string[]
}

interface ClaimedJob extends Record<string, unknown> {
  id: string
  business_key: string
  printer_device_id: string
  printer_code: string
  connectivity_status: ConnectivityStatus
  station_code: HardwareStation
  copies: number
  print_snapshot: JsonObject
  contains_priority_note: boolean
  attempts: number
  max_attempts: number
}

type TransactionRunner = Pick<ScopedPostgresTransactionRunner, 'run'>

export class PrintAdapterError extends Error {
  readonly failureCode: string
  constructor(failureCode: string) {
    super('Print adapter failed')
    this.name = 'PrintAdapterError'
    this.failureCode = normalizeHardwareFailureCode(failureCode)
  }
}

export class PrintWorker {
  constructor(private readonly transactions: TransactionRunner) {}

  async runBatch(
    scope: Readonly<StoreScope>,
    workerId: string,
    adapter: PrintAdapter,
    options: Readonly<{
      limit?: number
      staleLockMs?: number
      retryDelayMs?: number
    }> = {},
  ): Promise<PrintBatchResult> {
    const limit = integer(options.limit ?? 50, 1, 50, 'limit')
    const staleLockMs = integer(options.staleLockMs ?? 60_000, 1_000, 30 * 60_000, 'staleLockMs')
    const retryDelayMs = integer(options.retryDelayMs ?? 5_000, 1_000, 60 * 60_000, 'retryDelayMs')
    if (!/^[A-Za-z0-9_.:-]{3,96}$/.test(workerId)) throw new TypeError('workerId格式无效')
    const jobs = await this.transactions.run(scope, (transaction) => claimJobs(
      transaction, workerId, limit, staleLockMs,
    ))
    const result: PrintBatchResult = { claimed: jobs.length, printed: [], retrying: [], dead: [], lost: [] }

    for (const job of jobs) {
      try {
        if (job.connectivity_status !== 'online') throw new PrintAdapterError('device_offline')
        await adapter.print({
          jobId: job.id,
          idempotencyKey: job.business_key,
          printerDeviceId: job.printer_device_id,
          printerCode: job.printer_code,
          stationCode: job.station_code,
          copies: Number(job.copies),
          printSnapshot: job.print_snapshot,
          containsPriorityNote: job.contains_priority_note,
        })
        const changed = await this.transactions.run(scope, (transaction) => markPrinted(transaction, job, workerId))
        ;(changed ? result.printed : result.lost).push(job.id)
      } catch (error) {
        const terminal = Number(job.attempts) >= Number(job.max_attempts)
        const changed = await this.transactions.run(scope, (transaction) => markFailed(
          transaction,
          job,
          workerId,
          error instanceof PrintAdapterError ? error.failureCode : 'print_failed:unknown',
          terminal,
          retryDelayMs,
        ))
        if (!changed) result.lost.push(job.id)
        else (terminal ? result.dead : result.retrying).push(job.id)
      }
    }
    return result
  }
}

async function claimJobs(
  transaction: ScopedTransaction,
  workerId: string,
  limit: number,
  staleLockMs: number,
): Promise<ClaimedJob[]> {
  const result = await transaction.query<ClaimedJob>(`
    WITH candidates AS (
      SELECT job.id
      FROM mbox.print_jobs AS job
      WHERE job.tenant_id = $1::uuid AND job.store_id = $2::uuid
        AND job.delivery_mode = 'cloud_adapter'
        AND job.attempts < job.max_attempts
        AND (
          (job.status IN ('pending', 'failed') AND job.available_at <= clock_timestamp())
          OR (job.status = 'printing'
            AND job.locked_at < clock_timestamp() - ($5::bigint * interval '1 millisecond'))
        )
      ORDER BY job.contains_priority_note DESC, job.available_at, job.created_at, job.id
      FOR UPDATE SKIP LOCKED
      LIMIT $4
    )
    UPDATE mbox.print_jobs AS job
    SET status = 'printing', locked_by = $3, locked_at = clock_timestamp(),
        attempts = job.attempts + 1, last_error_code = NULL
    FROM candidates, mbox.devices AS device
    WHERE job.tenant_id = $1::uuid AND job.store_id = $2::uuid
      AND job.id = candidates.id
      AND device.tenant_id = job.tenant_id AND device.store_id = job.store_id
      AND device.id = job.printer_device_id
    RETURNING job.id, job.business_key, job.printer_device_id,
      device.code AS printer_code, device.connectivity_status,
      job.station_code, job.copies, job.print_snapshot, job.contains_priority_note,
      job.attempts, job.max_attempts
  `, [transaction.scope.tenantId, transaction.scope.storeId, workerId, limit, staleLockMs])
  return result.rows
}

async function markPrinted(transaction: ScopedTransaction, job: ClaimedJob, workerId: string) {
  const updated = await transaction.query(`
    UPDATE mbox.print_jobs
    SET status = 'printed', printed_at = clock_timestamp(),
        locked_by = NULL, locked_at = NULL, last_error_code = NULL
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      AND status = 'printing' AND locked_by = $4
  `, [transaction.scope.tenantId, transaction.scope.storeId, job.id, workerId])
  if (updated.rowCount !== 1) return false
  await appendEvent(transaction, job.id, 'printed', 'printing', 'printed', null)
  return true
}

async function markFailed(
  transaction: ScopedTransaction,
  job: ClaimedJob,
  workerId: string,
  failureCode: string,
  terminal: boolean,
  retryDelayMs: number,
) {
  const updated = await transaction.query(`
    UPDATE mbox.print_jobs
    SET status = CASE WHEN $5::boolean THEN 'dead' ELSE 'failed' END,
        dead_at = CASE WHEN $5::boolean THEN clock_timestamp() ELSE NULL END,
        available_at = CASE WHEN $5::boolean THEN available_at
          ELSE clock_timestamp() + ($6::bigint * interval '1 millisecond') END,
        locked_by = NULL, locked_at = NULL, last_error_code = $7
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      AND status = 'printing' AND locked_by = $4
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    job.id,
    workerId,
    terminal,
    retryDelayMs,
    normalizeHardwareFailureCode(failureCode),
  ])
  if (updated.rowCount !== 1) return false
  await appendEvent(
    transaction,
    job.id,
    terminal ? 'dead' : 'retry_scheduled',
    'printing',
    terminal ? 'dead' : 'failed',
    normalizeHardwareFailureCode(failureCode),
  )
  return true
}

async function appendEvent(
  transaction: ScopedTransaction,
  jobId: string,
  eventType: string,
  fromStatus: string,
  toStatus: string,
  failureCode: string | null,
) {
  await transaction.query(`
    INSERT INTO mbox.print_job_events (
      tenant_id, store_id, print_job_id, event_type, from_status, to_status,
      actor_type, failure_code
    ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, 'system', $7)
  `, [transaction.scope.tenantId, transaction.scope.storeId, jobId, eventType, fromStatus, toStatus, failureCode])
}

function integer(value: number, minimum: number, maximum: number, field: string) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new TypeError(`${field}格式无效`)
  return value
}
