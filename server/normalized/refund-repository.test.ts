import { describe, expect, it } from 'vitest'
import {
  RefundApprovalRequiredError,
  RefundCallbackMismatchError,
  RefundLimitError,
  RefundRepository,
  RefundTransitionError,
  type RefundStatus,
} from './refund-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const orderId = '33333333-3333-4333-8333-333333333333'
const paymentId = '44444444-4444-4444-8444-444444444444'
const refundId = '55555555-5555-4555-8555-555555555555'
const itemId = '66666666-6666-4666-8666-666666666666'
const requesterId = '77777777-7777-4777-8777-777777777777'
const approverId = '88888888-8888-4888-8888-888888888888'

describe('RefundRepository', () => {
  it('stores item allocations and derives the refund amount from them', async () => {
    const transaction = new ScriptedTransaction([
      rows([paymentTargetRow()]),
      rows([{ id: orderId }]),
      rows([paymentRow('succeeded', 10000)]),
      rows([{ id: itemId, total_amount_minor: '6000', currency: 'CNY', status: 'delivered' }]),
      rows([{ reserved_total_minor: '0' }]),
      rows([]),
      rows([refundBaseRow('requested', 2500)]),
      rows([{ order_item_id: itemId, amount_minor: '2500' }]),
    ])

    const refund = await new RefundRepository(transaction).request({
      paymentId,
      publicId: 'refund-request-0001',
      reason: '客人退掉一项',
      requestedByEmployeeId: requesterId,
      allocations: [{ orderItemId: itemId, amountMinor: 2500 }],
    })

    expect(refund.amountMinor).toBe(2500)
    expect(refund.allocations).toEqual([{ orderItemId: itemId, amountMinor: 2500 }])
    expect(transaction.calls[1]?.sql).toContain('FROM mbox.orders')
    expect(transaction.calls[1]?.sql).toContain('FOR UPDATE')
    expect(transaction.calls[2]?.sql).toContain('FROM mbox.payments')
    expect(transaction.calls[2]?.sql).toContain('FOR UPDATE')
    expect(transaction.calls[3]?.sql).toContain('FROM mbox.order_items')
    expect(transaction.calls[3]?.sql).toContain('FOR UPDATE')
    expect(transaction.calls[6]?.values[4]).toBe(2500)
    expect(transaction.calls[7]?.sql).toContain('INSERT INTO mbox.refund_items')
  })

  it('rejects cumulative refunds above the captured payment', async () => {
    const transaction = new ScriptedTransaction([
      rows([paymentTargetRow()]),
      rows([{ id: orderId }]),
      rows([paymentRow('partially_refunded', 10000)]),
      rows([{ id: itemId, total_amount_minor: '10000', currency: 'CNY', status: 'delivered' }]),
      rows([{ reserved_total_minor: '9500' }]),
      rows([{ order_item_id: itemId, reserved_amount_minor: '9500' }]),
    ])

    await expect(new RefundRepository(transaction).request({
      paymentId,
      publicId: 'refund-request-0002',
      reason: '越额测试',
      requestedByEmployeeId: requesterId,
      allocations: [{ orderItemId: itemId, amountMinor: 1000 }],
    })).rejects.toBeInstanceOf(RefundLimitError)

    expect(transaction.calls).toHaveLength(6)
  })

  it('rejects cumulative item refunds above that order item even when payment total remains available', async () => {
    const transaction = new ScriptedTransaction([
      rows([paymentTargetRow()]),
      rows([{ id: orderId }]),
      rows([paymentRow('partially_refunded', 20000)]),
      rows([{ id: itemId, total_amount_minor: '6000', currency: 'CNY', status: 'delivered' }]),
      rows([{ reserved_total_minor: '5000' }]),
      rows([{ order_item_id: itemId, reserved_amount_minor: '5000' }]),
    ])

    await expect(new RefundRepository(transaction).request({
      paymentId,
      publicId: 'refund-request-0003',
      reason: '单品越额测试',
      requestedByEmployeeId: requesterId,
      allocations: [{ orderItemId: itemId, amountMinor: 2000 }],
    })).rejects.toThrow(`Cumulative refund exceeds order item ${itemId}`)
  })

  it('does not allow a requested refund to execute before human approval', async () => {
    const transaction = new ScriptedTransaction([
      rows([paymentTargetRow()]),
      rows([{ id: orderId }]),
      rows([refundJoinedRow('requested', 2500)]),
    ])

    await expect(new RefundRepository(transaction).beginExecution(refundId))
      .rejects.toBeInstanceOf(RefundApprovalRequiredError)
    expect(transaction.calls).toHaveLength(3)
  })

  it('keeps request and approval duties separated', async () => {
    const samePerson = new ScriptedTransaction([
      rows([paymentTargetRow()]),
      rows([{ id: orderId }]),
      rows([refundJoinedRow('requested', 2500)]),
    ])
    await expect(new RefundRepository(samePerson).approve(refundId, requesterId, '申请人不能自批'))
      .rejects.toBeInstanceOf(RefundTransitionError)

    const differentPerson = new ScriptedTransaction([
      rows([paymentTargetRow()]),
      rows([{ id: orderId }]),
      rows([refundJoinedRow('requested', 2500)]),
      rows([refundJoinedRow('approved', 2500, approverId)]),
    ])
    const approved = await new RefundRepository(differentPerson).approve(refundId, approverId, '商品未出品，同意退款')
    expect(approved.status).toBe('approved')
    expect(approved.approvedByEmployeeId).toBe(approverId)
    expect(approved.decisionReason).toBe('商品未出品，同意退款')
  })

  it('never permits a manual result to close an online-provider refund', async () => {
    const transaction = new ScriptedTransaction([
      rows([paymentTargetRow()]),
      rows([{ id: orderId }]),
      rows([refundJoinedRow('processing', 2500, approverId)]),
    ])
    await expect(new RefundRepository(transaction).completeManualExecution({
      refundId,
      succeeded: true,
      receiptReference: 'FORGED-MANUAL-REFUND',
    })).rejects.toBeInstanceOf(RefundCallbackMismatchError)
    expect(transaction.calls.every((call) => !call.sql.includes('UPDATE mbox.refunds'))).toBe(true)
  })

  it('binds provider refund callbacks to provider, original transaction, amount and currency', async () => {
    const mismatches = [
      { provider: 'wechat' as const },
      { originalProviderTransactionId: 'OTHER-TX' },
      { reportedAmountMinor: 2499 },
      { reportedCurrency: 'USD' },
    ]
    for (const mismatch of mismatches) {
      const transaction = providerCallbackTransaction(refundJoinedRow('processing', 2500, approverId))
      await expect(new RefundRepository(transaction).completeProviderExecution({
        refundPublicId: 'refund-request-0001',
        provider: 'postar',
        providerRefundId: 'POSTAR-REFUND-001',
        originalProviderTransactionId: 'POSTAR-TX-001',
        reportedAmountMinor: 2500,
        reportedCurrency: 'CNY',
        succeeded: true,
        ...mismatch,
      })).rejects.toBeInstanceOf(RefundCallbackMismatchError)
    }
  })

  it('treats an identical terminal provider callback as a business-idempotent no-op', async () => {
    const row = {
      ...refundJoinedRow('succeeded', 2500, approverId),
      provider_refund_id: 'POSTAR-REFUND-001',
      completed_at: '2026-08-11T12:30:00.000Z',
    }
    const transaction = providerCallbackTransaction(row)
    const result = await new RefundRepository(transaction).completeProviderExecution({
      refundPublicId: 'refund-request-0001',
      provider: 'postar',
      providerRefundId: 'POSTAR-REFUND-001',
      originalProviderTransactionId: 'POSTAR-TX-001',
      reportedAmountMinor: 2500,
      reportedCurrency: 'CNY',
      succeeded: true,
    })
    expect(result.applied).toBe(false)
    expect(result.refund.status).toBe('succeeded')
    expect(transaction.calls.every((call) => !call.sql.includes('UPDATE mbox.refunds'))).toBe(true)
  })
})

interface QueryCall {
  sql: string
  values: readonly unknown[]
}
interface Response { data: Record<string, unknown>[]; rowCount: number }

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

function rows(data: Record<string, unknown>[], rowCount = data.length): Response {
  return { data, rowCount }
}

function paymentRow(status: string, amountMinor: number): Record<string, unknown> {
  return {
    id: paymentId,
    payable_kind: 'order',
    order_id: orderId,
    activity_registration_id: null,
    provider: 'postar',
    amount_minor: String(amountMinor),
    currency: 'CNY',
    status,
  }
}

function refundBaseRow(status: RefundStatus, amountMinor: number): Record<string, unknown> {
  return {
    id: refundId,
    payment_id: paymentId,
    public_id: 'refund-request-0001',
    provider_refund_id: null,
    amount_minor: String(amountMinor),
    currency: 'CNY',
    status,
    reason: '客人退掉一项',
    requested_by_employee_id: requesterId,
    approved_by_employee_id: null,
    decision_reason: null,
    provider_snapshot: { requestEvidence: {} },
    allocations: [{ orderItemId: itemId, amountMinor }],
    completed_at: null,
    created_at: '2026-08-11T12:00:00.000Z',
    updated_at: '2026-08-11T12:00:00.000Z',
  }
}

function refundJoinedRow(
  status: RefundStatus,
  amountMinor: number,
  approvedByEmployeeId: string | null = null,
): Record<string, unknown> {
  return {
    ...refundBaseRow(status, amountMinor),
    order_id: orderId,
    activity_registration_id: null,
    payment_provider: 'postar',
    payment_provider_transaction_id: 'POSTAR-TX-001',
    approved_by_employee_id: approvedByEmployeeId,
    decision_reason: approvedByEmployeeId === null ? null : '商品未出品，同意退款',
  }
}

function providerCallbackTransaction(row: Record<string, unknown>): ScriptedTransaction {
  return new ScriptedTransaction([
    rows([{ id: refundId }]),
    rows([paymentTargetRow()]),
    rows([{ id: orderId }]),
    rows([row]),
  ])
}

function paymentTargetRow(): Record<string, unknown> {
  return { payable_kind: 'order', order_id: orderId, activity_registration_id: null }
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}
