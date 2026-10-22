import assert from 'node:assert/strict'
import test from 'node:test'
import {createOrderPage,deferred} from './test-support/order-performance-harness.mjs'
for(const platform of ['miniprogram','alipay-miniprogram']) {
 test(`${platform}: minute refresh updates availability without resetting the page or dropping cart portions`,async()=>{
  let read=0
  const h=createOrderPage({platform,overrides:{getMenu:async()=>[{productId:'p-0',name:'限时菜品',amountMinor:800,available:read++===0,unavailableReason:'本时段已结束'}]}})
  try {
   await h.page.preparePage();await h.page.addProduct({currentTarget:{dataset:{id:'p-0'}}})
   const request=h.page.currentTableRequest(),cartCount=h.page.data.cartCount
   assert.ok(h.page.menuWindowTimer)
   assert.equal(await h.page.refreshMenuWindow(request),true)
   assert.equal(h.page.data.products[0].available,false)
   assert.equal(h.page.data.cartCount,cartCount)
   assert.equal(h.page.currentTableRequest().generation,request.generation)
   h.page.stopMenuWindowRefresh();assert.equal(h.page.menuWindowTimer,null)
  } finally {h.dispose()}
 })
 test(`${platform}: a boundary refresh from the previous table cannot change the new menu`,async()=>{
  const h=createOrderPage({platform});try{
   await h.page.preparePage();const old=h.page.currentTableRequest()
   h.state.session={tableCode:'B02',tableToken:'new-token',cartScope:'new-scope',scanNonce:'new'}
   await h.page.preparePage();const before=h.page.data.products
   assert.equal(await h.page.refreshMenuWindow(old),false);assert.equal(h.page.data.products,before)
  } finally{h.dispose()}
 })
}
for(const platform of ['miniprogram','alipay-miniprogram']) {
 test(`${platform}: failed minute refresh retains menu and original payment, explicit retry clears the warning`,async()=>{
  let fail=false
  const h=createOrderPage({platform,overrides:{getMenu:async()=>{if(fail)throw Error('offline');return [{productId:'p-0',name:'原菜',amountMinor:800,available:true}]}}})
  try{
   await h.page.preparePage();await h.page.addProduct({currentTarget:{dataset:{id:'p-0'}}})
   const products=h.page.data.products,cartCount=h.page.data.cartCount,original={key:'unknown-payment',orderId:'original-order'}
   h.page.checkoutOperation=original;fail=true
   assert.equal(await h.page.refreshMenuWindow(h.page.currentTableRequest()),false)
   assert.equal(h.page.data.menuUpdatePending,true);assert.equal(h.page.data.products,products);assert.equal(h.page.data.cartCount,cartCount);assert.equal(h.page.checkoutOperation,original)
   fail=false;await h.page.retryMenuWindow()
   assert.equal(h.page.data.menuUpdatePending,false);assert.equal(h.page.data.menuUpdateBusy,false);assert.ok(h.page.data.menuUpdatedAt);assert.equal(h.page.checkoutOperation,original)
  }finally{h.dispose()}
 })
 test(`${platform}: a late failed refresh cannot put the new table into stale state`,async()=>{
  const pending=deferred();let failLater=false
  const h=createOrderPage({platform,overrides:{getMenu:async()=>failLater?pending.promise:[{productId:'p-0',name:'菜',amountMinor:800,available:true}]}})
  try{
   await h.page.preparePage();failLater=true;const old=h.page.refreshMenuWindow(h.page.currentTableRequest())
   failLater=false;h.state.session={tableCode:'B02',tableToken:'new-token',cartScope:'new-scope',scanNonce:'new'};await h.page.preparePage()
   pending.reject(Error('old offline'));await old;assert.equal(h.page.data.menuUpdatePending,false)
  }finally{h.dispose()}
 })
 test(`${platform}: scheduled item uses authoritative full-window explanation instead of old daily hours`,async()=>{
  const h=createOrderPage({platform,overrides:{getMenu:async()=>[{productId:'p-0',name:'菜',amountMinor:800,available:false,availabilityStatus:'scheduled',availableFrom:'18:00',availableUntil:'23:00',availabilityDetail:'供应日期尚未开始。2026-11-01 周日 20:00–22:00。请改选其他商品。'}]}})
  try{await h.page.preparePage();assert.match(h.page.data.products[0].availabilityDetail,/2026-11-01/);assert.doesNotMatch(h.page.data.products[0].availabilityDetail,/18:00/)}finally{h.dispose()}
 })
 test(`${platform}: an older failed read cannot restore the warning after a newer successful check`,async()=>{
  const pending=deferred();let oldRead=false
  const h=createOrderPage({platform,overrides:{getMenu:async()=>oldRead?pending.promise:[{productId:'p-0',name:'菜',amountMinor:800,available:true}]}})
  try{
   await h.page.preparePage();oldRead=true;const old=h.page.refreshMenuWindow(h.page.currentTableRequest())
   oldRead=false;await h.page.retryMenuWindow();pending.reject(Error('old offline'));await old
   assert.equal(h.page.data.menuUpdatePending,false);assert.equal(h.page.data.menuUpdateBusy,false)
  }finally{h.dispose()}
 })
 test(`${platform}: leaving and returning releases only the old read busy flag so menu checking remains usable`,async()=>{
  const pending=deferred();let oldRead=false
  const h=createOrderPage({platform,overrides:{getMenu:async()=>oldRead?pending.promise:[{productId:'p-0',name:'菜',amountMinor:800,available:true}]}})
  try{
   await h.page.preparePage();oldRead=true;const old=h.page.retryMenuWindow();assert.equal(h.page.data.menuUpdateBusy,true)
   h.page.onHide();oldRead=false;await h.page.onShow();assert.equal(h.page.data.menuUpdateBusy,false)
   pending.reject(Error('hidden offline'));await old;assert.equal(h.page.data.menuUpdatePending,false)
  }finally{h.dispose()}
 })
}
