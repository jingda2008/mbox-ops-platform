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

test('menu decision helper uses compact reachable actions without overflow', async () => {
  const browser = await chromium.launch({headless:true})
  try {
    const page = await browser.newPage()
    const template = await readFile(resolve(root,'miniprogram/pages/order/index.wxml'),'utf8')
    const helper = template.match(/<view class="menu-filter-line" aria-label="选购帮助">[\s\S]*?<\/button>\s*<\/view>/)[0]
    const styles = await css(resolve(root,'miniprogram/app.wxss')) + await css(resolve(root,'miniprogram/pages/order/index.wxss'))
    for (const width of widths) {
      await page.setViewportSize({width,height:740})
      await page.setContent(`<style>${reset}${scale(styles,width)}</style><page><view class="page order-page">${helper}</view></page>`)
      inside(await geometry(page,'button'),width,'decision helper/'+width)
      assert.equal(await page.locator('button').count(),2)
      const bounds = await page.locator('.menu-filter-line').boundingBox()
      assert.ok(bounds.height <= 60,'helper must not become another large hero')
      for (const box of await geometry(page,'button')) assert.ok(box.height>=44,'keep comfortable tap targets')
    }
  } finally { await browser.close() }
})

test('category grid stays inside the screen and remains pinned while the menu scrolls', async () => {
  const browser = await chromium.launch({headless:true})
  try {
    const page = await browser.newPage()
    const styles = await css(resolve(root,'miniprogram/app.wxss')) + await css(resolve(root,'miniprogram/pages/order/index.wxss'))
    for(const width of widths) for(const browse of [true,false]) {
      await page.setViewportSize({width,height:740})
      const labels=['全部','套餐组合','鸡尾酒','啤酒','葡萄酒与起泡酒','威士忌与烈酒','小食与果盘','无酒精饮品']
      await page.setContent(`<style>${reset}${scale(styles,width)} .order-scroll{overflow-y:auto}</style><page><view class="page order-page"><scroll-view class="order-scroll"><view class="order-scroll__content"><view style="height:180px">扫码提示或桌台信息</view><view class="menu-tools ${browse?'menu-tools--browse':''}"><view class="category-grid">${labels.map((x,i)=>'<button class="category-chip '+(!i?'is-active':'')+'">'+x+'</button>').join('')}</view><view class="menu-filter-line"><button class="subcategory-trigger"><view class="menu-filter-surface">细分类 ⌄</view></button><button class="menu-search-trigger"><view class="menu-filter-surface">⌕ 搜索</view></button></view></view><view style="height:1800px">菜品列表</view></view></scroll-view></view></page>`)
      inside(await geometry(page,'button'),width,'category/'+width)
      for(const selector of ['.subcategory-trigger','.menu-search-trigger']) {
        const style = await page.locator(selector + ' .menu-filter-surface').evaluate(n=>{
          const s=getComputedStyle(n);return {font:parseFloat(s.fontSize),border:parseFloat(s.borderTopWidth),background:s.backgroundColor}
        })
        assert.ok(style.font>=14, 'filter actions must remain readable')
        assert.ok(style.border>0, 'filter actions must look like buttons')
        assert.notEqual(style.background,'rgba(0, 0, 0, 0)')
        const surface = await page.locator(selector + ' .menu-filter-surface').boundingBox()
        assert.ok(surface.height <= 32, 'visible filter buttons remain small while hit area stays 44px')
      }
      const grid = await page.locator('.category-grid').boundingBox()
      const detailButton = await page.locator('.subcategory-trigger').boundingBox()
      const searchButton = await page.locator('.menu-search-trigger').boundingBox()
      assert.ok(detailButton.width < width * 0.5, 'short subcategory button must not stretch across the row')
      assert.ok(searchButton.width < width * 0.25, 'search button should fit its label')
      assert.ok(grid.height < 130, 'collapsed grid remains compact')
      await page.locator('.order-scroll').evaluate(n=>{n.scrollTop=450})
      const bar=await page.locator('.menu-tools').boundingBox()
      assert.ok(Math.abs(bar.y)<2,'category bar must stick to scroll viewport')
      if(width===375 && browse) {
        const directory=resolve(root,'artifacts/menu-navigation-20260910')
        await mkdir(directory,{recursive:true})
        await page.locator('.menu-tools').screenshot({path:resolve(directory,'category-css-fixture.png')})
      }
    }
  } finally { await browser.close() }
})

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
