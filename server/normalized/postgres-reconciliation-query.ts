import type {
  ReconciliationListInput,
  ReconciliationListResult,
  ReconciliationQueryPort,
} from './payment-api.js'
import { sanitizeProviderSnapshot } from './payment-security-policy.js'
import type { ReconciliationEntry, ReconciliationEntryType } from './reconciliation-repository.js'
import type { ScopedPostgresTransactionRunner } from './transaction-runner.js'

interface ReconciliationRow extends Record<string, unknown> {
  id: string
  payment_id: string | null
  refund_id: string | null
  entry_type: ReconciliationEntryType
  provider: string
  provider_reference: string
  amount_minor: string | number
  currency: string
  business_date: string
  occurred_at: string
  evidence_snapshot: Record<string, never>
  created_at: string
}

interface ReconciliationCursor {
  occurredAt: string
  id: string
}

export class PostgresReconciliationQuery implements ReconciliationQueryPort {
  constructor(private readonly transactions: ScopedPostgresTransactionRunner) {}

  list(input: Readonly<ReconciliationListInput>): Promise<ReconciliationListResult> {
    validateInput(input)
    const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor)
    return this.transactions.run(input.scope, async (transaction) => {
      const result = await transaction.query<ReconciliationRow>(`
        SELECT id, payment_id, refund_id, entry_type, provider, provider_reference,
          amount_minor, currency, business_date::text, occurred_at::text,
          evidence_snapshot, created_at::text
        FROM mbox.reconciliation_entries
        WHERE tenant_id = $1::uuid
          AND store_id = $2::uuid
          AND business_date = $3::date
          AND ($4::text IS NULL OR entry_type = $4)
          AND (
            $5::timestamptz IS NULL
            OR (occurred_at, id) < ($5::timestamptz, $6::uuid)
          )
        ORDER BY occurred_at DESC, id DESC
        LIMIT $7
      `, [
        input.scope.tenantId,
        input.scope.storeId,
        input.businessDate,
        input.entryType ?? null,
        cursor?.occurredAt ?? null,
        cursor?.id ?? null,
        input.limit + 1,
      ])
      const hasMore = result.rows.length > input.limit
      const visibleRows = result.rows.slice(0, input.limit)
      const entries = visibleRows.map(mapEntry)
      const last = hasMore ? visibleRows.at(-1) : undefined
      return {
        entries,
        nextCursor: last === undefined ? null : encodeCursor({ occurredAt: last.occurred_at, id: last.id }),
      }
    }, { readOnly: true })
  }
}

function validateInput(input: Readonly<ReconciliationListInput>): void {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  if (!uuid.test(input.scope.tenantId) || !uuid.test(input.scope.storeId) || !uuid.test(input.employeeId)) {
    throw new TypeError('reconciliation scope or employee is invalid')
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate)) {
    throw new TypeError('reconciliation businessDate is invalid')
  }
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 200) {
    throw new TypeError('reconciliation limit must be between 1 and 200')
  }
}

function mapEntry(row: ReconciliationRow): ReconciliationEntry {
  const amountMinor = Number(row.amount_minor)
  if (!Number.isSafeInteger(amountMinor)) throw new RangeError('reconciliation amount exceeds safe range')
  return {
    id: row.id,
    paymentId: row.payment_id,
    refundId: row.refund_id,
    entryType: row.entry_type,
    provider: row.provider,
    providerReference: row.provider_reference,
    amountMinor,
    currency: row.currency,
    businessDate: row.business_date,
    occurredAt: row.occurred_at,
    evidenceSnapshot: sanitizeProviderSnapshot(row.evidence_snapshot),
    createdAt: row.created_at,
  }
}

function encodeCursor(cursor: Readonly<ReconciliationCursor>): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function decodeCursor(value: string): ReconciliationCursor {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch {
    throw new TypeError('reconciliation cursor is invalid')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('reconciliation cursor is invalid')
  }
  const occurredAt = Reflect.get(parsed, 'occurredAt')
  const id = Reflect.get(parsed, 'id')
  if (
    typeof occurredAt !== 'string'
    || !Number.isFinite(Date.parse(occurredAt))
    || typeof id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
  ) {
    throw new TypeError('reconciliation cursor is invalid')
  }
  return { occurredAt, id }
}
