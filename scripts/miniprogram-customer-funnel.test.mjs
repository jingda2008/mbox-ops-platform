import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

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
  assert.match(homeView, /membership-inline-card/)
  assert.match(homeView, /bindtap="openMembershipInvite"/)
  assert.match(homeView, /可先浏览首页和菜单，参与超嗨活动时再加入/)
  assert.match(homeView, /暂不加入/)
  assert.match(homeView, />同意入会<\/button>/)
  assert.match(homeView, /wx:if="\{\{membershipInviteAgreed\}\}"[^>]*class="member-invite-agree wx-phone-button"[^>]*open-type="getPhoneNumber"/)
  assert.doesNotMatch(homeView, /checked="\{\{true\}\}"/)
  assert.match(homeLogic, /membershipInviteAgreed: false/)
  assert.match(homeLogic, /onMembershipInviteAgreementChange/)
  assert.match(homeLogic, /openMembershipInvite\(\)/)
  assert.match(homeLogic, /membershipInviteVisible: false/)
  assert.doesNotMatch(homeLogic, /membershipInvitePresented/)
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
  assert.match(termsView, /wx:if="\{\{agreedToPolicies\}\}"[^>]*class="accept-button wx-phone-button"[^>]*open-type="getPhoneNumber"/)
})

test('only the payment initiator can continue an active table payment', async () => {
  const [orderLogic, orderView, accountLogic] = await Promise.all([
    read('miniprogram/pages/order/index.js'),
    read('miniprogram/pages/order/index.wxml'),
    read('miniprogram/pages/account/index.js'),
  ])

  assert.match(orderLogic, /canContinue: pendingFromOrders\.paymentAccess === 'available'/)
  assert.match(orderLogic, /canContinue: Boolean\(tableOrdersAvailable && storedOrder[\s\S]*?\['available', 'payment_in_progress'\]\.includes\(storedOrder\.paymentAccess\)\)/)
  assert.match(orderLogic, /storedPending && tableOrdersAvailable[\s\S]*?!storedOrder/)
  assert.match(orderLogic, /桌账暂时无法核对，请稍后刷新/)
  assert.match(orderLogic, /if \(!pending \|\| !pending\.canContinue \|\| this\.data\.busy\) return/)
  assert.match(orderView, /wx:if="\{\{pendingPayment\.canContinue\}\}"[^>]*bindtap="continuePayment"/)
  assert.match(accountLogic, /canPay: order\.paymentAccess === 'available'/)
  assert.match(accountLogic, /canContinue: true/)
  assert.match(accountLogic, /storedPending && \(!storedOrder \|\| Number\(storedOrder\.payableAmountMinor \|\| 0\) === 0\)/)
})

test('activity cards are horizontal brand-green surfaces and profile actions expose their destinations', async () => {
  const [homeView, homeLogic, homeStyle, communityView, communityStyle, profileView, profileLogic, profileStyle] = await Promise.all([
    read('miniprogram/pages/home/index.wxml'),
    read('miniprogram/pages/home/index.js'),
    read('miniprogram/pages/home/index.wxss'),
    read('miniprogram/pages/community/index.wxml'),
    read('miniprogram/pages/community/index.wxss'),
    read('miniprogram/pages/profile/index.wxml'),
    read('miniprogram/pages/profile/index.js'),
    read('miniprogram/pages/profile/index.wxss'),
  ])

  assert.match(homeView, /featured-activity-card__art/)
  assert.match(homeStyle, /\.featured-activity-card\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*row[^}]*linear-gradient\(145deg, #315d46, #214635/)
  assert.match(homeView, /class="published-content-card/)
  assert.match(homeView, /wx:if="\{\{editorialPanel\}\}" class="editorial-panel-mask"/)
  assert.match(homeView, /bindtap="openEditorialTarget"/)
  assert.match(homeLogic, /openEditorialTarget\(candidate\)/)
  assert.match(homeLogic, /card\.type === 'article' \|\| !card\.hasTarget/)
  assert.match(homeStyle, /\.published-content-card\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*row[^}]*linear-gradient\(145deg, #315d46, #214635/)
  assert.doesNotMatch(homeView, /home-campaign-mask/)
  assert.match(communityView, /hover-class="activity-card--hover"/)
  assert.match(communityStyle, /\.activity-card\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*row[^}]*linear-gradient\(145deg, #315d46, #214635/)
  assert.equal((profileView.match(/class="metric-icon"/g) || []).length, 4)
  assert.match(profileView, /class="service-chip__icon"/)
  assert.match(profileView, /bindtap="openSuperhighService"/)
  assert.match(profileView, /已报名的超嗨活动/)
  assert.match(profileLogic, /activityRegistrationViews\(await getActivityRegistrations\(\)\)/)
  assert.match(profileLogic, /selector: '#registered-activities'/)
  assert.match(profileLogic, /当前不会跳转到活动列表/)
  assert.match(profileLogic, /wx\.switchTab\(\{ url: '\/pages\/community\/index' \}\)/)
  assert.match(profileStyle, /\.metric-icon\s*\{[^}]*border-radius:\s*50%/)
  assert.match(profileStyle, /\.member-content-card\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*row[^}]*background:\s*linear-gradient\(145deg, #315d46, #214635/)
})

test('activity-list dates use the shared iOS-safe time parser', async () => {
  const [communityLogic, formatLogic] = await Promise.all([
    read('miniprogram/pages/community/index.js'),
    read('miniprogram/utils/format.js'),
  ])
  const formatModule = { exports: {} }
  vm.runInNewContext(formatLogic, { module: formatModule, exports: formatModule.exports })
  const { dateInput } = formatModule.exports

  assert.equal(dateInput('2026-08-30 19:30:00+08'), '2026-08-30T19:30:00+08:00')
  assert.match(communityLogic, /const \{ money, dateInput \} = require\('\.\.\/\.\.\/utils\/format'\)/)
  assert.match(communityLogic, /new Date\(dateInput\(value\)\)/)
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
  assert.match(detailLogic, /showRegistrationOutcome/)
  assert.match(detailLogic, /confirmText: '我的活动'/)
  assert.match(detailLogic, /await this\.refreshActivityAvailability\(\)/)
  assert.match(detailLogic, /完成付款后才算报名成功。/)
  assert.match(detailLogic, /requiresPaymentOnSubmit/)
  assert.match(detailLogic, /activityPackagePublicId/)
  assert.match(detailLogic, /ACTIVITY_PACKAGE_PURCHASE_LIMIT/)
  assert.match(detailView, /selectedPricing && selectedPricing\.requiresPaymentOnSubmit/)
  assert.match(detailView, /每会员限购/)
  assert.match(detailLogic, /已加入候补，按报名顺序自动递补；现在无需付款。/)
  assert.match(detailLogic, /ACTIVITY_CONTACT_INVALID/)
  assert.match(detailLogic, /ACTIVITY_CONTACT_PROTECTION_UNAVAILABLE/)
  assert.match(detailLogic, /ACTIVITY_CONTACT_PROTECTION_FAILED/)
  assert.match(detailLogic, /报名服务配置异常，请稍后再试/)
  assert.match(detailLogic, /ACTIVITY_REGISTRATION_RESULT_UNCONFIRMED/)
  assert.match(detailLogic, /报名服务暂时繁忙，结果尚未确认/)
  assert.match(detailLogic, /本机待核对请求已清除/)
  assert.match(detailLogic, /shouldClearRegistrationAttempt/)
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

test('activity registration asks only for a phone number and guides a missed field into view', async () => {
  const [detailLogic, detailView, detailStyle, api] = await Promise.all([
    read('miniprogram/pages/community-detail/index.js'),
    read('miniprogram/pages/community-detail/index.wxml'),
    read('miniprogram/pages/community-detail/index.wxss'),
    read('server/normalized/customer-experience-api.ts'),
  ])

  assert.match(detailLogic, /function registrationContact\(value\)[\s\S]*?\^1\\d\{10\}\$/)
  assert.match(detailLogic, /focusRegistrationField\('contact'/)
  assert.match(detailLogic, /wx\.pageScrollTo\(\{[\s\S]*?selector: contact \? '#activity-registration-contact' : '#activity-registration-acknowledgement',[\s\S]*?duration: 280/)
  assert.match(detailLogic, /partySizeLimit\(activity, activityPackage\)/)
  assert.match(detailView, /id="activity-registration-contact"/)
  assert.match(detailView, /type="number"[\s\S]*?maxlength="11"[\s\S]*?focus="\{\{contactFocused\}\}"/)
  assert.match(detailView, /仅用于本次活动联系/)
  assert.match(detailView, /id="activity-registration-acknowledgement"/)
  assert.match(detailStyle, /\.registration-contact--attention/)
  assert.match(detailLogic, /REGISTRATION_ATTEMPT_MAX_AGE_MS = 15 \* 60 \* 1000/)
  assert.match(detailLogic, /function registrationAttemptPayload\(value\)[\s\S]*?Phone numbers are never persisted/)
  assert.match(detailLogic, /payload: registrationAttemptPayload\(payload\)/)
  assert.match(detailLogic, /Object\.assign\(\{\}, attempt\.payload, \{ contactSnapshot:/)
  assert.match(api, /function miniActivityRegistrationPhone\(value: unknown\)/)
  assert.match(api, /ACTIVITY_CONTACT_INVALID/)
  assert.doesNotMatch(api.slice(api.indexOf('function miniActivityRegistrationPhone'), api.indexOf('export async function protectActivityRegistrationContact')), /wechat/)
})

test('tonight ordering keeps live service separate from recommendation and delegates ranking to the server', async () => {
  const [orderLogic, orderView, orderStyle, servicePage, statusPage, recommendationService] = await Promise.all([
    read('miniprogram/pages/order/index.js'),
    read('miniprogram/pages/order/index.wxml'),
    read('miniprogram/pages/order/index.wxss'),
    read('miniprogram/pages/service/index.js'),
    read('miniprogram/pages/status/index.js'),
    read('server/normalized/customer-experience-service.ts'),
  ])

  assert.match(orderView, /本桌服务\{\{serviceSummary\.live \? ' · 自动更新' : ''\}\}/)
  assert.match(orderView, /呼叫服务员/)
  assert.match(orderView, /生日\/需求/)
  assert.match(orderView, /data-code="celebration" aria-label="生日或个性化需求"/)
  assert.match(orderView, /投诉\/不满意/)
  assert.match(orderView, /帮我选/)
  assert.match(orderView, /摇一摇 · 换一组推荐/)
  assert.match(orderView, /单点约 \{\{item\.separatePriceText\}\}/)
  assert.match(orderLogic, /getServiceRequests/)
  assert.match(orderLogic, /async function loadPerformanceView\(\)[\s\S]*?演出信息暂时未更新，请点一下重试/)
  assert.match(orderLogic, /async retryPerformance\(\)/)
  assert.match(orderView, /wx:elif="\{\{performanceError\}\}"[^>]*bindtap="retryPerformance"/)
  assert.match(orderStyle, /\.show-brief--retry/)
  assert.match(orderLogic, /scheduleServicePoll\(request\)[\s\S]*?\}, 6000\)/)
  assert.match(orderLogic, /async requestQuickService/)
  assert.match(orderLogic, /createTableRequestGuard/)
  assert.match(orderLogic, /beginTableRequest\(session\)/)
  assert.match(orderLogic, /if \(request && !this\.isCurrentTableRequest\(request\)\) return false/)
  assert.match(statusPage, /createTableRequestGuard/)
  assert.match(statusPage, /localRequestsKey\(request\.scope\)/)
  assert.match(servicePage, /createTableRequestGuard/)
  assert.match(servicePage, /localRequestsKey\(request\.scope\)/)
  assert.match(orderLogic, /wx\.startAccelerometer/)
  assert.match(orderLogic, /recommendationIntent/)
  assert.match(orderLogic, /marketingLabel/)
  assert.match(recommendationService, /recommendationIntent: RecommendationIntent/)
  assert.match(orderStyle, /\.quick-service button[\s\S]*?min-height:\s*88rpx/)
  assert.match(servicePage, /tableSessionCacheScope/)
  assert.match(statusPage, /tableSessionCacheScope/)
})

test('Superhigh activity access invites non-members to join with native WeChat phone authorization', async () => {
  const [homeLogic, communityLogic, communityView, detailLogic, detailView, profileLogic, termsLogic, repository] = await Promise.all([
    read('miniprogram/pages/home/index.js'),
    read('miniprogram/pages/community/index.js'),
    read('miniprogram/pages/community/index.wxml'),
    read('miniprogram/pages/community-detail/index.js'),
    read('miniprogram/pages/community-detail/index.wxml'),
    read('miniprogram/pages/profile/index.js'),
    read('miniprogram/pages/membership-terms/index.js'),
    read('server/normalized/customer-experience-repository.ts'),
  ])

  assert.match(homeLogic, /openFeaturedActivity\(\)\s*\{[\s\S]*?if \(!this\.data\.membership\)[\s\S]*?pendingActivityId: activity\.publicId/)
  assert.match(homeLogic, /const pendingActivityId = this\.data\.pendingActivityId/)
  assert.match(homeLogic, /if \(pendingActivityId\)\s*\{[\s\S]*?wx\.navigateTo/)
  assert.match(communityLogic, /getMiniBootstrap, enrollMembership/)
  assert.match(communityLogic, /if \(!this\.data\.membership\)/)
  assert.match(communityLogic, /membershipInviteVisible: false/)
  assert.match(communityLogic, /enrollMembership\(terms\.version, 'mini_community', authorization\.code\)/)
  assert.match(communityView, /加入会员，解锁超嗨活动/)
  assert.match(communityView, /查看和报名活动需要先加入会员并授权手机号。/)
  assert.match(communityView, /wx:if="\{\{membershipInviteAgreed\}\}"[^>]*open-type="getPhoneNumber"[^>]*bindgetphonenumber="acceptMembershipInvite"/)
  assert.match(detailLogic, /const bootstrap = await getMiniBootstrap\(\)/)
  assert.match(detailLogic, /getActivityPreview\(this\.data\.id\)/)
  assert.match(detailLogic, /if \(!membership\)\s*\{[\s\S]*?previewOnly: true/)
  assert.match(detailLogic, /if \(!this\.data\.membership\)/)
  assert.match(detailLogic, /enrollMembership\(terms\.version, 'mini_community', authorization\.code\)/)
  assert.match(detailView, /加入会员，解锁超嗨活动/)
  assert.match(detailView, /报名活动需要先加入会员并授权手机号。/)
  assert.match(detailView, /open-type="getPhoneNumber"/)
  assert.match(termsLogic, /'mini_community'/)
  assert.match(repository, /ACTIVITY_MEMBERSHIP_REQUIRED/)
  assert.match(repository, /才可查看和报名超嗨活动/)
  assert.match(profileLogic, /openCommunity\(event\)\s*\{\s*if \(!this\.requireMembership\(\)\) return\s+const activityId[\s\S]*?wx\.navigateTo/)
  assert.doesNotMatch(profileLogic, /if \(!this\.requireMembership\(\)\) return wx\.navigateTo/)
})

test('profile membership invitation enrolls after one explicit checkbox and one confirmation button', async () => {
  const [profileView, profileLogic] = await Promise.all([
    read('miniprogram/pages/profile/index.wxml'),
    read('miniprogram/pages/profile/index.js'),
  ])

  assert.match(profileView, /邀请加入 M-BOX 会员/)
  assert.match(profileView, /loginSheetVisible/)
  assert.match(profileView, /checked="\{\{agreedToPolicies\}\}"/)
  assert.match(profileView, /catchtap="showMembershipTerms"/)
  assert.match(profileView, /确定加入并授权手机号/)
  assert.match(profileView, /wx:if="\{\{agreedToPolicies\}\}"[^>]*class="login-action-link[^"]*wx-phone-button"[^>]*bindgetphonenumber="quickLoginAndEnroll"/)
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
  const browseStart = orderView.indexOf("connectionState === 'needs_scan' || connectionState === 'waiting'")
  const browseEnd = orderView.indexOf('<block wx:else>')
  assert.ok(browseStart >= 0 && browseEnd > browseStart)
  const browseView = orderView.slice(browseStart, browseEnd)

  assert.match(browseView, /今晚菜单/)
  assert.match(browseView, /随便看看也完全可以/)
  assert.match(browseView, /请联系服务人员开台/)
  assert.match(browseView, /等待期间可以先查看今晚真实菜单/)
  assert.match(browseView, /\{\{item\.availabilityText\}\}/)
  assert.match(browseView, /product-list--browse/)
  assert.doesNotMatch(browseView, /preview-product-grid/)
  assert.match(browseView, /bindtap="scanTable"/)
  assert.equal((browseView.match(/bindtap="scanTable"/g) || []).length, 1)
  assert.doesNotMatch(browseView, /已到店，扫描桌码开始点单/)
  assert.doesNotMatch(browseView, /bindtap="addProduct"/)
  assert.match(orderLogic, /const \{ publicImageUrl \} = require\('\.\.\/\.\.\/utils\/media'\)/)
  assert.match(orderLogic, /imageUrl: publicImageUrl\(item\.imageUrl\)/)
  assert.match(orderLogic, /function menuProducts\(items\)/)
  assert.match(orderLogic, /if \(connected\.status === 'waiting_for_table'\)[\s\S]*?await this\.loadBrowseData\('', waitingView, request\)/)
  assert.match(orderLogic, /connectionMessage: '请联系服务人员开台。开台后可直接下单。'/)
  assert.doesNotMatch(orderLogic, /includeUnavailable/)
  assert.match(orderLogic, /const products = menuProducts\(results\[0\]\)/)
  assert.match(orderLogic, /function menuRecommendations\(items, products\)/)
  assert.match(orderLogic, /const recommendations = menuRecommendations\(result\.recommendations, this\.data\.products\)/)
  assert.match(orderView, /wx:else class="product-unavailable" disabled="\{\{true\}\}"/)
  assert.match(mediaSource, /trimmed\.startsWith\('\/menu\/'\)/)
  assert.match(apiSource, /publicRequest\(`\/api\/public\/mini\/menu\/products/)
})

test('customer pages use Chinese release copy and the table cart is server-authoritative', async () => {
  const [orderView, orderLogic, apiSource, errorSource, sessionApi, cartRepository] = await Promise.all([
    read('miniprogram/pages/order/index.wxml'),
    read('miniprogram/pages/order/index.js'),
    read('miniprogram/utils/api.js'),
    read('miniprogram/utils/customer-error.js'),
    read('server/normalized/guest-session-api.ts'),
    read('server/normalized/guest-shared-cart-repository.ts'),
  ])
  const appConfig = JSON.parse(await read('miniprogram/app.json'))
  const views = await Promise.all(appConfig.pages.map((page) => read(`miniprogram/${page}.wxml`)))

  for (const view of [orderView, ...views]) {
    assert.doesNotMatch(view, /开发模式|上架候选版|正式发布提示|STEP\s*0[1-3]|LIVE ORDER|TONIGHT MENU|M-BOX MEMBERSHIP|MEMBER · PERSONAL|SERVICE STATUS|TONIGHT AT M-BOX|ARTIST PROFILE|>STATUS<|>SERVICES</)
  }
  assert.match(orderView, /本桌共享购物车/)
  assert.match(orderView, /同桌每位顾客加入的商品都会在这里同步显示/)
  assert.match(orderLogic, /serviceStaffName/)
  assert.match(orderView, /小计 \{\{item\.subtotalText\}\}/)
  assert.match(orderView, /item\.unavailableReason/)
  assert.match(orderLogic, /getSharedCart,\s*adjustSharedCart/)
  assert.match(orderLogic, /clearSharedCart/)
  assert.doesNotMatch(orderLogic, /mbox\.guest\.cart\./)
  assert.doesNotMatch(orderLogic, /setInterval\(\(\) => this\.refreshSharedCart/)
  assert.match(orderLogic, /Math\.min\(60000, 5000 \* \(2 \*\* Math\.min\(this\.sharedCartPollFailures, 4\)\)\)/)
  assert.match(apiSource, /\/api\/guest\/shared-cart/)
  assert.match(apiSource, /\/api\/guest\/shared-cart\/clear/)
  assert.match(apiSource, /expectedGeneration: input\.expectedGeneration/)
  assert.match(orderLogic, /this\.data\.cartGeneration, this\.data\.cartVersion/)
  assert.match(errorSource, /CART_PROTOCOL_UPGRADE_REQUIRED/)
  assert.match(sessionApi, /cartProtocolVersion/)
  assert.match(cartRepository, /new OrderRepository\(this\.transaction\)\.assertCurrentOrderable/)
  assert.match(cartRepository, /async clear\(/)
  assert.match(cartRepository, /unavailableReason/)
  assert.match(cartRepository, /totalAmountMinor/)
})

test('recommendations stay inside the current table menu and never bypass guest ordering gates', async () => {
  const [orderLogic, recommendationRepository] = await Promise.all([
    read('miniprogram/pages/order/index.js'),
    read('server/normalized/customer-experience-repository.ts'),
  ])

  assert.match(orderLogic, /function menuRecommendations\(items, products\)/)
  assert.match(orderLogic, /\.filter\(\(product\) => product\.available\)/)
  assert.match(orderLogic, /const product = this\.data\.products\.find\(\(item\) => item\.productId === productId\)/)
  assert.match(recommendationRepository, /AND 'guest_qr'=ANY\(product\.allowed_channels\)/)
  assert.match(recommendationRepository, /mbox\.inventory_balances balance/)
  assert.match(recommendationRepository, /recipe\.status='active'/)
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
  assert.match(orderStyle, /@media\s*\(max-width:\s*390px\)/)
  assert.match(orderStyle, /\.order-page\s*\{[\s\S]*?overflow-x:\s*hidden/)
  const narrowLayout = orderStyle.slice(orderStyle.indexOf('@media (max-width: 390px)'))
  assert.match(narrowLayout, /\.order-head\s*\{[\s\S]*?margin-right:\s*-22rpx;[\s\S]*?margin-left:\s*-22rpx/)
  assert.match(narrowLayout, /\.menu-tools\s*\{[\s\S]*?margin-right:\s*-22rpx;[\s\S]*?margin-left:\s*-22rpx/)
})

test('monthly performance calendar starts at today and keeps date choices compact', async () => {
  const [logic, view, style] = await Promise.all([
    read('miniprogram/pages/performances/index.js'),
    read('miniprogram/pages/performances/index.wxml'),
    read('miniprogram/pages/performances/index.wxss'),
  ])

  assert.match(logic, /function selectedDateForMonth\(value, previousDate\)/)
  assert.match(logic, /monthValue: date\.slice\(0, 7\)/)
  assert.match(logic, /calendarScrollTarget: dayTargetId\(date\)/)
  assert.match(logic, /calendarScrollTarget: dayTargetId\(selectedDate\)/)
  assert.match(view, /fields="month" value="\{\{monthValue\}\}" start="\{\{minimumMonth\}\}"/)
  assert.match(view, /scroll-into-view="\{\{calendarScrollTarget\}\}"/)
  assert.match(view, /id="calendar-day-\{\{item\.value\}\}"/)
  assert.match(view, /class="day-chip__label"/)
  assert.match(style, /\.day-chip\{display:inline-flex;width:88rpx;min-height:88rpx/)
  assert.match(style, /\.day-chip__label\{display:inline-flex;min-width:24rpx;height:24rpx/)
  assert.match(style, /\.day-chip\.is-on \.day-chip__label\{min-width:36rpx;height:36rpx/)
  assert.match(style, /font-size:20rpx/)
})

test('customer surfaces keep neutral browsing, meaningful activity labels, and reachable membership controls', async () => {
  const [communityLogic, communityView, homeConfig, memberCenterLogic, orderLogic, orderStyle, profileLogic, profileStyle] = await Promise.all([
    read('miniprogram/pages/community/index.js'),
    read('miniprogram/pages/community/index.wxml'),
    read('miniprogram/pages/home/index.json'),
    read('miniprogram/pages/member-center/index.js'),
    read('miniprogram/pages/order/index.js'),
    read('miniprogram/pages/order/index.wxss'),
    read('miniprogram/pages/profile/index.js'),
    read('miniprogram/pages/profile/index.wxss'),
  ])

  assert.doesNotMatch(communityView, /<text>\{\{activities\.length\}\}<\/text>/)
  assert.match(communityView, /wx:if="\{\{item\.sequenceText\}\}" class="activity-sequence"/)
  assert.match(communityLogic, /Number\.isInteger\(Number\(item\.sortOrder\)\) && Number\(item\.sortOrder\) > 0/)
  assert.equal(JSON.parse(homeConfig).navigationBarTitleText, 'M-BOX')
  assert.doesNotMatch(profileLogic, /成长值待核验/)
  assert.doesNotMatch(memberCenterLogic, /成长值待核验/)
  assert.match(profileLogic, /成长进度暂不可显示/)
  assert.match(profileStyle, /\.profile-member-card__top button, \.profile-member-card__foot button \{[^}]*min-height: 88rpx/)
  assert.match(profileStyle, /\.profile-member-card__foot \{ min-height: 88rpx/)
  assert.match(orderLogic, /const connectionError = session\.tableToken[\s\S]*?customerErrorMessage\(error, '桌台连接已失效，请重新扫描桌面二维码'\) : ''/)
  assert.match(orderStyle, /\.quick-service button \{[^}]*min-height: 88rpx[^}]*border-radius: 999rpx[^}]*box-shadow: none/)
})

test('customer-only reservations stay executable, performances use the public schedule, and store contact is opt-in configured', async () => {
  const [reservationLogic, reservationView, orderLogic, homeLogic, miniApi, profileLogic, profileView, contactLogic, contactView, supportService, supportApi] = await Promise.all([
    read('miniprogram/pages/reservations/index.js'),
    read('miniprogram/pages/reservations/index.wxml'),
    read('miniprogram/pages/order/index.js'),
    read('miniprogram/pages/home/index.js'),
    read('miniprogram/utils/api.js'),
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
  assert.match(miniApi, /async function getTodayPerformances\(\)\s*\{\s*return getReservationPerformances\(shanghaiDate\(\)\)\s*\}/)
  assert.doesNotMatch(miniApi, /async function getTodayPerformances\(\)[\s\S]*?request\('\/api\/guest\/performances\/today'/)
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
  assert.match(profileView, /metric-label">储值余额/)
  assert.match(profileLogic, /balanceText: '未开通'/)
  assert.doesNotMatch(profileLogic, /balanceText: '0'/)
  assert.match(profileView, /metric-icon">积/)
  assert.match(profileView, /超嗨活动/)
  assert.match(profileView, /loginSheetVisible/)
  assert.match(profileView, /login-sheet-mask/)
  assert.match(profileLogic, /requireMembership/)
  assert.match(profileLogic, /openLoginSheet/)
  assert.match(profileView, /login-action-link/)
  assert.match(profileLogic, /openReservations\(\)\s*\{[^}]*requireMembership/)
  assert.doesNotMatch(orderLogic, /requireMembershipLogin/)
  assert.match(orderLogic, /wx\.scanCode\(\{/)
  assert.match(reservationLogic, /membershipRequired/)
  assert.match(reservationView, /membership-gate/)
  assert.doesNotMatch(profileView, /class="login-dock"/)
  assert.match(profileView, /确定加入并授权手机号/)
  assert.match(profileLogic, /quickLoginAndEnroll/)
  assert.match(profileView, /退出登录/)
  assert.match(profileLogic, /logoutMember/)
  assert.match(profileLogic, /restartAnonymousCustomerSession/)
  assert.match(profileView, /访客/)
  assert.match(profileView, /profile-member-card/)
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
