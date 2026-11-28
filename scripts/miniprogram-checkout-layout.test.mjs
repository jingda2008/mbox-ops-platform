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
    .replace(/\{\{[^}]+\}\}/g, expression => expression.includes('已抵 ') ? '选择抵扣积分 ›' : expression.includes('checkoutLocked ?') ? '确认支付' : expression.includes('cartTotal') ? '¥40.00' : expression.includes('item.name') ? '泰象气泡水' : expression.includes('pointsBalance') ? '0' : '')
  const style = await css(resolve(root, 'miniprogram/app.wxss')) + await css(resolve(root, 'miniprogram/pages/order/index.wxss'))
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    for (const [width, height] of [[320,568], [360,780], [375,667], [384,850], [393,852], [412,915], [430,932], [720,360]]) {
      await page.setViewportSize({ width, height })
      await page.setContent(`<style>html,body{margin:0;font-family:sans-serif}view,block,scroll-view{display:block}scroll-view{overflow-y:auto!important}button{box-sizing:border-box;font-family:inherit}text{overflow-wrap:anywhere}${style.replace(/(-?[\d.]+)rpx\b/g, (_, n) => `${Number(n)*width/750}px`)}</style>${markup}<div style="position:fixed;bottom:0;left:0;right:0;height:85px;z-index:9999;background:white">navigation</div>`)
      await page.evaluate(() => {
        document.querySelector('.ticket-pay-options').style.display='none'
        document.querySelectorAll('.checkout-upgrade,.checkout-upgrade__message,.cart-line__selection,.cart-line__unavailable,.coupon-portion').forEach(el => el.remove())
      })
      const assertFooter = async () => {
        for (const name of ['关闭订单明细', '确认支付']) {
          const button = page.getByRole('button', { name, exact: true })
          const box = await button.boundingBox()
          assert.ok(box.height >= 44 && box.x >= 0 && box.x + box.width <= width + 1 && box.y >= 0 && box.y + box.height <= height - 85 + 1, `${name} visible above navigation at ${width}x${height}: ${JSON.stringify(box)}`)
          await button.click({ trial: true, timeout: 1000 })
        }
      }
      await assertFooter()
      const title = await page.locator('.checkout-item-name').boundingBox()
      const quantity = await page.locator('.checkout-item-quantity').boundingBox()
      assert.ok(Math.abs(title.y + title.height / 2 - quantity.y - quantity.height / 2) < 2, 'quantity aligns with item name')
      for (const step of await page.locator('.checkout-stepper > button').all()) {
        const box = await step.boundingBox()
        assert.ok(box.width >= 44 && box.height >= 44, 'quantity buttons retain finger-sized targets')
      }
      assert.equal(await page.locator('.checkout-points-picker__input').evaluate(el => getComputedStyle(el).color), 'rgb(41, 44, 38)')
      assert.equal(await page.locator('.checkout-points-entry [bindtap="openCheckoutPoints"]').evaluate(el => Boolean(el.closest('scroll-view'))), true, 'points entry scrolls with the order')
      for (const selector of ['[bindtap="fillMaximumCheckoutPoints"]','[bindtap="quoteCheckoutCoupons"]','[bindtap="quoteCheckoutPoints"]','[bindinput="onCheckoutNoteInput"]']) {
        const control = page.locator(selector)
        assert.ok(await control.evaluate(el => Boolean(el.closest('scroll-view'))), `${selector} must share the scrolling form`)
        await control.scrollIntoViewIfNeeded()
        await control.click({ trial: true, timeout: 1000 }).catch(async error => { throw new Error(`${width}x${height} ${selector} scroll=${JSON.stringify(await page.locator('scroll-view').boundingBox())}`, { cause: error }) })
        await assertFooter()
      }
      const scroll = await page.locator('scroll-view').evaluate(el => ({ height: el.clientHeight, content: el.scrollHeight }))
      assert.ok(scroll.height > 0 && scroll.content > scroll.height, 'long checkout content scrolls')
      assert.ok(await page.evaluate(() => document.body.scrollWidth <= innerWidth + 1), 'no horizontal overflow')
      await page.evaluate(() => {
        document.querySelector('.checkout-points-entry').remove()
        document.querySelector('.ticket-pay-options').style.display='grid'
        document.querySelector('[bindtap="useTicketPoints"]').textContent='用 200 积分　微信补 ¥60'
        document.querySelector('.ticket-pay-options .coupon-quote-error').remove()
      })
      for (const handler of ['useDirectCheckout','useTicketPoints','confirmCheckout']) {
        const button=page.locator('[bindtap="'+handler+'"]')
        await button.scrollIntoViewIfNeeded()
        const box=await button.boundingBox()
        assert.ok(box && box.height>=44 && box.x>=0 && box.x+box.width<=width+1 && box.y>=0 && box.y+box.height<=height-85+1,handler+' reachable at '+width+'x'+height)
        await button.click({trial:true,timeout:1000})
      }
    }
  } finally { await browser.close() }
})
test('bundle confirmation remains clickable above navigation on small and landscape screens', async () => {
  const source = await readFile(resolve(root, 'miniprogram/pages/order/index.wxml'), 'utf8')
  const start = source.indexOf('  <view wx:if="{{detailProduct}}"')
  let markup = source.slice(start, source.lastIndexOf('  <view', source.indexOf('class="cart-dock"', start)))
  assert.ok(markup.includes('product-detail-footer'))
  markup = markup.replace('{{(customTabBarHeight || 50) + 1}}', '85').replace(/disabled="[^"]*"/g, '').replace(/\{\{[^}]+\}\}/g, expression => expression.includes('保存第') ? '确认选择并加入' : expression.includes('priceText') ? '¥168.00' : '套餐内容')
  const style = await css(resolve(root, 'miniprogram/app.wxss')) + await css(resolve(root, 'miniprogram/pages/order/index.wxss'))
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    for (const [width, height, navigationHeight] of [[320,568,50],[393,724,50],[375,667,84],[393,852,84],[430,932,84],[720,360,50]]) {
      await page.setViewportSize({width,height})
      await page.setContent(`<style>html,body{margin:0}view,block,scroll-view{display:block}scroll-view{overflow-y:auto!important}button{box-sizing:border-box}${style.replace(/(-?[\d.]+)rpx\b/g, (_,n) => `${Number(n)*width/750}px`)}</style><view class="page order-page" style="height:calc(100vh - ${navigationHeight}px)">${markup.replace('bottom: 85px"', `bottom: ${navigationHeight + 1}px"`)}</view><div style="position:fixed;bottom:0;left:0;right:0;height:${navigationHeight}px;z-index:9999;background:white">navigation</div>`)
      await page.evaluate(() => document.querySelectorAll('.product-detail-footer > button:not([catchtap="confirmBundleProduct"]),.product-detail-browse-note').forEach(el => el.remove()))
      const button = page.locator('[catchtap="confirmBundleProduct"]')
      const box = await button.boundingBox()
      assert.ok(box.height >= 44 && box.y >= 0 && box.y+box.height <= height-navigationHeight+1, `bundle confirm reachable at ${width}x${height}: ${JSON.stringify(box)}`)
      await button.click({trial:true,timeout:1000})
      assert.ok(await page.locator('.product-detail-scroll').evaluate(el => el.clientHeight > 0))
    }
  } finally { await browser.close() }
})
