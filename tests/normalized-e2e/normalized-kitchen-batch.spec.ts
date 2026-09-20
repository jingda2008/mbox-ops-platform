import {readFile} from 'node:fs/promises'
import {expect,test,type Page} from '@playwright/test'
import type {KitchenBoardData} from '../../src/shared/kitchen-production'

test.use({viewport:{width:1024,height:640},isMobile:false,hasTouch:true})
async function login(page:Page,employee='shenliangliang'){
  const fixture=JSON.parse(await readFile('artifacts/normalized-browser/fixture.json','utf8'))
  test.skip(!fixture.kitchenBatchFixture,'requires isolated kitchen fixture')
  await page.goto(fixture.staffUrl)
  await page.getByLabel('门店口令').fill(fixture.dailyCredential);await page.getByRole('button',{name:/验证设备/}).click()
  await page.getByLabel('员工账号').fill(employee);await page.getByLabel('四位 PIN').fill(fixture.employeePin)
  await page.getByRole('button',{name:/进入工作台/}).click();await expect(page.getByTestId('normalized-workspace')).toBeVisible()
  await page.goto('/staff/fulfillment')
  return fixture
}
const board=(page:Page)=>page.getByRole('region',{name:'后厨制作工作台',exact:true})
async function data(page:Page){const response=await page.request.get('/api/commerce/kitchen-board');expect(response.ok()).toBe(true);return (await response.json()).data as KitchenBoardData}
async function choose(page:Page,quantity:number){
  await board(page).getByRole('region',{name:'待制作',exact:true}).getByRole('button').filter({hasText:'隔离合批薯条'}).first().click()
  await board(page).getByLabel('本批份数',{exact:true}).fill(String(quantity))
  await board(page).getByLabel('实际设备',{exact:true}).fill('隔离炸篮 A')
}
test('60单180份：低高度双板、真实开批、跨页草稿、出锅释放及取送状态',async({page},testInfo)=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message))
  const fixture=await login(page);expect(fixture.kitchenBatchFixture.orders).toBe(60)
  await expect(board(page)).toBeVisible();await choose(page,18)
  const before=await data(page),commandBody:unknown[]=[]
  page.on('request',request=>{if(request.url().endsWith('/kitchen-board/commands'))commandBody.push(request.postDataJSON())})
  await board(page).getByRole('button',{name:'开始制作 18 份',exact:true}).click()
  await expect(board(page).getByRole('status',{name:'后厨操作反馈',exact:true})).toContainText('已开始 18 份')
  const started=await data(page),batch=started.batches.find(row=>row.equipment==='隔离炸篮 A'&&!row.releasedAt)!
  expect(batch.units).toHaveLength(18);expect(started.pending.reduce((sum,item)=>sum+item.unmade,0)).toBe(before.pending.reduce((sum,item)=>sum+item.unmade,0)-18)
  await board(page).getByRole('button',{name:'隔离炸篮 A 已出锅'}).click()
  await expect(board(page).getByRole('status',{name:'后厨操作反馈',exact:true})).toContainText('已登记实际出锅')
  const right=board(page).getByRole('region',{name:'正在制作',exact:true})
  await right.getByRole('spinbutton').first().fill('1')
  await right.getByRole('button',{name:'下一页',exact:true}).click()
  await right.getByRole('spinbutton').first().fill('1')
  await expect(right).toContainText('其他页已选 1 份')
  await right.getByRole('button',{name:'本页 1 份备齐 · 通知取菜'}).click()
  await expect(board(page).getByRole('status',{name:'后厨操作反馈',exact:true})).toContainText('已备齐 1 份')
  await right.getByRole('button',{name:'上一页',exact:true}).click()
  await expect(right.getByRole('spinbutton').first()).toHaveValue('1')
  await right.getByRole('button',{name:'本页 1 份备齐 · 通知取菜'}).click()
  await expect.poll(async()=>(await data(page)).batches.find(row=>row.id===batch.id)?.units.filter(unit=>unit.state==='ready').length).toBe(2)
  expect((await data(page)).batches.find(row=>row.id===batch.id)?.units.some(unit=>unit.state==='delivered')).toBe(false)
  await board(page).getByLabel('找桌 / 菜品 / 订单').fill('k03')
  await expect(right.getByRole('spinbutton').first()).toHaveAccessibleName(/K03/)
  await board(page).getByLabel('找桌 / 菜品 / 订单').fill('')
  await board(page).getByRole('region',{name:'待制作',exact:true}).getByRole('button').filter({hasText:'隔离合批薯条'}).first().click()
  await expect(board(page).getByLabel('本批份数',{exact:true})).toHaveValue('18')
  await expect(board(page).getByLabel('实际设备',{exact:true})).toHaveValue('隔离炸篮 A')
  await choose(page,2)
  for(const height of [640,768]){
    await page.setViewportSize({width:1024,height})
    const geometry=await board(page).locator('.kitchen-actions > button, .kitchen-actions summary').evaluateAll(elements=>elements.map(element=>{const rect=element.getBoundingClientRect();return {top:rect.top,bottom:rect.bottom,width:rect.width,height:rect.height,hit:element.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2))}}))
    expect(geometry.length).toBeGreaterThan(0)
    for(const rect of geometry){expect(rect.top).toBeGreaterThanOrEqual(0);expect(rect.bottom).toBeLessThanOrEqual(height);expect(rect.width).toBeGreaterThanOrEqual(44);expect(rect.height).toBeGreaterThanOrEqual(44);expect(rect.hit).toBe(true)}
    await page.screenshot({path:testInfo.outputPath(`kitchen-${height}.png`)})
  }
  await right.getByLabel('整批备齐选项').click()
  const whole=right.getByRole('button',{name:'整批 16 份已备齐',exact:true});await expect(whole).toBeVisible()
  const box=await whole.boundingBox();expect(box!.height).toBeGreaterThanOrEqual(44);expect(box!.y+box!.height).toBeLessThanOrEqual(768)
  await right.getByLabel('整批备齐选项').click()
  await page.reload();await expect(board(page)).toBeVisible()
  expect((await data(page)).batches.find(row=>row.id===batch.id)?.units).toHaveLength(18)
  expect(commandBody).toHaveLength(4);expect(errors).toEqual([])
})

test('真实提交成功但响应丢失：刷新后原凭据恢复，不重复开批',async({page})=>{
  await login(page);await expect(board(page)).toBeVisible();await choose(page,2)
  await board(page).getByLabel('实际设备',{exact:true}).fill('隔离炸篮 B')
  const before=await data(page),keys:string[]=[];let lose=true
  await page.route('**/api/commerce/kitchen-board/commands',async route=>{
    keys.push(route.request().headers()['idempotency-key']!)
    const response=await route.fetch()
    if(lose){lose=false;expect(response.ok()).toBe(true);return route.abort('failed')}
    return route.fulfill({response})
  })
  await board(page).getByRole('button',{name:'开始制作 2 份',exact:true}).click()
  await expect(board(page).getByRole('button',{name:'恢复原操作',exact:true})).toBeEnabled()
  await page.reload();await expect(board(page).getByRole('button',{name:'恢复原操作',exact:true})).toBeEnabled()
  await board(page).getByRole('button',{name:'恢复原操作',exact:true}).click()
  await expect(board(page).getByRole('status',{name:'后厨操作反馈',exact:true})).toContainText('已开始 2 份')
  expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);expect((await data(page)).batches.length).toBe(before.batches.length+1)
})

test('服务员读取真实备齐数量并送达；厨师操作不冒充送达',async({page,browser})=>{
  await login(page,'tom')
  await page.goto('/')
  const notice=page.getByRole('status',{name:'出品取送提醒',exact:true})
  await expect(notice).toContainText('份出品待取送')
  const cookContext=await browser.newContext({baseURL:page.url(),viewport:{width:1024,height:640}})
  try{
    const cook=await cookContext.newPage();await login(cook)
    const queue=await data(cook),batch=queue.batches.find(row=>row.units.some(unit=>unit.state==='ready'))!
    const original=batch.units.find(unit=>unit.state==='ready')!,next=batch.units.find(unit=>unit.taskId===original.taskId&&unit.state==='started')!
    const response=await cook.request.post('/api/commerce/kitchen-board/commands',{headers:{'idempotency-key':crypto.randomUUID()},data:{employeeId:queue.employeeId,command:{action:'ready',batchId:batch.id,items:[{taskId:next.taskId,tableId:next.tableId,tableSessionId:next.tableSessionId,locationVersion:next.locationVersion,unitIds:[next.unitId]}]}}})
    expect(response.ok(),await response.text()).toBe(true)
    await expect(notice).toContainText('3 份出品待取送')
  }finally{await cookContext.close()}

  await notice.getByRole('button',{name:'查看取菜'}).click()
  await page.getByRole('button',{name:/^待取送（/}).click()
  const card=page.locator('.staff-action-card').filter({hasText:'隔离合批薯条'}).first()
  await expect(card).toBeVisible();await expect(card).toContainText('已备齐 2')
  await card.getByRole('button',{name:'本次已送达',exact:true}).click()
  await expect(page.getByRole('status').filter({hasText:'已确认送达'})).toBeVisible()
})
