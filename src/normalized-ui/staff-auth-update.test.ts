import { describe, expect, it } from 'vitest'
import type { StaffAuthView } from '../normalized-api'
import { reconcileStaffAuth } from './staff-auth-update'

function auth() {
  return {
    session: { id: 'session-a', employeeId: 'employee-a', issuedAt: 'issued', expiresAt: 'expires', onlineLeaseUntil: 'lease-1', isOnline: true },
    employee: { id: 'employee-a', code: 'a', displayName: '员工甲', roleCodes: ['manager', 'counter'] },
    permissions: ['inventory.view', 'inventory.count'], deniedPermissions: ['refund', 'cash'],
    navigation: [{ code: 'inventory', label: '库存', route: '/staff/inventory', icon: 'box', sortOrder: 1, displayConfig: {} }],
    dataScopes: [{ key: 'store', effect: 'include', value: ['store-a'] }],
    approvalLimits: { amount: { fixedAmountMinor: 100, requiresSecondActor: true } },
    resolvedAt: 'resolved-1', businessDate: '2026-10-05', timezone: 'Asia/Shanghai',
  }
}

describe('staff heartbeat authorization identity', () => {
  it('retains selection dependencies for equivalent authorization while accepting the fresh lease', () => {
    const previous = auth(), next = structuredClone(previous)
    next.permissions.reverse(); next.deniedPermissions.reverse(); next.employee.roleCodes.reverse()
    next.session.onlineLeaseUntil = 'lease-2'; next.resolvedAt = 'resolved-2'
    const { businessDate: _date, timezone: _zone, ...heartbeat } = next
    const updated = reconcileStaffAuth(previous, heartbeat)
    expect(updated.permissions).toBe(previous.permissions)
    expect(updated.deniedPermissions).toBe(previous.deniedPermissions)
    expect(updated.session.onlineLeaseUntil).toBe('lease-2')
    expect(updated).toMatchObject({ resolvedAt: 'resolved-2' })
    expect(previous.permissions).toEqual(['inventory.view', 'inventory.count'])
    expect(next.permissions).toEqual(['inventory.count', 'inventory.view'])
  })
  it('ignores object property ordering but not scope or approval content', () => {
    const previous = auth(), next = auth()
    next.approvalLimits = { amount: { requiresSecondActor: true, fixedAmountMinor: 100 } }
    expect(reconcileStaffAuth(previous, next).permissions).toBe(previous.permissions)
  })
  const changes: [string, (next: ReturnType<typeof auth>) => void][] = [
    ['permission removal', next => { next.permissions.pop() }],
    ['denial', next => { next.deniedPermissions.push('inventory.view') }],
    ['role', next => { next.employee.roleCodes = ['counter'] }],
    ['employee', next => { next.employee.id = 'employee-b' }],
    ['employee code', next => { next.employee.code = 'b' }],
    ['session', next => { next.session.id = 'session-b' }],
    ['session employee', next => { next.session.employeeId = 'employee-b' }],
    ['session expiry', next => { next.session.expiresAt = 'new-expiry' }],
    ['session offline', next => { next.session.isOnline = false }],
    ['store scope', next => { next.dataScopes[0].value = ['store-b'] }],
    ['scope effect', next => { next.dataScopes[0].effect = 'exclude' }],
    ['approval amount', next => { next.approvalLimits.amount.fixedAmountMinor = 50 }],
    ['approval second actor', next => { next.approvalLimits.amount.requiresSecondActor = false }],
    ['navigation revoked', next => { next.navigation = [] }],
  ]
  it.each(changes)('invalidates module reads on %s', (_label, change) => {
    const previous = auth(), next = auth(); change(next)
    const updated = reconcileStaffAuth(previous, next)
    expect(updated.permissions).not.toBe(previous.permissions)
    expect(updated.deniedPermissions).not.toBe(previous.deniedPermissions)
    expect(updated).toEqual(next)
  })
  it('conservatively invalidates new authorization fields even with shared permission arrays', () => {
    const previous = auth(), next = { ...previous, storeId: 'new-store' }
    expect(reconcileStaffAuth(previous, next).permissions).not.toBe(previous.permissions)
  })
  it('accepts initial authentication unchanged', () => {
    const next: StaffAuthView = auth()
    expect(reconcileStaffAuth(null, next)).toBe(next)
  })
})
