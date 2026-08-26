import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createCashReceiptReference, shortPaymentOrderLabel } from './table-payment-model'

describe('TablePaymentSheet', () => {
  it('creates a traceable cash receipt reference without asking staff to type one', () => {
    expect(createCashReceiptReference(
      'L 03',
      new Date('2026-08-27T15:30:45.000Z'),
      'abcdef12',
    )).toBe('CASH-L03-20260827153045-abcdef12')
    expect(shortPaymentOrderLabel('order-a4eb851aefe494d70ceeb885')).toBe('订单 …0ceeb885')
  })

  it('can query a persisted unresolved attempt and offers cash beside both scan methods', () => {
    const source = readFileSync(new URL('./TablePaymentSheet.tsx', import.meta.url), 'utf8')

    expect(source).toContain('action?.paymentId ?? selected?.unresolvedOnlinePaymentId ?? null')
    expect(source).toContain('api.queryOnlinePayment(activePaymentId)')
    expect(source).toContain('确认已收到现金')
    expect(source).toContain("provider: 'cash'")
    expect(source).toContain('重新读取本桌收款')
  })
})
