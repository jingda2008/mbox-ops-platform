import {readFile} from 'node:fs/promises'
import {expect,test,type Page} from '@playwright/test'

for(const account of ['chenfangyu','hugu','sanmu','ajin']){
  test(`${account}: cashier and history queries retain scope across filters and refresh`,async({page})=>{
    const fixture=JSON.parse(await readFile(process.env.NORMALIZED_E2E_FIXTURE_FILE??'artifacts/normalized-browser/fixture.json','utf8'))
    await page.setViewportSize({width:390,height:844})
    await page.goto('/staff/payments')
    await page.getByLabel('门店口令').fill(fixture.dailyCredential)
    await page.getByRole('button',{name:/验证设备/}).click()
    await page.getByLabel('员工账号').fill(account)
    await page.getByLabel('四位 PIN').fill(fixture.employeePin)
    await query(page,'/api/payments/workbench',()=>page.getByRole('button',{name:/进入工作台/}).click())
    await expect(page.getByLabel('查找收银订单')).toBeVisible()
    await query(page,'/api/payments/workbench',()=>page.locator('.cashier-workbench-filters').getByLabel('支付状态').selectOption('unpaid'))
    await query(page,'/api/payments/workbench',()=>page.locator('.cashier-workbench-filters').getByLabel('支付状态').selectOption('all'))
    await page.getByLabel('查找收银订单').fill('C11')
    await query(page,'/api/payments/workbench',()=>page.getByRole('button',{name:'查找',exact:true}).click())
    await query(page,'/api/payments/workbench',()=>page.reload())
    const initial=await query(page,'/api/operations/history',()=>page.goto('/staff/orders'))
    const panel=page.getByLabel('营业日账务与历史订单',{exact:true})
    await expect(panel).toBeVisible()
    await query(page,'/api/operations/history',()=>panel.getByRole('button',{name:'上一营业日',exact:true}).click())
    await query(page,'/api/operations/history',()=>panel.getByRole('button',{name:'当前营业日',exact:true}).click())
    await panel.getByText('日期与更多筛选',{exact:true}).click()
    await panel.getByLabel('开始营业日',{exact:true}).fill(initial.businessDate.slice(0,8)+'01')
    const month=await query(page,'/api/operations/history',()=>panel.getByRole('button',{name:'查找订单',exact:true}).click())
    if(initial.financialSummaryVisible===false){expect(month.receipts).toEqual([]);expect(month.summary).toBeUndefined()}
    await query(page,'/api/operations/history',()=>page.reload())
    await expect(page.getByLabel('营业日账务与历史订单',{exact:true}).locator(':scope > p[role="alert"]')).toHaveCount(0)
    const workspace=await page.request.get('/api/staff/workspace')
    expect(workspace.status()).toBe(200)
    expect((await workspace.json()).data.staff.code).toBe(account)
    const logout=await page.request.post('/api/auth/logout',{data:{}})
    expect(logout.status()).toBe(204)
  })
}

async function query(page:Page,path:string,action:()=>Promise<unknown>){
  const response=page.waitForResponse(r=>new URL(r.url()).pathname===path)
  await action()
  const result=await response
  expect(result.status()).toBe(200)
  const body=await result.json()
  expect(body.data).toBeDefined()
  return body.data
}
