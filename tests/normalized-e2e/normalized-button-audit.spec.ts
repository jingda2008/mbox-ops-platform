import {readFile} from 'node:fs/promises'
import {test,expect} from '@playwright/test'

test.use({viewport:{width:1024,height:600},isMobile:false,hasTouch:true})

// Audit reproduction: assert the observed defect, not a passing acceptance gate.
test('AUDIT pickup-only original-task link loops back to the pickup screen',async({page},testInfo)=>{
  const f=JSON.parse(await readFile('artifacts/normalized-browser/fixture.json','utf8'))
  await page.goto('/')
  await page.getByLabel('门店口令').fill(f.dailyCredential)
  await page.getByRole('button',{name:/验证设备/}).click()
  await page.getByLabel('员工账号').fill('wuya')
  await page.getByLabel('四位 PIN').fill(f.employeePin)
  await page.getByRole('button',{name:/进入工作台/}).click()
  await expect(page.getByTestId('normalized-workspace')).toBeVisible()
  await page.goto('/staff/fulfillment?screen=pickup')
  await page.getByRole('button',{name:'设为取餐屏',exact:true}).click()
  await page.getByRole('button',{name:'切换工作账号',exact:true}).click()
  await page.getByLabel('员工账号').fill('test_pickup_only')
  await page.getByLabel('四位 PIN').fill(f.employeePin)
  await page.getByRole('button',{name:/进入工作台/}).click()
  await expect(page.locator('.pickup-connection')).toHaveText('已更新')
  const taskId='caaa0000-0000-4000-8000-000000000099'
  await page.route('**/api/commerce/pickup-board',async route=>{
    const response=await route.fetch(),body=await response.json()
    body.data.attention=[{taskId,message:'旧出品有退库、异常或拆份待核对，请从原任务继续处理；尚未标记取走',href:`/staff/fulfillment?factId=${taskId}`}]
    await route.fulfill({response,json:body})
  })
  await page.goto('/staff/fulfillment?screen=pickup')
  await page.locator('.pickup-attention summary').click()
  await page.getByRole('link',{name:'查看原出品',exact:true}).click()
  await expect(page).toHaveURL(new RegExp(`factId=${taskId}`))
  await expect(page.getByRole('region',{name:'吧台取餐工作台'})).toBeVisible()
  await expect(page.locator(`[data-action-fact-id="${taskId}"]`)).toHaveCount(0)
  await page.locator('.pickup-attention summary').click()
  await expect(page.getByRole('link',{name:'查看原出品',exact:true})).toBeVisible()
  await page.screenshot({path:testInfo.outputPath('pickup-original-task-loop.png')})
})
