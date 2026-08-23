const { getRuntimeConfig } = require('../config/index')
const {
  request, deviceKey, storeWechatIdentityToken, clearWechatIdentityToken, clearReservationCookie,
} = require('./request')
const { randomId } = require('./id')

const EXPIRY_KEY = 'mbox.public.session.expiresAt'
const ASSERTION_KEY = 'mbox.public.identity.assertion'
const WECHAT_EXPIRY_KEY = 'mbox.wechat.identity.expiresAt.v1'
const WECHAT_PRINCIPAL_KEY = 'mbox.wechat.identity.principal.v1'
let inFlightSession = null

function anonymousAssertion() {
  let value = wx.getStorageSync(ASSERTION_KEY)
  if (typeof value === 'string' && value.length >= 16) return value
  value = randomId('mini-anonymous-identity')
  wx.setStorageSync(ASSERTION_KEY, value)
  return value
}

function wxLogin() {
  return new Promise((resolve, reject) => {
    wx.login({
      timeout: 10_000,
      success(result) {
        if (result && typeof result.code === 'string' && result.code.trim()) return resolve(result.code.trim())
        reject(new Error('微信登录未返回有效凭证'))
      },
      fail(error) {
        reject(new Error((error && error.errMsg) || '微信登录失败'))
      },
    })
  })
}

function assertWechatIdentityConfig(config) {
  const missing = []
  if (!config.identityTenantId) missing.push('identityTenantId')
  if (!config.identityStoreId) missing.push('identityStoreId')
  if (!config.wechatAppId) missing.push('wechatAppId')
  if (missing.length) throw new Error(`微信身份配置不完整：${missing.join('、')}`)
}

function isCustomerSessionInvalid(error) {
  const message = String((error && error.message) || '')
  const code = String((error && error.code) || '')
  return Boolean(error && error.statusCode === 401)
    || code === 'RESERVATION_SESSION_INVALID'
    || code === 'AUTHENTICATION_REQUIRED'
    || /预约会话已失效|登录状态已失效|登录或桌边会话已过期|重新进入预约/.test(message)
}

function isWechatIdentityUnavailable(error) {
  const message = String((error && error.message) || '')
  const code = String((error && error.code) || '')
  return code === 'WECHAT_IDENTITY_UNAVAILABLE'
    || code === 'ROUTE_NOT_FOUND'
    || /请求的页面或接口不存在|ROUTE_NOT_FOUND/.test(message)
}

async function authenticateWechat(config) {
  assertWechatIdentityConfig(config)
  try {
    const challengeAttemptId = randomId('wechat-challenge')
    const challenge = await request('/api/wechat/challenges', {
      method: 'POST',
      requireTableSession: false,
      data: {
        tenantId: config.identityTenantId,
        storeId: config.identityStoreId,
        appId: config.wechatAppId,
        idempotencyKey: challengeAttemptId,
      },
    })
    const code = await wxLogin()
    const authenticated = await request('/api/wechat/code-authentication', {
      method: 'POST',
      requireTableSession: false,
      data: {
        tenantId: config.identityTenantId,
        storeId: config.identityStoreId,
        appId: config.wechatAppId,
        code,
        state: challenge.state,
        nonce: challenge.nonce,
        idempotencyKey: randomId('wechat-authentication'),
      },
    })
    storeWechatIdentityToken(authenticated.accessToken)
    wx.setStorageSync(WECHAT_EXPIRY_KEY, authenticated.expiresAt || '')
    wx.setStorageSync(WECHAT_PRINCIPAL_KEY, authenticated.principal || null)
    return authenticated.accessToken
  } catch (error) {
    if (isWechatIdentityUnavailable(error) || (error && error.statusCode === 404)) {
      const unavailable = new Error('微信身份服务暂时未开通')
      unavailable.code = 'WECHAT_IDENTITY_UNAVAILABLE'
      throw unavailable
    }
    throw error
  }
}

async function issueReservationSession(provider, providerAssertion) {
  const response = await request('/api/public/reservation/session', {
    method: 'POST',
    requireTableSession: false,
    headers: { 'idempotency-key': randomId('public-session') },
    data: {
      provider,
      providerAssertion,
      deviceFingerprint: deviceKey(),
    },
  })
  const data = response.data || response
  wx.setStorageSync(EXPIRY_KEY, data.expiresAt || '')
  return true
}

async function openReservationSession(force) {
  const config = getRuntimeConfig()
  const expiry = Date.parse(wx.getStorageSync(EXPIRY_KEY) || '')
  if (!force && expiry > Date.now() + 60_000) return true

  let provider = 'anonymous'
  let providerAssertion = anonymousAssertion()

  if (config.wechatIdentityEnabled) {
    try {
      const identityExpiry = Date.parse(wx.getStorageSync(WECHAT_EXPIRY_KEY) || '')
      const savedToken = wx.getStorageSync('mbox.wechat.identity.accessToken.v1')
      providerAssertion = !force && identityExpiry > Date.now() + 60_000
        && typeof savedToken === 'string' && savedToken.length >= 32
        ? savedToken
        : await authenticateWechat(config)
      provider = 'wechat'
    } catch (error) {
      // 现网若未挂载 /api/wechat/*，回退匿名预约会话，避免把已有会员凭证清掉后卡死。
      if (!isWechatIdentityUnavailable(error)) throw error
      provider = 'anonymous'
      providerAssertion = anonymousAssertion()
    }
  } else if (!config.isDevelopment) {
    throw new Error('正式小程序尚未启用微信身份，已停止匿名访问')
  }

  try {
    return await issueReservationSession(provider, providerAssertion)
  } catch (error) {
    if (provider === 'wechat' && (isCustomerSessionInvalid(error) || isWechatIdentityUnavailable(error))) {
      return issueReservationSession('anonymous', anonymousAssertion())
    }
    throw error
  }
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
  wx.removeStorageSync(EXPIRY_KEY)
  clearReservationCookie()
  wx.removeStorageSync(WECHAT_EXPIRY_KEY)
  wx.removeStorageSync(WECHAT_PRINCIPAL_KEY)
  clearWechatIdentityToken()
}

function rotateAnonymousAssertion() {
  wx.removeStorageSync(ASSERTION_KEY)
  return anonymousAssertion()
}

async function restartAnonymousCustomerSession() {
  clearCustomerSession()
  rotateAnonymousAssertion()
  await issueReservationSession('anonymous', anonymousAssertion())
}

function renewReservationSessionOnly() {
  wx.removeStorageSync(EXPIRY_KEY)
  clearReservationCookie()
}

module.exports = {
  ensureCustomerSession,
  clearCustomerSession,
  restartAnonymousCustomerSession,
  renewReservationSessionOnly,
  isCustomerSessionInvalid,
  isWechatIdentityUnavailable,
}
