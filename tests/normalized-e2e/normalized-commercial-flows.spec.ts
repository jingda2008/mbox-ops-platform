import { readFile } from 'node:fs/promises'
import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

interface Fixture {
  guestUrl: string
  reservationUrl: string
  staffUrl: string
  dailyCredential: string
  employeeCode: string
  employeePin: string
  adminEmployeeCode: string
  adminEmployeePin: string
  orderableProductName: string
  bundleProductName: string
}

async function expectNoHorizontalOverflow(page: import('@playwright/test').Page) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    page: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
  }))
  expect(dimensions.page).toBeLessThanOrEqual(dimensions.viewport + 1)
}

async function fixture(): Promise<Fixture> {
  return JSON.parse(await readFile(
    process.env.NORMALIZED_E2E_FIXTURE_FILE ?? 'artifacts/normalized-browser/fixture.json',
    'utf8',
  )) as Fixture
}

test('mobile guest scans a fixed table QR, searches, orders and sees payment result', async ({ page }) => {
  const data = await fixture()
  await page.goto(data.guestUrl)
  await expect(page.getByTestId('normalized-guest-app')).toBeVisible()
  await expect(page.getByRole('button', { name: /本桌已点.*W01/ })).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await expect(page.locator('.guest-mood-options img')).toHaveCount(6)

  const recommendationLayout = await page.locator('.menu-recommendation-options').evaluate((element) => ({
    viewportWidth: element.clientWidth,
    contentWidth: element.scrollWidth,
    cardWidths: Array.from(element.children).map((child) => Math.round(child.getBoundingClientRect().width)),
  }))
  expect(recommendationLayout.contentWidth).toBeGreaterThan(recommendationLayout.viewportWidth)
  expect(Math.min(...recommendationLayout.cardWidths)).toBeGreaterThanOrEqual(238)

  const search = page.getByLabel('搜索菜单商品')
  await search.fill(data.bundleProductName)
  await page.getByRole('button', { name: `查看${data.bundleProductName}详情` }).first().click()
  const bundleDetail = page.getByRole('dialog', { name: `${data.bundleProductName}商品详情` })
  await expect(bundleDetail.getByText('这份组合包含')).toBeVisible()
  await expect(bundleDetail.locator('.menu-detail-components article').first()).toBeVisible()
  await bundleDetail.getByTitle('关闭商品详情').click()

  await search.fill(data.orderableProductName)
  const add = page.getByRole('button', { name: `加入${data.orderableProductName}` })
  await expect(add).toBeVisible()
  expect((await add.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(44)
  expect((await add.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  await add.click()
  const cartDockBackground = await page.locator('.menu-cart-dock').evaluate((element) => getComputedStyle(element).backgroundColor)
  expect(cartDockBackground).not.toMatch(/rgb\((?:0|1[0-9]|2[0-9]),\s*(?:0|1[0-9]|2[0-9]),\s*(?:0|1[0-9]|2[0-9])\)/)
  await page.getByRole('button', { name: '查看已选' }).click()
  const cart = page.getByRole('dialog', { name: '购物车明细' })
  await cart.getByPlaceholder('如：少冰、不要香菜、酒水和小食一起上').fill('浏览器验收备注')
  await cart.getByRole('button', { name: /确认订单并微信支付/ }).click()
  await page.getByRole('dialog', { name: '确认上单' }).getByRole('button', { name: '确认上单' }).click()

  const resultDialog = page.getByRole('dialog', { name: '订单与支付状态' })
  await expect(resultDialog.getByRole('heading', { name: '测试订单已建立' })).toBeVisible()
  await expect(resultDialog).toContainText('没有产生真实收款')
  await expect(page.getByText('备注已重点标记给出品和配送人员')).toBeVisible()
  await expect(page.getByText('本次应付')).toBeVisible()

  await resultDialog.getByRole('button', { name: '返回菜单' }).click()
  await page.getByRole('button', { name: /本桌已点/ }).click()
  const tableOrders = page.getByRole('dialog', { name: '本桌已点' })
  await expect(tableOrders).toContainText(data.orderableProductName)
  await expect(tableOrders).toContainText(/等待付款|准备中|已送齐/)
  await tableOrders.getByRole('button', { name: '关闭' }).click()

  await page.getByRole('button', { name: `加入${data.orderableProductName}` }).click()
  await page.getByRole('dialog', { name: '确认继续加单' }).getByRole('button', { name: '继续选商品' }).click()
  await page.getByRole('button', { name: '查看已选' }).click()
  await page.getByRole('dialog', { name: '购物车明细' }).getByRole('button', { name: /确认订单并微信支付/ }).click()
  await page.getByRole('dialog', { name: '确认上单' }).getByRole('button', { name: '确认上单' }).click()
  await expect(page.getByRole('alert')).toContainText(`本桌刚点过 ${data.orderableProductName}`)
  await expect(page.getByRole('button', { name: '确认继续加单' })).toBeVisible()
})

test('desktop guest keeps recommendations comparable without turning the cart into a dark bill bar', async ({ page }) => {
  const data = await fixture()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(data.guestUrl)
  await expect(page.getByTestId('normalized-guest-app')).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await expect(page.locator('.menu-recommendation-option')).toHaveCount(3)

  const cards = await page.locator('.menu-recommendation-option').evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect()
    return { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width) }
  }))
  expect(cards).toHaveLength(3)
  expect(new Set(cards.map((card) => card.top)).size).toBe(1)
  expect(Math.min(...cards.map((card) => card.width))).toBeGreaterThanOrEqual(230)

  await page.locator('.menu-recommendation-choose').first().click()
  const dockStyle = await page.locator('.menu-cart-dock').evaluate((element) => {
    const style = getComputedStyle(element)
    return { background: style.backgroundColor, height: Math.round(element.getBoundingClientRect().height) }
  })
  expect(dockStyle.background).not.toMatch(/rgb\((?:0|1[0-9]|2[0-9]),\s*(?:0|1[0-9]|2[0-9]),\s*(?:0|1[0-9]|2[0-9])\)/)
  expect(dockStyle.height).toBeLessThanOrEqual(90)
})

test('narrow mobile guest keeps mood and service controls compact above the menu', async ({ page }) => {
  const data = await fixture()
  for (const width of [320, 360, 390, 430]) {
    await page.setViewportSize({ width, height: width === 320 ? 568 : 800 })
    await page.goto(data.guestUrl)
    await expect(page.getByTestId('normalized-guest-app')).toBeVisible()

    const moodButtons = page.locator('.guest-mood-options button')
    await expect(moodButtons).toHaveCount(6)
    const moodRows = await moodButtons.evaluateAll((buttons) => new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top))).size)
    expect(moodRows, `${width}px mood controls wrapped`).toBe(1)
    expect((await page.locator('.guest-mood').boundingBox())?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(74)
    expect((await page.locator('.guest-service-strip').boundingBox())?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(58)
    expect((await page.locator('.guest-recommendation-entries').boundingBox())?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(60)
    expect((await page.locator('.menu-recommendation-option').first().boundingBox())?.y ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(420)
    if (width === 320) {
      const quickAdd = page.getByRole('button', { name: /快速加入/ }).first()
      const checkoutDock = page.getByRole('complementary', { name: '订单结算' })
      await expect(quickAdd).toBeVisible()
      const quickAddBox = await quickAdd.boundingBox()
      const dockBox = await checkoutDock.boundingBox()
      expect(quickAddBox).not.toBeNull()
      expect(dockBox).not.toBeNull()
      expect(quickAddBox!.y + quickAddBox!.height).toBeLessThanOrEqual(dockBox!.y)
      expect(quickAddBox!.width).toBeGreaterThanOrEqual(44)
      expect(quickAddBox!.height).toBeGreaterThanOrEqual(44)
      await quickAdd.click()
      await expect(checkoutDock).toContainText('已选 1 件')
    }
    await expectNoHorizontalOverflow(page)

    await page.goto(data.reservationUrl)
    await expect(page.getByTestId('reservation-booking')).toBeVisible()
    await expect(page.getByRole('button', { name: /核对预约信息/ })).toBeVisible()
    await expectNoHorizontalOverflow(page)
  }
})

test('mobile guest, reservation and staff work surfaces have no serious accessibility violations', async ({ page }) => {
  const data = await fixture()
  await page.setViewportSize({ width: 320, height: 800 })

  await page.goto(data.guestUrl)
  await expect(page.getByTestId('normalized-guest-app')).toBeVisible()
  const guest = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  expect(guest.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')).toEqual([])

  await page.goto(data.reservationUrl)
  await expect(page.getByTestId('reservation-booking')).toBeVisible()
  const reservation = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  expect(reservation.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')).toEqual([])

  await page.goto(data.staffUrl)
  await page.getByLabel('门店口令').fill(data.dailyCredential)
  await page.getByRole('button', { name: /验证设备/ }).click()
  await page.getByLabel('员工账号').fill(data.employeeCode)
  await page.getByLabel('四位 PIN').fill(data.employeePin)
  await page.getByRole('button', { name: /进入工作台/ }).click()
  await expect(page.getByTestId('normalized-workspace')).toBeVisible()
  const staffHome = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  expect(staffHome.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')).toEqual([])

  await page.getByRole('button', { name: '现场', exact: true }).first().click()
  await expect(page.getByRole('heading', { name: '找到桌台，直接处理' })).toBeVisible()
  const staffActions = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  expect(staffActions.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')).toEqual([])
})

test('mobile public reservation uses preferences without exposing exact table selection', async ({ page }) => {
  const data = await fixture()
  await page.goto(data.reservationUrl)
  await expect(page.getByTestId('reservation-booking')).toBeVisible()
  await expect(page.getByText('预约服务在线')).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await expect(page.getByRole('button', { name: /门店帮我安排/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /靠近舞台/ })).toBeVisible()
  await expect(page.getByText('座位自选')).toHaveCount(0)
  await page.getByRole('button', { name: /靠近舞台/ }).click()
  await page.getByLabel('怎么称呼您').fill('位置偏好验收')
  await page.getByLabel('手机或微信').fill('13800138000')
  await page.getByRole('button', { name: /核对预约信息/ }).click()
  await expect(page.getByRole('heading', { name: '提交预约申请' })).toBeVisible()
  await expect(page.getByText('靠近舞台', { exact: true })).toBeVisible()
  await expect(page.getByText('这是一份预约申请')).toBeVisible()
})

test('member page never invents a development member when identity is missing', async ({ page }) => {
  await page.goto('/member')
  await expect(page.getByText('登录后查看会员权益', { exact: true })).toBeVisible()
  await expect(page.getByText(/当前不会展示测试会员或虚构权益/)).toBeVisible()
  await expect(page.getByText('member-amy')).toHaveCount(0)
  await expectNoHorizontalOverflow(page)
})

test('mobile public reservation silently renews one expired session before submit', async ({ page }) => {
  const data = await fixture()
  let reservationAttempts = 0
  await page.route('**/api/public/reservations', async (route) => {
    if (route.request().method() !== 'POST' || reservationAttempts > 0) {
      await route.continue()
      return
    }
    reservationAttempts += 1
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'RESERVATION_SESSION_INVALID',
          message: '预约会话已失效，请重新进入预约页面',
        },
      }),
    })
  })

  await page.goto(data.reservationUrl)
  await expect(page.getByText('预约服务在线')).toBeVisible()
  await page.getByLabel('怎么称呼您').fill('会话恢复验收')
  await page.getByLabel('手机或微信').fill('13800138001')
  await page.getByRole('button', { name: /核对预约信息/ }).click()
  await page.getByRole('button', { name: '提交预约申请' }).click()

  await expect(page.getByRole('heading', { name: '等待门店确认' })).toBeVisible()
  await expect(page.getByText('门店确认后才正式生效')).toBeVisible()
  await expect(page.getByText(/临时锁位剩余/)).toHaveCount(0)
  await expect(page.getByText(/预约锁位剩余/)).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(reservationAttempts).toBe(1)
})

test('confirmed reservation starts its ten-minute arrival retention only at the scheduled arrival time', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-08-12T21:00:01+08:00') })
  await page.route('**/api/public/reservation/session', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: { status: 'active' } }),
  }))
  await page.route('**/api/public/reservations/reservation-arrival-grace-001', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      data: {
        publicId: 'reservation-arrival-grace-001', customerName: '王女士', maskedContact: '138****8000',
        guestCount: 2, arrivalAt: '2026-08-12T21:00:00+08:00', expectedEndAt: '2026-08-13T01:00:00+08:00',
        status: 'confirmed', arrivalState: 'not_arrived', note: null, seatPreference: 'stage_atmosphere',
        arrivalGraceEndsAt: '2026-08-12T21:10:00+08:00',
        cancellationPolicy: {},
      },
    }),
  }))

  await page.goto('/reserve?reservation=reservation-arrival-grace-001')

  await expect(page.getByRole('heading', { name: '预约已确认' })).toBeVisible()
  await expect(page.getByText('预约到店保留剩余 09:59')).toBeVisible()
  await expect(page.getByText('本次预约为您保留到 21:10；具体位置到店后由门迎安排。')).toBeVisible()
  await expect(page.getByText('VIP1')).toHaveCount(0)
  await expect(page.getByText(/临时锁位/)).toHaveCount(0)
  await expectNoHorizontalOverflow(page)
})

test('submitted reservation keeps its receipt and gives actionable guidance if status lookup is unavailable', async ({ page }) => {
  const data = await fixture()
  await page.route('**/api/public/reservations/reservation-*', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue()
      return
    }
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'RESERVATION_NOT_FOUND', message: '没有找到对应预约' },
      }),
    })
  })

  await page.goto(data.reservationUrl)
  await expect(page.getByText('预约服务在线')).toBeVisible()
  await page.getByLabel('怎么称呼您').fill('失联提示验收')
  await page.getByLabel('手机或微信').fill('13800138002')
  await page.getByRole('button', { name: /核对预约信息/ }).click()
  await page.getByRole('button', { name: '提交预约申请' }).click()
  await expect(page.getByRole('heading', { name: '等待门店确认' })).toBeVisible()
  await expect(page).toHaveURL(/reservation=reservation-/)

  await page.getByRole('button', { name: '刷新确认状态' }).click()
  await expect(page.getByRole('alert')).toContainText('请勿重复提交')
  await expect(page.getByRole('alert')).toContainText('预约编号')
  await expect(page.getByText('没有找到对应预约')).toHaveCount(0)
  await expect(page.getByText(/reservation-[0-9a-f-]{36}/)).toBeVisible()
})

test('mobile manager completes device verification and reaches role-scoped workspace', async ({ page }) => {
  const data = await fixture()
  await page.goto(data.staffUrl)
  await page.getByLabel('门店口令').fill(data.dailyCredential)
  await page.getByRole('button', { name: /验证设备/ }).click()
  await page.getByLabel('员工账号').fill(data.employeeCode)
  await page.getByLabel('四位 PIN').fill(data.employeePin)
  await page.getByRole('button', { name: /进入工作台/ }).click()

  await expect(page.getByTestId('normalized-workspace')).toBeVisible()
  await expect(page.getByRole('heading', { name: '李艳' })).toBeVisible()
  await expect(page.getByText(/店长/)).toBeVisible()
  await expect(page.getByRole('heading', { name: '现在要做什么' })).toBeVisible()
  for (const width of [320, 360, 390, 430]) {
    await page.setViewportSize({ width, height: 800 })
    await expectNoHorizontalOverflow(page)
    await expect(page.getByRole('heading', { name: '现在要做什么' })).toBeVisible()
    await expect(page.locator('.normalized-mobile-nav')).toBeVisible()
  }
  const liveSummary = page.getByRole('button', { name: /营业桌台.*1.*进行中/ })
  await expect(liveSummary).toBeVisible()
  await expect(page.getByText('0', { exact: true })).toHaveCount(0)

  await liveSummary.click()
  await expect(page.getByRole('heading', { name: '找到桌台，直接处理' })).toBeVisible()
  await expect(page.getByText('按需加载')).toHaveCount(0)
  await expect(page.getByText('available', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: /工作台/ }).click()

  await page.getByRole('button', { name: '预约到店', exact: true }).first().click()
  await expect(page.getByText('预约与到店', { exact: true })).toBeVisible()
  await expect(page.getByText('规范化改造中')).toHaveCount(0)
})

test('mobile administrator publishes a permission and sees server-verified feedback in view', async ({ page }) => {
  const data = await fixture()
  await page.goto(data.staffUrl)
  await page.getByLabel('门店口令').fill(data.dailyCredential)
  await page.getByRole('button', { name: /验证设备/ }).click()
  await page.getByLabel('员工账号').fill(data.adminEmployeeCode)
  await page.getByLabel('四位 PIN').fill(data.adminEmployeePin)
  await page.getByRole('button', { name: /进入工作台/ }).click()

  await expect(page.getByRole('heading', { name: '乌鸦' })).toBeVisible()
  await page.getByLabel('现在要做什么').getByRole('button', { name: '系统配置', exact: true }).click()
  await expect(page.getByRole('heading', { name: '管理员控制中心' })).toBeVisible()
  await expectNoHorizontalOverflow(page)

  await page.getByRole('button', { name: /岗位权限/ }).click()
  const editorHeading = page.getByRole('heading', { name: '岗位权限' })
  await expect(editorHeading).toBeVisible()
  await expect.poll(() => editorHeading.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return rect.top >= 0 && rect.bottom <= window.innerHeight
  })).toBe(true)
  await page.getByLabel('选择岗位').selectOption({ label: '系统管理员（1人）' })
  await page.getByPlaceholder('搜索权限名称').fill('订单折扣')
  const checkbox = page.getByRole('checkbox')
  await expect(checkbox).toHaveCount(1)
  await checkbox.check()
  await page.getByLabel('发布原因').fill('浏览器验收岗位职责调整')
  await page.getByRole('button', { name: '发布1项修改' }).click()

  const feedback = page.getByRole('status').filter({ hasText: '配置已发布并复核生效' })
  await expect(feedback).toBeVisible()
  await expect(feedback).toContainText('服务端已重新读取数据库')
  await expect.poll(() => feedback.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return rect.top >= 0 && rect.bottom <= window.innerHeight
  })).toBe(true)

  await page.getByRole('button', { name: /审批与范围/ }).click()
  await page.getByLabel('选择岗位').selectOption({ label: '系统管理员（1人）' })
  await page.getByLabel('订单折扣启用').check()
  await page.getByLabel('订单折扣单次上限').fill('1000')
  await page.getByRole('button', { name: '发布1项修改' }).click()
  await expect(page.getByRole('status').filter({ hasText: '1项配置已发布并复核生效' })).toBeVisible()

  await page.getByRole('button', { name: /入口与设备/ }).click()
  await page.getByLabel('选择岗位').selectOption({ label: '系统管理员（1人）' })
  await page.getByLabel('设备高频入口').check()
  await page.getByRole('button', { name: '发布1项修改' }).click()
  await expect(page.getByRole('status').filter({ hasText: '1项配置已发布并复核生效' })).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ path: 'artifacts/normalized-browser/staff-access-admin-mobile.png', fullPage: true })
})

test('mobile manager assists an open table order and gifts a product without mixing member benefits', async ({ page }) => {
  const data = await fixture()
  await page.goto(data.staffUrl)
  await page.getByLabel('门店口令').fill(data.dailyCredential)
  await page.getByRole('button', { name: /验证设备/ }).click()
  await page.getByLabel('员工账号').fill(data.employeeCode)
  await page.getByLabel('四位 PIN').fill(data.employeePin)
  await page.getByRole('button', { name: /进入工作台/ }).click()

  await page.getByRole('button', { name: '现场', exact: true }).first().click()
  await expect(page.getByRole('heading', { name: '找到桌台，直接处理' })).toBeVisible()
  await page.getByRole('button', { name: /W01.*已开台/ }).click()
  await expect(page.getByRole('button', { name: '协助点单' })).toBeVisible()
  await expect(page.getByRole('button', { name: '赠送商品' })).toBeVisible()
  await expect(page.getByText('会员权益')).toHaveCount(0)

  await page.getByRole('button', { name: '协助点单' }).click()
  const paidSheet = page.getByRole('dialog', { name: 'W01协助点单' })
  await paidSheet.getByLabel('搜索菜单商品').fill(data.orderableProductName)
  await paidSheet.getByRole('button', { name: `加入${data.orderableProductName}` }).click()
  await paidSheet.getByRole('button', { name: '查看已选' }).click()
  await paidSheet.getByRole('dialog', { name: '购物车明细' }).getByRole('button', { name: '核对无误，确认下单' }).click()
  await paidSheet.getByRole('dialog', { name: '确认上单' }).getByRole('button', { name: '确认上单' }).click()
  await expect(page.getByRole('status')).toContainText('W01 订单已挂桌并发送出品')

  await page.getByRole('button', { name: '赠送商品' }).click()
  const giftSheet = page.getByRole('dialog', { name: 'W01赠送商品' })
  await expect(giftSheet).toContainText('按本人岗位额度执行，赠送原因全程留痕')
  await expect(giftSheet.getByText('会员权益')).toHaveCount(0)
  await giftSheet.getByLabel('搜索点单商品').fill(data.orderableProductName)
  await giftSheet.getByRole('button', { name: `添加${data.orderableProductName}` }).click()
  await giftSheet.getByLabel('赠送原因').fill('浏览器验收生日关怀')
  await giftSheet.getByRole('button', { name: '确认赠送并出品' }).click()
  await expect(page.getByRole('status')).toContainText('W01 商品已赠送并发送出品')
})
