const runtime = require('./platform')
const STORAGE_KEY = 'mbox.alipay.subscription.presentation.v1'

function readPresentationCache() {
  const cached = runtime.getStorageSync(STORAGE_KEY)
  return cached && typeof cached === 'object' ? cached : {}
}

function rememberPresentationOptions(context, options) {
  const normalized = Array.isArray(options) ? options.filter((item) => item && item.templateId) : []
  if (!normalized.length) return normalized
  const cached = readPresentationCache()
  cached[String(context || 'latest')] = normalized
  cached.latest = normalized
  runtime.setStorageSync(STORAGE_KEY, cached)
  return normalized
}

function resolvePresentationOptions(context, ...localGroups) {
  const cached = readPresentationCache()
  const merge = require('./alipay-subscription').mergeAlipayNotificationPromptOptions
  const buildReservation = require('./alipay-subscription').buildReservationSubscriptionPresentation
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

export {
  rememberPresentationOptions,
  resolvePresentationOptions,
}
