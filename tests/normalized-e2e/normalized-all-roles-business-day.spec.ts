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
  orderableProductName: string
  kitchenProductName: string
  employees: EmployeeFixture[]
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
        await expect(page.getByText('林小满')).toBeVisible()
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
        await page.getByRole('button', { name: /工作台/ }).click()
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
    '/staff/performance': '演出与点歌',
    '/staff/inventory': '库存与存酒',
    '/staff/operations': '经营数据',
    '/staff/customer-experience': '客户体验与活动',
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
  await expect(guest.getByRole('heading', { name: /支付已经完成|测试订单已建立|等待微信支付/ })).toBeVisible()
  await guestContext.close()

  const orderManager = await staffPage(browser, data, 'liyan')
  await orderManager.page.getByRole('button', { name: '现场', exact: true }).first().click()
  await orderManager.page.getByRole('button', { name: /W01.*已开台/ }).click()
  await orderManager.page.getByRole('button', { name: '协助点单' }).click()
  const assistedOrder = orderManager.page.getByRole('dialog', { name: 'W01协助点单' })
  for (const productName of [data.orderableProductName, data.kitchenProductName]) {
    await assistedOrder.getByLabel('搜索菜单商品').fill(productName)
    await assistedOrder.getByRole('button', { name: `加入${productName}` }).click()
  }
  await assistedOrder.getByRole('button', { name: '查看已选' }).click()
  const assistedCart = assistedOrder.getByRole('dialog', { name: '购物车明细' })
  await assistedCart.getByPlaceholder('如：少冰、不要香菜、酒水和小食一起上').fill('营业日验收：酒水小食一起上')
  await assistedCart.getByRole('button', { name: '核对无误，确认下单' }).click()
  await assistedOrder.getByRole('dialog', { name: '确认上单' }).getByRole('button', { name: '确认上单' }).click()
  await expect(orderManager.page.getByRole('status')).toContainText('W01 订单已挂桌并发送出品')
  await orderManager.context.close()

  const bartender = await staffPage(browser, data, 'lengyanzhi')
  await bartender.page.getByRole('button', { name: '吧台出品', exact: true }).first().click()
  const barCard = bartender.page.locator('.staff-action-card').filter({ hasText: data.orderableProductName }).first()
  await expect(barCard).toBeVisible()
  await expect(bartender.page.locator('.staff-action-card').filter({ hasText: data.kitchenProductName })).toHaveCount(0)
  await expect(bartender.page.locator('.staff-action-card').filter({ hasText: '未付款订单不得出品' })).toHaveCount(0)
  await expect(barCard).toContainText('营业日验收：酒水小食一起上')
  await barCard.getByRole('button', { name: '制作完成' }).click()
  await expect(bartender.page.getByRole('status')).toContainText('配送岗位已收到')
  await bartender.context.close()

  const kitchen = await staffPage(browser, data, 'shenliangliang')
  await kitchen.page.getByRole('button', { name: '后厨出品', exact: true }).first().click()
  const kitchenCard = kitchen.page.locator('.staff-action-card').filter({ hasText: data.kitchenProductName }).first()
  await expect(kitchenCard).toBeVisible()
  await expect(kitchen.page.locator('.staff-action-card').filter({ hasText: data.orderableProductName })).toHaveCount(0)
  await expect(kitchen.page.locator('.staff-action-card').filter({ hasText: '未付款订单不得出品' })).toHaveCount(0)
  await expect(kitchenCard).toContainText('营业日验收：酒水小食一起上')
  await kitchenCard.getByRole('button', { name: '制作完成' }).click()
  await expect(kitchen.page.getByRole('status')).toContainText('配送岗位已收到')
  await kitchen.context.close()

  const server = await staffPage(browser, data, 'tom')
  await server.page.getByRole('button', { name: '取送', exact: true }).first().click()
  for (const productName of [data.orderableProductName, data.kitchenProductName]) {
    const delivery = server.page.locator('.staff-action-card').filter({ hasText: productName }).first()
    await expect(delivery).toBeVisible()
    await expect(delivery).toContainText('待配送')
    await delivery.getByRole('button', { name: '已送达' }).click()
    await expect(server.page.getByRole('status')).toContainText('已送达')
  }
  await server.page.getByRole('button', { name: /工作台/ }).click()
  await server.page.getByRole('button', { name: '任务', exact: true }).first().click()
  const callTask = server.page.locator('.staff-action-card').filter({ hasText: '客人正在等您' }).first()
  await expect(callTask).toBeVisible()
  await callTask.getByRole('button', { name: '完成' }).click()
  await expect(server.page.getByRole('status')).toContainText('已完成')
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
  await cashier.page.getByRole('button', { name: '收银复核', exact: true }).first().click()
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

test('public reservation is confirmed by marketing and marked arrived by the greeter', async ({ browser }) => {
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
  const pending = marketing.page.locator('.staff-reservation-card').filter({ hasText: customerName }).first()
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
  await expect(confirmed).toBeVisible()
  await expect(confirmed).toContainText('已确认')
  await confirmed.getByRole('button', { name: '客人到店' }).click()
  await expect(greeter.page.getByRole('status')).toContainText('已登记到店')
  await greeter.context.close()
})

test('manager completes a walk-in table lifecycle without leaving the mobile operations page', async ({ browser }) => {
  test.setTimeout(90_000)
  const data = await fixture()
  const manager = await staffPage(browser, data, 'liyan')
  await manager.page.getByRole('button', { name: '现场', exact: true }).first().click()
  await expect(manager.page.getByRole('heading', { name: '找到桌台，直接处理' })).toBeVisible()
  await manager.page.getByRole('button', { name: '全部', exact: true }).click()

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

  await manager.page.getByRole('button', { name: '关台/翻台' }).click()
  await manager.page.getByRole('button', { name: '再次确认关台' }).click()
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

  await expect(manager.page.getByRole('status')).toContainText('李艳 已安排 1 张责任桌')
  const active = manager.page.locator('.staff-assignment-active article').filter({ hasText: `${tableCode} · 李艳` })
  await expect(active).toContainText('主服务员')
  await active.getByRole('button', { name: '结束责任' }).click()
  await active.getByRole('button', { name: '再次确认结束' }).click()
  await expect(manager.page.getByRole('status')).toContainText(`李艳 对 ${tableCode} 的责任已结束`)
  await expect(active).toHaveCount(0)
  await expectNoHorizontalOverflow(manager.page)
  await manager.context.close()
})

test('店长可在经营配置中修改商品推荐字段并从服务端读回', async ({ browser }) => {
  test.setTimeout(90_000)
  const data = await fixture()
  const manager = await staffPage(browser, data, 'liyan')
  await manager.page.setViewportSize({ width: 430, height: 880 })
  await manager.page.goto('/staff/settings')
  await expect(manager.page.getByRole('heading', { name: '系统配置状态' })).toBeVisible()
  await manager.page.getByRole('button', { name: /商品、售价与推荐/ }).click()
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
  manager.page.once('dialog', (dialog) => dialog.accept())
  await manager.page.getByRole('button', { name: '关闭线上支付' }).click()
  await expect(manager.page.getByRole('status')).toContainText('线上支付已关闭')
  await expect(manager.page.getByText('线上支付已关闭', { exact: true }).first()).toBeVisible()

  await manager.page.getByLabel('调整原因').fill('浏览器验收：恢复支付渠道')
  manager.page.once('dialog', (dialog) => dialog.accept())
  await manager.page.getByRole('button', { name: '开放线上支付' }).click()
  await expect(manager.page.getByRole('status')).toContainText('线上支付已开放')
  await expect(manager.page.getByText('线上支付已开放', { exact: true }).first()).toBeVisible()
  await expect(manager.page.getByRole('button', { name: '关闭线上支付' })).toBeEnabled()

  await manager.page.getByLabel('待付款库存保留时间').fill('9')
  await manager.page.getByLabel('调整原因').fill('浏览器验收：缩短库存保留时间')
  manager.page.once('dialog', (dialog) => dialog.accept())
  await manager.page.getByRole('button', { name: '保存时限' }).click()
  await expect(manager.page.getByRole('status')).toContainText('待付款库存保留时间已调整为9分钟')
  await expect(manager.page.getByLabel('待付款库存保留时间')).toHaveValue('9')
  await expect(manager.page.getByRole('button', { name: '关闭线上支付' })).toBeEnabled()

  await manager.page.getByLabel('待付款库存保留时间').fill('10')
  await manager.page.getByLabel('调整原因').fill('浏览器验收：恢复库存保留时间')
  manager.page.once('dialog', (dialog) => dialog.accept())
  await manager.page.getByRole('button', { name: '保存时限' }).click()
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
