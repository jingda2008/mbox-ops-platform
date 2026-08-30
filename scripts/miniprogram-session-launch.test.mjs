import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

import './miniprogram-request-credential-domain.test.mjs'
import './miniprogram-activity-share.test.mjs'
import './miniprogram-public-share.test.mjs'
import './miniprogram-table-scope-race.test.mjs'

async function loadSessionModule() {
  const source = await readFile(new URL('../miniprogram/utils/session.js', import.meta.url), 'utf8')
  const storage = new Map()
  const app = { globalData: {} }
  const context = {
    module: { exports: {} },
    exports: {},
    getApp: () => app,
    wx: {
      getStorageSync: (key) => storage.get(key),
      setStorageSync: (key, value) => storage.set(key, value),
      removeStorageSync: (key) => storage.delete(key),
    },
  }
  vm.runInNewContext(source, context, { filename: 'miniprogram/utils/session.js' })
  return { session: context.module.exports, storage }
}

async function loadTableRequestScopeModule() {
  const source = await readFile(new URL('../miniprogram/utils/table-request-scope.js', import.meta.url), 'utf8')
  const context = { module: { exports: {} }, exports: {} }
  vm.runInNewContext(source, context, { filename: 'miniprogram/utils/table-request-scope.js' })
  return context.module.exports
}

async function loadAppModule(storage, options = {}) {
  const sessionSource = await readFile(new URL('../miniprogram/utils/session.js', import.meta.url), 'utf8')
  const app = { globalData: {} }
  const sessionContext = {
    module: { exports: {} }, exports: {}, getApp: () => app,
    wx: {
      getStorageSync: (key) => storage.get(key),
      setStorageSync: (key, value) => storage.set(key, value),
      removeStorageSync: (key) => storage.delete(key),
    },
  }
  vm.runInNewContext(sessionSource, sessionContext, { filename: 'miniprogram/utils/session.js' })

  const appSource = await readFile(new URL('../miniprogram/app.js', import.meta.url), 'utf8')
  const context = {
    App(definition) {
      Object.assign(app, definition)
      app.globalData = Object.assign({}, definition.globalData)
    },
    require(specifier) {
      if (specifier === './config/index') return { getRuntimeConfig: () => production }
      if (specifier === './utils/session') return sessionContext.module.exports
      if (specifier === './utils/auth') return {
        ensureCustomerSession: async () => {
          options.ensureCustomerSessionCalls && options.ensureCustomerSessionCalls.push(true)
          return true
        },
      }
      if (specifier === './utils/customer-error') return { customerErrorMessage: (_error, fallback) => fallback }
      throw new Error(`unexpected require: ${specifier}`)
    },
  }
  vm.runInNewContext(appSource, context, { filename: 'miniprogram/app.js' })
  return { app, session: sessionContext.module.exports }
}

const production = Object.freeze({
  isDevelopment: false, defaultTableCode: '', defaultTableToken: '',
})

test('reads the official mini-program code token from launchOptions.query.scene', async () => {
  const { session } = await loadSessionModule()
  const token = 'A'.repeat(32)
  const result = session.applyLaunchSession({ scene: 1047, query: { scene: token } }, production)
  assert.equal(result.tableToken, token)
  assert.equal(result.tableCode, '')
})

test('reads encoded scene parameters and accepts matching explicit aliases', async () => {
  const { session } = await loadSessionModule()
  const token = 'B'.repeat(32)
  const scene = encodeURIComponent(`token=${token}&table=L01`)
  const result = session.applyLaunchSession({ query: { scene, tableCode: 'L01', tableToken: token } }, production)
  assert.equal(result.tableToken, token)
  assert.equal(result.tableCode, 'L01')
})

test('scopes local table records to the scanned credential, not a reusable table code', async () => {
  const { session } = await loadSessionModule()
  const first = session.tableSessionCacheScope({
    tableCode: 'A01', tableToken: 'E'.repeat(32), cartScope: 'cart-scope-for-turn-a-000000001',
  })
  const repeated = session.tableSessionCacheScope({
    tableCode: 'A01', tableToken: 'E'.repeat(32), cartScope: 'cart-scope-for-turn-a-000000001',
  })
  const sameFixedQrNextTurn = session.tableSessionCacheScope({
    tableCode: 'A01', tableToken: 'E'.repeat(32), cartScope: 'cart-scope-for-turn-b-000000002',
  })
  const nextTurnover = session.tableSessionCacheScope({ tableCode: 'A01', tableToken: 'F'.repeat(32) })
  assert.equal(first, repeated)
  assert.notEqual(first, sameFixedQrNextTurn)
  assert.notEqual(first, nextTurnover)
  assert.match(first, /^A01\.[a-z0-9]+$/)
  assert.doesNotMatch(first, /E{8}/)
})

test('rebases the verified scan response but drops a delayed response from an earlier fixed-QR turnover', async () => {
  const { createTableRequestGuard, tableRequestScope } = await loadTableRequestScopeModule()
  let current = tableRequestScope({ tableCode: '', tableToken: 'fixed-token', scanNonce: 'scan-turn-a' })
  const guard = createTableRequestGuard(() => current)
  const first = guard.begin(current)
  // The active scan receives cartScope and remains the same request.
  current = tableRequestScope({ tableCode: 'A01', tableToken: 'fixed-token', cartScope: 'cart-scope-for-turn-a-000000001' })
  assert.equal(guard.rebase(first, current), true)
  assert.equal(guard.isCurrent(first), true)
  // A fresh scan of the same fixed QR gets a new local generation. Its result
  // wins even when the old response arrives later.
  current = tableRequestScope({ tableCode: '', tableToken: 'fixed-token', scanNonce: 'scan-turn-b' })
  const second = guard.begin(current)
  assert.equal(guard.isCurrent(first), false)
  assert.equal(guard.isCurrent(second), true)
  guard.invalidate()
  assert.equal(guard.isCurrent(second), false)
})

test('a cold launch of the same fixed QR starts a fresh generation and keeps the new turn after an old response', async () => {
  const token = 'G'.repeat(32)
  const cartScopeA = 'cart-scope-for-turn-a-000000001'
  const cartScopeB = 'cart-scope-for-turn-b-000000002'
  const storage = new Map([
    ['mbox.table.session', {
      tableCode: 'VIP1', tableToken: token, cartScope: cartScopeA, scanNonce: 'scan-turn-a',
    }],
    ['mbox.connected.table.token', token],
    ['mbox.table.connection.state', { status: 'active', scanNonce: 'scan-turn-a' }],
    ['mbox.http.cookie.guest.v2', '__Host-mbox_guest_session=guest-a'],
    ['mbox.pending.guest.payment.v1', { orderPublicId: 'order-a', tableScope: `cache.VIP1.${cartScopeA}` }],
  ])
  const { app, session } = await loadAppModule(storage)

  app.onLaunch({ query: { tableToken: token, tableCode: 'VIP1' } })
  const scanB = app.globalData.tableSession
  assert.equal(scanB.cartScope, '')
  assert.notEqual(scanB.scanNonce, 'scan-turn-a')
  assert.equal(storage.get('mbox.http.cookie.guest.v2'), undefined)
  assert.equal(storage.get('mbox.connected.table.token'), undefined)
  assert.equal(storage.get('mbox.pending.guest.payment.v1'), undefined)

  // This is the B scan response. It upgrades the one active local request to
  // the server-issued turn scope. The old A response must no longer be allowed
  // to rebase or write after this point.
  const { createTableRequestGuard, tableRequestScope } = await loadTableRequestScopeModule()
  let currentScope = tableRequestScope(scanB)
  const guard = createTableRequestGuard(() => currentScope)
  const bRequest = guard.begin(currentScope)
  const aRequest = { scope: `session:${token}:${cartScopeA}`, generation: bRequest.generation - 1 }
  session.rememberTableConnection({ status: 'active', table: { code: 'VIP1' }, cartScope: cartScopeB })
  currentScope = tableRequestScope(app.globalData.tableSession)
  assert.equal(guard.rebase(bRequest, currentScope), true)
  const pendingB = {
    orderPublicId: 'order-b',
    tableScope: session.tableSessionCacheScope(app.globalData.tableSession),
  }
  storage.set('mbox.pending.guest.payment.v1', pendingB)
  assert.equal(guard.rebase(aRequest, `session:${token}:${cartScopeA}`), false)

  // Home's ordinary onShow refresh must retain B's resolved turn rather than
  // clearing it for a second time.
  const refreshed = app.refreshRuntime({ query: { tableToken: token, tableCode: 'VIP1' } })
  assert.equal(refreshed.cartScope, cartScopeB)
  assert.equal(refreshed.scanNonce, scanB.scanNonce)
  assert.equal(guard.isCurrent(bRequest), true)
  assert.equal(tableRequestScope(refreshed), `session:${token}:${cartScopeB}`)
  assert.deepEqual(storage.get('mbox.pending.guest.payment.v1'), pendingB)
})

test('rejects conflicting, malformed or unknown scene values instead of choosing one credential', async () => {
  const { session } = await loadSessionModule()
  const first = 'C'.repeat(32)
  const second = 'D'.repeat(32)
  assert.throws(() => session.applyLaunchSession({ query: { scene: first, token: second } }, production), /参数冲突/)
  assert.throws(() => session.applyLaunchSession({ query: { token: first, tableToken: second } }, production), /参数冲突/)
  assert.throws(() => session.applyLaunchSession({ query: { scene: 'redirect=https%3A%2F%2Fevil.invalid' } }, production), /scene无效/)
  assert.throws(() => session.applyLaunchSession({ query: { scene: '%E0%A4%A' } }, production), /scene无效/)
})

test('the in-mini-program scanner accepts official mini-program codes without allowing album replay', async () => {
  const source = await readFile(new URL('../miniprogram/pages/order/index.js', import.meta.url), 'utf8')
  assert.match(source, /onlyFromCamera:\s*true/)
  assert.match(source, /scanType:\s*\[\s*['"]qrCode['"]\s*,\s*['"]wxCode['"]\s*\]/)
  assert.match(source, /parseScanValue\(result\.path \|\| result\.result\)/)
  assert.match(source, /refreshRuntime\(\{ query, forceTableScan: true \}\)/)
})

test('published activity and home images resolve against the reviewed API host in the mini-program', async () => {
  const source = await readFile(new URL('../miniprogram/utils/media.js', import.meta.url), 'utf8')
  assert.match(source, /startsWith\('\/api\/public\/media-assets\/'\)/)
  assert.match(source, /getRuntimeConfig\(\)\.apiBaseUrl/)
  for (const page of ['home/index.js', 'community/index.js', 'community-detail/index.js', 'profile/index.js']) {
    const pageSource = await readFile(new URL(`../miniprogram/pages/${page}`, import.meta.url), 'utf8')
    assert.match(pageSource, /publicImageUrl/)
  }
})
