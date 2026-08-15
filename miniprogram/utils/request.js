const { getRuntimeConfig } = require('../config/index')
const { getTableSession } = require('./session')

const COOKIE_KEY = 'mbox.http.cookie.v1'
const DEVICE_KEY = 'mbox.device.key.v1'

function deviceKey() {
  let value = wx.getStorageSync(DEVICE_KEY)
  if (typeof value === 'string' && value.length >= 8) return value
  value = `mini-${Date.now()}-${Math.random().toString(36).slice(2, 14)}`
  wx.setStorageSync(DEVICE_KEY, value)
  return value
}

function buildHeaders(extraHeaders) {
  const config = getRuntimeConfig()
  const session = getTableSession()
  const headers = Object.assign({
    'content-type': 'application/json',
    accept: 'application/json',
    'x-mbox-store-id': config.storeId,
    'x-mbox-guest-device': deviceKey(),
    'x-mbox-table-code': session.tableCode || '',
  }, extraHeaders || {})
  const cookie = wx.getStorageSync(COOKIE_KEY)
  if (cookie) headers.cookie = cookie
  return headers
}

function rememberCookie(headers) {
  const raw = headers && (headers['Set-Cookie'] || headers['set-cookie'])
  const first = Array.isArray(raw) ? raw[0] : raw
  if (typeof first !== 'string' || !first.includes('=')) return
  const cookie = first.split(';')[0]
  if (cookie) wx.setStorageSync(COOKIE_KEY, cookie)
}

function request(path, options) {
  const config = getRuntimeConfig()
  const session = getTableSession()
  const settings = options || {}
  if (!config.apiBaseUrl || !config.storeId) return Promise.reject(new Error('尚未配置 API 地址或门店编号'))
  if (settings.requireTableSession !== false && !session.tableCode) return Promise.reject(new Error('请先扫描桌码进入当前桌次'))
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${config.apiBaseUrl}${path}`,
      method: settings.method || 'GET',
      data: settings.data,
      header: buildHeaders(settings.headers),
      timeout: config.requestTimeoutMs,
      success(response) {
        rememberCookie(response.header)
        if (response.statusCode >= 200 && response.statusCode < 300) return resolve(response.data)
        const body = response.data || {}
        const detail = body.error || body
        const error = new Error(detail.message || `请求失败（${response.statusCode}）`)
        error.code = detail.code || 'HTTP_ERROR'
        error.statusCode = response.statusCode
        reject(error)
      },
      fail(error) {
        const requestError = new Error(error.errMsg || '网络连接失败')
        requestError.code = 'NETWORK_ERROR'
        reject(requestError)
      },
    })
  })
}

module.exports = { request, deviceKey }
