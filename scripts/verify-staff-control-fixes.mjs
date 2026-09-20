import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { chromium, expect } from '@playwright/test'
import pg from 'pg'

const out = path.resolve(process.env.STAFF_AUDIT_OUT ?? 'artifacts/staff-control-fixes-20260920')
const baseURL = process.env.STAFF_AUDIT_URL ?? 'http://127.0.0.1:18898'
if (!['127.0.0.1', 'localhost'].includes(new URL(baseURL).hostname)) throw new Error('Synthetic local fixture required')
const fixture = JSON.parse(fs.readFileSync(path.join(out, 'optin-fixture.json'), 'utf8'))
const folder = path.join(out, 'closure-probes')
fs.mkdirSync(folder, { recursive: true })
const browser = await chromium.launch({ headless: true })
const results = []
const contexts = []
const only = process.env.STAFF_AUDIT_CASES?.split(',')
async function login(code, width = 390, mobile = false) {
  const context = await browser.newContext({ baseURL, viewport: { width, height: 844 }, isMobile: mobile, hasTouch: mobile, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
  contexts.push(context)
  const page = await context.newPage(); page.setDefaultTimeout(10000)
  await page.goto('/')
  await page.getByLabel('门店口令').fill(fixture.dailyCredential)
  await page.getByRole('button', { name: /验证设备/ }).click()
  await page.getByLabel('员工账号').fill(code)
  await page.getByLabel('四位 PIN').fill(fixture.employeePin)
  await page.getByRole('button', { name: /进入工作台/ }).click()
  await page.getByTestId('normalized-workspace').waitFor()
  return page
}
async function go(page, route) { await page.goto(route); await page.locator('.staff-module-panel').waitFor(); await page.waitForTimeout(450) }
async function localWasteAllowance(itemId) {
  const source = process.env.TEST_NORMALIZED_ADMIN_URL
  if (!source || new URL(source).hostname !== '127.0.0.1' || new URL(source).port !== '55444') throw new Error('Owned isolated PostgreSQL URL is required to seed an allowed waste quantity')
  const admin = new pg.Client({ connectionString: source }); await admin.connect()
  try {
    const { rows } = await admin.query("SELECT datname FROM pg_database WHERE datname LIKE 'mbox_normalized_browser_%'")
    for (const row of rows) {
      const url = new URL(source); url.pathname = `/${row.datname}`
      const client = new pg.Client({ connectionString: url.toString() }); await client.connect()
      try {
        const found = await client.query('SELECT reasonable_waste_quantity::text AS allowance FROM mbox.inventory_items WHERE id=$1::uuid', [itemId])
        if (!found.rowCount) continue
        await client.query('UPDATE mbox.inventory_items SET reasonable_waste_quantity=10 WHERE id=$1::uuid', [itemId])
        return { database: row.datname, before: found.rows[0].allowance, after: '10', note: 'Only synthetic material allowance was seeded; no employee permissions changed' }
      } finally { await client.end() }
    }
    throw new Error('Synthetic material was not found')
  } finally { await admin.end() }
}
async function probe(id, run) {
  if (only && !only.includes(id)) return
  try { const evidence = await run(); results.push({ id, result: 'passed', evidence }) }
  catch (error) {
    results.push({ id, result: 'failed', error: error.message })
    const page = contexts.at(-1)?.pages().at(-1)
    if (page) { fs.writeFileSync(path.join(folder, `${id}-diagnostic.txt`), await page.locator('body').innerText()); await page.screenshot({path:path.join(folder,`${id}-diagnostic.png`)}) }
  }
  fs.writeFileSync(path.join(folder, `${only ? only.join('-') : 'results'}.json`), JSON.stringify(results, null, 2) + '\n')
  console.log(JSON.stringify(results.at(-1)))
}
function responseWait(page,predicate){const promise=page.waitForResponse(predicate);promise.catch(()=>{});return promise}
try {
 await probe('SYS-291-page-responsibility',async()=>{
  const page=await login('liyan');await go(page,'/staff/member-overview');const panel=page.locator('.customer-experience-management')
  assert.equal(await panel.locator('form').count(),0);assert.equal(await panel.getByRole('button',{name:/保存|审批|发布|返还|核销/}).count(),0)
  for(const route of ['member-fulfillment','member-exceptions']){await go(page,`/staff/${route}`);assert.equal(await page.getByRole('button',{name:/保存等级|保存完整目录|排期发布/}).count(),0);assert.equal(await page.getByText('兑换目录与开关',{exact:true}).count(),0)}
  return {overviewReadOnly:true,fulfillmentAndExceptionsHideConfiguration:true}
 })
 await probe('SYS-292-validation-and-289-navigation',async()=>{
  const page=await login('liyan');await go(page,'/staff/member-rule-drafts');const errors=[];page.on('pageerror',e=>errors.push(e.message))
  const field=page.getByLabel('银卡积分倍率',{exact:true}),form=field.locator('xpath=ancestor::form');await field.fill('');await form.getByLabel('配置原因').fill('修复验证：需要显式反馈')
  await form.getByRole('button',{name:'保存等级草稿',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'银卡积分倍率'})).toBeVisible();assert.deepEqual(errors,[])
  await field.fill('1.1');const created=responseWait(page,r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/staff/loyalty/tier-policies');await form.getByRole('button',{name:'保存等级草稿',exact:true}).click();const response=await created;assert.ok(response.ok(),await response.text());const id=(await response.json()).data.id
  const approver=await login('hugu');await go(approver,'/staff/member-management#work=member-benefits');const panel=approver.locator('.loyalty-policy-panel');const link=panel.getByRole('button',{name:'前往配置中心审批',exact:true}).first();await expect(link).toBeVisible();await link.click();await expect(approver.locator('#membership-configuration-center .membership-configuration-workspace header').first()).toContainText('会员等级');const url=new URL(approver.url());assert.equal(url.pathname,'/staff/member-rule-approvals');assert.equal(url.searchParams.get('configuration'),id)
  return{validationVisible:true,uncaughtErrors:errors,approvalSelectsCreatedDraft:true}
 })
 await probe('SYS-293-295-rule-race-and-save-feedback',async()=>{
  const page=await login('liyan');await go(page,'/staff/member-rule-drafts');const form=page.locator('.loyalty-policy-panel').getByRole('button',{name:'保存新版本草稿',exact:true}).locator('xpath=ancestor::form');for(let index=0;index<2;index++){await form.getByLabel('配置原因').fill(`修复验证：建立隔离积分草稿${index}`);const created=responseWait(page,r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/staff/loyalty/policies');await form.getByRole('button',{name:'保存新版本草稿',exact:true}).click();assert.ok((await created).ok());await expect(form.getByRole('button',{name:'保存新版本草稿',exact:true})).toBeEnabled()}
  await go(page,'/staff/member-rule-drafts');const center=page.locator('#membership-configuration-center'),rows=center.locator('nav[aria-label="配置列表"] button').filter({hasText:'基础积分'});await expect.poll(()=>rows.count()).toBeGreaterThan(1)
  let release,start,first=true;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>start=resolve)
  await page.route('**/api/staff/loyalty/configuration-center/base_points/*',async route=>{if(route.request().method()!=='GET')return route.continue();const response=await route.fetch();if(first){first=false;start();await gate}await route.fulfill({response})})
  const last=await rows.last().textContent();await rows.first().click();await started;await rows.last().click();await expect(center.locator('nav button[data-active="true"]')).toHaveText(last);release();await page.waitForTimeout(450);await expect(center.locator('nav button[data-active="true"]')).toHaveText(last)
  await page.unroute('**/api/staff/loyalty/configuration-center/base_points/*');await rows.first().click();await center.getByLabel('本次修改或审批说明').fill('修复验证：保存成功提示必须保留');const saved=responseWait(page,r=>r.request().method()==='PUT'&&r.url().includes('/configuration-center/'));await center.getByRole('button',{name:'保存草稿',exact:true}).click();assert.ok((await saved).ok());await expect(center.getByRole('status')).toContainText('草稿已保存')
  // A subsequent read failure must leave the confirmed write result intact.
  await page.route('**/api/staff/loyalty/configuration-center',r=>r.fulfill({status:503,json:{error:{code:'UNAVAILABLE',message:'列表读取暂时失败'}}}));await center.getByRole('button',{name:'刷新配置',exact:true}).click();await expect(center.getByRole('alert')).toContainText('读取失败，请刷新重试');await expect(center.getByRole('status')).toContainText('草稿已保存')
  return{lastSelectionPreserved:true,writeSuccessSurvivesReadFailure:true}
 })
 await probe('SYS-294-nullable-inventory',async()=>{
  const page=await login('liyan');await go(page,'/staff/member-rule-drafts');const submit=page.getByRole('button',{name:'保存完整目录草稿',exact:true}),form=submit.locator('xpath=ancestor::form');await expect.poll(()=>form.locator('select').first().locator('option').count()).toBeGreaterThan(1);await form.locator('select').first().selectOption({index:1});await form.getByLabel('所需积分').fill('10');await form.getByLabel('配置原因').fill('修复验证：不限库存改成整数');const created=responseWait(page,r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/staff/loyalty/redemption-catalogs');await submit.click();const response=await created;assert.ok(response.ok(),await response.text())
  await go(page,'/staff/member-rule-drafts');const center=page.locator('#membership-configuration-center');await center.locator('nav button').filter({hasText:'积分兑换'}).first().click();await center.getByLabel('总库存（留空不限）',{exact:true}).fill('10');await center.getByLabel('日库存（留空不限）',{exact:true}).fill('0');await center.getByLabel('每人终身上限（留空不限）',{exact:true}).fill('5');await center.getByLabel('本次修改或审批说明').fill('十份总量且每日暂停');const complete=responseWait(page,r=>r.request().method()==='PUT'&&r.url().includes('/redemption_catalog/'));await center.getByRole('button',{name:'保存草稿',exact:true}).click();const saved=await complete;assert.ok(saved.ok(),await saved.text());const body=saved.request().postDataJSON();assert.equal(body.content.items[0].totalInventory,10);assert.equal(body.content.items[0].dailyInventory,0);assert.equal(body.content.items[0].memberLifetimeLimit,5);await center.getByLabel('每人终身上限（留空不限）',{exact:true}).fill('0');assert.equal(await center.getByLabel('每人终身上限（留空不限）',{exact:true}).evaluate(e=>e.checkValidity()),false);await center.getByLabel('每人终身上限（留空不限）',{exact:true}).fill('')
  await center.getByLabel('总库存（留空不限）',{exact:true}).fill('');await center.getByLabel('本次修改或审批说明').fill('恢复不限总量');const again=responseWait(page,r=>r.request().method()==='PUT'&&r.url().includes('/redemption_catalog/'));await center.getByRole('button',{name:'保存草稿',exact:true}).click();const cleared=await again;assert.ok(cleared.ok());assert.equal(cleared.request().postDataJSON().content.items[0].totalInventory,null);assert.equal(cleared.request().postDataJSON().content.items[0].memberLifetimeLimit,null)
  return{integerAccepted:10,zeroAccepted:0,clearRestoresNull:true}
 })
 await probe('SYS-296-popup-role-access',async()=>{
  const page=await login('lengyanzhi');const denied=[];page.on('response',r=>{if(r.status()===403)denied.push(new URL(r.url()).pathname)});await go(page,'/staff/member-management#work=member-marketing');await expect(page.getByRole('heading',{name:'小程序打开弹窗',exact:true})).toBeVisible();const panel=page.locator('.bottle-custody-panel').filter({has:page.getByRole('heading',{name:'小程序打开弹窗',exact:true})});await expect(panel.getByLabel('标题',{exact:true})).toBeVisible();await expect.poll(()=>panel.getByLabel('添加推荐商品').locator('option').count()).toBeGreaterThan(1);assert.deepEqual(denied,[]);return{unauthorizedResponses:denied,productOptionsLoaded:true}
 })
 await probe('SYS-297-mobile-admin-integration',async()=>{
  const page=await login('liyan',320,true);await go(page,'/staff/member-management#work=member-integrations');await page.locator('.social-account-panel summary').filter({hasText:'新增微信账号'}).click();const sizes=[];for(const width of [320,360,390,844]){await page.setViewportSize({width,height:844});await page.waitForTimeout(150);const size=await page.evaluate(()=>({width:document.documentElement.clientWidth,scroll:Math.max(document.body.scrollWidth,document.documentElement.scrollWidth)}));assert.ok(size.scroll<=size.width+1,JSON.stringify(size));sizes.push(size)}return{sizes}
 })
 await probe('SYS-287-288-waste-recovery-and-review',async()=>{
  let page=await login('liyan');await go(page,'/staff/inventory');await page.getByRole('button',{name:'登记损耗',exact:true}).click();let panel=page.getByRole('region',{name:'登记损耗',exact:true}),form=panel.locator('form');const option=await form.locator('select').first().locator('option').nth(1).evaluate(o=>({value:o.value,text:o.textContent}));await form.locator('select').first().selectOption(option.value);await localWasteAllowance(option.value);await form.getByLabel(/损耗数量/).fill('1');await form.getByLabel('损耗原因').fill('修复验证：回执丢失且刷新页面恢复');const writes=[]
  await page.context().route(`**/api/inventory/items/${option.value}/waste`,async route=>{const response=await route.fetch();writes.push({key:route.request().headers()['idempotency-key'],body:route.request().postDataJSON(),status:response.status(),response:await response.json()});if(writes.length===1)await route.abort('connectionreset');else await route.fulfill({response})})
  await form.getByRole('button',{name:'确认登记损耗'}).click();await expect(panel.getByRole('button',{name:'恢复原登记结果'})).toBeVisible();await page.reload();await page.getByRole('button',{name:'登记损耗',exact:true}).click();await expect(panel.getByRole('button',{name:'恢复原登记结果'})).toBeVisible();const context=page.context();await page.close();page=await context.newPage();await go(page,'/staff/inventory');await page.getByRole('button',{name:'登记损耗',exact:true}).click();panel=page.getByRole('region',{name:'登记损耗',exact:true});form=panel.locator('form');await panel.getByRole('button',{name:'恢复原登记结果'}).click();await expect.poll(()=>writes.length).toBe(2);assert.equal(writes[0].key,writes[1].key);assert.equal(writes[0].response.data.movementId,writes[1].response.data.movementId);assert.equal(writes[1].response.meta.replayed,true);await expect(form.getByRole('button',{name:'确认登记损耗'})).toBeVisible()
  // A different item with the default zero allowance must be accepted as an application.
  const second=await form.locator('select').first().locator('option').nth(2).getAttribute('value');await form.locator('select').first().selectOption(second);await form.getByLabel(/损耗数量/).fill('1');await form.getByLabel('损耗原因').fill('修复验证：默认限额进入独立审批');const pending=responseWait(page,r=>r.request().method()==='POST'&&new URL(r.url()).pathname===`/api/inventory/items/${second}/waste`);await form.getByRole('button',{name:'确认登记损耗'}).click();const queued=await pending;assert.ok(queued.ok(),await queued.text());assert.equal((await queued.json()).data.status,'pending');await expect(panel.locator('p[role="status"]')).toContainText('尚未扣减库存')
  return{survivesReloadAndClosedTab:true,sameKey:true,sameMovement:true,replayed:true,defaultLimitCreatesPendingRequest:true,writes}
 })
 await probe('SYS-290-cost-navigation',async()=>{
  const page=await login('liyan');await page.route(/\/api\/auth\/(session|heartbeat)$/,async route=>{const response=await route.fetch(),body=await response.json();body.data.permissions=[...new Set([...body.data.permissions,'inventory.cost.correct'])];await route.fulfill({response,json:body})});await go(page,'/staff/inventory');await page.getByRole('button',{name:'商品与上架',exact:true}).click();await page.locator('.catalog-management-trigger[aria-expanded="false"]').click();await page.locator('.catalog-management-list article').filter({hasText:'莫吉托'}).first().getByRole('button',{name:'编辑',exact:true}).click();const name=page.getByLabel('商品名称',{exact:true});if(await name.count())await name.fill('未保存的商品名称');const recalc=page.getByRole('button',{name:/重新核算成本|核算配方成本|核算成本/}).first();if(await recalc.count())await recalc.click();await page.getByRole('button',{name:/^核对 .+ 的库存成本$/}).first().click();await expect(page.locator('#inventory-cost-correction')).toBeVisible();await page.getByRole('button',{name:'返回原商品并刷新成本'}).click();await expect(page.locator('.catalog-management-trigger')).toBeVisible();if(await name.count())await expect(name).toHaveValue('未保存的商品名称');return{costFormVisible:true,returnPreservesEditing:true,scope:'read-only UI capability fixture; no grant or cost write'}
 })
 await probe('SYS-298-money-and-percentage',async()=>{
  const page=await login('liyan');await go(page,'/staff/customer-experience#work=experience-rules')
  const panel=page.locator('.checkout-upgrade-management');await panel.getByRole('button',{name:'配置',exact:true}).click();await panel.locator('summary').filter({hasText:'新建规则草稿'}).click()
  const form=panel.locator('.checkout-upgrade-form');await expect.poll(()=>form.getByLabel('升级套餐',{exact:true}).locator('option').count()).toBeGreaterThan(0)
  await form.getByLabel('规则代码',{exact:true}).fill(`FIX_${Date.now()}`);await form.getByLabel('规则名称',{exact:true}).fill('修复验证：元和百分比保持精度')
  await form.getByLabel('最低毛利率（%）',{exact:true}).fill('1');await form.getByLabel('最多加价（元）',{exact:true}).fill('1')
  await form.getByLabel('相对加价上限（留空仅用绝对上限）（%）',{exact:true}).fill('1')
  await form.getByLabel('升级后最低贡献额（元）',{exact:true}).fill('0.01');await form.getByLabel('最低新增贡献额（元）',{exact:true}).fill('0.29');await form.getByLabel('适配依据').fill('合成测试：核对精确金额，不触发推荐')
  await form.getByLabel('份量上限商品').selectOption({index:1});await form.getByRole('button',{name:'保存此份量上限'}).click()
  const invalid=form.getByLabel('最多加价（元）',{exact:true});await invalid.fill('1.001');assert.equal(await invalid.evaluate(e=>e.checkValidity()),false);await invalid.fill('1')
  const saved=responseWait(page,r=>r.request().method()==='PUT'&&r.url().includes('/checkout-upgrade-rules/'));await form.getByRole('button',{name:'保存草稿',exact:true}).click();const response=await saved;assert.ok(response.ok(),await response.text());const body=response.request().postDataJSON()
  assert.equal(body.minimumGrossMarginBasisPoints,100);assert.equal(body.qualification.maximumAddMinor,100);assert.equal(body.qualification.maximumAddBasisPoints,100);assert.equal(body.qualification.minimumContributionMinor,1);assert.equal(body.qualification.minimumIncrementalContributionMinor,29)
  await expect(panel.getByRole('status')).toContainText('规则草稿已保存');const savedRow=panel.locator('.checkout-rule-list article').filter({hasText:'修复验证：元和百分比保持精度'}).first();await savedRow.locator('summary').click();await expect(savedRow).toContainText('最多加价 ¥1.00；相对上限 1%');await expect(savedRow).toContainText('最低新增贡献额 ¥0.29')
  const recommendation=page.locator('.recommendation-policy-panel');await recommendation.getByRole('button').first().click();await recommendation.getByRole('button',{name:'新建推荐规则草稿'}).click();const draft=recommendation.locator('form');await draft.getByLabel('最低毛利率（%）',{exact:true}).fill('1');await draft.getByLabel('最低匹配把握（%）',{exact:true}).fill('1')
  const created=responseWait(page,r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/staff/customer-experience/recommendation-policies');await draft.getByRole('button',{name:'保存草稿，交由另一人审批'}).click();const dialog=page.getByRole('alertdialog');await expect(dialog).toBeVisible();await dialog.getByRole('button',{name:'保存草稿',exact:true}).click();const policy=await created;assert.ok(policy.ok(),await policy.text());assert.equal(policy.request().postDataJSON().minimumGrossMarginBasisPoints,100);assert.equal(policy.request().postDataJSON().preferenceMinConfidenceBasisPoints,100)
  return{money:{yuan:1,minor:100,oneCent:1,decimal29Cents:29},percentage:{percent:1,basisPoints:100},excessPrecisionRejected:true,serverReadback:true}
 })
 await probe('SYS-301-seven-publication-ui',async()=>{
  const page=await login('chenfangyu'),pairs=[['base_points','基础积分','policies'],['tier_policy','会员等级','tier-policies'],['tier_benefits','等级权益','tier-benefit-policies'],['redemption_catalog','积分兑换','redemption-catalogs'],['promotion_points','促销积分','promotion-policies'],['membership_terms','入会条款','membership-terms'],['wechat_notifications','微信服务通知','wechat_notifications']]
  const rows=pairs.map(([domain,title],i)=>({domain,title,configurationId:crypto.randomUUID(),status:'approved',revision:2,version:i+1,updatedAt:new Date().toISOString(),approvedByEmployeeId:crypto.randomUUID(),effectiveFrom:null})),writes=[]
  const paths=rows.map((row,i)=>row.domain==='membership_terms'?`/api/staff/membership-terms/${row.version}/publish`:row.domain==='wechat_notifications'?`/api/staff/loyalty/configuration-center/wechat_notifications/${row.configurationId}/publish`:`/api/staff/loyalty/${pairs[i][2]}/${row.configurationId}/publish`)
  await page.route('**/api/**',async route=>{const url=new URL(route.request().url()),method=route.request().method(),index=paths.indexOf(url.pathname)
    if(url.pathname==='/api/staff/loyalty/configuration-center')return route.fulfill({json:{data:rows}})
    if(url.pathname==='/api/staff/loyalty/configuration-center/references')return route.fulfill({json:{data:[]}})
    if(index>=0&&method==='POST'){const body=route.request().postDataJSON();rows[index].status='published';rows[index].effectiveFrom=body.effectiveFrom;writes.push({path:url.pathname,body});return route.fulfill({json:{data:{id:rows[index].configurationId,status:'published'},meta:{replayed:false}}})}
    const row=rows.find(item=>url.pathname===`/api/staff/loyalty/configuration-center/${item.domain}/${item.configurationId}`)
    if(row&&method==='GET')return route.fulfill({json:{data:{publicId:row.configurationId,domain:row.domain,status:row.status,revision:row.revision,makerEmployeeIds:[crypto.randomUUID()],content:{domain:row.domain},updatedAt:row.updatedAt}}})
    return route.continue()
  })
  await go(page,'/staff/member-rule-publish');const center=page.locator('#membership-configuration-center');const local=new Date(Date.now()+86400_000+8*3600_000).toISOString().slice(0,16),expected=new Date(`${local}+08:00`).toISOString()
  for(const [index,row]of rows.entries()){await center.locator('nav button').filter({has:page.getByText(row.title,{exact:true})}).click();const form=center.getByRole('region',{name:'发布已审批规则'});await form.getByLabel('生效时间（北京时间）').fill(local);await form.getByLabel('发布说明').fill('界面路由夹具：三人流程由数据库测试另行验证');await form.getByRole('button',{name:'确认排期发布'}).click();await expect.poll(()=>writes.length).toBe(index+1);assert.equal(writes[index].body.effectiveFrom,expected);assert.equal(writes[index].body.expectedRevision,2);await expect(center.getByRole('status')).toContainText('排期已保存');await expect(center).toContainText('北京时间')}
  return{domains:rows.map(row=>row.domain),writes,scope:'UI route and input fixture only; real database publication and role checks are separately tested'}
 })
 await probe('SYS-299-business-status-report',async()=>{
  const page=await login('liyan'),states=[['custody','stored','在存'],['custody','collected','已取走待处理'],['custody','archived','已归档'],['custody','voided','已作废'],['sales','unpaid','未付款'],['sales','pending','付款结果待确认'],['sales','partially_paid','部分已付款'],['sales','paid','已付款'],['sales','partially_refunded','部分退款'],['sales','refunded','已退款'],['sales','unexpected_fixture_value','状态待核对，请联系管理员']]
  const items=states.map(([type,status],i)=>({id:String(i),type,status,public_id:`FIX-REPORT-${i}`,member_no:'测试会员',category:'隔离夹具',occurred_at:new Date().toISOString(),amount_minor:'100',amount_basis:type==='custody'?'存酒登记价值（非收入）':'消费订单应付金额（非实收）',currency:'CNY'}))
  await page.route('**/api/staff/bottle-custody/report?*',route=>route.fulfill({json:{data:{items,nextOffset:null,summary:[{type:'custody',currency:'CNY',count:'4',amount_minor:'400',unknown_amount_count:'0'},{type:'sales',currency:'CNY',count:'7',amount_minor:'700',unknown_amount_count:'0'}]}}}))
  await go(page,'/staff/member-management#work=custody');const summary=page.locator('summary').filter({hasText:'数据中心：选择统计范围'});await summary.click();const report=summary.locator('..');await report.getByRole('button',{name:'查询统计',exact:true}).click();await expect(report.locator('.custody-orders article')).toHaveCount(states.length)
  for(const [i,state]of states.entries())await expect(report.locator('.custody-orders article').nth(i)).toContainText(state[2])
  await expect(report).toContainText('人民币（元）');await expect(report).toContainText('均不能作为实收收入');assert.equal((await report.innerText()).includes('unexpected_fixture_value'),false)
  await page.screenshot({path:path.join(folder,'SYS-299-business-status-report.png'),fullPage:true});return{states:states.length,unknownHasNextStep:true,financialBasisPreserved:true,scope:'all report state rendering fixtures; workbook export uses a separate PostgreSQL integration test'}
 })
 await probe('SYS-302-303-guidance-and-touch',async()=>{
  const page=await login('liyan');await go(page,'/staff/inventory');await page.locator('.inventory-selling-guide summary').click();await expect(page.locator('.inventory-selling-flow li')).toHaveCount(4);await page.getByRole('button',{name:'商品与上架',exact:true}).click();await page.locator('.catalog-management-trigger[aria-expanded="false"]').click();await expect(page.locator('.catalog-selling-flow')).toContainText('第 2 步：选择销售规格并配置配方');assert.equal(await page.getByText(/第\s*5\s*步|第\s*4–5\s*步/).count(),0)
  await go(page,'/staff/performance');const summary=page.locator('.monthly-schedule-panel summary').first();await expect(summary).toBeVisible();const height=await summary.evaluate(e=>e.getBoundingClientRect().height);assert.ok(height>=44,`height=${height}`);await summary.focus();await page.keyboard.press('Enter');await expect(summary.locator('..')).toHaveAttribute('open','');await page.keyboard.press('Space');assert.equal(await summary.locator('..').getAttribute('open'),null)
  return{guideSteps:4,summaryHeight:height,keyboardOpenAndClose:true}
 })
} finally {
 for(const context of contexts)await context.close();await browser.close();fs.writeFileSync(path.join(folder,'fix-results.json'),JSON.stringify(results,null,2)+'\n')
 if(results.some(r=>r.result!=='passed'))process.exitCode=1
}
