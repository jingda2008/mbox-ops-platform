import { expect, type Page } from '@playwright/test'

export async function useStaffIdentity(page: Page, actorId: string, actorName: string) {
  await page.addInitScript(({ id, name }) => {
    window.localStorage.setItem('mbox.actor.id', id)
    window.localStorage.setItem('mbox.actor.name', name)
  }, { id: actorId, name: actorName })
}

export async function revealStaffNavigation(page: Page, label: string | RegExp) {
  const sidebar = page.locator('.sidebar')
  const mobileMenu = page.getByTitle('打开导航')
  const sidebarOpen = (await sidebar.getAttribute('class'))?.includes('is-open') ?? false
  if (await mobileMenu.isVisible() && !sidebarOpen) {
    await mobileMenu.click()
    await expect(sidebar).toHaveClass(/is-open/)
  }
  const navigation = page.getByRole('navigation', { name: '岗位导航' })
  let target = navigation.getByRole('button', { name: label })
  if (await target.count() === 0) {
    const more = navigation.getByRole('button', { name: /更多功能/ })
    await more.scrollIntoViewIfNeeded()
    await more.click()
    target = navigation.getByRole('button', { name: label })
  }
  await expect(target).toBeVisible()
  return navigation
}

export async function openStaffNavigation(page: Page, label: string | RegExp) {
  const navigation = await revealStaffNavigation(page, label)
  const target = navigation.getByRole('button', { name: label })
  await target.click()
}

export async function expectNoHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }))).toEqual(expect.objectContaining({
    document: await page.evaluate(() => window.innerWidth),
    body: await page.evaluate(() => window.innerWidth),
  }))
}

export async function expectSecurityHeaders(page: Page, path = '/api/health') {
  const response = await page.request.get(path)
  expect(response.ok()).toBeTruthy()
  expect(response.headers()['x-content-type-options']).toBe('nosniff')
  expect(response.headers()['x-frame-options']).toBe('DENY')
  expect(response.headers()['referrer-policy']).toBe('no-referrer')
  expect(response.headers()['content-security-policy']).toContain("frame-ancestors 'none'")
}
