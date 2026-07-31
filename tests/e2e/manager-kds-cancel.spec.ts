import { expect, test } from '@playwright/test'
import { useStaffIdentity } from './helpers'

test('李艳取消未送达酒水时情况说明为选填', async ({ page }) => {
  await useStaffIdentity(page, 'emp-chen', '李艳')
  await page.route('**/api/auth/verify-pin', async (route) => {
    const input = route.request().postDataJSON() as { employeePin?: string }
    await route.fulfill(input.employeePin === '1010'
      ? { status: 200, contentType: 'application/json', body: JSON.stringify({ verified: true, actorId: 'emp-chen' }) }
      : { status: 401, contentType: 'application/json', body: JSON.stringify({ code: 'PILOT_EMPLOYEE_PIN_DENIED', message: '员工PIN错误，请输入当前登录员工的PIN' }) })
  })
  await page.goto('/')
  await page.getByTitle('打开导航').click()
  await page.locator('.sidebar nav').getByRole('button', { name: '订单与出品' }).click()
  await expect(page.getByRole('heading', { name: '岗位履约工作台' })).toBeVisible()

  await page.getByRole('button', { name: '全屏点单' }).click()
  const entry = page.getByRole('dialog', { name: '进入全屏点单前选择桌台' })
  await entry.getByLabel('进入点单前选择桌台').selectOption('table-l01')
  await entry.getByRole('button', { name: '确认桌台并进入' }).click()
  const product = page.locator('.menu-product').filter({ hasText: '精酿啤酒' }).first()
  await product.getByTitle('加入精酿啤酒').click()
  await page.getByRole('button', { name: /查看购物车/ }).click()
  await page.getByRole('dialog', { name: '购物车明细' }).getByRole('button', { name: '确认订单并收款' }).click()
  await page.getByRole('button', { name: '确认上单' }).click()
  await expect(page.getByRole('dialog', { name: /订单支付/ })).toBeVisible()
  await page.getByTitle('关闭支付窗口').click()

  await page.getByRole('button', { name: '员工退出' }).click()
  const exitDialog = page.getByRole('dialog', { name: '退出客用点单' })
  await exitDialog.getByLabel('当前员工PIN').fill('1010')
  await exitDialog.getByRole('button', { name: '验证并退出' }).click()
  await expect(page.getByRole('button', { name: /出品履约/ })).toHaveClass(/is-active/)
  const task = page.locator('.kds-row').filter({ hasText: '精酿啤酒' }).last()
  await expect(task.getByRole('button', { name: '取消出品' })).toBeVisible()
  await task.getByRole('button', { name: '取消出品' }).click()

  const dialog = page.getByRole('dialog', { name: /取消精酿啤酒出品/ })
  await expect(dialog).toContainText('原订单、桌账和支付不会自动修改')
  await expect(dialog.getByLabel('情况说明（选填）')).toHaveValue('')
  const confirmCancellation = dialog.getByRole('button', { name: '确认取消出品' })
  await expect(confirmCancellation).toBeEnabled()
  await confirmCancellation.click()

  await expect(page.getByRole('status')).toContainText('精酿啤酒已停止出品')
  await expect(task).toHaveCount(0)
})
