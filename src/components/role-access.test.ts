import { describe, expect, it } from 'vitest'
import type { BootstrapResponse } from '../shared/contracts'
import { buildRoleHomeModel, getRoleHomeAccess, resolveRoleHomeKind } from './role-access'

const expectedKinds = [
  ['owner', 'owner', ['live', 'tasks', 'reservations', 'commerce', 'inventory', 'payments', 'benefits', 'songs', 'layout', 'master', 'config']],
  ['admin', 'admin', ['live', 'tasks', 'reservations', 'commerce', 'inventory', 'payments', 'benefits', 'songs', 'layout', 'master', 'config']],
  ['manager', 'manager', ['live', 'tasks', 'reservations', 'commerce', 'inventory', 'payments', 'benefits', 'songs', 'layout']],
  ['server', 'server', ['live', 'tasks', 'commerce', 'benefits', 'songs']],
  ['bartender', 'bartender', ['tasks', 'commerce', 'inventory']],
  ['kitchen', 'kitchen', ['tasks', 'commerce', 'inventory']],
  ['cashier', 'cashier', ['reservations', 'tasks', 'payments', 'inventory']],
  ['host', 'host', ['live', 'tasks', 'reservations', 'benefits']],
  ['runner', 'runner', ['live', 'tasks', 'commerce']],
] as const

describe('role home access', () => {
  it.each(expectedKinds)('maps %s to the %s home and navigation', (roleId, expected, navigation) => {
    expect(resolveRoleHomeKind(roleId)).toBe(expected)
    expect(getRoleHomeAccess(bootstrapForRole(roleId, roleId), roleId).allowedNavigationIds).toEqual(navigation)
  })

  it('maps the existing supervisor role to the manager home', () => {
    expect(resolveRoleHomeKind('supervisor', '领班')).toBe('manager')
    expect(resolveRoleHomeKind('manager', '值班经理')).toBe('manager')
  })

  it('maps backup and specialist role IDs to the service workbench', () => {
    expect(resolveRoleHomeKind('backup', '区域候补')).toBe('server')
    expect(resolveRoleHomeKind('specialist', '服务专员')).toBe('server')
  })

  it('does not elevate custom role IDs through substring matching', () => {
    expect(resolveRoleHomeKind('night-owner-assistant')).toBe('custom')
    expect(resolveRoleHomeKind('cashier-temp-custom')).toBe('custom')
    expect(resolveRoleHomeKind('custom-admin', '管理员')).toBe('custom')
  })

  it('limits an unknown custom role to tasks and KDS', () => {
    const data = bootstrapForRole('custom-night', '夜班机动岗')
    const access = getRoleHomeAccess(data, 'custom-night')

    expect(access.kind).toBe('custom')
    expect(access.isFallback).toBe(true)
    expect(access.allowedNavigationIds).toEqual(['tasks', 'commerce'])
  })

  it('uses configured permissions instead of the built-in role navigation profile', () => {
    const data = bootstrapForRole('admin', '系统管理员')
    data.config.roles[0]!.permissionIds = ['dashboard.view', 'config.manage', 'master_data.manage']
    expect(getRoleHomeAccess(data, 'admin').allowedNavigationIds).toEqual(['live', 'master', 'config'])

    data.config.roles[0] = {
      ...data.config.roles[0]!,
      id: 'custom-cash-desk',
      name: '夜班结算',
      permissionIds: ['finance.view', 'payment.collect'],
    }
    expect(getRoleHomeAccess(data, 'custom-cash-desk').allowedNavigationIds).toEqual(['payments'])
  })

  it('builds a fallback home from only assigned service and workstation tasks', () => {
    const data = bootstrapForRole('custom-night', '夜班机动岗')
    const model = buildRoleHomeModel(data, 'employee-current')

    expect(model.navigation.map((item) => item.id)).toEqual(['tasks', 'commerce'])
    expect(model.metrics).toMatchObject([
      { id: 'tasks', value: 1, navigationId: 'tasks' },
      { id: 'kds', value: 1, navigationId: 'commerce' },
    ])
  })
})

function bootstrapForRole(roleId: string, roleName: string) {
  return {
    store: { id: 'store-1', name: 'M-Box', businessDate: '2026-07-15', timezone: 'Asia/Shanghai' },
    serverNow: '2026-07-15T12:00:00.000Z',
    metrics: { occupiedTables: 1, openTasks: 2, atRiskTasks: 0, escalatedTasks: 0, complaints: 0 },
    config: {
      version: 2,
      roles: [{ id: roleId, name: roleName, maxConcurrentTasks: 2, canReceiveTasks: true }],
    },
    employees: [{
      id: 'employee-current', displayName: '测试员工', initials: '测', status: 'active', roleId,
      online: true, paused: false, areaIds: ['area-1'],
    }],
    shiftAssignments: [{
      id: 'shift-1', employeeId: 'employee-current', businessDate: '2026-07-15',
      startAt: '2026-07-15T10:00:00.000Z', endAt: '2026-07-15T18:00:00.000Z',
      roleId, areaIds: ['area-1'], stationIds: ['station-1'], isPrimary: true, status: 'active',
    }],
    tables: [],
    awaitingOrderIntents: [],
    tasks: [
      { id: 'task-own', status: 'pending', ownerId: 'employee-current' },
      { id: 'task-other', status: 'pending', ownerId: 'employee-other' },
    ],
    orderDomain: {
      authorizations: [],
      tableLedgerEntries: [],
      kdsTasks: [{
        id: 'kds-own', status: 'completed', stationId: 'station-1',
        workstation: { productionRoleIds: [], deliveryRoleIds: [roleId] },
        deliveryServiceTask: { id: 'delivery-1', status: 'pending', ownerId: 'employee-current', createdAt: '2026-07-15T11:00:00.000Z' },
      }],
    },
    paymentDomain: { paymentIntents: [], refunds: [] },
  } as unknown as BootstrapResponse
}
