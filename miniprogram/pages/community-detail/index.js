const {
  getActivity,
  getActivityPreview,
  getActivityLoyaltyBenefits,
  getActivityRegistrations,
  getActivityRegistrationServiceCode,
  updateActivityRegistrationPartySize,
  requestActivityRegistrationRefund,
  getActivityAddonProducts,
  resolveActivityParent,
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
const REFUND_ATTEMPTS_KEY = 'mbox.community.registration.refund-requests.v1'
const PARTY_SIZE_ATTEMPTS_KEY = 'mbox.community.registration.party-size.v1'
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
  requested: '退款申请已提交，等待门店审核', approved: '退款处理中，尚未确认到账', processing: '退款处理中，尚未确认到账',
  succeeded: '退款已完成', failed: '退款暂未完成，尚未确认到账，请联系门店核对', rejected: '退款申请未通过', cancelled: '退款申请已撤销',
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
    ...(payload.purchaseKind ? { purchaseKind: payload.purchaseKind, parentRegistrationPublicId: payload.parentRegistrationPublicId || null } : {}),
    ...(payload.parentCredentialRequired ? { parentCredentialRequired: true } : {}),
    ...(payload.productId ? { productId: payload.productId, quantity: Number(payload.quantity || 1) } : {}),
    ...(Array.isArray(payload.selections) ? { selections: payload.selections.map(item => ({ groupId: String(item.groupId), productId: String(item.productId) })) } : {}),
    ...(payload.note ? { note: String(payload.note).slice(0, 200) } : {}),
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
    isServicePackage: Number(raw && raw.maxParticipants) > 0,
    feeText: Number(raw && raw.maxParticipants) > 0 ? `${money(feeAmountMinor)}/份` : feeAmountMinor > 0 ? `加购 ${money(feeAmountMinor)}${raw.feeBasis === 'per_person' ? '/人' : '/次'}` : '免费加购',
    mealOnlyFeeText: raw && (raw.includesAdmission === false || raw.mealOnlyFeeAmountMinor != null) ? `${money(Number(raw.includesAdmission === false ? raw.feeAmountMinor : raw.mealOnlyFeeAmountMinor))}/份` : '',
    includedItems: list(raw && raw.includedItems),
    choiceGroups: Array.isArray(raw && raw.choiceGroups) ? raw.choiceGroups : [],
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

function pricingFor(activity, activityPackage, partySize, purchaseKind, product, quantity) {
  if ((activityPackage && Number(activityPackage.maxParticipants) > 0) || purchaseKind === 'single_dish') {
    const fee = purchaseKind === 'single_dish' ? Number(product && product.priceAmountMinor || 0) * Math.max(1, Number(quantity || 1))
      : Number(purchaseKind === 'meal_package' && activityPackage.includesAdmission !== false ? activityPackage.mealOnlyFeeAmountMinor : activityPackage.feeAmountMinor)
    const methods = list(activity.availablePaymentMethods)
    const available = activity.paymentAvailability === 'available' && methods.length > 0
    const productAvailable = purchaseKind !== 'single_dish' || Boolean(product && product.sellable !== false && product.priceAmountMinor != null)
    return { feeAmountMinor: fee, depositAmountMinor: 0, paymentMode: fee > 0 ? 'full_required' : 'none',
      paymentDeadlineMinutes: Number(activityPackage && activityPackage.paymentDeadlineMinutes || activity.paymentDeadlineMinutes || 15),
      paymentAvailability: productAvailable && (fee === 0 || available) ? 'available' : 'blocked',
      availablePaymentChoices: !productAvailable ? [] : fee === 0 ? ['none'] : available ? ['full'] : [], availablePaymentMethods: methods,
      paymentRuleText: purchaseKind === 'single_dish' ? '单点加到所选套餐号码，单独付款' : purchaseKind === 'meal_package' ? '仅加餐，不增加入场名额；另领一个取餐号' : '每份按套餐总价付款，人数不改变本份价格',
      deadlineText: fee === 0 ? '无需在线付款' : `${Number(activityPackage && activityPackage.paymentDeadlineMinutes || activity.paymentDeadlineMinutes || 15)} 分钟`,
      requiresPaymentOnSubmit: productAvailable && fee > 0, feeText: productAvailable ? money(fee) : '暂不可购买', depositText: '无需订金' }
  }
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
  if (Number(activityPackage && activityPackage.maxParticipants) > 0) return Number(activityPackage.maxParticipants)
  const limits = [Number(activity && activity.remainingCapacity || 0)]
  if (activityPackage) limits.push(Number(activityPackage.remainingCapacity || 0))
  const valid = limits.filter((value) => Number.isFinite(value) && value > 0)
  return valid.length ? Math.max(1, Math.min(...valid)) : 1
}

function packageChoiceGroups(activityPackage, selections) {
  return (activityPackage && activityPackage.choiceGroups || []).map(group => {
    const options = Array.isArray(group.options) ? group.options : []
    const saved = (selections || []).find(item => item.groupId === group.id)
    return Object.assign({}, group, { options, selectedProductId: saved ? saved.productId : options.length === 1 ? options[0].productId : '' })
  })
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
    selectedChoiceGroups: packageChoiceGroups(currentPackage),
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
  const registrationStopped = Boolean(raw.registrationClosedAt)
  const registrationBlocked = !isSharePreview && (registrationStopped || providerBlocked || clientPaymentBlocked || !safetyPolicyVersion || !refundPolicyVersion)
  const safetyFacts = []
  if (safety.difficulty) safetyFacts.push(`难度：${safety.difficulty}`)
  if (safety.ageRequirement) safetyFacts.push(`年龄：${safety.ageRequirement}`)
  if (safety.insuranceIncluded !== undefined) safetyFacts.push(safety.insuranceIncluded ? '活动包含保险' : '活动不包含保险')
  let paymentBlockedText = ''
  if (registrationStopped) paymentBlockedText = '已停止新报名；原报名、付款和退款仍可继续处理。'
  else if (providerBlocked) paymentBlockedText = '线上付款暂时不可用，暂时不能报名。'
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
    hasServicePackages: packages.some((item) => Number(item.maxParticipants) > 0),
    isSharePreview,
    availabilityText: registrationStopped ? '已停止新报名' : String(raw.availabilityText || (raw.remainingCapacity > 0 ? '可报名' : '暂不可订')),
    packageSelectionRequired: Boolean(raw.packageSelectionRequired),
    requiresPaymentOnSubmit: raw.feeAmountMinor > 0 && !availablePaymentChoices.includes('none'),
    safetyFacts,
    registrationBlocked,
    addonBlocked: !safetyPolicyVersion || !refundPolicyVersion || (raw.addonEndsAt || raw.mealServiceEndsAt || raw.endsAt ? Date.parse(raw.addonEndsAt || raw.mealServiceEndsAt || raw.endsAt) <= Date.now() : true),
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
  const serviceRefundDisposition = raw.serviceRefundDisposition === undefined ? payment.serviceRefundDisposition : raw.serviceRefundDisposition
  const retainedService = ['retain_fulfillment', 'stop_unstarted'].includes(serviceRefundDisposition) && ['confirmed', 'checked_in'].includes(status)
  const hasServiceFlow = raw.serviceVersion === 3 || Number(raw.maxParticipants) > 0 || Number(raw.activityPackage && raw.activityPackage.maxParticipants) > 0 || Boolean(raw.purchaseKind)
  const refundEligibility = Object.prototype.hasOwnProperty.call(raw, 'canRequestFullRefund') ? raw.canRequestFullRefund : payment.canRequestFullRefund
  const refundRequestBlockReason = String((Object.prototype.hasOwnProperty.call(raw, 'refundRequestBlockReason') ? raw.refundRequestBlockReason : payment.refundRequestBlockReason) || '').trim()
  const refundRejectionReason = refundStatus === 'rejected' ? String((Object.prototype.hasOwnProperty.call(raw, 'refundRejectionReason') ? raw.refundRejectionReason : payment.refundRejectionReason) || '').trim() : ''
  const refundInProgress = ['requested', 'approved', 'processing'].includes(refundStatus) || ['refund_requested', 'refunding'].includes(resolutionState)
  const compensation = ['retain_fulfillment', 'stop_unstarted'].includes(serviceRefundDisposition)
  const storedRefundAttempt = storageObject(REFUND_ATTEMPTS_KEY)[raw.publicId]
  const hasUnconfirmedRefundAttempt = Boolean(storedRefundAttempt && !storedRefundAttempt.refundPublicId)
  const showFullRefundRequest = hasServiceFlow && refundEligibility === true && paidAmountMinor > 0 && !refundInProgress && !refundComplete && !compensation
  let refundGuidance = ''
  let showRefundContact = false
  if (hasUnconfirmedRefundAttempt) {
    refundGuidance = '原退订申请结果尚未确认，请核对原申请；不会新建重复申请。'
  } else if (refundStatus === 'succeeded' || (!refundStatus && resolutionState === 'refunded')) {
    refundGuidance = compensation ? '本次补偿退款已完成；原入场、餐号和已使用记录保留，剩余履约按已确认安排处理。' : '退款已完成；是否可以重新报名，仍需符合当前活动名额、时间和报名规则。'
  } else if (refundInProgress) {
    // The status label supplies the authoritative review/processing stage.
  } else if (showFullRefundRequest) {
    refundGuidance = refundStatus === 'rejected' ? '如仍需退订，可再次申请本份整单退订，由门店重新审核。' : '可申请本份整单退订，提交后等待门店审核；申请不代表退款已到账。'
  } else if ((!hasServiceFlow || refundRequestBlockReason === 'legacy_registration') && (paidAmountMinor > 0 || manualStates.includes(resolutionState))) {
    refundGuidance = '这是一笔旧版报名，如需退款，请联系门店办理；退款进展会显示在这里。'
    showRefundContact = !refundComplete
  } else if (hasServiceFlow && (paidAmountMinor > 0 || manualStates.includes(resolutionState))) {
    refundGuidance = ['rights_used', 'active_addons', 'compensation_review_required'].includes(refundRequestBlockReason)
      ? '本份已有入场、核销、关联加购或补偿安排，请联系门店核对已使用内容及退款安排。'
      : typeof refundEligibility !== 'boolean'
        ? '退订资格暂未确认，请刷新本页核对；如仍无法确认，请联系门店。'
        : '当前报名或付款状态暂不支持本份整单退订，请刷新核对；需要协助时请联系门店。'
    showRefundContact = true
  }
  const canAddPurchase = ['confirmed', 'checked_in'].includes(status) && !['refund_requested', 'refunding', 'unknown'].includes(resolutionState) && (resolutionState !== 'refunded' || retainedService) && !['requested', 'approved', 'processing'].includes(refundStatus)
  const stateGuide = retainedService ? (serviceRefundDisposition === 'stop_unstarted' ? '补偿退款按已确认的停止未制作安排处理；原入场、餐号及已制作记录保留。' : '补偿退款与原约定履约分开记录；原入场与餐饮权益按约继续使用。') : status === 'confirmed'
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
    refundStatus, serviceRefundDisposition,
    refundStatusText: hasUnconfirmedRefundAttempt ? '原退订申请结果待核对，尚未确认退款到账' : refundStatus === 'succeeded' && compensation ? '补偿退款已完成' : REFUND_STATUS_NAMES[refundStatus] || '',
    refundRejectionReason: hasUnconfirmedRefundAttempt ? '' : refundRejectionReason, refundRequestBlockReason, refundGuidance, showFullRefundRequest, showRefundContact, hasUnconfirmedRefundAttempt,
    allowedActions,
    canStartPayment: !retainedService && allowedActions.includes('start_payment'),
    canQueryPayment: allowedActions.includes('query_payment'),
    canCancelDirectly: !retainedService && allowedActions.includes('cancel_registration'),
    requiresManualCancellation: !refundComplete && (paidAmountMinor > 0 || manualStates.includes(resolutionState)),
    canReRegister: (['cancelled', 'expired'].includes(status) && !manualStates.includes(resolutionState)) || (['cancelled', 'refunded'].includes(status) && refundComplete),
    canAddPurchase, canUseService: retainedService || canAddPurchase, canAttemptFullRefund: canAddPurchase && !retainedService, canRequestFullRefund: refundEligibility,
    hasServiceFlow,
    purchaseText: raw.purchaseKind === 'single_dish' ? '单点加购' : raw.purchaseKind === 'meal_package' ? '仅加餐套餐' : '活动报名',
    packageText: raw.activityPackage && raw.activityPackage.name || raw.packageName || '',
    selectionSummary: (Array.isArray(raw.selections) ? raw.selections : []).filter(item => item && item.name).map(item => `${item.label ? item.label + '：' : ''}${item.name} × ${item.quantity}`),
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
    selectedPackagePublicId: '', selectedPackage: null, selectedPricing: null, selectedChoiceGroups: [], packageNote: '',
    registrations: [], registrationReadFailed: false, selectedRegistrationPublicId: '', creatingPurchase: false,
    purchaseKind: 'admission_package', parentRegistrationPublicId: '', parentCredentialRequired: false, parentPreview: null, ownParentRegistrationPublicId: '', addonProducts: [], selectedAddonProduct: null, selectedAddonProductId: '', addonQuantity: 1,
    serviceCode: null, serviceBusy: false, serviceError: '', registeredPartySizeDraft: '',
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
    this.setData({ id: shareActivityId(options && options.id), shareSource: source, memberAccessRequested: false, selectedRegistrationPublicId: shareActivityId(options && options.registrationId) })
  },
  onHide() { this.pageVisible = false; this.invalidateReads() },
  onUnload() { this.parentScanIntent = null; this.pageVisible = false; this.invalidateReads() },
  invalidateReads() {
    this.stopAddonMenuRefresh()
    this.parentPurchaseCredential = null
    this.serviceGeneration = (this.serviceGeneration || 0) + 1
    this.selectionGeneration = (this.selectionGeneration || 0) + 1
    this.pageGeneration = (this.pageGeneration || 0) + 1
    this.readGeneration = (this.readGeneration || 0) + 1
    this.presentationGeneration = (this.presentationGeneration || 0) + 1
    if (this.registrationFocusTimer) clearTimeout(this.registrationFocusTimer)
    this._presentationOptions = []
    // An already-issued payment must retain its registration for reconciliation.
    // New reads and pre-submit continuations are invalidated independently.
    if (!this.data.busy) this.setData({ membership: null, registration: null, registrations: [], serviceCode: null, serviceError: '', loyaltyBenefits: [], membershipInviteBusy: false })
  },
  onShow() { this.pageVisible = true; enablePublicShareMenu(); if (!this.data.busy) this.load() },

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
    const generation = this.readGeneration = (this.readGeneration || 0) + 1
    this.setData({ loading: true, error: '', success: '', membership: null, registration: null, loyaltyBenefits: [] })
    try {
      if (!this.data.id) {
        this.setData({ loading: false, activity: null, membershipInviteVisible: false, error: '活动入口无效，请返回活动列表重新选择' })
        return
      }
      if (this.data.shareSource === 'share' && !this.data.memberAccessRequested) {
        await this.loadAnonymousSharePreview(false, generation)
        return
      }
      const bootstrap = await getMiniBootstrap()
      if (generation !== this.readGeneration) return
      const membership = bootstrap.membership || null
      const membershipTerms = bootstrap.membershipTerms || null
      this.setData({ membership, membershipTerms })
      if (!membership) {
        if (!membershipTerms || !membershipTerms.title) {
          this.setData({ loading: false, membershipInviteVisible: false, membershipInviteAgreed: false, error: '会员条款暂时不可用，请稍后重试或返回活动列表' })
          return
        }
        if (this.data.shareSource === 'share') {
          await this.loadAnonymousSharePreview(Boolean(membershipTerms), generation)
          if (!membershipTerms) this.setData({ error: '当前会员协议暂时无法读取，请稍后再试。' })
          return
        }
        // Verify the public activity exists before asking the guest to join.
        await this.loadAnonymousSharePreview(true, generation)
        return
      }
      const [raw, activityPrompt, memberPrompt, couponPrompt] = await Promise.all([
        getActivity(this.data.id),
        getWechatNotificationPrompt('activity_registration').catch(() => ({ authorizations: [] })),
        getWechatNotificationPrompt('member_card').catch(() => ({ authorizations: [] })),
        getWechatNotificationPrompt('coupon_open').catch(() => ({ authorizations: [] })),
        this.preloadWechatSubscriptionPresentationOptions(),
      ])
      if (generation !== this.readGeneration) return
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
      if (generation !== this.readGeneration) return
      let registrations = []
      let registrationReadError = ''
      try { registrations = await getActivityRegistrations() } catch (error) { registrationReadError = customerErrorMessage(error, '报名记录暂时无法读取') }
      if (generation !== this.readGeneration) return
      const local = storageObject(LOCAL_REGISTRATIONS_KEY)
      const activityRegistrations = (registrations || []).filter((item) => item.activityPublicId === raw.publicId)
      const pending = storageObject(REGISTRATION_ATTEMPTS_KEY)[raw.publicId]
      const recovered = pending && activityRegistrations.find((item) => item.registrationRequestIdempotencyKey === pending.idempotencyKey)
      const pendingParent = pending && pending.payload && pending.payload.parentRegistrationPublicId
      const authoritative = recovered || activityRegistrations.find((item) => item.publicId === pendingParent) || activityRegistrations.find((item) => item.publicId === this.data.selectedRegistrationPublicId) || activityRegistrations[0]
      let registrationRaw = authoritative || (registrationReadError ? local[raw.publicId] : null) || null
      let paymentReadError = ''
      if (registrationRaw && registrationRaw.publicId) {
        try {
          const paymentState = await getActivityRegistrationPayment(registrationRaw.publicId)
          registrationRaw = Object.assign({}, registrationRaw, paymentState, {
            canRequestFullRefund: paymentState.canRequestFullRefund, refundRequestBlockReason: paymentState.refundRequestBlockReason, refundRejectionReason: paymentState.refundRejectionReason,
            status: paymentState.registrationStatus || registrationRaw.status,
          })
        } catch (error) {
          registrationRaw = Object.assign({}, registrationRaw, { canRequestFullRefund: undefined, refundRequestBlockReason: undefined, refundRejectionReason: undefined })
          paymentReadError = customerErrorMessage(error, '付款状态暂时无法读取')
        }
      }
      if (generation !== this.readGeneration) return
      const pendingAttempt = storageObject(REGISTRATION_ATTEMPTS_KEY)[raw.publicId]
      if (recovered || (authoritative && !pendingAttempt)) this.clearRegistrationAttempt(raw.publicId)
      const registration = viewRegistration(registrationRaw)
      if (registration) this.rememberRegistration(registration, raw.publicId)
      const activity = viewActivity(raw)
      this.setData({
        loading: false, activity, loyaltyBenefits, registration, registrations: activityRegistrations.map(viewRegistration), registrationReadFailed: Boolean(registrationReadError),
        selectedRegistrationPublicId: registration && registration.publicId || '',
        creatingPurchase: Boolean(pendingAttempt && !recovered && pendingAttempt.payload && pendingAttempt.payload.purchaseKind),
        serviceCode: null, serviceError: '', error: paymentReadError || registrationReadError,
        previewOnly: false,
        membershipInviteVisible: false,
        wechatNotificationPromptOptions: notificationPrompt.authorizations || [],
        wechatSubscriptionPresentationOptions: notificationPrompt.presentation || [],
        ...activitySelection(activity, this.data.selectedPackagePublicId, this.data.partySize),
      })
      if (pendingAttempt && !recovered && pendingAttempt.payload) await this.restorePurchaseAttempt(pendingAttempt)
      if (registration) await this.loadServiceCode()
      rememberPresentationOptions('activity_registration', notificationPrompt.presentation || [])
    } catch (error) {
      if (generation !== this.readGeneration) return
      if (error && error.code === 'ACTIVITY_MEMBERSHIP_REQUIRED') {
        this.setData({
          loading: false,
          activity: null,
          registration: null,
          membership: null,
          membershipInviteVisible: Boolean(this.data.membershipTerms && this.data.membershipTerms.title),
          membershipInviteAgreed: false,
          error: this.data.membershipTerms && this.data.membershipTerms.title ? '' : '会员条款暂时不可用，请稍后重试',
        })
        return
      }
      this.setData({
        loading: false, error: customerErrorMessage(error, '活动详情暂时无法读取'),
        wechatNotificationPromptOptions: [],
      })
    }
  },

  async loadAnonymousSharePreview(showMembershipInvite, generation = this.readGeneration) {
    const raw = await getActivityPreview(this.data.id)
    if (generation !== this.readGeneration) return
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
      if (!this.data.membershipTerms || !this.data.membershipTerms.title) wx.showToast({ title: '当前会员协议暂时无法读取', icon: 'none' })
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
    const generation = this.pageGeneration || 0
    this.setData({ membershipInviteBusy: true, error: '' })
    try {
      const result = await enrollMembership(terms.version, 'mini_community', authorization.code)
      if (generation !== (this.pageGeneration || 0)) return
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
      if (generation !== (this.pageGeneration || 0)) return
      this.setData({ membershipInviteBusy: false, error: customerErrorMessage(error, '入会暂时没有完成') })
      wx.showToast({ title: customerErrorMessage(error, '入会未完成'), icon: 'none' })
    }
  },

  onRegisteredPartySizeInput(event) {
    if (this.data.busy) return
    this.setData({ registeredPartySizeDraft: String(event.detail.value || '').replace(/\D/g, '').slice(0, 3) })
  },

  async saveRegisteredPartySize() {
    const registration = this.data.registration
    const service = this.data.serviceCode && this.data.serviceCode.service
    if (this.data.busy || !registration || !service || !service.includesAdmission || service.meal) return
    const partySize = Number(this.data.registeredPartySizeDraft)
    const minimum = Math.max(1, Number(service.admittedCount || 0))
    if (!Number.isInteger(partySize) || partySize < minimum || partySize > service.maxParticipants) return this.setData({ error: `本份实际人数应在 ${minimum} 至 ${service.maxParticipants} 人之间，不能少于已入场人数。` })
    const stored = storageObject(PARTY_SIZE_ATTEMPTS_KEY)
    const previous = stored[registration.publicId]
    if (previous && previous.partySize !== partySize) return this.setData({ error: `上次修改为 ${previous.partySize} 人的结果尚未核对，请先恢复该人数再保存。` })
    const attempt = previous || { partySize, idempotencyKey: commandKey('activity-party-size', registration.publicId) }
    stored[registration.publicId] = attempt
    wx.setStorageSync(PARTY_SIZE_ATTEMPTS_KEY, stored)
    this.setData({ busy: true, error: '', success: '' })
    try {
      const result = await updateActivityRegistrationPartySize(registration.publicId, attempt.partySize, attempt.idempotencyKey)
      if (!result || result.partySize !== attempt.partySize) throw new Error('人数修改结果尚未确认，请按原人数重试核对。')
      delete stored[registration.publicId]; wx.setStorageSync(PARTY_SIZE_ATTEMPTS_KEY, stored)
      const next = viewRegistration(Object.assign({}, registration, { partySize: result.partySize }))
      this.rememberRegistration(next)
      if (this.data.registration && this.data.registration.publicId === registration.publicId) {
        this.setData({ registration: next, success: '本份实际参加人数已更新，套餐价格及可入场上限不变。' })
        await this.loadServiceCode()
      }
    } catch (error) { this.setData({ error: customerErrorMessage(error, '人数修改结果尚未确认，请按原人数重试核对。') }) }
    finally { this.setData({ busy: false }) }
  },

  async requestRegistrationRefund() {
    const registration = this.data.registration
    if (this.data.busy || this._refundConfirmPending || !registration || !registration.hasServiceFlow || (!registration.canAttemptFullRefund && !registration.hasUnconfirmedRefundAttempt) || Number(registration.paidAmountMinor || 0) <= 0) return
    this._refundConfirmPending = true
    const generation = this.pageGeneration || 0
    const confirmed = await new Promise(resolve => wx.showModal({ title: registration.hasUnconfirmedRefundAttempt ? '核对原退订申请' : '申请整份退订', content: registration.hasUnconfirmedRefundAttempt ? '将使用原请求核对退订申请，不会新建重复申请。' : '将申请退订当前这一份订单。提交后由门店审核并原路退款；已使用权益或有关联加购时，请先联系门店处理。提交申请不代表退款已到账。', confirmText: registration.hasUnconfirmedRefundAttempt ? '核对原申请' : '提交申请', success: result => resolve(result.confirm), fail: () => resolve(false) }))
    this._refundConfirmPending = false
    if (!confirmed || generation !== (this.pageGeneration || 0) || this.data.busy || !this.data.registration || this.data.registration.publicId !== registration.publicId) return
    this.setData({ busy: true, error: '', success: '' })
    const current = () => generation === (this.pageGeneration || 0) && this.data.registration && this.data.registration.publicId === registration.publicId
    try {
      const state = await getActivityRegistrationPayment(registration.publicId)
      if (!current()) return
      const authoritative = viewRegistration(Object.assign({}, registration, state, { canRequestFullRefund: state.canRequestFullRefund, refundRequestBlockReason: state.refundRequestBlockReason, refundRejectionReason: state.refundRejectionReason, status: state.registrationStatus || registration.status }))
      this.rememberRegistration(authoritative)
      this.setData({ registration: authoritative })
      const stored = storageObject(REFUND_ATTEMPTS_KEY)
      let attempt = stored[registration.publicId]
      // A previous terminal refund must never clear an unknown newer request.
      // Only the exact acknowledged refund can establish a new user intent.
      if (attempt && attempt.refundPublicId && attempt.refundPublicId === state.refundPublicId && ['rejected', 'cancelled'].includes(state.refundStatus)) attempt = null
      if (!(attempt && !attempt.refundPublicId) && (!authoritative.canAttemptFullRefund || state.canRequestFullRefund !== true)) {
        this.setData({ serviceCode: null, success: '已更新退款进展与退订资格；请按当前页面提示继续处理。' })
        return
      }
      if (!attempt) attempt = { idempotencyKey: commandKey('activity-refund-request', registration.publicId), reason: '顾客在小程序申请整份活动订单退订' }
      stored[registration.publicId] = attempt; wx.setStorageSync(REFUND_ATTEMPTS_KEY, stored)
      const result = await requestActivityRegistrationRefund(registration.publicId, attempt.reason, attempt.idempotencyKey)
      if (!result || !result.refundPublicId || result.status !== 'requested') throw new Error('退款申请结果尚未确认，请使用原申请重试核对。')
      attempt.refundPublicId = result.refundPublicId
      const latestStored = storageObject(REFUND_ATTEMPTS_KEY)
      latestStored[registration.publicId] = attempt; wx.setStorageSync(REFUND_ATTEMPTS_KEY, latestStored)
      if (!current()) return
      let next = viewRegistration(Object.assign({}, authoritative, { resolutionState: 'refund_requested', refundStatus: 'requested', refundPublicId: result.refundPublicId, allowedActions: [] }))
      let message = '整份退订申请已提交，等待门店审核；尚未退款到账。'
      try {
        const latest = await getActivityRegistrationPayment(registration.publicId)
        if (!current()) return
        next = viewRegistration(Object.assign({}, authoritative, latest, { canRequestFullRefund: latest.canRequestFullRefund, refundRequestBlockReason: latest.refundRequestBlockReason, refundRejectionReason: latest.refundRejectionReason, status: latest.registrationStatus || authoritative.status }))
        if (latest.refundPublicId === result.refundPublicId && ['rejected', 'cancelled'].includes(latest.refundStatus)) message = next.showFullRefundRequest ? '已核对原申请，原申请已被拒绝或撤销；如仍需退订，可再次点击申请。' : '已核对原申请，原申请已被拒绝或撤销；请按页面提示核对本份退订资格。'
        else if (latest.refundStatus && latest.refundStatus !== 'requested') message = '已更新退款申请进展，请查看当前状态。'
      } catch (_error) { message = '申请已提交，当前审核进度暂时无法读取；请刷新核对，尚未确认退款到账。' }
      this.rememberRegistration(next)
      this.setData({ registration: next, serviceCode: null, success: message })
    } catch (error) {
      if (current()) this.setData({ registration: viewRegistration(this.data.registration), error: customerErrorMessage(error, '退款申请结果尚未确认，请重试原申请核对，不要重复提交其他申请。') })
    } finally { this.setData({ busy: false }) }
  },

  hasPendingPurchase() {
    const pending = storageObject(REGISTRATION_ATTEMPTS_KEY)[this.data.id]
    if (!pending) return false
    this.setData({ error: '上一次提交结果尚未核对，请先按原内容恢复，避免重复购买。' })
    return true
  },

  async restorePurchaseAttempt(attempt) {
    const payload = attempt.payload || {}
    if (!payload.purchaseKind) return
    const selection = activitySelection(this.data.activity, payload.activityPackagePublicId || '', payload.partySize)
    const kind = payload.purchaseKind
    this.setData({ ...selection, selectedChoiceGroups: packageChoiceGroups(selection.selectedPackage, payload.selections), packageNote: payload.note || '', creatingPurchase: true, purchaseKind: kind,
      parentRegistrationPublicId: payload.parentRegistrationPublicId || '', parentCredentialRequired: payload.parentCredentialRequired === true, parentPreview: null, addonQuantity: Number(payload.quantity || 1),
      error: '有一份提交结果尚未核对。请重新填写原手机号，按原内容恢复；不会另建一份。' })
    if (kind === 'single_dish') await this.loadAddonProducts(payload.productId)
    else this.setData({ selectedPricing: pricingFor(this.data.activity, selection.selectedPackage, selection.partySize, kind) })
  },

  async selectRegistration(event) {
    if (this.data.busy) return
    const id = String(event.currentTarget.dataset.registrationId || '')
    const raw = this.data.registrations.find((item) => item.publicId === id)
    if (!raw) return
    this.parentPurchaseCredential = null
    const generation = this.selectionGeneration = (this.selectionGeneration || 0) + 1
    this.setData({ parentPreview: null, parentCredentialRequired: false, selectedRegistrationPublicId: id, registration: raw, creatingPurchase: false, serviceCode: null, serviceError: '', purchaseKind: 'admission_package', parentRegistrationPublicId: '', error: '', success: '' })
    const registration = await this.readPaymentState(raw)
    if (generation !== this.selectionGeneration) return
    this.rememberRegistration(registration)
    this.setData({ registration })
    await this.loadServiceCode()
  },

  async scanParentForAddon() {
    if (this.data.busy || this._registrationPending || this.data.registrationReadFailed) return
    if (!this.data.activity || this.data.activity.addonBlocked) return this.setData({ error: '本场当前不开放加购。' })
    const pending = storageObject(REGISTRATION_ATTEMPTS_KEY)[this.data.id]
    if (pending && !(pending.payload && pending.payload.parentCredentialRequired)) return this.hasPendingPurchase()
    if (!pending && this.data.registrations.some(item => ['reserved', 'payment_pending'].includes(item.status))) return this.setData({ error: '请先核对已有待付款订单，再新增购买。' })
    if (!this.data.membership) return this.openMembershipInvite()
    const intent = this.parentScanIntent = {}
    const current = () => this.parentScanIntent === intent && this.pageVisible !== false
    this.setData({ busy: true, error: '' })
    try {
      const scanned = await new Promise((resolve, reject) => wx.scanCode({ onlyFromCamera: true, scanType: ['qrCode'], success: resolve, fail: reject }))
      if (!current()) return
      const code = String(scanned && scanned.result || '').trim()
      if (!/^MBOX_ACTIVITY_V3:[^:]{8,128}:[0-9a-f-]{36}$/i.test(code)) throw new Error('请扫描原活动票的专用核销码，会员码不能关联送餐。')
      const generation = this.pageGeneration || 0
      const parent = await resolveActivityParent(this.data.id, code)
      if (!current() || generation !== (this.pageGeneration || 0)) return
      if (!parent || parent.activityPublicId !== this.data.id || !parent.registrationPublicId) throw new Error('该凭证不是本场可关联的有效活动票。')
      if (pending && pending.payload.parentRegistrationPublicId !== parent.registrationPublicId) throw new Error('请扫描上次加购关联的同一张原票，不能改成另一号码。')
      this.parentPurchaseCredential = code
      this.setData({ ...activitySelection(this.data.activity, '', 1), creatingPurchase: true, purchaseKind: 'single_dish', parentCredentialRequired: true,
        parentRegistrationPublicId: parent.registrationPublicId, parentPreview: { packageName: parent.packageName || '活动票', number: parent.number, plaqueState: parent.plaqueState },
        selectedAddonProduct: null, selectedAddonProductId: '', addonProducts: [], addonQuantity: pending ? Number(pending.payload.quantity || 1) : 1,
        packageNote: pending ? pending.payload.note || '' : '', ruleAcknowledged: false, error: '', success: '' })
      await this.loadAddonProducts(pending && pending.payload.productId)
    } catch (error) {
      if (current()) this.setData({ error: customerErrorMessage(error, '没有完成扫码关联，请重试。') })
    } finally {
      if (this.parentScanIntent === intent) this.parentScanIntent = null
      this.setData({ busy: false })
    }
  },

  async beginPurchase(event) {
    if (this.data.busy || this.hasPendingPurchase()) return
    if (this.data.registrationReadFailed) return this.setData({ error: '请先刷新核对已有订单，暂不能另建购买。' })
    const kind = String(event && event.currentTarget && event.currentTarget.dataset.kind || 'admission_package')
    if (!['admission_package', 'meal_package', 'single_dish'].includes(kind)) return
    if (kind !== 'admission_package' && this.data.activity.addonBlocked) return this.setData({ error: '本场当前不开放加购，请联系活动负责人。' })
    const unfinished = this.data.registrations.find((item) => ['reserved', 'payment_pending'].includes(item.status))
    if (unfinished) {
      this.setData({ error: '还有一份待付款或结果待确认，请先选择该份继续付款、查单或取消，再购买。' })
      return
    }
    const parent = this.data.registration
    if (kind !== 'admission_package' && (!parent || !parent.canAddPurchase)) return
    if (kind === 'single_dish' && (!this.data.serviceCode || !(this.data.serviceCode.service.hasMeal || this.data.serviceCode.service.includesAdmission) || this.data.serviceCode.service.purchaseKind === 'single_dish')) {
      this.setData({ error: '请先选择一份有效活动票或餐饮套餐，再加购单点菜品。' })
      return
    }
    this.parentPurchaseCredential = null
    this.stopAddonMenuRefresh()
    const packages = this.data.activity.packages || []
    const first = packages.find((item) => item.availability === 'available' && (kind === 'meal_package' ? item.isServicePackage && (item.includesAdmission === false || item.mealOnlyFeeAmountMinor != null) : item.isServicePackage && item.includesAdmission !== false))
    const selection = activitySelection(this.data.activity, kind === 'single_dish' ? '' : first && first.publicId || '', 1)
    this.setData({ ...selection, creatingPurchase: true, purchaseKind: kind, parentCredentialRequired: false, parentPreview: null,
      parentRegistrationPublicId: kind === 'admission_package' ? '' : parent.publicId,
      selectedAddonProduct: null, selectedAddonProductId: '', addonProducts: [], addonQuantity: 1, packageNote: '', ruleAcknowledged: false, error: '', success: '',
      selectedPricing: pricingFor(this.data.activity, selection.selectedPackage, selection.partySize, kind),
    })
    if (kind === 'single_dish') await this.loadAddonProducts()
  },

  stopCreatingPurchase() {
    if (this.data.busy || this.hasPendingPurchase()) return
    this.parentPurchaseCredential = null
    this.stopAddonMenuRefresh()
    this.setData({ parentPreview: null, parentCredentialRequired: false, creatingPurchase: false, purchaseKind: 'admission_package', parentRegistrationPublicId: '', selectedAddonProduct: null, selectedAddonProductId: '', error: '' })
  },

  stopAddonMenuRefresh() {
    if (this.addonMenuTimer) clearTimeout(this.addonMenuTimer)
    this.addonMenuTimer = null
  },

  startAddonMenuRefresh() {
    this.stopAddonMenuRefresh()
    if (this.pageVisible === false || !this.data.creatingPurchase || this.data.purchaseKind !== 'single_dish') return
    this.addonMenuTimer = setTimeout(async () => {
      this.addonMenuTimer = null
      if (this.pageVisible === false || !this.data.creatingPurchase || this.data.purchaseKind !== 'single_dish') return
      if (this.data.busy || this._registrationPending) { this.startAddonMenuRefresh(); return }
      await this.loadAddonProducts(this.data.selectedAddonProductId)
    }, 60000)
    if (this.addonMenuTimer && typeof this.addonMenuTimer.unref === 'function') this.addonMenuTimer.unref()
  },

  async loadAddonProducts(requestedId) {
    const generation = this.pageGeneration || 0
    const menuGeneration = this.addonMenuGeneration = (this.addonMenuGeneration || 0) + 1
    const requestedSelection = requestedId || this.data.selectedAddonProductId || ''
    try {
      const rows = await getActivityAddonProducts(this.data.id)
      if (generation !== (this.pageGeneration || 0) || menuGeneration !== this.addonMenuGeneration || this.data.purchaseKind !== 'single_dish') return
      const addonProducts = (Array.isArray(rows) ? rows : []).map((item) => Object.assign({}, item, { sellable: item.sellable !== false && item.priceAmountMinor != null, priceText: item.sellable !== false && item.priceAmountMinor != null ? money(Number(item.priceAmountMinor)) : '', statusText: item.statusText || (item.sellable === false || item.priceAmountMinor == null ? '当前不可购买' : '') }))
      const product = addonProducts.find((item) => item.id === requestedSelection) || (!requestedSelection && addonProducts.find(item => item.sellable)) || null
      this.setData({ addonProducts, selectedAddonProduct: product, selectedAddonProductId: requestedSelection || product && product.id || '',
        selectedPricing: pricingFor(this.data.activity, null, 1, 'single_dish', product, this.data.addonQuantity),
        ...(requestedSelection && !product ? { error: '原菜品当前不可售，请先刷新核对原提交结果；不要改成另一份重复下单。' } : {}),
      })
    } catch (error) { if (generation === (this.pageGeneration || 0) && menuGeneration === this.addonMenuGeneration) this.setData({ error: customerErrorMessage(error, '加购菜单暂时无法读取，请稍后刷新。') }) }
    finally { if (generation === (this.pageGeneration || 0) && menuGeneration === this.addonMenuGeneration) this.startAddonMenuRefresh() }
  },

  chooseAddonProduct(event) {
    if (this._registrationPending || this.data.busy || this.hasPendingPurchase()) return
    const product = this.data.addonProducts.find((item) => item.id === event.currentTarget.dataset.productId)
    if (!product || product.sellable === false) return
    this.setData({ selectedAddonProduct: product, selectedAddonProductId: product.id, addonQuantity: 1, selectedPricing: pricingFor(this.data.activity, null, 1, 'single_dish', product, 1) })
  },

  changeAddonQuantity(event) {
    if (this._registrationPending || this.data.busy || this.hasPendingPurchase()) return
    const quantity = Math.max(1, Math.min(99, this.data.addonQuantity + Number(event.currentTarget.dataset.delta)))
    this.setData({ addonQuantity: quantity, selectedPricing: pricingFor(this.data.activity, null, 1, 'single_dish', this.data.selectedAddonProduct, quantity) })
  },

  async loadServiceCode() {
    const registration = this.data.registration
    const generation = this.serviceGeneration = (this.serviceGeneration || 0) + 1
    this.setData({ serviceCode: null, serviceError: '', serviceBusy: false, ownParentRegistrationPublicId: '' })
    if (!registration || !registration.canUseService || !registration.hasServiceFlow) return
    this.setData({ serviceBusy: true })
    try {
      const result = await getActivityRegistrationServiceCode(registration.publicId)
      if (generation !== this.serviceGeneration || !this.data.registration || this.data.registration.publicId !== registration.publicId) return
      const service = result && result.service
      if (!service || service.registrationPublicId !== registration.publicId || (registration.purchaseKind !== 'single_dish' && (!result.code || !result.qrDataUrl))) throw new Error('本份核销码暂时无法读取')
      const changes = storageObject(PARTY_SIZE_ATTEMPTS_KEY)
      const pending = changes[registration.publicId]
      if (pending && pending.partySize === service.partySize) { delete changes[registration.publicId]; wx.setStorageSync(PARTY_SIZE_ATTEMPTS_KEY, changes) }
      this.setData({ serviceCode: result, ownParentRegistrationPublicId: this.data.registrations.some(item => item.publicId === registration.parentRegistrationPublicId) ? registration.parentRegistrationPublicId : '', registeredPartySizeDraft: String(pending && pending.partySize !== service.partySize ? pending.partySize : service.partySize) })
    } catch (error) {
      if (generation === this.serviceGeneration) this.setData({ serviceError: customerErrorMessage(error, '本份核销码暂时无法读取，请刷新或联系门口工作人员。') })
    } finally {
      if (generation === this.serviceGeneration) this.setData({ serviceBusy: false })
    }
  },

  noop() {},

  changePartySize(event) {
    if (this._registrationPending || this.data.busy || this.hasPendingPurchase()) return
    const delta = Number(event.currentTarget.dataset.delta)
    const maximum = this.data.partySizeLimit || 1
    const partySize = Math.max(1, Math.min(maximum, this.data.partySize + delta))
    this.setData({ partySize, selectedPricing: pricingFor(this.data.activity, this.data.selectedPackage, partySize, this.data.purchaseKind, this.data.selectedAddonProduct, this.data.addonQuantity) })
  },
  choosePackageOption(event) {
    if (this._registrationPending || this.data.busy || this.hasPendingPurchase()) return
    const { groupId, productId } = event.currentTarget.dataset
    this.setData({ selectedChoiceGroups: this.data.selectedChoiceGroups.map(group => group.id === groupId && group.options.some(option => option.productId === productId) ? Object.assign({}, group, { selectedProductId: productId }) : group) })
  },
  onPackageNoteInput(event) {
    if (this._registrationPending || this.data.busy || this.hasPendingPurchase()) return
    this.setData({ packageNote: String(event.detail.value || '').slice(0, 200) })
  },

  choosePackage(event) {
    const activity = this.data.activity
    if (this._registrationPending || !activity || this.data.busy || this.hasPendingPurchase()) return
    const publicId = String(event.currentTarget.dataset.packageId || '')
    const next = selectedPackage(activity, publicId)
    if (!next || next.availability !== 'available' || (this.data.purchaseKind === 'meal_package' && next.includesAdmission !== false && next.mealOnlyFeeAmountMinor == null) || (this.data.purchaseKind === 'admission_package' && next.isServicePackage && next.includesAdmission === false)) return
    this.clearRegistrationAttempt(activity.publicId)
    const limit = partySizeLimit(activity, next)
    const partySize = Math.min(this.data.partySize, limit)
    this.setData({
      selectedPackagePublicId: publicId,
      selectedPackage: next,
      selectedChoiceGroups: packageChoiceGroups(next),
      partySize,
      partySizeLimit: limit,
      selectedPricing: pricingFor(activity, next, partySize, this.data.purchaseKind),
      error: '', success: '',
    })
  },
  clearPackageSelection() {
    const activity = this.data.activity
    if (this._registrationPending || !activity || activity.packageSelectionRequired || this.data.busy || this.data.purchaseKind !== 'admission_package' || this.hasPendingPurchase()) return
    this.clearRegistrationAttempt(activity.publicId)
    const limit = partySizeLimit(activity, null)
    const partySize = Math.min(this.data.partySize, limit)
    this.setData({
      selectedPackagePublicId: '', selectedPackage: null, selectedChoiceGroups: [], packageNote: '',
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
    const generation = this.presentationGeneration = (this.presentationGeneration || 0) + 1
    try {
      const empty = { presentation: [], authorizations: [] }
      const [activityPrompt, memberPrompt, couponPrompt] = await Promise.all([
        getWechatNotificationPrompt('activity_registration').catch(() => empty),
        getWechatNotificationPrompt('member_card').catch(() => empty),
        getWechatNotificationPrompt('coupon_open').catch(() => empty),
      ])
      if (generation !== this.presentationGeneration) return []
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
    const generation = this.pageGeneration || 0
    const options = this._presentationOptions || this.data.wechatSubscriptionPresentationOptions || []
    await requestWechatSubscription(options, ACTIVITY_REGISTRATION_SUBSCRIBE_TYPES)
    if (generation === (this.pageGeneration || 0)) this.preloadWechatSubscriptionPresentationOptions().catch(() => {})
  },

  async register() {
    if (this._registrationPending || this.data.busy) return
    this._registrationPending = true
    try { return await this.completeRegistration(this.pageGeneration || 0) }
    finally { this._registrationPending = false }
  },

  async completeRegistration(generation) {
    const current = () => generation === (this.pageGeneration || 0)
    const activity = this.data.activity
    if (!activity || this.data.busy) return
    if (!this.data.membership) {
      await this.openMembershipInvite()
      return
    }
    if (this.data.registrationReadFailed) return this.setData({ error: '请先刷新核对已有订单，暂不能另建购买。' })
    const chosenPackage = this.data.selectedPackage
    const purchaseKind = this.data.purchaseKind || 'admission_package'
    const isSingleDish = purchaseKind === 'single_dish'
    const parentCredential = this.parentPurchaseCredential
    const choiceGroups = isSingleDish ? [] : this.data.selectedChoiceGroups || []
    const missingChoice = choiceGroups.find(group => !group.selectedProductId)
    if (missingChoice && !storageObject(REGISTRATION_ATTEMPTS_KEY)[activity.publicId]) return this.setData({ error: `请先选择${missingChoice.name}，每组固定选择一种。` })
    if (isSingleDish && (!this.data.selectedAddonProduct || this.data.selectedAddonProduct.sellable === false)) return this.setData({ error: '请先选择当前可售的加购菜品。' })
    if (!isSingleDish && (activity.packageSelectionRequired || purchaseKind === 'meal_package') && !chosenPackage) {
      return this.setData({ error: '请先选择一个活动套餐后再报名。' })
    }
    if (chosenPackage && chosenPackage.availability !== 'available') {
      return this.setData({ error: '所选套餐当前不可报名，请换一档后再试。' })
    }
    const pricing = pricingFor(activity, chosenPackage, this.data.partySize, purchaseKind, this.data.selectedAddonProduct, this.data.addonQuantity)
    if ((purchaseKind === 'admission_package' ? activity.registrationBlocked : activity.addonBlocked) || pricing.paymentAvailability === 'blocked') {
      return this.setData({ error: activity.paymentBlockedText || '线上付款暂时不可用，本次报名尚未提交。' })
    }
    if (this.data.registration && !this.data.registration.canReRegister && !this.data.creatingPurchase) {
      await this.showRegistrationOutcome(this.data.registration)
      return
    }
    const attempts = storageObject(REGISTRATION_ATTEMPTS_KEY)
    const previous = attempts[activity.publicId]
    if (typeof previous === 'string') {
      const recovered = await this.recoverRegistration(activity.publicId, null)
      if (!current() || recovered) return
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
    if (isSingleDish && (this.data.parentCredentialRequired || (attempt && attempt.payload.parentCredentialRequired)) && !parentCredential) {
      if (attempt && await this.recoverRegistration(activity.publicId, attempt)) return
      if (current()) this.setData({ error: '请重新扫描原票核销码授权关联；已有请求会使用原记录恢复，不另建订单。' })
      return
    }
    if (attempt && attempt.payload.purchaseKind && ((attempt.payload.activityPackagePublicId || '') !== (chosenPackage?.publicId || '') || attempt.payload.purchaseKind !== purchaseKind || (attempt.payload.productId || '') !== (this.data.selectedAddonProduct && this.data.selectedAddonProduct.id || ''))) {
      return this.setData({ error: '请先恢复上一次提交内容并核对结果，当前不能切换为新购买。' })
    }
    if (attempt && !attempt.payload.purchaseKind && (attempt.payload.activityPackagePublicId || '') !== (chosenPackage?.publicId || '')) {
      this.clearRegistrationAttempt(activity.publicId)
      attempt = null
    }
    if (attempt && !attempt.payload.purchaseKind && registrationAttemptExpired(attempt)) {
      const recovered = await this.recoverRegistration(activity.publicId, attempt)
      if (!current() || recovered) return
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
      if (!current()) return
      const confirmed = await this.confirmPayment('上次报名结果尚未确认。请确认手机号与上次一致；我们会避免重复报名。')
      if (!confirmed || !current()) return
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
      if (!current()) return
      const payment = await this.choosePayment(pricing)
      if (!payment || !current()) return
      const payload = {
        activityPackagePublicId: chosenPackage?.publicId || null,
        partySize: isSingleDish ? 1 : this.data.partySize,
        ...((chosenPackage && chosenPackage.isServicePackage) || purchaseKind !== 'admission_package' ? {
          purchaseKind, parentRegistrationPublicId: this.data.parentRegistrationPublicId || null,
          ...(this.data.parentCredentialRequired ? { parentCredentialRequired: true } : {}),
          selections: choiceGroups.map(group => ({ groupId: group.id, productId: group.selectedProductId })),
          ...(this.data.packageNote.trim() ? { note: this.data.packageNote.trim() } : {}),
          ...(isSingleDish ? { productId: this.data.selectedAddonProduct.id, quantity: this.data.addonQuantity } : {}),
        } : {}),
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
      if (parentCredential) payload.parentCredential = parentCredential
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
        payload,
      )
      this.clearRegistrationAttempt(activity.publicId)
      this.parentPurchaseCredential = null
      let registrationRaw = Object.assign({}, result, { activityPublicId: activity.publicId, purchaseKind: payload.purchaseKind || null, parentRegistrationPublicId: payload.parentRegistrationPublicId || null, note: result.note || payload.note || '', selections: result.selections || choiceGroups.map(group => ({ label: group.name, productId: group.selectedProductId, name: (group.options.find(option => option.productId === group.selectedProductId) || {}).name || '', quantity: group.quantity })), registrationRequestIdempotencyKey: attempt.idempotencyKey, activityPackage: chosenPackage, createdAt: result.createdAt || new Date().toISOString() })
      if (result.payment && !registrationRaw.amountDueMinor) registrationRaw.amountDueMinor = result.payment.amountMinor
      const registration = await this.readPaymentState(registrationRaw)
      this.rememberRegistration(registration, activity.publicId)
      if (!current()) return
      this.setData({ registration, creatingPurchase: false, selectedRegistrationPublicId: registration.publicId, serviceCode: null })
      await this.loadServiceCode()
      await this.refreshActivityAvailability()
      if (!current()) return
      // A required online-payment choice is made before the registration is
      // created. Once the service returns its idempotent registration record,
      // immediately present the matching WeChat payment sheet instead of
      // making the customer tap a second “continue payment” button.
      shouldAutoStartPayment = Boolean(registration && registration.canStartPayment && payload.paymentChoice !== 'none')
      if (current() && shouldAutoStartPayment) {
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
      if (!current()) return
      const recovered = await this.recoverRegistration(activity.publicId, attempt)
      if (!current() || recovered) return
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
    } finally {
      this.setData({ busy: false })
      if (!current() && this.pageVisible) this.load()
    }
    if (current() && shouldAutoStartPayment) await this.startPayment()
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
    const generation = this.pageGeneration || 0
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
        if (result.confirm && generation === (this.pageGeneration || 0)) wx.switchTab({ url: '/pages/profile/index' })
        resolve()
      },
      fail: () => resolve(),
    }))
  },

  async readPaymentState(registrationRaw) {
    if (!registrationRaw || !registrationRaw.publicId) return viewRegistration(registrationRaw)
    try {
      const paymentState = await getActivityRegistrationPayment(registrationRaw.publicId)
      return viewRegistration(Object.assign({}, registrationRaw, paymentState, { canRequestFullRefund: paymentState.canRequestFullRefund, refundRequestBlockReason: paymentState.refundRequestBlockReason, refundRejectionReason: paymentState.refundRejectionReason, status: paymentState.registrationStatus || registrationRaw.status }))
    } catch (error) {
      this.setData({ error: `报名已记录，但付款状态暂时无法核对：${customerErrorMessage(error, '请稍后刷新')}` })
      return viewRegistration(Object.assign({}, registrationRaw, { canRequestFullRefund: undefined, refundRequestBlockReason: undefined, refundRejectionReason: undefined }))
    }
  },

  async refreshActivityAvailability() {
    const generation = this.pageGeneration || 0
    try {
      const raw = await getActivity(this.data.id)
      if (raw && generation === (this.pageGeneration || 0)) this.setData({ activity: viewActivity(raw) })
    } catch (_error) {
      // 报名状态已由报名接口确认；名额显示会在下次进入页面时再以服务端数据刷新。
    }
  },

  async recoverRegistration(activityPublicId, attempt) {
    const generation = this.pageGeneration || 0
    try {
      const registrations = await getActivityRegistrations()
      const candidates = (registrations || []).filter((item) => item.activityPublicId === activityPublicId)
      const found = attempt && attempt.payload && attempt.payload.purchaseKind
        ? candidates.find((item) => item.registrationRequestIdempotencyKey === attempt.idempotencyKey)
        : candidates.find((item) => !attempt || item.publicId !== attempt.previousRegistrationPublicId)
      if (!found) return false
      if (attempt && attempt.previousRegistrationPublicId === found.publicId && found.status === 'cancelled') return false
      const registration = await this.readPaymentState(found)
      this.clearRegistrationAttempt(activityPublicId)
      this.rememberRegistration(registration, activityPublicId)
      if (generation !== (this.pageGeneration || 0)) return true
      this.setData({ registration, creatingPurchase: false, selectedRegistrationPublicId: registration.publicId, success: '已找回刚才的报名记录，没有重复提交。', error: '' })
      await this.loadServiceCode()
      await this.refreshActivityAvailability()
      if (generation === (this.pageGeneration || 0)) await this.showRegistrationOutcome(registration)
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
      const next = viewRegistration(Object.assign({}, registration, state, { canRequestFullRefund: state.canRequestFullRefund, refundRequestBlockReason: state.refundRequestBlockReason, refundRejectionReason: state.refundRejectionReason, status: state.registrationStatus || registration.status }))
      this.rememberRegistration(next)
      this.setData({ registration: next })
      await this.loadServiceCode()
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
      const next = viewRegistration(Object.assign({}, registration, state, { canRequestFullRefund: state.canRequestFullRefund, refundRequestBlockReason: state.refundRequestBlockReason, refundRejectionReason: state.refundRejectionReason, status: state.registrationStatus || registration.status }))
      this.rememberRegistration(next)
      this.setData({ registration: next })
      await this.loadServiceCode()
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
    wx.showModal({ title: '取消与退款说明', content: `${this.data.registration && this.data.registration.refundGuidance || '请联系门店核对本份报名及退款安排。'}${contact}`, showCancel: false })
  },

  clearRegistrationAttempt(activityPublicId) {
    const attempts = storageObject(REGISTRATION_ATTEMPTS_KEY)
    delete attempts[activityPublicId]
    wx.setStorageSync(REGISTRATION_ATTEMPTS_KEY, attempts)
  },

  rememberRegistration(registration, activityPublicId) {
    if (!registration) return
    const stored = storageObject(LOCAL_REGISTRATIONS_KEY)
    const registrations = [registration, ...(this.data.registrations || []).filter((item) => item.publicId !== registration.publicId)]
    this.setData({ registrations })
    stored[activityPublicId || this.data.id] = registration
    wx.setStorageSync(LOCAL_REGISTRATIONS_KEY, stored)
  },
})
