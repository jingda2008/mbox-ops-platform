const runtime = require('./platform')
const { getRuntimeConfig } = require('../config/index')
const { getTableSession, clearTableConnection } = require('./session')
const { tableRequestScope } = require('./table-request-scope')

const LEGACY_COOKIE_KEY = 'mbox.http.cookie.v1'
const RESERVATION_COOKIE_NAME = 'mbox_reservation_session'
const GUEST_COOKIE_NAME = '__Host-mbox_guest_session'
const RESERVATION_COOKIE_KEY = 'mbox.http.cookie.reservation.v2'
const GUEST_COOKIE_KEY = 'mbox.http.cookie.guest.v2'
const RESERVATION_SESSION_HEADER = 'x-mbox-reservation-session'
const GUEST_SESSION_HEADER = 'x-mbox-guest-session'
const DEVICE_KEY = 'mbox.device.key.v1'

const COOKIE_STORAGE_KEYS = Object.freeze({
  [RESERVATION_COOKIE_NAME]: RESERVATION_COOKIE_KEY,
  [GUEST_COOKIE_NAME]: GUEST_COOKIE_KEY,
})

function deviceKey() {
  let value = runtime.getStorageSync(DEVICE_KEY)
  if (typeof value === 'string' && value.length >= 8) return value
  value = `mini-${Date.now()}-${Math.random().toString(36).slice(2, 14)}`
  runtime.setStorageSync(DEVICE_KEY, value)
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
  const legacy = runtime.getStorageSync(LEGACY_COOKIE_KEY)
  if (!legacy) return
  const parsed = parseCookiePair(legacy)
  if (parsed) runtime.setStorageSync(COOKIE_STORAGE_KEYS[parsed.name], parsed.pair)
  runtime.removeStorageSync(LEGACY_COOKIE_KEY)
}

function storedCookie(name) {
  migrateLegacyCookie()
  const value = runtime.getStorageSync(COOKIE_STORAGE_KEYS[name])
  const parsed = parseCookiePair(value)
  return parsed && parsed.name === name ? parsed.pair : ''
}

function storedCookieValue(name) {
  const parsed = parseCookiePair(storedCookie(name))
  return parsed ? parsed.value : ''
}

function rememberSessionToken(name, token) {
  if (typeof token !== 'string') return false
  const value = token.trim()
  if (!Object.prototype.hasOwnProperty.call(COOKIE_STORAGE_KEYS, name)) return false
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(value)) return false
  runtime.setStorageSync(COOKIE_STORAGE_KEYS[name], `${name}=${value}`)
  return true
}

function rememberSessionTokenFromBody(path, body, options) {
  const data = body && body.data && typeof body.data === 'object' ? body.data : body
  const token = data && typeof data.sessionToken === 'string' ? data.sessionToken.trim() : ''
  if (!token) return
  const normalized = String(path || '').split('?', 1)[0]
  if (normalized === '/api/public/reservation/session') {
    rememberSessionToken(RESERVATION_COOKIE_NAME, token)
    return
  }
  if (normalized === '/api/guest/session/scan' || normalized === '/api/guest/session') {
    if (options && options.allowGuest === false) return
    rememberSessionToken(GUEST_COOKIE_NAME, token)
  }
}

function omitEmptyHeaders(headers) {
  Object.keys(headers).forEach((key) => {
    if (headers[key] === '' || headers[key] == null) delete headers[key]
  })
  return headers
}

function parseAlipayFailBody(error) {
  const data = error && error.data
  if (data && typeof data === 'object') return data
  if (typeof data === 'string' && data.trim()) {
    try { return JSON.parse(data) } catch (_error) { return {} }
  }
  return {}
}

function networkFailureMessage(error) {
  const raw = String((error && (error.errorMessage || error.errMsg || error.error || error.message)) || '')
  if (/url not in domain|不在以下.*合法域名|域名名单|not in domain list/i.test(raw)) {
    return '请求域名未放行。请在开放平台「服务器域名白名单」加入 https://mbox.shmbox.com 后重新编译；不要加到 H5。'
  }
  if (/timeout|超时|timed out/i.test(raw)) {
    return '请求超时。请检查手机网络后重试。'
  }
  return '网络暂时不可用，请检查网络后重试'
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
    accept: 'application/json',
    'x-mbox-store-id': config.storeId,
    ...(anonymous ? {} : {
      'x-mbox-guest-device': deviceKey(),
      'x-mbox-table-code': session.tableCode || '',
    }),
  }, extraHeaders || {})
  if (settings.data !== undefined && settings.data !== null) {
    headers['content-type'] = 'application/json'
  }
  removeHeader(headers, 'cookie')
  if (requestedDomain && !['none', 'reservation+guest'].includes(requestedDomain)) {
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
  const reservationToken = storedCookieValue(RESERVATION_COOKIE_NAME)
  const guestToken = storedCookieValue(GUEST_COOKIE_NAME)
  if ((domain === 'reservation' || domain === 'reservation+guest') && reservationToken) {
    headers[RESERVATION_SESSION_HEADER] = reservationToken
  }
  if ((domain === 'guest' || domain === 'reservation+guest') && guestToken) {
    headers[GUEST_SESSION_HEADER] = guestToken
  }
  // 支付宝真机设置 Cookie 头常直接失败成「网络错误」。现网已接受 Bearer。
  const hasAuthorization = Object.keys(headers).some((key) => key.toLowerCase() === 'authorization')
  if (!hasAuthorization) {
    if (domain === 'reservation' && reservationToken) headers.authorization = `Bearer ${reservationToken}`
    else if (domain === 'guest' && guestToken) headers.authorization = `Bearer ${guestToken}`
  }
  return omitEmptyHeaders(headers)
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
    if (cookieWasCleared(setCookieValue, parsed)) runtime.removeStorageSync(storageKey)
    else runtime.setStorageSync(storageKey, parsed.pair)
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
    const requestHeaders = buildHeaders(path, settings.headers, settings)
    runtime.request({
      url: `${config.apiBaseUrl}${path}`,
      method: settings.method || 'GET',
      data: settings.data,
      header: requestHeaders,
      timeout: config.requestTimeoutMs,
      success(response) {
        const body = response.data || {}
        // An anonymous public preview must not turn a server misconfiguration
        // into a newly persisted member or guest session on the device.
        if (settings.credentialDomain !== 'none') {
          const guestCookieScopeMatches = expectedTableScope === null
            || tableRequestScope(getTableSession()) === expectedTableScope
          rememberCookies(response.header, response.cookies, { allowGuest: guestCookieScopeMatches })
          if (response.statusCode >= 200 && response.statusCode < 300) {
            rememberSessionTokenFromBody(path, body, { allowGuest: guestCookieScopeMatches })
          }
        }
        if (response.statusCode >= 200 && response.statusCode < 300) return resolve(body)
        const detail = body.error || body
        const error = new Error(detail.message || `请求失败（${response.statusCode}）`)
        error.code = detail.code || 'HTTP_ERROR'
        error.statusCode = response.statusCode
        // A rejected guest call is the first reliable evidence that this
        // device's table credential has ended. Do not leave a stale local
        // table binding to keep polling carts and service tasks as 5xx/401.
        // Scope-check first so an old A response can never clear a newer B.
        if (requestCredentialDomain(path) === 'guest'
          && ['GUEST_SESSION_INVALID', 'TABLE_SESSION_ENDED'].includes(error.code)
          && expectedTableScope !== null
          && tableRequestScope(getTableSession()) === expectedTableScope) {
          clearTableConnection()
        }
        reject(error)
      },
      fail(error) {
        const statusCode = Number((error && (error.status || error.statusCode)) || 0)
        const httpError = /http status error/i.test(String((error && (error.errorMessage || error.errMsg || error.message)) || ''))
          || Number(error && error.error) === 19
        if (httpError) {
          const body = parseAlipayFailBody(error)
          const detail = body.error || body
          const requestError = new Error(detail.message || `请求失败（${statusCode || 'http'}）`)
          requestError.code = detail.code || 'HTTP_ERROR'
          requestError.statusCode = statusCode
          reject(requestError)
          return
        }
        const requestError = new Error(networkFailureMessage(error))
        requestError.code = 'NETWORK_ERROR'
        reject(requestError)
      },
    })
  })
}

function clearReservationCookie() {
  runtime.removeStorageSync(RESERVATION_COOKIE_KEY)
  runtime.removeStorageSync(LEGACY_COOKIE_KEY)
}

export { request, deviceKey, clearReservationCookie }
