import {readFile} from 'node:fs/promises'
import {test,expect} from '@playwright/test'
test('staff collects arbitrary amounts, then the unpaid remainder, with surplus available on the same table',async({page},testInfo)=>{
 const fixture=JSON.parse(await readFile('artifacts/normalized-browser/fixture.json','utf8'))
 test.skip(!fixture.crossDayDebtFixture?.creditOrderId,'Requires isolated credit fixture')
 await page.setViewportSize({width:390,height:844});await page.goto(fixture.staffUrl)
 await page.getByLabel('门店口令').fill(fixture.dailyCredential);await page.getByRole('button',{name:/验证设备/}).click()
 await page.getByLabel('员工账号').fill('sanmu');await page.getByLabel('四位 PIN').fill(fixture.employeePin);await page.getByRole('button',{name:/进入工作台/}).click()
 await expect(page.getByTestId('normalized-workspace')).toBeVisible()
 const id=fixture.crossDayDebtFixture.creditOrderId
 await page.goto(`/staff/payments?query=CREDIT-BROWSER-1100&orderId=${id}`)
 const card=page.locator(`[data-cashier-order-id="${id}"]`),panel=card.getByRole('region',{name:'自填收款与本桌余额'})
 await panel.getByRole('button',{name:'自填收款／预收与补款',exact:true}).click()
 await expect(panel).toContainText('待付 ¥1100.00')
 async function collect(amount:string,receipt:string){
  await panel.getByLabel('本次收款金额（元）',{exact:true}).fill(amount)
  await panel.getByLabel('付款人及收款说明').fill('隔离验收：顾客确认本桌共享点单')
  await panel.getByLabel('收款方式').selectOption('cash');await panel.getByLabel('实收凭证号').fill(receipt)
  await panel.getByLabel('付款人已确认原款用于本桌所选订单及后续共同点单，余款不自动转服务费').check()
  await panel.getByRole('button',{name:'核对本次收款'}).click()
  const result=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/api/payments/table-prepayment'))
  await panel.getByRole('button',{name:'确认已实际收到本次款项'}).click();const response=await result
  expect(response.status(),await response.text()).toBe(200)
 }
 await collect('800','browser-credit-first')
 await expect(card).toContainText('剩余应收 ¥300.00')
 // A workbench refresh may remount the order card; reopen its read-only balance.
 if(!await panel.getByLabel('本次收款金额（元）',{exact:true}).isVisible())await panel.getByRole('button',{name:'自填收款／预收与补款',exact:true}).click()
 await expect(panel).toContainText('待付 ¥300.00')
 await collect('700','browser-credit-second')
 await page.reload()
 await panel.getByRole('button',{name:'自填收款／预收与补款',exact:true}).click()
 await expect(panel).toContainText('预收累计实收 ¥1500.00');await expect(panel).toContainText('可用余额 ¥400.00');await expect(panel).toContainText('预收要求还差 ¥0.00')
 await expect(panel.getByText('待付 ¥300.00',{exact:false})).toHaveCount(0)
 const size=await page.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}))
 expect(size.scroll).toBeLessThanOrEqual(size.width+1)
 await page.screenshot({path:testInfo.outputPath('staff-credit-1500-1100-400.png'),fullPage:true})
})
