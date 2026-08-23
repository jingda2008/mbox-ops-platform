import { describe, expect, it, vi } from 'vitest'
import {
  OnlinePaymentService,
  OnlinePaymentUnavailableError,
  OnlinePaymentUnknownError,
} from './online-payment-service.js'
import type { ScopedTransaction } from './transaction-runner.js'

const scope = {
  tenantId: '92000000-0000-4000-8000-000000000001',
  storeId: '92000000-0000-4000-8000-000000000002',
}
const refundId = '92000000-0000-4000-8000-000000000003'
const merchantRefundId = refundId.replaceAll('-', '')
const verifiedObservationId = '92000000-0000-4000-8000-000000000004'
const secrets = {
  provider: 'postar' as const,
  environment: 'test' as const,
  agencyId: 'TESTAGENCY', merchantId: 'TESTMERCHANT', publicKey: 'TESTPUBLICKEY',
  callbackUrl: 'https://example.test/api/payments/providers/postar/callback', timeoutMs: 1_000,
  wechat: null,
}

describe('OnlinePaymentService provider refund closure', () => {
  it('submits an approved refund once with the internal UUID-derived order number and bound payment truth', async () => {
    const requestRefund = vi.fn(async () => ({
      refundId: merchantRefundId, providerRefundId: merchantRefundId,
      providerRefundTransactionId: null, originalProviderTransactionId: 'POSTAR-PAYMENT-001',
      status: 'processing' as const, amount: 2_000, currency: 'CNY',
      occurredAt: '2026-08-16T12:00:00.000Z',
    }))
    const transaction = new RefundTransaction(true)
    const service = new OnlinePaymentService(
      runner(transaction), 'test-secret-at-least-thirty-two-bytes', secrets,
      { createPayment: vi.fn(), queryPayment: vi.fn(), requestRefund, queryRefund: vi.fn() } as never,
      observationRecorder(),
    )
    const result = await service.requestRefund(scope, refundId, 'refund-submit-binding-0001')

    expect(requestRefund).toHaveBeenCalledWith(expect.objectContaining({
      refundId: merchantRefundId,
      paymentIntentId: 'AP1234567890',
      providerTransactionId: 'POSTAR-PAYMENT-001',
      amount: 2_000, currency: 'CNY', items: [], idempotencyKey: merchantRefundId,
      settlementChannel: 'wechat',
    }), expect.objectContaining({ secrets: expect.anything() }))
    expect(result).toMatchObject({ merchantRefundId, observation: { status: 'processing' } })
    expect(transaction.calls.filter((sql) => sql.includes("providerStatus', 'submission_started'"))).toHaveLength(1)
    expect(transaction.calls.filter((sql) => sql.includes("'merchantRefundId', $4::text"))).toHaveLength(2)
    expect(transaction.calls.filter((sql) => sql.includes('merchant_refund_id=$4::text'))).toHaveLength(2)
    expect(transaction.calls.filter((sql) => sql.includes("'providerStatus', $5::text"))).toHaveLength(1)
  })

  it('preserves existing order refund allocations while using the authoritative settlement channel', async () => {
    const requestRefund = vi.fn(async (request: { providerTransactionId: string; amount: number; currency: string }) => ({
      refundId: merchantRefundId, providerRefundId: merchantRefundId,
      providerRefundTransactionId: null, originalProviderTransactionId: request.providerTransactionId,
      status: 'processing' as const, amount: request.amount, currency: request.currency,
      occurredAt: '2026-08-16T12:00:00.000Z',
    }))
    const transaction = new RefundTransaction(true, {
      payment_method: 'jsapi', settlement_channel: 'wechat', provider_snapshot: {},
      refund_items: [{
        orderId: '92000000-0000-4000-8000-000000000010',
        orderItemId: '92000000-0000-4000-8000-000000000011', amount: 2_000,
      }],
    })
    const service = new OnlinePaymentService(
      runner(transaction), 'test-secret-at-least-thirty-two-bytes', secrets,
      { createPayment: vi.fn(), queryPayment: vi.fn(), requestRefund, queryRefund: vi.fn() } as never,
      observationRecorder(),
    )
    await service.requestRefund(scope, refundId, 'refund-submit-binding-0002')

    expect(requestRefund).toHaveBeenCalledWith(expect.objectContaining({
      settlementChannel: 'wechat',
      items: [{
        orderId: '92000000-0000-4000-8000-000000000010',
        orderItemId: '92000000-0000-4000-8000-000000000011',
        quantity: 1, unitPaidAmount: 2_000, amount: 2_000,
      }],
    }), expect.anything())
  })

  it('does not promote a refund submission response to a verified terminal result', async () => {
    const requestRefund = vi.fn(async () => ({
      refundId: merchantRefundId, providerRefundId: merchantRefundId,
      providerRefundTransactionId: 'POSTAR-UNCONFIRMED-REFUND',
      originalProviderTransactionId: 'POSTAR-PAYMENT-001',
      status: 'succeeded' as const, amount: 2_000, currency: 'CNY',
      occurredAt: '2026-08-16T12:00:00.000Z',
    }))
    const recorder = observationRecorder()
    const service = new OnlinePaymentService(
      runner(new RefundTransaction(true)), 'test-secret-at-least-thirty-two-bytes', secrets,
      { createPayment: vi.fn(), queryPayment: vi.fn(), requestRefund, queryRefund: vi.fn() } as never,
      recorder,
    )

    const result = await service.requestRefund(scope, refundId, 'refund-submit-binding-0003')

    expect(result.observation.status).toBe('succeeded')
    expect(result.verifiedObservationId).toBeNull()
    expect(recorder.recordRefund).not.toHaveBeenCalled()
  })

  it('records a verified rejection when the provider synchronously refuses the refund', async () => {
    const requestRefund = vi.fn(async () => ({
      refundId: merchantRefundId, providerRefundId: merchantRefundId,
      providerRefundTransactionId: null, originalProviderTransactionId: 'POSTAR-PAYMENT-001',
      status: 'failed' as const, amount: 2_000, currency: 'CNY',
      failureReason: '021000: 商户余额不足',
      occurredAt: '2026-08-16T12:00:00.000Z',
    }))
    const recorder = observationRecorder()
    const service = new OnlinePaymentService(
      runner(new RefundTransaction(true)), 'test-secret-at-least-thirty-two-bytes', secrets,
      { createPayment: vi.fn(), queryPayment: vi.fn(), requestRefund, queryRefund: vi.fn() } as never,
      recorder,
    )
    const result = await service.requestRefund(scope, refundId, 'refund-submit-binding-failed')

    expect(result.observation.status).toBe('failed')
    expect(result.verifiedObservationId).toBe(verifiedObservationId)
    expect(recorder.recordRefund).toHaveBeenCalledWith(expect.objectContaining({
      integrationRef: 'postar-refund-submit-rejection',
      status: 'failed',
    }))
  })

  it.each(['native_qr', 'jsapi'] as const)(
    'blocks %s refunds when no verified settlement channel was stored',
    async (paymentMethod) => {
      const requestRefund = vi.fn()
      const service = new OnlinePaymentService(
        runner(new RefundTransaction(true, {
          payment_method: paymentMethod,
          settlement_channel: null,
          provider_snapshot: { channel: 'wechat' },
        })), 'test-secret-at-least-thirty-two-bytes', secrets,
        { createPayment: vi.fn(), queryPayment: vi.fn(), requestRefund, queryRefund: vi.fn() } as never,
        observationRecorder(),
      )

      await expect(service.requestRefund(scope, refundId, 'refund-submit-binding-0004'))
        .rejects.toBeInstanceOf(OnlinePaymentUnavailableError)
      expect(requestRefund).not.toHaveBeenCalled()
    },
  )

  it('queries instead of resubmitting after the first submission claim and accepts only a fully bound terminal result', async () => {
    const requestRefund = vi.fn()
    const queryRefund = vi.fn(async () => ({
      refundId: merchantRefundId, providerRefundId: merchantRefundId,
      providerRefundTransactionId: 'POSTAR-REFUND-001',
      originalProviderTransactionId: 'POSTAR-PAYMENT-001',
      status: 'succeeded' as const, amount: 2_000, currency: 'CNY',
      occurredAt: '2026-08-16T12:01:00.000Z',
    }))
    const service = new OnlinePaymentService(
      runner(new RefundTransaction(false)), 'test-secret-at-least-thirty-two-bytes', secrets,
      { createPayment: vi.fn(), queryPayment: vi.fn(), requestRefund, queryRefund } as never,
      observationRecorder(),
    )
    const result = await service.requestRefund(scope, refundId, 'refund-submit-binding-0005')

    expect(requestRefund).not.toHaveBeenCalled()
    expect(queryRefund).toHaveBeenCalledWith(expect.objectContaining({
      refundId: merchantRefundId, providerRefundId: merchantRefundId,
      merchantId: 'TESTMERCHANT', originalProviderTransactionId: 'POSTAR-PAYMENT-001',
      refundDate: '20260816',
    }), expect.anything())
    expect(result.observation.status).toBe('succeeded')
  })

  it('uses the strong first-submission timestamp rather than the request date or JSON evidence', async () => {
    const queryRefund = vi.fn(async () => ({
      refundId: merchantRefundId, providerRefundId: merchantRefundId,
      providerRefundTransactionId: null, originalProviderTransactionId: 'POSTAR-PAYMENT-001',
      status: 'processing' as const, amount: 2_000, currency: 'CNY',
      occurredAt: '2026-08-16T12:01:00.000Z',
    }))
    const service = new OnlinePaymentService(
      runner(new RefundTransaction(false, {
        created_at: '2026-08-14T03:00:00.000Z',
        provider_submission_started_at: '2026-08-16T03:00:00.000Z',
        provider_snapshot: { channel: 'wechat', occurredAt: '2026-08-15T03:00:00.000Z' },
      })), 'test-secret-at-least-thirty-two-bytes', secrets,
      { createPayment: vi.fn(), queryPayment: vi.fn(), requestRefund: vi.fn(), queryRefund } as never,
      observationRecorder(),
    )

    await service.queryRefund(scope, refundId, 'refund-query-binding-0001')

    expect(queryRefund).toHaveBeenCalledWith(expect.objectContaining({ refundDate: '20260816' }), expect.anything())
  })

  it('binds each active refund query attempt to its idempotency key', async () => {
    const queryRefund = vi.fn(async () => ({
      refundId: merchantRefundId, providerRefundId: merchantRefundId,
      providerRefundTransactionId: null, originalProviderTransactionId: 'POSTAR-PAYMENT-001',
      status: 'processing' as const, amount: 2_000, currency: 'CNY',
      occurredAt: '2026-08-16T12:01:00.000Z',
    }))
    const recorder = observationRecorder()
    const service = new OnlinePaymentService(
      runner(new RefundTransaction(false)), 'test-secret-at-least-thirty-two-bytes', secrets,
      { createPayment: vi.fn(), queryPayment: vi.fn(), requestRefund: vi.fn(), queryRefund } as never,
      recorder,
    )

    await service.queryRefund(scope, refundId, 'refund-query-binding-A')
    await service.queryRefund(scope, refundId, 'refund-query-binding-B')
    await service.queryRefund(scope, refundId, 'refund-query-binding-A')

    const firstEvent = recorder.recordRefund.mock.calls[0]?.[0].providerEventId
    const secondEvent = recorder.recordRefund.mock.calls[1]?.[0].providerEventId
    const replayEvent = recorder.recordRefund.mock.calls[2]?.[0].providerEventId
    expect(firstEvent).not.toBe(secondEvent)
    expect(replayEvent).toBe(firstEvent)
  })

  it('fails closed for pre-migration processing refunds marked for manual review', async () => {
    const requestRefund = vi.fn()
    const service = new OnlinePaymentService(
      runner(new RefundTransaction(false, {
        merchant_refund_id: null,
        provider_submission_started_at: null,
        provider_submission_state: 'manual_review',
      })), 'test-secret-at-least-thirty-two-bytes', secrets,
      { createPayment: vi.fn(), queryPayment: vi.fn(), requestRefund, queryRefund: vi.fn() } as never,
      observationRecorder(),
    )

    await expect(service.requestRefund(scope, refundId, 'refund-submit-binding-0006'))
      .rejects.toBeInstanceOf(OnlinePaymentUnavailableError)
    expect(requestRefund).not.toHaveBeenCalled()
  })

  it('keeps processing when an active query reports a mismatched amount', async () => {
    const service = new OnlinePaymentService(
      runner(new RefundTransaction(false)), 'test-secret-at-least-thirty-two-bytes', secrets,
      {
        createPayment: vi.fn(), queryPayment: vi.fn(), requestRefund: vi.fn(),
        queryRefund: vi.fn(async () => ({
          refundId: merchantRefundId, providerRefundId: merchantRefundId,
          providerRefundTransactionId: 'POSTAR-REFUND-001',
          originalProviderTransactionId: 'POSTAR-PAYMENT-001',
          status: 'succeeded' as const, amount: 1, currency: 'CNY',
          occurredAt: '2026-08-16T12:01:00.000Z',
        })),
      } as never,
      observationRecorder(),
    )
    await expect(service.queryRefund(scope, refundId, 'refund-query-binding-0002'))
      .rejects.toBeInstanceOf(OnlinePaymentUnknownError)
  })
})

function observationRecorder() {
  return {
    recordPayment: vi.fn(async () => verifiedObservationId),
    recordRefund: vi.fn(async () => verifiedObservationId),
  }
}

class RefundTransaction implements ScopedTransaction {
  readonly scope = scope
  readonly calls: string[] = []
  private submissionClaimed: boolean
  constructor(
    private readonly claimsSubmission: boolean,
    private readonly overrides: Record<string, unknown> = {},
  ) {
    this.submissionClaimed = !claimsSubmission
  }

  async query<Row extends Record<string, unknown>>(text: string) {
    const sql = text.replace(/\s+/g, ' ').trim()
    this.calls.push(sql)
    if (sql.startsWith('SELECT refund.id AS refund_id')) return result<Row>([{
      refund_id: refundId, refund_public_id: 'refund-public-test-0001', refund_status: 'processing',
      amount_minor: '2000', currency: 'CNY', created_at: '2026-08-15T03:00:00.000Z',
      payment_public_id: 'AP1234567890', payment_provider: 'postar', payment_method: 'native_qr',
      payment_status: 'succeeded', provider_transaction_id: 'POSTAR-PAYMENT-001',
      settlement_channel: 'wechat',
      merchant_refund_id: this.submissionClaimed ? merchantRefundId : null,
      provider_submission_started_at: this.submissionClaimed ? '2026-08-16T03:00:00.000Z' : null,
      provider_submission_state: this.submissionClaimed ? 'submitting' : 'not_started',
      provider_snapshot: { channel: 'wechat' }, refund_items: [],
      ...this.overrides,
    }])
    if (sql.includes("providerStatus', 'submission_started'")) {
      if (!this.claimsSubmission || this.submissionClaimed) return result<Row>([])
      this.submissionClaimed = true
      return result<Row>([{}])
    }
    if (sql.startsWith('UPDATE mbox.refunds')) return result<Row>([{}])
    throw new Error(`Unexpected refund query: ${sql}`)
  }
}

function runner(transaction: ScopedTransaction) {
  return {
    run: async (_scope: unknown, handler: (current: ScopedTransaction) => Promise<unknown>) => handler(transaction),
  } as never
}

function result<Row extends Record<string, unknown>>(rows: Record<string, unknown>[]) {
  return { rows: rows as Row[], rowCount: rows.length }
}
