import type { RoleApprovalLimits, RoleConfig, RoleDataScope, StaffPermissionId } from './contracts.js'

const noApproval: RoleApprovalLimits = {
  giftAmount: 0,
  discountAmount: 0,
  refundRequestAmount: 0,
  refundApproveAmount: 0,
  inventoryAdjustmentAmount: 0,
}

type RolePolicy = Pick<RoleConfig, 'permissionIds' | 'dataScope' | 'approvalLimits'>

function policy(
  permissionIds: StaffPermissionId[],
  dataScope: RoleDataScope,
  approvalLimits: Partial<RoleApprovalLimits> = {},
): RolePolicy {
  return { permissionIds, dataScope, approvalLimits: { ...noApproval, ...approvalLimits } }
}

export const defaultRolePolicies: Record<string, RolePolicy> = {
  owner: policy(
    [
      'dashboard.view', 'finance.view', 'finance.manage', 'audit.view', 'config.manage', 'identity.manage',
      'master_data.manage', 'shift.manage', 'table.open', 'table.manage', 'table.close', 'business_day.close', 'reservation.view', 'reservation.manage',
      'reservation.config.manage',
      'service.execute', 'complaint.handle', 'order.create', 'order.view', 'kds.prepare',
      'kds.deliver', 'payment.collect', 'payment.pos_report', 'payment.refund.request',
      'payment.refund.approve', 'commerce.authorization.request',
      'commerce.authorization.approve', 'inventory.view', 'inventory.manage',
      'inventory.approve', 'benefit.view', 'benefit.grant', 'benefit.approve', 'benefit.manage',
      'song.view', 'song.manage', 'store_import.apply',
      'hardware.view', 'hardware.operate', 'hardware.manage',
    ],
    'all_stores',
    {
      giftAmount: 9_999_999,
      discountAmount: 9_999_999,
      refundRequestAmount: 9_999_999,
      refundApproveAmount: 9_999_999,
      inventoryAdjustmentAmount: 9_999_999,
    },
  ),
  operations_director: policy(
    [
      'dashboard.view', 'finance.view', 'finance.manage', 'audit.view', 'config.manage', 'master_data.manage',
      'shift.manage', 'table.open', 'table.manage', 'table.close', 'business_day.close', 'reservation.view',
      'reservation.manage', 'reservation.config.manage', 'service.execute', 'complaint.handle',
      'order.create', 'order.view', 'kds.prepare', 'kds.deliver', 'payment.collect',
      'payment.pos_report', 'payment.refund.request', 'payment.refund.approve',
      'commerce.authorization.request', 'commerce.authorization.approve', 'inventory.view',
      'inventory.manage', 'inventory.approve', 'benefit.view', 'benefit.grant',
      'benefit.approve', 'benefit.manage', 'song.view', 'song.manage', 'store_import.apply',
      'hardware.view', 'hardware.operate', 'hardware.manage',
    ],
    'store',
    {
      giftAmount: 500_000,
      discountAmount: 500_000,
      refundRequestAmount: 500_000,
      refundApproveAmount: 500_000,
      inventoryAdjustmentAmount: 500_000,
    },
  ),
  admin: policy(
    ['dashboard.view', 'audit.view', 'config.manage', 'identity.manage', 'master_data.manage', 'shift.manage', 'table.manage', 'hardware.view', 'hardware.operate', 'hardware.manage', 'store_import.apply'],
    'store',
  ),
  manager: policy(
    [
      'dashboard.view', 'finance.view', 'finance.manage', 'audit.view', 'master_data.manage', 'shift.manage',
      'table.open', 'table.manage', 'table.close', 'business_day.close', 'reservation.view', 'reservation.manage', 'reservation.config.manage', 'service.execute', 'complaint.handle',
      'order.create', 'order.view', 'kds.prepare', 'kds.deliver', 'payment.collect',
      'payment.pos_report', 'payment.refund.request', 'payment.refund.approve',
      'commerce.authorization.request', 'commerce.authorization.approve', 'inventory.view',
      'inventory.manage', 'inventory.approve', 'benefit.view', 'benefit.grant',
      'benefit.approve', 'benefit.manage', 'song.view', 'song.manage', 'store_import.apply',
      'hardware.view', 'hardware.operate',
    ],
    'store',
    {
      giftAmount: 100_000,
      discountAmount: 100_000,
      refundRequestAmount: 100_000,
      refundApproveAmount: 100_000,
      inventoryAdjustmentAmount: 100_000,
    },
  ),
  supervisor: policy(
    [
      'dashboard.view', 'shift.manage', 'table.open', 'table.manage', 'table.close', 'reservation.view', 'reservation.manage',
      'service.execute', 'complaint.handle', 'order.create', 'order.view', 'kds.prepare',
      'kds.deliver', 'payment.collect', 'payment.pos_report', 'payment.refund.request',
      'commerce.authorization.request', 'commerce.authorization.approve', 'inventory.view',
      'inventory.manage', 'benefit.view', 'benefit.grant', 'song.view', 'song.manage',
      'benefit.approve',
    ],
    'store',
    { giftAmount: 30_000, discountAmount: 30_000, refundRequestAmount: 30_000 },
  ),
  server: policy(
    [
      'dashboard.view', 'table.open', 'table.manage', 'table.close', 'service.execute', 'order.create', 'order.view', 'kds.deliver',
      'payment.collect', 'payment.refund.request', 'commerce.authorization.request',
      'inventory.view', 'benefit.view', 'benefit.grant', 'song.view',
    ],
    'assigned_areas',
    { giftAmount: 8_800, refundRequestAmount: 100_000 },
  ),
  backup: policy(
    ['dashboard.view', 'table.open', 'table.manage', 'table.close', 'service.execute', 'order.create', 'order.view', 'kds.deliver', 'payment.collect', 'commerce.authorization.request', 'inventory.view', 'benefit.view', 'song.view'],
    'assigned_areas',
    { giftAmount: 8_800, refundRequestAmount: 100_000 },
  ),
  specialist: policy(
    ['dashboard.view', 'table.open', 'table.manage', 'table.close', 'service.execute', 'complaint.handle', 'order.create', 'order.view', 'kds.prepare', 'kds.deliver', 'commerce.authorization.request', 'benefit.view', 'benefit.grant', 'song.view'],
    'assigned_areas',
    { giftAmount: 8_800 },
  ),
  bartender: policy(['dashboard.view', 'service.execute', 'order.view', 'kds.prepare', 'inventory.view'], 'own'),
  kitchen: policy(['dashboard.view', 'service.execute', 'order.view', 'kds.prepare', 'inventory.view'], 'own'),
  runner: policy(['dashboard.view', 'service.execute', 'order.view', 'kds.deliver'], 'assigned_areas'),
  cashier: policy(
    ['dashboard.view', 'finance.view', 'table.close', 'reservation.view', 'order.view', 'payment.collect', 'payment.pos_report', 'payment.refund.request'],
    'store',
    { refundRequestAmount: 100_000 },
  ),
  host: policy(
    ['dashboard.view', 'table.open', 'table.manage', 'reservation.view', 'reservation.manage', 'service.execute', 'benefit.view'],
    'store',
  ),
}

export function withDefaultRolePolicy(role: RoleConfig): RoleConfig {
  const defaults = defaultRolePolicies[role.id] ?? policy([], 'own')
  return {
    ...role,
    permissionIds: role.permissionIds ?? [...(defaults.permissionIds ?? [])],
    dataScope: role.dataScope ?? defaults.dataScope,
    approvalLimits: role.approvalLimits ?? { ...(defaults.approvalLimits ?? noApproval) },
  }
}

export function roleHasPermission(role: RoleConfig | undefined, permissionId: StaffPermissionId) {
  return Boolean(role?.permissionIds?.includes(permissionId))
}
