import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

interface Fixture {
  guestUrl: string
  reservationUrl: string
  staffUrl: string
  dailyCredential: string
  employeeCode: string
  employeePin: string
  orderableProductName: string
}

const phoneProfiles = [
  { name: 'iPhone SE portrait', width: 320, height: 568 },
  { name: 'compact Android portrait', width: 360, height: 800 },
  { name: 'standard phone portrait', width: 390, height: 844 },
  { name: 'large phone portrait', width: 430, height: 932 },
  { name: 'phone landscape', width: 844, height: 390 },
] as const

async function fixture(): Promise<Fixture> {
  return JSON.parse(await readFile(
    process.env.NORMALIZED_E2E_FIXTURE_FILE ?? 'artifacts/normalized-browser/fixture.json',
    'utf8',
  )) as Fixture
}

async function loginManager(page: Page, data: Fixture) {
  await page.goto(data.staffUrl)
  await page.getByLabel('门店口令').fill(data.dailyCredential)
  await page.getByRole('button', { name: /验证设备/ }).click()
  await page.getByLabel('员工账号').fill(data.employeeCode)
  await page.getByLabel('四位 PIN').fill(data.employeePin)
  await page.getByRole('button', { name: /进入工作台/ }).click()
  await expect(page.getByTestId('normalized-workspace')).toBeVisible()
}

async function expectNoHorizontalOverflow(page: Page, label: string) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    page: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
  }))
  expect(dimensions.page, `${label} horizontal overflow`).toBeLessThanOrEqual(dimensions.viewport + 1)
}

async function expectTouchTargets(page: Page, root: string, label: string) {
  const undersized = await page.locator(root).evaluate((container) => {
    const controls = [...container.querySelectorAll<HTMLElement>('button, input:not([type="hidden"]), select, textarea, summary, a[href]')]
    return controls.flatMap((control) => {
      const style = getComputedStyle(control)
      const ownRect = control.getBoundingClientRect()
      if (style.display === 'none' || style.visibility === 'hidden' || ownRect.width === 0 || ownRect.height === 0) return []
      const type = control instanceof HTMLInputElement ? control.type : ''
      const target = type === 'checkbox' || type === 'radio' ? control.closest('label') ?? control : control
      const rect = target.getBoundingClientRect()
      if (rect.width >= 44 && rect.height >= 44) return []
      return [{
        element: control.tagName.toLowerCase(),
        name: control.getAttribute('aria-label') ?? control.textContent?.trim().slice(0, 48) ?? '',
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      }]
    })
  })
  expect(undersized, `${label} undersized touch targets`).toEqual([])
}

async function enlargeVisibleText(page: Page) {
  await page.evaluate(() => {
    const elements = [...document.querySelectorAll<HTMLElement>('h1, h2, h3, h4, p, span, strong, small, label, button, summary, dt, dd')]
    for (const element of elements) {
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      const size = Number.parseFloat(getComputedStyle(element).fontSize)
      if (Number.isFinite(size)) element.style.fontSize = `${Math.min(size * 1.25, 28)}px`
    }
  })
}

test('public guest and reservation layouts hold across compact, large and landscape phones', async ({ page }) => {
  const data = await fixture()
  for (const profile of phoneProfiles) {
    await page.setViewportSize({ width: profile.width, height: profile.height })
    await page.goto(data.guestUrl)
    await expect(page.getByTestId('normalized-guest-app')).toBeVisible()
    await expectNoHorizontalOverflow(page, `${profile.name} guest`)
    await expectTouchTargets(page, '[data-testid="normalized-guest-app"]', `${profile.name} guest`)

    await page.goto(data.reservationUrl)
    await expect(page.getByTestId('reservation-booking')).toBeVisible()
    await expectNoHorizontalOverflow(page, `${profile.name} reservation`)
    await expectTouchTargets(page, '[data-testid="reservation-booking"]', `${profile.name} reservation`)

    await page.goto('/member')
    await expect(page.getByRole('heading', { name: '我的权益' })).toBeVisible()
    await expectNoHorizontalOverflow(page, `${profile.name} member`)
    await expectTouchTargets(page, '.normalized-member', `${profile.name} member`)
  }
})

test('large text and dark preference keep public pages readable without clipping', async ({ page }) => {
  const data = await fixture()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  for (const route of [data.guestUrl, data.reservationUrl, '/member']) {
    await page.goto(route)
    await enlargeVisibleText(page)
    await expectNoHorizontalOverflow(page, `large text ${route}`)
  }
})

test('slow or offline connections keep the last useful mobile state and offer recovery', async ({ page, context }) => {
  const data = await fixture()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.route('**/api/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 350))
    await route.continue()
  })
  await page.goto(data.guestUrl)
  await expect(page.getByTestId('normalized-guest-app')).toBeVisible()
  await expectNoHorizontalOverflow(page, 'slow network guest')
  await page.unroute('**/api/**')

  await loginManager(page, data)
  await context.setOffline(true)
  await page.getByRole('button', { name: '刷新工作台' }).click()
  await expect(page.getByTestId('normalized-workspace')).toBeVisible()
  await expect(page.getByText(/刷新失败，当前仍显示上次成功数据|工作台暂时没有接上|网络连接失败，请检查网络后重试/)).toBeVisible()
  await context.setOffline(false)
})

test('focused fields remain usable when the mobile visual viewport is reduced', async ({ page }) => {
  const data = await fixture()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(data.guestUrl)
  const search = page.getByLabel('搜索菜单商品')
  await search.focus()
  await page.setViewportSize({ width: 390, height: 500 })
  await search.scrollIntoViewIfNeeded()
  const geometry = await search.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const dock = document.querySelector('.menu-cart-dock')?.getBoundingClientRect()
    return { top: rect.top, bottom: rect.bottom, viewport: window.innerHeight, dockTop: dock?.top ?? window.innerHeight }
  })
  expect(geometry.top).toBeGreaterThanOrEqual(0)
  expect(geometry.bottom).toBeLessThanOrEqual(Math.min(geometry.dockTop, geometry.viewport) + 1)
  await expectNoHorizontalOverflow(page, 'reduced visual viewport')
})

test('manager mobile pages prioritize current actions and keep low-frequency detail on demand', async ({ page }) => {
  const data = await fixture()
  await page.setViewportSize({ width: 390, height: 844 })
  await loginManager(page, data)
  await expectNoHorizontalOverflow(page, 'manager home')
  await expectTouchTargets(page, '[data-testid="normalized-workspace"]', 'manager home')

  await page.goto('/staff/live')
  await page.getByRole('button', { name: /人员与责任桌/ }).click()
  await expect(page.getByLabel('搜索责任区域或桌台')).toBeVisible()
  const areas = page.locator('.staff-assignment-area')
  expect(await areas.count()).toBeGreaterThanOrEqual(6)
  expect(await page.locator('.staff-assignment-area label').count()).toBeLessThanOrEqual(10)
  await page.getByLabel('搜索责任区域或桌台').fill('W01')
  await expect(page.locator('.staff-assignment-area label')).toHaveCount(1)
  await expectNoHorizontalOverflow(page, 'responsibility assignment')
  await expectTouchTargets(page, '.staff-assignment-panel', 'responsibility assignment')
  const responsibilityHeight = await page.evaluate(() => document.documentElement.scrollHeight)
  expect(responsibilityHeight).toBeLessThan(2_400)

  const operationalRoutes = [
    ['/staff/tasks', '只看需要服务的事'],
    ['/staff/fulfillment', '只做当前下一步'],
    ['/staff/reservations', '确认预约与到店'],
    ['/staff/payments', '收银与退款'],
    ['/staff/performance', '演出与点歌'],
    ['/staff/inventory', '库存与存酒'],
    ['/staff/operations', '经营数据'],
    ['/staff/devices', '设备与打印'],
  ] as const
  for (const [route, heading] of operationalRoutes) {
    await page.goto(route)
    await expect(page.getByRole('heading', { name: heading })).toBeVisible()
    await expectNoHorizontalOverflow(page, `portrait ${route}`)
    await expectTouchTargets(page, 'body', `portrait ${route}`)
  }

  await page.goto('/staff/settings')
  await expect(page.getByRole('heading', { name: '系统配置状态' })).toBeVisible()
  await expect(page.getByText('查看当前可配置范围')).toBeVisible()
  await expect(page.getByText('员工与岗位')).not.toBeVisible()
  await expect(page.getByText('支付安全边界')).toBeVisible()
  await expectNoHorizontalOverflow(page, 'settings')
  await expectTouchTargets(page, '.staff-module-panel', 'settings')

  await page.getByRole('button', { name: /商品、售价与推荐/ }).click()
  await page.getByLabel('搜索配置商品').fill(data.orderableProductName)
  await page.locator('.catalog-management-list article').filter({ hasText: data.orderableProductName }).first().getByRole('button', { name: '编辑' }).click()
  await expect(page.getByLabel('推荐优先级')).toBeVisible()
  await expect(page.getByLabel('菜单排序')).toHaveCount(0)
  await page.getByRole('button', { name: /显示高级字段/ }).click()
  await expect(page.getByLabel('菜单排序')).toBeVisible()
  await expectNoHorizontalOverflow(page, 'catalog advanced settings')
})

test('manager operational routes remain usable in phone landscape', async ({ page }) => {
  const data = await fixture()
  await page.setViewportSize({ width: 844, height: 390 })
  await loginManager(page, data)
  const routes = [
    ['/staff/live', '找到桌台，直接处理'],
    ['/staff/tasks', '只看需要服务的事'],
    ['/staff/fulfillment', '只做当前下一步'],
    ['/staff/reservations', '确认预约与到店'],
    ['/staff/payments', '收银与退款'],
    ['/staff/performance', '演出与点歌'],
    ['/staff/inventory', '库存与存酒'],
    ['/staff/operations', '经营数据'],
    ['/staff/devices', '设备与打印'],
    ['/staff/settings', '系统配置状态'],
  ] as const
  for (const [route, heading] of routes) {
    await page.goto(route)
    await expect(page.getByRole('heading', { name: heading })).toBeVisible()
    await expectNoHorizontalOverflow(page, `landscape ${route}`)
  }
})
