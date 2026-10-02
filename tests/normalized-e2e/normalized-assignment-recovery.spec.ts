import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

async function setup(page: Page) {
  const fixture = JSON.parse(await readFile('artifacts/normalized-browser/fixture.json', 'utf8'))
  await page.goto(fixture.staffUrl)
  await page.getByLabel('门店口令').fill(fixture.dailyCredential)
  await page.getByRole('button', { name: /验证设备/ }).click()
  await page.getByLabel('员工账号').fill(fixture.employeeCode)
  await page.getByLabel('四位 PIN').fill(fixture.employeePin)
  await page.getByRole('button', { name: /进入工作台/ }).click()
  await expect(page.getByTestId('normalized-workspace')).toBeVisible()
  const options = (await (await page.request.get('/api/table-management/assignment-options')).json()).data
  const tables = (await (await page.request.get('/api/table-management/tables')).json()).data
  const assignments = (await (await page.request.get('/api/table-management/assignments')).json()).data
  const table = tables.find((t: { id: string; status: string }) => t.status === 'available'
    && !assignments.some((a: { tableId: string; employeeId: string }) => a.tableId === t.id && a.employeeId === options.employees[0].id))
  expect(table).toBeTruthy()
  await page.goto('/staff/live')
  return { options, table }
}
async function panel(page: Page) {
  const root = page.getByRole('region', { name: '责任桌人员安排' })
  await root.getByRole('button', { name: /人员与责任桌/ }).click()
  await expect(root.getByLabel('责任类型')).toBeVisible()
  return root
}

test('责任桌提交已入库但丢回执，刷新后按原键恢复且不重复安排', async ({ page }) => {
  const { options, table } = await setup(page)
  const requests: { key: string | undefined; body: string | null }[] = []
  await page.route('**/api/table-management/guarded-assignments/batch', async route => {
    requests.push({ key: route.request().headers()['x-idempotency-key'], body: route.request().postData() })
    const response = await route.fetch()
    expect(response.ok()).toBe(true)
    if (requests.length === 1) await route.abort('failed')
    else await route.fulfill({ response })
  })
  let root = await panel(page)
  await root.getByRole('combobox', { name: '员工', exact: true }).selectOption(options.employees[0].id)
  await root.getByLabel('本次岗位').selectOption(options.roles[0].id)
  await root.getByLabel('责任类型').selectOption('backup')
  await root.getByLabel('搜索责任区域或桌台').fill(table.code)
  await root.getByRole('checkbox').first().check()
  await root.getByRole('button', { name: /发布 1 张桌台/ }).click()
  await expect(root.getByRole('button', { name: '恢复原责任操作' })).toBeVisible()
  await expect(root.getByRole('button', { name: /发布/ })).toBeDisabled()
  await page.setViewportSize({ width: 360, height: 800 })
  const recoveryButton = root.getByRole('button', { name: '恢复原责任操作' })
  const geometry = await recoveryButton.evaluate(element => ({ height: element.getBoundingClientRect().height,
    fits: element.scrollWidth <= element.clientWidth, pageFits: document.documentElement.scrollWidth <= innerWidth + 1 }))
  expect(geometry.height).toBeGreaterThanOrEqual(44)
  expect(geometry.fits).toBe(true); expect(geometry.pageFits).toBe(true)

  await page.screenshot({ path: 'artifacts/normalized-browser/assignment-recovery-pending.png', fullPage: true })
  await page.reload()
  await expect(page.getByRole('region', { name: '责任桌人员安排' })).toBeVisible()
  root = await panel(page)
  await root.getByRole('button', { name: '恢复原责任操作' }).click()
  await expect(root.getByText('原责任操作已确认，列表已刷新', { exact: true })).toBeVisible()
  expect(requests).toHaveLength(2); expect(requests[0]).toEqual(requests[1])
  const assignments = (await (await page.request.get('/api/table-management/assignments')).json()).data
  expect(assignments.filter((a: { tableId: string; employeeId: string }) => a.tableId === table.id && a.employeeId === options.employees[0].id)).toHaveLength(1)
  await expect(root.getByRole('button', { name: '恢复原责任操作' })).toHaveCount(0)
})

test('结束责任后列表已消失，页面刷新仍可恢复原结束回执', async ({ page }) => {
  const { options, table } = await setup(page)
  const created = await page.request.post('/api/table-management/guarded-assignments/batch', {
    headers: { 'x-idempotency-key': `e2e-assignment-setup-${crypto.randomUUID()}` },
    data: { tableIds: [table.id], employeeId: options.employees[0].id, roleId: options.roles[0].id,
      assignmentType: 'backup', startsAt: new Date(Date.now() - 60000).toISOString(), endsAt: null, reason: '隔离测试交班' },
  })
  expect(created.ok()).toBe(true)
  const id = (await created.json()).data.assignments[0].id
  const requests: { key: string | undefined; body: string | null }[] = []
  await page.route(`**/api/table-management/guarded-assignments/${id}/end`, async route => {
    requests.push({ key: route.request().headers()['x-idempotency-key'], body: route.request().postData() })
    const response = await route.fetch(); expect(response.ok()).toBe(true)
    if (requests.length === 1) await route.abort('failed')
    else await route.fulfill({ response })
  })
  let root = await panel(page)
  const row = root.locator('.staff-assignment-active article').filter({ hasText: table.code })
  await row.getByRole('button', { name: '结束责任', exact: true }).click()
  await row.getByRole('button', { name: '再次确认结束' }).click()
  await expect(root.getByRole('button', { name: '恢复原责任操作' })).toBeVisible()
  await page.reload(); await expect(page.getByRole('region', { name: '责任桌人员安排' })).toBeVisible()
  root = await panel(page)
  await root.getByRole('button', { name: '恢复原责任操作' }).click()
  await expect(root.getByText('原责任操作已确认，列表已刷新', { exact: true })).toBeVisible()
  expect(requests).toHaveLength(2); expect(requests[0]).toEqual(requests[1])
})
