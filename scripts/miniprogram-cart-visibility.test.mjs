import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'
import {createOrderPage} from './test-support/order-performance-harness.mjs'
function setup() {
 let failure=null
 const h=createOrderPage({overrides:{getGuestSession:async()=>{if(failure)throw Object.assign(new Error('session failed'),failure);return {data:{status:'active',cartProtocolVersion:2,table:{code:'A01',displayName:'A01'}}}}}})
 return Object.assign(h,{failSession:value=>{failure=value}})
}
const add = h => h.page.addProduct({currentTarget:{dataset:{id:'p-0'}}})
for (const failure of [{code:'NETWORK_ERROR'},{code:'HTTP_ERROR',statusCode:503},{code:'HTTP_ERROR',statusCode:429}]) {
 test(`same-table return preserves visible cart but blocks writes during ${failure.code}/${failure.statusCode || ''}`,async()=>{
  const h=setup()
  try {
   await h.page.preparePage();await add(h);
   h.page.onHide();h.failSession(failure)
   await h.page.onShow()
   assert.equal(h.page.data.connectionState,'active');assert.equal(h.page.data.browseOnly,false);assert.equal(h.page.data.cartCount,1)
   assert.equal(h.page.data.orderReady,false);assert.equal(h.page.data.paymentStateReady,false)
   await add(h);await h.page.openCheckout();assert.equal(h.state.calls.filter(x=>x==='add').length,1);assert.equal(h.state.calls.includes('submit'),false)
   h.failSession(null);await h.page.preparePage();assert.equal(h.page.data.orderReady,true);assert.equal(h.page.data.cartCount,1)
  }finally{h.dispose()}
 })
}
for (const kind of ['invalid-session','changed-table','first-load']) {
 test(`cart preservation never authorizes ${kind}`,async()=>{
  const h=setup()
  try {
   if(kind!=='first-load'){await h.page.preparePage();await add(h)}
   if(kind==='changed-table')h.state.session={tableCode:'B02',tableToken:'other-table',scanNonce:'other-scan',cartScope:'other-session'}
   h.failSession(kind==='invalid-session'?{code:'GUEST_SESSION_INVALID',statusCode:401}:{code:'NETWORK_ERROR'})
   await h.page.preparePage();assert.notEqual(h.page.data.connectionState,'active');assert.equal(h.page.data.orderReady,false)
   if(kind!=='invalid-session')assert.equal(h.page.data.cartCount,0)
  }finally{h.dispose()}
 })
}
test('empty carts hide the shortcut and cannot submit an empty order',async()=>{
 const source=await readFile('miniprogram/pages/order/index.wxml','utf8')
 const condition=source.match(/<view wx:if="\{\{([^}]+)\}\}" class="cart-dock">/)[1]
 const visible=Function('connectionState','cart','checkoutLocked',`return Boolean(${condition})`)
 assert.equal(visible('active',[],false),false);assert.equal(visible('active',[],true),true);assert.equal(visible('needs_scan',[],false),false)
 assert.doesNotMatch(source,/empty-cart-float|showEmptyCart/)
 assert.equal(visible('active',[{}],false),true)
 const h=setup();try{await h.page.preparePage();await h.page.openCheckout();assert.equal(h.state.calls.includes('submit'),false);assert.equal(h.page.data.checkoutConfirmVisible,false)}finally{h.dispose()}
})

test('unconfirmed points keep checkout open and point directly to the red numeric input',async()=>{
 const h=setup()
 try {await h.page.preparePage();await add(h);h.page.setData({checkoutConfirmVisible:true,pointsInput:'5',pointsPickerOpen:false});assert.equal(h.page.couponCheckoutReady(),false);assert.equal(h.page.data.pointsPickerOpen,true);assert.equal(h.page.data.checkoutScrollTarget,'checkout-points');assert.match(h.page.data.pointsError,/核对积分/);assert.equal(h.state.calls.includes('submit'),false)}finally{h.dispose()}
 const markup=await readFile('miniprogram/pages/order/index.wxml','utf8')
 assert.match(markup,/type="number"[^>]+placeholder="请输入抵扣积分数字" placeholder-style="color: #b42318"/)
})
