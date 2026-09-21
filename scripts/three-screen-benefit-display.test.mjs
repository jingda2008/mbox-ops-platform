import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import vm from 'node:vm'
for(const platform of ['miniprogram','alipay-miniprogram'])test(`${platform}: pickup undo changes current fulfillment copy without granting another claim`,async()=>{
  const source=await readFile(new URL(`../${platform}/pages/member-center/index.js`,import.meta.url),'utf8')
  let page;let fulfillment='ready'
  vm.runInNewContext(source,{Page(value){page=value;page.setData=next=>Object.assign(page.data,next)},require(name){
    if(name.endsWith('/api'))return {getMiniBootstrap:async()=>({annualBenefitCalendar:[{id:'original-grant',kind:'daily_snack',status:'redeemed',factState:'fulfilled',currentFulfillmentStatus:fulfillment,claimable:false,redeemable:false,quantity:1}]})}
    if(name.endsWith('/format'))return {money:String,dateTime:String}
    if(name.endsWith('/customer-error'))return {customerErrorMessage:(_error,fallback)=>fallback}
    return {getRuntimeConfig:()=>({})}
  }})
  await page.load();assert.equal(page.data.calendarItems.length,1);assert.equal(page.data.calendarItems[0].claimable,false)
  assert.match(page.data.calendarItems[0].quantityText,/待取.*无需重新申请/)
  assert.equal(page.data.calendarItems[0].factState,'fulfilled')
  fulfillment='pending';await page.load();assert.match(page.data.calendarItems[0].quantityText,/制作.*无需重新申请/)
  fulfillment='delivered';await page.load();assert.match(page.data.calendarItems[0].quantityText,/完成制作并送达/)
})
