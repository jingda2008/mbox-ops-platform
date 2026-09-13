import {readFile} from 'node:fs/promises'
import {expect,test} from '@playwright/test'

test('late captured stopped goods expose a funds-only request without restoring production',async({page},testInfo)=>{
  const fixture=JSON.parse(await readFile('artifacts/normalized-browser/fixture.json','utf8'))
  await page.setViewportSize({width:390,height:844})
  await page.goto(fixture.staffUrl)
  await page.getByLabel('门店口令').fill(fixture.dailyCredential)
  await page.getByRole('button',{name:/验证设备/}).click()
  const cashier=fixture.employees.find((employee:{roleNames:string[]})=>employee.roleNames.includes('收银员'))
  await page.getByLabel('员工账号').fill(cashier.code)
  await page.getByLabel('四位 PIN').fill(fixture.employeePin)
  await page.getByRole('button',{name:/进入工作台/}).click()
  await expect(page.getByTestId('normalized-workspace')).toBeVisible()
  // Controlled read-model UI probe. Financial and inventory transitions are
  // separately exercised against PostgreSQL; this never submits a real refund.
  const item={id:'late-capture-item',productName:'已停止瓶装水',quantity:5,totalAmountMinor:4000,status:'cancelled'}
  await page.route('**/api/payments/workbench?*',async route=>{
    const response=await route.fetch(),body=await response.json()
    const original=body.data,now=new Date().toISOString()
    original.query='';original.summary={...original.summary,orderCount:1,capturedPaymentCount:1,requestedRefundCount:0,processingRefundCount:0}
    original.orders=[{id:'late-capture-order',publicId:'LATE-CAPTURE-STOPPED',tableCode:'B05',areaId:'late-area',areaName:'隔离测试',channel:'staff_assisted',status:'submitted',paymentStatus:'paid',businessDate:original.businessDate,
      totalAmountMinor:0,originalAmountMinor:4000,stoppedAmountMinor:4000,outstandingAmountMinor:0,overCollectedAmountMinor:4000,currency:'CNY',submittedAt:now,createdAt:now,items:[item],kdsTasks:[],payments:[{
        id:'late-capture-payment',publicId:'LATE-PAYMENT-ORIGINAL',provider:'postar',method:'native_qr',providerTransactionId:'LATE-PROVIDER',providerActionState:'consumed',retryReleasedAt:null,retryReleaseReason:null,
        amountMinor:4000,currency:'CNY',status:'succeeded',succeededAt:now,createdAt:now,reservedRefundAmountMinor:0,remainingRefundableMinor:4000,refunds:[],refundableItems:[{...item,fundsOnly:true,reservedRefundAmountMinor:0,remainingRefundableMinor:4000}],
      }]}]
    await route.fulfill({response,json:body})
  })
  let submitted:Record<string,unknown>|undefined
  await page.route('**/api/payments/late-capture-payment/refunds',async route=>{
    submitted=route.request().postDataJSON()
    await route.fulfill({status:409,json:{error:{code:'TEST_NO_MUTATION',message:'隔离页面验证已读取请求，未执行退款'}}})
  })
  await page.goto('/staff/payments')
  const card=page.locator('[data-cashier-order-id="late-capture-order"]')
  await card.locator('.cashier-order-toggle').click()
  await expect(card.getByText(/本单已确认多收 ¥40.00/)).toBeVisible()
  await card.getByRole('button',{name:'选择原商品发起退款'}).click()
  const form=card.locator('.cashier-refund-form'),purpose=form.getByLabel('本次处理')
  await expect(purpose).toHaveValue('price_adjustment')
  await expect(form.getByText(/不自动恢复制作或退库/)).toBeVisible()
  const selected=form.locator('.cashier-refund-item input[type="checkbox"]')
  await purpose.selectOption('return_goods');await expect(selected).toBeDisabled()
  await purpose.selectOption('price_adjustment');await selected.check()
  await form.getByLabel('退款原因').fill('原商品已停止，核对后到的原多收款')
  const submit=form.getByRole('button',{name:'提交退款'})
  await expect(submit).toBeEnabled()
  await purpose.selectOption('service_compensation');await expect(submit).toBeDisabled()
  await purpose.selectOption('price_adjustment');await expect(submit).toBeEnabled()
  const width=await page.evaluate(()=>({viewport:document.documentElement.clientWidth,content:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)}))
  expect(width.content).toBeLessThanOrEqual(width.viewport+1)
  await page.screenshot({path:testInfo.outputPath('late-capture-funds-only-390.png'),fullPage:true})
  await submit.click()
  await expect.poll(()=>submitted).toMatchObject({purpose:'price_adjustment',allocations:[{orderItemId:item.id,amountMinor:4000}]})
})
