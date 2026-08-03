import { expect, test } from '@playwright/test'
import { expectNoHorizontalOverflow } from './helpers'

test.describe('高频移动端界面快速验收', () => {
  test('未开台桌码使用等待提示且不会误导客人重新扫码', async ({ page }) => {
    await page.setViewportSize({ width: 430, height: 932 })
    await page.goto('/guest?table=L04')

    await expect(page.getByText('座位正在为您准备')).toBeVisible()
    await expect(page.getByText('无需重新扫码，开台完成后会自动进入菜单。')).toBeVisible()
    await expect(page.getByText('请重新扫描桌面二维码')).toHaveCount(0)
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expectNoHorizontalOverflow(page)
  })

  test('客人点击酒水后立即看到商品且页面不横向挤压', async ({ page }) => {
    await page.setViewportSize({ width: 430, height: 932 })
    await page.goto('/guest?table=W01')

    await page.getByTestId('guest-menu-view-drinks').click()
    await expect(page.getByText('没有找到相关商品')).toHaveCount(0)
    await expect(page.locator('.menu-product').first()).toBeVisible()
    await expect(page.getByRole('navigation', { name: '酒水分类' })).toBeVisible()
    await expectNoHorizontalOverflow(page)
  })

  test('公众号预约首屏在常见手机宽度完整可用', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/reserve')

    await expect(page.getByRole('heading', { name: '今晚，给你留个好位置' })).toBeVisible()
    await expect(page.getByRole('button', { name: '直接预约' })).toBeVisible()
    await expect(page.getByRole('button', { name: '座位自选' })).toBeVisible()
    await expectNoHorizontalOverflow(page)
  })
})
