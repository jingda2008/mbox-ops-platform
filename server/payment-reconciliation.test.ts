import { describe, expect, it } from 'vitest'
import type {
  InternalReconciliationEntry,
  ProviderBillEntry,
} from '../src/shared/payment-provider-contracts.js'
import {
  reconcileDailyPayments,
  updateReconciliationManualStatus,
} from './payment-reconciliation.js'

const internalEntries: InternalReconciliationEntry[] = [
  {
    internalEntryId: 'payment-1',
    providerTransactionId: 'tx-match',
    type: 'payment',
    status: 'succeeded',
    amount: 3000,
    currency: 'CNY',
    occurredAt: '2026-07-14T12:01:00.000Z',
  },
  {
    internalEntryId: 'payment-2',
    providerTransactionId: 'tx-amount',
    type: 'payment',
    status: 'succeeded',
    amount: 2000,
    currency: 'CNY',
    occurredAt: '2026-07-14T12:02:00.000Z',
  },
  {
    internalEntryId: 'refund-1',
    providerTransactionId: 'tx-internal-only',
    type: 'refund',
    status: 'succeeded',
    amount: 1200,
    currency: 'CNY',
    occurredAt: '2026-07-14T12:03:00.000Z',
  },
]

const providerEntries: ProviderBillEntry[] = [
  {
    providerEntryId: 'bill-1',
    providerTransactionId: 'tx-match',
    type: 'payment',
    status: 'succeeded',
    amount: 3000,
    currency: 'CNY',
    occurredAt: '2026-07-14T12:01:00.000Z',
  },
  {
    providerEntryId: 'bill-2',
    providerTransactionId: 'tx-amount',
    type: 'payment',
    status: 'succeeded',
    amount: 1999,
    currency: 'CNY',
    occurredAt: '2026-07-14T12:02:00.000Z',
  },
  {
    providerEntryId: 'bill-3',
    providerTransactionId: 'tx-provider-only',
    type: 'refund',
    status: 'succeeded',
    amount: 600,
    currency: 'CNY',
    occurredAt: '2026-07-14T12:04:00.000Z',
  },
  {
    providerEntryId: 'bill-4',
    providerTransactionId: 'tx-match',
    type: 'payment',
    status: 'succeeded',
    amount: 3000,
    currency: 'CNY',
    occurredAt: '2026-07-14T12:01:00.000Z',
  },
]

function run() {
  return reconcileDailyPayments({
    runId: 'reconciliation-2026-07-14',
    provider: 'provider-a',
    merchantId: 'merchant-mbox',
    businessDate: '2026-07-14',
    createdAt: '2026-07-15T04:00:00.000Z',
    internalEntries,
    providerEntries,
  })
}

describe('daily payment reconciliation', () => {
  it('classifies matches, one-sided records, amount differences and duplicate bill rows', () => {
    const result = run()

    expect(result.items.map((item) => item.differenceType)).toEqual([
      'matched',
      'amount_mismatch',
      'internal_only',
      'provider_only',
      'duplicate_provider_entry',
    ])
    expect(result.items[0]?.manualStatus).toBe('not_required')
    expect(result.items.slice(1).every((item) => item.manualStatus === 'pending')).toBe(true)
  })

  it('does not match equal amounts without the same provider transaction id and type', () => {
    const result = reconcileDailyPayments({
      runId: 'reconciliation-equal-amounts',
      provider: 'provider-a',
      merchantId: 'merchant-mbox',
      businessDate: '2026-07-14',
      createdAt: '2026-07-15T04:00:00.000Z',
      internalEntries: [{ ...internalEntries[0]!, providerTransactionId: 'tx-internal' }],
      providerEntries: [{ ...providerEntries[0]!, providerTransactionId: 'tx-provider' }],
    })

    expect(result.items.map((item) => item.differenceType)).toEqual([
      'internal_only',
      'provider_only',
    ])
  })
})

describe('manual reconciliation workflow', () => {
  it('records investigation and resolution with actor, reason and resolution', () => {
    const result = run()
    const mismatch = result.items.find((item) => item.differenceType === 'amount_mismatch')!

    updateReconciliationManualStatus(result, {
      itemId: mismatch.id,
      status: 'investigating',
      actorId: 'finance-1',
      reason: '向渠道核对手续费前金额',
      occurredAt: '2026-07-15T05:00:00.000Z',
    })
    updateReconciliationManualStatus(result, {
      itemId: mismatch.id,
      status: 'resolved',
      actorId: 'finance-manager-1',
      reason: '渠道账单已更正并重新验证',
      resolution: 'provider_corrected',
      occurredAt: '2026-07-15T06:00:00.000Z',
    })

    expect(mismatch.manualStatus).toBe('resolved')
    expect(mismatch.resolution).toBe('provider_corrected')
    expect(mismatch.manualEvents).toHaveLength(2)
    expect(mismatch.manualEvents[0]?.actorId).toBe('finance-1')
  })

  it('requires a resolution to close and rejects manual handling of matched rows', () => {
    const result = run()
    const mismatch = result.items.find((item) => item.differenceType === 'amount_mismatch')!
    const matched = result.items.find((item) => item.differenceType === 'matched')!

    expect(() =>
      updateReconciliationManualStatus(result, {
        itemId: mismatch.id,
        status: 'resolved',
        actorId: 'finance-1',
        reason: '尝试直接结案',
        occurredAt: '2026-07-15T05:00:00.000Z',
      }),
    ).toThrow('结案必须填写处理结论')
    expect(() =>
      updateReconciliationManualStatus(result, {
        itemId: matched.id,
        status: 'investigating',
        actorId: 'finance-1',
        reason: '不应人工处理',
        occurredAt: '2026-07-15T05:00:00.000Z',
      }),
    ).toThrow('已自动对平的明细不需要人工处理')
  })
})
