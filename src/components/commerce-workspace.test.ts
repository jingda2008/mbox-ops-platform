import { describe, expect, it } from 'vitest'
import type { WorkstationConfig } from '../shared/contracts'
import type { KdsTask } from '../shared/order-contracts'
import type { PrintJob } from '../shared/commercial-ops-contracts'
import { createSeedState } from '../../server/seed'
import {
  actionAllowedForAccess,
  canManagerCancelKds,
  canResolveKdsException,
  compareKdsTasksForAccess,
  kdsPrintState,
  kdsTaskOperationallyActive,
  openKdsException,
  taskVisibleToAccess,
  getFulfillmentAccess,
  type FulfillmentAccess,
} from './commerce-workspace'
import { stabilizeOperationalOrder } from './stable-operational-order'

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
  it('keeps a bartender home role in production mode when a secondary supervisor duty adds oversight permissions', () => {
    const state = createSeedState(new Date('2026-08-08T12:00:00.000Z'))
    const bartender = state.employees.find((employee) => employee.id === 'emp-qing')!
    bartender.roleIds = [...new Set([...(bartender.roleIds ?? []), 'supervisor'])]
    const access = getFulfillmentAccess({ ...state, viewer: { actorId: bartender.id, permissionIds: [] } } as never, bartender.id)
    expect(access.mode).toBe('production')
    expect(access.scopeLabel).toContain('制作')
  })

  it('keeps electronic fulfillment active when a routed printer fails', () => {
    const kds = { ...task(), orderId: 'order-1', orderItemId: 'line-1' } as KdsTask
    const job: PrintJob = {
      id: 'print-1', orderId: 'order-1', orderItemIds: ['line-1'], printerId: 'bar-printer', routeId: 'bar',
      status: 'failed', attempts: 3, queuedAt: '2026-08-08T12:00:00.000Z', updatedAt: '2026-08-08T12:01:00.000Z',
      lastError: 'offline',
    }
    expect(kdsPrintState(kds, [job])).toBe('failed')
    expect(kdsTaskOperationallyActive(kds)).toBe(true)
  })

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

  it('shows only the role stage and releases an overdue assigned delivery to eligible backup staff', () => {
    const workstation = {
      id: 'bar-main', name: '主吧台', productionRoleIds: ['bartender'], deliveryRoleIds: ['server', 'backup'],
      requiredSkillIds: [], deliveryServiceTypeId: 'fulfillment-delivery', productionSlaSeconds: 180,
      pickupSlaSeconds: 60, configVersion: 1,
    }
    const queued = {
      ...task([], 'queued'), stationId: 'bar-main', workstation, queuedAt: '2026-08-08T12:00:00.000Z',
      productionSla: { targetSeconds: 180, dueAt: '2026-08-08T12:03:00.000Z' },
    } as KdsTask
    const ready = {
      ...queued, id: 'kds-ready', status: 'completed', completedAt: '2026-08-08T12:01:00.000Z',
      pickupSla: { targetSeconds: 60, dueAt: '2026-08-08T12:02:00.000Z' },
      deliveryServiceTask: { ownerId: 'emp-server-1' },
    } as KdsTask
    const productionAccess = {
      employee: { id: 'emp-bar', roleId: 'bartender' }, roleIds: ['bartender'], mode: 'production',
      stationIds: ['bar-main'], stationScoped: true,
    } as unknown as FulfillmentAccess
    const deliveryAccess = {
      employee: { id: 'emp-backup', roleId: 'backup' }, roleIds: ['backup'], mode: 'delivery',
      stationIds: ['bar-main'], stationScoped: true,
    } as unknown as FulfillmentAccess

    expect(taskVisibleToAccess(queued, productionAccess, Date.parse('2026-08-08T12:01:30.000Z'))).toBe(true)
    expect(taskVisibleToAccess(ready, productionAccess, Date.parse('2026-08-08T12:01:30.000Z'))).toBe(false)
    expect(taskVisibleToAccess(queued, deliveryAccess, Date.parse('2026-08-08T12:01:30.000Z'))).toBe(false)
    expect(taskVisibleToAccess(ready, deliveryAccess, Date.parse('2026-08-08T12:01:30.000Z'))).toBe(false)
    expect(taskVisibleToAccess(ready, deliveryAccess, Date.parse('2026-08-08T12:02:01.000Z'))).toBe(true)
  })

  it('prioritizes overdue work and current employee deliveries without starving older work', () => {
    const access = {
      employee: { id: 'emp-server-1', roleId: 'server' }, roleIds: ['server'], mode: 'oversight',
    } as unknown as FulfillmentAccess
    const base = {
      ...task([], 'queued'), queuedAt: '2026-08-08T12:00:00.000Z',
      productionSla: { targetSeconds: 600, dueAt: '2026-08-08T12:10:00.000Z' },
    } as KdsTask
    const ownDelivery = {
      ...base, id: 'own', status: 'completed', pickupSla: { targetSeconds: 600, dueAt: '2026-08-08T12:09:00.000Z' },
      deliveryServiceTask: { ownerId: 'emp-server-1' },
    } as KdsTask
    const overdue = {
      ...base, id: 'overdue', productionSla: { targetSeconds: 60, dueAt: '2026-08-08T12:01:00.000Z' },
    } as KdsTask
    const sorted = [base, ownDelivery, overdue].toSorted((left, right) => (
      compareKdsTasksForAccess(left, right, access, Date.parse('2026-08-08T12:02:00.000Z'))
    ))
    expect(sorted.map((item) => item.id)).toEqual(['overdue', 'own', 'kds-1'])
  })

  it('keeps the active KDS card fixed while the SLA clock changes priority', () => {
    const active = { id: 'active' } as KdsTask
    const newlyOverdue = { id: 'newly-overdue' } as KdsTask
    const stable = stabilizeOperationalOrder(
      [newlyOverdue, active],
      [active.id, newlyOverdue.id],
      new Set([active.id]),
    )
    expect(stable.map((item) => item.id)).toEqual(['active', 'newly-overdue'])
  })
})
