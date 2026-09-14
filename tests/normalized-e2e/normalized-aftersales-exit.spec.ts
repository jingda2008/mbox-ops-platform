import {readFile} from 'node:fs/promises'
import type {ItemAfterSalesWorkspace} from '../../src/shared/item-after-sales'
import {test,expect,type Page} from '@playwright/test'
const snapshot:ItemAfterSalesWorkspace={item:{id:'item',orderId:'order',name:'芙丝矿泉水',quantity:1,originalAmountMinor:7800,unitPriceMinor:7800,status:'submitted',orderPublicId:'Oa48117b4c9e68e3e25fdeae363c4518c',tableCode:'S6',tableSessionId:'session',bundle:false},fundingSources:[],canRequest:false,canExecuteRefund:true,canReceive:true,canRecordUsed:true,canAcknowledgeNotices:true,units:[{id:'unit',index:0,productionState:'ready',heldByCaseId:'b8674c5a-22b9-4b89-a35f-6d23c0685bd2',stoppedByCaseId:null,inventoryEvidence:'allocated'}],cases:[{caseId:'b8674c5a-22b9-4b89-a35f-6d23c0685bd2',orderId:'order',kind:'paid_return',status:'approved',businessDate:'2026-09-14',amountMinor:7800,selectedQuantity:1,heldQuantity:1,stoppedQuantity:0,madeQuantity:1,inventoryReviewQuantity:0,physicalComplete:false,moneyComplete:true,succeededMinor:7800,refundFailed:false,refundNeedsReview:false,awaitingCashPayout:false,unconfirmedNoticeCount:1,notices:[{id:'notice',stationCode:'bar',instruction:'暂停后续制作和取送',createdAt:'2026-09-14T13:43:14Z',printState:'printed'}],refunds:[{id:'refund',status:'succeeded',amountMinor:7800,provider:'postar'}],canResolveUnpaid:false,reason:'客人临时不要了',createdAt:'2026-09-14T13:34:12Z',canApprove:false,canReject:false,canWithdraw:false,canResume:false,canDisposeMade:true,canReplace:true,pricing:{policy:'captured_payment',refundAmountMinor:7800,receivableDeltaMinor:-7800,effectiveAmountMinor:4000,availablePaidMinor:11800,components:[]}}]};
snapshot.units[0].returnEligibility={canReturn:true,reason:null};
async function open(page:Page,options:{loadFails?:boolean;conflict?:boolean}={}){
  const fixture=JSON.parse(await readFile('artifacts/normalized-browser/fixture.json','utf8'))
  const data=structuredClone(snapshot)
  if(options.conflict)data.units[0].returnEligibility={canReturn:false,reason:'原记录扣减500毫升，与包装记录330毫升/瓶不一致，请交库存负责人核对。'}
  await page.route('**/api/commerce/item-after-sales/access',route=>route.fulfill({json:{data:{enabled:true,employeeId:'employee'}}}))
  await page.route('**/api/commerce/item-after-sales/pending*',route=>route.fulfill({json:{data:{items:[{...data.cases[0],orderItemId:'item',productName:'芙丝矿泉水',tableCode:'S6',requesterName:'李艳'}],nextCursor:null}}}))
  await page.route('**/api/commerce/item-after-sales/items/item',route=>options.loadFails?route.fulfill({status:503,json:{error:{code:'READ_FAILED',message:'原记录暂未读回，请刷新核对'}}}):route.fulfill({json:{data}}))
  await page.goto(fixture.staffUrl)
  await page.getByLabel('门店口令').fill(fixture.dailyCredential)
  await page.getByRole('button',{name:/验证设备/}).click()
  await page.getByLabel('员工账号').fill('sanmu')
  await page.getByLabel('四位 PIN').fill(fixture.employeePin)
  await page.getByRole('button',{name:/进入工作台/}).click()
  await expect(page.getByTestId('normalized-workspace')).toBeVisible()
  await page.goto('/staff/payments')
  await page.getByRole('button',{name:'处理商品',exact:true}).click()
  return page.getByRole('dialog',{name:'商品停止与退款',exact:true})
}
async function visibleExit(page:Page){
  const rect=await page.getByRole('button',{name:'关闭商品处理',exact:true}).boundingBox()
  expect(rect).not.toBeNull();expect(rect!.width).toBeGreaterThanOrEqual(44);expect(rect!.height).toBeGreaterThanOrEqual(44)
  expect(rect!.y).toBeGreaterThanOrEqual(0);expect(rect!.y+rect!.height).toBeLessThanOrEqual(page.viewportSize()!.height)
  // Coordinate clickability, not Playwright's automatic scroll-to-button.
  expect(await page.evaluate(({x,y})=>document.elementFromPoint(x,y)?.closest('button')?.textContent,{x:rect!.x+rect!.width/2,y:rect!.y+rect!.height/2})).toBe('关闭商品处理')
}
test('after-sales exit remains visible during long errors, polling, small views and enlarged text',async({page})=>{
  let writes=0
  await page.route('**/api/commerce/item-after-sales/*/physical',route=>{writes++;return route.fulfill({status:409,json:{error:{code:'PRODUCTION_REVIEW_REQUIRED',message:'库存记录待核对：原记录扣减500毫升，与包装记录330毫升/瓶不一致。'.repeat(5)}}})})
  await page.clock.install()
  await page.setViewportSize({width:390,height:650})
  const dialog=await open(page)
  await dialog.getByLabel('已实际收回且未开封').check()
  await dialog.getByRole('button',{name:'确认收回入库',exact:true}).click()
  await expect(dialog.getByRole('alert')).toBeVisible();await visibleExit(page)
  const background=await page.evaluate(()=>window.scrollY)
  const region=dialog.locator('[data-dialog-scroll]')
  await region.evaluate(element=>element.scrollTop=element.scrollHeight)
  const scroll=await region.evaluate(element=>element.scrollTop)
  await page.clock.fastForward(11000)
  await expect.poll(()=>region.evaluate(element=>element.scrollTop)).toBe(scroll)
  expect(await page.evaluate(()=>window.scrollY)).toBe(background)
  for(const viewport of [{width:320,height:568},{width:844,height:390},{width:390,height:300}]){
    await page.setViewportSize(viewport);await page.clock.runFor(20);await visibleExit(page)
  }
  await page.addStyleTag({content:'.staff-item-after-sales p,.staff-item-after-sales button{font-size:24px!important}'})
  await visibleExit(page)
  await page.screenshot({path:'artifacts/normalized-browser/aftersales-visible-exit.png'})
  const rect=await dialog.getByRole('button',{name:'关闭商品处理'}).boundingBox()
  await page.mouse.click(rect!.x+rect!.width/2,rect!.y+rect!.height/2)
  await expect(dialog).toHaveCount(0);expect(writes).toBe(1)
  await expect(page.getByRole('button',{name:'处理商品',exact:true})).toBeFocused()
})
test('after-sales load failure and stock conflict both allow exit without a business write',async({page})=>{
  let writes=0;page.on('request',request=>{if(request.method()==='POST'&&request.url().includes('/item-after-sales/'))writes++})
  const dialog=await open(page,{conflict:true})
  await expect(dialog).toContainText('500毫升');await expect(dialog).toContainText('退款已完成，不用再次退款')
  await expect(dialog.getByRole('button',{name:'确认收回入库'})).toHaveCount(0)
  await visibleExit(page);await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0)
  await page.route('**/api/commerce/item-after-sales/items/item',route=>route.fulfill({status:503,json:{error:{code:'READ_FAILED',message:'原记录暂未读回'}}}))
  await page.getByRole('button',{name:'处理商品',exact:true}).click()
  await expect(dialog.getByRole('alert')).toContainText('原记录暂未读回');await visibleExit(page)
  await dialog.getByRole('button',{name:'关闭商品处理'}).click();expect(writes).toBe(0)
  await expect(page.getByRole('region',{name:'商品售后待办'})).toContainText('已退款 ¥78.00')
  await expect(page.getByRole('region',{name:'商品售后待办'})).toContainText('待处理 1 份')
})
test('closing an in-flight after-sales write preserves its original recovery key',async({page})=>{
  const requests:Array<{key:string;body:string|null}>=[];let release:()=>void=()=>{}
  await page.route('**/api/commerce/item-after-sales/*/physical',async route=>{
    requests.push({key:route.request().headers()['idempotency-key'],body:route.request().postData()})
    if(requests.length===1){await new Promise<void>(resolve=>{release=resolve});await route.abort('failed')}
    else await route.fulfill({json:{data:{status:'approved'}}})
  })
  const dialog=await open(page)
  await dialog.getByLabel('已实际收回且未开封').check()
  await dialog.getByRole('button',{name:'确认收回入库',exact:true}).click()
  await expect.poll(()=>requests.length).toBe(1);await visibleExit(page)
  await dialog.getByRole('button',{name:'关闭商品处理'}).click();await expect(dialog).toHaveCount(0)
  release()
  await page.getByRole('button',{name:'处理商品',exact:true}).click()
  await dialog.getByRole('button',{name:'恢复上次商品处理'}).click()
  await expect(dialog).toContainText('商品处理进度已更新')
  expect(requests).toHaveLength(2);expect(requests[1]).toEqual(requests[0])
})
test('Escape closes only the replacement layer before the parent after-sales dialog',async({page})=>{
  const dialog=await open(page)
  await dialog.getByRole('button',{name:'换商品，另开新单'}).click()
  const child=page.getByRole('dialog',{name:'S6协助点单',exact:true})
  await expect(child).toBeVisible();await expect(child.getByRole('button',{name:'关闭点单',exact:true})).toBeInViewport()
  await page.keyboard.press('Escape');await expect(child).toHaveCount(0);await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button',{name:'换商品，另开新单'})).toBeFocused()
  await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0)
})
test('cashier opens the linked original case and keeps ordinary refund controls separate',async({page})=>{
  const parent=await open(page);await parent.getByRole('button',{name:'关闭商品处理'}).click()
  const instant='2026-09-14T13:34:12Z',linked=snapshot.cases[0].caseId
  const refund={id:'refund',publicId:'normal-looking-id',paymentId:'payment',providerRefundId:null,amountMinor:7800,currency:'CNY',status:'requested',providerSubmissionState:'not_started',reason:'原商品售后测试',requestedByEmployeeId:'requester',requestedByEmployeeName:'李艳',approvedByEmployeeId:null,approvedByEmployeeName:null,decisionReason:null,receiptReference:null,completedAt:null,createdAt:instant,allocations:[{orderItemId:'item',amountMinor:7800}],afterSalesCase:{caseId:linked,orderItemId:'item',status:'requested'}}
  await page.route('**/api/payments/workbench?*',async route=>{
    const response=await route.fetch(),body=await response.json()
    body.data.actions.canApproveRefund=true
    body.data.orders=[{id:'order',publicId:'test-original-order',tableCode:'S6',channel:'staff_assisted',status:'submitted',paymentStatus:'paid',totalAmountMinor:11800,outstandingAmountMinor:0,overCollectedAmountMinor:0,currency:'CNY',submittedAt:instant,createdAt:instant,items:[],kdsTasks:[],payments:[{id:'payment',publicId:'test-payment',provider:'cash',method:'cash',providerTransactionId:null,providerActionState:null,retryReleasedAt:null,retryReleaseReason:null,amountMinor:11800,currency:'CNY',status:'succeeded',succeededAt:instant,createdAt:instant,reservedRefundAmountMinor:7800,remainingRefundableMinor:4000,refundableItems:[],refunds:[refund,{...refund,id:'ordinary',reason:'独立资金调整测试',afterSalesCase:null}]}]}]
    await route.fulfill({json:body})
  })
  await page.goto('/staff/payments')
  await page.locator('[data-cashier-order-id="order"] .cashier-order-toggle').click()
  const rows=page.locator('.cashier-refund-row'),caseRow=rows.filter({hasText:'原商品售后测试'}),ordinary=rows.filter({hasText:'独立资金调整测试'})
  await expect(caseRow.getByRole('button',{name:'复核通过',exact:true})).toHaveCount(0)
  await expect(caseRow.getByRole('button',{name:'复核驳回',exact:true})).toHaveCount(0)
  await expect(ordinary.getByRole('button',{name:'复核通过',exact:true})).toBeVisible()
  await caseRow.getByRole('button',{name:'处理原售后单',exact:true}).click()
  await expect(parent.getByRole('article',{name:'所选原售后单'})).toBeVisible()
  await parent.getByRole('button',{name:'关闭商品处理'}).click()
  await expect(caseRow.getByRole('button',{name:'处理原售后单',exact:true})).toBeFocused()
  await expect(page.locator('[data-cashier-order-id="order"] .cashier-order-toggle')).toHaveAttribute('aria-expanded','true')
  await page.route('**/api/payments/workbench?*',route=>route.fulfill({status:503,json:{error:{message:'isolated delayed read'}}}))
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')))
  await expect(page.getByText('收银状态更新暂时延迟，已有记录保留，请刷新核对；不要因显示未变重复收退款。')).toBeVisible()
  await expect(caseRow).toBeVisible();await expect(ordinary).toBeVisible()
})
