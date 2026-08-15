import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const baseUrl = process.env.NORMALIZED_PREVIEW_BASE_URL ?? 'http://127.0.0.1:18789'
const fixture = JSON.parse(await readFile(resolve(
  process.env.NORMALIZED_E2E_FIXTURE_FILE ?? 'artifacts/normalized-preview/fixture.json',
), 'utf8'))
const outputDir = resolve(process.env.NORMALIZED_PREVIEW_OUTPUT_DIR ?? 'outputs/normalization-v23-audit/previews')
await mkdir(outputDir, { recursive: true })

const browser = await chromium.launch({ headless: true })
const manifest = []

try {
  await capturePublic('guest-desktop', { width: 1440, height: 1000 }, fixture.guestUrl, '[data-testid="normalized-guest-app"]')
  await capturePublic('guest-tablet', { width: 1024, height: 900 }, fixture.guestUrl, '[data-testid="normalized-guest-app"]')
  await capturePublic('guest-mobile', { width: 390, height: 844 }, fixture.guestUrl, '[data-testid="normalized-guest-app"]')
  await capturePublic('guest-mobile-compact', { width: 320, height: 568 }, fixture.guestUrl, '[data-testid="normalized-guest-app"]')
  await capturePublic('guest-mobile-landscape', { width: 844, height: 390 }, fixture.guestUrl, '[data-testid="normalized-guest-app"]')
  await capturePublic('reservation-desktop', { width: 1440, height: 1000 }, fixture.reservationUrl, '[data-testid="reservation-booking"]')
  await capturePublic('reservation-mobile', { width: 390, height: 844 }, fixture.reservationUrl, '[data-testid="reservation-booking"]', async (page) => {
    await page.getByRole('button', { name: /下一步：位置与联系/ }).click()
    await page.getByRole('heading', { name: '位置与联系' }).waitFor()
  })
  await capturePublic('reservation-mobile-compact', { width: 320, height: 568 }, fixture.reservationUrl, '[data-testid="reservation-booking"]')
  await captureMember('member-mobile', { width: 390, height: 844 })
  await captureMember('member-mobile-compact', { width: 320, height: 568 })

  await captureStaff('staff-home-tablet', { width: 1024, height: 900 })
  await captureStaff('staff-home-mobile', { width: 390, height: 844 }, undefined, false)
  await captureStaff('tasks-mobile', { width: 390, height: 844 }, async (page) => {
    await page.goto(`${baseUrl}/staff/tasks`)
    await page.getByRole('heading', { name: '只看需要服务的事' }).waitFor()
  }, false)
  await captureStaff('cashier-mobile', { width: 390, height: 844 }, async (page) => {
    await page.goto(`${baseUrl}/staff/payments`)
    await page.getByRole('heading', { name: '收银与退款' }).waitFor()
  }, false)
  await captureStaff('responsibility-mobile', { width: 390, height: 844 }, async (page) => {
    await page.getByRole('button', { name: '现场', exact: true }).first().click()
    await page.getByRole('button', { name: /人员与责任桌/ }).click()
    await page.getByText(/区域批量发布使用同一事务/).waitFor()
    await page.getByLabel('员工').selectOption({ label: '李艳 · liyan' })
    await page.getByLabel('本次岗位').selectOption({ label: '店长 · MANAGER' })
    await page.getByLabel('搜索责任区域或桌台').fill('W01')
    await page.locator('.staff-assignment-area label').getByRole('checkbox').check()
    await page.getByLabel('安排原因').fill('预览：李艳负责本桌晚班服务')
  }, false)
  await captureStaff('performance-tablet', { width: 1024, height: 900 }, async (page) => {
    await page.goto(`${baseUrl}/staff/performance`)
    await page.getByRole('heading', { name: '演出与点歌' }).waitFor()
    await page.getByText('林小满', { exact: true }).first().waitFor()
    await page.getByRole('button', { name: '维护歌单' }).click()
    await page.getByText(/可搜索、批量导入、逐首修改/).waitFor()
  })
  await captureStaff('performance-mobile', { width: 390, height: 844 }, async (page) => {
    await page.goto(`${baseUrl}/staff/performance`)
    await page.getByRole('heading', { name: '演出与点歌' }).waitFor()
    await page.getByText('林小满', { exact: true }).first().waitFor()
  }, false)
  await captureStaff('settings-payment-mobile', { width: 390, height: 844 }, async (page) => {
    await page.goto(`${baseUrl}/staff/settings`)
    await page.getByRole('heading', { name: '系统配置状态' }).waitFor()
    await page.locator('.staff-payment-policy').waitFor({ state: 'visible' })
    await page.getByText('正在读取最新状态', { exact: true }).waitFor({ state: 'hidden' })
    await page.waitForTimeout(300)
    await page.locator('.staff-payment-policy').waitFor({ state: 'visible' })
  }, false)
  await captureStaff('settings-catalog-desktop', { width: 1440, height: 1000 }, async (page) => {
    await page.goto(`${baseUrl}/staff/settings`)
    await page.getByRole('button', { name: /商品、售价与推荐/ }).click()
    await page.getByLabel('搜索配置商品').waitFor()
    await page.getByRole('button', { name: '编辑', exact: true }).first().click()
    await page.getByLabel('成本金额（元）').waitFor()
  }, false)
  await captureStaff('settings-catalog-mobile', { width: 390, height: 844 }, async (page) => {
    await page.goto(`${baseUrl}/staff/settings`)
    await page.getByRole('button', { name: /商品、售价与推荐/ }).click()
    await page.getByLabel('搜索配置商品').waitFor()
    await page.getByRole('button', { name: '编辑', exact: true }).first().click()
    await page.getByLabel('成本金额（元）').waitFor()
    await page.getByText(/显示高级字段/).waitFor()
  }, false)
  await captureStaff('settings-catalog-fields-desktop', { width: 1440, height: 1000 }, async (page) => {
    await page.goto(`${baseUrl}/staff/settings`)
    await page.getByRole('button', { name: /商品、售价与推荐/ }).click()
    await page.getByLabel('搜索配置商品').waitFor()
    await page.getByRole('button', { name: '编辑', exact: true }).first().click()
    await page.getByLabel('成本金额（元）').scrollIntoViewIfNeeded()
  }, false)
  await captureStaff('settings-venue-tablet', { width: 1024, height: 900 }, async (page) => {
    await page.goto(`${baseUrl}/staff/settings`)
    await page.getByRole('button', { name: /区域、桌台与容量/ }).click()
    await page.locator('.venue-management-list').waitFor()
  })
} finally {
  await browser.close()
}

await writeFile(resolve(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
process.stdout.write(`${outputDir}\n${manifest.map((entry) => `${entry.name}: ${entry.pageWidth}/${entry.viewportWidth}`).join('\n')}\n`)

async function capturePublic(name, viewport, route, readySelector, prepare) {
  const context = await browser.newContext({ viewport, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
  try {
    const page = await context.newPage()
    await page.goto(new URL(route, baseUrl).toString(), { waitUntil: 'networkidle' })
    await page.locator(readySelector).waitFor()
    if (prepare) await prepare(page)
    await record(page, name, viewport)
  } finally {
    await context.close()
  }
}

async function captureStaff(name, viewport, prepare, fullPage = true) {
  const context = await browser.newContext({ viewport, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
  try {
    const page = await context.newPage()
    await page.goto(new URL(fixture.staffUrl, baseUrl).toString())
    await page.getByLabel('门店口令').fill(fixture.dailyCredential)
    await page.getByRole('button', { name: /验证设备/ }).click()
    await page.getByLabel('员工账号').fill(fixture.employeeCode)
    await page.getByLabel('四位 PIN').fill(fixture.employeePin)
    await page.getByRole('button', { name: /进入工作台/ }).click()
    await page.getByTestId('normalized-workspace').waitFor()
    if (prepare) await prepare(page)
    await record(page, name, viewport, fullPage)
  } finally {
    await context.close()
  }
}

async function captureMember(name, viewport) {
  const context = await browser.newContext({ viewport, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
  try {
    const page = await context.newPage()
    await page.goto(new URL(fixture.guestUrl, baseUrl).toString(), { waitUntil: 'networkidle' })
    await page.locator('[data-testid="normalized-guest-app"]').waitFor()
    await page.goto(new URL('/member', baseUrl).toString(), { waitUntil: 'networkidle' })
    await page.getByRole('heading', { name: '我的权益' }).waitFor()
    await record(page, name, viewport)
  } finally {
    await context.close()
  }
}

async function record(page, name, viewport, fullPage = true) {
  await page.screenshot({ path: resolve(outputDir, `${name}.png`), fullPage })
  const dimensions = await page.evaluate(() => ({
    pageWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    pageHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
  }))
  manifest.push({ name, viewportWidth: viewport.width, viewportHeight: viewport.height, ...dimensions })
}
