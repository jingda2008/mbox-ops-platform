import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import type { StaffOperationsData } from '../../src/normalized-ui/staff-actions/types'

async function login(page: Page) {
  const fixture = JSON.parse(await readFile(process.env.NORMALIZED_E2E_FIXTURE_FILE ?? 'artifacts/normalized-browser/fixture.json', 'utf8'))
  await page.goto(fixture.staffUrl)
  await page.getByLabel('门店口令').fill(fixture.dailyCredential)
  await page.getByRole('button', { name: /验证设备/ }).click()
  await page.getByLabel('员工账号').fill('liyan')
  await page.getByLabel('四位 PIN').fill(fixture.employeePin)
  await page.getByRole('button', { name: /进入工作台/ }).click()
  await expect(page.getByTestId('normalized-workspace')).toBeVisible()
  return fixture
}

test('table primary actions, more actions and return navigation preserve the list at 390px', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  // Keep the existing financial alert present without creating a real payment.
  // Otherwise a fresh fixture misses the alert that interrupted restoration in CI.
  await page.route('**/api/operations', async route => {
    const response = await route.fetch()
    const body = await response.json()
    const table = (body.data as StaffOperationsData).tables.find(table => table.code === 'W1')
    if (table?.activeSession) table.activeSession.unpaidOrderCount = Math.max(1, table.activeSession.unpaidOrderCount)
    await route.fulfill({ response, json: body })
  })
  await page.getByRole('button', { name: '现场', exact: true }).first().click()
  await expect(page.locator('.staff-table-financial-alert')).toContainText('待收款')
  await page.getByRole('group', { name: '桌台显示范围' }).getByRole('button', { name: /^全部/ }).click()
  await page.getByLabel('搜索桌号或区域').fill('W1')
  await page.locator('.staff-table-tile').first().click()
  const dialog = page.getByRole('dialog', { name: 'W1桌台操作' })
  await expect(dialog.getByRole('button', { name: '本桌收款', exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '协助点单', exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '转桌', exact: true })).toBeHidden()
  await dialog.locator('.staff-table-more > summary').click()
  await expect(dialog.getByRole('button', { name: '转桌', exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '赠送商品', exact: true })).toBeVisible()
  await dialog.screenshot({ path: testInfo.outputPath('table-action-levels.png') })
  await dialog.getByRole('button', { name: '关闭桌台操作' }).click()
  await page.getByRole('button', { name: '工作台', exact: true }).click()
  await page.goBack()
  await expect(page.getByLabel('搜索桌号或区域')).toHaveValue('W1')
  await expect(page.getByRole('group', { name: '桌台显示范围' }).getByRole('button', { name: /^全部/ })).toHaveClass(/is-active/)
  await page.getByLabel('搜索桌号或区域').fill('')
  await page.evaluate(() => window.scrollTo(0, 500))
  const originalY = await page.evaluate(() => window.scrollY)
  expect(originalY).toBeGreaterThan(100)
  await page.getByRole('navigation', { name: '岗位快捷功能' }).getByRole('button', { name: /收银|退款/ }).click()
  await expect(page.getByRole('heading', { name: '收银与退款', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '返回上一页', exact: true }).click()
  await expect(page.getByLabel('搜索桌号或区域')).toBeVisible()
  await expect.poll(async () => Math.abs(await page.evaluate(() => window.scrollY) - originalY)).toBeLessThan(4)
  const restoredPositions = await page.evaluate(async () => {
    const positions = []
    for (let frame = 0; frame < 40; frame++) {
      await new Promise(requestAnimationFrame)
      positions.push(window.scrollY)
    }
    return positions
  })
  expect(Math.max(...restoredPositions.map(position => Math.abs(position - originalY)))).toBeLessThan(4)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)
})

test('shared refund todo is counted once, opens its original record and preserves failed-read evidence', async ({ page }) => {
  await login(page)
  const baseline = await (await page.request.get('/api/payments/workbench?limit=100')).json()
  const refund = { id: 'ui-refund', publicId: 'UI-REFUND', paymentId: 'ui-payment', providerRefundId: null, amountMinor: 100, currency: 'CNY', status: 'requested', providerSubmissionState: 'not_started', reason: '浏览器只读展示核对', requestedByEmployeeId: 'another-employee', requestedByEmployeeName: '申请同事', approvedByEmployeeId: null, approvedByEmployeeName: null, decisionReason: null, receiptReference: null, completedAt: null, createdAt: new Date().toISOString(), allocations: [] }
  const payment = { id: 'ui-payment', publicId: 'UI-PAYMENT', provider: 'cash', method: 'cash', providerTransactionId: null, providerActionState: null, retryReleasedAt: null, retryReleaseReason: null, amountMinor: 100, currency: 'CNY', status: 'succeeded', succeededAt: new Date().toISOString(), createdAt: new Date().toISOString(), reservedRefundAmountMinor: 100, remainingRefundableMinor: 0, refundableItems: [], refunds: [refund] }
  const order = { id: 'ui-order', publicId: 'UI-ORDER', tableCode: 'W1', channel: 'staff_assisted', status: 'confirmed', paymentStatus: 'paid', totalAmountMinor: 100, outstandingAmountMinor: 0, overCollectedAmountMinor: 0, currency: 'CNY', submittedAt: new Date().toISOString(), createdAt: new Date().toISOString(), items: [], kdsTasks: [], payments: [payment] }
  let fail = 0
  let writes = 0
  page.on('request', request => { if (/\/api\/(refunds|payments)\//.test(request.url()) && request.method() !== 'GET') writes++ })
  await page.route('**/api/payments/workbench?*', route => fail ? route.fulfill({ status: fail, json: { error: { code: 'UNAVAILABLE' } } }) : route.fulfill({ json: { data: { ...baseline.data, orders: [order, { ...order, id: 'ui-order-two' }], activityRegistrations: [] } } }))
  const todos = page.getByRole('region', { name: '待办事项', exact: true })
  await todos.getByRole('button', { name: '刷新待办', exact: true }).click()
  await todos.getByLabel('待办业务', { exact: true }).selectOption('refund')
  if (!baseline.data.actions.canApproveRefund) await todos.getByRole('button', { name: '等待处理', exact: true }).click()
  await expect(todos.locator('[data-todo-id="refund:ui-refund"]')).toHaveCount(1)
  await todos.getByRole('button', { name: baseline.data.actions.canApproveRefund ? '复核申请' : '核对退款进度', exact: true }).click()
  await expect(page.locator('[data-staff-todo-id="refund:ui-refund"]').filter({ visible: true })).toHaveCount(1)
  await page.getByRole('button', { name: '返回上一页', exact: true }).click()
  await expect(todos.getByLabel('待办业务', { exact: true })).toHaveValue('refund')
  await expect(todos.locator('[data-todo-id="refund:ui-refund"]')).toBeVisible()
  fail = 503
  await todos.getByRole('button', { name: '刷新待办', exact: true }).click()
  await expect(todos.getByRole('alert')).toContainText('部分待办未能更新')
  await expect(todos.locator('[data-todo-id="refund:ui-refund"]')).toContainText('上次数据')
  fail = 403
  await todos.getByRole('button', { name: '刷新待办', exact: true }).click()
  await expect(todos.getByRole('alert')).toContainText('当前权限已变更')
  await expect(todos.locator('[data-todo-id="refund:ui-refund"]')).toHaveCount(0)
  expect(writes).toBe(0)
})

test('member workspace uses existing authorized routes and retains the last business section', async ({ page }) => {
  await login(page)
  await page.getByRole('button', { name: '全部岗位入口', exact: true }).click()
  await page.getByRole('button', { name: '会员服务与管理', exact: true }).click()
  const membership = page.getByRole('navigation', { name: '会员工作台', exact: true })
  await expect(membership).toBeVisible()
  await membership.getByRole('button', { name: '会员办理与活动', exact: true }).click()
  await page.getByRole('navigation', { name: '会员办理与管理', exact: true }).getByRole('button', { name: '规则与条款', exact: true }).click()
  await page.getByRole('button', { name: '工作台', exact: true }).click()
  await page.goBack()
  await expect(page.getByRole('navigation', { name: '会员办理与管理', exact: true }).getByRole('button', { name: '规则与条款', exact: true })).toHaveAttribute('aria-current', 'page')
  await membership.getByRole('button', { name: '查会员', exact: true }).click()
  await expect(page.getByRole('heading', { name: '会员账户查询', exact: true })).toBeVisible()
  await membership.getByRole('button', { name: '会员办理与活动', exact: true }).click()
  const sections = page.getByRole('navigation', { name: '会员办理与管理', exact: true })
  // This section is authorized in both the default and opt-in acceptance fixtures.
  await sections.getByRole('button', { name: '权益与兑换', exact: true }).click()
  await page.route('**/api/auth/heartbeat', async route => {
    const response = await route.fetch()
    const body = await response.json()
    body.data.permissions = body.data.permissions.filter((permission: string) => !permission.startsWith('loyalty.'))
    await route.fulfill({ response, json: body })
  })
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(sections.getByRole('button', { name: '权益与兑换', exact: true })).toHaveCount(0)
  await expect(sections.locator('button[aria-current="page"]')).toHaveCount(1)
})

test('return-state memory is cleared when another employee signs in', async ({ page }) => {
  const fixture = await login(page)
  await page.getByRole('button', { name: '现场', exact: true }).first().click()
  await page.getByLabel('搜索桌号或区域').fill('W1')
  await page.getByRole('button', { name: /切换账号/ }).click()
  const dialog = page.getByRole('dialog', { name: '切换员工', exact: true })
  await dialog.getByLabel('下一位员工账号').fill('tom')
  await dialog.getByLabel('四位 PIN').fill(fixture.employeePin)
  await dialog.getByRole('button', { name: '验证并切换', exact: true }).click()
  await expect(page.getByTestId('normalized-workspace')).toBeVisible()
  await page.getByRole('button', { name: '现场', exact: true }).first().click()
  await expect(page.getByLabel('搜索桌号或区域')).toHaveValue('')
})
