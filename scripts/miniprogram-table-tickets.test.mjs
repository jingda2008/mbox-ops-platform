import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import {loadMiniModule} from './load-miniprogram-test-module.mjs'

const pageUrl=new URL('../miniprogram/pages/table-tickets/index.js',import.meta.url)
const source=readFileSync(pageUrl,'utf8')
function fixture(showModal,requestPayment=()=>{throw Error('Unexpected payment sheet')},extraWx={}){
  const calls=[],offer={id:'public-offer',areaId:'window',name:'靠窗桌票',priceMinor:50000,giftPoints:550,startsAt:'2026-11-23T12:00:00Z',endsAt:'2026-11-23T19:00:00Z',remaining:3}
  let member=null,page
  const api={
    getTableTicketOffers:async()=>[offer],getMiniBootstrap:async()=>({membership:member,membershipTerms:{version:7}}),
    getMyTableTickets:async()=>[],getTicketProposals:async()=>[],getTicketReservations:async()=>[],getVerifiedPhones:async()=>[{maskedPhone:'138****1234'}],
    enrollMembership:async(version,_,code)=>{calls.push(['enroll',version,code]);member={memberNo:'M001'}},
    buyTableTickets:async input=>{calls.push(['buy',input.quantity]);return {registrationPublicId:'original'}},
    getActivityRegistrationPayment:async()=>({allowedActions:['start_payment']}),
    startActivityRegistrationPayment:async(id,key)=>{calls.push(['present',id,key]);return {providerAction:{status:'unknown'}}},
    queryActivityRegistrationPayment:async id=>calls.push(['query',id]),
  }
  vm.runInNewContext(source,{require:name=>name.endsWith('/api')?api:name.endsWith('/id')?{randomId:()=> 'operation'}:loadMiniModule(new URL(name+'.js',pageUrl)),
    Page:object=>{page=object;page.setData=patch=>Object.assign(page.data,patch)},wx:{showModal,requestPayment,...extraWx}})
  page.onLoad({id:offer.id,quantity:'2'})
  return {page,calls,api}
}

test('购票须知展示本票档桌号，旧单只读购票时保存的适用区域',async()=>{
  const {page,api}=fixture()
  const [offer]=await api.getTableTicketOffers()
  let codes=['A01','A03']
  api.getTableTicketOffers=async()=>[{...offer,areaName:'中间 A 区',deskCodes:codes}]
  api.getMiniBootstrap=async()=>({membership:{memberNo:'M001'}})
  api.getMyTableTickets=async()=>[
    {purchaseTerms:{area:'原 A 区',deskCodes:['A02','A05']},tickets:[]},
    {purchaseTerms:{area:'窗边区'},tickets:[]},
    {tickets:[]},
  ]
  await page.refresh()
  assert.equal(page.data.selected.areaText,'中间 A 区 · A01、A03')
  assert.equal(page.data.mine[0].purchasedAreaText,'原 A 区 · A02、A05')
  assert.equal(page.data.mine[1].purchasedAreaText,'窗边区')
  assert.equal(page.data.mine[2].purchasedAreaText,'')
  page.agree({detail:{value:['yes']}})
  codes=['A03']
  await page.refresh()
  assert.equal(page.data.agreed,false)
  assert.equal(page.data.selected.areaText,'中间 A 区 · A03')
  codes=null
  await page.refresh()
  assert.equal(page.data.selected.areaText,'中间 A 区')
})

test('确认后刷新票档，余量变化保留确认，赠分、退款或有效期变化须重读',async()=>{
  const {page,api}=fixture()
  const [offer]=await api.getTableTicketOffers()
  api.getTableTicketOffers=async()=>[offer]
  await page.refresh()
  page.agree({detail:{value:['yes']}})
  offer.remaining=2
  await page.refresh()
  assert.equal(page.data.agreed,true)
  for(const change of [{refundSchedule:'开演前可全额退票'},{giftPoints:0},{validThroughIfPaidToday:'2027-11-25'}]){
    page.agree({detail:{value:['yes']}})
    Object.assign(offer,change)
    await page.refresh()
    assert.equal(page.data.agreed,false)
  }
})

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
  assert.equal(page.data.member.memberNo,'M001')
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

test('改期及错户消费由会员逐项确认，取消或连点不重复提交',async()=>{
  let modal
  const {page,api,calls}=fixture(options=>{modal=options})
  api.decideTicketMove=async(id,accept)=>calls.push(['move',id,accept])
  api.confirmTicketUse=async id=>calls.push(['use',id])
  for(const [method,action,confirm] of [['changeShow','accept',false],['changeShow','decline',true],['changeShow','accept',true],['confirmUse','',true]]){
    const event={currentTarget:{dataset:{id:'original',action,points:200}}}
    const first=page[method](event)
    assert.equal(page.data.busy,true)
    await page[method](event)
    modal.success({confirm})
    await first
    assert.equal(page.data.busy,false)
  }
  assert.deepEqual(calls,[['move','original',false],['move','original',true],['use','original']])
})

test('离开后重进，旧页面延迟返回的支付请求不会启动付款',async()=>{
  const {page,api,calls}=fixture()
  let release
  api.getActivityRegistrationPayment=()=>new Promise(resolve=>{release=resolve})
  const pending=page.payOriginal('previous-order')
  page.onHide()
  page.onShow()
  release({allowedActions:['start_payment']})
  await pending
  assert.deepEqual(calls,[])
})

test('回访身份读取失败时隐藏原会员入场码、手机号和原单，重新识别后仅本人恢复原单',async()=>{
  const {page,api}=fixture()
  await page.refresh()
  await page.authorize({detail:{code:'phone-code'}})
  page.agree({detail:{value:['yes']}})
  await page.buy()
  api.getMyTableTickets=async()=>[{totalMinor:50000,tickets:[{doorCode:'FIRST-MEMBER',expiresAt:'2027-11-23T08:00:00Z'}]}]
  await page.refresh()
  assert.equal(page.data.mine[0].tickets[0].doorCode,'FIRST-MEMBER')
  const bootstrap=api.getMiniBootstrap
  page.onHide()
  api.getMiniBootstrap=async()=>{throw Error('身份暂时无法读取')}
  await page.onShow()
  assert.equal(page.data.mine.length,0)
  assert.equal(page.data.originalOrder,null)
  assert.equal(page.data.phone,null)
  assert.equal(page.data.member,null)
  api.getMiniBootstrap=bootstrap
  await page.refresh()
  assert.equal(page.data.originalOrder,'original')
  api.getMiniBootstrap=async()=>({membership:{memberNo:'M002'}})
  api.getMyTableTickets=async()=>[]
  page.onHide()
  await page.onShow()
  assert.equal(page.data.originalOrder,null)
  assert.equal(page.data.member.memberNo,'M002')
})

test('原订桌不再可用或退票条款更新时重新确认，再买一单清除旧桌号',async()=>{
  const {page,api}=fixture()
  const [offer]=await api.getTableTicketOffers()
  offer.refundVersion='v1'
  const row={id:'old-lock',areaId:offer.areaId,startsAt:offer.startsAt,endsAt:offer.endsAt}
  api.getTicketReservations=async()=>[row]
  await page.refresh()
  await page.authorize({detail:{code:'phone-code'}})
  page.chooseReservation({detail:{value:'old-lock'}})
  page.agree({detail:{value:['yes']}})
  api.getTicketReservations=async()=>[]
  await page.refresh()
  assert.equal(page.data.reservationLockId,null)
  assert.equal(page.data.agreed,false)
  page.agree({detail:{value:['yes']}})
  offer.refundVersion='v2'
  await page.refresh()
  assert.equal(page.data.agreed,false)
  api.getTicketReservations=async()=>[row]
  await page.refresh()
  page.chooseReservation({detail:{value:'old-lock'}})
  page.chooseAnother()
  assert.equal(page.data.reservationLockId,null)
})

test('顾客补款确认防连点，离开又重进后旧确认作废',async()=>{
  for(const [method,endpoint] of [['confirmDining','confirmTicketDining']]){
    const modals=[]
    const {page,api,calls}=fixture(options=>modals.push(options))
    api[endpoint]=async()=>calls.push(endpoint)
    const event={currentTarget:{dataset:{id:'dish',amount:50000,merchant:5000,ticket:'ticket',order:'order'}}}
    const first=page[method](event)
    const second=page[method](event)
    assert.equal(modals.length,1)
    if(method==='confirmDining')assert.match(modals[0].content,/顾客应补.*500.*门店承担.*50/)
    modals[0].success({confirm:true,content:'因故退票'})
    await Promise.all([first,second])
    assert.deepEqual(calls,[endpoint])
    const stale=page[method](event)
    page.onHide()
    await page.onShow()
    modals[1].success({confirm:true,content:'因故退票'})
    await stale
    assert.deepEqual(calls,[endpoint])
    assert.equal(page.data.busy,false)
  }
})

test('支付面板返回时页面已隐藏，仅原会员下次进入核对该单支付结果',async()=>{
  for(const switchMember of [false,true]){
    let opened
    const sheet=new Promise(resolve=>{opened=resolve})
    const {page,api,calls}=fixture(undefined,opened)
    await page.refresh()
    await page.authorize({detail:{code:'phone-code'}})
    api.startActivityRegistrationPayment=async()=>({providerAction:{status:'pending',presentation:'jsapi',
      payload:{timeStamp:'1',nonceStr:'n',package:'p',signType:'RSA',paySign:'signature'}}})
    const payment=page.payOriginal('first-order')
    const modal=await sheet
    page.onHide()
    modal.success()
    await payment
    assert.equal(calls.filter(c=>c[0]==='query').length,0)
    if(switchMember)api.getMiniBootstrap=async()=>({membership:{memberNo:'M002'}})
    await page.onShow()
    await page.refresh()
    assert.deepEqual(calls.filter(c=>c[0]==='query'),switchMember?[]:[['query','first-order']])
  }
})

test('购票回执晚于页面回访时保留本人原单，换会员不展示或继续其支付',async()=>{
  for(const switchMember of [false,true]){
    const {page,api,calls}=fixture()
    await page.refresh()
    await page.authorize({detail:{code:'phone-code'}})
    page.agree({detail:{value:['yes']}})
    let finish
    api.buyTableTickets=()=>new Promise(resolve=>{finish=resolve})
    const attempt=page.buy()
    page.onHide()
    if(switchMember)api.getMiniBootstrap=async()=>({membership:{memberNo:'M002'}})
    await page.onShow()
    finish({registrationPublicId:'delayed-first'})
    await attempt
    assert.equal(page.data.originalOrder,switchMember?null:'delayed-first')
    assert.deepEqual(calls.map(c=>c[0]),['enroll'])
  }
})

test('menu shows individual ticket cards in browse and seated menus, filters by category/date and ignores stale offers', async () => {
  const {createOrderPage, deferred} = await import('./test-support/order-performance-harness.mjs')
  const first = {id:'middle', title:'周五演出', name:'中区整桌票', areaName:'A区', priceMinor:50000, giftPoints:550,
    remaining:2, startsAt:'2026-11-27T12:00:00Z', endsAt:'2026-11-27T16:30:00Z', coverUrl:'/menu/poster.jpg'}
  const second = {...first, id:'vip', name:'VIP卡座', categoryCode:'special', categoryName:'限定活动',
    startsAt:'2026-11-28T12:00:00Z', endsAt:'2026-11-28T16:30:00Z', saleState:'upcoming', coverUrl:null}
  const stale = deferred()
  let source = [first, second]
  const h = createOrderPage({menuCount:2, overrides:{getTableTicketOffers:() => source}})
  const page = h.page
  const select = code => page.selectCategory({currentTarget:{dataset:{code}}})
  try {
    for (const browse of [true, false]) {
      if (browse) await page.loadBrowseData()
      else await page.preparePage()
      await page.loadTableTicketOffers()
      select('all')
      assert.equal(page.data.visibleProducts.length, 2)
      assert.equal(page.data.visibleTickets.length, 2)
      assert.equal(page.data.categoryPreview.find(c => c.name === '门票').code, page.data.ticketCategoryCode)
      select(page.data.ticketCategoryCode)
      assert.equal(page.data.visibleProducts.length, 0)
      assert.equal(page.data.visibleTickets[0].price, '¥500.00')
      assert.equal(page.data.visibleTickets[0].giftPoints, 550)
      assert.match(page.data.visibleTickets[0].cover, /menu-thumbnail/)
      page.chooseTicketDay({currentTarget:{dataset:{day:'2026-11-28'}}})
      assert.equal(page.data.visibleTickets[0].saleText, '待开售')
      assert.equal(page.data.visibleTickets.length, 1)
      page.chooseTicketDay({currentTarget:{dataset:{day:''}}})
      select('special')
      assert.equal(page.data.visibleTickets[0].id, 'vip')
      select('all')
      page.onSearchInput({detail:{value:'A区'}})
      assert.equal(page.data.visibleProducts.length, 0)
      assert.equal(page.data.visibleTickets.length, 2)
      page.clearMenuSearch()
    }
    source = stale.promise
    const previous = page.loadTableTicketOffers()
    source = []
    await page.loadTableTicketOffers()
    stale.resolve([first])
    await previous
    assert.equal(page.data.visibleTickets.length, 0)
    assert.equal(page.data.categories.some(c => c.name === '门票'), false)
    assert.equal(page.data.visibleProducts.length, 2)
    const markup = readFileSync(new URL('../miniprogram/pages/order/index.wxml',import.meta.url),'utf8')
    assert.equal((markup.match(/<template is="menuTicketCard"/g)||[]).length, 2)
    const card = markup.match(/<template name="menuTicketCard">([\s\S]+?)<\/template>/)[1]
    assert.match(card, /class="product-row"[^>]+url="\/pages\/table-tickets\/index\?id={{ticket.id}}"/)
    assert.doesNotMatch(card, /addProduct|checkoutSharedCart/)
    assert.doesNotMatch(markup, /tableTicketOffers.length/)
  } finally { h.dispose() }
})

test('购票页切换须知不代替勾选，增减桌数遵守可售量及代选单锁定', async () => {
  const {page} = fixture()
  await page.refresh()
  page.toggleRules()
  assert.equal(page.data.rulesOpen, true)
  assert.equal(page.data.agreed, false)
  const step = delta => page.stepQuantity({currentTarget:{dataset:{delta}}})
  step(1)
  assert.equal(page.data.quantity, '3')
  assert.match(page.data.summary, /1500\.00.*1650/)
  step(1)
  assert.equal(page.data.quantity, '3')
  page.setData({reservationLockId:'own-table'})
  step(1)
  assert.equal(page.data.quantity, '4')
  page.setData({proposalId:'staff-proposal'})
  step(-1)
  assert.equal(page.data.quantity, '4')
})

test('联系门店仅复制选中原票或拨打原单客服，页面关闭后不泄露原票',()=>{
  let menu, copied, number
  const {page,calls}=fixture(undefined,undefined,{
    showActionSheet:options=>{menu=options},
    setClipboardData:({data})=>{copied=data},
    makePhoneCall:({phoneNumber})=>{number=phoneNumber},
  })
  page.visible=true
  page.data.mine=[{registrationPublicId:'TT-ONE',name:'A区整桌票',time:'周五 20:00',quantity:3,purchaseTerms:{serviceContact:'021-12345678'},tickets:[{id:'ticket-two',number:2}]}]
  page.contactStoreForTicket({currentTarget:{dataset:{order:'TT-ONE',ticket:'ticket-two'}}})
  menu.success({tapIndex:0})
  assert.match(copied,/周五 20:00[\s\S]*TT-ONE[\s\S]*第 2 张／共 3 张[\s\S]*ticket-two/)
  menu.success({tapIndex:1})
  assert.equal(number,'02112345678')
  page.visible=false
  copied=null
  menu.success({tapIndex:0})
  assert.equal(copied,null)
  assert.deepEqual(calls,[])
})
