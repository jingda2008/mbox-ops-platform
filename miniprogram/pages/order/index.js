const {
  getGuestSession,
  getMenu,
  getPublicMenu,
  recommendExperience,
  recordRecommendationEvent,
  prepareCheckoutUpgrade,
  recordCheckoutUpgradeEvent,
  checkout,
  getTableOrders,
  retryOrderPayment,
  getTodayPerformances,
  getCustomerBenefits,
  getMiniBootstrap,
  getWechatNotificationAuthorizations,
  recordWechatNotificationAuthorization,
} = require('../../utils/api')
const { getRuntimeConfig } = require('../../config/index')
const { getTableSession } = require('../../utils/session')
const { randomId } = require('../../utils/id')
const { money, dateTime } = require('../../utils/format')
const { checkoutRecommendationAttribution } = require('../../utils/recommendation-attribution')
const { publicImageUrl } = require('../../utils/media')

const PENDING_PAYMENT_KEY = 'mbox.pending.guest.payment.v1'
const CHECKOUT_ATTEMPT_KEY = 'mbox.pending.guest.checkout.v1'
const MEMBERSHIP_INVITE_DISMISSED_KEY = 'mbox.membership.invite.dismissed.until.v1'

const OCCASIONS = [
  { code: 'date', name: '约会' }, { code: 'friends', name: '朋友聚会' },
  { code: 'business', name: '商务聊天' }, { code: 'birthday', name: '生日庆祝' },
  { code: 'music', name: '专心听歌' }, { code: 'relax', name: '轻松坐坐' },
]
const ALCOHOL = [
  { code: 'cocktail', name: '鸡尾酒' }, { code: 'wine', name: '红酒' },
  { code: 'sparkling', name: '气泡酒' }, { code: 'whisky', name: '威士忌' },
  { code: 'beer', name: '啤酒' }, { code: 'non_alcoholic', name: '无酒精' },
  { code: 'undecided', name: '请帮我选' },
]

function performanceView(view) {
  const schedule = view && (view.current || view.next)
  if (!schedule) return null
  return {
    name: schedule.performerStageName,
    state: view.current ? '正在演出' : '下一场',
    time: `${dateTime(schedule.startsAt)}–${dateTime(schedule.endsAt).slice(6)}`,
  }
}

function parseScanValue(value) {
  const raw = String(value || '').trim()
  if (!raw) return {}
  const query = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : raw
  if (!query.includes('=')) return { token: raw }
  return query.split('&').reduce((result, pair) => {
    const position = pair.indexOf('=')
    if (position < 1) return result
    const key = decodeURIComponent(pair.slice(0, position))
    const item = decodeURIComponent(pair.slice(position + 1))
    if (key === 'scene') return Object.assign(result, parseScanValue(item))
    result[key] = item
    return result
  }, {})
}

function menuProducts(items, includeUnavailable) {
  return (items || []).filter((item) => includeUnavailable || item.available).sort((left, right) => {
    if (left.productKind !== right.productKind) return left.productKind === 'bundle' ? -1 : 1
    return (left.sortOrder || 0) - (right.sortOrder || 0)
  }).map((item) => Object.assign({}, item, {
    priceText: money(item.amountMinor),
    includedText: (item.bundleComponents || []).map((line) => `${line.name || '组合内容'}×${line.quantity || 1}`).join(' · '),
    imageUrl: publicImageUrl(item.imageUrl),
    availabilityText: item.available ? '到店可点' : '暂不可点',
  }))
}

function menuCategories(products) {
  const categories = [{ code: 'all', name: '全部' }]
  products.forEach((item) => {
    if (!categories.some((category) => category.code === item.categoryCode)) {
      categories.push({ code: item.categoryCode, name: item.categoryName || item.categoryCode })
    }
  })
  return categories
}

Page({
  data: {
    loading: true,
    browseOnly: false,
    busy: false,
    error: '',
    success: '',
    connectionState: 'needs_scan',
    connectionMessage: '',
    table: null,
    performance: null,
    products: [],
    visibleProducts: [],
    categories: [{ code: 'all', name: '全部' }],
    selectedCategory: 'all',
    searchText: '',
    recommendations: [],
    recommendationPublicId: '',
    recommendationAttribution: null,
    occasionOptions: OCCASIONS,
    occasionIndex: 1,
    alcoholOptions: ALCOHOL,
    alcoholIndex: 6,
    cart: [],
    cartTotal: '¥0.00',
    cartCount: 0,
    upgradeOffer: null,
    upgradeAdd: '',
    targetTotal: '',
    pendingPayment: null,
    checkoutLocked: false,
    benefitCount: 0,
    membershipInviteVisible: false,
    membershipBusy: false,
    membershipTerms: null,
    wechatNotificationAuthorizations: [],
  },

  onShow() { this.preparePage() },
  onHide() { this.stopWaitingPoll() },
  onUnload() { this.stopWaitingPoll() },

  stopWaitingPoll() {
    if (this.waitingTimer) clearTimeout(this.waitingTimer)
    this.waitingTimer = null
  },

  scheduleWaitingPoll() {
    this.stopWaitingPoll()
    this.waitingTimer = setTimeout(() => this.preparePage(true), 6000)
  },

  async preparePage(silent) {
    this.stopWaitingPoll()
    if (!silent) this.setData({ loading: true, error: '', success: '' })
    const session = getTableSession()
    const config = getRuntimeConfig()
    if (!session.tableToken && !session.tableCode && !config.isDevelopment) {
      await this.loadBrowseData()
      return
    }
    try {
      const result = await getGuestSession()
      const connected = result.data || {}
      if (connected.status === 'waiting_for_table') {
        this.setData({
          loading: false,
          connectionState: 'waiting',
          connectionMessage: connected.message || '桌位已识别，等待工作人员开台。',
          table: connected.table || null,
        })
        this.scheduleWaitingPoll()
        return
      }
      if (!['active', 'already_active'].includes(connected.status)) {
        this.setData({ loading: false, connectionState: 'needs_scan', table: null })
        return
      }
      this.setData({ connectionState: 'active', table: connected.table || null })
      await this.loadActiveData()
    } catch (error) {
      await this.loadBrowseData(error.message || '桌台连接已失效，请重新扫描桌面二维码')
    }
  },

  async loadBrowseData(connectionError) {
    try {
      const [menu, performance] = await Promise.all([
        getPublicMenu({}),
        getTodayPerformances().catch(() => null),
      ])
      const products = menuProducts(menu, true)
      this.setData({
        loading: false,
        browseOnly: true,
        connectionState: 'needs_scan',
        table: null,
        products,
        categories: menuCategories(products),
        performance: performanceView(performance),
        error: connectionError || '',
      })
      this.applyFilters()
    } catch (error) {
      this.setData({
        loading: false,
        browseOnly: true,
        connectionState: 'needs_scan',
        table: null,
        products: [],
        visibleProducts: [],
        error: connectionError || error.message || '今晚菜单暂时无法读取，请稍后再试',
      })
    }
  },

  async loadActiveData() {
    const results = await Promise.all([
      getMenu({}),
      getTodayPerformances().catch(() => null),
      getCustomerBenefits().catch(() => []),
      getTableOrders().catch(() => []),
      getMiniBootstrap().catch(() => null),
      getWechatNotificationAuthorizations().catch(() => ({ available: false, authorizations: [] })),
    ])
    const products = menuProducts(results[0])
    const categories = menuCategories(products)
    const storedCart = wx.getStorageSync(this.cartStorageKey()) || []
    const cart = storedCart.filter((line) => products.some((product) => product.productId === line.productId))
    const tableOrders = results[3] || []
    let storedPending = wx.getStorageSync(PENDING_PAYMENT_KEY) || null
    const storedOrder = storedPending && tableOrders.find((item) => item.publicId === storedPending.orderPublicId)
    if (storedOrder && Number(storedOrder.payableAmountMinor || 0) === 0) {
      wx.removeStorageSync(PENDING_PAYMENT_KEY)
      storedPending = null
    }
    const pendingFromOrders = tableOrders.find((item) => item.isMine && Number(item.payableAmountMinor || 0) > 0
      && ['available', 'payment_in_progress', 'status_review'].includes(item.paymentAccess))
    const pendingPayment = storedPending || (pendingFromOrders ? {
      orderPublicId: pendingFromOrders.publicId,
      retryIdempotencyKey: randomId(`guest-payment-${pendingFromOrders.publicId}`),
      amountText: money(pendingFromOrders.payableAmountMinor),
      statusText: pendingFromOrders.paymentAccess === 'status_review' ? '付款结果确认中' : '还有一笔待付款',
    } : null)
    const bootstrap = results[4]
    const dismissedUntil = Number(wx.getStorageSync(MEMBERSHIP_INVITE_DISMISSED_KEY) || 0)
    this.setData({
      loading: false,
      browseOnly: false,
      products,
      categories,
      performance: performanceView(results[1]),
      benefitCount: (results[2] || []).reduce((sum, item) => sum + Number(item.quantityAvailable || 0), 0),
      pendingPayment,
      checkoutLocked: Boolean(wx.getStorageSync(CHECKOUT_ATTEMPT_KEY)),
      membershipTerms: bootstrap && bootstrap.membershipTerms ? bootstrap.membershipTerms : null,
      membershipInviteVisible: Boolean(
        bootstrap && !bootstrap.membership && bootstrap.membershipTerms && Date.now() >= dismissedUntil,
      ),
      wechatNotificationAuthorizations: (results[5] && results[5].authorizations) || [],
    })
    this.updateCart(cart, false)
    this.applyFilters()
  },

  dismissMembershipInvite() {
    const configuredHours = Number(getRuntimeConfig().membershipInviteCooldownHours)
    const cooldownHours = Number.isFinite(configuredHours) && configuredHours >= 1 && configuredHours <= 2160
      ? configuredHours : 24
    wx.setStorageSync(MEMBERSHIP_INVITE_DISMISSED_KEY, Date.now() + cooldownHours * 60 * 60 * 1000)
    this.setData({ membershipInviteVisible: false })
  },

  openMembershipRecovery() { wx.switchTab({ url: '/pages/profile/index' }) },
  openPrivacy() { wx.navigateTo({ url: '/pages/privacy/index' }) },

  showMembershipTerms() {
    if (!this.data.membershipTerms) return
    wx.navigateTo({ url: '/pages/membership-terms/index?source=mini_menu&action=view' })
  },

  enrollFromMenu() {
    if (!this.data.membershipTerms) {
      this.setData({ error: '当前入会条款尚未发布，点单不受影响' })
      return
    }
    wx.navigateTo({ url: '/pages/membership-terms/index?source=mini_menu&action=enroll' })
  },

  cartStorageKey() {
    const table = this.data.table && this.data.table.code ? this.data.table.code : getTableSession().tableCode || 'unknown'
    return `mbox.guest.cart.${table}`
  },

  scanTable() {
    wx.scanCode({
      onlyFromCamera: true,
      scanType: ['qrCode', 'wxCode'],
      success: (result) => {
        const query = parseScanValue(result.path || result.result)
        getApp().refreshRuntime({ query })
        this.preparePage()
      },
      fail: (error) => {
        if (!String(error.errMsg || '').includes('cancel')) this.setData({ error: '没有识别到有效桌码，请扫描桌面固定二维码' })
      },
    })
  },

  retryTable() { this.preparePage() },
  onSearchInput(event) { this.setData({ searchText: event.detail.value }, () => this.applyFilters()) },
  selectCategory(event) { this.setData({ selectedCategory: event.currentTarget.dataset.code }, () => this.applyFilters()) },
  applyFilters() {
    const search = this.data.searchText.trim().toLowerCase()
    const visibleProducts = this.data.products.filter((item) => {
      const categoryMatches = this.data.selectedCategory === 'all' || item.categoryCode === this.data.selectedCategory
      const searchable = [item.name, item.description, item.includedText].concat(item.aliases || []).join(' ').toLowerCase()
      return categoryMatches && (!search || searchable.includes(search))
    })
    this.setData({ visibleProducts })
  },

  onOccasionChange(event) { this.setData({ occasionIndex: Number(event.detail.value) }) },
  onAlcoholChange(event) { this.setData({ alcoholIndex: Number(event.detail.value) }) },

  async recommend() {
    if (this.data.busy) return
    this.setData({ busy: true, error: '' })
    try {
      const occasion = this.data.occasionOptions[this.data.occasionIndex].code
      const alcoholPreference = this.data.alcoholOptions[this.data.alcoholIndex].code
      const result = await recommendExperience({ occasion, alcoholPreference, experienceLevel: 'enhanced', serviceIntensity: 'balanced' })
      const recommendations = (result.recommendations || []).map((item) => Object.assign({}, item, {
        priceText: money(item.amountMinor),
        savingsText: item.savingsAmountMinor > 0 ? `比单点省 ${money(item.savingsAmountMinor)}` : '',
        tierText: item.tier === 'signature' ? '完整体验' : item.tier === 'enhanced' ? '今晚推荐' : '轻松开始',
      }))
      this.setData({ recommendations, recommendationPublicId: result.publicId || '' })
      if (result.publicId) {
        recordRecommendationEvent(result.publicId, 'exposed', null, { surface: 'guest_order_recommendations' }).catch(() => {})
      }
    } catch (error) { this.setData({ error: error.message || '暂时无法生成推荐' }) }
    finally { this.setData({ busy: false }) }
  },

  async addProduct(event) {
    if (this.data.checkoutLocked || this.data.pendingPayment) return
    const productId = event.currentTarget.dataset.id
    const product = this.data.products.concat(this.data.recommendations).find((item) => item.productId === productId)
    if (!product) return
    // 推荐只影响当前购物车。体验承诺必须在有效订单且付款门禁通过后由服务端建立，
    // 这里不能提前派发服务节点或把“选择推荐”误当作已购买权益。
    const cart = this.data.cart.map((item) => Object.assign({}, item))
    const existing = cart.find((item) => item.productId === productId)
    if (existing) existing.quantity += 1
    else cart.push({ productId, name: product.name, quantity: 1, amountMinor: product.amountMinor })
    this.updateCart(cart)
    if (event.currentTarget.dataset.source === 'recommendation' && this.data.recommendationPublicId) {
      this.setData({
        recommendationAttribution: {
          recommendationPublicId: this.data.recommendationPublicId,
          selectedProductId: productId,
        },
      })
      recordRecommendationEvent(this.data.recommendationPublicId, 'selected', productId, {
        surface: 'guest_order_recommendations',
      }).catch(() => {})
    }
  },

  async rejectRecommendation(event) {
    if (this.data.checkoutLocked || this.data.pendingPayment) return
    const productId = event.currentTarget.dataset.id
    const recommendationPublicId = this.data.recommendationPublicId
    const current = this.data.recommendations.find((item) => item.productId === productId)
    if (!current || !recommendationPublicId || current.rejecting) return
    const reasonOptions = [
      { code: 'not_now', label: '这次不需要', persistent: false },
      { code: 'dislike', label: '不喜欢这个', persistent: true },
      { code: 'allergy_or_cannot_consume', label: '过敏或不能饮用', persistent: true },
    ]
    const selectedIndex = await new Promise((resolve) => wx.showActionSheet({
      itemList: reasonOptions.map((item) => item.label),
      success: (result) => resolve(result.tapIndex),
      fail: () => resolve(-1),
    }))
    const selectedReason = reasonOptions[selectedIndex]
    if (!selectedReason) return
    if (selectedReason.persistent) {
      const confirmed = await new Promise((resolve) => wx.showModal({
        title: '保存为我的长期限制？',
        content: selectedReason.code === 'allergy_or_cannot_consume'
          ? `以后不会再向您推荐“${current.name}”。请注意：这不是医疗过敏档案，点单时仍需主动核对成分。`
          : `以后不会再向您推荐“${current.name}”，可在“我的今晚”随时撤回。`,
        confirmText: '确认保存',
        success: (result) => resolve(result.confirm),
        fail: () => resolve(false),
      }))
      if (!confirmed) return
    }
    this.setData({
      error: '',
      recommendations: this.data.recommendations.map((item) => (
        item.productId === productId ? Object.assign({}, item, { rejecting: true }) : item
      )),
    })
    try {
      await recordRecommendationEvent(recommendationPublicId, 'rejected', productId, {
        surface: 'guest_order_recommendations',
        action: selectedReason.persistent ? 'explicit_product_restriction' : 'dismiss_for_current_session',
      }, selectedReason.code)
      if (this.data.recommendationPublicId !== recommendationPublicId) return
      const attribution = this.data.recommendationAttribution
      this.setData({
        recommendations: this.data.recommendations.filter((item) => item.productId !== productId),
        recommendationAttribution: attribution && attribution.recommendationPublicId === recommendationPublicId
          && attribution.selectedProductId === productId ? null : attribution,
      })
    } catch (error) {
      if (this.data.recommendationPublicId !== recommendationPublicId) return
      this.setData({
        error: error.message || '暂时无法记录，请稍后再试',
        recommendations: this.data.recommendations.map((item) => (
          item.productId === productId ? Object.assign({}, item, { rejecting: false }) : item
        )),
      })
    }
  },

  changeQuantity(event) {
    if (this.data.checkoutLocked || this.data.pendingPayment) return
    const productId = event.currentTarget.dataset.id
    const delta = Number(event.currentTarget.dataset.delta)
    const cart = this.data.cart.map((item) => Object.assign({}, item))
    const item = cart.find((line) => line.productId === productId)
    if (item) item.quantity += delta
    const attribution = this.data.recommendationAttribution
    const removedSelectedRecommendation = Boolean(
      item && item.quantity <= 0 && attribution
      && attribution.recommendationPublicId === this.data.recommendationPublicId
      && attribution.selectedProductId === productId,
    )
    this.updateCart(cart.filter((line) => line.quantity > 0))
    if (removedSelectedRecommendation) {
      // Only an explicit removal of the selected recommendation is an ignored fact.
      // Quantity reductions that leave the item in the cart are ambiguous and are not inferred.
      recordRecommendationEvent(attribution.recommendationPublicId, 'ignored', productId, {
        surface: 'guest_order_cart',
        action: 'removed_selected_recommendation',
      }, 'removed_from_cart').catch(() => {})
    }
  },

  updateCart(cart, persist) {
    const total = cart.reduce((sum, item) => sum + item.amountMinor * item.quantity, 0)
    const attribution = this.data.recommendationAttribution
    this.setData({
      cart,
      cartTotal: money(total),
      cartCount: cart.reduce((sum, item) => sum + item.quantity, 0),
      recommendationAttribution: attribution && cart.some((item) => item.productId === attribution.selectedProductId)
        ? attribution
        : null,
    })
    if (persist !== false) wx.setStorageSync(this.cartStorageKey(), cart)
  },

  openService() { wx.navigateTo({ url: '/pages/service/index' }) },
  openStatus() { wx.navigateTo({ url: '/pages/status/index' }) },
  openAccount() { wx.navigateTo({ url: '/pages/account/index' }) },
  openBenefits() { wx.switchTab({ url: '/pages/profile/index' }) },

  async openCheckout() {
    if (!this.data.cart.length || this.data.busy || this.data.pendingPayment) return
    if (this.data.checkoutLocked) return this.retryCheckout()
    this.setData({ busy: true, error: '', upgradeOffer: null })
    const items = this.data.cart.map((item) => ({ productId: item.productId, quantity: item.quantity }))
    try {
      const offer = await prepareCheckoutUpgrade(items, this.data.occasionOptions[this.data.occasionIndex].code, this.data.alcoholOptions[this.data.alcoholIndex].code)
      if (offer) {
        this.setData({ upgradeOffer: offer, upgradeAdd: money(offer.amountToAddMinor), targetTotal: money(offer.targetExperience.totalAmountMinor) })
        recordCheckoutUpgradeEvent(offer.publicId, 'viewed', null).catch(() => {})
      } else await this.submitOrder(null, true)
    } catch (error) {
      const blockingCodes = ['GUEST_SESSION_INVALID', 'TABLE_SESSION_ENDED', 'GUEST_CAPABILITY_DENIED', 'STORE_ACCESS_FORBIDDEN']
      if (blockingCodes.includes(error && error.code)) {
        this.setData({ error: error.message || '当前桌次已失效，请重新扫码' })
      } else {
        // 付款前升级是可选建议。建议生成失败不能阻断原购物车结账；
        // 真正的桌次、商品、库存和支付校验仍由同一个下单命令失败关闭。
        await this.submitOrder(null, true)
      }
    }
    finally { this.setData({ busy: false }) }
  },

  async declineUpgrade() {
    const offer = this.data.upgradeOffer
    this.setData({ upgradeOffer: null })
    if (offer) {
      // 埋点失败不能阻断顾客按原购物车下单。
      try { await recordCheckoutUpgradeEvent(offer.publicId, 'declined', 'kept_original') } catch (_) {}
    }
    await this.submitOrder(null)
  },
  acceptUpgrade() {
    const offer = this.data.upgradeOffer
    if (!offer) return
    this.setData({ upgradeOffer: null })
    this.submitOrder(offer.publicId)
  },

  async retryCheckout() {
    const attempt = wx.getStorageSync(CHECKOUT_ATTEMPT_KEY)
    if (!attempt || !attempt.items) {
      wx.removeStorageSync(CHECKOUT_ATTEMPT_KEY)
      this.setData({ checkoutLocked: false })
      return
    }
    await this.submitOrder(attempt.offerPublicId || null, false, attempt)
  },

  async submitOrder(offerPublicId, allowBusy, previousAttempt) {
    if (this.data.busy && !allowBusy) return
    const currentAttribution = checkoutRecommendationAttribution(
      offerPublicId,
      this.data.recommendationAttribution,
    )
    const attempt = previousAttempt || {
      idempotencyKey: randomId('guest-order'),
      items: this.data.cart.map((item) => ({ productId: item.productId, quantity: item.quantity })),
      offerPublicId: offerPublicId || null,
      recommendationPublicId: currentAttribution ? currentAttribution.recommendationPublicId : null,
      selectedRecommendationProductId: currentAttribution ? currentAttribution.selectedProductId : null,
      createdAt: new Date().toISOString(),
    }
    wx.setStorageSync(CHECKOUT_ATTEMPT_KEY, attempt)
    this.setData({ busy: true, checkoutLocked: true, error: '', success: '' })
    try {
      const attemptAttribution = checkoutRecommendationAttribution(attempt.offerPublicId, {
        recommendationPublicId: attempt.recommendationPublicId,
        selectedProductId: attempt.selectedRecommendationProductId,
      })
      const result = await checkout(
        attempt.items,
        attempt.offerPublicId,
        attempt.idempotencyKey,
        attemptAttribution,
      )
      const data = result.data || result
      const pendingPayment = {
        orderPublicId: data.order.publicId,
        paymentPublicId: data.payment && data.payment.publicId,
        retryIdempotencyKey: randomId(`guest-payment-${data.order.publicId}`),
        amountText: money(data.settlement && data.settlement.payableAmountMinor),
        statusText: '订单已备好，请完成付款',
      }
      wx.setStorageSync(PENDING_PAYMENT_KEY, pendingPayment)
      wx.removeStorageSync(CHECKOUT_ATTEMPT_KEY)
      this.updateCart([])
      this.setData({ pendingPayment, checkoutLocked: false })
      await this.handlePaymentAction(data.payment && data.payment.providerAction)
    } catch (error) {
      if (String(error && error.code || '').startsWith('CHECKOUT_UPGRADE_')) {
        wx.removeStorageSync(CHECKOUT_ATTEMPT_KEY)
        this.setData({
          error: error.message || '升级内容已经变化，请重新确认后再结账。',
          checkoutLocked: false,
          upgradeOffer: null,
        })
        return
      }
      this.setData({
        error: '提交结果暂时无法确认。为避免重复订单，请先重试确认或查看桌账，不要重新选商品。',
        checkoutLocked: true,
      })
    } finally { this.setData({ busy: false }) }
  },

  async handlePaymentAction(action) {
    if (!action || action.status !== 'ready' || action.presentation !== 'jsapi' || !action.payload) {
      const pendingPayment = Object.assign({}, this.data.pendingPayment, {
        statusText: action && action.status === 'unknown' ? '付款结果确认中' : '付款未完成',
      })
      wx.setStorageSync(PENDING_PAYMENT_KEY, pendingPayment)
      this.setData({ pendingPayment })
      return
    }
    try {
      await new Promise((resolve, reject) => wx.requestPayment(Object.assign({}, action.payload, { success: resolve, fail: reject })))
      const pendingPayment = Object.assign({}, this.data.pendingPayment, { statusText: '付款已提交，到账确认中' })
      wx.setStorageSync(PENDING_PAYMENT_KEY, pendingPayment)
      this.setData({ pendingPayment, success: '付款已提交，到账结果可在本桌账单查看。' })
      this.offerOrderNotifications()
      wx.showToast({ title: '付款已提交', icon: 'none' })
    } catch (error) {
      const cancelled = String(error.errMsg || '').includes('cancel')
      const pendingPayment = Object.assign({}, this.data.pendingPayment, {
        statusText: cancelled ? '订单已保留，可稍后再付' : '付款未完成，可继续支付',
      })
      wx.setStorageSync(PENDING_PAYMENT_KEY, pendingPayment)
      this.setData({ pendingPayment, error: cancelled ? '' : '付款未完成，可继续支付，无需重新下单。' })
    }
  },

  offerOrderNotifications() {
    if (this._notificationPromptShown) return
    this._notificationPromptShown = true
    // 直接唤起微信原生订阅消息弹窗，由顾客点「允许/取消」。
    this.ensureBalanceNotificationAuthorizations()
  },

  async ensureBalanceNotificationAuthorizations() {
    const options = (this.data.wechatNotificationAuthorizations || []).filter((item) => (
      ['loyalty_points_credited', 'loyalty_points_reversed'].includes(item.notificationType)
      && item.usesRemaining <= 0 && item.platformResult !== 'ban'
    ))
    if (!options.length || typeof wx.requestSubscribeMessage !== 'function') return
    try {
      const result = await new Promise((resolve, reject) => wx.requestSubscribeMessage({
        tmplIds: Array.from(new Set(options.map((item) => item.templateId))),
        success: resolve,
        fail: reject,
      }))
      for (const option of options) {
        const platformResult = result[option.templateId]
        if (!['accept', 'reject', 'ban'].includes(platformResult)) continue
        const recorded = await recordWechatNotificationAuthorization({
          notificationType: option.notificationType,
          policyId: option.policyId,
          policyVersion: option.policyVersion,
          templateId: option.templateId,
          expectedVersion: option.authorizationVersion,
          platformResult,
        })
        this.setData({
          wechatNotificationAuthorizations: this.data.wechatNotificationAuthorizations.map((item) => (
            item.policyId === option.policyId ? Object.assign({}, item, {
              decision: recorded.decision,
              authorizationVersion: recorded.authorizationVersion,
              platformResult,
              usesRemaining: platformResult === 'accept' ? 1 : 0,
            }) : item
          )),
        })
      }
    } catch (_error) {
      // Notification permission is optional and must never block payment.
    }
  },

  async continuePayment() {
    const pending = this.data.pendingPayment
    if (!pending || this.data.busy) return
    this.setData({ busy: true, error: '' })
    try {
      const retryIdempotencyKey = pending.retryIdempotencyKey || randomId(`guest-payment-${pending.orderPublicId}`)
      const normalizedPending = Object.assign({}, pending, { retryIdempotencyKey })
      wx.setStorageSync(PENDING_PAYMENT_KEY, normalizedPending)
      this.setData({ pendingPayment: normalizedPending })
      const action = await retryOrderPayment(pending.orderPublicId, retryIdempotencyKey)
      await this.handlePaymentAction(action)
    } catch (error) {
      this.setData({ error: error.message || '暂时无法恢复付款，请在桌账确认状态或联系服务人员' })
    } finally { this.setData({ busy: false }) }
  },
})
