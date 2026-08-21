import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('home offers menu browsing and an explicit opt-in membership invitation', async () => {
  const [homeView, homeLogic, configSource] = await Promise.all([
    read('miniprogram/pages/home/index.wxml'),
    read('miniprogram/pages/home/index.js'),
    read('miniprogram/config/index.js'),
  ])

  assert.match(homeView, /data-url="\/pages\/order\/index" bindtap="openTab"/)
  assert.match(homeView, /欢迎加入 M-BOX/)
  assert.doesNotMatch(homeView, /了解权益并阅读条款/)
  assert.match(homeView, /我已阅读并同意/)
  assert.match(homeView, /\{\{membershipTerms\.title\}\}/)
  assert.match(homeView, /《隐私政策》/)
  assert.match(homeView, /catchtap="showMembershipTerms"/)
  assert.match(homeView, /catchtap="openPrivacy"/)
  assert.match(homeView, /checked="\{\{membershipInviteAgreed\}\}"/)
  assert.match(homeView, /暂不加入/)
  assert.match(homeView, />同意入会<\/button>/)
  assert.match(homeView, /wx:if="\{\{membershipInviteAgreed\}\}"[^>]*class="member-invite-agree wx-phone-button"[^>]*open-type="getPhoneNumber\|agreePrivacyAuthorization"/)
  assert.doesNotMatch(homeView, /checked="\{\{true\}\}"/)
  assert.match(homeLogic, /membershipInviteAgreed: false/)
  assert.match(homeLogic, /onMembershipInviteAgreementChange/)
  assert.match(homeLogic, /enrollMembership\(terms\.version, 'mini_profile', authorization\.code\)/)
  assert.match(homeLogic, /membershipInvitePresented/)
  assert.match(homeLogic, /cooldownHours \* 60 \* 60 \* 1000/)
  assert.match(configSource, /membershipInviteCooldownHours:\s*24/)
})

test('membership consent stays unchecked and phone authorization appears only after the customer checks it', async () => {
  const [termsView, termsLogic] = await Promise.all([
    read('miniprogram/pages/membership-terms/index.wxml'),
    read('miniprogram/pages/membership-terms/index.js'),
  ])

  assert.match(termsLogic, /agreedToPolicies: false/)
  assert.match(termsView, /checked="\{\{agreedToPolicies\}\}"/)
  assert.match(termsView, /wx:if="\{\{agreedToPolicies\}\}"[^>]*class="accept-button wx-phone-button"[^>]*open-type="getPhoneNumber\|agreePrivacyAuthorization"/)
})

test('native tab bar uses a consistent icon system with a restrained green selected state', async () => {
  const appConfig = JSON.parse(await read('miniprogram/app.json'))
  const tabBar = appConfig.tabBar
  assert.equal(tabBar.color, '#817a72')
  assert.equal(tabBar.selectedColor, '#315d46')
  assert.equal(tabBar.backgroundColor, '#fffdfa')
  assert.equal(tabBar.borderStyle, 'white')
  assert.deepEqual(tabBar.list.map((item) => item.text), ['首页', '预约', '点单', '超嗨', '我的'])
  assert.equal(tabBar.list[2].pagePath, 'pages/order/index')
  for (const item of tabBar.list) {
    for (const path of [item.iconPath, item.selectedIconPath]) {
      assert.match(path, /^assets\/tabbar\/[a-z-]+\.png$/)
      const image = await readFile(new URL(`../miniprogram/${path}`, import.meta.url))
      assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
      assert.ok(image.length < 40 * 1024)
    }
  }
})

test('official M-BOX artwork replaces temporary letter marks with restrained circular badges', async () => {
  const [homeView, profileView, orderView, appStyle, homeStyle, profileStyle, orderStyle, fullLogo, badgeLogo] = await Promise.all([
    read('miniprogram/pages/home/index.wxml'),
    read('miniprogram/pages/profile/index.wxml'),
    read('miniprogram/pages/order/index.wxml'),
    read('miniprogram/app.wxss'),
    read('miniprogram/pages/home/index.wxss'),
    read('miniprogram/pages/profile/index.wxss'),
    read('miniprogram/pages/order/index.wxss'),
    readFile(new URL('../miniprogram/assets/brand/mbox-logo-full.png', import.meta.url)),
    readFile(new URL('../miniprogram/assets/brand/mbox-logo-badge.png', import.meta.url)),
  ])
  assert.match(homeView, /class="brand-logo"[^>]*mbox-logo-badge\.png/)
  assert.match(homeView, /class="member-invite-logo"[^>]*mbox-logo-badge\.png/)
  assert.match(profileView, /class="brand-logo"[^>]*mbox-logo-badge\.png/)
  assert.match(profileView, /class="member-card__logo"[^>]*mbox-logo-badge\.png/)
  assert.match(orderView, /class="gate-logo"[^>]*mbox-logo-badge\.png/)
  assert.doesNotMatch(homeView, /class="brand-mark">M</)
  assert.doesNotMatch(homeView, /class="member-invite-art"/)
  assert.match(appStyle, /\.brand-logo\s*\{[^}]*width:\s*60rpx[^}]*border-radius:\s*50%/)
  assert.match(homeStyle, /\.member-invite-logo\s*\{[^}]*width:\s*126rpx[^}]*border-radius:\s*50%/)
  assert.match(profileStyle, /\.member-card__logo\s*\{[^}]*width:\s*60rpx[^}]*border-radius:\s*50%/)
  assert.match(orderStyle, /\.gate-logo\s*\{[^}]*width:\s*84rpx[^}]*border-radius:\s*50%/)
  for (const [image, size] of [[fullLogo, 512], [badgeLogo, 192]]) {
    assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    assert.equal(image.readUInt32BE(16), size)
    assert.equal(image.readUInt32BE(20), size)
  }
  assert.ok(fullLogo.length < 256 * 1024)
  assert.ok(badgeLogo.length < 64 * 1024)
})

test('customers can browse a read-only menu before scanning, but the browse view cannot add products', async () => {
  const [orderView, apiSource] = await Promise.all([
    read('miniprogram/pages/order/index.wxml'),
    read('miniprogram/utils/api.js'),
  ])
  const browseStart = orderView.indexOf("connectionState === 'needs_scan'")
  const waitingStart = orderView.indexOf("connectionState === 'waiting'")
  assert.ok(browseStart >= 0 && waitingStart > browseStart)
  const browseView = orderView.slice(browseStart, waitingStart)

  assert.match(browseView, /今晚菜单/)
  assert.match(browseView, /浏览不下单，也不要求加入会员/)
  assert.match(browseView, /\{\{item\.availabilityText\}\}/)
  assert.match(browseView, /bindtap="scanTable"/)
  assert.equal((browseView.match(/bindtap="scanTable"/g) || []).length, 1)
  assert.doesNotMatch(browseView, /已到店，扫描桌码开始点单/)
  assert.doesNotMatch(browseView, /bindtap="addProduct"/)
  assert.match(apiSource, /publicRequest\(`\/api\/public\/mini\/menu\/products/)
})

test('customer-facing primary controls keep a comfortable touch target and checkout uses M-BOX brand green', async () => {
  const [homeStyle, orderStyle] = await Promise.all([
    read('miniprogram/pages/home/index.wxss'),
    read('miniprogram/pages/order/index.wxss'),
  ])

  assert.match(homeStyle, /\.member-invite-refuse,[\s\S]*?\.member-invite-agree\s*\{[\s\S]*?min-height:\s*88rpx/)
  assert.match(homeStyle, /\.member-invite-agree\s*\{[\s\S]*?background:\s*#315d46/)
  assert.match(orderStyle, /\.checkout-button[\s\S]*?min-height:\s*92rpx/)
  assert.match(orderStyle, /\.checkout-button[\s\S]*?linear-gradient\(145deg,\s*#315d46,\s*#214635\)/)
  assert.match(orderStyle, /@media\s*\(max-width:\s*350px\)/)
  assert.match(orderStyle, /\.order-page\s*\{[\s\S]*?overflow-x:\s*hidden/)
  const narrowLayout = orderStyle.slice(orderStyle.indexOf('@media (max-width: 350px)'))
  assert.match(narrowLayout, /\.order-head\s*\{[\s\S]*?margin-right:\s*-22rpx;[\s\S]*?margin-left:\s*-22rpx/)
  assert.match(narrowLayout, /\.menu-tools\s*\{[\s\S]*?margin-right:\s*-22rpx;[\s\S]*?margin-left:\s*-22rpx/)
})

test('customer-only reservations stay executable, performances use the public schedule, and store contact is opt-in configured', async () => {
  const [reservationLogic, reservationView, homeLogic, profileLogic, profileView, contactLogic, contactView, supportService, supportApi] = await Promise.all([
    read('miniprogram/pages/reservations/index.js'),
    read('miniprogram/pages/reservations/index.wxml'),
    read('miniprogram/pages/home/index.js'),
    read('miniprogram/pages/profile/index.js'),
    read('miniprogram/pages/profile/index.wxml'),
    read('miniprogram/pages/profile-contact/index.js'),
    read('miniprogram/pages/profile-contact/index.wxml'),
    read('server/normalized/customer-experience-service.ts'),
    read('server/normalized/customer-experience-api.ts'),
  ])
  assert.match(reservationLogic, /EXECUTABLE_RESERVATION_STATUSES/)
  assert.match(reservationLogic, /\['pending', 'confirmed'\]/)
  assert.match(reservationView, /更想坐在哪里？/)
  assert.match(reservationView, /这次想怎样相聚？/)
  assert.match(reservationView, /maxlength="180"/)
  assert.match(homeLogic, /getReservationPerformances\(shanghaiDate\(\)\)/)
  assert.match(homeLogic, /pages\/performances\/index/)
  assert.match(profileLogic, /openContact\(\)/)
  assert.match(profileView, /wx:if="\{\{supportContact\}\}"/)
  assert.match(contactLogic, /wx\.makePhoneCall/)
  assert.match(contactView, /企业微信的直接聊天入口必须由门店在微信侧完成官方配置/)
  assert.match(supportService, /customer\.support\.contact/)
  assert.match(supportApi, /\/staff\/customer-experience\/support-contact/)
})
