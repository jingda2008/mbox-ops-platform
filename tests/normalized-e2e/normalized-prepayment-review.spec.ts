import {readFile} from 'node:fs/promises'
import {expect,test} from '@playwright/test'
test('prepayment refund refresh applies the current reviewer and currency limit before showing approval',async({page})=>{
 const f=JSON.parse(await readFile('artifacts/normalized-browser/fixture.json','utf8'))
 const id='10000000-0000-4000-8000-000000000099'
 const reviewer={employeeId:'reviewer',canApproveRefund:true,refundApprovalLimits:{} as Record<string,number>}
 await page.route('**/api/table-management/prepayments',route=>route.fulfill({json:{data:[{id,tableCode:'演示W2',businessDate:'2026-11-16',status:'closed',unsettled:true}],meta:{nextCursor:null}}}))
 await page.route(`**/api/table-management/sessions/${id}/minimum-spend`,route=>route.fulfill({json:{data:null}}))
 await page.route(`**/api/table-management/sessions/${id}/prepayment`,route=>route.fulfill({json:{data:{minimumMinor:0,waiverMinor:0,qualifyingGoodsMinor:0,shortfallMinor:0,availableMinor:0,refundableBalanceMinor:0,message:'隔离预收款退款',receipts:[],refunds:[{id:'r',publicId:'教学退款',paymentId:'p',status:'requested',amountMinor:'2000',currency:'CNY',requestedByEmployeeId:'requester'}],reviewer}}}))
 await page.setViewportSize({width:390,height:844});await page.goto(f.staffUrl)
 await page.getByLabel('门店口令').fill(f.dailyCredential);await page.getByRole('button',{name:/验证设备/}).click()
 await page.getByLabel('员工账号').fill('sanmu');await page.getByLabel('四位 PIN').fill(f.employeePin);await page.getByRole('button',{name:/进入工作台/}).click()
 await expect(page.getByTestId('normalized-workspace')).toBeVisible();await page.goto('/staff/live')
 await page.getByRole('button',{name:'低消、预收款与往期结算',exact:true}).click()
 await page.getByRole('button',{name:/演示W2 · 2026-11-16/}).click()
 const panel=page.getByRole('region',{name:'本桌预收款结算'})
 await expect(panel).toContainText('未配置有效的 CNY');await expect(panel.getByRole('button',{name:'复核通过',exact:true})).toHaveCount(0)
 reviewer.refundApprovalLimits={CNY:2000};await panel.getByRole('button',{name:'刷新资金状态'}).click()
 await expect(panel.getByRole('button',{name:'复核通过',exact:true})).toBeVisible()
 reviewer.employeeId='requester';await panel.getByRole('button',{name:'刷新资金状态'}).click()
 await expect(panel).toContainText('发起人不能审核');await expect(panel.getByRole('button',{name:'复核通过',exact:true})).toHaveCount(0)
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true)
})
