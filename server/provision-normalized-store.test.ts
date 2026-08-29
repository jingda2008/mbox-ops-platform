import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseStoreProvisionConfig, shanghaiBusinessDate } from './provision-normalized-store.js'

const base = {
  version: '2026.08.12-v1',
  tenant: { id: '10000000-0000-4000-8000-000000000001', code: 'superhigh', name: '超嗨文化' },
  store: { id: '20000000-0000-4000-8000-000000000001', code: 'mbox-lujiazui', name: 'M-BOX 陆家嘴' },
  areas: [{ code: 'indoor', name: '室内', type: 'indoor' }],
  tables: [{ code: 'L01', name: 'L01', areaCode: 'indoor', capacity: 4 }],
  roles: [{ code: 'SERVER', name: '服务员', permissions: ['table.open', 'order.gift'], navigation: [
    { code: 'live', label: '现场', route: '/staff/live', highFrequency: true },
  ], dataScopes: [
    { key: 'area.codes', effect: 'include', value: ['indoor'] },
  ], approvalLimits: [
    { code: 'order.gift', amountMinor: 8800, rules: { allowFullGift: true } },
  ] }],
  employees: [{ code: 'tom', name: 'Tom', roleCodes: ['SERVER'], pinEnv: 'MBOX_EMPLOYEE_PIN_TOM' }],
  reservationPolicy: {
    holdMinutes: 20,
    arrivalGraceMinutes: 10,
    maxAdvanceDays: 90,
    defaultDurationMinutes: 240,
    customerCancelCutoffMinutes: 120,
    depositMode: 'disabled',
  },
  dailyCredentialEnv: 'MBOX_STORE_DAILY_CREDENTIAL',
  bootstrapAdminEmployeeCode: 'tom',
}

describe('normalized store provisioning config', () => {
  it('uses the previous Shanghai business date before the 06:00 cutoff exactly once', () => {
    expect(shanghaiBusinessDate(new Date('2026-08-11T21:59:59.000Z'))).toBe('2026-08-11')
    expect(shanghaiBusinessDate(new Date('2026-08-11T22:00:00.000Z'))).toBe('2026-08-12')
    expect(shanghaiBusinessDate(new Date('2026-01-01T17:00:00.000Z'))).toBe('2026-01-01')
  })

  it('normalizes a versioned secret-free store definition', () => {
    const config = parseStoreProvisionConfig(base)
    expect(config.store.timezone).toBe('Asia/Shanghai')
    expect(config.store.businessDayCutoff).toBe('06:00')
    expect(config.automaticTableTurnover).toEqual({ enabled: false, operatingStartsAt: '12:00' })
    expect(config.reservationPolicy).toMatchObject({ holdMinutes: 20, depositMode: 'disabled' })
    expect(config.roles[0]?.navigation?.[0]).toMatchObject({ highFrequency: true })
    expect(config.roles[0]?.dataScopes?.[0]).toEqual({
      key: 'area.codes', effect: 'include', value: ['indoor'], enabled: true,
    })
    expect(config.roles[0]?.approvalLimits?.[0]).toEqual({
      code: 'order.gift', amountMinor: 8800, currency: 'CNY', rules: { allowFullGift: true }, enabled: true,
    })
  })

  it('rejects duplicate tables, unknown areas, unknown roles and inline PIN fields', () => {
    expect(() => parseStoreProvisionConfig({ ...base, tables: [...base.tables, ...base.tables] })).toThrow(/duplicate table code/)
    expect(() => parseStoreProvisionConfig({ ...base, tables: [{ ...base.tables[0], areaCode: 'missing' }] })).toThrow(/unknown area/)
    expect(() => parseStoreProvisionConfig({ ...base, employees: [{ ...base.employees[0], roleCodes: ['OWNER'] }] })).toThrow(/unknown role/)
    expect(() => parseStoreProvisionConfig({ ...base, employees: [{ ...base.employees[0], pinEnv: '1234' }] })).toThrow(/pinEnv/)
    expect(() => parseStoreProvisionConfig({ ...base, bootstrapAdminEmployeeCode: 'missing' })).toThrow(/unknown bootstrap admin/)
    expect(() => parseStoreProvisionConfig({ ...base, bootstrapAdminEmployeeCode: undefined })).toThrow(/bootstrapAdminEmployeeCode/)
  })

  it('rejects inconsistent deposit settings and unversioned configuration', () => {
    expect(() => parseStoreProvisionConfig({ ...base, version: undefined })).toThrow(/version/)
    expect(() => parseStoreProvisionConfig({
      ...base,
      reservationPolicy: { ...base.reservationPolicy, depositMode: 'flat' },
    })).toThrow(/inconsistent/)
  })

  it('accepts only a cross-midnight automatic turnover window', () => {
    expect(parseStoreProvisionConfig({
      ...base,
      automaticTableTurnover: { enabled: true, operatingStartsAt: '12:00' },
    }).automaticTableTurnover).toEqual({ enabled: true, operatingStartsAt: '12:00' })
    expect(() => parseStoreProvisionConfig({
      ...base,
      automaticTableTurnover: { enabled: 'true', operatingStartsAt: '12:00' },
    })).toThrow(/enabled/)
    expect(() => parseStoreProvisionConfig({
      ...base,
      automaticTableTurnover: { enabled: true, operatingStartsAt: '06:00' },
    })).toThrow(/operatingStartsAt/)
  })

  it('rejects duplicate or non-JSON role policy configuration', () => {
    expect(() => parseStoreProvisionConfig({
      ...base,
      roles: [{ ...base.roles[0], dataScopes: [
        { key: 'area.codes', effect: 'include', value: ['indoor'] },
        { key: 'area.codes', effect: 'include', value: ['outdoor'] },
      ] }],
    })).toThrow(/duplicate data scope/)
    expect(() => parseStoreProvisionConfig({
      ...base,
      roles: [{ ...base.roles[0], approvalLimits: [
        { code: 'order.gift', amountMinor: 100, rules: { invalid: Number.NaN } },
      ] }],
    })).toThrow(/valid JSON/)
  })

  it('defaults to manager request and cashier review without hard-coding an employee', () => {
    const source = JSON.parse(readFileSync(
      new URL('../deploy/normalized-store/mbox-lujiazui.store.json', import.meta.url),
      'utf8',
    )) as unknown
    const config = parseStoreProvisionConfig(source)
    expect(config.version).toBe('2026.08.29-v18')
    expect(config.automaticTableTurnover).toEqual({ enabled: true, operatingStartsAt: '12:00' })
    const role = (code: string) => config.roles.find((candidate) => candidate.code === code)

    expect(role('MANAGER')?.permissions.filter((code) => code.startsWith('refund.')))
      .toEqual(['refund.request'])
    expect(role('MANAGER')?.approvalLimits).toContainEqual(expect.objectContaining({
      code: 'refund.request', amountMinor: 200_000, currency: 'CNY', enabled: true,
    }))
    expect(role('CASHIER')?.permissions.filter((code) => code.startsWith('refund.')))
      .toEqual(['refund.approve', 'refund.execute'])
    expect(role('CASHIER')?.approvalLimits).toContainEqual(expect.objectContaining({
      code: 'refund.approve', amountMinor: 200_000, currency: 'CNY', enabled: true,
    }))
    const cashierPermissions = new Set(role('CASHIER')?.permissions)
    expect(cashierPermissions.has('printer.manage')).toBe(true)
    expect(cashierPermissions.has('payment.collect.all_tables')).toBe(true)
    expect(new Set(role('SERVER')?.permissions).has('payment.collect.all_tables')).toBe(false)
    for (const roleCode of ['OWNER', 'OPS_LEAD', 'MANAGER']) {
      expect(new Set(role(roleCode)?.permissions).has('payment.collect.all_tables')).toBe(true)
    }
    for (const permission of ['hardware.view_all', 'hardware.manage', 'hardware.command', 'print.view_all', 'print.retry']) {
      expect(cashierPermissions.has(permission)).toBe(false)
    }
    expect(config.roles.filter((candidate) => candidate.code !== 'MANAGER' && candidate.code !== 'CASHIER')
      .flatMap((candidate) => candidate.permissions.filter((code) => code.startsWith('refund.'))))
      .toEqual([])
    for (const roleCode of ['OWNER', 'MANAGER', 'SERVER']) {
      expect(new Set(role(roleCode)?.permissions).has('guest.cart.freeze')).toBe(true)
    }
  })

  it('assigns loyalty and membership-recovery permissions by operating duty, not technical access', () => {
    const source = JSON.parse(readFileSync(
      new URL('../deploy/normalized-store/mbox-lujiazui.store.json', import.meta.url),
      'utf8',
    )) as unknown
    const config = parseStoreProvisionConfig(source)
    const permissions = (code: string) => new Set(
      config.roles.find((candidate) => candidate.code === code)?.permissions ?? [],
    )

    for (const roleCode of ['OWNER', 'OPS_LEAD', 'MANAGER', 'DEPUT_MANAGER', 'SERVER']) {
      expect(permissions(roleCode).has('table.turnover_unsettled')).toBe(true)
    }

    const owner = permissions('OWNER')
    expect([...owner]).toEqual(expect.arrayContaining([
      'loyalty.policy.publish', 'loyalty.accrual.approve', 'loyalty.adjust.manual',
      'loyalty.redemption.catalog.publish', 'loyalty.redemption.exception',
      'customer.membership.recovery.verify', 'customer.membership.merge.approve',
      'loyalty.configuration.view', 'loyalty.configuration.preview',
    ]))
    expect(owner.has('loyalty.policy.manage')).toBe(false)
    expect(owner.has('loyalty.policy.approve')).toBe(false)
    expect(owner.has('loyalty.configuration.edit')).toBe(false)
    expect(owner.has('loyalty.configuration.approve')).toBe(false)

    const operations = permissions('OPS_LEAD')
    expect([...operations]).toEqual(expect.arrayContaining([
      'loyalty.policy.approve', 'loyalty.accrual.request', 'loyalty.accrual.approve',
      'loyalty.adjust.manual', 'loyalty.redemption.catalog.approve',
      'loyalty.redemption.exception',
      'customer.membership.recovery.verify', 'customer.membership.merge.approve',
      'loyalty.configuration.view', 'loyalty.configuration.preview', 'loyalty.configuration.approve',
    ]))
    expect(operations.has('loyalty.policy.manage')).toBe(false)
    expect(operations.has('loyalty.policy.publish')).toBe(false)
    expect(operations.has('loyalty.configuration.edit')).toBe(false)
    const manager = permissions('MANAGER')
    expect([...manager]).toEqual(expect.arrayContaining([
      'loyalty.policy.view', 'loyalty.policy.manage', 'loyalty.account.view',
      'loyalty.accrual.request', 'loyalty.redemption.fulfill',
      'loyalty.redemption.catalog.manage', 'loyalty.redemption.exception',
      'customer.membership.recovery.verify',
      'loyalty.configuration.view', 'loyalty.configuration.edit', 'loyalty.configuration.preview',
    ]))
    expect(manager.has('loyalty.accrual.approve')).toBe(false)
    expect(manager.has('loyalty.adjust.manual')).toBe(false)
    expect(manager.has('customer.membership.merge.approve')).toBe(false)
    expect(manager.has('loyalty.policy.publish')).toBe(false)
    expect(manager.has('loyalty.redemption.catalog.publish')).toBe(false)
    expect(manager.has('loyalty.configuration.approve')).toBe(false)

    const deputy = permissions('DEPUT_MANAGER')
    expect(deputy.has('customer.membership.recovery.verify')).toBe(true)
    expect(deputy.has('loyalty.redemption.exception')).toBe(true)
    expect(deputy.has('customer.membership.merge.approve')).toBe(false)

    const technicalAdmin = permissions('ADMIN')
    expect(technicalAdmin.has('loyalty.account.view')).toBe(false)
    expect(technicalAdmin.has('customer.membership.recovery.verify')).toBe(false)
    expect(technicalAdmin.has('customer.membership.merge.approve')).toBe(false)
    for (const role of ['CASHIER','SERVER','BAR','KITCHEN','SINGER']) {
      expect(permissions(role).has('loyalty.redemption.exception')).toBe(false)
    }
  })

  it('keeps migration-seeded operating permissions in the versioned store configuration', () => {
    const source = JSON.parse(readFileSync(
      new URL('../deploy/normalized-store/mbox-lujiazui.store.json', import.meta.url),
      'utf8',
    )) as unknown
    const config = parseStoreProvisionConfig(source)
    const permissions = (code: string) => new Set(
      config.roles.find((candidate) => candidate.code === code)?.permissions ?? [],
    )

    expect([...permissions('OWNER')]).toEqual(expect.arrayContaining([
      'checkout.upgrade.rule.view', 'checkout.upgrade.rule.publish',
      'fulfillment.capacity.view', 'fulfillment.capacity.publish',
      'performance.schedule.revise', 'loyalty.promotion.view', 'loyalty.promotion.publish',
      'membership.terms.view', 'membership.terms.publish',
      'loyalty.operations.view', 'loyalty.operations.control',
      'recommendation.staff.modify', 'recommendation.staff.modify.all',
      'community.activity.contact.reveal', 'privacy.contact.retention.view',
      'privacy.contact.retention.publish', 'privacy.contact.legal_hold',
    ]))
    expect([...permissions('OPS_LEAD')]).toEqual(expect.arrayContaining([
      'checkout.upgrade.rule.view', 'checkout.upgrade.rule.approve',
      'fulfillment.capacity.view', 'fulfillment.capacity.approve',
      'performance.schedule.revise', 'loyalty.promotion.view', 'loyalty.promotion.approve',
      'membership.terms.view', 'membership.terms.approve',
      'recommendation.staff.modify', 'recommendation.staff.modify.all',
      'community.activity.contact.reveal', 'privacy.contact.retention.view',
      'privacy.contact.retention.approve',
    ]))
    expect([...permissions('MANAGER')]).toEqual(expect.arrayContaining([
      'checkout.upgrade.rule.view', 'checkout.upgrade.rule.draft',
      'fulfillment.capacity.view', 'fulfillment.capacity.draft',
      'performance.schedule.revise', 'loyalty.promotion.view', 'loyalty.promotion.manage',
      'membership.terms.view', 'membership.terms.manage',
      'recommendation.staff.modify', 'recommendation.staff.modify.all',
      'community.activity.contact.reveal', 'privacy.contact.retention.view',
      'privacy.contact.retention.draft',
    ]))
    expect([...permissions('DEPUT_MANAGER')]).toEqual(expect.arrayContaining([
      'checkout.upgrade.rule.view', 'fulfillment.capacity.view', 'loyalty.promotion.view',
      'membership.terms.view',
      'recommendation.staff.modify',
      'community.activity.contact.reveal', 'privacy.contact.retention.view',
    ]))
    expect(permissions('DEPUT_MANAGER').has('checkout.upgrade.rule.approve')).toBe(false)
    expect(permissions('DEPUT_MANAGER').has('loyalty.promotion.publish')).toBe(false)
    expect(permissions('DEPUT_MANAGER').has('membership.terms.manage')).toBe(false)
    expect(permissions('DEPUT_MANAGER').has('loyalty.operations.control')).toBe(false)
    expect(permissions('DEPUT_MANAGER').has('privacy.contact.retention.draft')).toBe(false)
    expect(permissions('DEPUT_MANAGER').has('privacy.contact.retention.approve')).toBe(false)
    expect(permissions('DEPUT_MANAGER').has('privacy.contact.retention.publish')).toBe(false)
    expect(permissions('DEPUT_MANAGER').has('privacy.contact.legal_hold')).toBe(false)
    expect(permissions('MANAGER').has('privacy.contact.retention.approve')).toBe(false)
    expect(permissions('MANAGER').has('privacy.contact.retention.publish')).toBe(false)
    expect(permissions('OPS_LEAD').has('privacy.contact.retention.draft')).toBe(false)
    expect(permissions('OPS_LEAD').has('privacy.contact.retention.publish')).toBe(false)
    expect(permissions('MARKETING').has('loyalty.promotion.view')).toBe(true)
    expect(permissions('MARKETING').has('loyalty.promotion.approve')).toBe(false)
    expect(permissions('MARKETING').has('loyalty.promotion.publish')).toBe(false)
    expect(permissions('SERVER').has('recommendation.staff.modify')).toBe(true)
    expect(permissions('SERVER').has('recommendation.staff.modify.all')).toBe(false)
    expect(permissions('ADMIN').has('recommendation.staff.modify')).toBe(false)
    const rolesWith = (permission: string) => config.roles
      .filter((candidate) => candidate.permissions.includes(permission))
      .map((candidate) => candidate.code)
      .sort()
    expect(rolesWith('community.activity.contact.reveal'))
      .toEqual(['DEPUT_MANAGER', 'MANAGER', 'OPS_LEAD', 'OWNER'])
    expect(rolesWith('privacy.contact.retention.view'))
      .toEqual(['DEPUT_MANAGER', 'MANAGER', 'OPS_LEAD', 'OWNER'])
    expect(rolesWith('privacy.contact.retention.draft')).toEqual(['MANAGER'])
    expect(rolesWith('privacy.contact.retention.approve')).toEqual(['OPS_LEAD'])
    expect(rolesWith('privacy.contact.retention.publish')).toEqual(['OWNER'])
    expect(rolesWith('privacy.contact.legal_hold')).toEqual(['OWNER'])
    expect(rolesWith('inventory.receive'))
      .toEqual(['BARTENDER', 'DEPUT_MANAGER', 'MANAGER', 'OPS_LEAD', 'OWNER'])
    expect(rolesWith('inventory.count'))
      .toEqual(['BARTENDER', 'DEPUT_MANAGER', 'MANAGER'])
    expect(rolesWith('inventory.count.approve')).toEqual(['OPS_LEAD', 'OWNER'])
    expect(rolesWith('inventory.waste'))
      .toEqual(['BARTENDER', 'DEPUT_MANAGER', 'MANAGER'])
    expect(permissions('CASHIER').has('inventory.receive')).toBe(false)
    expect(permissions('KITCHEN').has('inventory.receive')).toBe(false)
    expect(permissions('KITCHEN').has('inventory.count')).toBe(false)
    expect(permissions('KITCHEN').has('inventory.waste')).toBe(false)
  })
})
