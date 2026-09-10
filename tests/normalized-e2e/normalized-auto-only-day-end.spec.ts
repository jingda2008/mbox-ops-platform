import {readFile} from 'node:fs/promises'
import {test,expect} from '@playwright/test'

test('manual day end is unavailable in the page and retired API, including for a manager',async({page},testInfo)=>{
  const fixture=JSON.parse(await readFile('artifacts/normalized-browser/fixture.json','utf8'))
  await page.setViewportSize({width:320,height:800})
  await page.goto(fixture.staffUrl)
  await page.getByLabel('门店口令').fill(fixture.dailyCredential)
  await page.getByRole('button',{name:/验证设备/}).click()
  const manager=fixture.employees.find((employee:{roleNames:string[]})=>employee.roleNames.includes('店长'))
  await page.getByLabel('员工账号').fill(manager.code)
  await page.getByLabel('四位 PIN').fill(fixture.employeePin)
  await page.getByRole('button',{name:/进入工作台/}).click()
  await expect(page.getByTestId('normalized-workspace')).toBeVisible()
  await page.goto('/staff/payments')
  await expect(page.locator('[aria-label="提前结束营业日"]')).toHaveCount(0)
  await expect(page.getByRole('button',{name:'核对后提前结束'})).toHaveCount(0)
  for(const method of ['GET','POST']){
    const result=await page.evaluate(async method=>{
      const response=await fetch(`/api/business-days/end-current${method==='GET'?'/preview':''}`,{
        method,headers:{'content-type':'application/json','idempotency-key':'retired-manual-day-end-0001'},
        ...(method==='POST'?{body:JSON.stringify({expectedBusinessDate:'2026-09-10',reason:'旧页面重试'})}:{}),
      })
      return {status:response.status,body:await response.json()}
    },method)
    expect(result.status).toBe(410)
    expect(result.body.error.code).toBe('MANUAL_BUSINESS_DAY_END_DISABLED')
  }
  for(const width of [320,390]){
    await page.setViewportSize({width,height:800})
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1)).toBe(true)
    await page.screenshot({path:testInfo.outputPath(`automatic-only-${width}.png`),fullPage:true})
  }
  await page.goto('/staff/floor')
  await expect(page.getByTestId('normalized-workspace')).toBeVisible()
})
