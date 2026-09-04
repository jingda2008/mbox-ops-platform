const MAX_TEMPLATE_IDS_PER_REQUEST = 3

function mergeAlipayNotificationPromptOptions(...groups) {
  const seen = new Set()
  const merged = []
  for (const group of groups) {
    for (const item of group || []) {
      const templateId = String(item && item.templateId || '').trim()
      if (!templateId || seen.has(templateId)) continue
      seen.add(templateId)
      merged.push(item)
      if (merged.length >= MAX_TEMPLATE_IDS_PER_REQUEST) return merged
    }
  }
  return merged
}

function prioritizeAlipayNotificationOptions(options, notificationTypes) {
  const requested = new Set((notificationTypes || []).map((item) => String(item || '')).filter(Boolean))
  const rank = new Map((notificationTypes || []).map((type, index) => [type, index]))
  const ranking = (notificationType) => (
    rank.has(notificationType) ? rank.get(notificationType) : Number.MAX_SAFE_INTEGER
  )
  return mergeAlipayNotificationPromptOptions(options)
    .filter((item) => !requested.size || requested.has(item.notificationType))
    .sort((left, right) => (
      ranking(left.notificationType) - ranking(right.notificationType)
    ))
}

function buildAlipaySubscriptionPresentationOptions(input, notificationTypes) {
  const catalog = [
    ...(input && input.performance ? input.performance : []).map((item) => Object.assign({}, item, {
      apiKind: 'reservation_performance',
      notificationType: item.notificationType || 'reservation_performance_revised',
    })),
    ...(input && input.memberService ? input.memberService : []).map((item) => Object.assign({}, item, {
      apiKind: 'member_service',
    })),
    ...(input && input.loyalty ? input.loyalty : []).map((item) => Object.assign({}, item, {
      apiKind: 'loyalty',
    })),
  ]
  return prioritizeAlipayNotificationOptions(catalog, notificationTypes)
}

function extractPromptPresentation(prompt) {
  return mergeAlipayNotificationPromptOptions(
    prompt && prompt.presentation,
    prompt && prompt.authorizations,
  )
}

function requestAlipaySubscriptionFromTap() {
  return Promise.resolve({
    presented: false,
    outcomes: [],
    blockedReason: '支付宝订阅消息后端适配尚未开通',
  })
}

function requestAlipaySubscription() {
  return requestAlipaySubscriptionFromTap()
}

const ACTIVITY_REGISTRATION_SUBSCRIBE_TYPES = Object.freeze([
  'activity_registration_confirmed',
  'activity_performance_starting',
  'activity_schedule_changed',
  'member_benefit_issued',
  'membership_tier_changed',
  'loyalty_points_credited',
  'loyalty_points_expiring',
  'loyalty_points_reversed',
])

const RESERVATION_SUCCESS_SUBSCRIBE_TYPES = Object.freeze([
  'reservation_performance_revised',
])

function buildReservationSubscriptionPresentation(...groups) {
  return prioritizeAlipayNotificationOptions(
    mergeAlipayNotificationPromptOptions(...groups),
    RESERVATION_SUCCESS_SUBSCRIBE_TYPES,
  )
}

function buildActivitySubscriptionPresentation(...groups) {
  return prioritizeAlipayNotificationOptions(
    mergeAlipayNotificationPromptOptions(...groups),
    ACTIVITY_REGISTRATION_SUBSCRIBE_TYPES,
  )
}

export {
  requestAlipaySubscription,
  requestAlipaySubscriptionFromTap,
  mergeAlipayNotificationPromptOptions,
  buildAlipaySubscriptionPresentationOptions,
  buildReservationSubscriptionPresentation,
  buildActivitySubscriptionPresentation,
  extractPromptPresentation,
  prioritizeAlipayNotificationOptions,
  ACTIVITY_REGISTRATION_SUBSCRIBE_TYPES,
  RESERVATION_SUCCESS_SUBSCRIBE_TYPES,
}
