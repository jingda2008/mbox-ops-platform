import type {
  WechatLoyaltyNotificationType,
  WechatNotificationAuthorizationOption,
} from './wechat-loyalty-notification-repository.js'
import type {
  WechatMemberServiceAuthorizationOption,
  WechatMemberServiceNotificationType,
} from './wechat-member-service-notification-repository.js'

export const WECHAT_NOTIFICATION_PROMPT_CONTEXTS = Object.freeze([
  'order_selection', 'order_checkout', 'activity_registration', 'coupon_open', 'member_card',
  'reservation_submit', 'reservation_performance',
] as const)

export type WechatNotificationPromptContext = (typeof WECHAT_NOTIFICATION_PROMPT_CONTEXTS)[number]
type NotificationType = WechatLoyaltyNotificationType | WechatMemberServiceNotificationType | 'reservation_performance_revised'

export type WechatNotificationPromptOption =
  | (WechatNotificationAuthorizationOption & { apiKind: 'loyalty' })
  | (WechatMemberServiceAuthorizationOption & { apiKind: 'member_service' })
  | ({
    policyId: string
    notificationType: 'reservation_performance_revised'
    policyVersion: number
    templateId: string
    decision: 'granted' | 'denied' | 'revoked' | null
    platformResult: 'accept' | 'reject' | 'ban' | 'revoke' | null
    authorizationVersion: number
    usesRemaining: number
    changedAt: string | null
    reservationPublicId?: string
    apiKind: 'reservation_performance'
  })

// This is a server-side decision policy, not mini-program presentation logic.
// The first type is the action's non-negotiable contextual reminder.  The
// remaining positions make the most of WeChat's three-template limit without
// making a second request for the same action.
const CONTEXTUAL_PRIORITY: Readonly<Record<WechatNotificationPromptContext, readonly NotificationType[]>> = {
  order_selection: [
    'member_benefit_issued', 'membership_tier_changed', 'activity_registration_confirmed',
    'loyalty_points_credited', 'loyalty_points_reversed', 'loyalty_points_expiring',
  ],
  order_checkout: [
    'loyalty_points_credited', 'loyalty_points_reversed', 'loyalty_points_expiring',
    'member_benefit_issued', 'membership_tier_changed', 'activity_registration_confirmed',
  ],
  activity_registration: [
    'activity_registration_confirmed', 'activity_performance_starting', 'activity_schedule_changed',
    'member_benefit_issued', 'membership_tier_changed', 'loyalty_points_credited',
    'loyalty_points_reversed', 'loyalty_points_expiring',
  ],
  coupon_open: [
    'member_benefit_issued', 'membership_tier_changed', 'loyalty_points_credited',
    'loyalty_points_reversed', 'activity_registration_confirmed', 'loyalty_points_expiring',
  ],
  member_card: [
    'membership_tier_changed', 'member_benefit_issued', 'loyalty_points_credited',
    'loyalty_points_reversed', 'activity_registration_confirmed', 'loyalty_points_expiring',
  ],
  reservation_submit: [
    'reservation_performance_revised', 'member_benefit_issued', 'loyalty_points_credited',
    'membership_tier_changed', 'loyalty_points_expiring', 'activity_registration_confirmed',
  ],
  reservation_performance: [
    'reservation_performance_revised', 'member_benefit_issued', 'loyalty_points_credited',
    'membership_tier_changed', 'loyalty_points_expiring', 'activity_registration_confirmed',
  ],
}

export function decideWechatNotificationPrompt(input: Readonly<{
  context: WechatNotificationPromptContext
  loyaltyAuthorizations: readonly WechatNotificationAuthorizationOption[]
  memberServiceAuthorizations: readonly WechatMemberServiceAuthorizationOption[]
  reservationPerformanceAuthorizations?: readonly WechatNotificationPromptOption[]
}>): WechatNotificationPromptOption[] {
  return rankWechatNotificationPromptOptions({
    context: input.context,
    candidates: buildWechatNotificationPromptCandidates(input).filter((item) => (
      item.usesRemaining <= 0 && item.platformResult !== 'ban'
    )),
  })
}

export function decideWechatNotificationPresentation(input: Readonly<{
  context: WechatNotificationPromptContext
  loyaltyAuthorizations: readonly WechatNotificationAuthorizationOption[]
  memberServiceAuthorizations: readonly WechatMemberServiceAuthorizationOption[]
  reservationPerformanceAuthorizations?: readonly WechatNotificationPromptOption[]
}>): WechatNotificationPromptOption[] {
  return rankWechatNotificationPromptOptions({
    context: input.context,
    candidates: buildWechatNotificationPromptCandidates(input),
  }).filter((item) => item.platformResult !== 'ban')
}

function buildWechatNotificationPromptCandidates(input: Readonly<{
  loyaltyAuthorizations: readonly WechatNotificationAuthorizationOption[]
  memberServiceAuthorizations: readonly WechatMemberServiceAuthorizationOption[]
  reservationPerformanceAuthorizations?: readonly WechatNotificationPromptOption[]
}>): WechatNotificationPromptOption[] {
  return [
    ...(input.reservationPerformanceAuthorizations || []),
    ...input.loyaltyAuthorizations.map((item) => ({ ...item, apiKind: 'loyalty' as const })),
    ...input.memberServiceAuthorizations.map((item) => ({ ...item, apiKind: 'member_service' as const })),
  ].filter((item) => item.templateId.trim().length > 0)
}

function rankWechatNotificationPromptOptions(input: Readonly<{
  context: WechatNotificationPromptContext
  candidates: readonly WechatNotificationPromptOption[]
}>): WechatNotificationPromptOption[] {
  const priority = CONTEXTUAL_PRIORITY[input.context]
  const rank = new Map(priority.map((notificationType, index) => [notificationType, index]))
  const seenTemplates = new Set<string>()
  return [...input.candidates]
    .sort((left, right) => (
      (rank.get(left.notificationType) ?? Number.MAX_SAFE_INTEGER)
      - (rank.get(right.notificationType) ?? Number.MAX_SAFE_INTEGER)
    ))
    .filter((item) => {
      if (seenTemplates.has(item.templateId)) return false
      seenTemplates.add(item.templateId)
      return true
    })
    .slice(0, 3)
}
