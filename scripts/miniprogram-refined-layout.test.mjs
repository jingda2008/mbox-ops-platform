import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
async function css(path, refined = true) {
  let content = await readFile(path, 'utf8')
  for (const match of [...content.matchAll(/@import\s+"([^"]+)";/g)]) {
    content = content.replace(match[0], !refined && match[1].includes('refined-journey') ? '' : await css(resolve(dirname(path), match[1]), refined))
  }
  return content
}
const widths = [320, 375, 390, 430]

test('compact pre-scan strip fits narrow screens and preserves a reachable scan action', async () => {
  const browser = await chromium.launch({headless:true})
  try {
    const page = await browser.newPage()
    const template = await readFile(resolve(root, 'miniprogram/pages/order/index.wxml'), 'utf8')
    const strip = template.match(/<view wx:else class="browse-intro browse-intro--compact">[\s\S]*?<\/button>\s*<\/view>/)[0]
    const styles = await css(resolve(root, 'miniprogram/app.wxss')) + await css(resolve(root, 'miniprogram/pages/order/index.wxss'))
    for (const width of widths) {
      await page.setViewportSize({width,height:740})
      await page.setContent(`<style>${reset}${scale(styles,width)}</style><page><view class="page order-page">${strip}</view></page>`)
      inside(await geometry(page, 'button'), width, 'scan/' + width)
      const box = await page.locator('.browse-intro--compact').boundingBox()
      assert.ok(box.height <= 100, 'scan prompt must not become a hero')
    }
  } finally { await browser.close() }
})
const reset = 'html,body{margin:0}page,view,scroll-view{display:block}page{width:100%;min-height:100vh}button{box-sizing:border-box;border:0;font-family:inherit}textarea{resize:none;font-family:inherit}text{overflow-wrap:anywhere}'
const scale = (text, width) => text.replace(/(-?[\d.]+)rpx\b/g, (_, n) => `${Number(n) * width / 750}px`)
async function geometry(page, selector) {
  return page.locator(selector).evaluateAll(nodes => nodes.map(node => {
    const r = node.getBoundingClientRect(), s = getComputedStyle(node)
    return { x:r.x, right:r.right, height:r.height, width:r.width, lineHeight:parseFloat(s.lineHeight), scroll:node.scrollWidth, client:node.clientWidth }
  }))
}
function inside(boxes, width, label) {
  for (const b of boxes) {
    assert.ok(b.x >= -1 && b.right <= width + 1, `${label}: horizontal overflow ${JSON.stringify(b)}`)
    assert.ok(b.height >= 44 && b.width > 0, `${label}: unusable touch target ${JSON.stringify(b)}`)
    assert.ok(b.scroll <= b.client + 1, `${label}: clipped text ${JSON.stringify(b)}`)
    assert.ok(b.lineHeight < 35, `${label}: inherited fixed line height ${JSON.stringify(b)}`)
  }
}

test('all 23 page style cascades preserve compact wrapping actions in normal and disabled states', async () => {
  const browser = await chromium.launch({headless:true})
  try {
    const page = await browser.newPage()
    const routes = JSON.parse(await readFile(resolve(root, 'miniprogram/app.json'), 'utf8')).pages
    assert.equal(routes.length, 23)
    const app = await css(resolve(root, 'miniprogram/app.wxss'))
    for (const route of routes) {
      const template = await readFile(resolve(root, `miniprogram/${route}.wxml`), 'utf8')
      const classes = template.match(/class="([^"]+)"/)[1]
      const styles = app + await css(resolve(root, `miniprogram/${route}.wxss`))
      for (const width of widths) {
        await page.setViewportSize({width,height:740})
        // CSS-cascade fixture, not a rendered full-page or real payment acceptance claim.
        await page.setContent(`<style>${reset}${scale(styles,width)}</style><page><view class="${classes}"><view class="panel"><button class="primary-button">确认并继续</button><button class="secondary-button">网络暂时未返回，查看订单并选择下一步操作</button><button class="danger-button" disabled>正在处理，请稍候</button></view></view></page>`)
        inside(await geometry(page, 'button'), width, `${route}/${width}`)
      }
    }
  } finally { await browser.close() }
})

test('success, cancelled, pending and failed payment sheets retain readable actions on short screens', async () => {
  const browser = await chromium.launch({headless:true})
  try {
    const page = await browser.newPage()
    const styles = await css(resolve(root, 'miniprogram/app.wxss')) + await css(resolve(root, 'miniprogram/pages/order/index.wxss'))
    for (const width of widths) for (const kind of ['success','cancelled','pending','failed']) {
      await page.setViewportSize({width,height:480})
      await page.setContent(`<style>${reset}${scale(styles,width)}</style><page><view class="page order-page"><view class="payment-result sheet-mask"><view class="payment-result__sheet"><button class="payment-result__close compact-text-action">关闭</button><view class="payment-result__mark payment-result__mark--${kind}">!</view><text class="payment-result__title">付款状态需要确认</text><text class="payment-result__copy">这是${kind}状态的界面测试，不代表真实付款。${'订单说明和网络返回提示较长时也应该可以完整阅读。'.repeat(5)}</text><view class="payment-result__actions"><button class="secondary-button">查看本桌账单和明细</button><button class="primary-button">继续付款或返回菜单</button></view></view></view></view></page>`)
      inside(await geometry(page, '.payment-result__actions button'),width,`${kind}/${width}`)
      const sheet = page.locator('.payment-result__sheet')
      await sheet.evaluate(node => { node.scrollTop = node.scrollHeight })
      assert.ok(await page.locator('.payment-result__actions button').last().isVisible())
      const last = await page.locator('.payment-result__actions button').last().boundingBox()
      assert.ok(last.y + last.height <= 481, `${kind}/${width}: footer unreachable`)
    }
  } finally { await browser.close() }
})

test('checkout actions and long monetary values fit without losing precision', async () => {
  const browser = await chromium.launch({headless:true})
  try {
    const page = await browser.newPage()
    const styles = await css(resolve(root,'miniprogram/app.wxss')) + await css(resolve(root,'miniprogram/pages/order/index.wxss'))
    for (const width of widths) {
      await page.setViewportSize({width,height:600})
      await page.setContent(`<style>${reset}${scale(styles,width)}</style><page><view class="page order-page"><view class="checkout-confirm__footer"><button class="secondary-button checkout-confirm__footer-button">返回继续选择套餐内容</button><button class="primary-button checkout-confirm__footer-button">确认订单并付款</button></view></view></page>`)
      inside(await geometry(page,'button'),width,`checkout/${width}`)
    }
    const account = await css(resolve(root,'miniprogram/app.wxss')) + await css(resolve(root,'miniprogram/pages/account/index.wxss'))
    await page.setViewportSize({width:320,height:600})
    await page.setContent(`<style>${reset}${scale(account,320)}</style><page><view class="page"><view class="order-card panel"><view class="order-card__head"><view><text class="list-row__title">第二轮·付款异常需要核对订单状态</text></view><view class="order-card__amount"><text class="amount">¥123,456,789.00</text><text>上一笔结果仍待确认</text></view></view></view></view></page>`)
    const amount = await geometry(page,'.order-card__amount')
    assert.ok(amount[0].right <= 321 && amount[0].scroll <= amount[0].client+1)
    assert.equal(await page.locator('.amount').innerText(),'¥123,456,789.00')
  } finally { await browser.close() }
})

test('isolated loading, error and empty components share the same platform styles', async () => {
  assert.equal(await readFile(resolve(root,'miniprogram/components/state-panel/index.wxss'),'utf8'),await readFile(resolve(root,'alipay-miniprogram/components/state-panel/index.acss'),'utf8'))
})

test('capture before/after component fixtures with explicit non-native evidence labels', async () => {
  const out = resolve(root,'artifacts/refined-layout-20260910')
  await mkdir(out,{recursive:true})
  const browser=await chromium.launch({headless:true})
  try {
    const page=await browser.newPage({viewport:{width:375,height:700},deviceScaleFactor:2})
    for(const refined of [false,true]) {
      const styles=await css(resolve(root,'miniprogram/app.wxss'),refined)+await css(resolve(root,'miniprogram/pages/service/index.wxss'),refined)
      await page.setContent(`<style>${reset}${scale(styles,375)}</style><page><view class="page service-page"><view class="service-head"><text class="eyebrow">W01 · 桌台服务</text><text class="service-title">需要我们做什么？</text><text class="service-copy">常用需求一点即达，已提交的相同需求无需重复发送。</text></view><view class="service-grid">${['加水','正在通知','补充杯具','点单协助','买单协助','呼叫服务人员'].map((name,i)=>`<button class="service-option" ${i===1?'disabled':''}><text class="service-mark">${name[0]}</text><text class="service-item__name">${name}</text></button>`).join('')}</view><view class="custom-panel"><text class="list-row__title">其他需要</text><textarea placeholder="例如：需要两杯温水、想调整上桌节奏"></textarea><button class="primary-button">发送服务需求</button></view><view class="warning">组件布局测试 · 非微信原生截图 · 未发送服务或调用支付</view></view></page>`)
      await page.screenshot({path:resolve(out,`service-${refined?'after':'before'}.png`),fullPage:true})
    }
  } finally {await browser.close()}
})
