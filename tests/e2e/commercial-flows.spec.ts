import { expect, test } from '@playwright/test'
import { useStaffIdentity } from './helpers'

test.describe.serial('跨客户端经营流转', () => {
  test('客人个性化需求由责任服务员接单、到桌并完成', async ({ browser }) => {
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
    await task.getByRole('button', { name: '接单' }).click()
    await expect(task.getByRole('button', { name: '已到桌' })).toBeVisible()
    await task.getByRole('button', { name: '已到桌' }).click()
    await expect(task.getByRole('button', { name: '完成服务' })).toBeVisible()
    await task.getByRole('button', { name: '完成服务' }).click()
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
    await reservationPage.getByLabel('怎么称呼你').fill(customerName)
    await reservationPage.getByLabel('手机号').fill('13800138000')
    await reservationPage.getByRole('button', { name: '提交预约' }).click()
    await expect(reservationPage.getByRole('status')).toContainText('收到啦')
    await expect(reservationPage.locator('.public-reservation-history article')).toHaveCount(1)
    await expect(reservationPage.locator('.public-reservation-history article')).toContainText('等门店确认')

    const staffContext = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
    const staffPage = await staffContext.newPage()
    await useStaffIdentity(staffPage, 'emp-chen', '李艳')
    await staffPage.goto('/')
    await staffPage.getByTitle('打开导航').click()
    await staffPage.locator('.sidebar nav').getByRole('button', { name: '预约' }).click()
    await expect(staffPage.getByRole('heading', { name: '预约接待台' })).toBeVisible()
    await staffPage.getByRole('button', { name: '未来7个营业日' }).click()
    await staffPage.getByLabel('搜索预约').fill(customerName)
    await expect(staffPage.getByText(customerName)).toBeVisible()

    await staffContext.close()
    await guestContext.close()
  })

  test('李艳可从巡场预约警报直接进入本营业日预约并完成确认', async ({ page }) => {
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
})
