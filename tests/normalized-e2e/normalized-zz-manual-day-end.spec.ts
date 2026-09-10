import {readFile} from 'node:fs/promises'
import {test,expect} from '@playwright/test'

test('authorized staff confirms one manual day boundary and retries without skipping another day at 320/390px',async({page},testInfo)=>{
  const fixture=JSON.parse(await readFile('artifacts/normalized-browser/fixture.json','utf8'))
  await page.setViewportSize({width:320,height:800})
  await page.goto(fixture.staffUrl)
  await page.getByLabel('门店口令').fill(fixture.dailyCredential)
  await page.getByRole('button',{name:/验证设备/}).click()
  const cashier=fixture.employees.find((employee:{roleNames:string[]})=>employee.roleNames.includes('店长'))
  await page.getByLabel('员工账号').fill(cashier.code)
  await page.getByLabel('四位 PIN').fill(fixture.employeePin)
  await page.getByRole('button',{name:/进入工作台/}).click()
  await expect(page.getByTestId('normalized-workspace')).toBeVisible()
  await page.goto('/staff/payments')
  const panel=page.locator('[aria-label="提前结束营业日"]')
  await panel.locator('summary').click()
  const previewResponse=page.waitForResponse(response=>response.url().endsWith('/api/business-days/end-current/preview'))
  await panel.getByRole('button',{name:'读取日结核对'}).click()
  const preview=(await(await previewResponse).json()).data
  await panel.getByLabel('日结原因').fill('隔离浏览器提前结束验收')
  await expect(panel.getByRole('button',{name:'核对后提前结束'})).toBeEnabled()
  await page.screenshot({path:testInfo.outputPath('daily-preview-320.png'),fullPage:true})
  await panel.getByRole('button',{name:'核对后提前结束'}).click()
  const endResponse=page.waitForResponse(response=>response.url().endsWith('/api/business-days/end-current'))
  await page.getByRole('button',{name:'确认结束并切日',exact:true}).click()
  const response=await endResponse
  expect(response.status()).toBe(200)
  const ended=(await response.json()).data
  expect(ended.businessDate).toBe(preview.businessDate)
  expect(ended.nextBusinessDate>ended.businessDate).toBe(true)
  await expect(panel.getByRole('status')).toContainText('已结束')
  const replay=await page.evaluate(async({date})=>{
    const response=await fetch('/api/business-days/end-current',{method:'POST',headers:{'content-type':'application/json','idempotency-key':'manual-day-independent-retry-0001'},body:JSON.stringify({expectedBusinessDate:date,reason:'隔离重复核对'})})
    return {status:response.status,body:await response.json()}
  },{date:ended.businessDate})
  expect(replay.status).toBe(200)
  expect(replay.body.data.id).toBe(ended.id)
  const future=await page.evaluate(async({date})=>{
    const response=await fetch('/api/business-days/end-current',{method:'POST',headers:{'content-type':'application/json','idempotency-key':'manual-day-future-refusal-0001'},body:JSON.stringify({expectedBusinessDate:date,reason:'隔离连续跳日反测试'})})
    return response.status
  },{date:ended.nextBusinessDate})
  expect(future).toBe(409)
  await page.setViewportSize({width:390,height:844})
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1)).toBe(true)
  await page.screenshot({path:testInfo.outputPath('daily-completed-390.png'),fullPage:true})
  await page.goto('/staff/floor')
  await expect(page.getByTestId('normalized-workspace')).toBeVisible()
})
