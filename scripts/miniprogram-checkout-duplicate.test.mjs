import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

function harness(platform, mode = 'confirm') {
  const source = readFileSync(new URL(`../${platform}/pages/order/index.js`, import.meta.url), 'utf8')
  const tree = ts.createSourceFile('index.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const page = tree.statements.find(n => ts.isExpressionStatement(n) && ts.isCallExpression(n.expression) && n.expression.expression.getText(tree) === 'Page').expression.arguments[0]
  const methods = page.properties.filter(n => ['checkoutDraft', 'checkoutDraftMatches', 'submitOrder', 'confirmDuplicateCheckout'].includes(n.name?.getText(tree)))
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
    setData(v) { Object.assign(this.data, v) }, recordOrderTiming() {}, updateCart() {}, async handlePaymentAction() {}, couponCheckoutReady: () => true,
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

// Keep the transport adapter in this contract: page-only mocks used to hide
// missing error.details between the server response and duplicate confirmation.
import { liveMiniHarness } from './miniprogram-live-contract-harness.mjs'
for (const platform of ['miniprogram', 'alipay-miniprogram']) {
  test(`${platform}: actual request and checkout API preserve reviewed conflict through page confirmation`, async () => {
    const h = liveMiniHarness(platform, call => {
      if (!call.data.confirmedDuplicateOrderId) return { status: 409, data: { error: {
        code: 'GUEST_ORDER_DUPLICATE_CONFIRMATION_REQUIRED', message: '重复点单',
        details: { conflictingOrderId: 'original-order-123', conflictingOrderCreatedAt: '2026-10-05T01:00:00Z', unexpected: 'never expose' },
      } } }
      return { status: 201, data: { data: { order: { publicId: 'continued-order' }, payment: { publicId: 'payment' }, sharedCart: {} } } }
    })
    const p = h.page('order', ['checkoutDraft', 'checkoutDraftMatches', 'submitOrder', 'confirmDuplicateCheckout'], {
      alipayOnlinePaymentEnabled: () => true, checkoutRecommendationAttribution: () => null,
      CHECKOUT_ATTEMPT_KEY: 'checkout-attempt', PENDING_PAYMENT_KEY: 'pending-payment', CHECKOUT_REJECTED_BEFORE_ORDER: new Set(),
    })
    const request = { scope: 'table-one' }
    Object.assign(p, { currentTableRequest: () => request, isCurrentTableRequest: () => true, recordOrderTiming() {}, updateCart() {}, async handlePaymentAction() {}, couponCheckoutReady: () => true })
    p.data = { paymentStateReady: true, cartVersion: 1, cartGeneration: 2, busy: false }
    await p.submitOrder(null, false, null, request)
    assert.equal(h.modals.length, 1); assert.match(h.modals[0].content, /er-123/)
    assert.equal(h.calls.length, 2); assert.equal(h.calls[1].data.confirmedDuplicateOrderId, 'original-order-123')
    assert.notEqual(h.calls[0].headers['idempotency-key'], h.calls[1].headers['idempotency-key'])
    assert.equal(p.data.pendingPayment.orderPublicId, 'continued-order')
    assert.equal(h.storage.has('checkout-attempt'), false)
  })
  test(`${platform}: malformed conflict details never authorize continuing an unreviewed order`, async () => {
    for (const details of [null, [], { conflictingOrderId: 'short' }, { conflictingOrderId: 'bad order number' }]) {
      const h = liveMiniHarness(platform, () => ({ status: 409, data: { error: { code: 'GUEST_ORDER_DUPLICATE_CONFIRMATION_REQUIRED', message: '重复点单', details } } }))
      await assert.rejects(h.api.checkoutSharedCart({ expectedGeneration: 2, expectedVersion: 1 }, 'checkout-malformed'), e => e.code === 'GUEST_ORDER_DUPLICATE_CONFIRMATION_REQUIRED' && !e.details)
      assert.equal(h.modals.length, 0)
    }
  })
  test(`${platform}: details whitelist excludes unrelated server fields`, async () => {
    const h = liveMiniHarness(platform, () => ({ status: 409, data: { error: { code: 'GUEST_ORDER_DUPLICATE_CONFIRMATION_REQUIRED', message: '重复点单', details: { conflictingOrderId: 'original-order-123', conflictingOrderCreatedAt: 'bad-time', secret: 'omit' } } } }))
    await assert.rejects(h.api.checkoutSharedCart({ expectedGeneration: 2, expectedVersion: 1 }, 'checkout-whitelist'), e => JSON.stringify(e.details) === JSON.stringify({ conflictingOrderId: 'original-order-123' }))
  })
  test(`${platform}: account restores resolved batch payment without presenting platform payment`, async () => {
    const h = liveMiniHarness(platform, () => ({ data: { data: { status: 'resolved', paymentId: 'payment', paymentPublicId: 'payment-public', terminalPaymentStatus: 'succeeded', presentation: 'jsapi', payload: null } } }))
    const p = h.page('account', ['paySelectedOrders']); p.data = { payingBatch: false, selectedPublicIds: ['order-a'], orders: [] }
    let refreshes = 0; p.loadData = async () => { refreshes++ }
    h.storage.set('mbox.table-batch-attempt:table-one', { ids: ['order-a'], key: 'original-batch-key' })
    await p.paySelectedOrders()
    assert.equal(refreshes, 1); assert.equal(h.nativePayments.length, 0); assert.equal(h.calls[0].headers['idempotency-key'], 'original-batch-key')
    assert.equal(h.storage.has('mbox.table-batch-attempt:table-one'), false)
    assert.equal(p.data.selectedPublicIds.length, 0); assert.match(p.data.success, /已恢复原付款结果/); assert.equal(p.data.error, '')
  })
}
