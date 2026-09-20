import {readFile} from 'node:fs/promises'
import {expect,test} from '@playwright/test'

test('initial after-sales access failure remains visible and retry reads the original pending queue',async({page},testInfo)=>{
  const data=JSON.parse(await readFile(process.env.NORMALIZED_E2E_FIXTURE_FILE??'artifacts/normalized-browser/fixture.json','utf8'))
  await page.setViewportSize({width:390,height:844})
  await page.goto(data.staffUrl)
  await page.getByLabel('门店口令').fill(data.dailyCredential)
  await page.getByRole('button',{name:/验证设备/}).click()
  await page.getByLabel('员工账号').fill('sanmu')
  await page.getByLabel('四位 PIN').fill(data.employeePin)
  await page.getByRole('button',{name:/进入工作台/}).click()
  await expect(page.getByTestId('normalized-workspace')).toBeVisible()
  let unavailable=true,reads=0
  await page.route('**/api/commerce/item-after-sales/access',async route=>{
    reads++
    if(unavailable)return route.fulfill({status:503,json:{error:{code:'TEST_ACCESS_UNAVAILABLE',message:'待办暂时无法读取'}}})
    return route.continue()
  })
  await page.goto('/staff/payments')
  const pending=page.getByRole('region',{name:'商品售后待办'})
  await expect(pending.getByRole('alert')).toContainText('读取失败，请刷新重试')
  await expect(pending.getByText('没有待处理商品。',{exact:true})).toHaveCount(0)
  unavailable=false
  await pending.getByRole('button',{name:'重新读取商品待办'}).click()
  await expect(pending.getByRole('button',{name:'刷新商品待办'})).toBeVisible()
  await expect(pending.getByRole('alert')).toHaveCount(0)
  expect(reads).toBeGreaterThanOrEqual(2)
  await page.screenshot({path:testInfo.outputPath('after-sales-access-recovery-390.png'),fullPage:true})
})
