const {
  recordWechatNotificationAuthorization,
  recordWechatMemberServiceNotificationAuthorization,
  recordReservationPerformanceNotificationAuthorization,
} = require('./api')

const PLATFORM_RESULTS = new Set(['accept', 'reject', 'ban'])
const MAX_TEMPLATE_IDS_PER_REQUEST = 3
const AUTHORIZATION_RECORDING_WAIT_MS = 1500

function mergeWechatNotificationPromptOptions(...groups) {
  const seen = new Set()
  const merged = []
  for (const group of groups) {
    for (const item of group || []) {
      if (!item || !item.templateId) continue
      const templateId = String(item.templateId).trim()
      if (!templateId || seen.has(templateId)) continue
      seen.add(templateId)
      merged.push(item)
      if (merged.length >= MAX_TEMPLATE_IDS_PER_REQUEST) return merged
    }
  }
  return merged
}

function prioritizeWechatNotificationOptions(options, notificationTypes) {
  const requested = new Set((notificationTypes || []).map((item) => String(item || '')).filter(Boolean))
  const rank = new Map((notificationTypes || []).map((notificationType, index) => [notificationType, index]))
  const templates = new Set()
  return (options || [])
    .filter((item) => item && (!requested.size || requested.has(item.notificationType)))
    .sort((left, right) => (
      (rank.get(left.notificationType) ?? Number.MAX_SAFE_INTEGER)
      - (rank.get(right.notificationType) ?? Number.MAX_SAFE_INTEGER)
    ))
    .filter((item) => {
      if (item.platformResult === 'ban') return false
      const templateId = String(item.templateId || '').trim()
      if (!templateId || templates.has(templateId)) return false
      templates.add(templateId)
      return true
    })
    .slice(0, MAX_TEMPLATE_IDS_PER_REQUEST)
}

function presentationOptions(options, notificationTypes) {
  // WeChat shows the bottom multi-select sheet only when 2-3 tmplIds are
  // passed.  Presentation is separate from whether the server still needs a
  // new authorization record for that template.
  return prioritizeWechatNotificationOptions(options, notificationTypes)
}

function buildWechatSubscriptionPresentationOptions(input, notificationTypes) {
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
  return presentationOptions(catalog, notificationTypes)
}

function shouldRecordAuthorization(option) {
  if (!option || !String(option.policyId || '').trim()) return false
  return Number(option.usesRemaining || 0) <= 0 && option.platformResult !== 'ban'
}

function authorizationPayload(option, platformResult) {
  return {
    notificationType: option.notificationType,
    policyId: option.policyId,
    policyVersion: Number(option.policyVersion || 0),
    templateId: option.templateId,
    expectedVersion: Number(option.authorizationVersion ?? option.expectedVersion ?? 0),
    platformResult,
  }
}

async function recordAuthorizationOutcome(option, platformResult) {
  const payload = authorizationPayload(option, platformResult)
  if (option.apiKind === 'member_service') {
    return recordWechatMemberServiceNotificationAuthorization(payload)
  }
  if (option.apiKind === 'reservation_performance') {
    return recordReservationPerformanceNotificationAuthorization(Object.assign({}, payload, {
      reservationPublicId: option.reservationPublicId,
    }))
  }
  return recordWechatNotificationAuthorization(payload)
}

function subscriptionCandidates(options, notificationTypes) {
  const source = options || []
  if (Array.isArray(notificationTypes) && notificationTypes.length) {
    const preferred = presentationOptions(source, notificationTypes)
    if (preferred.length >= MAX_TEMPLATE_IDS_PER_REQUEST) return preferred
    return mergeWechatNotificationPromptOptions(preferred, source).slice(0, MAX_TEMPLATE_IDS_PER_REQUEST)
  }
  if (source.length >= 2) {
    const templates = new Set()
    return source.filter((item) => {
      if (!item || item.platformResult === 'ban') return false
      const templateId = String(item.templateId || '').trim()
      if (!templateId || templates.has(templateId)) return false
      templates.add(templateId)
      return true
    }).slice(0, MAX_TEMPLATE_IDS_PER_REQUEST)
  }
  return presentationOptions(source, notificationTypes)
}

function extractPromptPresentation(prompt) {
  const presentation = prompt && Array.isArray(prompt.presentation) ? prompt.presentation : []
  if (presentation.length >= 2) return presentation
  return mergeWechatNotificationPromptOptions(presentation, prompt && prompt.authorizations)
}

function finalizeWechatSubscription(candidates, platform) {
  const outcomes = candidates.map((option) => ({ option, platformResult: platform && platform[option.templateId] }))
    .filter((item) => PLATFORM_RESULTS.has(item.platformResult))
  const recordings = Promise.all(outcomes.map(async ({ option, platformResult }) => {
    if (!shouldRecordAuthorization(option)) return undefined
    return recordAuthorizationOutcome(option, platformResult).catch(() => undefined)
  }))
  return Promise.race([
    recordings,
    new Promise((resolve) => setTimeout(resolve, AUTHORIZATION_RECORDING_WAIT_MS)),
  ]).then(() => ({ presented: true, outcomes }))
}

function requestWechatSubscriptionFromTap(options, notificationTypes) {
  const candidates = subscriptionCandidates(options, notificationTypes)
  if (!candidates.length || typeof wx.requestSubscribeMessage !== 'function') {
    return Promise.resolve({ presented: false, outcomes: [] })
  }
  return new Promise((resolve) => {
    let settled = false
    const finish = (platform) => {
      if (settled) return
      settled = true
      finalizeWechatSubscription(candidates, platform).then(resolve)
    }
    wx.requestSubscribeMessage({
      tmplIds: candidates.map((item) => item.templateId),
      success: finish,
      fail: () => finish(null),
      complete: () => {
        if (!settled) finish(null)
      },
    })
  })
}

async function requestWechatSubscription(options, notificationTypes) {
  return requestWechatSubscriptionFromTap(options, notificationTypes)
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

// WeChat shows titles from template IDs.  Keep these as hard fallbacks so the
// Superhigh sheet stays correct even before the new policies are published.
const ACTIVITY_SHEET_FALLBACK_OPTIONS = Object.freeze([
  {
    apiKind: 'member_service',
    notificationType: 'activity_performance_starting',
    templateId: '4l6FLtKAkhYAb2v45G0NxaGAXmDsyi2gsD0F7H0h2Ag',
    policyId: '',
    policyVersion: 0,
    authorizationVersion: 0,
    usesRemaining: 0,
    platformResult: null,
  },
  {
    apiKind: 'member_service',
    notificationType: 'activity_schedule_changed',
    templateId: 'GQl7s-_G7gsUMliU7o_g3bstB9yXO6B2pctz1rwJMkg',
    policyId: '',
    policyVersion: 0,
    authorizationVersion: 0,
    usesRemaining: 0,
    platformResult: null,
  },
])

const RESERVATION_SUCCESS_SUBSCRIBE_TYPES = Object.freeze([
  'reservation_performance_revised',
  'loyalty_points_expiring',
  'membership_tier_changed',
  'member_benefit_issued',
  'loyalty_points_credited',
])

function buildReservationSubscriptionPresentation(...groups) {
  const catalog = []
  const seen = new Set()
  for (const group of groups) {
    for (const item of group || []) {
      if (!item || item.platformResult === 'ban') continue
      const templateId = String(item.templateId || '').trim()
      if (!templateId || seen.has(templateId)) continue
      seen.add(templateId)
      catalog.push(item)
    }
  }
  const preferred = prioritizeWechatNotificationOptions(catalog, RESERVATION_SUCCESS_SUBSCRIBE_TYPES)
  if (preferred.length >= MAX_TEMPLATE_IDS_PER_REQUEST) return preferred
  return mergeWechatNotificationPromptOptions(preferred, catalog)
}

function buildActivitySubscriptionPresentation(...groups) {
  const catalog = []
  const seen = new Set()
  for (const group of groups) {
    for (const item of group || []) {
      if (!item || item.platformResult === 'ban') continue
      const templateId = String(item.templateId || '').trim()
      if (!templateId || seen.has(templateId)) continue
      seen.add(templateId)
      catalog.push(item)
    }
  }
  for (const fallback of ACTIVITY_SHEET_FALLBACK_OPTIONS) {
    if (seen.has(fallback.templateId)) continue
    if (catalog.some((item) => item.notificationType === fallback.notificationType)) continue
    catalog.push(fallback)
    seen.add(fallback.templateId)
  }
  const preferred = prioritizeWechatNotificationOptions(catalog, ACTIVITY_REGISTRATION_SUBSCRIBE_TYPES)
  if (preferred.length >= MAX_TEMPLATE_IDS_PER_REQUEST) return preferred
  return mergeWechatNotificationPromptOptions(preferred, catalog)
}

module.exports = {
  requestWechatSubscription,
  requestWechatSubscriptionFromTap,
  mergeWechatNotificationPromptOptions,
  buildWechatSubscriptionPresentationOptions,
  buildReservationSubscriptionPresentation,
  buildActivitySubscriptionPresentation,
  extractPromptPresentation,
  prioritizeWechatNotificationOptions,
  ACTIVITY_REGISTRATION_SUBSCRIBE_TYPES,
  RESERVATION_SUCCESS_SUBSCRIBE_TYPES,
}
