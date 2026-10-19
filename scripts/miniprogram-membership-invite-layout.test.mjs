import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { chromium } from 'playwright'
const root = resolve(import.meta.dirname, '..')
async function css(file) {
  let source = await readFile(file, 'utf8')
  for (const match of [...source.matchAll(/@import\s+"([^"]+)";/g)]) source = source.replace(match[0], await css(resolve(dirname(file), match[1])))
  return source
}
test('membership invitation keeps accepted copy and usable actions on small phones and landscape', async () => {
  const source = await readFile(resolve(root, 'miniprogram/pages/order/index.wxml'), 'utf8')
  const markup = source.slice(source.indexOf('  <view wx:if="{{membershipInviteVisible}}"'), source.lastIndexOf('</view>'))
  for (const copy of ['加入会员，让积分替你买单', '消费攒积分，下次点单直接抵。', '1积分＝1元', '立即加入', '继续点菜']) assert.ok(markup.includes(copy))
  const style = await css(resolve(root, 'miniprogram/app.wxss')) + await css(resolve(root, 'miniprogram/pages/order/index.wxss'))
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    for (const [width, height] of [[320,568], [375,667], [430,932], [720,360]]) {
      await page.setViewportSize({ width, height })
      await page.setContent(`<style>html,body{margin:0;font-family:-apple-system,BlinkMacSystemFont,sans-serif}view{display:block}button{box-sizing:border-box;font-family:inherit}text{overflow-wrap:anywhere}${style.replace(/(-?[\d.]+)rpx\b/g, (_, n) => `${Number(n)*width/750}px`)}</style><view class="page order-page">${markup}</view>`)
      assert.ok(await page.evaluate(() => document.body.scrollWidth <= innerWidth + 1), 'no horizontal overflow')
      for (const action of ['立即加入', '继续点菜', '查看会员权益说明']) {
        const button = page.getByRole('button', { name: action, exact: true })
        await button.scrollIntoViewIfNeeded()
        const box = await button.boundingBox()
        assert.ok(box.height >= 44 && box.x >= 0 && box.x + box.width <= width + 1 && box.y >= 0 && box.y + box.height <= height + 1, `reachable action: ${action} at ${width}`)
        await button.click({ trial: true })
      }
      if (process.env.MBOX_INVITE_EVIDENCE_DIR && width === 375) {
        await mkdir(process.env.MBOX_INVITE_EVIDENCE_DIR, { recursive: true })
        await page.screenshot({ path: resolve(process.env.MBOX_INVITE_EVIDENCE_DIR, 'membership-invite-375.png') })
      }
    }
  } finally { await browser.close() }
})
