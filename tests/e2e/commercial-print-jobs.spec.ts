import { expect, test, type Page } from '@playwright/test'
import { expectNoHorizontalOverflow, openStaffNavigation, useStaffIdentity } from './helpers'

async function installPrintJobFixture(page: Page, initialStatus: 'queued' | 'failed' = 'queued') {
  let status: 'queued' | 'printed' | 'failed' = initialStatus
  let attempts = initialStatus === 'failed' ? 1 : 0
  let lastError: string | null = initialStatus === 'failed' ? '打印机离线' : null

  await page.route('**/api/bootstrap**', async (route) => {
    const response = await route.fetch()
    const raw = await response.text()
    if (!raw) {
      await route.fulfill({ response, body: raw })
      return
    }
    const data = JSON.parse(raw)
    const tableSession = data.songState.tableSessions.find((session: { tableCode: string }) => session.tableCode === 'L01')
    data.orderDomain.orders = [
      ...data.orderDomain.orders.filter((order: { id: string }) => order.id !== 'e2e-print-order'),
      {
        id: 'e2e-print-order', tableSessionId: tableSession.id, status: 'submitted',
        items: [{
          id: 'e2e-print-item', skuId: 'product-beer', name: '精酿啤酒', specification: '330ml', quantity: 2,
          unitListPriceAmount: 6800, unitSalePriceAmount: 6800, unitCostAmount: 1800, stationId: 'bar-main',
          configVersion: 1, fulfillmentStatus: 'queued', kdsTaskId: null, addedBy: 'emp-chen', addedAt: new Date().toISOString(),
        }],
        amounts: { grossAmount: 13_600, discountAmount: 0, giftAmount: 0, payableAmount: 13_600 },
        revision: 1, createdBy: 'emp-chen', createdAt: new Date().toISOString(), submittedBy: 'emp-chen',
        submittedAt: new Date().toISOString(), fulfilledAt: null,
      },
    ]
    await route.fulfill({ response, json: data })
  })

  await page.route('**/api/commercial-ops/print-jobs/**', async (route) => {
    const payload = route.request().postDataJSON() as { status: 'queued' | 'printed' | 'failed'; error: string }
    status = payload.status
    if (status !== 'queued') attempts += 1
    lastError = status === 'failed' ? payload.error : null
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(printJob()) })
  })

  await page.route('**/api/commercial-ops', async (route) => {
    const response = await route.fetch()
    const workspace = await response.json()
    workspace.state.printJobs = [printJob()]
    await route.fulfill({ response, json: workspace })
  })

  function printJob() {
    return {
      id: 'e2e-print-job', orderId: 'e2e-print-order', orderItemIds: ['e2e-print-item'],
      printerId: 'printer-bar', routeId: 'route-bar', status, attempts,
      queuedAt: '2026-07-22T12:30:00.000+08:00', updatedAt: new Date().toISOString(), lastError,
    }
  }
}

test.describe('打印任务经营入口', () => {
  test('待打印统计卡可进入详情并由有权岗位确认完成', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await useStaffIdentity(page, 'emp-chen', '李艳')
    await installPrintJobFixture(page)
    await page.goto('/')

    await openStaffNavigation(page, '经营工具')
    await expect(page.getByRole('heading', { name: '经营工具' })).toBeVisible()
    await page.getByRole('button', { name: /待打印任务1，查看详情/ }).click()

    await expect(page.getByText('打印任务处理')).toBeVisible()
    const job = page.locator('.print-job-card')
    await expect(job.getByRole('button', { name: /L01 · 酒水单/ })).toBeVisible()
    await job.getByRole('button', { name: /L01 · 酒水单/ }).click()
    await expect(job).toContainText('精酿啤酒')
    await expect(job).toContainText('吧台出单机')
    await job.getByRole('button', { name: '确认已打印' }).click()

    await expect(page.getByRole('status')).toContainText('L01打印任务已完成')
    await expect(page.getByText('当前没有待打印任务')).toBeVisible()
  })

  test('手机端可展开失败原因并重新加入队列且没有横向溢出', async ({ page }) => {
    await page.setViewportSize({ width: 430, height: 932 })
    await useStaffIdentity(page, 'emp-chen', '李艳')
    await installPrintJobFixture(page, 'failed')
    await page.goto('/')

    await openStaffNavigation(page, '经营工具')
    await page.getByRole('button', { name: /打印失败1，查看详情/ }).click()
    const job = page.locator('.print-job-card')
    await job.getByRole('button', { name: /L01 · 酒水单/ }).click()

    await expect(job).toContainText('上次失败原因')
    await expect(job).toContainText('打印机离线')
    await expect(job.getByRole('button', { name: '重新加入队列' })).toBeVisible()
    await expectNoHorizontalOverflow(page)
  })
})
