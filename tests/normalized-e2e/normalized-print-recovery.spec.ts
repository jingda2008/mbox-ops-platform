import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

for (const width of [320, 390]) test(`printer recovery is isolated and readable at ${width}px`, async ({ page }, testInfo) => {
  const fixture = JSON.parse(await readFile('artifacts/normalized-browser/fixture.json', 'utf8'))
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewportSize({ width, height: 800 })
  await page.goto(fixture.staffUrl)
  await page.getByLabel('门店口令').fill(fixture.dailyCredential)
  await page.getByRole('button', { name: /验证设备/ }).click()
  const cashier = fixture.employees.find((employee: { code: string; roleNames: string[] }) => employee.roleNames.includes('收银员'))
  if (!cashier) throw new Error('Missing isolated cashier fixture')
  await page.getByLabel('员工账号').fill(cashier.code)
  await page.getByLabel('四位 PIN').fill(fixture.employeePin)
  await page.getByRole('button', { name: /进入工作台/ }).click()
  await expect(page.getByTestId('normalized-workspace')).toBeVisible()
  const sourceResponse = page.waitForResponse(response => response.url().endsWith('/api/hardware/print-sources') && response.request().method() === 'GET')
  await page.goto('/staff/devices')
  await expect(page.getByRole('heading', { name: '票据生成检查' })).toBeVisible()
  const response = await sourceResponse
  expect(response.status()).toBe(200)
  const sourceRows = (await response.json()).data
  expect(Array.isArray(sourceRows)).toBe(true)
  await expect(page.locator('.print-source-recovery article')).toHaveCount(sourceRows.length)
  if (sourceRows.length === 0) await expect(page.getByText('当前没有待处理的票据生成记录。')).toBeVisible()
  await page.route('**/api/hardware/print-sources', route => route.fulfill({ status: 503, json: { error: { code: 'TEST_READ_UNAVAILABLE' } } }))
  await page.getByRole('button', { name: '刷新生成状态' }).click()
  await expect(page.getByText('票据生成状态暂未读到，可重试；不影响营业')).toBeVisible()
  const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth,
    content: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) }))
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1)
  await page.screenshot({ path: testInfo.outputPath('print-recovery.png'), fullPage: true })
  await page.goto('/staff/floor')
  await expect(page.getByTestId('normalized-workspace')).toBeVisible()
  expect(errors).toEqual([])
})
