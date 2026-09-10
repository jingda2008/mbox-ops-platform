import assert from 'node:assert/strict'
import test from 'node:test'
import {loadMiniModule} from './load-miniprogram-test-module.mjs'
for(const platform of ['miniprogram','alipay-miniprogram']){
 function fixture(){
  const utils=loadMiniModule(new URL(`../${platform}/utils/checkout-upgrade.js`,import.meta.url))
  let identity='table-a';const calls=[]
  const offer={id:'offer',sourcePortionId:'old',generation:1,version:2,status:'offered',currency:'CNY',originalPayableMinor:10000,upgradedPayableMinor:13000,expiresAt:new Date(Date.now()+120000).toISOString()}
  const api={prepare:async()=>offer,decide:async()=>({opportunity:{...offer,status:'accepted',replacementPortionId:'new'}})}
  const page={...utils.checkoutUpgradeMethods({prepare:async(...args)=>{calls.push(args);return api.prepare(...args)},decide:(...args)=>api.decide(...args),randomId:()=> 'upgrade-operation',scope:()=>identity,money:n=>'¥'+n/100}),
   data:{...structuredClone(utils.initialCheckoutUpgrade),busy:false,cartSyncing:false,checkoutConfirmVisible:true,cartGeneration:1,cartVersion:2,cart:[{productId:'source'}],couponSelections:[]},setData(v){Object.assign(this.data,v)},currentTableRequest:()=>({identity}),isCurrentTableRequest:r=>r.identity===identity,
   async refreshSharedCart(){this.data.cartVersion=3;this.invalidateCheckoutUpgrade();return true},async quoteCheckoutCoupons(){this.quoted=true}}
  return{page,api,calls,offer,setScope:value=>{identity=value}}
 }
 test(`${platform}: once per cart, optional request never marks checkout busy`,async()=>{
  const {page,calls}=fixture();await page.loadCheckoutUpgrade();assert.equal(page.data.checkoutUpgrade.addedText,'¥30');assert.equal(page.data.busy,false)
  page.declineCheckoutUpgrade();await page.loadCheckoutUpgrade();assert.equal(calls.length,1);assert.equal(page.data.checkoutUpgrade,null)
 })
 test(`${platform}: failed recommendation leaves original confirmation open`,async()=>{
  const {page,api}=fixture();api.prepare=async()=>{throw Error('timeout')};await page.loadCheckoutUpgrade()
  assert.equal(page.data.busy,false);assert.equal(page.data.checkoutConfirmVisible,true);assert.equal(page.data.checkoutUpgrade,null)
 })
 test(`${platform}: stale table, quote version or changed coupon selection cannot display delayed offer`,async()=>{
  for(const kind of ['table','version','coupon']){
   const {page,api,offer,setScope}=fixture();let resolve;api.prepare=()=>new Promise(r=>{resolve=r});const pending=page.loadCheckoutUpgrade()
   if(kind==='table')setScope('table-b');else if(kind==='version')page.data.cartVersion=3;else page.invalidateCheckoutUpgrade()
   resolve(offer);await pending;assert.equal(page.data.checkoutUpgrade,null)
  }
 })
 test(`${platform}: acceptance refreshes actual cart and maps only replaced coupon portion`,async()=>{
  const {page}=fixture();page.data.couponSelections=[{portionId:'old',benefitId:'coupon'},{portionId:'other',benefitId:'other-coupon'}]
  await page.loadCheckoutUpgrade();await page.acceptCheckoutUpgrade()
  assert.equal(page.data.cartVersion,3);assert.equal(page.data.checkoutConfirmVisible,true);assert.equal(page.data.busy,false);assert.equal(page.quoted,true)
  assert.deepEqual(Array.from(page.data.couponSelections,s=>s.portionId),['new','other']);assert.match(page.data.checkoutUpgradeMessage,/再确认支付/)
 })
 test(`${platform}: unknown acceptance refreshes without starting payment or trapping busy`,async()=>{
  const {page,api}=fixture();await page.loadCheckoutUpgrade();api.decide=async()=>{throw Error('unknown')};await page.acceptCheckoutUpgrade()
  assert.equal(page.data.busy,false);assert.equal(page.data.checkoutConfirmVisible,true);assert.equal(page.data.cartVersion,3);assert.match(page.data.checkoutUpgradeMessage,/尚未发起付款/)
 })
 test(`${platform}: accepting on old table cannot overwrite a new table`,async()=>{
  const {page,api,setScope}=fixture();await page.loadCheckoutUpgrade();let resolve;api.decide=()=>new Promise(r=>{resolve=r});const pending=page.acceptCheckoutUpgrade()
  setScope('table-b');page.data.cartVersion=9;page.data.busy=false;resolve({opportunity:{status:'accepted'}});await pending
  assert.equal(page.data.cartVersion,9);assert.equal(page.data.busy,false)
 })
 test(`${platform}: unknown write plus failed refresh cannot submit the old cart`,async()=>{
  const {page,api}=fixture();await page.loadCheckoutUpgrade();api.decide=async()=>{throw Error('unknown')};page.refreshSharedCart=async()=>false
  await page.acceptCheckoutUpgrade();assert.equal(page.data.checkoutUpgradeNeedsRefresh,true);assert.equal(await page.checkoutUpgradeReady(),false)
  page.refreshSharedCart=async()=>true;assert.equal(await page.checkoutUpgradeReady(),false);assert.equal(page.data.checkoutUpgradeNeedsRefresh,false)
  assert.equal(await page.checkoutUpgradeReady(),true)
 })
 test(`${platform}: required choices do not mutate until selection and explicit confirmation`,async()=>{
  const {page,api,offer}=fixture();offer.variants=[{id:'first',label:'鸡尾酒A；小食X'},{id:'second',label:'鸡尾酒A；小食Y'}]
  let writes=0,selected;api.decide=async(id,action,variantId)=>{writes++;selected=variantId;return{opportunity:{...offer,status:'accepted',replacementPortionId:'new'}}}
  await page.loadCheckoutUpgrade();await page.acceptCheckoutUpgrade();assert.equal(page.data.checkoutUpgradeChoicesOpen,true);assert.equal(writes,0)
  await page.acceptCheckoutUpgrade();assert.equal(writes,0);assert.equal(page.data.cartVersion,2)
  page.chooseCheckoutUpgradeVariant({detail:{value:2}});assert.equal(page.data.cartVersion,2)
  await page.acceptCheckoutUpgrade();assert.equal(writes,1);assert.equal(selected,'second');assert.equal(page.data.cartVersion,3)
 })
 test(`${platform}: cancelling required choices retains original cart and coupons`,async()=>{
  const {page,offer}=fixture();offer.variants=[{id:'first',label:'小食X'}];page.data.couponSelections=[{portionId:'old',benefitId:'coupon'}]
  await page.loadCheckoutUpgrade();await page.acceptCheckoutUpgrade();page.declineCheckoutUpgrade()
  assert.equal(page.data.cartVersion,2);assert.equal(page.data.couponSelections[0].benefitId,'coupon');assert.equal(page.data.checkoutUpgradeChoicesOpen,false)
 })
}
