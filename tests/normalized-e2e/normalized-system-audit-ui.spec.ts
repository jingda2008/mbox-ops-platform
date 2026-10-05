import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

async function login(page:Page,actor='wuya') {
  const f=JSON.parse(await readFile(process.env.NORMALIZED_E2E_FIXTURE_FILE??'artifacts/normalized-browser/fixture.json','utf8'))
  await page.goto(f.staffUrl)
  await page.getByLabel('门店口令').fill(f.dailyCredential)
  await page.getByRole('button',{name:/验证设备/}).click()
  await page.getByLabel('员工账号').fill(actor)
  await page.getByLabel('四位 PIN').fill(f.employeePin)
  await page.getByRole('button',{name:/进入工作台/}).click()
  await expect(page.getByTestId('normalized-workspace')).toBeVisible()
}

test('print copies do not hit save and route inheritance survives toggles and explicit copies',async({page},info)=>{
  await login(page)
  await page.goto('/staff/devices')
  const panel=page.locator('.print-ticket-policies'),card=panel.locator('article').first()
  await expect(card).toBeVisible()
  await panel.getByLabel('修改原因',{exact:true}).fill('隔离浏览器核对继承份数')
  await panel.getByLabel('修改原因',{exact:true}).blur()
  let writes=0
  page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/api/hardware/print-ticket-policies'))writes++})
  for(const width of [320,390,844,1440]) {
    await page.setViewportSize({width,height:844})
    await card.locator('select').evaluate(e=>e.scrollIntoView({block:'center',behavior:'instant'}))
    const geometry=await card.evaluate(e=>{
      const select=e.querySelector('select')!,button=e.querySelector('button')!,s=select.getBoundingClientRect(),b=button.getBoundingClientRect()
      return {right:s.right,next:b.left,height:s.height,arrowHit:document.elementFromPoint(s.right-5,s.y+s.height/2)===select}
    })
    expect(geometry.right).toBeLessThanOrEqual(geometry.next)
    expect(geometry.height).toBeGreaterThanOrEqual(44)
    expect(geometry.arrowHit).toBe(true)
  }
  await page.setViewportSize({width:390,height:844})
  await card.locator('select').evaluate(e=>e.scrollIntoView({block:'center',behavior:'instant'}))
  const rect=(await card.locator('select').boundingBox())!
  await page.mouse.click(rect.x+rect.width-5,rect.y+rect.height/2);await page.keyboard.press('Escape')
  expect(writes).toBe(0)
  const save=async(enabled:boolean,copies:number|null)=>{
    await card.locator('input[type=checkbox]').setChecked(enabled)
    await card.locator('select').selectOption(copies===null?'':String(copies))
    const response=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/api/hardware/print-ticket-policies'))
    await card.getByRole('button',{name:'保存',exact:true}).click()
    expect((await response).status()).toBe(200)
    await expect(card.getByRole('button',{name:'保存',exact:true})).toBeEnabled()
    const state=(await (await page.request.get('/api/hardware/print-ticket-policies')).json()).data
    expect(state.find((p:{ticketKind:string})=>p.ticketKind==='bar_production')).toMatchObject({enabled,copies})
  }
  await save(true,2)
  await save(true,null)
  await save(false,null)
  await save(true,null)
  await expect(card.locator('select')).toHaveValue('')
  await card.screenshot({path:info.outputPath('print-inheritance-fixed.png')})
})

test('failed todo refresh preserves the last complete successful time and an initial failure is not loading',async({page},info)=>{
  await login(page)
  const panel=page.locator('.staff-unified-todos')
  await expect(panel.getByRole('button',{name:'刷新待办',exact:true})).toBeEnabled()
  const fixed=new Date();fixed.setUTCMinutes(10,0,0)
  await page.clock.setFixedTime(fixed)
  await panel.getByRole('button',{name:'刷新待办',exact:true}).click()
  await expect(panel.getByRole('button',{name:'刷新待办',exact:true})).toBeEnabled()
  const before=await panel.locator('.normalized-section-heading small').innerText()
  expect(before).toContain('最近全部核对成功')
  await page.route('**/api/payments/workbench?*',r=>r.fulfill({status:503,json:{error:{code:'UNAVAILABLE'}}}))
  await page.route('**/api/hardware/print-jobs?*',r=>r.fulfill({status:503,json:{error:{code:'UNAVAILABLE'}}}))
  await page.clock.setFixedTime(new Date(fixed.getTime()+120000))
  await panel.getByRole('button',{name:'刷新待办',exact:true}).click()
  await expect(panel.getByRole('alert')).toContainText('部分待办未能更新')
  await expect(panel.locator('.normalized-section-heading small')).toHaveText(before)
  await panel.screenshot({path:info.outputPath('todo-failed-refresh-fixed.png')})
  await page.reload()
  await expect(panel.getByRole('button',{name:'刷新待办',exact:true})).toBeEnabled()
  await expect(panel.locator('.normalized-section-heading small')).toContainText('尚未完整读取各业务待办')
})

test('activity cashier keeps its grouping at narrow and wide widths and payment guidance stays readable',async({page},info)=>{
  await login(page,'sanmu');await page.goto('/staff/payments')
  const activity=page.locator('.cashier-activity-worklist')
  await expect(activity).toBeVisible()
  for(const width of [375,390,844,1440]) {
    await page.setViewportSize({width,height:844})
    expect(await activity.evaluate(e=>getComputedStyle(e).display)).toBe('grid')
    expect(await activity.locator('header').evaluate(e=>getComputedStyle(e).display)).toBe('flex')
  }
  await page.setViewportSize({width:390,height:844})
  expect(await page.locator('.cashier-workbench-boundary').evaluate(e=>parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(12)
  await activity.screenshot({path:info.outputPath('activity-grouping-fixed.png')})
})
