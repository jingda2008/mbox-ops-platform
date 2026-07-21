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
    await expect(dock.getByRole('button', { name: /查看购物车，1件商品/ })).toContainText('¥88.00')
    await expect(dock.getByRole('button', { name: '确认订单并微信支付' })).toBeVisible()

    await dock.getByRole('button', { name: /查看购物车/ }).click()
    const drawer = page.getByRole('dialog', { name: '购物车明细' })
    await expect(drawer).toBeVisible()
    await expect(drawer.getByText('招牌鸡尾酒', { exact: true })).toBeVisible()
    expect((await drawer.boundingBox())?.height ?? 0).toBeGreaterThan(100)
    await drawer.getByTitle('增加招牌鸡尾酒').click()
    await expect(dock.getByRole('button', { name: /查看购物车，2件商品/ })).toContainText('¥176.00')

    await drawer.getByTitle('关闭购物车').click()
    await dock.getByRole('button', { name: '确认订单并微信支付' }).click()
    await expect(page.getByRole('dialog', { name: '确认上单' })).toBeVisible()
    await expectNoHorizontalOverflow(page)
  })

  test('平板点单优先展示商品，主动打开购物车后才显示金额和支付', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 })
    await page.goto('/guest?table=L01')

    await page.getByTitle('加入招牌鸡尾酒').click()
    const dock = page.getByRole('complementary', { name: '订单结算' })
    await expect(dock).toBeVisible()
    await expect(dock.locator('.menu-cart-summary > strong')).toBeHidden()
    await expect(dock.getByRole('button', { name: '确认订单并微信支付' })).toBeHidden()

    await dock.getByRole('button', { name: /查看购物车/ }).click()
    const drawer = page.getByRole('dialog', { name: '购物车明细' })
    await expect(drawer.getByText('招牌鸡尾酒', { exact: true })).toBeVisible()
    await expect(drawer.getByText('¥88.00', { exact: true })).toBeVisible()
    await expect(drawer.getByRole('button', { name: '确认订单并微信支付' })).toBeVisible()
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
