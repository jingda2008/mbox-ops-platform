import type { StaffAccessManagementOverview, StaffAccessRoleView, StaffPermissionDeploymentChange } from './normalized-contracts.js'

export interface RefundReviewDraft { enabled: boolean; amount: string }

export function refundReviewDraft(role: StaffAccessRoleView): RefundReviewDraft {
  const limit = role.approvalLimits.find((item) => item.code === 'refund.approve' && item.currency === 'CNY')
  return { enabled: role.permissionCodes.includes('refund.approve'), amount: limit?.amountMinor == null ? '' : String(limit.amountMinor / 100) }
}

export function refundReviewAmount(amount: string): number | null {
  if (!/^\d+(\.\d{1,2})?$/.test(amount.trim())) return null
  return Math.round(Number(amount) * 100)
}

export function validRefundApprovalLimit(amountMinor: number | null): amountMinor is number {
  return amountMinor !== null && Number.isSafeInteger(amountMinor) && amountMinor > 0 && amountMinor <= 100_000_000_000
}

export function refundReviewChanges(role: StaffAccessRoleView, enabled: boolean, amountMinor: number | null): StaffPermissionDeploymentChange[] {
  if (enabled && !validRefundApprovalLimit(amountMinor)) throw new TypeError('启用退款复核时，请填写大于0、最多两位小数的单次额度')
  const changes: StaffPermissionDeploymentChange[] = []
  if (role.permissionCodes.includes('refund.approve') !== enabled) {
    changes.push({ kind: 'role_permission', roleId: role.id, permissionCode: 'refund.approve', enabled })
  }
  const original = role.approvalLimits.find((limit) => limit.code === 'refund.approve' && limit.currency === 'CNY')
  const amount = enabled ? amountMinor : original?.amountMinor ?? null
  const rules = { ...original?.rules, requiresReason: true, requiresSecondActor: true }
  if (original ? original.enabled !== enabled || original.amountMinor !== amount
    || original.rules.requiresReason !== true || original.rules.requiresSecondActor !== true : enabled) {
    changes.push({ kind: 'role_approval_limit', roleId: role.id, approvalCode: 'refund.approve', currency: 'CNY', amountMinor: amount, rules, enabled })
  }
  return changes
}

export function refundReviewReadiness(overview: StaffAccessManagementOverview) {
  const permissionActive = overview.permissions.some((permission) => permission.code === 'refund.approve')
  return overview.employees.filter((employee) => employee.status === 'active').map((employee) => {
    const roles = overview.roles.filter((role) => role.status === 'active' && employee.roleCodes.includes(role.code))
    const overrides = employee.overrides.filter((override) => override.permissionCode === 'refund.approve')
    const denied = overrides.some((override) => override.effect === 'deny')
    const allowed = permissionActive && !denied && (overrides.some((override) => override.effect === 'grant')
      || roles.some((role) => role.permissionCodes.includes('refund.approve')))
    const limits = roles.flatMap((role) => role.approvalLimits)
      .filter((limit) => limit.code === 'refund.approve' && limit.currency === 'CNY' && limit.enabled && validRefundApprovalLimit(limit.amountMinor))
      .map((limit) => limit.amountMinor!)
    const limitMinor = limits.length ? Math.max(...limits) : null
    return { employeeId: employee.id, name: employee.displayName, limitMinor,
      status: !allowed ? denied ? 'denied' as const : 'missing_permission' as const
        : limitMinor === null ? 'missing_limit' as const : 'ready' as const }
  })
}
