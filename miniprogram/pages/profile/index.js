const {
  getMiniBootstrap,
  getCustomerBenefits,
  getReservations,
  getActivityRegistrations,
  getActivityRegistrationPayment,
  startMembershipRecovery,
  verifyMembershipRecovery,
  getCustomerPreferenceFacts,
  declareCustomerPreference,
  withdrawCustomerPreferenceSource,
  reserveCustomerBenefit,
  getRedemptionCatalog,
  getRedemptions,
  createRedemption,
  cancelRedemption: cancelRedemptionRequest,
  getProductRestrictions,
  withdrawProductRestriction,
  getWechatNotificationAuthorizations,
  recordWechatNotificationAuthorization,
  enrollMembership,
  logoutWechatIdentity,
} = require('../../utils/api')
const { restartAnonymousCustomerSession } = require('../../utils/auth')
const { consumeMembershipLoginRedirect } = require('../../utils/membership-gate')
const { getTableConnection } = require('../../utils/session')
const { dateTime, money } = require('../../utils/format')
const { readWechatPhoneAuthorization } = require('../../utils/wechat-phone')
const { getRuntimeConfig } = require('../../config/index')
const { publicImageUrl } = require('../../utils/media')

const LEVEL_NAMES = { member: 'M-BOX会员', silver: '银卡会员', gold: '金卡会员' }
const BENEFIT_NAMES = { gift_product: '赠送好礼', discount: '折扣权益', credit: '金额权益', access: '专属资格', other: '会员权益' }
const REGISTRATION_STATUS_NAMES = {
  reserved: '名额已暂留', payment_pending: '付款未完成', confirmed: '已报名',
  waitlisted: '候补中', checked_in: '已签到', no_show: '未到场',
  cancelled: '已取消', refunded: '已退款', expired: '已失效',
}
const PAYMENT_RESOLUTION_NAMES = {
  not_required: '无需在线付款', action_required: '等待付款', pending: '支付处理中',
  unknown: '付款结果待核对', confirmed: '付款已确认', failed: '付款失败', expired: '付款已超时',
  refund_requested: '退款待审核', refunding: '退款处理中', refunded: '已退款',
}
const REFUND_STATUS_NAMES = {
  requested: '退款待复核', approved: '退款已复核', processing: '退款处理中',
  succeeded: '已退款', failed: '退款处理失败', rejected: '退款未通过',
}
const REDEMPTION_STATUS_NAMES = {
  authorizing: '正在确认', awaiting_fulfillment: '待门店交付', fulfilled: '已交付',
  cancelled: '已取消并返还积分', failed: '未完成', expired: '已失效',
}
const PREFERENCE_KEY_NAMES = {
  'beverage.family': '常喝酒水', 'taste.note': '口味倾向', 'music.style': '音乐偏好',
  'service.intensity': '服务方式', 'seat.preference': '座位偏好', 'dietary.note': '饮食说明',
}
const PREFERENCE_VALUE_NAMES = {
  cocktail: '鸡尾酒', wine: '葡萄酒', sparkling: '起泡酒', beer: '啤酒',
  spirits: '烈酒', non_alcoholic: '无酒精', mixed: '都可以', none: '不饮酒',
  quiet: '少打扰', balanced: '适度照顾', hosted: '希望被安排',
}
const PREFERENCE_TYPE_OPTIONS = [
  { key: 'beverage.family', name: '常喝酒水', inputKind: 'select' },
  { key: 'service.intensity', name: '服务方式', inputKind: 'select' },
  { key: 'taste.note', name: '口味倾向', inputKind: 'text', placeholder: '例如：清爽、少甜' },
  { key: 'music.style', name: '音乐偏好', inputKind: 'text', placeholder: '例如：流行、爵士' },
  { key: 'seat.preference', name: '座位偏好', inputKind: 'text', placeholder: '例如：相对安静' },
  { key: 'dietary.note', name: '饮食说明', inputKind: 'text', placeholder: '仅填写与推荐有关的饮食说明' },
]
const PREFERENCE_SELECT_VALUES = {
  'beverage.family': [
    { code: 'cocktail', name: '鸡尾酒' }, { code: 'wine', name: '葡萄酒' },
    { code: 'sparkling', name: '起泡酒' }, { code: 'beer', name: '啤酒' },
    { code: 'spirits', name: '烈酒' }, { code: 'non_alcoholic', name: '无酒精' },
    { code: 'mixed', name: '都可以' }, { code: 'none', name: '不饮酒' },
  ],
  'service.intensity': [
    { code: 'quiet', name: '少打扰' }, { code: 'balanced', name: '适度照顾' },
    { code: 'hosted', name: '希望被安排' },
  ],
}
const CONTENT_CARD_TYPE_NAMES = {
  activity: '活动推荐', presale: '活动预告', benefit: '权益介绍',
  article: '内容推荐', return_offer: '到店内容', show: '演出推荐',
}
const CONTENT_CARD_SIMPLE_TARGETS = new Set([
  '/pages/home/index', '/pages/reservations/index', '/pages/order/index',
  '/pages/community/index', '/pages/profile/index', '/pages/songs/index', '/pages/privacy/index',
])
const CONTENT_CARD_TAB_TARGETS = new Set([
  '/pages/home/index', '/pages/reservations/index', '/pages/order/index',
  '/pages/community/index', '/pages/profile/index',
])

function membershipView(item) {
  const progress = item.tierProgress
  const nextTierName = progress && progress.nextTier ? LEVEL_NAMES[progress.nextTier] : ''
  const upgradeText = !progress || !nextTierName || progress.upgradeRemaining === null
    ? ''
    : progress.upgradeRemaining > 0
      ? `距${nextTierName}还差 ${progress.upgradeRemaining} 成长值`
      : `已达到${nextTierName}成长值条件`
  const retainText = !progress || progress.retainRemaining === null
    ? ''
    : progress.retainRemaining > 0
      ? `本周期保级还差 ${progress.retainRemaining} 成长值`
      : '本周期已达到保级成长值条件'
  const periodAt = progress && (progress.periodStatus === 'grace' ? progress.graceEndsAt : progress.periodEndsAt)
  const periodText = !periodAt
    ? ''
    : progress.periodStatus === 'grace'
      ? `保级宽限至 ${String(periodAt).slice(0, 10)}`
      : `本级周期至 ${String(periodAt).slice(0, 10)}`
  const expiry = item.pointsExpiry
  return Object.assign({}, item, {
    levelText: LEVEL_NAMES[item.level] || 'M-BOX会员',
    upgradeText,
    retainText,
    periodText,
    expiryText: expiry
      ? `近30天有 ${expiry.expiringWithin30Days} 积分将到期，最近 ${String(expiry.nextExpiryAt).slice(0, 10)}`
      : '',
  })
}

function benefitView(item) {
  const display = item.display || {}
  return Object.assign({}, item, {
    title: display.title || display.name || BENEFIT_NAMES[item.type] || '会员权益',
    description: display.description || display.summary || display.usage || '使用条件以权益详情和现场确认为准',
    typeText: BENEFIT_NAMES[item.type] || '会员权益',
    quantityText: `×${item.quantityAvailable}`,
    valueText: item.valueAmountMinor > 0 ? money(item.valueAmountMinor) : '',
    validText: item.validUntil ? String(item.validUntil).slice(0, 10) : '长期有效',
  })
}

function safeContentCardTarget(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return ''
  if (CONTENT_CARD_SIMPLE_TARGETS.has(value)) return value
  const matched = value.match(/^\/pages\/community-detail\/index\?id=([^&#]+)$/)
  if (!matched) return ''
  try {
    const publicId = decodeURIComponent(matched[1]).trim()
    return /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(publicId)
      ? `/pages/community-detail/index?id=${encodeURIComponent(publicId)}` : ''
  } catch (_error) {
    return ''
  }
}

function memberContentCardView(item) {
  const targetPath = safeContentCardTarget(item.targetPath)
  return {
    code: item.code,
    typeText: CONTENT_CARD_TYPE_NAMES[item.type] || '内容推荐',
    title: item.title,
    summary: item.summary,
    imageUrl: publicImageUrl(item.imageUrl),
    ctaLabel: item.ctaLabel || '查看',
    targetPath,
    hasTarget: Boolean(targetPath),
    priority: Number(item.priority || 0),
  }
}

function preferenceValueName(key, value) {
  return PREFERENCE_VALUE_NAMES[value] || value || PREFERENCE_KEY_NAMES[key] || '未填写'
}

function preferenceEditorState(index) {
  const option = PREFERENCE_TYPE_OPTIONS[index] || PREFERENCE_TYPE_OPTIONS[0]
  const values = PREFERENCE_SELECT_VALUES[option.key] || []
  return {
    preferenceTypeIndex: index,
    preferenceUsesPicker: option.inputKind === 'select',
    preferenceValueOptions: values,
    preferenceValueIndex: 0,
    preferenceTextValue: '',
    preferenceInputPlaceholder: option.placeholder || '',
  }
}

function customerPreferenceView(snapshot) {
  const facts = ((snapshot && snapshot.facts) || []).map((fact) => ({
    viewKey: `${fact.key}:${fact.value}`,
    key: fact.key,
    value: fact.value,
    keyText: PREFERENCE_KEY_NAMES[fact.key] || '到店偏好',
    valueText: preferenceValueName(fact.key, fact.value),
    isActive: fact.status === 'active',
    statusText: fact.status === 'active' ? '当前有效' : '依据不足',
    evidenceText: `支持${Number(fact.supportingEvidenceCount || 0)}条${Number(fact.contraryEvidenceCount || 0) > 0 ? ` · 相反${Number(fact.contraryEvidenceCount)}条` : ''}`,
    lastEvidenceText: fact.lastEvidenceAt ? String(fact.lastEvidenceAt).slice(0, 10) : '',
  }))
  const sources = ((snapshot && snapshot.sources) || []).slice(0, 8).map((source) => ({
    publicId: source.publicId,
    keyText: PREFERENCE_KEY_NAMES[source.key] || '到店偏好',
    valueText: preferenceValueName(source.key, source.value),
    sourceText: source.sourceKind === 'customer_declaration' ? '本人填写' : '到店确认',
    relationText: source.polarity === 'contradicts' ? '已标记不符合' : '支持此偏好',
    createdAtText: source.createdAt ? String(source.createdAt).slice(0, 10) : '',
    withdrawn: source.withdrawn === true,
  }))
  return {
    preferenceFacts: facts,
    preferenceSources: sources,
    preferenceSourceCount: ((snapshot && snapshot.sources) || []).length,
    preferenceActiveCount: facts.filter((fact) => fact.isActive).length,
  }
}

function clearMemberLocalCache() {
  wx.removeStorageSync('mbox.member.avatarUrl')
  wx.removeStorageSync('mbox.member.displayName')
}

Page({
  data: {
    loading: true, busy: false, logoutBusy: false, recoveryBusy: false, recoveryMessage: '', benefitBusyId: '', redemptionBusyId: '',
    error: '', benefitError: '', registrationError: '', redemptionError: '', preferenceError: '',
    membership: null, points: [], benefits: [], reservations: [], registrations: [], contentCards: [],
    membershipTerms: null, supportContact: null,
    agreedToPolicies: false,
    redemptionItems: [], redemptions: [], showRedemptions: false,
    productRestrictions: [], restrictionBusyId: '', expiryNotificationOption: null,
    preferenceFacts: [], preferenceSources: [], preferenceSourceCount: 0, preferenceActiveCount: 0,
    preferenceBusyId: '', showPreferenceEvidence: false, showPreferenceEditor: false,
    preferenceTypeOptions: PREFERENCE_TYPE_OPTIONS,
    ...preferenceEditorState(0),
    benefitCount: 0, balanceText: '0', hasTableContext: false,
    avatarUrl: '', displayName: '',
    loginSheetVisible: false,
    wechatNotificationAuthorizations: [],
  },

  onShow() {
    const shouldOpenLogin = consumeMembershipLoginRedirect()
    this.setData({
      avatarUrl: wx.getStorageSync('mbox.member.avatarUrl') || '',
    })
    this.load().then(() => {
      if (shouldOpenLogin && !this.data.membership) this.openLoginSheet()
    })
  },



  async load() {
    this.setData({ loading: true, error: '', benefitError: '', registrationError: '', redemptionError: '', preferenceError: '' })
    try {
      const soft = (error) => {
        const message = String((error && error.message) || '')
        if (/预约会话已失效|重新进入预约|登录状态已失效|登录或桌边会话已过期/.test(message)) return ''
        return message
      }
      const results = await Promise.all([
        getMiniBootstrap(),
        getCustomerBenefits().catch((error) => { this.setData({ benefitError: soft(error) || '' }); return [] }),
        getReservations().catch(() => ({ reservations: [] })),
        getActivityRegistrations().catch((error) => { this.setData({ registrationError: soft(error) || '' }); return [] }),
        getRedemptionCatalog().catch((error) => { this.setData({ redemptionError: soft(error) || '' }); return { items: [] } }),
        getRedemptions().catch(() => []),
        getProductRestrictions().catch(() => []),
        getWechatNotificationAuthorizations().catch(() => ({ authorizations: [] })),
        getCustomerPreferenceFacts().catch((error) => {
          this.setData({ preferenceError: soft(error) || '' })
          return { facts: [], sources: [] }
        }),
      ])
      const data = results[0]
      const benefits = (results[1] || []).map(benefitView)
      const reservations = (results[2].reservations || []).filter((item) => {
        if (!['pending', 'confirmed'].includes(item.status)) return false
        const arrivalMs = Date.parse(item.arrivalAt)
        if (Number.isFinite(arrivalMs) && arrivalMs < Date.now() - 12 * 60 * 60 * 1000) return false
        return true
      }).map((item) => ({
        publicId: item.publicId, title: `${dateTime(item.arrivalAt)} · ${item.guestCount}人`, statusText: ({ pending: '等待确认', confirmed: '预约已确认' })[item.status] || '状态待确认',
      })).slice(0, 3)
      const registrationRows = (results[3] || [])
        .filter((item) => !['cancelled', 'refunded', 'expired'].includes(item.status))
        .sort((left, right) => String(left.startsAt || '').localeCompare(String(right.startsAt || '')))
        .slice(0, 5)
      const paymentStates = await Promise.all(registrationRows.map((item) => (
        getActivityRegistrationPayment(item.publicId).catch(() => null)
      )))
      const registrations = registrationRows.map((item, index) => {
        const state = paymentStates[index] || {}
        return Object.assign({}, item, state, {
          title: item.activityTitle || '超嗨活动',
          startsText: dateTime(item.startsAt),
          statusText: REFUND_STATUS_NAMES[state.refundStatus]
            || PAYMENT_RESOLUTION_NAMES[state.resolutionState]
            || REGISTRATION_STATUS_NAMES[item.status]
            || '状态待确认',
        })
      })
      const membership = data.membership ? membershipView(data.membership) : null
      const productRestrictions = (results[6] || []).map((item) => Object.assign({}, item, {
        restrictionText: item.restrictionType === 'allergy_or_cannot_consume'
          ? '过敏或不能饮用' : '不喜欢',
      }))
      const tableConnection = getTableConnection()
      const expiryNotificationOption = membership && membership.expiryText
        ? ((results[7] && results[7].authorizations) || []).find((item) => (
          item.notificationType === 'loyalty_points_expiring'
          && item.usesRemaining <= 0 && item.platformResult !== 'ban'
        )) || null
        : null
      const redemptionItems = ((results[4] && results[4].items) || []).map((item) => {
        const display = item.display || {}
        const inventoryText = item.remainingDailyInventory === null
          ? (item.remainingInventory === null ? '数量以页面确认结果为准' : `剩余 ${item.remainingInventory} 份`)
          : `今日剩余 ${item.remainingDailyInventory} 份`
        return Object.assign({}, item, {
          description: display.description || display.subtitle || '积分兑换完整商品或非现金权益，不抵扣现金',
          inventoryText,
          availableUntilText: item.availableUntil ? String(item.availableUntil).slice(0, 10) : '',
          actionText: item.eligible ? `${item.pointsRequired}积分兑换` : (item.ineligibleReason || '暂不可兑换'),
        })
      })
      const redemptions = (results[5] || []).map((item) => Object.assign({}, item, {
        statusText: REDEMPTION_STATUS_NAMES[item.status] || '状态待确认',
        canCancel: item.status === 'awaiting_fulfillment',
      })).slice(0, 5)
      const preferenceView = customerPreferenceView(results[8])
      const contentCards = (data.content || [])
        .map(memberContentCardView)
        .sort((left, right) => left.priority - right.priority)
        .slice(0, 3)
      this.setData({
        loading: false,
        membership,
        membershipTerms: data.membershipTerms || null,
        supportContact: data.supportContact || null,
        points: (data.points || []).slice(0, 8),
        benefits,
        benefitCount: benefits.reduce((sum, item) => sum + Number(item.quantityAvailable || 0), 0),
        balanceText: '0',
        reservations,
        registrations,
        redemptionItems,
        redemptions,
        productRestrictions,
        contentCards,
        expiryNotificationOption,
        wechatNotificationAuthorizations: (results[7] && results[7].authorizations) || [],
        showRedemptions: Boolean(membership && (redemptionItems.length || redemptions.length)),
        hasTableContext: ['active', 'already_active'].includes(tableConnection.status),
        displayName: wx.getStorageSync('mbox.member.displayName') || '',
        avatarUrl: wx.getStorageSync('mbox.member.avatarUrl') || '',
        ...preferenceView,
      })
    } catch (error) {
      const message = String((error && error.message) || '')
      const soft = /预约会话已失效|重新进入预约|登录状态已失效|登录或桌边会话已过期|请求的页面或接口不存在|ROUTE_NOT_FOUND/.test(message)
        ? ''
        : (message || '会员信息暂时无法读取')
      this.setData({ loading: false, error: soft })
    }
  },

  focusJoinInvitation() {
    if (this.data.membership) {
      this.openMemberCenter()
      return
    }
    this.openLoginSheet()
  },

  onIdentityTap() {
    if (this.data.membership) return
    this.openLoginSheet()
  },

  async becomeMember() {
    if (this.data.busy) return
    if (this.data.membership) {
      wx.showToast({ title: '您已经是会员', icon: 'none' })
      return
    }
    this.openLoginSheet()
  },

  openMemberCenter() {
    if (!this.requireMembership()) return
    wx.navigateTo({ url: '/pages/points/index' })
  },

  noop() {},

  requireMembership() {
    if (this.data.membership) return true
    this.openLoginSheet()
    return false
  },

  openLoginSheet() {
    if (this.data.membership) return
    this.setData({ loginSheetVisible: true, agreedToPolicies: false, recoveryMessage: '', error: '' })
  },

  closeLoginSheet() {
    this.setData({ loginSheetVisible: false, recoveryMessage: '' })
  },

  openPrivacy() { wx.navigateTo({ url: '/pages/privacy/index' }) },


  openCustomerService() {
    const config = getRuntimeConfig()
    const url = String(config.wecomCustomerServiceUrl || '').trim()
    const corpId = String(config.wecomCorpId || '').trim()
    if (!url) {
      wx.showToast({ title: '客服链接未配置', icon: 'none' })
      return
    }
    if (!corpId) {
      wx.showModal({
        title: '客服暂未开通',
        content: '已配置客服链接，但仍需填写企业微信企业ID，并在小程序后台「功能 → 客服 → 微信客服」完成绑定后才能打开会话。',
        showCancel: false,
        confirmText: '知道了',
      })
      return
    }
    if (typeof wx.openCustomerServiceChat !== 'function') {
      wx.showToast({ title: '当前微信版本过低，请升级后重试', icon: 'none' })
      return
    }
    wx.openCustomerServiceChat({
      extInfo: { url },
      corpId,
      fail(error) {
        const raw = String((error && (error.errMsg || error.message)) || '')
        const unbound = /not\s*bind|未绑定|no permission|没有权限/i.test(raw)
        wx.showModal({
          title: unbound ? '小程序尚未绑定微信客服' : '暂时无法打开客服',
          content: unbound
            ? '代码侧企业ID与客服链接已配置。请管理员登录微信公众平台 → 功能 → 客服 → 微信客服，绑定企业ID：ww205bd249a5431d8b（须与小程序同主体）。绑定后再用真机重试。'
            : ('微信返回：' + (raw || '未知错误') + '。请确认已在公众平台绑定该企业微信客服，并用真机（非仅模拟器）打开。'),
          showCancel: false,
          confirmText: '知道了',
        })
      },
    })
  },

  onAgreementChange(event) {
    const values = event && event.detail && Array.isArray(event.detail.value) ? event.detail.value : []
    this.setData({ agreedToPolicies: values.indexOf('agree') >= 0 })
  },

  remindAgreement() {
    wx.showToast({ title: '请先勾选并同意会员协议', icon: 'none' })
  },

  async logoutMember() {
    if (this.data.logoutBusy || !this.data.membership) return
    const confirmed = await new Promise((resolve) => wx.showModal({
      title: '退出登录',
      content: '退出后需要重新授权手机号登录',
      confirmText: '退出',
      cancelText: '取消',
      success: (result) => resolve(Boolean(result.confirm)),
      fail: () => resolve(false),
    }))
    if (!confirmed) return
    this.setData({ logoutBusy: true })
    try {
      try {
        await logoutWechatIdentity()
      } catch (_error) {
        // 服务端注销失败时仍清除本地会话，避免卡在半登录态。
      }
      clearMemberLocalCache()
      wx.removeStorageSync('mbox.membership.enroll.attempt.v1')
      wx.removeStorageSync('mbox.membership.recovery.attempt.v1')
      await restartAnonymousCustomerSession()
      this.setData({
        agreedToPolicies: false,
        loginSheetVisible: false,
        membership: null,
        displayName: '',
        avatarUrl: '',
        recoveryMessage: '',
        error: '',
        benefitError: '',
        registrationError: '',
        redemptionError: '',
        preferenceError: '',
        benefits: [],
        benefitCount: 0,
        points: [],
        reservations: [],
        registrations: [],
        redemptionItems: [],
        redemptions: [],
        showRedemptions: false,
        productRestrictions: [],
        contentCards: [],
      })
      wx.showToast({ title: '已退出登录', icon: 'success', duration: 1200 })
      await this.load()
    } finally {
      this.setData({ logoutBusy: false })
    }
  },

  async quickLoginAndEnroll(event) {
    if (this.data.busy) return
    if (!this.data.agreedToPolicies) {
      this.remindAgreement()
      return
    }
    if (this.data.membership) {
      wx.showToast({ title: '您已经是会员', icon: 'none' })
      return
    }
    const terms = this.data.membershipTerms
    if (!terms) {
      wx.showModal({
        title: '暂时无法登录',
        content: '当前会员协议尚未发布，暂不能新加入会员。点单和找回原会员不受影响。',
        showCancel: false,
        confirmText: '知道了',
      })
      return
    }
    const authorization = readWechatPhoneAuthorization(event)
    if (!authorization.code) {
      this.setData({ error: authorization.message })
      wx.showToast({ title: authorization.message, icon: 'none' })
      return
    }
    this.setData({ busy: true, error: '' })
    try {
      await enrollMembership(terms.version, 'mini_profile', authorization.code)
      this.setData({ loginSheetVisible: false })
      wx.showToast({ title: '登录成功', icon: 'success', duration: 1200 })
      await this.load()
    } catch (error) {
      const message = String((error && error.message) || '')
      const friendly = /请求的页面或接口不存在|ROUTE_NOT_FOUND|会员服务暂时连不上/.test(message)
        ? '会员登录服务暂时不可用，请稍后重试或联系门店'
        : (message || '登录暂时没有完成')
      this.setData({ error: friendly })
      wx.showToast({ title: friendly, icon: 'none' })
    } finally {
      this.setData({ busy: false })
    }
  },

  onAgreePrivacyAuthorization() {},

  showMembershipTerms() {
    wx.navigateTo({ url: '/pages/membership-terms/index?source=mini_profile&action=view' })
  },

  openMembershipBenefits() {
    if (!this.requireMembership()) return
    this.showMembershipTerms()
  },

  async enableExpiryReminder() {
    const option = this.data.expiryNotificationOption
    if (!option || typeof wx.requestSubscribeMessage !== 'function') return
    try {
      const result = await new Promise((resolve, reject) => wx.requestSubscribeMessage({
        tmplIds: [option.templateId], success: resolve, fail: reject,
      }))
      const platformResult = result[option.templateId]
      if (!['accept', 'reject', 'ban'].includes(platformResult)) return
      await recordWechatNotificationAuthorization({
        notificationType: option.notificationType,
        policyId: option.policyId,
        policyVersion: option.policyVersion,
        templateId: option.templateId,
        expectedVersion: option.authorizationVersion,
        platformResult,
      })
      this.setData({ expiryNotificationOption: null })
      wx.showToast({
        title: platformResult === 'accept' ? '到期提醒已申请' : '未开启到期提醒',
        icon: 'none',
      })
    } catch (_error) {
      // Reminder permission is optional and never blocks membership use.
    }
  },

  async recoverMembership(event) {
    if (this.data.recoveryBusy) return
    if (!this.data.agreedToPolicies) {
      this.remindAgreement()
      return
    }
    const authorization = readWechatPhoneAuthorization(event)
    if (!authorization.code) {
      this.setData({ recoveryMessage: authorization.message })
      wx.showToast({ title: authorization.message, icon: 'none' })
      return
    }
    this.setData({ recoveryBusy: true, recoveryMessage: '', error: '' })
    try {
      const challenge = await startMembershipRecovery()
      const result = await verifyMembershipRecovery(challenge.challengePublicId, authorization.code)
      this.setData({ recoveryMessage: result.message || '找回申请已经提交' })
      if (result.status === 'completed') {
        this.setData({ loginSheetVisible: false })
        wx.showToast({ title: '会员已找回', icon: 'success' })
        await this.load()
      }
    } catch (error) {
      const code = String((error && error.code) || '')
      const message = String((error && error.message) || '')
      const friendly = code === 'MEMBERSHIP_RECOVERY_PHONE_NOT_CONFIGURED'
        || /微信手机号找回尚未接通/.test(message)
        ? '会员手机号校验暂时不可用，请稍后重试或联系门店协助找回'
        : /请求的页面或接口不存在|ROUTE_NOT_FOUND|会员服务暂时连不上/.test(message)
          ? '会员找回服务暂时不可用。请稍后重试；若仍失败，请联系门店协助找回。'
          : (message || '历史会员找回暂时没有完成')
      this.setData({ recoveryMessage: friendly })
      wx.showToast({ title: friendly, icon: 'none', duration: 3500 })
    } finally {
      this.setData({ recoveryBusy: false })
    }
  },

  togglePreferenceEditor() {
    this.setData({ showPreferenceEditor: !this.data.showPreferenceEditor })
  },

  togglePreferenceEvidence() {
    this.setData({ showPreferenceEvidence: !this.data.showPreferenceEvidence })
  },

  onPreferenceTypeChange(event) {
    this.setData(preferenceEditorState(Number(event.detail.value)))
  },

  onPreferenceValueChange(event) {
    this.setData({ preferenceValueIndex: Number(event.detail.value) })
  },

  onPreferenceTextInput(event) {
    this.setData({ preferenceTextValue: event.detail.value })
  },

  applyCustomerPreferenceSnapshot(snapshot) {
    this.setData(customerPreferenceView(snapshot))
  },

  async submitCustomerPreference() {
    if (this.data.preferenceBusyId) return
    const type = this.data.preferenceTypeOptions[this.data.preferenceTypeIndex]
    const selected = this.data.preferenceValueOptions[this.data.preferenceValueIndex]
    const value = this.data.preferenceUsesPicker
      ? selected && selected.code
      : String(this.data.preferenceTextValue || '').trim()
    if (!type || !value) return this.setData({ preferenceError: '请先填写偏好内容' })
    this.setData({ preferenceBusyId: 'create', preferenceError: '' })
    try {
      const snapshot = await declareCustomerPreference({ key: type.key, value, polarity: 'supports' })
      this.applyCustomerPreferenceSnapshot(snapshot)
      this.setData({ showPreferenceEditor: false, preferenceTextValue: '' })
      wx.showToast({ title: '偏好已记录', icon: 'success' })
    } catch (error) {
      this.setData({ preferenceError: error.message || '偏好暂时无法记录' })
    } finally {
      this.setData({ preferenceBusyId: '' })
    }
  },

  async correctCustomerPreference(event) {
    const key = event.currentTarget.dataset.key
    const value = event.currentTarget.dataset.value
    if (!key || !value || this.data.preferenceBusyId) return
    const confirmed = await new Promise((resolve) => wx.showModal({
      title: '纠正这项偏好？',
      content: `“${preferenceValueName(key, value)}”将标记为不符合；原记录保留为历史依据。`,
      confirmText: '确认纠正',
      success: (result) => resolve(result.confirm), fail: () => resolve(false),
    }))
    if (!confirmed) return
    const busyId = `correct:${key}:${value}`
    this.setData({ preferenceBusyId: busyId, preferenceError: '' })
    try {
      const snapshot = await declareCustomerPreference({ key, value, polarity: 'contradicts' })
      this.applyCustomerPreferenceSnapshot(snapshot)
      wx.showToast({ title: '已记录纠正', icon: 'success' })
    } catch (error) {
      this.setData({ preferenceError: error.message || '这项纠正暂时没有保存' })
    } finally {
      this.setData({ preferenceBusyId: '' })
    }
  },

  async withdrawCustomerPreference(event) {
    const publicId = event.currentTarget.dataset.id
    const source = this.data.preferenceSources.find((item) => item.publicId === publicId)
    if (!source || source.withdrawn || this.data.preferenceBusyId) return
    const confirmed = await new Promise((resolve) => wx.showModal({
      title: '撤回这条依据？',
      content: '撤回后它不再影响推荐，历史记录仍会保留。',
      confirmText: '确认撤回',
      success: (result) => resolve(result.confirm), fail: () => resolve(false),
    }))
    if (!confirmed) return
    this.setData({ preferenceBusyId: publicId, preferenceError: '' })
    try {
      const snapshot = await withdrawCustomerPreferenceSource(publicId, '顾客本人在我的页面撤回偏好依据')
      this.applyCustomerPreferenceSnapshot(snapshot)
      wx.showToast({ title: '已撤回', icon: 'success' })
    } catch (error) {
      this.setData({ preferenceError: error.message || '这条依据暂时无法撤回' })
    } finally {
      this.setData({ preferenceBusyId: '' })
    }
  },

  openMemberContentCard(event) {
    const card = this.data.contentCards.find((item) => item.code === event.currentTarget.dataset.code)
    const targetPath = card && safeContentCardTarget(card.targetPath)
    if (!targetPath) {
      wx.showToast({ title: '该内容暂不支持跳转', icon: 'none' })
      return
    }
    if (CONTENT_CARD_TAB_TARGETS.has(targetPath)) {
      wx.switchTab({ url: targetPath })
      return
    }
    wx.navigateTo({ url: targetPath })
  },

  async withdrawRestriction(event) {
    const publicId = event.currentTarget.dataset.id
    const restriction = this.data.productRestrictions.find((item) => item.publicId === publicId)
    if (!restriction || this.data.restrictionBusyId) return
    const confirmed = await new Promise((resolve) => wx.showModal({
      title: '恢复这项推荐？',
      content: `撤回后，“${restriction.productName}”可以再次进入您的推荐结果。`,
      confirmText: '确认撤回',
      success: (result) => resolve(result.confirm), fail: () => resolve(false),
    }))
    if (!confirmed) return
    this.setData({ restrictionBusyId: publicId, error: '' })
    try {
      await withdrawProductRestriction(publicId, '顾客本人在我的页面撤回')
      this.setData({
        productRestrictions: this.data.productRestrictions.filter((item) => item.publicId !== publicId),
      })
      wx.showToast({ title: '已恢复推荐', icon: 'success' })
    } catch (error) {
      this.setData({ error: error.message || '暂时无法撤回，请稍后再试' })
    } finally {
      this.setData({ restrictionBusyId: '' })
    }
  },

  async requestBenefitUse(event) {
    if (!this.requireMembership()) return
    const id = event.currentTarget.dataset.id
    if (!this.data.hasTableContext) return wx.showModal({ title: '到店后使用', content: '请入座并扫描桌码后申请使用，现场人员确认后才会核销。', showCancel: false })
    this.setData({ benefitBusyId: id, benefitError: '' })
    try {
      await reserveCustomerBenefit(id, 1)
      wx.showModal({ title: '已经申请使用', content: '权益已经为本桌暂留，需由服务人员完成实际交付和核销。', showCancel: false })
      await this.load()
    } catch (error) { this.setData({ benefitError: error.message || '权益暂时无法申请使用' }) }
    finally { this.setData({ benefitBusyId: '' }) }
  },

  async redeemItem(event) {
    if (!this.requireMembership()) return
    const id = event.currentTarget.dataset.id
    const item = this.data.redemptionItems.find((candidate) => candidate.publicId === id)
    if (!item || !item.eligible || this.data.redemptionBusyId) return
    if (item.requiresTableSession && !this.data.hasTableContext) {
      return wx.showModal({ title: '请先扫码入座', content: '该兑换需要有效桌次，入座扫描桌码后才能确认。', showCancel: false })
    }
    const confirmed = await new Promise((resolve) => wx.showModal({
      title: `确认使用 ${item.pointsRequired} 积分`,
      content: `${item.name}\n${item.description}\n积分只兑换完整商品或权益，不抵扣现金。`,
      confirmText: '确认兑换',
      success: (result) => resolve(result.confirm), fail: () => resolve(false),
    }))
    if (!confirmed) return
    this.setData({ redemptionBusyId: id, redemptionError: '' })
    try {
      await createRedemption(id)
      wx.showModal({ title: '兑换已确认', content: '积分已扣减并生成交付记录；需要制作的商品现已进入对应出品工位。', showCancel: false })
      await this.load()
    } catch (error) { this.setData({ redemptionError: error.message || '兑换没有完成' }) }
    finally { this.setData({ redemptionBusyId: '' }) }
  },

  async cancelRedemption(event) {
    if (!this.requireMembership()) return
    const id = event.currentTarget.dataset.id
    if (!id || this.data.redemptionBusyId) return
    const confirmed = await new Promise((resolve) => wx.showModal({
      title: '取消这次兑换？',
      content: '只有商品尚未开始制作时才能取消；成功取消后按原积分批次返还。',
      confirmText: '确认取消', confirmColor: '#8b3d2f',
      success: (result) => resolve(result.confirm), fail: () => resolve(false),
    }))
    if (!confirmed) return
    this.setData({ redemptionBusyId: id, redemptionError: '' })
    try { await cancelRedemptionRequest(id, '顾客在交付前取消兑换'); await this.load() }
    catch (error) { this.setData({ redemptionError: error.message || '兑换暂时不能取消' }) }
    finally { this.setData({ redemptionBusyId: '' }) }
  },

  openReservations() {
    if (!this.requireMembership()) return
    wx.switchTab({ url: '/pages/reservations/index' })
  },
  openSuperhighService() {
    if (this.data.registrations.length) {
      wx.pageScrollTo({
        selector: '#registered-activities',
        duration: 320,
        fail: () => wx.showToast({ title: '报名活动正在加载，请稍后再试', icon: 'none' }),
      })
      return
    }
    this.openSuperhighTab()
  },
  openSuperhighTab() { wx.switchTab({ url: '/pages/community/index' }) },
  openPoints() {
    if (!this.requireMembership()) return
    wx.navigateTo({ url: '/pages/points/index' })
  },
  openOrders() {
    if (!this.requireMembership()) return
    wx.navigateTo({ url: '/pages/account/index' })
  },
  openBalance() {
    if (!this.requireMembership()) return
    wx.navigateTo({ url: '/pages/account/index' })
  },
  openPreferenceSettings() {
    if (!this.requireMembership()) return
    wx.navigateTo({ url: '/pages/profile-preferences/index' })
  },
  openContact() {
    if (!this.requireMembership()) return
    wx.navigateTo({ url: '/pages/profile-contact/index' })
  },
  openCoupons() {
    if (!this.requireMembership()) return
    wx.navigateTo({ url: '/pages/profile-coupons/index' })
  },
  async openNotificationSettings() {
    const authorizations = this.data.wechatNotificationAuthorizations || []
    const options = authorizations.filter((item) => (
      item && item.templateId && item.usesRemaining <= 0 && item.platformResult !== 'ban'
    ))
    if (!options.length) {
      wx.showToast({ title: '暂无可申请的提醒', icon: 'none' })
      return
    }
    if (typeof wx.requestSubscribeMessage !== 'function') {
      wx.showToast({ title: '当前微信暂不支持订阅消息', icon: 'none' })
      return
    }
    try {
      const tmplIds = Array.from(new Set(options.map((item) => item.templateId))).slice(0, 3)
      const result = await new Promise((resolve, reject) => wx.requestSubscribeMessage({
        tmplIds, success: resolve, fail: reject,
      }))
      for (const option of options) {
        if (!tmplIds.includes(option.templateId)) continue
        const platformResult = result[option.templateId]
        if (!['accept', 'reject', 'ban'].includes(platformResult)) continue
        await recordWechatNotificationAuthorization({
          notificationType: option.notificationType,
          policyId: option.policyId,
          policyVersion: option.policyVersion,
          templateId: option.templateId,
          expectedVersion: option.authorizationVersion,
          platformResult,
        })
      }
      wx.showToast({ title: '已按你的选择处理', icon: 'none' })
      this.load()
    } catch (_error) {
      wx.showToast({ title: '未完成提醒授权', icon: 'none' })
    }
  },
  openCommunity(event) {
    if (!this.requireMembership()) return
    const activityId = String(event.currentTarget.dataset.id || '').trim()
    if (!activityId) return
    wx.navigateTo({ url: `/pages/community-detail/index?id=${encodeURIComponent(activityId)}` })
  },
})
