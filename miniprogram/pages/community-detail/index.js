const {
  getActivity,
  getActivityLoyaltyBenefits,
  getActivityRegistrations,
  registerActivity,
  getActivityRegistrationPayment,
  startActivityRegistrationPayment,
  queryActivityRegistrationPayment,
  cancelActivityRegistration,
  getMiniBootstrap,
  enrollMembership,
} = require('../../utils/api')
const { randomId } = require('../../utils/id')
const { money, dateTime } = require('../../utils/format')
const { publicImageUrl } = require('../../utils/media')
const { readWechatPhoneAuthorization } = require('../../utils/wechat-phone')

const KIND_NAMES = { member_night: '会员之夜', hike: '城市轻徒步', camping: '露营计划', city_walk: '城市漫游', music_picnic: '音乐野餐', proposal: '特别企划', other: '超嗨活动' }
const LOCAL_REGISTRATIONS_KEY = 'mbox.community.registrations.v1'
const REGISTRATION_ATTEMPTS_KEY = 'mbox.community.registration.attempts.v1'
const PAYMENT_ACTION_ATTEMPTS_KEY = 'mbox.community.payment.actions.v1'
const PAYMENT_QUERY_ATTEMPTS_KEY = 'mbox.community.payment.queries.v1'
const CANCELLATION_ATTEMPTS_KEY = 'mbox.community.registration.cancellations.v1'
const ALLOWED_PAYMENT_ACTIONS = ['start_payment', 'query_payment', 'cancel_registration']
const REGISTRATION_STATUS_NAMES = {
  reserved: '待付款', payment_pending: '待付款', confirmed: '已报名',
  waitlisted: '候补中', checked_in: '已签到', no_show: '未到场',
  cancelled: '报名已取消', refunded: '已退款', expired: '报名已失效',
}
const RESOLUTION_STATE_NAMES = {
  not_required: '无需在线付款', action_required: '等待您完成付款', pending: '支付通道处理中',
  unknown: '付款结果待核对', confirmed: '付款已经确认', failed: '付款明确失败',
  expired: '付款已超时，名额已释放', refund_requested: '退款申请待审核',
  refunding: '退款处理中', refunded: '退款已经完成',
}
const REFUND_STATUS_NAMES = {
  requested: '店长已发起退款，等待复核', approved: '退款已复核通过', processing: '退款处理中',
  succeeded: '退款已经到账', failed: '退款处理失败，门店正在核对', rejected: '退款申请未通过',
}

function list(value) {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item || '').trim()).filter(Boolean)
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

function viewActivity(raw) {
  const sales = raw.salesCopy && typeof raw.salesCopy === 'object' ? raw.salesCopy : {}
  const safety = raw.safety && typeof raw.safety === 'object' ? raw.safety : {}
  const refund = raw.refundPolicy && typeof raw.refundPolicy === 'object' ? raw.refundPolicy : {}
  const safetyPolicyVersion = String(safety.policyVersion || '').trim()
  const refundPolicyVersion = String(refund.policyVersion || '').trim()
  const availablePaymentChoices = list(raw.availablePaymentChoices)
  const availablePaymentMethods = list(raw.availablePaymentMethods)
  const requiresOnlinePayment = raw.feeAmountMinor > 0 && !availablePaymentChoices.includes('none')
  const providerBlocked = raw.feeAmountMinor > 0 && raw.paymentAvailability !== 'available'
  const clientPaymentBlocked = requiresOnlinePayment && !availablePaymentMethods.includes('jsapi')
  const registrationBlocked = providerBlocked || clientPaymentBlocked || !safetyPolicyVersion || !refundPolicyVersion
  const safetyFacts = []
  if (safety.difficulty) safetyFacts.push(`难度：${safety.difficulty}`)
  if (safety.ageRequirement) safetyFacts.push(`年龄：${safety.ageRequirement}`)
  if (safety.insuranceIncluded !== undefined) safetyFacts.push(safety.insuranceIncluded ? '活动包含保险' : '活动不包含保险')
  let paymentBlockedText = ''
  if (providerBlocked) paymentBlockedText = raw.paymentBlockedReason || '线上付款条件尚未完整配置，本活动暂不接受报名，也不会提前占用名额。'
  else if (clientPaymentBlocked) paymentBlockedText = '本活动当前没有可供小程序使用的微信支付方式，暂不接受收费报名。'
  else if (!safetyPolicyVersion || !refundPolicyVersion) paymentBlockedText = '活动安全或退款规则缺少可核验版本，本活动暂不接受报名。'
  return Object.assign({}, raw, {
    coverUrl: publicImageUrl(raw.coverUrl),
    kindText: KIND_NAMES[raw.kind] || '超嗨活动',
    startsText: dateTime(raw.startsAt),
    endsText: dateTime(raw.endsAt),
    feeText: raw.feeAmountMinor > 0 ? `${money(raw.feeAmountMinor)}${raw.feeBasis === 'per_person' ? '/人' : '/次'}` : '免费',
    depositText: raw.depositAmountMinor > 0 ? money(raw.depositAmountMinor) : '无需订金',
    deadlineText: raw.paymentDeadlineMinutes > 0 ? `${raw.paymentDeadlineMinutes} 分钟` : '无需在线付款',
    paymentText: paymentText(raw),
    refundText: publicText(raw.refundPolicy, '取消与退款以本页报名时展示的规则快照为准'),
    details: String(sales.details || raw.summary || '').trim(),
    includedItems: list(sales.includedItems),
    participationRequirements: list(sales.participationRequirements),
    memberBenefitText: String(sales.memberBenefitText || '').trim(),
    contactInstructions: String(sales.contactInstructions || '').trim(),
    safetyRequirements: list(safety.requirements),
    safetyPolicyVersion,
    refundPolicyVersion,
    safetyPolicyText: safetyPolicyVersion ? `安全规则版本 ${safetyPolicyVersion}` : '安全规则版本缺失',
    availablePaymentChoices,
    availablePaymentMethods,
    requiresPaymentOnSubmit: raw.feeAmountMinor > 0 && !availablePaymentChoices.includes('none'),
    safetyFacts,
    registrationBlocked,
    paymentBlockedText,
    acknowledgementText: safetyPolicyVersion && refundPolicyVersion
      ? `我已阅读并确认安全规则 ${safetyPolicyVersion} 与退款规则 ${refundPolicyVersion}`
      : '当前安全或退款规则缺少版本，暂不能确认报名',
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
        ? '候补中，按报名顺序自动递补；现在无需付款。'
        : ''
  return Object.assign({}, raw, {
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
    id: '', loading: true, busy: false, error: '', success: '', activity: null,
    partySize: 1, contact: '', ruleAcknowledged: false, registration: null, loyaltyBenefits: [],
    membership: null, membershipTerms: null,
    membershipInviteVisible: false, membershipInviteAgreed: false, membershipInviteBusy: false,
  },

  onLoad(options) { this.setData({ id: options.id || '' }) },
  onShow() { this.load() },

  async load() {
    this.setData({ loading: true, error: '', success: '' })
    try {
      const bootstrap = await getMiniBootstrap()
      const membership = bootstrap.membership || null
      const membershipTerms = bootstrap.membershipTerms || null
      this.setData({ membership, membershipTerms })
      if (!membership) {
        this.setData({
          loading: false,
          activity: null,
          registration: null,
          membershipInviteVisible: true,
          membershipInviteAgreed: false,
          error: '',
        })
        return
      }
      const raw = await getActivity(this.data.id)
      if (!raw) throw new Error('活动已结束、暂停或不在您的可见范围内')
      let loyaltyBenefits = []
      try {
        loyaltyBenefits = (await getActivityLoyaltyBenefits(raw.publicId)).map(viewLoyaltyBenefit)
      } catch (_error) {
        loyaltyBenefits = []
      }
      let registrations = []
      let registrationReadError = ''
      try { registrations = await getActivityRegistrations() } catch (error) { registrationReadError = error.message || '报名记录暂时无法读取' }
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
        } catch (error) { paymentReadError = error.message || '付款状态暂时无法读取' }
      }
      const pendingAttempt = storageObject(REGISTRATION_ATTEMPTS_KEY)[raw.publicId]
      const sameCancelledRegistration = authoritative && authoritative.status === 'cancelled' && (
        typeof pendingAttempt === 'string'
        || (pendingAttempt && pendingAttempt.previousRegistrationPublicId === authoritative.publicId)
      )
      if (authoritative && !sameCancelledRegistration) this.clearRegistrationAttempt(raw.publicId)
      const registration = viewRegistration(registrationRaw)
      if (registration) this.rememberRegistration(registration, raw.publicId)
      this.setData({ loading: false, activity: viewActivity(raw), loyaltyBenefits, registration, error: paymentReadError || registrationReadError })
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
      this.setData({ loading: false, error: error.message || '活动详情暂时无法读取' })
    }
  },

  dismissMembershipInvite() {
    this.setData({ membershipInviteVisible: false, membershipInviteAgreed: false })
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/community/index' }) })
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
      this.setData({ membershipInviteBusy: false, error: error.message || '入会暂时没有完成' })
      wx.showToast({ title: error.message || '入会未完成', icon: 'none' })
    }
  },

  noop() {},

  changePartySize(event) {
    const delta = Number(event.currentTarget.dataset.delta)
    const maximum = Math.max(1, this.data.activity.remainingCapacity || 1)
    this.setData({ partySize: Math.max(1, Math.min(maximum, this.data.partySize + delta)) })
  },
  onContactInput(event) { this.setData({ contact: event.detail.value }) },
  onAcknowledgementChange(event) { this.setData({ ruleAcknowledged: Boolean(event.detail.value && event.detail.value.length) }) },

  async register() {
    const activity = this.data.activity
    if (!activity || this.data.busy) return
    if (!this.data.membership) {
      this.setData({ membershipInviteVisible: true, membershipInviteAgreed: false, error: '' })
      return
    }
    if (activity.registrationBlocked) return this.setData({ error: activity.paymentBlockedText })
    if (this.data.registration && !this.data.registration.canReRegister) {
      await this.showRegistrationOutcome(this.data.registration)
      return
    }
    const attempts = storageObject(REGISTRATION_ATTEMPTS_KEY)
    const previous = attempts[activity.publicId]
    if (typeof previous === 'string') {
      const recovered = await this.recoverRegistration(activity.publicId, null)
      if (!recovered) this.setData({ error: '检测到旧版报名请求仍待核对。为避免重复占位，本页不会用新资料重发；请刷新后联系活动负责人核对。' })
      return
    }
    if (previous && typeof previous === 'object' && previous.payload && !validCommandKey(previous.idempotencyKey)) {
      this.setData({ error: '本机保存的待核对请求编号异常。为避免重复报名，本页不会自动生成新请求，请联系活动负责人核对。' })
      return
    }
    let attempt = previous && previous.payload ? previous : null
    if (attempt) {
      const confirmed = await this.confirmPayment('上次报名结果尚未确认。本次只会原样重试同一请求，不会按当前页面内容新建第二份报名。')
      if (!confirmed) return
    } else {
      if (this.data.contact.trim().length < 3) return this.setData({ error: '请填写本次活动可联系的手机号或微信' })
      if (!this.data.ruleAcknowledged) return this.setData({ error: '请先阅读并确认报名、退款与安全规则版本' })
      const payment = await this.choosePayment(activity)
      if (!payment) return
      const payload = {
        partySize: this.data.partySize,
        contactSnapshot: { channel: 'miniprogram', contact: this.data.contact.trim() },
        termsAcknowledged: true,
        acknowledgedSafetyPolicyVersion: activity.safetyPolicyVersion,
        acknowledgedRefundPolicyVersion: activity.refundPolicyVersion,
        paymentChoice: payment.choice,
        ...(payment.method ? { paymentMethod: payment.method } : {}),
      }
      attempt = {
        idempotencyKey: commandKey('activity-register', activity.publicId),
        payload,
        previousRegistrationPublicId: this.data.registration && this.data.registration.publicId,
        createdAt: new Date().toISOString(),
      }
      attempts[activity.publicId] = attempt
      wx.setStorageSync(REGISTRATION_ATTEMPTS_KEY, attempts)
    }
    this.setData({ busy: true, error: '', success: '' })
    try {
      const payload = attempt.payload
      const result = await registerActivity(
        activity.publicId,
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
      const success = registration && registration.canStartPayment
        ? `名额已暂留至 ${registration.seatHoldText || '页面所示时限'}；完成付款后才算报名成功。`
        : result.status === 'waitlisted'
          ? '已加入候补，按报名顺序自动递补；现在无需付款。'
          : result.status === 'confirmed'
            ? '报名成功，名额已为您确认。'
            : '报名已提交，请在“我的”中查看当前状态。'
      this.setData({ success })
      await this.showRegistrationOutcome(registration)
    } catch (error) {
      const recovered = await this.recoverRegistration(activity.publicId, attempt)
      if (!recovered) {
        this.setData({ error: error.code === 'ACTIVITY_PAYMENT_AUTHORITY_NOT_CONFIGURED'
          ? '线上付款条件未就绪，本次没有建立收费报名。'
          : '报名结果暂时无法确认。再次点击只会原样重试同一请求，不会创建第二份报名。' })
      }
    } finally { this.setData({ busy: false }) }
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
      this.setData({ error: '当前没有可供小程序使用的付款选择，本次不会提交报名。' })
      return null
    }
    if (options.length === 1 && options[0].choice === 'none' && !item.feeAmountMinor) return options[0]
    if (options.length === 1) return await this.confirmPayment(`本次选择：${options[0].label}。提交后将按页面展示的退款与安全规则处理。`) ? options[0] : null
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
          ? '您已进入候补队列。系统会按报名时间自动递补；当前无需付款。'
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
      this.setData({ error: `报名已记录，但付款状态暂时无法核对：${error.message || '请稍后刷新'}` })
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
    this.setData({ busy: true, error: '', success: '' })
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
        const cancelled = String(error.errMsg || error.message || '').toLowerCase().includes('cancel')
        if (cancelled) this.setData({ success: '已取消支付，报名仍保留为待付款；可稍后查询或继续处理。', error: '' })
        else this.setData({ error: '支付窗口返回异常，结果尚未确认。请先查单，不要重复报名或重复付款。' })
        await this.refreshPaymentState(false)
      }
    } catch (error) {
      await this.refreshPaymentState(false)
      this.setData({ error: error.message || '支付动作结果暂时无法确认，请先查单，不要重复付款。' })
    } finally { this.setData({ busy: false }) }
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
      else if (next.resolutionState === 'refunded') this.setData({ success: '退款状态已由系统确认。', error: '' })
      else this.setData({ success: '已刷新权威付款状态。', error: '' })
    } catch (error) { this.setData({ error: error.message || '查单结果暂时无法确认；本页不会重建报名或重复付款。' }) }
  },

  async refreshPaymentState(showError = true) {
    const registration = this.data.registration
    if (!registration || !registration.publicId) return
    try {
      const state = await getActivityRegistrationPayment(registration.publicId)
      const next = viewRegistration(Object.assign({}, registration, state, { status: state.registrationStatus || registration.status }))
      this.rememberRegistration(next)
      this.setData({ registration: next })
    } catch (error) { if (showError) this.setData({ error: error.message || '付款状态暂时无法读取' }) }
  },

  async cancelRegistration() {
    const registration = this.data.registration
    if (!registration || this.data.busy) return
    if (!registration.canCancelDirectly) return this.showCancellationHelp()
    const confirmed = await new Promise((resolve) => wx.showModal({ title: '取消报名', content: '仅未付款且后台允许取消时才会释放名额。确认取消吗？', confirmColor: '#873e30', success: (result) => resolve(result.confirm), fail: () => resolve(false) }))
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
          ? '该报名已经付款，顾客端不能直接取消。退款需由店长发起、收银复核。'
          : error.message || '当前报名无法取消，请稍后重试或联系活动负责人。' })
    } finally { this.setData({ busy: false }) }
  },

  showCancellationHelp() {
    const contact = this.data.activity.contactInstructions || '请联系活动负责人核对。'
    wx.showModal({ title: '取消与退款说明', content: `已付款报名不能由顾客端直接退款。需要退款时由店长发起、收银复核；顾客端只显示处理进度。${contact}`, showCancel: false })
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
