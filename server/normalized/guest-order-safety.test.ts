import { describe, expect, it } from 'vitest'
import type { ScopedTransaction } from './transaction-runner.js'
import {
  GuestOrderDuplicateConfirmationRequiredError,
  GuestOrderRateLimitedError,
  GuestOrderSafetyRepository,
} from './guest-order-safety.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const tableSessionId = '33333333-3333-4333-8333-333333333333'
const customerId = '44444444-4444-4444-8444-444444444444'
const productId = '55555555-5555-4555-8555-555555555555'

class ScriptedTransaction implements ScopedTransaction {
  readonly scope = { tenantId, storeId }
  readonly calls: Array<{ sql: string; params: readonly unknown[] }> = []

  constructor(private readonly responses: Array<{ rows: Record<string, unknown>[]; rowCount?: number }>) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ) {
    this.calls.push({ sql, params })
    const response = this.responses.shift()
    if (!response) throw new Error('Unexpected query')
    return { rows: response.rows as Row[], rowCount: response.rowCount ?? response.rows.length }
  }
}

function input(confirmedDuplicateOrderPublicId?: string) {
  return {
    tableSessionId,
    customerId,
    lines: [{ productId, quantity: 2 }],
    confirmedDuplicateOrderPublicId,
  }
}

function openAndRate(customerCount = 0, tableCount = 0) {
  return [
    { rows: [{ id: tableSessionId }] },
    { rows: [{
      customer_count: String(customerCount),
      table_count: String(tableCount),
      customer_retry_at: '2026-08-13T12:01:00.000Z',
      table_retry_at: '2026-08-13T12:01:00.000Z',
    }] },
  ]
}

describe('GuestOrderSafetyRepository', () => {
  it('locks the table session and allows a distinct basket', async () => {
    const transaction = new ScriptedTransaction([
      ...openAndRate(),
      { rows: [] },
    ])

    await expect(new GuestOrderSafetyRepository(transaction).assertAllowed(input())).resolves.toBeUndefined()

    expect(transaction.calls[0]?.sql).toContain('FOR UPDATE')
    expect(transaction.calls[1]?.sql).toContain("channel = 'guest_qr'")
    expect(transaction.calls[1]?.sql).toContain('created_by_customer_id = $4::uuid')
    expect(transaction.calls[2]?.sql).toContain('parent_order_item_id IS NULL')
    expect(transaction.calls[2]?.params[4]).toBe(JSON.stringify({ [productId]: 2 }))
  })

  it('requires confirmation for the latest same-table exact basket, regardless of customer', async () => {
    const transaction = new ScriptedTransaction([
      ...openAndRate(1, 2),
      { rows: [{ public_id: 'guest-order-existing-0001', created_at: '2026-08-13T12:00:30.000Z' }] },
    ])

    await expect(new GuestOrderSafetyRepository(transaction).assertAllowed(input()))
      .rejects.toMatchObject({
        name: 'GuestOrderDuplicateConfirmationRequiredError',
        conflictingOrderPublicId: 'guest-order-existing-0001',
      })
    expect(transaction.calls[2]?.sql).not.toContain('created_by_customer_id')
  })

  it('allows an intentional duplicate only when the latest conflicting public order is confirmed', async () => {
    const transaction = new ScriptedTransaction([
      ...openAndRate(1, 2),
      { rows: [{ public_id: 'guest-order-existing-0001', created_at: '2026-08-13T12:00:30.000Z' }] },
    ])

    await expect(new GuestOrderSafetyRepository(transaction).assertAllowed(
      input('guest-order-existing-0001'),
    )).resolves.toBeUndefined()
  })

  it('limits one customer without blocking normal multi-customer table traffic', async () => {
    const customerLimited = new ScriptedTransaction(openAndRate(5, 5))
    await expect(new GuestOrderSafetyRepository(customerLimited).assertAllowed(input()))
      .rejects.toBeInstanceOf(GuestOrderRateLimitedError)

    const multiCustomerAllowed = new ScriptedTransaction([
      ...openAndRate(1, 19),
      { rows: [] },
    ])
    await expect(new GuestOrderSafetyRepository(multiCustomerAllowed).assertAllowed(input()))
      .resolves.toBeUndefined()
  })

  it('applies a wider table ceiling against coordinated multi-device abuse', async () => {
    const transaction = new ScriptedTransaction(openAndRate(1, 20))

    await expect(new GuestOrderSafetyRepository(transaction).assertAllowed(input()))
      .rejects.toMatchObject({
        name: 'GuestOrderRateLimitedError',
        dimension: 'table',
      })
  })

  it('uses typed duplicate errors so the API can return a confirmation token without internal ids', () => {
    const error = new GuestOrderDuplicateConfirmationRequiredError(
      'guest-order-public-0001',
      '2026-08-13T12:00:00.000Z',
    )
    expect(error.conflictingOrderPublicId).toBe('guest-order-public-0001')
    expect(error.message).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27}/i)
  })
})
