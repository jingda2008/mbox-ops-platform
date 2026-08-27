import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const GUEST_COOKIE_KEY = 'mbox.http.cookie.guest.v2'
const RESERVATION_COOKIE_KEY = 'mbox.http.cookie.reservation.v2'
const PENDING_PAYMENT_KEY = 'mbox.pending.guest.payment.v1'

function scope(session) {
  const token = String(session.tableToken || '').trim()
  const cartScope = String(session.cartScope || '').trim()
  if (token && cartScope) return `session:${token}:${cartScope}`
  return token ? `scan:${String(session.scanNonce || '').trim()}:${token}` : `table:${String(session.tableCode || '').trim().toUpperCase()}`
}

function requestGuard() {
  let generation = 0
  let active = null
  return {
    begin(requestScope) {
      active = { scope: String(requestScope || ''), generation: generation + 1 }
      generation = active.generation
      return active
    },
    current() { return active },
    isCurrent(request, current) {
      return Boolean(request && active && request.generation === active.generation
        && request.scope === active.scope && current() === request.scope)
    },
    rebase(request, nextScope) {
      if (!request || !active || request.generation !== active.generation || request.scope !== active.scope) return false
      active.scope = String(nextScope || '')
      request.scope = active.scope
      return true
    },
    invalidate() { generation += 1; active = null },
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

async function loadSessionModule(storage) {
  const source = await readFile(new URL('../miniprogram/utils/session.js', import.meta.url), 'utf8')
  const app = { globalData: {} }
  const context = {
    module: { exports: {} }, exports: {}, getApp: () => app,
    wx: {
      getStorageSync: (key) => storage.get(key), setStorageSync: (key, value) => storage.set(key, value),
      removeStorageSync: (key) => storage.delete(key),
    },
  }
  vm.runInNewContext(source, context, { filename: 'miniprogram/utils/session.js' })
  return context.module.exports
}

async function loadCustomerErrorModule() {
  const source = await readFile(new URL('../miniprogram/utils/customer-error.js', import.meta.url), 'utf8')
  const context = { module: { exports: {} }, exports: {} }
  vm.runInNewContext(source, context, { filename: 'miniprogram/utils/customer-error.js' })
  return context.module.exports
}

async function loadApiRaceModule(state) {
  const source = await readFile(new URL('../miniprogram/utils/api.js', import.meta.url), 'utf8')
  const calls = []
  const remembered = []
  const context = {
    module: { exports: {} }, exports: {},
    require(specifier) {
      if (specifier === './request') return {
        deviceKey: () => 'device-table-race',
        request: (path, options) => {
          const pending = deferred()
          calls.push({ path, options, pending })
          return pending.promise
        },
      }
      if (specifier === './id') return { randomId: (prefix) => `${prefix}-scope-test` }
      if (specifier === './session') return {
        getTableSession: () => state.session,
        rememberTableConnection: (value) => {
          remembered.push(value)
          state.session = Object.assign({}, state.session, {
            tableCode: value && value.table ? value.table.code : state.session.tableCode,
            cartScope: value && value.cartScope ? value.cartScope : '',
          })
          state.storage.set('mbox.table.connection.state', Object.assign({}, value, { scanNonce: state.session.scanNonce }))
        },
        clearTableConnection: () => { state.cleared += 1 },
      }
      if (specifier === './table-request-scope') return { tableRequestScope: scope }
      if (specifier === './auth') return {
        ensureCustomerSession: async () => true, renewReservationSessionOnly: () => undefined,
        isCustomerSessionInvalid: () => false, isWechatIdentityUnavailable: () => false,
      }
      if (specifier === './recommendation-attribution') return { checkoutRecommendationAttribution: () => null }
      throw new Error(`unexpected require: ${specifier}`)
    },
    wx: {
      getStorageSync: (key) => state.storage.get(key), setStorageSync: (key, value) => state.storage.set(key, value),
      removeStorageSync: (key) => state.storage.delete(key),
    },
  }
  vm.runInNewContext(source, context, { filename: 'miniprogram/utils/api.js' })
  return { api: context.module.exports, calls, remembered }
}

async function loadRequestRaceModule(state) {
  const source = await readFile(new URL('../miniprogram/utils/request.js', import.meta.url), 'utf8')
  const calls = []
  const context = {
    module: { exports: {} }, exports: {},
    require(specifier) {
      if (specifier === '../config/index') return { getRuntimeConfig: () => ({
        apiBaseUrl: 'https://mini.example.test', storeId: 'mbox-lujiazui', requestTimeoutMs: 10_000,
      }) }
      if (specifier === './session') return { getTableSession: () => state.session }
      if (specifier === './table-request-scope') return { tableRequestScope: scope }
      throw new Error(`unexpected require: ${specifier}`)
    },
    wx: {
      getStorageSync: (key) => state.storage.get(key), setStorageSync: (key, value) => state.storage.set(key, value),
      removeStorageSync: (key) => state.storage.delete(key),
      request: (input) => calls.push(input),
    },
  }
  vm.runInNewContext(source, context, { filename: 'miniprogram/utils/request.js' })
  return { request: context.module.exports.request, calls }
}

async function loadHomePage(state) {
  const source = await readFile(new URL('../miniprogram/pages/home/index.js', import.meta.url), 'utf8')
  let definition = null
  const guard = requestGuard()
  const api = {
    getMiniBootstrap: async () => ({ membership: null, membershipTerms: null, activities: [], content: [] }),
    getReservations: async () => ({ reservations: [] }),
    getReservationPerformances: async () => null,
    getCustomerBenefits: async () => [],
    enrollMembership: async () => ({}),
    getGuestSession: async () => {
      state.guestSessionReads += 1
      if (state.resolvedTableCode) state.session = Object.assign({}, state.session, {
        tableCode: state.resolvedTableCode, cartScope: state.resolvedCartScope || '',
      })
      return { data: {
        status: 'active', table: { code: state.session.tableCode, displayName: state.session.tableCode },
        guestCount: 2, primaryServiceName: '小李',
      }, warning: '' }
    },
  }
  const app = { refreshRuntime: () => state.session }
  const context = {
    module: { exports: {} }, exports: {}, Page: (value) => { definition = value }, getApp: () => app,
    require(specifier) {
      if (specifier === '../../utils/api') return api
      if (specifier === '../../config/index') return { getRuntimeConfig: () => ({ isDevelopment: false }) }
      if (specifier === '../../utils/session') return { getTableSession: () => state.session }
      if (specifier === '../../utils/table-request-scope') return {
        tableRequestScope: scope,
        createTableRequestGuard: (read) => ({
          begin: (value) => guard.begin(value),
          rebase: (request, nextScope) => guard.rebase(request, nextScope),
          isCurrent: (request) => guard.isCurrent(request, read),
          invalidate: () => guard.invalidate(),
        }),
      }
      if (specifier === '../../utils/format') return { dateTime: (value) => String(value || '') }
      if (specifier === '../../utils/wechat-phone') return { readWechatPhoneAuthorization: () => ({ code: '' }) }
      if (specifier === '../../utils/media') return { publicImageUrl: (value) => value || '' }
      if (specifier === '../../utils/customer-error') return { customerErrorMessage: (_error, fallback) => fallback }
      throw new Error(`unexpected require: ${specifier}`)
    },
    wx: {
      getStorageSync: (key) => state.storage.get(key), setStorageSync: (key, value) => state.storage.set(key, value),
      removeStorageSync: (key) => state.storage.delete(key), stopPullDownRefresh: () => undefined,
    },
    setTimeout, clearTimeout,
  }
  vm.runInNewContext(source, context, { filename: 'miniprogram/pages/home/index.js' })
  const page = Object.assign({}, definition, { data: JSON.parse(JSON.stringify(definition.data)) })
  page.setData = (patch) => Object.assign(page.data, patch)
  return page
}

async function loadOrderPage(state) {
  const source = await readFile(new URL('../miniprogram/pages/order/index.js', import.meta.url), 'utf8')
  let definition = null
  const guard = requestGuard()
  const calls = { retryOrderPayment: 0 }
  const context = {
    module: { exports: {} }, exports: {}, Page: (value) => { definition = value },
    getApp: () => ({ refreshRuntime: () => state.session }),
    require(specifier) {
      if (specifier === '../../utils/api') return {
        getGuestSession: async () => {
          state.session = Object.assign({}, state.session, {
            tableCode: state.resolvedTableCode || state.session.tableCode,
            cartScope: state.resolvedCartScope || '',
          })
          return { data: {
            status: 'active', cartProtocolVersion: 2,
            table: { code: state.session.tableCode, displayName: state.session.tableCode },
          }, warning: '' }
        },
        getMenu: async () => [], getPublicMenu: async () => [], recommendExperience: async () => ({ recommendations: [] }),
        recordRecommendationEvent: async () => undefined, prepareCheckoutUpgrade: async () => null,
        recordCheckoutUpgradeEvent: async () => undefined, checkoutSharedCart: async () => null,
        getSharedCart: async () => ({ lines: [], version: 0, generation: 0 }),
        adjustSharedCart: async () => null, removeSharedCartLine: async () => null, clearSharedCart: async () => null,
        getTableOrders: async () => { throw new Error('weak network') },
        retryOrderPayment: async () => {
          calls.retryOrderPayment += 1
          if (state.retryPaymentError) throw state.retryPaymentError
          return state.retryPaymentAction || null
        },
        getTodayPerformances: async () => null, getCustomerBenefits: async () => [], getMiniBootstrap: async () => null,
        getWechatNotificationPrompt: async () => ({ available: false, authorizations: [] }),
        getWechatNotificationAuthorizations: async () => ({ available: false, authorizations: [] }),
        recordWechatNotificationAuthorization: async () => undefined, createServiceTask: async () => null,
        getServiceRequests: async () => null,
      }
      if (specifier === '../../config/index') return { getRuntimeConfig: () => ({ isDevelopment: false, membershipInviteCooldownHours: 24 }) }
      if (specifier === '../../utils/session') return {
        getTableSession: () => state.session,
        tableSessionCacheScope: (session) => `cache.${scope(session || state.session)}`,
      }
      if (specifier === '../../utils/table-request-scope') return {
        tableRequestScope: scope,
        createTableRequestGuard: (read) => ({
          begin: (value) => guard.begin(value),
          current: () => guard.current(),
          rebase: (request, nextScope) => guard.rebase(request, nextScope),
          isCurrent: (request) => guard.isCurrent(request, read),
          invalidate: () => guard.invalidate(),
        }),
      }
      if (specifier === '../../utils/id') return { randomId: (prefix) => `${prefix}-scope-test` }
      if (specifier === '../../utils/format') return { money: (value) => `¥${Number(value || 0) / 100}`, dateTime: (value) => String(value || '') }
      if (specifier === '../../utils/recommendation-attribution') return { checkoutRecommendationAttribution: () => null }
      if (specifier === '../../utils/media') return { publicImageUrl: (value) => value || '' }
      if (specifier === '../../utils/customer-error') return {
        customerErrorMessage: (error, fallback) => error && error.code === 'GUEST_ORDER_ACCESS_FORBIDDEN'
          ? '这笔订单不属于当前桌位，请重新扫描当前桌面的二维码' : fallback,
        isWechatCancellation: () => false,
      }
      if (specifier === '../../utils/wechat-subscription') return {
        requestWechatSubscription: async () => ({ presented: false, outcomes: [] }),
      }
      throw new Error(`unexpected require: ${specifier}`)
    },
    wx: {
      getStorageSync: (key) => state.storage.get(key), setStorageSync: (key, value) => state.storage.set(key, value),
      removeStorageSync: (key) => state.storage.delete(key),
    },
    setTimeout, clearTimeout,
  }
  vm.runInNewContext(source, context, { filename: 'miniprogram/pages/order/index.js' })
  const page = Object.assign({}, definition, { data: JSON.parse(JSON.stringify(definition.data)) })
  page.setData = (patch, callback) => { Object.assign(page.data, patch); if (callback) callback() }
  page.updateCart = () => undefined
  page.applyFilters = () => undefined
  page.startSharedCartPolling = () => undefined
  page.startServicePolling = () => undefined
  page.ensureInitialRecommendations = () => undefined
  return { page, calls }
}

async function loadAccountPage(state) {
  const source = await readFile(new URL('../miniprogram/pages/account/index.js', import.meta.url), 'utf8')
  let definition = null
  const guard = requestGuard()
  const context = {
    module: { exports: {} }, exports: {}, Page: (value) => { definition = value },
    require(specifier) {
      if (specifier === '../../utils/api') return {
        getTableOrders: () => state.orderReads.shift().promise,
        retryOrderPayment: async () => {
          state.retryPaymentCalls = Number(state.retryPaymentCalls || 0) + 1
          if (state.retryPaymentError) throw state.retryPaymentError
          return state.retryPaymentAction || null
        },
      }
      if (specifier === '../../config/index') return { getRuntimeConfig: () => ({ isDevelopment: false }) }
      if (specifier === '../../utils/session') return {
        getTableSession: () => state.session,
        tableSessionCacheScope: (session) => `cache.${scope(session)}`,
      }
      if (specifier === '../../utils/table-request-scope') return {
        tableRequestScope: scope,
        createTableRequestGuard: (read) => ({
          begin: (value) => guard.begin(value),
          isCurrent: (request) => guard.isCurrent(request, read),
          invalidate: () => guard.invalidate(),
        }),
      }
      if (specifier === '../../utils/id') return { randomId: (prefix) => `${prefix}-scope-test` }
      if (specifier === '../../utils/format') return { money: (value) => `¥${Number(value || 0) / 100}`, dateTime: (value) => String(value || '') }
      if (specifier === '../../utils/customer-error') return {
        customerErrorMessage: (error, fallback) => error && error.code === 'GUEST_ORDER_ACCESS_FORBIDDEN'
          ? '这笔订单不属于当前桌位，请重新扫描当前桌面的二维码' : fallback,
        isWechatCancellation: () => false,
      }
      throw new Error(`unexpected require: ${specifier}`)
    },
    wx: {
      getStorageSync: (key) => state.storage.get(key), setStorageSync: (key, value) => state.storage.set(key, value),
      removeStorageSync: (key) => state.storage.delete(key), requestPayment: () => undefined, stopPullDownRefresh: () => undefined,
    },
  }
  vm.runInNewContext(source, context, { filename: 'miniprogram/pages/account/index.js' })
  const page = Object.assign({}, definition, { data: JSON.parse(JSON.stringify(definition.data)) })
  page.setData = (patch) => Object.assign(page.data, patch)
  return page
}

test('a changed table token clears only the guest cookie and prior table connection', async () => {
  const tokenA = 'A'.repeat(32)
  const tokenB = 'B'.repeat(32)
  const storage = new Map([
    ['mbox.table.session', { tableCode: 'A01', tableToken: tokenA }],
    ['mbox.connected.table.token', tokenA],
    ['mbox.table.connection.state', { status: 'active' }],
    [GUEST_COOKIE_KEY, '__Host-mbox_guest_session=guest-a'],
    [RESERVATION_COOKIE_KEY, 'mbox_reservation_session=reservation-kept'],
  ])
  const session = await loadSessionModule(storage)
  session.applyLaunchSession({ query: { tableToken: tokenB, tableCode: 'B02' } }, {
    isDevelopment: false, defaultTableCode: '', defaultTableToken: '',
  })
  assert.equal(storage.get(GUEST_COOKIE_KEY), undefined)
  assert.equal(storage.get(RESERVATION_COOKIE_KEY), 'mbox_reservation_session=reservation-kept')
  assert.equal(storage.get('mbox.connected.table.token'), undefined)
  assert.equal(storage.get('mbox.table.connection.state'), undefined)
})

test('an explicit rescan of the same fixed QR clears the prior cart generation before requesting the next turn', async () => {
  const token = 'F'.repeat(32)
  const storage = new Map([
    ['mbox.table.session', {
      tableCode: 'VIP1', tableToken: token, cartScope: 'cart-scope-for-turn-a-000000001', scanNonce: 'scan-turn-a',
    }],
    ['mbox.connected.table.token', token],
    ['mbox.table.connection.state', { status: 'active', scanNonce: 'scan-turn-a' }],
    [GUEST_COOKIE_KEY, '__Host-mbox_guest_session=guest-a'],
    [PENDING_PAYMENT_KEY, { orderPublicId: 'order-a', tableScope: 'old-scope' }],
    [RESERVATION_COOKIE_KEY, 'mbox_reservation_session=reservation-kept'],
  ])
  const sessionModule = await loadSessionModule(storage)
  const session = sessionModule.applyLaunchSession({
    query: { tableToken: token, tableCode: 'VIP1' }, forceTableScan: true,
  }, { isDevelopment: false, defaultTableCode: '', defaultTableToken: '' })

  assert.equal(session.cartScope, '')
  assert.notEqual(session.scanNonce, 'scan-turn-a')
  assert.equal(storage.get(GUEST_COOKIE_KEY), undefined)
  assert.equal(storage.get(PENDING_PAYMENT_KEY), undefined)
  assert.equal(storage.get(RESERVATION_COOKIE_KEY), 'mbox_reservation_session=reservation-kept')
  assert.equal(storage.get('mbox.connected.table.token'), undefined)
  assert.equal(storage.get('mbox.table.connection.state'), undefined)
})

test('wrong-table payment recovery has a direct rescan instruction', async () => {
  const customerError = await loadCustomerErrorModule()
  assert.equal(
    customerError.customerErrorMessage({ code: 'GUEST_ORDER_ACCESS_FORBIDDEN' }, 'fallback'),
    '这笔订单不属于当前桌位，请重新扫描当前桌面的二维码',
  )
  assert.equal(
    customerError.customerErrorMessage({ code: 'GUEST_SESSION_INVALID' }, 'fallback'),
    '桌台连接已失效，请重新扫描桌面二维码',
  )
})

test('a delayed A guest-session response cannot overwrite B connection state or connected token', async () => {
  const state = { session: { tableCode: 'A01', tableToken: 'token-a', scanNonce: 'scan-a' }, storage: new Map(), cleared: 0 }
  const fixture = await loadApiRaceModule(state)
  const pending = fixture.api.getGuestSession()
  // A scanned session first refreshes the WeChat identity before issuing its
  // guarded scan request; let that intentional async boundary schedule it.
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(fixture.calls[0].options.expectedTableScope, 'scan:scan-a:token-a')
  assert.equal(fixture.calls[0].options.guardCookiePersistence, true)

  state.session = { tableCode: 'B02', tableToken: 'token-b', scanNonce: 'scan-b' }
  fixture.calls[0].pending.resolve({ data: { status: 'active', table: { code: 'A01' } } })
  await assert.rejects(pending, (error) => error && error.code === 'TABLE_SESSION_SCOPE_CHANGED')
  assert.deepEqual(fixture.remembered, [])
  assert.equal(state.storage.get('mbox.connected.table.token'), undefined)
})

test('a fixed QR rescan keeps B when B resolves before the prior A turnover response', async () => {
  const state = {
    session: { tableCode: 'A01', tableToken: 'fixed-token', scanNonce: 'scan-turn-a' },
    storage: new Map(), cleared: 0,
  }
  const fixture = await loadApiRaceModule(state)
  const pendingA = fixture.api.getGuestSession()
  await new Promise((resolve) => setTimeout(resolve, 0))
  state.session = { tableCode: '', tableToken: 'fixed-token', scanNonce: 'scan-turn-b' }
  const pendingB = fixture.api.getGuestSession()
  await new Promise((resolve) => setTimeout(resolve, 0))

  fixture.calls[1].pending.resolve({ data: {
    status: 'active', table: { code: 'VIP1' }, cartScope: 'cart-scope-for-turn-b-000000002',
  } })
  await pendingB
  fixture.calls[0].pending.resolve({ data: {
    status: 'active', table: { code: 'VIP1' }, cartScope: 'cart-scope-for-turn-a-000000001',
  } })
  await assert.rejects(pendingA, (error) => error && error.code === 'TABLE_SESSION_SCOPE_CHANGED')

  assert.equal(state.session.cartScope, 'cart-scope-for-turn-b-000000002')
  assert.equal(state.storage.get('mbox.connected.table.token'), 'fixed-token')
  assert.deepEqual(fixture.remembered.map((value) => value.cartScope), ['cart-scope-for-turn-b-000000002'])
})

test('a delayed ordinary guest-order response cannot replace B guest cookie and cannot clear reservation cookie', async () => {
  const state = {
    session: { tableCode: 'A01', tableToken: 'token-a', cartScope: 'cart-scope-for-turn-a-000000001' },
    storage: new Map([
      [GUEST_COOKIE_KEY, '__Host-mbox_guest_session=guest-a'],
      [RESERVATION_COOKIE_KEY, 'mbox_reservation_session=reservation-kept'],
    ]),
  }
  const fixture = await loadRequestRaceModule(state)
  const pending = fixture.request('/api/guest/orders/table', { requireTableSession: false })
  state.session = { tableCode: 'B02', tableToken: 'token-b', cartScope: 'cart-scope-for-turn-b-000000002' }
  state.storage.set(GUEST_COOKIE_KEY, '__Host-mbox_guest_session=guest-b')
  fixture.calls[0].success({
    statusCode: 200, data: { ok: true },
    header: { 'Set-Cookie': '__Host-mbox_guest_session=guest-a-late; Path=/; HttpOnly' },
  })
  await pending
  assert.equal(state.storage.get(GUEST_COOKIE_KEY), '__Host-mbox_guest_session=guest-b')
  assert.equal(state.storage.get(RESERVATION_COOKIE_KEY), 'mbox_reservation_session=reservation-kept')
})

test('a delayed A response from the same fixed QR cannot replace B turnover guest cookie', async () => {
  const state = {
    session: { tableCode: 'VIP1', tableToken: 'fixed-token', cartScope: 'cart-scope-for-turn-a-000000001' },
    storage: new Map([
      [GUEST_COOKIE_KEY, '__Host-mbox_guest_session=guest-a'],
      [RESERVATION_COOKIE_KEY, 'mbox_reservation_session=reservation-kept'],
    ]),
  }
  const fixture = await loadRequestRaceModule(state)
  const pending = fixture.request('/api/guest/orders/table', { requireTableSession: false })
  state.session = { tableCode: 'VIP1', tableToken: 'fixed-token', cartScope: 'cart-scope-for-turn-b-000000002' }
  state.storage.set(GUEST_COOKIE_KEY, '__Host-mbox_guest_session=guest-b')
  fixture.calls[0].success({
    statusCode: 200, data: { ok: true },
    header: { 'Set-Cookie': '__Host-mbox_guest_session=guest-a-late; Path=/; HttpOnly' },
  })
  await pending
  assert.equal(state.storage.get(GUEST_COOKIE_KEY), '__Host-mbox_guest_session=guest-b')
  assert.equal(state.storage.get(RESERVATION_COOKIE_KEY), 'mbox_reservation_session=reservation-kept')
})

test('Home refreshes from an unscanned launch after a table scan and displays only the current table', async () => {
  const state = { session: { tableCode: '', tableToken: '' }, storage: new Map(), guestSessionReads: 0 }
  const page = await loadHomePage(state)
  page.onLoad({})
  await page.loadData()
  assert.equal(page.data.hasTableSession, false)
  assert.equal(page.data.visitState, 'prearrival')

  state.session = { tableCode: 'B02', tableToken: 'token-b' }
  await page.loadData()
  assert.equal(state.guestSessionReads, 1)
  assert.equal(page.data.hasTableSession, true)
  assert.equal(page.data.table.code, 'B02')
  assert.equal(page.data.visitState, 'active')
})

test('a token-only scan stays current when the guest-session response resolves its table code', async () => {
  const state = {
    session: { tableCode: '', tableToken: 'token-b', scanNonce: 'scan-b' },
    resolvedTableCode: 'B02', resolvedCartScope: 'cart-scope-for-turn-b-000000002',
    storage: new Map(), guestSessionReads: 0,
  }
  const page = await loadHomePage(state)
  page.onLoad({})
  await page.loadData()
  assert.equal(state.guestSessionReads, 1)
  assert.equal(page.data.visitState, 'active')
  assert.equal(page.data.table.code, 'B02')
  assert.equal(page.visibleTableScope, scope(state.session))
})

test('Order keeps a token-only scan active and clears an unscoped A pending payment during a weak B-table refresh', async () => {
  const state = {
    session: { tableCode: '', tableToken: 'token-b', scanNonce: 'scan-b' },
    resolvedTableCode: 'B02', resolvedCartScope: 'cart-scope-for-turn-b-000000002',
    storage: new Map([[PENDING_PAYMENT_KEY, {
      orderPublicId: 'order-a', retryIdempotencyKey: 'retry-a', amountText: '¥88.00',
    }]]),
  }
  const { page, calls } = await loadOrderPage(state)
  await page.preparePage()
  assert.equal(page.data.connectionState, 'active')
  assert.equal(page.data.table.code, 'B02')
  assert.equal(page.visibleTableScope, scope(state.session))
  assert.equal(page.data.pendingPayment, null)
  assert.equal(state.storage.get(PENDING_PAYMENT_KEY), undefined)
  await page.continuePayment()
  assert.equal(calls.retryOrderPayment, 0)
})

test('Order drops the pending record instead of retrying a wrong-table payment', async () => {
  const paymentScope = 'cache.session:fixed-token:cart-scope-for-turn-b-000000002'
  const wrongTable = Object.assign(new Error('wrong table'), { code: 'GUEST_ORDER_ACCESS_FORBIDDEN', statusCode: 409 })
  const state = {
    session: { tableCode: '', tableToken: 'fixed-token', scanNonce: 'scan-b' },
    resolvedTableCode: 'VIP1', resolvedCartScope: 'cart-scope-for-turn-b-000000002',
    retryPaymentError: wrongTable,
    storage: new Map(),
  }
  const { page, calls } = await loadOrderPage(state)
  await page.preparePage()
  const pending = { orderPublicId: 'order-a', retryIdempotencyKey: 'retry-a', tableScope: paymentScope, canContinue: true }
  state.storage.set(PENDING_PAYMENT_KEY, pending)
  page.setData({ pendingPayment: pending })
  await page.continuePayment()

  assert.equal(calls.retryOrderPayment, 1)
  assert.equal(state.storage.get(PENDING_PAYMENT_KEY), undefined)
  assert.equal(page.data.pendingPayment, null)
  assert.match(page.data.error, /重新扫描当前桌面/)
})

test('Account drops an A pending-payment record and late A orders after a B table switch', async () => {
  const aOrders = deferred()
  const bOrders = deferred()
  const state = {
    session: { tableCode: 'VIP1', tableToken: 'fixed-token', cartScope: 'cart-scope-for-turn-a-000000001' },
    storage: new Map([[PENDING_PAYMENT_KEY, {
      orderPublicId: 'order-a', retryIdempotencyKey: 'retry-a', tableScope: 'cache.session:fixed-token:cart-scope-for-turn-a-000000001',
    }]]),
    orderReads: [aOrders, bOrders],
  }
  const page = await loadAccountPage(state)
  page.onLoad()
  const firstLoad = page.loadData()
  await Promise.resolve()
  page.setData({ busyOrderId: 'order-a' })

  state.session = { tableCode: 'VIP1', tableToken: 'fixed-token', cartScope: 'cart-scope-for-turn-b-000000002' }
  const secondLoad = page.loadData()
  bOrders.resolve([{ publicId: 'order-b', round: 1, status: 'submitted', paymentStatus: 'unpaid', payableAmountMinor: 8800, paymentAccess: 'available', items: [] }])
  await secondLoad
  aOrders.resolve([{ publicId: 'order-a', round: 1, status: 'submitted', paymentStatus: 'unpaid', payableAmountMinor: 8800, paymentAccess: 'available', items: [] }])
  await firstLoad

  assert.equal(state.storage.get(PENDING_PAYMENT_KEY), undefined)
  assert.deepEqual(page.data.orders.map((item) => item.publicId), ['order-b'])
  assert.equal(page.data.tableCode, 'VIP1')
  assert.equal(page.data.busyOrderId, '')
})

test('Account clears an unscoped legacy pending-payment record before showing a table bill', async () => {
  const orders = deferred()
  const state = {
    session: { tableCode: 'B02', tableToken: 'token-b' },
    storage: new Map([[PENDING_PAYMENT_KEY, {
      orderPublicId: 'legacy-order', retryIdempotencyKey: 'legacy-retry',
    }]]),
    orderReads: [orders],
  }
  const page = await loadAccountPage(state)
  page.onLoad()
  const load = page.loadData()
  assert.equal(state.storage.get(PENDING_PAYMENT_KEY), undefined)
  orders.resolve([])
  await load
})

test('Account drops the pending record when payment recovery is rejected for another table', async () => {
  const paymentScope = 'cache.session:fixed-token:cart-scope-for-turn-b-000000002'
  const wrongTable = Object.assign(new Error('wrong table'), { code: 'GUEST_ORDER_ACCESS_FORBIDDEN', statusCode: 409 })
  const state = {
    session: { tableCode: 'VIP1', tableToken: 'fixed-token', cartScope: 'cart-scope-for-turn-b-000000002' },
    storage: new Map(), orderReads: [], retryPaymentError: wrongTable,
  }
  const page = await loadAccountPage(state)
  page.onLoad()
  page.setData({ orders: [{ publicId: 'order-a', payableText: '¥88.00', canPay: true }] })
  await page.continuePayment({ currentTarget: { dataset: { id: 'order-a' } } })

  assert.equal(state.retryPaymentCalls, 1)
  assert.equal(state.storage.get(PENDING_PAYMENT_KEY), undefined)
  assert.equal(page.data.busyOrderId, '')
  assert.match(page.data.error, /重新扫描当前桌面/)
  assert.doesNotMatch(String(state.storage.get(PENDING_PAYMENT_KEY) || ''), new RegExp(paymentScope))
})

test('Account also drops the pending record when the guest table session has expired', async () => {
  const paymentScope = 'cache.session:fixed-token:cart-scope-for-turn-b-000000002'
  const expired = Object.assign(new Error('guest session expired'), { code: 'GUEST_SESSION_INVALID', statusCode: 401 })
  const state = {
    session: { tableCode: 'VIP1', tableToken: 'fixed-token', cartScope: 'cart-scope-for-turn-b-000000002' },
    storage: new Map(), orderReads: [], retryPaymentError: expired,
  }
  const page = await loadAccountPage(state)
  page.onLoad()
  page.setData({ orders: [{ publicId: 'order-b', payableText: '¥88.00', canPay: true }] })
  await page.continuePayment({ currentTarget: { dataset: { id: 'order-b' } } })

  assert.equal(state.retryPaymentCalls, 1)
  assert.equal(state.storage.get(PENDING_PAYMENT_KEY), undefined)
  assert.equal(page.data.busyOrderId, '')
  assert.match(page.data.error, /重新扫描当前桌面/)
  assert.doesNotMatch(String(state.storage.get(PENDING_PAYMENT_KEY) || ''), new RegExp(paymentScope))
})
