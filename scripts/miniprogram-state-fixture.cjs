// Actual page/modules; deferred transport and native UI only. Never calls a live service.
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const ROOT = process.env.MBOX_STATE_TEST_ROOT || path.resolve(__dirname, '..')

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function cart(version, generation = 1) {
  return { version, generation, totalAmountMinor: 100, guestWritesFrozen: false, lines: [{
    productId: 'p1', name: '测试菜', available: true, quantity: 1, unitPriceMinor: 100,
    subtotalAmountMinor: 100, portionIds: ['portion-1'],
  }] }
}

function fixture(pageName = 'order', overrides = {}, platform = 'miniprogram') {
  const state = {
    session: { tableCode: 'W20', tableToken: 'test-token-w20', cartScope: 'test-turn-w20' },
    storage: new Map(), calls: [], timers: new Map(), nextTimer: 1,
  }
  const wx = {
    getStorageSync: key => state.storage.get(key), setStorageSync: (key, value) => state.storage.set(key, value),
    removeStorageSync: key => state.storage.delete(key),
    showToast() {}, showShareMenu() {}, showModal(options) { options.success({ confirm: true }) },
    stopAccelerometer() {}, offAccelerometerChange() {}, navigateTo() {}, switchTab() {}, stopPullDownRefresh() {},
    requestPayment(options) { state.payment = options },
  }
  const session = {
    getTableSession: () => state.session,
    tableSessionCacheScope: (value = state.session) => 'cache.' + value.tableToken + ':' + value.cartScope,
  }
  const product = { productId: 'p1', name: '测试菜', available: true, amountMinor: 100 }
  const api = Object.assign({
    getGuestSession: async () => ({ data: { status: 'active', cartProtocolVersion: 2, table: { code: state.session.tableCode } } }),
    getMenu: async () => [product], getPublicMenu: async () => [], getSharedCart: async () => cart(1),
    getTableOrders: async () => [], getCustomerOrderHistory: async () => [], getCustomerBenefits: async () => [],
    getMiniBootstrap: async () => null,
    getRecommendationConfiguration: async () => ({ inputConfiguration: { version: 1, questions: [] } }),
    getServiceRequests: async () => null, getTodayPerformances: async () => null,
    getWechatNotificationPrompt: async () => ({ available: false, authorizations: [] }),
    abandonGuestCheckout: async () => ({ operationalState: 'cancelled' }),
    checkoutSharedCart: async (input, key) => {
      state.calls.push({ input, key })
      throw Object.assign(new Error('definite test rejection'), { code: 'PRODUCT_UNAVAILABLE' })
    },
  }, overrides)
  const cache = new Map()
  let definition
  function load(filename) {
    filename = path.resolve(filename)
    if (!path.extname(filename)) filename += '.js'
    if (filename.endsWith('/utils/api.js')) return new Proxy({}, { get: (_, name) => (...args) => api[name](...args) })
    if (filename.endsWith('/utils/platform.js')) return wx
    if (filename.endsWith('/utils/session.js')) return session
    // Exercise shared Alipay branches in isolation; production's forced-closed
    // capability contract is separately covered by its platform tests.
    if (filename.endsWith('/config/index.js')) return { getRuntimeConfig: () => ({
      isDevelopment: false, membershipInviteCooldownHours: 24, alipayPaymentEnabled: true,
    }) }
    if (cache.has(filename)) return cache.get(filename).exports
    const module = { exports: {} }
    cache.set(filename, module)
    const source = fs.readFileSync(filename, 'utf8')
      .replace(/^export\s+default\s+/gm, 'module.exports = ')
      .replace(/^export\s+\{\s*\n([\s\S]*?)^\}\s*$/gm, 'module.exports = {\n$1\n}')
      .replace(/^export\s+\{([^\n}]*)\}\s*$/gm, 'module.exports = {$1}')
    vm.runInNewContext(source, {
      module, exports: module.exports, require: value => load(path.resolve(path.dirname(filename), value)),
      Page: value => { definition = value }, wx, getApp: () => ({ globalData: {} }), console, Date,
      setTimeout: (callback, ms) => {
        const id = state.nextTimer++
        state.timers.set(id, { callback, ms })
        return id
      },
      clearTimeout: id => state.timers.delete(id),
    }, { filename })
    return module.exports
  }
  load(path.join(ROOT, platform, 'pages', pageName, 'index.js'))
  const page = Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch, callback) { Object.assign(this.data, patch); if (callback) callback() },
  })
  if (pageName === 'order') {
    page.loadOrderExtras = () => {}
    page.applyFilters = () => {}
    page.setData({ loading: false, orderReady: true, paymentStateReady: true,
      connectionState: 'active', products: [product], couponSelections: [] })
    const request = page.beginTableRequest()
    page.visibleTableScope = request.scope
    page.updateCart(cart(1).lines, cart(1))
  }
  return { page, state, api, wx, session, load }
}

module.exports = { fixture, deferred, cart, ROOT }
