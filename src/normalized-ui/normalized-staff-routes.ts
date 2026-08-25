import type { StaffModule } from './StaffModulePanel'
import type { StaffActionsTab } from './staff-actions/types'
import { staffModuleForRoute } from '../shared/staff-module-access'

export type NormalizedStaffRoute = StaffActionsTab | StaffModule

export function normalizedStaffRoute(path: string): NormalizedStaffRoute | null {
  if (path === '/staff/live') return 'tables'
  if (path === '/staff/tasks') return 'tasks'
  if (path === '/staff/fulfillment') return 'fulfillment'
  if (path === '/staff/reservations') return 'reservations'
  if (path === '/staff/payments') return 'payments'
  if (path === '/staff/performance') return 'performance'
  if (path === '/staff/inventory') return 'inventory'
  if (path === '/staff/operations') return 'operations'
  if (path === '/staff/customer-experience') return 'experience'
  if (path === '/staff/member-fulfillment') return 'member-fulfillment'
  if (path === '/staff/member-exceptions') return 'member-exceptions'
  if (path === '/staff/member-overview') return 'member-overview'
  if (path === '/staff/member-rule-drafts') return 'member-rule-drafts'
  if (path === '/staff/member-rule-approvals') return 'member-rule-approvals'
  if (path === '/staff/member-rule-publish') return 'member-rule-publish'
  if (path === '/staff/member-accounts') return 'member-accounts'
  if (path === '/staff/member-management') return 'member-management'
  if (path === '/staff/devices') return 'devices'
  if (path === '/staff/settings') return 'settings'
  return null
}

export function normalizedStaffNavigationCode(path: string): string | null {
  return staffModuleForRoute(path)?.code ?? null
}
