import {readFile} from 'node:fs/promises'
import {expect,test} from '@playwright/test'

// Local disposable database, no physical printing or payment. Hold the actual
// post-open operations read so the optimistic-to-confirmed transition is deterministic.
for (const scenario of ['delayed success','refresh recovery','delayed panels','delayed panels desktop']) test(`opening a table waits for its confirmed session before assisted ordering (${scenario})`, async ({page}, testInfo) => {
  const failRefresh=scenario==='refresh recovery'
  const f=JSON.parse(await readFile('artifacts/normalized-browser/fixture.json','utf8'))
  await page.setViewportSize(scenario==='delayed panels desktop'?{width:1280,height:1200}:{width:390,height:844})
  await page.goto(f.staffUrl)
  await page.getByLabel('门店口令').fill(f.dailyCredential)
  await page.getByRole('button',{name:/验证设备/}).click()
  await page.getByLabel('员工账号').fill(f.employeeCode)
  await page.getByLabel('四位 PIN').fill(f.employeePin)
  await page.getByRole('button',{name:/进入工作台/}).click()
  await expect(page.getByTestId('normalized-workspace')).toBeVisible()
  await page.goto('/staff/live')
  await page.getByRole('group',{name:'桌台显示范围'}).getByRole('button',{name:/^全部/}).click()
  const free=page.locator('.staff-table-tile:not(.is-open)').first()
  const tableCode=(await free.locator('strong').innerText()).trim()
  await free.click()
  await page.getByLabel('实际到店人数').fill('2')
  if(scenario.startsWith('delayed panels')) await page.getByLabel('本次开台最低消费（元）',{exact:true}).fill('100')
  await page.getByLabel('主服务员（必选）').selectOption({label:'李艳 · liyan'})
  let opening=false, failOnce=failRefresh, release!:()=>void
  const held=new Promise<void>(resolve=>{release=resolve})
  let releasePanels!:()=>void
  const panelsHeld=new Promise<void>(resolve=>{releasePanels=resolve})
  if(scenario.startsWith('delayed panels')) await page.route(/\/api\/table-management\/sessions\/[^/]+\/(minimum-spend|prepayment)$/,async route=>{
    const response=await route.fetch(); await panelsHeld; await route.fulfill({response})
  })
  const optimisticRequests:string[]=[]
  page.on('request',request=>{if(request.url().includes('optimistic-'))optimisticRequests.push(request.url())})
  await page.route('**/api/table-management/sessions/open',async route=>{
    opening=true
    const response=await route.fetch()
    await route.fulfill({response})
  })
  await page.route('**/api/operations',async route=>{
    const response=await route.fetch()
    if(opening) {
      await held
      if(failOnce) {failOnce=false; return route.fulfill({status:503,json:{error:{code:'TEST_REFRESH_UNAVAILABLE',message:'隔离测试暂不可读'}}})}
    }
    await route.fulfill({response})
  })
  await page.getByRole('button',{name:'确认开台'}).click()
  await expect(page.getByRole('status',{name:'操作结果',exact:true})).toContainText(`${tableCode} 已开台，2人`)
  const actions=page.getByRole('dialog',{name:`${tableCode}桌台操作`})
  try{
    await expect(actions.getByText('正在同步已开桌次，请稍候再点单或收款。')).toBeVisible()
    await expect(actions.getByRole('button',{name:'协助点单',exact:true})).toHaveCount(0)
    await expect(actions.getByRole('button',{name:'本桌收款',exact:true})).toHaveCount(0)
    expect(optimisticRequests).toEqual([])
  }finally{release()}
  if(failRefresh) {
    await expect(actions.getByRole('button',{name:'刷新桌次状态'})).toBeEnabled()
    await expect(actions.getByRole('button',{name:'协助点单',exact:true})).toHaveCount(0)
    await actions.getByRole('button',{name:'刷新桌次状态'}).click()
  }
  const orderButton=actions.getByRole('button',{name:'协助点单',exact:true})
  await expect(orderButton).toBeVisible()
  if(scenario.startsWith('delayed panels')) {
    await orderButton.scrollIntoViewIfNeeded()
    const before=await orderButton.boundingBox()
    releasePanels()
    await expect(actions.getByRole('region',{name:'本桌最低消费'})).toContainText('当前')
    const after=await orderButton.boundingBox()
    expect(Math.abs(after!.y-before!.y)).toBeLessThanOrEqual(1)
  }
  await page.screenshot({path:testInfo.outputPath('confirmed-table-actions.png'),fullPage:true})
  await orderButton.click()
  const sheet=page.getByRole('dialog',{name:`${tableCode}协助点单`})
  await expect(sheet.getByLabel('搜索菜单商品')).toBeVisible()
  await sheet.getByLabel('搜索菜单商品').fill(f.orderableProductName)
  await expect(sheet.getByRole('button',{name:`加入${f.orderableProductName}`})).toBeVisible()
  expect(optimisticRequests).toEqual([])
  await page.screenshot({path:testInfo.outputPath('confirmed-assisted-order.png'),fullPage:true})
})
