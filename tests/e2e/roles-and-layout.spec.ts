import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { expectNoHorizontalOverflow, expectSecurityHeaders, useStaffIdentity } from './helpers'

const roleCases = [
  { actorId: 'emp-owner', actorName: '陈方宇', title: '老板工作台', allowed: '人员与岗位', denied: '' },
  { actorId: 'emp-chen', actorName: '李艳', title: '店长工作台', allowed: '现场调度', denied: '人员与岗位' },
  { actorId: 'emp-lin', actorName: 'Tom', title: '服务员工作台', allowed: '我的桌台', denied: '配置' },
  { actorId: 'emp-qing', actorName: '冷言志', title: '调酒师工作台', allowed: '酒水制作', denied: '配置' },
  { actorId: 'emp-han', actorName: '申良良', title: '厨房工作台', allowed: '餐品制作', denied: '收银/支付' },
  { actorId: 'emp-cashier', actorName: '三沐', title: '收银员工作台', allowed: '收银与退款', denied: '演出/点歌' },
] as const

test.describe('岗位权限隔离', () => {
  for (const role of roleCases) {
    test(`${role.actorName}只看到岗位所需入口`, async ({ page }) => {
      await useStaffIdentity(page, role.actorId, role.actorName)
      await page.goto('/')

      await expect(page.getByRole('heading', { name: role.title })).toBeVisible()
      await expect(page.locator('.sidebar nav').getByRole('button', { name: role.allowed })).toBeVisible()
      if (role.denied) {
        await expect(page.locator('.sidebar nav').getByRole('button', { name: role.denied })).toHaveCount(0)
      }
    })
  }

  test('李艳从首页和现场数字直达具体 SLA 与 KDS 待办', async ({ page }) => {
    await useStaffIdentity(page, 'emp-chen', '李艳')
    await page.route('**/api/bootstrap**', async (route) => {
      const response = await route.fetch()
      const raw = await response.text()
      if (!raw) {
        await route.fulfill({ response, body: raw })
        return
      }
      const data = JSON.parse(raw)
      const now = Date.now()
      const riskTask = (id: string, tableId: string, note: string) => ({
        id,
        tableId,
        tableSessionId: data.songState.tableSessions.find((session: { tableId: string }) => session.tableId === tableId)?.id ?? null,
        serviceTypeId: 'water',
        source: 'guest',
        note,
        status: 'pending',
        priority: 'high',
        ownerId: 'emp-lin',
        notifiedEmployeeIds: ['emp-lin', 'emp-chen'],
        createdAt: new Date(now - 180_000).toISOString(),
        updatedAt: new Date(now - 180_000).toISOString(),
        acceptedAt: null,
        arrivedAt: null,
        completedAt: null,
        warningAt: new Date(now - 120_000).toISOString(),
        escalateAt: new Date(now + 60_000).toISOString(),
        managerAt: new Date(now + 180_000).toISOString(),
        escalationLevel: 0,
        configVersion: data.config.version,
        customerReply: '已收到',
        actionScript: ['到桌确认需求', '完成后点击完成'],
        resolution: null,
        triggerId: null,
        archivedAt: null,
        archiveOutcome: null,
        archivedFromStatus: null,
      })
      data.tasks = [
        ...data.tasks,
        riskTask('e2e-risk-l01', 'table-l01', 'L01需要加水'),
        riskTask('e2e-risk-i01', 'table-i01', 'I01需要柠檬'),
      ]
      data.metrics = { ...data.metrics, openTasks: data.metrics.openTasks + 2, atRiskTasks: 2 }
      const station = data.config.workstations[0]
      data.orderDomain.kdsTasks = [{
        id: 'e2e-kds-l01',
        orderId: 'e2e-order-l01',
        orderItemId: 'e2e-item-l01',
        tableSessionId: data.songState.tableSessions.find((session: { tableId: string }) => session.tableId === 'table-l01')?.id,
        tableCode: 'L01',
        stationId: station.id,
        itemName: '招牌鸡尾酒',
        specification: '1杯',
        quantity: 1,
        status: 'queued',
        workstation: { ...station, configVersion: data.config.version },
        productionSla: { targetSeconds: 180, dueAt: new Date(now + 120_000).toISOString() },
        pickupSla: { targetSeconds: 60, dueAt: null },
        deliveryServiceTask: null,
        remakeOf: null,
        exceptionEvents: [],
        queuedAt: new Date(now - 60_000).toISOString(),
        startedAt: null,
        startedBy: null,
        completedAt: null,
        completedBy: null,
        pickedUpAt: null,
        pickedUpBy: null,
        deliveredAt: null,
        deliveredBy: null,
      }]
      await route.fulfill({ response, json: data })
    })
    await page.goto('/')

    await expect(page.getByRole('heading', { name: '店长工作台' })).toBeVisible()
    await page.locator('.role-home__next-action').getByRole('button', { name: /开始处理/ }).click()
    await expect(page.getByRole('heading', { name: '服务任务' })).toBeVisible()
    await expect(page.locator('.task-queue__focus')).toContainText('仅看 SLA 风险 · 2项')
    await expect(page.locator('.task-item')).toHaveCount(2)

    await page.getByTitle('打开导航').click()
    await page.locator('.sidebar nav').getByRole('button', { name: '首页' }).click()
    await page.getByTitle('打开KDS 待办').click()
    await expect(page.getByRole('heading', { name: '订单与出品' })).toBeVisible()
    await expect(page.getByRole('button', { name: /出品履约/ })).toHaveClass(/is-active/)
    await expect(page.locator('#kds-task-e2e-kds-l01')).toBeVisible()

    await page.getByTitle('打开导航').click()
    await page.locator('.sidebar nav').getByRole('button', { name: '现场调度' }).click()
    const occupied = page.locator('.table-tile.status-occupied').filter({ hasText: 'L01' }).first()
    const available = page.locator('.table-tile.status-available').filter({ hasText: 'L04' }).first()
    await expect(occupied).toContainText('营业中')
    await expect(available).toContainText('未开台')
    const colors = await page.locator('.floor-operations').evaluate(() => {
      const occupiedTable = document.querySelector<HTMLElement>('.table-tile.status-occupied')
      const availableTable = document.querySelector<HTMLElement>('.table-tile.status-available')
      return [getComputedStyle(occupiedTable!).backgroundColor, getComputedStyle(availableTable!).backgroundColor]
    })
    expect(colors[0]).not.toBe(colors[1])

    await occupied.click()
    await page.getByRole('button', { name: '查看SLA风险2项' }).click()
    await expect(page.locator('.task-queue__focus')).toContainText('仅看 SLA 风险 · 2项')
    await expect(page.getByRole('heading', { name: '待处理队列' })).toBeVisible()
  })
})

test.describe('视觉与移动端适配', () => {
  test('iPhone 14 Pro Max 员工页面使用抽屉导航且没有横向溢出', async ({ page }) => {
    await page.setViewportSize({ width: 430, height: 932 })
    await useStaffIdentity(page, 'emp-lin', 'Tom')
    await page.goto('/')

    await expect(page.getByRole('heading', { name: '服务员工作台' })).toBeVisible()
    await expect(page.locator('html')).toHaveClass(/staff-phone-device/)
    await expectNoHorizontalOverflow(page)

    await page.getByTitle('打开导航').click()
    await expect(page.locator('.sidebar')).toHaveClass(/is-open/)
    await page.locator('.sidebar nav').getByRole('button', { name: '我的桌台' }).click()
    await expect(page.getByRole('heading', { name: '全店现场' })).toBeVisible()
    await expectNoHorizontalOverflow(page)
  })

  test('客人点单页在手机上无严重可访问性问题和横向溢出', async ({ page }) => {
    await page.setViewportSize({ width: 430, height: 932 })
    await page.goto('/guest?table=L01')
    await expect(page.getByRole('heading', { name: '休闲01' })).toBeVisible()
    await expect(page.getByRole('navigation', { name: '桌台功能' })).toBeVisible()
    await expectNoHorizontalOverflow(page)

    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
    expect(results.violations.filter((item) => ['serious', 'critical'].includes(item.impact ?? ''))).toEqual([])
  })

  test('情绪选择不等待网络即可立即高亮，送达失败前不误报完成', async ({ page }) => {
    await page.setViewportSize({ width: 430, height: 932 })
    let releaseRequest = () => undefined
    const requestGate = new Promise<void>((resolve) => { releaseRequest = resolve })
    await page.route('**/api/guest/tasks', async (route) => {
      await requestGate
      await route.continue()
    })
    await page.goto('/guest?table=L01')

    const mood = page.getByRole('button', { name: '微醺' })
    await mood.click()
    await expect(mood).toHaveAttribute('aria-pressed', 'true', { timeout: 300 })
    await expect(mood).toHaveAttribute('data-action-state', 'pending', { timeout: 300 })
    await expect(mood).toHaveAttribute('aria-busy', 'true')
    await expect(page.locator('.guest-reply')).toHaveCount(0)

    releaseRequest()
    await expect(mood).toBeEnabled({ timeout: 8_000 })
    await expect(mood).not.toHaveAttribute('data-action-state', 'pending')
  })

  test('异步提交失败时恢复情绪选择并给出明确失败反馈', async ({ page }) => {
    await page.setViewportSize({ width: 430, height: 932 })
    await page.route('**/api/guest/tasks', async (route) => {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ message: '测试网络暂时不可用' }),
      })
    })
    await page.goto('/guest?table=L01')

    const mood = page.getByRole('button', { name: '微醺' })
    await mood.click()
    await expect(mood).toHaveAttribute('aria-pressed', 'false')
    await expect(mood).toHaveAttribute('data-action-state', 'failed')
    await expect(page.getByRole('alert')).toContainText('测试网络暂时不可用')
  })

  test('关键响应包含点击劫持与内容嗅探保护', async ({ page }) => {
    await expectSecurityHeaders(page)
    const unauthorized = await page.request.get('/api/bootstrap')
    expect(unauthorized.status()).toBe(401)
  })
})
