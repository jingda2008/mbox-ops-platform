import {readFile} from 'node:fs/promises'
import {test,expect,type Page} from '@playwright/test'
test.skip(process.env.NORMALIZED_E2E_SERVICE_HISTORY!=='true','Requires isolated service-history fixture')
async function fixture(){return JSON.parse(await readFile('artifacts/normalized-browser/fixture.json','utf8'))}
async function login(page:Page,reader=false){const f=await fixture();await page.goto(f.staffUrl);await page.getByLabel('门店口令').fill(f.dailyCredential);await page.getByRole('button',{name:/验证设备/}).click();await page.getByLabel('员工账号').fill(reader?'history-reader':f.employeeCode);await page.getByLabel('四位 PIN').fill(f.employeePin);await page.getByRole('button',{name:/进入工作台/}).click();await expect(page.getByRole('button',{name:'全店桌台服务记录'})).toBeVisible()}
test('zero-permission employee can inspect current/history but cannot hand over or open',async({page})=>{
 await page.setViewportSize({width:360,height:800});await login(page,true)
 await page.getByRole('button',{name:'全店桌台服务记录'}).click();const dialog=page.getByRole('dialog',{name:'全店桌台服务记录'});await expect(dialog).toBeVisible()
 await dialog.locator('.table-service-grid button').filter({hasText:/^W1 ·/}).click()
 await expect(dialog.getByText('当前主服务员：',{exact:false})).toBeVisible();await expect(dialog.getByRole('heading',{name:'负责人及交接历史'})).toBeVisible();await expect(dialog.getByText('开台确认主服务员',{exact:true})).toBeVisible()
 await expect(dialog.getByRole('button',{name:'确认交接',exact:true})).toHaveCount(0)
 const response=await page.request.post('/api/table-management/sessions/open',{headers:{'x-idempotency-key':crypto.randomUUID()},data:{tableId:crypto.randomUUID(),guestCount:2}});expect(response.status()).toBe(403)
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true)
 await page.screenshot({path:'artifacts/normalized-browser/service-history-reader-360.png',fullPage:true});await dialog.getByRole('button',{name:'关闭',exact:true}).click();await expect(dialog).toHaveCount(0)
 await page.goto('/staff/live');await expect(page.getByRole('alert')).toContainText('当前账号没有这个页面的有效权限')
 await page.getByRole('button',{name:'全店桌台服务记录',exact:true}).click();await expect(dialog).toBeVisible()
 await dialog.locator('.table-service-grid button').filter({hasText:/^W1 ·/}).click();await expect(dialog.getByText('当前主服务员：',{exact:false})).toBeVisible()
})
test('manager must select a primary, can open, then hand over with durable visible history',async({page})=>{
 await page.setViewportSize({width:390,height:844});await login(page)
 await page.goto('/staff/live');await page.getByRole('group',{name:'桌台显示范围'}).getByRole('button',{name:'全部',exact:true}).click();const tiles=page.locator('.staff-table-tile').filter({hasText:'空台'});await expect(tiles.first()).toBeVisible();const tableCode=await tiles.first().locator('strong').innerText();await tiles.first().click()
 const primary=page.getByLabel('主服务员（必选）');await expect(primary).toBeEnabled();await primary.selectOption('')
 await page.getByLabel('实际到店人数',{exact:true}).fill('2');await expect(page.getByRole('button',{name:'确认开台',exact:true})).toBeDisabled()
 const options=await primary.locator('option').evaluateAll(nodes=>nodes.map(n=>({value:(n as HTMLOptionElement).value,text:n.textContent??''})).filter(n=>n.value))
 const first=options.find(o=>o.text.includes('仅查看员工'))!;await primary.selectOption(first.value);await page.getByRole('button',{name:'确认开台',exact:true}).click()
 await expect(page.getByText('当前主服务员：仅查看员工',{exact:true})).toBeVisible();await page.getByText('查看交接与实际服务记录',{exact:true}).click();await expect(page.getByText('开台确认主服务员',{exact:true})).toBeVisible()
 const next=options.find(o=>o.value!==first.value)!;await page.getByLabel('接手员工',{exact:true}).selectOption(next.value);await page.getByLabel('交接原因',{exact:true}).fill('本次现场换班')
 await page.getByRole('button',{name:'确认交接',exact:true}).click();await expect(page.getByText(`当前主服务员：${next.text.split(' · ')[0]}`,{exact:true})).toBeVisible();await page.getByText('查看交接与实际服务记录',{exact:true}).click();await expect(page.getByText('本次现场换班',{exact:true})).toBeVisible()
 const directory=await (await page.request.get('/api/table-service/tables')).json();const table=directory.data.find((t:{code:string})=>t.code===tableCode)
 const created=await page.request.post('/api/service-tasks',{headers:{'idempotency-key':crypto.randomUUID()},data:{tableId:table.id,tableSessionId:table.sessionId,taskType:'call_staff',title:'现场呼叫'}});expect(created.status()).toBe(201)
 const task=(await created.json()).data;const completed=await page.request.post(`/api/service-tasks/${task.id}/complete`,{headers:{'idempotency-key':crypto.randomUUID()},data:{}});expect(completed.status()).toBe(200)
 await page.getByRole('button',{name:'刷新服务记录',exact:true}).click();await page.getByText('查看交接与实际服务记录',{exact:true}).click();await expect(page.getByText(/完成服务/)).toBeVisible()
 await page.screenshot({path:'artifacts/normalized-browser/service-history-handover-390.png',fullPage:true})
 await page.reload();await page.getByRole('group',{name:'桌台显示范围'}).getByRole('button',{name:'全部',exact:true}).click();await page.locator('.staff-table-tile').filter({has:page.locator('strong',{hasText:new RegExp(`^${tableCode}$`)})}).click();await page.getByText('查看交接与实际服务记录',{exact:true}).click();await expect(page.getByText('本次现场换班',{exact:true})).toBeVisible()
})
test('desktop service directory is usable and anonymous access is denied',async({page,request})=>{
 const anonymous=await request.get('/api/table-service/tables');expect(anonymous.status()).toBe(401)
 await page.setViewportSize({width:1366,height:900});await login(page);await page.getByRole('button',{name:'全店桌台服务记录'}).click();await page.getByLabel('搜索服务记录桌台').fill('W1');await expect(page.locator('.table-service-grid button').first()).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.keyboard.press('Escape');await expect(page.getByRole('dialog',{name:'全店桌台服务记录'})).toHaveCount(0)
})
test('service directory stays open when initial workspace finishes loading',async({page})=>{
 let releaseWorkspace!:()=>void
 const workspaceReady=new Promise<void>(resolve=>{releaseWorkspace=resolve})
 await page.route('**/api/staff/workspace',async route=>{
  const response=await route.fetch()
  if(response.status()===200)await workspaceReady
  await route.fulfill({response})
 })
 try{
  await login(page,true)
  await page.getByRole('button',{name:'全店桌台服务记录',exact:true}).click()
  const dialog=page.getByRole('dialog',{name:'全店桌台服务记录'})
  await expect(dialog).toBeVisible();await dialog.getByLabel('搜索服务记录桌台').fill('W1')
  await dialog.locator('.table-service-grid button').filter({hasText:/^W1 ·/}).click()
  await expect(dialog.getByText('当前主服务员：',{exact:false})).toBeVisible()
  releaseWorkspace()
  await expect(page.getByTestId('normalized-workspace')).toBeAttached()
  await expect(dialog).toBeVisible();await expect(dialog.getByLabel('搜索服务记录桌台')).toHaveValue('W1')
  await expect(dialog.getByText('当前主服务员：',{exact:false})).toBeVisible()
 }finally{releaseWorkspace()}
})
