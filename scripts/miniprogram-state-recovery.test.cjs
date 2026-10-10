const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const { fixture, deferred, cart, ROOT } = require('./miniprogram-state-fixture.cjs')
const tick = () => new Promise(resolve => setImmediate(resolve))
const conflict = () => Object.assign(new Error('conflict'), { code: 'SHARED_CART_VERSION_CONFLICT' })
const checkoutKey = 'mbox.pending.guest.checkout.v1'
const paymentKey = 'mbox.pending.guest.payment.v1'
const abandonmentKey = 'mbox.pending.guest.payment.abandon.v1'
const secondTable = { tableCode: 'W21', tableToken: 'test-w21', cartScope: 'turn-w21' }

for (const platform of ['miniprogram', 'alipay-miniprogram']) {
  const setup = (page, api) => fixture(page, api, platform)
  const check = (name, fn) => test(`${platform}: ${name}`, { timeout: 5000 }, fn)

  check('01 unchanged confirmation preserves notes/quote and double click sends only once', async () => {
    const post = deferred(), calls = []
    const { page } = setup('order', { checkoutSharedCart: (body, key) => { calls.push({ body, key }); return post.promise } })
    page.checkoutLineNotes = { 'portion-1': '少冰' }
    page.setData({ checkoutConfirmVisible: true, checkoutNote: '一起上', couponSelections: [{ portionId: 'portion-1', benefitId: 'coupon-1' }],
      couponQuote: { id: 'quote-1', generation: 1, version: 1, expiresAt: new Date(Date.now() + 60000).toISOString() } })
    const first = page.confirmCheckout(), second = page.confirmCheckout()
    await tick()
    assert.equal(calls.length, 1)
    assert.equal(calls[0].body.note, '一起上')
    assert.equal(calls[0].body.lineNotes[0].note, '少冰')
    assert.equal(calls[0].body.couponQuoteId, 'quote-1')
    post.reject(Object.assign(Error('unavailable'), { code: 'PRODUCT_UNAVAILABLE' }))
    await Promise.all([first, second])
    assert.equal(page.data.busy, false)
  })

  check('01 unavailable bill leaves cart reviewable and no persisted checkout', async () => {
    const { page, state } = setup('order', { getTableOrders: async () => { throw Error('offline') } })
    page.setData({ checkoutConfirmVisible: true, paymentStateReady: false })
    await page.confirmCheckout()
    assert.equal(page.data.busy, false)
    assert.equal(page.data.checkoutLocked, false)
    assert.equal(page.data.cart.length, 1)
    assert.equal(state.storage.has(checkoutKey), false)
    assert.equal(state.calls.length, 0)
  })

  check('07 an empty new cart still exposes and replays an unknown original checkout', async () => {
    const calls = []
    const { page, state, session } = setup('order', { checkoutSharedCart: async (body, key) => {
      calls.push({ body, key }); throw Object.assign(Error('unavailable'), { code: 'PRODUCT_UNAVAILABLE' })
    } })
    state.storage.set(checkoutKey, { expectedGeneration: 1, expectedVersion: 1, tableScope: session.tableSessionCacheScope(), idempotencyKey: 'original-key' })
    page.updateCart([], { ...cart(0, 2), lines: [], totalAmountMinor: 0 })
    page.setData({ checkoutLocked: true, cartWritesFrozen: true })
    const markup = fs.readFileSync(path.join(ROOT, platform, 'pages/order/index.' + (platform === 'miniprogram' ? 'wxml' : 'axml')), 'utf8')
    const expression = markup.match(/(?:wx|a):if="\{\{([^\n]*?)\}\}" class="cart-dock"/)[1]
    assert.equal(Function('connectionState', 'cart', 'checkoutLocked', `return Boolean(${expression})`)('active', [], true), true)
    await page.openCheckout()
    assert.equal(calls.length, 1)
    assert.equal(calls[0].key, 'original-key')
    assert.equal(calls[0].body.expectedGeneration, 1)
  })

  check('02 late checkout finally does not unlock a new table checkout', async () => {
    const old = deferred(), fresh = deferred()
    let calls = 0
    const { page, state } = setup('order', { checkoutSharedCart: () => (++calls === 1 ? old : fresh).promise })
    const first = page.submitOrder(null, false)
    state.session = secondTable
    await page.preparePage()
    const second = page.submitOrder(null, false)
    assert.equal(calls, 2)
    const original = state.storage.get(checkoutKey)
    old.reject(Error('offline'))
    await first
    assert.equal(page.data.busy, true)
    assert.equal(state.storage.get(checkoutKey), original)
    fresh.reject(Error('offline'))
    await second
    assert.equal(page.data.busy, false)
  })

  for (const outcome of ['success', 'cancel']) for (const destination of ['new-table', 'same-table', 'storage-only']) {
    check(`08 native payment callback cannot overwrite another order (${outcome}, ${destination})`, async () => {
      const { page, state, session } = setup('order')
      page.offerOrderNotifications = async () => {}
      page.confirmPaymentOutcome = async () => {}
      const firstPayment = { orderPublicId: 'first-order', tableScope: session.tableSessionCacheScope(), retryIdempotencyKey: 'first-key' }
      page.setData({ pendingPayment: firstPayment })
      const action = platform === 'miniprogram'
        ? { status: 'pending', presentation: 'jsapi', payload: { timeStamp: '1', nonceStr: 'n', package: 'p', signType: 'RSA', paySign: 'test' } }
        : { status: 'pending', presentation: 'trade_pay', payload: { tradeNO: 'trade-test' } }
      const pending = page.handlePaymentAction(action, page.currentTableRequest())
      assert.ok(state.payment)
      page.onHide()
      assert.equal(state.storage.has(abandonmentKey), false)
      if (destination === 'new-table') {
        state.session = secondTable
        await page.preparePage()
      }
      const newPayment = { orderPublicId: 'next-order', tableScope: session.tableSessionCacheScope(), retryIdempotencyKey: 'next-key' }
      if (destination !== 'storage-only') page.setData({ pendingPayment: newPayment })
      const displayedPayment = page.data.pendingPayment
      state.storage.set(paymentKey, newPayment)
      if (outcome === 'success') state.payment.success({})
      else state.payment.fail({ errMsg: 'requestPayment:fail cancel' })
      await pending
      assert.equal(state.storage.get(paymentKey), newPayment)
      assert.equal(page.data.pendingPayment, displayedPayment)
      assert.equal(state.storage.has(abandonmentKey), false)
    })
  }

  check('02 old recommendation completion cannot unlock a new recommendation', async () => {
    const old = deferred(), fresh = deferred()
    let calls = 0
    const { page, state } = setup('order', { recommendExperience: () => (++calls === 1 ? old : fresh).promise })
    const first = page.recommend('guided')
    state.session = secondTable
    await page.preparePage()
    const second = page.recommend('guided')
    assert.equal(calls, 2)
    old.resolve({ recommendations: [] })
    await first
    assert.equal(page.data.recommendationBusy, true)
    fresh.resolve({ recommendations: [] })
    await second
    assert.equal(page.data.recommendationBusy, false)
  })

  check('02 old upgrade completion cannot unlock a new checkout', async () => {
    const old = deferred(), fresh = deferred()
    const { page, state } = setup('order', { decideSharedCartUpgrade: () => old.promise, checkoutSharedCart: () => fresh.promise })
    page.setData({ checkoutConfirmVisible: true, checkoutUpgrade: {
      id: 'upgrade-1', variants: [], sourcePortionId: 'portion-1', expiresAt: new Date(Date.now() + 60000).toISOString(),
    } })
    const first = page.acceptCheckoutUpgrade()
    state.session = secondTable
    await page.preparePage()
    const second = page.submitOrder(null, false)
    old.resolve({ opportunity: { status: 'accepted' } })
    await first
    assert.equal(page.data.busy, true)
    fresh.reject(Error('offline'))
    await second
    assert.equal(page.data.busy, false)
  })

  check('03 poll started before a checkout cannot change its locked cart', async () => {
    const read = deferred(), post = deferred()
    const { page } = setup('order', { getSharedCart: () => read.promise, checkoutSharedCart: () => post.promise })
    const poll = page.refreshSharedCart(true)
    const checkout = page.submitOrder(null, false)
    read.resolve(cart(2))
    await poll
    assert.equal(page.data.cartVersion, 1)
    post.reject(Error('unknown'))
    await checkout
    assert.equal(page.data.checkoutLocked, true)
  })

  check('03 a new table accepts its own lower revision', async () => {
    const { page, state } = setup('order')
    page.updateCart(cart(90, 5).lines, cart(90, 5))
    state.session = secondTable
    await page.preparePage()
    assert.equal(page.data.cartGeneration, 1)
    assert.equal(page.data.cartVersion, 1)
  })

  check('04 a poll started before conflict cannot lift the failed-refresh restriction', async () => {
    const old = deferred()
    let reads = 0
    const { page, api } = setup('order', { getSharedCart: () => ++reads === 1 ? old.promise : Promise.reject(Error('offline')),
      adjustSharedCart: async () => { throw conflict() } })
    const poll = page.refreshSharedCart(true)
    await page.adjustSharedCart('p1', 1)
    assert.equal(page.data.orderReady, false)
    old.resolve(cart(1))
    await poll
    assert.equal(page.data.orderReady, false)
    api.getSharedCart = async () => cart(2)
    await page.refreshSharedCart(true)
    assert.equal(page.data.orderReady, true)
  })

  check('04 failed checkout-conflict refresh recovers through the next successful poll', async () => {
    const { page, api } = setup('order', { checkoutSharedCart: async () => { throw conflict() },
      getSharedCart: async () => { throw Error('offline') } })
    await page.submitOrder(null, false)
    assert.equal(page.data.orderReady, false)
    assert.equal(page.data.checkoutLocked, false)
    api.getSharedCart = async () => cart(2)
    await page.refreshSharedCart(true)
    assert.equal(page.data.orderReady, true)
    assert.equal(page.data.busy, false)
  })

  for (const outcome of ['GUEST_CHECKOUT_NOT_FOUND', 'cancelled', 'NETWORK_ERROR']) {
    check(`05 matching abandonment clears only known terminal results (${outcome})`, async () => {
      const { page, state, session } = setup('account', { abandonGuestCheckout: async () => {
        if (outcome === 'cancelled') return { operationalState: 'cancelled' }
        throw Object.assign(Error('terminal'), { code: outcome })
      } })
      const record = { orderPublicId: 'original', tableScope: session.tableSessionCacheScope(), idempotencyKey: 'original-key' }
      state.storage.set(paymentKey, record)
      state.storage.set(abandonmentKey, record)
      await page.executePendingGuestPaymentAbandonment(record)
      assert.equal(state.storage.has(paymentKey), outcome === 'NETWORK_ERROR')
      assert.equal(state.storage.has(abandonmentKey), outcome === 'NETWORK_ERROR')
    })
  }

  check('01 final confirmation never submits a cart changed during the bill read', async () => {
    const bill = deferred()
    const { page, state } = setup('order', { getTableOrders: () => bill.promise, getSharedCart: async () => cart(2) })
    page.setData({ paymentStateReady: false, checkoutConfirmVisible: true })
    const pending = page.confirmCheckout()
    await tick()
    await page.refreshSharedCart(true)
    bill.resolve([])
    await pending
    assert.equal(state.calls.length, 0)
    assert.equal(page.data.busy, false)
    assert.equal(page.data.checkoutConfirmVisible, true)
    assert.match(page.data.error, /核对|确认/)
    assert.equal(state.storage.has(checkoutKey), false)
  })

  check('01 final click snapshots before any asynchronous prerequisite', async () => {
    const ready = deferred()
    const { page, state } = setup('order')
    page.setData({ checkoutConfirmVisible: true })
    page.checkoutUpgradeReady = () => ready.promise
    const pending = page.confirmCheckout()
    page.updateCart(cart(2).lines, cart(2))
    ready.resolve(true)
    await pending
    assert.equal(state.calls.length, 0)
    assert.equal(page.data.busy, false)
  })

  for (const outcome of ['NETWORK_ERROR', 'PRODUCT_UNAVAILABLE', 'success']) {
    check(`02 checkout hide/return releases busy and replays the original attempt (${outcome})`, async () => {
      const post = deferred()
      const calls = []
      const { page, state, api } = setup('order', { checkoutSharedCart: (body, key) => { calls.push({ body, key }); return post.promise } })
      const pending = page.submitOrder(null, false, null, page.currentTableRequest())
      const original = state.storage.get(checkoutKey)
      page.onHide()
      await page.preparePage()
      if (outcome === 'success') post.resolve({ order: { publicId: 'original-order' }, payment: {} })
      else post.reject(Object.assign(new Error('transport'), { code: outcome }))
      await pending
      assert.equal(page.data.busy, false)
      assert.equal(page.data.checkoutLocked, true)
      assert.equal(state.storage.get(checkoutKey).idempotencyKey, original.idempotencyKey)
      api.checkoutSharedCart = async (body, key) => {
        calls.push({ body, key })
        throw Object.assign(new Error('definite rejection'), { code: 'PRODUCT_UNAVAILABLE' })
      }
      await page.openCheckout()
      assert.equal(calls.length, 2)
      assert.deepEqual(calls[1], calls[0])
      assert.equal(page.data.busy, false)
      assert.equal(page.data.checkoutLocked, false)
    })
  }

  check('02 upgrade hide/return releases busy but still requires actual cart review', async () => {
    const post = deferred()
    const { page } = setup('order', { decideSharedCartUpgrade: () => post.promise })
    page.setData({ checkoutConfirmVisible: true, checkoutUpgrade: {
      id: 'upgrade-1', variants: [], sourcePortionId: 'portion-1', expiresAt: new Date(Date.now() + 60000).toISOString(),
    } })
    const pending = page.acceptCheckoutUpgrade()
    page.onHide()
    await page.preparePage()
    post.resolve({ opportunity: { status: 'accepted', replacementPortionId: 'replacement-1' } })
    await pending
    assert.equal(page.data.busy, false)
    assert.equal(page.data.checkoutUpgradeNeedsRefresh, true)
    assert.equal(await page.checkoutUpgradeReady(), false)
    assert.equal(page.data.checkoutUpgradeNeedsRefresh, false)
  })

  check('02 recommendation hide/return can request again', async () => {
    const post = deferred()
    const { page, api } = setup('order', { recommendExperience: () => post.promise })
    const pending = page.recommend('guided')
    page.onHide()
    await page.preparePage()
    post.resolve({ recommendations: [] })
    await pending
    assert.equal(page.data.recommendationBusy, false)
    let calls = 0
    api.recommendExperience = async () => { calls++; return { recommendations: [] } }
    await page.recommend('guided')
    assert.equal(calls, 1)
  })

  check('03 old poll cannot undo a cart write', async () => {
    const read = deferred()
    const { page } = setup('order', { getSharedCart: () => read.promise, adjustSharedCart: async () => cart(2) })
    const pending = page.refreshSharedCart(true)
    await page.adjustSharedCart('p1', 1)
    assert.equal(page.data.cartVersion, 2)
    read.resolve(cart(1))
    await pending
    assert.equal(page.data.cartVersion, 2)
  })

  check('03 old poll cannot repopulate a submitted cart', async () => {
    const read = deferred()
    const { page } = setup('order', { getSharedCart: () => read.promise, checkoutSharedCart: async () => ({
      order: { publicId: 'new-order' }, sharedCart: { generation: 2, version: 0, lines: [], totalAmountMinor: 0 },
      settlement: { payableAmountMinor: 100 }, payment: { providerAction: { status: 'pending' } },
    }) })
    const pending = page.refreshSharedCart(true)
    await page.submitOrder(null, false, null, page.currentTableRequest())
    read.resolve(cart(1, 1))
    await pending
    assert.equal(page.data.cartGeneration, 2)
    assert.equal(page.data.cart.length, 0)
  })

  for (const operation of ['adjust', 'clear', 'remove', 'replace']) {
    check(`04 failed conflict refresh disables stale checkout and later recovers (${operation})`, async () => {
      const { page, api } = setup('order', { getSharedCart: async () => { throw Error('offline') },
        adjustSharedCart: async () => { throw conflict() }, clearSharedCart: async () => { throw conflict() },
        removeSharedCartLine: async () => { throw conflict() }, replaceSharedCartBundleSelection: async () => { throw conflict() },
      })
      if (operation === 'adjust') await page.adjustSharedCart('p1', 1)
      if (operation === 'clear') await page.clearCart()
      if (operation === 'remove') await page.removeCartLine({ currentTarget: { dataset: { id: 'p1' } } })
      if (operation === 'replace') await page.replaceBundleUnitSelection('p1', 0, { groups: [] })
      assert.doesNotMatch(page.data.error, /已为你刷新/)
      assert.equal(page.data.orderReady, false)
      assert.equal(page.data.cartVersion, 1)
      assert.equal(page.data.cartSyncing, false)
      api.getSharedCart = async () => cart(2)
      assert.equal(await page.refreshSharedCart(true), true)
      assert.equal(page.data.orderReady, true)
      assert.equal(page.data.cartVersion, 2)
    })
  }

  check('04 late conflict message cannot overwrite another table', async () => {
    const read = deferred()
    const { page, state } = setup('order', { adjustSharedCart: async () => { throw conflict() }, getSharedCart: () => read.promise })
    const pending = page.adjustSharedCart('p1', 1)
    await tick()
    state.session = secondTable
    page.beginTableRequest()
    page.setData({ error: 'new-table-message' })
    read.resolve(cart(1))
    await pending
    assert.equal(page.data.error, 'new-table-message')
  })

  for (const differentTable of [false, true]) {
    for (const outcome of ['GUEST_CHECKOUT_NOT_FOUND', 'GUEST_CHECKOUT_ALREADY_PAID', 'GUEST_ORDER_ACCESS_FORBIDDEN', 'cancelled']) {
      check(`05 old abandonment preserves new recovery records (${differentTable ? 'new' : 'same'} table, ${outcome})`, async () => {
        const post = deferred()
        const { page, state, session } = setup('account', { abandonGuestCheckout: () => post.promise })
        const pending = page.executePendingGuestPaymentAbandonment({ orderPublicId: 'old-order', idempotencyKey: 'old-key', tableScope: session.tableSessionCacheScope() })
        if (differentTable) state.session = secondTable
        const payment = { orderPublicId: 'new-order', tableScope: session.tableSessionCacheScope() }
        const abandonment = { ...payment, idempotencyKey: 'new-key' }
        state.storage.set(paymentKey, payment)
        state.storage.set(abandonmentKey, abandonment)
        if (outcome === 'cancelled') post.resolve({ operationalState: 'cancelled' })
        else post.reject(Object.assign(Error('terminal'), { code: outcome }))
        await pending
        assert.equal(state.storage.get(paymentKey), payment)
        assert.equal(state.storage.get(abandonmentKey), abandonment)
      })
    }
  }

  check('06 table switch releases batch display lock and preserves original attempt', async () => {
    const post = deferred()
    const { page, state, session } = setup('account', { payTableOrders: () => post.promise })
    page.onLoad({})
    await page.loadData()
    page.setData({ selectedPublicIds: ['old-order'] })
    const key = 'mbox.table-batch-attempt:' + session.tableSessionCacheScope()
    const pending = page.paySelectedOrders()
    const attempt = state.storage.get(key)
    state.session = secondTable
    await page.loadData()
    assert.equal(page.data.payingBatch, false)
    post.resolve({ status: 'resolved' })
    await pending
    assert.equal(page.data.payingBatch, false)
    assert.equal(state.storage.get(key), attempt)
  })

  check('06 late batch response cannot unlock or clear a new payment after A-B-A', async () => {
    const old = deferred(), fresh = deferred()
    let calls = 0
    const { page, state, session } = setup('account', { payTableOrders: () => (++calls === 1 ? old : fresh).promise })
    const firstTable = state.session
    page.onLoad({})
    await page.loadData()
    page.setData({ selectedPublicIds: ['old-order'] })
    const pending = page.paySelectedOrders()
    state.session = secondTable
    await page.loadData()
    state.session = firstTable
    await page.loadData()
    page.setData({ selectedPublicIds: ['new-order'] })
    const current = page.paySelectedOrders()
    assert.equal(calls, 2)
    const key = 'mbox.table-batch-attempt:' + session.tableSessionCacheScope()
    const attempt = state.storage.get(key)
    old.resolve({ status: 'resolved' })
    await pending
    assert.equal(page.data.payingBatch, true)
    assert.equal(state.storage.get(key), attempt)
    fresh.reject(Error('offline'))
    await current
    assert.equal(page.data.payingBatch, false)
  })
}
