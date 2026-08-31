import { describe, expect, it } from 'vitest'
import { decideWechatNotificationPresentation, decideWechatNotificationPrompt } from './wechat-notification-prompt-decision-engine.js'

const base = {
  policyId: '83000000-0000-4000-8000-000000000004', purpose: 'member_service_update',
  authorizationContext: 'member_benefit', policyVersion: 1, decision: null,
  platformResult: null, authorizationVersion: 0, usesRemaining: 0, changedAt: null,
}

describe('WeChat notification prompt decision engine', () => {
  it('includes the action-relevant reminder first and uses the remaining two slots for relevant service coverage', () => {
    const plan = decideWechatNotificationPrompt({
      context: 'order_checkout',
      loyaltyAuthorizations: [
        { ...base, notificationType: 'loyalty_points_credited', templateId: 'points-credit-template', purpose: 'loyalty_balance_change', authorizationContext: 'loyalty_accrual' },
        { ...base, notificationType: 'loyalty_points_reversed', templateId: 'points-reversal-template', purpose: 'loyalty_balance_change', authorizationContext: 'loyalty_refund' },
      ],
      memberServiceAuthorizations: [
        { ...base, notificationType: 'activity_registration_confirmed', templateId: 'activity-template', authorizationContext: 'activity_registration' },
        { ...base, notificationType: 'member_benefit_issued', templateId: 'benefit-template' },
        { ...base, notificationType: 'membership_tier_changed', templateId: 'tier-template', authorizationContext: 'membership_tier' },
      ],
    })
    expect(plan.map((item) => item.notificationType)).toEqual([
      'loyalty_points_credited', 'loyalty_points_reversed', 'member_benefit_issued',
    ])
    expect(plan.map((item) => item.apiKind)).toEqual(['loyalty', 'loyalty', 'member_service'])
  })

  it('puts member benefits first when a customer starts choosing drinks, leaving payment changes for checkout', () => {
    const plan = decideWechatNotificationPrompt({
      context: 'order_selection', loyaltyAuthorizations: [],
      memberServiceAuthorizations: [
        { ...base, notificationType: 'activity_registration_confirmed', templateId: 'activity-template', authorizationContext: 'activity_registration' },
        { ...base, notificationType: 'member_benefit_issued', templateId: 'benefit-template' },
        { ...base, notificationType: 'membership_tier_changed', templateId: 'tier-template', authorizationContext: 'membership_tier' },
      ],
    })
    expect(plan.map((item) => item.notificationType)).toEqual([
      'member_benefit_issued', 'membership_tier_changed', 'activity_registration_confirmed',
    ])
  })

  it('keeps already-consumed authorizations in the presentation bundle so WeChat can render the bottom sheet', () => {
    const input = {
      context: 'activity_registration' as const,
      loyaltyAuthorizations: [
        { ...base, notificationType: 'loyalty_points_credited', templateId: 'points-credit-template', purpose: 'loyalty_balance_change', authorizationContext: 'loyalty_accrual', usesRemaining: 1, platformResult: 'accept' },
        { ...base, notificationType: 'loyalty_points_reversed', templateId: 'points-reversal-template', purpose: 'loyalty_balance_change', authorizationContext: 'loyalty_refund' },
      ],
      memberServiceAuthorizations: [
        { ...base, notificationType: 'activity_registration_confirmed', templateId: 'activity-template', authorizationContext: 'activity_registration' },
        { ...base, notificationType: 'activity_performance_starting', templateId: 'performance-start-template', authorizationContext: 'activity_performance' },
        { ...base, notificationType: 'activity_schedule_changed', templateId: 'schedule-change-template', authorizationContext: 'activity_schedule' },
        { ...base, notificationType: 'member_benefit_issued', templateId: 'benefit-template' },
      ],
    }
    expect(decideWechatNotificationPrompt(input).map((item) => item.notificationType)).toEqual([
      'activity_registration_confirmed', 'activity_performance_starting', 'activity_schedule_changed',
    ])
    expect(decideWechatNotificationPresentation(input).map((item) => item.notificationType)).toEqual([
      'activity_registration_confirmed', 'activity_performance_starting', 'activity_schedule_changed',
    ])
  })
})
