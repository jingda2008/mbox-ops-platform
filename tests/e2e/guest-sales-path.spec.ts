import { expect, test } from '@playwright/test'
import { expectNoHorizontalOverflow } from './helpers'

test.describe('客人推荐销售路径', () => {
  test('双人桌可忽略推荐工具直接浏览、搜索和查看组合详情', async ({ page }) => {
    await page.setViewportSize({ width: 430, height: 932 })
    await page.goto('/guest?table=W01')

    await expect(page.getByTestId('guest-recommendation-tools')).toBeVisible()
    await expect(page.getByText('今夜特别推荐')).toBeVisible()
    const comparison = page.getByRole('region', { name: '今夜推荐方案对比' })
    await expect(comparison.locator('.menu-recommendation-option')).toHaveCount(3)
    await expect(comparison.locator('.menu-recommendation-option.is-primary').getByText('人气优选')).toBeVisible()
    await expect(comparison).toContainText('轻松开始')
    await expect(comparison).toContainText('人气优选')
    await expect(comparison).toContainText('更完整')
    await expect(comparison.locator('.menu-recommendation-option')).toContainText(['¥', '¥', '¥'])
    await expect(comparison.locator('.menu-recommendation-choose')).toHaveCount(3)
    await expect(page.getByRole('button', { name: '看酒水' })).toBeVisible()
    await expect(page.getByRole('button', { name: '看小食' })).toBeVisible()
    const menuSearch = page.getByLabel('搜索菜单商品')
    await expect(menuSearch).toBeVisible()
    await expect(page.getByTestId('guest-menu-view-search')).toHaveClass(/is-search-shortcut/)

    await page.getByTestId('guest-menu-view-bundles').click()
    await expect(page.getByText('V3组合')).toHaveCount(0)
    await expect(page.getByTestId('menu-product-product-pair-ritual-night')).toContainText('今晚有点仪式感')
    await menuSearch.fill('COCKTAIL-001')
    await expect(page.getByTestId('menu-product-product-cocktail')).toBeVisible()
    await expect(page.locator('.menu-product')).toHaveCount(1)

    await page.getByTestId('guest-menu-view-recommend').click()
    await comparison.getByRole('button', { name: /查看.+详情/ }).first().click()
    const detail = page.getByRole('dialog', { name: /商品详情/ })
    await expect(detail).toContainText('今晚为您配好')
    await expect(detail).toContainText('按一轮集中准备')
    await expectNoHorizontalOverflow(page)
  })

  test('手机点击酒水后显示可售商品且页面宽度不发生变化', async ({ page }) => {
    await page.setViewportSize({ width: 430, height: 932 })
    await page.goto('/guest?table=W01')

    const widthBefore = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }))
    await page.getByTestId('guest-menu-view-drinks').click()
    await expect(page.getByText('没有找到相关商品')).toHaveCount(0)
    await expect(page.locator('.menu-product')).not.toHaveCount(0)
    await expect(page.getByRole('navigation', { name: '酒水分类' })).toBeVisible()
    await expect(page.getByTestId('menu-product-product-cocktail')).toBeVisible()
    const widthAfter = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }))
    expect(widthAfter).toEqual(widthBefore)
    await expectNoHorizontalOverflow(page)
  })

  test('过期桌次不再显示可点击的空菜单', async ({ page }) => {
    await page.route('**/api/guest/session?*', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'GUEST_SESSION_EXPIRED',
          message: '这次桌边服务已过期～重新扫一下桌面二维码，我们马上继续照顾您。',
        }),
      })
    })
    await page.setViewportSize({ width: 430, height: 932 })
    await page.goto('/guest?token=expired-session')

    await expect(page.getByRole('alert')).toContainText('请重新扫描桌面二维码')
    await expect(page.getByTestId('guest-menu-view-drinks')).toHaveCount(0)
    await expect(page.getByRole('navigation', { name: '桌台功能' })).toHaveCount(0)
    await expectNoHorizontalOverflow(page)
  })

  test('已打开的菜单在桌次失效后立即收起旧商品', async ({ page }) => {
    let expireSession = false
    await page.route('**/api/guest/session?*', async (route) => {
      if (!expireSession) {
        await route.continue()
        return
      }
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'GUEST_SESSION_EXPIRED',
          message: '这次桌边服务已过期～重新扫一下桌面二维码，我们马上继续照顾您。',
        }),
      })
    })
    await page.setViewportSize({ width: 430, height: 932 })
    await page.goto('/guest?table=W01')
    await expect(page.getByTestId('guest-menu-view-drinks')).toBeVisible()

    expireSession = true
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))

    await expect(page.getByRole('alert')).toContainText('请重新扫描桌面二维码')
    await expect(page.getByTestId('guest-menu-view-drinks')).toHaveCount(0)
    await expect(page.locator('.menu-product')).toHaveCount(0)
    await expectNoHorizontalOverflow(page)
  })

  test('服务页只保留四个高频入口和个性化需求，不再展示六项服务网格', async ({ page }) => {
    await page.setViewportSize({ width: 430, height: 932 })
    await page.goto('/guest?table=W01')
    await page.getByRole('navigation', { name: '桌台功能' }).getByRole('button', { name: '服务' }).click()

    const quickServices = page.getByRole('region', { name: '常用服务' })
    await expect(quickServices.getByRole('button')).toHaveCount(4)
    await expect(quickServices.getByRole('button', { name: '点歌' })).toBeVisible()
    await expect(quickServices.getByRole('button', { name: '生日安排' })).toBeVisible()
    await expect(quickServices.getByRole('button', { name: '呼叫服务员' })).toBeVisible()
    await expect(quickServices.getByRole('button', { name: '投诉/不满意' })).toBeVisible()
    await expect(page.getByText('呼叫服务', { exact: true })).toHaveCount(0)
    await expect(page.locator('.service-grid')).toHaveCount(0)
    await expect(page.getByText('还有其他需要？')).toBeVisible()
    await expect(page.getByPlaceholder(/两杯温水/)).toBeVisible()
    await expectNoHorizontalOverflow(page)
  })

  test('快速选择重排原菜单，摇一摇只从同一候选池给出最多三次灵感', async ({ page }) => {
    const behaviorEventStatuses: number[] = []
    page.on('response', (response) => {
      if (response.request().method() === 'POST' && response.url().includes('/api/guest/events')) {
        behaviorEventStatuses.push(response.status())
      }
    })
    await page.setViewportSize({ width: 430, height: 932 })
    await page.goto('/guest?table=W01')

    await page.getByTestId('guest-quick-select').click()
    await page.getByRole('button', { name: '轻松一点' }).click()
    await page.getByRole('button', { name: '清爽好入口' }).click()
    await page.getByRole('button', { name: '听完这一场' }).click()
    await expect(page.getByRole('dialog', { name: '今晚准备待多久？' })).toHaveCount(0)
    await expect(page.getByText('已按 2 位筛选')).toBeVisible()
    await expect(page.getByTestId('recommendation-updated-feedback')).toContainText('已按你的选择')
    await expect(page.locator('.menu-recommendation-option.is-primary')).toContainText('人气优选')

    await page.getByTestId('guest-quick-select').click()
    await page.getByRole('button', { name: '来点仪式感' }).click()
    await page.getByRole('button', { name: '慢慢喝有层次' }).click()
    await page.getByRole('button', { name: '今晚不赶时间' }).click()
    await expect(page.getByTestId('recommendation-updated-feedback')).toContainText('已按你的选择')
    await expect(page.locator('.menu-recommendation-option.is-primary')).toContainText('人气优选')
    await expect(page.getByTestId('recommendation-updated-feedback')).toHaveCount(0, { timeout: 5_000 })

    await page.getByTestId('guest-shake-pick').click()
    const shakeDialog = page.getByRole('dialog', { name: '根据今晚的选择替你挑一款' })
    await expect(shakeDialog).toBeVisible()
    await expect(shakeDialog).toContainText('1/3')
    await shakeDialog.getByRole('button', { name: '再摇一次' }).click()
    await expect(shakeDialog).toContainText('2/3')
    await shakeDialog.getByRole('button', { name: '再摇一次' }).click()
    await expect(shakeDialog).toContainText('3/3')
    await expect(shakeDialog.getByRole('button', { name: '再摇一次' })).toBeDisabled()
    await expect.poll(() => behaviorEventStatuses.length).toBeGreaterThanOrEqual(8)
    expect(behaviorEventStatuses).toEqual(expect.arrayContaining([202]))
    expect(behaviorEventStatuses.every((status) => status === 202)).toBe(true)
    await expectNoHorizontalOverflow(page)
  })
})
