import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { BootstrapResponse } from '../shared/contracts'
import { preferredTableAccountId, tableFromSession } from './PaymentView'

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
})
