import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { fixture, deferred } = require('./miniprogram-state-fixture.cjs')
const phoneModule = { exports: {} }
vm.runInNewContext(readFileSync(new URL('../miniprogram/utils/wechat-phone.js', import.meta.url), 'utf8'), {module:phoneModule})
const phoneReader = phoneModule.exports
const phone = { detail: { code: 'native-phone-proof' } }
const verified = { status: 'active', publicId: 'CVC' + '1'.repeat(32) }
function tabFixture(overrides = {}) {
  let definition
  const routes = [], storage = new Map(), phoneCalls = []
  const page = {route:'pages/home/index',data:{},setData(patch){Object.assign(this.data,patch)}}
  const api = { getMiniBootstrap: async () => ({ membership: null }), getVerifiedPhones: async () => [], replaceVerifiedPhone: async code => { phoneCalls.push(code); return verified }, ...overrides }
  const wx = { getWindowInfo:()=>({screenHeight:844,safeArea:{bottom:810}}), getStorageSync: key => storage.get(key), setStorageSync: (key,value) => storage.set(key,value), switchTab: ({url}) => routes.push(url), showToast() {} }
  vm.runInNewContext(readFileSync(new URL('../miniprogram/custom-tab-bar/index.js', import.meta.url), 'utf8'), {
    Component: value => definition = value, getCurrentPages: () => [page], wx,
    require: name => ({'../utils/api':api,'../utils/wechat-phone':phoneReader,'../utils/customer-error':{customerErrorMessage:(_e,fallback)=>fallback},'../config/index':{getRuntimeConfig:()=>({membershipInviteCooldownHours:24})}})[name],
  })
  const bar = { ...definition.methods, data: structuredClone(definition.data), setData(patch) { Object.assign(this.data,patch) } }
  return {bar,definition,routes,storage,phoneCalls,api,page,wx}
}
test('menu tab uses native phone button only for known unverified nonmembers', async () => {
  const h = tabFixture(); await h.bar.refresh('/pages/home/index'); assert.equal(h.bar.data.needsPhone,true)
  for (const api of [{getMiniBootstrap:async()=>({membership:{memberNo:'123456'}})},{getVerifiedPhones:async()=>[verified]},{getMiniBootstrap:async()=>{throw Error('offline')}}]) {
    const other=tabFixture(api); await other.bar.refresh(); assert.equal(other.bar.data.needsPhone,false)
    other.bar.switchTab({currentTarget:{dataset:{index:2}}}); assert.deepEqual(other.routes,['/pages/order/index'])
  }
})
test('native phone acceptance saves only phone and then enters menu', async () => {
  const h=tabFixture(); await h.bar.refresh(); await h.bar.authorizeAndOrder(phone)
  assert.deepEqual(h.phoneCalls,['native-phone-proof']); assert.deepEqual(h.routes,['/pages/order/index']); assert.equal(h.bar.data.needsPhone,false)
})
test('phone denial still enters menu without phone or membership writes and cools down', async () => {
  const h=tabFixture(); await h.bar.refresh(); await h.bar.authorizeAndOrder({detail:{errMsg:'getPhoneNumber:fail user deny'}})
  assert.deepEqual(h.phoneCalls,[]); assert.deepEqual(h.routes,['/pages/order/index']); await h.bar.refresh(); assert.equal(h.bar.data.needsPhone,false)
})
test('failed phone verification never blocks ordering; duplicate callbacks save once', async () => {
  const pending=deferred(); let calls=0; const h=tabFixture({replaceVerifiedPhone:()=>{calls++;return pending.promise}})
  const first=h.bar.authorizeAndOrder(phone); await h.bar.authorizeAndOrder(phone); pending.reject(Error('offline')); await first
  assert.equal(calls,1); assert.deepEqual(h.routes,['/pages/order/index']); assert.equal(h.bar.data.busy,false)
})
test('stale identity cannot restore a phone prompt on a detached tab', async () => {
  const pending=deferred(); const h=tabFixture({getMiniBootstrap:()=>pending.promise}); const reading=h.bar.refresh()
  h.definition.lifetimes.detached.call(h.bar); pending.resolve({membership:null}); await reading; assert.equal(h.bar.data.needsPhone,false)
})
function orderFixture() {
  const h=fixture('order'); h.page.setData({membershipStatus:'nonmember',membershipTerms:{version:1},menuPhoneStatus:'verified'})
  h.page.loadCheckoutUpgrade=()=>{}; return h
}
test('membership invitation opens on submit order, not entering menu or selecting dishes', async () => {
  const h=orderFixture(); assert.equal(h.page.data.checkoutMemberInviteVisible,false)
  await h.page.openCheckout(); assert.equal(h.page.data.checkoutMemberInviteVisible,true); assert.equal(h.page.data.checkoutConfirmVisible,false); assert.equal(h.state.calls.length,0)
  await h.page.skipCheckoutMembership(); assert.equal(h.page.data.checkoutMemberInviteVisible,false); assert.equal(h.page.data.checkoutConfirmVisible,true); assert.equal(h.state.calls.length,0)
  h.page.closeCheckoutConfirm(); await h.page.openCheckout(); assert.equal(h.page.data.checkoutMemberInviteVisible,false)
})
test('member, unknown identity, frozen cart, empty cart never receive checkout invitation', async () => {
  for (const data of [{membershipStatus:'member'},{membershipStatus:'unknown'},{cartWritesFrozen:true},{cart:[]}]) {
    const h=orderFixture();h.page.setData(data); await h.page.openCheckout();assert.equal(h.page.data.checkoutMemberInviteVisible,false)
  }
})
test('phone dismissal does not suppress the distinct checkout membership invitation', async () => {
  const h=orderFixture();h.state.storage.set('mbox.membership.invite.dismissed.until.v1',Date.now()+86400000)
  await h.page.openCheckout();assert.equal(h.page.data.checkoutMemberInviteVisible,true)
})
test('membership navigation preserves cart and only returns to confirmation, never payment', async () => {
  const h=orderFixture(), routes=[];h.wx.navigateTo=({url})=>routes.push(url)
  await h.page.openCheckout(); const cart=JSON.stringify(h.page.data.cart);h.page.joinFromCheckout()
  assert.deepEqual(routes,['/pages/membership-terms/index?source=mini_menu&action=enroll']);assert.equal(JSON.stringify(h.page.data.cart),cart)
  h.page.preparePage=async()=>{};await h.page.onShow();assert.equal(h.page.data.checkoutConfirmVisible,true);assert.equal(h.state.calls.length,0)
})
test('cart review route still offers membership before final payment and stale return cannot reopen a different table', async () => {
  const h=orderFixture();h.page.openCartDetails();await h.page.confirmCheckout();assert.equal(h.page.data.checkoutMemberInviteVisible,true);assert.equal(h.state.calls.length,0)
  h.wx.navigateTo=()=>{};h.page.joinFromCheckout();h.page.onHide();h.state.session={tableCode:'W21',tableToken:'other',cartScope:'other'};h.page.beginTableRequest();h.page.preparePage=async()=>{}
  await h.page.onShow();assert.equal(h.page.data.checkoutConfirmVisible,false);assert.equal(h.state.calls.length,0)
})
test('custom tab keeps explicit native authorization and five real navigation targets', () => {
  const app=JSON.parse(readFileSync(new URL('../miniprogram/app.json',import.meta.url)));assert.equal(app.tabBar.custom,true);assert.equal(app.tabBar.list.length,5)
  const markup=readFileSync(new URL('../miniprogram/custom-tab-bar/index.wxml',import.meta.url),'utf8');assert.match(markup,/open-type="getPhoneNumber" bindgetphonenumber="authorizeAndOrder"/)
})

test('rapid submit taps cannot stack checkout under the membership invitation', async () => {
  const h=orderFixture(); await Promise.all([h.page.openCheckout(),h.page.openCheckout()])
  assert.equal(h.page.data.checkoutMemberInviteVisible,true);assert.equal(h.page.data.checkoutConfirmVisible,false);assert.equal(h.state.calls.length,0)
})

 test('tab and page reserve the same iPhone safe area; invalid device dimensions do not collapse layout', async()=>{
   const h=tabFixture();await h.bar.refresh();assert.equal(h.bar.data.safeBottom,34);assert.equal(h.page.data.customTabBarHeight,84)
   h.wx.getWindowInfo=()=>({screenHeight:700,safeArea:{bottom:720}});await h.bar.refresh();assert.equal(h.bar.data.safeBottom,0);assert.equal(h.page.data.customTabBarHeight,50)
 })
