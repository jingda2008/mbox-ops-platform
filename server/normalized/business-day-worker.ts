import type { JsonObject } from './command-executor.js'
import {
  ScopedPostgresTransactionRunner,
  type ScopedTransaction,
  type StoreScope,
} from './transaction-runner.js'

interface StoreClockRow extends Record<string, unknown> {
  business_date: string
  timezone: string
  cutoff: string
}

interface BusinessDayRow extends Record<string, unknown> {
  id: string
  business_date: string
  status: 'open' | 'awaiting_close' | 'closed'
}

export interface BusinessDayRolloverResult {
  businessDate: string
  timezone: string
  cutoff: string
  created: boolean
  rolledOverBusinessDayIds: string[]
}

export class BusinessDayRolloverWorker {
  constructor(private readonly transactions: ScopedPostgresTransactionRunner) {}

  run(scope: Readonly<StoreScope>, workerId: string): Promise<BusinessDayRolloverResult> {
    assertWorkerId(workerId)
    return this.transactions.run(scope, async (transaction) => {
      const clock = await readStoreClock(transaction)
      const stale = await claimStaleOpenDays(transaction, clock.business_date)
      const created = await ensureCurrentBusinessDay(transaction, clock.business_date)

      for (const row of stale) {
        await writeAudit(transaction, {
          action: 'business_day.rolled_over',
          objectId: row.id,
          businessDate: clock.business_date,
          before: { businessDate: row.business_date, status: row.status },
          after: { businessDate: row.business_date, status: 'awaiting_close' },
          workerId,
        })
        await writeOutbox(transaction, row.id, 'business_day.awaiting-close.v1', {
          businessDayId: row.id,
          businessDate: row.business_date,
          status: 'awaiting_close',
        })
      }
      if (created) {
        await writeAudit(transaction, {
          action: 'business_day.opened',
          objectId: created.id,
          businessDate: clock.business_date,
          before: null,
          after: { businessDate: created.business_date, status: created.status },
          workerId,
        })
        await writeOutbox(transaction, created.id, 'business_day.opened.v1', {
          businessDayId: created.id,
          businessDate: created.business_date,
          status: created.status,
        })
      }
      return {
        businessDate: clock.business_date,
        timezone: clock.timezone,
        cutoff: clock.cutoff,
        created: created !== null,
        rolledOverBusinessDayIds: stale.map((row) => row.id),
      }
    }, { isolation: 'serializable', retryOnConflict: 2 })
  }
}

async function readStoreClock(transaction: ScopedTransaction): Promise<StoreClockRow> {
  const result = await transaction.query<StoreClockRow>(`
    SELECT
      (((clock_timestamp() AT TIME ZONE timezone) - business_day_cutoff)::date)::text
        AS business_date,
      timezone,
      business_day_cutoff::text AS cutoff
    FROM mbox.stores
    WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'active'
    FOR KEY SHARE
  `, [transaction.scope.tenantId, transaction.scope.storeId])
  const row = result.rows[0]
  if (!row) throw new Error('当前门店不可用')
  return row
}

async function claimStaleOpenDays(
  transaction: ScopedTransaction,
  businessDate: string,
): Promise<BusinessDayRow[]> {
  const result = await transaction.query<BusinessDayRow>(`
    WITH candidates AS (
      SELECT id
      FROM mbox.business_days
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND status = 'open' AND business_date < $3::date
      ORDER BY business_date, id
      FOR UPDATE SKIP LOCKED
      LIMIT 50
    )
    UPDATE mbox.business_days AS day
    SET status = 'awaiting_close', rollover_at = clock_timestamp()
    FROM candidates
    WHERE day.tenant_id = $1::uuid AND day.store_id = $2::uuid
      AND day.id = candidates.id
    RETURNING day.id, day.business_date::text, day.status
  `, [transaction.scope.tenantId, transaction.scope.storeId, businessDate])
  return result.rows
}

async function ensureCurrentBusinessDay(
  transaction: ScopedTransaction,
  businessDate: string,
): Promise<BusinessDayRow | null> {
  const result = await transaction.query<BusinessDayRow>(`
    INSERT INTO mbox.business_days (tenant_id, store_id, business_date, status)
    VALUES ($1::uuid, $2::uuid, $3::date, 'open')
    ON CONFLICT (tenant_id, store_id, business_date) DO NOTHING
    RETURNING id, business_date::text, status
  `, [transaction.scope.tenantId, transaction.scope.storeId, businessDate])
  return result.rows[0] ?? null
}

async function writeAudit(transaction: ScopedTransaction, input: Readonly<{
  action: string
  objectId: string
  businessDate: string
  before: JsonObject | null
  after: JsonObject
  workerId: string
}>): Promise<void> {
  await transaction.query(`
    INSERT INTO mbox.audit_events (
      tenant_id, store_id, actor_type, actor_ref, action, object_type,
      object_id, before_snapshot, after_snapshot, business_date, metadata
    ) VALUES (
      $1::uuid, $2::uuid, 'system', $3, $4, 'business_day',
      $5, $6::jsonb, $7::jsonb, $8::date, jsonb_build_object('workerId', $3::text)
    )
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    input.workerId,
    input.action,
    input.objectId,
    input.before === null ? null : JSON.stringify(input.before),
    JSON.stringify(input.after),
    input.businessDate,
  ])
}

async function writeOutbox(
  transaction: ScopedTransaction,
  aggregateId: string,
  messageType: string,
  payload: JsonObject,
): Promise<void> {
  await transaction.query(`
    INSERT INTO mbox.outbox_messages (
      tenant_id, store_id, message_key, aggregate_type, aggregate_id,
      aggregate_version, message_type, payload
    ) VALUES (
      $1::uuid, $2::uuid, $3, 'business_day', $4::uuid, 1, $5, $6::jsonb
    ) ON CONFLICT (tenant_id, store_id, message_key) DO NOTHING
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    `${messageType}:${aggregateId}`,
    aggregateId,
    messageType,
    JSON.stringify(payload),
  ])
}

function assertWorkerId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,95}$/.test(value)) {
    throw new TypeError('workerId格式无效')
  }
}
