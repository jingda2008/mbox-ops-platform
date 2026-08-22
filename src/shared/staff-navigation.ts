import type { StaffPermissionId } from './contracts.js'

export const staffNavigationIds = [
  'live',
  'tasks',
  'reservations',
  'commerce',
  'inventory',
  'payments',
  'benefits',
  'operations',
  'devices',
  'songs',
  'layout',
  'master',
  'config',
] as const

export type StaffNavigationId = (typeof staffNavigationIds)[number]

export const staffNavigationPermissions: Record<StaffNavigationId, readonly StaffPermissionId[]> = {
  live: ['dashboard.view'],
  tasks: ['service.execute', 'complaint.handle'],
  reservations: ['reservation.view', 'reservation.manage', 'reservation.config.manage'],
  commerce: ['order.create', 'order.view', 'kds.prepare', 'kds.deliver', 'commerce.authorization.request', 'commerce.authorization.approve'],
  inventory: ['inventory.view', 'inventory.manage', 'inventory.receive', 'inventory.count', 'inventory.remake', 'inventory.bottle', 'inventory.approve'],
  payments: ['finance.view', 'payment.collect', 'payment.pos_report', 'payment.refund.request', 'payment.refund.approve'],
  benefits: ['benefit.view', 'benefit.grant', 'benefit.approve', 'benefit.manage'],
  operations: ['config.manage', 'inventory.manage', 'inventory.approve', 'payment.collect', 'finance.view', 'benefit.manage'],
  devices: ['hardware.view', 'hardware.operate', 'hardware.manage', 'printer.manage'],
  songs: ['song.view', 'song.manage'],
  layout: ['table.manage'],
  master: ['identity.manage', 'master_data.manage', 'shift.manage'],
  config: ['config.manage'],
}

export function navigationForStaffPermissions(permissionIds: readonly StaffPermissionId[]) {
  return staffNavigationIds.filter((navigationId) => (
    staffNavigationPermissions[navigationId].some((permissionId) => permissionIds.includes(permissionId))
  ))
}

export function isNavigationAllowedForStaffPermissions(
  navigationId: StaffNavigationId,
  permissionIds: readonly StaffPermissionId[],
) {
  return staffNavigationPermissions[navigationId].some((permissionId) => permissionIds.includes(permissionId))
}
