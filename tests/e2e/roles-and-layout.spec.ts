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
    await expect(page.locator('.guest-reply')).toHaveCount(0)

    releaseRequest()
    await expect(mood).toBeEnabled({ timeout: 8_000 })
  })

  test('关键响应包含点击劫持与内容嗅探保护', async ({ page }) => {
    await expectSecurityHeaders(page)
    const unauthorized = await page.request.get('/api/bootstrap')
    expect(unauthorized.status()).toBe(401)
  })
})
