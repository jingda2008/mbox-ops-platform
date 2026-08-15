import { describe, expect, it } from 'vitest'
import { normalizedStaffRoute } from './normalized-staff-routes'

describe('normalized staff route coverage', () => {
  it('keeps service and fulfillment as separate role workspaces', () => {
    expect(normalizedStaffRoute('/staff/tasks')).toBe('tasks')
    expect(normalizedStaffRoute('/staff/fulfillment')).toBe('fulfillment')
  })

  it('has a normalized destination for every configured staff module', () => {
    expect([
      '/staff/live', '/staff/tasks', '/staff/fulfillment', '/staff/reservations',
      '/staff/payments', '/staff/performance', '/staff/inventory',
      '/staff/operations', '/staff/devices', '/staff/settings',
      '/staff/customer-experience',
    ].map(normalizedStaffRoute)).not.toContain(null)
  })

  it('does not reopen a legacy or unknown staff route', () => {
    expect(normalizedStaffRoute('/staff/legacy')).toBeNull()
    expect(normalizedStaffRoute('/guest')).toBeNull()
  })
})
