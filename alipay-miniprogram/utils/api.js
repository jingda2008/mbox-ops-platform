const runtime = require('./platform')
const { request, deviceKey } = require('./request')
const { randomId } = require('./id')
const { getTableSession, rememberTableConnection, clearTableConnection } = require('./session')
const { tableRequestScope } = require('./table-request-scope')
const {
  ensureCustomerSession, clearCustomerSession, renewReservationSessionOnly,
  isCustomerSessionInvalid, isAlipayIdentityUnavailable,
} = require('./auth')
const { checkoutRecommendationAttribution } = require('./recommendation-attribution')

async function loadGuestSession() {
  const session = getTableSession()
  const expectedTableScope = tableRequestScope(session)
  const isCurrentScope = () => tableRequestScope(getTableSession()) === expectedTableScope
  const scopeChanged = () => {
    const error = new Error('桌台已经切换，已忽略上一桌的连接结果')
    error.code = 'TABLE_SESSION_SCOPE_CHANGED'
    error.statusCode = 409
    return error
  }
  const requestOptions = { expectedTableScope, guardCookiePersistence: true }
  const rememberedConnection = runtime.getStorageSync('mbox.table.connection.state') || {}
  const needsScan = Boolean(session.tableToken) && (
    runtime.getStorageSync('mbox.connected.table.token') !== session.tableToken
    || String(rememberedConnection.scanNonce || '') !== String(session.scanNonce || '')
    || !session.cartScope
  )
  if (needsScan) {
    // Until the shared backend has an Alipay identity adapter, table entry is
    // deliberately guest-only. The table and reservation sessions remain
    // isolated and no identity bearer is fabricated on the client.
    await ensureCustomerSession(false).catch(() => undefined)
    const connected = await request('/api/guest/session/scan', {
      method: 'POST',
      requireTableSession: false,
      data: { tableQrToken: session.tableToken, deviceKey: deviceKey() },
      ...requestOptions,
    })
    if (!isCurrentScope()) throw scopeChanged()
    const data = connected.data
    rememberTableConnection(data)
    if (data && (data.status === 'active' || data.status === 'already_active')) {
      runtime.setStorageSync('mbox.connected.table.token', session.tableToken)
    } else {
      runtime.removeStorageSync('mbox.connected.table.token')
    }
    return data
  }
  try {
    const response = await request('/api/guest/session', { requireTableSession: false, ...requestOptions })
    if (!isCurrentScope()) throw scopeChanged()
    rememberTableConnection(response.data)
    return response.data
  } catch (error) {
    if (!isCurrentScope()) throw scopeChanged()
    if (error && (error.statusCode === 401 || error.code === 'GUEST_SESSION_INVALID' || error.code === 'TABLE_SESSION_ENDED')) {
      clearTableConnection()
    }
    throw error
  }
}

async function getGuestSession() { return { data: await loadGuestSession(), source: 'api', warning: '' } }

async function publicRequest(path, options) {
  await ensureCustomerSession(false)
  try {
    return await request(path, Object.assign({ requireTableSession: false }, options || {}))
  } catch (error) {
    if (!isCustomerSessionInvalid(error)) throw error
    // 只续预约会话 cookie，避免把桌台会话与预约会话混在一起。
    renewReservationSessionOnly()
    await ensureCustomerSession(true)
    try {
      return await request(path, Object.assign({ requireTableSession: false }, options || {}))
    } catch (retryError) {
      if (isAlipayIdentityUnavailable(retryError) || /请求的页面或接口不存在/.test(String(retryError && retryError.message || ''))) {
        const friendly = new Error('会员服务暂时连不上，请稍后重试；若刚授权手机号，可再试一次找回会员')
        friendly.code = 'MEMBERSHIP_SERVICE_UNAVAILABLE'
        friendly.statusCode = retryError && retryError.statusCode
        throw friendly
      }
      throw retryError
    }
  }
}

async function getMiniBootstrap() { return (await publicRequest('/api/public/mini/bootstrap')).data }
async function getPrivacyPolicy() { return (await publicRequest('/api/public/mini/privacy-policy')).data }
async function getMiniLoyalty() { return (await publicRequest('/api/public/mini/loyalty')).data }
async function getMiniLoyaltyLedger() { return (await publicRequest('/api/public/mini/loyalty/ledger')).data }
async function recordBirthdayBenefitConsent(birthdayMonthDay) {
  return (await publicRequest('/api/public/mini/annual-benefits/birthday-consent', {
    method: 'PUT', headers: { 'idempotency-key': randomId('birthday-benefit-consent') }, data: { birthdayMonthDay },
  })).data
}
async function withdrawBirthdayBenefitConsent(reason) {
  return (await publicRequest('/api/public/mini/annual-benefits/birthday-consent/withdraw', {
    method: 'POST', headers: { 'idempotency-key': randomId('birthday-benefit-consent-withdraw') },
    data: { reason: reason || '顾客本人撤回生日礼遇授权' },
  })).data
}
async function getNotificationConsent() { return (await publicRequest('/api/public/mini/notification-consent')).data }
async function recordNotificationConsent(input) {
  return (await publicRequest('/api/public/mini/notification-consent', {
    method: 'POST', headers: { 'idempotency-key': randomId('notification-consent') }, data: input,
  })).data
}
async function getAlipayNotificationAuthorizations() {
  return { available: false, authorizations: [] }
}
async function recordAlipayNotificationAuthorization() {
  return { available: false, recorded: false }
}
async function getAlipayMemberServiceNotificationAuthorizations() {
  return { available: false, authorizations: [] }
}
async function getAlipayNotificationPrompt() {
  return { available: false, authorizations: [], presentation: [] }
}
async function recordAlipayMemberServiceNotificationAuthorization() {
  return { available: false, recorded: false }
}
async function getProductRestrictions() {
  return (await publicRequest('/api/public/mini/product-restrictions')).data
}
async function withdrawProductRestriction(publicId, reason) {
  return (await publicRequest(`/api/public/mini/product-restrictions/${encodeURIComponent(publicId)}/withdraw`, {
    method: 'POST', headers: { 'idempotency-key': randomId(`product-restriction-withdraw-${publicId}`) },
    data: { reason: reason || '顾客本人撤回长期商品限制' },
  })).data
}
async function getCustomerPreferenceFacts() {
  return (await publicRequest('/api/public/mini/preferences')).data
}
async function declareCustomerPreference(input) {
  const payload = {
    key: input.key,
    value: String(input.value || '').trim(),
    polarity: input.polarity,
    ...(input.validUntil ? { validUntil: input.validUntil } : {}),
  }
  const storageKey = 'mbox.customer.preference.declare.v1'
  const stored = runtime.getStorageSync(storageKey)
  const samePayload = stored && typeof stored === 'object'
    && JSON.stringify(stored.payload) === JSON.stringify(payload)
    && typeof stored.idempotencyKey === 'string' && stored.idempotencyKey.length >= 8
  const attempt = samePayload ? stored : {
    payload, idempotencyKey: randomId('customer-preference-declare'),
  }
  runtime.setStorageSync(storageKey, attempt)
  try {
    const result = (await publicRequest('/api/public/mini/preferences', {
      method: 'POST', headers: { 'idempotency-key': attempt.idempotencyKey }, data: payload,
    })).data
    runtime.removeStorageSync(storageKey)
    return result
  } catch (error) {
    if (error && error.code !== 'NETWORK_ERROR') runtime.removeStorageSync(storageKey)
    throw error
  }
}
async function withdrawCustomerPreferenceSource(publicId, reason) {
  const payload = { reason: reason || '顾客本人在我的页面撤回偏好依据' }
  const storageKey = `mbox.customer.preference.withdraw.${publicId}`
  const stored = runtime.getStorageSync(storageKey)
  const samePayload = stored && typeof stored === 'object'
    && stored.reason === payload.reason
    && typeof stored.idempotencyKey === 'string' && stored.idempotencyKey.length >= 8
  const attempt = samePayload ? stored : {
    reason: payload.reason, idempotencyKey: randomId(`customer-preference-withdraw-${publicId}`),
  }
  runtime.setStorageSync(storageKey, attempt)
  try {
    const result = (await publicRequest(`/api/public/mini/preferences/${encodeURIComponent(publicId)}/withdraw`, {
      method: 'POST', headers: { 'idempotency-key': attempt.idempotencyKey }, data: payload,
    })).data
    runtime.removeStorageSync(storageKey)
    return result
  } catch (error) {
    if (error && error.code !== 'NETWORK_ERROR') runtime.removeStorageSync(storageKey)
    throw error
  }
}
async function getRedemptionCatalog() { return (await publicRequest('/api/public/mini/redemptions/catalog')).data }
async function getRedemptions() { return (await publicRequest('/api/public/mini/redemptions')).data }
async function createRedemption(catalogItemPublicId) {
  const storageKey = `mbox.redemption.attempt.${catalogItemPublicId}`
  const idempotencyKey = runtime.getStorageSync(storageKey) || randomId(`redemption-${catalogItemPublicId}`)
  runtime.setStorageSync(storageKey, idempotencyKey)
  try {
    const result = (await publicRequest('/api/public/mini/redemptions', {
      method: 'POST', credentialDomain: 'reservation+guest',
      headers: { 'idempotency-key': idempotencyKey }, data: { catalogItemPublicId },
    })).data
    runtime.removeStorageSync(storageKey)
    return result
  } catch (error) {
    if (error && error.code !== 'NETWORK_ERROR') runtime.removeStorageSync(storageKey)
    throw error
  }
}
async function cancelRedemption(redemptionPublicId, reason) {
  const storageKey = `mbox.redemption.cancel.${redemptionPublicId}`
  const idempotencyKey = runtime.getStorageSync(storageKey) || randomId(`redemption-cancel-${redemptionPublicId}`)
  runtime.setStorageSync(storageKey, idempotencyKey)
  try {
    const result = (await publicRequest(`/api/public/mini/redemptions/${encodeURIComponent(redemptionPublicId)}/cancel`, {
      method: 'POST', headers: { 'idempotency-key': idempotencyKey }, data: { reason },
    })).data
    runtime.removeStorageSync(storageKey)
    return result
  } catch (error) {
    if (error && error.code !== 'NETWORK_ERROR') runtime.removeStorageSync(storageKey)
    throw error
  }
}
async function getActivities() { return (await publicRequest('/api/public/mini/activities')).data }
async function getActivity(activityPublicId) {
  return (await publicRequest(`/api/public/mini/activities/${encodeURIComponent(activityPublicId)}`)).data
}
// A share recipient may not be a member yet.  This route is intentionally a
// narrower public preview, not the member detail or a registration lookup.
// Do not call publicRequest: a shared preview must not first create or refresh
// a customer session just to read public activity copy.
async function getActivityPreview(activityPublicId) {
  return (await request(`/api/public/mini/activity-previews/${encodeURIComponent(activityPublicId)}`, {
    requireTableSession: false,
    credentialDomain: 'none',
  })).data
}
async function getActivityLoyaltyBenefits(activityPublicId) {
  return (await publicRequest(`/api/public/community-activities/${encodeURIComponent(activityPublicId)}/loyalty-benefits`)).data
}
async function getActivityRegistrations() {
  return (await publicRequest('/api/public/mini/activity-registrations')).data
}
async function updateActivityRegistrationContact(registrationPublicId, contactValue) {
  const payload = { contactType: 'phone', contactValue: String(contactValue || '').trim() }
  const storageKey = `mbox.activity.contact.update.${registrationPublicId}`
  const stored = runtime.getStorageSync(storageKey)
  const attempt = stored && typeof stored === 'object' && stored.contactValue === payload.contactValue
    && typeof stored.idempotencyKey === 'string' && stored.idempotencyKey.length >= 8
    ? stored : { contactValue: payload.contactValue, idempotencyKey: randomId(`activity-contact-${registrationPublicId}`) }
  runtime.setStorageSync(storageKey, attempt)
  try {
    const result = (await publicRequest(`/api/public/mini/activity-registrations/${encodeURIComponent(registrationPublicId)}/contact`, {
      method: 'PUT', headers: { 'idempotency-key': attempt.idempotencyKey }, data: payload,
    })).data
    runtime.removeStorageSync(storageKey)
    return result
  } catch (error) {
    if (error && error.code !== 'NETWORK_ERROR') runtime.removeStorageSync(storageKey)
    throw error
  }
}
async function getVerifiedPhones() {
  const data = (await publicRequest('/api/public/mini/membership/verified-phones')).data
  if (!Array.isArray(data)) throw new Error('已验证手机号响应格式无效')
  return data.map((item) => {
    if (!item || typeof item !== 'object'
      || typeof item.publicId !== 'string' || !/^CVC[0-9A-F]{32}$/.test(item.publicId)
      || typeof item.maskedPhone !== 'string' || item.maskedPhone.length < 7
      || item.status !== 'active'
      || typeof item.verifiedAt !== 'string'
      || !['wechat_phone_authorization', 'staff_controlled'].includes(item.verificationSource)) {
      throw new Error('已验证手机号响应格式无效')
    }
    return {
      publicId: item.publicId,
      maskedPhone: item.maskedPhone,
      status: item.status,
      verifiedAt: item.verifiedAt,
      verificationSource: item.verificationSource,
    }
  })
}
async function replaceVerifiedPhone(phoneAuthorizationCode) {
  const storageKey = 'mbox.verified.phone.replace.v1'
  const stored = runtime.getStorageSync(storageKey)
  const attempt = stored && typeof stored === 'object' && stored.phoneAuthorizationCode === phoneAuthorizationCode
    && typeof stored.idempotencyKey === 'string' && stored.idempotencyKey.length >= 8
    ? stored : { phoneAuthorizationCode, idempotencyKey: randomId('verified-phone-replace') }
  runtime.setStorageSync(storageKey, attempt)
  try {
    const result = (await publicRequest('/api/public/mini/membership/verified-phones/replace', {
      method: 'POST', headers: { 'idempotency-key': attempt.idempotencyKey },
      data: { phoneAuthorizationCode: attempt.phoneAuthorizationCode },
    })).data
    runtime.removeStorageSync(storageKey)
    return result
  } catch (error) {
    if (error && error.code !== 'NETWORK_ERROR') runtime.removeStorageSync(storageKey)
    throw error
  }
}
async function revokeVerifiedPhone(contactPublicId) {
  const storageKey = `mbox.verified.phone.revoke.${contactPublicId}`
  const idempotencyKey = runtime.getStorageSync(storageKey) || randomId(`verified-phone-revoke-${contactPublicId}`)
  runtime.setStorageSync(storageKey, idempotencyKey)
  try {
    const result = (await publicRequest(`/api/public/mini/membership/verified-phones/${encodeURIComponent(contactPublicId)}/revoke`, {
      method: 'POST', headers: { 'idempotency-key': idempotencyKey }, data: {},
    })).data
    runtime.removeStorageSync(storageKey)
    return result
  } catch (error) {
    if (error && error.code !== 'NETWORK_ERROR') runtime.removeStorageSync(storageKey)
    throw error
  }
}
async function enrollMembership(termsVersion, acknowledgementSource, phoneAuthorizationCode) {
  const storageKey = 'mbox.membership.enroll.attempt.v1'
  const payload = { termsVersion: Number(termsVersion), acknowledgementSource, phoneAuthorizationCode }
  const stored = runtime.getStorageSync(storageKey)
  const attempt = stored && typeof stored === 'object'
    && stored.termsVersion === payload.termsVersion
    && stored.acknowledgementSource === payload.acknowledgementSource
    && stored.phoneAuthorizationCode === payload.phoneAuthorizationCode
    && typeof stored.idempotencyKey === 'string' && stored.idempotencyKey.length >= 8
    ? stored : Object.assign({}, payload, { idempotencyKey: randomId('membership-enroll') })
  runtime.setStorageSync(storageKey, attempt)
  try {
    const result = (await publicRequest('/api/public/mini/membership/enroll-with-phone', {
      method: 'POST', headers: { 'idempotency-key': attempt.idempotencyKey }, data: payload,
    })).data
    runtime.removeStorageSync(storageKey)
    return result
  } catch (error) {
    if (error && error.code !== 'NETWORK_ERROR') runtime.removeStorageSync(storageKey)
    throw error
  }
}

const MEMBERSHIP_RECOVERY_ATTEMPT_KEY = 'mbox.membership.recovery.attempt.v1'

function membershipRecoveryAttempt() {
  const stored = runtime.getStorageSync(MEMBERSHIP_RECOVERY_ATTEMPT_KEY)
  if (stored && typeof stored === 'object'
    && typeof stored.startKey === 'string' && stored.startKey.length >= 8
    && typeof stored.verifyKey === 'string' && stored.verifyKey.length >= 8) return stored
  const created = {
    startKey: randomId('membership-recovery-start'),
    verifyKey: randomId('membership-recovery-verify'),
  }
  runtime.setStorageSync(MEMBERSHIP_RECOVERY_ATTEMPT_KEY, created)
  return created
}

async function startMembershipRecovery(idempotencyKey) {
  const attempt = membershipRecoveryAttempt()
  const requestKey = idempotencyKey || attempt.startKey
  try {
    const result = (await publicRequest('/api/public/mini/membership/recovery/start', {
      method: 'POST', headers: { 'idempotency-key': requestKey }, data: {},
    })).data
    if (!idempotencyKey) runtime.setStorageSync(MEMBERSHIP_RECOVERY_ATTEMPT_KEY, Object.assign({}, attempt, {
      startKey: requestKey, challengePublicId: result.challengePublicId,
    }))
    return result
  } catch (error) {
    if (!idempotencyKey && error && error.code !== 'NETWORK_ERROR') {
      runtime.removeStorageSync(MEMBERSHIP_RECOVERY_ATTEMPT_KEY)
    }
    throw error
  }
}
async function verifyMembershipRecovery(challengePublicId, phoneAuthorizationCode, idempotencyKey) {
  const attempt = membershipRecoveryAttempt()
  const requestKey = idempotencyKey || attempt.verifyKey
  try {
    const result = (await publicRequest('/api/public/mini/membership/recovery/verify', {
      method: 'POST', headers: { 'idempotency-key': requestKey },
      data: { challengePublicId, phoneAuthorizationCode },
    })).data
    if (!idempotencyKey) runtime.removeStorageSync(MEMBERSHIP_RECOVERY_ATTEMPT_KEY)
    return result
  } catch (error) {
    if (!idempotencyKey && error && error.code !== 'NETWORK_ERROR') {
      runtime.removeStorageSync(MEMBERSHIP_RECOVERY_ATTEMPT_KEY)
    }
    throw error
  }
}
async function updatePreferences(preferences, displayName) {
  return (await publicRequest('/api/public/mini/preferences', {
    method: 'PATCH', headers: { 'idempotency-key': randomId('member-preferences') },
    data: { preferences, displayName: displayName || null },
  })).data
}
async function registerActivity(
  activityPublicId,
  activityPackagePublicId,
  partySize,
  contactSnapshot,
  termsAcknowledged,
  acknowledgedSafetyPolicyVersion,
  acknowledgedRefundPolicyVersion,
  paymentChoice,
  paymentMethod,
  idempotencyKey,
) {
  return (await publicRequest(`/api/public/mini/activities/${encodeURIComponent(activityPublicId)}/registrations`, {
    method: 'POST', headers: { 'idempotency-key': idempotencyKey || randomId('activity-register') },
    data: Object.assign(
      {
        activityPackagePublicId: activityPackagePublicId || null,
        partySize,
        contactSnapshot,
        termsAcknowledged,
        acknowledgedSafetyPolicyVersion,
        acknowledgedRefundPolicyVersion,
        paymentChoice: paymentChoice || 'none',
      },
      paymentMethod ? { paymentMethod } : {},
    ),
  })).data
}
async function getActivityRegistrationPayment(registrationPublicId) {
  return (await publicRequest(`/api/public/mini/activity-registrations/${encodeURIComponent(registrationPublicId)}/payment`)).data
}
async function startActivityRegistrationPayment(registrationPublicId, idempotencyKey) {
  return (await publicRequest(`/api/public/mini/activity-registrations/${encodeURIComponent(registrationPublicId)}/payment-action`, {
    method: 'POST', headers: { 'idempotency-key': idempotencyKey || randomId(`activity-payment-${registrationPublicId}`) }, data: {},
  })).data
}
async function queryActivityRegistrationPayment(registrationPublicId, idempotencyKey) {
  return (await publicRequest(`/api/public/mini/activity-registrations/${encodeURIComponent(registrationPublicId)}/payment-query`, {
    method: 'POST', headers: { 'idempotency-key': idempotencyKey || randomId(`activity-payment-query-${registrationPublicId}`) }, data: {},
  })).data
}

async function getReservations() {
  await ensureCustomerSession(false)
  try {
    const response = await publicRequest('/api/public/reservations/mine')
    return response.data || response
  } catch (error) {
    if (!error || error.statusCode !== 404) throw error
  }
  const ids = runtime.getStorageSync('mbox.reservation.public.ids') || []
  const records = await Promise.all(ids.slice(0, 20).map(async (id) => {
    try { return (await publicRequest(`/api/public/reservations/${encodeURIComponent(id)}`)).data } catch (_error) { return null }
  }))
  return { reservations: records.filter(Boolean) }
}

async function getReservationPerformances(date) {
  return (await publicRequest(`/api/public/reservation/performances?date=${encodeURIComponent(date)}`)).data
}

async function getReservationAvailability(arrivalAt, guestCount) {
  return (await publicRequest(`/api/public/reservation/availability?arrivalAt=${encodeURIComponent(arrivalAt)}&guestCount=${encodeURIComponent(guestCount)}`)).data
}

async function createCustomerReservation(input) {
  const response = await publicRequest('/api/public/reservations', {
    method: 'POST', headers: { 'idempotency-key': randomId('reservation') },
    data: {
      mode: 'direct', customerName: input.customerName, contact: input.contact,
      guestCount: input.partySize, arrivalAt: input.scheduledAt,
      seatPreference: input.seatPreference || 'no_preference', note: input.note || null,
      reservationPolicyVersion: input.reservationPolicyVersion,
      preferredScheduleId: input.preferredScheduleId || null,
    },
  })
  const data = response.data
  const ids = runtime.getStorageSync('mbox.reservation.public.ids') || []
  if (data && data.publicId) runtime.setStorageSync('mbox.reservation.public.ids', [data.publicId].concat(ids.filter((id) => id !== data.publicId)).slice(0, 20))
  return data
}

async function cancelCustomerReservation(publicId, idempotencyKey) {
  return (await publicRequest(`/api/public/reservations/${encodeURIComponent(publicId)}`, {
    method: 'DELETE',
    data: {},
    headers: { 'idempotency-key': idempotencyKey || randomId(`reservation-cancel-${publicId}`) },
  })).data
}

async function getReservationPerformanceImpacts() {
  return (await publicRequest('/api/public/reservation/performance-impacts')).data
}

async function acknowledgeReservationPerformanceImpact(impactPublicId, decision, selectedScheduleId, idempotencyKey) {
  return (await publicRequest(
    `/api/public/reservation/performance-impacts/${encodeURIComponent(impactPublicId)}/acknowledgements`,
    {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey || randomId(`reservation-performance-${decision}`) },
      data: { decision, selectedScheduleId: selectedScheduleId || null },
    },
  )).data
}

async function getReservationPerformanceNotificationAuthorizations() {
  return { available: false, authorizations: [] }
}

async function recordReservationPerformanceNotificationAuthorization() {
  return { available: false, recorded: false }
}

const MENU_PAGE_SIZE = 100
// The API currently accepts offsets up to 10,000.  An extra full page at that
// boundary is treated as incomplete instead of being silently truncated.
const MENU_MAX_PAGES = 101
const MENU_RETRY_DELAYS_MS = [200, 600]

function menuCatalogError(code, message, details) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, details || {})
  return error
}

function assertMenuTableScope(expectedTableScope) {
  if (tableRequestScope(getTableSession()) === expectedTableScope) return
  throw menuCatalogError('TABLE_SESSION_SCOPE_CHANGED', '桌台已经切换，已停止加载上一桌的菜单', {
    statusCode: 409,
  })
}

function menuPagePath(basePath, query, offset) {
  const params = []
  if (query && query.categoryCode) params.push(`categoryCode=${encodeURIComponent(query.categoryCode)}`)
  if (query && query.search) params.push(`search=${encodeURIComponent(query.search)}`)
  params.push(`limit=${MENU_PAGE_SIZE}`)
  params.push(`offset=${offset}`)
  return `${basePath}?${params.join('&')}`
}

function retryableMenuPageError(error) {
  const statusCode = Number(error && error.statusCode)
  return Boolean(error && error.code === 'NETWORK_ERROR')
    || statusCode === 408
    || statusCode === 425
    || statusCode === 429
    || statusCode >= 500
}

function waitForMenuRetry(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

async function requestMenuPage(fetchPage, path, expectedTableScope, offset) {
  let lastError = null
  for (let attempt = 0; attempt <= MENU_RETRY_DELAYS_MS.length; attempt += 1) {
    assertMenuTableScope(expectedTableScope)
    try {
      const response = await fetchPage(path, expectedTableScope)
      assertMenuTableScope(expectedTableScope)
      return response
    } catch (error) {
      if (error && error.code === 'TABLE_SESSION_SCOPE_CHANGED') throw error
      lastError = error
      if (!retryableMenuPageError(error) || attempt >= MENU_RETRY_DELAYS_MS.length) break
      await waitForMenuRetry(MENU_RETRY_DELAYS_MS[attempt])
    }
  }
  throw menuCatalogError('MENU_CATALOG_INCOMPLETE', '菜单没有完整加载，请检查网络后重试', {
    statusCode: lastError && lastError.statusCode,
    causeCode: lastError && lastError.code,
    failedOffset: offset,
  })
}

function menuPageItems(response, offset) {
  if (!response || !Array.isArray(response.data)) {
    throw menuCatalogError('MENU_CATALOG_RESPONSE_INVALID', '菜单数据格式异常，请稍后重试', {
      failedOffset: offset,
    })
  }
  return response.data
}

async function loadCompleteMenu(basePath, query, fetchPage) {
  const expectedTableScope = tableRequestScope(getTableSession())
  const productsById = new Map()
  let offset = 0
  let reportedTotalCount = null
  let catalogRevision = null

  for (let pageNumber = 0; pageNumber < MENU_MAX_PAGES; pageNumber += 1) {
    const path = menuPagePath(basePath, query, offset)
    let response
    try {
      response = await requestMenuPage(fetchPage, path, expectedTableScope, offset)
    } catch (error) {
      if (error && typeof error === 'object') error.partialCount = productsById.size
      throw error
    }
    const items = menuPageItems(response, offset)
    for (const item of items) {
      const productId = String(item && (item.productId || item.id) || '').trim()
      if (!productId) {
        throw menuCatalogError('MENU_CATALOG_RESPONSE_INVALID', '菜单商品缺少有效编号，请稍后重试', {
          failedOffset: offset,
          partialCount: productsById.size,
        })
      }
      if (!productsById.has(productId)) productsById.set(productId, item)
    }

    const meta = response.meta && typeof response.meta === 'object' ? response.meta : {}
    if (meta.totalCount !== undefined && meta.totalCount !== null) {
      const totalCount = Number(meta.totalCount)
      if (!Number.isInteger(totalCount) || totalCount < 0
        || (reportedTotalCount !== null && reportedTotalCount !== totalCount)) {
        throw menuCatalogError('MENU_CATALOG_RESPONSE_INVALID', '菜单总数信息不一致，请稍后重试', {
          failedOffset: offset,
          partialCount: productsById.size,
        })
      }
      reportedTotalCount = totalCount
    }
    if (meta.catalogRevision !== undefined && meta.catalogRevision !== null) {
      const revision = String(meta.catalogRevision).trim()
      if (!revision || (catalogRevision !== null && catalogRevision !== revision)) {
        throw menuCatalogError('MENU_CATALOG_CHANGED', '菜单正在更新，请稍后重新加载', {
          failedOffset: offset,
          partialCount: productsById.size,
        })
      }
      catalogRevision = revision
    }

    if (reportedTotalCount !== null && productsById.size === reportedTotalCount) {
      return Array.from(productsById.values())
    }

    const hasExplicitNextOffset = Object.prototype.hasOwnProperty.call(meta, 'nextOffset')
    if (hasExplicitNextOffset && meta.nextOffset === null) {
      if (reportedTotalCount !== null && productsById.size !== reportedTotalCount) {
        throw menuCatalogError('MENU_CATALOG_INCOMPLETE', '菜单数量不完整，请稍后重新加载', {
          failedOffset: offset,
          partialCount: productsById.size,
          expectedCount: reportedTotalCount,
        })
      }
      return Array.from(productsById.values())
    }
    if (hasExplicitNextOffset) {
      const nextOffset = Number(meta.nextOffset)
      if (!Number.isInteger(nextOffset) || nextOffset <= offset || nextOffset > 10000) {
        throw menuCatalogError('MENU_CATALOG_RESPONSE_INVALID', '菜单分页信息异常，请稍后重试', {
          failedOffset: offset,
          partialCount: productsById.size,
        })
      }
      offset = nextOffset
      continue
    }
    if (items.length < MENU_PAGE_SIZE) {
      if (reportedTotalCount !== null && productsById.size !== reportedTotalCount) {
        throw menuCatalogError('MENU_CATALOG_INCOMPLETE', '菜单数量不完整，请稍后重新加载', {
          failedOffset: offset,
          partialCount: productsById.size,
          expectedCount: reportedTotalCount,
        })
      }
      return Array.from(productsById.values())
    }
    offset += MENU_PAGE_SIZE
  }

  throw menuCatalogError('MENU_CATALOG_INCOMPLETE', '菜单商品超过当前安全加载范围，请联系门店处理', {
    failedOffset: offset,
    partialCount: productsById.size,
  })
}

async function getMenu(query) {
  return loadCompleteMenu('/api/guest/menu/products', query, (path, expectedTableScope) => (
    request(path, { expectedTableScope, guardCookiePersistence: true })
  ))
}
async function getPublicMenu(query) {
  return loadCompleteMenu('/api/public/mini/menu/products', query, (path, expectedTableScope) => (
    publicRequest(path, { expectedTableScope, guardCookiePersistence: true })
  ))
}
async function recommendExperience(input) {
  return (await request('/api/guest/experience/recommendations', {
    method: 'POST', headers: { 'idempotency-key': randomId('experience-recommend') }, data: input,
  })).data
}
async function getRecommendationConfiguration() {
  return (await request('/api/guest/experience/recommendations/configuration')).data
}
async function recordRecommendationEvent(recommendationPublicId, eventType, productId, evidence, reasonCode) {
  return (await request(`/api/guest/experience/recommendations/${encodeURIComponent(recommendationPublicId)}/events`, {
    method: 'POST', headers: { 'idempotency-key': randomId(`experience-${eventType}-${recommendationPublicId}`) },
    data: { eventType, productId: productId || null, reasonCode: reasonCode || null, evidence: evidence || {} },
  })).data
}
async function prepareCheckoutUpgrade(items, occasion, alcoholPreference) {
  return (await request('/api/guest/checkout/upgrade-offers', {
    method: 'POST', headers: { 'idempotency-key': randomId('checkout-upgrade-offer') },
    data: { items, occasion, alcoholPreference },
  })).data
}
async function recordCheckoutUpgradeEvent(publicId, eventType, reasonCode) {
  return (await request(`/api/guest/checkout/upgrade-offers/${encodeURIComponent(publicId)}/events`, {
    method: 'POST',
    headers: { 'idempotency-key': randomId(`checkout-upgrade-${eventType}-${publicId}`) },
    data: { eventType, reasonCode: reasonCode || null },
  })).data
}
async function checkout(items, checkoutUpgradeOfferPublicId, idempotencyKey, recommendationAttribution) {
  const attribution = checkoutRecommendationAttribution(
    checkoutUpgradeOfferPublicId,
    recommendationAttribution,
  )
  return request('/api/guest/orders', {
    method: 'POST', headers: { 'idempotency-key': idempotencyKey || randomId('guest-order') },
    data: {
      items,
      checkoutUpgradeOfferPublicId: checkoutUpgradeOfferPublicId || null,
      ...(attribution ? {
        recommendationPublicId: attribution.recommendationPublicId,
        selectedRecommendationProductId: attribution.selectedProductId,
      } : {}),
    },
  })
}
async function getSharedCart() { return (await request('/api/guest/shared-cart')).data }
async function adjustSharedCart(productId, delta, expectedGeneration, expectedVersion, idempotencyKey) {
  return (await request('/api/guest/shared-cart/lines', {
    method: 'POST', headers: { 'idempotency-key': idempotencyKey || randomId('shared-cart-adjust') },
    data: { productId, delta, expectedGeneration, expectedVersion },
  })).data
}
async function removeSharedCartLine(productId, expectedGeneration, expectedVersion, idempotencyKey) {
  return (await request(`/api/guest/shared-cart/lines/${encodeURIComponent(productId)}`, {
    method: 'DELETE', headers: { 'idempotency-key': idempotencyKey || randomId('shared-cart-remove') },
    data: { expectedGeneration, expectedVersion },
  })).data
}
async function clearSharedCart(expectedGeneration, expectedVersion, idempotencyKey) {
  return (await request('/api/guest/shared-cart/clear', {
    method: 'POST', headers: { 'idempotency-key': idempotencyKey || randomId('shared-cart-clear') },
    data: { expectedGeneration, expectedVersion },
  })).data
}
async function checkoutSharedCart(input, idempotencyKey) {
  const attribution = checkoutRecommendationAttribution(
    input.checkoutUpgradeOfferPublicId,
    input.recommendationAttribution,
  )
  return request('/api/guest/shared-cart/checkout', {
    method: 'POST', headers: { 'idempotency-key': idempotencyKey || randomId('shared-cart-checkout') },
    data: {
      expectedGeneration: input.expectedGeneration,
      expectedVersion: input.expectedVersion,
      confirmedDuplicateOrderId: input.confirmedDuplicateOrderId || null,
      checkoutUpgradeOfferPublicId: input.checkoutUpgradeOfferPublicId || null,
      ...(attribution ? {
        recommendationPublicId: attribution.recommendationPublicId,
        selectedRecommendationProductId: attribution.selectedProductId,
      } : {}),
    },
  })
}
async function getTableOrders() { return (await request('/api/guest/orders/table')).data }
async function retryOrderPayment(orderPublicId, idempotencyKey) {
  return (await request(`/api/guest/orders/${encodeURIComponent(orderPublicId)}/payment`, {
    method: 'POST', headers: { 'idempotency-key': idempotencyKey || randomId(`guest-payment-${orderPublicId}`) }, data: {},
  })).data
}
async function abandonGuestCheckout(orderPublicId, idempotencyKey) {
  return (await request(`/api/guest/orders/${encodeURIComponent(orderPublicId)}/abandon-checkout`, {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey || randomId(`guest-checkout-abandon-${orderPublicId}`) },
    data: {},
  })).data
}
async function createServiceTask(input) {
  return request('/api/guest/service-requests', {
    method: 'POST', headers: { 'idempotency-key': randomId('guest-service') },
    data: {
      requestType: input.requestType || 'custom',
      detail: input.detail || null,
      relatedOrderPublicId: input.relatedOrderPublicId || null,
    },
  })
}
async function getServiceRequests() {
  return (await request('/api/guest/service-requests')).data
}
async function actOnServiceTask(taskPublicId, action) {
  return (await request(`/api/guest/service-requests/${encodeURIComponent(taskPublicId)}/feedback`, {
    method: 'POST', headers: { 'idempotency-key': randomId(`guest-service-feedback-${taskPublicId}-${action}`) },
    data: { action },
  })).data
}
async function getCustomerBenefits() {
  return (await publicRequest('/api/public/mini/customer/benefits')).data
}
async function getCustomerProfile() {
  return (await publicRequest('/api/public/mini/customer/profile')).data
}
async function reserveCustomerBenefit(benefitId, quantity) {
  return (await request(`/api/guest/customer/benefits/${encodeURIComponent(benefitId)}/reservations`, {
    method: 'POST', headers: { 'idempotency-key': randomId(`guest-benefit-${benefitId}`) }, data: { quantity: quantity || 1 },
  })).data
}
async function claimAnnualDailySnack() {
  return (await request('/api/guest/customer/annual-daily-snacks/claim', {
    method: 'POST', headers: { 'idempotency-key': randomId('annual-daily-snack') }, data: {},
  })).data
}
async function cancelActivityRegistration(registrationPublicId, reason, idempotencyKey) {
  return (await publicRequest(`/api/public/mini/activity-registrations/${encodeURIComponent(registrationPublicId)}/cancel`, {
    method: 'POST', headers: { 'idempotency-key': idempotencyKey || randomId(`activity-cancel-${registrationPublicId}`) },
    data: { reason },
  })).data
}
async function submitSongRequest(input) {
  return request('/api/guest/song-requests', {
    method: 'POST', headers: { 'idempotency-key': randomId('song-submit') }, data: input,
  })
}
async function getTodayPerformances() {
  return getReservationPerformances(shanghaiDate())
}

function shanghaiDate() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

async function logoutAlipayIdentity() {
  clearCustomerSession()
  return { loggedOut: true, provider: 'anonymous' }
}

export {
  getGuestSession, getMiniBootstrap, getPrivacyPolicy, getMiniLoyalty, getMiniLoyaltyLedger,
  recordBirthdayBenefitConsent, withdrawBirthdayBenefitConsent,
  getNotificationConsent, recordNotificationConsent,
  getAlipayNotificationAuthorizations, recordAlipayNotificationAuthorization,
  getAlipayMemberServiceNotificationAuthorizations, recordAlipayMemberServiceNotificationAuthorization,
  getAlipayNotificationPrompt,
  getProductRestrictions, withdrawProductRestriction,
  getCustomerPreferenceFacts, declareCustomerPreference, withdrawCustomerPreferenceSource,
  getRedemptionCatalog, getRedemptions, createRedemption, cancelRedemption,
  getActivities, getActivity, getActivityPreview, getActivityLoyaltyBenefits, getActivityRegistrations,
  updateActivityRegistrationContact, getVerifiedPhones, replaceVerifiedPhone, revokeVerifiedPhone,
  enrollMembership,
  startMembershipRecovery, verifyMembershipRecovery, updatePreferences,
  registerActivity, getActivityRegistrationPayment, startActivityRegistrationPayment,
  queryActivityRegistrationPayment, cancelActivityRegistration,
  getReservations, getReservationAvailability, getReservationPerformances, createCustomerReservation,
  cancelCustomerReservation,
  getReservationPerformanceImpacts, acknowledgeReservationPerformanceImpact,
  getReservationPerformanceNotificationAuthorizations,
  recordReservationPerformanceNotificationAuthorization,
  getMenu, getPublicMenu, recommendExperience, getRecommendationConfiguration, recordRecommendationEvent, prepareCheckoutUpgrade, recordCheckoutUpgradeEvent,
  checkout, getSharedCart, adjustSharedCart, removeSharedCartLine, clearSharedCart, checkoutSharedCart, getTableOrders, retryOrderPayment, abandonGuestCheckout,
  createServiceTask, getServiceRequests, actOnServiceTask,
  getCustomerBenefits, getCustomerProfile, reserveCustomerBenefit, claimAnnualDailySnack, submitSongRequest, getTodayPerformances,
  logoutAlipayIdentity,
}
