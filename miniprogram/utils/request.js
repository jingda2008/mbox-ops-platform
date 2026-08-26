const { getRuntimeConfig } = require('../config/index')
const { getTableSession } = require('./session')
const { tableRequestScope } = require('./table-request-scope')

const LEGACY_COOKIE_KEY = 'mbox.http.cookie.v1'
const RESERVATION_COOKIE_NAME = 'mbox_reservation_session'
const GUEST_COOKIE_NAME = '__Host-mbox_guest_session'
const RESERVATION_COOKIE_KEY = 'mbox.http.cookie.reservation.v2'
const GUEST_COOKIE_KEY = 'mbox.http.cookie.guest.v2'
const DEVICE_KEY = 'mbox.device.key.v1'
const WECHAT_TOKEN_KEY = 'mbox.wechat.identity.accessToken.v1'

const COOKIE_STORAGE_KEYS = Object.freeze({
  [RESERVATION_COOKIE_NAME]: RESERVATION_COOKIE_KEY,
  [GUEST_COOKIE_NAME]: GUEST_COOKIE_KEY,
})

function deviceKey() {
  let value = wx.getStorageSync(DEVICE_KEY)
  if (typeof value === 'string' && value.length >= 8) return value
  value = `mini-${Date.now()}-${Math.random().toString(36).slice(2, 14)}`
  wx.setStorageSync(DEVICE_KEY, value)
  return value
}

function removeHeader(headers, name) {
  Object.keys(headers).forEach((key) => {
    if (key.toLowerCase() === name) delete headers[key]
  })
}

function parseCookiePair(value) {
  if (typeof value !== 'string') return null
  const pair = value.split(';', 1)[0].trim()
  const separator = pair.indexOf('=')
  if (separator <= 0) return null
  const name = pair.slice(0, separator).trim()
  const cookieValue = pair.slice(separator + 1).trim()
  if (!Object.prototype.hasOwnProperty.call(COOKIE_STORAGE_KEYS, name)) return null
  if (cookieValue && !/^[^\s,;]+$/.test(cookieValue)) return null
  return { name, value: cookieValue, pair: `${name}=${cookieValue}` }
}

function migrateLegacyCookie() {
  const legacy = wx.getStorageSync(LEGACY_COOKIE_KEY)
  if (!legacy) return
  const parsed = parseCookiePair(legacy)
  if (parsed) wx.setStorageSync(COOKIE_STORAGE_KEYS[parsed.name], parsed.pair)
  wx.removeStorageSync(LEGACY_COOKIE_KEY)
}

function storedCookie(name) {
  migrateLegacyCookie()
  const value = wx.getStorageSync(COOKIE_STORAGE_KEYS[name])
  const parsed = parseCookiePair(value)
  return parsed && parsed.name === name ? parsed.pair : ''
}

function requestCredentialDomain(path) {
  const normalized = String(path || '').split('?', 1)[0]
  if (normalized === '/api/public' || normalized.startsWith('/api/public/')) return 'reservation'
  if (normalized === '/api/guest' || normalized.startsWith('/api/guest/')) return 'guest'
  return 'none'
}

function isCreateRedemptionRequest(path, settings) {
  return String(path || '').split('?', 1)[0] === '/api/public/mini/redemptions'
    && String((settings && settings.method) || 'GET').toUpperCase() === 'POST'
}

function buildHeaders(path, extraHeaders, settings) {
  const config = getRuntimeConfig()
  const requestedDomain = settings && settings.credentialDomain
  const anonymous = requestedDomain === 'none'
  const session = anonymous ? {} : getTableSession()
  const headers = Object.assign({
    'content-type': 'application/json',
    accept: 'application/json',
    'x-mbox-store-id': config.storeId,
    ...(anonymous ? {} : {
      'x-mbox-guest-device': deviceKey(),
      'x-mbox-table-code': session.tableCode || '',
    }),
  }, extraHeaders || {})
  removeHeader(headers, 'cookie')
  if (requestedDomain && !['none', 'wechat_identity', 'reservation+guest'].includes(requestedDomain)) {
    throw new Error('请求凭证域无效')
  }
  if (requestedDomain === 'reservation+guest' && !isCreateRedemptionRequest(path, settings)) {
    throw new Error('双会话凭证仅限创建会员兑换')
  }
  const domain = requestedDomain === 'reservation+guest'
    ? 'reservation+guest'
    : requestedDomain === 'none' ? 'none' : requestCredentialDomain(path)
  if (anonymous) {
    // A shared acquisition preview is public copy, not a continuation of an
    // existing member or table context.  Do not let caller headers reattach it.
    removeHeader(headers, 'authorization')
    removeHeader(headers, 'x-mbox-guest-device')
    removeHeader(headers, 'x-mbox-table-code')
  }
  if (domain !== 'none') removeHeader(headers, 'authorization')
  const cookies = []
  if (domain === 'reservation' || domain === 'reservation+guest') {
    const reservationCookie = storedCookie(RESERVATION_COOKIE_NAME)
    if (reservationCookie) cookies.push(reservationCookie)
  }
  if (domain === 'guest' || domain === 'reservation+guest') {
    const guestCookie = storedCookie(GUEST_COOKIE_NAME)
    if (guestCookie) cookies.push(guestCookie)
  }
  if (cookies.length) headers.cookie = cookies.join('; ')

  if (settings && settings.credentialDomain === 'wechat_identity') {
    if (domain !== 'none') throw new Error('微信身份凭证不能发送到预约或桌台会话接口')
    const hasExplicitAuthorization = Object.keys(headers).some((key) => key.toLowerCase() === 'authorization')
    if (!hasExplicitAuthorization) {
      const identityToken = wx.getStorageSync(WECHAT_TOKEN_KEY)
      if (typeof identityToken !== 'string' || identityToken.length < 32 || identityToken.includes(' ')) {
        throw new Error('微信身份会话无效')
      }
      headers.authorization = `Bearer ${identityToken}`
    }
  }
  return headers
}

function splitSetCookieHeader(value) {
  if (typeof value !== 'string') return []
  return value.split(/,(?=\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=)/g).map((part) => part.trim()).filter(Boolean)
}

function allSetCookieValues(headers, responseCookies) {
  const values = []
  Object.keys(headers || {}).forEach((key) => {
    if (key.toLowerCase() !== 'set-cookie') return
    const raw = headers[key]
    if (Array.isArray(raw)) raw.forEach((value) => values.push(...splitSetCookieHeader(value)))
    else values.push(...splitSetCookieHeader(raw))
  })
  if (Array.isArray(responseCookies)) {
    responseCookies.forEach((value) => values.push(...splitSetCookieHeader(value)))
  }
  return values
}

function cookieWasCleared(setCookieValue, parsed) {
  if (!parsed.value) return true
  const attributes = String(setCookieValue).split(';').slice(1).map((value) => value.trim())
  for (const attribute of attributes) {
    const separator = attribute.indexOf('=')
    const name = (separator < 0 ? attribute : attribute.slice(0, separator)).trim().toLowerCase()
    const value = separator < 0 ? '' : attribute.slice(separator + 1).trim()
    if (name === 'max-age' && Number(value) <= 0) return true
    if (name === 'expires') {
      const expiry = Date.parse(value)
      if (Number.isFinite(expiry) && expiry <= Date.now()) return true
    }
  }
  return false
}

function rememberCookies(headers, responseCookies, options) {
  const allowGuest = !options || options.allowGuest !== false
  allSetCookieValues(headers, responseCookies).forEach((setCookieValue) => {
    const parsed = parseCookiePair(setCookieValue)
    if (!parsed) return
    // A delayed response from a previous table must not replace (or clear)
    // the current table's guest session.  Reservation and identity domains
    // deliberately remain outside this table-scope guard.
    if (parsed.name === GUEST_COOKIE_NAME && !allowGuest) return
    const storageKey = COOKIE_STORAGE_KEYS[parsed.name]
    if (cookieWasCleared(setCookieValue, parsed)) wx.removeStorageSync(storageKey)
    else wx.setStorageSync(storageKey, parsed.pair)
  })
}

function request(path, options) {
  const config = getRuntimeConfig()
  const session = getTableSession()
  const settings = options || {}
  // Every credentialed request captures the current table identity.  A guest
  // Set-Cookie can be returned by any authenticated route, not just the scan
  // endpoint, so protecting only callers that remembered to opt in leaves a
  // cross-table race on orders, carts and payment recovery.
  const guardGuestCookiePersistence = settings.credentialDomain !== 'none'
  const expectedTableScope = guardGuestCookiePersistence
    ? String(settings.expectedTableScope || tableRequestScope(session))
    : null
  if (!config.apiBaseUrl || !config.storeId) return Promise.reject(new Error('尚未配置 API 地址或门店编号'))
  if (settings.requireTableSession !== false && !session.tableCode) return Promise.reject(new Error('请先扫描桌码进入当前桌次'))
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${config.apiBaseUrl}${path}`,
      method: settings.method || 'GET',
      data: settings.data,
      header: buildHeaders(path, settings.headers, settings),
      timeout: config.requestTimeoutMs,
      success(response) {
        // An anonymous public preview must not turn a server misconfiguration
        // into a newly persisted member or guest session on the device.
        if (settings.credentialDomain !== 'none') {
          const guestCookieScopeMatches = expectedTableScope === null
            || tableRequestScope(getTableSession()) === expectedTableScope
          rememberCookies(response.header, response.cookies, { allowGuest: guestCookieScopeMatches })
        }
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

function storeWechatIdentityToken(token) {
  if (typeof token !== 'string' || token.length < 32 || token.includes(' ')) {
    throw new Error('微信身份会话格式无效')
  }
  wx.setStorageSync(WECHAT_TOKEN_KEY, token)
}

function clearWechatIdentityToken() {
  wx.removeStorageSync(WECHAT_TOKEN_KEY)
  wx.removeStorageSync(RESERVATION_COOKIE_KEY)
}

function clearReservationCookie() {
  wx.removeStorageSync(RESERVATION_COOKIE_KEY)
  wx.removeStorageSync(LEGACY_COOKIE_KEY)
}

module.exports = { request, deviceKey, storeWechatIdentityToken, clearWechatIdentityToken, clearReservationCookie }
