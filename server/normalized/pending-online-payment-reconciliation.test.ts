import { describe, expect, it, vi } from 'vitest'
import {
  PENDING_PAYMENT_RECONCILE_MIN_AGE_SECONDS,
  reconcileStalePendingOnlinePaymentsForStore,
  shouldReconcilePaymentContext,
} from './pending-online-payment-reconciliation.js'

describe('pending online payment reconciliation', () => {
  it('only reconciles stale postar payments that are still open', () => {
    const createdAt = new Date(Date.now() - (PENDING_PAYMENT_RECONCILE_MIN_AGE_SECONDS + 5) * 1_000).toISOString()
    expect(shouldReconcilePaymentContext({
      provider: 'postar',
      status: 'pending',
      createdAt,
    })).toBe(true)
    expect(shouldReconcilePaymentContext({
      provider: 'postar',
      status: 'succeeded',
      createdAt,
    })).toBe(false)
    expect(shouldReconcilePaymentContext({
      provider: 'cash',
      status: 'pending',
      createdAt,
    })).toBe(false)
    expect(shouldReconcilePaymentContext({
      provider: 'postar',
      status: 'pending',
      createdAt: new Date().toISOString(),
    })).toBe(false)
  })

  it('reconciles each stale payment without aborting the batch', async () => {
    const listStalePendingPostarPaymentIds = vi.fn(async () => ['pay-1', 'pay-2'])
    const querySystem = vi.fn()
      .mockResolvedValueOnce({
        context: { publicId: 'P-1' },
        observation: { status: 'succeeded', amount: 10000, currency: 'CNY', providerTransactionId: 'TX-1', occurredAt: '2026-08-23T07:21:12.000Z' },
        verifiedObservationId: 'obs-1',
      })
      .mockRejectedValueOnce(new Error('provider timeout'))
    const recordProviderQueryResult = vi.fn(async () => ({ replayed: false, value: {} }))
    const result = await reconcileStalePendingOnlinePaymentsForStore(
      {
        onlinePayments: { listStalePendingPostarPaymentIds, querySystem } as never,
        commands: { recordProviderQueryResult },
      },
      {
        scope: { tenantId: 'tenant', storeId: 'store' },
        businessDate: '2026-08-23',
        actor: { type: 'integration', ref: 'test' },
      },
      'batch-test',
    )
    expect(result.attempted).toBe(2)
    expect(result.reconciled).toBe(1)
    expect(recordProviderQueryResult).toHaveBeenCalledTimes(1)
  })
})
