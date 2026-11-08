const test = require('node:test')
const assert = require('node:assert/strict')
const {fixture,cart} = require('./miniprogram-state-fixture.cjs')
for(const platform of ['miniprogram','alipay-miniprogram']){
 test(platform+': current table follows a live transfer without losing the cart scope',()=>{
  const h=fixture('order',{},platform),scope=h.state.session.cartScope,modals=[]
  h.wx.showModal=o=>{modals.push(o);o.success({confirm:false})}
  const snapshot={...cart(2),prepayment:{tableCode:'VIP2',tableDisplayName:'VIP2',locationVersion:1,minimumMinor:100000,waiverMinor:0,initialFundingRequiredMinor:50000,availableMinor:50000,receivedMinor:50000,message:'补款继续抵商品',myPendingReceipts:[],mySharedReceipts:[]}}
  h.page.updateCart(snapshot.lines,snapshot)
  assert.equal(h.page.data.table.code,'VIP2');assert.equal(h.state.session.tableCode,'VIP2');assert.equal(h.state.session.cartScope,scope)
  h.page.updateCart(snapshot.lines,snapshot);assert.equal(modals.length,1);assert.match(modals[0].content,/500\.00/)
 })
 test(platform+': zero-minimum ordinary tables also follow transfer without enabling prepayment',()=>{
  const h=fixture('order',{},platform),scope=h.state.session.cartScope
  const snapshot={...cart(2),prepayment:null,tableLocation:{tableCode:'A02',tableDisplayName:'A02',locationVersion:1}}
  h.page.updateCart(snapshot.lines,snapshot)
  assert.equal(h.page.data.table.code,'A02');assert.equal(h.state.session.tableCode,'A02');assert.equal(h.state.session.cartScope,scope);assert.equal(h.page.data.prepayment,null)
 })
 test(platform+': customer checkout asks only for the shortfall and preserves the cart until confirmed funds',async()=>{
  const h=fixture('order',{},platform),modals=[];let topup=0
  h.wx.showModal=o=>{modals.push(o);o.success({confirm:true})}
  h.page.checkoutUpgradeReady=async()=>true;h.page.handlePendingPaymentBeforeCheckout=async()=>false
  h.page.onPrepayTable=async()=>{topup++;assert.equal(h.page.data.prepaymentAmount,'80.00');assert.equal(h.page.data.prepaymentConsent,true)}
  const snapshot={...cart(2),totalAmountMinor:18000,lines:[{...cart(2).lines[0],subtotalAmountMinor:18000}],prepayment:{tableCode:'VIP2',locationVersion:1,minimumMinor:150000,waiverMinor:0,initialFundingRequiredMinor:0,availableMinor:10000,pendingOrderDueMinor:0,myPendingReceipts:[],mySharedReceipts:[]}}
  h.page.updateCart(snapshot.lines,snapshot);h.page.setData({checkoutConfirmVisible:true})
  await h.page.confirmCheckout()
  assert.equal(topup,1);assert.equal(h.state.calls.length,0);assert.equal(h.page.data.cart.length,1);assert.match(modals[0].content,/80\.00/)
 })
 test(platform+': a stale table change during supplement confirmation sends no payment',async()=>{
  const h=fixture('order',{},platform);let topup=0
  h.page.checkoutUpgradeReady=async()=>true;h.page.handlePendingPaymentBeforeCheckout=async()=>false;h.page.onPrepayTable=async()=>{topup++}
  const snapshot={...cart(2),prepayment:{locationVersion:1,minimumMinor:150000,waiverMinor:0,initialFundingRequiredMinor:10000,availableMinor:0,myPendingReceipts:[],mySharedReceipts:[]}}
  h.page.updateCart(snapshot.lines,snapshot);h.page.setData({checkoutConfirmVisible:true})
  h.wx.showModal=o=>{h.page.setData({prepayment:{...h.page.data.prepayment,locationVersion:2,minimumMinor:200000}});o.success({confirm:true})}
  await h.page.confirmCheckout();assert.equal(topup,0);assert.equal(h.state.calls.length,0);assert.match(h.page.data.error,/变化/)
 })
}
