import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const PENDING_PAYMENT_KEY = 'mbox.pending.guest.payment.v1'
const CHECKOUT_ATTEMPT_KEY = 'mbox.pending.guest.checkout.v1'
const PENDING_GUEST_PAYMENT_ABANDONMENT_KEY = 'mbox.pending.guest.payment.abandon.v1'
function harness(platform, getOrders) {
  const file = new URL(`../${platform}/pages/order/index.js`, import.meta.url)
  const source = readFileSync(file, 'utf8')
  const tree = ts.createSourceFile(file.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const pageNode = tree.statements.find((node) => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(tree) === 'Page').expression.arguments[0]
  const names = ['handlePaymentAction','restoreResolvedPayment','applyOrderPaymentState','refreshOrderPaymentState','loadActiveData']
  const methods = pageNode.properties.filter((node) => names.includes(node.name?.getText(tree)))
  const storage = new Map()
  let orderSource = getOrders
  let nativeCalls = 0, abandonCalls = 0, presents = 0
  const runtime = { getStorageSync: (key) => storage.get(key), setStorageSync: (key,value) => storage.set(key,value), removeStorageSync: (key) => storage.delete(key),
    requestPayment: () => { nativeCalls++ }, tradePay: () => { nativeCalls++ } }
  const actions = vm.runInNewContext(`({${methods.map((node) => node.getText(tree)).join(',')}})`, {
    wx: runtime, runtime, PENDING_PAYMENT_KEY, CHECKOUT_ATTEMPT_KEY, PENDING_GUEST_PAYMENT_ABANDONMENT_KEY,
    tableSessionCacheScope: () => 'original-scope', getTableOrders: () => orderSource(),
    getMenu: async () => [], getSharedCart: async () => ({}), menuProducts: () => [], menuCategoryState: () => ({}), sharedCartView: () => [], menuRecommendations: () => [],
    isPresentableWechatJsapiAction: () => { presents++; return false },
    isPresentableAlipayTradeAction: () => { presents++; return false },
    isRetryableGuestPaymentAbandonment: () => false, randomId: () => 'unused', money: (value) => String(value),
  })
  const request = {}
  const original = { orderPublicId: 'original-order', paymentPublicId: 'original-payment', tableScope: 'original-scope', amountText: '80.00', checkoutKind: 'guest_immediate_payment' }
  const page = { ...actions, data: { pendingPayment: original, checkoutLocked: true },
    currentTableRequest: () => request, isCurrentTableRequest: (value) => value === request,
    setData(value) { Object.assign(this.data,value) },
    showMenuBeforeCart() {}, updateCart() {}, applyFilters() {}, recordOrderTiming() {}, loadOrderExtras() {}, startSharedCartPolling() {}, startServicePolling() {},
    queuePendingGuestPaymentAbandonment: () => { abandonCalls++; return {} },
    executePendingGuestPaymentAbandonment: () => { abandonCalls++ },
  }
  storage.set(PENDING_PAYMENT_KEY, original)
  storage.set(CHECKOUT_ATTEMPT_KEY, { tableScope: original.tableScope })
  storage.set(PENDING_GUEST_PAYMENT_ABANDONMENT_KEY, { tableScope: original.tableScope, orderPublicId: original.orderPublicId })
  return { page, storage, request, async refresh(orders) { orderSource = async () => orders; if (platform === 'miniprogram') page.applyOrderPaymentState(orders); else await page.loadActiveData(request) }, counts: () => ({ nativeCalls, abandonCalls, presents }) }
}

for (const platform of ['miniprogram','alipay-miniprogram']) {
  test(`${platform}: terminal checkout recovery never re-presents or abandons the original payment`, async () => {
    for (const terminalPaymentStatus of ['succeeded','partially_refunded','refunded','failed','closed']) {
      let reads = 0
      const state = harness(platform, async () => { reads++; return [{ publicId: 'original-order', paymentStatus: terminalPaymentStatus === 'succeeded' ? 'paid' : 'unpaid', payableAmountMinor: 0 }] })
      await state.page.handlePaymentAction({ status: 'resolved', terminalPaymentStatus, payload: null })
      assert.equal(reads, 1)
      assert.deepEqual(state.counts(), { nativeCalls: 0, abandonCalls: 0, presents: 0 })
      assert.equal(state.page.data.pendingPayment.orderPublicId, 'original-order')
      assert.equal(state.page.data.pendingPayment.paymentPublicId, 'original-payment')
      assert.equal(state.page.data.pendingPayment.canContinue, false)
      assert.equal(state.page.data.checkoutLocked, false)
      assert.equal(state.storage.has(CHECKOUT_ATTEMPT_KEY), false)
      assert.equal(state.storage.has(PENDING_GUEST_PAYMENT_ABANDONMENT_KEY), false)
      assert.equal(state.page.data.paymentResult.canRetry, false)
      assert.doesNotMatch(state.page.data.paymentResult.copy, /没有发起扣款|重新选购|重新付款/)
      await state.refresh([{ publicId: 'original-order', paymentStatus: 'refunded', payableAmountMinor: 0 }])
      assert.equal(state.page.data.paymentResult.title, '原订单账单已更新')
    }
  })

  test(`${platform}: failed or missing original-order readback retains durable recovery`, async () => {
    for (const getOrders of [async () => { throw new Error('offline') }, async () => [], async () => [{ publicId: 'other-order' }]]) {
      const state = harness(platform,getOrders)
      await state.page.handlePaymentAction({ status: 'resolved', terminalPaymentStatus: 'succeeded', payload: null })
      assert.equal(state.storage.get(PENDING_PAYMENT_KEY).orderPublicId, 'original-order')
      assert.equal(state.storage.get(PENDING_PAYMENT_KEY).paymentPresentationState, 'resolved')
      assert.match(state.page.data.paymentResult.copy, /恢复信息已保留/)
      assert.equal(state.page.data.paymentResult.canRetry, false)
      assert.equal(state.page.data.paymentStateReady, false)
      await state.refresh([])
      assert.equal(state.storage.get(PENDING_PAYMENT_KEY).orderPublicId, 'original-order')
      assert.equal(state.page.data.pendingPayment.canContinue, false)
      assert.deepEqual(state.counts(), { nativeCalls: 0, abandonCalls: 0, presents: 0 })
    }
  })

  test(`${platform}: late recovery response cannot overwrite another table`, async () => {
    let resolve
    const state = harness(platform, () => new Promise((done) => { resolve = done }))
    const result = state.page.handlePaymentAction({ status: 'resolved', terminalPaymentStatus: 'succeeded', payload: null })
    state.page.isCurrentTableRequest = () => false
    state.page.data.paymentResult = { title: 'new-table' }
    resolve([{ publicId: 'original-order', paymentStatus: 'paid', payableAmountMinor: 0 }])
    await result
    assert.equal(state.page.data.paymentResult.title, 'new-table')
  })
}
