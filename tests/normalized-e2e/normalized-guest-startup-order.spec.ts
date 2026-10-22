import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

function signal() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function fixture() {
  return JSON.parse(await readFile(process.env.NORMALIZED_E2E_FIXTURE_FILE ?? 'artifacts/normalized-browser/fixture.json', 'utf8'))
}

async function holdFirstRead(page: Page, path: string, rejectSession = false) {
  const seen = signal(), release = signal()
  let first = true
  await page.route(`**${path}*`, async route => {
    if (!first) return route.continue()
    first = false
    const response = rejectSession ? null : await route.fetch()
    seen.resolve()
    await release.promise
    if (response) await route.fulfill({ response })
    else await route.fulfill({ status: 401, json: { error: { code: 'TABLE_SESSION_ENDED', message: '本桌服务已结束' } } })
  })
  return { seen: seen.promise, release: release.resolve }
}

test('initial history waits for both menu and cart while performance remains parallel', async ({ page }) => {
  const f = await fixture()
  const menu = await holdFirstRead(page, '/api/guest/menu/products')
  const cart = await holdFirstRead(page, '/api/guest/shared-cart')
  let historyReads = 0, performanceReads = 0
  await page.route('**/api/guest/orders/table', route => { historyReads++; return route.continue() })
  await page.route('**/api/guest/performances/today', route => { performanceReads++; return route.continue() })
  try {
    await page.goto(f.guestUrl)
    await Promise.all([menu.seen, cart.seen])
    await expect(page.locator('.guest-table')).toContainText('查看历史已下单')
    await expect.poll(() => performanceReads).toBe(1)
    expect(historyReads).toBe(0)
    const menuResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/guest/menu/products')
    menu.release()
    await menuResponse
    await expect(page.locator('.guest-menu-loading')).toBeVisible()
    expect(historyReads).toBe(0)
    cart.release()
    await expect(page.getByRole('navigation', { name: '菜单分类' }).getByRole('button').first()).toBeVisible()
    await expect.poll(() => historyReads).toBe(1)
    await expect(page.locator('.guest-table')).toContainText(/历史已下单 · \d+件/)
  } finally { menu.release(); cart.release() }
})

test('explicit history and retry remain immediate before menu readiness and a failed first read never reports zero', async ({ page }) => {
  const f = await fixture()
  const menu = await holdFirstRead(page, '/api/guest/menu/products')
  const cart = await holdFirstRead(page, '/api/guest/shared-cart')
  let historyReads = 0
  await page.route('**/api/guest/orders/table', async route => {
    historyReads++
    if (historyReads === 1) return route.fulfill({ status: 503, json: { error: { code: 'TEMPORARY_UNAVAILABLE', message: '历史记录暂不可用，请重试' } } })
    await route.continue()
  })
  try {
    await page.goto(f.guestUrl)
    await Promise.all([menu.seen, cart.seen])
    await page.locator('.guest-table').click()
    await expect.poll(() => historyReads).toBe(1)
    await expect(page.getByText('历史记录暂不可用，请重试')).toBeVisible()
    await expect(page.locator('.guest-table')).toContainText('查看历史已下单')
    await expect(page.locator('.guest-table')).not.toContainText('0件')
    const orders = page.getByRole('dialog', { name: '本桌历史订单' })
    await expect(orders).toContainText('历史订单尚未读取，请刷新核对')
    await expect(orders).not.toContainText('还没有已确认的订单')
    await orders.getByRole('button', { name: '刷新', exact: true }).click()
    await expect.poll(() => historyReads).toBe(2)
    await expect(page.locator('.guest-table')).toContainText(/历史已下单 · \d+件/)
    await expect(orders).not.toContainText('历史订单尚未读取')
  } finally { menu.release(); cart.release() }
})

test('a final cart response ending the session cancels history before React effect cleanup', async ({ page }) => {
  const f = await fixture()
  const menu = await holdFirstRead(page, '/api/guest/menu/products')
  const cart = await holdFirstRead(page, '/api/guest/shared-cart', true)
  let historyReads = 0
  await page.route('**/api/guest/orders/table', route => { historyReads++; return route.continue() })
  try {
    await page.goto(f.guestUrl)
    await Promise.all([menu.seen, cart.seen])
    const menuResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/guest/menu/products')
    menu.release()
    await menuResponse
    await expect(page.locator('.guest-menu-loading')).toBeVisible()
    expect(historyReads).toBe(0)
    cart.release()
    await expect(page.getByRole('heading', { name: '感谢今晚相聚' })).toBeVisible()
    // Also observe the continuation after both initial reads have settled.
    await page.waitForTimeout(100)
    expect(historyReads).toBe(0)
    await expect(page.getByTestId('normalized-guest-app')).toHaveCount(0)
  } finally { menu.release(); cart.release() }
})

test('a blocked table session cancels its queued history even if the old menu arrives later', async ({ page }) => {
  const f = await fixture()
  const menu = await holdFirstRead(page, '/api/guest/menu/products')
  const cart = await holdFirstRead(page, '/api/guest/shared-cart', true)
  let historyReads = 0
  await page.route('**/api/guest/orders/table', route => { historyReads++; return route.continue() })
  try {
    await page.goto(f.guestUrl)
    await Promise.all([menu.seen, cart.seen])
    cart.release()
    await expect(page.getByTestId('normalized-guest-app')).toHaveCount(0)
    await expect(page.getByRole('status')).toContainText('本次服务已结束')
    await expect(page.getByRole('heading', { name: '感谢今晚相聚' })).toBeVisible()
    const menuResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/guest/menu/products')
    menu.release()
    await menuResponse
    // Allow the delayed Promise continuation to run after the blocked render.
    await page.waitForTimeout(100)
    expect(historyReads).toBe(0)
    await expect(page.getByTestId('normalized-guest-app')).toHaveCount(0)
  } finally { menu.release(); cart.release() }
})
