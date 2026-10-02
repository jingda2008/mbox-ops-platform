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
 let recovered=false,historical=false
 await page.route('**/api/payments/finance-review?*',route=>route.fulfill({json:{urgentCount:recovered?0:1,hasMore:false,data:historical?[{id:'historical-ui-proof',publicId:'Pold-attempt',amountMinor:'8800',status:'pending',createdAt:'2026-09-11T16:39:11Z',tableCode:'B06',phase:'stopped',stopReason:'historical_system_attempt_review',financialSignals:[],historicalAssociation:{orders:[{order:{id:'original-order',publicId:'OrderCorrectlyPaid'},dueMinor:0,receipts:[{publicId:'ReceiptAlreadyCorrect',amountMinor:8800}]}]}}]:recovered?[]:[{id:'finance-ui-proof',publicId:'Pexample',amountMinor:'138000',status:'pending',createdAt:'2026-09-11T16:39:11Z',tableCode:'B06',financialSignals:['confirmed_payment_not_applied'],queryCount:2,ownerName:null}]}}))
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
 historical=true
 await panel.getByRole('button',{name:'刷新核对状态'}).click()
 await expect(panel.locator('article')).toContainText('无须顾客重付')
 await expect(panel.locator('article')).toContainText('OrderCorrectlyPaid')
 await expect(panel.locator('article')).toContainText('ReceiptAlreadyCorrect ¥88.00')
 await expect(panel.getByRole('button',{name:'核对完成，结案'})).toHaveCount(0)
 for(const width of [320,390]){
  await page.setViewportSize({width,height:800})
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1)).toBe(true)
 }

})

test('慢读取不显示空记录，展开不重复查询，失败后可以重试',async({page},testInfo)=>{
 const fixture=JSON.parse(await readFile('artifacts/normalized-browser/fixture.json','utf8'))
 await page.goto(fixture.staffUrl)
 await page.getByLabel('门店口令').fill(fixture.dailyCredential)
 await page.getByRole('button',{name:/验证设备/}).click()
 const employee=fixture.employees.find((item:{roleNames:string[]})=>item.roleNames.includes('收银员'))
 await page.getByLabel('员工账号').fill(employee.code)
 await page.getByLabel('四位 PIN').fill(fixture.employeePin)
 await page.getByRole('button',{name:/进入工作台/}).click()
 await expect(page.getByTestId('normalized-workspace')).toBeVisible()
 await page.route('**/api/payments/workbench?*',route=>route.fulfill({status:503,json:{error:{code:'WORKBENCH_UNAVAILABLE',message:'请求超时，请重试'}}}))
 let release!:()=>void,requests=0
 const gate=new Promise<void>(resolve=>{release=resolve})
 await page.route('**/api/payments/finance-review?*',async route=>{
  requests++
  if(requests===1){await gate;await route.fulfill({status:503,json:{error:{code:'FINANCE_REVIEW_UNAVAILABLE',message:'核对读取暂时不可用'}}});return}
  await route.fulfill({json:{urgentCount:0,hasMore:false,data:[]}})
 })
 await page.goto('/staff/payments')
 const panel=page.locator('.payment-finance-review')
 await panel.locator('summary').click()
 await expect(panel.getByRole('status')).toContainText('正在读取财务核对记录')
 await expect(panel.getByText('当前没有待核对记录。')).toHaveCount(0)
 await expect(panel.getByRole('button',{name:'正在读取…'})).toBeDisabled()
 expect(requests).toBe(1)
 release()
 await expect(panel.getByRole('alert')).toContainText('尚不能判断是否有待核对记录')
 for(const width of [320,390]){
  await page.setViewportSize({width,height:844})
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1)).toBe(true)
 }
 await expect(page.getByText('收银订单读取失败',{exact:true})).toBeVisible()
 const orderBox=await page.locator('.cashier-workbench-state').boundingBox(),financeBox=await panel.boundingBox()
 expect(orderBox!.y).toBeLessThan(financeBox!.y)
 await panel.screenshot({path:testInfo.outputPath('finance-read-failed-390.png')})
 await panel.getByRole('button',{name:'刷新核对状态'}).click()
 await expect(panel.getByText('当前没有待核对记录。')).toBeVisible()
 await expect(panel.getByRole('alert')).toHaveCount(0)
 expect(requests).toBe(2)
})

test('收银慢刷新合并重复事件，财务面板保持挂载',async({page})=>{
 const fixture=JSON.parse(await readFile('artifacts/normalized-browser/fixture.json','utf8'))
 await page.goto(fixture.staffUrl)
 await page.getByLabel('门店口令').fill(fixture.dailyCredential)
 await page.getByRole('button',{name:/验证设备/}).click()
 const employee=fixture.employees.find((item:{roleNames:string[]})=>item.roleNames.includes('收银员'))
 await page.getByLabel('员工账号').fill(employee.code)
 await page.getByLabel('四位 PIN').fill(fixture.employeePin)
 await page.getByRole('button',{name:/进入工作台/}).click()
 await expect(page.getByTestId('normalized-workspace')).toBeVisible()
 let financeReads=0,reads=0,hold=false,release!:()=>void
 const gate=new Promise<void>(resolve=>{release=resolve})
 await page.route('**/api/payments/finance-review?*',route=>{financeReads++;return route.fulfill({json:{data:[],urgentCount:0,hasMore:false}})})
 await page.route('**/api/payments/workbench?*',async route=>{
  reads++;const response=await route.fetch()
  if(hold)await gate
  await route.fulfill({response})
 })
 await page.goto('/staff/payments')
 await expect(page.locator('.cashier-workbench')).toBeVisible()
 expect(financeReads).toBe(1)
 const panel=page.locator('.payment-finance-review')
 await panel.locator('summary').click()
 const initial=reads;hold=true
 await page.evaluate(()=>{for(let i=0;i<8;i++)document.dispatchEvent(new Event('visibilitychange'))})
 await expect.poll(()=>reads).toBe(initial+1)
 await page.evaluate(()=>{for(let i=0;i<8;i++)document.dispatchEvent(new Event('visibilitychange'))})
 expect(reads).toBe(initial+1)
 const response=page.waitForResponse('**/api/payments/workbench?*')
 release()
 await response
 await expect(panel).toHaveAttribute('open','')
 await page.unrouteAll({behavior:'wait'})
})
