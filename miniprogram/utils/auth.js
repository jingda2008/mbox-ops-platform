const { request, deviceKey } = require('./request')
const { randomId } = require('./id')

const EXPIRY_KEY = 'mbox.public.session.expiresAt'
const ASSERTION_KEY = 'mbox.public.identity.assertion'

function anonymousAssertion() {
  let value = wx.getStorageSync(ASSERTION_KEY)
  if (typeof value === 'string' && value.length >= 16) return value
  value = randomId('mini-anonymous-identity')
  wx.setStorageSync(ASSERTION_KEY, value)
  return value
}

async function ensureCustomerSession(force) {
  const expiry = Date.parse(wx.getStorageSync(EXPIRY_KEY) || '')
  if (!force && expiry > Date.now() + 60_000) return true
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
  wx.setStorageSync(EXPIRY_KEY, data.expiresAt || '')
  return true
}

function clearCustomerSession() {
  wx.removeStorageSync(EXPIRY_KEY)
  wx.removeStorageSync('mbox.http.cookie.v1')
}

module.exports = { ensureCustomerSession, clearCustomerSession }
