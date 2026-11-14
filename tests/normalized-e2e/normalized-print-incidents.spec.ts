import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

// Real local application/authentication and disposable Postgres fixture. Incident
// responses are mocked at the browser boundary; no bridge or printer is connected.
for (const width of [390, 1280]) test(`print incident recovery works at ${width}px without printing`, async ({page}, testInfo) => {
  const fixture = JSON.parse(await readFile('artifacts/normalized-browser/fixture.json', 'utf8'))
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewportSize({width, height: 900})
  await page.goto(fixture.staffUrl)
  await page.getByLabel('门店口令').fill(fixture.dailyCredential)
  await page.getByRole('button', {name: /验证设备/}).click()
  const cashier = fixture.employees.find((employee: {code: string; roleNames: string[]}) => employee.roleNames.includes('收银员'))
  await page.getByLabel('员工账号').fill(cashier.code)
  await page.getByLabel('四位 PIN').fill(fixture.employeePin)
  await page.getByRole('button', {name: /进入工作台/}).click()
  await expect(page.getByTestId('normalized-workspace')).toBeVisible()
  const employeeId = await page.evaluate(async () => (await (await fetch('/api/auth/session')).json()).data.employee.id)
  const incident = {episodeStartedAt: new Date().toISOString(), id: '00000000-0000-4000-8000-000000000001', bridgeId: '00000000-0000-4000-8000-000000000002', jobId: '00000000-0000-4000-8000-000000000003', kind: 'ambiguous', failureCode: 'ambiguous_print_result', status: 'open', firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), occurrences: 2, claimedBy: null as string|null, resolution: null as string|null, escalation: 'administrator'}
  let failRead = false, loseResponse = true, accidentalPrints = 0
  const resolutionKeys: string[] = []
  page.on('request', request => {if (request.method() === 'POST' && /\/api\/hardware\/.+\/(reprint|retry|report|commands)$/.test(request.url())) accidentalPrints++})
  await page.route('**/api/hardware/print-incidents**', async route => {
    const request = route.request()
    if (request.method() === 'GET') return route.fulfill({status: failRead ? 503 : 200, json: failRead ? {error: {code: 'TEST_UNAVAILABLE'}} : {data: incident.status === 'resolved' ? [] : [incident]}})
    expect(request.postDataJSON().expectedEpisodeAt).toBe(incident.episodeStartedAt)
    if (request.url().endsWith('/claim')) {
      incident.status = 'claimed'; incident.claimedBy = employeeId
      return route.fulfill({json: {data: incident}})
    }
    expect(request.url()).toMatch(/\/resolve$/)
    const resolution = request.postDataJSON().resolution
    resolutionKeys.push(request.headers()['idempotency-key'])
    incident.resolution = resolution
    if (resolution === 'paper_confirmed') incident.status = 'resolved'
    if (loseResponse) {loseResponse = false; return route.abort('failed')}
    return route.fulfill({json: {data: incident}})
  })
  await page.goto('/staff/devices')
  const panel = page.getByRole('region', {name: '打印故障处理'})
  await expect(panel.getByText('需管理员处理', {exact: true})).toBeVisible()
  await expect(panel).toContainText('Windows 已接收不代表实际出纸')
  await expect(panel).toContainText('外发通知尚未接通')
  await panel.getByRole('button', {name: '认领处理'}).click()
  await expect(panel.getByText('由你处理中', {exact: true})).toBeVisible()
  await expect(panel.getByRole('combobox')).not.toContainText('设备已恢复')
  await panel.getByRole('combobox').selectOption('not_printed')
  await panel.getByRole('button', {name: '确认保存现场核验'}).click()
  await expect(panel.getByRole('alert')).toContainText('操作结果尚未确认')
  await expect(panel.getByRole('combobox')).toBeDisabled()
  await panel.getByRole('button', {name: '核对原请求结果'}).click()
  expect(resolutionKeys[1]).toBe(resolutionKeys[0])
  await expect(panel).toContainText('未出纸已记录，尚未补打')
  await expect(panel.getByRole('heading')).toContainText('1 项未解决')
  failRead = true
  await panel.getByRole('button', {name: '刷新故障'}).click()
  await expect(panel.getByRole('alert')).toContainText('列表可能已过期')
  await expect(panel.getByRole('combobox')).toBeDisabled()
  failRead = false
  await panel.getByRole('button', {name: '刷新故障'}).click()
  await expect(panel.getByRole('combobox')).toBeEnabled()
  await panel.scrollIntoViewIfNeeded()
  const dimensions = await page.evaluate(() => ({viewport: document.documentElement.clientWidth, content: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)}))
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1)
  const controlBounds = await panel.locator('select, button').evaluateAll(elements => elements.map(element => {const rect = element.getBoundingClientRect(); return {left: rect.left, right: rect.right, height: rect.height}}))
  for (const bounds of controlBounds) {expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(dimensions.viewport + 1); expect(bounds.height).toBeGreaterThanOrEqual(44)}
  await page.screenshot({path: testInfo.outputPath('print-incidents.png'), fullPage: true})
  await panel.getByRole('combobox').selectOption('paper_confirmed')
  await panel.getByRole('button', {name: '确认保存现场核验'}).click()
  await expect(panel).toContainText('当前列表没有未解决故障')
  // UI authorization downgrade is mocked; backend authorization is tested separately.
  incident.status = 'open'; incident.claimedBy = null; incident.resolution = null
  await page.route(/\/api\/auth\/(session|heartbeat)$/, async route => {
    const response = await route.fetch(), json = await response.json()
    json.data.permissions = [...json.data.permissions.filter((permission: string) => !['print.reprint', 'printer.manage', 'hardware.manage'].includes(permission)), 'print.retry']
    await route.fulfill({response, json})
  })
  await page.reload()
  await expect(panel).toContainText('当前仅可查看')
  await expect(panel.getByRole('button', {name: '认领处理'})).toHaveCount(0)
  await expect(panel.getByRole('button', {name: '确认保存现场核验'})).toHaveCount(0)
  expect(accidentalPrints).toBe(0)
  expect(errors).toEqual([])
})
