import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  selectStackedCandidates,
  type PromotionAwardCandidate,
} from './promotional-loyalty-worker.js'

describe('promotional loyalty worker', () => {
  it('selects all stackable rules and only the deterministic winner for exclusive groups', () => {
    const selected = selectStackedCandidates([
      candidate('stack-a', 'A', 'stackable', 20, 20),
      candidate('stack-b', 'A', 'stackable', 10, 10),
      candidate('high-low', 'B', 'exclusive_highest', 50, 500),
      candidate('high-win', 'B', 'exclusive_highest', 90, 100),
      candidate('first-low', 'C', 'exclusive_first', 500, 1),
      candidate('first-win', 'C', 'exclusive_first', 5, 999),
    ])
    expect(selected.map((item) => item.ruleId)).toEqual([
      'first-win',
      'high-win',
      'stack-a',
      'stack-b',
    ])
  })

  it('fails closed on conflicting modes within one published stacking group', () => {
    expect(() => selectStackedCandidates([
      candidate('one', 'CONFLICT', 'stackable', 20, 10),
      candidate('two', 'CONFLICT', 'exclusive_highest', 30, 20),
    ])).toThrow('Published promotion stacking modes conflict')
  })

  it('uses typed authority, pause, budget, membership and refund facts without JSON runtime decisions', () => {
    const source = readFileSync(new URL('./promotional-loyalty-worker.ts', import.meta.url), 'utf8')
    expect(source).toContain("state('points_accrual', true)")
    expect(source).toContain("payment.status IN ('succeeded','partially_refunded','refunded')")
    expect(source).toContain("membership.status='active'")
    expect(source).toContain('policy.store_budget_points')
    expect(source).toContain('policy.per_member_points_limit')
    expect(source).toContain('policy.eligible_member_levels')
    expect(source).toContain("refund.status='succeeded'")
    expect(source).toContain('loyalty_promotion_refund_applications')
    expect(source).toContain("resolution_code='promotion_trigger_pending'")
    expect(source).toContain('loyalty-promotion-registration:')
    expect(source).not.toMatch(/provider_snapshot|activity_details|sales_copy|audience_rule/)
  })
})

function candidate(
  ruleId: string,
  stackingGroup: string,
  stackingMode: PromotionAwardCandidate['stackingMode'],
  points: number,
  priority: number,
): PromotionAwardCandidate {
  return {
    policyVersionId: `policy-${ruleId}`,
    ruleId,
    ruleCode: ruleId.toUpperCase(),
    points,
    perMemberAwardLimit: 1,
    campaignCode: `CAMPAIGN-${ruleId}`,
    stackingGroup,
    stackingMode,
    priority,
    storeBudgetPoints: 10_000,
    perMemberPointsLimit: 500,
    pointValidityDays: 180,
    refundPolicy: 'reverse_on_any_refund',
    budgetReuseAfterRefund: false,
    memberLimitReuseAfterRefund: false,
    membershipId: 'membership-id',
    customerId: 'customer-id',
    accountId: 'account-id',
    availablePoints: 0,
    pendingRecoveryPoints: 0,
    growthValue: 0,
  }
}
