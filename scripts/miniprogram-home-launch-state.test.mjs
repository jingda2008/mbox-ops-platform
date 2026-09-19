import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

const tokenA = 'A'.repeat(32), tokenB = 'B'.repeat(32)
const config = { isDevelopment: false, defaultTableCode: '', defaultTableToken: '' }

// Run the actual App, session and Home modules together: page-only mocks hide
// the second launch parse that can discard the App's current scan.
function fixture(storage = new Map()) {
  const app = { globalData: {} }, cache = new Map()
  let pageDefinition
  const wx = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
  }
  function load(url) {
    if (cache.has(url.href)) return cache.get(url.href).exports
    const module = { exports: {} }; cache.set(url.href, module)
    vm.runInNewContext(readFileSync(url, 'utf8'), {
      module, wx, Date, setTimeout, clearTimeout, getApp: () => app,
      App: definition => Object.assign(app, definition),
      Page: definition => { pageDefinition = definition },
      require: name => {
        if (name.endsWith('/config/index')) return { getRuntimeConfig: () => config }
        if (name.endsWith('/auth')) return { ensureCustomerSession: async () => true }
        if (name.endsWith('/api')) return {
          getGuestSession: async () => {
            const current = app.globalData.tableSession
            assert.ok(current.tableToken, 'table identity must survive page creation')
            const table = { code: current.tableToken === tokenB ? 'W03' : 'W02' }
            const data = { status: 'active', table, cartScope: 'verified-cart-scope-00001' }
            load(new URL('../miniprogram/utils/session.js', import.meta.url)).rememberTableConnection(data)
            return { data }
          },
          getMiniBootstrap: async () => ({ activities: [], content: [] }),
          getReservations: async () => ({ reservations: [] }),
          getReservationPerformances: async () => null,
          getCustomerBenefits: async () => [],
        }
        return load(new URL(`${name}.js`, url))
      },
    }, { filename: url.pathname })
    return module.exports
  }
  load(new URL('../miniprogram/app.js', import.meta.url))
  const session = load(new URL('../miniprogram/utils/session.js', import.meta.url))
  function home(options = {}) {
    load(new URL('../miniprogram/pages/home/index.js', import.meta.url))
    const page = { ...pageDefinition, data: structuredClone(pageDefinition.data) }
    page.setData = patch => Object.assign(page.data, patch)
    page.onLoad(options)
    return page
  }
  return { app, session, storage, home }
}

test('first Home tab visit preserves the scan established by a direct Order launch', async () => {
  const f = fixture(), launch = { path: 'pages/order/index', query: { scene: tokenA } }
  f.app.onLaunch(launch); f.app.onShow(launch)
  const before = f.app.globalData.tableSession
  const home = f.home({})
  assert.equal(f.app.globalData.tableSession.tableToken, tokenA)
  assert.equal(f.app.globalData.tableSession.scanNonce, before.scanNonce)
  await home.loadData()
  assert.equal(home.data.table.code, 'W02')
  assert.equal(home.data.canEnter, true)
})

test('Home creation does not replace a newer warm scan with stale page options', async () => {
  const f = fixture(), first = { query: { scene: tokenA } }
  f.app.onLaunch(first); f.app.onShow(first)
  f.app.onShow({ query: { scene: tokenB } })
  const before = f.app.globalData.tableSession
  const home = f.home({ scene: tokenA })
  assert.equal(f.app.globalData.tableSession.tableToken, tokenB)
  assert.equal(f.app.globalData.tableSession.scanNonce, before.scanNonce)
  await home.loadData()
  assert.equal(home.data.table.code, 'W03')
})

test('Home preserves a verified table visit and its guest cookie across first tab creation', async () => {
  const f = fixture(), launch = { query: { scene: tokenA } }
  f.app.onLaunch(launch); f.app.onShow(launch)
  f.session.rememberTableConnection({ status: 'active', table: { code: 'W02' }, cartScope: 'verified-cart-scope-00001' })
  f.storage.set('mbox.http.cookie.guest.v2', 'test-guest-cookie')
  const before = f.app.globalData.tableSession
  const home = f.home({})
  assert.equal(f.app.globalData.tableSession.tableToken, tokenA)
  assert.equal(f.app.globalData.tableSession.cartScope, before.cartScope)
  assert.equal(f.app.globalData.tableSession.scanNonce, before.scanNonce)
  assert.equal(f.storage.get('mbox.http.cookie.guest.v2'), 'test-guest-cookie')
  await home.loadData()
  assert.equal(home.data.table.code, 'W02')
})

test('cold unscanned Home launch still does not revive a previous active table from storage', async () => {
  const f = fixture(new Map([
    ['mbox.table.session', { tableCode: 'W02', tableToken: tokenA, cartScope: 'verified-cart-scope-00001', scanNonce: 'previous-scan' }],
    ['mbox.table.connection.state', { status: 'active' }],
  ]))
  f.app.onLaunch({ query: {} }); f.app.onShow({ query: {} })
  const home = f.home({})
  await home.loadData()
  assert.equal(f.app.globalData.tableSession.tableToken, '')
  assert.equal(home.data.canEnter, false)
  assert.equal(home.data.table, null)
})
