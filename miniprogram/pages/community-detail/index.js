const {
  getActivity,
  getActivityPreview,
  getActivityLoyaltyBenefits,
  getActivityRegistrations,
  registerActivity,
  getActivityRegistrationPayment,
  startActivityRegistrationPayment,
  queryActivityRegistrationPayment,
  cancelActivityRegistration,
  getMiniBootstrap,
  getWechatNotificationPrompt,
  enrollMembership,
} = require('../../utils/api')
const { ensureCustomerSession } = require('../../utils/auth')
const { randomId } = require('../../utils/id')
const { money, dateTime } = require('../../utils/format')
const { publicImageUrl } = require('../../utils/media')
const { readWechatPhoneAuthorization } = require('../../utils/wechat-phone')
const { customerErrorMessage, isWechatCancellation } = require('../../utils/customer-error')
const {
  requestWechatSubscription,
  mergeWechatNotificationPromptOptions,
  extractPromptPresentation,
  buildActivitySubscriptionPresentation,
  ACTIVITY_REGISTRATION_SUBSCRIBE_TYPES,
} = require('../../utils/wechat-subscription')
const { rememberPresentationOptions } = require('../../utils/wechat-subscription-presentation-cache')
const { enablePublicShareMenu } = require('../../utils/public-share')

const KIND_NAMES = { member_night: '会员之夜', hike: '城市轻徒步', camping: '露营计划', city_walk: '城市漫游', music_picnic: '音乐野餐', proposal: '特别企划', other: '超嗨活动' }
const LOCAL_REGISTRATIONS_KEY = 'mbox.community.registrations.v1'
const REGISTRATION_ATTEMPTS_KEY = 'mbox.community.registration.attempts.v1'
const PAYMENT_ACTION_ATTEMPTS_KEY = 'mbox.community.payment.actions.v1'
const PAYMENT_QUERY_ATTEMPTS_KEY = 'mbox.community.payment.queries.v1'
const CANCELLATION_ATTEMPTS_KEY = 'mbox.community.registration.cancellations.v1'
const REGISTRATION_ATTEMPT_MAX_AGE_MS = 15 * 60 * 1000
const ALLOWED_PAYMENT_ACTIONS = ['start_payment', 'query_payment', 'cancel_registration']
const REGISTRATION_STATUS_NAMES = {
  reserved: '待付款', payment_pending: '待付款', confirmed: '已报名',
  waitlisted: '候补中', checked_in: '已签到', no_show: '未到场',
  cancelled: '报名已取消', refunded: '已退款', expired: '报名已失效',
}
const RESOLUTION_STATE_NAMES = {
  not_required: '无需在线付款', action_required: '等待您完成付款', pending: '付款确认中',
  unknown: '付款结果待确认', confirmed: '付款已经确认', failed: '付款明确失败',
  expired: '付款已超时，名额已释放', refund_requested: '退款申请确认中',
  refunding: '退款处理中', refunded: '退款已经完成',
}
const REFUND_STATUS_NAMES = {
  requested: '退款申请已提交，等待确认', approved: '退款申请已确认', processing: '退款处理中',
  succeeded: '退款已经到账', failed: '退款暂未完成，门店正在确认', rejected: '退款申请未通过',
}

function list(value) {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item || '').trim()).filter(Boolean)
}

function shareActivityId(value) {
  const publicId = String(value || '').trim()
  return publicId && publicId.length <= 128 ? publicId : ''
}

function activityShareQuery(publicId) {
  const activityId = shareActivityId(publicId)
  return activityId ? `id=${encodeURIComponent(activityId)}&source=share` : ''
}

function activitySharePath(publicId) {
  const query = activityShareQuery(publicId)
  return query ? `/pages/community-detail/index?${query}` : '/pages/community/index'
}

function storageObject(key) {
  const value = wx.getStorageSync(key)
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function commandKey(kind, publicId) {
  const suffix = String(publicId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(-24) || 'activity'
  return randomId(`${kind}-${suffix}`).slice(0, 128)
}

function validCommandKey(value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 128
}

const REGISTRATION_CLEARABLE_CODES = Object.freeze([
  'ACTIVITY_CONTACT_INVALID',
  'ACTIVITY_CONTACT_PROTECTION_FAILED',
  'ACTIVITY_CONTACT_PROTECTION_UNAVAILABLE',
  'ACTIVITY_MEMBERSHIP_REQUIRED',
  'ACTIVITY_TERMS_ACKNOWLEDGEMENT_REQUIRED',
  'ACTIVITY_TERMS_NOT_CONFIGURED',
  'ACTIVITY_AUDIENCE_DENIED',
  'ACTIVITY_UNAVAILABLE',
  'ACTIVITY_NOT_FOUND',
  'ACTIVITY_PAYMENT_AUTHORITY_NOT_CONFIGURED',
  'ACTIVITY_ALREADY_REGISTERED',
  'ACTIVITY_PACKAGE_SELECTION_REQUIRED',
  'ACTIVITY_PACKAGE_UNAVAILABLE',
  'ACTIVITY_PACKAGE_INVENTORY_UNAVAILABLE',
  'ACTIVITY_PACKAGE_INVENTORY_INSUFFICIENT',
  'ACTIVITY_PACKAGE_PURCHASE_LIMIT',
])

function registrationContact(value) {
  const contact = String(value || '').trim()
  if (/^1\d{10}$/.test(contact)) return contact
  return ''
}

function registrationAttemptPayload(value) {
  const payload = value && typeof value === 'object' ? value : {}
  // Phone numbers are never persisted in the local retry record. The same
  // idempotency key is retained briefly, but a customer must re-enter the
  // contact phone before an unconfirmed request is retried.
  return {
    activityPackagePublicId: payload.activityPackagePublicId || null,
    partySize: Number(payload.partySize || 1),
    termsAcknowledged: payload.termsAcknowledged === true,
    acknowledgedSafetyPolicyVersion: String(payload.acknowledgedSafetyPolicyVersion || ''),
    acknowledgedRefundPolicyVersion: String(payload.acknowledgedRefundPolicyVersion || ''),
    paymentChoice: String(payload.paymentChoice || 'none'),
    ...(payload.paymentMethod ? { paymentMethod: String(payload.paymentMethod) } : {}),
  }
}

function registrationAttemptExpired(attempt) {
  const createdAt = attempt && typeof attempt.createdAt === 'string' ? Date.parse(attempt.createdAt) : Number.NaN
  return !Number.isFinite(createdAt) || Date.now() - createdAt > REGISTRATION_ATTEMPT_MAX_AGE_MS
}

function registrationFailureMessage(error) {
  const code = error && error.code ? String(error.code) : ''
  const status = Number(error && error.statusCode)
  if (code === 'ACTIVITY_PAYMENT_AUTHORITY_NOT_CONFIGURED') {
    return '线上付款暂时不可用，本次报名尚未提交，也不会占用名额。'
  }
  if (code === 'ACTIVITY_MEMBERSHIP_REQUIRED') {
    return '加入 M-BOX 会员并授权手机号后，才可报名超嗨活动。'
  }
  if (code === 'ACTIVITY_CONTACT_INVALID') {
    return '手机号格式不正确，请填写本人可联系的 11 位手机号。'
  }
  if (code === 'ACTIVITY_CONTACT_PROTECTION_UNAVAILABLE' || code === 'ACTIVITY_CONTACT_PROTECTION_FAILED') {
    return '报名服务暂时不可用，请稍后再试。'
  }
  if (code === 'ACTIVITY_TERMS_ACKNOWLEDGEMENT_REQUIRED') {
    return '请阅读并确认报名说明后再报名。'
  }
  if (code === 'ACTIVITY_TERMS_NOT_CONFIGURED') {
    return '活动报名说明暂未准备好，暂时不能报名。'
  }
  if (code === 'ACTIVITY_AUDIENCE_DENIED') {
    return '这个活动当前不在您的可报名范围内。'
  }
  if (code === 'ACTIVITY_UNAVAILABLE' || code === 'ACTIVITY_NOT_FOUND') {
    return '这个活动已结束、暂停或不在您的可见范围内。'
  }
  if (code === 'ACTIVITY_ALREADY_REGISTERED') {
    return '你已报名这个活动，请下拉刷新后查看进展。'
  }
  if (code === 'ACTIVITY_PACKAGE_SELECTION_REQUIRED') return '请先选择一档活动套餐后再报名。'
  if (code === 'ACTIVITY_PACKAGE_UNAVAILABLE' || code === 'ACTIVITY_PACKAGE_INVENTORY_UNAVAILABLE' || code === 'ACTIVITY_PACKAGE_INVENTORY_INSUFFICIENT') {
    return '所选套餐当前不可报名，请刷新后选择其他可订套餐。'
  }
  if (code === 'ACTIVITY_PACKAGE_PURCHASE_LIMIT') return '所选套餐已超过每会员限购数量，请调整报名人数或更换套餐。'
  if (status === 401 || code === 'AUTH_REQUIRED') {
    return '会员登录状态已失效，请返回“我的”重新进入会员后再报名。'
  }
  if (code === 'ACTIVITY_REGISTRATION_RESULT_UNCONFIRMED' || status >= 500) {
    return '报名服务暂时繁忙，结果尚未确认；请稍后在“我的活动”查看后再试。'
  }
  if (code === 'HTTP_ERROR') {
    return '报名结果暂时无法确认；请先刷新“我的活动”查看进展，再决定是否重试。'
  }
  return customerErrorMessage(error, '报名结果尚未确认；请先刷新“我的活动”查看进展，再决定是否重试。')
}

function shouldClearRegistrationAttempt(error) {
  const code = error && error.code ? String(error.code) : ''
  if (REGISTRATION_CLEARABLE_CODES.includes(code)) return true
  const status = Number(error && error.statusCode)
  return status === 400 || status === 403 || status === 409
}

function publicText(value, fallback) {
  if (!value || typeof value !== 'object') return fallback
  return value.summary || value.publicText || value.ruleText || fallback
}

function paymentText(item) {
  const choices = list(item.availablePaymentChoices)
  if (item.feeAmountMinor > 0 && item.paymentAvailability !== 'available') {
    return `收费报名暂未开放${item.paymentRuleText ? ` · ${item.paymentRuleText}` : ''}`
  }
  if (item.paymentMode === 'none' || !item.feeAmountMinor) return item.feeAmountMinor > 0
    ? `无需线上预付 · ${item.paymentRuleText}` : '免费报名，提交后确认名额'
  if (item.paymentMode === 'deposit_optional' && !choices.includes('deposit')) return `线上订金暂未开放，本次仅支持不预付报名 · ${item.paymentRuleText}`
  if (item.paymentMode === 'deposit_optional') return `可付${money(item.depositAmountMinor)}订金锁定，也可选择不预付`
  if (item.paymentMode === 'deposit_required') return `需付${money(item.depositAmountMinor)}订金，${item.paymentDeadlineMinutes}分钟内完成`
  return `需全额预付，${item.paymentDeadlineMinutes}分钟内完成`
}

function packageView(raw) {
  const availability = String(raw && raw.availability || 'temporarily_unavailable')
  const feeAmountMinor = Number(raw && raw.feeAmountMinor || 0)
  return Object.assign({}, raw, {
    imageUrl: publicImageUrl(raw && raw.imageUrl),
    availability,
    availabilityText: raw && raw.availabilityText || (availability === 'available' ? '可报名' : availability === 'sold_out' ? '已售罄' : '暂不可订'),
    feeText: feeAmountMinor > 0 ? `加购 ${money(feeAmountMinor)}${raw.feeBasis === 'per_person' ? '/人' : '/次'}` : '免费加购',
    includedItems: list(raw && raw.includedItems),
  })
}

function stricterPaymentMode(modes) {
  if (modes.includes('full_required')) return 'full_required'
  if (modes.includes('deposit_required')) return 'deposit_required'
  if (modes.includes('deposit_optional')) return 'deposit_optional'
  return 'none'
}

function selectedPackage(activity, publicId) {
  const packages = activity && Array.isArray(activity.packages) ? activity.packages : []
  return packages.find((item) => item && item.publicId === publicId) || null
}

function pricingFor(activity, activityPackage, partySize) {
  const packageSelected = activityPackage || null
  const activityMultiplier = activity.feeBasis === 'per_person' ? partySize : 1
  const packageMultiplier = packageSelected && packageSelected.feeBasis === 'per_person' ? partySize : 1
  const totalFeeAmountMinor = Number(activity.feeAmountMinor || 0) * activityMultiplier
    + (packageSelected ? Number(packageSelected.feeAmountMinor || 0) * packageMultiplier : 0)
  const depositAmountMinor = Number(activity.depositAmountMinor || 0) * activityMultiplier
    + (packageSelected ? Number(packageSelected.depositAmountMinor || 0) * packageMultiplier : 0)
  const paymentMode = stricterPaymentMode([activity.paymentMode, packageSelected && packageSelected.paymentMode].filter(Boolean))
  const paymentSources = [activity, packageSelected].filter((item) => item && item.paymentMode !== 'none')
  const deadline = paymentSources.length ? Math.min(...paymentSources.map((item) => Number(item.paymentDeadlineMinutes || 15))) : 0
  const authorityAvailable = paymentSources.every((item) => item.paymentAvailability === 'available')
  const availablePaymentChoices = paymentMode === 'none' ? ['none']
    : !authorityAvailable ? (paymentMode === 'deposit_optional' ? ['none'] : [])
      : paymentMode === 'deposit_optional' ? ['none', 'deposit']
        : paymentMode === 'deposit_required' ? ['deposit'] : ['full']
  return {
    feeAmountMinor: totalFeeAmountMinor,
    depositAmountMinor,
    paymentMode,
    paymentDeadlineMinutes: deadline,
    paymentAvailability: authorityAvailable || paymentMode === 'deposit_optional' ? 'available' : 'blocked',
    availablePaymentChoices,
    availablePaymentMethods: authorityAvailable ? activity.availablePaymentMethods : [],
    paymentRuleText: packageSelected
      ? `活动票：${activity.paymentRuleText}；套餐：${packageSelected.paymentRuleText}`
      : activity.paymentRuleText,
    deadlineText: paymentMode === 'none' || !totalFeeAmountMinor ? '无需在线付款' : `${deadline} 分钟`,
    requiresPaymentOnSubmit: totalFeeAmountMinor > 0 && !availablePaymentChoices.includes('none'),
    feeText: totalFeeAmountMinor > 0 ? money(totalFeeAmountMinor) : '免费',
    depositText: depositAmountMinor > 0 ? money(depositAmountMinor) : '无需订金',
  }
}

function partySizeLimit(activity, activityPackage) {
  const limits = [Number(activity && activity.remainingCapacity || 0)]
  if (activityPackage) limits.push(Number(activityPackage.remainingCapacity || 0))
  const valid = limits.filter((value) => Number.isFinite(value) && value > 0)
  return valid.length ? Math.max(1, Math.min(...valid)) : 1
}

function activitySelection(activity, requestedPackagePublicId, requestedPartySize) {
  const selectedPackagePublicId = selectedPackage(activity, requestedPackagePublicId)
    ? requestedPackagePublicId : ''
  const currentPackage = selectedPackage(activity, selectedPackagePublicId)
  const maximumPartySize = partySizeLimit(activity, currentPackage)
  const requested = Number(requestedPartySize)
  const partySize = Math.max(1, Math.min(maximumPartySize, Number.isFinite(requested) ? Math.floor(requested) : 1))
  return {
    selectedPackagePublicId,
    selectedPackage: currentPackage,
    partySize,
    partySizeLimit: maximumPartySize,
    selectedPricing: pricingFor(activity, currentPackage, partySize),
  }
}

function viewActivity(raw) {
  const isSharePreview = raw && raw.registrationRequiresMembership === true
  const sales = isSharePreview
    ? (raw.marketingCopy && typeof raw.marketingCopy === 'object' ? raw.marketingCopy : {})
    : (raw.salesCopy && typeof raw.salesCopy === 'object' ? raw.salesCopy : {})
  const safety = raw.safety && typeof raw.safety === 'object' ? raw.safety : {}
  const refund = raw.refundPolicy && typeof raw.refundPolicy === 'object' ? raw.refundPolicy : {}
  const safetyPolicyVersion = String(safety.policyVersion || '').trim()
  const refundPolicyVersion = String(refund.policyVersion || '').trim()
  const packages = Array.isArray(raw.packages) ? raw.packages.map(packageView) : []
  const availablePaymentChoices = list(raw.availablePaymentChoices)
  const availablePaymentMethods = list(raw.availablePaymentMethods)
  const requiresOnlinePayment = raw.feeAmountMinor > 0 && !availablePaymentChoices.includes('none')
  const providerBlocked = raw.feeAmountMinor > 0 && raw.paymentAvailability !== 'available'
  const clientPaymentBlocked = requiresOnlinePayment && !availablePaymentMethods.includes('jsapi')
  const registrationBlocked = !isSharePreview && (providerBlocked || clientPaymentBlocked || !safetyPolicyVersion || !refundPolicyVersion)
  const safetyFacts = []
  if (safety.difficulty) safetyFacts.push(`难度：${safety.difficulty}`)
  if (safety.ageRequirement) safetyFacts.push(`年龄：${safety.ageRequirement}`)
  if (safety.insuranceIncluded !== undefined) safetyFacts.push(safety.insuranceIncluded ? '活动包含保险' : '活动不包含保险')
  let paymentBlockedText = ''
  if (providerBlocked) paymentBlockedText = '线上付款暂时不可用，暂时不能报名。'
  else if (clientPaymentBlocked) paymentBlockedText = '线上付款暂时不可用，暂时不能提交收费报名。'
  else if (!safetyPolicyVersion || !refundPolicyVersion) paymentBlockedText = '报名说明暂未准备好，暂时不能报名。'
  return Object.assign({}, raw, {
    coverUrl: publicImageUrl(raw.coverUrl),
    kindText: KIND_NAMES[raw.kind] || '超嗨活动',
    startsText: dateTime(raw.startsAt),
    endsText: dateTime(raw.endsAt),
    feeText: raw.feeAmountMinor > 0 ? `${money(raw.feeAmountMinor)}${raw.feeBasis === 'per_person' ? '/人' : '/次'}` : '免费',
    depositText: raw.depositAmountMinor > 0 ? money(raw.depositAmountMinor) : '无需订金',
    deadlineText: raw.paymentDeadlineMinutes > 0 ? `${raw.paymentDeadlineMinutes} 分钟` : '无需在线付款',
    paymentText: isSharePreview ? '加入会员后查看报名与付款安排' : paymentText(raw),
    refundText: publicText(raw.refundPolicy, '取消与退款以本页报名时展示的规则快照为准'),
    details: String(sales.details || raw.summary || '').trim(),
    includedItems: list(sales.includedItems),
    participationRequirements: list(sales.participationRequirements),
    memberBenefitText: String(sales.memberBenefitText || '').trim(),
    contactInstructions: String(sales.contactInstructions || '').trim(),
    safetyRequirements: isSharePreview ? list(raw.safetyRequirements) : list(safety.requirements),
    safetyPolicyVersion,
    refundPolicyVersion,
    safetyPolicyText: safetyPolicyVersion ? '报名规则已确认' : '报名说明暂未准备好',
    availablePaymentChoices,
    availablePaymentMethods,
    packages,
    isSharePreview,
    availabilityText: String(raw.availabilityText || (raw.remainingCapacity > 0 ? '可报名' : '暂不可订')),
    packageSelectionRequired: Boolean(raw.packageSelectionRequired),
    requiresPaymentOnSubmit: raw.feeAmountMinor > 0 && !availablePaymentChoices.includes('none'),
    safetyFacts,
    registrationBlocked,
    paymentBlockedText: isSharePreview ? '' : paymentBlockedText,
    acknowledgementText: safetyPolicyVersion && refundPolicyVersion
      ? `我已阅读并确认安全规则 ${safetyPolicyVersion} 与退款规则 ${refundPolicyVersion}`
      : '报名说明暂未准备好，暂时不能确认报名',
  })
}

function viewRegistration(raw) {
  if (!raw) return null
  const status = raw.registrationStatus || raw.status || ''
  const payment = raw.payment && typeof raw.payment === 'object' ? raw.payment : {}
  const resolutionState = String(raw.resolutionState || payment.resolutionState || '').trim()
  const allowedActions = list(raw.allowedActions || payment.allowedActions).filter((action) => ALLOWED_PAYMENT_ACTIONS.includes(action))
  const refundStatus = String(raw.refundStatus || payment.refundStatus || '').trim()
  const paidAmountMinor = Number(raw.paidAmountMinor || (resolutionState === 'confirmed' ? payment.amountMinor : 0) || 0)
  const paymentAmountMinor = Number(payment.amountMinor || payment.amountDueMinor || raw.amountDueMinor || 0)
  const manualStates = ['confirmed', 'refund_requested', 'refunding', 'refunded']
  const refundComplete = resolutionState === 'refunded' || refundStatus === 'succeeded'
  const stateGuide = status === 'confirmed'
    ? '报名成功，名额已确认。'
    : ['reserved', 'payment_pending'].includes(status)
      ? '名额已暂留，完成付款后才算报名成功。'
      : status === 'waitlisted'
        ? '候补中，会按报名顺序依次安排；现在无需付款。'
        : ''
  return Object.assign({}, raw, {
    referenceText: shortReference(raw.publicId),
    status,
    statusText: REGISTRATION_STATUS_NAMES[status] || '状态待确认',
    resolutionState,
    resolutionText: RESOLUTION_STATE_NAMES[resolutionState] || '',
    refundStatus,
    refundStatusText: REFUND_STATUS_NAMES[refundStatus] || '',
    allowedActions,
    canStartPayment: allowedActions.includes('start_payment'),
    canQueryPayment: allowedActions.includes('query_payment'),
    canCancelDirectly: allowedActions.includes('cancel_registration'),
    requiresManualCancellation: !refundComplete && (paidAmountMinor > 0 || manualStates.includes(resolutionState)),
    canReRegister: status === 'cancelled' && !manualStates.includes(resolutionState),
    paymentAmountMinor,
    amountDueText: money(paymentAmountMinor),
    paidText: money(paidAmountMinor),
    paymentDueText: raw.paymentDueAt ? dateTime(raw.paymentDueAt) : '',
    seatHoldText: raw.seatHoldExpiresAt || raw.expiresAt || payment.expiresAt
      ? dateTime(raw.seatHoldExpiresAt || raw.expiresAt || payment.expiresAt) : '',
    paymentMethodText: payment.method === 'jsapi' ? '微信支付' : payment.method === 'native_qr' ? '二维码支付' : '',
    stateGuide,
  })
}

function shortReference(value) {
  const normalized = String(value || '').trim()
  if (!normalized) return '待生成'
  return normalized.length <= 12 ? normalized : `…${normalized.slice(-8)}`
}

function viewLoyaltyBenefit(raw) {
  const triggerText = {
    activity_payment: '付款成功后', activity_check_in: '到场签到后', activity_completion: '活动完成后',
  }[raw.triggerKind] || '活动条件达成后'
  const levelText = list(raw.eligibleMemberLevels).map((level) => ({
    member: '普通会员', silver: '银卡会员', gold: '金卡会员',
  }[level] || level)).join('、')
  const refundText = raw.refundPolicy === 'reverse_on_full_refund' ? '全额退款时冲回' : '发生退款时冲回'
  return Object.assign({}, raw, {
    triggerText, levelText, refundText,
    minimumPaidText: Number(raw.minimumPaidAmountMinor || 0) > 0
      ? `付款满 ${money(Number(raw.minimumPaidAmountMinor))}` : '',
  })
}

function jsapiPayload(value) {
  if (!value || typeof value !== 'object') return null
  const keys = ['timeStamp', 'nonceStr', 'package', 'signType', 'paySign']
  if (!keys.every((key) => typeof value[key] === 'string' && value[key])) return null
  return keys.reduce((result, key) => Object.assign(result, { [key]: value[key] }), {})
}

Page({
  data: {
    id: '', shareSource: '', loading: true, busy: false, error: '', success: '', activity: null,
    partySize: 1, partySizeLimit: 1, contact: '', contactFocused: false, contactAttention: false,
    acknowledgementAttention: false, ruleAcknowledged: false, registration: null, loyaltyBenefits: [],
    selectedPackagePublicId: '', selectedPackage: null, selectedPricing: null,
    previewOnly: false, memberAccessRequested: false,
    membership: null, membershipTerms: null,
    membershipInviteVisible: false, membershipInviteAgreed: false, membershipInviteBusy: false,
    // A paid-activity preflight can refuse before it creates a registration.
    // Keep the next action explicit so the customer can force a fresh wx.login
    // rather than merely being told to re-enter an app that may reuse a cache.
    wechatIdentityRefreshRequired: false,
    wechatNotificationPromptOptions: [],
    wechatSubscriptionPresentationOptions: [],
  },

  onLoad(options) {
    const source = options && options.source === 'share' ? 'share' : ''
    this.setData({ id: shareActivityId(options && options.id), shareSource: source, memberAccessRequested: false })
  },
  onUnload() { if (this.registrationFocusTimer) clearTimeout(this.registrationFocusTimer) },
  onShow() { enablePublicShareMenu(); this.load() },

  activitySharePayload() {
    const activity = this.data.activity
    const activityId = shareActivityId(activity && activity.publicId || this.data.id)
    const title = activity && activity.title ? `邀请你参加 · ${activity.title}` : 'M-BOX 超嗨活动'
    return {
      title,
      path: activitySharePath(activityId),
      query: activityShareQuery(activityId),
      ...(activity && activity.coverUrl ? { imageUrl: activity.coverUrl } : {}),
    }
  },

  onShareAppMessage() {
    const payload = this.activitySharePayload()
    return {
      title: payload.title,
      path: payload.path,
      ...(payload.imageUrl ? { imageUrl: payload.imageUrl } : {}),
    }
  },

  onShareTimeline() {
    const payload = this.activitySharePayload()
    return {
      title: payload.title,
      ...(payload.query ? { query: payload.query } : {}),
      ...(payload.imageUrl ? { imageUrl: payload.imageUrl } : {}),
    }
  },

  async load() {
    this.setData({ loading: true, error: '', success: '' })
    try {
      if (this.data.shareSource === 'share' && !this.data.memberAccessRequested) {
        await this.loadAnonymousSharePreview(false)
        return
      }
      const bootstrap = await getMiniBootstrap()
      const membership = bootstrap.membership || null
      const membershipTerms = bootstrap.membershipTerms || null
      this.setData({ membership, membershipTerms })
      if (!membership) {
        if (this.data.shareSource === 'share') {
          await this.loadAnonymousSharePreview(Boolean(membershipTerms))
          if (!membershipTerms) this.setData({ error: '当前会员协议暂时无法读取，请稍后再试。' })
          return
        }
        this.setData({
          loading: false,
          activity: null,
          registration: null,
          loyaltyBenefits: [],
          previewOnly: false,
          membershipInviteVisible: true,
          membershipInviteAgreed: false,
          error: '',
        })
        return
      }
      const [raw, activityPrompt, memberPrompt, couponPrompt] = await Promise.all([
        getActivity(this.data.id),
        getWechatNotificationPrompt('activity_registration').catch(() => ({ authorizations: [] })),
        getWechatNotificationPrompt('member_card').catch(() => ({ authorizations: [] })),
        getWechatNotificationPrompt('coupon_open').catch(() => ({ authorizations: [] })),
        this.preloadWechatSubscriptionPresentationOptions(),
      ])
      const notificationPrompt = {
        authorizations: mergeWechatNotificationPromptOptions(
          activityPrompt.authorizations,
          memberPrompt.authorizations,
          couponPrompt.authorizations,
        ),
        presentation: buildActivitySubscriptionPresentation(
          extractPromptPresentation(activityPrompt),
          extractPromptPresentation(memberPrompt),
          extractPromptPresentation(couponPrompt),
        ),
      }
      if (!raw) throw new Error('活动已结束、暂停或不在您的可见范围内')
      let loyaltyBenefits = []
      try {
        loyaltyBenefits = (await getActivityLoyaltyBenefits(raw.publicId)).map(viewLoyaltyBenefit)
      } catch (_error) {
        loyaltyBenefits = []
      }
      let registrations = []
      let registrationReadError = ''
      try { registrations = await getActivityRegistrations() } catch (error) { registrationReadError = customerErrorMessage(error, '报名记录暂时无法读取') }
      const local = storageObject(LOCAL_REGISTRATIONS_KEY)
      const authoritative = (registrations || []).find((item) => item.activityPublicId === raw.publicId)
      let registrationRaw = authoritative || local[raw.publicId] || null
      let paymentReadError = ''
      if (registrationRaw && registrationRaw.publicId && registrationRaw.status !== 'cancelled') {
        try {
          const paymentState = await getActivityRegistrationPayment(registrationRaw.publicId)
          registrationRaw = Object.assign({}, registrationRaw, paymentState, {
            status: paymentState.registrationStatus || registrationRaw.status,
          })
        } catch (error) { paymentReadError = customerErrorMessage(error, '付款状态暂时无法读取') }
      }
      const pendingAttempt = storageObject(REGISTRATION_ATTEMPTS_KEY)[raw.publicId]
      const sameCancelledRegistration = authoritative && authoritative.status === 'cancelled' && (
        typeof pendingAttempt === 'string'
        || (pendingAttempt && pendingAttempt.previousRegistrationPublicId === authoritative.publicId)
      )
      if (authoritative && !sameCancelledRegistration) this.clearRegistrationAttempt(raw.publicId)
      const registration = viewRegistration(registrationRaw)
      if (registration) this.rememberRegistration(registration, raw.publicId)
      const activity = viewActivity(raw)
      this.setData({
        loading: false, activity, loyaltyBenefits, registration, error: paymentReadError || registrationReadError,
        previewOnly: false,
        membershipInviteVisible: false,
        wechatNotificationPromptOptions: notificationPrompt.authorizations || [],
        wechatSubscriptionPresentationOptions: notificationPrompt.presentation || [],
        ...activitySelection(activity, this.data.selectedPackagePublicId, this.data.partySize),
      })
      rememberPresentationOptions('activity_registration', notificationPrompt.presentation || [])
    } catch (error) {
      if (error && error.code === 'ACTIVITY_MEMBERSHIP_REQUIRED') {
        this.setData({
          loading: false,
          activity: null,
          registration: null,
          membership: null,
          membershipInviteVisible: true,
          membershipInviteAgreed: false,
          error: '',
        })
        return
      }
      this.setData({
        loading: false, error: customerErrorMessage(error, '活动详情暂时无法读取'),
        wechatNotificationPromptOptions: [],
      })
    }
  },

  async loadAnonymousSharePreview(showMembershipInvite) {
    const raw = await getActivityPreview(this.data.id)
    if (!raw) throw new Error('活动已结束、暂停或当前不可分享')
    const activity = viewActivity(raw)
    this.setData({
      loading: false,
      activity,
      registration: null,
      loyaltyBenefits: [],
      previewOnly: true,
      membershipInviteVisible: Boolean(showMembershipInvite),
      membershipInviteAgreed: false,
      error: '',
      ...activitySelection(activity, this.data.selectedPackagePublicId, this.data.partySize),
    })
  },

  dismissMembershipInvite() {
    this.setData({ membershipInviteVisible: false, membershipInviteAgreed: false })
    if (this.data.previewOnly) return
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/community/index' }) })
  },

  async openMembershipInvite() {
    if (this.data.membership) return
    if (this.data.memberAccessRequested) {
      if (!this.data.membershipTerms) wx.showToast({ title: '当前会员协议暂时无法读取', icon: 'none' })
      else this.setData({ membershipInviteVisible: true, membershipInviteAgreed: false, error: '' })
      return
    }
    this.setData({ memberAccessRequested: true, error: '' })
    await this.load()
  },

  onMembershipInviteAgreementChange(event) {
    const values = event && event.detail && Array.isArray(event.detail.value) ? event.detail.value : []
    this.setData({ membershipInviteAgreed: values.indexOf('agree') >= 0 })
  },

  remindMembershipInviteAgreement() {
    wx.showToast({ title: '请先勾选同意会员协议', icon: 'none' })
  },

  showMembershipTerms() {
    wx.navigateTo({ url: '/pages/membership-terms/index?source=mini_community&action=view' })
  },

  onAgreePrivacyAuthorization() {},

  async acceptMembershipInvite(event) {
    if (this.data.membershipInviteBusy) return
    if (!this.data.membershipInviteAgreed) return this.remindMembershipInviteAgreement()
    const terms = this.data.membershipTerms
    if (!terms) {
      wx.showToast({ title: '当前会员协议暂时无法读取', icon: 'none' })
      return
    }
    const authorization = readWechatPhoneAuthorization(event)
    if (!authorization.code) {
      wx.showToast({ title: authorization.message, icon: 'none' })
      return
    }
    this.setData({ membershipInviteBusy: true, error: '' })
    try {
      const result = await enrollMembership(terms.version, 'mini_community', authorization.code)
      if (!result.membership) throw new Error('会员状态暂时未刷新，请稍后重试')
      this.setData({
        membership: result.membership,
        membershipInviteVisible: false,
        membershipInviteAgreed: false,
        membershipInviteBusy: false,
      })
      wx.showToast({ title: '入会成功', icon: 'success' })
      await this.load()
    } catch (error) {
      this.setData({ membershipInviteBusy: false, error: customerErrorMessage(error, '入会暂时没有完成') })
      wx.showToast({ title: customerErrorMessage(error, '入会未完成'), icon: 'none' })
    }
  },

  noop() {},

  changePartySize(event) {
    const delta = Number(event.currentTarget.dataset.delta)
    const maximum = this.data.partySizeLimit || 1
    const partySize = Math.max(1, Math.min(maximum, this.data.partySize + delta))
    this.setData({ partySize, selectedPricing: pricingFor(this.data.activity, this.data.selectedPackage, partySize) })
  },
  choosePackage(event) {
    const activity = this.data.activity
    if (!activity || this.data.busy) return
    const publicId = String(event.currentTarget.dataset.packageId || '')
    const next = selectedPackage(activity, publicId)
    if (!next || next.availability !== 'available') return
    this.clearRegistrationAttempt(activity.publicId)
    const limit = partySizeLimit(activity, next)
    const partySize = Math.min(this.data.partySize, limit)
    this.setData({
      selectedPackagePublicId: publicId,
      selectedPackage: next,
      partySize,
      partySizeLimit: limit,
      selectedPricing: pricingFor(activity, next, partySize),
      error: '', success: '',
    })
  },
  clearPackageSelection() {
    const activity = this.data.activity
    if (!activity || activity.packageSelectionRequired || this.data.busy) return
    this.clearRegistrationAttempt(activity.publicId)
    const limit = partySizeLimit(activity, null)
    const partySize = Math.min(this.data.partySize, limit)
    this.setData({
      selectedPackagePublicId: '', selectedPackage: null,
      partySize, partySizeLimit: limit,
      selectedPricing: pricingFor(activity, null, partySize), error: '', success: '',
    })
  },
  onContactInput(event) {
    const contact = String(event && event.detail && event.detail.value || '').replace(/\D/g, '').slice(0, 11)
    this.setData({ contact, contactAttention: false })
  },
  onAcknowledgementChange(event) {
    this.setData({
      ruleAcknowledged: Boolean(event.detail.value && event.detail.value.length),
      acknowledgementAttention: false,
    })
  },

  focusRegistrationField(field, error) {
    if (this.registrationFocusTimer) clearTimeout(this.registrationFocusTimer)
    const contact = field === 'contact'
    this.setData({
      error: error || '',
      contactFocused: contact,
      contactAttention: contact,
      acknowledgementAttention: !contact,
    }, () => {
      wx.pageScrollTo({
        selector: contact ? '#activity-registration-contact' : '#activity-registration-acknowledgement',
        duration: 280,
      })
      this.registrationFocusTimer = setTimeout(() => {
        this.setData({ contactFocused: false, contactAttention: false, acknowledgementAttention: false })
      }, 1100)
    })
  },

  async preloadWechatSubscriptionPresentationOptions() {
    try {
      const empty = { presentation: [], authorizations: [] }
      const [activityPrompt, memberPrompt, couponPrompt] = await Promise.all([
        getWechatNotificationPrompt('activity_registration').catch(() => empty),
        getWechatNotificationPrompt('member_card').catch(() => empty),
        getWechatNotificationPrompt('coupon_open').catch(() => empty),
      ])
      const options = buildActivitySubscriptionPresentation(
        extractPromptPresentation(activityPrompt),
        extractPromptPresentation(memberPrompt),
        extractPromptPresentation(couponPrompt),
      )
      this._presentationOptions = options
      rememberPresentationOptions('activity_registration', options)
      if (options.length) this.setData({ wechatSubscriptionPresentationOptions: options })
      return options
    } catch (_error) {
      return this.data.wechatSubscriptionPresentationOptions || []
    }
  },

  async offerActivityRegistrationNotifications() {
    const options = this._presentationOptions || this.data.wechatSubscriptionPresentationOptions || []
    await requestWechatSubscription(options, ACTIVITY_REGISTRATION_SUBSCRIBE_TYPES)
    this.preloadWechatSubscriptionPresentationOptions().catch(() => {})
  },

  async register() {
    const activity = this.data.activity
    if (!activity || this.data.busy) return
    if (!this.data.membership) {
      this.setData({ membershipInviteVisible: true, membershipInviteAgreed: false, error: '' })
      return
    }
    const chosenPackage = this.data.selectedPackage
    if (activity.packageSelectionRequired && !chosenPackage) {
      return this.setData({ error: '请先选择一个活动套餐后再报名。' })
    }
    if (chosenPackage && chosenPackage.availability !== 'available') {
      return this.setData({ error: '所选套餐当前不可报名，请换一档后再试。' })
    }
    const pricing = pricingFor(activity, chosenPackage, this.data.partySize)
    if (activity.registrationBlocked || pricing.paymentAvailability === 'blocked') {
      return this.setData({ error: activity.paymentBlockedText || '线上付款暂时不可用，本次报名尚未提交。' })
    }
    if (this.data.registration && !this.data.registration.canReRegister) {
      await this.showRegistrationOutcome(this.data.registration)
      return
    }
    const attempts = storageObject(REGISTRATION_ATTEMPTS_KEY)
    const previous = attempts[activity.publicId]
    if (typeof previous === 'string') {
      const recovered = await this.recoverRegistration(activity.publicId, null)
      if (recovered) return
      this.clearRegistrationAttempt(activity.publicId)
      this.setData({ error: '上一次报名记录已失效，请重新填写手机号后报名。' })
      return
    }
    if (previous && typeof previous === 'object' && previous.payload && !validCommandKey(previous.idempotencyKey)) {
      this.clearRegistrationAttempt(activity.publicId)
      this.setData({ error: '本次报名记录已过期，请重新填写后报名。' })
      return
    }
    let attempt = previous && previous.payload ? previous : null
    if (attempt && (attempt.payload.activityPackagePublicId || '') !== (chosenPackage?.publicId || '')) {
      this.clearRegistrationAttempt(activity.publicId)
      attempt = null
    }
    if (attempt && registrationAttemptExpired(attempt)) {
      const recovered = await this.recoverRegistration(activity.publicId, attempt)
      if (recovered) return
      this.clearRegistrationAttempt(activity.publicId)
      this.setData({ error: '上次未完成报名已超过 15 分钟，请重新填写手机号后报名。' })
      return
    }
    if (attempt && attempt.payload.contactSnapshot) {
      attempt = Object.assign({}, attempt, { payload: registrationAttemptPayload(attempt.payload) })
      attempts[activity.publicId] = attempt
      wx.setStorageSync(REGISTRATION_ATTEMPTS_KEY, attempts)
    }
    let contact = ''
    if (attempt) {
      contact = registrationContact(this.data.contact)
      if (!contact) {
        return this.focusRegistrationField('contact', '请重新填写本次活动联系手机号，再核对上次报名结果。')
      }
      // Keep the native subscription sheet in this direct customer tap.  Do
      // not wait for the confirmation dialog or a payment/network callback.
      await this.offerActivityRegistrationNotifications()
      const confirmed = await this.confirmPayment('上次报名结果尚未确认。请确认手机号与上次一致；我们会避免重复报名。')
      if (!confirmed) return
    } else {
      contact = registrationContact(this.data.contact)
      if (!contact) {
        return this.focusRegistrationField('contact', '请填写本次活动联系手机号，再继续报名。')
      }
      if (!this.data.ruleAcknowledged) {
        return this.focusRegistrationField('acknowledgement', '请先阅读并确认报名、退款与安全说明。')
      }
      if (!activity.safetyPolicyVersion || !activity.refundPolicyVersion) {
        return this.setData({ error: '活动报名说明暂未准备好，本场暂不开放报名。' })
      }
      // This precedes the payment-choice sheet so it remains a request from
      // the customer's original registration action, as required by WeChat.
      await this.offerActivityRegistrationNotifications()
      const payment = await this.choosePayment(pricing)
      if (!payment) return
      const payload = {
        activityPackagePublicId: chosenPackage?.publicId || null,
        partySize: this.data.partySize,
        termsAcknowledged: true,
        acknowledgedSafetyPolicyVersion: activity.safetyPolicyVersion,
        acknowledgedRefundPolicyVersion: activity.refundPolicyVersion,
        paymentChoice: payment.choice,
        ...(payment.method ? { paymentMethod: payment.method } : {}),
      }
      attempt = {
        idempotencyKey: commandKey('activity-register', `${activity.publicId}-${chosenPackage?.publicId || 'ticket'}`),
        payload: registrationAttemptPayload(payload),
        previousRegistrationPublicId: this.data.registration && this.data.registration.publicId,
        createdAt: new Date().toISOString(),
      }
      attempts[activity.publicId] = attempt
      wx.setStorageSync(REGISTRATION_ATTEMPTS_KEY, attempts)
    }
    let shouldAutoStartPayment = false
    this.setData({ busy: true, error: '', success: '', wechatIdentityRefreshRequired: false })
    try {
      const payload = Object.assign({}, attempt.payload, { contactSnapshot: { channel: 'miniprogram', contact } })
      const result = await registerActivity(
        activity.publicId,
        payload.activityPackagePublicId,
        payload.partySize,
        payload.contactSnapshot,
        payload.termsAcknowledged,
        payload.acknowledgedSafetyPolicyVersion,
        payload.acknowledgedRefundPolicyVersion,
        payload.paymentChoice,
        payload.paymentMethod,
        attempt.idempotencyKey,
      )
      this.clearRegistrationAttempt(activity.publicId)
      let registrationRaw = Object.assign({}, result, { activityPublicId: activity.publicId, createdAt: result.createdAt || new Date().toISOString() })
      if (result.payment && !registrationRaw.amountDueMinor) registrationRaw.amountDueMinor = result.payment.amountMinor
      const registration = await this.readPaymentState(registrationRaw)
      this.rememberRegistration(registration, activity.publicId)
      this.setData({ registration })
      await this.refreshActivityAvailability()
      // A required online-payment choice is made before the registration is
      // created. Once the service returns its idempotent registration record,
      // immediately present the matching WeChat payment sheet instead of
      // making the customer tap a second “continue payment” button.
      shouldAutoStartPayment = Boolean(registration && registration.canStartPayment && payload.paymentChoice !== 'none')
      if (shouldAutoStartPayment) {
        this.setData({ success: '名额已暂留，正在打开微信支付。' })
      } else {
        const success = result.status === 'waitlisted'
          ? '已加入候补名单，会按报名顺序依次安排；现在无需付款。'
          : result.status === 'confirmed'
            ? '报名成功，名额已为您确认。'
            : '报名已提交，请在“我的”活动中查看进展。'
        this.setData({ success })
        await this.showRegistrationOutcome(registration)
      }
    } catch (error) {
      const recovered = await this.recoverRegistration(activity.publicId, attempt)
      if (recovered) return
      if (error && error.code === 'WECHAT_IDENTITY_REQUIRED') {
        // Paid-activity identity is checked before any registration, capacity,
        // inventory, or payment write. Do not leave a misleading retry record.
        this.clearRegistrationAttempt(activity.publicId)
        this.setData({
          wechatIdentityRefreshRequired: true,
          error: '微信支付身份需要刷新。本次报名尚未创建，也没有占用名额；请点击下方按钮刷新身份后重新提交。',
        })
        return
      }
      const detail = registrationFailureMessage(error)
      if (shouldClearRegistrationAttempt(error)) {
        this.clearRegistrationAttempt(activity.publicId)
        this.setData({ error: `${detail} 请按提示调整后重新报名。` })
        return
      }
      // 未知/网络类错误：保留幂等键重试，但展示真实原因，避免永远只看到笼统文案。
      this.setData({ error: `${detail} 请在 15 分钟内重新填写相同手机号后再试；我们会避免重复报名。` })
    } finally { this.setData({ busy: false }) }
    if (shouldAutoStartPayment) await this.startPayment()
  },

  async choosePayment(item) {
    const choices = list(item.availablePaymentChoices)
    const canUseJsapi = list(item.availablePaymentMethods).includes('jsapi')
    const multiplier = item.feeBasis === 'per_person' ? this.data.partySize : 1
    const options = []
    if (choices.includes('deposit') && canUseJsapi) options.push({ choice: 'deposit', method: 'jsapi', label: `微信支付订金 ${money(item.depositAmountMinor * multiplier)}` })
    if (choices.includes('full') && canUseJsapi) options.push({ choice: 'full', method: 'jsapi', label: `微信支付全款 ${money(item.feeAmountMinor * multiplier)}` })
    if (choices.includes('none') || item.paymentMode === 'none' || !item.feeAmountMinor) options.push({ choice: 'none', method: null, label: item.feeAmountMinor ? '不预付，按活动规则报名' : '免费报名' })
    if (!options.length) {
      this.setData({ error: '线上付款暂时不可用，本次报名尚未提交。' })
      return null
    }
    // The primary CTA already states “提交报名并支付”, and the customer has
    // explicitly acknowledged the activity and refund rules. For one required
    // payment option, go straight to the platform payment sheet after the
    // server creates the registration; only show a chooser when there is a
    // genuine payment decision such as optional deposit versus no prepayment.
    if (options.length === 1) return options[0]
    return new Promise((resolve) => wx.showActionSheet({
      itemList: options.map((option) => option.label), success: (result) => resolve(options[result.tapIndex] || null), fail: () => resolve(null),
    }))
  },

  confirmPayment(content) {
    return new Promise((resolve) => wx.showModal({ title: '确认本次报名', content, confirmText: '继续', success: (result) => resolve(result.confirm), fail: () => resolve(false) }))
  },

  showRegistrationOutcome(registration) {
    if (!registration) return Promise.resolve()
    const status = registration.status
    const content = status === 'confirmed'
      ? '报名成功，名额已为您确认。活动详情与签到安排可在“我的活动”中查看。'
      : ['reserved', 'payment_pending'].includes(status)
        ? `名额已暂留${registration.seatHoldText ? `至 ${registration.seatHoldText}` : ''}。完成付款后才算报名成功。`
        : status === 'waitlisted'
          ? '你已进入候补名单。我们会按报名时间依次安排；当前无需付款。'
          : registration.stateGuide || '报名状态已更新，可在“我的活动”中查看。'
    const title = status === 'confirmed' ? '报名成功' : status === 'waitlisted' ? '已加入候补' : '报名状态已更新'
    return new Promise((resolve) => wx.showModal({
      title,
      content,
      confirmText: '我的活动',
      cancelText: '留在本页',
      success: (result) => {
        if (result.confirm) wx.switchTab({ url: '/pages/profile/index' })
        resolve()
      },
      fail: () => resolve(),
    }))
  },

  async readPaymentState(registrationRaw) {
    if (!registrationRaw || !registrationRaw.publicId || registrationRaw.status === 'cancelled') return viewRegistration(registrationRaw)
    try {
      const paymentState = await getActivityRegistrationPayment(registrationRaw.publicId)
      return viewRegistration(Object.assign({}, registrationRaw, paymentState, { status: paymentState.registrationStatus || registrationRaw.status }))
    } catch (error) {
      this.setData({ error: `报名已记录，但付款状态暂时无法核对：${customerErrorMessage(error, '请稍后刷新')}` })
      return viewRegistration(registrationRaw)
    }
  },

  async refreshActivityAvailability() {
    try {
      const raw = await getActivity(this.data.id)
      if (raw) this.setData({ activity: viewActivity(raw) })
    } catch (_error) {
      // 报名状态已由报名接口确认；名额显示会在下次进入页面时再以服务端数据刷新。
    }
  },

  async recoverRegistration(activityPublicId, attempt) {
    try {
      const registrations = await getActivityRegistrations()
      const found = (registrations || []).find((item) => item.activityPublicId === activityPublicId)
      if (!found) return false
      if (attempt && attempt.previousRegistrationPublicId === found.publicId && found.status === 'cancelled') return false
      const registration = await this.readPaymentState(found)
      this.clearRegistrationAttempt(activityPublicId)
      this.rememberRegistration(registration, activityPublicId)
      this.setData({ registration, success: '已找回刚才的报名记录，没有重复提交。', error: '' })
      await this.refreshActivityAvailability()
      await this.showRegistrationOutcome(registration)
      return true
    } catch (_error) { return false }
  },

  async startPayment() {
    const registration = this.data.registration
    if (!registration || !registration.canStartPayment || this.data.busy) return
    const stored = storageObject(PAYMENT_ACTION_ATTEMPTS_KEY)
    const current = stored[registration.publicId]
    const paymentPublicId = registration.payment && (registration.payment.publicId || registration.payment.paymentPublicId)
    const attempt = current && validCommandKey(current.idempotencyKey) && (!paymentPublicId || current.paymentPublicId === paymentPublicId)
      ? current
      : { idempotencyKey: commandKey('activity-payment', registration.publicId), paymentPublicId: paymentPublicId || '', createdAt: new Date().toISOString() }
    stored[registration.publicId] = attempt
    wx.setStorageSync(PAYMENT_ACTION_ATTEMPTS_KEY, stored)
    this.setData({ busy: true, error: '', success: '', wechatIdentityRefreshRequired: false })
    try {
      const result = await startActivityRegistrationPayment(registration.publicId, attempt.idempotencyKey)
      const action = result && (result.providerAction || result)
      if (!action || action.status !== 'pending') {
        await this.refreshPaymentState()
        this.setData({ error: action && action.status === 'unknown' ? '付款结果暂时未知，请先查单。' : '支付通道没有建立可执行动作，本页不会显示付款成功。' })
        return
      }
      if (action.presentation !== 'jsapi') {
        this.setData({ error: '支付通道返回的不是小程序微信支付，本页不会用二维码或模拟结果替代。请联系活动负责人。' })
        return
      }
      const payload = jsapiPayload(action.payload)
      if (!payload) {
        this.setData({ error: '微信支付参数不完整，本页没有发起付款，也不会显示成功。' })
        return
      }
      try {
        await new Promise((resolve, reject) => wx.requestPayment(Object.assign({}, payload, { success: resolve, fail: reject })))
        this.setData({ success: '支付请求已提交，正在向支付通道核对最终结果。' })
        await this.performPaymentQuery()
      } catch (error) {
        const cancelled = isWechatCancellation(error)
        if (cancelled) this.setData({ success: '已取消支付，报名仍保留为待付款；可稍后查询或继续处理。', error: '' })
        else this.setData({ error: '支付窗口返回异常，结果尚未确认。请先查单，不要重复报名或重复付款。' })
        await this.refreshPaymentState(false)
      }
    } catch (error) {
      await this.refreshPaymentState(false)
      const preflightIdentityRequired = Boolean(error && error.code === 'WECHAT_IDENTITY_REQUIRED')
      const rejectedIdentity = Boolean(error && error.code === 'ACTIVITY_PAYMENT_WECHAT_IDENTITY_REJECTED')
      const identityRefreshRequired = preflightIdentityRequired || rejectedIdentity
      const message = preflightIdentityRequired
        ? '报名已保留，付款尚未发起。请点击下方按钮刷新微信身份并继续付款，不要重复报名。'
        : rejectedIdentity
          ? '微信付款身份未通过验证，本次没有扣款。请点击下方按钮刷新身份后重新报名。'
          : customerErrorMessage(error, '支付动作结果暂时无法确认，请先查单，不要重复付款。')
      this.setData({
        wechatIdentityRefreshRequired: identityRefreshRequired,
        error: message,
      })
    } finally { this.setData({ busy: false }) }
  },

  async refreshWechatIdentityAndRetry() {
    if (this.data.busy || !this.data.wechatIdentityRefreshRequired) return
    const resumePayment = Boolean(this.data.registration && this.data.registration.canStartPayment)
    this.setData({ busy: true, error: '', success: '' })
    try {
      // `true` deliberately bypasses the locally cached identity expiry, which
      // makes this a real wx.login recovery step instead of a cosmetic retry.
      await ensureCustomerSession(true)
    } catch (error) {
      this.setData({ error: customerErrorMessage(error, '微信身份暂时无法刷新，请稍后再试。') })
      return
    } finally {
      this.setData({ busy: false })
    }
    this.setData({ wechatIdentityRefreshRequired: false })
    if (resumePayment) return this.startPayment()
    return this.register()
  },

  async queryPayment() {
    if (!this.data.registration || !this.data.registration.canQueryPayment || this.data.busy) return
    this.setData({ busy: true, error: '', success: '' })
    try { await this.performPaymentQuery() } finally { this.setData({ busy: false }) }
  },

  async performPaymentQuery() {
    const registration = this.data.registration
    if (!registration) return
    const stored = storageObject(PAYMENT_QUERY_ATTEMPTS_KEY)
    const current = stored[registration.publicId]
    const attempt = current && validCommandKey(current.idempotencyKey)
      ? current
      : { idempotencyKey: commandKey('activity-payment-query', registration.publicId), createdAt: new Date().toISOString() }
    stored[registration.publicId] = attempt
    wx.setStorageSync(PAYMENT_QUERY_ATTEMPTS_KEY, stored)
    try {
      const state = await queryActivityRegistrationPayment(registration.publicId, attempt.idempotencyKey)
      delete stored[registration.publicId]
      wx.setStorageSync(PAYMENT_QUERY_ATTEMPTS_KEY, stored)
      const next = viewRegistration(Object.assign({}, registration, state, { status: state.registrationStatus || registration.status }))
      this.rememberRegistration(next)
      this.setData({ registration: next })
      if (next.resolutionState === 'confirmed') this.setData({ success: '付款已经由支付通道确认，报名正式生效。', error: '' })
      else if (next.resolutionState === 'unknown') this.setData({ error: '支付通道暂未给出确定结果，名额继续保留；稍后只能继续查单。' })
      else if (next.resolutionState === 'failed') this.setData({ error: '支付通道已明确返回失败，可按页面允许的动作取消报名。' })
      else if (next.resolutionState === 'refunded') this.setData({ success: '退款状态已确认。', error: '' })
      else this.setData({ success: '付款状态已更新。', error: '' })
    } catch (error) { this.setData({ error: customerErrorMessage(error, '查单结果暂时无法确认；本页不会重建报名或重复付款。') }) }
  },

  async refreshPaymentState(showError = true) {
    const registration = this.data.registration
    if (!registration || !registration.publicId) return
    try {
      const state = await getActivityRegistrationPayment(registration.publicId)
      const next = viewRegistration(Object.assign({}, registration, state, { status: state.registrationStatus || registration.status }))
      this.rememberRegistration(next)
      this.setData({ registration: next })
    } catch (error) { if (showError) this.setData({ error: customerErrorMessage(error, '付款状态暂时无法读取') }) }
  },

  async cancelRegistration() {
    const registration = this.data.registration
    if (!registration || this.data.busy) return
    if (!registration.canCancelDirectly) return this.showCancellationHelp()
    const confirmed = await new Promise((resolve) => wx.showModal({ title: '取消报名', content: '仅未付款且仍可取消的报名会释放名额。确认取消吗？', confirmColor: '#873e30', success: (result) => resolve(result.confirm), fail: () => resolve(false) }))
    if (!confirmed) return
    const reason = '顾客在小程序主动取消未付款报名'
    const stored = storageObject(CANCELLATION_ATTEMPTS_KEY)
    const current = stored[registration.publicId]
    const attempt = current && validCommandKey(current.idempotencyKey)
      ? current
      : { idempotencyKey: commandKey('activity-cancel', registration.publicId), reason, createdAt: new Date().toISOString() }
    stored[registration.publicId] = attempt
    wx.setStorageSync(CANCELLATION_ATTEMPTS_KEY, stored)
    this.setData({ busy: true, error: '', success: '' })
    try {
      await cancelActivityRegistration(registration.publicId, attempt.reason, attempt.idempotencyKey)
      delete stored[registration.publicId]
      wx.setStorageSync(CANCELLATION_ATTEMPTS_KEY, stored)
      const next = viewRegistration(Object.assign({}, registration, { status: 'cancelled', registrationStatus: 'cancelled', allowedActions: [] }))
      this.rememberRegistration(next)
      this.setData({ registration: next, success: '报名已经取消，是否重新报名将以当前活动名额和规则重新判断。' })
      await this.refreshActivityAvailability()
    } catch (error) {
      if (['PAYMENT_RESULT_UNKNOWN', 'ACTIVITY_PAYMENT_RESULT_UNKNOWN', 'ACTIVITY_PAID_CANCELLATION_REQUIRES_REFUND_WORKFLOW'].includes(error.code)) await this.refreshPaymentState(false)
      this.setData({ error: ['PAYMENT_RESULT_UNKNOWN', 'ACTIVITY_PAYMENT_RESULT_UNKNOWN'].includes(error.code)
        ? '付款结果未知，当前不能取消；请先查单。'
        : error.code === 'ACTIVITY_PAID_CANCELLATION_REQUIRES_REFUND_WORKFLOW'
          ? '该报名已经付款，暂不能直接取消；如需退款，请联系门店协助。'
          : customerErrorMessage(error, '当前报名无法取消，请稍后重试或联系活动负责人。') })
    } finally { this.setData({ busy: false }) }
  },

  showCancellationHelp() {
    const contact = this.data.activity.contactInstructions || '请联系活动负责人核对。'
    wx.showModal({ title: '取消与退款说明', content: `已付款报名如需退款，请联系门店；退款进展会显示在这里。${contact}`, showCancel: false })
  },

  clearRegistrationAttempt(activityPublicId) {
    const attempts = storageObject(REGISTRATION_ATTEMPTS_KEY)
    delete attempts[activityPublicId]
    wx.setStorageSync(REGISTRATION_ATTEMPTS_KEY, attempts)
  },

  rememberRegistration(registration, activityPublicId) {
    if (!registration) return
    const stored = storageObject(LOCAL_REGISTRATIONS_KEY)
    stored[activityPublicId || this.data.id] = registration
    wx.setStorageSync(LOCAL_REGISTRATIONS_KEY, stored)
  },
})
