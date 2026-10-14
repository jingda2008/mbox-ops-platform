import assert from 'node:assert/strict'
import test from 'node:test'
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
