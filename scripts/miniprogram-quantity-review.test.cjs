const assert = require('node:assert/strict')
const test = require('node:test')
const { fixture, cart, deferred } = require('./miniprogram-state-fixture.cjs')
const tick = () => new Promise(resolve => setImmediate(resolve))
const line = (id, quantity, name = id) => ({ productId: id, name, quantity, available: true, portionIds: [], unitPriceMinor: 100, subtotalAmountMinor: quantity * 100 })
for (const platform of ['miniprogram', 'alipay-miniprogram']) {
  function setup(lines, response) {
    const calls = []
    const h = fixture('order', { checkoutSharedCart: async (input, key) => {
      calls.push({ input, key })
      if (response) return response(input, key)
      return { data: { order: { publicId: 'TEST-ORDER' }, payment: null, settlement: { payableAmountMinor: 100 }, sharedCart: { ...cart(0, 2), lines: [] } } }
    } }, platform)
    h.page.checkoutUpgradeReady = async () => true
    h.page.handlePaymentAction = async () => {}
    h.page.updateCart(lines, { ...cart(1), lines })
    h.page.setData({ checkoutConfirmVisible: true })
    return { ...h, calls }
  }
  test(`${platform}: aggregates all repeated products; yes submits once with the reviewed version`, { timeout: 2000 }, async () => {
    const h = setup([line('p1', 2, '啤酒'), line('p2', 1, '薯条'), line('p2', 2, '薯条'), line('p3', 1)])
    const pending = h.page.confirmCheckout()
    await tick()
    assert.equal(h.calls.length, 0)
    assert.deepEqual(JSON.parse(JSON.stringify(h.page.data.quantityReviewLines)), [{ productId: 'p1', name: '啤酒', quantity: 2 }, { productId: 'p2', name: '薯条', quantity: 3 }])
    await h.page.confirmCheckout()
    h.page.confirmRepeatedQuantities(); h.page.confirmRepeatedQuantities()
    await pending
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0].input.expectedVersion, 1)
    assert.equal(h.page.data.quantityReviewVisible, false)
    assert.equal(h.page.data.cart.length, 0)
    assert.equal(h.page.data.busy, false)
  })
  test(`${platform}: no leaves the cart and quantities untouched and permits a later review`, { timeout: 2000 }, async () => {
    const h = setup([line('p1', 3)])
    const before = JSON.stringify(h.page.data.cart)
    const pending = h.page.confirmCheckout(); await tick(); h.page.cancelRepeatedQuantities(); await pending
    assert.equal(h.calls.length, 0)
    assert.equal(JSON.stringify(h.page.data.cart), before)
    assert.equal(h.page.data.checkoutConfirmVisible, true)
    assert.equal(h.page.data.busy, false)
    const second = h.page.confirmCheckout(); await tick()
    assert.equal(h.page.data.quantityReviewVisible, true)
    h.page.cancelRepeatedQuantities(); await second
  })
  test(`${platform}: one each and equal names with different product IDs do not prompt`, async () => {
    const h = setup([line('p1', 1, '同名'), line('p2', 1, '同名')])
    await h.page.confirmCheckout()
    assert.equal(h.calls.length, 1)
    assert.equal(h.page.data.quantityReviewVisible, false)
  })
  for (const change of ['version', 'generation', 'note', 'frozen', 'table', 'hide']) {
    test(`${platform}: ${change} while reviewing cannot submit the old confirmation`, { timeout: 2000 }, async () => {
      const h = setup([line('p1', 2)])
      const pending = h.page.confirmCheckout(); await tick()
      if (change === 'version') h.page.data.cartVersion++
      if (change === 'generation') h.page.data.cartGeneration++
      if (change === 'note') h.page.data.checkoutNote = '新备注'
      if (change === 'frozen') h.page.data.cartWritesFrozen = true
      if (change === 'table') { h.state.session.tableToken = 'new-table'; h.page.beginTableRequest() }
      if (change === 'hide') h.page.onHide()
      h.page.confirmRepeatedQuantities(); await pending
      assert.equal(h.calls.length, 0)
      assert.equal(h.page.data.busy, false)
      assert.equal(h.page.data.quantityReviewVisible, false)
    })
  }
  test(`${platform}: a long list is complete and a failed submit never claims success`, { timeout: 2000 }, async () => {
    const h = setup(Array.from({length: 60}, (_, i) => line(`p${i}`, i + 2)), () => { throw Object.assign(new Error('不可售'), { code: 'PRODUCT_UNAVAILABLE' }) })
    const pending = h.page.confirmCheckout(); await tick()
    assert.equal(h.page.data.quantityReviewLines.length, 60)
    assert.equal(h.page.data.quantityReviewLines[59].quantity, 61)
    h.page.confirmRepeatedQuantities(); await pending
    assert.equal(h.calls.length, 1)
    assert.equal(h.page.data.cart.length, 60)
    assert.ok(!h.page.data.success)
    assert.ok(h.page.data.error)
  })
  test(`${platform}: a stalled transport cannot create a second submit`, { timeout: 2000 }, async () => {
    const response = deferred()
    const h = setup([line('p1', 2)], () => response.promise)
    const pending = h.page.confirmCheckout(); await tick(); h.page.confirmRepeatedQuantities(); await tick()
    await h.page.confirmCheckout(); h.page.confirmRepeatedQuantities()
    assert.equal(h.calls.length, 1)
    response.reject(Object.assign(new Error('offline'), { code: 'NETWORK_ERROR' })); await pending
    assert.equal(h.page.data.checkoutLocked, true)
  })
}
