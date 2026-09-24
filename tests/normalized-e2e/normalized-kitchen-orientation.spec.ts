import {readFile} from 'node:fs/promises'
import {test,expect,type Page} from '@playwright/test'
import type {KitchenBoardData} from '../../src/shared/kitchen-production'

test.use({isMobile:false,hasTouch:true})
async function queue(page:Page):Promise<KitchenBoardData>{const r=await page.request.get('/api/commerce/kitchen-board?station=kitchen');expect(r.ok()).toBe(true);return (await r.json()).data}
async function targets(page:Page,height:number){
  const boxes=await page.locator('.kitchen-actions > button,.kitchen-actions summary,.kitchen-view-switch button').evaluateAll(els=>els.filter(e=>(e as HTMLElement).offsetParent!==null&&!e.hasAttribute('disabled')).map(e=>{const r=e.getBoundingClientRect();return {text:e.textContent,top:r.top,bottom:r.bottom,width:r.width,height:r.height,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}}))
  expect(boxes.length).toBeGreaterThan(1)
  for(const b of boxes){expect(b.top,JSON.stringify(b)).toBeGreaterThanOrEqual(0);expect(b.bottom,JSON.stringify(b)).toBeLessThanOrEqual(height);expect(b.width).toBeGreaterThanOrEqual(44);expect(b.height).toBeGreaterThanOrEqual(44);expect(b.hit,JSON.stringify(b)).toBe(true)}
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
}
for(const size of [{width:768,height:1024},{width:600,height:960},{width:390,height:844}])test(`后厨 ${size.width}×${size.height} 竖屏开做、旋转保留份数、部分完成`,async({page},info)=>{
  await page.setViewportSize(size)
  const f=JSON.parse(await readFile('artifacts/normalized-browser/fixture.json','utf8'));test.skip(!f.threeScreenFixture,'requires three-screen fixture')
  await page.goto('/');await page.getByLabel('门店口令').fill(f.dailyCredential);await page.getByRole('button',{name:/验证设备/}).click()
  await page.getByLabel('员工账号').fill('shenliangliang');await page.getByLabel('四位 PIN').fill(f.employeePin);await page.getByRole('button',{name:/进入工作台/}).click();await expect(page.getByTestId('normalized-workspace')).toBeVisible()
  await page.goto('/staff/fulfillment?screen=kitchen')
  const tabs=page.getByRole('navigation',{name:'制作工序切换'}),pending=page.getByRole('region',{name:'待制作',exact:true}),working=page.getByRole('region',{name:'正在制作',exact:true})
  await expect(tabs).toBeVisible();await expect(pending).toBeVisible();await expect(working).toBeHidden()
  expect((await pending.boundingBox())!.width).toBeGreaterThan(size.width*.9)
  await pending.getByRole('button').filter({hasText:f.threeScreenFixture.products.kitchen.name}).first().click()
  await targets(page,size.height)
  await pending.getByRole('spinbutton',{name:'本批份数'}).focus()
  await page.evaluate(()=>{Object.defineProperty(window.visualViewport!,'height',{configurable:true,value:320});window.visualViewport!.dispatchEvent(new Event('resize'))})
  await expect.poll(async()=>{const b=(await pending.getByRole('button',{name:'开始制作 2 份',exact:true}).boundingBox())!;return b.y+b.height}).toBeLessThanOrEqual(320)
  await targets(page,320)
  await page.evaluate(()=>{Reflect.deleteProperty(window.visualViewport!,'height');window.visualViewport!.dispatchEvent(new Event('resize'))})
  await pending.getByRole('button',{name:'开始制作 2 份',exact:true}).click()
  await expect(working).toBeVisible();await expect(pending).toBeHidden()
  const batch=(await queue(page)).batches.at(-1)!
  await working.getByRole('spinbutton').first().fill('1')
  await tabs.getByRole('button',{name:/待制作/}).click();await expect(pending).toBeVisible()
  // Searching while a prior working batch is selected must not steal the current pane.
  await page.getByLabel('找桌 / 品名 / 订单').fill('三屏');await expect(pending).toBeVisible()
  await page.getByLabel('找桌 / 品名 / 订单').fill('')
  await tabs.getByRole('button',{name:/制作中/}).click()
  await expect(working.getByRole('spinbutton').first()).toHaveValue('1')
  await targets(page,size.height)
  await page.screenshot({path:info.outputPath(`portrait-${size.width}.png`)})
  await page.setViewportSize({width:1024,height:552})
  await expect(tabs).toBeHidden();await expect(pending).toBeVisible();await expect(working).toBeVisible()
  expect((await pending.boundingBox())!.x).toBeLessThan((await working.boundingBox())!.x)
  await expect(working.getByRole('spinbutton').first()).toHaveValue('1');await targets(page,552)
  await page.screenshot({path:info.outputPath(`landscape-from-${size.width}.png`)})
  await page.setViewportSize(size)
  await expect(pending).toBeHidden();await expect(working).toBeVisible();await expect(working.getByRole('spinbutton').first()).toHaveValue('1')
  await working.getByRole('button',{name:'本页 1 份已放好',exact:true}).click()
  await expect.poll(async()=>{const b=(await queue(page)).batches.find(b=>b.id===batch.id);return b?.units.filter(u=>u.state==='ready').length}).toBe(1)
  const result=(await queue(page)).batches.find(b=>b.id===batch.id)!
  expect(result.units.filter(u=>u.state==='started')).toHaveLength(1);expect(result.units.some(u=>u.state==='delivered')).toBe(false)
})
