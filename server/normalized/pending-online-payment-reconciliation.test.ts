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

  it('keeps confirmed application failures separate from provider outages and retries the next payment', async () => {
    const log = vi.spyOn(console,'error').mockImplementation(() => {})
    const querySystem = vi.fn(async () => ({context:{publicId:'P-1'},
      observation:{status:'succeeded',amount:8800,currency:'CNY',providerTransactionId:'TX-1',occurredAt:'2026-09-11T14:30:30.000Z'},
      verifiedObservationId:'obs-1'}))
    const recordAutomaticPaymentQueryOutcome = vi.fn(async () => undefined)
    const recordProviderQueryResult = vi.fn().mockRejectedValueOnce(Object.assign(new Error('private SQL or token must not be logged'),{code:'23514'}))
      .mockResolvedValue({replayed:false,value:{}})
    const result = await reconcileStalePendingOnlinePaymentsForStore({onlinePayments:{
      listStalePendingPostarPaymentIds:async()=>['pay-1','pay-2'],querySystem,recordAutomaticPaymentQueryOutcome,
    } as never,commands:{recordProviderQueryResult}},
    {scope:{tenantId:'tenant',storeId:'store'},businessDate:'2026-09-11',actor:{type:'integration',ref:'test'}},'application-failure')
    expect(result).toMatchObject({attempted:2,reconciled:1})
    expect(recordAutomaticPaymentQueryOutcome).toHaveBeenCalledWith({tenantId:'tenant',storeId:'store'},'pay-1','error','succeeded',false)
    expect(JSON.parse(log.mock.calls[0]![0])).toEqual({event:'payment_reconciliation_failed',paymentId:'pay-1',stage:'apply_verified_success',errorCode:'23514'})
    expect(JSON.stringify(log.mock.calls)).not.toContain('private SQL')
    log.mockRestore()
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
    const recordAutomaticPaymentQueryOutcome = vi.fn(async () => undefined)
    const recordProviderQueryResult = vi.fn(async () => ({ replayed: false, value: {} }))
    const result = await reconcileStalePendingOnlinePaymentsForStore(
      {
        onlinePayments: {
          listStalePendingPostarPaymentIds, querySystem, recordAutomaticPaymentQueryOutcome,
        } as never,
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
    expect(recordAutomaticPaymentQueryOutcome).toHaveBeenCalledWith(
      { tenantId: 'tenant', storeId: 'store' }, 'pay-1', 'terminal', 'succeeded', false,
    )
    expect(recordAutomaticPaymentQueryOutcome).toHaveBeenCalledWith(
      { tenantId: 'tenant', storeId: 'store' }, 'pay-2', 'error', undefined, false,
    )
  })
})
