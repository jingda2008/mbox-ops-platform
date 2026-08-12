import { describe, expect, it } from 'vitest'
import {
  ReconciliationConflictError,
  ReconciliationRepository,
} from './reconciliation-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const paymentId = '33333333-3333-4333-8333-333333333333'

describe('ReconciliationRepository', () => {
  it('only appends a reconciliation entry and never emits update or delete SQL', async () => {
    const transaction = new ScriptedTransaction([rows([entryRow()])])
    const entry = await new ReconciliationRepository(transaction).append(paymentInput())

    expect(entry.amountMinor).toBe(8800)
    expect(transaction.calls[0]).toContain('INSERT INTO mbox.reconciliation_entries')
    expect(transaction.calls[0]).toContain('ON CONFLICT')
    expect(transaction.calls[0]).not.toMatch(/\bUPDATE\b|\bDELETE\b/)
  })

  it('replays identical provider evidence but rejects a conflicting duplicate', async () => {
    const replay = new ScriptedTransaction([
      rows([], 0),
      rows([entryRow()]),
    ])
    await expect(new ReconciliationRepository(replay).append(paymentInput()))
      .resolves.toMatchObject({ providerReference: 'provider-payment-001', amountMinor: 8800 })

    const conflict = new ScriptedTransaction([
      rows([], 0),
      rows([{ ...entryRow(), amount_minor: '9900' }]),
    ])
    await expect(new ReconciliationRepository(conflict).append(paymentInput()))
      .rejects.toBeInstanceOf(ReconciliationConflictError)
  })
})

class ScriptedTransaction implements ScopedTransaction {
  readonly scope = { tenantId, storeId }
  readonly calls: string[] = []
  constructor(private readonly responses: Response[]) {}
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
  ): Promise<{ rows: Row[]; rowCount: number }> {
    this.calls.push(text.replace(/\s+/g, ' ').trim())
    const response = this.responses.shift()
    if (response === undefined) throw new Error('Unexpected query')
    return { rows: response.data as Row[], rowCount: response.rowCount }
  }
}

interface Response { data: Record<string, unknown>[]; rowCount: number }
function rows(data: Record<string, unknown>[], rowCount = data.length): Response {
  return { data, rowCount }
}

function paymentInput() {
  return {
    paymentId,
    entryType: 'payment' as const,
    provider: 'postar',
    providerReference: 'provider-payment-001',
    amountMinor: 8800,
    currency: 'CNY',
    businessDate: '2026-08-11',
    occurredAt: '2026-08-11T12:00:00.000Z',
    evidenceSnapshot: { signatureVerified: true, signature: 'must-not-persist' },
  }
}

function entryRow(): Record<string, unknown> {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    payment_id: paymentId,
    refund_id: null,
    entry_type: 'payment',
    provider: 'postar',
    provider_reference: 'provider-payment-001',
    amount_minor: '8800',
    currency: 'CNY',
    business_date: '2026-08-11',
    occurred_at: '2026-08-11T12:00:00.000Z',
    evidence_snapshot: { signatureVerified: true },
    created_at: '2026-08-11T12:00:01.000Z',
  }
}
