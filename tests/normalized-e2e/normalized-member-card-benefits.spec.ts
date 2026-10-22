import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { expect, test, type Locator, type Page } from '@playwright/test'

async function fillDraft(panel: Locator, code: string) {
  await panel.getByLabel('本次操作原因', { exact: true }).fill('隔离兴趣卡入卡权益入口验收')
  await panel.getByText('新建活动版本', { exact: true }).click()
  await expect(panel.getByRole('combobox', { name: '发放触发', exact: true })).toHaveValue('card_entry')
  await expect(panel.getByRole('combobox', { name: '发放触发', exact: true })).toBeDisabled()
  await expect(panel.getByRole('group', { name: '入卡触发项目', exact: true })).toHaveCount(0)
  await panel.getByLabel('活动编号', { exact: true }).fill(code)
  await panel.getByLabel('活动名称', { exact: true }).fill(`本卡权益 ${code}`)
  for (const [label, value] of [['每人赠送', '1'], ['活动总上限', '100'], ['每日上限', '20'], ['活动成本预算', '10000'], ['每日成本预算', '2000'], ['单份最高成本', '100']]) {
    await panel.getByLabel(label!, { exact: true }).fill(value!)
  }
  const local = (time: number) => new Date(time + 8 * 3600000).toISOString().slice(0, 16)
  await panel.getByLabel('发放开始（北京时间）').fill(local(Date.now() - 3600000))
  await panel.getByLabel('发放截止（北京时间）').fill(local(Date.now() + 86400000))
  for (const [label, search] of [['赠品商品池', '测试发券小食'], ['已发布券时间规则', 'BROWSER_GIFT_CAL']]) {
    const selector = panel.getByRole('group', { name: label!, exact: true })
    await selector.getByRole('textbox').fill(search!)
    await selector.getByRole('button', { name: '查找', exact: true }).click()
    await selector.getByRole('button', { name: new RegExp(search!) }).click()
  }
}

async function readCampaigns(page: Page, panel: Locator, projectId: string) {
  const read = page.waitForResponse(response => {
    const url = new URL(response.url())
    return response.request().method() === 'GET' && url.pathname === '/api/staff/member-gifts/campaigns'
      && url.searchParams.get('projectId') === projectId
  })
  await panel.getByRole('button', { name: '读取活动', exact: true }).click()
  const response = await read
  expect(response.ok()).toBe(true)
  const result = await response.json()
  for (const campaign of result.data.items) expect(campaign.card_project_id).toBe(projectId)
  return result.data.items as Array<{ id: string; code: string; status: string; card_project_id: string }>
}

for (const width of [320, 360]) test(`card entry benefit drafts stay scoped and independently reviewed at ${width}px`, async ({ page }, testInfo) => {
  test.setTimeout(60_000)
  const fixture = JSON.parse(await readFile('artifacts/normalized-browser/fixture.json', 'utf8'))
  test.skip(!fixture.memberCardFixture, 'Requires an isolated PostgreSQL card fixture; never creates real grants')
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewportSize({ width, height: 800 })
  await page.goto(fixture.staffUrl)
  await page.getByLabel('门店口令').fill(fixture.dailyCredential)
  await page.getByRole('button', { name: /验证设备/ }).click()
  await page.getByLabel('员工账号').fill(fixture.employeeCode)
  await page.getByLabel('四位 PIN').fill(fixture.employeePin)
  await page.getByRole('button', { name: /进入工作台/ }).click()
  await expect(page.getByTestId('normalized-workspace')).toBeVisible()
  await page.goto('/staff/member-management#work=member-cards')
  const cards = page.locator('.member-card-management')
  const projectsRead = page.waitForResponse(response => new URL(response.url()).pathname === '/api/staff/member-cards/projects')
  await cards.getByRole('button', { name: '读取 / 刷新', exact: true }).click()
  const projects = (await (await projectsRead).json()).data.items as Array<{ id: string; name: string; code: string }>
  await cards.getByText('卡项目配置与开放', { exact: true }).click()
  const drafts: Array<{ project: typeof projects[number]; code: string; id: string }> = []
  for (const projectCode of ['BROWSER_CARD_320', 'BROWSER_CARD_360']) {
    const project = projects.find(item => item.code === projectCode)!
    expect(project).toBeDefined()
    const projectCard = cards.locator('article').filter({ has: page.locator('strong').filter({ hasText: new RegExp(`^${project.name}$`) }) })
    await projectCard.getByRole('button', { name: '配置入卡权益', exact: true }).click()
    const panel = page.getByRole('region', { name: `${project.name}入卡权益`, exact: true })
    await expect(panel).toBeVisible()
    await expect(page.getByRole('region', { name: /入卡权益$/ })).toHaveCount(1)
    await expect(panel.getByRole('button', { name: '读取发券任务', exact: true })).toHaveCount(0)
    await readCampaigns(page, panel, project.id)
    for (const other of drafts) await expect(panel.locator('article').filter({ hasText: other.code })).toHaveCount(0)
    const code = `CARD_UI_${width}_${randomUUID().slice(0, 8).toUpperCase()}`
    await fillDraft(panel, code)
    const saving = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/staff/member-gifts/campaigns')
    await panel.getByRole('button', { name: '保存活动草稿', exact: true }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: '确认执行', exact: true }).click()
    const saved = await saving
    expect(saved.ok()).toBe(true)
    expect(saved.request().postDataJSON().rule).toMatchObject({ trigger: 'card_entry', cardProjectId: project.id })
    await expect(panel.getByRole('status')).toContainText('操作已记录')
    const id = (await saved.json()).data.versionId as string
    expect(await readCampaigns(page, panel, project.id)).toEqual(expect.arrayContaining([expect.objectContaining({ id, code, status: 'draft', card_project_id: project.id })]))
    const draft = panel.locator('article').filter({ hasText: code })
    await expect(draft).toContainText('待审核')
    await expect(draft.getByRole('button', { name: '审核', exact: true })).toHaveCount(0)
    await expect(draft.getByRole('button', { name: '发布', exact: true })).toHaveCount(0)
    // The existing author role can configure gifts but has no approval grant.
    // A card-management entry must not grant that separate permission.
    const bindingHeaders = Object.fromEntries(Object.entries(await saved.request().allHeaders()).filter(([name]) => name.startsWith('x-')))
    const selfApproval = await page.request.post(`/api/staff/member-gifts/campaigns/${id}/decision`, {
      headers: { ...bindingHeaders, 'idempotency-key': randomUUID() },
      data: { action: 'approve', reason: '验证卡管理权不能旁路独立审核权限' },
    })
    expect(selfApproval.status()).toBe(403)
    expect(await selfApproval.json()).toMatchObject({ error: { code: 'GIFT_ACCESS_DENIED', message: '没有此项发券权限' } })
    drafts.push({ project, code, id })
  }
  const first = drafts[0]!, second = drafts[1]!
  await cards.locator('article').filter({ has: page.locator('strong').filter({ hasText: new RegExp(`^${first.project.name}$`) }) }).getByRole('button', { name: '配置入卡权益', exact: true }).click()
  const firstPanel = page.getByRole('region', { name: `${first.project.name}入卡权益`, exact: true })
  const finalRows = await readCampaigns(page, firstPanel, first.project.id)
  expect(finalRows.some(row => row.id === first.id && row.status === 'draft')).toBe(true)
  expect(finalRows.some(row => row.id === second.id)).toBe(false)
  await expect(firstPanel.locator('article').filter({ hasText: second.code })).toHaveCount(0)
  const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) }))
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1)
  await firstPanel.screenshot({ path: testInfo.outputPath('card-entry-benefits.png') })
  expect(errors).toEqual([])
})
