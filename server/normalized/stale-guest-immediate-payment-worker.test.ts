import { describe, expect, it, vi } from 'vitest'
import {
  STALE_GUEST_IMMEDIATE_PAYMENT_DEFERRED_RETRY_SECONDS,
  STALE_GUEST_IMMEDIATE_PAYMENT_MIN_AGE_SECONDS,
  StaleGuestImmediatePaymentWorker,
} from './stale-guest-immediate-payment-worker.js'
import { OnlinePaymentUnavailableError, OnlinePaymentUnknownError, OnlineRefundStatusUnknownError } from './online-payment-service.js'

const scope = { tenantId: 'tenant', storeId: 'store' }
const businessDate = '2026-08-29'

function observed(id: string, status: 'closed' | 'failed' | 'succeeded') {
  return {
    context: { publicId: `PAY-${id}` },
    observation: {
      status, amount: 25_600, currency: 'CNY', providerTransactionId: `TX-${id}`,
      settlementChannel: 'wechat', occurredAt: '2026-08-29T04:00:00.000Z',
    },
    verifiedObservationId: `obs-${id}`,
  }
}

describe('stale guest immediate payment worker', () => {
  it('automatically applies only a provider-verified terminal refund result', async () => {
    const listRefunds = vi.fn(async () => ['refund-processing'])
    const queryRefund = vi.fn(async () => ({
      refundId: 'refund-processing', refundPublicId: 'R-public', merchantRefundId: 'merchant-refund',
      paymentPublicId: 'P-public', originalProviderTransactionId: 'payment-provider-txn',
      amountMinor: 4_000, currency: 'CNY', verifiedObservationId: 'refund-observation',
      observation: {
        refundId: 'merchant-refund', providerRefundId: 'merchant-refund',
        providerRefundTransactionId: 'refund-provider-txn',
        originalProviderTransactionId: 'payment-provider-txn', status: 'succeeded' as const,
        amount: 4_000, currency: 'CNY', occurredAt: '2026-09-07T10:00:00.000Z',
      },
    }))
    const recordProviderRefundResult = vi.fn(async () => ({ replayed: false, value: {} }))
    const worker = new StaleGuestImmediatePaymentWorker({
      onlinePayments: {
        listStaleGuestImmediateCheckoutPaymentCandidates: vi.fn(async () => []), closeSystem: vi.fn(),
        listStaleProcessingPostarRefundIds: listRefunds, queryRefund,
      } as never,
      payments: { recordProviderQueryResult: vi.fn(), recordProviderRefundResult } as never,
      reconciliation: { commitTerminal: vi.fn(), abandonUnresolved: vi.fn() } as never,
    })

    const result = await worker.runBatch(scope, 'worker-test', businessDate)

    expect(listRefunds).toHaveBeenCalledWith(scope, 15, 20)
    expect(queryRefund).toHaveBeenCalledWith(scope, 'refund-processing', expect.stringMatching(/^pending-refund:/))
    expect(recordProviderRefundResult).toHaveBeenCalledWith(expect.objectContaining({
      refundPublicId: 'merchant-refund', verifiedObservationId: 'refund-observation',
      providerRefundId: 'refund-provider-txn', succeeded: true,
      actor: { type: 'integration', ref: 'postar-refund-active-query' },
    }))
    expect(result.terminalRefundIds).toEqual(['refund-processing'])
    expect(result.failedRefundIds).toEqual([])
  })

  it('keeps a non-terminal refund in reconciliation without blocking table payment recovery', async () => {
    const worker = new StaleGuestImmediatePaymentWorker({
      onlinePayments: {
        listStaleGuestImmediateCheckoutPaymentCandidates: vi.fn(async () => []), closeSystem: vi.fn(),
        listStaleProcessingPostarRefundIds: vi.fn(async () => ['refund-waiting']),
        queryRefund: vi.fn(async () => ({
          verifiedObservationId: 'refund-observation', merchantRefundId: 'merchant-refund',
          observation: { status: 'processing' as const },
        })),
      } as never,
      payments: { recordProviderQueryResult: vi.fn(), recordProviderRefundResult: vi.fn() } as never,
      reconciliation: { commitTerminal: vi.fn(), abandonUnresolved: vi.fn() } as never,
    })

    const result = await worker.runBatch(scope, 'worker-test', businessDate)

    expect(result.deferredRefundIds).toEqual(['refund-waiting'])
    expect(result.failedRefundIds).toEqual([])
  })

  it('treats a refund query outage as deferred financial follow-up, not worker failure', async () => {
    const closeSystem = vi.fn(async () => observed('table-still-operates', 'closed'))
    const commitTerminal = vi.fn(async () => ({ replayed: false, value: {} }))
    const worker = new StaleGuestImmediatePaymentWorker({
      onlinePayments: {
        listStaleGuestImmediateCheckoutPaymentCandidates: vi.fn(async () => [{
          id: 'payment-table-still-operates',
          createdAt: '2026-08-29T03:00:00.000Z',
          operationallyAbandoned: false,
        }]),
        closeSystem,
        listStaleProcessingPostarRefundIds: vi.fn(async () => ['refund-provider-outage']),
        queryRefund: vi.fn(async () => { throw new OnlineRefundStatusUnknownError() }),
      } as never,
      payments: { recordProviderQueryResult: vi.fn(), recordProviderRefundResult: vi.fn() } as never,
      reconciliation: { commitTerminal, abandonUnresolved: vi.fn() } as never,
    })

    const result = await worker.runBatch(scope, 'worker-test', businessDate)

    expect(result.deferredRefundIds).toEqual(['refund-provider-outage'])
    expect(result.failedRefundIds).toEqual([])
    expect(closeSystem).toHaveBeenCalledTimes(1)
    expect(commitTerminal).toHaveBeenCalledTimes(1)
    expect(result.terminalAbandonedPaymentIds).toEqual(['payment-table-still-operates'])
  })

  it('reconciles general pending payments in the worker instead of a page read', async () => {
    const listGeneral = vi.fn(async () => ['payment-general'])
    const querySystem = vi.fn(async () => observed('general', 'succeeded'))
    const recordProviderQueryResult = vi.fn(async () => ({ replayed: false, value: {} }))
    const worker = new StaleGuestImmediatePaymentWorker({
      onlinePayments: {
        listStalePendingPostarPaymentIds: listGeneral,
        querySystem,
        listStaleGuestImmediateCheckoutPaymentCandidates: vi.fn(async () => []),
        closeSystem: vi.fn(),
      } as never,
      payments: { recordProviderQueryResult } as never,
      reconciliation: { commitTerminal: vi.fn(), abandonUnresolved: vi.fn() } as never,
    })

    await worker.runBatch(scope, 'worker-test', businessDate, { now: () => 90_000 })

    expect(listGeneral).toHaveBeenCalledWith(scope, 15, 20)
    expect(querySystem).toHaveBeenCalledWith(expect.objectContaining({ paymentId: 'payment-general' }))
    expect(recordProviderQueryResult).toHaveBeenCalledWith(expect.objectContaining({ paymentPublicId: 'PAY-general' }))
  })

  it('queries then retires only an unpaid terminal guest checkout', async () => {
    const list = vi.fn(async () => [{
      id: 'payment-terminal', createdAt: '2026-08-29T03:00:00.000Z', operationallyAbandoned: false,
    }])
    const closeSystem = vi.fn(async () => observed('terminal', 'closed'))
    const commitTerminal = vi.fn(async () => ({ replayed: false, value: {} }))
    const worker = new StaleGuestImmediatePaymentWorker({
      onlinePayments: { listStaleGuestImmediateCheckoutPaymentCandidates: list, closeSystem } as never,
      payments: { recordProviderQueryResult: vi.fn() } as never,
      reconciliation: { commitTerminal, abandonUnresolved: vi.fn() } as never,
    })

    const result = await worker.runBatch(scope, 'worker-test', businessDate)

    expect(list).toHaveBeenCalledWith(scope, STALE_GUEST_IMMEDIATE_PAYMENT_MIN_AGE_SECONDS, 20)
    expect(closeSystem).toHaveBeenCalledWith(expect.objectContaining({ paymentId: 'payment-terminal' }))
    expect(commitTerminal).toHaveBeenCalledWith(expect.objectContaining({
      paymentPublicId: 'PAY-terminal', status: 'closed', workerId: 'worker-test',
      actor: { type: 'integration', ref: 'postar-close-payment' },
    }))
    expect(result.terminalAbandonedPaymentIds).toEqual(['payment-terminal'])
  })

  it('records a provider-confirmed success through the normal paid path', async () => {
    const recordProviderQueryResult = vi.fn(async () => ({ replayed: false, value: {} }))
    const worker = new StaleGuestImmediatePaymentWorker({
      onlinePayments: {
        listStaleGuestImmediateCheckoutPaymentCandidates: vi.fn(async () => [{
          id: 'payment-paid', createdAt: '2026-08-29T03:00:00.000Z', operationallyAbandoned: false,
        }]),
        closeSystem: vi.fn(async () => observed('paid', 'succeeded')),
      } as never,
      payments: { recordProviderQueryResult } as never,
      reconciliation: { commitTerminal: vi.fn(), abandonUnresolved: vi.fn() } as never,
    })

    const result = await worker.runBatch(scope, 'worker-test', businessDate)

    expect(recordProviderQueryResult).toHaveBeenCalledWith(expect.objectContaining({
      paymentPublicId: 'PAY-paid', status: 'succeeded',
      actor: { type: 'integration', ref: 'postar-close-payment' },
    }))
    expect(result.paidPaymentIds).toEqual(['payment-paid'])
  })

  it('continues to query an operationally abandoned payment for late capture, without retiring it twice', async () => {
    const recordProviderQueryResult = vi.fn(async () => ({ replayed: false, value: {} }))
    const commitTerminal = vi.fn()
    const worker = new StaleGuestImmediatePaymentWorker({
      onlinePayments: {
        listStaleGuestImmediateCheckoutPaymentCandidates: vi.fn(async () => [{
          id: 'payment-late', createdAt: '2026-08-29T03:00:00.000Z', operationallyAbandoned: true,
        }]),
        closeSystem: vi.fn(async () => observed('late', 'succeeded')),
      } as never,
      payments: { recordProviderQueryResult } as never,
      reconciliation: { commitTerminal, abandonUnresolved: vi.fn() } as never,
    })

    const result = await worker.runBatch(scope, 'worker-test', businessDate)

    expect(recordProviderQueryResult).toHaveBeenCalledTimes(1)
    expect(recordProviderQueryResult).toHaveBeenCalledWith(expect.objectContaining({
      actor: { type: 'integration', ref: 'postar-close-payment' },
    }))
    expect(commitTerminal).not.toHaveBeenCalled()
    expect(result.paidPaymentIds).toEqual(['payment-late'])
  })

  it('consumes an abandoned terminal result with the close observation authority', async () => {
    const recordProviderQueryResult = vi.fn(async (input: { actor: { ref: string } }) => {
      if (input.actor.ref !== 'postar-close-payment') throw new Error('observation integration mismatch')
      return { replayed: false, value: {} }
    })
    const worker = new StaleGuestImmediatePaymentWorker({
      onlinePayments: {
        listStaleGuestImmediateCheckoutPaymentCandidates: vi.fn(async () => [{
          id: 'payment-abandoned-failed',
          createdAt: '2026-08-29T03:00:00.000Z',
          operationallyAbandoned: true,
        }]),
        closeSystem: vi.fn(async () => observed('abandoned-failed', 'failed')),
      } as never,
      payments: { recordProviderQueryResult } as never,
      reconciliation: { commitTerminal: vi.fn(), abandonUnresolved: vi.fn() } as never,
    })

    const result = await worker.runBatch(scope, 'worker-test', businessDate)

    expect(recordProviderQueryResult).toHaveBeenCalledWith(expect.objectContaining({
      paymentPublicId: 'PAY-abandoned-failed',
      status: 'failed',
      actor: { type: 'integration', ref: 'postar-close-payment' },
    }))
    expect(result.failedPaymentIds).toEqual([])
  })

  it('keeps the close binding within the command idempotency limit for a production worker id', async () => {
    const paymentId = '1055bfcb-2711-45d5-a88a-3cc1cc07e10e'
    const productionWorkerId = 'mbox-mini-d25b3a4:stale-guest-immediate-payment-reconciliation'
    let providerBinding = ''
    const recordProviderQueryResult = vi.fn(async (input: {
      actor: { ref: string }
      idempotencyKey: string
    }) => {
      expect(input.actor.ref).toBe('postar-close-payment')
      expect(input.idempotencyKey).toBe(providerBinding)
      expect(input.idempotencyKey.length).toBeLessThanOrEqual(128)
      return { replayed: false, value: {} }
    })
    const worker = new StaleGuestImmediatePaymentWorker({
      onlinePayments: {
        listStaleGuestImmediateCheckoutPaymentCandidates: vi.fn(async () => [{
          id: paymentId,
          createdAt: '2026-08-29T03:00:00.000Z',
          operationallyAbandoned: true,
        }]),
        closeSystem: vi.fn(async (input: { closeBindingId: string }) => {
          providerBinding = input.closeBindingId
          expect(providerBinding.length).toBeLessThanOrEqual(128)
          return observed('production-binding', 'failed')
        }),
      } as never,
      payments: { recordProviderQueryResult } as never,
      reconciliation: { commitTerminal: vi.fn(), abandonUnresolved: vi.fn() } as never,
    })

    const result = await worker.runBatch(scope, productionWorkerId, businessDate)

    expect(providerBinding).toMatch(new RegExp(`^stale-guest-checkout:${paymentId}:[0-9a-f-]{36}$`))
    expect(result.failedPaymentIds).toEqual([])
  })

  it('defers fresh channel unavailability but operationally retires only an older unresolved checkout', async () => {
    const now = Date.parse('2026-08-29T06:00:00.000Z')
    const abandonUnresolved = vi.fn(async () => ({ replayed: false, value: {} }))
    const worker = new StaleGuestImmediatePaymentWorker({
      onlinePayments: {
        listStaleGuestImmediateCheckoutPaymentCandidates: vi.fn(async () => [
          { id: 'payment-fresh', createdAt: '2026-08-29T05:30:00.000Z', operationallyAbandoned: false },
          { id: 'payment-old', createdAt: '2026-08-29T02:00:00.000Z', operationallyAbandoned: false },
        ]),
        closeSystem: vi.fn(async () => { throw new OnlinePaymentUnavailableError() }),
      } as never,
      payments: { recordProviderQueryResult: vi.fn() } as never,
      reconciliation: { commitTerminal: vi.fn(), abandonUnresolved } as never,
    })

    const result = await worker.runBatch(scope, 'worker-test', businessDate, {
      unresolvedAbandonAgeSeconds: 2 * 60 * 60, now: () => now,
    })

    expect(abandonUnresolved).toHaveBeenCalledTimes(1)
    expect(abandonUnresolved).toHaveBeenCalledWith(expect.objectContaining({ paymentId: 'payment-old' }))
    expect(result.deferredPaymentIds).toEqual(['payment-fresh'])
    expect(result.unresolvedAbandonedPaymentIds).toEqual(['payment-old'])
  })

  it('backs off an abandoned unknown payment without failing readiness or repeatedly querying the channel', async () => {
    let now = Date.parse('2026-08-29T06:00:00.000Z')
    const closeSystem = vi.fn(async () => { throw new OnlinePaymentUnknownError() })
    let due = true
    const recordAutomaticPaymentQueryOutcome = vi.fn(async () => { due = false })
    const worker = new StaleGuestImmediatePaymentWorker({
      onlinePayments: {
        listStaleGuestImmediateCheckoutPaymentCandidates: vi.fn(async () => due ? [{
          id: 'payment-abandoned', createdAt: '2026-08-29T05:00:00.000Z', operationallyAbandoned: true,
        }] : []),
        closeSystem, recordAutomaticPaymentQueryOutcome,
      } as never,
      payments: { recordProviderQueryResult: vi.fn() } as never,
      reconciliation: { commitTerminal: vi.fn(), abandonUnresolved: vi.fn() } as never,
    })

    const first = await worker.runBatch(scope, 'worker-test', businessDate, { now: () => now })
    now += 30_000
    const second = await worker.runBatch(scope, 'worker-test', businessDate, { now: () => now })
    now += STALE_GUEST_IMMEDIATE_PAYMENT_DEFERRED_RETRY_SECONDS * 1_000
    due = true
    const third = await worker.runBatch(scope, 'worker-test', businessDate, { now: () => now })

    expect(first.failedPaymentIds).toEqual([])
    expect(second.failedPaymentIds).toEqual([])
    expect(third.failedPaymentIds).toEqual([])
    expect(first.deferredPaymentIds).toEqual(['payment-abandoned'])
    expect(second.deferredPaymentIds).toEqual([])
    expect(recordAutomaticPaymentQueryOutcome).toHaveBeenCalledWith(
      scope, 'payment-abandoned', 'error', undefined, true,
    )
    expect(closeSystem).toHaveBeenCalledTimes(2)
  })
})
