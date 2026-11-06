const { commandIdentityScope } = require('./recoverable-command')
const STORAGE_KEY = 'mbox.wechat.subscription.presentation.v2'

function readPresentationCache() {
  const cached = wx.getStorageSync(STORAGE_KEY)
  return cached && cached.ownerScope === commandIdentityScope() && cached.options && typeof cached.options === 'object' ? cached.options : {}
}

function rememberPresentationOptions(context, options) {
  const normalized = Array.isArray(options) ? options.filter((item) => item && item.templateId) : []
  const cached = readPresentationCache()
  cached[String(context || 'latest')] = normalized
  cached.latest = normalized
  wx.setStorageSync(STORAGE_KEY, { ownerScope: commandIdentityScope(), options: cached })
  return normalized
}

function resolvePresentationOptions(context, ...localGroups) {
  const cached = readPresentationCache()
  const merge = require('./wechat-subscription').mergeWechatNotificationPromptOptions
  const buildReservation = require('./wechat-subscription').buildReservationSubscriptionPresentation
  const key = String(context || '')
  const locals = merge(...localGroups)
  if (key === 'reservation_submit' || key === 'reservation_performance') {
    return buildReservation(
      locals,
      cached.reservation_submit,
      cached.reservation_performance,
      cached.order_checkout,
      cached.member_card,
      cached.coupon_open,
      cached.activity_registration,
      cached.latest,
    )
  }
  if (locals.length >= 2) return locals
  return merge(
    locals,
    cached[key],
    cached.activity_registration,
    cached.order_checkout,
    cached.member_card,
    cached.coupon_open,
    cached.reservation_submit,
    cached.latest,
  )
}

module.exports = {
  rememberPresentationOptions,
  resolvePresentationOptions,
}
