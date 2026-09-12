import {readFile} from 'node:fs/promises'
import {test,expect} from '@playwright/test'

test('finance alert remains visible while collapsed and identifies confirmed unapplied payment',async({page})=>{
 const fixture=JSON.parse(await readFile('artifacts/normalized-browser/fixture.json','utf8'))
 await page.goto(fixture.staffUrl)
 await page.getByLabel('门店口令').fill(fixture.dailyCredential)
 await page.getByRole('button',{name:/验证设备/}).click()
 const employee=fixture.employees.find((item:{roleNames:string[]})=>item.roleNames.includes('收银员'))
 await page.getByLabel('员工账号').fill(employee.code)
 await page.getByLabel('四位 PIN').fill(fixture.employeePin)
 await page.getByRole('button',{name:/进入工作台/}).click()
 await expect(page.getByTestId('normalized-workspace')).toBeVisible()
 // Explicit UI fixture: financial correctness is tested against PostgreSQL separately.
 let recovered=false
 await page.route('**/api/payments/finance-review?*',route=>route.fulfill({json:{urgentCount:recovered?0:1,hasMore:false,data:recovered?[]:[{id:'finance-ui-proof',publicId:'Pexample',amountMinor:'138000',status:'pending',createdAt:'2026-09-11T16:39:11Z',tableCode:'B06',financialSignals:['confirmed_payment_not_applied'],queryCount:2,ownerName:null}]}}))
 await page.goto('/staff/payments')
 const panel=page.locator('.payment-finance-review')
 await expect(panel.locator('summary')).toContainText('1笔到账异常待处理')
 await panel.locator('summary').click()
 await expect(panel.getByRole('alert')).toContainText('请勿向客人重复收款')
 await expect(panel.locator('article')).toHaveCount(1)
 await expect(panel.getByRole('button',{name:'核对完成，结案'})).toHaveCount(0)
 await panel.getByRole('button',{name:'刷新核对状态'}).click()
 await expect(panel.locator('article')).toHaveCount(1)
 for(const width of [320,390]){
  await page.setViewportSize({width,height:800})
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1)).toBe(true)
 }
 recovered=true
 await panel.getByRole('button',{name:'刷新核对状态'}).click()
 await expect(panel.locator('summary')).not.toContainText('到账异常')
 await expect(panel.locator('article')).toHaveCount(0)
})
