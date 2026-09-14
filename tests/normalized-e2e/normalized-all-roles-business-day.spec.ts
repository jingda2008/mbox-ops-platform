import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test, type Browser, type Page } from '@playwright/test'

interface EmployeeFixture {
  code: string
  name: string
  roleNames: string[]
  highFrequencyEntries: Array<{ label: string; route: string }>
  navigationRoutes: string[]
}

interface Fixture {
  guestUrl: string
  staffUrl: string
  dailyCredential: string
  employeePin: string
  orderableProductUnitPriceMinor: number
  orderableProductName: string
  kitchenProductName: string
  bundleProductName:string
  employees: EmployeeFixture[]
  remakeHandoverFixture?:{batchId:string;itemId:string;tableCode:string;productName:string}
  recoveryBaseUrl?:string
}

const expectedEmployees = new Map([
  ['chenfangyu', '陈方宇'],
  ['hugu', '护古'],
  ['wuya', '乌鸦'],
  ['tata', '挞挞'],
  ['fuchunyu', '付淳羽'],
  ['liyan', '李艳'],
  ['lengyanzhi', '冷言志'],
  ['sanmu', '三沐'],
  ['tom', 'Tom'],
  ['jerry', 'Jerry'],
  ['tyke', 'Tyke'],
  ['shenliangliang', '申良良'],
  ['ajin', '阿金'],
])

const expectedHighFrequencyEntries = new Map<string, string[]>([
  ['chenfangyu', ['现场', '收银与退款']],
  ['hugu', ['现场', '任务']],
  ['wuya', ['客户与活动', '系统配置', '预约']],
  ['tata', []],
  ['fuchunyu', ['演出点歌']],
  ['liyan', ['现场', '任务', '出品', '预约到店']],
  ['lengyanzhi', ['现场', '任务', '吧台出品']],
  ['sanmu', ['收银复核']],
  ['tom', ['现场', '任务', '取送', '预约到店']],
  ['jerry', ['现场', '任务', '取送', '预约到店']],
  ['tyke', ['现场', '任务', '取送', '预约到店']],
  ['shenliangliang', ['后厨出品']],
  ['ajin', ['演出现场']],
])

async function fixture(): Promise<Fixture> {
  return JSON.parse(await readFile(resolve(
    process.env.NORMALIZED_E2E_FIXTURE_FILE ?? 'artifacts/normalized-browser/fixture.json',
  ), 'utf8')) as Fixture
}

async function login(page: Page, data: Fixture, employee: EmployeeFixture) {
  await page.goto(data.staffUrl)
  await page.getByLabel('门店口令').fill(data.dailyCredential)
  await page.getByRole('button', { name: /验证设备/ }).click()
  await page.getByLabel('员工账号').fill(employee.code)
  await page.getByLabel('四位 PIN').fill(data.employeePin)
  await page.getByRole('button', { name: /进入工作台/ }).click()
  await expect(page.getByTestId('normalized-workspace')).toBeVisible()
}

function employee(data: Fixture, code: string): EmployeeFixture {
  const value = data.employees.find((candidate) => candidate.code === code)
  if (!value) throw new Error(`missing employee fixture: ${code}`)
  return value
}

async function staffPage(browser: Browser, data: Fixture, code: string) {
  const context = await browser.newContext()
  const page = await context.newPage()
  await login(page, data, employee(data, code))
  return { context, page }
}

async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    page: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
  }))
  expect(dimensions.page).toBeLessThanOrEqual(dimensions.viewport + 1)
}

test('all real employees enter role-scoped mobile workspaces and every high-frequency entry is live', async ({ browser }) => {
  test.setTimeout(120_000)
  const data = await fixture()
  expect(data.employees).toHaveLength(expectedEmployees.size)

  for (const employee of data.employees) {
    expect(expectedEmployees.get(employee.code), `unexpected employee code ${employee.code}`).toBe(employee.name)
    expect(
      employee.highFrequencyEntries.map((entry) => entry.label).sort(),
      `${employee.name} high-frequency entry configuration drifted`,
    ).toEqual([...(expectedHighFrequencyEntries.get(employee.code) ?? [])].sort())
    const context = await browser.newContext({ viewport: { width: 320, height: 720 }, isMobile: true, hasTouch: true })
    const page = await context.newPage()
    await login(page, data, employee)
    await expect(page.getByRole('heading', { name: employee.name })).toBeVisible()
    for (const roleName of employee.roleNames) await expect(page.locator('.normalized-identity')).toContainText(roleName)
    await expectNoHorizontalOverflow(page)

    for (const entry of employee.highFrequencyEntries) {
      await page.getByRole('button', { name: entry.label, exact: true }).first().click()
      await expect(page.getByText(/仍在规范化改造中/)).toHaveCount(0)
      if (entry.route === '/staff/performance') {
        await expect(page.getByRole('heading', { name: '演出与点歌' })).toBeVisible()
        await expect(page.getByText('林小满', {exact:true}).first()).toBeVisible()
        await expect(page.getByText('后来')).toBeVisible()
      }
      if (entry.route === '/staff/live') await expect(page.getByRole('heading', { name: '找到桌台，直接处理' })).toBeVisible()
      if (entry.route === '/staff/tasks') await expect(page.getByRole('heading', { name: '只看需要服务的事' })).toBeVisible()
      if (entry.route === '/staff/fulfillment') await expect(page.getByRole('heading', { name: '只做当前下一步' })).toBeVisible()
      if (entry.route === '/staff/reservations') await expect(page.getByText('预约与到店', { exact: true })).toBeVisible()
      if (entry.route === '/staff/payments') await expect(page.getByRole('heading', { name: '收银与退款' })).toBeVisible()
      if (entry.route === '/staff/settings') await expect(page.getByRole('heading', { name: '系统配置状态' })).toBeVisible()
      await expectNoHorizontalOverflow(page)
      if (new URL(page.url()).pathname !== '/') {
        await page.getByRole('button', { name: '工作台', exact: true }).click()
        await expect(page.getByTestId('normalized-workspace')).toBeVisible()
      }
    }
    for (const route of employee.navigationRoutes) {
      await page.goto(route)
      await expect(page.getByText(/仍在规范化改造中/)).toHaveCount(0)
      await expect(page.getByText('暂时没有接上', { exact: true })).toHaveCount(0)
      await expectStaffRoute(page, route)
      await expectNoHorizontalOverflow(page)
    }
    await context.close()
  }
})

async function expectStaffRoute(page: Page, route: string) {
  const heading = ({
    '/staff/live': '找到桌台，直接处理',
    '/staff/tasks': '只看需要服务的事',
    '/staff/fulfillment': '只做当前下一步',
    '/staff/payments': '收银与退款',
    '/staff/orders': '订单中心',
    '/staff/performance': '演出与点歌',
    '/staff/inventory': '库存与酒水上架',
    '/staff/operations': '经营数据',
    '/staff/customer-experience': '客户体验与活动',
    '/staff/member-fulfillment': '会员权益待办',
    '/staff/member-exceptions': '会员权益异常',
    '/staff/member-overview': '会员等级与权益',
    '/staff/member-rule-drafts': '会员规则草稿',
    '/staff/member-rule-approvals': '待审批会员规则',
    '/staff/member-rule-publish': '会员规则发布',
    '/staff/member-accounts': '会员账户查询',
    '/staff/member-management': '其他会员经营配置',
    '/staff/devices': '设备与打印',
    '/staff/settings': '系统配置状态',
  } as Record<string, string>)[route]
  if (route === '/staff/reservations') {
    await expect(page.getByText('预约与到店', { exact: true })).toBeVisible()
  } else {
    expect(heading, `missing route assertion for ${route}`).toBeTruthy()
    await expect(page.getByRole('heading', { name: heading })).toBeVisible()
  }
}

test('one business-day order and guest requests flow through bartender, kitchen, service and manager roles', async ({ browser }) => {
  test.setTimeout(120_000)
  const data = await fixture()
  const guestContext = await browser.newContext()
  const guest = await guestContext.newPage()
  await guest.goto(data.guestUrl)
  await expect(guest.getByTestId('normalized-guest-app')).toBeVisible()

  await guest.getByRole('button', { name: /记录今晚心情/ }).click()
  await guest.getByRole('button', { name: '心情：开心' }).click()
  await expect(guest.getByRole('button', { name: '心情：开心' })).toHaveAttribute('aria-pressed', 'true')
  await guest.getByRole('button', { name: '呼叫服务员' }).click()
  await expect(guest.getByRole('status')).toContainText(/收到|安排|赶来/)
  await guest.getByRole('button', { name: '投诉 / 不满意' }).click()
  const complaint = guest.getByRole('dialog', { name: '我们想马上处理好' })
  await complaint.getByLabel('哪里没有照顾好您').fill('营业日验收：音乐太响，请经理到桌沟通')
  await complaint.getByRole('button', { name: '提交给现场伙伴' }).click()
  await expect(guest.getByRole('status')).toContainText(/收到|经理|处理/)

  for (const productName of [data.orderableProductName, data.kitchenProductName]) {
    await guest.getByLabel('搜索菜单商品').fill(productName)
    await guest.getByRole('button', { name: `加入${productName}` }).click()
  }
  await guest.getByRole('button', { name: '查看已选' }).click()
  const cart = guest.getByRole('dialog', { name: '购物车明细' })
  await cart.getByPlaceholder('如：少冰、不要香菜、酒水和小食一起上').fill('营业日验收：未付款订单不得出品')
  await cart.getByRole('button', { name: /确认订单并微信支付/ }).click()
  await guest.getByRole('dialog', { name: '确认上单' }).getByRole('button', { name: '确认上单' }).click()
  const resultDialog = guest.getByRole('dialog', { name: '订单与支付状态' })
  const duplicateConfirmation = guest.getByRole('button', { name: '确认继续加单' })
  await expect(resultDialog.or(duplicateConfirmation)).toBeVisible()
  if (await duplicateConfirmation.isVisible()) await duplicateConfirmation.click()
  await expect(resultDialog).toBeVisible()
  await expect(resultDialog.getByRole('heading', { name: /支付已经完成|测试订单已建立|等待微信支付|等待扫码支付|付款状态待核对|正在准备付款/ })).toBeVisible()
  await expect(resultDialog).toContainText('付款状态每 2 秒自动核对')
  await guestContext.close()

  const orderManager = await staffPage(browser, data, 'liyan')
  await orderManager.page.getByRole('button', { name: '现场', exact: true }).first().click()
  await orderManager.page.getByRole('button', { name: /^W01 \d+人 · / }).click()
  await orderManager.page.getByRole('button', { name: '协助点单' }).click()
  const assistedOrder = orderManager.page.getByRole('dialog', { name: 'W01协助点单' })
  for (const productName of [data.orderableProductName, data.kitchenProductName]) {
    await assistedOrder.getByLabel('搜索菜单商品').fill(productName)
    await assistedOrder.getByRole('button', { name: `加入${productName}` }).click()
  }
  await assistedOrder.getByRole('button', { name: '查看已选' }).click()
  const assistedCart = assistedOrder.getByRole('dialog', { name: '购物车明细' })
  await assistedCart.getByPlaceholder('如：少冰、不要香菜、酒水和小食一起上').fill('营业日验收：酒水小食一起上')
  await assistedCart.getByPlaceholder('如：少冰、不放香菜').first().fill('草稿恢复逐行备注')
  await orderManager.page.reload()
  await orderManager.page.getByRole('button', { name: '现场', exact: true }).first().click()
  await orderManager.page.getByRole('button', { name: /^W01 \d+人 · / }).click()
  await orderManager.page.getByRole('button', { name: '协助点单' }).click()
  await assistedOrder.getByRole('button', { name: '查看已选' }).click()
  await expect(assistedCart.getByPlaceholder('如：少冰、不要香菜、酒水和小食一起上')).toHaveValue('营业日验收：酒水小食一起上')
  await expect(assistedCart.getByPlaceholder('如：少冰、不放香菜').first()).toHaveValue('草稿恢复逐行备注')
  await assistedCart.getByRole('button', { name: '核对无误，确认下单' }).click()
  await assistedOrder.getByRole('dialog', { name: '确认上单' }).getByRole('button', { name: '确认上单' }).click()
  await expect(orderManager.page.getByRole('status')).toContainText('W01 订单已挂桌并发送出品')
  await orderManager.context.close()

  const bartender = await staffPage(browser, data, 'lengyanzhi')
  await bartender.page.getByRole('button', { name: '吧台出品', exact: true }).first().click()
  const barCard = bartender.page.locator('.staff-action-card').filter({ hasText: data.orderableProductName }).first()
  await expect(barCard).toBeVisible()
  const bartenderKitchenCard = bartender.page.locator('.staff-action-card').filter({ hasText: data.kitchenProductName }).first()
  await expect(bartenderKitchenCard).toHaveCount(0)
  await expect(bartenderKitchenCard.getByRole('button', { name: '制作完成' })).toHaveCount(0)
  await expect(bartender.page.locator('.staff-action-card').filter({ hasText: '未付款订单不得出品' })).toHaveCount(0)
  await expect(barCard).toContainText('营业日验收：酒水小食一起上')
  await barCard.getByRole('button', { name: '制作完成' }).click()
  await expect(bartender.page.locator('.staff-actions-notice')).toContainText('配送岗位已收到')
  await bartender.context.close()

  const kitchen = await staffPage(browser, data, 'shenliangliang')
  await kitchen.page.getByRole('button', { name: '后厨出品', exact: true }).first().click()
  const kitchenCard = kitchen.page.locator('.staff-action-card').filter({ hasText: data.kitchenProductName }).first()
  await expect(kitchenCard).toBeVisible()
  await expect(kitchen.page.locator('.staff-action-card').filter({ hasText: data.orderableProductName })).toHaveCount(0)
  await expect(kitchen.page.locator('.staff-action-card').filter({ hasText: '未付款订单不得出品' })).toHaveCount(0)
  await expect(kitchenCard).toContainText('营业日验收：酒水小食一起上')
  await kitchenCard.getByRole('button', { name: '制作完成' }).click()
  await expect(kitchen.page.locator('.staff-actions-notice')).toContainText('配送岗位已收到')
  await kitchen.context.close()

  const server = await staffPage(browser, data, 'tom')
  await server.page.getByRole('button', { name: '取送', exact: true }).first().click()
  for (const productName of [data.orderableProductName, data.kitchenProductName]) {
    const delivery = server.page.locator('.staff-action-card').filter({ hasText: productName }).first()
    await expect(delivery).toBeVisible()
    await expect(delivery).toContainText('待配送')
    await delivery.getByRole('button', { name: '已送达' }).click()
    await expect(server.page.locator('.staff-actions-notice')).toContainText('已送达')
  }
  await server.page.getByRole('button', { name: /工作台/ }).click()
  await server.page.getByRole('button', { name: '任务', exact: true }).first().click()
  const callTask = server.page.locator('.staff-action-card').filter({ hasText: '客人正在等您' }).first()
  await expect(callTask).toBeVisible()
  for (const endpoint of [
    '**/api/staff/annual-benefit-reservations*',
    '**/api/staff/annual-daily-snack-claims*',
  ]) {
    await server.page.route(endpoint, (route) => route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'OPTIONAL_MEMBER_QUEUE_UNAVAILABLE', message: 'temporary test outage' } }),
    }))
  }
  await callTask.getByRole('button', { name: '完成' }).click()
  await expect(server.page.getByRole('status')).toContainText('已完成')
  await expect(callTask).toHaveCount(0)
  await expect(server.page.getByText(/心情.*开心|开心.*心情/)).toHaveCount(0)
  await server.context.close()

  const manager = await staffPage(browser, data, 'liyan')
  await manager.page.getByRole('button', { name: '任务', exact: true }).first().click()
  const complaintCard = manager.page.locator('.staff-action-card').filter({ hasText: '营业日验收：音乐太响' }).first()
  await expect(complaintCard).toBeVisible()
  await complaintCard.getByRole('button', { name: '记录并完成' }).click()
  await expect(manager.page.getByRole('status')).toContainText('投诉需要值班经理简要记录')
  await expect(complaintCard).toBeVisible()
  await complaintCard.getByRole('textbox').fill('已到桌沟通并调整音量，客人表示可以')
  await complaintCard.getByRole('button', { name: '记录并完成' }).click()
  await expect(manager.page.getByRole('status')).toContainText('已完成')
  await manager.context.close()

  const cashier = await staffPage(browser, data, 'sanmu')
  await cashier.page.goto('/staff/live')
  await expect(cashier.page.getByRole('heading', { name: '找到桌台，直接处理' })).toBeVisible()
  await expect(cashier.page.getByRole('alert')).toContainText('1 张桌待收款')
  const cashierTable = cashier.page.getByRole('button', { name: /^W01 \d+人 · / })
  await expect(cashierTable).toContainText(/待支付|支付确认中|支付异常/)
  await cashierTable.click()
  await cashier.page.getByRole('button', { name: '协助点单' }).click()
  const cashierAssistedOrder = cashier.page.getByRole('dialog', { name: 'W01协助点单' })
  await cashierAssistedOrder.getByLabel('搜索菜单商品').fill(data.kitchenProductName)
  await expect(cashierAssistedOrder.getByRole('button', { name: `加入${data.kitchenProductName}` })).toBeVisible()
  await cashierAssistedOrder.getByRole('button', { name: '关闭点单' }).click()
  await cashier.page.goto('/staff/payments')
  await expect(cashier.page.getByRole('heading', { name: '收银与退款' })).toBeVisible()
  await expect(cashier.page.getByLabel('本营业日售后摘要')).toContainText('2订单')
  await expect(cashier.page.getByLabel('本营业日售后摘要')).toContainText('0已收款')
  const pendingOrder = cashier.page.locator('.cashier-order').filter({ hasText: 'W01' }).first()
  await expect(pendingOrder).toBeVisible()
  await expect(pendingOrder).toContainText('未支付')
  await pendingOrder.getByRole('button').click()
  await expect(pendingOrder).toContainText('不能申请退款')
  await expect(pendingOrder.getByRole('button', { name: /申请退款/ })).toHaveCount(0)
  await cashier.context.close()
})

test('future public reservation is confirmed by marketing and kept out of today arrival queue', async ({ browser }) => {
  test.setTimeout(90_000)
  const data = await fixture()
  const customerName = '跨岗位预约验收'
  const publicContext = await browser.newContext()
  const booking = await publicContext.newPage()
  await booking.goto('/reserve')
  await expect(booking.getByTestId('reservation-booking')).toBeVisible()
  await booking.getByRole('button', { name: /下一步：位置与联系/ }).click()
  await booking.getByLabel('怎么称呼您').fill(customerName)
  await booking.getByLabel('手机或微信').fill('13800138002')
  await booking.getByRole('button', { name: /核对预约信息/ }).click()
  await booking.getByRole('button', { name: '提交预约申请' }).click()
  await expect(booking.getByRole('heading', { name: '等待门店确认' })).toBeVisible()
  await expect(booking.getByText('门店确认后才正式生效')).toBeVisible()

  const marketing = await staffPage(browser, data, 'wuya')
  await marketing.page.getByRole('button', { name: '预约', exact: true }).first().click()
  const reservationWorkspace = marketing.page.getByRole('region', { name: '预约工作台' })
  const pending = reservationWorkspace.locator('.staff-reservation-card').filter({ hasText: customerName }).first()
  await expect(pending).toBeVisible()
  await expect(pending).toContainText('待确认')
  await pending.getByRole('button', { name: '确认预约' }).click()
  await expect(marketing.page.getByRole('status')).toContainText('预约已确认')
  await marketing.context.close()

  await booking.getByRole('button', { name: '刷新确认状态' }).click()
  await expect(booking.getByRole('heading', { name: '预约已确认' })).toBeVisible()
  await expect(booking.getByText('门店已确认本次预约')).toBeVisible()
  await expect(booking.getByText(/临时锁位/)).toHaveCount(0)
  await publicContext.close()

  const greeter = await staffPage(browser, data, 'tom')
  await greeter.page.getByRole('button', { name: '预约到店', exact: true }).first().click()
  const confirmed = greeter.page.locator('.staff-reservation-card').filter({ hasText: customerName }).first()
  await expect(confirmed).toHaveCount(0)
  await greeter.context.close()
})

test('manager completes a walk-in table lifecycle without leaving the mobile operations page', async ({ browser }) => {
  test.setTimeout(90_000)
  const data = await fixture()
  const manager = await staffPage(browser, data, 'liyan')
  await manager.page.getByRole('button', { name: '现场', exact: true }).first().click()
  await expect(manager.page.getByRole('heading', { name: '找到桌台，直接处理' })).toBeVisible()
  await manager.page.getByRole('group', { name: '桌台显示范围' }).getByRole('button', { name: /^全部/ }).click()

  const source = manager.page.locator('.staff-table-tile:not(.is-open)').first()
  await expect(source).toBeVisible()
  const sourceCode = (await source.locator('strong').textContent())?.trim() ?? ''
  expect(sourceCode).not.toBe('')
  await source.click()
  await manager.page.getByLabel('实际到店人数').fill('2')
  await manager.page.getByRole('button', { name: '确认开台' }).click()
  await expect(manager.page.getByRole('status')).toContainText(`${sourceCode} 已开台，2人`)
  await expect(manager.page.locator('.staff-table-tile').filter({ hasText: sourceCode }).first()).toContainText('已开台')

  await manager.page.getByRole('button', { name: '转桌', exact: true }).click()
  const target = manager.page.locator('.staff-transfer-targets > div > button').first()
  await expect(target).toBeVisible()
  const targetCode = await target.evaluate((element) => element.childNodes[0]?.textContent?.trim() ?? '')
  expect(targetCode).not.toBe('')
  await target.click()
  await manager.page.getByRole('button', { name: '确认转桌' }).click()
  await expect(manager.page.getByRole('status')).toContainText(`${sourceCode} 已转至 ${targetCode}`)
  await expect(manager.page.locator('.staff-table-tile').filter({ hasText: targetCode }).first()).toContainText('已开台')

  await manager.page.getByRole('button', { name: '准备结台' }).click()
  await expect(manager.page.getByRole('status')).toContainText('请再次确认结台')
  await manager.page.getByRole('button', { name: '确认结台' }).click()
  await expect(manager.page.getByRole('status')).toContainText(`${targetCode} 已关台`)
  await expect(manager.page.locator('.staff-table-tile').filter({ hasText: targetCode }).first()).not.toContainText('已开台')
  await expectNoHorizontalOverflow(manager.page)
  await manager.context.close()
})

test('李艳可由授权管理页批量安排为主服务员并安全结束责任', async ({ browser }) => {
  test.setTimeout(90_000)
  const data = await fixture()
  const manager = await staffPage(browser, data, 'liyan')
  await manager.page.setViewportSize({ width: 390, height: 844 })
  await manager.page.getByRole('button', { name: '全部岗位入口', exact: true }).click()
  const allEntries = manager.page.getByRole('dialog', { name: '全部工作入口' })
  await expect(allEntries).toBeVisible()
  await allEntries.getByRole('button', { name: '现场', exact: true }).click()
  await expect(manager.page.getByRole('heading', { name: '找到桌台，直接处理' })).toBeVisible()
  await manager.page.getByRole('button', { name: /人员与责任桌/ }).click()

  await expect(manager.page.getByText(/区域批量发布使用同一事务/)).toBeVisible()
  await manager.page.getByLabel('员工').selectOption({ label: '李艳 · liyan' })
  await manager.page.getByLabel('本次岗位').selectOption({ label: '店长 · MANAGER' })
  await manager.page.getByLabel('责任类型').selectOption('primary')

  const tableCode = 'W01'
  await manager.page.getByLabel('搜索责任区域或桌台').fill(tableCode)
  const matchingTable = manager.page.locator('.staff-assignment-area label').filter({ hasText: tableCode })
  await expect(matchingTable).toHaveCount(1)
  await matchingTable.getByRole('checkbox').check()
  await manager.page.getByLabel('安排原因').fill('浏览器验收：李艳负责本桌晚班服务')
  await manager.page.getByRole('button', { name: '发布 1 张桌台' }).click()

  await expect(manager.page.getByRole('status').filter({ hasText: '李艳 已安排' })).toContainText('李艳 已安排 1 张责任桌')
  const active = manager.page.locator('.staff-assignment-active article').filter({ hasText: `${tableCode} · 李艳` })
  await expect(active).toContainText('主服务员')
  await active.getByRole('button', { name: '结束责任' }).click()
  await active.getByRole('button', { name: '再次确认结束' }).click()
  await expect(manager.page.getByRole('status').filter({ hasText: `李艳 对 ${tableCode}` })).toContainText(`李艳 对 ${tableCode} 的责任已结束`)
  await expect(active).toHaveCount(0)
  await expectNoHorizontalOverflow(manager.page)
  await manager.context.close()
})

test('店长可在经营配置中修改商品推荐字段并从服务端读回', async ({ browser }) => {
  test.setTimeout(90_000)
  const data = await fixture()
  const manager = await staffPage(browser, data, 'liyan')
  await manager.page.setViewportSize({ width: 430, height: 880 })
  await manager.page.goto('/staff/inventory')
  await expect(manager.page.getByRole('heading', { name: '库存与酒水上架' })).toBeVisible()
  await manager.page.getByRole('button', { name: /酒水上架流程/ }).click()
  await expect(manager.page.getByLabel('搜索配置商品')).toBeVisible()
  await manager.page.getByLabel('搜索配置商品').fill(data.orderableProductName)
  const product = manager.page.locator('.catalog-management-list article').filter({ hasText: data.orderableProductName }).first()
  await expect(product).toBeVisible()
  await product.getByRole('button', { name: '编辑' }).click()
  await manager.page.getByLabel('推荐优先级').fill('123')
  await manager.page.getByLabel('搜索文本').fill(`${data.orderableProductName} 浏览器验收推荐词`)
  await manager.page.getByRole('button', { name: /保存并读回验证/ }).click()
  await expect(manager.page.getByRole('status')).toContainText(`${data.orderableProductName} 已保存并从服务端读回`)

  await manager.page.getByLabel('搜索配置商品').fill(data.orderableProductName)
  await manager.page.locator('.catalog-management-list article').filter({ hasText: data.orderableProductName }).first()
    .getByRole('button', { name: '编辑' }).click()
  await expect(manager.page.getByLabel('推荐优先级')).toHaveValue('123')
  await expect(manager.page.getByLabel('搜索文本')).toHaveValue(`${data.orderableProductName} 浏览器验收推荐词`)
  await expectNoHorizontalOverflow(manager.page)
  await manager.context.close()
})

test('店长可关闭并重新开放线上支付且策略即时读回', async ({ browser }) => {
  const data = await fixture()
  const manager = await staffPage(browser, data, 'liyan')
  await manager.page.goto('/staff/settings')
  await expect(manager.page.getByText('线上支付已开放', { exact: true }).first()).toBeVisible()
  await manager.page.getByLabel('调整原因').fill('浏览器验收：临时关闭支付渠道')
  await manager.page.getByRole('button', { name: '关闭线上支付' }).click()
  const closeConfirmation = manager.page.getByRole('alertdialog', { name: '确认关闭线上支付' })
  await expect(closeConfirmation).toBeVisible()
  await closeConfirmation.getByRole('button', { name: '确认关闭' }).click()
  await expect(manager.page.getByRole('status')).toContainText('线上支付已关闭')
  await expect(manager.page.getByText('线上支付已关闭', { exact: true }).first()).toBeVisible()

  await manager.page.getByLabel('调整原因').fill('浏览器验收：恢复支付渠道')
  await manager.page.getByRole('button', { name: '开放线上支付' }).click()
  const openConfirmation = manager.page.getByRole('alertdialog', { name: '确认开放线上支付' })
  await expect(openConfirmation).toBeVisible()
  await openConfirmation.getByRole('button', { name: '确认开放' }).click()
  await expect(manager.page.getByRole('status')).toContainText('线上支付已开放')
  await expect(manager.page.getByText('线上支付已开放', { exact: true }).first()).toBeVisible()
  await expect(manager.page.getByRole('button', { name: '关闭线上支付' })).toBeEnabled()

  await manager.page.getByLabel('待付款库存保留时间').fill('9')
  await manager.page.getByLabel('调整原因').fill('浏览器验收：缩短库存保留时间')
  await manager.page.getByRole('button', { name: '保存时限' }).click()
  const reduceReservationConfirmation = manager.page.getByRole('alertdialog', { name: '确认调整待付款库存保留' })
  await expect(reduceReservationConfirmation).toBeVisible()
  await reduceReservationConfirmation.getByRole('button', { name: '确认调整' }).click()
  await expect(manager.page.getByRole('status')).toContainText('待付款库存保留时间已调整为9分钟')
  await expect(manager.page.getByLabel('待付款库存保留时间')).toHaveValue('9')
  await expect(manager.page.getByRole('button', { name: '关闭线上支付' })).toBeEnabled()

  await manager.page.getByLabel('待付款库存保留时间').fill('10')
  await manager.page.getByLabel('调整原因').fill('浏览器验收：恢复库存保留时间')
  await manager.page.getByRole('button', { name: '保存时限' }).click()
  const restoreReservationConfirmation = manager.page.getByRole('alertdialog', { name: '确认调整待付款库存保留' })
  await expect(restoreReservationConfirmation).toBeVisible()
  await restoreReservationConfirmation.getByRole('button', { name: '确认调整' }).click()
  await expect(manager.page.getByRole('status')).toContainText('待付款库存保留时间已调整为10分钟')
  await manager.context.close()
})

test('店长可在经营配置中修改桌台容量资料并读回', async ({ browser }) => {
  const data = await fixture()
  const manager = await staffPage(browser, data, 'liyan')
  await manager.page.setViewportSize({ width: 430, height: 880 })
  await manager.page.goto('/staff/settings')
  await manager.page.getByRole('button', { name: /区域、桌台与容量/ }).click()
  const table = manager.page.locator('.venue-management-list > section').nth(1).locator('article').filter({ hasText: 'W01' }).first()
  await expect(table).toBeVisible()
  await table.getByRole('button', { name: '编辑' }).click()
  await manager.page.getByLabel('显示名称').fill('W01验收桌')
  await manager.page.getByLabel('标准容量').fill('4')
  await manager.page.getByRole('button', { name: '保存桌台' }).click()
  await expect(manager.page.getByRole('status')).toContainText('W01验收桌 已保存并从服务端读回')
  await expect(manager.page.locator('.venue-management-list > section').nth(1).locator('article').filter({ hasText: 'W01验收桌' }).first()).toBeVisible()
  await expectNoHorizontalOverflow(manager.page)
  await manager.context.close()
})


test('快捷盘点提交丢失回执后复用原单，不直接改变库存', async ({ browser }) => {
  const data=await fixture(),manager=await staffPage(browser,data,'liyan'),page=manager.page
  await page.setViewportSize({width:390,height:844})
  await page.goto('/staff/inventory')
  const card=page.locator('.staff-module-list article').filter({has:page.getByRole('button',{name:'录入实盘',exact:true})}).first()
  await expect(card).toBeVisible()
  const originalCard=await card.innerText()
  await card.getByRole('button',{name:'录入实盘',exact:true}).click()
  const form=page.locator('#inventory-quick-count')
  const selected=await form.getByRole('combobox',{name:'物料',exact:true}).inputValue()
  expect(selected).not.toBe('')
  await expect(form.getByRole('textbox',{name:/实盘数量/})).toBeFocused()
  await form.getByRole('textbox',{name:/实盘数量/}).fill('12')
  let countId='',createKey='',submitKey=''
  const createKeys:string[]=[]
  page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/inventory/stock-counts'))createKeys.push(request.headers()['idempotency-key'])})
  await page.route('**/api/inventory/stock-counts/*/submit',async route=>{
    submitKey=route.request().headers()['idempotency-key'];countId=route.request().url().split('/').at(-2)!
    const result=await route.fetch();expect(result.ok()).toBe(true)
    await route.abort('failed')
  },{times:1})
  await form.getByRole('button',{name:'提交盘点复核'}).click()
  await expect(form.getByRole('button',{name:'提交盘点复核'})).toBeEnabled()
  expect(countId).not.toBe('');createKey=createKeys[0]
  const retry=page.waitForResponse(response=>response.url().endsWith(`/stock-counts/${countId}/submit`))
  await form.getByRole('button',{name:'提交盘点复核'}).click()
  const result=await retry;expect(result.status()).toBe(200);expect(result.request().headers()['idempotency-key']).toBe(submitKey)
  expect(createKeys).toEqual([createKey,createKey])
  await expect(page.getByText('盘点已提交，等待有审批权限的岗位复核',{exact:true})).toBeVisible()
  await expect(card).toHaveText(originalCard,{useInnerText:true})
  await expectNoHorizontalOverflow(page)
  await manager.context.close()
})

test('图片上传与月度排班成功回执在页面正确展示',async({browser})=>{
  test.setTimeout(90_000)
  const data=await fixture(),manager=await staffPage(browser,data,'liyan'),page=manager.page
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message))
  await page.goto('/staff/customer-experience')
  const activity=page.getByRole('region',{name:'活动报名运营工作台'})
  await expect(activity).toBeVisible()
  await activity.getByRole('button',{name:'打开工作台'}).click()
  await activity.getByRole('button',{name:'新建活动草稿'}).click()
  const picker=activity.locator('.media-asset-picker').first()
  await picker.getByRole('button',{name:/上传/}).click()
  await expect(picker.locator('input[type=file]')).toBeEnabled()
  const upload=page.waitForResponse(response=>response.url().endsWith('/api/staff/media-assets')&&response.request().method()==='POST')
  await picker.locator('input[type=file]').setInputFiles({name:'isolated-receipt-check.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1kAAAAASUVORK5CYII=','base64')})
  const uploaded=await upload;expect(uploaded.ok(),await uploaded.text()).toBe(true)
  await expect(picker.getByText('图片已上传并选中；保存当前内容后才会正式绑定。',{exact:true})).toBeVisible()
  await expect(picker.getByAltText('已选图片预览')).toBeVisible()
  await page.goto('/staff/performance')
  const monthly=page.locator('.monthly-schedule-panel')
  await monthly.locator(':scope > summary').click()
  await monthly.getByLabel('月份',{exact:true}).fill('2026-11')
  await monthly.getByRole('button',{name:'按规则生成整月草稿'}).click()
  const preview=page.waitForResponse(response=>response.url().endsWith('/schedules/monthly/preview'))
  await monthly.getByRole('button',{name:'预览冲突与发布范围'}).click()
  expect((await preview).ok()).toBe(true)
  await expect(monthly.getByText('共 30 场；0 场已有相同排班，不重复生成。',{exact:true})).toBeVisible()
  const publish=page.waitForResponse(response=>response.url().endsWith('/schedules/monthly/publish'))
  await monthly.getByRole('button',{name:'发布已预览的场次'}).click()
  expect((await publish).ok()).toBe(true)
  await expect(monthly.getByText('已发布 30 场，0 场已存在并保留。',{exact:true})).toBeVisible()
  await expect(monthly.locator(':scope > article')).toHaveCount(30)
  expect(errors).toEqual([])
  await manager.context.close()
})

test('出品页面六十项待制作全部可达，取送单独展示且末项可搜索',async({browser})=>{
  const data=await fixture(),manager=await staffPage(browser,data,'liyan'),page=manager.page
  await page.setViewportSize({width:390,height:844})
  // Read-model-only stress fixture. Server scope and transitions are tested separately;
  // these synthetic task IDs are never submitted to a production/action endpoint.
  await page.route('**/api/commerce/fulfillment',async route=>{
    const actual=await route.fetch();expect(actual.ok()).toBe(true)
    const body=await actual.json(),now=new Date().toISOString()
    body.data.workItems=Array.from({length:70},(_,index)=>({
      taskId:crypto.randomUUID(),businessDate:now.slice(0,10),carryover:false,stationCode:'bar',
      kdsStatus:index<60?'pending':'ready',priority:100,overdue:false,readyForDelivery:index>=60,
      canPrepare:index<60,canDeliver:index>=60,canRemake:false,dueAt:null,nextActionAt:now,createdAt:now,
      item:{productName:`隔离队列${String(index+1).padStart(2,'0')}`,quantity:1,note:null},
      order:{publicId:`QUEUE-${index}`,note:null},table:{id:crypto.randomUUID(),code:`Q${index+1}`,assignmentType:'primary'},attentionMessages:[],
    }))
    await route.fulfill({response:actual,json:body})
  })
  await page.goto('/staff/fulfillment')
  await expect(page.getByRole('button',{name:'待制作（60）',exact:true})).toBeVisible()
  const cards=page.locator('.staff-action-card[data-action-fact-id]')
  await expect(cards).toHaveCount(24)
  await page.getByRole('button',{name:'再显示24项（还有36项）'}).click()
  await expect(cards).toHaveCount(48)
  await page.getByRole('button',{name:'再显示24项（还有12项）'}).click()
  await expect(cards).toHaveCount(60)
  await page.getByRole('textbox',{name:'按桌号或品名查找出品'}).fill('隔离队列60')
  await expect(cards).toHaveCount(1);await expect(cards).toContainText('隔离队列60')
  await page.getByRole('textbox',{name:'按桌号或品名查找出品'}).fill('')
  await page.getByRole('button',{name:'待取送（10）',exact:true}).click()
  await expect(cards).toHaveCount(10)
  await expect(cards.first()).toContainText('隔离队列61')
  await expectNoHorizontalOverflow(page)
  await manager.context.close()
})


for(const pauseNew of (process.env.NORMALIZED_E2E_RECOVERY_PEER==='true'?[true]:[false])) test(`数量制作按实际份数配送，${pauseNew?'停用新增后':'刷新后'}恢复原操作不重复完成余量`,async({browser},testInfo)=>{
  test.setTimeout(120_000)
  const data=await fixture(),note=`数量联验-${Date.now()}`
  const manager=await staffPage(browser,data,'liyan')
  await manager.page.getByRole('button',{name:'现场',exact:true}).first().click()
  await manager.page.getByRole('button',{name:/^W01 \d+人 · /}).click()
  await manager.page.getByRole('button',{name:'协助点单'}).click()
  const dialog=manager.page.getByRole('dialog',{name:'W01协助点单'})
  await dialog.getByLabel('搜索菜单商品').fill(data.orderableProductName)
  await dialog.getByRole('button',{name:`加入${data.orderableProductName}`}).click()
  for(let n=0;n<2;n++)await dialog.getByRole('button',{name:`增加${data.orderableProductName}`}).click()
  await dialog.getByRole('button',{name:'查看已选'}).click()
  const cart=dialog.getByRole('dialog',{name:'购物车明细'})
  await cart.getByPlaceholder('如：少冰、不要香菜、酒水和小食一起上').fill(note)
  await cart.getByRole('button',{name:'核对无误，确认下单'}).click()
  const submitted=manager.page.waitForResponse(response=>response.url().endsWith('/api/commerce/orders')&&response.request().method()==='POST')
  await dialog.getByRole('dialog',{name:'确认上单'}).getByRole('button',{name:'确认上单'}).click()
  const submittedResponse=await submitted;expect(submittedResponse.ok(),await submittedResponse.text()).toBe(true)
  await expect(dialog).toHaveCount(0)
  await manager.context.close()
  const bartender=await staffPage(browser,data,'lengyanzhi')
  let paused=false
  const backendUrl=(url:string)=>{const parsed=new URL(url);return paused?`${data.recoveryBaseUrl}${parsed.pathname}${parsed.search}`:url}
  if(pauseNew){expect(data.recoveryBaseUrl).toBeTruthy();await bartender.page.route('**/api/**',async route=>{const response=await route.fetch({url:backendUrl(route.request().url())});await route.fulfill({response})})}
  await bartender.page.setViewportSize({width:390,height:844})
  await bartender.page.getByRole('button',{name:'吧台出品',exact:true}).first().click()
  const card=bartender.page.locator('.staff-action-card').filter({hasText:note}).first()
  await expect(card).toBeVisible();await expect(card).toContainText('× 3')
  await card.getByRole('spinbutton').fill('2')
  const sent:Array<{key:string;body:unknown}>=[];let drop=true,probeNew=pauseNew
  let finishFirst:()=>void=()=>{}
  const firstRequestFinished=new Promise<void>(resolve=>{finishFirst=resolve})
  await bartender.page.route('**/api/commerce/kds/*/actions',async route=>{
    const loseResponse=drop;drop=false
    sent.push({key:route.request().headers()['idempotency-key'],body:route.request().postDataJSON()})
    if(probeNew){
      probeNew=false
      const parsed=new URL(route.request().url()),refused=await route.fetch({url:`${data.recoveryBaseUrl}${parsed.pathname}`})
      expect(refused.status()).toBe(409);expect((await refused.json()).error.code).toBe('QUANTITY_BATCH_NOT_ENABLED')
    }
    const response=await route.fetch({url:backendUrl(route.request().url())})
    if(loseResponse){expect(response.ok()).toBe(true);paused=pauseNew;await route.abort('failed');finishFirst()}else await route.fulfill({response})
  })
  await card.getByRole('button',{name:'制作完成',exact:true}).click()
  // Pending recovery is visible as soon as the original command is stored.
  // Wait for the injected lost response, rather than reloading during the probe.
  await firstRequestFinished
  await expect(bartender.page.getByRole('button',{name:'恢复上次结果'})).toBeVisible()
  await bartender.page.reload()
  await expect(bartender.page.getByRole('button',{name:'恢复上次结果'})).toBeVisible()
  await bartender.page.getByRole('button',{name:'恢复上次结果'}).click()
  await expect(bartender.page.getByText('原制作/送达操作结果已恢复')).toBeVisible()
  await expect(card).toContainText('待制作 1 · 已备齐 2')
  expect(sent).toHaveLength(2);expect(sent[1]).toEqual(sent[0])
  await expectNoHorizontalOverflow(bartender.page)
  await bartender.page.screenshot({path:testInfo.outputPath('quantity-recovered-390.png'),fullPage:true})
  const server=await staffPage(browser,data,'tom')
  if(paused)await server.page.route('**/api/**',async route=>{const response=await route.fetch({url:backendUrl(route.request().url())});await route.fulfill({response})})
  await server.page.getByRole('button',{name:'取送',exact:true}).first().click()
  const delivery=server.page.locator('.staff-action-card').filter({hasText:note}).first()
  await expect(delivery).toContainText('已备齐 2')
  await delivery.getByRole('button',{name:'本次已送达'}).click()
  await expect(delivery).toHaveCount(0)
  await bartender.page.reload()
  await expect(card).toContainText('待制作 1 · 已备齐 0')
  await card.getByRole('button',{name:'制作完成',exact:true}).click()
  await expect(card).toHaveCount(0)
  await server.page.reload()
  await expect(delivery).toContainText('已备齐 1')
  await delivery.getByRole('button',{name:'本次已送达'}).click()
  await expect(delivery).toHaveCount(0)
  await bartender.context.close();await server.context.close()
})

for(const paid of [false,true])test(`套餐停止一份按原单点价重算，其余份数照常制作（${paid?'已付一次审核':'未付直接停止'}）`,async({browser},testInfo)=>{
  test.setTimeout(120_000)
  const data=await fixture(),manager=await staffPage(browser,data,'liyan'),note=`套餐暂停-${Date.now()}`
  await manager.page.setViewportSize({width:390,height:844})
  await manager.page.getByRole('button',{name:'现场',exact:true}).first().click()
  await manager.page.getByRole('button',{name:/^W01 \d+人 · /}).click()
  await manager.page.getByRole('button',{name:'协助点单'}).click()
  const order=manager.page.getByRole('dialog',{name:'W01协助点单'})
  await order.getByLabel('搜索菜单商品').fill(data.bundleProductName)
  await order.getByRole('button',{name:`加入${data.bundleProductName}`}).click()
  await order.getByRole('dialog',{name:`${data.bundleProductName}商品详情`}).getByRole('button',{name:'加入购物车'}).click()
  await order.getByRole('button',{name:'查看已选'}).click()
  const cart=order.getByRole('dialog',{name:'购物车明细'})
  await cart.getByPlaceholder('如：少冰、不要香菜、酒水和小食一起上').fill(note)
  await cart.getByRole('button',{name:'核对无误，确认下单'}).click()
  const orderResponse=manager.page.waitForResponse(response=>response.url().endsWith('/api/commerce/orders')&&response.request().method()==='POST')
  await order.getByRole('dialog',{name:'确认上单'}).getByRole('button',{name:'确认上单'}).click()
  const originalOrder=await (await orderResponse).json()
  if(paid){
    const collected=await manager.page.request.post('/api/payments/manual',{headers:{'idempotency-key':`qa-bundle-cash-${Date.now()}`},data:{orderId:originalOrder.id,provider:'cash',method:'cash',receiptReference:''}})
    expect(collected.ok(),await collected.text()).toBe(true)
  }
  await expect(order).toHaveCount(0)
  const details=manager.page.getByRole('region',{name:'W01本桌点单详情'})
  const child=details.locator('.staff-table-order-status-item').filter({hasText:'吧台'}).filter({has:manager.page.getByRole('button',{name:'处理套餐内商品'})}).first()
  const loaded=manager.page.waitForResponse(response=>response.url().includes('/api/commerce/item-after-sales/items/')&&response.request().method()==='GET')
  await child.getByRole('button',{name:'处理套餐内商品'}).click()
  const original=(await (await loaded).json()).data.item as {name:string;quantity:number}
  expect(original.quantity).toBeGreaterThanOrEqual(2)
  const panel=manager.page.getByRole('dialog',{name:'商品停止与退款'})
  await expect(panel).toContainText('计费包含在原套餐内，不另收费')
  await panel.getByLabel('本次停止份数').fill('1')
  const requested=manager.page.waitForResponse(response=>response.url().endsWith('/item-after-sales/requests')&&response.request().method()==='POST')
  await panel.getByRole('button',{name:'停止所选套餐商品'}).click()
  const facts=(await (await requested).json()).data
  if(paid){
    await expect(panel).toContainText('暂停 1 · 已停止 0 份')
    await expect(panel.getByRole('button',{name:/^批准/})).toHaveCount(0)
    const reviewer=await staffPage(browser,data,'sanmu');await reviewer.page.goto('/staff/payments')
    const pending=reviewer.page.getByRole('region',{name:'商品售后待办'})
    await pending.locator('article').filter({hasText:originalOrder.publicId.slice(-8)}).getByRole('button',{name:'处理商品'}).first().click()
    const review=reviewer.page.getByRole('dialog',{name:'商品停止与退款'})
    await expect(review).toContainText('套餐已按保留商品的下单时单点原价重算')
    await review.getByRole('button',{name:`批准 ¥${(facts.amountMinor/100).toFixed(2)}`}).click()
    await expect(review).toContainText('暂停 0 · 已停止 1 份')
    await expect(review.getByRole('button',{name:/^批准/})).toHaveCount(0)
    await reviewer.context.close()
    await panel.getByRole('button',{name:'刷新商品状态'}).click()
  }
  await expect(panel).toContainText('暂停 0 · 已停止 1 份')
  await expect(panel).toContainText('按下单时单点原价重算')
  await expect(panel).toContainText('本次退款')
  await expect(panel.getByRole('button',{name:/^批准/})).toHaveCount(0)
  await expectNoHorizontalOverflow(manager.page)
  await manager.page.screenshot({path:testInfo.outputPath(`bundle-component-repriced-${paid?'paid':'unpaid'}-390.png`),fullPage:true})
  const bartender=await staffPage(browser,data,'lengyanzhi')
  await bartender.page.getByRole('button',{name:'吧台出品',exact:true}).first().click()
  const task=bartender.page.locator('.staff-action-card').filter({hasText:note}).filter({hasText:original.name}).first()
  await expect(task).toContainText('已停止 1')
  await task.getByRole('spinbutton').fill(String(original.quantity-1))
  await task.getByRole('button',{name:'制作完成',exact:true}).click()
  await expect(task).toHaveCount(0)
  await panel.getByRole('button',{name:'刷新商品状态'}).click()
  await expect(panel).toContainText('已停止 1 份')
  await expect(panel.getByRole('button',{name:'撤回申请'})).toHaveCount(0)
  await manager.context.close();await bartender.context.close()
})

for(const staffCode of ['liyan','tom']) test(`商品售后入口停止部分未付数量并在响应丢失后恢复原申请（${staffCode}）`,async({browser},testInfo)=>{
  test.setTimeout(120_000)
  const data=await fixture(),manager=await staffPage(browser,data,staffCode)
  if(staffCode==='tom'){
    const permissions=await manager.page.evaluate(async()=>((await (await fetch('/api/auth/session')).json()).data.permissions as string[]))
    expect(permissions).toContain('refund.request');expect(permissions).not.toContain('order.cancel_unpaid')
    // Real service accounts see their assigned tables; set up that responsibility
    // through the existing manager workflow without granting additional permissions.
    const scheduler=await staffPage(browser,data,'liyan')
    await scheduler.page.getByRole('button',{name:'现场',exact:true}).first().click()
    await scheduler.page.getByRole('button',{name:/人员与责任桌/}).click()
    await scheduler.page.getByLabel('员工').selectOption({label:'Tom · tom'})
    await scheduler.page.getByLabel('本次岗位').selectOption({label:'服务员 · SERVER'})
    await scheduler.page.getByLabel('责任类型').selectOption('backup')
    await scheduler.page.getByLabel('搜索责任区域或桌台').fill('W01')
    await scheduler.page.locator('.staff-assignment-area label').filter({hasText:'W01'}).getByRole('checkbox').check()
    await scheduler.page.getByLabel('安排原因').fill('隔离验证普通服务员停止本人责任桌未付款商品')
    await scheduler.page.getByRole('button',{name:'发布 1 张桌台'}).click()
    await expect(scheduler.page.getByRole('status').filter({hasText:'Tom 已安排'})).toContainText('Tom 已安排 1 张责任桌')
    await scheduler.context.close()
    await manager.page.reload()
  }
  await manager.page.setViewportSize({width:390,height:844})
  await manager.page.getByRole('button',{name:'现场',exact:true}).first().click()
  await manager.page.getByRole('button',{name:/^W01 \d+人 · /}).click()
  const initialDetails=manager.page.getByRole('region',{name:'W01本桌点单详情'})
  await expect(initialDetails).toContainText(/未上 \d+ 份|本桌暂时没有已提交的商品/)
  const initialUndelivered=Number((await initialDetails.innerText()).match(/未上 (\d+) 份/)?.[1]??0)
  await manager.page.getByRole('button',{name:'协助点单'}).click()
  const order=manager.page.getByRole('dialog',{name:'W01协助点单'})
  await order.getByLabel('搜索菜单商品').fill(data.orderableProductName)
  await order.getByRole('button',{name:`加入${data.orderableProductName}`}).click()
  for(let n=0;n<2;n++)await order.getByRole('button',{name:`增加${data.orderableProductName}`}).click()
  await order.getByRole('button',{name:'查看已选'}).click()
  await order.getByRole('dialog',{name:'购物车明细'}).getByRole('button',{name:'核对无误，确认下单'}).click()
  await order.getByRole('dialog',{name:'确认上单'}).getByRole('button',{name:'确认上单'}).click()
  await expect(order).toHaveCount(0)
  const details=manager.page.getByRole('region',{name:'W01本桌点单详情'})
  await details.getByRole('button',{name:'停止 / 退款'}).first().click()
  const workspace=manager.page.getByRole('dialog',{name:'商品停止与退款'})
  await expect(workspace).toContainText('原订单 3 份')
  await workspace.getByLabel('本次停止份数').fill('2')
  let drop=true;const sent:Array<{key:string;body:unknown}>=[]
  await manager.page.route('**/api/commerce/item-after-sales/requests',async route=>{
    sent.push({key:route.request().headers()['idempotency-key'],body:route.request().postDataJSON()})
    const response=await route.fetch();expect(response.ok()).toBe(true)
    if(drop){drop=false;await route.abort('failed')}else await route.fulfill({response})
  })
  await workspace.getByRole('button',{name:'停止 / 申请退款'}).click()
  await expect(workspace.getByRole('button',{name:'恢复上次商品处理'})).toBeVisible()
  await workspace.getByRole('button',{name:'关闭商品处理'}).click()
  await details.getByRole('button',{name:'停止 / 退款'}).first().click()
  await workspace.getByRole('button',{name:'恢复上次商品处理'}).click()
  await expect(workspace).toContainText('2 份 · 已完成')
  await expect(workspace).toContainText('暂停 0 · 已停止 2 份')
  await expect(workspace.getByRole('button',{name:'恢复上次商品处理'})).toHaveCount(0)
  expect(sent).toHaveLength(2);expect(sent[1]).toEqual(sent[0])
  const stationNotice=workspace.getByRole('region',{name:'岗位通知待确认'})
  await expect(stationNotice).toContainText('出纸不代表岗位已看到')
  let dropAcknowledgement=true
  let dropReadAfterAcknowledgement=false
  const acknowledgements:Array<{key:string;body:unknown}>=[]
  await manager.page.route('**/api/commerce/item-after-sales/items/*',async route=>{
    if(dropReadAfterAcknowledgement){dropReadAfterAcknowledgement=false;await route.abort('failed')}else await route.continue()
  })
  await manager.page.route('**/api/commerce/item-after-sales/*/notice-ack',async route=>{
    acknowledgements.push({key:route.request().headers()['idempotency-key'],body:route.request().postDataJSON()})
    const response=await route.fetch();expect(response.ok()).toBe(true)
    if(dropAcknowledgement){dropAcknowledgement=false;await route.abort('failed')}else {dropReadAfterAcknowledgement=true;await route.fulfill({response})}
  })
  await stationNotice.getByRole('button',{name:'已联系所示岗位，确认知悉'}).click()
  await expect(workspace.getByRole('button',{name:'恢复上次商品处理'})).toBeVisible()
  await workspace.getByRole('button',{name:'恢复上次商品处理'}).click()
  await expect(workspace).toContainText('操作已经成功，最新商品状态暂未读回')
  await expect(workspace.getByRole('button',{name:'停止 / 申请退款'})).toBeDisabled()
  await expect(workspace.getByRole('button',{name:'恢复上次商品处理'})).toHaveCount(0)
  await workspace.getByRole('button',{name:'刷新商品状态'}).click()
  await expect(stationNotice).toHaveCount(0)
  expect(acknowledgements).toHaveLength(2);expect(acknowledgements[1]).toEqual(acknowledgements[0])
  await expectNoHorizontalOverflow(manager.page)
  await manager.page.screenshot({path:testInfo.outputPath('item-after-sales-unpaid-390.png'),fullPage:true})
  await workspace.getByRole('button',{name:'关闭商品处理'}).click()
  await expect(details).toContainText('停止 2')
  await expect(details).toContainText(`未上 ${initialUndelivered+1} 份`)
  await expect(details).toContainText('退菜减额')
  await manager.context.close()
})

for(const pauseNew of (process.env.NORMALIZED_E2E_RECOVERY_PEER==='true'?[true]:[false])) for(const closeBeforeReview of [false,true]) test(`已付商品${closeBeforeReview?'关桌后':'在桌时'}${pauseNew?'停用新增后':''}一次审核并确认现金实退，丢失回执不重复登记`,async({browser},testInfo)=>{
  test.setTimeout(120_000)
  const data=await fixture(),manager=await staffPage(browser,data,'liyan')
  await manager.page.getByRole('button',{name:'现场',exact:true}).first().click()
  await manager.page.getByRole('group',{name:'桌台显示范围'}).getByRole('button',{name:/^全部/}).click()
  const free=manager.page.locator('.staff-table-tile:not(.is-open)').first()
  await expect(free).toBeVisible()
  const tableCode=(await free.locator('strong').innerText()).trim()
  await free.click()
  await manager.page.getByLabel('实际到店人数').fill('2')
  await manager.page.getByRole('button',{name:'确认开台'}).click()
  await expect(manager.page.getByRole('status')).toContainText(`${tableCode} 已开台，2人`)
  await manager.page.getByRole('button',{name:'协助点单'}).click()
  const order=manager.page.getByRole('dialog',{name:`${tableCode}协助点单`})
  await order.getByLabel('搜索菜单商品').fill(data.orderableProductName)
  await order.getByRole('button',{name:`加入${data.orderableProductName}`}).click()
  await order.getByRole('button',{name:`增加${data.orderableProductName}`}).click()
  await order.getByRole('button',{name:'查看已选'}).click()
  await order.getByRole('dialog',{name:'购物车明细'}).getByRole('button',{name:'核对无误，确认下单'}).click()
  const created=manager.page.waitForResponse(response=>response.url().endsWith('/api/commerce/orders')&&response.request().method()==='POST')
  await order.getByRole('dialog',{name:'确认上单'}).getByRole('button',{name:'确认上单'}).click()
  const originalOrder=await (await created).json(),orderId=originalOrder.id
  // Isolated database cash fixture; no real till, provider or print worker.
  const collected=await manager.page.request.post('/api/payments/manual',{headers:{'idempotency-key':`qa-quantity-cash-${Date.now()}`},data:{orderId,provider:'cash',method:'cash',receiptReference:''}})
  expect(collected.ok(),await collected.text()).toBe(true)
  await expect(order).toHaveCount(0)
  const reviewer=await staffPage(browser,data,'sanmu')
  await reviewer.page.setViewportSize({width:390,height:844})
  await reviewer.page.goto('/staff/payments')
  const pending=reviewer.page.getByRole('region',{name:'商品售后待办'})
  await expect(pending.locator('article').filter({hasText:`${tableCode} ·`})).toHaveCount(0)
  // Cash fixture completion may return to the floor; explicitly enter this
  // order's table before testing the refund and lost-receipt recovery flow.
  const details=manager.page.getByRole('region',{name:`${tableCode}本桌点单详情`})
  if(!await details.isVisible())await manager.page.locator('.staff-table-tile').filter({has:manager.page.getByText(tableCode,{exact:true})}).click()
  await details.getByRole('button',{name:'停止 / 退款'}).first().click()
  const request=manager.page.getByRole('dialog',{name:'商品停止与退款'})
  const requestResponse=manager.page.waitForResponse(response=>response.url().endsWith('/item-after-sales/requests')&&response.request().method()==='POST')
  await request.getByRole('button',{name:'停止 / 申请退款'}).click()
  const originalRequest=await requestResponse
  await expect(request).toContainText('暂停 1 · 已停止 0')
  await expect(request.getByRole('button',{name:/^批准 ¥/})).toHaveCount(0)
  if(closeBeforeReview){
    expect(typeof originalOrder.tableSessionId).toBe('string')
    const closed=await manager.page.request.post(`/api/table-sessions/${originalOrder.tableSessionId}/close-after-customer-left`,{headers:{'idempotency-key':`qa-quantity-close-${Date.now()}`},data:{reasonNote:'隔离验收客人离店，保留原退款继续处理'}})
    expect(closed.ok(),await closed.text()).toBe(true)
  }
  if(pauseNew){
    expect(data.recoveryBaseUrl).toBeTruthy()
    const originalPayload=originalRequest.request().postDataJSON(),originalKey=originalRequest.request().headers()['idempotency-key']
    const recovered=await manager.page.request.post(`${data.recoveryBaseUrl}/api/commerce/item-after-sales/requests`,{headers:{'idempotency-key':originalKey},data:originalPayload})
    expect(recovered.ok(),await recovered.text()).toBe(true);expect((await recovered.json()).replayed).toBe(true)
    const denied=await manager.page.request.post(`${data.recoveryBaseUrl}/api/commerce/item-after-sales/requests`,{headers:{'idempotency-key':`qa-paused-new-${Date.now()}`},data:originalPayload})
    expect(denied.status()).toBe(409);expect((await denied.json()).error.code).toBe('QUANTITY_BATCH_NOT_ENABLED')
    if(!closeBeforeReview){
      await manager.page.route('**/api/**',async route=>{const parsed=new URL(route.request().url()),response=await route.fetch({url:`${data.recoveryBaseUrl}${parsed.pathname}${parsed.search}`});await route.fulfill({response})})
      await request.getByRole('button',{name:'停止 / 申请退款'}).click()
      await expect(request.getByRole('alert')).toContainText('暂不新增单品售后')
      await expect(request.getByRole('button',{name:'停止 / 申请退款'})).toHaveCount(0)
      await expect(request.getByRole('button',{name:'恢复上次商品处理'})).toHaveCount(0)
    }
    await reviewer.page.route('**/api/**',async route=>{const parsed=new URL(route.request().url()),response=await route.fetch({url:`${data.recoveryBaseUrl}${parsed.pathname}${parsed.search}`});await route.fulfill({response})})
    await reviewer.page.reload()
  }
  const backendUrl=(url:string)=>{const parsed=new URL(url);return pauseNew?`${data.recoveryBaseUrl}${parsed.pathname}${parsed.search}`:url}
  await manager.context.close()
  // The already-open cashier page must discover this new case without reload.
  await pending.locator('article').filter({hasText:`${tableCode} ·`}).getByRole('button',{name:'处理商品'}).first().click()
  const workspace=reviewer.page.getByRole('dialog',{name:'商品停止与退款'})
  const approvedResponse=reviewer.page.waitForResponse(response=>response.url().includes('/api/commerce/item-after-sales/')&&response.url().endsWith('/decision')&&response.request().method()==='POST')
  await workspace.getByRole('button',{name:`批准 ¥${(data.orderableProductUnitPriceMinor / 100).toFixed(2)}`}).click()
  const approvedFacts=(await (await approvedResponse).json()).data
  await expect(workspace).toContainText('待确认现金实际退付')
  await expect(workspace).toContainText('暂停 0 · 已停止 1')
  const failedRefund=approvedFacts.refunds[0].id
  const beginFailed=await reviewer.page.request.post(`/api/refunds/${failedRefund}/execute`,{headers:{'idempotency-key':`qa-failed-cash-begin-${Date.now()}`},data:{}})
  expect(beginFailed.ok(),await beginFailed.text()).toBe(true)
  const failedResult=await reviewer.page.request.post(`/api/refunds/${failedRefund}/manual-result`,{headers:{'idempotency-key':`qa-failed-cash-result-${Date.now()}`},data:{succeeded:false}})
  expect(failedResult.ok(),await failedResult.text()).toBe(true)
  // Background completion becomes visible without closing or reloading the page.
  await expect(workspace.getByRole('button',{name:`重试已确认失败的现金退款 ¥${(data.orderableProductUnitPriceMinor / 100).toFixed(2)}`})).toBeVisible()
  const retryCalls:Array<{key:string;body:unknown}>=[];let loseRetry=true
  await reviewer.page.route('**/api/commerce/item-after-sales/*/refund-retry',async route=>{
    retryCalls.push({key:route.request().headers()['idempotency-key'],body:route.request().postDataJSON()})
    const response=await route.fetch({url:backendUrl(route.request().url())});expect(response.ok(),await response.text()).toBe(true)
    if(loseRetry){loseRetry=false;await route.abort('failed')}else await route.fulfill({response})
  })
  await workspace.getByRole('button',{name:`重试已确认失败的现金退款 ¥${(data.orderableProductUnitPriceMinor / 100).toFixed(2)}`}).click()
  await expect(workspace.getByRole('button',{name:'恢复上次商品处理'})).toBeVisible()
  await workspace.getByRole('button',{name:'恢复上次商品处理'}).click()
  await expect(workspace.getByRole('button',{name:/^批准 ¥/})).toHaveCount(0)
  expect(retryCalls).toHaveLength(2);expect(retryCalls[1]).toEqual(retryCalls[0])
  await workspace.getByRole('checkbox',{name:`现金 ¥${(data.orderableProductUnitPriceMinor / 100).toFixed(2)} 已实际退给客人`}).check()
  const sent:Array<{url:string;key:string;body:unknown}>=[];let drop=true
  await reviewer.page.route('**/api/refunds/*/manual-result',async route=>{
    sent.push({url:route.request().url(),key:route.request().headers()['idempotency-key'],body:route.request().postDataJSON()})
    const response=await route.fetch({url:backendUrl(route.request().url())});expect(response.ok(),await response.text()).toBe(true)
    if(drop){drop=false;await route.abort('failed')}else await route.fulfill({response})
  })
  await workspace.getByRole('button',{name:'登记现金已退'}).click()
  await expect(workspace.getByRole('button',{name:'恢复上次商品处理'})).toBeVisible()
  await workspace.getByRole('button',{name:'恢复上次商品处理'}).click()
  await expect(workspace).toContainText('1 份 · 已完成')
  await expect(workspace.getByRole('button',{name:'登记现金已退'})).toHaveCount(0)
  expect(sent).toHaveLength(2);expect(sent[1]).toEqual(sent[0])
  await expectNoHorizontalOverflow(reviewer.page)
  await reviewer.page.screenshot({path:testInfo.outputPath('item-after-sales-paid-390.png'),fullPage:true})
  await reviewer.context.close()
})

test('修改退款份数丢回执后恢复同一新版本，减少份数明确继续且只审核新申请',async({browser},testInfo)=>{
  test.setTimeout(120_000)
  const data=await fixture(),manager=await staffPage(browser,data,'liyan')
  await manager.page.setViewportSize({width:390,height:844})
  await manager.page.getByRole('button',{name:'现场',exact:true}).first().click()
  await manager.page.getByRole('group',{name:'桌台显示范围'}).getByRole('button',{name:/^全部/}).click()
  const free=manager.page.locator('.staff-table-tile:not(.is-open)').first()
  const tableCode=(await free.locator('strong').innerText()).trim()
  await free.click();await manager.page.getByLabel('实际到店人数').fill('2')
  await manager.page.getByRole('button',{name:'确认开台'}).click()
  await expect(manager.page.getByRole('status')).toContainText(`${tableCode} 已开台，2人`)
  await manager.page.getByRole('button',{name:'协助点单'}).click()
  const order=manager.page.getByRole('dialog',{name:`${tableCode}协助点单`})
  await order.getByLabel('搜索菜单商品').fill(data.orderableProductName)
  await order.getByRole('button',{name:`加入${data.orderableProductName}`}).click()
  for(let n=0;n<2;n++)await order.getByRole('button',{name:`增加${data.orderableProductName}`}).click()
  await order.getByRole('button',{name:'查看已选'}).click()
  await order.getByRole('dialog',{name:'购物车明细'}).getByRole('button',{name:'核对无误，确认下单'}).click()
  const submitted=manager.page.waitForResponse(response=>response.url().endsWith('/api/commerce/orders')&&response.request().method()==='POST')
  await order.getByRole('dialog',{name:'确认上单'}).getByRole('button',{name:'确认上单'}).click()
  const source=await (await submitted).json()
  const collected=await manager.page.request.post('/api/payments/manual',{headers:{'idempotency-key':`qa-revision-cash-${Date.now()}`},data:{orderId:source.id,provider:'cash',method:'cash',receiptReference:''}})
  expect(collected.ok(),await collected.text()).toBe(true)
  await expect(order).toHaveCount(0)
  const details=manager.page.getByRole('region',{name:`${tableCode}本桌点单详情`})
  if(!await details.isVisible())await manager.page.locator('.staff-table-tile').filter({has:manager.page.getByText(tableCode,{exact:true})}).click()
  await expect(details).toBeVisible()
  await details.getByRole('button',{name:'停止 / 退款'}).first().click()
  const panel=manager.page.getByRole('dialog',{name:'商品停止与退款'})
  await panel.getByLabel('本次停止份数').fill('2')
  await panel.getByRole('button',{name:'停止 / 申请退款'}).click()
  await expect(panel).toContainText('暂停 2 · 已停止 0')
  await panel.getByRole('button',{name:'修改申请',exact:true}).click()
  await panel.getByLabel('修改后份数').fill('1')
  await panel.getByLabel('修改原因').fill('客人确认只退一瓶，另一瓶保留')
  let lose=true,revisedCaseId='',finishFirst:()=>void=()=>{}
  const firstFinished=new Promise<void>(resolve=>{finishFirst=resolve}),sent:Array<{key:string;body:unknown}>=[]
  await manager.page.route('**/api/commerce/item-after-sales/*/revision',async route=>{
    sent.push({key:route.request().headers()['idempotency-key'],body:route.request().postDataJSON()})
    const response=await route.fetch();expect(response.ok(),await response.text()).toBe(true)
    revisedCaseId=(await response.json()).data.caseId
    expect(revisedCaseId).toBeTruthy()
    if(lose){lose=false;await route.abort('failed');finishFirst()}else await route.fulfill({response})
  })
  await panel.getByRole('button',{name:'保存修改，重新申请'}).click()
  await firstFinished
  await expect(panel.getByRole('button',{name:'恢复上次商品处理'})).toBeVisible()
  await panel.getByRole('button',{name:'关闭商品处理'}).click()
  await details.getByRole('button',{name:'停止 / 退款'}).first().click()
  await panel.getByRole('button',{name:'恢复上次商品处理'}).click()
  await expect(panel.locator('article')).toHaveCount(2)
  const old=panel.locator('article').filter({hasText:'已修改，原记录保留'}),replacement=panel.locator('article').filter({hasText:'修改后的申请'})
  await expect(old).toContainText('另有 1 份仍暂停')
  await expect(replacement).toContainText('暂停 1 · 已停止 0')
  expect(sent).toHaveLength(2);expect(sent[1]).toEqual(sent[0])
  await old.getByRole('button',{name:'确认继续原商品'}).click()
  await expect(old).toContainText('暂停 0 · 已停止 0')
  await expect(replacement).toContainText('暂停 1 · 已停止 0')
  await expectNoHorizontalOverflow(manager.page)
  await manager.page.screenshot({path:testInfo.outputPath('case-revision-recovered-390.png'),fullPage:true})
  await manager.context.close()
  const reviewer=await staffPage(browser,data,'sanmu')
  await reviewer.page.goto('/staff/payments')
  await reviewer.page.getByRole('region',{name:'商品售后待办'}).locator(`[data-after-sales-case-id="${revisedCaseId}"]`).getByRole('button',{name:'处理商品'}).click()
  const review=reviewer.page.getByRole('dialog',{name:'商品停止与退款'})
  await expect(review.getByRole('button',{name:/^批准/})).toHaveCount(1)
  await review.getByRole('button',{name:`批准 ¥${(data.orderableProductUnitPriceMinor / 100).toFixed(2)}`}).click()
  await review.getByRole('checkbox',{name:`现金 ¥${(data.orderableProductUnitPriceMinor / 100).toFixed(2)} 已实际退给客人`}).check()
  await review.getByRole('button',{name:'登记现金已退'}).click()
  await expect(review.locator('article').filter({hasText:'修改后的申请'})).toContainText('1 份 · 已完成')
  await expect(review.getByRole('button',{name:/^批准/})).toHaveCount(0)
  await reviewer.context.close()
})

test('关桌后撤回退款仍能登记实际耗用，原操作恢复不重复处置',async({browser},testInfo)=>{
  test.setTimeout(120_000)
  const data=await fixture(),manager=await staffPage(browser,data,'liyan'),note=`离店实物-${Date.now()}`
  await manager.page.setViewportSize({width:390,height:844})
  await manager.page.getByRole('button',{name:'现场',exact:true}).first().click()
  await manager.page.getByRole('group',{name:'桌台显示范围'}).getByRole('button',{name:/^全部/}).click()
  const free=manager.page.locator('.staff-table-tile:not(.is-open)').first()
  await expect(free).toBeVisible()
  const tableCode=(await free.locator('strong').innerText()).trim()
  await free.click();await manager.page.getByLabel('实际到店人数').fill('2')
  await manager.page.getByRole('button',{name:'确认开台'}).click()
  await expect(manager.page.getByRole('status')).toContainText(`${tableCode} 已开台，2人`)
  await manager.page.getByRole('button',{name:'协助点单'}).click()
  const order=manager.page.getByRole('dialog',{name:`${tableCode}协助点单`})
  await order.getByLabel('搜索菜单商品').fill(data.orderableProductName)
  await order.getByRole('button',{name:`加入${data.orderableProductName}`}).click()
  await order.getByRole('button',{name:`增加${data.orderableProductName}`}).click()
  await order.getByRole('button',{name:'查看已选'}).click()
  const cart=order.getByRole('dialog',{name:'购物车明细'})
  await cart.getByPlaceholder('如：少冰、不要香菜、酒水和小食一起上').fill(note)
  await cart.getByRole('button',{name:'核对无误，确认下单'}).click()
  const created=manager.page.waitForResponse(response=>response.url().endsWith('/api/commerce/orders')&&response.request().method()==='POST')
  await order.getByRole('dialog',{name:'确认上单'}).getByRole('button',{name:'确认上单'}).click()
  const original=await (await created).json()
  const collected=await manager.page.request.post('/api/payments/manual',{headers:{'idempotency-key':`qa-physical-paid-${Date.now()}`},data:{orderId:original.id,provider:'cash',method:'cash',receiptReference:''}})
  expect(collected.ok(),await collected.text()).toBe(true)
  await expect(order).toHaveCount(0)
  const bartender=await staffPage(browser,data,'lengyanzhi')
  await bartender.page.getByRole('button',{name:'吧台出品',exact:true}).first().click()
  const card=bartender.page.locator('.staff-action-card').filter({hasText:note}).first()
  await expect(card).toBeVisible();await card.getByRole('spinbutton').fill('2')
  await card.getByRole('button',{name:'制作完成',exact:true}).click()
  await expect(card).toHaveCount(0);await bartender.context.close()
  const details=manager.page.getByRole('region',{name:`${tableCode}本桌点单详情`})
  if(!await details.isVisible())await manager.page.locator('.staff-table-tile').filter({has:manager.page.getByText(tableCode,{exact:true})}).click()
  await expect(details).toBeVisible()
  await details.getByRole('button',{name:'停止 / 退款'}).first().click()
  const workspace=manager.page.getByRole('dialog',{name:'商品停止与退款'})
  await workspace.getByLabel('本次停止份数').fill('2')
  await workspace.getByRole('button',{name:'停止 / 申请退款'}).click()
  await expect(workspace).toContainText('暂停 2 · 已停止 0')
  const closed=await manager.page.request.post(`/api/table-sessions/${original.tableSessionId}/close-after-customer-left`,{headers:{'idempotency-key':`qa-physical-close-${Date.now()}`},data:{reasonNote:'隔离验收离店后只处理实物，不退款'}})
  expect(closed.ok(),await closed.text()).toBe(true)
  // Force the regular table poll to observe the closure while the original
  // product is open; the after-sales workspace must survive that refresh.
  const refreshed=manager.page.waitForResponse(response=>response.url().includes('/api/operations')&&response.request().method()==='GET')
  await manager.page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')))
  await refreshed
  await expect(manager.page.getByRole('region',{name:`${tableCode}本桌点单详情`})).toHaveCount(0)
  await expect(workspace).toBeVisible()
  await workspace.getByRole('button',{name:'撤回申请'}).click()
  await expect(workspace).toContainText('退款决定保持，仅核对实物去向')
  await expect(workspace.getByRole('button',{name:'确认继续原商品'})).toHaveCount(0)
  await workspace.getByLabel('本批实物份数').fill('1')
  const sent:Array<{key:string;body:unknown}>=[];let lose=true
  await manager.page.route('**/api/commerce/item-after-sales/*/physical',async route=>{
    sent.push({key:route.request().headers()['idempotency-key'],body:route.request().postDataJSON()})
    const response=await route.fetch();expect(response.ok(),await response.text()).toBe(true)
    if(lose){lose=false;await route.abort('failed')}else await route.fulfill({response})
  })
  await workspace.getByRole('button',{name:'已消耗，不回库'}).click()
  await expect(workspace.getByRole('button',{name:'恢复上次商品处理'})).toBeVisible()
  await workspace.getByRole('button',{name:'恢复上次商品处理'}).click()
  await expect(workspace).toContainText('暂停 1 · 已停止 1')
  expect(sent).toHaveLength(2);expect(sent[1]).toEqual(sent[0])
  await workspace.getByRole('button',{name:'已消耗，不回库'}).click()
  await expect(workspace).toContainText('已撤回，商品已停止')
  await expect(workspace).toContainText('暂停 0 · 已停止 2')
  await expect(workspace).toContainText('申请已撤回，未退钱')
  expect(sent).toHaveLength(3);expect(sent[2].key).not.toBe(sent[0].key)
  await expect(workspace.getByRole('button',{name:'已消耗，不回库'})).toHaveCount(0)
  await workspace.getByRole('button',{name:'已联系所示岗位，确认知悉'}).click()
  await expect(workspace.getByRole('region',{name:'岗位通知待确认'})).toHaveCount(0)
  await expectNoHorizontalOverflow(manager.page)
  await manager.page.screenshot({path:testInfo.outputPath('declined-physical-390.png'),fullPage:true})
  await manager.context.close()
})

test('旧退库表单成功后读回失败只刷新数量，未知结果跨页面恢复原登记',async({browser})=>{
  const data=await fixture(),manager=await staffPage(browser,data,'liyan')
  const itemId=crypto.randomUUID(),orderId=crypto.randomUUID()
  let returned=0,readFails=false,loseNextCommit=false
  const applied=new Map<string,string>(),sent:Array<{key:string;body:unknown}>=[]
  // Controlled receipts exercise the real mounted UI. They do not attest stock
  // accounting; that is covered separately by PostgreSQL repository scenarios.
  await manager.page.route('**/api/operations/history**',async route=>{
    if(readFails){await route.abort('failed');return}
    await route.fulfill({json:{data:{businessDate:'2026-09-13',generatedAt:new Date().toISOString(),page:0,hasMore:false,financialSummaryVisible:false,receipts:[],orders:returned===3?[]:[{
      id:orderId,publicId:'QA-STOCK-READBACK',tableCode:'W01',employeeName:'隔离退库界面用例',submittedAt:new Date().toISOString(),status:'completed',paymentStatus:'partially_refunded',totalMinor:2400,
      items:[{id:itemId,name:'退库恢复测试水',quantity:3,returnedQuantity:returned,unitPriceMinor:800,totalMinor:2400,status:'delivered',note:null}],
    }]}}})
  })
  await manager.page.route(`**/api/operations/order-items/${itemId}/stock-return`,async route=>{
    const key=route.request().headers()['idempotency-key'],body=route.request().postDataJSON()
    sent.push({key,body})
    if(!applied.has(key)){
      returned+=body.quantity;applied.set(key,crypto.randomUUID())
      if(loseNextCommit){loseNextCommit=false;await route.abort('failed');return}
      readFails=true
    }
    await route.fulfill({json:{data:{id:applied.get(key),orderItemId:itemId,quantity:body.quantity,disposition:body.disposition},replayed:sent.length>1}})
  })
  await manager.page.goto('/staff/orders')
  await manager.page.getByText('退款商品库存处理',{exact:true}).click()
  await manager.page.getByLabel('核对说明').fill('未开封一瓶已实际收回')
  await manager.page.getByRole('checkbox',{name:'我已核实上述情况和实际数量'}).check()
  await manager.page.getByRole('button',{name:'确认实际退库'}).click()
  await expect(manager.page.getByText('退库已经成功，剩余数量暂未读回。只需刷新数量，不要再次登记。',{exact:true})).toBeVisible()
  await expect(manager.page.getByLabel('退回数量')).toBeDisabled()
  await expect(manager.page.getByRole('button',{name:'确认实际退库'})).toBeDisabled()
  expect(returned).toBe(1);expect(sent).toHaveLength(1)
  readFails=false
  await manager.page.reload()
  await manager.page.getByText('退款商品库存处理',{exact:true}).click()
  await expect(manager.page.getByLabel('退回数量')).toBeDisabled()
  await manager.page.getByRole('button',{name:'刷新剩余数量'}).click()
  await expect(manager.page.getByLabel('退回数量')).toBeEnabled()
  expect(returned).toBe(1);expect(sent).toHaveLength(1)
  await manager.page.getByLabel('核对说明').fill('第二瓶也已实际收回')
  await manager.page.getByRole('checkbox',{name:'我已核实上述情况和实际数量'}).check()
  loseNextCommit=true
  await manager.page.getByRole('button',{name:'确认实际退库'}).click()
  await expect(manager.page.getByRole('button',{name:'恢复原退库结果'})).toBeVisible()
  await manager.page.reload()
  await manager.page.getByText('退款商品库存处理',{exact:true}).click()
  await expect(manager.page.getByLabel('实际情况')).toBeDisabled()
  await manager.page.getByRole('button',{name:'恢复原退库结果'}).click()
  await expect(manager.page.getByText('已核对剩余数量。本次退库完成，没有再次退款或出品。',{exact:true})).toBeVisible()
  expect(sent).toHaveLength(3);expect(sent[2]).toEqual(sent[1]);expect(returned).toBe(2)
  await manager.page.getByLabel('核对说明').fill('最后一瓶也已实际收回')
  await manager.page.getByRole('checkbox',{name:'我已核实上述情况和实际数量'}).check()
  loseNextCommit=true
  await manager.page.getByRole('button',{name:'确认实际退库'}).click()
  await expect(manager.page.getByRole('button',{name:'恢复原退库结果'})).toBeVisible()
  await manager.page.reload()
  const outstanding=manager.page.getByRole('region',{name:'原退库结果待核对'})
  await expect(outstanding).toBeVisible()
  await outstanding.getByText('退款商品库存处理',{exact:true}).click()
  await outstanding.getByRole('button',{name:'恢复原退库结果'}).click()
  await expect(outstanding).toHaveCount(0)
  expect(returned).toBe(3);expect(sent).toHaveLength(5);expect(sent[4]).toEqual(sent[3])

  await expectNoHorizontalOverflow(manager.page)
  await manager.context.close()
})

test('换品新单丢回执后从原商品读回关联，不重复建单且旧退款与新价格分别保留',async({browser},testInfo)=>{
  test.setTimeout(120_000)
  const data=await fixture(),manager=await staffPage(browser,data,'liyan')
  await manager.page.setViewportSize({width:390,height:844})
  await manager.page.getByRole('button',{name:'现场',exact:true}).first().click()
  await manager.page.getByRole('group',{name:'桌台显示范围'}).getByRole('button',{name:/^全部/}).click()
  const free=manager.page.locator('.staff-table-tile:not(.is-open)').first()
  const tableCode=(await free.locator('strong').innerText()).trim()
  await free.click();await manager.page.getByLabel('实际到店人数').fill('2')
  await manager.page.getByRole('button',{name:'确认开台'}).click()
  await expect(manager.page.getByRole('status')).toContainText(`${tableCode} 已开台，2人`)
  await manager.page.getByRole('button',{name:'协助点单'}).click()
  const sheet=manager.page.getByRole('dialog',{name:`${tableCode}协助点单`,exact:true})
  await sheet.getByLabel('搜索菜单商品').fill(data.orderableProductName)
  await sheet.getByRole('button',{name:`加入${data.orderableProductName}`}).click()
  await sheet.getByRole('button',{name:`增加${data.orderableProductName}`}).click()
  await sheet.getByRole('button',{name:'查看已选'}).click()
  await sheet.getByRole('dialog',{name:'购物车明细'}).getByRole('button',{name:'核对无误，确认下单'}).click()
  const submitted=manager.page.waitForResponse(response=>response.url().endsWith('/api/commerce/orders')&&response.request().method()==='POST')
  await sheet.getByRole('dialog',{name:'确认上单'}).getByRole('button',{name:'确认上单'}).click()
  const source=await (await submitted).json()
  const paid=await manager.page.request.post('/api/payments/manual',{headers:{'idempotency-key':`qa-replacement-paid-${Date.now()}`},data:{orderId:source.id,provider:'cash',method:'cash',receiptReference:''}})
  expect(paid.ok(),await paid.text()).toBe(true)
  await expect(sheet).toHaveCount(0)
  const details=manager.page.getByRole('region',{name:`${tableCode}本桌点单详情`})
  if(!await details.isVisible())await manager.page.locator('.staff-table-tile').filter({has:manager.page.locator('strong',{hasText:new RegExp(`^${tableCode}$`)})}).click()
  await details.getByRole('button',{name:'停止 / 退款'}).first().click()
  const panel=manager.page.getByRole('dialog',{name:'商品停止与退款',exact:true})
  await panel.getByLabel('本次停止份数').fill('1')
  await panel.getByRole('button',{name:'停止 / 申请退款'}).click()
  await expect(panel).toContainText('暂停 1 · 已停止 0')
  await panel.getByRole('button',{name:'换商品，另开新单'}).click()
  await sheet.getByLabel('搜索菜单商品').fill(data.kitchenProductName)
  await sheet.getByRole('button',{name:`加入${data.kitchenProductName}`}).click()
  await sheet.getByRole('button',{name:'查看已选'}).click()
  await sheet.getByRole('dialog',{name:'购物车明细'}).getByRole('button',{name:'确认换品，建立新单'}).click()
  let sent=0,newOrder:Record<string,unknown>|null=null,done:()=>void=()=>{}
  const completed=new Promise<void>(resolve=>{done=resolve})
  await manager.page.route('**/api/commerce/orders',async route=>{
    if(route.request().method()!=='POST')return route.continue()
    sent++;expect(route.request().postDataJSON().replacementCaseId).toBeTruthy()
    const response=await route.fetch();expect(response.ok(),await response.text()).toBe(true)
    newOrder=await response.json();await route.abort('failed');done()
  })
  await sheet.getByRole('dialog',{name:'确认上单'}).getByRole('button',{name:'确认上单'}).click()
  await completed
  await expect(sheet.getByRole('dialog',{name:'确认上单'}).getByRole('alert')).toContainText('网络连接失败')
  await sheet.getByRole('dialog',{name:'确认上单'}).getByRole('button',{name:'再看看',exact:true}).click()
  if(await sheet.getByRole('dialog',{name:'购物车明细'}).isVisible())await sheet.getByRole('dialog',{name:'购物车明细'}).getByRole('button',{name:'关闭购物车',exact:true}).click()
  await sheet.getByRole('button',{name:'关闭点单'}).click()
  await expect(panel).toContainText('换品新单：')
  await expect(panel).toContainText('旧申请与新单分别结算')
  await expect(panel).toContainText('暂停 1 · 已停止 0')
  await expect(panel.getByRole('button',{name:'换商品，另开新单'})).toHaveCount(0)
  expect(sent).toBe(1);expect(newOrder).not.toBeNull();expect((newOrder as unknown as {id:string}).id).not.toBe(source.id)
  await expectNoHorizontalOverflow(manager.page)
  await manager.page.screenshot({path:testInfo.outputPath('replacement-associated-after-lost-response-390.png'),fullPage:true})
  const firstNewId=(newOrder as unknown as {id:string}).id
  const cancelled=await manager.page.request.post(`/api/orders/${firstNewId}/cancel-unpaid`,{headers:{'idempotency-key':`qa-replacement-cancel-${Date.now()}`},data:{reasonCode:'other',reasonNote:'客人重新选择商品，本次新单未制作'}})
  expect(cancelled.ok(),await cancelled.text()).toBe(true)
  await panel.getByRole('button',{name:'刷新商品状态',exact:true}).click()
  await expect(panel).toContainText('已取消')
  await panel.getByRole('button',{name:'重新换品，另开新单'}).click()
  await sheet.getByLabel('搜索菜单商品').fill(data.kitchenProductName)
  await sheet.getByRole('button',{name:`加入${data.kitchenProductName}`}).click()
  await sheet.getByRole('button',{name:'查看已选'}).click()
  await sheet.getByRole('dialog',{name:'购物车明细'}).getByRole('button',{name:'确认换品，建立新单'}).click()
  await manager.page.unroute('**/api/commerce/orders')
  const successorResponse=manager.page.waitForResponse(response=>response.url().endsWith('/api/commerce/orders')&&response.request().method()==='POST')
  await sheet.getByRole('dialog',{name:'确认上单'}).getByRole('button',{name:'确认上单'}).click()
  const successor=await successorResponse
  expect(successor.ok(),await successor.text()).toBe(true)
  expect(successor.request().postDataJSON().replacementPreviousOrderId).toBe(firstNewId)
  expect((await successor.json()).id).not.toBe(firstNewId)
  await expect(sheet).toHaveCount(0)
  await expect(panel).toContainText('暂停 1 · 已停止 0')
  await expect(panel.getByRole('button',{name:'重新换品，另开新单'})).toHaveCount(0)
  await expectNoHorizontalOverflow(manager.page)
  await manager.context.close()
})

test('原实物补送丢回执恢复原任务，手机按份数确认并取消余量',async({browser},testInfo)=>{
  test.setTimeout(120_000)
  const data=await fixture(),note=`原实物补送-${Date.now()}`,manager=await staffPage(browser,data,'liyan')
  await manager.page.setViewportSize({width:390,height:844})
  await manager.page.getByRole('button',{name:'现场',exact:true}).first().click()
  await manager.page.getByRole('group',{name:'桌台显示范围'}).getByRole('button',{name:/^全部/}).click()
  const free=manager.page.locator('.staff-table-tile:not(.is-open)').first(),tableCode=(await free.locator('strong').innerText()).trim()
  await free.click();await manager.page.getByLabel('实际到店人数').fill('2');await manager.page.getByRole('button',{name:'确认开台'}).click()
  await expect(manager.page.getByRole('status')).toContainText(`${tableCode} 已开台，2人`)
  await manager.page.getByRole('button',{name:'协助点单'}).click()
  const sheet=manager.page.getByRole('dialog',{name:`${tableCode}协助点单`})
  await sheet.getByLabel('搜索菜单商品').fill(data.orderableProductName)
  await sheet.getByRole('button',{name:`加入${data.orderableProductName}`}).click()
  await sheet.getByRole('button',{name:`增加${data.orderableProductName}`}).click()
  await sheet.getByRole('button',{name:'查看已选'}).click()
  const cart=sheet.getByRole('dialog',{name:'购物车明细'})
  await cart.getByPlaceholder('如：少冰、不要香菜、酒水和小食一起上').fill(note)
  await cart.getByRole('button',{name:'核对无误，确认下单'}).click()
  const submitted=manager.page.waitForResponse(response=>response.url().endsWith('/api/commerce/orders')&&response.request().method()==='POST')
  await sheet.getByRole('dialog',{name:'确认上单'}).getByRole('button',{name:'确认上单'}).click()
  const source=await (await submitted).json();await expect(sheet).toHaveCount(0)
  const bartender=await staffPage(browser,data,'lengyanzhi')
  await bartender.page.getByRole('button',{name:'吧台出品',exact:true}).first().click()
  const preparing=bartender.page.locator('.staff-action-card').filter({hasText:note}).first()
  await expect(preparing).toBeVisible();await preparing.getByRole('spinbutton').fill('2')
  await preparing.getByRole('button',{name:'制作完成',exact:true}).click();await expect(preparing).toHaveCount(0)
  const server=await staffPage(browser,data,'tom')
  await server.page.getByRole('button',{name:'取送',exact:true}).first().click()
  const delivery=server.page.locator('.staff-action-card').filter({hasText:note}).first()
  await expect(delivery).toContainText('× 2');await delivery.getByRole('button',{name:/^(本次|全部)已送达$/}).click();await expect(delivery).toHaveCount(0)
  const details=manager.page.getByRole('region',{name:`${tableCode}本桌点单详情`})
  if(!await details.isVisible())await manager.page.locator('.staff-table-tile').filter({has:manager.page.locator('strong',{hasText:new RegExp(`^${tableCode}$`)})}).click()
  await details.getByRole('button',{name:'停止 / 退款'}).first().click()
  const panel=manager.page.getByRole('dialog',{name:'商品停止与退款',exact:true})
  await panel.getByRole('button',{name:'原实物补送',exact:true}).click()
  await panel.getByLabel('补送份数',{exact:true}).fill('2')
  await panel.getByLabel('原实物仍在且可交付，无需重新制作').check()
  let drop=true,finish:()=>void=()=>{};const finished=new Promise<void>(resolve=>{finish=resolve}),sent:Array<{key:string;body:unknown}>=[]
  await manager.page.route('**/api/commerce/item-after-sales/redeliveries',async route=>{
    const lose=drop;drop=false;sent.push({key:route.request().headers()['idempotency-key'],body:route.request().postDataJSON()})
    const response=await route.fetch();expect(response.ok(),await response.text()).toBe(true)
    if(lose){await route.abort('failed');finish()}else await route.fulfill({response})
  })
  await panel.getByRole('button',{name:'安排原实物补送'}).click();await finished
  await expect(panel.getByRole('button',{name:'恢复上次商品处理'})).toBeVisible()
  await panel.getByRole('button',{name:'关闭商品处理'}).click()
  await details.getByRole('button',{name:'停止 / 退款'}).first().click()
  await panel.getByRole('button',{name:'恢复上次商品处理'}).click()
  const task=panel.getByRole('article',{name:'原实物补送任务'})
  await expect(task).toHaveCount(1);await expect(task).toContainText('待补送 2')
  expect(sent).toHaveLength(2);expect(sent[1]).toEqual(sent[0])
  // The manager can arrange/cancel, while delivery stays with the real delivery role.
  await expect(task.getByLabel('本次实际补送份数')).toHaveCount(0)
  await panel.getByRole('button',{name:'关闭商品处理'}).click()
  await server.page.setViewportSize({width:390,height:844})
  await server.page.getByRole('button',{name:'任务',exact:true}).first().click()
  const serviceCard=server.page.locator('.staff-action-card').filter({hasText:`${tableCode} · ${data.orderableProductName}原实物补送`}).first()
  await expect(serviceCard).toBeVisible();await serviceCard.getByRole('button',{name:'核对补送份数'}).click()
  const serverPanel=server.page.getByRole('dialog',{name:'商品停止与退款',exact:true}),serverTask=serverPanel.getByRole('article',{name:'原实物补送任务'})
  await serverTask.getByLabel('本次实际补送份数').fill('1');await serverTask.getByRole('button',{name:'确认原实物已补送'}).click()
  await expect(serverTask).toContainText('已补送 1');await expect(serverTask).toContainText('待补送 1')
  await serverTask.getByRole('button',{name:'取消本次补送'}).click()
  await expect(serverTask).toContainText('已取消 1');await expect(serverTask).toContainText('已补送 1');await expect(serverTask).toContainText('待补送 0')
  await expect(serverPanel).toContainText('原成交');await expectNoHorizontalOverflow(server.page)
  await server.page.screenshot({path:testInfo.outputPath('redelivery-recovered-partial-cancel-390.png'),fullPage:true})
  expect(source.id).toBeTruthy()
  await manager.context.close();await bartender.context.close();await server.context.close()
})


test('离店重做实物分份登记，最后一份丢回执仍可刷新恢复',async({browser},testInfo)=>{
  test.setTimeout(120_000)
  const data=await fixture();test.skip(!data.remakeHandoverFixture,'需要独立重做实物夹具')
  const original=data.remakeHandoverFixture!,manager=await staffPage(browser,data,'liyan'),page=manager.page
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'任务',exact:true}).first().click()
  const panel=page.getByRole('region',{name:'离店重做实物',exact:true}),row=panel.getByRole('article',{name:'离店重做实物批次'})
  await expect(row).toHaveCount(1);await expect(row).toContainText('待处理 2 份')
  await row.getByLabel('本次实物份数').fill('1');await row.getByRole('button',{name:'确认本批已耗用或损耗'}).click()
  await expect(row).toContainText('待处理 1 份')
  const url=`**/api/commerce/item-after-sales/remakes/${original.batchId}/after-visit-physical`
  let committed:()=>void=()=>{};const finished=new Promise<void>(resolve=>{committed=resolve})
  await page.route(url,async route=>{const response=await route.fetch();expect(response.ok(),await response.text()).toBe(true);committed();await route.abort('failed')},{times:1})
  await row.getByRole('button',{name:'确认本批已耗用或损耗'}).click();await finished
  await expect(panel.getByRole('button',{name:'恢复上次实物登记'})).toBeVisible()
  await page.reload();await page.getByRole('button',{name:'任务',exact:true}).first().click()
  await expect(panel.getByRole('article',{name:'离店重做实物批次'})).toHaveCount(0)
  await expect(panel.getByRole('button',{name:'恢复上次实物登记'})).toBeVisible()
  await panel.getByRole('button',{name:'恢复上次实物登记'}).click()
  await expect(panel).toContainText('实物登记已确认，原收款和退款不变')
  await expect(panel.getByRole('button',{name:'恢复上次实物登记'})).toHaveCount(0)
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true)
  await page.screenshot({path:testInfo.outputPath('remake-handover-last-result-390.png'),fullPage:true})
  await manager.context.close()
})

test('岗位按份重做丢回执恢复，新批逐份完成并保留原金额',async({browser},testInfo)=>{
  test.setTimeout(120_000)
  const data=await fixture(),note=`按份重做-${Date.now()}`,manager=await staffPage(browser,data,'liyan')
  await manager.page.setViewportSize({width:390,height:844})
  await manager.page.getByRole('button',{name:'现场',exact:true}).first().click()
  await manager.page.getByRole('group',{name:'桌台显示范围'}).getByRole('button',{name:/^全部/}).click()
  const free=manager.page.locator('.staff-table-tile:not(.is-open)').first(),tableCode=(await free.locator('strong').innerText()).trim()
  await free.click();await manager.page.getByLabel('实际到店人数').fill('2');await manager.page.getByRole('button',{name:'确认开台'}).click()
  await expect(manager.page.getByRole('status')).toContainText(`${tableCode} 已开台，2人`)
  await manager.page.getByRole('button',{name:'协助点单'}).click()
  const sheet=manager.page.getByRole('dialog',{name:`${tableCode}协助点单`})
  await sheet.getByLabel('搜索菜单商品').fill(data.orderableProductName)
  await sheet.getByRole('button',{name:`加入${data.orderableProductName}`}).click()
  await sheet.getByRole('button',{name:`增加${data.orderableProductName}`}).click()
  await sheet.getByRole('button',{name:'查看已选'}).click()
  const cart=sheet.getByRole('dialog',{name:'购物车明细'})
  await cart.getByPlaceholder('如：少冰、不要香菜、酒水和小食一起上').fill(note)
  await cart.getByRole('button',{name:'核对无误，确认下单'}).click()
  const submitted=manager.page.waitForResponse(response=>response.url().endsWith('/api/commerce/orders')&&response.request().method()==='POST')
  await sheet.getByRole('dialog',{name:'确认上单'}).getByRole('button',{name:'确认上单'}).click()
  const source=await (await submitted).json();await expect(sheet).toHaveCount(0)
  const bartender=await staffPage(browser,data,'lengyanzhi')
  await bartender.page.getByRole('button',{name:'吧台出品',exact:true}).first().click()
  const preparing=bartender.page.locator('.staff-action-card').filter({hasText:note}).first()
  await expect(preparing).toBeVisible();await preparing.getByRole('spinbutton').fill('2')
  await preparing.getByRole('button',{name:'制作完成',exact:true}).click();await expect(preparing).toHaveCount(0)
  await bartender.page.setViewportSize({width:390,height:844})
  await bartender.page.getByRole('button',{name:'我的已制作',exact:true}).click()
  const history=bartender.page.getByRole('region',{name:'我的历史制作'}),original=history.locator('article').filter({hasText:tableCode})
  await expect(original).toBeVisible();await original.getByRole('button',{name:'商品处理',exact:true}).click()
  const panel=bartender.page.getByRole('dialog',{name:'商品停止与退款',exact:true})
  await panel.getByRole('button',{name:'按份重新制作',exact:true}).click()
  const form=panel.getByRole('form',{name:'按份重做'})
  await form.getByLabel('本次重做份数').fill('2');await form.getByLabel('需要重新制作，无法直接补送这批原实物').check()
  const sent:Array<{key:string;body:unknown}>=[];let drop=true
  await bartender.page.route('**/api/commerce/kds/*/remake',async route=>{
    const lose=drop;drop=false;sent.push({key:route.request().headers()['idempotency-key'],body:route.request().postDataJSON()})
    const response=await route.fetch();expect(response.ok(),await response.text()).toBe(true)
    if(lose)await route.abort('failed');else await route.fulfill({response})
  })
  await form.getByRole('button',{name:'确认本次重做'}).click()
  await expect(panel.getByRole('button',{name:'恢复上次商品处理'})).toBeVisible()
  await panel.getByRole('button',{name:'关闭商品处理'}).click();await original.getByRole('button',{name:'商品处理',exact:true}).click()
  await panel.getByRole('button',{name:'恢复上次商品处理'}).click()
  const batch=panel.getByRole('article',{name:'重做批次'})
  await expect(batch).toHaveCount(1);await expect(batch).toContainText('未制作 2');expect(sent).toHaveLength(2);expect(sent[1]).toEqual(sent[0])
  await expect(panel).toContainText('原成交');await expect(panel.getByRole('button',{name:'本批按份再次制作'})).toHaveCount(0)
  await panel.getByRole('button',{name:'关闭商品处理'}).click()
  await bartender.page.getByRole('button',{name:/^待制作（/}).click()
  const remakeCard=bartender.page.locator('.staff-action-card').filter({hasText:note}).filter({hasText:'重做：'}).first()
  await expect(remakeCard).toContainText('× 2');await remakeCard.getByRole('spinbutton').fill('1');await remakeCard.getByRole('button',{name:'制作完成',exact:true}).click()
  await expect(remakeCard).toContainText('待制作 1');await expect(remakeCard).toContainText('已备齐 1')
  await remakeCard.getByRole('button',{name:'商品处理',exact:true}).click()
  await expect(batch).toContainText('未制作 1');await expect(batch).toContainText('待送 1');await expect(panel.getByRole('button',{name:'本批按份再次制作'})).toBeVisible()
  await expectNoHorizontalOverflow(bartender.page)
  await bartender.page.screenshot({path:testInfo.outputPath('quantity-remake-source-recovery-390.png'),fullPage:true})
  expect(source.id).toBeTruthy();await manager.context.close();await bartender.context.close()
})

for(const decision of ['approved','rejected'] as const)test(`未付已制作商品本人${decision==='approved'?'按原权限免收':'按原权限拒绝停止'}，丢回执恢复后实物单独处理`,async({browser},testInfo)=>{
  test.setTimeout(120_000)
  const data=await fixture(),manager=await staffPage(browser,data,'liyan'),note=`未付已做-${Date.now()}`
  await manager.page.setViewportSize({width:390,height:844})
  await manager.page.getByRole('button',{name:'现场',exact:true}).first().click()
  await manager.page.getByRole('group',{name:'桌台显示范围'}).getByRole('button',{name:/^全部/}).click()
  const free=manager.page.locator('.staff-table-tile:not(.is-open)').first()
  await expect(free).toBeVisible()
  const tableCode=(await free.locator('strong').innerText()).trim()
  await free.click();await manager.page.getByLabel('实际到店人数').fill('2')
  await manager.page.getByRole('button',{name:'确认开台'}).click()
  await expect(manager.page.getByRole('status')).toContainText(`${tableCode} 已开台，2人`)
  await manager.page.getByRole('button',{name:'协助点单'}).click()
  const order=manager.page.getByRole('dialog',{name:`${tableCode}协助点单`})
  await order.getByLabel('搜索菜单商品').fill(data.orderableProductName)
  await order.getByRole('button',{name:`加入${data.orderableProductName}`}).click()
  await order.getByRole('button',{name:`增加${data.orderableProductName}`}).click()
  await order.getByRole('button',{name:'查看已选'}).click()
  const cart=order.getByRole('dialog',{name:'购物车明细'})
  await cart.getByPlaceholder('如：少冰、不要香菜、酒水和小食一起上').fill(note)
  await cart.getByRole('button',{name:'核对无误，确认下单'}).click()
  const created=manager.page.waitForResponse(response=>response.url().endsWith('/api/commerce/orders')&&response.request().method()==='POST')
  await order.getByRole('dialog',{name:'确认上单'}).getByRole('button',{name:'确认上单'}).click()
  const original=await (await created).json()
  await expect(order).toHaveCount(0)
  const bartender=await staffPage(browser,data,'lengyanzhi')
  await bartender.page.getByRole('button',{name:'吧台出品',exact:true}).first().click()
  const card=bartender.page.locator('.staff-action-card').filter({hasText:note}).first()
  await expect(card).toBeVisible();await card.getByRole('spinbutton').fill('2')
  await card.getByRole('button',{name:'制作完成',exact:true}).click()
  await expect(card).toHaveCount(0);await bartender.context.close()
  const details=manager.page.getByRole('region',{name:`${tableCode}本桌点单详情`})
  if(!await details.isVisible())await manager.page.locator('.staff-table-tile').filter({has:manager.page.getByText(tableCode,{exact:true})}).click()
  await expect(details).toBeVisible()
  await details.getByRole('button',{name:'停止 / 退款'}).first().click()
  const workspace=manager.page.getByRole('dialog',{name:'商品停止与退款'})
  await workspace.getByLabel('本次停止份数').fill('1')
  await workspace.getByRole('button',{name:'停止 / 申请退款'}).click()
  await expect(workspace).toContainText('暂停 1 · 已停止 0')
  await expect(workspace).toContainText('未付款，待停止核对')
  const sent:Array<{key:string;body:unknown}>=[];let lose=true
  await manager.page.route('**/api/commerce/item-after-sales/*/decision',async route=>{
    sent.push({key:route.request().headers()['idempotency-key'],body:route.request().postDataJSON()})
    const response=await route.fetch();expect(response.ok(),await response.text()).toBe(true)
    if(lose){lose=false;await route.abort('failed')}else await route.fulfill({response})
  })
  await workspace.getByRole('button',{name:decision==='approved'?`确认停止并免收 ¥${(data.orderableProductUnitPriceMinor / 100).toFixed(2)}`:'拒绝停止'}).click()
  await expect(workspace.getByRole('button',{name:'恢复上次商品处理'})).toBeVisible()
  await workspace.getByRole('button',{name:'恢复上次商品处理'}).click()
  expect(sent).toHaveLength(2);expect(sent[1]).toEqual(sent[0])
  if(decision==='rejected'){
    await expect(workspace).toContainText('停止未获同意，未免收')
    await expect(workspace).toContainText('暂停 1 · 已停止 0')
    await expect(workspace.getByRole('button',{name:/确认停止并免收/})).toHaveCount(0)
    await workspace.getByRole('combobox').selectOption({label:'客人确认继续保留商品'})
    await workspace.getByRole('button',{name:'确认继续原商品'}).click()
    await expect(workspace).toContainText('暂停 0 · 已停止 0')
    await expect(workspace).toContainText('已拒绝，已恢复原商品')
    await expectNoHorizontalOverflow(manager.page)
    await manager.page.screenshot({path:testInfo.outputPath('unpaid-made-self-reject-390.png'),fullPage:true})
    await manager.context.close()
    return
  }
  await expect(workspace).toContainText('已免收所选原款，无退款')
  await expect(workspace).toContainText('暂停 1 · 已停止 0')
  await expect(workspace.getByRole('button',{name:/确认停止并免收/})).toHaveCount(0)
  const collected=await manager.page.request.post('/api/payments/manual',{headers:{'idempotency-key':`qa-unpaid-made-remainder-${Date.now()}`},data:{orderId:original.id,provider:'cash',method:'cash',receiptReference:''}})
  expect(collected.ok(),await collected.text()).toBe(true)
  await workspace.getByRole('button',{name:'已消耗，不回库'}).click()
  await expect(workspace).toContainText('暂停 0 · 已停止 1')
  await expect(workspace).toContainText('1 份 · 已完成')
  await expect(workspace.getByRole('checkbox',{name:/现金.*已实际退给客人/})).toHaveCount(0)
  await expectNoHorizontalOverflow(manager.page)
  await manager.page.screenshot({path:testInfo.outputPath('unpaid-made-stop-390.png'),fullPage:true})
  await manager.context.close()
})
