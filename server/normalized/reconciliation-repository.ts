import type { JsonObject } from './command-executor.js'
import { sanitizeProviderSnapshot } from './payment-security-policy.js'
import type { ScopedTransaction } from './transaction-runner.js'

export type ReconciliationEntryType = 'payment' | 'refund' | 'fee' | 'adjustment'

export interface ReconciliationEntry {
  id: string
  paymentId: string | null
  refundId: string | null
  entryType: ReconciliationEntryType
  provider: string
  providerReference: string
  amountMinor: number
  currency: string
  businessDate: string
  occurredAt: string
  evidenceSnapshot: JsonObject
  createdAt: string
}

export interface AppendReconciliationEntryInput {
  paymentId?: string | null
  refundId?: string | null
  entryType: ReconciliationEntryType
  provider: string
  providerReference: string
  amountMinor: number
  currency: string
  businessDate: string
  occurredAt: string
  evidenceSnapshot?: JsonObject
}

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
  evidence_snapshot: JsonObject
  created_at: string
}

export class ReconciliationConflictError extends Error {
  constructor(provider: string, reference: string, entryType: ReconciliationEntryType) {
    super(`Reconciliation identity conflicts with different evidence: ${provider}/${reference}/${entryType}`)
    this.name = 'ReconciliationConflictError'
  }
}

export class ReconciliationRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async append(input: Readonly<AppendReconciliationEntryInput>): Promise<ReconciliationEntry> {
    validateInput(input)
    const evidence = sanitizeProviderSnapshot(input.evidenceSnapshot)
    const inserted = await this.transaction.query<ReconciliationRow>(`
      INSERT INTO mbox.reconciliation_entries (
        tenant_id, store_id, payment_id, refund_id, entry_type,
        provider, provider_reference, amount_minor, currency,
        business_date, occurred_at, evidence_snapshot
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5,
        $6, $7, $8::bigint, $9,
        $10::date, $11::timestamptz, $12::jsonb
      )
      ON CONFLICT (tenant_id, store_id, provider, provider_reference, entry_type)
      DO NOTHING
      RETURNING ${RECONCILIATION_COLUMNS}
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.paymentId ?? null,
      input.refundId ?? null,
      input.entryType,
      input.provider,
      input.providerReference,
      input.amountMinor,
      input.currency,
      input.businessDate,
      input.occurredAt,
      JSON.stringify(evidence),
    ])
    const row = inserted.rows[0]
    if (inserted.rowCount === 1 && row !== undefined) return mapEntry(row)

    const existing = await this.transaction.query<ReconciliationRow>(`
      SELECT ${RECONCILIATION_COLUMNS}
      FROM mbox.reconciliation_entries
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND provider = $3
        AND provider_reference = $4
        AND entry_type = $5
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.provider,
      input.providerReference,
      input.entryType,
    ])
    const existingRow = existing.rows[0]
    if (existingRow === undefined || !sameEntry(existingRow, input, evidence)) {
      throw new ReconciliationConflictError(input.provider, input.providerReference, input.entryType)
    }
    return mapEntry(existingRow)
  }
}

const RECONCILIATION_COLUMNS = `
  id, payment_id, refund_id, entry_type, provider, provider_reference,
  amount_minor, currency, business_date::text, occurred_at::text,
  evidence_snapshot, created_at::text
`

function validateInput(input: Readonly<AppendReconciliationEntryInput>): void {
  if (input.provider.trim().length === 0) throw new TypeError('provider must not be blank')
  if (input.providerReference.trim().length === 0) {
    throw new TypeError('providerReference must not be blank')
  }
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor === 0) {
    throw new TypeError('amountMinor must be a non-zero safe integer')
  }
  if (input.entryType === 'payment' && (input.amountMinor < 0 || !input.paymentId)) {
    throw new TypeError('payment reconciliation requires a payment id and positive amount')
  }
  if (input.entryType === 'refund' && (input.amountMinor > 0 || !input.refundId)) {
    throw new TypeError('refund reconciliation requires a refund id and negative amount')
  }
  if (!/^[A-Z]{3}$/.test(input.currency)) throw new TypeError('currency is invalid')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate)) {
    throw new TypeError('businessDate must use YYYY-MM-DD')
  }
}

function sameEntry(
  row: ReconciliationRow,
  input: Readonly<AppendReconciliationEntryInput>,
  evidence: JsonObject,
): boolean {
  return row.payment_id === (input.paymentId ?? null)
    && row.refund_id === (input.refundId ?? null)
    && Number(row.amount_minor) === input.amountMinor
    && row.currency === input.currency
    && row.business_date === input.businessDate
    && sameInstant(row.occurred_at, input.occurredAt)
    && stableJson(row.evidence_snapshot) === stableJson(evidence)
}

function sameInstant(left: string, right: string): boolean {
  const leftTime = Date.parse(left)
  const rightTime = Date.parse(right)
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime === rightTime
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
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
    evidenceSnapshot: row.evidence_snapshot,
    createdAt: row.created_at,
  }
}
