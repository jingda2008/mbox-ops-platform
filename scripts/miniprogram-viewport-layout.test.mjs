import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

const listFiles = async (directory) => {
  const entries = await readdir(new URL(`../${directory}/`, import.meta.url), { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const relativePath = `${directory}/${entry.name}`
    return entry.isDirectory() ? listFiles(relativePath) : [relativePath]
  }))
  return nested.flat()
}

test('persistent customer actions occupy layout rows instead of covering scrollable content', async () => {
  const [orderView, orderStyle, detailView, detailStyle, termsView, termsStyle] = await Promise.all([
    read('miniprogram/pages/order/index.wxml'),
    read('miniprogram/pages/order/index.wxss'),
    read('miniprogram/pages/community-detail/index.wxml'),
    read('miniprogram/pages/community-detail/index.wxss'),
    read('miniprogram/pages/membership-terms/index.wxml'),
    read('miniprogram/pages/membership-terms/index.wxss'),
  ])

  assert.match(orderView, /class="order-scroll"[\s\S]*?class="order-scroll__content"[\s\S]*?<\/view>\s*<\/scroll-view>\s*<view wx:if="\{\{recommendationQuestionVisible/)
  assert.match(orderView, /<\/scroll-view>\s*<view wx:if="\{\{recommendationQuestionVisible[\s\S]*?class="cart-dock"/)
  assert.match(orderStyle, /\.order-page\s*\{[^}]*display:\s*flex;[^}]*height:\s*100vh;[^}]*overflow:\s*hidden;/)
  assert.match(orderStyle, /\.order-scroll\s*\{[^}]*height:\s*0;[^}]*flex:\s*1 1 auto;/)
  assert.match(orderStyle, /\.cart-dock\s*\{[^}]*position:\s*relative;/)
  assert.match(orderStyle, /Keep the native tab bar[\s\S]*?\.checkout-button\s*\{[^}]*width:\s*auto;[^}]*max-width:\s*100%;[^}]*justify-self:\s*stretch;/)

  assert.match(detailView, /class="detail-scroll"[\s\S]*?class="detail-scroll__content"[\s\S]*?<\/view>\s*<\/scroll-view>\s*<view class="detail-dock">/)
  assert.match(detailStyle, /\.detail-scroll\s*\{[^}]*height:\s*0;[^}]*flex:\s*1 1 auto;/)
  assert.match(detailStyle, /\.detail-dock\s*\{[^}]*position:\s*relative;/)

  assert.match(termsView, /class="terms-scroll"[\s\S]*?<\/view>\s*<\/scroll-view>\s*<view wx:if="\{\{terms && allowEnrollment && !membership\}\}" class="terms-dock">/)
  assert.match(termsStyle, /\.terms-scroll\s*\{[^}]*height:\s*0;[^}]*flex:\s*1 1 auto;/)
  assert.match(termsStyle, /\.terms-dock\s*\{[^}]*position:\s*relative;/)
})

test('tab pages do not double-count the native tab-bar safe area or force viewport width', async () => {
  const [appStyle, orderStyle, homeStyle, communityStyle, profileStyle] = await Promise.all([
    read('miniprogram/app.wxss'),
    read('miniprogram/pages/order/index.wxss'),
    read('miniprogram/pages/home/index.wxss'),
    read('miniprogram/pages/community/index.wxss'),
    read('miniprogram/pages/profile/index.wxss'),
  ])

  assert.match(appStyle, /\.home-page,[\s\S]*?\.profile-page\s*\{\s*padding-bottom:\s*48rpx;/)
  assert.doesNotMatch(orderStyle, /width:\s*100vw/)
  assert.match(orderStyle, /Tab pages already sit above WeChat's native tab bar[\s\S]*?\.checkout-confirm\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%;/)
  assert.match(homeStyle, /do not add the phone inset twice[\s\S]*?\.member-invite-sheet\s*\{[^}]*overflow-y:\s*auto;[^}]*padding-bottom:\s*34rpx;/)
  assert.match(communityStyle, /native tab bar owns the device safe area[\s\S]*?\.community-member-sheet\s*\{[^}]*overflow-y:\s*auto;[^}]*padding-bottom:\s*34rpx;/)
  assert.match(profileStyle, /\.profile-page\s*\{[^}]*padding:\s*0 28rpx 48rpx;/)
  assert.match(profileStyle, /This sheet is already above the native tab bar[\s\S]*?\.login-sheet\s*\{[^}]*padding-bottom:\s*34rpx;/)
})

test('non-tab detail actions retain the physical device safe area and flexible narrow-screen buttons', async () => {
  const [detailStyle, termsStyle] = await Promise.all([
    read('miniprogram/pages/community-detail/index.wxss'),
    read('miniprogram/pages/membership-terms/index.wxss'),
  ])

  assert.match(detailStyle, /\.detail-dock\s*\{[^}]*env\(safe-area-inset-bottom\)/)
  assert.match(detailStyle, /\.detail-dock > button\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*46%;[^}]*white-space:\s*normal;/)
  assert.match(termsStyle, /\.terms-dock\s*\{[^}]*env\(safe-area-inset-bottom\)/)
})

test('only modal masks remain fixed across mini-program pages', async () => {
  const styleFiles = (await listFiles('miniprogram/pages')).filter((path) => path.endsWith('.wxss'))
  const fixedSelectors = []

  for (const path of styleFiles) {
    const style = await read(path)
    for (const match of style.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (/position\s*:\s*fixed/.test(match[2])) {
        fixedSelectors.push(`${path}: ${match[1].replace(/\/\*[\s\S]*?\*\//g, '').trim()}`)
      }
    }
  }

  assert.deepEqual(fixedSelectors.sort(), [
    'miniprogram/pages/community-detail/index.wxss: .detail-member-mask',
    'miniprogram/pages/community/index.wxss: .community-member-mask',
    'miniprogram/pages/home/index.wxss: .editorial-panel-mask',
    'miniprogram/pages/home/index.wxss: .member-invite-mask',
    'miniprogram/pages/home/index.wxss: .performance-panel-mask',
    'miniprogram/pages/order/index.wxss: .sheet-mask',
    'miniprogram/pages/profile/index.wxss: .login-sheet-mask',
    'miniprogram/pages/profile/index.wxss: .login-sheet-mask',
  ])
})
