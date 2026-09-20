import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { chromium, expect } from '@playwright/test'
import pg from 'pg'

const out = path.resolve(process.env.STAFF_AUDIT_OUT ?? 'artifacts/staff-every-control-20260920')
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
  try { const evidence = await run(); results.push({ id, result: 'confirmed', evidence }) }
  catch (error) {
    results.push({ id, result: 'not-confirmed-or-harness-failed', error: error.message })
    const page = contexts.at(-1)?.pages().at(-1)
    if (page) { fs.writeFileSync(path.join(folder, `${id}-diagnostic.txt`), await page.locator('body').innerText()); await page.screenshot({path:path.join(folder,`${id}-diagnostic.png`)}) }
  }
  fs.writeFileSync(path.join(folder, `${only ? only.join('-') : 'results'}.json`), JSON.stringify(results, null, 2) + '\n')
  console.log(JSON.stringify(results.at(-1)))
}
try {
  await probe('default-waste-denied', async () => {
    const page=await login('liyan');await go(page,'/staff/inventory')
    await page.getByRole('button',{name:'登记损耗',exact:true}).click()
    const form=page.locator('#inventory-quick-count')
    await form.locator('select').first().selectOption({index:2})
    await form.getByLabel('损耗数量').fill('1');await form.getByLabel('损耗原因').fill('逐键审计：默认限额的损耗申请')
    const completed=page.waitForResponse(response=>response.request().method()==='POST'&&/\/inventory\/items\/[^/]+\/waste$/.test(new URL(response.url()).pathname))
    await form.getByRole('button',{name:'确认登记损耗'}).click()
    const response=await completed;assert.equal(response.status(),409)
    const error=await response.json();assert.equal(error.error.code,'INVENTORY_CONFLICT')
    await expect(form.getByRole('button',{name:'确认登记损耗'})).toBeEnabled()
    return {status:response.status(),error,request:response.request().postDataJSON(),notice:await page.locator('.staff-module-notice').allTextContents(),approvalButtons:await page.getByRole('button',{name:/损耗.*审批|提交损耗申请|申请.*损耗/}).count()}
  })
  await probe('overview-is-editable', async () => {
    const page = await login('liyan'); await go(page, '/staff/member-overview')
    const disclaimer = await page.locator('.customer-experience-publishing-intro').innerText()
    await expect(page.getByRole('button', { name: '保存新版本草稿', exact: true })).toBeVisible()
    const form = page.locator('.loyalty-policy-panel form')
    await form.getByLabel('配置原因').fill('逐键审计：验证只读页面实际允许建立草稿')
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/staff/loyalty/policies' && response.request().method() === 'POST')
    await page.getByRole('button', { name: '保存新版本草稿', exact: true }).click()
    const saved = await response
    assert.ok(saved.ok())
    await expect(page.locator('.loyalty-policy-panel')).toContainText('积分规则已保存为草稿', { timeout: 2500 }).catch(async () => { await expect(page.locator('.loyalty-policy-panel')).toContainText('保存', { timeout: 1000 }) })
    const status = await page.locator('.loyalty-policy-panel [role="status"]').allTextContents()
    await page.screenshot({ path: path.join(folder, 'overview-is-editable.png') })
    return { disclaimer, responseStatus: saved.status(), saved: await saved.json(), status }
  })
  await probe('approval-link-no-destination', async () => {
    const page = await login('hugu'); await go(page, '/staff/member-overview')
    const button = page.locator('.loyalty-policy-panel').getByRole('button', { name: '前往配置中心审批', exact: true }).last()
    await expect(button).toBeVisible()
    const before = page.url(); await button.click(); await page.waitForTimeout(500)
    const centerCount = await page.locator('#membership-configuration-center').count()
    const notice = await page.locator('.loyalty-policy-panel [role="status"]').innerText()
    assert.equal(centerCount, 0); assert.equal(page.url(), before)
    await page.screenshot({ path: path.join(folder, 'approval-link-no-destination.png') })
    return { before: new URL(before).pathname, after: new URL(page.url()).pathname, centerCount, notice }
  })
  await probe('waste-response-loss-duplicates-stock', async () => {
    const page = await login('liyan'); await go(page, '/staff/inventory')
    await page.getByRole('button', { name: '登记损耗', exact: true }).click()
    const form = page.locator('#inventory-quick-count')
    const option = await form.locator('select').first().locator('option').nth(1).evaluate(element => ({ value: element.value, text: element.textContent }))
    await form.locator('select').first().selectOption(option.value)
    const allowanceFixture = await localWasteAllowance(option.value)
    await form.getByLabel('损耗数量').fill('1')
    await form.getByLabel('损耗原因').fill('逐键审计：模拟服务已登记但浏览器没有收到结果')
    const writes = []
    await page.route(`**/api/inventory/items/${option.value}/waste`, async route => {
      const response = await route.fetch()
      writes.push({ requestKey: route.request().headers()['idempotency-key'], body: route.request().postDataJSON(), status: response.status(), response: await response.json() })
      fs.writeFileSync(path.join(folder, 'waste-requests.json'), JSON.stringify(writes, null, 2))
      if (writes.length === 1) await route.abort('connectionreset')
      else await route.fulfill({ response })
    })
    await form.getByRole('button', { name: '确认登记损耗' }).click()
    await expect.poll(() => writes.length).toBe(1)
    await expect(form.getByRole('button', { name: '确认登记损耗' })).toBeEnabled()
    const firstNotice = await page.locator('.staff-module-notice').allTextContents()
    await form.getByRole('button', { name: '确认登记损耗' }).click()
    await expect.poll(() => writes.length).toBe(2)
    await expect(form.getByRole('button', { name: '确认登记损耗' })).toBeEnabled()
    assert.ok(writes.every(write => write.status < 300))
    assert.notEqual(writes[0].requestKey, writes[1].requestKey)
    const unwrap = response => response.data ?? response
    assert.equal(Number(unwrap(writes[0].response).remainingQuantity) - Number(unwrap(writes[1].response).remainingQuantity), 1)
    await page.screenshot({ path: path.join(folder, 'waste-response-loss-duplicates-stock.png') })
    return { itemId: option.value, option: option.text, allowanceFixture, firstNotice, writes, finalNotice: await page.locator('.staff-module-notice').allTextContents() }
  })
  await probe('catalog-cost-form-hidden', async () => {
    const page = await login('liyan')
    // Controlled read-only UI capability fixture. Production grants and write
    // authorization are unchanged; this probe never submits cost corrections.
    await page.route(/\/api\/auth\/(session|heartbeat)$/, async route => {
      const response = await route.fetch(); const body = await response.json()
      body.data.permissions = [...new Set([...body.data.permissions, 'inventory.cost.correct'])]
      await route.fulfill({ response, json: body })
    })
    await go(page, '/staff/inventory')
    await page.getByRole('button', { name: '商品与上架', exact: true }).click()
    await page.locator('.catalog-management-trigger[aria-expanded="false"]').click()
    const product = page.locator('.catalog-management-list article').filter({ hasText: '莫吉托' }).first()
    await product.getByRole('button', { name: '编辑', exact: true }).click()
    const recalc = page.getByRole('button', { name: /重新核算成本|核算配方成本|核算成本/ }).first()
    if (await recalc.count()) await recalc.click()
    const button = page.getByRole('button', { name: /^核对 .+ 的库存成本$/ }).first()
    await expect(button).toBeVisible()
    const label = await button.innerText(); await button.click(); await page.waitForTimeout(350)
    assert.equal(await page.locator('#inventory-cost-correction').count(), 1)
    assert.equal(await page.locator('#inventory-cost-correction').isVisible(), false)
    const selected = await page.locator('.staff-task-section-nav [aria-current="page"]').innerText()
    await page.screenshot({ path: path.join(folder, 'catalog-cost-form-hidden.png') })
    return { button: label, selected, formExists: true, formVisible: false, hash: new URL(page.url()).hash, scope:'Read-only UI capability fixture; default store roles lack cost-correction permission' }
  })
  await probe('member-fulfillment-shows-configuration', async () => {
    const page = await login('liyan'); await go(page, '/staff/member-fulfillment')
    const buttons = await page.getByRole('button').allTextContents()
    assert.ok(buttons.some(text => text.includes('保存等级规则草稿')) || buttons.some(text => text.includes('保存完整目录草稿')))
    return { introduction: await page.locator('.customer-experience-publishing-intro').innerText(), configurationButtons: buttons.filter(text => /草稿|发布|试点开放|正式开放/.test(text)) }
  })
  await probe('tier-validation-no-feedback', async () => {
    const page = await login('liyan'); await go(page, '/staff/member-fulfillment')
    const errors=[]; page.on('pageerror', error => errors.push(error.message))
    const field = page.getByLabel('银卡积分倍率', {exact:true})
    await field.fill('')
    const form = field.locator('xpath=ancestor::form')
    await form.getByLabel('配置原因').fill('逐键审计：空倍率应该提示用户补填')
    await form.getByRole('button',{name:'保存等级草稿',exact:true}).click()
    await expect.poll(()=>errors.length).toBeGreaterThan(0)
    const visibleStatus=await page.locator('[role="status"]:visible,[role="alert"]:visible').allTextContents()
    assert.ok(errors.some(error=>error.includes('银卡积分倍率')))
    assert.ok(!visibleStatus.some(text=>text.includes('银卡积分倍率')))
    return {errors,visibleStatus,fieldValue:await field.inputValue()}
  })
  await probe('configuration-success-cleared', async () => {
    const page = await login('liyan'); await go(page, '/staff/member-rule-drafts')
    const center=page.locator('#membership-configuration-center')
    await center.locator('button[aria-expanded="false"]').first().click()
    await center.locator('nav[aria-label="配置列表"] button').filter({hasText:'基础积分'}).last().click()
    await center.getByLabel('本次修改或审批说明').fill('逐键审计：确认保存成功反馈是否保留')
    const response=page.waitForResponse(response=>response.request().method()==='PUT'&&response.url().includes('/configuration-center/'))
    await center.getByRole('button',{name:'保存草稿',exact:true}).click()
    const saved=await response;assert.ok(saved.ok())
    await expect(center.getByRole('button',{name:'保存草稿',exact:true})).toBeEnabled()
    const messages=await center.locator('[role="status"]:visible').allTextContents()
    assert.ok(!messages.some(message=>message.includes('草稿已保存')))
    return {status:saved.status(),saved:await saved.json(),messages}
  })
  await probe('configuration-selection-race', async () => {
    const page=await login('liyan'); await go(page,'/staff/member-overview')
    const form=page.locator('.loyalty-policy-panel form')
    await form.getByLabel('配置原因').fill('逐键审计：第二份隔离草稿用于切换顺序验证')
    const created=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/staff/loyalty/policies')
    await form.getByRole('button',{name:'保存新版本草稿',exact:true}).click();assert.ok((await created).ok())
    await go(page,'/staff/member-rule-drafts')
    const center=page.locator('#membership-configuration-center')
    await center.locator('button[aria-expanded="false"]').first().click()
    const rows=center.locator('nav[aria-label="配置列表"] button').filter({hasText:'基础积分'})
    await expect.poll(()=>rows.count()).toBeGreaterThan(1)
    let release, firstStarted, first=true
    const gate=new Promise(resolve=>{release=resolve})
    const started=new Promise(resolve=>{firstStarted=resolve})
    await page.route('**/api/staff/loyalty/configuration-center/base_points/*',async route=>{
      if(route.request().method()!=='GET')return route.continue()
      const response=await route.fetch()
      if(first){first=false;firstStarted();await gate}
      await route.fulfill({response})
    })
    const firstLabel=await rows.first().innerText(),lastLabel=await rows.last().innerText()
    await rows.first().click();await started
    await rows.last().click()
    await expect.poll(()=>center.locator('nav button[data-active="true"]').innerText()).toBe(lastLabel)
    release()
    await expect.poll(()=>center.locator('nav button[data-active="true"]').innerText()).toBe(firstLabel)
    return {lastUserSelection:lastLabel,finalDisplayedSelection:firstLabel,network:'First real GET response delivered after second real GET response; no response content was changed'}
  })
  await probe('nullable-inventory-input-rejected', async () => {
    const page=await login('liyan');await go(page,'/staff/member-fulfillment')
    const submit=page.getByRole('button',{name:'保存完整目录草稿',exact:true})
    const form=submit.locator('xpath=ancestor::form')
    await expect.poll(()=>form.locator('select').first().locator('option').count()).toBeGreaterThan(1)
    await form.locator('select').first().selectOption({index:1})
    await form.getByLabel('所需积分').fill('10')
    await form.getByLabel('配置原因').fill('逐键审计：不限库存的兑换草稿')
    const created=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/staff/loyalty/redemption-catalogs')
    await submit.click();const creation=await created;assert.ok(creation.ok())
    await go(page,'/staff/member-rule-drafts')
    const center=page.locator('#membership-configuration-center')
    await center.locator('button[aria-expanded="false"]').first().click()
    await center.locator('nav[aria-label="配置列表"] button').filter({hasText:'积分兑换'}).first().click()
    await center.getByLabel('总库存',{exact:true}).fill('10')
    await center.getByLabel('本次修改或审批说明').fill('逐键审计：把不限库存改成十份')
    const completed=page.waitForResponse(response=>response.request().method()==='PUT'&&response.url().includes('/configuration-center/redemption_catalog/'))
    await center.getByRole('button',{name:'保存草稿',exact:true}).click()
    const response=await completed;assert.ok(!response.ok())
    const error=await response.json();assert.equal(error.error.code,'MEMBERSHIP_CONFIGURATION_INVALID')
    const body=response.request().postDataJSON();assert.equal(typeof body.content.items[0].totalInventory,'string')
    return {requestValue:body.content.items[0].totalInventory,requestValueType:typeof body.content.items[0].totalInventory,status:response.status(),error,visibleStatus:await center.locator('[role="status"]').allTextContents()}
  })
  await probe('mobile-notification-overflow', async () => {
    const page=await login('liyan',320,true);await go(page,'/staff/member-management#work=member-marketing')
    await page.locator('summary').filter({hasText:'新增微信账号'}).click()
    await page.waitForTimeout(600)
    const result=await page.evaluate(()=>{
      const width=document.documentElement.clientWidth
      return {width,scrollWidth:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),overflowElements:Array.from(document.querySelectorAll('main p,main label,main input,main select,main button')).filter(element=>element.getClientRects().length).map(element=>({tag:element.tagName,text:element.textContent?.slice(0,210),left:element.getBoundingClientRect().left,right:element.getBoundingClientRect().right,scroll:element.scrollWidth,width:element.clientWidth})).filter(element=>element.right>width+1||element.scroll>element.width+1)}
    })
    assert.ok(result.scrollWidth>result.width+1)
    await page.screenshot({path:path.join(folder,'mobile-notification-overflow.png')})
    return result
  })
} finally { for (const context of contexts) await context.close(); await browser.close() }
