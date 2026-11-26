import { loadMiniModule as loadActualDateModule } from './load-miniprogram-test-module.mjs'
const actualMiniFormat = loadActualDateModule(new URL('../miniprogram/utils/format.js', import.meta.url))
import { memberGuardFixture } from './miniprogram-member-guard-fixture.mjs'
const memberGuards = memberGuardFixture()
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const row = (id, state = 'upcoming') => ({
  id, type: 'gift_product', state, quantityAvailable: 1, quantityReserved: 0, quantityRedeemed: 0,
  display: { title: '限时鸡尾酒' }, validFrom: '2026-09-09T16:00:00Z', validUntil: null,
  valueAmountMinor: 6800,
})
async function harness(platform, api) {
  let page
  const timers = new Map(); let timerId = 0
  vm.runInNewContext(await readFile(new URL('../' + platform + '/pages/profile-coupons/index.js', import.meta.url), 'utf8'), {
    setTimeout: callback => { timers.set(++timerId, callback); return timerId }, clearTimeout: id => timers.delete(id),
    Page(value) { page = value; page.setData = next => Object.assign(page.data, next) },
    require(name) { if (name === './format') return actualMiniFormat;
      if (memberGuards[name.split('/').pop()]) return memberGuards[name.split('/').pop()]
      if (name.endsWith('/api')) return { getCustomerBenefitWallet: api, getChannelWalletPage: async()=>({items:[],nextCursor:null}) }
      if (name.endsWith('/format')) return { ...actualMiniFormat, money: n => '¥' + n / 100, dateInput: value => value }
      return { customerErrorMessage: (_, fallback) => fallback }
    },
  })
  page.testTimers = timers
  return page
}
for (const platform of ['miniprogram', 'alipay-miniprogram']) {
  test(platform + ': fixed selling price is not rendered as a deduction or a free gift', async () => {
    const page = await harness(platform, async () => ({ items: [{ ...row('low-price','available'),type:'discount',valueAmountMinor:0,pricePromise:{kind:'fixed_price',fixedPriceMinor:990,products:[{id:'snack',name:'薯条'}]} }],nextCursor:null }))
    await page.load()
    assert.equal(page.data.coupons[0].typeText,'固定低价兑换券')
    assert.equal(page.data.coupons[0].valueText,'¥9.9/份')
    assert.match(page.data.coupons[0].description,/不是减免金额.*薯条.*订单确认/)
  })
  test(platform + ': shows server calendar and shared frequency without claiming weekly grants', async () => {
    const page = await harness(platform, async () => ({ items: [{ ...row('window', 'outside_window'), calendar: {
      summary: '周一至周三，按营业日使用。', nextAvailableAt: '2026-09-14T13:00:00Z',
      limits: { perCustomerDay: 1, perCustomerWeek: 2, perCustomerCampaign: null },
    } }], nextCursor: null }))
    await page.load()
    const coupon = page.data.coupons[0]
    assert.equal(coupon.stateText, '非可用时段')
    assert.match(coupon.calendarNextText, /2026-09-14 21:00/)
    assert.match(coupon.calendarLimitText, /每日最多1次.*每周最多2次.*同活动多张券合计/)
    assert.match(coupon.quantityText, /^剩余/)
  })
  test(platform + ': future status and Beijing date, no fake gift cash balance', async () => {
    const page = await harness(platform, async () => ({ items: [row('a')], nextCursor: null }))
    await page.load()
    assert.equal(page.data.coupons[0].stateText, '未到使用时间')
    assert.match(page.data.coupons[0].validText, /2026-09-10 00:00/)
    assert.equal(page.data.coupons[0].valueText, '')
  })
  test(platform + ': pagination retry keeps existing wallet and deduplicates overlapping rows', async () => {
    let count = 0
    const page = await harness(platform, async cursor => {
      count++
      if (!cursor) return { items: [row('a')], nextCursor: 'next' }
      if (count === 2) throw new Error('network')
      return { items: [row('a'), row('b', 'reserved')], nextCursor: null }
    })
    await page.load()
    await page.loadMore()
    assert.equal(page.data.coupons.length, 1)
    assert.equal(page.data.nextCursor, 'next')
    assert.ok(page.data.moreError)
    await page.loadMore()
    assert.equal(page.data.coupons.length, 2)
    assert.equal(page.data.coupons[1].stateText, '使用处理中')
    assert.equal(page.data.nextCursor, null)
  })
  test(platform + ': hidden page rejects late response; next identity load clears old data', async () => {
    let resolve
    const page = await harness(platform, () => new Promise(r => { resolve = r }))
    const pending = page.load()
    page.onHide()
    resolve({ items: [row('old-account')], nextCursor: null })
    await pending
    assert.equal(page.data.coupons.length, 0)
    const fresh = page.load()
    resolve({ items: [row('new-account')], nextCursor: null })
    await fresh
    assert.equal(page.data.coupons[0].id, 'new-account')
  })
}

test('WeChat member wallet rechecks expiry with the server and clears the timer on hide', async () => {
  let reads = 0
  const page = await harness('miniprogram', async () => ({items:[{
    ...row('ending', ++reads === 1 ? 'available' : 'expired'), validUntil:new Date(Date.now()+1000).toISOString(),
    pricePromise:{kind:'fixed_price',fixedPriceMinor:990,products:[{id:'snack',name:'薯条'}]},
  }],nextCursor:null}))
  await page.onShow()
  assert.equal(page.data.coupons[0].canUsePriceCoupon,true)
  assert.equal(page.testTimers.size,1)
  await [...page.testTimers.values()][0]()
  assert.equal(page.data.coupons[0].stateText,'已过期')
  assert.equal(page.data.coupons[0].canUsePriceCoupon,false)
  assert.equal(page.testTimers.size,0)
  page.onHide();assert.equal(page.testTimers.size,0)
})
test('WeChat member wallet never restores redeemed or reserved state from local dates', async () => {
  const page = await harness('miniprogram', async () => ({items:['redeemed','reserved'].map(state=>({
    ...row(state,state), validUntil:new Date(Date.now()+1000).toISOString(),
  })),nextCursor:null}))
  await page.onShow();assert.equal(page.testTimers.size,0)
  assert.deepEqual(Array.from(page.data.coupons,c=>c.stateText),['已使用','使用处理中'])
})

// Promotion coupons use a separate backend ledger but must appear in the same customer wallet.
const { pageFixture, deferred, tick } = await import('./miniprogram-full-page-fixture.mjs')
const channelRow = (id, status='available') => ({id, status, offerCode:'ABCDEFGH2345', title:'餐后优惠', offer:{kind:'gift',productName:'气泡水',quantity:1}, useFrom:'2026-11-01T00:00:00Z',useUntil:'2099-12-01T00:00:00Z',eligibleProductScope:'all'})
const channelPage = (overrides={}) => pageFixture('profile-coupons', {getCustomerBenefitWallet:async()=>({items:[],nextCursor:null}),getChannelWalletPage:async()=>({items:[channelRow('mine')],nextCursor:null}),...overrides})
test('promotion appears in My Coupons even when membership wallet is empty',async()=>{
 const f=channelPage();await f.page.onShow();assert.equal(f.page.data.coupons.length,0);assert.equal(f.page.data.channelCoupons[0].id,'mine');assert.match(f.page.data.channelCoupons[0].offerText,/气泡水 1 份/);assert.equal(f.page.data.channelError,'')
 f.page.openChannelCoupon({currentTarget:{dataset:{id:'mine'}}});assert.match(f.state.calls.at(-1)[1].url,/code=ABCDEFGH2345&claimId=mine&order=1$/)
})
test('wallet refresh after returning shows newly claimed coupon and server refund/use states',async()=>{
 let rows=[];const f=channelPage({getChannelWalletPage:async()=>({items:rows,nextCursor:null})});await f.page.onShow();assert.equal(f.page.data.channelCoupons.length,0)
 f.page.onHide();rows=[channelRow('new','fulfilled')];await f.page.onShow();assert.equal(f.page.data.channelCoupons[0].stateText,'已兑现');assert.equal(f.page.data.channelCoupons[0].canUse,false)
})
for(const lane of ['member','channel'])test('one wallet failure preserves the other lane: '+lane,async()=>{
 const f=channelPage({getCustomerBenefitWallet:async()=>{if(lane==='member')throw Error('offline');return {items:[row('member')],nextCursor:null}},getChannelWalletPage:async()=>{if(lane==='channel')throw Error('offline');return {items:[channelRow('mine')],nextCursor:null}}});await f.page.onShow()
 assert.equal(f.page.data.coupons.length,lane==='member'?0:1);assert.equal(f.page.data.channelCoupons.length,lane==='channel'?0:1);assert.ok(lane==='member'?f.page.data.error:f.page.data.channelError)
})
test('promotion pagination retains records on failure, deduplicates and rejects looping cursors',async()=>{
 let fail=true;const f=channelPage({getChannelWalletPage:async({cursor})=>{if(!cursor)return {items:[channelRow('a')],nextCursor:'next'};if(fail)throw Error('offline');return {items:[channelRow('a'),channelRow('b')],nextCursor:'last'}}});await f.page.onShow();await f.page.loadMoreChannelCoupons();assert.equal(f.page.data.channelCoupons.length,1);fail=false;await f.page.loadMoreChannelCoupons();assert.deepEqual(Array.from(f.page.data.channelCoupons,c=>c.id),['a','b']);await f.page.loadMoreChannelCoupons();assert.ok(f.page.data.channelError);assert.equal(f.page.data.channelCoupons.length,2)
})
for(const boundary of ['hide','account'])test('late promotion wallet response cannot cross '+boundary,async()=>{
 const gate=deferred(),f=channelPage({getChannelWalletPage:()=>gate.promise});f.state.storage.set('mbox.wechat.identity.principal.v1',{principalId:'a'});const read=f.page.onShow();await tick();if(boundary==='hide')f.page.onHide();else f.state.storage.set('mbox.wechat.identity.principal.v1',{principalId:'b'});gate.resolve({items:[channelRow('private')],nextCursor:null});await read;assert.equal(f.page.data.channelCoupons.length,0)
})
test('account switch blocks a stale coupon navigation before another wallet read',async()=>{
 const f=channelPage();f.state.storage.set('mbox.wechat.identity.principal.v1',{principalId:'a'});await f.page.onShow();f.state.storage.set('mbox.wechat.identity.principal.v1',{principalId:'b'});f.page.openChannelCoupon({currentTarget:{dataset:{id:'mine'}}});assert.equal(f.state.calls.length,0);assert.equal(f.page.data.channelCoupons.length,0)
})
test('wallet has a promotion card and never claims empty while its lane is unread or failed',async()=>{
 const wxml=await readFile(new URL('../miniprogram/pages/profile-coupons/index.wxml',import.meta.url),'utf8');assert.match(wxml,/wx:for="{{channelCoupons}}"/);assert.match(wxml,/去点单使用/);assert.match(wxml,/!channelLoading && !channelError && !channelCoupons.length/)
})
