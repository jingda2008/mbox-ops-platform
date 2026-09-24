import {readFile} from 'node:fs/promises'
import {test,expect,type Page,type Locator} from '@playwright/test'
import {pickupFixtureBoard,pickupFixtureUnit} from '../../src/normalized-ui/staff-actions/pickup-test-fixtures'

test.use({isMobile:false,hasTouch:true})
async function login(page:Page,employee='wuya'){
  const f=JSON.parse(await readFile('artifacts/normalized-browser/fixture.json','utf8'))
  await page.goto('/');await page.getByLabel('门店口令').fill(f.dailyCredential);await page.getByRole('button',{name:/验证设备/}).click()
  await page.getByLabel('员工账号').fill(employee);await page.getByLabel('四位 PIN').fill(f.employeePin);await page.getByRole('button',{name:/进入工作台/}).click();await expect(page.getByTestId('normalized-workspace')).toBeVisible()
}
async function reachable(button:Locator,height:number){
  const b=await button.evaluate(e=>{const r=e.getBoundingClientRect();return {bottom:r.bottom,top:r.top,width:r.width,height:r.height,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})
  expect(b.top,JSON.stringify(b)).toBeGreaterThanOrEqual(0);expect(b.bottom,JSON.stringify(b)).toBeLessThanOrEqual(height);expect(b.width).toBeGreaterThanOrEqual(44);expect(b.height).toBeGreaterThanOrEqual(44);expect(b.hit,JSON.stringify(b)).toBe(true)
}
async function keyboardViewport(page:Page,height:number){
  await page.evaluate(h=>{Object.defineProperty(window.visualViewport!,'height',{configurable:true,value:h});window.visualViewport!.dispatchEvent(new Event('resize'))},height)
}
for(const size of [{width:768,height:1024},{width:600,height:960},{width:390,height:844}])test(`取餐 ${size.width} 竖屏长备注、调整份数、旋转和可见视口收缩`,async({page},info)=>{
  await page.setViewportSize(size);await login(page)
  const units=Array.from({length:8},(_,i)=>pickupFixtureUnit(i+1,{productName:`餐品${i+1}`,itemNote:'不要花生，酱料单独放置。\n请核对实物后取走。',readyAt:new Date().toISOString()}))
  const data=pickupFixtureBoard(units,{generatedAt:new Date().toISOString()});let writes=0
  await page.route('**/api/commerce/pickup-board',r=>r.fulfill({json:{data}}))
  await page.route('**/api/commerce/pickup-board/commands',r=>{writes++;return r.abort()})
  await page.goto('/staff/fulfillment?screen=pickup');await page.getByRole('button',{name:'查看全部并核对'}).click()
  const confirm=page.getByRole('button',{name:'本次 8份已取走',exact:true})
  await expect(confirm).toBeDisabled();await reachable(confirm,size.height)
  await page.getByRole('button',{name:'减少 餐品1 数量',exact:true}).click()
  await page.setViewportSize({width:1024,height:552});await expect(page.getByRole('spinbutton',{name:'餐品1 本次取走数量',exact:true})).toHaveValue('0')
  await page.setViewportSize(size);await expect(page.getByRole('spinbutton',{name:'餐品1 本次取走数量',exact:true})).toHaveValue('0')
  // Simulate the visual viewport shrink of an overlay keyboard, without changing layout orientation.
  await keyboardViewport(page,480)
  const reduced=page.getByRole('button',{name:'本次 7份已取走',exact:true})
  await expect.poll(async()=>(await reduced.boundingBox())!.y+(await reduced.boundingBox())!.height).toBeLessThanOrEqual(480)
  await reachable(reduced,480);await expect(reduced).toBeDisabled()
  await page.locator('.pickup-detail-scroll').evaluate(e=>{e.scrollTop=e.scrollHeight;e.dispatchEvent(new Event('scroll'))})
  await expect(reduced).toBeEnabled();expect(writes).toBe(0)
  await keyboardViewport(page,size.height);await page.screenshot({path:info.outputPath(`pickup-portrait-${size.width}.png`)})
})
for(const screen of ['kitchen','bar','pickup'] as const)test(`${screen} 休眠唤醒后权威重读前禁止操作，重读后恢复`,async({page})=>{
  const f=JSON.parse(await readFile('artifacts/normalized-browser/fixture.json','utf8'))
  test.skip(screen!=='pickup'&&!f.threeScreenFixture,'requires isolated three-screen fixture')
  await page.setViewportSize({width:1024,height:552});await login(page,screen==='kitchen'?'shenliangliang':screen==='bar'?'lengyanzhi':'wuya')
  let hold=false,release:()=>void=()=>{},writes=0
  let gate=new Promise<void>(resolve=>{release=resolve})
  const path=screen==='pickup'?'**/api/commerce/pickup-board':'**/api/commerce/kitchen-board?**'
  if(screen==='pickup')await page.route(path,async r=>{if(hold)await gate;await r.fulfill({json:{data:pickupFixtureBoard([pickupFixtureUnit()],{generatedAt:new Date().toISOString()})}})})
  else await page.route(path,async r=>{if(hold)await gate;await r.continue()})
  await page.route('**/api/commerce/*/commands',r=>{writes++;return r.abort()})
  await page.goto(`/staff/fulfillment?screen=${screen}`)
  if(screen!=='pickup')await page.getByRole('region',{name:'待制作',exact:true}).getByRole('button').filter({hasText:f.threeScreenFixture.products[screen].name}).first().click()
  const action=screen==='pickup'?page.getByRole('button',{name:/本次 1份已取走/}):page.getByRole('button',{name:'开始制作 2 份',exact:true})
  await expect(action).toBeEnabled()
  if(screen!=='pickup'){
    await page.getByLabel('找桌 / 品名 / 订单').focus();await keyboardViewport(page,320)
    await expect.poll(async()=>(await action.boundingBox())!.y+(await action.boundingBox())!.height).toBeLessThanOrEqual(320)
    await reachable(action,320);await keyboardViewport(page,552)
  }
  hold=true
  try{
    await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'))})
    await expect(action).toBeDisabled({timeout:1500})
    await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.dispatchEvent(new Event('visibilitychange'))})
    await expect(action).toBeDisabled();release();await expect(action).toBeEnabled()
    gate=new Promise<void>(resolve=>{release=resolve})
    await page.evaluate(()=>{Object.defineProperty(navigator,'onLine',{configurable:true,value:false});window.dispatchEvent(new Event('offline'))})
    await expect(action).toBeDisabled()
    await page.evaluate(()=>{Object.defineProperty(navigator,'onLine',{configurable:true,value:true});window.dispatchEvent(new Event('online'))})
    await expect(action).toBeDisabled();release();await expect(action).toBeEnabled();expect(writes).toBe(0)
  }finally{release()}
})
