const assert=require('node:assert/strict')
const test=require('node:test')
const {fixture,cart}=require('./miniprogram-state-fixture.cjs')
test('minimum spend rejection keeps selected goods and permits a corrected later checkout',async()=>{
 const h=fixture('order',{checkoutSharedCart:async()=>{throw Object.assign(new Error('本桌最低消费 ¥500.00，还差 ¥100.00。再选几款喜欢的商品即可提交。'),{code:'TABLE_MINIMUM_SPEND_NOT_MET'})}})
 const lines=[{productId:'p1',name:'商品',quantity:1,available:true,portionIds:[],unitPriceMinor:40000,subtotalAmountMinor:40000}]
 h.page.checkoutUpgradeReady=async()=>true
 h.page.updateCart(lines,{...cart(1),lines,minimumSpend:{minimumMinor:50000,consumedMinor:0,cartMinor:40000,shortfallMinor:10000,message:'还差 ¥100.00'}})
 h.page.setData({checkoutConfirmVisible:true})
 await h.page.confirmCheckout()
 assert.equal(h.page.data.checkoutLocked,false)
 assert.equal(h.page.data.cart.length,1)
 assert.match(h.page.data.error,/还差/)
 assert.equal(h.page.data.minimumSpendMessage,'还差 ¥100.00')
 assert.equal(h.page.data.busy,false)
})
for(const platform of ['miniprogram','alipay-miniprogram']){
 test(platform+': prepaid checkout uses balance with no second native payment',async()=>{
  let submitted
  const h=fixture('order',{checkoutSharedCart:async input=>{submitted=input;return{data:{prepaymentSettlement:true,payment:null,order:{publicId:'prepaid-order',paymentStatus:'paid'},settlement:{payableAmountMinor:100},sharedCart:{...cart(2),lines:[],totalAmountMinor:0}}}}},platform)
  h.page.checkoutUpgradeReady=async()=>true
  h.page.updateCart(cart(1).lines,{...cart(1),prepayment:{availableMinor:200,message:'可分次点单'}})
  h.page.setData({checkoutConfirmVisible:true})
  await h.page.confirmCheckout()
  assert.equal(submitted.prepayment,true);assert.equal(h.page.data.checkoutLocked,false)
  assert.equal(h.page.data.cart.length,0);assert.equal(h.state.payment,undefined)
  assert.equal(h.page.data.paymentResult.title,'预收款抵扣成功')
 })
 test(platform+': insufficient balance preserves cart, notes and an editable checkout',async()=>{
  const h=fixture('order',{checkoutSharedCart:async()=>{throw Object.assign(new Error('预收款还差 ¥1.00，购物车已保留'),{code:'TABLE_PREPAYMENT_INSUFFICIENT'})}},platform)
  h.page.checkoutUpgradeReady=async()=>true
  h.page.updateCart(cart(1).lines,{...cart(1),prepayment:{availableMinor:0,message:'还需补充'}})
  h.page.setData({checkoutConfirmVisible:true,note:'少冰'})
  await h.page.confirmCheckout()
  assert.equal(h.page.data.checkoutLocked,false);assert.equal(h.page.data.cart.length,1)
  assert.equal(h.page.data.note,'少冰');assert.match(h.page.data.error,/还差/)
 })
 test(platform+': shared deposit requires explicit consent and retains original key after uncertain result',async()=>{
  const calls=[]
  const h=fixture('order',{prepayTable:async(amount,key)=>{calls.push({amount,key});throw new Error('结果待核对')}},platform)
  h.page.setData({prepayment:{},prepaymentAmount:'100.00'})
  await h.page.onPrepayTable();assert.equal(calls.length,0);assert.match(h.page.data.error,/确认/)
  h.page.setData({prepaymentConsent:true});await h.page.onPrepayTable()
  h.page.setData({prepaymentAmount:'200.00'});await h.page.onPrepayTable()
  assert.equal(calls.length,2);assert.deepEqual(calls[1],calls[0]);assert.equal(calls[0].amount,10000)
  assert.equal(h.page.data.prepaymentBusy,false);assert.equal(h.state.payment,undefined)
 })
 test(platform+': terminal failed original deposit never displays payment success',async()=>{
  const h=fixture('order',{prepayTable:async()=>({status:'resolved',terminalPaymentStatus:'closed'})},platform)
  h.page.refreshSharedCart=async()=>{}
  h.page.setData({prepayment:{},prepaymentAmount:'100.00',prepaymentConsent:true})
  await h.page.onPrepayTable();assert.match(h.page.data.success,/未新增收款/)
  assert.equal([...h.state.storage.keys()].filter(k=>k.startsWith('mbox.table-prepayment.v1:')).length,0)
 })
}
