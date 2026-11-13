const test=require('node:test'),assert=require('node:assert/strict')
const {fixture,cart}=require('./miniprogram-state-fixture.cjs')
function setup(mode='paid') {
 let h,paid=false,native=0,queries=0,submits=0,prepayKeys=[]
 const replaceAttempt=()=>{const key=[...h.state.storage.keys()].find(k=>k.startsWith('mbox.table-prepayment.v1:'));h.state.storage.set(key,{key:'another-payment',amount:54000})}
 const credit=()=>({locationVersion:1,minimumMinor:50000,waiverMinor:0,initialFundingRequiredMinor:paid?0:50000,availableMinor:paid?54000:0,pendingOrderDueMinor:0,myPendingReceipts:[],mySharedReceipts:[]})
 const snapshot=()=>({...cart(2),totalAmountMinor:54000,lines:[{...cart(2).lines[0],unitPriceMinor:54000,subtotalAmountMinor:54000}],prepayment:credit()})
 h=fixture('order',{
  prepayTable:async(amount,key)=>{prepayKeys.push(key);if(mode==='callback-first'&&prepayKeys.length>1){paid=true;return{paymentId:'payment-1',status:'resolved',terminalPaymentStatus:'succeeded'}}return({paymentId:'payment-1',status:'pending',presentation:'jsapi',payload:{timeStamp:'1',nonceStr:'n',package:'prepay_id=test',signType:'RSA',paySign:'test'}})},
  queryPrepayment:async()=>{queries++;if(mode==='replace-query')replaceAttempt();if(mode==='timeout'||mode==='callback-first')throw new Error('query timeout');paid=true;return {data:{id:'payment-1',status:mode==='pending'?'pending':'succeeded'}}},
  getSharedCart:async()=>{if(mode==='replace-refresh')replaceAttempt();if(mode==='refresh-fail')throw new Error('cart unavailable');const s=snapshot();if(mode==='cart-change')s.version=3;if(mode==='frozen')s.guestWritesFrozen=true;if(mode==='spent')s.prepayment.availableMinor=0;return s},
  checkoutSharedCart:async(input,key)=>{submits++;h.state.calls.push({input,key});if(mode==='lost-response')throw new Error('lost response');return {data:{order:{publicId:'synthetic-order'},payment:null,prepaymentSettlement:true,sharedCart:{...cart(3,2),lines:[],prepayment:credit()}}}},
 })
 h.page.checkoutUpgradeReady=async()=>true;h.page.handlePendingPaymentBeforeCheckout=async()=>false
 h.page.updateCart(snapshot().lines,snapshot());h.page.setData({checkoutConfirmVisible:true})
 h.wx.requestPayment=o=>{native++;if(mode==='cancel'){o.fail({errMsg:'requestPayment:fail cancel'});return}if(mode==='switch'){h.state.session={...h.state.session,tableToken:'other-table'};}o.success({})}
 return {...h,prepayKeys,counts:()=>({native,queries,submits})}
}
test('confirmed topup continues the reviewed product submission exactly once',async()=>{
 const h=setup();await h.page.confirmCheckout();assert.deepEqual(h.counts(),{native:1,queries:1,submits:1});assert.equal(h.state.calls[0].input.prepayment,true);assert.equal(h.state.calls[0].input.expectedVersion,2);assert.equal(h.page.data.paymentResult.kind,'success');await h.page.confirmCheckout();assert.equal(h.counts().submits,1)
})
for(const mode of ['cancel','timeout','pending','refresh-fail','cart-change','frozen','spent','switch'])test(mode+' never submits products or claims order success',async()=>{
 const h=setup(mode);await h.page.confirmCheckout();assert.equal(h.counts().submits,0);assert.equal(h.page.data.paymentResult,null);assert.notEqual(h.page.data.success,'请核对到账后的最新余额，再确认本单。购物车已保留。');if(mode!=='switch')assert.ok(h.page.data.error)
})
test('lost product response preserves original order key, not another payment',async()=>{
 const h=setup('lost-response');await h.page.confirmCheckout();assert.equal(h.counts().submits,1);assert.equal(h.page.data.checkoutLocked,true);const key=h.state.calls[0].key;await h.page.retryCheckout();assert.equal(h.counts().submits,2);assert.equal(h.state.calls[1].key,key);assert.equal(h.counts().native,1)
})
test('independent prepay button never submits products',async()=>{
 const h=setup();h.page.setData({prepaymentConsent:true,prepaymentAmount:'540.00'});const result=await h.page.onPrepayTable();assert.equal(result.status,'confirmed');assert.equal(h.counts().submits,0);assert.match(h.page.data.success,/商品尚未提交/)
})

test('callback before query recovers the original payment key and continues once',async()=>{const h=setup('callback-first');await h.page.confirmCheckout();assert.equal(h.counts().submits,1);assert.equal(h.counts().native,1);assert.equal(h.prepayKeys.length,2);assert.equal(h.prepayKeys[0],h.prepayKeys[1])})

for(const mode of ['replace-query','replace-refresh'])test(mode+' cannot continue another payment attempt',async()=>{const h=setup(mode);await h.page.confirmCheckout();assert.equal(h.counts().submits,0)})
