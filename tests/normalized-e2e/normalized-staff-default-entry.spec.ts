import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import type { StaffAuthView } from '../../src/normalized-api'

test('targetless staff login uses actual role and finance permissions while explicit workspace and table links win', async ({ browser, baseURL }) => {
  test.setTimeout(120_000)
  const fixture = JSON.parse(await readFile('artifacts/normalized-browser/fixture.json', 'utf8'))
  async function login(page: Page, path: string, employee: string): Promise<StaffAuthView> {
    await page.goto(path)
    await page.getByLabel('门店口令').fill(fixture.dailyCredential)
    await page.getByRole('button', { name: /验证设备/ }).click()
    await page.getByLabel('员工账号').fill(employee)
    await page.getByLabel('四位 PIN').fill(fixture.employeePin)
    const response = page.waitForResponse(result => new URL(result.url()).pathname === '/api/auth/login' && result.request().method() === 'POST')
    await page.getByRole('button', { name: /进入工作台/ }).click()
    const result = await response
    expect(result.status()).toBe(200)
    return (await result.json()).data as StaffAuthView
  }
  // These are the existing provisioned accounts; no role/permission override or
  // mocked auth response is used to make a landing page appear.
  const scenarios = [
    { employee: 'wuya', role: 'ADMIN', path: '/', expected: '/staff/operations', profit: true, cost: false, payroll: false },
    { employee: 'chenfangyu', role: 'OWNER', path: '/', expected: '/staff/operations', profit: true, cost: true, payroll: true },
    { employee: 'hugu', role: 'OPS_LEAD', path: '/', expected: '/', profit: true, cost: true, payroll: false },
    { employee: 'tom', role: 'SERVER', path: '/', expected: '/', profit: false, cost: false, payroll: false },
    { employee: 'wuya', role: 'ADMIN', path: fixture.staffUrl, expected: '/staff', profit: true, cost: false, payroll: false },
    { employee: 'wuya', role: 'ADMIN', path: '/staff/live', expected: '/staff/live', profit: true, cost: false, payroll: false },
  ]
  for (const scenario of scenarios) {
    const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
    try {
      const page = await context.newPage()
      const auth = await login(page, scenario.path, scenario.employee)
      expect(auth.employee.roleCodes).toContain(scenario.role)
      expect(auth.permissions.includes('commercial.profit.view')).toBe(scenario.profit)
      expect(auth.permissions.includes('commercial.cost.view')).toBe(scenario.cost)
      expect(auth.permissions.includes('commercial.payroll.view')).toBe(scenario.payroll)
      await expect(page).toHaveURL(new RegExp(`${scenario.expected.replaceAll('/', '\\/')}$`))
      if (scenario.expected === '/staff/operations') {
        await expect(page.getByRole('region', { name: '老板经营仪表盘', exact: true })).toBeVisible()
        const response = await page.request.get('/api/commercial-ops/profit?period=day')
        expect(response.status()).toBe(200)
        const report = (await response.json()).data
        await expect(page.getByLabel('经营期间选择')).toHaveValue(report.currentBusinessDate)
        await expect(page.getByRole('region', { name: '财务仪表盘', exact: true })).toHaveCount(scenario.cost ? 1 : 0)
        // Returning to the workspace within this login must not bounce back.
        await page.getByRole('button', { name: '工作台', exact: true }).click()
        await expect(page.getByTestId('normalized-workspace')).toBeVisible()
        await expect(page).toHaveURL(/\/$/)
      } else if (scenario.expected === '/staff/live') {
        await expect(page.getByRole('heading', { name: '找到桌台，直接处理', exact: true })).toBeVisible()
        await expect(page.getByRole('region', { name: '老板经营仪表盘', exact: true })).toHaveCount(0)
      } else {
        await expect(page.getByTestId('normalized-workspace')).toBeVisible()
      }
      const cost = await page.request.get('/api/commercial-ops/profit?period=day&sourceKind=cost')
      expect(cost.status()).toBe(scenario.cost && scenario.profit ? 200 : 403)
      if (scenario.employee === 'hugu') {
        // Financial access alone does not change this employee's configured role.
        await page.goto('/staff/operations')
        await expect(page.getByRole('region', { name: '财务仪表盘', exact: true })).toBeVisible()
        const finance = await page.request.get('/api/commercial-ops/owner-finance')
        expect(finance.status()).toBe(200)
        expect((await finance.json()).data).toMatchObject({ canViewCost: true, canViewPayroll: false, payrollLines: [] })
      }
      if (!scenario.profit) {
        expect((await page.request.get('/api/commercial-ops/profit?period=day')).status()).toBe(403)
        await page.goto('/staff/operations')
        await expect(page.getByRole('alert')).toContainText('当前账号没有这个页面的有效权限')
        await expect(page.getByRole('region', { name: '老板经营仪表盘', exact: true })).toHaveCount(0)
      }
    } finally {
      await context.close()
    }
  }
})
