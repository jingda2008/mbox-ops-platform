import { describe, expect, it } from 'vitest'
import {
  effectiveStaffNavigation,
  staffModuleForPermission,
  staffModuleForRoute,
} from './staff-module-access.js'

describe('permission-derived staff modules', () => {
  it('offers a dedicated cooperation entry only with read authority, independent of membership permissions', () => {
    for (const permissions of [['channel.view'], ['channel.view', 'channel.manage'], ['channel.view', 'channel.correct'], ['channel.view', 'channel.settle']]) {
      expect(effectiveStaffNavigation(permissions, [])).toEqual([expect.objectContaining({ code: 'channel-partners', label: '周边店合作', route: '/staff/channel-partners' })])
    }
    for (const permissions of [[], ['channel.manage'], ['channel.activate'], ['channel.correct'], ['channel.settle'], ['loyalty.operations.view']]) {
      expect(effectiveStaffNavigation(permissions, []).some(n => n.code === 'channel-partners')).toBe(false)
    }
    expect(staffModuleForRoute('/staff/channel-partners')?.permissionCodes).toEqual(['channel.view'])
    expect(effectiveStaffNavigation([], [{code:'channel-partners',label:'周边店合作',route:'/staff/channel-partners',sortOrder:1,icon:null,displayConfig:{}}])).toEqual([])
  })

  it('shows a parent module from an effective personal grant even without role navigation', () => {
    expect(effectiveStaffNavigation(['printer.manage'], [])).toEqual([
      expect.objectContaining({ code: 'devices', label: '设备与打印', route: '/staff/devices' }),
    ])
    expect(effectiveStaffNavigation(['payment.manual.cash.record'], [])).toEqual([
      expect.objectContaining({ code: 'payments', label: '收银与退款', route: '/staff/payments' }),
    ])
    expect(effectiveStaffNavigation(['community.activity.cashier'], [])).toEqual([
      expect.objectContaining({ code: 'payments', label: '收银与退款', route: '/staff/payments' }),
    ])
    expect(effectiveStaffNavigation(['commercial.voucher.redeem'], [])).toEqual([
      expect.objectContaining({ code: 'payments', label: '收银与退款', route: '/staff/payments' }),
    ])
    expect(effectiveStaffNavigation(['privacy.policy.publish'], [])).toEqual([
      expect.objectContaining({ code: 'settings', label: '系统配置', route: '/staff/settings' }),
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
    expect(staffModuleForPermission('community.activity.cashier')).toMatchObject({ code: 'payments' })
    expect(staffModuleForPermission('commercial.voucher.view')).toMatchObject({ code: 'payments' })
    expect(staffModuleForPermission('commercial.voucher.redeem')).toMatchObject({ code: 'payments' })
    expect(staffModuleForPermission('inventory.manage')).toMatchObject({ code: 'inventory' })
    expect(staffModuleForRoute('/staff/devices')).toMatchObject({ code: 'devices' })
    expect(staffModuleForRoute('https://example.com')).toBeNull()
  })

  it('does not advertise a top-level page for a capability whose action lives inside another workflow', () => {
    expect(staffModuleForPermission('payment.initiate.staff')).toBeNull()
    expect(staffModuleForPermission('commercial.cost.manage')).toMatchObject({ code: 'operations' })
    expect(staffModuleForPermission('observation.record')).toMatchObject({ code: 'live' })
    expect(staffModuleForPermission('catalog.product.manage')).toMatchObject({ code: 'inventory' })
  })

  it('maps every independently rendered customer and loyalty panel to its parent page', () => {
    expect(staffModuleForPermission('community.activity.publish')?.code).toBe('experience')
    expect(staffModuleForPermission('loyalty.configuration.edit')?.code).toBe('member-management')
    expect(staffModuleForPermission('loyalty.policy.view')?.code).toBe('member-overview')
    expect(staffModuleForPermission('loyalty.policy.manage')?.code).toBe('member-rule-drafts')
    expect(staffModuleForPermission('loyalty.policy.approve')?.code).toBe('member-rule-approvals')
    expect(staffModuleForPermission('loyalty.policy.publish')?.code).toBe('member-rule-publish')
    expect(staffModuleForPermission('loyalty.account.view')?.code).toBe('member-accounts')
    expect(staffModuleForPermission('loyalty.redemption.fulfill')?.code).toBe('member-fulfillment')
    expect(staffModuleForPermission('loyalty.redemption.exception')?.code).toBe('member-exceptions')
    expect(staffModuleForPermission('recommendation.rule.approve')?.code).toBe('experience')
    expect(staffModuleForPermission('privacy.contact.retention.publish')?.code).toBe('experience')
    expect(staffModuleForPermission('community.activity.contact.reveal')).toBeNull()
  })
})
