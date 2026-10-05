import { expect, test, type Page } from '@playwright/test'

async function prepare(page: Page) {
  await page.goto('/reserve')
  await expect(page.getByText('预约服务在线')).toBeVisible()
  await page.getByRole('button', { name: /下一步：位置与联系/ }).click()
  await page.getByLabel('怎么称呼您').fill('原预约恢复浏览器验收')
  await page.getByLabel('手机或微信').fill('13800138009')
  await page.getByRole('button', { name: /核对预约信息/ }).click()
  await expect(page.getByRole('button', { name: '提交预约申请', exact: true })).toBeEnabled()
}
async function storedSubmission(page: Page) {
  return page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('mbox.web.reservation.submission.v1:')).map(key => JSON.parse(localStorage.getItem(key)!)))
}
async function ownReservations(page: Page) {
  return page.evaluate(async () => {
    const response = await fetch('/api/public/reservations/mine', { credentials: 'include', headers: { 'x-mbox-guest-device': localStorage.getItem('mbox.reservation.device-id.v1')! } })
    if (!response.ok) throw new Error(`own reservation read failed: ${response.status}`)
    return (await response.json()).data.reservations as Array<{publicId: string}>
  })
}

test('web booking restores a real committed reservation after losing its response and reopening', async ({ page }, info) => {
  let postCount = 0, committedId = ''
  await page.route('**/api/public/reservations', async route => {
    if (route.request().method() !== 'POST') return route.continue()
    postCount++
    const response = await route.fetch()
    expect(response.status()).toBe(201)
    committedId = (await response.json()).data.publicId
    await route.abort('failed')
  })
  await prepare(page)
  await page.getByRole('button', { name: '提交预约申请', exact: true }).click()
  await expect(page.getByRole('heading', { name: '上次预约结果待确认' })).toBeVisible()
  const original = (await storedSubmission(page))[0]
  expect(original.payload.publicId).toBe(committedId)
  expect(await ownReservations(page)).toHaveLength(1)
  await page.reload()
  await expect(page.getByRole('button', { name: '查询并恢复原预约' })).toBeEnabled()
  await expect(page.getByRole('button', { name: /下一步：位置与联系/ })).toHaveCount(0)
  await page.getByRole('button', { name: '查询并恢复原预约' }).click()
  await expect(page.getByRole('heading', { name: '等待门店确认' })).toBeVisible()
  expect(postCount).toBe(1)
  expect(await ownReservations(page)).toEqual([expect.objectContaining({ publicId: committedId })])
  expect(await storedSubmission(page)).toHaveLength(0)
  await page.screenshot({ path: info.outputPath('web-original-reservation-restored.png'), fullPage: true })
})

test('web booking replays the original payload and key when the first request never reached the server', async ({ page }) => {
  const posts: Array<{ key: string; body: unknown }> = []
  await page.route('**/api/public/reservations', async route => {
    if (route.request().method() !== 'POST') return route.continue()
    posts.push({ key: route.request().headers()['idempotency-key'], body: route.request().postDataJSON() })
    if (posts.length === 1) return route.abort('failed')
    await route.continue()
  })
  await prepare(page)
  await page.getByRole('button', { name: '提交预约申请', exact: true }).click()
  await expect(page.getByRole('button', { name: '查询并恢复原预约' })).toBeEnabled()
  expect(await ownReservations(page)).toHaveLength(0)
  await page.reload()
  await page.getByRole('button', { name: '查询并恢复原预约' }).click()
  await expect(page.getByRole('heading', { name: '等待门店确认' })).toBeVisible()
  expect(posts).toHaveLength(2)
  expect(posts[1]).toEqual(posts[0])
  expect(await ownReservations(page)).toHaveLength(1)
})

test('failed original lookup keeps recovery locked and never submits a replacement', async ({ page }) => {
  let postCount = 0
  await page.route('**/api/public/reservations', async route => {
    if (route.request().method() !== 'POST') return route.continue()
    postCount++
    expect((await route.fetch()).status()).toBe(201)
    await route.abort('failed')
  })
  await prepare(page)
  await page.getByRole('button', { name: '提交预约申请', exact: true }).click()
  await expect(page.getByRole('button', { name: '查询并恢复原预约' })).toBeEnabled()
  const original = (await storedSubmission(page))[0]
  await page.route(`**/api/public/reservations/${original.payload.publicId}`, route => route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: '原预约暂时无法读取' } } }))
  await page.reload()
  await page.getByRole('button', { name: '查询并恢复原预约' }).click()
  await expect(page.getByRole('alert')).toContainText('原预约暂时无法读取')
  await expect(page.getByRole('button', { name: '查询并恢复原预约' })).toBeEnabled()
  await expect(page.getByRole('button', { name: '提交预约申请', exact: true })).toHaveCount(0)
  expect((await storedSubmission(page))[0]).toEqual(original)
  expect(postCount).toBe(1)
  expect(await ownReservations(page)).toHaveLength(1)
})
