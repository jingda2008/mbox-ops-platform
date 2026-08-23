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
  if (path === '/staff/devices') return 'devices'
  if (path === '/staff/settings') return 'settings'
  return null
}

export function normalizedStaffNavigationCode(path: string): string | null {
  return staffModuleForRoute(path)?.code ?? null
}
