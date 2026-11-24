import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { fixture } = require('./miniprogram-state-fixture.cjs')
function tabFixture() {
  let definition
  const routes = []
  const page = {route:'pages/home/index',data:{},setData(patch){Object.assign(this.data,patch)}}
  const wx = { getWindowInfo:()=>({screenHeight:844,safeArea:{bottom:810}}), switchTab:({url})=>routes.push(url) }
  vm.runInNewContext(readFileSync(new URL('../miniprogram/custom-tab-bar/index.js', import.meta.url), 'utf8'), {
    Component: value => definition = value, getCurrentPages: () => [page], wx,
  })
  const bar = { ...definition.methods, data: structuredClone(definition.data), setData(patch) { Object.assign(this.data,patch) } }
  return {bar,routes,page,wx}
}
test('menu tab opens directly without checking or requesting a phone', () => {
  const {bar,routes}=tabFixture()
  bar.refresh()
  bar.switchTab({currentTarget:{dataset:{index:2}}})
  assert.deepEqual(routes,['/pages/order/index'])
})
function orderFixture() {
  const h=fixture('order'); h.page.setData({membershipStatus:'nonmember',membershipTerms:{version:1}})
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
test('custom tab keeps five direct navigation targets', () => {
  const app=JSON.parse(readFileSync(new URL('../miniprogram/app.json',import.meta.url)));assert.equal(app.tabBar.custom,true);assert.equal(app.tabBar.list.length,5)
  const markup=readFileSync(new URL('../miniprogram/custom-tab-bar/index.wxml',import.meta.url),'utf8');assert.match(markup,/bindtap="switchTab"/);assert.doesNotMatch(markup,/getPhoneNumber/)
})

test('rapid submit taps cannot stack checkout under the membership invitation', async () => {
  const h=orderFixture(); await Promise.all([h.page.openCheckout(),h.page.openCheckout()])
  assert.equal(h.page.data.checkoutMemberInviteVisible,true);assert.equal(h.page.data.checkoutConfirmVisible,false);assert.equal(h.state.calls.length,0)
})

 test('tab and page reserve the same iPhone safe area; invalid device dimensions do not collapse layout', async()=>{
   const h=tabFixture();await h.bar.refresh();assert.equal(h.bar.data.safeBottom,34);assert.equal(h.page.data.customTabBarHeight,84)
   h.wx.getWindowInfo=()=>({screenHeight:700,safeArea:{bottom:720}});await h.bar.refresh();assert.equal(h.bar.data.safeBottom,0);assert.equal(h.page.data.customTabBarHeight,50)
 })
