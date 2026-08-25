import { describe, expect, it } from 'vitest'
import { normalizedStaffRoute } from './normalized-staff-routes'
import { businessDayBlockerFactFromHistory } from './NormalizedStaffApp'

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
      '/staff/member-fulfillment', '/staff/member-exceptions', '/staff/member-overview',
      '/staff/member-rule-drafts', '/staff/member-rule-approvals', '/staff/member-rule-publish',
      '/staff/member-accounts', '/staff/member-management',
    ].map(normalizedStaffRoute)).not.toContain(null)
  })

  it('does not reopen a legacy or unknown staff route', () => {
    expect(normalizedStaffRoute('/staff/legacy')).toBeNull()
    expect(normalizedStaffRoute('/guest')).toBeNull()
  })

  it('restores only a validated exact blocker fact from same-window navigation state',()=>{
    const fact={id:'fact-1',title:'金酒库存',statusLabel:'已预留',actionRoute:'/staff/inventory'}
    expect(businessDayBlockerFactFromHistory({businessDayBlockerFact:fact})).toBe(fact)
    expect(businessDayBlockerFactFromHistory({businessDayBlockerFact:{id:'fact-1'}})).toBeNull()
  })
})
