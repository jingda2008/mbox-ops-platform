const { getRuntimeConfig } = require('../config/index')
const { randomId } = require('./id')

function identityRequest(path, data) {
  const config = getRuntimeConfig()
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${config.apiBaseUrl}${path}`,
      method: 'POST',
      data,
      header: { 'content-type': 'application/json' },
      timeout: config.requestTimeoutMs,
      success(response) {
        if (response.statusCode >= 200 && response.statusCode < 300) return resolve(response.data)
        const body = response.data || {}
        const error = new Error(body.message || `微信身份请求失败（${response.statusCode}）`)
        error.code = body.code || 'WECHAT_IDENTITY_HTTP_ERROR'
        reject(error)
      },
      fail(error) {
        reject(new Error(error.errMsg || '微信身份网络连接失败'))
      },
    })
  })
}

function loginCode() {
  return new Promise((resolve, reject) => {
    wx.login({
      timeout: 10000,
      success(result) {
        if (result.code) resolve(result.code)
        else reject(new Error('微信未返回登录code'))
      },
      fail(error) {
        reject(new Error(error.errMsg || '微信登录失败'))
      },
    })
  })
}

async function ensureCustomerSession() {
  const config = getRuntimeConfig()
  if (!config.wechatIdentityEnabled) return null
  if (!config.apiBaseUrl || !config.identityTenantId || !config.identityStoreId || !config.wechatAppId) {
    throw new Error('微信身份范围配置不完整')
  }
  const currentToken = wx.getStorageSync('mbox.customer.session.token')
  const currentExpiry = Date.parse(wx.getStorageSync('mbox.customer.session.expiresAt') || '')
  if (currentToken && currentExpiry > Date.now() + 60_000) return currentToken

  const scope = {
    tenantId: config.identityTenantId,
    storeId: config.identityStoreId,
    appId: config.wechatAppId,
  }
  const challenge = await identityRequest('/api/wechat/challenges', Object.assign({}, scope, {
    idempotencyKey: randomId('wechat-challenge'),
  }))
  const code = await loginCode()
  const session = await identityRequest('/api/wechat/code-authentication', Object.assign({}, scope, {
    code,
    state: challenge.state,
    nonce: challenge.nonce,
    idempotencyKey: randomId('wechat-authentication'),
  }))
  wx.setStorageSync('mbox.customer.session.token', session.accessToken)
  wx.setStorageSync('mbox.customer.session.expiresAt', session.expiresAt)
  wx.setStorageSync('mbox.customer.principal', session.principal)
  return session.accessToken
}

function clearCustomerSession() {
  wx.removeStorageSync('mbox.customer.session.token')
  wx.removeStorageSync('mbox.customer.session.expiresAt')
  wx.removeStorageSync('mbox.customer.principal')
}

module.exports = { ensureCustomerSession, clearCustomerSession }
