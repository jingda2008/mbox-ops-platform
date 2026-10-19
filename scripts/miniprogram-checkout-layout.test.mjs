import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { chromium } from 'playwright'
const root = resolve(import.meta.dirname, '..')
async function css(file) {
  let source = await readFile(file, 'utf8')
  for (const match of [...source.matchAll(/@import\s+"([^"]+)";/g)]) source = source.replace(match[0], await css(resolve(dirname(file), match[1])))
  return source
}
test('expanded checkout keeps payment visible and every form control scrollable above custom navigation', async () => {
  const source = await readFile(resolve(root, 'miniprogram/pages/order/index.wxml'), 'utf8')
  const start = source.indexOf('  <view wx:if="{{checkoutConfirmVisible}}"')
  let markup = source.slice(start, source.indexOf('  <view wx:if="{{checkoutMemberInviteVisible}}"', start))
  // Render the actual WXML hierarchy; emulate only native tags and fixture values.
  markup = markup.replace('{{(customTabBarHeight || 50) + 1}}', '85')
    .replace(/disabled="[^"]*"/g, '').replace(/<input([^>]*?)\/>/g, '<input$1>')
    .replace(/\{\{[^}]+\}\}/g, expression => expression.includes('checkoutLocked ?') ? '确认支付' : expression.includes('cartTotal') ? '¥40.00' : expression.includes('item.name') ? '泰象气泡水' : expression.includes('pointsBalance') ? '0' : '')
  const style = await css(resolve(root, 'miniprogram/app.wxss')) + await css(resolve(root, 'miniprogram/pages/order/index.wxss'))
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    for (const [width, height] of [[320,568], [375,667], [393,852], [430,932], [720,360]]) {
      await page.setViewportSize({ width, height })
      await page.setContent(`<style>html,body{margin:0;font-family:sans-serif}view,block,scroll-view{display:block}scroll-view{overflow-y:auto!important}button{box-sizing:border-box;font-family:inherit}text{overflow-wrap:anywhere}${style.replace(/(-?[\d.]+)rpx\b/g, (_, n) => `${Number(n)*width/750}px`)}</style>${markup}<div style="position:fixed;bottom:0;left:0;right:0;height:85px;z-index:9999;background:white">navigation</div>`)
      await page.evaluate(() => {
        document.querySelectorAll('.checkout-upgrade,.checkout-upgrade__message,.cart-line__selection,.cart-line__unavailable,.coupon-portion').forEach(el => el.remove())
      })
      const assertFooter = async () => {
        for (const name of ['继续加购', '确认支付']) {
          const button = page.getByRole('button', { name, exact: true })
          const box = await button.boundingBox()
          assert.ok(box.height >= 44 && box.x >= 0 && box.x + box.width <= width + 1 && box.y >= 0 && box.y + box.height <= height - 85 + 1, `${name} visible above navigation at ${width}x${height}: ${JSON.stringify(box)}`)
          await button.click({ trial: true, timeout: 1000 })
        }
      }
      await assertFooter()
      for (const selector of ['[bindtap="quoteCheckoutCoupons"]','[bindtap="quoteCheckoutPoints"]','[bindinput="onCheckoutNoteInput"]']) {
        const control = page.locator(selector)
        assert.ok(await control.evaluate(el => Boolean(el.closest('scroll-view'))), `${selector} must share the scrolling form`)
        await control.scrollIntoViewIfNeeded()
        await control.click({ trial: true, timeout: 1000 })
        await assertFooter()
      }
      const scroll = await page.locator('scroll-view').evaluate(el => ({ height: el.clientHeight, content: el.scrollHeight }))
      assert.ok(scroll.height > 0 && scroll.content > scroll.height, 'long checkout content scrolls')
      assert.ok(await page.evaluate(() => document.body.scrollWidth <= innerWidth + 1), 'no horizontal overflow')
    }
  } finally { await browser.close() }
})
