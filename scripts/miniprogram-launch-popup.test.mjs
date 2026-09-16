import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
const context={module:{exports:{}}}
vm.runInNewContext(readFileSync(new URL('../miniprogram/utils/launch-popup-policy.js',import.meta.url),'utf8'),context)
const {popupShouldDisplay}=context.module.exports
test('daily uses Shanghai day supplied by component; navigation and reopening same day do not repeat',()=>{
 const popup={enabled:true,title:'今日推荐',frequency:'daily'}
 assert.equal(popupShouldDisplay(popup,{day:'2026-09-17',storedDay:'2026-09-16'}),true)
 assert.equal(popupShouldDisplay(popup,{day:'2026-09-17',storedDay:'2026-09-17'}),false)
})
test('session and foreground frequency differ, disabled/unknown configuration remains silent',()=>{
 const popup={enabled:true,title:'推荐'}
 assert.equal(popupShouldDisplay({...popup,frequency:'session'},{sessionSeen:true}),false)
 assert.equal(popupShouldDisplay({...popup,frequency:'always'},{sessionSeen:true,foregroundSeen:false}),true)
 assert.equal(popupShouldDisplay({...popup,frequency:'always'},{foregroundSeen:true}),false)
 assert.equal(popupShouldDisplay({...popup,enabled:false,frequency:'daily'},{}),false)
 assert.equal(popupShouldDisplay({...popup,frequency:'invalid'},{}),false)
})

test('recommendation uses API price/image, handles missing price and uses full image and falls back to placeholder',async()=>{
 let component, navigatedTo
 const sandbox={Component:value=>component=value,require:name=>({
  '../../utils/auth':{ensureCustomerSession:async()=>{}},
  '../../utils/request':{request:async()=>({data:{enabled:true,title:'推荐',frequency:'always',products:[{id:'a',name:'套餐',amountMinor:250,currency:'CNY',imageUrl:'/menu/a.jpg'},{id:'b',amountMinor:null,imageUrl:null},...Array.from({length:6},(_,i)=>({id:'extra-'+i,name:'推荐'+i,amountMinor:4800,currency:'CNY',imageUrl:'/menu/'+i+'.jpg'}))]}})},
  '../../utils/media':{publicImageUrl:(value,variant)=>value?(variant==='menu'?'thumb:'+value:'original:'+value):''},
  '../../utils/format':{money:n=>'¥'+(n/100).toFixed(2)},
  '../../utils/launch-popup-policy':{popupShouldDisplay},
 })[name],getApp:()=>({globalData:{foregroundSequence:1}}),wx:{getStorageSync:()=>null,setStorageSync:()=>{},switchTab:options=>{navigatedTo=options.url}}}
 vm.runInNewContext(readFileSync(new URL('../miniprogram/components/launch-popup/index.js',import.meta.url),'utf8'),sandbox)
 const target={data:{},setData(patch){for(const [key,value]of Object.entries(patch)){const match=key.match(/^popup\.products\[(\d+)\]$/);if(match)this.data.popup.products[Number(match[1])]=value;else this.data[key]=value}},...component.methods}
 await target.loadPopup();assert.equal(target.data.popup.products[0].priceText,'¥2.50');assert.equal(target.data.popup.products[1].priceText,'价格待确认')
 target.imageFailed({currentTarget:{dataset:{index:0}}});assert.equal(target.data.popup.products[0].imageUrl,'original:/menu/a.jpg');assert.equal(target.data.popup.products[0].imageFailed,true)
 assert.equal(target.data.popup.products.length,8)
 for(let current=0;current<8;current++){target.changeSlide({detail:{current}});assert.equal(target.data.currentIndex,current)}
 target.changeSlide({detail:{current:8}});assert.equal(target.data.currentIndex,7)
 target.order();assert.equal(target.data.visible,false);assert.equal(navigatedTo,'/pages/order/index')
 await target.loadPopup();assert.equal(target.data.currentIndex,0);assert.equal(target.data.visible,true)
 target.close();assert.equal(target.data.visible,false)
})
