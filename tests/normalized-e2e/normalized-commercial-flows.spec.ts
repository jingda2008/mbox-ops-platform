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
  await expect(page.getByText('W01', { exact: true })).toBeVisible()

  const search = page.getByLabel('搜索所有商品')
  await search.fill(data.orderableProductName)
  const add = page.getByRole('button', { name: `加入${data.orderableProductName}` })
  await expect(add).toBeVisible()
  await add.click()
  await page.getByRole('button', { name: /核对订单/ }).click()
  await page.getByPlaceholder('例如：少冰、生日桌、一起上').fill('浏览器验收备注')
  await page.getByRole('button', { name: /确认订单并继续支付/ }).click()

  const resultDialog = page.getByRole('dialog', { name: '订单与支付状态' })
  await expect(resultDialog.getByRole('heading', { name: '测试订单已建立' })).toBeVisible()
  await expect(resultDialog).toContainText('没有产生真实收款')
  await expect(page.getByText('备注已重点标记给出品和配送人员')).toBeVisible()
  await expect(page.getByText('本次应付')).toBeVisible()
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
})
