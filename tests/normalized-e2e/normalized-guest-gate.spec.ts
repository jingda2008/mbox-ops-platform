import { expect, test } from '@playwright/test'

test('fixed QR waiting state is compact, self-updating and does not ask the guest to scan again', async ({ page }) => {
  let scanCount = 0
  await page.route('**/api/guest/session/scan', async (route) => {
    scanCount += 1
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          status: 'waiting_for_table',
          message: '桌位已识别，请告知身边的服务人员为本桌开台。开台后菜单会自动出现。',
          table: { code: 'W01', displayName: '室外 W01' },
        },
      }),
    })
  })

  await page.goto(`/guest?table=W01#token=${'a'.repeat(48)}`)

  await expect(page.getByRole('status')).toContainText('室外 W01 · 桌位已识别')
  await expect(page.getByRole('heading', { name: '欢迎入座，请联系服务人员开台' })).toBeVisible()
  await expect(page.getByText('请告知身边的服务人员为 室外 W01 开台。无需重复扫码，开台后菜单会自动出现。')).toBeVisible()
  await expect(page.getByText('无需重复扫码')).toBeVisible()
  await expect(page.getByText('页面每 8 秒自动更新，开台完成后会直接进入菜单。')).toBeVisible()
  await expect(page.getByText('请重新扫描')).toHaveCount(0)
  await expect(page.getByText('我已入座')).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)

  await page.getByRole('button', { name: '立即刷新' }).click()
  await expect.poll(() => scanCount).toBe(2)
  await expect(page.getByRole('heading', { name: '欢迎入座，请联系服务人员开台' })).toBeVisible()

  const dimensions = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    gateBottom: document.querySelector('.guest-gate > section')?.getBoundingClientRect().bottom ?? Infinity,
    viewportHeight: window.innerHeight,
  }))
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.innerWidth)
  expect(dimensions.gateBottom).toBeLessThan(dimensions.viewportHeight)
})

test('invalid unsigned entry gives one precise recovery instruction and no ineffective retry', async ({ page }) => {
  await page.goto('/guest?table=W01')

  await expect(page.getByRole('alert')).toContainText('需要确认桌位')
  await expect(page.getByRole('heading', { name: '请扫描桌面上的二维码' })).toBeVisible()
  await expect(page.getByText('不要使用别人转发的页面')).toBeVisible()
  await expect(page.getByRole('button', { name: /重新|再试/ })).toHaveCount(0)

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
  expect(overflow).toBe(false)
})
