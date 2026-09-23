import {readFile} from 'node:fs/promises'
import {expect,test} from '@playwright/test'
import type {OrderFinancialRecoveryPreview,OrderFinancialRecoveryResult} from '../../src/shared/order-financial-recovery'

test('financial-only cashier entry restores a lost original request after reload without another key',async({page},testInfo)=>{
  const fixture=JSON.parse(await readFile(process.env.NORMALIZED_E2E_FIXTURE_FILE??'artifacts/normalized-browser/fixture.json','utf8'))
  await page.setViewportSize({width:390,height:844});await page.goto(fixture.staffUrl)
  await page.getByLabel('门店口令').fill(fixture.dailyCredential);await page.getByRole('button',{name:/验证设备/}).click()
  await page.getByLabel('员工账号').fill('sanmu');await page.getByLabel('四位 PIN').fill(fixture.employeePin)
  await page.getByRole('button',{name:/进入工作台/}).click();await expect(page.getByTestId('normalized-workspace')).toBeVisible()
  // Authentication uses the isolated server. Financial-only permissions and
  // recovery responses are explicit browser contracts, not real money effects.
  let employeeId='',loseResponse=true
  await page.route('**/api/auth/session',async route=>{
    const response=await route.fetch(),body=await response.json();employeeId=body.data.employee.id
    body.data.permissions=['reconciliation.view','reconciliation.manage']
    body.data.navigation=body.data.navigation.filter((entry:{code:string})=>entry.code==='payments')
    await route.fulfill({response,json:body})
  })
  const row:OrderFinancialRecoveryPreview={orderId:'11111111-1111-4111-8111-111111111111',orderPublicId:'LEGACY-ATTRIBUTION-ORIGINAL',currency:'CNY',basisVersion:'a'.repeat(64),availableDimensions:['attribution'],attribution:{eligible:true,itemAmountMinor:800,recommendationCurrentMinor:3200,recommendationExpectedMinor:4000,recommendationDeltaMinor:800,items:[{orderItemId:'original-item',productName:'原消费商品',amountMinor:800,restored:false}],blockReasons:[]},loyalty:{status:'permission_required',memberNo:null,policyVersionId:null,eligibleAmountMinor:0,pointsDelta:0,growthDelta:0,availablePointsDelta:0,pendingRecoveryPointsDelta:0,expiresAt:null,blockReasons:['loyalty_permission_required']},requests:[]}
  const mutations:Array<{body:unknown;key:string|undefined}>=[]
  await page.route('**/api/staff/order-financial-recovery?*',route=>route.fulfill({json:{data:{orders:[row],nextCursor:null},meta:{scopeKey:'fixture-tenant:fixture-store'}}}))
  await page.route('**/api/staff/order-financial-recovery/*/requests',async route=>{
    const body=route.request().postDataJSON();mutations.push({body,key:route.request().headers()['idempotency-key']})
    if(!row.requests.length)row.requests.push({requestId:'original-request',orderId:row.orderId,orderPublicId:row.orderPublicId,basisVersion:row.basisVersion,dimensions:'attribution',requestedByEmployeeId:employeeId,requestedByName:'当前财务人员',reason:body.reason,createdAt:'2026-09-21T02:00:00.000Z',status:'requested',snapshot:{attribution:row.attribution,loyalty:row.loyalty},decidedByName:null,decisionReason:null,result:null})
    if(loseResponse)return route.abort('failed')
    const data:OrderFinancialRecoveryResult={requestId:'original-request',orderId:row.orderId,orderPublicId:row.orderPublicId,dimensions:'attribution',status:'requested',itemAmountMinor:0,recommendationAmountMinor:0,pointsDelta:0,growthDelta:0,availablePointsDelta:0,pendingRecoveryPointsDelta:0}
    return route.fulfill({json:{data,meta:{replayed:true}}})
  })
  await page.goto('/staff/payments')
  const panel=page.getByRole('region',{name:'原订单权益与归属恢复'})
  await expect(panel).toBeVisible();await expect(panel.getByText('会员奖账需会员异常查看权限；当前仍可独立处理商品与推荐归属。')).toBeVisible()
  await expect(panel.getByRole('option',{name:'仅商品与推荐归属'})).toHaveCount(1);await expect(panel.getByRole('option',{name:'商品、推荐及会员贡献'})).toHaveCount(0)
  await panel.getByLabel('核对依据',{exact:true}).fill('核对原商品、普通退款和真实补收凭据')
  await panel.getByRole('button',{name:'提交申请，交另一人复核'}).click()
  await expect(panel.getByRole('button',{name:'恢复原操作结果'})).toBeVisible()
  await page.reload();await expect(panel.getByRole('button',{name:'恢复原操作结果'})).toBeVisible()
  await expect(panel.getByRole('button',{name:'提交申请，交另一人复核'})).toHaveCount(0)
  loseResponse=false;await panel.getByRole('button',{name:'恢复原操作结果'}).click()
  await expect(panel.getByText('申请已保存，请由另一名授权员工复核。')).toBeVisible()
  await expect(panel.getByRole('button',{name:'恢复原操作结果'})).toHaveCount(0)
  await expect(panel.getByText('这是本人申请，必须由另一名授权员工复核。')).toBeVisible()
  await expect(panel.getByRole('button',{name:'确认按原事实恢复'})).toHaveCount(0)
  expect(mutations.length).toBeGreaterThanOrEqual(2);expect(new Set(mutations.map(m=>m.key)).size).toBe(1);expect(new Set(mutations.map(m=>JSON.stringify(m.body))).size).toBe(1)
  expect(mutations[0]!.body).toEqual({basisVersion:row.basisVersion,dimensions:'attribution',reason:'核对原商品、普通退款和真实补收凭据'})
  const dimensions=await page.evaluate(()=>({width:document.documentElement.clientWidth,content:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)}));expect(dimensions.content).toBeLessThanOrEqual(dimensions.width+1)
  await page.screenshot({path:testInfo.outputPath('financial-recovery-original-request-390.png'),fullPage:true})
})
