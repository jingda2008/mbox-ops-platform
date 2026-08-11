import { describe, expect, it } from 'vitest'
import type { JsonObject } from './command-executor.js'
import {
  PaymentCallbackMismatchError,
  PaymentEvidenceError,
  PaymentRepository,
  type PaymentStatus,
} from './payment-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const orderId = '33333333-3333-4333-8333-333333333333'
const paymentId = '44444444-4444-4444-8444-444444444444'
const employeeId = '55555555-5555-4555-8555-555555555555'
const tableSessionId = '66666666-6666-4666-8666-666666666666'
const customerId = '77777777-7777-4777-8777-777777777777'
const employeePrincipal = { type: 'employee' as const, employeeId }

describe('PaymentRepository', () => {
  it('derives the payment amount only from the locked order and existing database settlement', async () => {
    const transaction = new ScriptedTransaction([
      rows([orderRow(12800)]),
      rows([{ gross_paid_minor: '3000', refunded_minor: '500', has_pending: false }]),
      rows([paymentRow('created', 10300)]),
    ])

    const payment = await new PaymentRepository(transaction).createForOrder({
      orderId,
      publicId: 'payment-order-0001',
      provider: 'wechat',
      method: 'jsapi',
      principal: employeePrincipal,
    })

    expect(payment.amountMinor).toBe(10300)
    expect(transaction.calls[0]?.sql).toContain('FROM mbox.orders')
    expect(transaction.calls[0]?.sql).toContain('FOR UPDATE')
    expect(transaction.calls[2]?.values[7]).toBe(10300)
  })

  it('accepts an already-applied identical callback without a second update', async () => {
    const transaction = new ScriptedTransaction([
      rows([{ id: paymentId, order_id: orderId }]),
      rows([{ id: orderId }]),
      rows([paymentRow('succeeded', 8800, 'provider-payment-001')]),
    ])

    const application = await new PaymentRepository(transaction).applySucceededCallback({
      paymentPublicId: 'payment-order-0001',
      provider: 'postar',
      providerTransactionId: 'provider-payment-001',
      reportedAmountMinor: 8800,
      reportedCurrency: 'CNY',
    })

    expect(application.payment.status).toBe('succeeded')
    expect(application.applied).toBe(false)
    expect(transaction.calls).toHaveLength(3)
  })

  it('stores only allowlisted provider evidence and excludes credentials and customer identifiers', async () => {
    const transaction = new ScriptedTransaction([
      rows([orderRow(8800)]),
      rows([{ gross_paid_minor: '0', refunded_minor: '0', has_pending: false }]),
      rows([{
        ...paymentRow('created', 8800),
        provider_snapshot: { signatureVerified: true, tradeState: 'SUCCESS' },
      }]),
    ])

    const payment = await new PaymentRepository(transaction).createForOrder({
      orderId,
      publicId: 'payment-safe-evidence-0001',
      provider: 'postar',
      method: 'native_qr',
      principal: employeePrincipal,
      evidence: {
        signatureVerified: true,
        tradeState: 'SUCCESS',
        signature: 'secret-signature',
        token: 'secret-token',
        headers: { authorization: 'Bearer secret' },
        openid: 'customer-openid',
      },
    })

    const persisted = JSON.parse(String(transaction.calls[2]?.values[10])) as JsonObject
    expect(persisted).toEqual({ signatureVerified: true, tradeState: 'SUCCESS' })
    expect(payment.providerSnapshot).toEqual(persisted)
    expect(JSON.stringify(persisted)).not.toContain('secret')
    expect(JSON.stringify(persisted)).not.toContain('openid')
  })

  it('rejects a callback amount that differs from the order-derived amount', async () => {
    const transaction = new ScriptedTransaction([
      rows([{ id: paymentId, order_id: orderId }]),
      rows([{ id: orderId }]),
      rows([paymentRow('pending', 8800)]),
    ])

    await expect(new PaymentRepository(transaction).applySucceededCallback({
      paymentPublicId: 'payment-order-0001',
      provider: 'postar',
      providerTransactionId: 'provider-payment-002',
      reportedAmountMinor: 1,
      reportedCurrency: 'CNY',
    })).rejects.toBeInstanceOf(PaymentCallbackMismatchError)

    expect(transaction.calls).toHaveLength(3)
  })

  it('requires auditable evidence for cash and physical POS payments', async () => {
    const repository = new PaymentRepository(new ScriptedTransaction([]))
    await expect(repository.createForOrder({
      orderId,
      publicId: 'payment-cash-0001',
      provider: 'cash',
      method: 'cash',
      initialStatus: 'succeeded',
      evidence: { collectedByEmployeeId: 'employee-1' },
      principal: employeePrincipal,
    })).rejects.toBeInstanceOf(PaymentEvidenceError)

    await expect(repository.createForOrder({
      orderId,
      publicId: 'payment-pos-0001',
      provider: 'physical_pos',
      method: 'card',
      initialStatus: 'succeeded',
      evidence: {
        collectedByEmployeeId: 'employee-1',
        receiptReference: 'receipt-1',
      },
      principal: employeePrincipal,
    })).rejects.toBeInstanceOf(PaymentEvidenceError)
  })

  it('persists physical POS receipt, terminal and collector evidence with the order-derived amount', async () => {
    const evidence = {
      terminalId: 'POS-01',
      receiptReference: 'POS-20260811-0001',
      collectedByEmployeeId: '77777777-7777-4777-8777-777777777777',
    }
    const transaction = new ScriptedTransaction([
      rows([orderRow(6800)]),
      rows([{ gross_paid_minor: '0', refunded_minor: '0', has_pending: false }]),
      rows([{
        ...paymentRow('succeeded', 6800, evidence.receiptReference),
        provider: 'physical_pos',
        method: 'card',
        provider_snapshot: evidence,
      }]),
    ])

    const payment = await new PaymentRepository(transaction).createForOrder({
      orderId,
      publicId: 'payment-pos-valid-0001',
      provider: 'physical_pos',
      method: 'card',
      providerTransactionId: evidence.receiptReference,
      initialStatus: 'succeeded',
      evidence,
      principal: employeePrincipal,
    })

    expect(payment.amountMinor).toBe(6800)
    expect(payment.providerSnapshot).toEqual(evidence)
    expect(JSON.parse(String(transaction.calls[2]?.values[10]))).toEqual(evidence)
  })

  it('allows a guest to pay only an order owned by the authenticated table session and linked customer', async () => {
    const allowed = new ScriptedTransaction([
      rows([orderRow(8800)]),
      rows([{ linked: true }]),
      rows([{ gross_paid_minor: '0', refunded_minor: '0', has_pending: false }]),
      rows([paymentRow('created', 8800)]),
    ])
    await expect(new PaymentRepository(allowed).createForOrder({
      orderId,
      publicId: 'payment-guest-owned-0001',
      provider: 'postar',
      method: 'native_qr',
      principal: { type: 'guest', tableSessionId, customerId },
    })).resolves.toMatchObject({ orderId })
    expect(allowed.calls[1]?.sql).toContain('FROM mbox.table_session_customers')

    const foreignSession = new ScriptedTransaction([
      rows([{ ...orderRow(8800), table_session_id: '88888888-8888-4888-8888-888888888888' }]),
    ])
    await expect(new PaymentRepository(foreignSession).createForOrder({
      orderId,
      publicId: 'payment-guest-forged-0001',
      provider: 'postar',
      method: 'native_qr',
      principal: { type: 'guest', tableSessionId, customerId },
    })).rejects.toThrow('authenticated table session')
    expect(foreignSession.calls).toHaveLength(1)
  })
})

interface QueryCall {
  sql: string
  values: readonly unknown[]
}

class ScriptedTransaction implements ScopedTransaction {
  readonly scope = { tenantId, storeId }
  readonly calls: QueryCall[] = []

  constructor(private readonly responses: Response[]) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number }> {
    this.calls.push({ sql: normalizeSql(text), values: [...values] })
    const response = this.responses.shift()
    if (response === undefined) throw new Error(`Unexpected query: ${normalizeSql(text)}`)
    return { rows: response.data as Row[], rowCount: response.rowCount }
  }
}

interface Response {
  data: Record<string, unknown>[]
  rowCount: number
}

function rows(data: Record<string, unknown>[], rowCount = data.length): Response {
  return { data, rowCount }
}

function paymentRow(
  status: PaymentStatus,
  amountMinor: number,
  providerTransactionId: string | null = null,
): Record<string, unknown> {
  const snapshot: JsonObject = {}
  return {
    id: paymentId,
    order_id: orderId,
    public_id: 'payment-order-0001',
    provider: 'postar',
    provider_transaction_id: providerTransactionId,
    method: 'native_qr',
    amount_minor: String(amountMinor),
    currency: 'CNY',
    status,
    provider_snapshot: snapshot,
    succeeded_at: status === 'succeeded' ? '2026-08-11T12:00:00.000Z' : null,
    created_at: '2026-08-11T11:59:00.000Z',
    updated_at: '2026-08-11T12:00:00.000Z',
  }
}

function orderRow(totalAmountMinor: number): Record<string, unknown> {
  return {
    id: orderId,
    table_session_id: tableSessionId,
    total_amount_minor: String(totalAmountMinor),
    currency: 'CNY',
    status: 'submitted',
  }
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}
