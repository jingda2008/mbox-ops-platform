import {readFile} from 'node:fs/promises'
import {test,expect,type Page} from '@playwright/test'
import type {KitchenBoardData} from '../../src/shared/kitchen-production'
import {pickupFixtureBoard,pickupFixtureUnit,pickupFixtureId as id} from '../../src/normalized-ui/staff-actions/pickup-test-fixtures'

test.use({viewport:{width:1024,height:552},isMobile:false,hasTouch:true})
async function login(page:Page){
  const f=JSON.parse(await readFile('artifacts/normalized-browser/fixture.json','utf8'))
  await page.goto('/');await page.getByLabel('门店口令').fill(f.dailyCredential);await page.getByRole('button',{name:/验证设备/}).click()
  await page.getByLabel('员工账号').fill('wuya');await page.getByLabel('四位 PIN').fill(f.employeePin);await page.getByRole('button',{name:/进入工作台/}).click()
  await expect(page.getByTestId('normalized-workspace')).toBeVisible()
  return (await (await page.request.get('/api/auth/session')).json()).data.employee.id as string
}
async function hitTargets(page:Page,selector:string,height:number){
  const rects=await page.locator(selector).evaluateAll(els=>els.filter(e=>!e.hasAttribute('disabled')&&(e as HTMLElement).offsetParent!==null).map(e=>{const r=e.getBoundingClientRect();return {label:e.textContent,top:r.top,bottom:r.bottom,width:r.width,height:r.height,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}}))
  for(const r of rects){expect(r.top,JSON.stringify(r)).toBeGreaterThanOrEqual(0);expect(r.bottom,JSON.stringify(r)).toBeLessThanOrEqual(height);expect(r.height).toBeGreaterThanOrEqual(44);expect(r.width).toBeGreaterThanOrEqual(44);expect(r.hit,JSON.stringify(r)).toBe(true)}
}
for(const station of ['bar','kitchen'] as const)test(`${station}紧凑横屏：队列占满空白、长备注、错误反馈和按钮可达`,async({page},info)=>{
  const employeeId=await login(page),now=new Date().toISOString()
  const pending=Array.from({length:12},(_,i)=>({taskId:id(i+1),itemId:id(i+30),productId:id(i+60),productName:['炸薯条','金粟香酥鸡粒','台式香肠','柿种米果','火腿','鸡翅'][i%6]!+String(i+1),specification:'',itemNote:'',orderNote:'',unmade:1,canPrepare:true,tableSessionId:id(i+90),tableId:id(i+120),tableCode:`W${String(i+1).padStart(2,'0')}`,locationVersion:1,orderPublicId:`ORDER-${i+1}`,orderCreatedAt:now}))
  const data:KitchenBoardData={employeeId,stationCode:station,canHandoff:true,canStart:true,canPrepare:true,actionSessionValid:true,generatedAt:now,pickupSummary:{awaitingPickup:8,pickedUpThisShift:26},pending,equipmentLabels:[],legacyTaskIds:[],batches:[0,1].map(i=>({id:id(i+200),productId:id(i+60),productName:i?'鸡翅':'炸薯条',specification:'',itemNote:'',orderNote:'',employeeId,employeeName:'测试员工',stationCode:station,createdByEmployeeId:employeeId,createdByEmployeeName:'测试员工',ownershipVersion:0,createdAt:now,startedAt:now,anchorAt:now,equipment:null,releasedAt:null,expectedSeconds:null,originalQuantity:1,units:[{...pending[i]!,unitId:id(i+250),state:'started',held:false,stopped:false,originalTableCode:pending[i]!.tableCode}]}))}
  let failed=false,writes=0
  await page.route('**/api/commerce/kitchen-board?**',r=>r.fulfill(failed?{status:503,json:{error:{code:'UNAVAILABLE',message:'出品读取失败，请重新读取'}}}:{json:{data}}))
  await page.route('**/api/commerce/kitchen-board/commands',r=>{writes++;return r.abort()})
  await page.goto(`/staff/fulfillment?screen=${station}`)
  const left=page.getByRole('region',{name:'待制作',exact:true}),right=page.getByRole('region',{name:'正在制作',exact:true})
  await expect(left.locator('.kitchen-group')).toHaveCount(12)
  const geometry=[]
  for(const height of [480,552,600,768]){
    await page.setViewportSize({width:1024,height})
    const metrics=await left.evaluate(e=>{const cards=e.querySelector('.kitchen-cards')!,c=cards.getBoundingClientRect(),p=e.getBoundingClientRect();return {top:p.top,pane:p.height,list:c.height,visible:[...cards.children].filter(x=>x.getBoundingClientRect().bottom<=c.bottom).length}})
    expect(metrics.top).toBeLessThanOrEqual(64);expect(metrics.list/metrics.pane).toBeGreaterThan(.85);expect(metrics.visible).toBeGreaterThanOrEqual(10)
    geometry.push({height,...metrics});await hitTargets(page,'.kitchen-top button',height)
  }
  await page.setViewportSize({width:1024,height:552})
  await right.locator('.kitchen-group').first().click()
  await expect(right.locator('.kitchen-pagination')).toHaveCount(0)
  await page.screenshot({path:info.outputPath(`${station}-dense.png`)})
  await left.locator('.kitchen-group').first().click()
  await hitTargets(page,'.kitchen-top button,.kitchen-actions > button,.kitchen-actions summary',552)
  data.pending[0]!.itemNote='过敏提示：不要花生，不加辣。\n酱料单独放置，出品前核对桌号与份数。'
  await page.getByRole('button',{name:'刷新',exact:true}).click();await left.locator('.kitchen-group').first().click()
  await expect(left.locator('.kitchen-detail .kitchen-production-note')).toHaveText(data.pending[0]!.itemNote)
  expect(await left.locator('.kitchen-detail .kitchen-production-note').evaluate(e=>getComputedStyle(e).fontSize)).toBe('20px')
  await hitTargets(page,'.kitchen-actions > button,.kitchen-actions summary',552)
  if(station==='kitchen'&&await page.evaluate(()=>document.fullscreenEnabled)){
    await page.getByRole('button',{name:'全屏',exact:true}).click();await expect.poll(()=>page.evaluate(()=>!!document.fullscreenElement)).toBe(true)
    await page.getByRole('button',{name:'退出全屏',exact:true}).click();await expect.poll(()=>page.evaluate(()=>!!document.fullscreenElement)).toBe(false)
    await page.keyboard.press('Escape');await expect(page.getByRole('region',{name:'后厨制作工作台',exact:true})).toBeVisible()
  }
  failed=true;await page.getByRole('button',{name:'刷新',exact:true}).click()
  await expect(page.getByRole('status',{name:station==='bar'?'酒水操作反馈':'后厨操作反馈',exact:true})).toContainText('读取失败')
  await expect(left.getByRole('button',{name:/开始制作/})).toBeDisabled();expect(writes).toBe(0)
  await info.attach('layout.json',{body:JSON.stringify(geometry,null,2),contentType:'application/json'})
})

test('取餐屏正常状态不占提示横条，四桌信息与操作在矮屏内可达',async({page},info)=>{
  await login(page)
  const data=pickupFixtureBoard(Array.from({length:4},(_,i)=>pickupFixtureUnit(i+1,{tableId:id(500+i),tableSessionId:id(600+i),tableCode:`W0${i+1}`,productName:'金粟香酥鸡粒',readyAt:new Date().toISOString()})),{generatedAt:new Date().toISOString()})
  await page.route('**/api/commerce/pickup-board',r=>r.fulfill({json:{data}}))
  await page.goto('/staff/fulfillment?screen=pickup');await expect(page.locator('.pickup-ticket')).toHaveCount(4)
  for(const height of [480,552,600,768]){
    await page.setViewportSize({width:1024,height})
    expect((await page.locator('.pickup-tickets').boundingBox())!.y).toBeLessThanOrEqual(82)
    await hitTargets(page,'.pickup-top button,.pickup-ticket-actions button',height)
  }
  await page.setViewportSize({width:1024,height:552});await page.screenshot({path:info.outputPath('pickup-dense.png')})
})
