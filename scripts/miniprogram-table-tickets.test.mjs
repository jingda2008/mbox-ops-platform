import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import {loadMiniModule} from './load-miniprogram-test-module.mjs'

const pageUrl=new URL('../miniprogram/pages/table-tickets/index.js',import.meta.url)
const source=readFileSync(pageUrl,'utf8')
function fixture(){
  const calls=[],offer={id:'public-offer',areaId:'window',name:'靠窗桌票',priceMinor:50000,giftPoints:550,startsAt:'2026-11-23T12:00:00Z',endsAt:'2026-11-23T19:00:00Z',remaining:3}
  let member=null,page
  const api={
    getTableTicketOffers:async()=>[offer],getMiniBootstrap:async()=>({membership:member,membershipTerms:{version:7}}),
    getMyTableTickets:async()=>[],getTicketProposals:async()=>[],getTicketReservations:async()=>[],getVerifiedPhones:async()=>[{maskedPhone:'138****1234'}],
    enrollMembership:async(version,_,code)=>{calls.push(['enroll',version,code]);member={id:'member'}},
    buyTableTickets:async input=>{calls.push(['buy',input.quantity]);return {registrationPublicId:'original'}},
    getActivityRegistrationPayment:async()=>({allowedActions:['start_payment']}),
    startActivityRegistrationPayment:async(id,key)=>{calls.push(['present',id,key]);return {providerAction:{status:'unknown'}}},
    queryActivityRegistrationPayment:async id=>calls.push(['query',id]),
  }
  vm.runInNewContext(source,{require:name=>name.endsWith('/api')?api:name.endsWith('/id')?{randomId:()=> 'operation'}:loadMiniModule(new URL(name+'.js',pageUrl)),
    Page:object=>{page=object;page.setData=patch=>Object.assign(page.data,patch)},wx:{requestPayment:()=>{throw Error('Unexpected payment sheet')}}})
  page.onLoad({id:offer.id,quantity:'2'})
  return {page,calls,api}
}

test('分享带入桌数，拒绝手机号授权仍可看票，授权后沿用原选择',async()=>{
  const {page,calls}=fixture()
  await page.refresh()
  assert.equal(page.data.quantity,'2')
  assert.match(page.data.summary,/1000\.00.*1100/)
  assert.equal(page.data.member,null)
  await page.authorize({detail:{errMsg:'deny'}})
  assert.match(page.data.error,/未授权/)
  assert.deepEqual(calls,[])
  await page.authorize({detail:{code:'phone-code'}})
  assert.deepEqual(calls,[['enroll',7,'phone-code']])
  assert.equal(page.data.member.id,'member')
  assert.equal(page.data.selected.id,'public-offer')
  assert.match(page.onShareAppMessage().path,/quantity=2$/)
})

test('未确认条款不建单，支付未明先查原单，再点确认不产生第二笔',async()=>{
  const {page,calls}=fixture()
  await page.refresh()
  await page.authorize({detail:{code:'phone-code'}})
  await page.buy()
  assert.equal(calls.length,1)
  page.agree({detail:{value:['yes']}})
  await page.buy()
  assert.equal(page.data.originalOrder,'original')
  assert.deepEqual(calls.slice(1),[['buy',2],['present','original','tt-pay-original'],['query','original']])
  page.agree({detail:{value:['yes']}})
  await page.buy()
  assert.equal(calls.length,4)
  page.chooseAnother()
  assert.equal(page.data.agreed,false)
})

test('页面离开后返回的支付状态不会调起微信收款',async()=>{
  const {page,api,calls}=fixture()
  let release
  api.getActivityRegistrationPayment=()=>new Promise(resolve=>{release=resolve})
  const pending=page.payOriginal('original')
  page.onHide()
  release({allowedActions:['start_payment']})
  await pending
  assert.deepEqual(calls,[])
})
