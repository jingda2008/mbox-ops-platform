import {readFile} from 'node:fs/promises'
import {test,expect,type Page} from '@playwright/test'
const fixture=async()=>JSON.parse(await readFile('artifacts/normalized-browser/fixture.json','utf8'))
async function login(page:Page,f:Awaited<ReturnType<typeof fixture>>,employeeCode:string){await page.goto(f.staffUrl);await page.getByLabel('门店口令').fill(f.dailyCredential);await page.getByRole('button',{name:/验证设备/}).click();await page.getByLabel('员工账号').fill(employeeCode);await page.getByLabel('四位 PIN').fill(f.employeePin);await page.getByRole('button',{name:/进入工作台/}).click();await expect(page.getByTestId('normalized-workspace')).toBeVisible();await page.goto('/staff/live')}
for(const mode of ['order_gate','prepaid'])test(`opens a table with ${mode}, exact amount and a preserved server result`,async({page,browser})=>{
 test.setTimeout(90000)
 const f=await fixture();await page.setViewportSize({width:390,height:844})
 await page.goto(f.staffUrl);await page.getByLabel('门店口令').fill(f.dailyCredential);await page.getByRole('button',{name:/验证设备/}).click()
 await page.getByLabel('员工账号').fill(f.employeeCode);await page.getByLabel('四位 PIN').fill(f.employeePin);await page.getByRole('button',{name:/进入工作台/}).click()
 await expect(page.getByTestId('normalized-workspace')).toBeVisible();await page.goto('/staff/live')
 await page.getByRole('group',{name:'桌台显示范围'}).getByRole('button',{name:/^全部(?:\s|$)/}).click()
 const empty=page.locator('.staff-table-tile').filter({hasText:'空台'}).first();const tableCode=await empty.locator('strong').innerText();await empty.click()
 await page.getByLabel('最低消费方式',{exact:true}).selectOption(mode)
 await page.getByLabel('本次开台最低消费（元）',{exact:true}).fill('100.01')
 await page.getByLabel('实际到店人数',{exact:true}).fill('2')
 const primary=page.getByLabel('主服务员（必选）');const option=await primary.locator('option').evaluateAll(nodes=>nodes.map(n=>(n as HTMLOptionElement).value).find(Boolean)!)
 await primary.selectOption(option)
 const response=page.waitForResponse(r=>r.url().includes('/table-management/sessions/open')&&r.request().method()==='POST')
 await page.getByRole('button',{name:'确认开台',exact:true}).click()
 const opened=await response;expect(opened.status(),await opened.text()).toBe(201)
 const body=await opened.json();expect(body.data).toMatchObject({minimumSpendMinor:10001,minimumSpendMode:mode})
 const minimum=page.getByRole('region',{name:'本桌最低消费'});await expect(minimum).toContainText('当前 ¥100.01')
 if(mode==='order_gate'){
  const scheduler=await browser.newPage(),server=await browser.newPage({viewport:{width:390,height:844}})
  try{
   await login(scheduler,f,f.employeeCode);await scheduler.getByRole('button',{name:/人员与责任桌/}).click()
   await scheduler.getByLabel('员工').selectOption({label:'Tom · tom'});await scheduler.getByLabel('本次岗位').selectOption({label:'服务员 · SERVER'})
   await scheduler.getByLabel('责任类型').selectOption('backup');await scheduler.getByLabel('搜索责任区域或桌台').fill(tableCode)
   await scheduler.locator('.staff-assignment-area label').filter({has:scheduler.getByText(tableCode,{exact:true})}).getByRole('checkbox').check()
   await scheduler.getByLabel('安排原因').fill('验证本人账号协助点单与低消放行');await scheduler.getByRole('button',{name:'发布 1 张桌台'}).click()
   await expect(scheduler.getByRole('status').filter({hasText:'Tom 已安排'})).toContainText('Tom 已安排 1 张责任桌')
   await login(server,f,'tom');await server.getByRole('button',{name:new RegExp('^'+tableCode+' \\d+人')}).click()
   await expect(server.getByRole('button',{name:'取消整桌低消'})).toBeHidden()
   await server.getByRole('button',{name:'协助点单',exact:true}).click();const sheet=server.getByRole('dialog',{name:tableCode+'协助点单'})
   await expect(sheet).toContainText('员工协助点单自动放行');await expect(sheet.getByRole('checkbox',{name:/低消/})).toBeHidden()
   await sheet.getByLabel('搜索菜单商品').fill(f.orderableProductName);await sheet.getByRole('button',{name:'加入'+f.orderableProductName}).click()
   await sheet.getByRole('button',{name:'查看已选'}).click();await sheet.getByRole('dialog',{name:'购物车明细'}).getByRole('button',{name:'核对无误，确认下单'}).click()
   const submitted=server.waitForResponse(r=>r.url().endsWith('/commerce/orders')&&r.request().method()==='POST')
   await sheet.getByRole('dialog',{name:'确认上单'}).getByRole('button',{name:'确认上单'}).click();const order=await submitted;expect(order.status(),await order.text()).toBe(201)
   expect((await order.json()).paymentStatus).toBe('unpaid');await expect(sheet).toBeHidden()
   await minimum.getByRole('button',{name:'刷新本桌低消'}).click();await minimum.getByText(/^低消操作记录（/).click();await expect(minimum).toContainText('本单放行');await expect(minimum).toContainText('Tom')
  }finally{await scheduler.close();await server.close()}
 }
 if(mode==='prepaid'){
  await expect(page.getByRole('region',{name:'本桌预收款结算'})).toBeVisible()
  await expect(page.getByRole('button',{name:'记录门槛减免'})).toBeHidden()
  // Manager requests refunds; cashier independently reviews and executes them.
  const owner=await browser.newPage({viewport:{width:390,height:844}})
  try{
   await owner.goto(f.staffUrl);await owner.getByLabel('门店口令').fill(f.dailyCredential);await owner.getByRole('button',{name:/验证设备/}).click()
   await owner.getByLabel('员工账号').fill(f.employees.find((employee:{roleNames:string[]})=>employee.roleNames.includes('收银员')).code);await owner.getByLabel('四位 PIN').fill(f.employeePin);await owner.getByRole('button',{name:/进入工作台/}).click()
   await expect(owner.getByTestId('normalized-workspace')).toBeVisible();await owner.goto('/staff/live')
   await owner.getByRole('button',{name:new RegExp('^'+tableCode+' \\d+人')}).click()
   const panel=owner.getByRole('region',{name:'本桌预收款结算'});await expect(panel).toBeVisible();await expect(panel).toContainText('差额收费未启用');await expect(panel).toContainText('100.01');await expect(panel.getByRole('button',{name:'记录门槛减免'})).toBeHidden();await expect(owner.getByRole('button',{name:'取消整桌低消'})).toBeHidden()
   expect(await owner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true)
   await owner.screenshot({path:'artifacts/normalized-browser/minimum-prepaid-finance-390.png',fullPage:true})
  }finally{await owner.close()}
 }
 await minimum.getByText('调整整桌低消',{exact:true}).click()
 await minimum.getByLabel('低消调整原因').fill('门店确认降低本桌低消');await minimum.getByLabel('调整后的整桌低消（元）').fill('80.01')
 await minimum.getByRole('button',{name:'降低整桌低消'}).click();await expect(minimum).toContainText('当前 ¥80.01')
 await minimum.getByLabel('低消调整原因').fill('负责人确认取消剩余要求');await minimum.getByLabel('确认取消本桌剩余低消要求').check()
 await minimum.getByRole('button',{name:'取消整桌低消'}).click();await expect(minimum).toContainText('当前 ¥0.00');await expect(minimum).toContainText('差额收费未启用')
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true)
 await minimum.scrollIntoViewIfNeeded();await page.getByRole('dialog',{name:tableCode+'桌台操作'}).evaluate(el=>{el.scrollTop=0})
 await page.screenshot({path:`artifacts/normalized-browser/minimum-${mode}-390.png`,fullPage:true})
})
test('guest prepaid panel validates consent and cents, resumes the original receipt and shows no charge for unknown result',async({page})=>{
 const f=await fixture();let calls=0
 // UI contract fixture only; database/payment authority is covered separately.
 await page.route('**/api/guest/shared-cart',async route=>{const response=await route.fetch();const body=await response.json();if(body.data)body.data.prepayment={mode:'prepaid',minimumMinor:10000,waiverMinor:0,qualifyingGoodsMinor:0,shortfallMinor:10000,availableMinor:0,receivedMinor:0,initialFundingRequiredMinor:10000,differenceChargingEnabled:false,mySharedReceipts:[],myPendingReceipts:[],message:'本桌预收款尚未支付，可分次点单，差额收费未启用。'};await route.fulfill({response,json:body})})
 await page.route('**/api/guest/table-prepayment',async route=>{calls++;expect(route.request().postDataJSON()).toMatchObject({amountMinor:10001,sharedTableConsent:'v1'});await route.fulfill({status:503,json:{error:{code:'PAYMENT_STATUS_REVIEW',message:'付款结果待核对，请继续原付款'}}})})
 await page.goto(f.guestUrl);const panel=page.getByRole('region',{name:'本桌预收款'});await expect(panel).toBeVisible()
 await panel.getByRole('button',{name:'预付／继续原付款'}).click();await expect(panel).toContainText('请先确认共享规则');expect(calls).toBe(0)
 await panel.getByRole('checkbox').check();await panel.getByLabel('预收或补充金额（元）').fill('100.001');await panel.getByRole('button',{name:'预付／继续原付款'}).click();await expect(panel).toContainText('最多两位小数');expect(calls).toBe(0)
 await panel.getByLabel('预收或补充金额（元）').fill('100.01');await panel.getByRole('button',{name:'预付／继续原付款'}).click();await expect(panel).toContainText('付款结果待核对')
 expect(calls).toBe(1);await expect(panel).toContainText('差额收费未启用')
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true)
 await page.screenshot({path:'artifacts/normalized-browser/minimum-guest-prepay-430.png',fullPage:true})
})
