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

test('native-like block buttons center their labels across dock and related text actions', async () => {
  const browser = await chromium.launch({headless:true})
  const cases = [
    ['community-detail','detail-dock','','免费报名'],
    ['community-detail','detail-dock','payment-button','提交报名并支付'],
    ['community-detail','detail-dock','cancel-button','退款与联系'],
    ['community-detail','detail-dock','','查询付款结果'],
    ['profile-cards','cards-actions','cards-button primary','提交申请'],
    ['profile-marketing','contact-page','contact-button stop','停止所有营销联系'],
    ['profile-preferences','preferences-page','save-button','保存偏好'],
    ['profile','benefit-foot','','领取权益'],
    ['profile','redemption-history__row','','取消兑换'],
    ['reservations','reservation-notification-row','','开启演出提醒'],
    ['privacy','privacy-contact-row','','更新活动联系信息'],
    ['order','checkout-upgrade__actions','checkout-upgrade__decline','保留原单，继续付款']
  ]
  try {
    const page = await browser.newPage()
    for (const [base,ext] of [['miniprogram','wxss'],['alipay-miniprogram','acss']]) {
      const app = await css(resolve(root,base,'app.'+ext))
      for (const [route,parent,cls,label] of cases) {
        const source = app + await css(resolve(root,base,'pages',route,'index.'+ext))
        for (const width of widths) for (const disabled of [false,true]) {
          await page.setViewportSize({width,height:740})
          const styles = scale(source,width).replace(/env\(safe-area-inset-bottom\)/g,'34px')
          // Deliberately emulate native block text placement, not HTML button's implicit centering.
          await page.setContent(`<style>${reset}button{display:block;line-height:1.5}${styles}</style><page><view class="page"><view class="${parent}">${parent==='detail-dock'?'<view><text>免费</text><text>剩余 300 位</text></view>':''}<button class="${cls}" ${disabled?'disabled':''}><span class="fixture-label">${label}</span></button></view></view></page>`)
          const button = await page.locator('button').boundingBox()
          const text = await page.locator('.fixture-label').boundingBox()
          assert.ok(Math.abs(button.y+button.height/2-text.y-text.height/2)<=1.5,base+'/'+route+'/'+label+' vertical center')
          assert.ok(text.x>=button.x-1 && text.x+text.width<=button.x+button.width+1,'label must fit button')
          assert.ok(button.height>=44,'touch target')
          assert.ok(button.x>=-1 && button.x+button.width<=width+1,'screen overflow')
          if(base==='miniprogram' && width===375 && route==='community-detail' && label==='免费报名' && !disabled) {
            const out=resolve(root,'artifacts/button-alignment-20260910')
            await mkdir(out,{recursive:true})
            await page.locator('.detail-dock').screenshot({path:resolve(out,'free-registration-css-fixture.png')})
          }
        }
      }
    }
  } finally {await browser.close()}
})

test('custom actions keep selection, warning, consent and isolated component semantics', async () => {
  const browser = await chromium.launch({headless:true})
  try {
    const page = await browser.newPage()
    for (const [base,ext] of [['miniprogram','wxss'],['alipay-miniprogram','acss']]) {
      const app = await css(resolve(root,base,'app.'+ext))
      const phoneClass = base === 'miniprogram' ? 'wx-phone-button' : 'alipay-phone-button'
      for (const width of widths) {
        await page.setViewportSize({width,height:740})
        const styles = 'button{line-height:1.5}' + app + await css(resolve(root,base,'pages/profile-marketing/index.'+ext))
        await page.setContent(`<style>${reset}${scale(styles,width)}</style><page><view class="page contact-page"><button class="contact-button primary">同意所选联系渠道</button><button class="contact-button stop">停止所有营销联系</button><button class="contact-button" disabled>正在保存</button><button class="chip">未选择</button><button class="chip is-on">已选择</button><button class="wx-phone-button button-hover">授权手机号</button></view></page>`)
        await page.locator('.wx-phone-button').evaluate((n,cls)=>n.className=cls+' button-hover',phoneClass)
        inside(await geometry(page,'button'),width,base+' custom actions')
        assert.notEqual(await page.locator('.stop').evaluate(n=>getComputedStyle(n).backgroundColor),await page.locator('.primary').evaluate(n=>getComputedStyle(n).backgroundColor),'withdrawal must retain warning palette')
        const shades = await page.locator('.chip').evaluateAll(ns=>ns.map(n=>getComputedStyle(n).backgroundColor))
        assert.notEqual(shades[0],shades[1])
        assert.equal(await page.locator('.'+phoneClass).evaluate(n=>getComputedStyle(n).transform),'none')
        assert.equal(await page.locator('.'+phoneClass).evaluate(n=>getComputedStyle(n).opacity),'1')
        for (const [component,cls] of [['state-panel','state__action'],['member-identities','identity-retry']]) {
          const isolated = await css(resolve(root,base,'components',component,'index.'+ext))
          await page.setContent(`<style>${reset}${scale(isolated,width)}</style><button class="${cls}">暂时未读取，请点击重新尝试</button>`)
          inside(await geometry(page,'button'),width,base+'/'+component)
          assert.ok((await page.locator('button').boundingBox()).height>=44)
          assert.equal(await page.locator('button').evaluate(n=>getComputedStyle(n).backgroundColor),'rgb(241, 244, 237)')
        }
      }
    }
  } finally { await browser.close() }
})

test('order action hierarchy preserves readable states and press geometry on both platforms', async () => {
  const browser = await chromium.launch({headless:true})
  try {
    const page = await browser.newPage()
    for (const [platform, sheet] of [['miniprogram','wxss'],['alipay-miniprogram','acss']]) {
      const styles = await css(resolve(root,platform,'app.'+sheet)) + await css(resolve(root,platform,'pages/order/index.'+sheet))
      for (const width of widths) {
        await page.setViewportSize({width,height:740})
        await page.setContent(`<style>${reset}${scale(styles,width)}</style><page><view class="page order-page"><view class="category-grid"><button class="category-chip">鲜果与冷食</button><button class="category-chip is-active">套餐组合</button></view><button class="primary-button">确认支付</button><button class="secondary-button">继续加购</button><button class="primary-button" disabled>订单确认中</button></view></page>`)
        const action = page.locator('.primary-button:not([disabled])')
        const initial = await action.boundingBox()
        const primary = await action.evaluate(n=>getComputedStyle(n).backgroundImage)
        assert.notEqual(primary,'none')
        assert.equal(await page.locator('.secondary-button').evaluate(n=>getComputedStyle(n).backgroundImage),'none')
        const backgrounds = await page.locator('.category-chip').evaluateAll(ns=>ns.map(n=>getComputedStyle(n).backgroundColor))
        assert.notEqual(backgrounds[0],backgrounds[1],'selection stays identifiable')
        await action.evaluate(n=>n.classList.add('button-hover'))
        await page.waitForFunction(()=>Number(getComputedStyle(document.querySelector('.button-hover')).opacity)<1)
        assert.deepEqual(await action.boundingBox(),initial,'press must not shift content')
        assert.ok(Number(await action.evaluate(n=>getComputedStyle(n).opacity))<1)
        assert.notEqual(await page.locator('[disabled]').evaluate(n=>getComputedStyle(n).backgroundImage),primary,'busy action must not resemble enabled primary')
        inside(await geometry(page,'button'),width,'soft actions/'+platform+'/'+width)
      }
    }
  } finally { await browser.close() }
})

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
      const labels=['全部','门票','套餐组合','11月限定鸡尾酒','鸡尾酒','威士忌','其他烈酒','鲜果与冷食','啤酒','软饮']
      await page.setContent(`<style>${reset}${scale(styles,width)} .order-scroll{overflow-y:auto}</style><page><view class="page order-page"><scroll-view class="order-scroll"><view class="order-scroll__content"><view style="height:180px">扫码提示或桌台信息</view><view class="menu-tools ${browse?'menu-tools--browse':''}"><view class="category-grid">${labels.map((x,i)=>'<button class="category-chip '+(!i?'is-active':'')+'">'+x+'</button>').join('')}</view><view class="menu-filter-line"><button class="subcategory-trigger"><view class="menu-filter-surface">细分类 ⌄</view></button><view class="search-box"><view class="menu-search-icon"></view><input placeholder="搜索菜品、门票或场次"><button class="menu-search-clear">清除</button></view></view></view><view style="height:1800px">菜品列表</view></view></scroll-view></view></page>`)
      inside(await geometry(page,'button'),width,'category/'+width)
      {
        const selector = '.subcategory-trigger'
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
      const searchBox = await page.locator('.search-box').boundingBox()
      assert.ok(detailButton.width < width * 0.5, 'short subcategory button must not stretch across the row')
      assert.equal(searchBox.height, 34)
      assert.ok((await page.locator('.search-box input').boundingBox()).height >= 44)
      assert.ok(searchBox.width > width / 2 && Math.abs(searchBox.y + searchBox.height / 2 - detailButton.y - detailButton.height / 2) < 2, 'search input shares the row with the category filter')
      const lastCategory = await page.getByRole('button', {name:'软饮', exact:true}).boundingBox()
      assert.ok(lastCategory.y > grid.y && lastCategory.y + lastCategory.height <= grid.y + grid.height + 1, 'last row fits inside the expanded category grid')
      assert.ok(searchBox.y >= lastCategory.y + lastCategory.height - 1, 'search sits below every category')
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
      assert.ok(box.height <= 52, 'keep the two-line scan banner compact')
      assert.ok((await page.locator('.gate-button').boundingBox()).height >= 44, 'preserve the scan tap target')
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

test('all configured page style cascades preserve compact wrapping actions in normal and disabled states', async () => {
  const browser = await chromium.launch({headless:true})
  try {
    const page = await browser.newPage()
    const routes = JSON.parse(await readFile(resolve(root, 'miniprogram/app.json'), 'utf8')).pages
    assert.equal(routes.length, 28)
    assert.ok(routes.includes('pages/profile-activities/index'))
    assert.ok(routes.includes('pages/table-tickets/index'))
    assert.ok(routes.includes('pages/channel-coupons/index'))
    assert.ok(!routes.includes('pages/channel-partner/index'))
    assert.ok(routes.includes('pages/profile-bottles/index'))
    assert.ok(routes.includes('pages/profile-bottle-detail/index'))
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
        assert.equal(await page.locator('.primary-button').evaluate(n=>getComputedStyle(n).borderRadius),'24px')
        assert.notEqual(await page.locator('.primary-button').evaluate(n=>getComputedStyle(n).backgroundImage),'none')
        assert.equal(await page.locator('.secondary-button').evaluate(n=>getComputedStyle(n).backgroundColor),'rgb(241, 244, 237)')
        assert.equal(await page.locator('[disabled]').evaluate(n=>getComputedStyle(n).opacity),'1','disabled labels remain legible')
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

test('scheduled menu cards keep pictures, taste tags, price and selling hours separate on narrow screens',async()=>{
 const browser=await chromium.launch({headless:true})
 try{
  const page=await browser.newPage()
  for(const [platform,ext] of [['miniprogram','wxss'],['alipay-miniprogram','acss']]){
   const styles=await css(resolve(root,platform,'app.'+ext))+await css(resolve(root,platform,'pages/order/index.'+ext))
   for(const width of widths){
    await page.setViewportSize({width,height:860})
    const cards=['18:00–次日02:00','2026-11-10至2026-11-20 周五、周六 20:00–次日01:00'].map(time=>`<view class="product-row is-scheduled"><view class="product-media"><view class="product-media__placeholder"><text>M-BOX</text></view></view><view class="product-main"><text class="product-kind">经典鸡尾酒</text><text class="product-name">龙舌兰日出</text><view class="product-tastes"><text>酸度 2/5</text><text>甜度 2/5</text></view><text class="product-copy">龙舌兰 橙汁 红石榴</text></view><view class="product-action"><view class="product-action__meta"><text class="product-price">¥98.00</text><text class="product-availability">可销售时间</text><text class="product-availability-copy">${time}</text></view></view></view>`).join('')
    await page.setContent(`<style>${reset}${scale(styles,width)}</style><page><view class="page order-page"><text>销售时段卡片布局验证 · 非原生小程序截图</text><view class="product-list product-list--browse">${cards}</view></view></page>`)
    for(const card of await page.locator('.product-row').all()){
     const main=await card.locator('.product-main').boundingBox(),action=await card.locator('.product-action').boundingBox(),bounds=await card.boundingBox()
     assert.ok(action.y>=main.y+main.height-1,'price must not overlap taste or description')
     const time=await card.locator('.product-availability-copy').boundingBox()
     assert.ok(time.y+time.height<=bounds.y+bounds.height+1,'selling time must remain inside card')
     assert.equal(await card.locator('.product-media').evaluate(n=>getComputedStyle(n).opacity),'1')
    }
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1))
    if(platform==='miniprogram'&&width===390){const out=resolve(root,'artifacts/selling-time-20261108');await mkdir(out,{recursive:true});await page.screenshot({path:resolve(out,'scheduled-menu-layout.png'),fullPage:true})}
   }
  }
 }finally{await browser.close()}
})

test('promotion claim and wallet ordering actions remain prominent and reachable on small screens', async () => {
  const out=resolve(root,'artifacts/channel-wallet-20261126');await mkdir(out,{recursive:true})
  const browser=await chromium.launch({headless:true})
  const offer={title:'餐后再坐一会儿',offerText:'圣培露气泡水 1 份',claimedCount:0,unavailable:null,sourceLabel:'周边合作商户',minimumText:'¥0.00',productText:'全部商品参与',claimTimeText:'2026-11-26 10:00 至 2026-11-30 23:59',timeText:'2026-11-26 10:00 至 2026-11-30 23:59',perCustomerClaims:1,perVisitUses:1}
  const item={id:'demo',title:offer.title,offerText:offer.offerText,stateText:'待使用',sourceLabel:offer.sourceLabel,productText:offer.productText,validText:offer.timeText,canUse:true}
  const context={offer,item,channelCoupons:[item],busy:false,loading:false,pendingClaim:false,notice:'',selectedClaimId:''}
  const evaluate=expression=>Function(...Object.keys(context),'return ('+expression+')')(...Object.values(context))
  const render=source=>source.replace(/<template\b[^>]*\/>/g,'').replace(/<(button|text) wx:if="{{(.*?)}}"([\s\S]*?)<\/\1>/g,(all,tag,condition)=>evaluate(condition)?all:'').replace(/{{(.*?)}}/g,(_,expression)=>String(evaluate(expression)??'')).replace(/\s(?:wx:[\w-]+|disabled|loading)="[^"]*"/g,'')
  try {
    const page=await browser.newPage()
    for(const route of ['channel-coupons','profile-coupons']){
      const wxml=await readFile(resolve(root,'miniprogram/pages',route,'index.wxml'),'utf8')
      const start=wxml.indexOf(route==='channel-coupons'?'<view wx:if="{{offer && !selectedClaimId}}"':'<view wx:for="{{channelCoupons}}"')
      const end=route==='channel-coupons'?wxml.indexOf('</view>',start)+7:wxml.indexOf('    <view wx:if="{{channelError}}"',start)
      assert.ok(start>=0 && end>start)
      const styles=await css(resolve(root,'miniprogram/app.wxss'))+await css(resolve(root,'miniprogram/pages',route,'index.wxss'))
      for(const width of [320,390,430]){
        await page.setViewportSize({width,height:740})
        await page.setContent(`<style>${reset}${scale(styles,width)}</style><page><view class="page ${route==='channel-coupons'?'channel-page':'coupons-page'}"><text style="display:block;font-size:12px;margin:12px 0">演示数据 · 浏览器样式验证</text>${render(wxml.slice(start,end))}</view></page>`)
        const button=page.getByRole('button',{name:route==='channel-coupons'?'立即领取优惠券':'去点单使用',exact:true}),box=await button.boundingBox()
        assert.ok(box.height>=48 && box.y+box.height<=740,route+' action visible without scrolling')
        assert.ok(box.width>=width-80 && box.x>=0 && box.x+box.width<=width+1,route+' full width within screen')
        assert.equal(await button.evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(40, 81, 61)')
        assert.equal(await button.evaluate(el=>getComputedStyle(el).color),'rgb(255, 255, 255)')
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
        await button.click({trial:true})
        await page.screenshot({path:resolve(out,route+'-'+width+'.png'),fullPage:true})
      }
    }
  } finally {await browser.close()}
})
