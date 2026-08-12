import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

interface Fixture {
  guestUrl: string
  reservationUrl: string
  staffUrl: string
  dailyCredential: string
  employeeCode: string
  employeePin: string
  orderableProductName: string
}

async function fixture(): Promise<Fixture> {
  return JSON.parse(await readFile(
    process.env.NORMALIZED_E2E_FIXTURE_FILE ?? 'artifacts/normalized-browser/fixture.json',
    'utf8',
  )) as Fixture
}

test('mobile guest scans a fixed table QR, searches, orders and sees payment result', async ({ page }) => {
  const data = await fixture()
  await page.goto(data.guestUrl)
  await expect(page.getByTestId('normalized-guest-app')).toBeVisible()
  await expect(page.getByRole('button', { name: /本桌已点.*W01/ })).toBeVisible()

  const search = page.getByLabel('搜索菜单商品')
  await search.fill(data.orderableProductName)
  const add = page.getByRole('button', { name: `加入${data.orderableProductName}` })
  await expect(add).toBeVisible()
  await add.click()
  await page.getByRole('button', { name: /核对订单/ }).click()
  const cart = page.getByRole('dialog', { name: '购物车明细' })
  await cart.getByPlaceholder('如：少冰、不要香菜、酒水和小食一起上').fill('浏览器验收备注')
  await cart.getByRole('button', { name: /确认订单并微信支付/ }).click()
  await page.getByRole('dialog', { name: '确认上单' }).getByRole('button', { name: '确认上单' }).click()

  const resultDialog = page.getByRole('dialog', { name: '订单与支付状态' })
  await expect(resultDialog.getByRole('heading', { name: '测试订单已建立' })).toBeVisible()
  await expect(resultDialog).toContainText('没有产生真实收款')
  await expect(page.getByText('备注已重点标记给出品和配送人员')).toBeVisible()
  await expect(page.getByText('本次应付')).toBeVisible()

  await resultDialog.getByRole('button', { name: '返回菜单' }).click()
  await page.getByRole('button', { name: /本桌已点/ }).click()
  const tableOrders = page.getByRole('dialog', { name: '本桌已点' })
  await expect(tableOrders).toContainText(data.orderableProductName)
  await expect(tableOrders).toContainText(/等待付款|准备中|已送齐/)
  await tableOrders.getByRole('button', { name: '关闭' }).click()

  await page.getByRole('button', { name: `加入${data.orderableProductName}` }).click()
  await page.getByRole('dialog', { name: '确认继续加单' }).getByRole('button', { name: '继续选商品' }).click()
  await page.getByRole('button', { name: /核对订单/ }).click()
  await page.getByRole('dialog', { name: '购物车明细' }).getByRole('button', { name: /确认订单并微信支付/ }).click()
  await page.getByRole('dialog', { name: '确认上单' }).getByRole('button', { name: '确认上单' }).click()
  await expect(page.getByRole('alert')).toContainText(`本桌刚点过 ${data.orderableProductName}`)
  await expect(page.getByRole('button', { name: '确认继续加单' })).toBeVisible()
})

test('mobile public reservation loads real availability and seat details', async ({ page }) => {
  const data = await fixture()
  await page.goto(data.reservationUrl)
  await expect(page.getByTestId('reservation-booking')).toBeVisible()
  await expect(page.getByText('已连接微信')).toBeVisible()
  await page.getByRole('button', { name: /查看可订座位/ }).click()
  await expect(page.getByRole('heading', { name: '选一种预约方式' })).toBeVisible()
  await page.getByRole('button', { name: /座位自选/ }).click()
  const availableTable = page.locator('.reservation-table.is-available').first()
  await expect(availableTable).toBeVisible()
  await availableTable.click()
  await expect(page.locator('.reservation-table-detail')).toContainText('可预约')
  await expect(page.getByRole('button', { name: '下一步' })).toBeEnabled()
})

test('mobile public reservation silently renews one expired session before submit', async ({ page }) => {
  const data = await fixture()
  let reservationAttempts = 0
  await page.route('**/api/public/reservations', async (route) => {
    if (route.request().method() !== 'POST' || reservationAttempts > 0) {
      await route.continue()
      return
    }
    reservationAttempts += 1
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'RESERVATION_SESSION_INVALID',
          message: '预约会话已失效，请重新进入预约页面',
        },
      }),
    })
  })

  await page.goto(data.reservationUrl)
  await expect(page.getByText('已连接微信')).toBeVisible()
  await page.getByRole('button', { name: /查看可订座位/ }).click()
  await page.getByRole('button', { name: /直接预约/ }).click()
  await page.getByLabel('预约姓名').fill('会话恢复验收')
  await page.getByLabel('手机或微信').fill('13800138001')
  await page.getByRole('button', { name: '确认预约' }).click()

  await expect(page.getByRole('heading', { name: '预约已提交' })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(reservationAttempts).toBe(1)
})

test('mobile manager completes device verification and reaches role-scoped workspace', async ({ page }) => {
  const data = await fixture()
  await page.goto(data.staffUrl)
  await page.getByLabel('门店口令').fill(data.dailyCredential)
  await page.getByRole('button', { name: /验证设备/ }).click()
  await page.getByLabel('员工账号').fill(data.employeeCode)
  await page.getByLabel('四位 PIN').fill(data.employeePin)
  await page.getByRole('button', { name: /进入工作台/ }).click()

  await expect(page.getByTestId('normalized-workspace')).toBeVisible()
  await expect(page.getByRole('heading', { name: '李艳' })).toBeVisible()
  await expect(page.getByText(/店长/)).toBeVisible()
  await expect(page.getByRole('heading', { name: '现在要做什么' })).toBeVisible()

  await page.getByRole('button', { name: '预约到店', exact: true }).first().click()
  await expect(page.getByText('预约与到店', { exact: true })).toBeVisible()
  await expect(page.getByText('规范化改造中')).toHaveCount(0)
})

test('mobile manager assists an open table order and gifts a product without mixing member benefits', async ({ page }) => {
  const data = await fixture()
  await page.goto(data.staffUrl)
  await page.getByLabel('门店口令').fill(data.dailyCredential)
  await page.getByRole('button', { name: /验证设备/ }).click()
  await page.getByLabel('员工账号').fill(data.employeeCode)
  await page.getByLabel('四位 PIN').fill(data.employeePin)
  await page.getByRole('button', { name: /进入工作台/ }).click()

  await page.getByRole('button', { name: '现场', exact: true }).first().click()
  await expect(page.getByRole('heading', { name: '现在要处理什么' })).toBeVisible()
  await page.getByRole('button', { name: /W01.*已开台/ }).click()
  await expect(page.getByRole('button', { name: '协助点单' })).toBeVisible()
  await expect(page.getByRole('button', { name: '赠送商品' })).toBeVisible()
  await expect(page.getByText('会员权益')).toHaveCount(0)

  await page.getByRole('button', { name: '协助点单' }).click()
  const paidSheet = page.getByRole('dialog', { name: 'W01协助点单' })
  await paidSheet.getByLabel('搜索菜单商品').fill(data.orderableProductName)
  await paidSheet.getByTitle(`加入${data.orderableProductName}`).click()
  await paidSheet.getByRole('button', { name: '核对订单' }).click()
  await paidSheet.getByRole('dialog', { name: '购物车明细' }).getByRole('button', { name: '核对无误，确认下单' }).click()
  await paidSheet.getByRole('dialog', { name: '确认上单' }).getByRole('button', { name: '确认上单' }).click()
  await expect(page.getByRole('status')).toContainText('W01 订单已挂桌并发送出品')

  await page.getByRole('button', { name: '赠送商品' }).click()
  const giftSheet = page.getByRole('dialog', { name: 'W01赠送商品' })
  await expect(giftSheet).toContainText('按本人岗位额度执行，赠送原因全程留痕')
  await expect(giftSheet.getByText('会员权益')).toHaveCount(0)
  await giftSheet.getByLabel('搜索点单商品').fill(data.orderableProductName)
  await giftSheet.getByRole('button', { name: `添加${data.orderableProductName}` }).click()
  await giftSheet.getByLabel('赠送原因').fill('浏览器验收生日关怀')
  await giftSheet.getByRole('button', { name: '确认赠送并出品' }).click()
  await expect(page.getByRole('status')).toContainText('W01 商品已赠送并发送出品')
})
