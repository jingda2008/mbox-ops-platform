import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

test('legacy W01 QR hint accepts verified W1 and waiting state is compact, self-updating and does not ask the guest to scan again', async ({ page }) => {
  let scanCount = 0, waitCount = 0
  await page.route('**/api/guest/session/wait', async route => {
    waitCount++
    await route.fulfill({status:200,json:{data:{status:'waiting_for_table',message:'等待开台',table:{code:'W1',displayName:'室外 W1'}}}})
  })
  await page.route('**/api/guest/session/scan', async (route) => {
    scanCount += 1
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          status: 'waiting_for_table',
          message: '桌位已识别，请告知身边的服务人员为本桌开台。开台后菜单会自动出现。',
          table: { code: 'W1', displayName: '室外 W1' },
        },
      }),
    })
  })

  await page.goto(`/guest?table=W01#token=${'a'.repeat(48)}`)

  await expect(page.getByRole('status')).toContainText('室外 W1 · 桌位已识别')
  await expect(page.getByRole('heading', { name: '欢迎入座，请联系服务人员开台' })).toBeVisible()
  await expect(page.getByText('请告知身边的服务人员为 室外 W1 开台。无需重复扫码，开台后菜单会自动出现。')).toBeVisible()
  await expect(page.getByText('无需重复扫码')).toBeVisible()
  await expect(page.getByText('页面每 8 秒自动更新，开台完成后会直接进入菜单。')).toBeVisible()
  await expect(page.getByText('请重新扫描')).toHaveCount(0)
  await expect(page.getByText('我已入座')).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)

  await page.getByRole('button', { name: '立即刷新' }).click()
  await expect.poll(() => waitCount).toBe(1)
  expect(scanCount).toBe(1)
  // Many manual refreshes must not consume the real scan allowance.
  for(let index=0;index<11;index++){
    await page.getByRole('button', { name: '立即刷新' }).click()
    await expect.poll(() => waitCount).toBe(index+2)
  }
  expect(scanCount).toBe(1)
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
  await page.goto('/guest?table=W1')

  await expect(page.getByRole('alert')).toContainText('需要确认桌位')
  await expect(page.getByRole('heading', { name: '请扫描桌面上的二维码' })).toBeVisible()
  await expect(page.getByText('不要使用别人转发的页面')).toBeVisible()
  await expect(page.getByRole('button', { name: /重新|再试/ })).toHaveCount(0)

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
  expect(overflow).toBe(false)
})


test('waiting refresh respects retryAt and resumes the availability check without another scan',async({page})=>{
  await page.clock.install()
  let scans=0,waits=0
  await page.route('**/api/guest/session/scan',async route=>{scans++;await route.fulfill({status:200,json:{data:{status:'waiting_for_table',message:'等待开台',table:{code:'W1',displayName:'室外 W1'}}}})})
  await page.route('**/api/guest/session/wait',async route=>{
    waits++
    if(waits===1){const now=await page.evaluate(()=>Date.now());return route.fulfill({status:429,json:{error:{code:'GUEST_SCAN_RATE_LIMITED',message:'稍后再试',retryAt:new Date(now+30000).toISOString()}}})}
    return route.fulfill({status:200,json:{data:{status:'waiting_for_table',message:'等待开台',table:{code:'W1',displayName:'室外 W1'}}}})
  })
  await page.goto(`/guest?table=W1#token=${'a'.repeat(48)}`)
  const refresh=page.getByRole('button',{name:'立即刷新'})
  await refresh.click();await expect.poll(()=>waits).toBe(1);await expect(refresh).toBeEnabled()
  await refresh.click();await page.clock.runFor(16000)
  expect(waits).toBe(1);expect(scans).toBe(1)
  await page.clock.runFor(17000);await expect.poll(()=>waits).toBe(2)
  expect(scans).toBe(1)
  await expect(page.getByRole('heading',{name:'欢迎入座，请联系服务人员开台'})).toBeVisible()
})


test('old printed W01 hint with the real W1 credential opens the active menu; another table hint is rejected', async ({ page }) => {
  const fixture = JSON.parse(await readFile(process.env.NORMALIZED_E2E_FIXTURE_FILE ?? 'artifacts/normalized-browser/fixture.json', 'utf8'))
  const oldUrl = new URL(fixture.guestUrl, 'http://localhost')
  oldUrl.searchParams.set('table', 'W01')
  await page.goto(oldUrl.pathname + oldUrl.search + oldUrl.hash)
  await expect(page.getByTestId('normalized-guest-app')).toBeVisible()
  await expect(page.getByRole('button', { name: /历史已下单.*W1/ })).toBeVisible()
  oldUrl.searchParams.set('table', 'W2')
  await page.goto(oldUrl.pathname + oldUrl.search + oldUrl.hash)
  await expect(page.getByTestId('normalized-guest-app')).toHaveCount(0)
  await expect(page.getByRole('alert')).toBeVisible()
})
