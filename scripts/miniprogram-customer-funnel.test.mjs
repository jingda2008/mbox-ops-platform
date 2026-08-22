import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
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
  assert.doesNotMatch(homeView, /《隐私政策》/)
  assert.match(homeView, /catchtap="showMembershipTerms"/)
  assert.doesNotMatch(homeView, /catchtap="openPrivacy"/)
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

test('activity cards are horizontal brand-green surfaces and profile actions expose their destinations', async () => {
  const [homeView, homeStyle, communityView, communityStyle, profileView, profileLogic, profileStyle] = await Promise.all([
    read('miniprogram/pages/home/index.wxml'),
    read('miniprogram/pages/home/index.wxss'),
    read('miniprogram/pages/community/index.wxml'),
    read('miniprogram/pages/community/index.wxss'),
    read('miniprogram/pages/profile/index.wxml'),
    read('miniprogram/pages/profile/index.js'),
    read('miniprogram/pages/profile/index.wxss'),
  ])

  assert.match(homeView, /featured-activity-card__art/)
  assert.match(homeStyle, /\.featured-activity-card\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*228rpx minmax\(0, 1fr\)[^}]*linear-gradient\(145deg, #315d46, #214635/)
  assert.match(homeView, /class="published-content-card/)
  assert.match(homeStyle, /\.published-content-card\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*208rpx minmax\(0, 1fr\)[^}]*linear-gradient\(145deg, #315d46, #214635/)
  assert.doesNotMatch(homeView, /home-campaign-mask/)
  assert.match(communityView, /hover-class="activity-card--hover"/)
  assert.match(communityStyle, /\.activity-card\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*236rpx minmax\(0, 1fr\)[^}]*linear-gradient\(145deg, #315d46, #214635/)
  assert.equal((profileView.match(/class="metric-icon"/g) || []).length, 4)
  assert.match(profileView, /class="service-chip__icon"/)
  assert.match(profileView, /bindtap="openSuperhighService"/)
  assert.match(profileView, /已报名的超嗨活动/)
  assert.match(profileLogic, /if \(this\.data\.registrations\.length\)/)
  assert.match(profileLogic, /selector: '#registered-activities'/)
  assert.match(profileLogic, /wx\.switchTab\(\{ url: '\/pages\/community\/index' \}\)/)
  assert.match(profileStyle, /\.metric-icon\s*\{[^}]*border-radius:\s*50%/)
})

test('activity registration distinguishes confirmed, payment-pending, and waitlist states', async () => {
  const [detailLogic, detailView, communityLogic, communityView, operationsPanel, operationsApi] = await Promise.all([
    read('miniprogram/pages/community-detail/index.js'),
    read('miniprogram/pages/community-detail/index.wxml'),
    read('miniprogram/pages/community/index.js'),
    read('miniprogram/pages/community/index.wxml'),
    read('src/normalized-ui/ActivityOperationsPanel.tsx'),
    read('server/normalized/activity-operations-api.ts'),
  ])

  assert.match(detailView, /'免费报名'/)
  assert.match(detailView, /'提交报名并支付'/)
  assert.match(detailView, /'提交报名'/)
  assert.match(detailView, /'加入候补'/)
  assert.match(detailView, />完成支付<\/button>/)
  assert.doesNotMatch(detailView, /确认报名/)
  assert.match(detailLogic, /报名成功，名额已为您确认。/)
  assert.match(detailLogic, /完成付款后才算报名成功。/)
  assert.match(detailLogic, /requiresPaymentOnSubmit/)
  assert.match(detailLogic, /已加入候补，按报名顺序自动递补；现在无需付款。/)
  assert.match(communityLogic, /REGISTRATION_STATUS_NAMES\[registration\.status\]/)
  assert.match(communityLogic, /paymentStateText/)
  assert.match(communityView, /class="activity-payment-state"/)
  assert.match(operationsPanel, /\/api\/staff\/activity-operations\/\$\{encodeURIComponent\(activity\.publicId\)\}\/publish/)
  assert.doesNotMatch(operationsPanel, /\/api\/staff\/community-activities\//)
  assert.match(operationsPanel, /重试系统候补任务/)
  assert.match(operationsPanel, /不会人工确认任何报名或改变候补顺序/)
  assert.match(operationsApi, /\/staff\/activity-operations\/:publicId\/publish/)
  assert.match(operationsApi, /\/staff\/activity-operations\/:publicId\/waitlist-retry/)
})

test('Superhigh activity access invites non-members to join with native WeChat phone authorization', async () => {
  const [communityLogic, communityView, detailLogic, detailView, termsLogic, repository] = await Promise.all([
    read('miniprogram/pages/community/index.js'),
    read('miniprogram/pages/community/index.wxml'),
    read('miniprogram/pages/community-detail/index.js'),
    read('miniprogram/pages/community-detail/index.wxml'),
    read('miniprogram/pages/membership-terms/index.js'),
    read('server/normalized/customer-experience-repository.ts'),
  ])

  assert.match(communityLogic, /getMiniBootstrap, enrollMembership/)
  assert.match(communityLogic, /if \(!this\.data\.membership\)/)
  assert.match(communityLogic, /enrollMembership\(terms\.version, 'mini_community', authorization\.code\)/)
  assert.match(communityView, /加入会员，解锁超嗨活动/)
  assert.match(communityView, /wx:if="\{\{membershipInviteAgreed\}\}"[^>]*open-type="getPhoneNumber\|agreePrivacyAuthorization"[^>]*bindgetphonenumber="acceptMembershipInvite"/)
  assert.match(detailLogic, /const bootstrap = await getMiniBootstrap\(\)/)
  assert.match(detailLogic, /membershipInviteVisible: true/)
  assert.match(detailLogic, /enrollMembership\(terms\.version, 'mini_community', authorization\.code\)/)
  assert.match(detailView, /加入会员，解锁超嗨活动/)
  assert.match(detailView, /open-type="getPhoneNumber\|agreePrivacyAuthorization"/)
  assert.match(termsLogic, /'mini_community'/)
  assert.match(repository, /ACTIVITY_MEMBERSHIP_REQUIRED/)
  assert.match(repository, /才可查看和报名超嗨活动/)
})

test('profile membership invitation enrolls after one explicit checkbox and one confirmation button', async () => {
  const [profileView, profileLogic] = await Promise.all([
    read('miniprogram/pages/profile/index.wxml'),
    read('miniprogram/pages/profile/index.js'),
  ])

  assert.match(profileView, /邀请加入 M-BOX 会员/)
  assert.match(profileView, /checked="\{\{agreedToPolicies\}\}"/)
  assert.match(profileView, /catchtap="showMembershipTerms"/)
  assert.match(profileView, /wx:if="\{\{agreedToPolicies\}\}"[^>]*class="join-primary wx-phone-button"[^>]*bindgetphonenumber="confirmMembershipJoin"[^>]*>确定入会<\/button>/)
  assert.doesNotMatch(profileView, /阅读入会条款/)
  assert.match(profileLogic, /enrollMembership\(terms\.version, 'mini_profile', authorization\.code\)/)
})

test('profile opens the configured WeCom customer-service conversation through the native WeChat API', async () => {
  const [profileLogic, profileView, contactLogic, contactView, runtimeConfig] = await Promise.all([
    read('miniprogram/pages/profile/index.js'),
    read('miniprogram/pages/profile/index.wxml'),
    read('miniprogram/pages/profile-contact/index.js'),
    read('miniprogram/pages/profile-contact/index.wxml'),
    read('miniprogram/config/index.js'),
  ])

  assert.match(profileView, /联系我们/)
  assert.match(profileView, /bindtap="openContact"/)
  assert.match(profileLogic, /openContact\(\)/)
  assert.match(contactLogic, /wx\.openCustomerServiceChat\(/)
  assert.match(contactLogic, /extInfo:\s*\{\s*url\s*\}/)
  assert.match(contactLogic, /corpId/)
  assert.match(contactView, /bindtap="openCustomerService"/)
  assert.match(runtimeConfig, /wecomCorpId/)
  assert.match(runtimeConfig, /wecomCustomerServiceUrl/)
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
  assert.match(profileView, /class="identity-avatar"[^>]*mbox-logo-badge\.png/)
  assert.match(orderView, /class="gate-logo"[^>]*mbox-logo-badge\.png/)
  assert.doesNotMatch(homeView, /class="brand-mark">M</)
  assert.doesNotMatch(homeView, /class="member-invite-art"/)
  assert.match(appStyle, /\.brand-logo\s*\{[^}]*width:\s*60rpx[^}]*border-radius:\s*50%/)
  assert.match(homeStyle, /\.member-invite-logo\s*\{[^}]*width:\s*126rpx[^}]*border-radius:\s*50%/)
  assert.match(profileStyle, /\.identity-avatar\s*\{[^}]*width:\s*96rpx[^}]*border-radius:\s*50%/)
  assert.match(orderStyle, /\.gate-logo\s*\{[^}]*width:\s*84rpx[^}]*border-radius:\s*50%/)
  for (const [image, size] of [[fullLogo, 360], [badgeLogo, 140]]) {
    assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    assert.equal(image.readUInt32BE(16), size)
    assert.equal(image.readUInt32BE(20), size)
  }
  assert.ok(fullLogo.length < 256 * 1024)
  assert.ok(badgeLogo.length < 64 * 1024)
})

test('every packaged mini-program image stays within the 200KB asset budget', async () => {
  const paths = await imagePaths(new URL('../miniprogram/assets/', import.meta.url))
  assert.ok(paths.length > 0)
  for (const path of paths) {
    const image = await readFile(path)
    assert.ok(image.length <= 200 * 1024, `${path.pathname} exceeds the 200KB image budget`)
  }
})

test('every public menu image available to the mini-program stays within the 200KB budget', async () => {
  const paths = await imagePaths(new URL('../public/menu/', import.meta.url))
  assert.ok(paths.length >= 135)
  for (const path of paths) {
    const image = await readFile(path)
    assert.ok(image.length <= 200 * 1024, `${path.pathname} exceeds the 200KB image budget`)
  }
})

test('customers can browse a read-only menu before scanning, but the browse view cannot add products', async () => {
  const [orderView, orderLogic, mediaSource, apiSource] = await Promise.all([
    read('miniprogram/pages/order/index.wxml'),
    read('miniprogram/pages/order/index.js'),
    read('miniprogram/utils/media.js'),
    read('miniprogram/utils/api.js'),
  ])
  const browseStart = orderView.indexOf("connectionState === 'needs_scan'")
  const waitingStart = orderView.indexOf("connectionState === 'waiting'")
  assert.ok(browseStart >= 0 && waitingStart > browseStart)
  const browseView = orderView.slice(browseStart, waitingStart)

  assert.match(browseView, /今晚菜单/)
  assert.match(browseView, /随便看看也完全可以/)
  assert.match(browseView, /\{\{item\.availabilityText\}\}/)
  assert.match(browseView, /bindtap="scanTable"/)
  assert.equal((browseView.match(/bindtap="scanTable"/g) || []).length, 1)
  assert.doesNotMatch(browseView, /已到店，扫描桌码开始点单/)
  assert.doesNotMatch(browseView, /bindtap="addProduct"/)
  assert.match(orderLogic, /const \{ publicImageUrl \} = require\('\.\.\/\.\.\/utils\/media'\)/)
  assert.match(orderLogic, /imageUrl: publicImageUrl\(item\.imageUrl\)/)
  assert.match(mediaSource, /trimmed\.startsWith\('\/menu\/'\)/)
  assert.match(apiSource, /publicRequest\(`\/api\/public\/mini\/menu\/products/)
})

async function imagePaths(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = new URL(entry.name, directory)
    if (entry.isDirectory()) return imagePaths(new URL(`${entry.name}/`, directory))
    return /\.(?:png|jpe?g|webp)$/i.test(entry.name) ? [path] : []
  }))
  return nested.flat()
}

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
  assert.match(reservationView, /choice-picker/)
  assert.match(reservationView, /bindchange="onSeatChange"/)
  assert.match(reservationView, /bindchange="onOccasionChange"/)
  assert.match(reservationView, /maxlength="80"/)
  assert.match(homeLogic, /getReservationPerformances\(shanghaiDate\(\)\)/)
  assert.match(homeLogic, /pages\/performances\/index/)
  assert.match(homeLogic, /hasTarget/)
  assert.match(homeLogic, /softNetworkError/)
  assert.match(profileLogic, /openContact\(\)/)
  assert.match(profileLogic, /openCoupons\(\)/)
  assert.match(profileLogic, /requestSubscribeMessage/)
  assert.match(profileView, /联系我们/)
  assert.match(profileView, /我的偏好/)
  assert.match(profileView, /会员权益/)
  assert.match(profileView, /metric-label">积分/)
  assert.match(profileView, /metric-label">优惠券/)
  assert.match(profileView, /metric-label">成长值/)
  assert.match(profileView, /metric-label">余额/)
  assert.doesNotMatch(profileView, /消息提醒/)
  assert.doesNotMatch(profileView, /我的资料/)
  assert.doesNotMatch(profileView, /了解个人信息处理范围/)
  assert.doesNotMatch(profileView, /personal-entry-section/)
  assert.doesNotMatch(profileView, /bindtap="openPoints">我的积分/)
  assert.doesNotMatch(profileView, /bindtap="openCoupons">我的优惠券/)
  assert.doesNotMatch(profileView, /bindtap="openBalance">我的余额/)
  assert.doesNotMatch(profileView, /openNotificationSettings/)
  assert.match(contactLogic, /wx\.makePhoneCall/)
  assert.match(contactLogic, /17621392152/)
  assert.match(contactLogic, /openCustomerServiceChat/)
  assert.match(contactView, /企业微信/)
  assert.match(contactView, /拨打/)
  assert.match(supportService, /customer\.support\.contact/)
  assert.match(supportApi, /\/staff\/customer-experience\/support-contact/)
})
