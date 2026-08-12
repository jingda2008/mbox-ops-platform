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
})
