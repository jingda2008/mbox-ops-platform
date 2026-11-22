import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import type { StaffOperationsData } from '../../src/normalized-ui/staff-actions/types'

async function login(page: Page, employeeCode = 'liyan') {
  const fixture = JSON.parse(await readFile(process.env.NORMALIZED_E2E_FIXTURE_FILE ?? 'artifacts/normalized-browser/fixture.json', 'utf8'))
  await page.goto(fixture.staffUrl)
  await page.getByLabel('门店口令').fill(fixture.dailyCredential)
  await page.getByRole('button', { name: /验证设备/ }).click()
  await page.getByLabel('员工账号').fill(employeeCode)
  await page.getByLabel('四位 PIN').fill(fixture.employeePin)
  await page.getByRole('button', { name: /进入工作台/ }).click()
  await expect(page.getByTestId('normalized-workspace')).toBeVisible()
  return fixture
}

test('table primary actions, more actions and return navigation preserve the list at 390px', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  // Keep the existing financial alert present without creating a real payment.
  // Otherwise a fresh fixture misses the alert that interrupted restoration in CI.
  await page.route('**/api/operations', async route => {
    const response = await route.fetch()
    const body = await response.json()
    const table = (body.data as StaffOperationsData).tables.find(table => table.code === 'W1')
    if (table?.activeSession) table.activeSession.unpaidOrderCount = Math.max(1, table.activeSession.unpaidOrderCount)
    await route.fulfill({ response, json: body })
  })
  await page.getByRole('button', { name: '现场', exact: true }).first().click()
  await expect(page.locator('.staff-table-financial-alert')).toContainText('待收款')
  await page.getByRole('group', { name: '桌台显示范围' }).getByRole('button', { name: /^全部/ }).click()
  await page.getByLabel('搜索桌号或区域').fill('W1')
  await page.locator('.staff-table-tile').first().click()
  const dialog = page.getByRole('dialog', { name: 'W1桌台操作' })
  await expect(dialog.getByRole('button', { name: '本桌收款', exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '协助点单', exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '转桌', exact: true })).toBeHidden()
  await dialog.locator('.staff-table-more > summary').click()
  await expect(dialog.getByRole('button', { name: '转桌', exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '赠送商品', exact: true })).toBeVisible()
  await dialog.screenshot({ path: testInfo.outputPath('table-action-levels.png') })
  await dialog.getByRole('button', { name: '关闭桌台操作' }).click()
  await page.getByRole('button', { name: '工作台', exact: true }).click()
  await page.goBack()
  await expect(page.getByLabel('搜索桌号或区域')).toHaveValue('W1')
  await expect(page.getByRole('group', { name: '桌台显示范围' }).getByRole('button', { name: /^全部/ })).toHaveClass(/is-active/)
  await page.getByLabel('搜索桌号或区域').fill('')
  await page.evaluate(() => window.scrollTo(0, 500))
  const originalY = await page.evaluate(() => window.scrollY)
  expect(originalY).toBeGreaterThan(100)
  await page.getByRole('navigation', { name: '岗位快捷功能' }).getByRole('button', { name: /收银|退款/ }).click()
  await expect(page.getByRole('heading', { name: '收银与退款', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '返回上一页', exact: true }).click()
  await expect(page.getByLabel('搜索桌号或区域')).toBeVisible()
  await expect.poll(async () => Math.abs(await page.evaluate(() => window.scrollY) - originalY)).toBeLessThan(4)
  const restoredPositions = await page.evaluate(async () => {
    const positions = []
    for (let frame = 0; frame < 40; frame++) {
      await new Promise(requestAnimationFrame)
      positions.push(window.scrollY)
    }
    return positions
  })
  expect(Math.max(...restoredPositions.map(position => Math.abs(position - originalY)))).toBeLessThan(4)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)
})

for (const width of [320, 390]) {
  test(`open-table headcount and more actions work on the first screen at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 568 })
    await login(page)
    await page.getByRole('button', { name: '现场', exact: true }).first().click()
    await page.getByRole('group', { name: '桌台显示范围' }).getByRole('button', { name: /^全部/ }).click()
    await page.getByLabel('搜索桌号或区域').fill('W1')
    const tile = page.locator('.staff-table-tile').first()
    await tile.click()
    const dialog = page.getByRole('dialog', { name: 'W1桌台操作' })
    const edit = dialog.getByRole('button', { name: /改人数/ })
    const more = dialog.locator('.staff-table-more > summary')
    await expect(edit).toBeInViewport({ ratio: 1 })
    await expect(more).toBeInViewport({ ratio: 1 })
    expect(await dialog.evaluate(el => el.scrollLeft === 0 && el.scrollTop === 0 && el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    await dialog.screenshot({path: testInfo.outputPath('table-actions.png')})
    await more.click()
    await expect(dialog.getByRole('button', { name: '转桌', exact: true })).toBeInViewport()
    await more.click()
    await edit.click()
    const count = dialog.getByLabel('实际人数', { exact: true })
    const previous = Number(await count.inputValue())
    await dialog.getByRole('button', { name: '增加一人' }).click()
    await expect(count).toHaveValue(String(previous + 1))
    const reason = dialog.getByLabel(/请填写加座说明/)
    if (await reason.isVisible()) await reason.fill('现场加座')
    await dialog.screenshot({path: testInfo.outputPath('edit-count.png')})
    await dialog.getByRole('button', { name: '保存人数' }).click()
    await expect(edit).toContainText(`${previous + 1}人`)
    await dialog.getByRole('button', { name: '关闭桌台操作' }).click()
    await expect(tile).toContainText(`${previous + 1}人`)
    await tile.click()
    await edit.click()
    await count.fill(String(previous))
    if (await reason.isVisible()) await reason.fill('现场调整')
    await dialog.getByRole('button', { name: '保存人数' }).click()
    await expect(edit).toContainText(`${previous}人`)
  })
}

async function readOperations(page: Page): Promise<StaffOperationsData> {
  const response = await page.request.get('/api/operations')
  expect(response.ok()).toBe(true)
  return (await response.json()).data
}

async function openCountDialog(page: Page, code: string) {
  await page.getByRole('button', { name: '现场', exact: true }).first().click()
  await page.getByRole('group', { name: '桌台显示范围' }).getByRole('button', { name: /^全部/ }).click()
  await page.getByLabel('搜索桌号或区域').fill(code)
  await page.locator('.staff-table-tile').first().click()
  return page.getByRole('dialog', { name: `${code}桌台操作` })
}

for (const action of ['重试保存', '重新编辑'] as const) {
  test(`guest count after a lost receipt and another employee's correction: ${action}`, async ({ page, browser }) => {
    await page.setViewportSize({ width: 320, height: 568 })
    await login(page)
    const peer = await browser.newContext({ baseURL: new URL(page.url()).origin })
    try {
      const second = await peer.newPage()
      await login(second, 'hugu')
      const table = (await readOperations(page)).tables.find(t => t.code === 'W1')!
      const visit = table.activeSession!
      const before = visit.guestCount, after = before + 1
      const path = `/api/table-management/sessions/${visit.id}/guest-count`
      const keys: string[] = []
      const replays: boolean[] = []
      await page.route(`**${path}`, async route => {
        const result = await route.fetch()
        expect(result.ok(), await result.text()).toBe(true)
        keys.push(route.request().headers()['x-idempotency-key'])
        replays.push((await result.json()).meta.replayed)
        if (keys.length === 1) await route.abort('connectionreset')
        else await route.fulfill({ response: result })
      })
      const dialog = await openCountDialog(page, table.code)
      const edit = dialog.getByRole('button', { name: /改人数/ })
      await edit.click()
      await dialog.getByRole('button', { name: '增加一人' }).click()
      const reason = dialog.getByLabel(/请填写加座说明/)
      if (await reason.isVisible()) await reason.fill('现场加座')
      await dialog.getByRole('button', { name: '保存人数' }).click()
      await expect(dialog.getByRole('alert')).toContainText('保存结果尚未确认')
      const readCount = async () => (await readOperations(second)).tables.find(t => t.id === table.id)!.activeSession!.guestCount
      expect(await readCount()).toBe(after)
      const restore = async () => {
        const result = await second.request.post(path, { headers: { 'x-idempotency-key': crypto.randomUUID() }, data: {
          tableId: table.id, locationVersion: visit.locationVersion ?? 0, expectedGuestCount: after, guestCount: before,
          ...(before > visit.capacityAtOpen ? { capacityOverrideReason: '现场加座' } : {}),
        } })
        expect(result.ok(), await result.text()).toBe(true)
      }
      await restore()
      if (action === '重试保存') {
        await dialog.getByRole('button', { name: '重试保存' }).click()
        await expect(dialog.getByRole('status').filter({hasText:'原修改已确认'})).toContainText(`随后已调为 ${before} 人`)
        expect(keys[1]).toBe(keys[0])
        expect(replays).toEqual([false, true])
        expect(await readCount()).toBe(before)
      } else {
        await dialog.getByRole('button', { name: '返回', exact: true }).click()
        await expect(edit).toContainText(`${before}人`)
        await edit.click()
        await dialog.getByRole('button', { name: '增加一人' }).click()
        if (await reason.isVisible()) await reason.fill('现场加座')
        await dialog.getByRole('button', { name: '保存人数' }).click()
        await expect(edit).toContainText(`${after}人`)
        expect(keys[1]).not.toBe(keys[0])
        expect(replays).toEqual([false, false])
        expect(await readCount()).toBe(after)
        await restore()
      }
    } finally { await peer.close() }
  })
}

test('paid open table confirms headcount independently of a slow or failed refresh', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 568 })
  const fixture = await login(page)
  const operations = await readOperations(page)
  const code = `HC${Date.now().toString(36)}`.toUpperCase()
  const post = async (path: string, data: object) => {
    const result = await page.request.post(path, {headers:{'idempotency-key':crypto.randomUUID()}, data})
    expect(result.ok(), await result.text()).toBe(true)
    return result.json()
  }
  const table = (await post('/api/table-management/tables', {
    code, areaId: operations.tables[0].areaId, displayName: '人数验收桌', capacity: 4, status: 'available',
  })).data
  const visit = (await post('/api/table-management/sessions/open', {
    tableId: table.id, primaryServiceEmployeeId: operations.actor.id, guestCount: 2,
  })).data
  const dialog = await openCountDialog(page, code)
  await dialog.getByRole('button', {name:'协助点单'}).click()
  const sheet = page.getByRole('dialog', {name: `${code}协助点单`})
  await sheet.getByLabel('搜索菜单商品').fill(fixture.orderableProductName)
  await sheet.getByRole('button', {name: `加入${fixture.orderableProductName}`}).click()
  await sheet.getByRole('button', {name:'查看已选'}).click()
  await sheet.getByRole('dialog', {name:'购物车明细'}).getByRole('button', {name:'核对无误，确认下单'}).click()
  const created = page.waitForResponse(r => r.url().endsWith('/api/commerce/orders') && r.request().method() === 'POST')
  await sheet.getByRole('dialog', {name:'确认上单'}).getByRole('button', {name:'确认上单'}).click()
  const order = await (await created).json()
  await post('/api/payments/manual', {orderId:order.id,provider:'cash',method:'cash',receiptReference:''})
  const session = async () => (await readOperations(page)).tables.find(t => t.id === table.id)!.activeSession
  expect(await session()).toMatchObject({ id:visit.id, status:'open', financialState:'paid', guestCount:2 })
  const close = dialog.getByRole('button', {name:'准备结台', exact:true})
  await expect(close).toBeVisible()
  const releaseReceipt = Promise.withResolvers<void>()
  const receiptReady = Promise.withResolvers<void>()
  const releaseRefresh = Promise.withResolvers<void>()
  const refreshStarted = Promise.withResolvers<void>()
  let delayRefresh = false
  const keys: string[] = []
  await page.route('**/api/operations', async route => {
    if (!delayRefresh) return route.continue()
    refreshStarted.resolve()
    await releaseRefresh.promise
    await route.fulfill({status:503, json:{error:{message:'测试读取延迟'}}})
  })
  await page.route(`**/sessions/${visit.id}/guest-count`, async route => {
    keys.push(route.request().headers()['x-idempotency-key'])
    if (keys.length === 1) return route.abort('internetdisconnected')
    const response = await route.fetch()
    expect(response.ok()).toBe(true)
    receiptReady.resolve()
    await releaseReceipt.promise
    await route.fulfill({response})
  })
  try {
    const edit = dialog.getByRole('button', {name:/改人数/})
    await edit.click()
    await dialog.getByRole('button', {name:'增加一人'}).click()
    await dialog.getByRole('button', {name:'保存人数'}).click()
    await expect(dialog.getByRole('alert')).toContainText('保存结果尚未确认')
    expect((await session())!.guestCount).toBe(2)
    await dialog.getByRole('button', {name:'重试保存'}).click()
    await receiptReady.promise
    await expect(dialog.getByRole('button', {name:'正在保存人数…'})).toBeDisabled()
    await expect(close).toBeVisible()
    await expect(dialog).not.toContainText('正在结台')
    await dialog.screenshot({path:testInfo.outputPath('paid-open-saving-guests.png')})
    delayRefresh = true
    releaseReceipt.resolve()
    await refreshStarted.promise
    await expect(edit).toHaveText(/改人数 · 3人/)
    await expect(edit).toBeEnabled()
    await expect(dialog.getByRole('status').filter({hasText:'人数已保存'})).toContainText('当前 3 人')
    await expect(close).toBeVisible()
    releaseRefresh.resolve()
    await expect(dialog.getByRole('status').filter({hasText:'现场数据刷新失败'})).toBeVisible()
    await expect(edit).toContainText('3人')
    expect(keys).toHaveLength(2)
    expect(keys[1]).toBe(keys[0])
    expect(await session()).toMatchObject({id:visit.id,status:'open',financialState:'paid',guestCount:3,orderCount:1})
  } finally {
    releaseReceipt.resolve()
    releaseRefresh.resolve()
  }
})

test('shared refund todo is counted once, opens its original record and preserves failed-read evidence', async ({ page }) => {
  await login(page)
  const baseline = await (await page.request.get('/api/payments/workbench?limit=100')).json()
  const refund = { id: 'ui-refund', publicId: 'UI-REFUND', paymentId: 'ui-payment', providerRefundId: null, amountMinor: 100, currency: 'CNY', status: 'requested', providerSubmissionState: 'not_started', reason: '浏览器只读展示核对', requestedByEmployeeId: 'another-employee', requestedByEmployeeName: '申请同事', approvedByEmployeeId: null, approvedByEmployeeName: null, decisionReason: null, receiptReference: null, completedAt: null, createdAt: new Date().toISOString(), allocations: [] }
  const payment = { id: 'ui-payment', publicId: 'UI-PAYMENT', provider: 'cash', method: 'cash', providerTransactionId: null, providerActionState: null, retryReleasedAt: null, retryReleaseReason: null, amountMinor: 100, currency: 'CNY', status: 'succeeded', succeededAt: new Date().toISOString(), createdAt: new Date().toISOString(), reservedRefundAmountMinor: 100, remainingRefundableMinor: 0, refundableItems: [], refunds: [refund] }
  const order = { id: 'ui-order', publicId: 'UI-ORDER', tableCode: 'W1', channel: 'staff_assisted', status: 'confirmed', paymentStatus: 'paid', totalAmountMinor: 100, outstandingAmountMinor: 0, overCollectedAmountMinor: 0, currency: 'CNY', submittedAt: new Date().toISOString(), createdAt: new Date().toISOString(), items: [], kdsTasks: [], payments: [payment] }
  let fail = 0
  let writes = 0
  page.on('request', request => { if (/\/api\/(refunds|payments)\//.test(request.url()) && request.method() !== 'GET') writes++ })
  await page.route('**/api/payments/workbench?*', route => fail ? route.fulfill({ status: fail, json: { error: { code: 'UNAVAILABLE' } } }) : route.fulfill({ json: { data: { ...baseline.data, orders: [order, { ...order, id: 'ui-order-two' }], activityRegistrations: [] } } }))
  const todos = page.getByRole('region', { name: '待办事项', exact: true })
  await todos.getByRole('button', { name: '刷新待办', exact: true }).click()
  await todos.getByLabel('待办业务', { exact: true }).selectOption('refund')
  if (!baseline.data.actions.canApproveRefund) await todos.getByRole('button', { name: '等待处理', exact: true }).click()
  await expect(todos.locator('[data-todo-id="refund:ui-refund"]')).toHaveCount(1)
  await todos.getByRole('button', { name: baseline.data.actions.canApproveRefund ? '复核申请' : '核对退款进度', exact: true }).click()
  await expect(page.locator('[data-staff-todo-id="refund:ui-refund"]').filter({ visible: true })).toHaveCount(1)
  await page.getByRole('button', { name: '返回上一页', exact: true }).click()
  await expect(todos.getByLabel('待办业务', { exact: true })).toHaveValue('refund')
  await expect(todos.locator('[data-todo-id="refund:ui-refund"]')).toBeVisible()
  fail = 503
  await todos.getByRole('button', { name: '刷新待办', exact: true }).click()
  await expect(todos.getByRole('alert')).toContainText('部分待办未能更新')
  await expect(todos.locator('[data-todo-id="refund:ui-refund"]')).toContainText('上次数据')
  fail = 403
  await todos.getByRole('button', { name: '刷新待办', exact: true }).click()
  await expect(todos.getByRole('alert')).toContainText('当前权限已变更')
  await expect(todos.locator('[data-todo-id="refund:ui-refund"]')).toHaveCount(0)
  expect(writes).toBe(0)
})

test('member workspace uses existing authorized routes and retains the last business section', async ({ page }) => {
  await login(page)
  await page.getByRole('button', { name: '全部岗位入口', exact: true }).click()
  await page.getByRole('button', { name: '会员服务与管理', exact: true }).click()
  const membership = page.getByRole('navigation', { name: '会员工作台', exact: true })
  await expect(membership).toBeVisible()
  await membership.getByRole('button', { name: '会员办理与活动', exact: true }).click()
  await page.getByRole('navigation', { name: '会员办理与管理', exact: true }).getByRole('button', { name: '规则与条款', exact: true }).click()
  await page.getByRole('button', { name: '工作台', exact: true }).click()
  await page.goBack()
  await expect(page.getByRole('navigation', { name: '会员办理与管理', exact: true }).getByRole('button', { name: '规则与条款', exact: true })).toHaveAttribute('aria-current', 'page')
  await membership.getByRole('button', { name: '查会员', exact: true }).click()
  await expect(page.getByRole('heading', { name: '会员账户查询', exact: true })).toBeVisible()
  await membership.getByRole('button', { name: '会员办理与活动', exact: true }).click()
  const sections = page.getByRole('navigation', { name: '会员办理与管理', exact: true })
  // This section is authorized in both the default and opt-in acceptance fixtures.
  await sections.getByRole('button', { name: '权益与兑换', exact: true }).click()
  await page.route('**/api/auth/heartbeat', async route => {
    const response = await route.fetch()
    const body = await response.json()
    body.data.permissions = body.data.permissions.filter((permission: string) => !permission.startsWith('loyalty.'))
    await route.fulfill({ response, json: body })
  })
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(sections.getByRole('button', { name: '权益与兑换', exact: true })).toHaveCount(0)
  await expect(sections.locator('button[aria-current="page"]')).toHaveCount(1)
})

test('return-state memory is cleared when another employee signs in', async ({ page }) => {
  const fixture = await login(page)
  await page.getByRole('button', { name: '现场', exact: true }).first().click()
  await page.getByLabel('搜索桌号或区域').fill('W1')
  await page.getByRole('button', { name: /切换账号/ }).click()
  const dialog = page.getByRole('dialog', { name: '切换员工', exact: true })
  await dialog.getByLabel('下一位员工账号').fill('tom')
  await dialog.getByLabel('四位 PIN').fill(fixture.employeePin)
  await dialog.getByRole('button', { name: '验证并切换', exact: true }).click()
  await expect(page.getByTestId('normalized-workspace')).toBeVisible()
  await page.getByRole('button', { name: '现场', exact: true }).first().click()
  await expect(page.getByLabel('搜索桌号或区域')).toHaveValue('')
})

test('320px live table and cashier show the three VIP8 money snapshots without reopening a refunded order', async ({page}) => {
  await page.setViewportSize({width:320,height:844})
  await login(page)
  const operations = await readOperations(page)
  const source = operations.tables.find(t=>t.activeSession)
  expect(source?.activeSession).toBeTruthy()
  const baseline = (await (await page.request.get('/api/payments/workbench?limit=20')).json()).data
  const now = new Date().toISOString()
  const snapshots = [
    {gross:1201,refund:0,due:792,count:3,cash:0},
    {gross:1201,refund:1201,due:792,count:3,cash:0},
    {gross:3173,refund:1201,due:0,count:0,cash:1972},
  ]
  let readFailed=false
  let state = snapshots[0]!
  const money = ()=>({grossCollectedAmountMinor:state.gross*100,refundedAmountMinor:state.refund*100,
    netCollectedAmountMinor:(state.gross-state.refund)*100,outstandingAmountMinor:state.due*100,
    unpaidOrderCount:state.count,pendingPaymentCount:0,cashAmountMinor:state.cash*100,cashPaymentCount:state.cash?1:0})
  await page.route('**/api/operations',route=>route.fulfill({json:{data:{...operations,tables:[{...source,code:'VIP8',
    activeSession:{...source!.activeSession,orderCount:8,financialState:state.due?'unpaid':'partially_refunded',...money()}}]}}}))
  await page.route('**/api/payments/workbench?*',route=>{
    if(readFailed) return route.fulfill({status:503,json:{error:{code:'UNAVAILABLE'}}})
    const refund = {id:'vip8-refund',publicId:'refund-321',paymentId:'scan-321',amountMinor:32100,status:'succeeded',currency:'CNY',
      providerSubmissionState:'submitted',requestedByEmployeeName:'测试服务员',reason:'隔离展示回放',completedAt:now,createdAt:now,allocations:[]}
    const payment = {id:'scan-321',publicId:'SCAN-321',provider:'postar',method:'native_qr',amountMinor:32100,currency:'CNY',
      status:state.refund?'refunded':'succeeded',createdAt:now,succeededAt:now,reservedRefundAmountMinor:0,remainingRefundableMinor:state.refund?0:32100,
      providerTransactionId:'test-321',providerActionState:null,retryReleasedAt:null,refundableItems:[],refunds:state.refund?[refund]:[]}
    const order = {id:'order-321',publicId:'VIP8-7339c7',tableCode:'VIP8',tableSessionId:source!.activeSession!.id,tableSessionStatus:'open',
      channel:'staff_assisted',status:'submitted',paymentStatus:state.refund?'refunded':'paid',totalAmountMinor:32100,
      outstandingAmountMinor:state.refund?32100:0,overCollectedAmountMinor:0,currency:'CNY',createdAt:now,submittedAt:now,
      items:[],kdsTasks:[],payments:[payment]}
    return route.fulfill({json:{data:{...baseline,query:'VIP8',selectedTable:{tableCode:'VIP8',sessionId:source!.activeSession!.id,businessDate:'2026-11-21',money:money()},orders:[order],activityRegistrations:[]}}})
  })
  for (const snapshot of snapshots) {
    state=snapshot
    await page.goto('/staff/live')
    const tile=page.locator('.staff-table-tile').filter({hasText:'VIP8'})
    await expect(tile).toBeVisible()
    await tile.click()
    const floor=page.getByRole('dialog',{name:/VIP8.*桌台操作/}).getByLabel('本桌次收退款')
    await pageCheck(floor)
    await page.goto('/staff/payments?query=VIP8')
    const cashier=page.getByRole('region',{name:'查询桌次实收'})
    await pageCheck(cashier)
    if(state.refund) {
      const original=page.locator('[data-cashier-order-id="order-321"]')
      await expect(original.getByRole('button',{name:'收款',exact:true})).toHaveCount(0)
      await expect(original.getByRole('button',{name:'查看退款记录'})).toBeVisible()
      await expect(original).toContainText('本单已收 ¥321.00 · 已退 ¥321.00 · 净收 ¥0.00')
    }
  }

  readFailed=true
  await page.getByRole('button',{name:'刷新收银与退款'}).click()
  const cashier=page.getByRole('region',{name:'查询桌次实收'})
  await expect(cashier.getByRole('status')).toContainText('当前结果待核对')
  await expect(cashier).toContainText('净收 ¥1972.00')
  readFailed=false
  await page.getByRole('button',{name:'重新读取订单',exact:true}).click()
  await expect(cashier.getByRole('status')).toHaveCount(0)
  await expect(cashier).toContainText('待收 ¥0.00')

  async function pageCheck(region:ReturnType<Page['getByLabel']>) {
    await expect(region).toContainText('累计已收 ¥'+state.gross.toFixed(2))
    await expect(region).toContainText('已退 ¥'+state.refund.toFixed(2))
    await expect(region).toContainText('净收 ¥'+(state.gross-state.refund).toFixed(2))
    await expect(region).toContainText('待收 ¥'+state.due.toFixed(2)+'（'+state.count+' 单）')
    if (state.cash) await expect(region).toContainText('收银登记 1 笔，共 ¥1972.00')
    const rect=await region.boundingBox()
    expect(rect!.y+rect!.height).toBeLessThanOrEqual(844)
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(320)
  }
})
