import { describe, expect, it } from 'vitest'
import type { WorkstationConfig } from '../shared/contracts'
import type { KdsTask } from '../shared/order-contracts'
import {
  actionAllowedForAccess,
  canManagerCancelKds,
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
      roleIds: [roleId],
      mode,
    } as unknown as FulfillmentAccess)

    expect(canResolveKdsException(access('supervisor', 'oversight'))).toBe(true)
    expect(canResolveKdsException(access('manager', 'oversight'))).toBe(true)
    expect(canResolveKdsException(access('bartender', 'production'))).toBe(false)
  })

  it('lets only an oversight manager with table-close permission cancel an active fulfillment item', () => {
    const access = (roleId: string, mode: FulfillmentAccess['mode']): FulfillmentAccess => ({
      employee: { roleId, roleIds: [] },
      roleIds: [roleId],
      mode,
    } as unknown as FulfillmentAccess)

    expect(canManagerCancelKds(access('manager', 'oversight'), ['table.close'])).toBe(true)
    expect(canManagerCancelKds(access('manager', 'oversight'), [])).toBe(false)
    expect(canManagerCancelKds(access('bartender', 'production'), ['table.close'])).toBe(false)
  })

  it('requires permission, effective role, workstation, skill and active shift before showing production controls', () => {
    const queuedTask = {
      ...task([], 'queued'),
      stationId: 'bar-main',
      workstation: {
        id: 'bar-main', name: '主吧台', productionRoleIds: ['bartender'], deliveryRoleIds: ['runner'],
        requiredSkillIds: ['skill-bar'], deliveryServiceTypeId: 'fulfillment-delivery',
        productionSlaSeconds: 180, pickupSlaSeconds: 60, configVersion: 1,
      },
    } as KdsTask
    const workstations: WorkstationConfig[] = [{
      ...queuedTask.workstation!, kind: 'hybrid', enabled: true, fallbackStationId: null,
      deliveryServiceTypeId: queuedTask.workstation?.deliveryServiceTypeId ?? null,
    }]
    const baseAccess = {
      employee: { id: 'emp-manager', roleId: 'manager', roleIds: [], skillIds: ['skill-bar'], online: true, paused: false },
      roleIds: ['manager'], stationIds: ['bar-main'], stationScoped: false, hasActiveShift: true,
      canPrepare: true, canDeliver: true,
    } as unknown as FulfillmentAccess

    expect(actionAllowedForAccess(queuedTask, baseAccess, workstations)).toBe(false)
    expect(actionAllowedForAccess(queuedTask, { ...baseAccess, roleIds: ['manager', 'bartender'] }, workstations)).toBe(true)
    expect(actionAllowedForAccess(queuedTask, {
      ...baseAccess,
      roleIds: ['bartender'],
      employee: { ...baseAccess.employee!, skillIds: [] },
    }, workstations)).toBe(false)
    expect(actionAllowedForAccess(queuedTask, {
      ...baseAccess,
      roleIds: ['bartender'],
      hasActiveShift: false,
    }, workstations)).toBe(false)
  })
})
