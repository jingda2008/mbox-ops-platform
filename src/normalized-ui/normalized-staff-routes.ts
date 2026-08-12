import type { StaffModule } from './StaffModulePanel'
import type { StaffActionsTab } from './staff-actions/types'

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
  if (path === '/staff/devices') return 'devices'
  if (path === '/staff/settings') return 'settings'
  return null
}
