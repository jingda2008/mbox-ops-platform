import {readFile} from 'node:fs/promises'
import {test,expect,type Page} from '@playwright/test'
test.use({viewport:{width:1024,height:600},isMobile:false,hasTouch:true})
const fixture=async()=>JSON.parse(await readFile('artifacts/normalized-browser/fixture.json','utf8'))
async function login(page:Page,code:string){
  const f=await fixture();test.skip(!f.threeScreenFixture,'requires isolated three-screen fixture')
  await page.goto('/')
  await page.getByLabel('门店口令').fill(f.dailyCredential);await page.getByRole('button',{name:/验证设备/}).click()
  await page.getByLabel('员工账号').fill(code);await page.getByLabel('四位 PIN').fill(f.employeePin)
  await page.getByRole('button',{name:/进入工作台/}).click();await expect(page.getByTestId('normalized-workspace')).toBeVisible()
  return f
}

test('取餐最小权限从普通出品入口进入，不请求桌台、不反复退回登录',async({page})=>{
  const f=await login(page,'test_pickup_only')
  const session=await page.request.get('/api/auth/session');expect((await session.json()).data.permissions).toEqual(['kds.deliver'])
  expect((await page.request.get('/api/operations')).status()).toBe(403)
  let operations=0;page.on('request',r=>{if(new URL(r.url()).pathname==='/api/operations')operations++})
  await page.goto('/staff/fulfillment')
  await expect(page.getByRole('heading',{name:'本机尚未设为取餐屏'})).toBeVisible()
  await expect(page.getByRole('button',{name:'设为取餐屏',exact:true})).toHaveCount(0)
  await expect(page.getByLabel('员工账号')).toHaveCount(0)
  await page.reload();await expect(page.getByRole('heading',{name:'本机尚未设为取餐屏'})).toBeVisible()
  expect(operations).toBe(0);expect((await page.request.get('/api/auth/session')).status()).toBe(200)
  // Configure only this isolated browser's device as an administrator, then restore the restricted account.
  expect((await page.request.post('/api/auth/switch',{data:{employeeCode:'wuya',pin:f.employeePin}})).ok()).toBe(true)
  await page.goto('/staff/fulfillment?screen=pickup')
  await page.getByRole('button',{name:'设为取餐屏',exact:true}).click()
  await page.getByRole('button',{name:'切换工作账号',exact:true}).click()
  await page.getByLabel('员工账号').fill('test_pickup_only');await page.getByLabel('四位 PIN').fill(f.employeePin)
  await page.getByRole('button',{name:/进入工作台/}).click()
  await expect(page.locator('.pickup-connection')).toHaveText('已更新');await expect(page.locator('.pickup-waiting')).toBeVisible()
  await page.goto('/staff/fulfillment')
  await expect(page.locator('.pickup-connection')).toHaveText('已更新');await expect(page.locator('.pickup-waiting')).toBeVisible()
  const pickup=await page.request.get('/api/commerce/pickup-board')
  expect((await pickup.json()).data.actor).toMatchObject({canPickup:true,canConfigure:false})
  let leaseReads=0
  await page.route('**/api/commerce/pickup-board',r=>++leaseReads===1?r.fulfill({status:403,json:{error:{code:'PICKUP_SESSION_INVALID',message:'登录已过期'}}}):r.continue())
  await page.reload();await expect(page.locator('.pickup-connection')).toHaveText('已更新');await expect(page.locator('.pickup-waiting')).toBeVisible()
  expect(leaseReads).toBeGreaterThanOrEqual(2)
  await page.unroute('**/api/commerce/pickup-board')
  await page.route('**/api/commerce/pickup-board',r=>r.fulfill({status:403,json:{error:{code:'PICKUP_FORBIDDEN',message:'当前岗位没有取餐权限'}}}))
  await page.reload();await expect(page.getByText('当前岗位没有取餐权限')).toBeVisible()
  await expect(page.getByRole('button',{name:'恢复登录',exact:true})).toHaveCount(0)
  expect((await page.request.get('/api/auth/session')).status()).toBe(200)
})

test('普通出品权限拒绝保留登录，不再形成登录循环',async({page})=>{
  await login(page,'shenliangliang')
  await page.route('**/api/operations',r=>r.fulfill({status:403,json:{error:{code:'STAFF_ACCESS_FORBIDDEN',message:'当前岗位没有桌台看板权限'}}}))
  await page.goto('/staff/fulfillment?view=all')
  await expect(page.getByText('当前岗位没有桌台看板权限')).toBeVisible()
  await expect(page.getByLabel('员工账号')).toHaveCount(0)
  expect((await page.request.get('/api/auth/session')).status()).toBe(200)
})

for(const [code,station,label] of [['shenliangliang','kitchen','后厨'],['lengyanzhi','bar','酒水']] as const){
  test(`${label}默认入口及返回旧页后完成新批次，不再发送错误的旧命令`,async({page})=>{
    const f=await login(page,code);let legacyWrites=0
    page.on('request',r=>{if(r.method()==='POST'&&/\/api\/commerce\/kds\/.+\/actions$/.test(new URL(r.url()).pathname))legacyWrites++})
    await page.goto('/staff/fulfillment');await expect(page).toHaveURL(new RegExp(`screen=${station}`))
    await page.getByRole('region',{name:'待制作',exact:true}).getByRole('button').filter({hasText:f.threeScreenFixture.products[station].name}).first().click()
    const before=await page.request.get(`/api/commerce/kitchen-board?station=${station}`)
    const beforeIds=new Set((await before.json()).data.batches.map((b:{id:string})=>b.id))
    await page.getByRole('button',{name:'开始制作 2 份',exact:true}).click()
    await expect(page.getByRole('button',{name:'本页 2 份已放好',exact:true})).toBeEnabled()
    const created=await page.request.get(`/api/commerce/kitchen-board?station=${station}`)
    const newBatch=(await created.json()).data.batches.find((b:{id:string})=>!beforeIds.has(b.id))
    expect(newBatch).toBeTruthy()
    await page.getByRole('button',{name:'返回出品',exact:true}).click()
    await expect(page).toHaveURL(/view=all/)
    const link=page.getByRole('button',{name:`到${label}制作屏完成`,exact:true}).first()
    await expect(link).toBeVisible()
    await expect(link.locator('..').getByRole('button',{name:'制作完成',exact:true})).toHaveCount(0)
    await link.click();await expect(page).toHaveURL(new RegExp(`screen=${station}`))
    await page.getByRole('button',{name:'本页 2 份已放好',exact:true}).click()
    await expect.poll(async()=>{const r=await page.request.get(`/api/commerce/kitchen-board?station=${station}`);return (await r.json()).data.batches.filter((b:{id:string;units:{state:string}[]})=>b.id===newBatch.id&&b.units.some(u=>u.state==='started')).length}).toBe(0)
    expect(legacyWrites).toBe(0)
  })
}
