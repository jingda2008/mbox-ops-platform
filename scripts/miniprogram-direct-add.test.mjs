import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'
import {createOrderPage} from './test-support/order-performance-harness.mjs'
const event=id=>({currentTarget:{dataset:{id}}})
for(const kind of ['single','bundle']) {
 test(`menu plus adds ${kind} without opening details`,async()=>{
  const h=createOrderPage();h.menu[0].productKind=kind
  try {await h.page.preparePage();await h.page.addProduct(event('p-0'));assert.equal(h.page.data.cartCount,1);assert.equal(h.page.data.detailProduct,null);assert.equal(h.state.calls.filter(x=>x==='add').length,1)}finally{h.dispose()}
 })
}
test('configurable bundle requires choices and only adds after explicit confirmation',async()=>{
 const h=createOrderPage();Object.assign(h.menu[0],{productKind:'bundle',bundleChoiceGroups:[{id:'choice',name:'饮品',selectionCount:1,options:[{productId:'p-1',name:'饮品一',available:true}]}]})
 try {await h.page.preparePage();await h.page.addProduct(event('p-0'));assert.equal(h.page.data.cartCount,0);assert.equal(h.page.data.detailSelectionsComplete,false);await h.page.confirmBundleProduct();assert.equal(h.state.calls.includes('add'),false);h.page.selectBundleChoice({currentTarget:{dataset:{group:'choice',product:'p-1'}}});assert.equal(h.page.data.detailSelectionsComplete,true);await h.page.confirmBundleProduct();assert.equal(h.page.data.cartCount,1);assert.equal(h.page.data.detailProduct,null)}finally{h.dispose()}
})
test('menu action area does not bubble into detail, and choice actions are visibly named',async()=>{
 const source=await readFile('miniprogram/pages/order/index.wxml','utf8')
 const start=source.indexOf('<view class="section-title"><text>菜单</text>')
 const active=source.slice(start,source.indexOf('<view wx:if="{{recommendationQuestionVisible && recommendationQuestion}}"',start))
 const card=active.match(/<view wx:for="\{\{visibleProducts\}\}"[^>]+>/)?.[0]
 assert.ok(card);assert.doesNotMatch(card,/bindtap="openProductDetail"/)
 assert.match(active,/catchtap="addProduct"[^>]*>\{\{item.bundleChoiceGroups.length \? '选规格' : '＋'\}\}/)
 assert.match(source,/class="product-detail-mask sheet-mask" style="bottom: \{\{\(customTabBarHeight \|\| 50\) \+ 1\}\}px"/)
})
