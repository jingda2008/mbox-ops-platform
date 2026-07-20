import { expect, test } from '@playwright/test'
import { useStaffIdentity } from './helpers'

test('李艳可在出品履约中直接取消未送达酒水并留下原因', async ({ page }) => {
  await useStaffIdentity(page, 'emp-chen', '李艳')
  await page.goto('/')
  await page.getByTitle('打开导航').click()
  await page.locator('.sidebar nav').getByRole('button', { name: '订单与出品' }).click()
  await expect(page.getByRole('heading', { name: '岗位履约工作台' })).toBeVisible()

  const product = page.locator('.menu-product').filter({ hasText: '精酿啤酒' }).first()
  await product.getByTitle('加入精酿啤酒').click()
  await page.getByRole('button', { name: '核对无误，确认下单' }).click()
  await page.getByRole('button', { name: '确认上单' }).click()
  await expect(page.getByRole('dialog', { name: /订单支付/ })).toBeVisible()
  await page.getByTitle('关闭支付窗口').click()

  await page.getByRole('button', { name: /出品履约/ }).click()
  const task = page.locator('.kds-row').filter({ hasText: '精酿啤酒' }).last()
  await expect(task.getByRole('button', { name: '取消出品' })).toBeVisible()
  await task.getByRole('button', { name: '取消出品' }).click()

  const dialog = page.getByRole('dialog', { name: /取消精酿啤酒出品/ })
  await expect(dialog).toContainText('原订单、桌账和支付不会自动修改')
  await dialog.getByLabel('情况说明').fill('客人确认不再需要这杯酒')
  await dialog.getByRole('button', { name: '确认取消出品' }).click()

  await expect(page.getByRole('status')).toContainText('精酿啤酒已停止出品')
  await expect(task).toHaveCount(0)
})
