import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import type { StaffAccessManagementOverview } from '../../src/shared/normalized-contracts'

test('administrator configures refund review and cents in one publish on mobile, with persisted readback and revocation', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 })
  const data = JSON.parse(await readFile('artifacts/normalized-browser/fixture.json', 'utf8'))
  await page.goto(data.staffUrl)
  await page.getByLabel('门店口令').fill(data.dailyCredential)
  await page.getByRole('button', { name: /验证设备/ }).click()
  await page.getByLabel('员工账号').fill(data.adminEmployeeCode)
  await page.getByLabel('四位 PIN').fill(data.adminEmployeePin)
  await page.getByRole('button', { name: /进入工作台/ }).click()
  await page.getByLabel('现在要做什么').getByRole('button', { name: '系统配置', exact: true }).click()
  await page.getByRole('button', { name: /退款复核.*同时配置/ }).click()
  const overview = (await (await page.request.get('/api/staff-access/overview')).json()).data as StaffAccessManagementOverview
  const manager = overview.roles.find((role) => role.code === 'MANAGER')!
  await page.getByLabel('选择岗位').selectOption(manager.id)
  await page.getByLabel('允许复核退款').check()
  await page.getByLabel('退款复核单次上限').fill('')
  await expect(page.getByRole('alert').filter({ hasText: '请填写大于0' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^发布\d+项修改$/ })).toBeDisabled()
  await page.getByLabel('退款复核单次上限').fill('30.01')
  await page.getByLabel('发布原因').fill('隔离手机退款复核配置验证')
  const deployment = page.waitForResponse((response) => response.url().endsWith('/api/staff-access/deploy') && response.request().method() === 'POST')
  await page.getByRole('button', { name: '发布2项修改' }).click()
  const response = await deployment
  expect(response.status()).toBe(200)
  await expect(page.getByRole('status').filter({ hasText: '2项配置已发布并复核' })).toBeVisible()
  const saved = (await response.json()).data.overview as StaffAccessManagementOverview
  expect(saved.roles.find((role) => role.id === manager.id)?.permissionCodes).toContain('refund.approve')
  expect(saved.roles.find((role) => role.id === manager.id)?.approvalLimits).toContainEqual(expect.objectContaining({ code: 'refund.approve', amountMinor: 3001, enabled: true }))
  await expect(page.getByText('可复核他人申请，单次上限 ¥30.01', { exact: true })).toBeVisible()
  const dimensions = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }))
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1)
  await page.screenshot({ path: 'artifacts/normalized-browser/refund-review-mobile.png', fullPage: true })

  await page.reload()
  await page.getByRole('button', { name: /退款复核.*同时配置/ }).click()
  await page.getByLabel('选择岗位').selectOption(manager.id)
  await expect(page.getByLabel('允许复核退款')).toBeChecked()
  await expect(page.getByLabel('退款复核单次上限')).toHaveValue('30.01')
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.getByLabel('允许复核退款').uncheck()
  await page.getByRole('button', { name: '发布2项修改' }).click()
  await expect(page.getByRole('status').filter({ hasText: '2项配置已发布并复核' })).toBeVisible()
  const disabled = (await (await page.request.get('/api/staff-access/overview')).json()).data as StaffAccessManagementOverview
  expect(disabled.roles.find((role) => role.id === manager.id)?.permissionCodes).not.toContain('refund.approve')
  expect(disabled.roles.find((role) => role.id === manager.id)?.approvalLimits).toContainEqual(expect.objectContaining({ code: 'refund.approve', enabled: false }))
  await page.screenshot({ path: 'artifacts/normalized-browser/refund-review-desktop.png', fullPage: true })
})
