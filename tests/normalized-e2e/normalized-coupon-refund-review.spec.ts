import {readFile} from 'node:fs/promises'
import {expect,test} from '@playwright/test'

for(const width of [320,360])test(`coupon refund review explicit decision and layout ${width}px`,async({page},testInfo)=>{
 const fixture=JSON.parse(await readFile('artifacts/normalized-browser/fixture.json','utf8'))
 test.skip(!fixture.memberCardFixture,'Requires isolated member configuration fixture')
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message))
 const row={refund_id:'11111111-1111-4111-8111-111111111111',reservation_id:'22222222-2222-4222-8222-222222222222',order_reference:'隔离订单-不可用于真实收退款-长编号测试000000001',refund_reference:'隔离退款00000001',refund_amount_minor:'100',currency:'CNY',benefit_code:'限时小食固定价权益-长名称换行验证',quantity:2,status:'redeemed',action:null as string|null,reason:null as string|null,evidence_reference:null as string|null}
 const requests:Array<Record<string,unknown>>=[],replacementId='33333333-3333-4333-8333-333333333333'
 await page.route('**/api/staff/member-gifts/refund-replacement-options**',route=>route.fulfill({json:{data:{items:[{id:replacementId,benefit_code:'隔离补偿小食券',quantity_total:1,valid_until:null}],nextCursor:null}}}))
 // UI contract fixture only. Actual permission/financial-state/immutability
 // checks are covered independently in HTTP and PostgreSQL tests.
 await page.route('**/api/staff/member-gifts/refund-reviews**',async route=>{
  if(route.request().method()==='POST'){
   const body=route.request().postDataJSON();requests.push(body)
   row.action=body.action;row.reason=body.reason;row.evidence_reference=body.evidenceReference
   Object.assign(row,{replacement_benefit_id:body.replacementBenefitId??null,replacement_quantity:body.replacementBenefitId?1:null})
   await route.fulfill({json:{data:{recorded:true,replayed:false},meta:{replayed:false}}});return
  }
  const resolved=new URL(route.request().url()).searchParams.get('state')==='resolved'
  await route.fulfill({json:{data:{items:Boolean(row.action)===resolved?[row]:[],nextCursor:null}}})
 })
 await page.setViewportSize({width,height:700});await page.goto(fixture.staffUrl)
 await page.getByLabel('门店口令').fill(fixture.dailyCredential);await page.getByRole('button',{name:/验证设备/}).click()
 await page.getByLabel('员工账号').fill('chenfangyu');await page.getByLabel('四位 PIN').fill(fixture.employeePin);await page.getByRole('button',{name:/进入工作台/}).click()
 await expect(page.getByTestId('normalized-workspace')).toBeVisible();await page.goto('/staff/member-management');await page.getByRole('button',{name:/会员经营配置中心/}).click()
 const panel=page.locator('.coupon-refund-reviews');await panel.locator('summary').click()
 await panel.getByRole('button',{name:'读取待复核权益',exact:true}).click()
 await expect(panel).toContainText(row.benefit_code)
 await panel.getByRole('button',{name:'复核此权益',exact:true}).click()
 const submit=panel.getByRole('button',{name:'记录权益处理',exact:true});await expect(submit).toBeDisabled()
 await panel.getByRole('combobox',{name:'权益处理方式',exact:true}).selectOption(width===320?'no_return':'replacement_coupon')
 await panel.getByLabel('权益复核原因',{exact:true}).fill('隔离验收，已制作，按客户确认的原规则不返券')
 await panel.getByLabel('规则或补偿凭证',{exact:true}).fill('隔离客服记录-不可用于真实业务')
 if(width===360){
  await expect(submit).toBeDisabled()
  await panel.getByRole('button',{name:'读取本人新券',exact:true}).click()
  await panel.getByRole('combobox',{name:'已发补偿券',exact:true}).selectOption(replacementId)
 }
 await expect(submit).toBeEnabled()
 const size=await page.evaluate(()=>({viewport:document.documentElement.clientWidth,content:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)}));expect(size.content).toBeLessThanOrEqual(size.viewport+1)
 await panel.screenshot({path:testInfo.outputPath('coupon-refund-review.png')})
 await submit.click();await page.getByRole('alertdialog').getByRole('button',{name:'记录复核结果',exact:true}).click()
 await expect(panel.getByRole('status')).toContainText('权益复核已记录')
 await expect(panel).toContainText('当前没有待复核权益')
 await panel.getByRole('button',{name:'已处理记录',exact:true}).click();await expect(panel).toContainText(width===320?'按原规则不返券':'已关联补偿券 1份')
 expect(requests).toHaveLength(1);expect(requests[0]).not.toHaveProperty('amountMinor');expect(requests[0]?.reservationId).toBe(row.reservation_id)
 if(width===360)expect(requests[0]?.replacementBenefitId).toBe(replacementId)
 expect(errors).toEqual([])
})
