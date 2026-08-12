import { describe, expect, it } from 'vitest'
import { PostgresReconciliationQuery } from './postgres-reconciliation-query.js'
import type { ScopedPostgresTransactionRunner, ScopedTransaction } from './transaction-runner.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const employeeId = '33333333-3333-4333-8333-333333333333'

describe('PostgresReconciliationQuery', () => {
  it('scopes, filters and paginates the normalized ledger without leaking evidence', async () => {
    const runner = new QueryRunner([entryRow(1), entryRow(2), entryRow(3)])
    const query = new PostgresReconciliationQuery(runner as unknown as ScopedPostgresTransactionRunner)
    const first = await query.list({
      scope: { tenantId, storeId },
      employeeId,
      businessDate: '2026-08-11',
      entryType: 'payment',
      limit: 2,
    })

    expect(first.entries).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()
    expect(first.entries[0]?.evidenceSnapshot).toEqual({
      signatureVerified: true,
      transactionState: '1',
    })
    expect(JSON.stringify(first.entries)).not.toContain('customer-phone')
    expect(runner.lastCall?.sql).toContain('tenant_id = $1::uuid')
    expect(runner.lastCall?.sql).toContain('ORDER BY occurred_at DESC, id DESC')
    expect(runner.lastCall?.values).toEqual([
      tenantId,
      storeId,
      '2026-08-11',
      'payment',
      null,
      null,
      3,
    ])

    const secondRunner = new QueryRunner([])
    const secondQuery = new PostgresReconciliationQuery(
      secondRunner as unknown as ScopedPostgresTransactionRunner,
    )
    await secondQuery.list({
      scope: { tenantId, storeId },
      employeeId,
      businessDate: '2026-08-11',
      cursor: first.nextCursor!,
      limit: 2,
    })
    expect(secondRunner.lastCall?.values[4]).toBe('2026-08-11T12:00:02.000Z')
    expect(secondRunner.lastCall?.values[5]).toBe('44444444-4444-4444-8444-444444444442')
  })

  it('rejects malformed cursors before opening a database transaction', async () => {
    const runner = new QueryRunner([])
    const query = new PostgresReconciliationQuery(runner as unknown as ScopedPostgresTransactionRunner)
    expect(() => query.list({
      scope: { tenantId, storeId },
      employeeId,
      businessDate: '2026-08-11',
      cursor: 'not-a-valid-cursor',
      limit: 20,
    })).toThrow('cursor is invalid')
    expect(runner.runCalls).toBe(0)
  })
})

class QueryRunner {
  runCalls = 0
  lastCall: { sql: string; values: readonly unknown[] } | null = null

  constructor(private readonly rows: Record<string, unknown>[]) {}

  async run<Result>(
    scope: { tenantId: string; storeId: string },
    handler: (transaction: ScopedTransaction) => Promise<Result>,
    options?: { readOnly?: boolean },
  ): Promise<Result> {
    this.runCalls += 1
    expect(scope).toEqual({ tenantId, storeId })
    expect(options).toEqual({ readOnly: true })
    return handler({
      scope,
      query: async <Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) => {
        this.lastCall = { sql: text.replace(/\s+/g, ' ').trim(), values }
        return { rows: this.rows as Row[], rowCount: this.rows.length }
      },
    })
  }
}

function entryRow(index: number): Record<string, unknown> {
  return {
    id: `44444444-4444-4444-8444-44444444444${index}`,
    payment_id: '55555555-5555-4555-8555-555555555555',
    refund_id: null,
    entry_type: 'payment',
    provider: 'postar',
    provider_reference: `POSTAR-TX-${index}`,
    amount_minor: '8800',
    currency: 'CNY',
    business_date: '2026-08-11',
    occurred_at: `2026-08-11T12:00:0${index}.000Z`,
    evidence_snapshot: {
      signatureVerified: true,
      transactionState: '1',
      customerPhone: 'customer-phone',
    },
    created_at: `2026-08-11T12:00:0${index}.500Z`,
  }
}
