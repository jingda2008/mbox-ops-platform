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
  const markup=source.slice(start,source.indexOf('  <view wx:if="{{paymentResult}}"',start))
  assert.ok(markup.includes('消费攒积分，下次点单直接抵。'))
  const style=await css(resolve(root,'miniprogram/app.wxss'))+await css(resolve(root,'miniprogram/pages/order/index.wxss'))
  const browser=await chromium.launch({headless:true})
  try {
    const page=await browser.newPage()
    for(const [width,height] of [[320,568],[375,667],[430,932],[720,360]]) {
      await page.setViewportSize({width,height})
      await page.setContent(`<style>html,body{margin:0}view{display:block}button{box-sizing:border-box}text{overflow-wrap:anywhere}${style.replace(/(-?[\d.]+)rpx\b/g,(_,n)=>`${Number(n)*width/750}px`)}</style><view class="page order-page">${markup}</view>`)
      for(const name of ['加入会员','先下单']) {
        const button=page.getByRole('button',{name,exact:true});await button.scrollIntoViewIfNeeded();const box=await button.boundingBox()
        assert.ok(box.height>=44&&box.x>=0&&box.x+box.width<=width+1&&box.y>=0&&box.y+box.height<=height+1);await button.click({trial:true})
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
