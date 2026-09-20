import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

test('switching rule drafts clears unsaved amount text and its validity without changing either rule', async ({ page }) => {
  const fixture = JSON.parse(await readFile(process.env.NORMALIZED_E2E_FIXTURE_FILE ?? 'artifacts/normalized-browser/fixture.json', 'utf8'))
  await page.goto(fixture.staffUrl)
  await page.getByLabel('门店口令').fill(fixture.dailyCredential)
  await page.getByRole('button', { name: /验证设备/ }).click()
  await page.getByLabel('员工账号').fill('liyan')
  await page.getByLabel('四位 PIN').fill(fixture.employeePin)
  await page.getByRole('button', { name: /进入工作台/ }).click()
  await expect(page.getByTestId('normalized-workspace')).toBeVisible()

  // Frontend-only read fixtures isolate equal-valued drafts; no business writes are sent.
  const prefix = '/api/staff/loyalty/configuration-center'
  const summaries = ['第一份规则', '第二份规则'].map((title, index) => ({
    domain: 'base_points', configurationId: `input-fixture-${index}`, status: 'draft', revision: 1, version: index + 1, title, updatedAt: new Date().toISOString(),
  }))
  let writes = 0
  page.on('request', request => { if (request.url().includes(prefix) && request.method() !== 'GET') writes++ })
  await page.route(`**${prefix}`, route => route.fulfill({ json: { data: summaries } }))
  for (const item of summaries) await page.route(`**${prefix}/base_points/${item.configurationId}`, route => route.fulfill({ json: { data: {
    publicId: item.configurationId, domain: 'base_points', status: 'draft', revision: 1, makerEmployeeIds: [], updatedAt: item.updatedAt,
    content: { domain: 'base_points', pointsNumerator: 1, pointsDenominatorMinor: 100, growthNumerator: 1, growthDenominatorMinor: 100, roundingMode: 'floor', pointsValidityMonths: 18 },
  } } }))
  await page.goto('/staff/member-management#work=member-rules')
  const panel = page.getByRole('region', { name: '会员经营配置中心', exact: true })
  await panel.getByRole('button', { name: /会员经营配置中心/ }).click()
  const versions = panel.getByRole('navigation', { name: '配置列表' })
  await versions.getByRole('button', { name: /第一份规则/ }).click()
  const money = panel.getByRole('group', { name: '消费积分', exact: true }).getByLabel('每消费（元）', { exact: true })
  await expect(money).toHaveValue('1.00')
  await money.fill('1.001')
  expect(await money.evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(false)
  await versions.getByRole('button', { name: /第二份规则/ }).click()
  await expect(money).toHaveValue('1.00')
  expect(await money.evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(true)
  await money.fill('10.01')
  await expect(panel.getByRole('group', { name: '消费积分', exact: true })).toContainText('每消费 10.01 元')
  expect(writes).toBe(0)
})
