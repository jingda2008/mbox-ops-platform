import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import type { CashierWorkbenchView } from '../../src/shared/cashier-workbench-contracts'

type RecoveryStatus = NonNullable<CashierWorkbenchView['orders'][number]['closedDebtRecovery']>['status']

async function login(page: Page) {
  const fixture = JSON.parse(await readFile(process.env.NORMALIZED_E2E_FIXTURE_FILE ?? 'artifacts/normalized-browser/fixture.json', 'utf8'))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(fixture.staffUrl)
  await page.getByLabel('门店口令').fill(fixture.dailyCredential)
  await page.getByRole('button', { name: /验证设备/ }).click()
  await page.getByLabel('员工账号').fill('sanmu')
  await page.getByLabel('四位 PIN').fill(fixture.employeePin)
  await page.getByRole('button', { name: /进入工作台/ }).click()
  await expect(page.getByTestId('normalized-workspace')).toBeVisible()
}

function workbench(status: RecoveryStatus): CashierWorkbenchView {
  return {
    businessDate: '2026-08-13', query: '',
    actions: { canInitiateOnlinePayment: true, canQueryOnlinePayment: true, onlinePaymentProvider: 'postar',
      canRecordManualCash: true, canRecordManualPos: true, canRecordManualExternal: true,
      canAuthorizeRecollection: true, canRequestRefund: false, canApproveRefund: false,
      canExecuteRefund: false, canViewReconciliation: true, canManageKdsException: false },
    summary: { orderCount: 1, capturedPaymentCount: 0, requestedRefundCount: 0, processingRefundCount: 0, carryoverOrderCount: 1 },
    orders: [{
      id: 'closed-debt-order', publicId: 'HISTORICAL-DEBT-ORIGINAL', tableCode: 'H01', channel: 'staff_assisted',
      tableSessionId: 'original-closed-session', tableSessionStatus: 'closed', status: 'submitted',
      paymentStatus: status === 'settled' ? 'paid' : 'unpaid', businessDate: '2026-08-12', carryover: true,
      totalAmountMinor: 4_000, outstandingAmountMinor: status === 'settled' ? 0 : 1_000, overCollectedAmountMinor: 0,
      currency: 'CNY', createdAt: '2026-08-12T12:00:00.000Z', submittedAt: '2026-08-12T12:00:00.000Z',
      closedDebtRecovery: { status, originalBusinessDate: '2026-08-12', pendingPaymentIds: status === 'pending_payment' ? ['original-pending-payment'] : [] },
      recollectionAuthorization: status === 'available' ? { id: 'original-debt-authorization', amountMinor: 1_000, expiresAt: '2026-08-13T12:30:00.000Z' } : null,
      items: [{ id: 'original-item', productName: '原订单已消费商品', quantity: 1, totalAmountMinor: 4_000, status: 'delivered' }], kdsTasks: [],
      payments: [{ id: 'original-pending-payment', publicId: 'ORIGINAL-PAYMENT', provider: 'postar', method: 'native_qr',
        providerTransactionId: null, providerActionState: 'failed', retryReleasedAt: '2026-08-12T12:03:00.000Z', retryReleaseReason: '原结果待核对',
        amountMinor: 1_000, currency: 'CNY', status: status === 'pending_payment' ? 'pending' : 'closed', succeededAt: null,
        createdAt: '2026-08-12T12:01:00.000Z', reservedRefundAmountMinor: 0, remainingRefundableMinor: 0, refundableItems: [], refunds: [] }],
    }],
  }
}

test('closed debt queries the original unknown payment before authorization and actual manual receipt', async ({ page }, testInfo) => {
  await login(page)
  let state: RecoveryStatus = 'pending_payment'
  const mutations: Array<{ path: string; body: unknown; key: string | undefined }> = []
  // This exercises the actual browser UI against explicit read-model/command
  // contracts. The isolated server supplies authentication only; no real
  // financial transition or historical migration is claimed by this fixture.
  await page.route('**/api/payments/workbench?*', route => route.fulfill({ json: { data: workbench(state) } }))
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (request.method() !== 'POST' || !['/api/payments/original-pending-payment/provider-query', '/api/orders/closed-debt-order/recollection-authorizations', '/api/payments/manual'].includes(path)) return route.fallback()
    mutations.push({ path, body: request.postDataJSON(), key: request.headers()['idempotency-key'] })
    state = path.endsWith('provider-query') ? 'authorization_required' : path.endsWith('recollection-authorizations') ? 'available' : 'settled'
    await route.fulfill({ json: { data: {}, meta: { replayed: false } } })
  })
  await page.goto('/staff/payments')
  const card = page.locator('[data-cashier-order-id="closed-debt-order"]')
  await card.locator('.cashier-order-toggle').click()
  await expect(card.getByText(/已放开重试的原付款也必须先核对/)).toBeVisible()
  for (const name of ['登记现金收款', '出示付款二维码', '扫顾客付款码']) await expect(card.getByRole('button', { name })).toHaveCount(0)
  await expect(card.getByText(/可直接继续收款/)).toHaveCount(0)
  await card.getByRole('button', { name: '查询渠道结果' }).click()
  await expect(card.getByLabel('已关桌订单补收授权')).toBeVisible()
  await card.getByLabel('重新收款原因').fill('核对历史欠款，顾客确认现金补收')
  await card.getByRole('button', { name: '核对并继续', exact: true }).click()
  expect(mutations).toHaveLength(1)
  await card.getByRole('button', { name: '确认授权重新收款' }).click()
  await card.getByRole('button', { name: '登记现金收款', exact: true }).click()
  await card.getByRole('button', { name: '核对并继续', exact: true }).click()
  await expect(card.getByText(/确认后按当前营业日计入收款和对账/)).toBeVisible()
  await expect(card.getByText(/允许继续结台/)).toHaveCount(0)
  await expect(card.getByRole('button', { name: '出示付款二维码' })).toHaveCount(0)
  expect(mutations).toHaveLength(2)
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, content: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) }))
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.width + 1)
  await page.screenshot({ path: testInfo.outputPath('closed-debt-confirmation-390.png'), fullPage: true })
  await card.getByRole('button', { name: '确认已收到现金' }).click()
  await expect(page.getByText('历史欠款补收已登记，实际收款按当前营业日入账并关联原订单；原桌次保持关闭。')).toBeVisible()
  await expect(card.getByRole('button', { name: '登记现金收款' })).toHaveCount(0)
  expect(mutations.map(entry => entry.path)).toEqual(['/api/payments/original-pending-payment/provider-query', '/api/orders/closed-debt-order/recollection-authorizations', '/api/payments/manual'])
  expect(mutations[0]!.body).toEqual({})
  expect(mutations[2]!.body).toEqual({ orderId: 'closed-debt-order', provider: 'cash', method: 'cash' })
  expect(mutations.every(entry => typeof entry.key === 'string' && entry.key.length > 0)).toBe(true)
})

test('refresh removes closed collection permission while ordinary open retry policy remains available', async ({ page }) => {
  await login(page)
  let view = workbench('available')
  await page.route('**/api/payments/workbench?*', route => route.fulfill({ json: { data: view } }))
  await page.goto('/staff/payments')
  const card = page.locator('[data-cashier-order-id="closed-debt-order"]')
  await card.locator('.cashier-order-toggle').click()
  await card.getByRole('button', { name: '登记现金收款' }).click()
  await card.getByRole('button', { name: '核对并继续', exact: true }).click()
  await expect(card.getByRole('button', { name: '确认已收到现金' })).toBeVisible()
  view = workbench('available')
  view.actions.canRecordManualCash = false
  await Promise.all([
    page.waitForResponse(response => response.url().includes('/api/payments/workbench?')),
    page.getByRole('button', { name: '刷新收银与退款', exact: true }).click(),
  ])
  if (await card.locator('.cashier-order-toggle').getAttribute('aria-expanded') !== 'true') await card.locator('.cashier-order-toggle').click()
  await expect(card.getByRole('button', { name: '确认已收到现金' })).toHaveCount(0)
  await expect(card.getByRole('button', { name: '登记现金收款' })).toHaveCount(0)
  await expect(card.getByRole('button', { name: '登记实体POS收款' })).toBeVisible()
  view = workbench('permission_required')
  await Promise.all([
    page.waitForResponse(response => response.url().includes('/api/payments/workbench?')),
    page.getByRole('button', { name: '刷新收银与退款', exact: true }).click(),
  ])
  if (await card.locator('.cashier-order-toggle').getAttribute('aria-expanded') !== 'true') await card.locator('.cashier-order-toggle').click()
  await expect(card.getByText(/当前账号没有处理已关桌欠款的权限/)).toBeVisible()
  await expect(card.getByRole('button', { name: '确认已收到现金' })).toHaveCount(0)
  await expect(card.getByRole('button', { name: '出示付款二维码' })).toHaveCount(0)
  view = workbench('pending_payment')
  view.orders[0]!.tableSessionStatus = 'open'
  delete view.orders[0]!.closedDebtRecovery
  await Promise.all([
    page.waitForResponse(response => response.url().includes('/api/payments/workbench?')),
    page.getByRole('button', { name: '刷新收银与退款', exact: true }).click(),
  ])
  if (await card.locator('.cashier-order-toggle').getAttribute('aria-expanded') !== 'true') await card.locator('.cashier-order-toggle').click()
  await expect(card.getByRole('button', { name: '登记现金收款' })).toBeVisible()
  await expect(card.getByRole('button', { name: '出示付款二维码' })).toBeVisible()
  await expect(card.getByRole('button', { name: '扫顾客付款码' })).toBeVisible()
})

test('local void requires an explicit server permission, a reason and confirmation on the original payment', async ({ page }) => {
  await login(page)
  let view = workbench('pending_payment')
  view.orders[0]!.closedDebtRecovery!.closableUnpresentedPaymentIds = ['original-pending-payment']
  view.orders[0]!.payments[0]!.providerActionState = null
  view.orders[0]!.payments[0]!.retryReleasedAt = null
  const requests: Array<{ body: unknown; key: string | undefined }> = []
  await page.route('**/api/payments/workbench?*', route => route.fulfill({ json: { data: view } }))
  await page.route('**/api/payments/original-pending-payment/close-unpresented-history', async route => {
    requests.push({ body: route.request().postDataJSON(), key: route.request().headers()['idempotency-key'] })
    view = workbench('authorization_required')
    await route.fulfill({ json: { data: {}, meta: { replayed: false } } })
  })
  await page.goto('/staff/payments')
  const card = page.locator('[data-cashier-order-id="closed-debt-order"]')
  await card.locator('.cashier-order-toggle').click()
  await card.getByRole('button', { name: '作废未外送付款', exact: true }).click()
  await expect(card.getByRole('button', { name: '核对并作废' })).toBeDisabled()
  await card.getByLabel('作废核对依据').fill('核对原付款从未外送，登记本地作废')
  await card.getByRole('button', { name: '核对并作废' }).click()
  expect(requests).toHaveLength(0)
  await expect(card.getByText(/没有执行退款，后续补收仍需核对原欠款和授权/)).toBeVisible()
  await expect(card.getByRole('button', { name: '登记现金收款' })).toHaveCount(0)
  await card.getByRole('button', { name: '确认作废本地付款' }).click()
  await expect(card.getByLabel('已关桌订单补收授权')).toBeVisible()
  await expect(card.getByRole('button', { name: '作废未外送付款', exact: true })).toHaveCount(0)
  expect(requests).toHaveLength(1)
  expect(requests[0]!.body).toEqual({ reason: '核对原付款从未外送，登记本地作废' })
  expect(requests[0]!.key).toMatch(/^cashier:payment-close-unpresented-history-original-pending-payment:/)
})


test('whole historical batch confirmation displays total and every original order on a narrow phone', async ({ page }, testInfo) => {
  await login(page)
  let view = workbench('pending_payment')
  view.actions.canQueryOnlinePayment = false // local void uses the distinct server four-permission allowlist
  view.orders[0]!.closedDebtRecovery!.closableUnpresentedPaymentIds = ['original-pending-payment']
  view.orders[0]!.closedDebtRecovery!.closableUnpresentedPayments = [{
    paymentId: 'original-pending-payment', payableKind: 'order_batch', totalAmountMinor: 3000, currency: 'CNY',
    orderIds: ['closed-debt-order', 'other-original-order'], orderPublicIds: ['HISTORICAL-DEBT-ORIGINAL', 'OTHER-ORIGINAL-ORDER-INCLUDING-SETTLED-MEMBER'],
  }]
  const requests: Array<{ body: unknown; key: string | undefined }> = []
  await page.route('**/api/payments/workbench?*', route => route.fulfill({ json: { data: view } }))
  await page.route('**/api/payments/original-pending-payment/close-unpresented-history', async route => {
    requests.push({ body: route.request().postDataJSON(), key: route.request().headers()['idempotency-key'] })
    view = workbench('authorization_required')
    await route.fulfill({ json: { data: { id: 'original-pending-payment', status: 'closed' }, meta: { replayed: false } } })
  })
  await page.goto('/staff/payments')
  const card = page.locator('[data-cashier-order-id="closed-debt-order"]')
  await card.locator('.cashier-order-toggle').click()
  await expect(card.getByText('整笔合并付款 ¥30.00', { exact: true })).toBeVisible()
  await expect(card.getByText('OTHER-ORIGINAL-ORDER-INCLUDING-SETTLED-MEMBER', { exact: true })).toBeVisible()
  await expect(card.getByText(/本订单分摊 ¥10.00/)).toBeVisible()
  await expect(card.getByRole('button', { name: '登记现金收款' })).toHaveCount(0)
  await expect(card.getByRole('button', { name: '查询渠道结果' })).toHaveCount(0)
  await card.getByRole('button', { name: '作废整个合并付款', exact: true }).click()
  await card.getByLabel('作废核对依据').fill('核对全部原订单，整笔付款从未外送')
  await card.getByRole('button', { name: '核对并作废' }).click()
  expect(requests).toHaveLength(0)
  await expect(card.getByText(/作废整个合并付款 ¥30.00，涉及以上全部 2 笔原订单/)).toBeVisible()
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, content: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) }))
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.width + 1)
  await page.screenshot({ path: testInfo.outputPath('whole-historical-batch-390.png'), fullPage: true })
  await card.getByRole('button', { name: '确认作废整个合并付款' }).click()
  await expect(card.getByLabel('已关桌订单补收授权')).toBeVisible()
  expect(requests).toHaveLength(1)
  expect(requests[0]!.body).toEqual({ reason: '核对全部原订单，整笔付款从未外送' })
  expect(requests[0]!.key).toMatch(/^cashier:payment-close-unpresented-history-original-pending-payment:/)
})
