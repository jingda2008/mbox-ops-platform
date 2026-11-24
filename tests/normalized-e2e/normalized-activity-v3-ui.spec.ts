import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {spawn} from 'node:child_process'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {expect,test,type Page} from '@playwright/test'
import type {ActivityDoorCommand,ActivityServiceView} from '../../src/shared/activity-service'

const credential='MBOX_ACTIVITY_V3:browser-registration-v3:12345678-1234-4234-8234-123456789abc'
const initial:ActivityServiceView={registrationPublicId:'browser-registration-v3',activityPublicId:'browser-activity-v3',activityTitle:'活动核销界面测试',packageName:'五人固定套餐',hasMeal:true,partySize:2,maxParticipants:5,reservedSeats:5,admittedCount:0,remainingAdmission:5,includesAdmission:true,paymentStatus:'paid',meal:null}
async function login(page:Page,fixturePath='artifacts/normalized-browser/fixture.json',origin?:string,roleName?:string){
  const fixture=JSON.parse(await readFile(fixturePath,'utf8'))
  await page.goto(origin?new URL(fixture.staffUrl,origin).href:fixture.staffUrl)
  await page.getByLabel('门店口令').fill(fixture.dailyCredential);await page.getByRole('button',{name:/验证设备/}).click()
  const employeeCode=roleName?fixture.employees.find((e:{roleNames:string[]})=>e.roleNames.includes(roleName))?.code:fixture.adminEmployeeCode
  if(!employeeCode)throw Error('验收岗位缺少测试员工')
  await page.getByLabel('员工账号').fill(employeeCode);await page.getByLabel('四位 PIN').fill(fixture.adminEmployeePin)
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

test('运营在原场次上架桌票，公共菜单读回票价、赠分、预告和下架',async({page},testInfo)=>{
  test.setTimeout(120_000)
  // First publication changes the entire store's opening rules. Give this test its own store.
  const directory=await mkdtemp(join(tmpdir(),'mbox-ticket-browser-'))
  const fixturePath=join(directory,'fixture.json')
  const port=Number(process.env.NORMALIZED_E2E_PORT??18789)+10,origin='http://127.0.0.1:'+port
  const server=spawn(process.execPath,['--import','tsx','scripts/start-normalized-browser-e2e.ts'],{stdio:'ignore',env:{
    ...process.env,TEST_NORMALIZED_ADMIN_URL:process.env.TEST_NORMALIZED_ADMIN_URL??'postgresql://postgres:mbox_test_only@127.0.0.1:55441/postgres',
    NORMALIZED_E2E_TABLE_TICKETS:'true',NORMALIZED_E2E_PORT:String(port),NORMALIZED_E2E_FIXTURE_FILE:fixturePath,MBOX_STATIC_DIR:'dist',
  }})
  const exited=new Promise<void>(resolve=>server.once('close',()=>resolve()))
  try{
    await expect.poll(async()=>{try{return (await fetch(origin+'/api/live')).ok}catch{return false}},{timeout:60000}).toBe(true)
    const fixture=JSON.parse(await readFile(fixturePath,'utf8'))
    await page.setViewportSize({width:390,height:844})
    await login(page,fixturePath,origin)
    await page.goto(new URL('/staff/reservations',origin).href)
    await page.getByRole('link',{name:'门票接待',exact:true}).click()
    const workspace=page.getByRole('region',{name:'活动报名运营工作台'})
    const open=workspace.getByRole('button',{name:'打开工作台',exact:true})
    await expect(workspace).toBeVisible()
    if(await open.isVisible())await open.click()
    await workspace.getByRole('button',{name:/整桌演出票浏览器验收场/}).click()
    await expect(workspace.getByText('本场暂无已付款门票',{exact:true})).toBeVisible()
    await workspace.getByText('整桌门票',{exact:true}).click()
    await workspace.getByText('首次上架，先核实本场公示资料').click()
    const rules=[['举办主体','验收举办方'],['售票主体','验收售票方'],['批准文件号或适用依据','模拟场次批文'],['主要演员或团体','测试乐队'],
      ['最低演出时长（分钟）','90'],['最低曲目数及适用说明','十首'],['门店客服','门店接待'],['退票约定（何时可退、退多少、门店变更或取消时怎么办）','开演前可在原单全额退票']]
    for(const [field,value] of rules)await workspace.getByLabel(field!,{exact:true}).fill(value!)
    await workspace.getByRole('button',{name:'确认资料并保存本场版本'}).click()
    await expect(workspace.getByText('本场公示资料 · 版本 1',{exact:true})).toBeVisible()
    await workspace.getByLabel('产品名称',{exact:true}).fill('中间区域整桌票')
    await workspace.getByLabel('每桌售价（元）',{exact:true}).fill('500')
    const points=workspace.getByLabel('每张赠送积分',{exact:true})
    const price=workspace.getByLabel('每桌售价（元）',{exact:true})
    const name=workspace.getByLabel('产品名称',{exact:true})
    const publish=workspace.getByRole('button',{name:/^(复核场次并发布票档|保存并发布票档)$/})
    for(const [field,invalid,valid] of [[name,'','中间区域整桌票'],[price,'0','500'],[points,'-1','550'],[points,'0.5','550'],[points,'','550']] as const){
      await field.fill(invalid)
      await publish.click()
      await expect(field).toBeFocused()
      await field.fill(valid)
    }
    for(const width of [320,390,1280]){
      await page.setViewportSize({width,height:850})
      const editor=workspace.locator('.ticket-offer-editor')
      await expect(editor.getByLabel('同时在超嗨推荐')).not.toBeChecked()
      const amountBox=await price.boundingBox(),pointsBox=await points.boundingBox()
      expect(amountBox?.x).toBe(pointsBox?.x)
      expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
      await editor.screenshot({path:testInfo.outputPath('ticket-offer-'+width+'.png')})
    }
    await page.setViewportSize({width:390,height:844})
    // Fail the offer update after the activity review, inside the same database transaction.
    const offerPath='**/api/staff/activity-operations/*/table-tickets'
    await page.route(offerPath,async route=>{
      const request=route.request()
      if(request.method()==='POST')return route.continue({postData:JSON.stringify({...request.postDataJSON(),expectedVersion:999})})
      return route.continue()
    })
    await publish.click()
    await page.getByRole('button',{name:'确认复核并发布'}).click()
    await expect(workspace.getByText('票档已更新，请刷新后核对')).toBeVisible()
    await page.unroute(offerPath)
    await workspace.getByRole('button',{name:'刷新票档'}).click()
    await expect(workspace.getByRole('button',{name:'复核场次并发布票档',exact:true})).toBeEnabled()
    let resume!:()=>void
    const delayed=new Promise<void>(resolve=>{resume=resolve})
    let failRead=false
    const listRoute='**/api/staff/activity-operations/*/table-tickets'
    await page.route(listRoute,async route=>{
      if(route.request().method()==='GET'){
        await delayed
        if(failRead){await route.fulfill({status:503,contentType:'application/json',body:'{}'});return}
      }
      await route.continue()
    })
    try{
      await publish.click()
      await page.getByRole('button',{name:'确认复核并发布'}).click()
      await expect(workspace.getByText('已保存，正在核对最新版本…',{exact:true})).toBeVisible()
      await expect(name).toBeDisabled()
      await expect(publish).toBeDisabled()
    }finally{resume()}
    await expect(workspace.getByText('票档版本已发布',{exact:true})).toBeVisible()
    const published=async()=>(await (await page.request.get(new URL('/api/public/mini/table-ticket-offers',origin).href)).json()).data.filter((o:{activityPublicId:string})=>o.activityPublicId===fixture.ticketEvent)
    await expect.poll(published).toMatchObject([{name:'中间区域整桌票',giftPoints:550,priceMinor:50000,saleState:'open'}])
    const recommended=async()=>(await (await page.request.get(new URL('/api/public/mini/table-ticket-offers?channel=community',origin).href)).json()).data
    expect(await recommended()).toEqual([])
    await workspace.getByLabel('同时在超嗨推荐').check()
    await workspace.getByText('分类、展示及售卖时间（选填，北京时间）',{exact:true}).click()
    await workspace.getByLabel('开售',{exact:true}).fill(new Date(Date.now()+86400000).toISOString().slice(0,10)+'T12:00')
    failRead=true
    await publish.click()
    await expect.poll(published).toMatchObject([{saleState:'upcoming'}])
    await expect.poll(recommended).toMatchObject([{id:(await published())[0].id,priceMinor:50000,giftPoints:550}])
    await expect(workspace.getByText('已保存，最新版本读取失败。请点「刷新票档」后继续。',{exact:true})).toBeVisible()
    await expect(publish).toBeDisabled()
    failRead=false
    await workspace.getByRole('button',{name:'刷新票档'}).click()
    await expect(workspace.getByText('票档版本已发布',{exact:true})).toBeVisible()
    await workspace.getByRole('button',{name:'下架',exact:true}).click()
    await expect.poll(published).toEqual([])
    expect(await recommended()).toEqual([])

    // The partial-liability form sends the same minor units checked by the database integration test.
    await page.route('**/api/staff/activity-operations/*/ticket-reception',route=>route.fulfill({json:{data:{tables:[],orders:[{
      id:'test-ticket',orderId:'test-order',name:'整桌票',ordinal:1,priceMinor:50000,consumedMinor:'55000',
      refundCase:'test-case',refundStatus:'review',plannedRefundMinor:50000,arrived:0,contactStatus:'onsite',showEnded:true,
    }]}}}))
    const submitted:unknown[]=[]
    await page.route('**/table-ticket-refunds/test-case/dining',route=>{
      submitted.push(route.request().postDataJSON())
      return route.fulfill({json:{data:{amountMinor:50000}}})
    })
    await workspace.getByRole('button',{name:'刷新接待队列'}).click()
    const customer=workspace.getByLabel('顾客应补菜款（元）')
    const merchant=workspace.getByLabel('门店承担金额（元）')
    await customer.fill('500')
    await merchant.fill('49.99')
    await workspace.getByLabel('菜款核定依据').fill('已核实售出条款和原餐单')
    const propose=workspace.getByRole('button',{name:'发给会员核对逐菜补款'})
    await propose.click()
    await expect(workspace.getByText('请填齐两项金额，合计须等于本票已抵菜款')).toBeVisible()
    expect(submitted).toEqual([])
    await merchant.fill('50')
    await propose.click()
    await expect.poll(()=>submitted).toEqual([{reason:'已核实售出条款和原餐单',customerMinor:50000,merchantMinor:5000}])

    await page.setViewportSize({width:320,height:740})
    await workspace.getByRole('button',{name:'新建门票场次'}).click()
    await expect(workspace.getByText('活动套餐与加购',{exact:true})).toHaveCount(0)
    await workspace.getByLabel('活动名称',{exact:true}).fill('跨日票档快速建场')
    await workspace.getByLabel('活动详情',{exact:true}).fill('测试场次：本场演出提供整桌入场权益。')
    await workspace.getByRole('spinbutton',{name:/人数上限/}).fill('80')
    const day=(offset:number)=>new Date(Date.now()+offset*86400000).toISOString().slice(0,10)
    await workspace.getByLabel('开始时间',{exact:true}).fill(day(3)+'T20:00')
    await workspace.getByLabel('结束时间',{exact:true}).fill(day(4)+'T00:30')
    await workspace.getByLabel('安全要求（每行一项）').fill('配合现场工作人员指引。')
    await workspace.getByRole('button',{name:'添加桌区票档'}).click()
    const row=workspace.locator('.ticket-draft-row').first()
    await row.getByRole('combobox',{name:'桌区',exact:true}).selectOption({index:1})
    await row.getByLabel('票名',{exact:true}).fill('A区复核票')
    await row.getByLabel('每桌售价（元）',{exact:true}).fill('500')
    await row.getByLabel('每张赠分',{exact:true}).fill('550')
    const created=page.waitForResponse(res=>res.url().endsWith('/api/staff/activity-operations') && res.request().method()==='POST')
    await workspace.getByRole('button',{name:'提交本场票档复核'}).click()
    const createdResponse=await created
    expect(createdResponse.status(),await createdResponse.text()).toBe(201)
    const saved=(await createdResponse.json()).data
    expect(saved.ticketOnly).toBe(true)
    expect(new Date(saved.startsAt).toISOString()).toBe(day(3)+'T12:00:00.000Z')
    expect(new Date(saved.endsAt).toISOString()).toBe(day(3)+'T16:30:00.000Z')
    await expect(workspace.getByRole('button',{name:/跨日票档快速建场 草稿/})).toBeVisible()
    await workspace.getByText('整桌门票',{exact:true}).click()
    await expect(workspace.getByText('场次由你创建，保存票档草稿后由另一位发布人员复核上架。')).toBeVisible()
    await expect(workspace.getByRole('button',{name:'下架',exact:true})).toHaveCount(0)
    await expect(workspace.getByLabel('同时在超嗨推荐')).not.toBeChecked()
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
  }finally{
    server.kill('SIGTERM')
    await exited
    await rm(directory,{recursive:true,force:true})
  }
})

test('收银在原案核定票款，收齐后的独立复核状态自动显示',async({page})=>{
  const ticket='7ea70994-95da-47d6-bcdb-57894a6dbeef'
  const row={id:ticket,ordinal:1,quantity:1,orderNo:'TT500',name:'A 区整桌票',memberNo:'M001',maskedPhone:'****0001',priceMinor:50000,
    giftPoints:550,recoverable:0,consumedMinor:'55000',refundSchedule:'开演前全额退票',refundLimit:50000,previewVersion:'a'.repeat(64),
    caseId:null as string|null,caseStatus:null as string|null,plannedRefundMinor:null as number|null,refundId:null as string|null,cashStatus:null as string|null}
  let manualSubmissions=0
  await page.route('**/api/staff/activity-operations/ticket-refund-preview?*',route=>route.fulfill({json:{data:[row]}}))
  await page.route('**/api/staff/activity-operations/table-tickets/*/refund-request',route=>{
    expect(route.request().postDataJSON()).toMatchObject({refundAmountMinor:50000})
    Object.assign(row,{caseId:'original-case',caseStatus:'review',plannedRefundMinor:50000})
    return route.fulfill({json:{data:{caseId:row.caseId}}})
  })
  await page.route('**/api/staff/activity-operations/table-ticket-refunds/*/submit',route=>{manualSubmissions++;return route.fulfill({status:409})})
  await login(page)
  await page.goto('/staff/payments')
  await page.getByLabel('查找收银订单').fill(ticket)
  await page.getByRole('button',{name:'查找',exact:true}).click()
  const desk=page.getByRole('region',{name:'整桌门票退票办理'})
  await desk.getByLabel('办理依据').fill('依据原单条款全额退票')
  await desk.getByLabel('按原条款核定退票款（元）').fill('500')
  await desk.getByRole('button',{name:'受理本票退票'}).click()
  await expect(desk.getByText(/收齐后自动提交复核/)).toBeVisible()
  await expect(desk.getByRole('button',{name:'提交原路退款复核'})).toHaveCount(0)
  Object.assign(row,{refundId:'original-refund',cashStatus:'requested',caseStatus:'requested'})
  await expect(desk.getByText(/已提交，等待独立复核/)).toBeVisible({timeout:15000})
  expect(manualSubmissions).toBe(0)
})

test('同单逐票送达复核人，可直接审核指定一张',async({page})=>{
  const rows=[1,2].map(ordinal=>({ordinal,quantity:2,ticketId:'ticket-'+ordinal,refundId:'refund-'+ordinal,name:'A 区整桌票',
    requestedByEmployeeId:'another-employee',amountMinor:50000,currency:'CNY',reason:'按原票条款核定',automatic:true}))
  const approved:string[]=[]
  await page.route('**/api/staff/activity-operations/ticket-refund-reviews',route=>route.fulfill({json:{data:rows.filter(r=>!approved.includes(r.refundId))}}))
  await page.route('**/api/refunds/*/approve',route=>{
    expect(route.request().postDataJSON()).toEqual({reason:'已核对第二张原票及收款'})
    approved.push(new URL(route.request().url()).pathname.split('/').at(-2)!)
    return route.fulfill({json:{data:{status:'approved'}}})
  })
  await login(page,undefined,undefined,'收银员')
  await page.goto('/staff/payments')
  const queue=page.getByRole('region',{name:'门票退款待复核'})
  await queue.getByRole('button',{name:/第 2／2 张/}).click()
  await queue.getByLabel('复核意见').fill('已核对第二张原票及收款')
  await queue.getByRole('button',{name:'复核通过'}).click()
  await expect(queue.getByRole('button',{name:/第 2／2 张/})).toHaveCount(0)
  await expect(queue.getByRole('button',{name:/第 1／2 张/})).toBeVisible()
  expect(approved).toEqual(['refund-2'])
})
