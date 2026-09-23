import {readFile} from 'node:fs/promises'
import {expect,test,type Page,type BrowserContext} from '@playwright/test'
import type {KitchenBoardData} from '../../src/shared/kitchen-production'
import type {PickupBoardData} from '../../src/shared/pickup-workflow'

type ScrollCall={className:string;tagName:string;ariaLive:string|null;actionReveal:string|null;clip:string;behavior:string;top:number;text:string}
type ScrollDebugWindow=Window&{__threeScreenScrollCalls:ScrollCall[]}
test.use({viewport:{width:1024,height:600},isMobile:false,hasTouch:true})
test.setTimeout(300_000)
const fixture=async()=>JSON.parse(await readFile('artifacts/normalized-browser/fixture.json','utf8'))
async function login(page:Page,code:string){
  const f=await fixture();await page.goto('/')
  await page.getByLabel('门店口令').fill(f.dailyCredential);await page.getByRole('button',{name:/验证设备/}).click()
  await page.getByLabel('员工账号').fill(code);await page.getByLabel('四位 PIN').fill(f.employeePin)
  await page.getByRole('button',{name:/进入工作台/}).click();await expect(page.getByTestId('normalized-workspace')).toBeVisible()
}
async function kitchenData(page:Page,station:string):Promise<KitchenBoardData>{const r=await page.request.get(`/api/commerce/kitchen-board?station=${station}`);expect(r.ok()).toBe(true);return (await r.json()).data}
async function pickupData(page:Page):Promise<PickupBoardData>{const r=await page.request.get('/api/commerce/pickup-board');expect(r.ok()).toBe(true);return (await r.json()).data}
async function buttonVisible(page:Page,selector:string){
  const bounds=await page.locator(selector).evaluateAll(elements=>elements.filter(e=>!e.hasAttribute('disabled')&&(e as HTMLElement).offsetParent!==null).map(e=>{const r=e.getBoundingClientRect();return {label:e.textContent,top:r.top,bottom:r.bottom,left:r.left,right:r.right}}))
  for(const r of bounds){expect(r.top,JSON.stringify(r)).toBeGreaterThanOrEqual(0);expect(r.bottom,JSON.stringify(r)).toBeLessThanOrEqual(600);expect(r.left).toBeGreaterThanOrEqual(0);expect(r.right).toBeLessThanOrEqual(1024)}
}
async function phoneLayout(page:Page){
  return page.evaluate(()=>{
    const describe=(element:Element|null)=>{
      if(!element)return null
      const rect=element.getBoundingClientRect(),style=getComputedStyle(element)
      return {tag:element.tagName,className:element.className,role:element.getAttribute('role'),label:element.getAttribute('aria-label'),text:element.textContent?.trim().slice(0,100),rect:{top:rect.top,bottom:rect.bottom,left:rect.left,right:rect.right,width:rect.width,height:rect.height},position:style.position,display:style.display,background:style.backgroundColor,transform:style.transform}
    }
    const history=document.querySelector('[aria-label="共用取餐屏送达记录"]'),viewport=window.visualViewport
    return {scrollX:window.scrollX,scrollY:window.scrollY,scrollCalls:[...(window as unknown as ScrollDebugWindow).__threeScreenScrollCalls],innerWidth:window.innerWidth,innerHeight:window.innerHeight,devicePixelRatio:window.devicePixelRatio,visibility:document.visibilityState,documentHeight:document.documentElement.scrollHeight,visualViewport:viewport?{offsetLeft:viewport.offsetLeft,offsetTop:viewport.offsetTop,pageLeft:viewport.pageLeft,pageTop:viewport.pageTop,width:viewport.width,height:viewport.height,scale:viewport.scale}:null,
      html:describe(document.documentElement),body:describe(document.body),root:describe(document.getElementById('root')),shell:describe(document.querySelector('.normalized-staff-action-shell')),header:describe(document.querySelector('.normalized-staff-action-shell > header')),notice:describe(document.querySelector('.staff-ready-notice')),history:describe(history),historyHeading:describe(history?.querySelector('h3')??null),firstRecord:describe(history?.querySelector('article')??null),
      hitTests:[40,160,Math.floor(window.innerHeight/2),window.innerHeight-80].map(y=>({x:Math.floor(window.innerWidth/2),y,element:describe(document.elementFromPoint(Math.floor(window.innerWidth/2),y))}))}
  })
}
async function phoneScrollSettled(page:Page){
  await page.evaluate(()=>new Promise<void>((resolve,reject)=>{
    let previous='',stableSince=performance.now();const deadline=performance.now()+5000
    const sample=()=>{
      const heading=document.querySelector('[aria-label="共用取餐屏送达记录"] h3')?.getBoundingClientRect()
      const current=`${window.scrollY}:${heading?.top}:${document.documentElement.scrollHeight}`
      if(current!==previous){previous=current;stableSince=performance.now()}
      if(performance.now()-stableSince>=250){resolve();return}
      if(performance.now()>deadline){reject(new Error('Phone history keeps moving after tab selection'));return}
      requestAnimationFrame(sample)
    };requestAnimationFrame(sample)
  }))
}
async function historyHeadingUncovered(page:Page){
  const heading=page.getByRole('region',{name:'共用取餐屏送达记录'}).getByRole('heading',{name:'共用取餐屏',exact:true})
  await expect(heading).toBeInViewport({ratio:1})
  expect(await heading.evaluate(element=>{
    const r=element.getBoundingClientRect(),header=document.querySelector('.normalized-staff-action-shell > header')?.getBoundingClientRect()
    const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)
    return r.top>=(header?.bottom??0)&&hit!==null&&(hit===element||element.contains(hit))
  }),'History heading must be visible to the user, not merely behind the sticky header').toBe(true)
}
async function makeNext(page:Page,station:'bar'|'kitchen',name:string){
  const pending=page.getByRole('region',{name:'待制作',exact:true})
  await pending.getByRole('button').filter({hasText:name}).first().click()
  await expect(page.getByLabel('本批份数',{exact:true})).toHaveValue('2')
  await buttonVisible(page,'.kitchen-actions button')
  await page.getByRole('button',{name:'开始制作 2 份',exact:true}).click()
  const running=page.getByRole('region',{name:'正在制作',exact:true})
  await expect(running.getByRole('button',{name:'本页 2 份已放好',exact:true})).toBeEnabled()
  await buttonVisible(page,'.kitchen-actions button')
  await running.getByRole('button',{name:'本页 2 份已放好',exact:true}).click()
  await expect.poll(async()=>(await kitchenData(page,station)).batches.filter(b=>b.units.some(u=>u.state==='started'&&!u.stopped)).length).toBe(0)
}

test('正式三屏20桌80份：制作、共同取走、撤回、手机自动同步及横屏可达',async({browser},testInfo)=>{
  const f=await fixture();test.skip(!f.threeScreenFixture,'requires isolated three-screen fixture')
  const contexts:BrowserContext[]=[];const errors:string[]=[]
  const open=async(code:string,screen?:string,phone=false)=>{
    const context=await browser.newContext({viewport:phone?{width:390,height:844}:{width:1024,height:600},hasTouch:true,isMobile:phone});contexts.push(context)
    if(phone)await context.addInitScript(()=>{
      const debugWindow=window as unknown as ScrollDebugWindow;debugWindow.__threeScreenScrollCalls=[]
      const original=Element.prototype.scrollIntoView
      Element.prototype.scrollIntoView=function(options?:boolean|ScrollIntoViewOptions){
        debugWindow.__threeScreenScrollCalls.push({className:this.className,tagName:this.tagName,ariaLive:this.getAttribute('aria-live'),actionReveal:this.getAttribute('data-action-reveal'),clip:getComputedStyle(this).clip,behavior:typeof options==='object'?options.behavior??'auto':String(options),top:this.getBoundingClientRect().top,text:this.textContent?.trim().slice(0,80)??''})
        return original.call(this,options)
      }
    })
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await login(page,code);await page.goto(`/staff/fulfillment${screen?'?screen='+screen:''}`);return page
  }
  try{
    const [bar,kitchen,pickup,phone]=await Promise.all([open('lengyanzhi','bar'),open('shenliangliang','kitchen'),open('wuya'),open('tom',undefined,true)])
    await pickup.getByRole('button',{name:'吧台取餐屏',exact:true}).click()
    await expect(pickup.getByRole('button',{name:'设为取餐屏',exact:true})).toBeEnabled()
    await pickup.getByRole('button',{name:'设为取餐屏',exact:true}).click()
    await expect(pickup.getByRole('button',{name:'切换工作账号',exact:true})).toBeVisible()
    await pickup.getByRole('button',{name:'切换工作账号',exact:true}).click()
    await pickup.getByLabel('员工账号').fill('tom');await pickup.getByLabel('四位 PIN').fill(f.employeePin)
    await pickup.getByRole('button',{name:/进入工作台/}).click()
    await expect(pickup.getByText('当前没有待取餐的出品')).toBeVisible()
    await Promise.all([makeNext(bar,'bar',f.threeScreenFixture.products.bar.name),makeNext(kitchen,'kitchen',f.threeScreenFixture.products.kitchen.name)])
    const first=pickup.locator('[data-table-code="TS01"]');await expect(first).toBeVisible()
    await expect(first.getByRole('button',{name:'本次 4份已取走',exact:true})).toBeEnabled()
    const phoneFirst=phone.locator('[data-action-fact-id]').filter({hasText:'TS01'})
    await expect(phoneFirst).toHaveCount(2)
    await expect(phone.getByRole('button',{name:/本次已送达|全部已送达/})).toHaveCount(0)
    for(const [name,page] of Object.entries({bar,kitchen,pickup,phone}))await page.screenshot({path:testInfo.outputPath(name+'-first-ready.png')})
    await buttonVisible(pickup,'.pickup-ticket-actions button,.pickup-pages button')
    let lose=true,droppedCommits=0
    await pickup.route('**/api/commerce/pickup-board/commands',async route=>{if(!lose)return route.continue();lose=false;const committed=await route.fetch();expect(committed.status()).toBe(200);droppedCommits++;await route.abort('failed')})
    await first.getByRole('button',{name:'本次 4份已取走',exact:true}).click()
    await expect(pickup.getByRole('button',{name:'恢复原操作',exact:true})).toBeVisible()
    await pickup.reload();await expect(pickup.getByRole('button',{name:'恢复原操作',exact:true})).toBeVisible()
    await pickup.getByRole('button',{name:'恢复原操作',exact:true}).click()
    await expect(pickup.getByText('当前没有待取餐的出品')).toBeVisible()
    let result=await pickupData(pickup);expect(result.history).toHaveLength(1);expect(result.history[0].pickerEmployeeId).toBeNull();expect(result.history[0].deliverySource).toBe('pickup');expect(result.history[0].quantity).toBe(4)
    await expect.poll(async()=>(await kitchenData(bar,'bar')).pickupSummary.awaitingPickup).toBe(0)
    await expect.poll(async()=>(await kitchenData(kitchen,'kitchen')).pickupSummary.awaitingPickup).toBe(0)
    const noReadyForFirst=async()=>{const r=await phone.request.get('/api/commerce/fulfillment');return (await r.json()).data.workItems.filter((i:{table:{code:string};readyForDelivery:boolean})=>i.table.code==='TS01'&&i.readyForDelivery).length}
    await expect.poll(noReadyForFirst).toBe(0)
    await expect(phoneFirst).toHaveCount(0)
    await phone.getByRole('button',{name:'已送达',exact:true}).click()
    const sharedHistory=phone.getByRole('region',{name:'共用取餐屏送达记录'})
    await expect(sharedHistory.locator('article')).toHaveCount(1)
    await expect(sharedHistory).toContainText('TS01')
    await pickup.getByRole('button',{name:'撤回',exact:true}).click()
    await pickup.getByRole('button',{name:'实物仍在取餐区，确认撤回',exact:true}).click()
    await expect(first).toBeVisible();await expect.poll(noReadyForFirst).toBe(2)
    await expect(sharedHistory.locator('article')).toHaveCount(0)
    await phone.getByRole('button',{name:/^待取（/}).click()
    await expect(phoneFirst).toHaveCount(2)
    await expect.poll(async()=>(await kitchenData(bar,'bar')).pickupSummary.awaitingPickup).toBe(2)
    await expect.poll(async()=>(await kitchenData(kitchen,'kitchen')).pickupSummary.awaitingPickup).toBe(2)
    lose=true
    await first.getByRole('button',{name:'本次 4份已取走',exact:true}).click()
    await expect(pickup.getByRole('button',{name:'恢复原操作',exact:true})).toBeVisible()
    await expect.poll(()=>droppedCommits).toBe(2)
    expect((await pickup.request.post('/api/auth/logout')).status()).toBe(204)
    await pickup.reload()
    await pickup.getByLabel('员工账号').fill('tom');await pickup.getByLabel('四位 PIN').fill(f.employeePin)
    await pickup.getByRole('button',{name:/进入工作台/}).click()
    await pickup.getByRole('button',{name:'查看本设备上次操作',exact:true}).click()
    await expect(pickup.getByRole('button',{name:'核对并恢复本设备上次操作',exact:true})).toBeVisible()
    await pickup.getByRole('button',{name:'核对并恢复本设备上次操作',exact:true}).click()
    await expect.poll(async()=>(await pickupData(pickup)).tables.length).toBe(0)
    await expect(pickup.getByText('当前没有待取餐的出品')).toBeVisible()
    for(let i=1;i<20;i++){
      await Promise.all([makeNext(bar,'bar',f.threeScreenFixture.products.bar.name),makeNext(kitchen,'kitchen',f.threeScreenFixture.products.kitchen.name)])
      const card=pickup.locator(`[data-table-code="TS${String(i+1).padStart(2,'0')}"]`);await expect(card).toBeVisible()
      const review=card.getByRole('button',{name:/核对全部内容|查看全部并核对/})
      if(await review.count()){
        await review.click();const detail=pickup.locator('.pickup-detail-scroll');await detail.evaluate(el=>{el.scrollTop=el.scrollHeight;el.dispatchEvent(new Event('scroll',{bubbles:true}))})
        await expect(pickup.getByText('此单请完整核对：酱料与装饰分别放置，确认桌号后再取走，不与其他桌的出品混放。').first()).toBeVisible()
        await pickup.getByRole('button',{name:'本次 4份已取走',exact:true}).click()
      }else await card.getByRole('button',{name:'本次 4份已取走',exact:true}).click()
      await expect.poll(async()=>(await pickupData(pickup)).tables.some(t=>t.tableCode===`TS${String(i+1).padStart(2,'0')}`)).toBe(false)
      await expect(pickup.getByText('当前没有待取餐的出品')).toBeVisible()
    }
    result=await pickupData(pickup);expect(result.tables).toHaveLength(0)
    expect(result.history.filter(r=>!r.undo).reduce((sum,r)=>sum+r.quantity,0)).toBe(80)
    const units=result.history.filter(r=>!r.undo).flatMap(r=>r.units.map(u=>u.kind+':'+u.unitId));expect(new Set(units).size).toBe(80)
    await expect(phone.locator('[data-action-fact-id]')).toHaveCount(0)
    for(const page of [bar,kitchen]){
      await expect(page.locator('.kitchen-pickup-summary')).toHaveText('待取 0 · 已取走 40')
      const feedback=page.getByRole('status',{name:page===bar?'酒水操作反馈':'后厨操作反馈',exact:true})
      await expect(feedback).toContainText('上次操作：')
      await expect(feedback).not.toContainText('等待取走')
    }
    await phone.bringToFront()
    await phone.evaluate(()=>{(window as unknown as ScrollDebugWindow).__threeScreenScrollCalls=[]})
    await phone.getByRole('button',{name:'已送达',exact:true}).click()
    await expect(sharedHistory.locator('article')).toHaveCount(20)
    for(const page of [bar,kitchen,pickup]){await buttonVisible(page,page===pickup?'.pickup-top button':'.three-screen-toolbar button');await page.screenshot({path:testInfo.outputPath(page===bar?'bar-final.png':page===kitchen?'kitchen-final.png':'pickup-final.png')})}
    // Keep the unadjusted frame and real geometry: DOM counts alone cannot
    // distinguish an offscreen history from a mobile layout/compositor fault.
    const beforePosition=await phoneLayout(phone)
    await phone.screenshot({path:testInfo.outputPath('phone-final-before-position.png')})
    await phone.bringToFront()
    await phoneScrollSettled(phone)
    const afterForeground=await phoneLayout(phone)
    await phone.screenshot({path:testInfo.outputPath('phone-final-foreground.png')})
    await testInfo.attach('phone-final-natural-layout.json',{body:JSON.stringify({beforePosition,afterForeground},null,2),contentType:'application/json'})
    expect(afterForeground.scrollCalls.filter(call=>call.className==='staff-actions-announcer'||call.ariaLive!==null&&call.clip!=='auto'),'Hidden screen-reader announcements must never pull the natural history view away').toEqual([])
    await historyHeadingUncovered(phone)
    await sharedHistory.getByRole('heading',{name:'共用取餐屏',exact:true}).evaluate(element=>{
      const header=document.querySelector('.normalized-staff-action-shell > header')?.getBoundingClientRect()
      window.scrollTo({top:window.scrollY+element.getBoundingClientRect().top-(header?.height??0)-12,behavior:'instant'})
    })
    await phoneScrollSettled(phone)
    const historyPositioned=await phoneLayout(phone)
    await testInfo.attach('phone-final-layout.json',{body:JSON.stringify({beforePosition,afterForeground,historyPositioned},null,2),contentType:'application/json'})
    await historyHeadingUncovered(phone)
    await expect(sharedHistory.locator('article').first()).toBeInViewport({ratio:0.25})
    for(const layout of [afterForeground,historyPositioned]){
      expect(layout.header?.rect.top,'The real mobile header must stay at the viewport top, not below an empty screen').toBeGreaterThanOrEqual(0)
      expect(layout.header?.rect.top).toBeLessThanOrEqual(1)
      expect(layout.visualViewport?.offsetTop??0).toBe(0)
      expect(layout.visualViewport?.scale??1).toBe(1)
    }
    await phone.screenshot({path:testInfo.outputPath('phone-final.png')})
    await testInfo.attach('final-pickup.json',{body:JSON.stringify(result,null,2),contentType:'application/json'})
    expect(errors).toEqual([])
  }finally{for(const context of contexts)await context.close()}
})
