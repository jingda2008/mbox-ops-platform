const {
  recordWechatNotificationAuthorization,
  recordWechatMemberServiceNotificationAuthorization,
} = require('./api')

const PLATFORM_RESULTS = new Set(['accept', 'reject', 'ban'])
const MAX_TEMPLATE_IDS_PER_REQUEST = 3
const AUTHORIZATION_RECORDING_WAIT_MS = 1500

function pendingOptions(options, notificationTypes) {
  const requested = new Set((notificationTypes || []).map((item) => String(item || '')).filter(Boolean))
  const templates = new Set()
  return (options || []).filter((item) => {
    if (!item || (requested.size && !requested.has(item.notificationType))) return false
    if (Number(item.usesRemaining || 0) > 0 || item.platformResult === 'ban') return false
    const templateId = String(item.templateId || '').trim()
    if (!templateId || templates.has(templateId)) return false
    templates.add(templateId)
    return true
  }).slice(0, MAX_TEMPLATE_IDS_PER_REQUEST)
}

async function requestWechatSubscription(options, notificationTypes) {
  const candidates = pendingOptions(options, notificationTypes)
  if (!candidates.length || typeof wx.requestSubscribeMessage !== 'function') {
    return { presented: false, outcomes: [] }
  }
  let platform
  try {
    platform = await new Promise((resolve, reject) => wx.requestSubscribeMessage({
      tmplIds: candidates.map((item) => item.templateId), success: resolve, fail: reject,
    }))
  } catch (_error) {
    // Closing the native sheet, or an old WeChat version, must never block the
    // customer action that offered this optional service notification.
    return { presented: true, outcomes: [] }
  }
  const outcomes = candidates.map((option) => ({ option, platformResult: platform && platform[option.templateId] }))
    .filter((item) => PLATFORM_RESULTS.has(item.platformResult))
  const recordings = Promise.all(outcomes.map(async ({ option, platformResult }) => {
    const record = option.apiKind === 'member_service'
      ? recordWechatMemberServiceNotificationAuthorization
      : recordWechatNotificationAuthorization
    return record({
      notificationType: option.notificationType,
      policyId: option.policyId,
      policyVersion: option.policyVersion,
      templateId: option.templateId,
      expectedVersion: option.authorizationVersion,
      platformResult,
    }).catch(() => undefined)
  }))
  // The result is normally saved before the business write so an immediately
  // confirmed registration can use it.  A slow network must not keep a member
  // from registering or paying; the request may complete in the background.
  await Promise.race([
    recordings,
    new Promise((resolve) => setTimeout(resolve, AUTHORIZATION_RECORDING_WAIT_MS)),
  ])
  return { presented: true, outcomes }
}

module.exports = { requestWechatSubscription }
