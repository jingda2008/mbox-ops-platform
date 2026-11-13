const { request, deviceKey } = require('./request')
const { randomId } = require('./id')
const { recoverableGuestCommand } = require('./recoverable-command')
const { getTableSession, rememberTableConnection, clearTableConnection } = require('./session')
const { tableRequestScope } = require('./table-request-scope')
const { ensureCustomerSession, ensureWechatIdentity, renewReservationSessionOnly, isCustomerSessionInvalid, isWechatIdentityUnavailable, clearMembershipLoggedOut, obtainWechatIdentityForMembership } = require('./auth')
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
  const rememberedConnection = wx.getStorageSync('mbox.table.connection.state') || {}
  const needsScan = Boolean(session.tableToken) && (
    wx.getStorageSync('mbox.connected.table.token') !== session.tableToken
    || String(rememberedConnection.scanNonce || '') !== String(session.scanNonce || '')
    || !session.cartScope
  )
  if (needsScan) {
    if (rememberedConnection.status === 'waiting_for_table'
      && String(rememberedConnection.scanNonce || '') === String(session.scanNonce || '')) {
      const waiting = await request('/api/guest/session/wait', {
        method: 'POST', requireTableSession: false,
        data: { tableQrToken: session.tableToken, deviceKey: deviceKey() }, ...requestOptions,
      })
      if (!isCurrentScope()) throw scopeChanged()
      if (waiting.data && waiting.data.status === 'waiting_for_table') {
        rememberTableConnection(waiting.data)
        return waiting.data
      }
      if (!waiting.data || waiting.data.status !== 'ready_for_scan') throw new Error('桌台状态暂未确认，请稍后重试')
    }
    // Keep the normal customer identity and table session distinct.  The scan
    // route receives the identity bearer only to bind this new table session
    // to the canonical WeChat customer for JSAPI; all later guest calls use
    // the HttpOnly guest credential alone.
    await ensureWechatIdentity(false).catch(() => undefined)
    let connected
    try { connected = await request('/api/guest/session/scan', {
      method: 'POST',
      requireTableSession: false,
      credentialDomain: 'guest+wechat_identity',
      data: { tableQrToken: session.tableToken, deviceKey: deviceKey() },
      ...requestOptions,
    }) } catch(error) {
      if(!isCurrentScope())throw scopeChanged()
      if(error&&error.code==='TABLE_QR_INVALID')error.message='桌台同步未成功，请重新扫描有效桌码；核验前不能向原桌下单。'
      throw error
    }
    if (!isCurrentScope()) throw scopeChanged()
    const data = connected.data
    rememberTableConnection(data)
    if (data && (data.status === 'active' || data.status === 'already_active')) {
      wx.setStorageSync('mbox.connected.table.token', session.tableToken)
      wx.removeStorageSync('mbox.table.scan.previous')
    } else {
      wx.removeStorageSync('mbox.connected.table.token')
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

let guestSessionPending = null
async function getGuestSession() {
  const scope = tableRequestScope(getTableSession())
  if (guestSessionPending && guestSessionPending.scope === scope) return guestSessionPending.promise
  const pending = { scope, promise: null }
  pending.promise = loadGuestSession().then(data => ({ data, source: 'api', warning: '' })).finally(() => {
    if (guestSessionPending === pending) guestSessionPending = null
  })
  guestSessionPending = pending
  return pending.promise
}

function publicIdentityScope() {
  const principal = wx.getStorageSync('mbox.wechat.identity.principal.v1') || {}
  return JSON.stringify([principal.principalId || principal.memberId || null,
    wx.getStorageSync('mbox.public.identity.assertion') || null, wx.getStorageSync('mbox.membership.loggedOut.v1') || null])
}
async function ensureBoundCustomerSession() {
  const before = publicIdentityScope()
  const bound = wx.getStorageSync('mbox.wechat.identity.principal.v1') || wx.getStorageSync('mbox.public.identity.assertion') || wx.getStorageSync('mbox.membership.loggedOut.v1')
  await ensureCustomerSession(false)
  if (bound && before !== publicIdentityScope()) throw Object.assign(new Error('登录身份已变化，请重新核对当前状态。'), { code: 'COMMAND_RECOVERY_SCOPE_CHANGED' })
}
async function publicRequest(path, options) {
  await ensureBoundCustomerSession()
  const identity = publicIdentityScope()
  const assertIdentity = () => {
    if (identity !== publicIdentityScope()) throw Object.assign(new Error('会员身份已变化，请重新读取当前状态；原请求结果仍需核对。'), { code: 'COMMAND_RECOVERY_SCOPE_CHANGED' })
  }
  try {
    const response = await request(path, Object.assign({ requireTableSession: false }, options || {}))
    assertIdentity()
    return response
  } catch (error) {
    assertIdentity()
    if (!isCustomerSessionInvalid(error)) throw error
    // 只续预约会话 cookie，不清除微信身份，避免现网微信身份接口缺失时把会员冲成访客。
    renewReservationSessionOnly()
    await ensureCustomerSession(true)
    assertIdentity()
    try {
      const response = await request(path, Object.assign({ requireTableSession: false }, options || {}))
      assertIdentity()
      return response
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

async function recoverableMemberWrite(operation, path, method, data, legacyKeys, extra) {
  await ensureBoundCustomerSession()
  return (await recoverableGuestCommand(operation, data, (key, context) => publicRequest(path, {
    ...(extra || {}), method, headers: { ...((extra || {}).headers || {}), 'idempotency-key': key, ...(extra && extra.channelRecovery && context.recovery ? { 'x-channel-recovery': '1' } : {}) }, data,
  }), { customerOnly: true, legacyKeys: legacyKeys || [], initialKey: extra && extra.initialKey, clearOnNotCommitted: Boolean(extra && extra.clearOnNotCommitted) })).data
}

async function getMiniBootstrap() { return (await publicRequest('/api/public/mini/bootstrap')).data }
// Published agreements remain readable when customer login or renewal is unavailable.
async function getPrivacyPolicy() {
  return (await request('/api/public/mini/privacy-policy', { requireTableSession: false, credentialDomain: 'none' })).data
}
async function getMembershipTerms() {
  return (await request('/api/public/mini/membership-terms', { requireTableSession: false, credentialDomain: 'none' })).data
}
async function getMiniLoyalty() { return (await publicRequest('/api/public/mini/loyalty')).data }
async function getMiniLoyaltyLedger() { return (await publicRequest('/api/public/mini/loyalty/ledger')).data }
async function recordBirthdayBenefitConsent(birthdayMonthDay) {
  await ensureBoundCustomerSession()
  return (await recoverableGuestCommand('birthday-benefit-consent', { birthdayMonthDay }, key => publicRequest('/api/public/mini/annual-benefits/birthday-consent', {
    method: 'PUT', headers: { 'idempotency-key': key }, data: { birthdayMonthDay },
  }), { customerOnly: true })).data
}
async function withdrawBirthdayBenefitConsent(reason) {
  const data = { reason: reason || '顾客本人撤回生日礼遇授权' }
  await ensureBoundCustomerSession()
  return (await recoverableGuestCommand('birthday-benefit-consent-withdraw', data, key => publicRequest('/api/public/mini/annual-benefits/birthday-consent/withdraw', {
    method: 'POST', headers: { 'idempotency-key': key }, data,
  }), { customerOnly: true })).data
}
async function getNotificationConsent() { return (await publicRequest('/api/public/mini/notification-consent')).data }
async function recordNotificationConsent(input) {
  await ensureBoundCustomerSession()
  return (await recoverableGuestCommand('notification-consent', input, key => publicRequest('/api/public/mini/notification-consent', {
    method: 'POST', headers: { 'idempotency-key': key }, data: input,
  }), { customerOnly: true })).data
}
async function getOfficialPointsNotifications() { return (await publicRequest('/api/public/mini/official-points-notifications')).data }
async function setOfficialPointsNotifications(input) { return (await publicRequest('/api/public/mini/official-points-notifications', { method: 'POST', data: input })).data }
async function getWechatNotificationAuthorizations() {
  return (await publicRequest('/api/public/mini/wechat-notification-authorizations')).data
}
async function recoverNotificationAuthorization(kind, path, input, legacyKey) {
  await ensureBoundCustomerSession()
  const principal = wx.getStorageSync('mbox.wechat.identity.principal.v1') || {}
  if (!principal.principalId && !principal.memberId) {
    throw Object.assign(new Error('请先确认本人微信身份再操作通知授权'), { code: 'NOTIFICATION_IDENTITY_REQUIRED', statusCode: 401 })
  }
  const legacy = wx.getStorageSync(legacyKey)
  if (legacy && typeof legacy === 'object') {
    throw Object.assign(new Error('有旧版授权请求结果待核对，请先查看授权状态并联系工作人员核实，暂不重复提交'), { code: 'NOTIFICATION_LEGACY_ATTEMPT_REVIEW_REQUIRED', statusCode: 409 })
  }
  return (await recoverableGuestCommand('wechat-authorization:' + kind + ':' + (input.notificationType || input.reservationPublicId) + ':' + input.policyId, input, key => publicRequest(path, {
    method: 'POST', headers: { 'idempotency-key': key },
    data: Object.assign({}, input, { platformEventReference: input.platformEventReference || key }),
  }), { customerOnly: true, legacyKeys: [legacyKey], legacyOperation: 'wechat-authorization:' + kind })).data
}
async function recordWechatNotificationAuthorization(input) {
  return recoverNotificationAuthorization('loyalty', '/api/public/mini/wechat-notification-authorizations', {
    notificationType: input.notificationType,
    policyId: input.policyId, policyVersion: input.policyVersion, templateId: input.templateId,
    expectedVersion: input.expectedVersion, platformResult: input.platformResult,
    ...(input.platformEventReference ? { platformEventReference: input.platformEventReference } : {}),
  }, `mbox.wechat.notification.authorization.${input.notificationType}.${input.policyId}`)
}
async function getWechatMemberServiceNotificationAuthorizations() {
  return (await publicRequest('/api/public/mini/wechat-member-service-notification-authorizations')).data
}
async function getWechatNotificationPrompt(context) {
  const value = String(context || '').trim()
  return (await publicRequest(`/api/public/mini/wechat-notification-prompt?context=${encodeURIComponent(value)}`)).data
}
async function recordWechatMemberServiceNotificationAuthorization(input) {
  return recoverNotificationAuthorization('member-service', '/api/public/mini/wechat-member-service-notification-authorizations', {
    notificationType: input.notificationType,
    policyId: input.policyId, policyVersion: input.policyVersion, templateId: input.templateId,
    expectedVersion: input.expectedVersion, platformResult: input.platformResult,
    ...(input.platformEventReference ? { platformEventReference: input.platformEventReference } : {}),
  }, `mbox.wechat.member-service-notification.authorization.${input.notificationType}.${input.policyId}`)
}
async function getProductRestrictions() {
  return (await publicRequest('/api/public/mini/product-restrictions')).data
}
async function withdrawProductRestriction(publicId, reason) {
  return recoverableMemberWrite('restriction-withdraw:' + publicId, `/api/public/mini/product-restrictions/${encodeURIComponent(publicId)}/withdraw`, 'POST', { reason: reason || '顾客本人撤回长期商品限制' })
}
async function getCustomerPreferenceFacts() {
  return (await publicRequest('/api/public/mini/preferences')).data
}
async function declareCustomerPreference(input) {
  const data = { key: input.key, value: String(input.value || '').trim(), polarity: input.polarity,
    ...(input.validUntil ? { validUntil: input.validUntil } : {}) }
  return recoverableMemberWrite('preference-declare', '/api/public/mini/preferences', 'POST', data, ['mbox.customer.preference.declare.v1'])
}
async function withdrawCustomerPreferenceSource(publicId, reason) {
  return recoverableMemberWrite('preference-withdraw:' + publicId, `/api/public/mini/preferences/${encodeURIComponent(publicId)}/withdraw`, 'POST',
    { reason: reason || '顾客本人在我的页面撤回偏好依据' }, [`mbox.customer.preference.withdraw.${publicId}`])
}
async function getRedemptionCatalog() { return (await publicRequest('/api/public/mini/redemptions/catalog')).data }
async function getRedemptions() { return (await publicRequest('/api/public/mini/redemptions')).data }
async function createRedemption(catalogItemPublicId) {
  await ensureBoundCustomerSession()
  return (await recoverableGuestCommand('redemption-create', { catalogItemPublicId }, key => publicRequest('/api/public/mini/redemptions', {
    method: 'POST', credentialDomain: 'reservation+guest', headers: { 'idempotency-key': key }, data: { catalogItemPublicId },
  }), { legacyKeys: [`mbox.redemption.attempt.${catalogItemPublicId}`] })).data
}
async function cancelRedemption(redemptionPublicId, reason) {
  return recoverableMemberWrite('redemption-cancel:' + redemptionPublicId, `/api/public/mini/redemptions/${encodeURIComponent(redemptionPublicId)}/cancel`, 'POST', { reason }, [`mbox.redemption.cancel.${redemptionPublicId}`])
}
async function getActivities() { return (await publicRequest('/api/public/mini/activities')).data }
async function getActivity(activityPublicId) {
  return (await publicRequest(`/api/public/mini/activities/${encodeURIComponent(activityPublicId)}`)).data
}
// A share recipient may not be a member yet.  This route is intentionally a
// narrower public preview, not the member detail or a registration lookup.
// Do not call publicRequest: a shared preview must not first create or refresh
// a customer/WeChat session just to read public activity copy.
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
  return recoverableMemberWrite('activity-contact:' + registrationPublicId, `/api/public/mini/activity-registrations/${encodeURIComponent(registrationPublicId)}/contact`, 'PUT',
    { contactType: 'phone', contactValue: String(contactValue || '').trim() }, [`mbox.activity.contact.update.${registrationPublicId}`])
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
  return recoverableMemberWrite('phone-replace', '/api/public/mini/membership/verified-phones/replace', 'POST',
    { phoneAuthorizationCode, phoneAuthorizationProvider: 'wechat' }, ['mbox.verified.phone.replace.v1'])
}
async function revokeVerifiedPhone(contactPublicId) {
  return recoverableMemberWrite('phone-revoke:' + contactPublicId, `/api/public/mini/membership/verified-phones/${encodeURIComponent(contactPublicId)}/revoke`, 'POST', {}, [`mbox.verified.phone.revoke.${contactPublicId}`])
}
async function enrollMembership(termsVersion, acknowledgementSource, phoneAuthorizationCode) {
  const token = await obtainWechatIdentityForMembership()
  const result = await recoverableMemberWrite('membership-enroll', '/api/public/mini/membership/enroll-with-phone', 'POST',
    { termsVersion: Number(termsVersion), acknowledgementSource, phoneAuthorizationCode, phoneAuthorizationProvider: 'wechat' },
    ['mbox.membership.enroll.attempt.v1'], { headers: token ? { 'x-mbox-wechat-identity': token } : {} })
  clearMembershipLoggedOut()
  return result
}
async function startMembershipRecovery(idempotencyKey) {
  return recoverableMemberWrite('membership-recovery-start', '/api/public/mini/membership/recovery/start', 'POST', {},
    ['mbox.membership.recovery.attempt.v1'], { initialKey: idempotencyKey })
}
async function verifyMembershipRecovery(challengePublicId, phoneAuthorizationCode, idempotencyKey) {
  const result = await recoverableMemberWrite('membership-recovery-verify', '/api/public/mini/membership/recovery/verify', 'POST',
    { challengePublicId, phoneAuthorizationCode, phoneAuthorizationProvider: 'wechat' },
    ['mbox.membership.recovery.attempt.v1'], { initialKey: idempotencyKey })
  clearMembershipLoggedOut()
  return result
}
async function updatePreferences(preferences, displayName, dietaryConsent) {
  return recoverableMemberWrite('profile-preferences', '/api/public/mini/wechat-preferences', 'PATCH', { preferences, displayName: displayName || null, dietaryConsent })
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
  purchase,
) {
  const data = Object.assign(
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
      purchase && purchase.purchaseKind ? {
        purchaseKind: purchase.purchaseKind,
        parentRegistrationPublicId: purchase.parentRegistrationPublicId || null,
        ...(purchase.parentCredential ? { parentCredential: purchase.parentCredential } : {}),
        ...(purchase.productId ? { productId: purchase.productId, quantity: purchase.quantity || 1 } : {}),
        ...(Array.isArray(purchase.selections) ? { selections: purchase.selections } : {}),
        ...(purchase.note ? { note: purchase.note } : {}),
      } : {},
    )
  return recoverableMemberWrite('activity-register:' + activityPublicId, `/api/public/mini/activities/${encodeURIComponent(activityPublicId)}/registrations`, 'POST', data, [], { initialKey: idempotencyKey })
}
async function updateActivityRegistrationPartySize(registrationPublicId, partySize, idempotencyKey) {
  return (await publicRequest(`/api/public/mini/activity-registrations/${encodeURIComponent(registrationPublicId)}/party-size`, {
    method: 'POST', headers: { 'idempotency-key': idempotencyKey }, data: { partySize },
  })).data
}
async function requestActivityRegistrationRefund(registrationPublicId, reason, idempotencyKey) {
  return (await publicRequest(`/api/public/mini/activity-registrations/${encodeURIComponent(registrationPublicId)}/refund-request`, {
    method: 'POST', headers: { 'idempotency-key': idempotencyKey }, data: { reason },
  })).data
}
async function getActivityRegistrationServiceCode(registrationPublicId) {
  return (await publicRequest(`/api/public/mini/activity-registrations/${encodeURIComponent(registrationPublicId)}/service-code`)).data
}
async function resolveActivityParent(activityPublicId, code) {
  return (await publicRequest('/api/public/mini/activity-parents/resolve', { method: 'POST', data: { activityPublicId, code } })).data
}
async function getActivityAddonProducts(activityPublicId) {
  return (await publicRequest(`/api/public/mini/activities/${encodeURIComponent(activityPublicId)}/addon-products`)).data
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
  await ensureBoundCustomerSession()
  try {
    const response = await publicRequest('/api/public/reservations/mine')
    return response.data || response
  } catch (error) {
    if (!error || error.statusCode !== 404) throw error
  }
  const ids = wx.getStorageSync('mbox.reservation.public.ids') || []
  const records = await Promise.all(ids.slice(0, 20).map(async (id) => {
    try { return (await publicRequest(`/api/public/reservations/${encodeURIComponent(id)}`)).data }
    catch (error) {
      if (error && error.statusCode === 404 && error.code === 'RESERVATION_NOT_FOUND') return null
      throw error
    }
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
  return require('./reservation-submission').createCustomerReservation(input)
}
async function getPendingCustomerReservation() {
  return require('./reservation-submission').getPendingCustomerReservation()
}
async function recoverCustomerReservation() {
  return require('./reservation-submission').recoverCustomerReservation()
}

async function cancelCustomerReservation(publicId, idempotencyKey) {
  return recoverableMemberWrite('reservation-cancel:' + publicId, `/api/public/reservations/${encodeURIComponent(publicId)}`, 'DELETE', {}, [], { initialKey: idempotencyKey })
}
async function getReservationPerformanceImpacts() {
  return (await publicRequest('/api/public/reservation/performance-impacts')).data
}

async function acknowledgeReservationPerformanceImpact(impactPublicId, decision, selectedScheduleId, idempotencyKey) {
  return recoverableMemberWrite('performance-acknowledge:' + impactPublicId,
    `/api/public/reservation/performance-impacts/${encodeURIComponent(impactPublicId)}/acknowledgements`, 'POST',
    { decision, selectedScheduleId: selectedScheduleId || null }, [], { initialKey: idempotencyKey })
}
async function getReservationPerformanceNotificationAuthorizations() {
  return (await publicRequest('/api/public/reservation/performance-notification-authorizations')).data
}

async function recordReservationPerformanceNotificationAuthorization(input) {
  return recoverNotificationAuthorization('reservation', '/api/public/reservation/performance-notification-authorizations', {
    reservationPublicId: input.reservationPublicId,
    policyId: input.policyId, policyVersion: input.policyVersion, templateId: input.templateId,
    expectedVersion: input.expectedVersion, platformResult: input.platformResult,
    ...(input.platformEventReference ? { platformEventReference: input.platformEventReference } : {}),
  }, `mbox.reservation.performance.notification.${input.reservationPublicId}.${input.policyId}`)
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
      if (!Number.isInteger(nextOffset) || nextOffset <= offset || nextOffset > 10_000) {
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
async function addIssuedCouponProduct(productId, issuedCouponBenefitId, expectedGeneration, expectedVersion, bundleSelections) {
  const intent = { productId, issuedCouponBenefitId, bundleSelections: Array.isArray(bundleSelections) ? bundleSelections : [] }
  return (await recoverableGuestCommand('issued-coupon-product', intent, key => request('/api/guest/shared-cart/lines', {
    method: 'POST', headers: { 'idempotency-key': key },
    data: { ...intent, delta: 1, expectedGeneration, expectedVersion },
  }))).data
}
async function adjustSharedCart(productId, delta, expectedGeneration, expectedVersion, idempotencyKey,bundleSelections) {
  return (await request('/api/guest/shared-cart/lines', {
    method: 'POST', headers: { 'idempotency-key': idempotencyKey || randomId('shared-cart-adjust') },
    data: { productId, delta, expectedGeneration, expectedVersion,
      ...(Array.isArray(bundleSelections)&&bundleSelections.length?{ bundleSelections }:{}), },
  })).data
}
async function replaceSharedCartBundleSelection(productId, unitIndex, bundleSelection, expectedGeneration, expectedVersion, idempotencyKey, portionId) {
  return (await request(`/api/guest/shared-cart/lines/${encodeURIComponent(productId)}/bundle-selections/${unitIndex}`, {
    method: 'PUT', headers: { 'idempotency-key': idempotencyKey || randomId('shared-cart-choice') },
    data: { bundleSelection, expectedGeneration, expectedVersion, ...(portionId ? { portionId } : {}) },
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
async function getCheckoutPoints() { return (await request('/api/guest/shared-cart/points')).data }
async function quoteSharedCartPoints(input, idempotencyKey) { return (await request('/api/guest/shared-cart/points-quote', { method: 'POST', headers: { 'idempotency-key': idempotencyKey }, data: input })).data }
async function quoteSharedCartChannel(input) { return (await request('/api/guest/shared-cart/channel-quote', { method: 'POST', data: input })).data }
async function quoteSharedCartCoupons(input, idempotencyKey) {
  return (await request('/api/guest/shared-cart/coupon-quote', { method: 'POST', headers: { 'idempotency-key': idempotencyKey || randomId('coupon-quote') }, data: input })).data
}
async function prepareSharedCartUpgrade(input, idempotencyKey) {
  return (await request('/api/guest/shared-cart/upgrade-opportunity', { method: 'POST', headers: { 'idempotency-key': idempotencyKey }, data: input })).data
}
async function decideSharedCartUpgrade(id, action, variantId) {
  return (await request('/api/guest/shared-cart/upgrade-opportunity/' + encodeURIComponent(id), { method: 'POST', data: { action, ...(variantId ? { variantId } : {}) } })).data
}
async function revokeTablePrepayment(paymentId) {
  return request('/api/guest/table-prepayment/revoke', { method: 'POST', headers: { 'idempotency-key': 'prepay-revoke-' + paymentId }, data: { paymentId } })
}
async function prepayTable(amountMinor, idempotencyKey, expected) {
  return (await request('/api/guest/table-prepayment', { method: 'POST', headers: { 'idempotency-key': idempotencyKey }, data: Object.assign({ amountMinor, sharedTableConsent: 'v1' }, expected || {}) })).data
}
async function queryPrepayment(paymentId) {
  return request('/api/payments/' + encodeURIComponent(paymentId) + '/provider-query', { method: 'POST', headers: { 'idempotency-key': randomId('prepay-query') }, data: {} })
}
async function checkoutSharedCart(input, idempotencyKey) {
  const attribution = checkoutRecommendationAttribution(
    input.checkoutUpgradeOfferPublicId,
    input.recommendationAttribution,
  )
  return request(input.channelOnly ? '/api/guest/shared-cart/channel-settlement' : input.prepayment ? '/api/guest/shared-cart/prepayment-settlement' : input.pointsOnly ? '/api/guest/shared-cart/points-settlement' : '/api/guest/shared-cart/checkout', {
    method: 'POST', headers: { 'idempotency-key': idempotencyKey || randomId('shared-cart-checkout') },
    data: {
      note: input.note || null,
      ...(input.lineNotes && input.lineNotes.length ? { lineNotes: input.lineNotes } : {}),
      expectedGeneration: input.expectedGeneration,
      expectedVersion: input.expectedVersion,
      ...(input.expectedLocationVersion !== undefined ? { expectedLocationVersion: input.expectedLocationVersion, expectedMinimumMinor: input.expectedMinimumMinor } : {}),
      confirmedDuplicateOrderId: input.confirmedDuplicateOrderId || null,
      checkoutUpgradeOfferPublicId: input.checkoutUpgradeOfferPublicId || null,
      ...(input.couponQuoteId ? { couponQuoteId: input.couponQuoteId } : {}),
      ...(attribution ? {
        recommendationPublicId: attribution.recommendationPublicId,
        selectedRecommendationProductId: attribution.selectedProductId,
      } : {}),
    },
  })
}
async function getTableOrders() { return (await request('/api/guest/orders/table')).data }
async function getCustomerOrderHistory(before) { return (await publicRequest('/api/public/mini/customer/orders' + (before ? '?before=' + encodeURIComponent(before) : ''))).data }
async function payTableOrders(orderPublicIds,idempotencyKey) {
  return (await request('/api/guest/orders/payment-batch',{method:'POST',headers:{'idempotency-key':idempotencyKey},data:{orderPublicIds}})).data
}
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
  return recoverableGuestCommand('service', input, (idempotencyKey) => request('/api/guest/service-requests', {
    method: 'POST', headers: { 'idempotency-key': idempotencyKey },
    data: {
      requestType: input.requestType || 'custom',
      detail: input.detail || null,
      relatedOrderPublicId: input.relatedOrderPublicId || null,
    },
  }))
}
async function getServiceRequests() {
  return (await request('/api/guest/service-requests')).data
}
async function actOnServiceTask(taskPublicId, action) {
  return (await recoverableGuestCommand(`feedback:${taskPublicId}`, { action }, (idempotencyKey) => request(`/api/guest/service-requests/${encodeURIComponent(taskPublicId)}/feedback`, {
    method: 'POST', headers: { 'idempotency-key': idempotencyKey },
    data: { action },
  }))).data
}
async function getCustomerBenefits() {
  return (await publicRequest('/api/public/mini/customer/benefits')).data
}

async function getCustomerBenefitWallet(cursor) {
  const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
  return (await publicRequest(`/api/public/mini/customer/benefit-wallet?limit=30${suffix}`)).data
}
async function getChannelWalletPage(options) {
  const input=options||{}, query=['limit=30']
  for(const key of ['cursor','status','code']) if(input[key])query.push(key+'='+encodeURIComponent(input[key]))
  const response=await publicRequest('/api/public/mini/channel/wallet?'+query.join('&'))
  if(!Array.isArray(response.data)||!response.meta||!Object.prototype.hasOwnProperty.call(response.meta,'nextCursor'))throw new Error('券包分页信息缺失，请刷新核对')
  return {items:response.data,nextCursor:response.meta.nextCursor}
}
async function getChannelWallet() { return (await getChannelWalletPage()).items }

async function getChannelOffer(code) { return (await publicRequest('/api/public/mini/channel/offer?code=' + encodeURIComponent(code))).data }

async function claimChannelCoupon(code) {
  return recoverableMemberWrite('channel.claim', '/api/public/mini/channel/claim', 'POST', { code }, [], { initialKey: randomId('channel'), clearOnNotCommitted: true, channelRecovery: true })
}
async function activateChannelCoupon(claimId) {
  await getGuestSession()
  return (await recoverableGuestCommand('channel.activate', { claimId }, (key, context) => request('/api/guest/channel/activate', {
    method: 'POST', headers: { 'idempotency-key': key, ...(context.recovery ? { 'x-channel-recovery': '1' } : {}) }, data: { claimId },
  }), { initialKey: randomId('channel'), clearOnNotCommitted: true, channelRecovery: true })).data
}
async function getCustomerBottles(cursor) {
  return (await publicRequest('/api/public/mini/customer/bottle-custody' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''))).data
}
async function getCustomerBottle(id) {
  return (await publicRequest('/api/public/mini/customer/bottle-custody/' + encodeURIComponent(id))).data
}
async function getCustomerBottlePhoto(id, depositId) {
  return (await publicRequest('/api/public/mini/customer/bottle-custody/' + encodeURIComponent(id) + '/photos/' + encodeURIComponent(depositId))).data
}
async function getCustomerProfile() {
  return (await publicRequest('/api/public/mini/customer/profile')).data
}
async function getMarketingPreferences() {
  return (await publicRequest('/api/public/mini/marketing-preferences')).data
}
async function updateMarketingPreferences(action, data) {
  return recoverableMemberWrite('marketing-preferences:' + action, '/api/public/mini/marketing-preferences/' + action, 'POST', data)
}
async function getMemberGiftJobs(cursor) {
  return (await publicRequest('/api/public/mini/member-gift-jobs' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''))).data
}
async function getMemberCards(cursors) {
  const query = Object.keys(cursors || {}).filter(key => ['projects', 'cards', 'applications'].includes(key) && cursors[key]).map(key => key + '=' + encodeURIComponent(cursors[key])).join('&')
  return (await publicRequest('/api/public/mini/member-cards' + (query ? '?' + query : ''))).data
}
async function submitMemberCardAction(action, id, input) {
  const suffix = action === 'apply' ? '/applications' : action === 'withdraw-application' ? '/applications/' + encodeURIComponent(id) + '/withdraw' : action === 'withdraw-card' ? '/' + encodeURIComponent(id) + '/withdraw' : null
  if (!suffix) throw new Error('不支持的卡片操作')
  const data = input || {}
  return recoverableMemberWrite('member-card:' + action + ':' + (id || ''), '/api/public/mini/member-cards' + suffix, 'POST', data)
}
async function reserveCustomerBenefit(benefitId, quantity) {
  return (await recoverableGuestCommand(`benefit:${benefitId}`, { quantity: quantity || 1 }, (idempotencyKey) => request(`/api/guest/customer/benefits/${encodeURIComponent(benefitId)}/reservations`, {
    method: 'POST', headers: { 'idempotency-key': idempotencyKey }, data: { quantity: quantity || 1 },
  }))).data
}
async function claimAnnualDailySnack() {
  return (await recoverableGuestCommand('annual-daily-snack', {}, key => request('/api/guest/customer/annual-daily-snacks/claim', {
    method: 'POST', headers: { 'idempotency-key': key }, data: {},
  }))).data
}
async function cancelActivityRegistration(registrationPublicId, reason, idempotencyKey) {
  return (await publicRequest(`/api/public/mini/activity-registrations/${encodeURIComponent(registrationPublicId)}/cancel`, {
    method: 'POST', headers: { 'idempotency-key': idempotencyKey || randomId(`activity-cancel-${registrationPublicId}`) },
    data: { reason },
  })).data
}
async function submitSongRequest(input) {
  return recoverableGuestCommand('song-submit', input, (idempotencyKey) => request('/api/guest/song-requests', {
    method: 'POST', headers: { 'idempotency-key': idempotencyKey }, data: input,
  }))
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
  getCustomerBottles, getCustomerBottle, getCustomerBottlePhoto,
  getCustomerOrderHistory,
  getMemberCards, submitMemberCardAction, getMemberGiftJobs, getMarketingPreferences, updateMarketingPreferences,
  getGuestSession, getMiniBootstrap, getPrivacyPolicy, getMembershipTerms, getMiniLoyalty, getMiniLoyaltyLedger,
  recordBirthdayBenefitConsent, withdrawBirthdayBenefitConsent,
  getNotificationConsent, recordNotificationConsent,
  getOfficialPointsNotifications, setOfficialPointsNotifications,
  getWechatNotificationAuthorizations, recordWechatNotificationAuthorization,
  getWechatMemberServiceNotificationAuthorizations, recordWechatMemberServiceNotificationAuthorization,
  getWechatNotificationPrompt,
  getProductRestrictions, withdrawProductRestriction,
  getCustomerPreferenceFacts, declareCustomerPreference, withdrawCustomerPreferenceSource,
  getRedemptionCatalog, getRedemptions, createRedemption, cancelRedemption,
  getActivities, getActivity, getActivityPreview, getActivityLoyaltyBenefits, getActivityRegistrations,
  updateActivityRegistrationContact, getVerifiedPhones, replaceVerifiedPhone, revokeVerifiedPhone,
  enrollMembership,
  startMembershipRecovery, verifyMembershipRecovery, updatePreferences,
  getActivityRegistrationServiceCode, resolveActivityParent, getActivityAddonProducts, updateActivityRegistrationPartySize, requestActivityRegistrationRefund,
  registerActivity, getActivityRegistrationPayment, startActivityRegistrationPayment,
  queryActivityRegistrationPayment, cancelActivityRegistration,
  getReservations, getReservationAvailability, getReservationPerformances, createCustomerReservation, getPendingCustomerReservation, recoverCustomerReservation,
  cancelCustomerReservation,
  getReservationPerformanceImpacts, acknowledgeReservationPerformanceImpact,
  getReservationPerformanceNotificationAuthorizations,
  recordReservationPerformanceNotificationAuthorization,
  getMenu, getPublicMenu, recommendExperience, getRecommendationConfiguration, recordRecommendationEvent, prepareCheckoutUpgrade, recordCheckoutUpgradeEvent,
  revokeTablePrepayment, prepayTable, queryPrepayment, checkout, getSharedCart, addIssuedCouponProduct, adjustSharedCart, replaceSharedCartBundleSelection, removeSharedCartLine, clearSharedCart, checkoutSharedCart, getCheckoutPoints, quoteSharedCartPoints, quoteSharedCartCoupons, quoteSharedCartChannel, prepareSharedCartUpgrade, decideSharedCartUpgrade, getTableOrders, payTableOrders, retryOrderPayment, abandonGuestCheckout,
  createServiceTask, getServiceRequests, actOnServiceTask,
  getCustomerBenefits, getCustomerBenefitWallet, getCustomerProfile, reserveCustomerBenefit, claimAnnualDailySnack, submitSongRequest, getTodayPerformances,
  getChannelWallet, getChannelWalletPage, getChannelOffer, claimChannelCoupon, activateChannelCoupon,
  logoutWechatIdentity,
}
