const { getRuntimeConfig } = require('../config/index')
const { developmentBootstrap, developmentMember } = require('../mock/data')
const { request } = require('./request')
const { randomId } = require('./id')
const { getTableSession, updateTableToken } = require('./session')
const { ensureCustomerSession } = require('./auth')

async function withDevFallback(loader, fallback) {
  try {
    return { data: await loader(), source: 'api', warning: '' }
  } catch (error) {
    const config = getRuntimeConfig()
    if (!config.isDevelopment || !config.allowDevDataFallback) throw error
    return {
      data: fallback,
      source: 'development-fallback',
      warning: `本地 API 不可用，当前展示开发占位数据：${error.message}`,
    }
  }
}

function developmentGuestSession() {
  const table = developmentBootstrap.tables[0]
  return {
    store: developmentBootstrap.store,
    table: { code: table.code, displayName: table.displayName, status: table.status, occupied: table.status === 'occupied' },
    primaryServiceName: developmentBootstrap.employees[0].displayName,
    serviceTypes: developmentBootstrap.config.serviceTypes,
    tasks: [],
    account: { tableSessionId: null, balanceAmount: 0, orders: [] },
    songOffers: [],
    songRequests: [],
    tableToken: '',
    serverNow: developmentBootstrap.serverNow,
  }
}

async function loadGuestSession() {
  const config = getRuntimeConfig()
  const session = getTableSession()
  const query = config.isDevelopment && !session.tableToken
    ? `table=${encodeURIComponent(session.tableCode)}`
    : `token=${encodeURIComponent(session.tableToken)}`
  const data = await request(`/api/guest/session?${query}`, { requireTableToken: false })
  if (data.tableToken) updateTableToken(data.tableToken)
  return data
}

function getGuestSession() {
  return withDevFallback(loadGuestSession, developmentGuestSession())
}

function createServiceTask(input) {
  const session = getTableSession()
  return request('/api/guest/tasks', {
    method: 'POST',
    data: Object.assign({}, input, {
      tableToken: session.tableToken,
      idempotencyKey: randomId(`guest-${session.tableCode}-${input.serviceTypeId}`),
    }),
  })
}

function actOnTask(taskId, action) {
  const session = getTableSession()
  return request(`/api/guest/tasks/${encodeURIComponent(taskId)}/feedback`, {
    method: 'POST',
    data: {
      tableToken: session.tableToken,
      action,
      note: action === 'unresolved' ? '客户反馈仍未解决' : '',
      idempotencyKey: randomId(`guest-feedback-${taskId}-${action}`),
    },
  })
}

async function getMemberPortal() {
  const config = getRuntimeConfig()
  if (!config.isDevelopment) await ensureCustomerSession()
  if (!config.isDevelopment) return { data: await request('/api/wechat/member-portal'), source: 'api', warning: '' }
  const path = `/api/dev/member-portal/${encodeURIComponent(config.developmentMemberId)}`
  return withDevFallback(() => request(path), developmentMember)
}

function submitSongRequest(input) {
  const session = getTableSession()
  return request('/api/guest/song-requests', {
    method: 'POST',
    data: Object.assign({}, input, {
      tableToken: session.tableToken,
      idempotencyKey: randomId('song-submit'),
    }),
  })
}

function reservationRequest(path, options) {
  const config = getRuntimeConfig()
  const settings = options || {}
  if (!config.apiBaseUrl || !config.storeId) return Promise.reject(new Error('尚未配置 API 地址或门店编号'))
  const headers = { 'content-type': 'application/json', 'x-mbox-store-id': config.storeId }
  const customerToken = wx.getStorageSync('mbox.customer.session.token')
  if (customerToken) headers.Authorization = `Bearer ${customerToken}`
  if (config.isDevelopment && config.developmentActorId) headers['x-mbox-actor-id'] = config.developmentActorId
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${config.apiBaseUrl}${path}`,
      method: settings.method || 'GET',
      data: settings.data,
      header: headers,
      timeout: config.requestTimeoutMs,
      success(response) {
        if (response.statusCode >= 200 && response.statusCode < 300) return resolve(response.data)
        const body = response.data || {}
        const error = new Error(body.message || `预约请求失败（${response.statusCode}）`)
        error.code = body.code || 'RESERVATION_HTTP_ERROR'
        error.statusCode = response.statusCode
        reject(error)
      },
      fail(error) {
        const requestError = new Error(error.errMsg || '预约网络连接失败')
        requestError.code = 'NETWORK_ERROR'
        reject(requestError)
      },
    })
  })
}

async function getReservations() {
  const config = getRuntimeConfig()
  if (!config.isDevelopment) await ensureCustomerSession()
  const path = config.isDevelopment ? '/api/reservations' : '/api/wechat/reservations'
  return reservationRequest(path)
}

async function createCustomerReservation(input) {
  const config = getRuntimeConfig()
  if (!config.isDevelopment) await ensureCustomerSession()
  const idempotencyKey = randomId('wechat-reservation')
  const payload = Object.assign({}, input, { idempotencyKey })
  if (config.isDevelopment) {
    Object.assign(payload, {
      customerReference: `development-member:${config.developmentMemberId}`,
      contactReference: `development-member:${config.developmentMemberId}`,
      sourceCode: 'wechat',
      depositRequiredAmount: 0,
      depositCurrency: 'CNY',
    })
  }
  const path = config.isDevelopment ? '/api/reservations' : '/api/wechat/reservations'
  return reservationRequest(path, { method: 'POST', data: payload })
}

module.exports = {
  getGuestSession,
  createServiceTask,
  actOnTask,
  getMemberPortal,
  submitSongRequest,
  getReservations,
  createCustomerReservation,
}
