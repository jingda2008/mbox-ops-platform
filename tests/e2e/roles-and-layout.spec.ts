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

  test('顾客端购物车与金额合并到底部支付栏，明细按需展开', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/guest?table=L01')

    await page.getByTitle('加入招牌鸡尾酒').click()
    await expect(page.locator('.menu-cart-panel')).toHaveCount(0)
    const dock = page.getByRole('complementary', { name: '订单结算' })
    await expect(dock).toBeVisible()
    await expect(dock.getByRole('button', { name: /查看购物车，已选1件/ })).toContainText('已选 1 件')
    await expect(dock.getByRole('button', { name: /查看购物车，已选1件/ })).toContainText('查看明细 · 合计 ¥88')
    await expect(dock.getByRole('button', { name: '核对订单' })).toBeVisible()
    await expect(page.getByRole('button', { name: '确认订单并微信支付' })).toHaveCount(0)

    await dock.getByRole('button', { name: '核对订单' }).click()
    const drawer = page.getByRole('dialog', { name: '购物车明细' })
    await expect(drawer).toBeVisible()
    await expect(drawer.getByText('招牌鸡尾酒', { exact: true })).toBeVisible()
    await expect(drawer.getByRole('button', { name: '确认订单并微信支付' })).toBeVisible()
    expect((await drawer.boundingBox())?.height ?? 0).toBeGreaterThan(100)
    await drawer.getByTitle('增加招牌鸡尾酒').click()
    await expect(dock.getByRole('button', { name: /查看购物车，已选2件/ })).toContainText('查看明细 · 合计 ¥176')

    await drawer.getByTitle('关闭购物车').click()
    await dock.getByRole('button', { name: '核对订单' }).click()
    await page.getByRole('dialog', { name: '购物车明细' }).getByRole('button', { name: '确认订单并微信支付' }).click()
    await expect(page.getByRole('dialog', { name: '确认上单' })).toBeVisible()
    await expectNoHorizontalOverflow(page)
  })

  test('平板点单优先展示商品，主动打开购物车后才显示金额和支付', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 })
    await page.goto('/guest?table=L01')

    await page.getByTitle('加入招牌鸡尾酒').click()
    const dock = page.getByRole('complementary', { name: '订单结算' })
    await expect(dock).toBeVisible()
    await expect(dock.locator('.menu-cart-summary-copy small')).toBeHidden()
    await expect(dock.getByRole('button', { name: '核对订单' })).toBeHidden()

    await dock.getByRole('button', { name: /查看购物车/ }).click()
    const drawer = page.getByRole('dialog', { name: '购物车明细' })
    await expect(drawer.getByText('招牌鸡尾酒', { exact: true })).toBeVisible()
    await expect(drawer.getByText('¥88', { exact: true })).toBeVisible()
    await expect(drawer.getByRole('button', { name: '确认订单并微信支付' })).toBeVisible()
    await expectNoHorizontalOverflow(page)
  })

  test('员工没有已开桌台时不能提交空桌号订单', async ({ page }) => {
    await useStaffIdentity(page, 'emp-chen', '李艳')
    let orderRequests = 0
    await page.route('**/api/bootstrap**', async (route) => {
      const headers = { ...route.request().headers() }
      delete headers['if-none-match']
      const response = await route.fetch({ headers })
      const data = await response.json()
      data.tables = data.tables.map((table: { status: string }) => ({ ...table, status: 'available' }))
      await route.fulfill({ response, json: data })
    })
    await page.route('**/api/commerce/orders', async (route) => {
      orderRequests += 1
      await route.continue()
    })
    await page.goto('/')
    await page.getByTitle('打开导航').click()
    await page.locator('.sidebar nav').getByRole('button', { name: '订单与出品' }).click()

    await expect(page.getByText('尚未选择桌台')).toBeVisible()
    await expect(page.getByLabel('选择桌台')).toBeDisabled()
    await page.getByTitle('加入招牌鸡尾酒').click()
    await expect(page.getByText('当前没有已开台桌台，请先到“现场调度”开台')).toBeVisible()
    await page.getByRole('button', { name: /查看购物车/ }).click()
    await expect(page.getByRole('dialog', { name: '购物车明细' }).getByRole('button', { name: '请先选择桌台' })).toBeDisabled()
    expect(orderRequests).toBe(0)
  })

  test('员工协助点单默认收起金额，选桌后才可核对并进入支付', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await useStaffIdentity(page, 'emp-chen', '李艳')
    await page.goto('/')
    await page.locator('.sidebar nav').getByRole('button', { name: '订单与出品' }).click()

    const tableSelect = page.getByLabel('选择桌台')
    await expect(tableSelect).toHaveValue('')
    await expect(page.getByText('请先选择客人所在桌台，再开始核对订单')).toBeVisible()
    await page.getByTitle('加入招牌鸡尾酒').click()

    await expect(page.locator('.menu-cart-panel')).toHaveCount(0)
    const dock = page.getByRole('complementary', { name: '订单结算' })
    const summary = dock.getByRole('button', { name: /查看购物车，已选1件/ })
    await expect(summary).toContainText('已选 1 件')
    await expect(summary).toContainText('需要时打开核对')
    await expect(summary).not.toContainText('¥88')
    await expect(dock.getByRole('button', { name: '请先选择桌台' })).toBeDisabled()

    await tableSelect.selectOption('table-l01')
    await dock.getByRole('button', { name: '核对订单' }).click()
    const drawer = page.getByRole('dialog', { name: '购物车明细' })
    await expect(drawer.getByText('招牌鸡尾酒', { exact: true })).toBeVisible()
    await expect(drawer.getByText('¥88', { exact: true })).toBeVisible()
    await expect(drawer.getByRole('button', { name: '核对无误，确认下单' })).toBeEnabled()

    await page.route('**/api/commerce/orders', async (route) => {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'COMMERCE_TABLE_NOT_OPEN',
          message: '桌台尚未开台或已经翻台，请先开台后再下单',
        }),
      })
    })
    await drawer.getByRole('button', { name: '核对无误，确认下单' }).click()
    await page.getByRole('dialog', { name: '确认上单' }).getByRole('button', { name: '确认上单' }).click()
    await expect(page.locator('.notice-bar.is-error')).toContainText('下单未完成：桌台尚未开台或已经翻台，请先开台后再下单')
    await expect(page.getByRole('dialog', { name: '确认上单' })).toContainText('桌台尚未开台或已经翻台，请先开台后再下单')
    await expect(page.getByRole('dialog', { name: '购物车明细' })).toContainText('招牌鸡尾酒')
    await expectNoHorizontalOverflow(page)
  })

  test('AI能力中心清楚区分服务端执行与人工审计且移动端不溢出', async ({ page }) => {
    await page.setViewportSize({ width: 430, height: 932 })
    await useStaffIdentity(page, 'emp-owner', '陈方宇')
    await page.goto('/')

    await page.getByTitle('打开导航').click()
    await page.locator('.sidebar nav').getByRole('button', { name: '配置' }).click()
    await expect(page.getByRole('heading', { name: '服务与调度' })).toBeVisible()
    await expect(page.getByText('AI可执行能力中心')).toBeVisible()
    await expect(page.getByText('人工操作·全程审计').first()).toBeVisible()
    await expect(page.getByText('确认后服务端执行').first()).toBeVisible()
    await expect(page.getByLabel('人工申请退款自然语言别名')).toBeVisible()
    await expectNoHorizontalOverflow(page)
  })

  test('移动端语音模式加载门店动态热词且保持单屏宽度', async ({ page }) => {
    await page.setViewportSize({ width: 430, height: 932 })
    await useStaffIdentity(page, 'emp-lin', 'Tom')
    await page.goto('/')

    await page.getByRole('button', { name: 'AI值班经理' }).click()
    await expect(page.getByRole('heading', { name: '还想处理别的事？' })).toBeVisible()
    await page.getByText('语音偏好与识别状态').click()
    await expect(page.getByText(/个控件 · \d+ 个热词/)).toBeVisible()
    await expectNoHorizontalOverflow(page)
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
