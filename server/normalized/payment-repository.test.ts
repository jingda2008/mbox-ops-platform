import { describe, expect, it } from 'vitest'
import type { JsonObject } from './command-executor.js'
import {
  PaymentCallbackMismatchError,
  PaymentEvidenceError,
  PaymentRepository,
  type PaymentStatus,
} from './payment-repository.js'
import { ActivityRecollectionAuthorizationConflictError } from './activity-recollection-authorization-repository.js'
import { RecollectionAuthorizationRequiredError } from './recollection-authorization-repository.js'
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
  it('closes only an online payment that never left M-BOX before manual collection', async () => {
    const transaction = new ScriptedTransaction([
      rows([orderRow(8800)]),
      rows([{
        id: paymentId,
        public_id: 'payment-unpresented-0001',
        provider: 'postar',
        provider_transaction_id: null,
        provider_action_state: null,
        provider_order_created: false,
      }]),
      rows([{ id: paymentId }]),
    ])

    await expect(new PaymentRepository(transaction).closeUnpresentedOnlinePaymentsForManualCollection(
      orderId,
      employeeId,
    )).resolves.toEqual([{
      id: paymentId, publicId: 'payment-unpresented-0001', provider: 'postar',
    }])
    expect(transaction.calls[1]?.sql).toContain('FOR UPDATE OF payment')
    expect(transaction.calls[2]?.sql).toContain("SET status = 'closed'")
    expect(transaction.calls[2]?.values[3]).toBe(employeeId)
  })

  it('blocks cash when a provider presentation exists or its result is unknown', async () => {
    const transaction = new ScriptedTransaction([
      rows([orderRow(8800)]),
      rows([{
        id: paymentId,
        public_id: 'payment-presented-0001',
        provider: 'postar',
        provider_transaction_id: 'POSTAR-REMOTE-1',
        provider_action_state: 'ready',
        provider_order_created: true,
      }]),
    ])

    await expect(new PaymentRepository(transaction).closeUnpresentedOnlinePaymentsForManualCollection(
      orderId,
      employeeId,
    )).rejects.toThrow('query or close it before manual collection')
    expect(transaction.calls).toHaveLength(2)
  })

  it('keeps an unresolved online payment auditable while explicitly releasing it for one replacement collection', async () => {
    const releasedAt = '2026-08-11T12:02:00.000Z'
    const transaction = new ScriptedTransaction([
      rows([paymentRow('pending', 8800)]),
      rows([orderRow(8800)]),
      rows([{ id: tableSessionId }]),
      rows([{ ...paymentRow('pending', 8800), retry_released_at: releasedAt, retry_release_reason: '顾客未确认到账，改用另一种方式收款' }]),
      rows([orderRow(8800)]),
      rows([{ gross_paid_minor: '0', refunded_minor: '0', has_pending: false }]),
      rows([{ payment_status: 'pending' }]),
    ])

    const released = await new PaymentRepository(transaction).releaseUnresolvedForRetry({
      paymentId,
      employeeId,
      reason: '顾客未确认到账，改用另一种方式收款',
      idempotencyKey: 'payment-retry-release-0001',
    })

    expect(released).toMatchObject({
      id: paymentId, status: 'pending', retryReleasedAt: releasedAt,
      retryReleaseReason: '顾客未确认到账，改用另一种方式收款',
    })
    expect(transaction.calls[2]?.sql).toContain('FROM mbox.table_sessions')
    expect(transaction.calls[3]?.sql).toContain('SET retry_released_at=clock_timestamp()')
    expect(transaction.calls[3]?.values.slice(3)).toEqual([
      employeeId, '顾客未确认到账，改用另一种方式收款', 'payment-retry-release-0001',
    ])
    expect(transaction.calls[5]?.sql).toContain('p.retry_released_at IS NULL')
  })

  it('derives the payment amount only from the locked order and existing database settlement', async () => {
    const transaction = new ScriptedTransaction([
      rows([orderRow(12800)]),
      rows([{ gross_paid_minor: '3000', refunded_minor: '500', has_pending: false }]),
      rows([{
        id: '44444444-4444-4444-8444-444444444445', public_id: 'recollect-test-0001', order_id: orderId,
        amount_minor: '10300', currency: 'CNY', reason: '客人确认改用另一种付款方式',
        authorized_by_employee_id: employeeId, expires_at: '2026-08-30T00:00:00.000Z', created_at: '2026-08-24T00:00:00.000Z',
      }]),
      rows([paymentRow('created', 10300)]),
      rows([{ id: '44444444-4444-4444-8444-444444444445' }]),
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
    expect(transaction.calls[3]?.values[7]).toBe(10300)
  })

  it('does not treat a completed refund as automatic permission to charge the table again', async () => {
    const transaction = new ScriptedTransaction([
      rows([orderRow(8800)]),
      rows([{ gross_paid_minor: '8800', refunded_minor: '8800', has_pending: false }]),
      rows([]),
    ])

    await expect(new PaymentRepository(transaction).createForOrder({
      orderId,
      publicId: 'payment-refund-without-authorization-0001',
      provider: 'postar',
      method: 'native_qr',
      principal: employeePrincipal,
    })).rejects.toBeInstanceOf(RecollectionAuthorizationRequiredError)

    expect(transaction.calls).toHaveLength(3)
    expect(transaction.calls[2]?.sql).toContain('mbox.order_recollection_authorizations')
  })

  it('does not create a recollection payment or consume the authorization when later registrations fill the activity', async () => {
    const transaction = new ScriptedTransaction([
      rows([refundedActivityRegistrationRow()]),
      rows([{ status: 'refunded', payment_status: 'refunded' }]),
      rows([activityRecollectionAuthorizationRow()]),
      rows([{
        id: '88888888-8888-4888-8888-888888888888', capacity: 1, status: 'published',
        ends_at: '2099-08-11T12:00:00.000Z', registered_count: '1',
      }]),
    ])

    await expect(new PaymentRepository(transaction).recordManualForActivityRegistration(activityManualInput()))
      .rejects.toBeInstanceOf(ActivityRecollectionAuthorizationConflictError)

    expect(transaction.calls.some((call) => call.sql.includes('INSERT INTO mbox.payments'))).toBe(false)
    expect(transaction.calls.some((call) => call.sql.includes("SET status='consumed'"))).toBe(false)
    expect(transaction.calls[3]?.sql).toContain('FOR UPDATE OF activity')
  })

  it('does not create a recollection payment or consume the authorization when package inventory was reserved later', async () => {
    const transaction = new ScriptedTransaction([
      rows([refundedActivityRegistrationRow()]),
      rows([{ status: 'refunded', payment_status: 'refunded' }]),
      rows([activityRecollectionAuthorizationRow()]),
      rows([{
        id: '88888888-8888-4888-8888-888888888888', capacity: 2, status: 'published',
        ends_at: '2099-08-11T12:00:00.000Z', registered_count: '0',
      }]),
      rows([{ id: '99999999-9999-4999-8999-999999999999', capacity: 2, registered_count: '0' }]),
      rows([{
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        inventory_item_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        item_name: '活动专属酒水', item_status: 'active', required_quantity: '1',
      }]),
      rows([]),
      rows([], 0),
    ])

    await expect(new PaymentRepository(transaction).recordManualForActivityRegistration(activityManualInput()))
      .rejects.toBeInstanceOf(ActivityRecollectionAuthorizationConflictError)

    expect(transaction.calls.some((call) => call.sql.includes('INSERT INTO mbox.payments'))).toBe(false)
    expect(transaction.calls.some((call) => call.sql.includes("SET status='consumed'"))).toBe(false)
    expect(transaction.calls[7]?.sql).toContain('on_hand_quantity-reserved_quantity>=')
  })

  it('accepts an already-applied identical callback without a second update', async () => {
    const transaction = new ScriptedTransaction([
      rows([paymentTargetRow()]),
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

  it('enriches a captured payment only when a later authoritative result supplies the missing channel', async () => {
    const transaction = new ScriptedTransaction([
      rows([paymentTargetRow()]),
      rows([{ id: orderId }]),
      rows([paymentRow('succeeded', 8800, 'provider-payment-001')]),
      rows([{ ...paymentRow('succeeded', 8800, 'provider-payment-001'), settlement_channel: 'wechat' }]),
    ])

    const application = await new PaymentRepository(transaction).applySucceededCallback({
      paymentPublicId: 'payment-order-0001',
      provider: 'postar',
      providerTransactionId: 'provider-payment-001',
      reportedAmountMinor: 8800,
      reportedCurrency: 'CNY',
      settlementChannel: 'wechat',
    })

    expect(application).toMatchObject({ applied: false, payment: { settlementChannel: 'wechat' } })
    expect(transaction.calls[3]?.sql).toContain('SET settlement_channel=$4')
    expect(transaction.calls[3]?.sql).not.toContain("SET status = 'succeeded'")
  })

  it('rejects a later authoritative settlement channel that conflicts with the stored one', async () => {
    const transaction = new ScriptedTransaction([
      rows([paymentTargetRow()]),
      rows([{ id: orderId }]),
      rows([{ ...paymentRow('succeeded', 8800, 'provider-payment-001'), settlement_channel: 'wechat' }]),
    ])

    await expect(new PaymentRepository(transaction).applySucceededCallback({
      paymentPublicId: 'payment-order-0001',
      provider: 'postar',
      providerTransactionId: 'provider-payment-001',
      reportedAmountMinor: 8800,
      reportedCurrency: 'CNY',
      settlementChannel: 'alipay',
    })).rejects.toBeInstanceOf(PaymentCallbackMismatchError)
    expect(transaction.calls).toHaveLength(3)
  })

  it('applies a signed active query success once and consumes the provider action', async () => {
    const transaction = new ScriptedTransaction([
      rows([paymentTargetRow()]),
      rows([orderRow(8800)]),
      rows([paymentRow('pending', 8800)]),
      rows([{ ...paymentRow('succeeded', 8800, 'provider-payment-001'), settlement_channel: 'wechat' }]),
      rows([]),
    ])

    const application = await new PaymentRepository(transaction).applyProviderQueryResult({
      paymentPublicId: 'payment-order-0001',
      provider: 'postar',
      providerTransactionId: 'provider-payment-001',
      reportedAmountMinor: 8800,
      reportedCurrency: 'CNY',
      settlementChannel: 'wechat',
      status: 'succeeded',
      providerSnapshot: { signatureVerified: true, providerStatus: 'succeeded' },
      succeededAt: '2026-08-11T12:00:00.000Z',
    })

    expect(application).toMatchObject({
      applied: true,
      payment: { status: 'succeeded', settlementChannel: 'wechat' },
    })
    expect(transaction.calls[3]?.sql).toContain("SET status = $4")
    expect(transaction.calls[3]?.sql).toContain('settlement_channel = COALESCE(settlement_channel, $8)')
    expect(transaction.calls[3]?.values[3]).toBe('succeeded')
    expect(transaction.calls[3]?.values[7]).toBe('wechat')
    expect(transaction.calls[4]?.sql).toContain("SET state = 'consumed'")
  })

  it('stores a verified callback settlement channel in the strong payment column', async () => {
    const transaction = new ScriptedTransaction([
      rows([paymentTargetRow()]),
      rows([{ id: orderId }]),
      rows([paymentRow('pending', 8800)]),
      rows([{ ...paymentRow('succeeded', 8800, 'provider-payment-003'), settlement_channel: 'alipay' }]),
    ])

    const application = await new PaymentRepository(transaction).applySucceededCallback({
      paymentPublicId: 'payment-order-0001',
      provider: 'postar',
      providerTransactionId: 'provider-payment-003',
      reportedAmountMinor: 8800,
      reportedCurrency: 'CNY',
      settlementChannel: 'alipay',
      providerSnapshot: { signatureVerified: true, channel: 'alipay' },
    })

    expect(application.payment.settlementChannel).toBe('alipay')
    expect(transaction.calls[3]?.sql).toContain('settlement_channel = COALESCE(settlement_channel, $7)')
    expect(transaction.calls[3]?.values[6]).toBe('alipay')
  })

  it('releases the order for a new attempt after a verified failed provider query', async () => {
    const transaction = new ScriptedTransaction([
      rows([paymentTargetRow()]),
      rows([orderRow(8800)]),
      rows([paymentRow('pending', 8800)]),
      rows([paymentRow('failed', 8800, 'provider-payment-002')]),
      rows([]),
    ])

    const application = await new PaymentRepository(transaction).applyProviderQueryResult({
      paymentPublicId: 'payment-order-0001',
      provider: 'postar',
      providerTransactionId: 'provider-payment-002',
      reportedAmountMinor: 8800,
      reportedCurrency: 'CNY',
      status: 'failed',
      providerSnapshot: { signatureVerified: true, providerStatus: 'failed' },
      succeededAt: '2026-08-11T12:00:00.000Z',
    })

    expect(application).toMatchObject({ applied: true, payment: { status: 'failed' } })
    expect(transaction.calls[4]?.sql).toContain("SET state = 'failed'")
    expect(transaction.calls[4]?.values[3]).toBe('provider-query:failed')
  })

  it('stores only allowlisted provider evidence and excludes credentials and customer identifiers', async () => {
    const transaction = new ScriptedTransaction([
      rows([orderRow(8800)]),
      rows([{ gross_paid_minor: '0', refunded_minor: '0', has_pending: false }]),
      rows([{
        ...paymentRow('created', 8800),
        provider_snapshot: { tradeState: 'SUCCESS' },
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
    expect(persisted).toEqual({ tradeState: 'SUCCESS' })
    expect(payment.providerSnapshot).toEqual(persisted)
    expect(JSON.stringify(persisted)).not.toContain('secret')
    expect(JSON.stringify(persisted)).not.toContain('openid')
  })

  it('rejects a callback amount that differs from the order-derived amount', async () => {
    const transaction = new ScriptedTransaction([
      rows([paymentTargetRow()]),
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
      rows([{ participation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }]),
      rows([{ gross_paid_minor: '0', refunded_minor: '0', has_pending: false }]),
      rows([paymentRow('created', 8800)]),
    ])
    await expect(new PaymentRepository(allowed).createForOrder({
      orderId,
      publicId: 'payment-guest-owned-0001',
      provider: 'postar',
      method: 'native_qr',
      principal: {
        type: 'guest',tableSessionId,customerId,
        guestSessionId:'99999999-9999-4999-8999-999999999999',
      },
    })).resolves.toMatchObject({ orderId })
    expect(allowed.calls[1]?.sql).toContain('mbox.lock_active_table_guest_session_position')
    expect(allowed.calls[1]?.sql).not.toContain('mbox.table_session_customers')

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
    payable_kind: 'order',
    order_id: orderId,
    activity_registration_id: null,
    public_id: 'payment-order-0001',
    provider: 'postar',
    provider_transaction_id: providerTransactionId,
    settlement_channel: null,
    method: 'native_qr',
    amount_minor: String(amountMinor),
    currency: 'CNY',
    status,
    provider_snapshot: snapshot,
    retry_released_at: null,
    retry_release_reason: null,
    succeeded_at: status === 'succeeded' ? '2026-08-11T12:00:00.000Z' : null,
    created_at: '2026-08-11T11:59:00.000Z',
    updated_at: '2026-08-11T12:00:00.000Z',
  }
}

function paymentTargetRow(): Record<string, unknown> {
  return { id: paymentId, payable_kind: 'order', order_id: orderId, activity_registration_id: null }
}

function refundedActivityRegistrationRow(): Record<string, unknown> {
  return {
    id: '77777777-7777-4777-8777-777777777778',
    status: 'refunded', payment_status: 'refunded', payment_id: paymentId,
    amount_due_minor: '0', paid_amount_minor: '2000', currency: 'CNY',
    activity_id: '88888888-8888-4888-8888-888888888888',
    activity_package_id: '99999999-9999-4999-8999-999999999999',
    party_size: 1, registration_cycle: 1,
  }
}

function activityRecollectionAuthorizationRow(): Record<string, unknown> {
  return {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', public_id: 'activity-recollect-0001',
    activity_registration_id: '77777777-7777-4777-8777-777777777778',
    source_refund_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', amount_minor: '2000', currency: 'CNY',
    reason: '顾客确认重新以现金收款', authorized_by_employee_id: employeeId,
    expires_at: '2099-08-11T12:00:00.000Z', created_at: '2026-08-11T12:00:00.000Z',
  }
}

function activityManualInput() {
  return {
    registrationPublicId: 'activity-registration-public-0001', publicId: 'activity-payment-public-0001',
    provider: 'cash' as const, method: 'cash' as const, collectedByEmployeeId: employeeId,
    evidence: { collectedByEmployeeId: employeeId, receiptReference: 'ACT-CASH-0001' },
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
