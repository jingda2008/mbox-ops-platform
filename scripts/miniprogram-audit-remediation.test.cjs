// Regression: real page methods with isolated API boundaries; not native UI evidence.
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const ts = require('typescript')
const root = process.cwd()
const app = JSON.parse(fs.readFileSync('miniprogram/app.json', 'utf8'))
function emit(name, evidence) { console.log(JSON.stringify({ name, evidence })) }
const inventory = []
for (const route of app.pages) {
  const file = `miniprogram/${route}.js`
  const source = fs.readFileSync(file, 'utf8')
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  let object
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'Page') object = node.arguments[0]
    ts.forEachChild(node, visit)
  }
  visit(ast)
  const methods = new Set(object.properties.filter(p => ts.isMethodDeclaration(p) || (ts.isPropertyAssignment(p) && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer)))).map(p => p.name.getText(ast)))
  const wxml = fs.readFileSync(`miniprogram/${route}.wxml`, 'utf8')
  const bindings = [...wxml.matchAll(/\b(?:capture-)?(?:bind|catch):?[\w-]+\s*=\s*["']([^"']+)["']/g)].map(m => m[1])
  const missing = [...new Set(bindings.filter(name => !name.includes('{{') && !methods.has(name)))]
  inventory.push({ route, bindings: bindings.length, handlers: new Set(bindings).size, missing })
}
emit('all-native-page-bindings', inventory)
assert(inventory.every(row => row.missing.length === 0))
function pageHarness(name, overrides = {}) {
  let page
  const sourcePath = path.join(root, 'miniprogram/pages', name, 'index.js')
  const storage = new Map()
  const noop = () => {}
  const wx = { getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key), showToast: noop, navigateBack: noop, switchTab: noop, navigateTo: noop, ...overrides.wx }
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), {
    Page(value) { page = value; page.data = structuredClone(value.data); page.setData = next => Object.assign(page.data, next) },
    wx, console, setTimeout: noop, clearTimeout: noop, setInterval: noop, clearInterval: noop,
    require(name) {
      if (name in overrides) return overrides[name]
      if (name.includes('/api')) return overrides.api || {}
      if (name.includes('/config')) return { getRuntimeConfig: () => ({ isDevelopment: true }) }
      if (name.includes('/session')) return { getTableSession: () => ({ tableCode: 'AUDIT', tableToken: 'isolated-token', cartScope: 'same-table-session' }), tableSessionCacheScope: () => 'audit-scope' }
      if (name.includes('public-share')) return { enablePublicShareMenu: noop }
      if (name.includes('customer-error')) return { customerErrorMessage: (_, fallback) => fallback }
      const importedPath = path.resolve(path.dirname(sourcePath), name) + '.js'
      const importedModule = { exports: {} }
      vm.runInNewContext(fs.readFileSync(importedPath, 'utf8'), { module: importedModule, wx, require: () => ({}), console }, { filename: importedPath })
      return importedModule.exports
    },
  }, { filename: sourcePath })
  return page
}
async function run() {
  let saved
  const pref = pageHarness('profile-preferences', { api: {
    updatePreferences: async body => { saved = body },
    getCustomerProfile: async () => ({ preferences: saved || {} }),
    recordBirthdayBenefitConsent: async () => {}, withdrawBirthdayBenefitConsent: async () => {},
  } })
  await pref.load()
  const event = value => ({ currentTarget: { dataset: { value } } })
  pref.toggleAlcohol(event('cocktail')); pref.toggleAlcohol(event('wine'))
  const selectedBefore = pref.data.alcohol.filter(i => i.selected).map(i => i.value)
  await pref.save(); await pref.load()
  assert.equal(saved.preferredAlcohol, 'mixed')
  assert.equal(JSON.stringify(pref.data.alcohol.filter(i=>i.selected).map(i=>i.value)), JSON.stringify(selectedBefore))
  emit('preference-multiple-selection-roundtrip', { selectedBefore, saved: saved.preferredAlcohol, selectedAfter: pref.data.alcohol.filter(i => i.selected).map(i => i.value) })
  const notifications = pageHarness('profile-notifications', { api: {
    getWechatNotificationAuthorizations: async () => { throw new Error('simulated network unavailable') },
    getWechatMemberServiceNotificationAuthorizations: async () => { throw new Error('simulated network unavailable') },
  } })
  await notifications.load()
  assert.notEqual(notifications.data.error, '')
  assert.equal(notifications.data.options.length, 0)
  emit('notification-errors-visible', notifications.data)
  let resolveService
  let writes = 0
  const pending = new Promise(resolve => { resolveService = resolve })
  const order = pageHarness('order', { api: {
    createServiceTask: async () => { writes++; return pending },
    getGuestSession: async () => ({ data: { status: 'active', cartProtocolVersion: 2 } }),
  } })
  // Unrelated loads/polls stubbed; real lifecycle, generation and mutation handlers retained.
  order.stopWaitingPoll = order.stopSharedCartPolling = order.stopServicePolling = order.stopShakeRecommendation = () => {}
  order.loadActiveData = async () => {}
  order.queuePendingGuestPaymentAbandonment = () => null
  await order.preparePage()
  order.data.products = [{ productId: 'choice-layout', available: true, productKind: 'bundle', bundleChoiceGroups: [{ id: 'group', selectionCount: 1, options: [{ productId: 'cocktail', available: true }] }] }]
  order.data.detailInformationExpanded = true
  await order.addProduct({ currentTarget: { dataset: { id: 'choice-layout' } } })
  assert.equal(order.data.detailProduct.selectionSource, 'menu_add')
  assert.equal(order.data.detailInformationExpanded, false)
  assert.equal(order.data.detailSelectionsComplete, false)
  order.closeProductDetail()
  const code = 'call'
  const first = order.requestQuickService({ currentTarget: { dataset: { code } } })
  assert.equal(writes, 1)
  order.onHide()
  resolveService({ data: { taskStatus: 'pending' } })
  await first
  await order.preparePage()
  await order.requestQuickService({ currentTarget: { dataset: { code } } })
  assert.equal(writes, 2)
  assert.equal(order.data.quickServiceBusy, '')
  emit('order-same-table-hide-return-service-recovered', { writesAfterSecondClick: writes, quickServiceBusy: order.data.quickServiceBusy })
  let finishCart
  let cartWrites = 0
  const pendingCart = new Promise(resolve => { finishCart = resolve })
  const cart = pageHarness('order', { api: {
    adjustSharedCart: async () => { cartWrites++; return pendingCart },
    getGuestSession: async () => ({ data: { status: 'active', cartProtocolVersion: 2 } }),
  } })
  cart.stopWaitingPoll = cart.stopSharedCartPolling = cart.stopServicePolling = cart.stopShakeRecommendation = () => {}
  cart.loadActiveData = async () => {}
  cart.queuePendingGuestPaymentAbandonment = () => null
  await cart.preparePage()
  const adjustment = cart.adjustSharedCart('isolated-product', 1)
  assert.equal(cartWrites, 1)
  cart.onHide(); finishCart({ items: [], version: 1 })
  await adjustment; await cart.preparePage()
  await cart.adjustSharedCart('isolated-product', 1)
  assert.equal(cartWrites, 2)
  assert.equal(cart.data.cartSyncing, false)
  emit('order-same-table-hide-return-cart-recovered', { cartSyncing: cart.data.cartSyncing, requestsAfterSecondClick: cartWrites })
  let resolveOldShow, resolveOldAvailability
  const oldShow = new Promise(resolve => { resolveOldShow = resolve })
  const oldAvailability = new Promise(resolve => { resolveOldAvailability = resolve })
  const reservation = pageHarness('reservations', { api: {
    getReservationPerformances: async date => date === '2026-09-10' ? oldShow : { schedules: [{ id: 'NEW-DAY', performerStageName: 'New day show', startsAt: '2026-09-11T20:00:00+08:00', endsAt: '2026-09-11T21:00:00+08:00' }] },
    getReservationAvailability: async arrival => arrival.startsWith('2026-09-10') ? oldAvailability : { acceptingReservations: false },
  } })
  reservation.data.reservationDate = '2026-09-10'
  const oldShowRequest = reservation.loadPerformances()
  const oldAvailabilityRequest = reservation.checkAvailability()
  reservation.data.reservationDate = '2026-09-11'
  await reservation.loadPerformances(); await reservation.checkAvailability()
  resolveOldShow({ schedules: [{ id: 'OLD-DAY', performerStageName: 'Old day show', startsAt: '2026-09-10T20:00:00+08:00', endsAt: '2026-09-10T21:00:00+08:00' }] })
  resolveOldAvailability({ acceptingReservations: true })
  await oldShowRequest; await oldAvailabilityRequest
  assert.equal(reservation.data.performances[0].id, 'NEW-DAY')
  assert.equal(reservation.data.availability.acceptingReservations, false)
  emit('reservation-date-request-response-race', { selectedDate: reservation.data.reservationDate, showId: reservation.data.performances[0].id, acceptingReservations: reservation.data.availability.acceptingReservations })
}
test('SYS-092/096/097/098 page lifecycle and response ownership regression', run)
