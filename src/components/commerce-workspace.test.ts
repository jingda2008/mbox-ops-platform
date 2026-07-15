import { describe, expect, it } from 'vitest'
import type { KdsTask } from '../shared/order-contracts'
import {
  canResolveKdsException,
  kdsTaskOperationallyActive,
  openKdsException,
  type FulfillmentAccess,
} from './commerce-workspace'

function task(events: KdsTask['exceptionEvents'] = [], status: KdsTask['status'] = 'queued') {
  return { id: 'kds-1', status, exceptionEvents: events } as KdsTask
}

const report = {
  id: 'event-report',
  exceptionId: 'exception-1',
  type: 'reported',
  exceptionKind: 'shortage',
  reasonCode: 'product_out_of_stock',
} as const

describe('KDS exception workspace projection', () => {
  it('keeps an open exception visible and removes the original task after disposition', () => {
    const open = task([report] as KdsTask['exceptionEvents'], 'delivered')
    expect(openKdsException(open)?.exceptionId).toBe('exception-1')
    expect(kdsTaskOperationallyActive(open)).toBe(true)

    const resolved = task([
      report,
      { ...report, id: 'event-decision', type: 'manager_disposition', managerDisposition: 'remake' },
    ] as KdsTask['exceptionEvents'])
    expect(openKdsException(resolved)).toBeUndefined()
    expect(kdsTaskOperationallyActive(resolved)).toBe(false)
  })

  it('only exposes manager disposition controls to oversight roles', () => {
    const access = (roleId: string, mode: FulfillmentAccess['mode']): FulfillmentAccess => ({
      employee: { roleId, roleIds: [] },
      mode,
    } as unknown as FulfillmentAccess)

    expect(canResolveKdsException(access('supervisor', 'oversight'))).toBe(true)
    expect(canResolveKdsException(access('manager', 'oversight'))).toBe(true)
    expect(canResolveKdsException(access('bartender', 'production'))).toBe(false)
  })
})
