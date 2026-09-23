import { describe, expect, it } from 'vitest'
import { refundReviewChanges, refundReviewReadiness, refundReviewAmount } from '../shared/refund-review-configuration'
import type { StaffAccessManagementOverview, StaffAccessRoleView } from '../shared/normalized-contracts'

const role: StaffAccessRoleView = { id: 'manager-role', code: 'MANAGER', name: '店长', status: 'active', memberCount: 1,
  permissionCodes: [], dataScopes: [], approvalLimits: [], navigation: [], dataScopeCount: 0, approvalLimitCount: 0, navigationCount: 0 }
const limit = { code: 'refund.approve', amountMinor: 3000, currency: 'CNY', enabled: true, rules: { requiresReason: true, requiresSecondActor: true } }

describe('refund review configuration', () => {
  it('enables permission and a chosen amount atomically without assigning execute permission', () => {
    expect(refundReviewChanges(role, true, 3000)).toEqual([
      { kind: 'role_permission', roleId: role.id, permissionCode: 'refund.approve', enabled: true },
      { kind: 'role_approval_limit', roleId: role.id, approvalCode: 'refund.approve', amountMinor: 3000, currency: 'CNY', enabled: true, rules: limit.rules },
    ])
  })
  it('repairs legacy permission-only roles and can disable both controls', () => {
    const legacy = { ...role, permissionCodes: ['refund.approve'] }
    expect(refundReviewChanges(legacy, true, 3000)).toHaveLength(1)
    const configured = { ...legacy, approvalLimits: [limit] }
    expect(refundReviewChanges(configured, true, 3000)).toEqual([])
    expect(refundReviewChanges(configured, false, null)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'role_permission', enabled: false }),
      expect.objectContaining({ kind: 'role_approval_limit', enabled: false, amountMinor: 3000 }),
    ]))
  })
  it.each([null, 0, -1, 0.1, Number.NaN, 100_000_000_001])('rejects unusable enabled limit %s', (amount) => {
    expect(() => refundReviewChanges(role, true, amount)).toThrow('请填写')
  })
  it('preserves cents and rejects empty, negative, overprecise or exponential inputs', () => {
    expect(refundReviewAmount('30.01')).toBe(3001)
    for (const amount of ['', '-1', '0.001', '1e5']) expect(refundReviewAmount(amount)).toBeNull()
  })
  it('reports permission gaps, missing limits, personal denials, inactive roles and multi-role maxima', () => {
    const overview: StaffAccessManagementOverview = { generatedAt: '', configurationDefinitions: [], areas: [],
      permissions: [{ code: 'refund.approve', name: '复核退款', category: 'payment', description: null }],
      roles: [role, { ...role, id: 'cashier', code: 'CASHIER', permissionCodes: ['refund.approve'], approvalLimits: [limit] },
        { ...role, id: 'owner', code: 'OWNER', permissionCodes: ['refund.approve'] },
        { ...role, id: 'large', code: 'LARGE', approvalLimits: [{ ...limit, amountMinor: 5000 }] },
        { ...role, id: 'old', code: 'OLD', status: 'inactive', permissionCodes: ['refund.approve'], approvalLimits: [limit] }],
      employees: [
        { id: 'a', code: 'a', displayName: '收银', status: 'active', roleCodes: ['CASHIER'], overrides: [] },
        { id: 'b', code: 'b', displayName: '老板', status: 'active', roleCodes: ['OWNER'], overrides: [] },
        { id: 'c', code: 'c', displayName: '店长', status: 'active', roleCodes: ['MANAGER'], overrides: [] },
        { id: 'd', code: 'd', displayName: '禁止', status: 'active', roleCodes: ['CASHIER'], overrides: [{ permissionCode: 'refund.approve', effect: 'deny', reason: '测试', endsAt: null }] },
        { id: 'e', code: 'e', displayName: '兼岗', status: 'active', roleCodes: ['CASHIER', 'LARGE'], overrides: [] },
        { id: 'f', code: 'f', displayName: '旧岗', status: 'active', roleCodes: ['OLD'], overrides: [] },
        { id: 'g', code: 'g', displayName: '停用', status: 'suspended', roleCodes: ['CASHIER'], overrides: [] },
      ] }
    expect(refundReviewReadiness(overview).map(({ employeeId, status, limitMinor }) => ({ employeeId, status, limitMinor }))).toEqual([
      { employeeId: 'a', status: 'ready', limitMinor: 3000 }, { employeeId: 'b', status: 'missing_limit', limitMinor: null },
      { employeeId: 'c', status: 'missing_permission', limitMinor: null }, { employeeId: 'd', status: 'denied', limitMinor: 3000 },
      { employeeId: 'e', status: 'ready', limitMinor: 5000 }, { employeeId: 'f', status: 'missing_permission', limitMinor: null },
    ])
  })
})
