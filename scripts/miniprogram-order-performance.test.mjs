import assert from 'node:assert/strict'
import test from 'node:test'
import {createOrderPage, deferred, sleep} from './test-support/order-performance-harness.mjs'

for(const platform of ['miniprogram','alipay-miniprogram']) {
 test(`${platform}: stalled optional content and images do not block menu, adding or authority submit`,async()=>{
  const never=()=>new Promise(()=>{})
  const h=createOrderPage({platform,overrides:{getTodayPerformances:never,getMiniBootstrap:never,getCustomerBenefits:never,getRecommendationConfiguration:never,getWechatNotificationPrompt:never,getAlipayNotificationPrompt:never,getServiceRequests:never}})
  try{
   await Promise.race([h.page.preparePage(),sleep(200).then(()=>{throw Error('core blocked')})])
   assert.equal(h.page.data.orderReady,true);assert.equal(h.page.data.visibleProducts.length,180)
   await h.page.addProduct({currentTarget:{dataset:{id:'p-0'}}})
   assert.equal(h.page.data.cartCount,1);assert.equal(h.page.data.cartTotal,'¥8.00')
   await h.page.submitOrder(null,false)
   assert.equal(h.state.calls.filter(x=>x==='submit').length,1)
  }finally{h.dispose()}
 })
 test(`${platform}: menu is visible before cart but cannot mutate until cart is confirmed`,async()=>{
  const cart=deferred();const h=createOrderPage({platform,overrides:{getSharedCart:()=>cart.promise}})
  try{const load=h.page.preparePage();await sleep(20);assert.equal(h.page.data.loading,false);assert.equal(h.page.data.visibleProducts.length,180);assert.equal(h.page.data.orderReady,false)
   await h.page.addProduct({currentTarget:{dataset:{id:'p-0'}}});assert.equal(h.state.calls.includes('add'),false)
   cart.resolve(h.state.cart);await load;assert.equal(h.page.data.orderReady,true)
  }finally{h.dispose()}
 })
 test(`${platform}: old table menu and optional responses cannot replace a new scan`,async()=>{
  const old=deferred();const optional=deferred();let n=0;const h=createOrderPage({platform,overrides:{getMenu:()=>++n===1?old.promise:Promise.resolve([{productId:'new',name:'新桌商品',amountMinor:800,available:true}]),getTodayPerformances:()=>optional.promise}})
  try{const a=h.page.preparePage();await sleep(10);h.state.session={tableCode:'B02',tableToken:'test-b',cartScope:'scope-b',scanNonce:'scan-b'};await h.page.preparePage();old.resolve([{productId:'old',name:'旧商品'}]);optional.resolve(null);await a;await sleep(5);assert.equal(h.page.data.table.code,'B02');assert.equal(h.page.data.products[0].productId,'new')
  }finally{h.dispose()}
 })
 test(`${platform}: image failures preserve all products, searchable last item, price and valid writes`,async()=>{
  const h=createOrderPage({platform});try{await h.page.preparePage();let event={type:'error',currentTarget:{dataset:{id:'p-0',imageIndex:0,loadGeneration:h.page.data.menuImageGeneration}}};h.page.productImageFailed(event);h.page.productImageFailed(event)
   assert.equal(h.page.data.products.length,180);h.page.onSearchInput({detail:{value:'最后一款'}});assert.equal(h.page.data.visibleProducts.length,1);assert.equal(h.page.data.visibleProducts[0].productId,'p-179')
   await h.page.addProduct({currentTarget:{dataset:{id:'p-179'}}});assert.equal(h.page.data.cartCount,1)
  }finally{h.dispose()}
 })
 test(`${platform}: delayed old-table image errors do not alter the new menu`,async()=>{
  const h=createOrderPage({platform});try{await h.page.preparePage();const old=h.page.data.menuImageGeneration;h.state.session={tableCode:'B02',tableToken:'test-b',cartScope:'scope-b',scanNonce:'scan-b'};await h.page.preparePage();const before=h.page.data.products[0].listImageUrl
   h.page.productImageFailed({type:'error',currentTarget:{dataset:{id:'p-0',imageIndex:0,loadGeneration:old}}});assert.equal(h.page.data.products[0].listImageUrl,before);assert.equal(Boolean(h.page.data.products[0].imageFailed),false)
  }finally{h.dispose()}
 })
 test(`${platform}: failed bill read permits selection but blocks new payment until recovery`,async()=>{
  const h=createOrderPage({platform,overrides:{getTableOrders:async()=>{throw Error('offline')}}});try{await h.page.preparePage();assert.equal(h.page.data.orderReady,true);await h.page.addProduct({currentTarget:{dataset:{id:'p-0'}}});await h.page.submitOrder(null,false);assert.equal(h.state.calls.includes('submit'),false);assert.equal(h.page.data.cartCount,1)
  }finally{h.dispose()}
 })
 test(`${platform}: failed optional module retries alone without reloading cart`,async()=>{
  let calls=0;const h=createOrderPage({platform,overrides:{getTodayPerformances:async()=>{if(!calls++)throw Error('temporary');return null}}});try{await h.page.preparePage();await h.page.orderExtrasPending;assert.ok(h.page.data.performanceError);const cartReads=h.state.calls.filter(x=>x==='cart').length;await h.page.retryPerformance();assert.equal(h.page.data.performanceError,'');assert.equal(h.state.calls.filter(x=>x==='cart').length,cartReads)
  }finally{h.dispose()}
 })
 test(`${platform}: disabled recommendations stay quiet while normal ordering remains usable`,async()=>{
  let calls=0,sends=0;const h=createOrderPage({platform,overrides:{getRecommendationConfiguration:async()=>{calls++;throw Object.assign(new Error('disabled'),{code:'RECOMMENDATION_FEATURE_NOT_ENABLED'})},recommendExperience:async()=>{sends++;return {recommendations:[]}}}})
  try{
   await h.page.preparePage();await h.page.orderExtrasPending
   assert.equal(h.page.recommendationFeatureDisabled,true);assert.equal(Boolean(h.page.orderExtraErrors.recommendation),false)
   await h.page.onRecommend();await h.page.recommend('shake')
   assert.equal(calls,1);assert.equal(sends,0);assert.equal(h.page.data.orderReady,true)
   await h.page.addProduct({currentTarget:{dataset:{id:'p-0'}}});assert.equal(h.page.data.cartCount,1)
  }finally{h.dispose()}
 })
 test(`${platform}: recommendation configuration retries without reloading essential data`,async()=>{
  let n=0;const h=createOrderPage({platform,overrides:{getRecommendationConfiguration:async()=>{if(!n++)throw Error('temporary');return {inputConfiguration:{version:1,questions:[]}}}}});try{await h.page.preparePage();await h.page.orderExtrasPending;assert.equal(h.page.orderExtraErrors.recommendation,true);const reads=h.state.calls.filter(x=>['menu','cart','orders'].includes(x)).length;await h.page.onRecommend();assert.equal(Boolean(h.page.orderExtraErrors.recommendation),false);assert.equal(h.state.calls.filter(x=>['menu','cart','orders'].includes(x)).length,reads)}finally{h.dispose()}
 })
 test(`${platform}: uncompleted first-screen images count as failures without storing identifiers in statistics`,async()=>{
  const h=createOrderPage({platform});try{await h.page.preparePage();h.page.menuDisplayStartedAt=Date.now()-15001;const result=h.page.getOrderPerformance();assert.equal(result.first_screen_image.count,4);assert.equal(result.first_screen_image.failureRate,1);assert.equal(result.first_screen_image.p95Ms,null);assert.equal(h.page.getOrderPerformance().first_screen_image.count,4);assert.doesNotMatch(JSON.stringify(result),/p-0|test-qr|example\.test/)}finally{h.dispose()}
 })
 test(`${platform}: diagnostics are bounded numerical summaries without customer or table identifiers`,()=>{
  const h=createOrderPage({platform});try{for(let i=0;i<100;i++)h.page.recordOrderTiming('add',Date.now(),i%3!==0);h.page.recordOrderTiming('test-private-id',Date.now(),true);const s=h.page.getOrderPerformance();assert.equal(s.add.count,60);assert.equal(s.add.failures,20);assert.deepEqual(Object.keys(s),['add']);assert.doesNotMatch(JSON.stringify(s),/table|customer|test-qr|product/)}finally{h.dispose()}
 })
}

test('Alipay retains its real payment-disabled guard while menu and selection remain available',async()=>{
 const h=createOrderPage({platform:'alipay-miniprogram',alipayPaymentEnabled:false});try{await h.page.preparePage();await h.page.addProduct({currentTarget:{dataset:{id:'p-0'}}});assert.equal(h.page.data.cartCount,1);await h.page.submitOrder(null,false);assert.equal(h.state.calls.includes('submit'),false);assert.match(h.page.data.error,/支付宝在线支付后端适配尚未接通/)}finally{h.dispose()}
})

// Hold the bill promise unresolved: a rejected request alone cannot reproduce SYS-211.
async function prepareWechatWithoutBill(h) {
  await Promise.race([
    h.page.preparePage(),
    sleep(200).then(() => { throw new Error('selection is still waiting for the table bill') }),
  ])
}
const addFirstProduct = h => h.page.addProduct({ currentTarget: { dataset: { id: 'p-0' } } })
const paymentKey = 'mbox.pending.guest.payment.v1'
const checkoutKey = 'mbox.pending.guest.checkout.v1'
const paymentScope = h => `${h.state.session.tableToken}:${h.state.session.cartScope}`
const pendingOrder = (publicId, extra = {}) => ({
  publicId, isMine: true, channel: 'guest_qr', payableAmountMinor: 800,
  paymentStatus: 'pending', paymentAccess: 'status_review', ...extra,
})

test('WeChat SYS-211: slow bill permits adding; concurrent submit reuses the read and sends one checkout', async () => {
  const bill = deferred()
  const checkout = deferred()
  let reads = 0
  const h = createOrderPage({ overrides: {
    getTableOrders: () => { reads++; return bill.promise },
    checkoutSharedCart: async () => { h.state.calls.push('submit'); return checkout.promise },
  } })
  try {
    await prepareWechatWithoutBill(h)
    assert.equal(h.page.data.orderReady, true)
    assert.equal(h.page.data.paymentStateReady, false)
    await addFirstProduct(h)
    assert.equal(h.page.data.cartCount, 1)
    const first = h.page.submitOrder(null, false)
    const second = h.page.submitOrder(null, false)
    await sleep(0)
    assert.equal(reads, 1)
    assert.equal(h.state.calls.includes('submit'), false)
    bill.resolve([])
    await sleep(0)
    assert.equal(h.state.calls.filter(x => x === 'submit').length, 1)
    checkout.resolve({ data: { order: { publicId: 'new-checkout' }, settlement: { payableAmountMinor: 800 }, sharedCart: { generation: 2, version: 0, lines: [] } } })
    await Promise.all([first, second])
    assert.equal(h.state.calls.filter(x => x === 'submit').length, 1)
  } finally { h.dispose() }
})

test('WeChat SYS-211: delayed bill failure preserves cart and checkout retries after payment recovery', async () => {
  const bill = deferred()
  let recovered = false
  const h = createOrderPage({ overrides: { getTableOrders: () => recovered ? Promise.resolve([]) : bill.promise } })
  try {
    await prepareWechatWithoutBill(h)
    await addFirstProduct(h)
    const submit = h.page.submitOrder(null, false)
    bill.reject(new Error('timeout'))
    await submit
    assert.equal(h.page.data.paymentStateReady, false)
    assert.equal(h.page.data.cartCount, 1)
    assert.equal(h.state.calls.includes('submit'), false)
    assert.match(h.page.data.error, /付款状态暂未确认/)
    recovered = true
    await h.page.submitOrder(null, false)
    assert.equal(h.state.calls.filter(x => x === 'submit').length, 1)
  } finally { h.dispose() }
})

for (const reload of ['new table', 'same table']) {
  test(`WeChat SYS-211: late bill from ${reload} reload cannot overwrite current payment or cart`, async () => {
    const oldBill = deferred()
    let reads = 0
    const h = createOrderPage({ overrides: { getTableOrders: () => ++reads === 1 ? oldBill.promise : Promise.resolve([pendingOrder('current-order')]) } })
    try {
      await prepareWechatWithoutBill(h)
      const oldRead = h.page.orderPaymentRead.promise
      if (reload === 'new table') h.state.session = { tableCode: 'B02', tableToken: 'test-b', cartScope: 'scope-b', scanNonce: 'scan-b' }
      await h.page.preparePage()
      if (h.page.orderPaymentRead) await h.page.orderPaymentRead.promise
      await addFirstProduct(h)
      oldBill.resolve([pendingOrder('old-order')])
      await oldRead
      assert.equal(h.page.data.pendingPayment.orderPublicId, 'current-order')
      assert.equal(h.page.data.cartCount, 1)
      assert.equal(h.page.data.paymentStateReady, true)
    } finally { h.dispose() }
  })
}

test('WeChat SYS-211: a confirmed old bill does not authorize checkout during a new table load', async () => {
  const bill = deferred()
  let reads = 0
  const h = createOrderPage({ overrides: { getTableOrders: () => ++reads === 1 ? Promise.resolve([]) : bill.promise } })
  try {
    await h.page.preparePage()
    if (h.page.orderPaymentRead) await h.page.orderPaymentRead.promise
    assert.equal(h.page.data.paymentStateReady, true)
    h.state.session = { tableCode: 'B02', tableToken: 'test-b', cartScope: 'scope-b', scanNonce: 'scan-b' }
    await prepareWechatWithoutBill(h)
    assert.equal(h.page.data.paymentStateReady, false)
    await addFirstProduct(h)
    const submit = h.page.submitOrder(null, false)
    await sleep(0)
    assert.equal(h.state.calls.includes('submit'), false)
    bill.reject(new Error('timeout'))
    await submit
    assert.equal(h.state.calls.includes('submit'), false)
  } finally { h.dispose() }
})

for (const access of ['payment_in_progress', 'status_review']) {
  test(`WeChat SYS-211: delayed ${access} restores own payment without losing new cart items`, async () => {
    const bill = deferred()
    const h = createOrderPage({ overrides: { getTableOrders: () => bill.promise } })
    try {
      const stored = { orderPublicId: 'own-order', tableScope: paymentScope(h), amountText: '¥8.00', paymentPresentationState: 'result_unknown' }
      h.state.storage.set(paymentKey, stored)
      await prepareWechatWithoutBill(h)
      const read = h.page.orderPaymentRead.promise
      assert.equal(h.state.storage.get(paymentKey), stored)
      assert.equal(h.page.data.pendingPayment.canContinue, false)
      await addFirstProduct(h)
      bill.resolve([pendingOrder('neighbor-order', { isMine: false }), pendingOrder('own-order', { paymentAccess: access })])
      await read
      assert.equal(h.page.data.pendingPayment.orderPublicId, 'own-order')
      assert.equal(h.page.data.pendingPayment.canContinue, false)
      assert.equal(h.page.data.cartCount, 1)
      assert.equal(h.page.data.cartVersion, 1)
    } finally { h.dispose() }
  })
}

test('WeChat SYS-211: delayed paid result clears recovery only after confirmation and retains selection', async () => {
  const bill = deferred()
  const h = createOrderPage({ overrides: { getTableOrders: () => bill.promise } })
  try {
    h.state.storage.set(paymentKey, { orderPublicId: 'paid-order', tableScope: paymentScope(h), amountText: '¥8.00' })
    await prepareWechatWithoutBill(h)
    const read = h.page.orderPaymentRead.promise
    assert.ok(h.state.storage.has(paymentKey))
    await addFirstProduct(h)
    bill.resolve([pendingOrder('paid-order', { paymentStatus: 'paid', paymentAccess: 'not_required', payableAmountMinor: 0 })])
    await read
    assert.equal(h.state.storage.has(paymentKey), false)
    assert.equal(h.page.data.pendingPayment, null)
    assert.equal(h.page.data.paymentResult.kind, 'success')
    assert.equal(h.page.data.cartCount, 1)
  } finally { h.dispose() }
})

test('WeChat SYS-211: checkout recovery keeps its idempotency key and a late empty bill cannot erase the new payment', async () => {
  const bill = deferred()
  const keys = []
  const h = createOrderPage({ overrides: {
    getTableOrders: () => bill.promise,
    checkoutSharedCart: async (_input, key) => {
      keys.push(key)
      return { data: { order: { publicId: 'test-order' }, settlement: { payableAmountMinor: 800 }, sharedCart: { generation: 2, version: 0, lines: [] } } }
    },
  } })
  try {
    const attempt = { expectedGeneration: 1, expectedVersion: 0, tableScope: paymentScope(h), idempotencyKey: 'original-checkout-attempt' }
    h.state.storage.set(checkoutKey, attempt)
    await prepareWechatWithoutBill(h)
    const read = h.page.orderPaymentRead.promise
    assert.equal(h.page.data.checkoutLocked, true)
    await h.page.retryCheckout()
    assert.deepEqual(keys, ['original-checkout-attempt'])
    const pending = h.state.storage.get(paymentKey)
    assert.equal(pending.orderPublicId, 'test-order')
    bill.resolve([])
    await read
    assert.equal(h.state.storage.get(paymentKey), pending)
    assert.equal(h.page.data.pendingPayment.orderPublicId, 'test-order')
  } finally { h.dispose() }
})

test('WeChat SYS-211: frozen cart remains read only while bill is pending', async () => {
  const bill = deferred()
  const h = createOrderPage({ overrides: { getTableOrders: () => bill.promise } })
  h.state.cart.guestWritesFrozen = true
  try {
    await prepareWechatWithoutBill(h)
    await addFirstProduct(h)
    assert.equal(h.page.data.cartWritesFrozen, true)
    assert.equal(h.state.calls.includes('add'), false)
  } finally { h.dispose() }
})

test('WeChat SYS-211: a failed cart read cannot be unlocked by a successful bill', async () => {
  const bill = deferred()
  const h = createOrderPage({ overrides: { getTableOrders: () => bill.promise, getSharedCart: async () => { throw new Error('cart unavailable') } } })
  try {
    await h.page.preparePage()
    bill.resolve([])
    await sleep(0)
    await addFirstProduct(h)
    assert.equal(h.page.data.orderReady, false)
    assert.equal(h.state.calls.includes('add'), false)
  } finally { h.dispose() }
})

test('WeChat SYS-211: leaving the page discards a late bill response', async () => {
  const bill = deferred()
  const h = createOrderPage({ overrides: { getTableOrders: () => bill.promise } })
  try {
    await prepareWechatWithoutBill(h)
    const read = h.page.orderPaymentRead.promise
    h.page.onHide()
    bill.resolve([pendingOrder('hidden-page-order')])
    await read
    assert.equal(h.page.data.paymentStateReady, false)
    assert.equal(h.page.data.pendingPayment, null)
  } finally { h.dispose() }
})
