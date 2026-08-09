import { expect, test, type Locator } from '@playwright/test'
import { openStaffNavigation, useStaffIdentity } from './helpers'

async function expectVisibleTouchTargetsAtLeast44(
  locator: Locator,
) {
  const undersized = await locator.evaluateAll(async (elements) => {
    await new Promise((resolve) => window.setTimeout(resolve, 220))
    return elements
      .filter((element) => {
        const style = window.getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0 && rect.height < 44
      })
      .map((element) => {
        const rect = element.getBoundingClientRect()
        return {
          label: element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent?.trim() || element.tagName,
          height: Math.round(rect.height * 100) / 100,
        }
      })
  })
  expect(undersized).toEqual([])
}

test.describe.serial('跨客户端经营流转', () => {
  test('客人个性化需求由责任服务员两步处理并完成', async ({ browser }) => {
    const requestNote = `E2E两杯温水-${Date.now()}`
    const guestContext = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
    const guestPage = await guestContext.newPage()
    await guestPage.goto('/guest?table=L01')
    await expect(guestPage.getByRole('heading', { name: '休闲01' })).toBeVisible()
    await guestPage.getByRole('navigation', { name: '桌台功能' }).getByRole('button', { name: '服务' }).click()
    await guestPage.getByPlaceholder(/两杯温水/).fill(requestNote)
    await guestPage.getByRole('button', { name: '告诉我们' }).click()
    await expect(guestPage.getByRole('status')).toContainText('这个特别需求已经交给Tom')
    await expect(guestPage.locator('.guest-progress .guest-task').filter({ hasText: '个性化需求' })).toBeVisible()

    const staffContext = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
    const staffPage = await staffContext.newPage()
    await useStaffIdentity(staffPage, 'emp-lin', 'Tom')
    await staffPage.goto('/')
    await staffPage.getByRole('button', { name: /开始处理/ }).click()

    const task = staffPage.locator('.task-item').filter({ hasText: requestNote })
    await expect(task).toBeVisible()
    await expect(task).toContainText('休闲01')
    await task.getByRole('button', { name: '开始处理' }).click()
    await expect(task.getByRole('button', { name: '完成', exact: true })).toBeVisible()
    await task.getByRole('button', { name: '完成', exact: true }).click()
    await expect(task).toHaveCount(0)

    await expect(guestPage.locator('.guest-progress .guest-task').filter({ hasText: '个性化需求' })).toHaveCount(0, { timeout: 15_000 })
    await expect(guestPage.locator('.guest-reply')).toHaveCount(0, { timeout: 15_000 })

    await staffContext.close()
    await guestContext.close()
  })

  test('手机预约实时进入店长预约台', async ({ browser }) => {
    const customerName = `验收客人${Date.now().toString().slice(-6)}`
    const guestContext = await browser.newContext({
      viewport: { width: 430, height: 932 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    })
    const reservationPage = await guestContext.newPage()
    await reservationPage.goto('/reserve')
    await expect(reservationPage.getByRole('heading', { name: '今晚，给你留个好位置' })).toBeVisible()
    expect(await reservationPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await reservationPage.getByRole('button', { name: '直接预约' }).click()
    await expect(reservationPage.getByRole('heading', { name: '确认预约安排' })).toBeVisible()
    await reservationPage.getByLabel('怎么称呼你').fill(customerName)
    await reservationPage.getByLabel('手机号').fill('13800138000')
    await reservationPage.getByRole('button', { name: '提交预约' }).click()
    await expect(reservationPage.getByRole('status')).toContainText('预约申请已收到')
    await expect(reservationPage.locator('.public-reservation-history article')).toHaveCount(1)
    await expect(reservationPage.locator('.public-reservation-history article')).toContainText('等门店确认')

    const staffContext = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
    const staffPage = await staffContext.newPage()
    await useStaffIdentity(staffPage, 'emp-chen', '李艳')
    await staffPage.goto('/')
    await openStaffNavigation(staffPage, '预约')
    await expect(staffPage.getByRole('heading', { name: '预约接待台' })).toBeVisible()
    await staffPage.getByRole('button', { name: '未来7个营业日' }).click()
    await staffPage.getByLabel('搜索预约').fill(customerName)
    await expect(staffPage.getByText(customerName)).toBeVisible()

    await staffContext.close()
    await guestContext.close()
  })

  test('客人自选座位后后台显示桌号且同一时段不能重复预约', async ({ browser }) => {
    const customerName = `自选桌客人${Date.now().toString().slice(-6)}`
    const guestContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    })
    const reservationPage = await guestContext.newPage()
    await reservationPage.goto('/reserve')
    await reservationPage.getByRole('button', { name: '座位自选' }).click()
    await expect(reservationPage.getByRole('heading', { name: '选个喜欢的位置' })).toBeVisible()
    expect(await reservationPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await reservationPage.getByRole('tab', { name: /^室内全景/ }).click()
    await expect(reservationPage.getByRole('button', { name: 'S01 可以预约' })).toBeVisible()
    await expect(reservationPage.getByRole('button', { name: 'W01 可以预约' })).toHaveCount(0)
    await reservationPage.getByRole('tab', { name: /^室外区域/ }).click()
    await expect(reservationPage.getByRole('button', { name: 'W01 可以预约' })).toBeVisible()
    await expect(reservationPage.getByRole('button', { name: 'S01 可以预约' })).toHaveCount(0)
    await reservationPage.getByRole('tab', { name: /^舞台侧/ }).click()
    const vip1 = reservationPage.getByRole('button', { name: 'VIP1 可以预约' })
    await vip1.click()
    await expect(reservationPage.locator('.public-reservation-seat-detail')).toBeInViewport()
    const mapBox = await reservationPage.locator('.public-reservation-map-viewport').boundingBox()
    expect(mapBox).not.toBeNull()
    expect(mapBox!.x).toBeGreaterThanOrEqual(0)
    expect(mapBox!.x + mapBox!.width).toBeLessThanOrEqual(390)
    await reservationPage.getByRole('button', { name: '选择VIP1，下一步' }).click()
    await reservationPage.getByLabel('怎么称呼你').fill(customerName)
    await reservationPage.getByLabel('手机号').fill('13900139000')
    await reservationPage.getByRole('button', { name: '提交预约' }).click()
    await expect(reservationPage.getByRole('status')).toContainText('VIP1预约申请')
    await expect(reservationPage.locator('.public-reservation-history article')).toContainText('VIP1')

    const staffContext = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
    const staffPage = await staffContext.newPage()
    await useStaffIdentity(staffPage, 'emp-chen', '李艳')
    await staffPage.goto('/')
    await openStaffNavigation(staffPage, '预约')
    await staffPage.getByRole('button', { name: '未来7个营业日' }).click()
    await staffPage.getByLabel('搜索预约').fill(customerName)
    const reservation = staffPage.locator('.reservation-row').filter({ hasText: customerName })
    await expect(reservation).toContainText('VIP1')
    await expect(reservation).toContainText('客人自选')

    await staffContext.close()
    await guestContext.close()
  })

  test('李艳可从巡场预约警报直接进入本营业日预约并完成确认', async ({ page }) => {
    await page.setViewportSize({ width: 430, height: 932 })
    const customerName = `巡场预约${Date.now().toString().slice(-6)}`
    const actorHeaders = {
      'x-mbox-actor-id': 'emp-chen',
      'x-mbox-store-id': 'mbox-lujiazui',
    }
    const bootstrap = await page.request.get('/api/bootstrap', { headers: actorHeaders })
    expect(bootstrap.ok()).toBeTruthy()
    const businessDate = String((await bootstrap.json()).store.businessDate)
    const created = await page.request.post('/api/reservations', {
      headers: actorHeaders,
      data: {
        customerReference: customerName,
        customerName,
        phone: '13800138000',
        sourceCode: 'phone',
        partySize: 4,
        scheduledAt: `${businessDate}T20:30:00+08:00`,
        depositRequiredAmount: 0,
        depositCurrency: 'CNY',
        salesEmployeeId: 'emp-chen',
        idempotencyKey: `e2e-duty-reservation-${crypto.randomUUID()}`,
      },
    })
    expect(created.status()).toBe(201)

    await useStaffIdentity(page, 'emp-chen', '李艳')
    await page.goto('/')
    await page.getByRole('button', { name: 'AI值班经理' }).click()
    const effectiveness = page.getByRole('region', { name: '今日经营成效' })
    await expect(effectiveness).toBeVisible()
    await expect(effectiveness).toContainText('按时响应')
    await expect(effectiveness).toContainText('净实收')
    await expect(effectiveness).toContainText('投诉闭环')
    await expect(effectiveness).toContainText('负荷率')
    await expect(effectiveness).toContainText('待对账')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    const resolveRiskButton = page.getByRole('button', { name: `接管并处理：${customerName}的今日预约待确认` })
    await expect(resolveRiskButton).toBeVisible()
    await expect(page.getByText('AI建议').first()).toBeVisible()
    await resolveRiskButton.click()

    await expect(page.getByRole('heading', { name: '预约接待台' })).toBeVisible()
    await expect(page.getByRole('button', { name: '本营业日' })).toHaveClass(/is-active/)
    await expect(page.getByLabel('搜索预约')).toHaveValue(customerName)
    const reservation = page.locator('.reservation-row').filter({ hasText: customerName })
    await expect(reservation).toBeVisible()
    await expect(reservation).toHaveClass(/is-ai-focus/)
    await reservation.getByRole('button', { name: '确认预约' }).click()
    await expect(page.getByRole('status')).toContainText('预约已确认')
    await expect(reservation).toContainText('已确认')

    const briefing = await page.request.get('/api/assistant/briefing', { headers: actorHeaders })
    expect(briefing.ok()).toBeTruthy()
    expect(JSON.stringify((await briefing.json()).risks)).not.toContain(customerName)
  })

  test('移动预约高频控件可触达且延迟失败会即时反馈并恢复状态', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const customerName = `移动反馈${Date.now().toString().slice(-6)}`
    const actorHeaders = {
      'x-mbox-actor-id': 'emp-chen',
      'x-mbox-store-id': 'mbox-lujiazui',
    }
    const bootstrap = await page.request.get('/api/bootstrap', { headers: actorHeaders })
    expect(bootstrap.ok()).toBeTruthy()
    const businessDate = String((await bootstrap.json()).store.businessDate)
    const created = await page.request.post('/api/reservations', {
      headers: actorHeaders,
      data: {
        customerReference: customerName,
        customerName,
        phone: '13800138000',
        sourceCode: 'phone',
        partySize: 2,
        scheduledAt: `${businessDate}T21:00:00+08:00`,
        depositRequiredAmount: 0,
        depositCurrency: 'CNY',
        salesEmployeeId: 'emp-chen',
        idempotencyKey: `e2e-mobile-reservation-${crypto.randomUUID()}`,
      },
    })
    expect(created.status()).toBe(201)
    const reservationId = String((await created.json()).id)

    await page.route(`**/api/reservations/${reservationId}/actions`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        json: { message: '预约服务暂时不可用，请重试' },
      })
    })

    await useStaffIdentity(page, 'emp-chen', '李艳')
    await page.goto('/')
    await openStaffNavigation(page, '预约')
    await expect(page.getByRole('heading', { name: '预约接待台' })).toBeVisible()
    await page.getByRole('button', { name: '未来7个营业日' }).click()
    await page.getByLabel('搜索预约').fill(customerName)
    const reservation = page.locator('.reservation-row').filter({ hasText: customerName })
    await expect(reservation).toBeVisible()

    await expectVisibleTouchTargetsAtLeast44(page.locator([
      '.reservation-heading-actions button',
      '.waitlist-heading > button',
      '.reservation-toolbar button',
      '.reservation-search input',
      '.reservation-status-filter',
      '.reservation-actions button',
    ].join(',')))

    await page.getByRole('button', { name: '登记候补' }).click()
    await expectVisibleTouchTargetsAtLeast44(page.locator([
      '.waitlist-create input',
      '.waitlist-create select',
      '.waitlist-area-picks button',
      '.waitlist-create > button',
    ].join(',')))
    await page.getByRole('button', { name: '关闭', exact: true }).click()

    await page.getByRole('button', { name: '新建预约' }).click()
    await expectVisibleTouchTargetsAtLeast44(page.locator([
      '.reservation-form-grid input',
      '.reservation-form-grid select',
      '.reservation-form-grid > button',
    ].join(',')))
    await page.getByRole('button', { name: '关闭创建' }).click()

    await reservation.getByRole('button', { name: '修改人数/时间' }).click()
    await expectVisibleTouchTargetsAtLeast44(page.locator([
      '.reservation-operation input',
      '.reservation-operation select',
      '.operation-area-picks button',
      '.operation-actions button',
    ].join(',')))
    await page.locator('.reservation-operation').getByRole('button', { name: '返回' }).click()

    await reservation.getByRole('button', { name: '确认预约' }).click()
    await expect(reservation.getByText('已确认', { exact: true })).toBeVisible({ timeout: 500 })
    await expect(page.getByRole('status')).toContainText('预约服务暂时不可用，请重试；状态已恢复', { timeout: 4_000 })
    await expect(reservation.getByText('待确认', { exact: true })).toBeVisible()
    await expect(reservation.getByRole('button', { name: '确认预约' })).toBeEnabled()
  })
})
