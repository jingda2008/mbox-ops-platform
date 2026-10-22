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
