import { readFile } from 'node:fs/promises'
import { expect, test, type Browser, type Page } from '@playwright/test'

interface Fixture { staffUrl: string; dailyCredential: string; employeePin: string }
async function login(page: Page, data: Fixture, code: string) {
  await page.goto(data.staffUrl)
  await page.getByLabel('门店口令').fill(data.dailyCredential)
  await page.getByRole('button', { name: /验证设备/ }).click()
  await page.getByLabel('员工账号').fill(code)
  await page.getByLabel('四位 PIN').fill(data.employeePin)
  await page.getByRole('button', { name: /进入工作台/ }).click()
  await expect(page.getByTestId('normalized-workspace')).toBeVisible()
}
async function setup(browser: Browser) {
  const fixture: Fixture = JSON.parse(await readFile('artifacts/normalized-browser/fixture.json', 'utf8'))
  const counter = await browser.newContext(), reviewer = await browser.newContext()
  const counterPage = await counter.newPage(), page = await reviewer.newPage()
  await login(counterPage, fixture, 'lengyanzhi'); await login(page, fixture, 'hugu')
  const nonce = crypto.randomUUID()
  const item = await page.request.post('/api/inventory/items', { headers: { 'idempotency-key': `heartbeat-item-${nonce}` }, data: {
    sku: `HEARTBEAT-${nonce}`, name: '心跳盘点复核酒水', itemType: 'bottle', baseUnit: 'ml', categoryCode: 'spirits.gin', packageVolumeMl: '750',
  } })
  expect(item.status(), await item.text()).toBe(201)
  const itemId = (await item.json()).data.id
  const created = await counterPage.request.post('/api/inventory/stock-counts', { headers: { 'idempotency-key': `heartbeat-count-${nonce}` }, data: {
    lines: [{ inventoryItemId: itemId, countedQuantity: '500', reason: '隔离浏览器心跳回归' }],
  } })
  expect(created.status(), await created.text()).toBe(201)
  const count = (await created.json()).data as { id: string; publicId: string }
  const submitted = await counterPage.request.post(`/api/inventory/stock-counts/${count.id}/submit`, { headers: { 'idempotency-key': `heartbeat-submit-${nonce}` }, data: {} })
  expect(submitted.status(), await submitted.text()).toBe(200)
  return { page, count, close: async () => { await counter.close(); await reviewer.close() } }
}
async function heartbeat(page: Page) {
  const response = page.waitForResponse(r => r.url().endsWith('/api/auth/heartbeat') && r.request().method() === 'POST')
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await response
  // Observe the real effects/network after the response, including the old 20ms reload race.
  await page.waitForTimeout(300)
}

test('equivalent heartbeats preserve a real stock-count selection; access changes, refresh and revoked sessions still take effect', async ({ browser }, testInfo) => {
  test.setTimeout(120_000)
  const { page, count, close } = await setup(browser)
  try {
    let mode: 'same' | 'scope' | 'permissions' | 'navigation' | 'revoked' = 'same'
    let heartbeatReplies = 0, inventoryReads = 0, countReads = 0
    page.on('request', request => {
      const url = new URL(request.url())
      if (url.pathname === '/api/inventory') inventoryReads++
      if (url.pathname === '/api/inventory/stock-counts' && request.method() === 'GET') countReads++
    })
    await page.route('**/api/auth/heartbeat', async route => {
      if (mode === 'revoked') { heartbeatReplies++; return route.fulfill({ status: 401, json: { error: { code: 'AUTH_REQUIRED', message: '会话已撤销' } } }) }
      const response = await route.fetch(), body = await response.json()
      // The session and inventory are real isolated PostgreSQL. Only changed access responses are controlled.
      body.data.permissions = [...body.data.permissions].reverse()
      if (mode === 'scope') body.data.dataScopes = [{ key: 'inventory.item_ids', effect: 'include', value: ['changed-scope'] }]
      if (mode === 'permissions') body.data.permissions = body.data.permissions.filter((value: string) => !['inventory.count', 'inventory.count.approve'].includes(value))
      if (mode === 'navigation') body.data.navigation = []
      heartbeatReplies++
      await route.fulfill({ response, json: body })
    })
    await page.goto('/staff/inventory')
    const panel = page.getByRole('region', { name: '盘点复核', exact: true })
    const row = panel.getByRole('article', { name: `盘点 ${count.publicId}`, exact: true })
    await expect(row).toBeVisible()
    await expect.poll(() => heartbeatReplies).toBeGreaterThan(0)
    await page.waitForTimeout(300)
    await row.getByRole('checkbox').check()
    const before = { inventoryReads, countReads }
    await heartbeat(page)
    expect.soft({ inventoryReads, countReads }, 'same-authority heartbeat must not reload inventory or counts').toEqual(before)
    await expect.soft(row.getByRole('checkbox')).toBeChecked()
    await expect.soft(panel).toContainText('已选 1 张')
    await page.screenshot({ path: testInfo.outputPath('same-heartbeat-selection.png') })
    if (testInfo.errors.length) return

    await panel.getByRole('button', { name: '刷新盘点', exact: true }).click()
    await expect.poll(() => countReads).toBeGreaterThan(before.countReads)
    await expect(row.getByRole('checkbox')).not.toBeChecked()
    await row.getByRole('checkbox').check()
    const beforeScope = inventoryReads
    mode = 'scope'; await heartbeat(page)
    await expect.poll(() => inventoryReads).toBeGreaterThan(beforeScope)
    await expect(row.getByRole('checkbox')).not.toBeChecked()

    mode = 'permissions'; await heartbeat(page)
    await expect(panel).toHaveCount(0)
    mode = 'same'; await heartbeat(page)
    await expect(row).toBeVisible()
    mode = 'navigation'; await heartbeat(page)
    await expect(page.getByRole('alert')).toContainText('当前账号没有这个页面的有效权限')
    await expect(panel).toHaveCount(0)
    mode = 'same'; await heartbeat(page)
    await expect(row).toBeVisible()
    mode = 'revoked'; await heartbeat(page)
    await expect(page.getByLabel('员工账号')).toBeVisible()
    await expect(panel).toHaveCount(0)
  } finally { await close() }
})

test('stock-count read failure survives equivalent heartbeat and recovers only in the manual retry phase', async ({ browser }) => {
  test.setTimeout(120_000)
  const { page, count, close } = await setup(browser)
  try {
    let unavailable = true
    await page.route('**/api/inventory/stock-counts?**', route => unavailable
      ? route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: '盘点服务暂时不可用' } } })
      : route.continue())
    await page.goto('/staff/inventory')
    const panel = page.getByRole('region', { name: '盘点复核', exact: true })
    await expect(panel.getByRole('alert')).toContainText('读取失败，请刷新重试')
    await heartbeat(page)
    await expect(panel.getByRole('alert')).toContainText('读取失败，请刷新重试')
    await expect(panel.getByText('当前没有待复核盘点', { exact: true })).toHaveCount(0)
    unavailable = false
    await panel.getByRole('button', { name: '刷新盘点', exact: true }).click()
    await expect(panel.getByRole('article', { name: `盘点 ${count.publicId}`, exact: true })).toBeVisible()
    await expect(panel.getByRole('alert')).toHaveCount(0)
  } finally { await close() }
})
