import {readFile} from 'node:fs/promises'
import {expect,test,type Page} from '@playwright/test'
import type {ActivityDoorCommand,ActivityServiceView} from '../../src/shared/activity-service'

const credential='MBOX_ACTIVITY_V3:browser-registration-v3:12345678-1234-4234-8234-123456789abc'
const initial:ActivityServiceView={registrationPublicId:'browser-registration-v3',activityPublicId:'browser-activity-v3',activityTitle:'活动核销界面测试',packageName:'五人固定套餐',hasMeal:true,partySize:2,maxParticipants:5,reservedSeats:5,admittedCount:0,remainingAdmission:5,includesAdmission:true,paymentStatus:'paid',meal:null}
async function login(page:Page){
  const fixture=JSON.parse(await readFile('artifacts/normalized-browser/fixture.json','utf8'))
  await page.goto(fixture.staffUrl)
  await page.getByLabel('门店口令').fill(fixture.dailyCredential);await page.getByRole('button',{name:/验证设备/}).click()
  await page.getByLabel('员工账号').fill(fixture.adminEmployeeCode);await page.getByLabel('四位 PIN').fill(fixture.adminEmployeePin)
  await page.getByRole('button',{name:/进入工作台/}).click();await expect(page.getByTestId('normalized-workspace')).toBeVisible()
}
async function query(page:Page,code=credential){await page.getByLabel('会员号或套餐码',{exact:true}).fill(code);await page.getByRole('button',{name:'查询',exact:true}).click()}

test('全部内连续办理：查询只读、失败回执刷新后恢复原入场批次和餐号',async({page},testInfo)=>{
  await page.setViewportSize({width:390,height:844})
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message))
  let view=structuredClone(initial),lost=true,committed=false
  const keys:string[]=[],bodies:ActivityDoorCommand[]=[]
  await page.route('**/api/staff/activity-operations/scan',route=>route.fulfill({json:{data:view}}))
  await page.route('**/api/staff/activity-operations/registrations/*/service',async route=>{
    const body=route.request().postDataJSON() as ActivityDoorCommand
    keys.push(route.request().headers()['idempotency-key']!);bodies.push(body)
    if(body.action==='admit_and_redeem'&&!committed){committed=true;view={...view,admittedCount:body.arrivedCount!,remainingAdmission:5-body.arrivedCount!,meal:{id:'meal-1',number:27,status:'open',plaqueState:'pending',location:'A区',lines:[]}}}
    if(body.action==='plaque_issued')view={...view,meal:{...view.meal!,plaqueState:'issued'}}
    if(lost){lost=false;return route.abort('failed')}
    return route.fulfill({json:{data:view}})
  })
  await login(page)
  await expect(page.getByRole('navigation',{name:'岗位快捷功能'}).getByRole('button',{name:/扫码与活动核销/})).toHaveCount(0)
  await page.getByRole('button',{name:'全部岗位入口',exact:true}).click()
  await page.getByRole('dialog').getByRole('button',{name:'扫码与活动核销',exact:true}).click()
  await query(page);await expect(page.getByRole('heading',{name:'活动核销界面测试 · 五人固定套餐'})).toBeVisible()
  expect(bodies).toHaveLength(0)
  await expect(page.getByLabel('本批首次入场人数')).toHaveValue('2')
  await page.getByRole('button',{name:'确认本次办理'}).click()
  await expect(page.getByRole('button',{name:'恢复原操作',exact:true})).toBeVisible()
  await page.reload();await query(page)
  await page.getByRole('button',{name:'恢复原操作',exact:true}).click()
  await expect(page.locator('.activity-number strong')).toHaveText('27')
  expect(keys[0]).toBe(keys[1]);expect(bodies[0]).toEqual(bodies[1]);expect(view.admittedCount).toBe(2)
  const persisted=await page.evaluate(()=>Object.keys(localStorage).filter(key=>key.startsWith('mbox.activity-door')).map(key=>localStorage.getItem(key)).join(''))
  expect(persisted).not.toContain('12345678-1234-4234-8234-123456789abc')
  await page.getByRole('button',{name:'下一位',exact:true}).click()
  await expect(page.getByRole('dialog',{name:'扫描会员码或套餐码'})).toBeVisible()
  await page.getByRole('button',{name:'关闭扫码',exact:true}).click()
  await expect(page.getByLabel('会员号或套餐码')).toHaveValue('')
  expect(page.url()).toContain('/staff/scan');expect(view.meal?.plaqueState).toBe('issued')
  await page.screenshot({path:testInfo.outputPath('continuous-scan.png'),fullPage:true})
  expect(errors).toEqual([])
})

test('纯活动票没有出餐选项；无效码和扫码查询不产生办理请求',async({page})=>{
  let mutations=0
  await page.route('**/api/staff/activity-operations/scan',route=>route.fulfill({json:{data:{...initial,hasMeal:false,packageName:'纯活动入场'}}}))
  await page.route('**/api/staff/activity-operations/registrations/*/service',route=>{mutations++;return route.fulfill({status:409,json:{error:{message:'界面测试不应触发此操作'}}})})
  await login(page);await page.goto('/staff/scan')
  await query(page,'MBOX_ACTIVITY_V3:broken')
  await expect(page.getByRole('alert')).toContainText('活动码不完整')
  await query(page)
  await expect(page.getByText('本份套餐现在开始出餐',{exact:true})).toHaveCount(0)
  expect(mutations).toBe(0)
})

test('固定套餐编辑保留人数上限、菜量与时间字段，窄屏可操作',async({page},testInfo)=>{
  await page.route('**/api/staff/activity-operations/product-catalog',route=>route.fulfill({json:{data:[{id:'11111111-1111-4111-8111-111111111111',name:'柠檬茶',station:'bar'},{id:'22222222-2222-4222-8222-222222222222',name:'橙汁',station:'bar'}]}}))
  await page.setViewportSize({width:360,height:800})
  await login(page);await page.goto('/staff/customer-experience')
  const create=page.getByRole('button',{name:'新建活动草稿',exact:true})
  if(!await create.isVisible())await page.getByRole('region',{name:'活动报名运营工作台'}).getByRole('button',{name:'打开工作台',exact:true}).click()
  await create.click();await page.getByRole('button',{name:'新增套餐',exact:true}).click()
  await page.getByLabel('每份最多参加',{exact:false}).fill('5')
  await expect(page.getByLabel('本份包含入场',{exact:true})).toBeChecked()
  await expect(page.getByLabel('本份包含餐饮',{exact:true})).toBeChecked()
  await expect(page.getByLabel('餐饮核销开始（空为活动开始）',{exact:true})).toBeVisible()
  await expect(page.getByText('按份全额预付。填写人数不改变菜量；含入场时按人数上限预留名额。',{exact:true})).toBeVisible()
  await page.getByRole('button',{name:'添加固定自选组',exact:true}).click()
  await page.getByLabel('自选组 1 名称',{exact:true}).fill('饮品二选一')
  await page.getByLabel('自选组 1 固定份数',{exact:true}).fill('2')
  const choices=page.getByRole('group',{name:'自选组 1',exact:true})
  await choices.getByLabel('柠檬茶',{exact:true}).check();await choices.getByLabel('橙汁',{exact:true}).check()
  await expect(choices.getByText('已选择 2 项，需选2至8项。',{exact:true})).toBeVisible()
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth)).toBeLessThanOrEqual(1)
  await page.screenshot({path:testInfo.outputPath('package-editor-360.png'),fullPage:true})
})
