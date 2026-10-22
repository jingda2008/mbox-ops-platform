import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'
import vm from 'node:vm'
import {loadMiniModule} from './load-miniprogram-test-module.mjs'
for(const platform of ['miniprogram','alipay-miniprogram']){
  function fixture(){
    const utils=loadMiniModule(new URL(`../${platform}/utils/checkout-coupons.js`,import.meta.url))
    let identity='table-a';const calls=[]
    const coupon={id:'coupon',state:'available',quantityAvailable:2,display:{title:'鸡尾酒券'},pricePromise:{fixedPriceMinor:990,products:[{id:'drink',name:'鸡尾酒'}]}}
    const api={points:async()=>({availablePoints:20,minorPerPoint:100,allowCoupons:false}),quotePoints:async input=>({id:'points-quote',generation:input.expectedGeneration,version:input.expectedVersion,current:true,expiresAt:new Date(Date.now()+120000).toISOString(),pointsUsed:input.points,subtotalMinor:1000,discountMinor:input.points*100,payableMinor:1000-input.points*100,currency:'CNY'}),wallet:async()=>({items:[coupon],nextCursor:null}),quote:async input=>({id:'server-quote',generation:input.expectedGeneration,version:input.expectedVersion,current:true,expiresAt:new Date(Date.now()+120000).toISOString(),subtotalMinor:13600,discountMinor:5810,payableMinor:7790,currency:'CNY'})}
    const page={...utils.checkoutCouponMethods({getWallet:(...a)=>api.wallet(...a),getPoints:(...a)=>api.points(...a),quotePoints:(...a)=>api.quotePoints(...a),quote:async(...a)=>{calls.push(a);return api.quote(...a)},money:n=>'¥'+(n/100).toFixed(2),randomId:()=> 'quote-operation',scope:()=>identity,errorMessage:(_,fallback)=>fallback}),
      data:{...structuredClone(utils.initialCheckoutCoupons),busy:false,checkoutConfirmVisible:true,cartGeneration:1,cartVersion:2,cart:[{productId:'drink',name:'鸡尾酒',portionIds:['first','second'],quantity:2}]},setData(v){Object.assign(this.data,v)}}
    const choose=(portion='second')=>page.chooseCheckoutCoupon({currentTarget:{dataset:{portion}},detail:{value:1}})
    return{page,api,choose,calls,setScope:value=>{identity=value}}
  }
  test(`${platform}: two identical products have independent coupon choices, not one quantity-wide discount`,async()=>{
    const {page,choose}=fixture();await page.openCheckoutCoupons();choose()
    assert.deepEqual(Array.from(page.data.couponSelections,s=>({...s})),[{portionId:'second',benefitId:'coupon'}])
    assert.equal(page.data.couponPortions[0].selectedIndex,0);assert.equal(page.data.couponPortions[1].selectedIndex,1)
    choose('first');assert.equal(page.data.couponSelections.length,2)
  })
  test(`${platform}: only a matching server quote permits discounted confirmation`,async()=>{
    const {page,choose,calls}=fixture();await page.openCheckoutCoupons();choose()
    assert.equal(page.couponCheckoutReady(),false)
    await page.quoteCheckoutCoupons()
    assert.equal(page.data.couponQuoteTotal,'¥77.90');assert.equal(page.couponCheckoutReady(),true)
    assert.equal(calls[0][0].selections[0].portionId,'second')
    page.data.couponQuote.expiresAt=new Date(Date.now()-1000).toISOString()
    assert.equal(page.couponCheckoutReady(),false)
    assert.equal(page.data.couponSelections.length,1)
  })
  test(`${platform}: choosing original price invalidates an in-flight discounted response`,async()=>{
    const {page,api,choose}=fixture();await page.openCheckoutCoupons();choose();let resolve
    api.quote=()=>new Promise(r=>{resolve=r});const pending=page.quoteCheckoutCoupons()
    page.skipCheckoutCoupons();resolve({id:'late',generation:1,version:2,current:true,payableMinor:1,expiresAt:new Date(Date.now()+120000).toISOString()});await pending
    assert.equal(page.data.couponQuote,null);assert.equal(page.data.couponLoading,false);assert.equal(page.couponCheckoutReady(),true)
  })
  test(`${platform}: remote cart changes require review, never silently fall back to full price`,async()=>{
    const {page,choose}=fixture();await page.openCheckoutCoupons();choose();await page.quoteCheckoutCoupons()
    page.data.cartVersion=3;page.invalidateCheckoutCoupons(false,true)
    assert.equal(page.couponCheckoutReady(),false)
    page.skipCheckoutCoupons();assert.equal(page.couponCheckoutReady(),true)
  })
  test(`${platform}: changing table ignores a delayed wallet response`,async()=>{
    const {page,api,setScope}=fixture();let resolve;api.wallet=()=>new Promise(r=>{resolve=r})
    const pending=page.openCheckoutCoupons();setScope('table-b');resolve({items:[{id:'wrong-customer'}],nextCursor:null});await pending
    assert.equal(page.data.couponItems.length,0)
  })
  test(`${platform}: wallet pagination failures preserve selected items and original-price escape`,async()=>{
    const {page,api,choose}=fixture();await page.openCheckoutCoupons();choose();page.data.couponNextCursor='older'
    api.wallet=async()=>{throw Error('network')};await page.loadMoreCheckoutCoupons()
    assert.equal(page.data.couponItems.length,1);assert.equal(page.data.couponSelections.length,1)
    assert.ok(page.data.couponError);page.skipCheckoutCoupons();assert.equal(page.couponCheckoutReady(),true)
  })
  test(`${platform}: zero balance stays distinct from unavailable rules`,async()=>{
    const {page,api}=fixture();api.points=async()=>({availablePoints:0,minorPerPoint:100,allowCoupons:false})
    await page.openCheckoutPoints();assert.equal(page.data.pointsBalance,0);assert.equal(page.data.pointsError,'')
    api.points=async()=>{throw Error('unavailable')};await page.openCheckoutPoints()
    assert.equal(page.data.pointsBalance,null);assert.ok(page.data.pointsError)
  })
  test(`${platform}: exact points quote supports zero payable and excludes coupon selection`,async()=>{
    const {page,choose}=fixture();await page.openCheckoutCoupons();choose()
    await page.openCheckoutPoints();assert.equal(page.data.couponSelections.length,0)
    page.onCheckoutPointsInput({detail:{value:'10'}});assert.equal(page.couponCheckoutReady(),false)
    await page.quoteCheckoutPoints();assert.equal(page.data.couponQuote.payableMinor,0);assert.equal(page.couponCheckoutReady(),true)
    await page.openCheckoutCoupons();assert.equal(page.data.pointsInput,'');assert.equal(page.data.couponQuote,null)
  })
  test(`${platform}: invalid counts, stale quotes and changed amounts never authorize points`,async()=>{
    const {page,api}=fixture();await page.openCheckoutPoints()
    for(const text of ['-1','0','1.5','NaN','21']){
      page.onCheckoutPointsInput({detail:{value:text}});await page.quoteCheckoutPoints();assert.equal(page.data.couponQuote,null);assert.equal(page.couponCheckoutReady(),false)
    }
    page.onCheckoutPointsInput({detail:{value:'10'}})
    const valid=api.quotePoints
    for(const patch of [{discountMinor:999},{pointsUsed:9},{payableMinor:-1},{version:3},{expiresAt:'2000-01-01'}]){
      api.quotePoints=async input=>({...await valid(input),...patch});await page.quoteCheckoutPoints()
      assert.equal(page.data.couponQuote,null);assert.equal(page.couponCheckoutReady(),false)
    }
  })
  test(`${platform}: cart invalidation and cancellation reject a late points quote`,async()=>{
    const {page,api}=fixture();await page.openCheckoutPoints();page.onCheckoutPointsInput({detail:{value:'5'}})
    const valid=api.quotePoints;let resolve;api.quotePoints=input=>new Promise(r=>{resolve=async()=>r(await valid(input))})
    const pending=page.quoteCheckoutPoints();page.data.cartVersion=3;page.invalidateCheckoutCoupons(false,true)
    await resolve();await pending;assert.equal(page.data.couponQuote,null);assert.equal(page.couponCheckoutReady(),false)
    page.skipCheckoutCoupons();assert.equal(page.couponCheckoutReady(),true)
  })

}

for (const platform of ['miniprogram', 'alipay-miniprogram']) {
  const future = () => new Date(Date.now() + 120000).toISOString()
  test(`${platform}: unavailable original-coupon lines require exact quote coverage for every portion`, () => {
    const utils = loadMiniModule(new URL(`../${platform}/utils/checkout-coupons.js`, import.meta.url))
    const page = { ...utils.checkoutCouponMethods({}), data: { ...structuredClone(utils.initialCheckoutCoupons), cartGeneration: 1, cartVersion: 2,
      cart: [{ productId: 'hidden', available: false, couponReviewAvailable: true, quantity: 2, portionIds: ['mine', 'another'] }],
      couponSelections: [{ portionId: 'mine', benefitId: 'old-coupon' }] }, setData(value) { Object.assign(this.data, value) } }
    assert.equal(page.couponCheckoutReady(), false)
    page.data.couponQuote = { current: true, generation: 1, version: 2, expiresAt: future(), lines: [{ portionId: 'mine', productId: 'hidden', benefitId: 'old-coupon' }] }
    assert.equal(page.couponCheckoutReady(), false, 'a coupon for one portion never covers a second portion')
    page.data.couponSelections.push({ portionId: 'another', benefitId: 'other-coupon' })
    page.data.couponQuote.lines.push({ portionId: 'another', productId: 'hidden', benefitId: 'other-coupon' })
    assert.equal(page.couponCheckoutReady(), true)
    for (const patch of [{ current: false }, { version: 3 }, { pointsUsed: 1 }, { expiresAt: '2000-01-01' }, { lines: [{ portionId: 'mine', productId: 'different', benefitId: 'old-coupon' }] }]) {
      const original = page.data.couponQuote; page.data.couponQuote = { ...original, ...patch }
      assert.equal(page.couponCheckoutReady(), false); page.data.couponQuote = original
    }
    page.data.cart[0].couponReviewAvailable = false; assert.equal(page.couponCheckoutReady(), false)
    page.data.cart[0].couponReviewAvailable = true; page.skipCheckoutCoupons(); assert.equal(page.couponCheckoutReady(), false, 'skip never silently buys unavailable goods at full price')
  })
}

async function issuedEntryFixture(platform, storage = new Map()) {
  let page, identity = 'table-a', principal = 'member-a'
  const runtime = { getStorageSync: key => key.endsWith('identity.principal.v1') ? { principalId: principal } : storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key) }
  const coupon = { id: 'coupon', state: 'available', quantityAvailable: 2, display: { title: '原券' }, pricePromise: { fixedPriceMinor: 990,
    products: [{ id: 'hidden', name: '原券套餐', productKind: 'bundle', bundleChoiceGroups: [{ id: 'choice', name: '选饮品', selectionCount: 1, options: [{ productId: 'drink', name: '饮品', quantity: 1, available: true }] }] }] } }
  const api = { add: async () => ({ generation: 1, version: 2, issuedCouponPortionId: 'issued', lines: [{ productId: 'hidden', name: '原券套餐', available: false,
    couponReviewAvailable: true, quantity: 1, portionIds: ['issued'] }] }), wallet: async () => ({ items: [coupon], nextCursor: null }) }
  vm.runInNewContext(await readFile(new URL(`../${platform}/pages/order/index.js`, import.meta.url), 'utf8'), {
    wx: runtime, Page(value) { page = value }, setTimeout, clearTimeout,
    require(path) {
      if (path.endsWith('/platform')) return runtime
      if (path.endsWith('/checkout-coupons')) return loadMiniModule(new URL(`../${platform}/utils/checkout-coupons.js`, import.meta.url))
      if (path.endsWith('/checkout-upgrade')) return loadMiniModule(new URL(`../${platform}/utils/checkout-upgrade.js`, import.meta.url))
      if (path.endsWith('/api')) return { addIssuedCouponProduct: (...args) => api.add(...args), getCustomerBenefitWallet: (...args) => api.wallet(...args) }
      return { tableSessionCacheScope: () => identity, randomId: () => 'test-key', money: n => '¥' + n / 100, customerErrorMessage: (_error, fallback) => fallback }
    },
  })
  page.data = { ...structuredClone(page.data), orderReady: true, connectionState: 'active', cartGeneration: 1, cartVersion: 1 }
  page.setData = value => Object.assign(page.data, value)
  page.currentTableRequest = () => ({ scope: identity })
  page.isCurrentTableRequest = request => request.scope === identity
  page.ensureTableRequestGuard = () => ({ beginWrite: scope => ({ scope }), isCurrentWrite: write => write.scope === identity, finishWrite: write => write.scope === identity })
  page.maybeShowMembershipInvite = () => {}
  page.recoverSharedCart = async () => {}
  return { page, api, coupon, storage, changeTable: value => { identity = value }, changeMember: value => { principal = value } }
}
for (const platform of ['miniprogram', 'alipay-miniprogram']) {
  test(`${platform}: an empty cart can select an original hidden bundle and binds the receipt portion`, async () => {
    const { page, api } = await issuedEntryFixture(platform)
    await page.openIssuedCouponEntry()
    page.updateCart([], { generation: 1, version: 1, lines: [] })
    assert.equal(page.data.checkoutConfirmVisible, true)
    assert.equal(page.data.couponProducts.length, 1)
    page.chooseIssuedCouponProduct({ currentTarget: { dataset: { product: 'hidden', benefit: 'coupon' } } })
    assert.equal(page.data.detailProduct.issuedCouponBenefitId, 'coupon')
    assert.equal(page.data.checkoutConfirmVisible, false)
    page.selectBundleChoice({ currentTarget: { dataset: { group: 'choice', product: 'drink' } } })
    assert.equal(page.data.detailSelectionsComplete, true)
    const calls = [], original = api.add; api.add = async (...args) => { calls.push(args); return original(...args) }
    await page.confirmBundleProduct()
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), ['hidden', 'coupon', 1, 1, [{ groups: [{ groupId: 'choice', productIds: ['drink'] }] }]])
    assert.deepEqual(JSON.parse(JSON.stringify(page.data.couponSelections)), [{ portionId: 'issued', benefitId: 'coupon' }])
    assert.equal(page.data.cart[0].available, false)
    page.data.couponItems = []
    const utils = loadMiniModule(new URL(`../${platform}/utils/checkout-coupons.js`, import.meta.url))
    const restoredLabels = utils.couponPortions(page.data.cart, [], page.data.couponSelections, String)
    assert.match(restoredLabels[0].selectedLabel, /已选原券.*待核对/)
    assert.equal(page.data.cart[0].couponReviewAvailable, true)
    assert.equal(page.couponCheckoutReady(), false, 'added original product is not permission to pay without the coupon quote')
  })
  test(`${platform}: lost issued-coupon add retains body across reload and never guesses a portion`, async () => {
    const first = await issuedEntryFixture(platform), attempt = { productId: 'hidden', issuedCouponBenefitId: 'coupon', bundleSelections: [] }
    first.api.add = async () => { throw new Error('lost after commit') }
    assert.equal(await first.page.commitIssuedCouponProduct(attempt), false)
    assert.equal(first.storage.size, 1)
    const restored = await issuedEntryFixture(platform, first.storage)
    restored.page.data.cartSyncing = true // Returning to the page creates a new request guard; the old flight cannot release its UI flag.
    restored.page.restoreIssuedCouponAttempt()
    assert.equal(restored.page.data.cartSyncing, false)
    assert.deepEqual(JSON.parse(JSON.stringify(restored.page.data.issuedCouponPending)), attempt)
    restored.page.data.cartVersion = 4
    const calls = []; restored.api.add = async (...args) => { calls.push(args); return { generation: 1, version: 4, lines: [{ productId: 'hidden', name: '原券套餐', available: false, couponReviewAvailable: true, quantity: 1, portionIds: ['another-person'] }] } }
    assert.equal(await restored.page.retryIssuedCouponProduct(), true)
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), ['hidden', 'coupon', 1, 4, []])
    assert.equal(restored.page.data.couponSelections.length, 0, 'missing original receipt portion never selects the last or another person portion')
    assert.equal(restored.storage.size, 0)
    assert.match(restored.page.data.couponError, /不会再次增加商品/)
    assert.equal(restored.page.couponCheckoutReady(), false)
  })
  for (const changed of ['table', 'member']) test(`${platform}: late issued-coupon add cannot populate another ${changed}`, async () => {
    const fixture = await issuedEntryFixture(platform); let resolve
    fixture.api.add = () => new Promise(done => { resolve = done })
    const pending = fixture.page.commitIssuedCouponProduct({ productId: 'hidden', issuedCouponBenefitId: 'coupon', bundleSelections: [] })
    if (changed === 'table') fixture.changeTable('table-b'); else fixture.changeMember('member-b')
    resolve({ generation: 1, version: 2, issuedCouponPortionId: 'old', lines: [{ productId: 'hidden', quantity: 1, portionIds: ['old'] }] })
    assert.equal(await pending, false)
    assert.equal(fixture.page.data.cart.length, 0)
    assert.equal(fixture.page.data.couponSelections.length, 0)
    assert.equal(fixture.storage.size, 0, 'success clears the old scope intent even when its response is ignored')
  })
  test(`${platform}: confirmed old-coupon rejection clears pending while timeouts preserve it`, async () => {
    const { page, api, storage } = await issuedEntryFixture(platform), attempt = { productId: 'hidden', issuedCouponBenefitId: 'coupon', bundleSelections: [] }
    api.add = async () => { throw Object.assign(new Error('timeout'), { statusCode: 408 }) }
    await page.commitIssuedCouponProduct(attempt); assert.ok(page.data.issuedCouponPending); assert.equal(storage.size, 1)
    api.add = async () => { throw Object.assign(new Error('expired'), { statusCode: 422, code: 'ISSUED_COUPON_UNAVAILABLE' }) }
    await page.retryIssuedCouponProduct(); assert.equal(page.data.issuedCouponPending, null); assert.equal(storage.size, 0)
  })
  test(`${platform}: issued-coupon add replays its durable original key despite a newer cart version`, async () => {
    const source = await readFile(new URL(`../${platform}/utils/api.js`, import.meta.url), 'utf8')
    const body = source.slice(source.indexOf('async function addIssuedCouponProduct('), source.indexOf('async function adjustSharedCart('))
    const storage = new Map(), calls = []; let counter = 0, fail = true
    const runtime = { getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key) }
    async function load() {
      const module = { exports: {} }, recovery = (await readFile(new URL(`../${platform}/utils/recoverable-command.js`, import.meta.url), 'utf8')).replace(/^export \{ recoverableGuestCommand \}/m, 'module.exports = { recoverableGuestCommand }')
      vm.runInNewContext(recovery, { module, wx: runtime, require: path => path.endsWith('/platform') ? runtime : path === './id' ? { randomId: () => `key-${++counter}` } : { getTableSession: () => ({ cartScope: 'opaque-table' }) } })
      return vm.runInNewContext(`(${body})`, { recoverableGuestCommand: module.exports.recoverableGuestCommand,
        request: async (_url, request) => { calls.push(request); if (fail) throw new Error('lost'); return { data: { issuedCouponPortionId: 'same-original' } } } })
    }
    await assert.rejects((await load())('hidden', 'coupon', 1, 2, []))
    fail = false
    assert.equal((await (await load())('hidden', 'coupon', 1, 4, [])).issuedCouponPortionId, 'same-original')
    assert.equal(calls[0].headers['idempotency-key'], calls[1].headers['idempotency-key'])
    assert.equal(calls[1].data.expectedVersion, 4)
    assert.equal(calls[1].data.issuedCouponBenefitId, 'coupon')
    assert.equal(calls[1].data.delta, 1)
    assert.equal(storage.size, 0)
  })
}
