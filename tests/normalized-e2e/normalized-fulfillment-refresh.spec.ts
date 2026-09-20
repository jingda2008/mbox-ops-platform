import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

const taskId = 'caaa0000-0000-4000-8000-000000000001'
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }

async function kitchen(page: Page, quantity = true, employee = 'liyan') {
  const data = JSON.parse(await readFile(process.env.NORMALIZED_E2E_FIXTURE_FILE ?? 'artifacts/normalized-browser/fixture.json', 'utf8'))
  await page.goto(data.staffUrl)
  await page.getByLabel('门店口令').fill(data.dailyCredential)
  await page.getByRole('button', { name: /验证设备/ }).click()
  await page.getByLabel('员工账号').fill(employee)
  await page.getByLabel('四位 PIN').fill(data.employeePin)
  await page.getByRole('button', { name: /进入工作台/ }).click()
  await expect(page.getByTestId('normalized-workspace')).toBeVisible()
  const original = await page.request.get('/api/commerce/fulfillment')
  expect(original.ok()).toBe(true)
  const queue = (await original.json()).data
  // This suite preserves the legacy station/exception workflow; the new board has real-backend tests.
  queue.actor.kitchenBatchBoardEnabled = false
  const now = new Date().toISOString()
  // Synthetic read model/command acknowledgements only. Never send these IDs to the real command handler.
  const item = { taskId, businessDate: now.slice(0, 10), carryover: false, stationCode: 'kitchen',
    kdsStatus: 'pending', priority: 100, overdue: false, readyForDelivery: false,
    canPrepare: true, canDeliver: false, canRemake: false, dueAt: null, nextActionAt: now, createdAt: now,
    item: { productName: '隔离后厨刷新样本', quantity: 2, note: null }, order: { publicId: 'AUDIT-ONLY', note: null },
    table: { id: 'caaa0000-0000-4000-8000-000000000002', code: 'TEST01', assignmentType: 'primary' }, attentionMessages: [],
    ...(quantity ? { quantities: { total: 2, unmade: 2, started: 0, ready: 0, delivered: 0, held: 0, stopped: 0 } } : {}) }
  const state = { fail: false, denied: false, reads: 0, hold: null as ReturnType<typeof gate> | null, items: [item] }
  await page.route('**/api/commerce/fulfillment', async route => {
    state.reads++
    const snapshot = structuredClone({ data: { ...queue, workItems: state.items } })
    if (state.hold) await state.hold.promise
    if (state.denied) return route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN', message: '无出品权限' } } })
    if (state.fail) return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: '暂时不可用' } } })
    await route.fulfill({ json: snapshot })
  })
  await page.goto('/staff/fulfillment')
  if (employee === 'tom') await page.getByRole('button', { name: /^待制作（/ }).click()
  const card = page.locator(`[data-action-fact-id="${taskId}"]`)
  await expect(card).toBeVisible()
  return { state, card, item }
}

const refresh = (page: Page) => page.getByRole('button', { name: '刷新现场', exact: true }).click()

test('后厨短暂读取失败保留旧列表，禁止操作，恢复不误报新增', async ({ page }) => {
  const { state, card } = await kitchen(page)
  state.fail = true; await refresh(page)
  await expect(page.getByText('出品更新失败，保留上次列表；恢复后才能继续确认。')).toBeVisible()
  await expect(card).toBeVisible(); await expect(card.getByRole('button', { name: '制作完成', exact: true })).toBeDisabled()
  state.fail = false; await page.getByRole('button', { name: '重新读取出品' }).click()
  await expect(card.getByRole('button', { name: '制作完成', exact: true })).toBeEnabled()
  await expect(page.locator('.staff-actions-notice')).not.toContainText('新增')
  state.denied = true; await refresh(page); await expect(card).toHaveCount(0)
})

test('后厨超过轮询间隔的请求不会被取消，出品不等待慢桌台读取', async ({ page }) => {
  const { state } = await kitchen(page)
  const hold = gate(); let operations = 0
  await page.route('**/api/operations', async route => { operations++; const actual = await route.fetch(); await hold.promise; await route.fulfill({ response: actual }) })
  const before = state.reads
  await page.clock.install()
  await refresh(page)
  await expect.poll(() => state.reads).toBeGreaterThan(before)
  await page.clock.runFor(6000)
  expect(operations).toBe(1)
  hold.release()
  await expect(page.locator('.staff-actions-stale')).toHaveCount(0)
  await page.clock.runFor(5000)
  await expect.poll(() => operations).toBeGreaterThan(1)
})

test('按份制作确认后锁住旧数量，读回失败也不会再次制作剩余份数', async ({ page }) => {
  const { state, card, item } = await kitchen(page)
  let commands = 0
  await page.route('**/api/commerce/kds/*/actions', async route => {
    commands++; state.fail = true
    item.quantities!.unmade = 1; item.quantities!.ready = 1; item.readyForDelivery = true
    await route.fulfill({ json: { id: taskId, affectedQuantity: 1 } })
  })
  await card.getByRole('spinbutton').fill('1')
  await card.getByRole('button', { name: '制作完成', exact: true }).click()
  await expect(card.getByRole('button', { name: '已确认，等待同步' })).toBeDisabled()
  await expect(card).toContainText('请勿重复制作或送达')
  await refresh(page); expect(commands).toBe(1)
  state.fail = false; await refresh(page)
  await expect(card).toContainText('待制作 1 · 已备齐 1')
  await expect(card.getByRole('button', { name: '制作完成', exact: true })).toBeEnabled()
  expect(commands).toBe(1)
})

test('遗留整单完成也等待权威读回，不把部分份数隐藏后再当新单弹出', async ({ page }) => {
  const { state, card } = await kitchen(page, false)
  const hold = gate()
  await page.route('**/api/commerce/kds/*/actions', async route => { state.items = []; state.hold = hold; await route.fulfill({ json: { id: taskId } }) })
  await card.getByRole('button', { name: '制作完成', exact: true }).click()
  await expect(card.getByRole('button', { name: '已确认，等待同步' })).toBeDisabled()
  state.hold = null; hold.release()
  await expect(card).toHaveCount(0)
  await expect(page.locator('.staff-actions-notice')).not.toContainText('新增')
})

test('未知制作结果跨刷新恢复原数量原编号，新队列不能解锁重复操作', async ({ page }) => {
  const { state, card, item } = await kitchen(page)
  const sent: Array<{ key: string; body: unknown }> = []
  await page.route('**/api/commerce/kds/*/actions', async route => {
    sent.push({ key: route.request().headers()['idempotency-key']!, body: route.request().postDataJSON() })
    item.quantities!.unmade = 1; item.quantities!.ready = 1; item.readyForDelivery = true
    if (sent.length === 1) await route.abort('failed')
    else await route.fulfill({ json: { id: taskId, affectedQuantity: 1 } })
  })
  await card.getByRole('spinbutton').fill('1')
  await card.getByRole('button', { name: '制作完成', exact: true }).click()
  await expect(page.getByRole('button', { name: '恢复上次结果' })).toBeVisible()
  await refresh(page); await expect(card.getByRole('button', { name: '结果待确认' })).toBeDisabled()
  await page.reload(); await expect(card.getByRole('button', { name: '结果待确认' })).toBeDisabled()
  await page.getByRole('button', { name: '恢复上次结果' }).click()
  await expect(card.getByRole('button', { name: '制作完成', exact: true })).toBeEnabled()
  expect(sent).toHaveLength(2); expect(sent[1]).toEqual(sent[0]); expect(state.items[0]!.quantities!.unmade).toBe(1)
})

test('顶部刷新更新本人历史，筛选变化不会显示旧桌台记录', async ({ page }) => {
  await kitchen(page, true, 'shenliangliang')
  let reads = 0, fail = false
  const hold = gate()
  await page.route('**/api/operations/history?**', async route => {
    reads++; const table = new URL(route.request().url()).searchParams.get('table')
    if (table === 'B') await hold.promise
    if (fail) return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: '暂时不可用' } } })
    await route.fulfill({ json: { data: { businessDate: '2026-09-19', page: 0, hasMore: false, receipts: [], generatedAt: new Date().toISOString(), orders: [{ id: 'history', publicId: 'HISTORY', tableCode: table || 'A', items: [{ id: 'item', name: '本人历史样本', quantity: 1, preparedBy: '本人', preparedAt: '2026-09-19T10:00:00Z' }] }] } } })
  })
  await page.getByRole('button', { name: '我的已制作', exact: true }).click()
  const history = page.getByRole('region', { name: '我的历史制作' })
  await expect(history).toContainText('本人历史样本')
  const initial = reads; await refresh(page); await expect.poll(() => reads).toBeGreaterThan(initial)
  fail = true; await refresh(page); await expect(history).toContainText('保留上次成功记录')
  await expect(history).toContainText('本人历史样本')
  fail = false; await history.getByLabel('桌号', { exact: true }).fill('B')
  await expect(history.getByText('本人历史样本')).toHaveCount(0)
  hold.release(); await expect(history.locator('article header strong')).toHaveText('B')
})

test('制作前发出的旧响应不能解除成功后的同步锁', async ({ page }) => {
  const { state, card, item } = await kitchen(page)
  const oldRead = gate(), freshRead = gate()
  const initial = state.reads
  state.hold = oldRead; await refresh(page)
  await expect.poll(() => state.reads).toBeGreaterThan(initial)
  await page.route('**/api/commerce/kds/*/actions', async route => {
    item.quantities!.unmade = 1; item.quantities!.ready = 1; item.readyForDelivery = true
    state.hold = freshRead
    await route.fulfill({ json: { id: taskId, affectedQuantity: 1 } })
  })
  await card.getByRole('spinbutton').fill('1')
  await card.getByRole('button', { name: '制作完成', exact: true }).click()
  await expect(card.getByRole('button', { name: '已确认，等待同步' })).toBeDisabled()
  oldRead.release()
  await expect.poll(() => state.reads).toBeGreaterThan(initial + 1)
  await expect(card.getByRole('button', { name: '已确认，等待同步' })).toBeDisabled()
  state.hold = null; freshRead.release()
  await expect(card).toContainText('待制作 1 · 已备齐 1')
  await expect(card.getByRole('button', { name: '制作完成', exact: true })).toBeEnabled()
})

test('不同菜品的并发确认独立锁定，不回滚别人的更新且通知不跳页', async ({ page }) => {
  const { state, card, item } = await kitchen(page)
  const other = structuredClone(item)
  other.taskId = 'caaa0000-0000-4000-8000-000000000003'; other.item.productName = '第二份隔离样本'
  state.items.push(other); await refresh(page)
  const second = page.locator(`[data-action-fact-id="${other.taskId}"]`)
  await expect(second).toBeVisible()
  await page.evaluate(() => {
    const probe = window as unknown as { scrollCalls: number }
    probe.scrollCalls = 0
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (options) {
      if (this.matches('.staff-actions-notice')) probe.scrollCalls++
      original.call(this, options)
    }
  })
  const firstCommand = gate(), secondCommand = gate()
  await page.route('**/api/commerce/kds/*/actions', async route => {
    const first = route.request().url().includes(taskId)
    await (first ? firstCommand : secondCommand).promise
    const target = first ? item : other
    target.quantities!.unmade = 1; target.quantities!.ready = 1; target.readyForDelivery = true
    await route.fulfill({ json: { id: target.taskId, affectedQuantity: 1 } })
  })
  for (const entry of [card, second]) {
    await entry.getByRole('spinbutton').fill('1')
    await entry.getByRole('button', { name: '制作完成', exact: true }).click()
  }
  secondCommand.release()
  await expect(second).toContainText('待制作 1 · 已备齐 1')
  await expect(second.getByRole('button', { name: '制作完成', exact: true })).toBeEnabled()
  await expect(card.getByRole('button', { name: '正在确认…' })).toBeDisabled()
  firstCommand.release()
  await expect(card).toContainText('待制作 1 · 已备齐 1')
  await expect(second).toContainText('待制作 1 · 已备齐 1')
  expect(await page.evaluate(() => (window as unknown as { scrollCalls: number }).scrollCalls)).toBe(0)
})

test('历史出品取消失败不恢复整份旧列表覆盖其他员工的进度', async ({ page }) => {
  const { state, card, item } = await kitchen(page)
  item.carryover = true
  const other = structuredClone(item)
  other.taskId = 'caaa0000-0000-4000-8000-000000000003'; other.item.productName = '其他员工正在制作'
  state.items.push(other); await refresh(page)
  const second = page.locator(`[data-action-fact-id="${other.taskId}"]`)
  const pending = gate()
  await page.route('**/api/commerce/kds/*/manager-cancel', async route => {
    await pending.promise
    state.fail = true
    await route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: '取消结果尚未确认' } } })
  })
  await card.getByRole('textbox').fill('已向现场核实取消')
  await card.getByRole('button', { name: '不再出品', exact: true }).click()
  await card.getByRole('button', { name: '确认取消遗留' }).click()
  other.quantities!.unmade = 1; other.quantities!.ready = 1; other.readyForDelivery = true
  await refresh(page); await expect(second).toContainText('待制作 1 · 已备齐 1')
  pending.release()
  await expect(page.getByText('出品更新失败，保留上次列表；恢复后才能继续确认。')).toBeVisible()
  await expect(second).toContainText('待制作 1 · 已备齐 1')
  await expect(second.getByRole('button', { name: '制作完成', exact: true })).toBeDisabled()
})

test('出品批次确认后等候读回，旧可配送份数不能再次提交', async ({ page }) => {
  const { state, item } = await kitchen(page, true, 'tom')
  Object.assign(item, { canDeliver: true, readyForDelivery: true, deliveryUnbatchedQuantity: 2 })
  item.quantities!.unmade = 0; item.quantities!.ready = 2
  await refresh(page)
  await page.getByText('合并本批配送单', { exact: true }).click()
  await page.getByLabel('隔离后厨刷新样本本批数量').fill('2')
  const hold = gate(); let commands = 0
  await page.route('**/api/operations/delivery-batches', async route => {
    commands++; Object.assign(item, { deliveryUnbatchedQuantity: 0 }); state.hold = hold
    await route.fulfill({ json: { data: { id: 'test-only-batch' } } })
  })
  await page.getByRole('button', { name: '确认本批备齐并生成配送单' }).click()
  await expect(page.getByRole('button', { name: '正在确认本批…' })).toBeDisabled()
  expect(commands).toBe(1)
  state.hold = null; hold.release()
  await expect(page.getByText('合并本批配送单', { exact: true })).toHaveCount(0)
  expect(commands).toBe(1)
})
