const { getRuntimeConfig } = require('../config/index')
const { getTableSession } = require('./session')

function buildHeaders(extraHeaders) {
  const config = getRuntimeConfig()
  const session = getTableSession()
  const headers = Object.assign({
    'content-type': 'application/json',
    'x-mbox-store-id': config.storeId,
    'x-mbox-table-code': session.tableCode || '',
    'x-mbox-table-token': session.tableToken || '',
  }, extraHeaders || {})

  const customerToken = wx.getStorageSync('mbox.customer.session.token')
  if (customerToken) headers.Authorization = `Bearer ${customerToken}`
  if (config.isDevelopment && config.developmentActorId) {
    headers['x-mbox-actor-id'] = config.developmentActorId
  }
  return headers
}

function request(path, options) {
  const config = getRuntimeConfig()
  const session = getTableSession()
  const settings = options || {}
  if (!config.apiBaseUrl || !config.storeId) {
    return Promise.reject(new Error('尚未配置 API 地址或门店编号'))
  }
  if (!session.tableCode || (!session.tableToken && settings.requireTableToken !== false)) {
    return Promise.reject(new Error('桌码会话无效，请重新扫描桌码'))
  }
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${config.apiBaseUrl}${path}`,
      method: settings.method || 'GET',
      data: settings.data,
      header: buildHeaders(settings.headers),
      timeout: config.requestTimeoutMs,
      success(response) {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(response.data)
          return
        }
        const body = response.data || {}
        const error = new Error(body.message || `请求失败（${response.statusCode}）`)
        error.code = body.code || 'HTTP_ERROR'
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

module.exports = { request }
