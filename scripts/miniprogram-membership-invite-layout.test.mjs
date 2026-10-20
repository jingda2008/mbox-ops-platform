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
  const template = source.slice(source.indexOf('  <view wx:if="{{membershipInviteVisible}}"'), source.indexOf('  <state-panel', source.indexOf('  <view wx:if="{{membershipInviteVisible}}"')))
  for (const copy of ['授权手机号', '暂不授权']) assert.ok(template.includes(copy))
  assert.match(template, /open-type="getPhoneNumber" bindgetphonenumber="authorizeMenuPhone"/)
  assert.doesNotMatch(template, /checkbox|role="dialog"|sheet-mask|enrollFromMenu/)
  const markup = template.replace(/disabled="\{\{membershipBusy\}\}"/g, '')
    .replace(/<text wx:if="\{\{membershipInviteError\}\}"[\s\S]*?<\/text>/, '')
  const style = await css(resolve(root, 'miniprogram/app.wxss')) + await css(resolve(root, 'miniprogram/pages/order/index.wxss'))
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    for (const [width, height] of [[320,568], [375,667], [430,932], [720,360]]) {
      await page.setViewportSize({ width, height })
      await page.setContent(`<style>html,body{margin:0;font-family:-apple-system,BlinkMacSystemFont,sans-serif}view{display:block}button{box-sizing:border-box;font-family:inherit}text{overflow-wrap:anywhere}${style.replace(/(-?[\d.]+)rpx\b/g, (_, n) => `${Number(n)*width/750}px`)}</style><view class="page order-page">${markup}</view>`)
      assert.ok(await page.evaluate(() => document.body.scrollWidth <= innerWidth + 1), 'no horizontal overflow')
      for (const action of ['授权手机号', '暂不授权', '隐私政策']) {
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

test('checkout membership invitation has reachable choices above the custom tab bar', async () => {
  const source=await readFile(resolve(root,'miniprogram/pages/order/index.wxml'),'utf8')
  const start=source.indexOf('  <view wx:if="{{checkoutMemberInviteVisible}}"')
  const template=source.slice(start,source.indexOf('  <view wx:if="{{paymentResult}}"',start))
  assert.ok(template.includes('bottom: {{(customTabBarHeight || 50) + 1}}px'))
  const markup=template.replace('{{(customTabBarHeight || 50) + 1}}', '85')
  assert.ok(markup.includes('消费攒积分，下次点单直接抵。'))
  const style=await css(resolve(root,'miniprogram/app.wxss'))+await css(resolve(root,'miniprogram/pages/order/index.wxss'))
  const browser=await chromium.launch({headless:true})
  try {
    const page=await browser.newPage()
    for(const [width,height] of [[320,568],[375,667],[430,932],[720,360]]) {
      await page.setViewportSize({width,height})
      await page.setContent(`<style>html,body{margin:0}view{display:block}button{box-sizing:border-box}text{overflow-wrap:anywhere}${style.replace(/(-?[\d.]+)rpx\b/g,(_,n)=>`${Number(n)*width/750}px`)}</style><view class="page order-page">${markup}</view><div style="position:fixed;bottom:0;left:0;right:0;height:85px;z-index:9999;background:white">custom navigation layer</div>`)
      for(const name of ['加入会员','先下单']) {
        const button=page.getByRole('button',{name,exact:true});await button.scrollIntoViewIfNeeded();const box=await button.boundingBox()
        assert.ok(box.height>=44&&box.x>=0&&box.x+box.width<=width+1&&box.y>=0&&box.y+box.height<=height-85);await button.click({trial:true})
      }
    }
  } finally {await browser.close()}
})

test('custom navigation keeps its buttons above the iPhone home indicator under global border-box styles', async()=>{
  const style=await readFile(resolve(root,'miniprogram/custom-tab-bar/index.wxss'),'utf8')
  const browser=await chromium.launch({headless:true})
  try {
    const page=await browser.newPage()
    for(const width of [320,375,430,720]) {
      await page.setViewportSize({width,height:667})
      await page.setContent(`<style>html,body{margin:0}view,text,button{box-sizing:border-box}${style}</style><view class="tab-bar" style="padding-bottom:34px">${['首页','预约','点单','超嗨','我的'].map(name=>`<button class="tab-item"><text>${name}</text></button>`).join('')}</view>`)
      const bar=await page.locator('.tab-bar').boundingBox();assert.equal(bar.height,85)
      for(const button of await page.getByRole('button').all()) {const box=await button.boundingBox();assert.ok(box.height>=44&&box.y+box.height<=667-34);await button.click({trial:true})}
    }
  } finally {await browser.close()}
})

test('member cards keep growth difference and next tier action fully visible on narrow screens', async () => {
  const browser = await chromium.launch({headless:true})
  try {
    const page = await browser.newPage()
    for (const route of ['profile','member-center']) {
      const prefix = route === 'profile' ? 'profile-member-card' : 'member-card'
      const source = await readFile(resolve(root,`miniprogram/pages/${route}/index.wxml`),'utf8')
      const start = source.indexOf(`<view class="${prefix}__progress">`)
      const end = route === 'profile' ? source.indexOf('\n\n    <view wx:else',start) : source.indexOf('    <view wx:if="{{tierBenefitsVisible}}"',start)
      const block = source.slice(start,end)
        .replace(/\{\{membership.cardGrowthText\}\}/g,'成长值 680 / 10,000')
        .replace(/\{\{membership.cardDifferenceText\}\}/g,'距银卡还差 9,320 成长值')
        .replace(/\{\{membership.cardProgressPercent\}\}/g,'7')
        .replace(/\{\{membership.cardCurrentTierText\}\}/g,'普卡')
        .replace(/\{\{membership.cardNextTierText\}\}/g,'银卡')
        .replace(/\{\{membership.cardBenefitText\}\}/g,'查看银卡权益 ›')
      const style=await css(resolve(root,'miniprogram/app.wxss'))+await css(resolve(root,`miniprogram/pages/${route}/index.wxss`))
      for (const width of [320,375,430]) {
        await page.setViewportSize({width,height:667})
        await page.setContent(`<style>html,body{margin:0}view{display:block}button{box-sizing:border-box}text{overflow-wrap:anywhere}${style.replace(/(-?[\d.]+)rpx\b/g,(_,n)=>`${Number(n)*width/750}px`)}</style><view class="page ${route==='profile'?'profile-page':'member-center-page'}"><view class="${prefix}">${block}</view>`)
        assert.ok(await page.evaluate(()=>document.body.scrollWidth<=innerWidth+1))
        const card = await page.locator('.'+prefix).boundingBox()
        for (const text of await page.locator(`.${prefix}__progress-copy text`).all()) {
          const box=await text.boundingBox()
          assert.ok(box.x>=card.x&&box.x+box.width<=card.x+card.width+1)
          assert.ok(box.y>=card.y&&box.y+box.height<=card.y+card.height+1)
          assert.ok(await text.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'no clipped progress text')
        }
        const button=page.getByRole('button',{name:'查看银卡权益 ›'})
        assert.ok((await button.boundingBox()).height>=44)
        await button.click({trial:true})
      }
    }
  } finally {await browser.close()}
})
