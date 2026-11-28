import {fixture} from './miniprogram-state-fixture.cjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import {loadMiniModule} from './load-miniprogram-test-module.mjs'
const markup=readFileSync(new URL('../miniprogram/pages/order/index.wxml',import.meta.url),'utf8')
const amountExpression=markup.match(/class="checkout-confirm__total-price">{{([^}]+)}}/)[1]
const buttonExpression=markup.match(/bindtap="confirmCheckout"[^>]+>{{([^}]+)}}/)[1]
function display(patch={}){const data={couponQuote:null,couponQuoteTotal:'',couponReviewRequired:false,couponNeedsReview:false,couponSelections:[],pointsInput:'',cartTotal:'¥100.00',checkoutLocked:false,prepayment:null,ticketPreview:null,ticketChoice:'',...patch};return{amount:vm.runInNewContext(amountExpression,data),button:vm.runInNewContext(buttonExpression,data)}}
test('Mini checkout displays quoted payable, including zero and decimal amounts',()=>{
 for(const n of [9000,8000,1234,0])assert.equal(display({couponQuote:{payableMinor:n},couponQuoteTotal:'¥'+(n/100).toFixed(2)}).amount,'¥'+(n/100).toFixed(2))
})
test('Mini missing quote never silently shows full price as a reviewed amount',()=>{
 for(const patch of [{couponNeedsReview:true},{couponReviewRequired:true},{couponSelections:[{portionId:'a'}]},{pointsInput:'10'}])assert.equal(display(patch).amount,'待确认')
 assert.equal(display().amount,'¥100.00')
})
test('Mini zero due confirms order without suggesting another payment',()=>{
 for(const q of [{sourceType:'channel_quote',payableMinor:0},{pointsUsed:10,payableMinor:0}])assert.equal(display({couponQuote:q,couponQuoteTotal:'¥0.00'}).button,'确认下单')
 assert.equal(display({couponQuote:{payableMinor:9000}}).button,'确认支付')
 assert.equal(display({prepayment:{}}).button,'确认抵扣并下单')
 assert.equal(display({checkoutLocked:true,couponQuote:{payableMinor:0}}).button,'订单确认中')
})
test('expired or mismatched quotes clear misleading payable text and retain review intent',()=>{
 const utils=loadMiniModule(new URL('../miniprogram/utils/checkout-coupons.js',import.meta.url))
 for(const patch of [{expiresAt:'2000-01-01'},{generation:2},{version:9},{current:false}]){
  const page={data:{...structuredClone(utils.initialCheckoutCoupons),cart:[],cartGeneration:1,cartVersion:2,couponQuoteTotal:'¥90.00',couponQuote:{current:true,generation:1,version:2,expiresAt:new Date(Date.now()+60000).toISOString(),sourceType:'channel_quote',payableMinor:9000,...patch}},setData(v){Object.assign(this.data,v)},...utils.checkoutCouponMethods({})}
  assert.equal(page.couponCheckoutReady(),false);assert.equal(page.data.couponQuote,null);assert.equal(page.data.couponQuoteTotal,'');assert.equal(display(page.data).amount,'待确认')
 }
})

test('hiding channel checkout retains review intent instead of silently restoring full price',()=>{
 const {page}=fixture('order',{},'miniprogram')
 page.setData({couponQuote:{sourceType:'channel_quote',payableMinor:9000},couponQuoteTotal:'¥90.00',couponSelections:[],pointsInput:''})
 page.onHide();assert.equal(page.data.couponQuote,null);assert.equal(page.data.couponNeedsReview,true);assert.equal(display(page.data).amount,'待确认')
 page.skipCheckoutCoupons();assert.equal(page.data.couponNeedsReview,false)
})

test('Alipay and WeChat share pending-quote and zero-due display expressions',()=>{
 const ali=readFileSync(new URL('../alipay-miniprogram/pages/order/index.axml',import.meta.url),'utf8')
 const aliAmount=ali.match(/class="checkout-confirm__total-price">{{([^}]+)}}/)[1]
 const aliButton=ali.match(/onTap="confirmCheckout"[^>]+>{{([^}]+)}}/)[1]
 for(const amount of [0,100]) {
   const data={checkoutLocked:false,couponQuote:{payableMinor:amount},prepayment:null}
   assert.equal(vm.runInNewContext(aliButton,data).startsWith('确认下单'),display(data).button === '确认下单')
   assert.equal(vm.runInNewContext(aliAmount,{...data,couponQuoteTotal:'¥'+(amount/100).toFixed(2)}),display({...data,couponQuoteTotal:'¥'+(amount/100).toFixed(2)}).amount)
 }
 assert.equal(display({ticketPreview:{},ticketChoice:'points',couponQuote:{payableMinor:6000},couponQuoteTotal:'¥60.00'}).button,'确认支付')
})
