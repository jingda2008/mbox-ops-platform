import { mkdir, readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

interface Fixture {
  guestUrl: string
  staffUrl: string
  dailyCredential: string
  employeeCode: string
  employeePin: string
}

const previewDir = 'outputs/final-mobile-previews-2026-08-16'
const viewports = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
] as const

test.beforeAll(async () => mkdir(previewDir, { recursive: true }))

async function fixture(): Promise<Fixture> {
  return JSON.parse(await readFile(
    process.env.NORMALIZED_E2E_FIXTURE_FILE ?? 'artifacts/normalized-browser/fixture.json',
    'utf8',
  )) as Fixture
}

async function expectNoHorizontalOverflow(page: Page, label: string) {
  const size = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    page: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
  }))
  expect(size.page, `${label} horizontal overflow`).toBeLessThanOrEqual(size.viewport + 1)
}

async function expectTouchTargets(page: Page, root: string, label: string) {
  const undersized = await page.locator(root).evaluate((container) => (
    [...container.querySelectorAll<HTMLElement>('button, input:not([type="hidden"]), select, textarea, summary, a[href]')]
      .flatMap((control) => {
        const style = getComputedStyle(control)
        const ownRect = control.getBoundingClientRect()
        if (style.display === 'none' || style.visibility === 'hidden' || ownRect.width === 0 || ownRect.height === 0) return []
        const inputType = control instanceof HTMLInputElement ? control.type : ''
        const target = inputType === 'checkbox' || inputType === 'radio' ? control.closest('label') ?? control : control
        const rect = target.getBoundingClientRect()
        return rect.width >= 44 && rect.height >= 44 ? [] : [{
          name: control.getAttribute('aria-label') ?? control.textContent?.trim().slice(0, 36) ?? control.tagName,
          width: Math.round(rect.width), height: Math.round(rect.height),
        }]
      })
  ))
  expect(undersized, `${label} undersized touch targets`).toEqual([])
}

async function expectFixedFiveTabs(page: Page) {
  const nav = page.getByRole('navigation', { name: '小程序主导航' })
  const buttons = nav.getByRole('button')
  await expect(buttons).toHaveCount(5)
  await expect(buttons.allTextContents()).resolves.toEqual(['首页', '预约', '点单', '超嗨', '我的'])
  const hidden = await buttons.evaluateAll((items) => items.flatMap((item) => {
    const style = getComputedStyle(item)
    const rect = item.getBoundingClientRect()
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height >= 44
      ? []
      : [item.textContent?.trim() ?? 'unknown']
  }))
  expect(hidden, 'fixed five-tab navigation must stay visible').toEqual([])
}

async function captureExpandedPreview(page: Page, name: string) {
  await expectFixedFiveTabs(page)
  await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>('.mini-preview-shell')
    const content = document.querySelector<HTMLElement>('.mini-preview-content')
    if (!shell || !content) throw new Error('mini preview shell is missing')
    shell.style.height = 'auto'
    shell.style.minHeight = '100dvh'
    shell.style.gridTemplateRows = '36px auto 70px'
    content.style.overflow = 'visible'
  })
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
  await page.screenshot({ path: `${previewDir}/${name}.png`, fullPage: true, animations: 'disabled' })
}

async function openPreview(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height })
  await page.goto('/mini-preview')
  await expect(page.getByLabel('M-BOX 小程序交互预览')).toBeVisible()
  await expectNoHorizontalOverflow(page, `${width}px preview`)
}

test('five-tab customer preview keeps pre-scan menu browsing, three-step reservation, activities and benefits usable at 320/390', async ({ page }) => {
  for (const viewport of viewports) {
    const suffix = String(viewport.width)
    await openPreview(page, viewport.width, viewport.height)
    await expectFixedFiveTabs(page)
    await expect(page.getByText(/语音记录|麦克风/)).toHaveCount(0)
    await expectTouchTargets(page, '.mini-preview-shell', `${suffix}px home`)
    await captureExpandedPreview(page, `guest-home-${suffix}`)

    await openPreview(page, viewport.width, viewport.height)
    await page.getByRole('button', { name: '点单', exact: true }).click()
    await expect(page.getByRole('heading', { name: '先看今晚，再决定怎么喝' })).toBeVisible()
    await expect(page.getByText('菜单与价格可以提前浏览；到店扫码后连接实时库存、购物车和付款。')).toBeVisible()
    await expect(page.getByText('两人微醺现场')).toBeVisible()
    await expect(page.getByRole('button', { name: '到店扫码点单' })).toBeVisible()
    await expectTouchTargets(page, '.mini-preview-shell', `${suffix}px order browsing`)
    await captureExpandedPreview(page, `order-browsing-${suffix}`)

    await openPreview(page, viewport.width, viewport.height)
    await page.getByRole('button', { name: '点单', exact: true }).click()
    await page.getByRole('button', { name: '到店扫码点单' }).click()
    await expect(page.getByText('陆家嘴店 · A08桌 · 已开台')).toBeVisible()
    await expect(page.getByText('两人微醺现场')).toBeVisible()
    await expectTouchTargets(page, '.mini-preview-shell', `${suffix}px menu`)
    await captureExpandedPreview(page, `order-menu-${suffix}`)

    await openPreview(page, viewport.width, viewport.height)
    await page.getByRole('button', { name: '预约', exact: true }).click()
    await expect(page.getByLabel('预约第1步')).toBeVisible()
    await page.getByRole('button', { name: '下一步' }).click()
    await expect(page.getByLabel('预约第2步')).toBeVisible()
    await expect(page.getByText('当晚 21:30 有现场演出')).toBeVisible()
    await captureExpandedPreview(page, `reservation-show-step-${suffix}`)
    await openPreview(page, viewport.width, viewport.height)
    await page.getByRole('button', { name: '预约', exact: true }).click()
    await page.getByRole('button', { name: '下一步' }).click()
    await page.getByRole('button', { name: '下一步' }).click()
    await expect(page.getByLabel('预约第3步')).toBeVisible()
    await expect(page.getByRole('heading', { name: '确认你的预约' })).toBeVisible()
    await expectTouchTargets(page, '.mini-preview-shell', `${suffix}px reservation`)
    await captureExpandedPreview(page, `reservation-confirm-${suffix}`)

    await openPreview(page, viewport.width, viewport.height)
    await page.getByRole('button', { name: '超嗨', exact: true }).click()
    await page.locator('.mini-event-card').first().getByRole('button', { name: /详情/ }).click()
    await expect(page.getByRole('heading', { name: /歌手主场后的/ })).toBeVisible()
    await expect(page.getByText('报名成功赠送饮品券 1 张')).toBeVisible()
    await expect(page.getByRole('button', { name: '收费报名暂未开放' })).toBeDisabled()
    await expect(page.getByText('当前不会创建报名、占用名额或发起扣款')).toBeVisible()
    await captureExpandedPreview(page, `superhigh-paid-blocked-${suffix}`)

    await openPreview(page, viewport.width, viewport.height)
    await page.getByRole('button', { name: '超嗨', exact: true }).click()
    await page.locator('.mini-event-card').filter({ hasText: '陆家嘴夜景音乐散步' }).getByRole('button', { name: /详情/ }).click()
    await expect(page.getByRole('heading', { name: /陆家嘴夜景/ })).toBeVisible()
    await expect(page.getByRole('button', { name: '免费报名' })).toBeEnabled()
    await expect(page.getByText('签到后赠送无酒精饮品券')).toBeVisible()
    await expectTouchTargets(page, '.mini-preview-shell', `${suffix}px free activity`)
    await captureExpandedPreview(page, `superhigh-free-detail-${suffix}`)

    await openPreview(page, viewport.width, viewport.height)
    await page.getByRole('button', { name: '我的', exact: true }).click()
    await expect(page.getByRole('heading', { name: '你的今晚，都在这里' })).toBeVisible()
    await expect(page.getByRole('heading', { name: '邀请加入 M-BOX 会员' })).toBeVisible()
    await expect(page.getByRole('button', { name: /0 优惠券/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /超嗨活动 1 场已报名/ })).toBeVisible()
    await expect(page.getByText('已报名的超嗨活动')).toBeVisible()
    await expectTouchTargets(page, '.mini-preview-shell', `${suffix}px profile`)
    await captureExpandedPreview(page, `member-benefits-${suffix}`)
  }
})

test('waiting_for_table resumes the same trusted QR into the real menu without another scan', async ({ page }) => {
  const data = await fixture()
  let attempts = 0
  await page.route('**/api/guest/session/scan', async (route) => {
    attempts += 1
    if (attempts > 1) return route.continue()
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
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(data.guestUrl)
  await expect(page.getByRole('heading', { name: '欢迎入座，请联系服务人员开台' })).toBeVisible()
  await page.getByRole('button', { name: '立即刷新' }).click()
  await expect(page.getByTestId('normalized-guest-app')).toBeVisible()
  await expect(page.getByLabel('搜索菜单商品')).toBeVisible()
  await expect(page.getByText('请重新扫描')).toHaveCount(0)
  expect(attempts).toBe(2)
  await expectNoHorizontalOverflow(page, 'waiting_for_table recovery')
})

test('employee observation voice stays inside the staff table action and customer surfaces have no voice entry', async ({ page }) => {
  const data = await fixture()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(data.staffUrl)
  await page.getByLabel('门店口令').fill(data.dailyCredential)
  await page.getByRole('button', { name: /验证设备/ }).click()
  await page.getByLabel('员工账号').fill(data.employeeCode)
  await page.getByLabel('四位 PIN').fill(data.employeePin)
  await page.getByRole('button', { name: /进入工作台/ }).click()
  await expect(page.getByTestId('normalized-workspace')).toBeVisible()
  await page.goto('/staff/live')
  await page.getByLabel('搜索桌号或区域').fill('W01')
  await page.locator('.staff-table-tile').filter({ hasText: 'W01' }).click()
  await page.getByRole('button', { name: '记录桌台情况' }).click()
  const observation = page.getByRole('dialog', { name: 'W01记录桌台情况' })
  await expect(observation).toBeVisible()
  await expect(observation.getByRole('button', { name: '语音记录' })).toBeVisible()
  await expect(observation.getByText('点击后才会申请麦克风；原始录音不保存')).toBeVisible()
  await expectTouchTargets(page, '.staff-observation-sheet', 'staff observation')
  await expectNoHorizontalOverflow(page, 'staff observation')
  await page.screenshot({ path: `${previewDir}/staff-observation-voice-390.png`, fullPage: true, animations: 'disabled' })

  await page.goto('/mini-preview')
  await expect(page.getByText(/语音记录|麦克风/)).toHaveCount(0)
  await page.getByRole('button', { name: '我的', exact: true }).click()
  await expect(page.getByText(/语音记录|麦克风/)).toHaveCount(0)
})
