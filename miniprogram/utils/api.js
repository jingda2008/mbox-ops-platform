const { request, deviceKey } = require('./request')
const { randomId } = require('./id')
const { getTableSession, rememberTableConnection, clearTableConnection } = require('./session')
const { ensureCustomerSession, renewReservationSessionOnly, isCustomerSessionInvalid, isWechatIdentityUnavailable } = require('./auth')
const { checkoutRecommendationAttribution } = require('./recommendation-attribution')

async function loadGuestSession() {
  const session = getTableSession()
  if (session.tableToken && wx.getStorageSync('mbox.connected.table.token') !== session.tableToken) {
    const connected = await request('/api/guest/session/scan', {
      method: 'POST',
      requireTableSession: false,
      data: { tableQrToken: session.tableToken, deviceKey: deviceKey() },
    })
    const data = connected.data
    rememberTableConnection(data)
    if (data && (data.status === 'active' || data.status === 'already_active')) {
      wx.setStorageSync('mbox.connected.table.token', session.tableToken)
    } else {
      wx.removeStorageSync('mbox.connected.table.token')
    }
    return data
  }
  try {
    const response = await request('/api/guest/session', { requireTableSession: false })
    rememberTableConnection(response.data)
    return response.data
  } catch (error) {
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
    // 只续预约会话 cookie，不清除微信身份，避免现网微信身份接口缺失时把会员冲成访客。
    renewReservationSessionOnly()
    await ensureCustomerSession(true)
    try {
      return await request(path, Object.assign({ requireTableSession: false }, options || {}))
    } catch (retryError) {
      if (isWechatIdentityUnavailable(retryError) || /请求的页面或接口不存在/.test(String(retryError && retryError.message || ''))) {
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
async function getWechatNotificationAuthorizations() {
  return (await publicRequest('/api/public/mini/wechat-notification-authorizations')).data
}
async function recordWechatNotificationAuthorization(input) {
  const storageKey = `mbox.wechat.notification.authorization.${input.notificationType}.${input.policyId}`
  const stored = wx.getStorageSync(storageKey)
  const samePayload = stored && typeof stored === 'object'
    && stored.policyId === input.policyId
    && stored.policyVersion === input.policyVersion
    && stored.templateId === input.templateId
    && stored.expectedVersion === input.expectedVersion
    && stored.platformResult === input.platformResult
  const attempt = samePayload ? stored : Object.assign({}, input, {
    platformEventReference: input.platformEventReference || randomId(`wx-subscribe-${input.notificationType}`),
    idempotencyKey: randomId(`wechat-notification-${input.notificationType}`),
  })
  wx.setStorageSync(storageKey, attempt)
  try {
    const result = (await publicRequest('/api/public/mini/wechat-notification-authorizations', {
      method: 'POST', headers: { 'idempotency-key': attempt.idempotencyKey }, data: {
        notificationType: attempt.notificationType,
        policyId: attempt.policyId,
        policyVersion: attempt.policyVersion,
        templateId: attempt.templateId,
        expectedVersion: attempt.expectedVersion,
        platformResult: attempt.platformResult,
        platformEventReference: attempt.platformEventReference,
      },
    })).data
    wx.removeStorageSync(storageKey)
    return result
  } catch (error) {
    if (error && error.code !== 'NETWORK_ERROR') wx.removeStorageSync(storageKey)
    throw error
  }
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
  const stored = wx.getStorageSync(storageKey)
  const samePayload = stored && typeof stored === 'object'
    && JSON.stringify(stored.payload) === JSON.stringify(payload)
    && typeof stored.idempotencyKey === 'string' && stored.idempotencyKey.length >= 8
  const attempt = samePayload ? stored : {
    payload, idempotencyKey: randomId('customer-preference-declare'),
  }
  wx.setStorageSync(storageKey, attempt)
  try {
    const result = (await publicRequest('/api/public/mini/preferences', {
      method: 'POST', headers: { 'idempotency-key': attempt.idempotencyKey }, data: payload,
    })).data
    wx.removeStorageSync(storageKey)
    return result
  } catch (error) {
    if (error && error.code !== 'NETWORK_ERROR') wx.removeStorageSync(storageKey)
    throw error
  }
}
async function withdrawCustomerPreferenceSource(publicId, reason) {
  const payload = { reason: reason || '顾客本人在我的页面撤回偏好依据' }
  const storageKey = `mbox.customer.preference.withdraw.${publicId}`
  const stored = wx.getStorageSync(storageKey)
  const samePayload = stored && typeof stored === 'object'
    && stored.reason === payload.reason
    && typeof stored.idempotencyKey === 'string' && stored.idempotencyKey.length >= 8
  const attempt = samePayload ? stored : {
    reason: payload.reason, idempotencyKey: randomId(`customer-preference-withdraw-${publicId}`),
  }
  wx.setStorageSync(storageKey, attempt)
  try {
    const result = (await publicRequest(`/api/public/mini/preferences/${encodeURIComponent(publicId)}/withdraw`, {
      method: 'POST', headers: { 'idempotency-key': attempt.idempotencyKey }, data: payload,
    })).data
    wx.removeStorageSync(storageKey)
    return result
  } catch (error) {
    if (error && error.code !== 'NETWORK_ERROR') wx.removeStorageSync(storageKey)
    throw error
  }
}
async function getRedemptionCatalog() { return (await publicRequest('/api/public/mini/redemptions/catalog')).data }
async function getRedemptions() { return (await publicRequest('/api/public/mini/redemptions')).data }
async function createRedemption(catalogItemPublicId) {
  const storageKey = `mbox.redemption.attempt.${catalogItemPublicId}`
  const idempotencyKey = wx.getStorageSync(storageKey) || randomId(`redemption-${catalogItemPublicId}`)
  wx.setStorageSync(storageKey, idempotencyKey)
  try {
    const result = (await publicRequest('/api/public/mini/redemptions', {
      method: 'POST', credentialDomain: 'reservation+guest',
      headers: { 'idempotency-key': idempotencyKey }, data: { catalogItemPublicId },
    })).data
    wx.removeStorageSync(storageKey)
    return result
  } catch (error) {
    if (error && error.code !== 'NETWORK_ERROR') wx.removeStorageSync(storageKey)
    throw error
  }
}
async function cancelRedemption(redemptionPublicId, reason) {
  const storageKey = `mbox.redemption.cancel.${redemptionPublicId}`
  const idempotencyKey = wx.getStorageSync(storageKey) || randomId(`redemption-cancel-${redemptionPublicId}`)
  wx.setStorageSync(storageKey, idempotencyKey)
  try {
    const result = (await publicRequest(`/api/public/mini/redemptions/${encodeURIComponent(redemptionPublicId)}/cancel`, {
      method: 'POST', headers: { 'idempotency-key': idempotencyKey }, data: { reason },
    })).data
    wx.removeStorageSync(storageKey)
    return result
  } catch (error) {
    if (error && error.code !== 'NETWORK_ERROR') wx.removeStorageSync(storageKey)
    throw error
  }
}
async function getActivities() { return (await publicRequest('/api/public/mini/activities')).data }
async function getActivity(activityPublicId) {
  return (await publicRequest(`/api/public/mini/activities/${encodeURIComponent(activityPublicId)}`)).data
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
  const stored = wx.getStorageSync(storageKey)
  const attempt = stored && typeof stored === 'object' && stored.contactValue === payload.contactValue
    && typeof stored.idempotencyKey === 'string' && stored.idempotencyKey.length >= 8
    ? stored : { contactValue: payload.contactValue, idempotencyKey: randomId(`activity-contact-${registrationPublicId}`) }
  wx.setStorageSync(storageKey, attempt)
  try {
    const result = (await publicRequest(`/api/public/mini/activity-registrations/${encodeURIComponent(registrationPublicId)}/contact`, {
      method: 'PUT', headers: { 'idempotency-key': attempt.idempotencyKey }, data: payload,
    })).data
    wx.removeStorageSync(storageKey)
    return result
  } catch (error) {
    if (error && error.code !== 'NETWORK_ERROR') wx.removeStorageSync(storageKey)
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
  const stored = wx.getStorageSync(storageKey)
  const attempt = stored && typeof stored === 'object' && stored.phoneAuthorizationCode === phoneAuthorizationCode
    && typeof stored.idempotencyKey === 'string' && stored.idempotencyKey.length >= 8
    ? stored : { phoneAuthorizationCode, idempotencyKey: randomId('verified-phone-replace') }
  wx.setStorageSync(storageKey, attempt)
  try {
    const result = (await publicRequest('/api/public/mini/membership/verified-phones/replace', {
      method: 'POST', headers: { 'idempotency-key': attempt.idempotencyKey },
      data: { phoneAuthorizationCode: attempt.phoneAuthorizationCode },
    })).data
    wx.removeStorageSync(storageKey)
    return result
  } catch (error) {
    if (error && error.code !== 'NETWORK_ERROR') wx.removeStorageSync(storageKey)
    throw error
  }
}
async function revokeVerifiedPhone(contactPublicId) {
  const storageKey = `mbox.verified.phone.revoke.${contactPublicId}`
  const idempotencyKey = wx.getStorageSync(storageKey) || randomId(`verified-phone-revoke-${contactPublicId}`)
  wx.setStorageSync(storageKey, idempotencyKey)
  try {
    const result = (await publicRequest(`/api/public/mini/membership/verified-phones/${encodeURIComponent(contactPublicId)}/revoke`, {
      method: 'POST', headers: { 'idempotency-key': idempotencyKey }, data: {},
    })).data
    wx.removeStorageSync(storageKey)
    return result
  } catch (error) {
    if (error && error.code !== 'NETWORK_ERROR') wx.removeStorageSync(storageKey)
    throw error
  }
}
async function enrollMembership(termsVersion, acknowledgementSource, phoneAuthorizationCode) {
  const storageKey = 'mbox.membership.enroll.attempt.v1'
  const payload = { termsVersion: Number(termsVersion), acknowledgementSource, phoneAuthorizationCode }
  const stored = wx.getStorageSync(storageKey)
  const attempt = stored && typeof stored === 'object'
    && stored.termsVersion === payload.termsVersion
    && stored.acknowledgementSource === payload.acknowledgementSource
    && stored.phoneAuthorizationCode === payload.phoneAuthorizationCode
    && typeof stored.idempotencyKey === 'string' && stored.idempotencyKey.length >= 8
    ? stored : Object.assign({}, payload, { idempotencyKey: randomId('membership-enroll') })
  wx.setStorageSync(storageKey, attempt)
  try {
    const result = (await publicRequest('/api/public/mini/membership/enroll-with-phone', {
      method: 'POST', headers: { 'idempotency-key': attempt.idempotencyKey }, data: payload,
    })).data
    wx.removeStorageSync(storageKey)
    return result
  } catch (error) {
    if (error && error.code !== 'NETWORK_ERROR') wx.removeStorageSync(storageKey)
    throw error
  }
}

const MEMBERSHIP_RECOVERY_ATTEMPT_KEY = 'mbox.membership.recovery.attempt.v1'

function membershipRecoveryAttempt() {
  const stored = wx.getStorageSync(MEMBERSHIP_RECOVERY_ATTEMPT_KEY)
  if (stored && typeof stored === 'object'
    && typeof stored.startKey === 'string' && stored.startKey.length >= 8
    && typeof stored.verifyKey === 'string' && stored.verifyKey.length >= 8) return stored
  const created = {
    startKey: randomId('membership-recovery-start'),
    verifyKey: randomId('membership-recovery-verify'),
  }
  wx.setStorageSync(MEMBERSHIP_RECOVERY_ATTEMPT_KEY, created)
  return created
}

async function startMembershipRecovery(idempotencyKey) {
  const attempt = membershipRecoveryAttempt()
  const requestKey = idempotencyKey || attempt.startKey
  try {
    const result = (await publicRequest('/api/public/mini/membership/recovery/start', {
      method: 'POST', headers: { 'idempotency-key': requestKey }, data: {},
    })).data
    if (!idempotencyKey) wx.setStorageSync(MEMBERSHIP_RECOVERY_ATTEMPT_KEY, Object.assign({}, attempt, {
      startKey: requestKey, challengePublicId: result.challengePublicId,
    }))
    return result
  } catch (error) {
    if (!idempotencyKey && error && error.code !== 'NETWORK_ERROR') {
      wx.removeStorageSync(MEMBERSHIP_RECOVERY_ATTEMPT_KEY)
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
    if (!idempotencyKey) wx.removeStorageSync(MEMBERSHIP_RECOVERY_ATTEMPT_KEY)
    return result
  } catch (error) {
    if (!idempotencyKey && error && error.code !== 'NETWORK_ERROR') {
      wx.removeStorageSync(MEMBERSHIP_RECOVERY_ATTEMPT_KEY)
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
  const ids = wx.getStorageSync('mbox.reservation.public.ids') || []
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
  const ids = wx.getStorageSync('mbox.reservation.public.ids') || []
  if (data && data.publicId) wx.setStorageSync('mbox.reservation.public.ids', [data.publicId].concat(ids.filter((id) => id !== data.publicId)).slice(0, 20))
  return data
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
  return (await publicRequest('/api/public/reservation/performance-notification-authorizations')).data
}

async function recordReservationPerformanceNotificationAuthorization(input) {
  const storageKey = `mbox.reservation.performance.notification.${input.reservationPublicId}.${input.policyId}`
  const stored = wx.getStorageSync(storageKey)
  const samePayload = stored && typeof stored === 'object'
    && stored.reservationPublicId === input.reservationPublicId
    && stored.policyId === input.policyId
    && stored.policyVersion === input.policyVersion
    && stored.templateId === input.templateId
    && stored.expectedVersion === input.expectedVersion
    && stored.platformResult === input.platformResult
  const attempt = samePayload ? stored : Object.assign({}, input, {
    platformEventReference: input.platformEventReference || randomId('wx-subscribe-reservation-performance'),
    idempotencyKey: randomId('reservation-performance-notification'),
  })
  wx.setStorageSync(storageKey, attempt)
  try {
    const result = (await publicRequest('/api/public/reservation/performance-notification-authorizations', {
      method: 'POST', headers: { 'idempotency-key': attempt.idempotencyKey }, data: {
        reservationPublicId: attempt.reservationPublicId,
        policyId: attempt.policyId,
        policyVersion: attempt.policyVersion,
        templateId: attempt.templateId,
        expectedVersion: attempt.expectedVersion,
        platformResult: attempt.platformResult,
        platformEventReference: attempt.platformEventReference,
      },
    })).data
    wx.removeStorageSync(storageKey)
    return result
  } catch (error) {
    if (error && error.code !== 'NETWORK_ERROR') wx.removeStorageSync(storageKey)
    throw error
  }
}

async function getMenu(query) {
  const params = []
  if (query && query.categoryCode) params.push(`categoryCode=${encodeURIComponent(query.categoryCode)}`)
  if (query && query.search) params.push(`search=${encodeURIComponent(query.search)}`)
  params.push('limit=100')
  return (await request(`/api/guest/menu/products?${params.join('&')}`)).data
}
async function getPublicMenu(query) {
  const params = []
  if (query && query.categoryCode) params.push(`categoryCode=${encodeURIComponent(query.categoryCode)}`)
  if (query && query.search) params.push(`search=${encodeURIComponent(query.search)}`)
  params.push('limit=100')
  return (await publicRequest(`/api/public/mini/menu/products?${params.join('&')}`)).data
}
async function recommendExperience(input) {
  return (await request('/api/guest/experience/recommendations', {
    method: 'POST', headers: { 'idempotency-key': randomId('experience-recommend') }, data: input,
  })).data
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

async function logoutWechatIdentity() {
  const storageKey = 'mbox.wechat.logout.attempt.v1'
  const stored = wx.getStorageSync(storageKey)
  const attempt = stored && typeof stored === 'object'
    && typeof stored.idempotencyKey === 'string' && stored.idempotencyKey.length >= 8
    ? stored : { idempotencyKey: randomId('wechat-logout') }
  wx.setStorageSync(storageKey, attempt)
  try {
    const result = await request('/api/wechat/logout', {
      method: 'POST',
      requireTableSession: false,
      credentialDomain: 'wechat_identity',
      headers: { 'idempotency-key': attempt.idempotencyKey },
      data: { idempotencyKey: attempt.idempotencyKey },
    })
    wx.removeStorageSync(storageKey)
    return result
  } catch (error) {
    if (error && error.code !== 'NETWORK_ERROR') wx.removeStorageSync(storageKey)
    throw error
  }
}

module.exports = {
  getGuestSession, getMiniBootstrap, getPrivacyPolicy, getMiniLoyalty, getMiniLoyaltyLedger,
  recordBirthdayBenefitConsent, withdrawBirthdayBenefitConsent,
  getNotificationConsent, recordNotificationConsent,
  getWechatNotificationAuthorizations, recordWechatNotificationAuthorization,
  getProductRestrictions, withdrawProductRestriction,
  getCustomerPreferenceFacts, declareCustomerPreference, withdrawCustomerPreferenceSource,
  getRedemptionCatalog, getRedemptions, createRedemption, cancelRedemption,
  getActivities, getActivity, getActivityLoyaltyBenefits, getActivityRegistrations,
  updateActivityRegistrationContact, getVerifiedPhones, replaceVerifiedPhone, revokeVerifiedPhone,
  enrollMembership,
  startMembershipRecovery, verifyMembershipRecovery, updatePreferences,
  registerActivity, getActivityRegistrationPayment, startActivityRegistrationPayment,
  queryActivityRegistrationPayment, cancelActivityRegistration,
  getReservations, getReservationAvailability, getReservationPerformances, createCustomerReservation,
  getReservationPerformanceImpacts, acknowledgeReservationPerformanceImpact,
  getReservationPerformanceNotificationAuthorizations,
  recordReservationPerformanceNotificationAuthorization,
  getMenu, getPublicMenu, recommendExperience, recordRecommendationEvent, prepareCheckoutUpgrade, recordCheckoutUpgradeEvent,
  checkout, getSharedCart, adjustSharedCart, removeSharedCartLine, clearSharedCart, checkoutSharedCart, getTableOrders, retryOrderPayment,
  createServiceTask, getServiceRequests, actOnServiceTask,
  getCustomerBenefits, getCustomerProfile, reserveCustomerBenefit, claimAnnualDailySnack, submitSongRequest, getTodayPerformances,
  logoutWechatIdentity,
}
