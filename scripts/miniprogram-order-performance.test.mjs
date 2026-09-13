import assert from 'node:assert/strict'
import test from 'node:test'
import {createOrderPage, deferred, sleep} from './test-support/order-performance-harness.mjs'

for(const platform of ['miniprogram','alipay-miniprogram']) {
 test(`${platform}: stalled optional content and images do not block menu, adding or authority submit`,async()=>{
  const never=()=>new Promise(()=>{})
  const h=createOrderPage({platform,overrides:{getTodayPerformances:never,getMiniBootstrap:never,getCustomerBenefits:never,getRecommendationConfiguration:never,getWechatNotificationPrompt:never,getAlipayNotificationPrompt:never,getServiceRequests:never}})
  try{
   await Promise.race([h.page.preparePage(),sleep(200).then(()=>{throw Error('core blocked')})])
   assert.equal(h.page.data.orderReady,true);assert.equal(h.page.data.visibleProducts.length,180)
   await h.page.addProduct({currentTarget:{dataset:{id:'p-0'}}})
   assert.equal(h.page.data.cartCount,1);assert.equal(h.page.data.cartTotal,'¥8.00')
   await h.page.submitOrder(null,false)
   assert.equal(h.state.calls.filter(x=>x==='submit').length,1)
  }finally{h.dispose()}
 })
 test(`${platform}: menu is visible before cart but cannot mutate until cart is confirmed`,async()=>{
  const cart=deferred();const h=createOrderPage({platform,overrides:{getSharedCart:()=>cart.promise}})
  try{const load=h.page.preparePage();await sleep(20);assert.equal(h.page.data.loading,false);assert.equal(h.page.data.visibleProducts.length,180);assert.equal(h.page.data.orderReady,false)
   await h.page.addProduct({currentTarget:{dataset:{id:'p-0'}}});assert.equal(h.state.calls.includes('add'),false)
   cart.resolve(h.state.cart);await load;assert.equal(h.page.data.orderReady,true)
  }finally{h.dispose()}
 })
 test(`${platform}: old table menu and optional responses cannot replace a new scan`,async()=>{
  const old=deferred();const optional=deferred();let n=0;const h=createOrderPage({platform,overrides:{getMenu:()=>++n===1?old.promise:Promise.resolve([{productId:'new',name:'新桌商品',amountMinor:800,available:true}]),getTodayPerformances:()=>optional.promise}})
  try{const a=h.page.preparePage();await sleep(10);h.state.session={tableCode:'B02',tableToken:'test-b',cartScope:'scope-b',scanNonce:'scan-b'};await h.page.preparePage();old.resolve([{productId:'old',name:'旧商品'}]);optional.resolve(null);await a;await sleep(5);assert.equal(h.page.data.table.code,'B02');assert.equal(h.page.data.products[0].productId,'new')
  }finally{h.dispose()}
 })
 test(`${platform}: image failures preserve all products, searchable last item, price and valid writes`,async()=>{
  const h=createOrderPage({platform});try{await h.page.preparePage();let event={type:'error',currentTarget:{dataset:{id:'p-0',imageIndex:0,loadGeneration:h.page.data.menuImageGeneration}}};h.page.productImageFailed(event);h.page.productImageFailed(event)
   assert.equal(h.page.data.products.length,180);h.page.onSearchInput({detail:{value:'最后一款'}});assert.equal(h.page.data.visibleProducts.length,1);assert.equal(h.page.data.visibleProducts[0].productId,'p-179')
   await h.page.addProduct({currentTarget:{dataset:{id:'p-179'}}});assert.equal(h.page.data.cartCount,1)
  }finally{h.dispose()}
 })
 test(`${platform}: delayed old-table image errors do not alter the new menu`,async()=>{
  const h=createOrderPage({platform});try{await h.page.preparePage();const old=h.page.data.menuImageGeneration;h.state.session={tableCode:'B02',tableToken:'test-b',cartScope:'scope-b',scanNonce:'scan-b'};await h.page.preparePage();const before=h.page.data.products[0].listImageUrl
   h.page.productImageFailed({type:'error',currentTarget:{dataset:{id:'p-0',imageIndex:0,loadGeneration:old}}});assert.equal(h.page.data.products[0].listImageUrl,before);assert.equal(Boolean(h.page.data.products[0].imageFailed),false)
  }finally{h.dispose()}
 })
 test(`${platform}: failed bill read permits selection but blocks new payment until recovery`,async()=>{
  const h=createOrderPage({platform,overrides:{getTableOrders:async()=>{throw Error('offline')}}});try{await h.page.preparePage();assert.equal(h.page.data.orderReady,true);await h.page.addProduct({currentTarget:{dataset:{id:'p-0'}}});await h.page.submitOrder(null,false);assert.equal(h.state.calls.includes('submit'),false);assert.equal(h.page.data.cartCount,1)
  }finally{h.dispose()}
 })
 test(`${platform}: failed optional module retries alone without reloading cart`,async()=>{
  let calls=0;const h=createOrderPage({platform,overrides:{getTodayPerformances:async()=>{if(!calls++)throw Error('temporary');return null}}});try{await h.page.preparePage();await h.page.orderExtrasPending;assert.ok(h.page.data.performanceError);const cartReads=h.state.calls.filter(x=>x==='cart').length;await h.page.retryPerformance();assert.equal(h.page.data.performanceError,'');assert.equal(h.state.calls.filter(x=>x==='cart').length,cartReads)
  }finally{h.dispose()}
 })
 test(`${platform}: recommendation configuration retries without reloading essential data`,async()=>{
  let n=0;const h=createOrderPage({platform,overrides:{getRecommendationConfiguration:async()=>{if(!n++)throw Error('temporary');return {inputConfiguration:{version:1,questions:[]}}}}});try{await h.page.preparePage();await h.page.orderExtrasPending;assert.equal(h.page.orderExtraErrors.recommendation,true);const reads=h.state.calls.filter(x=>['menu','cart','orders'].includes(x)).length;await h.page.onRecommend();assert.equal(Boolean(h.page.orderExtraErrors.recommendation),false);assert.equal(h.state.calls.filter(x=>['menu','cart','orders'].includes(x)).length,reads)}finally{h.dispose()}
 })
 test(`${platform}: uncompleted first-screen images count as failures without storing identifiers in statistics`,async()=>{
  const h=createOrderPage({platform});try{await h.page.preparePage();h.page.menuDisplayStartedAt=Date.now()-15001;const result=h.page.getOrderPerformance();assert.equal(result.first_screen_image.count,4);assert.equal(result.first_screen_image.failureRate,1);assert.equal(result.first_screen_image.p95Ms,null);assert.equal(h.page.getOrderPerformance().first_screen_image.count,4);assert.doesNotMatch(JSON.stringify(result),/p-0|test-qr|example\.test/)}finally{h.dispose()}
 })
 test(`${platform}: diagnostics are bounded numerical summaries without customer or table identifiers`,()=>{
  const h=createOrderPage({platform});try{for(let i=0;i<100;i++)h.page.recordOrderTiming('add',Date.now(),i%3!==0);h.page.recordOrderTiming('test-private-id',Date.now(),true);const s=h.page.getOrderPerformance();assert.equal(s.add.count,60);assert.equal(s.add.failures,20);assert.deepEqual(Object.keys(s),['add']);assert.doesNotMatch(JSON.stringify(s),/table|customer|test-qr|product/)}finally{h.dispose()}
 })
}

test('Alipay retains its real payment-disabled guard while menu and selection remain available',async()=>{
 const h=createOrderPage({platform:'alipay-miniprogram',alipayPaymentEnabled:false});try{await h.page.preparePage();await h.page.addProduct({currentTarget:{dataset:{id:'p-0'}}});assert.equal(h.page.data.cartCount,1);await h.page.submitOrder(null,false);assert.equal(h.state.calls.includes('submit'),false);assert.match(h.page.data.error,/支付宝在线支付后端适配尚未接通/)}finally{h.dispose()}
})
