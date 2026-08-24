const {
  getGuestSession,
  getMenu,
  getPublicMenu,
  recommendExperience,
  recordRecommendationEvent,
  prepareCheckoutUpgrade,
  recordCheckoutUpgradeEvent,
  checkoutSharedCart,
  getSharedCart,
  adjustSharedCart,
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
const { customerErrorMessage, isWechatCancellation } = require('../../utils/customer-error')

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

function menuAvailability(item) {
  if (item.available) return { text: '可下单', detail: '当前桌可直接加入购物车' }
  if (item.availabilityStatus === 'configuration_incomplete') {
    return { text: '暂不可点', detail: '库存或配方配置未完成' }
  }
  if (item.availabilityStatus === 'inventory_unavailable') {
    return { text: '暂不可点', detail: '当前可售库存不足' }
  }
  if (item.availabilityStatus === 'scheduled') {
    const range = item.availableFrom && item.availableUntil ? `供应时间 ${item.availableFrom}-${item.availableUntil}` : '当前不在供应时段'
    return { text: '暂不可点', detail: range }
  }
  return { text: '暂不可点', detail: '当前暂不能下单' }
}

function menuProducts(items) {
  return (items || []).sort((left, right) => {
    if (left.productKind !== right.productKind) return left.productKind === 'bundle' ? -1 : 1
    return (left.sortOrder || 0) - (right.sortOrder || 0)
  }).map((item) => {
    const availability = menuAvailability(item)
    return Object.assign({}, item, {
      priceText: money(item.amountMinor),
      includedText: (item.bundleComponents || []).map((line) => `${line.name || '组合内容'}×${line.quantity || 1}`).join(' · '),
      imageUrl: publicImageUrl(item.imageUrl),
      availabilityText: availability.text,
      availabilityDetail: availability.detail,
    })
  })
}

function menuRecommendations(items, products) {
  const orderableProducts = new Map((products || [])
    .filter((product) => product.available)
    .map((product) => [product.productId, product]))
  return (items || []).map((item) => {
    const product = orderableProducts.get(item.productId)
    if (!product) return null
    return Object.assign({}, item, {
      name: product.name,
      amountMinor: product.amountMinor,
      currency: product.currency,
      imageUrl: product.imageUrl,
      description: product.description,
      includedText: product.includedText,
    })
  }).filter(Boolean)
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

function sharedCartView(sharedCart, products) {
  const byProductId = new Map((products || []).map((product) => [product.productId, product]))
  return (sharedCart && Array.isArray(sharedCart.lines) ? sharedCart.lines : []).map((line) => {
    const product = byProductId.get(line.productId)
    const amountMinor = Number(line.unitPriceMinor)
    const subtotalAmountMinor = Number(line.subtotalAmountMinor)
    const available = line.available === true
      && Number.isSafeInteger(amountMinor)
      && amountMinor >= 0
      && Number.isSafeInteger(subtotalAmountMinor)
      && subtotalAmountMinor >= 0
    return {
      productId: line.productId,
      quantity: Number(line.quantity || 0),
      name: typeof line.name === 'string' && line.name.trim() ? line.name : '暂不可用商品',
      amountMinor: available ? amountMinor : 0,
      subtotalAmountMinor: available ? subtotalAmountMinor : 0,
      priceText: available ? money(amountMinor) : '价格待确认',
      subtotalText: available ? money(subtotalAmountMinor) : '暂不可结算',
      available: available && Boolean(product && product.available),
    }
  }).filter((line) => line.quantity > 0)
}

Page({
  data: {
    loading: true,
    browseOnly: false,
    browseCatalogLoaded: false,
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
    cartVersion: 0,
    cartGeneration: 0,
    cartSyncing: false,
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
  onHide() { this.stopWaitingPoll(); this.stopSharedCartPolling() },
  onUnload() { this.stopWaitingPoll(); this.stopSharedCartPolling() },

  stopWaitingPoll() {
    if (this.waitingTimer) clearTimeout(this.waitingTimer)
    this.waitingTimer = null
  },

  scheduleWaitingPoll() {
    this.stopWaitingPoll()
    this.waitingTimer = setTimeout(() => this.preparePage(true), 6000)
  },

  stopSharedCartPolling() {
    if (this.sharedCartTimer) clearTimeout(this.sharedCartTimer)
    this.sharedCartTimer = null
    this.sharedCartPollFailures = 0
  },

  startSharedCartPolling() {
    this.stopSharedCartPolling()
    this.scheduleSharedCartPoll(5000)
  },

  scheduleSharedCartPoll(delay) {
    if (this.data.connectionState !== 'active' || this.data.checkoutLocked) return
    this.sharedCartTimer = setTimeout(async () => {
      this.sharedCartTimer = null
      const synchronized = await this.refreshSharedCart(true)
      this.sharedCartPollFailures = synchronized ? 0 : (this.sharedCartPollFailures || 0) + 1
      const nextDelay = Math.min(60000, 5000 * (2 ** Math.min(this.sharedCartPollFailures, 4)))
      this.scheduleSharedCartPoll(nextDelay)
    }, delay)
  },

  async preparePage(silent) {
    this.stopWaitingPoll()
    this.stopSharedCartPolling()
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
        const waitingView = {
          connectionState: 'waiting',
          connectionMessage: '请联系服务人员开台。开台后可直接下单。',
          table: connected.table || null,
        }
        if (this.data.browseCatalogLoaded) this.setData(Object.assign({ loading: false }, waitingView))
        else await this.loadBrowseData('', waitingView)
        this.scheduleWaitingPoll()
        return
      }
      if (!['active', 'already_active'].includes(connected.status)) {
        this.setData({ loading: false, connectionState: 'needs_scan', table: null })
        return
      }
      if (Number(connected.cartProtocolVersion) !== 2) {
        await this.loadBrowseData('', {
          connectionState: 'upgrade_required',
          connectionMessage: '本桌正在完成旧版点单。为避免两套购物车混用，请在结台后重新扫码。',
          table: connected.table || null,
        })
        return
      }
      this.setData({ connectionState: 'active', table: connected.table || null })
      await this.loadActiveData()
    } catch (error) {
      await this.loadBrowseData(customerErrorMessage(error, '桌台连接已失效，请重新扫描桌面二维码'))
    }
  },

  async loadBrowseData(connectionError, view) {
    const browseView = Object.assign({
      connectionState: 'needs_scan',
      connectionMessage: '',
      table: null,
    }, view || {})
    try {
      const [menu, performance] = await Promise.all([
        getPublicMenu({}),
        getTodayPerformances().catch(() => null),
      ])
      const products = menuProducts(menu)
      this.setData({
        loading: false,
        browseOnly: true,
        browseCatalogLoaded: true,
        connectionState: browseView.connectionState,
        connectionMessage: browseView.connectionMessage,
        table: browseView.table,
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
        browseCatalogLoaded: false,
        connectionState: browseView.connectionState,
        connectionMessage: browseView.connectionMessage,
        table: browseView.table,
        products: [],
        visibleProducts: [],
        error: connectionError || customerErrorMessage(error, '今晚菜单暂时无法读取，请稍后再试'),
      })
    }
  },

  async loadActiveData() {
    const results = await Promise.all([
      getMenu({}),
      getTodayPerformances().catch(() => null),
      getCustomerBenefits().catch(() => []),
      getTableOrders().catch(() => []),
      getSharedCart(),
      getMiniBootstrap().catch(() => null),
      getWechatNotificationAuthorizations().catch(() => ({ available: false, authorizations: [] })),
    ])
    const products = menuProducts(results[0])
    const categories = menuCategories(products)
    const sharedCart = results[4]
    const cart = sharedCartView(sharedCart, products)
    const recommendations = menuRecommendations(this.data.recommendations, products)
    const recommendationAttribution = this.data.recommendationAttribution
      && recommendations.some((item) => item.productId === this.data.recommendationAttribution.selectedProductId)
      ? this.data.recommendationAttribution
      : null
    const tableOrders = results[3] || []
    let storedPending = wx.getStorageSync(PENDING_PAYMENT_KEY) || null
    const storedOrder = storedPending && tableOrders.find((item) => item.publicId === storedPending.orderPublicId)
    if (storedOrder && Number(storedOrder.payableAmountMinor || 0) === 0) {
      wx.removeStorageSync(PENDING_PAYMENT_KEY)
      storedPending = null
    }
    const pendingFromOrders = tableOrders.find((item) => Number(item.payableAmountMinor || 0) > 0
      && ['available', 'payment_in_progress', 'status_review'].includes(item.paymentAccess))
    const pendingPayment = storedPending || (pendingFromOrders ? {
      orderPublicId: pendingFromOrders.publicId,
      retryIdempotencyKey: randomId(`guest-payment-${pendingFromOrders.publicId}`),
      amountText: money(pendingFromOrders.payableAmountMinor),
      statusText: pendingFromOrders.paymentAccess === 'status_review' ? '付款结果确认中' : '还有一笔待付款',
    } : null)
    const bootstrap = results[5]
    this.setData({
      loading: false,
      browseOnly: false,
      products,
      categories,
      recommendations,
      recommendationAttribution,
      performance: performanceView(results[1]),
      benefitCount: (results[2] || []).reduce((sum, item) => sum + Number(item.quantityAvailable || 0), 0),
      pendingPayment,
      checkoutLocked: Boolean(wx.getStorageSync(CHECKOUT_ATTEMPT_KEY)),
      membershipTerms: bootstrap && bootstrap.membershipTerms ? bootstrap.membershipTerms : null,
      membershipInviteVisible: false,
      wechatNotificationAuthorizations: (results[6] && results[6].authorizations) || [],
    })
    this.updateCart(cart, sharedCart)
    this.applyFilters()
    this.startSharedCartPolling()
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
      const recommendations = menuRecommendations(result.recommendations, this.data.products).map((item) => Object.assign({}, item, {
        priceText: money(item.amountMinor),
        savingsText: item.savingsAmountMinor > 0 ? `比单点省 ${money(item.savingsAmountMinor)}` : '',
        tierText: item.tier === 'signature' ? '完整体验' : item.tier === 'enhanced' ? '今晚推荐' : '轻松开始',
      }))
      this.setData({
        recommendations,
        recommendationPublicId: recommendations.length ? result.publicId || '' : '',
        recommendationAttribution: null,
      })
      if (result.publicId && recommendations.length) {
        recordRecommendationEvent(result.publicId, 'exposed', null, { surface: 'guest_order_recommendations' }).catch(() => {})
      }
    } catch (error) { this.setData({ error: customerErrorMessage(error, '暂时无法生成推荐') }) }
    finally { this.setData({ busy: false }) }
  },

  async addProduct(event) {
    if (this.data.checkoutLocked || this.data.pendingPayment) return
    const productId = event.currentTarget.dataset.id
    const product = this.data.products.find((item) => item.productId === productId)
    if (!product || !product.available) {
      wx.showToast({ title: '这款商品当前暂不可点', icon: 'none' })
      return
    }
    if (!await this.adjustSharedCart(productId, 1)) return
    // 推荐只影响当前购物车。体验承诺必须在有效订单且付款门禁通过后由服务端建立，
    // 这里不能提前派发服务节点或把“选择推荐”误当作已购买权益。
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
        error: customerErrorMessage(error, '暂时无法记录，请稍后再试'),
        recommendations: this.data.recommendations.map((item) => (
          item.productId === productId ? Object.assign({}, item, { rejecting: false }) : item
        )),
      })
    }
  },

  async changeQuantity(event) {
    if (this.data.checkoutLocked || this.data.pendingPayment) return
    const productId = event.currentTarget.dataset.id
    const delta = Number(event.currentTarget.dataset.delta)
    const product = this.data.products.find((item) => item.productId === productId)
    if (delta > 0 && (!product || !product.available)) {
      wx.showToast({ title: '这款商品当前暂不可点', icon: 'none' })
      return
    }
    const item = this.data.cart.find((line) => line.productId === productId)
    if (!item) return
    const attribution = this.data.recommendationAttribution
    const removedSelectedRecommendation = Boolean(
      item && item.quantity + delta <= 0 && attribution
      && attribution.recommendationPublicId === this.data.recommendationPublicId
      && attribution.selectedProductId === productId,
    )
    if (!await this.adjustSharedCart(productId, delta)) return
    if (removedSelectedRecommendation) {
      // Only an explicit removal of the selected recommendation is an ignored fact.
      // Quantity reductions that leave the item in the cart are ambiguous and are not inferred.
      recordRecommendationEvent(attribution.recommendationPublicId, 'ignored', productId, {
        surface: 'guest_order_cart',
        action: 'removed_selected_recommendation',
      }, 'removed_from_cart').catch(() => {})
    }
  },

  updateCart(cart, sharedCart) {
    const serverTotal = sharedCart && Number(sharedCart.totalAmountMinor)
    const total = Number.isSafeInteger(serverTotal) && serverTotal >= 0
      ? serverTotal
      : cart.reduce((sum, item) => sum + item.subtotalAmountMinor, 0)
    const attribution = this.data.recommendationAttribution
    this.setData({
      cart,
      cartTotal: money(total),
      cartCount: cart.reduce((sum, item) => sum + item.quantity, 0),
      cartVersion: sharedCart ? Number(sharedCart.version || 0) : this.data.cartVersion,
      cartGeneration: sharedCart ? Number(sharedCart.generation || 0) : this.data.cartGeneration,
      recommendationAttribution: attribution && cart.some((item) => item.productId === attribution.selectedProductId)
        ? attribution
        : null,
    })
  },

  async refreshSharedCart(silent) {
    if (this.data.connectionState !== 'active' || this.data.checkoutLocked) return
    try {
      const sharedCart = await getSharedCart()
      this.updateCart(sharedCartView(sharedCart, this.data.products), sharedCart)
      return true
    } catch (error) {
      if (!silent) this.setData({ error: customerErrorMessage(error, '购物车暂时无法同步，请稍后重试') })
      return false
    }
  },

  async adjustSharedCart(productId, delta) {
    if (this.data.cartSyncing) return false
    this.setData({ cartSyncing: true, error: '' })
    try {
      const sharedCart = await adjustSharedCart(
        productId, delta, this.data.cartVersion, randomId('shared-cart-adjust'),
      )
      this.updateCart(sharedCartView(sharedCart, this.data.products), sharedCart)
      return true
    } catch (error) {
      if (error && error.code === 'SHARED_CART_VERSION_CONFLICT') {
        await this.refreshSharedCart(true)
        this.setData({ error: '同桌购物车已经更新，已为你刷新，请确认后再操作。' })
      } else {
        this.setData({ error: customerErrorMessage(error, '购物车暂时无法更新，请稍后重试') })
      }
      return false
    } finally { this.setData({ cartSyncing: false }) }
  },

  openService() { wx.navigateTo({ url: '/pages/service/index' }) },
  openStatus() { wx.navigateTo({ url: '/pages/status/index' }) },
  openAccount() { wx.navigateTo({ url: '/pages/account/index' }) },
  openBenefits() { wx.switchTab({ url: '/pages/profile/index' }) },

  async openCheckout() {
    if (!this.data.cart.length || this.data.busy || this.data.pendingPayment) return
    if (this.data.checkoutLocked) return this.retryCheckout()
    if (this.data.cart.some((item) => !item.available)) {
      this.setData({ error: '购物车中有暂不可用商品，请先移除后再结账。' })
      return
    }
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
        this.setData({ error: customerErrorMessage(error, '当前桌次已失效，请重新扫码') })
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
      try { await recordCheckoutUpgradeEvent(offer.publicId, 'declined', 'kept_original') } catch {}
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
    if (!attempt || !Number.isSafeInteger(attempt.expectedVersion)) {
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
      expectedVersion: this.data.cartVersion,
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
      const result = await checkoutSharedCart({
        expectedVersion: attempt.expectedVersion,
        checkoutUpgradeOfferPublicId: attempt.offerPublicId,
        recommendationAttribution: attemptAttribution,
      }, attempt.idempotencyKey)
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
      this.updateCart([], data.sharedCart || null)
      this.setData({ pendingPayment, checkoutLocked: false })
      await this.handlePaymentAction(data.payment && data.payment.providerAction)
    } catch (error) {
      if (error && error.code === 'SHARED_CART_VERSION_CONFLICT') {
        wx.removeStorageSync(CHECKOUT_ATTEMPT_KEY)
        await this.refreshSharedCart(true)
        this.setData({
          error: '同桌购物车已经更新，原结账请求没有提交。请确认最新商品后再结账。',
          checkoutLocked: false,
          upgradeOffer: null,
        })
        return
      }
      if (String(error && error.code || '').startsWith('CHECKOUT_UPGRADE_')) {
        wx.removeStorageSync(CHECKOUT_ATTEMPT_KEY)
        this.setData({
          error: customerErrorMessage(error, '升级内容已经变化，请重新确认后再结账。'),
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
      const cancelled = isWechatCancellation(error)
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
    } catch {
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
      this.setData({ error: customerErrorMessage(error, '暂时无法恢复付款，请在桌账确认状态或联系服务人员') })
    } finally { this.setData({ busy: false }) }
  },
})
