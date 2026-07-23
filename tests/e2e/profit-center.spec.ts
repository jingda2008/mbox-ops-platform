import { expect, test } from '@playwright/test'
import { expectNoHorizontalOverflow, useStaffIdentity } from './helpers'

test.describe('经营损益中心', () => {
  test('店长录入预估费用后立即重算预计利润', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await useStaffIdentity(page, 'emp-chen', '李艳')
    await page.goto('/')

    await page.locator('.sidebar nav').getByRole('button', { name: '经营工具' }).click()
    await page.getByRole('button', { name: '经营损益', exact: true }).click()
    await expect(page.getByText('预计经营利润', { exact: true })).toBeVisible()
    const pendingMetric = page.locator('.profit-metrics > div').filter({ hasText: '待确认成本' })
    const pendingBefore = Number((await pendingMetric.locator('strong').innerText()).replace(/[^\d.-]/g, ''))

    await page.getByRole('button', { name: '费用记录' }).click()
    await page.getByLabel('费用名称').fill('E2E营业前费用预估')
    await page.getByLabel('金额（元）').fill('123.45')
    await page.getByRole('button', { name: '确认录入' }).click()

    await expect(page.getByRole('status')).toContainText('预估成本已计入经营预测')
    await expect(page.getByText('E2E营业前费用预估')).toBeVisible()
    await page.getByRole('button', { name: '损益看板' }).click()
    await expect.poll(async () => Number((await pendingMetric.locator('strong').innerText()).replace(/[^\d.-]/g, '')))
      .toBeCloseTo(pendingBefore + 123.45, 2)
  })

  test('收银员手机端可查看损益但不能管理费用', async ({ page }) => {
    await page.setViewportSize({ width: 430, height: 932 })
    await useStaffIdentity(page, 'emp-cashier', '三沐')
    await page.goto('/')

    await page.getByTitle('打开导航').click()
    await page.locator('.sidebar nav').getByRole('button', { name: '经营工具' }).click()
    await page.getByRole('button', { name: '经营损益', exact: true }).click()
    await page.getByRole('button', { name: '费用记录' }).click()

    await expect(page.getByText('费用记录与追溯')).toBeVisible()
    await expect(page.getByText('录入经营费用')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '作废费用记录' })).toHaveCount(0)
    await expectNoHorizontalOverflow(page)
  })
})
