import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

function harness(platform, mode = 'confirm') {
  const source = readFileSync(new URL(`../${platform}/pages/order/index.js`, import.meta.url), 'utf8')
  const tree = ts.createSourceFile('index.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const page = tree.statements.find(n => ts.isExpressionStatement(n) && ts.isCallExpression(n.expression) && n.expression.expression.getText(tree) === 'Page').expression.arguments[0]
  const methods = page.properties.filter(n => ['submitOrder', 'confirmDuplicateCheckout'].includes(n.name?.getText(tree)))
  const rejected = tree.statements.find(n => ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(tree) === 'CHECKOUT_REJECTED_BEFORE_ORDER')).getText(tree)
  const storage = new Map(), calls = [], modals = []
  let seq = 0, scope = 'table-one', generation = 1, instance
  const request = { scope, generation }
  const runtime = {
    getStorageSync: k => storage.get(k), setStorageSync: (k, v) => storage.set(k, v), removeStorageSync: k => storage.delete(k),
    showModal: options => {
      modals.push(options)
      if (mode === 'cart-changed') instance.data.cartVersion++
      if (mode === 'table-changed') { scope = 'table-two'; request.scope = scope }
      options.success({ confirm: mode !== 'cancel' })
    },
  }
  const actions = vm.runInNewContext(`${rejected}; ({${methods.map(n => n.getText(tree)).join(',')}})`, {
    wx: runtime, runtime, alipayOnlinePaymentEnabled: () => true,
    checkoutRecommendationAttribution: () => null, tableSessionCacheScope: () => scope,
    CHECKOUT_ATTEMPT_KEY: 'pending-checkout', PENDING_PAYMENT_KEY: 'pending-payment',
    randomId: () => `attempt-${++seq}`, customerErrorMessage: e => e.message, money: String,
    checkoutSharedCart: async (body, key) => {
      calls.push({ body, key })
      if (!body.confirmedDuplicateOrderId || mode === 'latest-conflict' && calls.length === 2) {
        throw Object.assign(new Error('重复点单'), { status: 409, code: 'GUEST_ORDER_DUPLICATE_CONFIRMATION_REQUIRED', details: { conflictingOrderId: calls.length === 1 ? 'original-order-123' : 'latest-order-456' } })
      }
      if (mode === 'lost-response' && calls.length === 2) throw new Error('lost committed response')
      return { order: { publicId: 'new-confirmed-order' }, payment: { publicId: 'payment', providerAction: {} }, sharedCart: {} }
    },
  })
  instance = { ...actions, data: { paymentStateReady: true, busy: false, cartGeneration: 2, cartVersion: 1 },
    currentTableRequest: () => request, isCurrentTableRequest: r => r.scope === scope && r.generation === generation,
    setData(v) { Object.assign(this.data, v) }, recordOrderTiming() {}, updateCart() {}, async handlePaymentAction() {},
  }
  return { instance, calls, modals, storage, request }
}

for (const platform of ['miniprogram', 'alipay-miniprogram']) {
  test(`${platform}: explicit duplicate confirmation sends the reviewed order with a new request key`, async () => {
    const h = harness(platform)
    await h.instance.submitOrder(null, false, null, h.request)
    assert.equal(h.modals.length, 1)
    assert.match(h.modals[0].content, /订单尾号 er-123/)
    assert.equal(h.calls.length, 2)
    assert.equal(h.calls[1].body.confirmedDuplicateOrderId, 'original-order-123')
    assert.notEqual(h.calls[0].key, h.calls[1].key)
    assert.equal(h.calls[1].body.expectedVersion, 1)
    assert.equal(h.storage.has('pending-checkout'), false)
    assert.equal(h.instance.data.pendingPayment.orderPublicId, 'new-confirmed-order')
  })
  for (const mode of ['cancel', 'cart-changed', 'table-changed']) test(`${platform}: ${mode} never confirms a stale request`, async () => {
    const h = harness(platform, mode)
    await h.instance.submitOrder(null, false, null, h.request)
    assert.equal(h.calls.length, 1)
    assert.equal(h.storage.has('pending-checkout'), false)
  })
  test(`${platform}: uncertain confirmed checkout reuses confirmation, version and key`, async () => {
    const h = harness(platform, 'lost-response')
    await h.instance.submitOrder(null, false, null, h.request)
    const saved = h.storage.get('pending-checkout')
    assert.equal(saved.confirmedDuplicateOrderId, 'original-order-123')
    assert.equal(h.instance.data.checkoutLocked, true)
    await h.instance.submitOrder(null, false, saved, h.request)
    assert.deepEqual(h.calls[2], h.calls[1])
    assert.equal(h.modals.length, 1)
  })
  test(`${platform}: a newer conflicting order requires another explicit confirmation`, async () => {
    const h = harness(platform, 'latest-conflict')
    await h.instance.submitOrder(null, false, null, h.request)
    assert.equal(h.modals.length, 2)
    assert.equal(h.calls[2].body.confirmedDuplicateOrderId, 'latest-order-456')
    assert.equal(new Set(h.calls.map(c => c.key)).size, 3)
  })
}
