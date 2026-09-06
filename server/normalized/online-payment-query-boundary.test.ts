import { describe, expect, it, vi } from 'vitest'
import {
  OnlinePaymentService,
  OnlinePaymentUnknownError,
} from './online-payment-service.js'
import type { ScopedTransaction } from './transaction-runner.js'

const scope = {
  tenantId: '93000000-0000-4000-8000-000000000001',
  storeId: '93000000-0000-4000-8000-000000000002',
}
const paymentId = '93000000-0000-4000-8000-000000000003'
const paymentContext = {
  id: paymentId,
  payable_kind: 'order',
  order_id: '93000000-0000-4000-8000-000000000004',
  order_public_id: 'ORDER-QUERY-BOUNDARY-001',
  activity_registration_id: null,
  activity_registration_public_id: null,
  public_id: 'PAYQUERYBOUNDARY001',
  provider: 'postar',
  provider_transaction_id: null,
  method: 'jsapi',
  amount_minor: '13600',
  currency: 'CNY',
  status: 'pending',
  customer_id: '93000000-0000-4000-8000-000000000005',
  table_session_id: '93000000-0000-4000-8000-000000000006',
  table_code: 'L01',
  created_at: '2026-09-06T15:40:00.000Z',
}
const config = {
  provider: 'postar' as const,
  environment: 'test' as const,
  agencyId: 'TESTAGENCY', merchantId: 'TESTMERCHANT', publicKey: 'TESTPUBLICKEY',
  callbackUrl: 'https://example.test/api/payments/providers/postar/callback', timeoutMs: 1_000,
  wechat: null,
}

describe('OnlinePaymentService payment query uncertainty boundary', () => {
  it.each(['query', 'querySystem', 'closeSystem'] as const)(
    'maps an unmappable provider response to unknown for %s',
    async (operation) => {
      const queryPayment = vi.fn(async () => {
        throw new Error('provider returned an unmappable query response')
      })
      const service = new OnlinePaymentService(
        runner(), 'test-secret-at-least-thirty-two-bytes', config,
        { createPayment: vi.fn(), queryPayment, closePayment: vi.fn(), requestRefund: vi.fn(), queryRefund: vi.fn() },
        { recordPayment: vi.fn(), recordRefund: vi.fn() },
      )

      const input = operation === 'query'
        ? service.query({
            scope, paymentId, queryBindingId: 'query-boundary-test',
            principal: { type: 'employee', employeeId: '93000000-0000-4000-8000-000000000007' },
          })
        : operation === 'querySystem'
          ? service.querySystem({ scope, paymentId, queryBindingId: 'query-system-boundary-test' })
          : service.closeSystem({ scope, paymentId, closeBindingId: 'close-system-boundary-test' })

      await expect(input).rejects.toBeInstanceOf(OnlinePaymentUnknownError)
      expect(queryPayment).toHaveBeenCalledTimes(1)
    },
  )
})

function runner() {
  const transaction: ScopedTransaction = {
    scope,
    query: async <Row extends Record<string, unknown>>(text: string) => {
      const sql = text.replace(/\s+/g, ' ').trim()
      if (sql.startsWith('SELECT payment.id')) {
        return { rows: [paymentContext as Row], rowCount: 1 }
      }
      throw new Error(`Unexpected payment query: ${sql}`)
    },
  }
  return {
    run: async (_scope: unknown, handler: (current: ScopedTransaction) => Promise<unknown>) => handler(transaction),
  } as never
}
