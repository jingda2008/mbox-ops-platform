const runtime = require('./platform')
const { request, deviceKey, clearReservationCookie } = require('./request')
const { randomId } = require('./id')

const EXPIRY_KEY = 'mbox.public.session.expiresAt'
const ASSERTION_KEY = 'mbox.public.identity.assertion'
let inFlightSession = null

function anonymousAssertion() {
  let value = runtime.getStorageSync(ASSERTION_KEY)
  if (typeof value === 'string' && value.length >= 16) return value
  value = randomId('alipay-anonymous-identity')
  runtime.setStorageSync(ASSERTION_KEY, value)
  return value
}

function isCustomerSessionInvalid(error) {
  const message = String((error && error.message) || '')
  const code = String((error && error.code) || '')
  return Boolean(error && error.statusCode === 401)
    || code === 'RESERVATION_SESSION_INVALID'
    || code === 'AUTHENTICATION_REQUIRED'
    || /预约会话已失效|登录状态已失效|登录或桌边会话已过期|重新进入预约/.test(message)
}

function isAlipayIdentityUnavailable(error) {
  return Boolean(error && error.code === 'ALIPAY_IDENTITY_UNAVAILABLE')
}

async function issueReservationSession() {
  const response = await request('/api/public/reservation/session', {
    method: 'POST',
    requireTableSession: false,
    headers: { 'idempotency-key': randomId('public-session') },
    data: {
      provider: 'anonymous',
      providerAssertion: anonymousAssertion(),
      deviceFingerprint: deviceKey(),
    },
  })
  const data = response.data || response
  runtime.setStorageSync(EXPIRY_KEY, data.expiresAt || '')
  return true
}

async function openReservationSession(force) {
  const expiry = Date.parse(runtime.getStorageSync(EXPIRY_KEY) || '')
  if (!force && expiry > Date.now() + 60000) return true
  return issueReservationSession()
}

function ensureCustomerSession(force) {
  if (inFlightSession && !force) return inFlightSession
  const pending = openReservationSession(Boolean(force))
  inFlightSession = pending
  pending.finally(() => {
    if (inFlightSession === pending) inFlightSession = null
  }).catch(() => undefined)
  return pending
}

function clearCustomerSession() {
  runtime.removeStorageSync(EXPIRY_KEY)
  clearReservationCookie()
}

function rotateAnonymousAssertion() {
  runtime.removeStorageSync(ASSERTION_KEY)
  return anonymousAssertion()
}

async function restartAnonymousCustomerSession() {
  clearCustomerSession()
  rotateAnonymousAssertion()
  await issueReservationSession()
}

function renewReservationSessionOnly() {
  runtime.removeStorageSync(EXPIRY_KEY)
  clearReservationCookie()
}

export {
  ensureCustomerSession,
  clearCustomerSession,
  restartAnonymousCustomerSession,
  renewReservationSessionOnly,
  isCustomerSessionInvalid,
  isAlipayIdentityUnavailable,
}
