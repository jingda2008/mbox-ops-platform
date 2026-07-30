import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { BootstrapResponse } from '../shared/contracts'
import { canEmployeeApproveRefund } from '../shared/staff-access'
import type { PaymentIntent } from '../shared/payment-contracts'
import { createSeedState } from '../../server/seed'
import { activeRecollectionIntent, preferredTableAccountId, tableFromSession } from './PaymentView'

const paymentStyles = readFileSync(new URL('./PaymentView.css', import.meta.url), 'utf8')

describe('cashier table account presentation', () => {
  it('opens the first account that can still collect money by default', () => {
    expect(preferredTableAccountId([
      { tableSessionId: 'settled', collectableAmount: 0 },
      { tableSessionId: 'due-first', collectableAmount: 6800 },
      { tableSessionId: 'due-second', collectableAmount: 8800 },
    ])).toBe('due-first')
    expect(preferredTableAccountId([{ tableSessionId: 'settled', collectableAmount: 0 }])).toBe('')
    expect(preferredTableAccountId([])).toBe('')
  })

  it('resolves the current table from the mutable table session instead of its historical id', () => {
    const data = {
      tables: [
        { id: 'table-l01', code: 'L01', displayName: '林村01' },
        { id: 'table-v02', code: 'V02', displayName: '舞台02' },
      ],
      songState: {
        tableSessions: [{
          id: 'session:table-l01:before-transfer',
          tableId: 'table-v02',
          tableCode: 'V02',
          status: 'open',
          openedAt: '2026-07-17T12:00:00.000Z',
          closedAt: null,
        }],
      },
    } as unknown as BootstrapResponse

    expect(tableFromSession(data, 'session:table-l01:before-transfer')?.code).toBe('V02')
  })

  it('keeps collapsed rows compact and exposes a dedicated details region', () => {
    expect(paymentStyles).toContain('.table-account-summary')
    expect(paymentStyles).toContain('.table-account-details')
    expect(paymentStyles).toContain('.table-account-toggle:focus-visible')
  })

  it('requires a different approver with both permission and sufficient amount limit', () => {
    const data = createSeedState(new Date('2026-07-30T12:00:00.000Z')) as BootstrapResponse
    const administrator = data.employees.find((employee) => employee.id === 'emp-admin')!
    administrator.permissionIds = [...(administrator.permissionIds ?? []), 'payment.refund.approve']

    expect(canEmployeeApproveRefund(data, 'emp-admin', 'emp-chen', 62_800)).toBe(false)
    expect(canEmployeeApproveRefund(data, 'emp-owner', 'emp-chen', 62_800)).toBe(true)
    expect(canEmployeeApproveRefund(data, 'emp-owner', 'emp-owner', 62_800)).toBe(false)
  })

  it('allows a new recollection after a failed attempt and prefers the latest active attempt', () => {
    const intent = (id: string, status: PaymentIntent['status']): PaymentIntent => ({
      id,
      sourceRefundId: 'refund-1',
      status,
    } as PaymentIntent)

    expect(activeRecollectionIntent([
      intent('closed-first', 'closed'),
      intent('failed-second', 'failed'),
    ], 'refund-1')).toBeUndefined()
    expect(activeRecollectionIntent([
      intent('closed-first', 'closed'),
      intent('pending-second', 'pending'),
    ], 'refund-1')?.id).toBe('pending-second')
  })
})
