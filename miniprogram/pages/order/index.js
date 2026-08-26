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
  removeSharedCartLine,
  clearSharedCart,
  getTableOrders,
  retryOrderPayment,
  getTodayPerformances,
  getCustomerBenefits,
  getMiniBootstrap,
  getWechatNotificationAuthorizations,
  recordWechatNotificationAuthorization,
  createServiceTask,
  getServiceRequests,
} = require('../../utils/api')
const { getRuntimeConfig } = require('../../config/index')
const { getTableSession, tableSessionCacheScope } = require('../../utils/session')
const { createTableRequestGuard, tableRequestScope } = require('../../utils/table-request-scope')
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
const LEGACY_MENU_CATEGORY_HIERARCHY = Object.freeze({
  cocktail: { name: '鸡尾酒', parentCode: 'drinks', parentName: '酒水', parentSortOrder: 20, sortOrder: 10 },
  beer: { name: '啤酒', parentCode: 'drinks', parentName: '酒水', parentSortOrder: 20, sortOrder: 20 },
  wine: { name: '葡萄酒', parentCode: 'drinks', parentName: '酒水', parentSortOrder: 20, sortOrder: 30 },
  sparkling: { name: '起泡酒', parentCode: 'drinks', parentName: '酒水', parentSortOrder: 20, sortOrder: 40 },
  whisky: { name: '威士忌', parentCode: 'drinks', parentName: '酒水', parentSortOrder: 20, sortOrder: 50 },
  spirits: { name: '烈酒', parentCode: 'drinks', parentName: '酒水', parentSortOrder: 20, sortOrder: 60 },
  non_alcoholic: { name: '无酒精', parentCode: 'drinks', parentName: '酒水', parentSortOrder: 20, sortOrder: 70 },
  fruit: { name: '鲜果', parentCode: 'food', parentName: '鲜果与冷食', parentSortOrder: 30, sortOrder: 10 },
  cold_food: { name: '冷食', parentCode: 'food', parentName: '鲜果与冷食', parentSortOrder: 30, sortOrder: 20 },
  snack: { name: '小食', parentCode: 'food', parentName: '鲜果与冷食', parentSortOrder: 30, sortOrder: 30 },
})
const SERVICE_STATUS_NAMES = {
  pending: '等待接单', accepted: '服务人员已接单', arrived: '服务人员已到桌',
  in_progress: '正在处理', completed: '等待您确认', confirmed: '已解决',
  reopened: '正在继续处理', escalated: '已升级处理', cancelled: '已取消', expired: '已失效',
}
const ACTIVE_SERVICE_STATUSES = ['pending', 'accepted', 'arrived', 'in_progress', 'completed', 'reopened', 'escalated']
const QUICK_SERVICE_REQUESTS = {
  call: { requestType: 'call_staff', detail: '顾客请求服务人员到桌协助', pendingText: '正在通知服务人员' },
  celebration: { requestType: 'custom', detail: '【生日/个性化需求】请服务人员到桌沟通确认', pendingText: '正在安排沟通' },
  complaint: { requestType: 'complaint', detail: '顾客请求负责人到桌协助处理不满意事项', pendingText: '正在通知负责人' },
}

function performanceView(view) {
  const schedule = view && (view.current || view.next)
  if (!schedule) return null
  return {
    name: schedule.performerStageName,
    state: view.current ? '正在演出' : '下一场',
    time: `${dateTime(schedule.startsAt)}–${dateTime(schedule.endsAt).slice(6)}`,
  }
}

async function loadPerformanceView() {
  try {
    return { performance: performanceView(await getTodayPerformances()), error: '' }
  } catch (error) {
    return {
      performance: null,
      error: customerErrorMessage(error, '演出信息暂时未更新，请点一下重试'),
    }
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
    return { text: '暂不可点', detail: '这款暂未开放' }
  }
  if (item.availabilityStatus === 'inventory_unavailable') {
    return { text: '暂不可点', detail: '这款暂时售罄' }
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
      categoryName: customerCategoryName(item),
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
  return (items || []).map((item, index) => {
    const product = orderableProducts.get(item.productId)
    if (!product) return null
    return Object.assign({}, item, {
      name: product.name,
      amountMinor: product.amountMinor,
      currency: product.currency,
      imageUrl: product.imageUrl,
      description: product.description,
      includedText: product.includedText,
      separatePriceText: Number(item.separateAmountMinor || 0) > Number(item.amountMinor || 0)
        ? money(item.separateAmountMinor) : '',
      marketingLabel: item.marketingLabel || (index === 0 ? '今晚优先推荐' : ''),
    })
  }).filter(Boolean)
}

function serviceSummaryView(response, serviceStaffName) {
  if (!response) return {
    status: 'unavailable', label: '服务进展暂时不可用', detail: '点击查看服务进展', live: false,
  }
  const items = Array.isArray(response) ? response : (response.tasks || [])
  const active = items.filter((item) => ACTIVE_SERVICE_STATUSES.includes(String(item.status || item.taskStatus || 'pending')))
    .toSorted((left, right) => String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || '')))
  const latest = active[0]
  if (latest) {
    const status = String(latest.status || latest.taskStatus || 'pending')
    return {
      status,
      label: SERVICE_STATUS_NAMES[status] || '服务处理中',
      detail: latest.requestType === 'complaint' ? '负责人正在跟进' : latest.detail || '本桌请求已送达',
      live: true,
    }
  }
  return {
    status: 'ready', label: serviceStaffName ? '本桌服务已安排' : '需要时随时呼叫',
    detail: serviceStaffName || '有新进展会显示在这里', live: true,
  }
}

function categoryText(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text || fallback
}

function customerCategoryName(item) {
  const categoryCode = categoryText(item && item.categoryCode, 'other').toLowerCase()
  const categoryName = categoryText(item && item.categoryName, '')
  const legacyCategory = LEGACY_MENU_CATEGORY_HIERARCHY[categoryCode]
  // Old servers may echo an operational category code as its display name.
  // Do not expose that code to customers while the server is being upgraded;
  // the category configuration becomes authoritative as soon as it is present.
  if (!categoryName || categoryName.toLowerCase() === categoryCode) return legacyCategory ? legacyCategory.name : '其他'
  return categoryName
}

function menuCategoryIdentity(item) {
  const categoryCode = categoryText(item && item.categoryCode, 'other')
  const normalizedCategoryCode = categoryCode.toLowerCase()
  const rawCategoryName = categoryText(item && item.categoryName, '')
  const categoryName = customerCategoryName(item)
  const parentCode = categoryText(item && item.categoryParentCode, '')
  const parentName = categoryText(item && item.categoryParentName, '')
  const categorySortOrder = Number.isFinite(Number(item && item.categorySortOrder))
    ? Number(item.categorySortOrder) : 9000
  const topCategorySortOrder = Number.isFinite(Number(item && item.topCategorySortOrder))
    ? Number(item.topCategorySortOrder) : categorySortOrder
  const legacyCategory = LEGACY_MENU_CATEGORY_HIERARCHY[normalizedCategoryCode]
  const legacyUnparentedCategory = parentCode === '' && legacyCategory
    && (!rawCategoryName || rawCategoryName.toLowerCase() === normalizedCategoryCode || rawCategoryName === legacyCategory.name)
  if (legacyUnparentedCategory) {
    return {
      topCode: legacyCategory.parentCode,
      topName: legacyCategory.parentName,
      topSortOrder: legacyCategory.parentSortOrder,
      childCode: normalizedCategoryCode,
      childName: legacyCategory.name,
      childSortOrder: Number.isFinite(Number(item && item.categorySortOrder))
        ? Number(item.categorySortOrder) : legacyCategory.sortOrder,
    }
  }
  const legacyUnconfigured = parentCode === '' && categoryName === '其他'
  if (legacyUnconfigured) {
    return {
      topCode: 'other',
      topName: '其他',
      topSortOrder: 9000,
      childCode: '',
      childName: '',
      childSortOrder: 9000,
    }
  }
  return {
    topCode: parentCode || categoryCode,
    topName: parentName || categoryName,
    topSortOrder: topCategorySortOrder,
    childCode: parentCode ? categoryCode : '',
    childName: parentCode ? categoryName : '',
    childSortOrder: categorySortOrder,
  }
}

function menuCategoryState(products, selectedTopCategory, selectedSubcategory, includeRecommendations = false) {
  const roots = new Map()
  const childrenByRoot = new Map()
  ;(products || []).forEach((item) => {
    const category = menuCategoryIdentity(item)
    const existingRoot = roots.get(category.topCode)
    if (!existingRoot || category.topSortOrder < existingRoot.sortOrder) {
      roots.set(category.topCode, { code: category.topCode, name: category.topName, sortOrder: category.topSortOrder })
    }
    if (category.childCode) {
      const children = childrenByRoot.get(category.topCode) || new Map()
      const existingChild = children.get(category.childCode)
      if (!existingChild || category.childSortOrder < existingChild.sortOrder) {
        children.set(category.childCode, { code: category.childCode, name: category.childName, sortOrder: category.childSortOrder })
      }
      childrenByRoot.set(category.topCode, children)
    }
  })
  const leadingCategories = includeRecommendations
    ? [{ code: 'recommendation', name: '今夜推荐', sortOrder: -2 }, { code: 'all', name: '全部', sortOrder: -1 }]
    : [{ code: 'all', name: '全部', sortOrder: -1 }]
  const categories = leadingCategories.concat(
    Array.from(roots.values()).sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, 'zh-CN')),
  )
  const fallbackTopCode = includeRecommendations ? 'recommendation' : 'all'
  const topCode = categories.some((item) => item.code === selectedTopCategory) ? selectedTopCategory : fallbackTopCode
  const children = topCode === 'all' || topCode === 'recommendation'
    ? []
    : Array.from((childrenByRoot.get(topCode) || new Map()).values())
      .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, 'zh-CN'))
  const subcategories = children.length === 0
    ? []
    : [{ code: 'all', name: '全部', sortOrder: -1 }].concat(children)
  const subcategoryCode = subcategories.some((item) => item.code === selectedSubcategory)
    ? selectedSubcategory : 'all'
  return {
    categories,
    selectedCategory: topCode,
    subcategories,
    selectedSubcategory: subcategoryCode,
  }
}

function publicServiceName(value) {
  const name = typeof value === 'string' ? value.trim() : ''
  return name.length >= 1 && name.length <= 80 ? name : ''
}

function cartUnavailableReason(value, product) {
  const serverReason = typeof value === 'string' ? value.trim() : ''
  if (serverReason) return serverReason
  const menuReason = product && typeof product.availabilityDetail === 'string'
    ? product.availabilityDetail.trim() : ''
  return menuReason || '商品信息正在更新，暂不可结算'
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
      unavailableReason: available && Boolean(product && product.available)
        ? '' : cartUnavailableReason(line.unavailableReason, product),
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
    serviceStaffName: '',
    serviceSummary: { status: 'ready', label: '需要时随时呼叫', detail: '有新进展会显示在这里', live: false },
    quickServiceBusy: '',
    performance: null,
    performanceError: '',
    products: [],
    visibleProducts: [],
    categories: [{ code: 'recommendation', name: '今夜推荐' }, { code: 'all', name: '全部' }],
    selectedCategory: 'recommendation',
    subcategories: [],
    selectedSubcategory: 'all',
    searchText: '',
    recommendations: [],
    recommendationBusy: false,
    recommendationError: '',
    shakeArmed: false,
    recommendationPublicId: '',
    recommendationAttribution: null,
    occasionOptions: OCCASIONS,
    occasionIndex: 1,
    alcoholOptions: ALCOHOL,
    alcoholIndex: 6,
    cart: [],
    cartVersion: 0,
    cartGeneration: 0,
    cartWritesFrozen: false,
    cartSyncing: false,
    clearingCart: false,
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

  onLoad() { this.ensureTableRequestGuard() },
  onShow() { this.preparePage() },
  onHide() {
    this.invalidateTableRequests()
    this.stopWaitingPoll(); this.stopSharedCartPolling(); this.stopServicePolling(); this.stopShakeRecommendation()
  },
  onUnload() {
    this.invalidateTableRequests()
    this.stopWaitingPoll(); this.stopSharedCartPolling(); this.stopServicePolling(); this.stopShakeRecommendation()
  },

  ensureTableRequestGuard() {
    if (!this.tableRequestGuard) {
      this.tableRequestGuard = createTableRequestGuard(() => tableRequestScope(getTableSession()))
    }
    return this.tableRequestGuard
  },

  beginTableRequest(session) {
    return this.ensureTableRequestGuard().begin(tableRequestScope(session || getTableSession()))
  },
  rebaseTableRequest(request) {
    const rebased = this.ensureTableRequestGuard().rebase(request, tableRequestScope(getTableSession()))
    if (rebased) this.visibleTableScope = request.scope
    return rebased
  },
  currentTableRequest() { return this.ensureTableRequestGuard().current() },
  isCurrentTableRequest(request) { return this.ensureTableRequestGuard().isCurrent(request) },
  invalidateTableRequests() { this.ensureTableRequestGuard().invalidate() },

  stopWaitingPoll() {
    if (this.waitingTimer) clearTimeout(this.waitingTimer)
    this.waitingTimer = null
  },

  scheduleWaitingPoll(request) {
    this.stopWaitingPoll()
    this.waitingTimer = setTimeout(() => {
      if (request && !this.isCurrentTableRequest(request)) return
      this.preparePage(true)
    }, 6000)
  },

  stopSharedCartPolling() {
    if (this.sharedCartTimer) clearTimeout(this.sharedCartTimer)
    this.sharedCartTimer = null
    this.sharedCartPollFailures = 0
  },

  stopServicePolling() {
    if (this.serviceTimer) clearTimeout(this.serviceTimer)
    this.serviceTimer = null
  },

  scheduleServicePoll(request) {
    this.stopServicePolling()
    const expected = request || this.currentTableRequest()
    if (!expected || !this.isCurrentTableRequest(expected) || this.data.connectionState !== 'active') return
    this.serviceTimer = setTimeout(async () => {
      this.serviceTimer = null
      if (!this.isCurrentTableRequest(expected)) return
      await this.refreshServiceSummary(true, expected)
      if (this.isCurrentTableRequest(expected)) this.scheduleServicePoll(expected)
    }, 6000)
  },

  startServicePolling(request) { this.scheduleServicePoll(request) },

  stopShakeRecommendation() {
    if (this.shakeFallbackTimer) clearTimeout(this.shakeFallbackTimer)
    this.shakeFallbackTimer = null
    if (this.shakeListener && wx.offAccelerometerChange) wx.offAccelerometerChange(this.shakeListener)
    this.shakeListener = null
    if (wx.stopAccelerometer) wx.stopAccelerometer({ fail: () => {} })
    if (this.data.shakeArmed) this.setData({ shakeArmed: false })
  },

  startSharedCartPolling(request) {
    this.stopSharedCartPolling()
    this.scheduleSharedCartPoll(5000, request)
  },

  scheduleSharedCartPoll(delay, request) {
    const expected = request || this.currentTableRequest()
    if (!expected || !this.isCurrentTableRequest(expected)
      || this.data.connectionState !== 'active' || this.data.checkoutLocked) return
    this.sharedCartTimer = setTimeout(async () => {
      this.sharedCartTimer = null
      if (!this.isCurrentTableRequest(expected)) return
      const synchronized = await this.refreshSharedCart(true, expected)
      if (!this.isCurrentTableRequest(expected)) return
      this.sharedCartPollFailures = synchronized ? 0 : (this.sharedCartPollFailures || 0) + 1
      const nextDelay = Math.min(60000, 5000 * (2 ** Math.min(this.sharedCartPollFailures, 4)))
      this.scheduleSharedCartPoll(nextDelay, expected)
    }, delay)
  },

  async preparePage(silent) {
    this.stopWaitingPoll()
    this.stopSharedCartPolling()
    this.stopServicePolling()
    const session = getTableSession()
    const request = this.beginTableRequest(session)
    const scopeChanged = this.visibleTableScope !== request.scope
    this.visibleTableScope = request.scope
    if (scopeChanged) {
      this.stopShakeRecommendation()
      this.initialRecommendationRequested = false
      this.setData({
        busy: false, cartSyncing: false, clearingCart: false, quickServiceBusy: '',
        checkoutLocked: false, pendingPayment: null, cart: [], cartVersion: 0, cartGeneration: 0,
        cartTotal: '¥0.00', cartCount: 0, cartWritesFrozen: false,
        recommendations: [], recommendationPublicId: '', recommendationAttribution: null, recommendationError: '', performance: null, performanceError: '',
      })
    }
    if (!silent) this.setData({ loading: true, error: '', success: '' })
    const recommendationScopeKey = `${session.tableToken || ''}:${session.tableCode || ''}`
    if (this.recommendationScopeKey !== recommendationScopeKey) {
      this.recommendationScopeKey = recommendationScopeKey
      this.initialRecommendationRequested = false
      this.setData({ recommendations: [], recommendationPublicId: '', recommendationAttribution: null, recommendationError: '' })
    }
    const config = getRuntimeConfig()
    if (!session.tableToken && !session.tableCode && !config.isDevelopment) {
      await this.loadBrowseData('', undefined, request)
      return
    }
    try {
      const result = await getGuestSession()
      // A fixed QR is resolved to cartScope only by the verified session
      // response. Rebase this live request, but never revive an older scan.
      if (!this.rebaseTableRequest(request)) return
      if (!this.isCurrentTableRequest(request)) return
      const connected = result.data || {}
      if (connected.status === 'waiting_for_table') {
        const waitingView = {
          connectionState: 'waiting',
          connectionMessage: '请联系服务人员开台。开台后可直接下单。',
          table: connected.table || null,
        }
        if (this.data.browseCatalogLoaded) this.setData(Object.assign({ loading: false }, waitingView))
        else await this.loadBrowseData('', waitingView, request)
        if (this.isCurrentTableRequest(request)) this.scheduleWaitingPoll(request)
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
        }, request)
        return
      }
      this.setData({
        connectionState: 'active',
        table: connected.table || null,
        // 只采用已发布的顾客展示名；没有时由权威服务任务决定中性状态，
        // 不把“已分配服务人员”伪装成“正在处理”。
        serviceStaffName: publicServiceName(connected.primaryServiceName),
      })
      await this.loadActiveData(request)
    } catch (error) {
      if (this.isCurrentTableRequest(request)) {
        // A remembered table code alone is not proof that this visitor scanned a
        // current table QR. Only a scanned credential should produce an
        // "expired" instruction; otherwise preserve the neutral browse entry.
        const connectionError = session.tableToken
          ? customerErrorMessage(error, '桌台连接已失效，请重新扫描桌面二维码') : ''
        await this.loadBrowseData(connectionError, undefined, request)
      }
    }
  },

  async loadBrowseData(connectionError, view, request) {
    const browseView = Object.assign({
      connectionState: 'needs_scan',
      connectionMessage: '',
      table: null,
    }, view || {})
    try {
      const [menu, performanceResult] = await Promise.all([
        getPublicMenu({}),
        loadPerformanceView(),
      ])
      if (request && !this.isCurrentTableRequest(request)) return false
      const products = menuProducts(menu)
      const categoryState = menuCategoryState(
        products,
        this.data.selectedCategory,
        this.data.selectedSubcategory,
      )
      this.setData({
        loading: false,
        browseOnly: true,
        browseCatalogLoaded: true,
        connectionState: browseView.connectionState,
        connectionMessage: browseView.connectionMessage,
        table: browseView.table,
        serviceStaffName: '',
        serviceSummary: { status: 'ready', label: '到店后可呼叫服务', detail: '扫码开台后显示本桌服务进度', live: false },
        products,
        ...categoryState,
        performance: performanceResult.performance,
        performanceError: performanceResult.error,
        error: connectionError || '',
      })
      this.applyFilters()
      return true
    } catch (error) {
      if (request && !this.isCurrentTableRequest(request)) return false
      this.setData({
        loading: false,
        browseOnly: true,
        browseCatalogLoaded: false,
        connectionState: browseView.connectionState,
        connectionMessage: browseView.connectionMessage,
        table: browseView.table,
        serviceStaffName: '',
        serviceSummary: { status: 'ready', label: '到店后可呼叫服务', detail: '扫码开台后显示本桌服务进度', live: false },
        products: [],
        visibleProducts: [],
        error: connectionError || customerErrorMessage(error, '今晚菜单暂时无法读取，请稍后再试'),
      })
      return false
    }
  },

  async loadActiveData(request) {
    const results = await Promise.all([
      getMenu({}),
      loadPerformanceView(),
      getCustomerBenefits().catch(() => []),
      getTableOrders().catch(() => null),
      getSharedCart(),
      getMiniBootstrap().catch(() => null),
      getWechatNotificationAuthorizations().catch(() => ({ available: false, authorizations: [] })),
      getServiceRequests().catch(() => null),
    ])
    if (request && !this.isCurrentTableRequest(request)) return false
    const products = menuProducts(results[0])
    const categoryState = menuCategoryState(
      products,
      this.data.browseOnly && this.data.selectedCategory === 'all'
        ? 'recommendation' : this.data.selectedCategory,
      this.data.selectedSubcategory,
      true,
    )
    const sharedCart = results[4]
    const cart = sharedCartView(sharedCart, products)
    const recommendations = menuRecommendations(this.data.recommendations, products)
    const recommendationAttribution = this.data.recommendationAttribution
      && recommendations.some((item) => item.productId === this.data.recommendationAttribution.selectedProductId)
      ? this.data.recommendationAttribution
      : null
    const tableOrdersAvailable = Array.isArray(results[3])
    const tableOrders = tableOrdersAvailable ? results[3] : []
    const paymentScope = tableSessionCacheScope()
    let storedPending = wx.getStorageSync(PENDING_PAYMENT_KEY) || null
    // Pending-payment records created before table scopes existed cannot be
    // safely attributed after a new scan. Clear them before a weak-network
    // order refresh can render the previous table's payment state.
    if (storedPending && (!storedPending.tableScope || storedPending.tableScope !== paymentScope)) {
      wx.removeStorageSync(PENDING_PAYMENT_KEY)
      storedPending = null
    }
    const storedOrder = storedPending && tableOrders.find((item) => item.publicId === storedPending.orderPublicId)
    if (storedPending && tableOrdersAvailable
      && (!storedOrder || Number(storedOrder.payableAmountMinor || 0) === 0)) {
      wx.removeStorageSync(PENDING_PAYMENT_KEY)
      storedPending = null
    }
    const pendingFromOrders = tableOrders.find((item) => Number(item.payableAmountMinor || 0) > 0
      && ['available', 'payment_in_progress', 'status_review'].includes(item.paymentAccess))
    const pendingPayment = storedPending
      ? Object.assign({}, storedPending, {
          canContinue: Boolean(tableOrdersAvailable && storedOrder
            && ['available', 'payment_in_progress'].includes(storedOrder.paymentAccess)),
          statusText: tableOrdersAvailable && storedOrder
            ? storedOrder.paymentAccess === 'status_review'
              ? '付款结果确认中，请勿重复支付'
              : storedPending.statusText
            : '桌账暂时无法核对，请稍后刷新',
        })
      : (pendingFromOrders ? {
          orderPublicId: pendingFromOrders.publicId,
          retryIdempotencyKey: randomId(`guest-payment-${pendingFromOrders.publicId}`),
          tableScope: paymentScope,
          amountText: money(pendingFromOrders.payableAmountMinor),
          statusText: pendingFromOrders.paymentAccess === 'status_review'
            ? '付款结果确认中，请勿重复支付'
            : pendingFromOrders.paymentAccess === 'payment_in_progress'
              ? '同桌已有付款进行中，请稍候'
              : '还有一笔待付款',
          canContinue: pendingFromOrders.paymentAccess === 'available',
        } : null)
    const bootstrap = results[5]
    this.setData({
      loading: false,
      browseOnly: false,
      products,
      ...categoryState,
      recommendations,
      recommendationAttribution,
      performance: results[1].performance,
      performanceError: results[1].error,
      serviceSummary: serviceSummaryView(results[7], this.data.serviceStaffName),
      benefitCount: (results[2] || []).reduce((sum, item) => sum + Number(item.quantityAvailable || 0), 0),
      pendingPayment,
      checkoutLocked: Boolean((() => {
        const pendingCheckout = wx.getStorageSync(CHECKOUT_ATTEMPT_KEY)
        if (pendingCheckout && pendingCheckout.tableScope !== paymentScope) {
          wx.removeStorageSync(CHECKOUT_ATTEMPT_KEY)
          return false
        }
        return Boolean(pendingCheckout)
      })()),
      membershipTerms: bootstrap && bootstrap.membershipTerms ? bootstrap.membershipTerms : null,
      membershipInviteVisible: false,
      wechatNotificationAuthorizations: (results[6] && results[6].authorizations) || [],
    })
    this.updateCart(cart, sharedCart)
    this.applyFilters()
    this.startSharedCartPolling(request)
    this.startServicePolling(request)
    this.ensureInitialRecommendations(request)
    return true
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
      this.setData({ error: '暂时无法查看入会说明，点单不受影响' })
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
        // A physical QR is fixed across turnovers. Mark this as an explicit
        // rescan so its new server table-session generation cannot reuse a
        // previous table's guest cookie, cart or pending payment.
        getApp().refreshRuntime({ query, forceTableScan: true })
        this.preparePage()
      },
      fail: (error) => {
        if (!String(error.errMsg || '').includes('cancel')) this.setData({ error: '没有识别到有效桌码，请扫描桌面固定二维码' })
      },
    })
  },

  retryTable() { this.preparePage() },
  async retryPerformance() {
    const request = this.currentTableRequest()
    const result = await loadPerformanceView()
    if (request && !this.isCurrentTableRequest(request)) return
    this.setData({ performance: result.performance, performanceError: result.error })
  },
  onSearchInput(event) { this.setData({ searchText: event.detail.value }, () => this.applyFilters()) },
  selectCategory(event) {
    const selectedCategory = event.currentTarget.dataset.code
    const categoryState = menuCategoryState(this.data.products, selectedCategory, 'all', !this.data.browseOnly)
    this.setData(categoryState, () => this.applyFilters())
  },
  selectSubcategory(event) { this.setData({ selectedSubcategory: event.currentTarget.dataset.code }, () => this.applyFilters()) },
  applyFilters() {
    const search = this.data.searchText.trim().toLowerCase()
    const recommendationView = this.data.selectedCategory === 'recommendation' && !search
    const visibleProducts = this.data.products.filter((item) => {
      const category = menuCategoryIdentity(item)
      const topCategoryMatches = this.data.selectedCategory === 'all'
        || this.data.selectedCategory === 'recommendation'
        || category.topCode === this.data.selectedCategory
      const subcategoryMatches = this.data.selectedSubcategory === 'all'
        || category.childCode === this.data.selectedSubcategory
      const searchable = [item.name, item.description, item.includedText].concat(item.aliases || []).join(' ').toLowerCase()
      return !recommendationView && topCategoryMatches && subcategoryMatches && (!search || searchable.includes(search))
    })
    this.setData({ visibleProducts })
  },

  onOccasionChange(event) { this.setData({ occasionIndex: Number(event.detail.value) }) },
  onAlcoholChange(event) { this.setData({ alcoholIndex: Number(event.detail.value) }) },

  ensureInitialRecommendations(request) {
    if (request && !this.isCurrentTableRequest(request)) return
    if (this.initialRecommendationRequested || this.data.recommendations.length || this.data.recommendationBusy) return
    this.initialRecommendationRequested = true
    void this.recommend('initial', request)
  },

  showRecommendationSurface(onReady) {
    if (this.data.selectedCategory === 'recommendation' && !this.data.searchText) return onReady()
    const categoryState = menuCategoryState(this.data.products, 'recommendation', 'all', !this.data.browseOnly)
    this.setData(Object.assign({}, categoryState, { searchText: '' }), () => {
      this.applyFilters()
      onReady()
    })
  },

  onRecommend() { return this.showRecommendationSurface(() => this.recommend('guided')) },

  async recommend(intent, request) {
    const expected = request || this.currentTableRequest()
    if (!expected || !this.isCurrentTableRequest(expected)) return
    if (this.data.recommendationBusy) return
    const recommendationIntent = ['initial', 'guided', 'shake'].includes(intent) ? intent : 'guided'
    this.setData({ recommendationBusy: true, recommendationError: '' })
    try {
      const occasion = this.data.occasionOptions[this.data.occasionIndex].code
      const alcoholPreference = this.data.alcoholOptions[this.data.alcoholIndex].code
      const result = await recommendExperience({
        occasion, alcoholPreference, experienceLevel: 'enhanced', serviceIntensity: 'balanced', recommendationIntent,
      })
      if (!this.isCurrentTableRequest(expected)) return
      const recommendations = menuRecommendations(result.recommendations, this.data.products).slice(0, 3).map((item, index) => Object.assign({}, item, {
        priceText: money(item.amountMinor),
        savingsText: item.savingsAmountMinor > 0 ? `比单点省 ${money(item.savingsAmountMinor)}` : '',
        tierText: item.marketingLabel || (index === 0 ? '今晚优先推荐' : item.tier === 'signature' ? '完整体验' : item.tier === 'enhanced' ? '今晚推荐' : '轻松开始'),
      }))
      this.setData({
        recommendations,
        recommendationPublicId: recommendations.length ? result.publicId || '' : '',
        recommendationAttribution: null,
        recommendationError: '',
      })
      if (result.publicId && recommendations.length) {
        recordRecommendationEvent(result.publicId, 'exposed', null, {
          surface: 'guest_order_recommendations', recommendationIntent,
        }).catch(() => {})
      }
    } catch (error) {
      if (!this.isCurrentTableRequest(expected)) return
      // The first exposure is helpful, but not worth making the page look
      // broken when the recommendation service briefly reconnects. Permit a
      // later refresh rather than treating one transient failure as final.
      if (recommendationIntent === 'initial') this.initialRecommendationRequested = false
      this.setData({ recommendationError: customerErrorMessage(error, '今夜推荐正在更新') })
    }
    finally { if (this.isCurrentTableRequest(expected)) this.setData({ recommendationBusy: false }) }
  },

  onShakeRecommendation() {
    if (this.data.selectedCategory !== 'recommendation' || this.data.searchText) {
      return this.showRecommendationSurface(() => this.onShakeRecommendation())
    }
    if (this.data.recommendationBusy || this.data.shakeArmed) return
    const tableRequest = this.currentTableRequest()
    if (!tableRequest || !this.isCurrentTableRequest(tableRequest)) return
    if (!wx.startAccelerometer || !wx.onAccelerometerChange) return this.recommend('shake', tableRequest)
    this.setData({ shakeArmed: true, recommendationError: '' })
    let completed = false
    const refresh = () => {
      if (completed) return
      completed = true
      this.stopShakeRecommendation()
      void this.recommend('shake', tableRequest)
    }
    this.shakeListener = (reading) => {
      const force = Math.abs(Number(reading && reading.x) || 0)
        + Math.abs(Number(reading && reading.y) || 0)
        + Math.abs(Number(reading && reading.z) || 0)
      if (force >= 2.45) refresh()
    }
    wx.startAccelerometer({
      interval: 'game',
      success: () => {
        wx.onAccelerometerChange(this.shakeListener)
        // A tap is still a complete, accessible way to ask for a new choice.
        // If the device is held still, refresh after a short beat instead of
        // trapping the customer in a sensor-only interaction.
        this.shakeFallbackTimer = setTimeout(refresh, 1300)
      },
      fail: refresh,
    })
  },

  async refreshServiceSummary(silent, request) {
    const expected = request || this.currentTableRequest()
    if (!expected || !this.isCurrentTableRequest(expected) || this.data.connectionState !== 'active') return false
    try {
      const response = await getServiceRequests()
      if (!this.isCurrentTableRequest(expected)) return false
      this.setData({ serviceSummary: serviceSummaryView(response, this.data.serviceStaffName) })
      return true
    } catch (error) {
      if (!this.isCurrentTableRequest(expected)) return false
      if (!silent) this.setData({ error: customerErrorMessage(error, '服务进度暂时无法读取') })
      this.setData({ serviceSummary: serviceSummaryView(null, this.data.serviceStaffName) })
      return false
    }
  },

  async requestQuickService(event) {
    const code = String(event.currentTarget.dataset.code || '')
    const request = QUICK_SERVICE_REQUESTS[code]
    if (!request || this.data.quickServiceBusy) return
    const tableRequest = this.currentTableRequest()
    if (!tableRequest || !this.isCurrentTableRequest(tableRequest)) return
    this.setData({ quickServiceBusy: code, error: '', success: '' })
    try {
      const response = await createServiceTask(request)
      if (!this.isCurrentTableRequest(tableRequest)) return
      const task = response.data || response
      this.setData({
        success: task.message || '请求已送达，我们会尽快到桌。',
        serviceSummary: serviceSummaryView([{ status: task.taskStatus || 'pending', detail: request.detail, requestType: request.requestType }], this.data.serviceStaffName),
      })
      await this.refreshServiceSummary(true, tableRequest)
    } catch (error) {
      if (this.isCurrentTableRequest(tableRequest)) this.setData({ error: customerErrorMessage(error, '请求暂时没有送达，请稍后重试') })
    } finally { if (this.isCurrentTableRequest(tableRequest)) this.setData({ quickServiceBusy: '' }) }
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
    const tableRequest = this.currentTableRequest()
    if (!tableRequest || !this.isCurrentTableRequest(tableRequest)) return
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
    if (!this.isCurrentTableRequest(tableRequest)) return
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
      if (!this.isCurrentTableRequest(tableRequest)) return
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
      if (!this.isCurrentTableRequest(tableRequest)) return
      if (this.data.recommendationPublicId !== recommendationPublicId) return
      const attribution = this.data.recommendationAttribution
      this.setData({
        recommendations: this.data.recommendations.filter((item) => item.productId !== productId),
        recommendationAttribution: attribution && attribution.recommendationPublicId === recommendationPublicId
          && attribution.selectedProductId === productId ? null : attribution,
      })
    } catch (error) {
      if (!this.isCurrentTableRequest(tableRequest)) return
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
      cartWritesFrozen: Boolean(sharedCart && sharedCart.guestWritesFrozen),
      recommendationAttribution: attribution && cart.some((item) => item.productId === attribution.selectedProductId)
        ? attribution
        : null,
    })
  },

  async refreshSharedCart(silent, request) {
    const expected = request || this.currentTableRequest()
    if (!expected || !this.isCurrentTableRequest(expected)
      || this.data.connectionState !== 'active' || this.data.checkoutLocked) return false
    try {
      const sharedCart = await getSharedCart()
      if (!this.isCurrentTableRequest(expected)) return false
      this.updateCart(sharedCartView(sharedCart, this.data.products), sharedCart)
      return true
    } catch (error) {
      if (!silent && this.isCurrentTableRequest(expected)) this.setData({ error: customerErrorMessage(error, '购物车暂时无法同步，请稍后重试') })
      return false
    }
  },

  async adjustSharedCart(productId, delta) {
    const tableRequest = this.currentTableRequest()
    if (!tableRequest || !this.isCurrentTableRequest(tableRequest)) return false
    if (this.data.cartSyncing) return false
    if (this.data.cartWritesFrozen) {
      this.setData({ error: '服务人员正在核对本桌点单，暂时只能查看购物车。' })
      return false
    }
    this.setData({ cartSyncing: true, error: '' })
    try {
      const sharedCart = await adjustSharedCart(
        productId, delta, this.data.cartGeneration, this.data.cartVersion, randomId('shared-cart-adjust'),
      )
      if (!this.isCurrentTableRequest(tableRequest)) return false
      this.updateCart(sharedCartView(sharedCart, this.data.products), sharedCart)
      return true
    } catch (error) {
      if (!this.isCurrentTableRequest(tableRequest)) return false
      if (error && error.code === 'SHARED_CART_VERSION_CONFLICT') {
        await this.refreshSharedCart(true, tableRequest)
        this.setData({ error: '同桌购物车已经更新，已为你刷新，请确认后再操作。' })
      } else {
        this.setData({ error: customerErrorMessage(error, '购物车暂时无法更新，请稍后重试') })
      }
      return false
    } finally { if (this.isCurrentTableRequest(tableRequest)) this.setData({ cartSyncing: false }) }
  },

  async clearCart() {
    if (!this.data.cart.length || this.data.cartSyncing || this.data.clearingCart
      || this.data.checkoutLocked || this.data.pendingPayment || this.data.cartWritesFrozen) return
    const confirmed = await new Promise((resolve) => wx.showModal({
      title: '清空本桌购物车？',
      content: '同桌顾客当前加入的商品都会被移除；已提交的订单不会受影响。',
      confirmText: '清空',
      confirmColor: '#315d46',
      success: (result) => resolve(Boolean(result.confirm)),
      fail: () => resolve(false),
    }))
    if (!confirmed) return
    const tableRequest = this.currentTableRequest()
    if (!tableRequest || !this.isCurrentTableRequest(tableRequest)) return
    this.setData({ cartSyncing: true, clearingCart: true, error: '' })
    try {
      const sharedCart = await clearSharedCart(
        this.data.cartGeneration, this.data.cartVersion, randomId('shared-cart-clear'),
      )
      if (!this.isCurrentTableRequest(tableRequest)) return
      this.updateCart(sharedCartView(sharedCart, this.data.products), sharedCart)
      wx.showToast({ title: '已清空本桌购物车', icon: 'none' })
    } catch (error) {
      if (!this.isCurrentTableRequest(tableRequest)) return
      if (error && error.code === 'SHARED_CART_VERSION_CONFLICT') {
        await this.refreshSharedCart(true, tableRequest)
        this.setData({ error: '同桌购物车已经更新，未执行清空，已为你刷新。' })
      } else {
        this.setData({ error: customerErrorMessage(error, '购物车暂时无法清空，请稍后重试') })
      }
    } finally { if (this.isCurrentTableRequest(tableRequest)) this.setData({ cartSyncing: false, clearingCart: false }) }
  },

  async removeCartLine(event) {
    if (this.data.cartSyncing || this.data.checkoutLocked || this.data.pendingPayment || this.data.cartWritesFrozen) return
    const productId=event.currentTarget.dataset.id
    const item=this.data.cart.find((line)=>line.productId===productId)
    if (!item) return
    const tableRequest = this.currentTableRequest()
    if (!tableRequest || !this.isCurrentTableRequest(tableRequest)) return
    this.setData({ cartSyncing:true,error:'' })
    try {
      const sharedCart=await removeSharedCartLine(
        productId,this.data.cartGeneration,this.data.cartVersion,randomId('shared-cart-remove'),
      )
      if (!this.isCurrentTableRequest(tableRequest)) return
      this.updateCart(sharedCartView(sharedCart,this.data.products),sharedCart)
      wx.showToast({ title:'已移除这件商品',icon:'none' })
    } catch (error) {
      if (!this.isCurrentTableRequest(tableRequest)) return
      if (error&&error.code==='SHARED_CART_VERSION_CONFLICT') {
        await this.refreshSharedCart(true,tableRequest)
        this.setData({ error:'同桌购物车已经更新，已为你刷新，请确认后再操作。' })
      } else {
        this.setData({ error:customerErrorMessage(error,'这件商品暂时没有移除，请稍后重试') })
      }
    } finally { if (this.isCurrentTableRequest(tableRequest)) this.setData({ cartSyncing:false }) }
  },

  openService() { wx.navigateTo({ url: '/pages/service/index' }) },
  openStatus() { wx.navigateTo({ url: '/pages/status/index' }) },
  openAccount() { wx.navigateTo({ url: '/pages/account/index' }) },
  openBenefits() { wx.switchTab({ url: '/pages/profile/index' }) },

  async openCheckout() {
    if (!this.data.cart.length || this.data.busy || this.data.pendingPayment) return
    const tableRequest = this.currentTableRequest()
    if (!tableRequest || !this.isCurrentTableRequest(tableRequest)) return
    if (this.data.cartWritesFrozen) {
      this.setData({ error: '服务人员正在核对本桌点单，完成后才能付款。' })
      return
    }
    if (this.data.checkoutLocked) return this.retryCheckout(tableRequest)
    if (this.data.cart.some((item) => !item.available)) {
      this.setData({ error: '购物车中有暂不可用商品，请先移除后再结账。' })
      return
    }
    this.setData({ busy: true, error: '', upgradeOffer: null })
    const items = this.data.cart.map((item) => ({ productId: item.productId, quantity: item.quantity }))
    try {
      const offer = await prepareCheckoutUpgrade(items, this.data.occasionOptions[this.data.occasionIndex].code, this.data.alcoholOptions[this.data.alcoholIndex].code)
      if (!this.isCurrentTableRequest(tableRequest)) return
      if (offer) {
        this.setData({ upgradeOffer: offer, upgradeAdd: money(offer.amountToAddMinor), targetTotal: money(offer.targetExperience.totalAmountMinor) })
        recordCheckoutUpgradeEvent(offer.publicId, 'viewed', null).catch(() => {})
      } else await this.submitOrder(null, true, null, tableRequest)
    } catch (error) {
      if (!this.isCurrentTableRequest(tableRequest)) return
      const blockingCodes = ['GUEST_SESSION_INVALID', 'TABLE_SESSION_ENDED', 'GUEST_CAPABILITY_DENIED', 'STORE_ACCESS_FORBIDDEN']
      if (blockingCodes.includes(error && error.code)) {
        this.setData({ error: customerErrorMessage(error, '当前桌次已失效，请重新扫码') })
      } else {
        // 付款前升级是可选建议。建议生成失败不能阻断原购物车结账；
        // 真正的桌次、商品、库存和支付校验仍由同一个下单命令失败关闭。
        await this.submitOrder(null, true, null, tableRequest)
      }
    }
    finally { if (this.isCurrentTableRequest(tableRequest)) this.setData({ busy: false }) }
  },

  async declineUpgrade() {
    const tableRequest = this.currentTableRequest()
    if (!tableRequest || !this.isCurrentTableRequest(tableRequest)) return
    const offer = this.data.upgradeOffer
    this.setData({ upgradeOffer: null })
    if (offer) {
      // 埋点失败不能阻断顾客按原购物车下单。
      try { await recordCheckoutUpgradeEvent(offer.publicId, 'declined', 'kept_original') } catch {}
    }
    if (this.isCurrentTableRequest(tableRequest)) await this.submitOrder(null, false, null, tableRequest)
  },
  acceptUpgrade() {
    const tableRequest = this.currentTableRequest()
    if (!tableRequest || !this.isCurrentTableRequest(tableRequest)) return
    const offer = this.data.upgradeOffer
    if (!offer) return
    this.setData({ upgradeOffer: null })
    this.submitOrder(offer.publicId, false, null, tableRequest)
  },

  async retryCheckout(request) {
    const tableRequest = request || this.currentTableRequest()
    if (!tableRequest || !this.isCurrentTableRequest(tableRequest)) return
    const attempt = wx.getStorageSync(CHECKOUT_ATTEMPT_KEY)
    if (!attempt || !Number.isSafeInteger(attempt.expectedGeneration)
      || !Number.isSafeInteger(attempt.expectedVersion)
      || attempt.tableScope !== tableSessionCacheScope()) {
      wx.removeStorageSync(CHECKOUT_ATTEMPT_KEY)
      this.setData({ checkoutLocked: false })
      return
    }
    await this.submitOrder(attempt.offerPublicId || null, false, attempt, tableRequest)
  },

  async submitOrder(offerPublicId, allowBusy, previousAttempt, request) {
    const tableRequest = request || this.currentTableRequest()
    if (!tableRequest || !this.isCurrentTableRequest(tableRequest)) return
    if (this.data.busy && !allowBusy) return
    const currentAttribution = checkoutRecommendationAttribution(
      offerPublicId,
      this.data.recommendationAttribution,
    )
    const attempt = previousAttempt || {
      idempotencyKey: randomId('guest-order'),
      expectedGeneration: this.data.cartGeneration,
      expectedVersion: this.data.cartVersion,
      offerPublicId: offerPublicId || null,
      recommendationPublicId: currentAttribution ? currentAttribution.recommendationPublicId : null,
      selectedRecommendationProductId: currentAttribution ? currentAttribution.selectedProductId : null,
      tableScope: tableSessionCacheScope(),
      createdAt: new Date().toISOString(),
    }
    if (attempt.tableScope !== tableSessionCacheScope()) return
    wx.setStorageSync(CHECKOUT_ATTEMPT_KEY, attempt)
    this.setData({ busy: true, checkoutLocked: true, error: '', success: '' })
    try {
      const attemptAttribution = checkoutRecommendationAttribution(attempt.offerPublicId, {
        recommendationPublicId: attempt.recommendationPublicId,
        selectedProductId: attempt.selectedRecommendationProductId,
      })
      const result = await checkoutSharedCart({
        expectedGeneration: attempt.expectedGeneration,
        expectedVersion: attempt.expectedVersion,
        checkoutUpgradeOfferPublicId: attempt.offerPublicId,
        recommendationAttribution: attemptAttribution,
      }, attempt.idempotencyKey)
      if (!this.isCurrentTableRequest(tableRequest)) return
      const data = result.data || result
      const pendingPayment = {
        orderPublicId: data.order.publicId,
        paymentPublicId: data.payment && data.payment.publicId,
        retryIdempotencyKey: randomId(`guest-payment-${data.order.publicId}`),
        amountText: money(data.settlement && data.settlement.payableAmountMinor),
        tableScope: attempt.tableScope,
        statusText: '订单已备好，请完成付款',
        canContinue: true,
      }
      wx.setStorageSync(PENDING_PAYMENT_KEY, pendingPayment)
      wx.removeStorageSync(CHECKOUT_ATTEMPT_KEY)
      this.updateCart([], data.sharedCart || null)
      this.setData({ pendingPayment, checkoutLocked: false })
      await this.handlePaymentAction(data.payment && data.payment.providerAction, tableRequest)
    } catch (error) {
      if (!this.isCurrentTableRequest(tableRequest)) return
      if (error && error.code === 'SHARED_CART_VERSION_CONFLICT') {
        wx.removeStorageSync(CHECKOUT_ATTEMPT_KEY)
        await this.refreshSharedCart(true, tableRequest)
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
    } finally { if (this.isCurrentTableRequest(tableRequest)) this.setData({ busy: false }) }
  },

  async handlePaymentAction(action, request) {
    const tableRequest = request || this.currentTableRequest()
    if (!tableRequest || !this.isCurrentTableRequest(tableRequest)) return
    if (!action || action.status !== 'ready' || action.presentation !== 'jsapi' || !action.payload) {
      const pendingPayment = Object.assign({}, this.data.pendingPayment, {
        statusText: action && action.status === 'unknown' ? '付款结果确认中' : '付款未完成',
      })
      if (!this.isCurrentTableRequest(tableRequest)) return
      wx.setStorageSync(PENDING_PAYMENT_KEY, pendingPayment)
      this.setData({ pendingPayment })
      return
    }
    try {
      await new Promise((resolve, reject) => wx.requestPayment(Object.assign({}, action.payload, { success: resolve, fail: reject })))
      if (!this.isCurrentTableRequest(tableRequest)) return
      const pendingPayment = Object.assign({}, this.data.pendingPayment, { statusText: '付款已提交，到账确认中' })
      wx.setStorageSync(PENDING_PAYMENT_KEY, pendingPayment)
      this.setData({ pendingPayment, success: '付款已提交，到账结果可在本桌账单查看。' })
      this.offerOrderNotifications(tableRequest)
      wx.showToast({ title: '付款已提交', icon: 'none' })
    } catch (error) {
      if (!this.isCurrentTableRequest(tableRequest)) return
      const cancelled = isWechatCancellation(error)
      const pendingPayment = Object.assign({}, this.data.pendingPayment, {
        statusText: cancelled ? '订单已保留，可稍后再付' : '付款未完成，可继续支付',
      })
      wx.setStorageSync(PENDING_PAYMENT_KEY, pendingPayment)
      this.setData({ pendingPayment, error: cancelled ? '' : '付款未完成，可继续支付，无需重新下单。' })
    }
  },

  offerOrderNotifications(request) {
    if (request && !this.isCurrentTableRequest(request)) return
    if (this._notificationPromptShown) return
    this._notificationPromptShown = true
    // 直接唤起微信原生订阅消息弹窗，由顾客点「允许/取消」。
    this.ensureBalanceNotificationAuthorizations(request)
  },

  async ensureBalanceNotificationAuthorizations(request) {
    const tableRequest = request || this.currentTableRequest()
    if (!tableRequest || !this.isCurrentTableRequest(tableRequest)) return
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
      if (!this.isCurrentTableRequest(tableRequest)) return
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
        if (!this.isCurrentTableRequest(tableRequest)) return
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
    if (!pending || !pending.canContinue || this.data.busy) return
    const tableRequest = this.currentTableRequest()
    if (!tableRequest || !this.isCurrentTableRequest(tableRequest)
      || pending.tableScope !== tableSessionCacheScope()) return
    this.setData({ busy: true, error: '' })
    try {
      const retryIdempotencyKey = pending.retryIdempotencyKey || randomId(`guest-payment-${pending.orderPublicId}`)
      const normalizedPending = Object.assign({}, pending, { retryIdempotencyKey })
      wx.setStorageSync(PENDING_PAYMENT_KEY, normalizedPending)
      this.setData({ pendingPayment: normalizedPending })
      const action = await retryOrderPayment(pending.orderPublicId, retryIdempotencyKey)
      if (!this.isCurrentTableRequest(tableRequest)) return
      await this.handlePaymentAction(action, tableRequest)
    } catch (error) {
      if (!this.isCurrentTableRequest(tableRequest)) return
      if (['GUEST_ORDER_ACCESS_FORBIDDEN', 'GUEST_SESSION_INVALID', 'TABLE_SESSION_ENDED'].includes(error && error.code)) {
        wx.removeStorageSync(PENDING_PAYMENT_KEY)
        this.setData({
          pendingPayment: null,
          error: customerErrorMessage(error, '桌台连接已失效，请重新扫描当前桌面的二维码'),
        })
        return
      }
      this.setData({ error: customerErrorMessage(error, '暂时无法恢复付款，请在桌账确认状态或联系服务人员') })
    } finally { if (this.isCurrentTableRequest(tableRequest)) this.setData({ busy: false }) }
  },
})
