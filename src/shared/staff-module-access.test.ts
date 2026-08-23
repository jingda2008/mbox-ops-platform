import { describe, expect, it } from 'vitest'
import {
  effectiveStaffNavigation,
  staffModuleForPermission,
  staffModuleForRoute,
} from './staff-module-access'

describe('permission-derived staff modules', () => {
  it('shows a parent module from an effective personal grant even without role navigation', () => {
    expect(effectiveStaffNavigation(['printer.manage'], [])).toEqual([
      expect.objectContaining({ code: 'devices', label: '设备与打印', route: '/staff/devices' }),
    ])
    expect(effectiveStaffNavigation(['payment.manual.cash.record'], [])).toEqual([
      expect.objectContaining({ code: 'payments', label: '收银与退款', route: '/staff/payments' }),
    ])
  })

  it('removes a module when its effective permission is denied and never trusts navigation as authority', () => {
    const configured = [{
      code: 'devices', label: '打印中心', route: '/staff/devices', icon: 'printer',
      sortOrder: 1, displayConfig: { highFrequency: true },
    }]
    expect(effectiveStaffNavigation([], configured)).toEqual([])
    expect(effectiveStaffNavigation(['printer.manage'], configured)).toEqual([
      expect.objectContaining({ code: 'devices', label: '打印中心', route: '/staff/devices', sortOrder: 1 }),
    ])
  })

  it('binds direct routes and permission impact previews to the same registry', () => {
    expect(staffModuleForPermission('refund.approve')).toMatchObject({ code: 'payments' })
    expect(staffModuleForPermission('inventory.manage')).toMatchObject({ code: 'inventory' })
    expect(staffModuleForRoute('/staff/devices')).toMatchObject({ code: 'devices' })
    expect(staffModuleForRoute('https://example.com')).toBeNull()
  })
})
