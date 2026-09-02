import { describe, expect, it, vi } from 'vitest'
import {
  STALE_GUEST_IMMEDIATE_PAYMENT_MIN_AGE_SECONDS,
  StaleGuestImmediatePaymentWorker,
} from './stale-guest-immediate-payment-worker.js'
import { OnlinePaymentUnavailableError } from './online-payment-service.js'

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
    expect(commitTerminal).not.toHaveBeenCalled()
    expect(result.paidPaymentIds).toEqual(['payment-late'])
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
})
