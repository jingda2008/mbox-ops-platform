import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

const repo = resolve(import.meta.dirname, '../..')
let javascript: string
let css: string

// Render the real shared component with production CSS, without service requests.
// A pointer context also exercises the production hover media query.
test.use({ hasTouch: false, isMobile: false })
test.beforeAll(async () => {
  const result = await build({
    stdin: {
      resolveDir: repo,
      loader: 'tsx',
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { StaffBottomNavigation } from './src/normalized-ui/NormalizedStaffWorkspace';
        const entries = [['payments', '收银复核'], ['live', '现场'], ['orders', '订单'], ['member-fulfillment', '会员']]
          .map(([code, label]) => ({ code, label, route: '/staff/' + code }));
        window.renderNavigation = (inside, disabled = false) => {
          const nav = <StaffBottomNavigation entries={entries} roleCodes={['CASHIER']}
            activeRoute='/staff/payments' onNavigate={disabled ? undefined : () => {}} />;
          createRoot(document.getElementById('root')).render(inside
            ? <main className='normalized-workspace'>{nav}</main>
            : <><main className='normalized-workspace' />{nav}</>);
        };
      `,
    },
    bundle: true, write: false, outfile: 'fixture.js', format: 'iife', platform: 'browser',
    jsx: 'automatic', loader: { '.png': 'dataurl' },
  })
  javascript = result.outputFiles.find((file) => file.path.endsWith('.js'))!.text
  css = `${await readFile(resolve(repo, 'src/normalized-base.css'), 'utf8')}\n${result.outputFiles.find((file) => file.path.endsWith('.css'))!.text}`
})

async function mount(page: Page, inside: boolean, disabled = false) {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.route('**/*', (route) => route.abort())
  await page.setContent('<html lang="zh-CN"><head><title>隔离岗位导航</title></head><body><div id="root"></div></body></html>')
  await page.addStyleTag({ content: css })
  await page.addScriptTag({ content: javascript })
  await page.evaluate(({ inside, disabled }) => {
    (window as unknown as { renderNavigation: (inside: boolean, disabled: boolean) => void }).renderNavigation(inside, disabled)
  }, { inside, disabled })
  await expect(page.locator('.normalized-mobile-nav button')).toHaveCount(5)
}

async function setUnderlay(page: Page, color: string) {
  await page.locator('main').evaluate((main, background) => {
    main.style.background = background
    main.style.minHeight = '2000px'
  }, color)
}

async function setTextScale(page: Page, scale: 1 | 2) {
  await page.locator('.normalized-mobile-nav button').evaluateAll((buttons, factor) => {
    for (const button of buttons) {
      const style = (button as HTMLElement).style
      style.removeProperty('font-size')
      style.removeProperty('line-height')
    }
    if (factor === 1) return
    const sizes = buttons.map((button) => ({ button, font: parseFloat(getComputedStyle(button).fontSize) }))
    for (const { button, font } of sizes) (button as HTMLElement).style.fontSize = `${font * factor}px`
  }, scale)
}

async function assertContrast(page: Page) {
  const results = await new AxeBuilder({ page }).include('.normalized-mobile-nav').withRules(['color-contrast']).analyze()
  expect(results.violations).toEqual([])
  // These controlled solid underlays must produce a decision, not a manual-review result.
  expect(results.incomplete).toEqual([])
}

for (const inside of [false, true]) {
  test(`mobile navigation contrast survives content underlay and text restoration: ${inside ? 'workspace' : 'app sibling'}`, async ({ page }, info) => {
    await mount(page, inside)
    const navigation = page.locator('.normalized-mobile-nav')
    const inactive = navigation.getByRole('button', { name: '订单', exact: true })
    const active = navigation.getByRole('button', { name: '收银复核', exact: true })
    for (const width of [320, 390]) {
      for (const backdrop of ['#ffffff', '#000000', '#167852']) {
        await page.setViewportSize({ width, height: 844 })
        await setUnderlay(page, backdrop)
        for (const scale of [1, 2, 1] as const) {
          await setTextScale(page, scale)
          expect(await inactive.evaluate((element) => getComputedStyle(element).fontSize)).toBe(`${11 * scale}px`)
          // Keep the actual cascade: the old gold span rule must not override the current icon.
          expect(await active.locator('.normalized-nav-icon').evaluate((element) => getComputedStyle(element).color))
            .toBe(inside ? 'rgb(49, 93, 70)' : 'rgb(22, 120, 82)')
          await assertContrast(page)
          if (width === 320 && backdrop === '#000000') {
            await page.screenshot({ path: info.outputPath(`nav-${scale * 100}.png`) })
          }
        }
      }
    }
    expect(await inactive.evaluate((element) => (element as HTMLElement).style.fontSize)).toBe('')
    expect(await inactive.evaluate((element) => (element as HTMLElement).style.color)).toBe('')
    await inactive.focus()
    await assertContrast(page)
    await inactive.hover()
    expect(await inactive.evaluate((element) => getComputedStyle(element).filter)).toBe('brightness(0.985)')
    await assertContrast(page)
    await page.mouse.down()
    try { await assertContrast(page) } finally { await page.mouse.up() }
  })
}

test('disabled navigation remains disabled without muting active application controls', async ({ page }) => {
  await mount(page, false, true)
  await setUnderlay(page, '#000000')
  const navigation = page.locator('.normalized-mobile-nav')
  await expect(navigation.getByRole('button', { name: '订单', exact: true })).toBeDisabled()
  const menu = navigation.getByRole('button', { name: '全部岗位入口', exact: true })
  await expect(menu).toBeEnabled()
  expect(await menu.evaluate((element) => getComputedStyle(element).opacity)).toBe('1')
  await assertContrast(page)
})
