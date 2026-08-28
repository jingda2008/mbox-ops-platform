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

test('home menu entry stays a compact full-width horizontal control', async () => {
  const [homeView, homeStyle] = await Promise.all([
    read('miniprogram/pages/home/index.wxml'),
    read('miniprogram/pages/home/index.wxss'),
  ])

  assert.match(homeView, /<view class="primary-experience"[^>]*hover-class="button-hover"[^>]*aria-role="button"/)
  assert.match(homeView, /class="primary-experience__body"/)
  assert.match(homeStyle, /\.primary-experience\s*\{[^}]*width:\s*100%[^}]*min-width:\s*100%[^}]*max-width:\s*100%[^}]*min-height:\s*136rpx[^}]*box-sizing:\s*border-box[^}]*border-radius:\s*22rpx/)
  assert.match(homeStyle, /\.primary-experience__body\s*\{[^}]*flex:\s*1/)
  assert.match(homeStyle, /\.primary-experience__title\s*\{[^}]*white-space:\s*nowrap/)
  assert.doesNotMatch(homeStyle, /\.primary-experience\s*\{[^}]*min-height:\s*218rpx/)
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

test('customer pages avoid duplicate status labels and backstage implementation copy', async () => {
  const [homeView, orderView, accountView, communityView, detailView, detailLogic, complaintView, memberCenterView, serviceView] = await Promise.all([
    read('miniprogram/pages/home/index.wxml'),
    read('miniprogram/pages/order/index.wxml'),
    read('miniprogram/pages/account/index.wxml'),
    read('miniprogram/pages/community/index.wxml'),
    read('miniprogram/pages/community-detail/index.wxml'),
    read('miniprogram/pages/community-detail/index.js'),
    read('miniprogram/pages/complaint/index.wxml'),
    read('miniprogram/pages/member-center/index.wxml'),
    read('miniprogram/pages/service/index.wxml'),
  ])

  assert.doesNotMatch(homeView, /<view class="section-title"><text>今晚现场<\/text><text class="section-link">/)
  assert.doesNotMatch(homeView, /状态实时同步/)
  assert.match(homeView, /<text class="performance-compact__state">/)
  assert.doesNotMatch(orderView, /自动更新|后端/)
  assert.match(accountView, /付款结果尚未确认时，请先查看结果，避免重复付款。/)
  assert.doesNotMatch(communityView, /报名与安排以活动详情为准/)
  assert.doesNotMatch(detailView, /安全规则版本|由店长发起|收银复核|请求编号/)
  assert.doesNotMatch(detailLogic, /安全规则版本|可核验版本|由店长发起|收银复核|请求编号/)
  assert.match(complaintView, /由值班负责人跟进/)
  assert.doesNotMatch(memberCenterView, /以系统状态为准|已授予权益/)
  assert.doesNotMatch(serviceView, /需要值班经理/)
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
  assert.equal((profileView.match(/class="metric-icon"/g) || []).length, 3)
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
  assert.match(detailView, />继续付款<\/button>/)
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
  assert.match(detailLogic, /已加入候补名单，会按报名顺序依次安排；现在无需付款。/)
  assert.match(detailLogic, /ACTIVITY_CONTACT_INVALID/)
  assert.match(detailLogic, /ACTIVITY_CONTACT_PROTECTION_UNAVAILABLE/)
  assert.match(detailLogic, /ACTIVITY_CONTACT_PROTECTION_FAILED/)
  assert.match(detailLogic, /报名服务暂时不可用，请稍后再试/)
  assert.match(detailLogic, /ACTIVITY_REGISTRATION_RESULT_UNCONFIRMED/)
  assert.match(detailLogic, /报名服务暂时繁忙，结果尚未确认/)
  assert.match(detailLogic, /请按提示调整后重新报名。/)
  assert.match(detailLogic, /shouldClearRegistrationAttempt/)
  assert.match(detailLogic, /ACTIVITY_PAYMENT_WECHAT_IDENTITY_REJECTED/)
  assert.match(detailLogic, /微信付款身份未通过验证，本次没有扣款。请点击下方按钮刷新身份后重新报名。/)
  assert.match(detailLogic, /const identityRefreshRequired = preflightIdentityRequired \|\| rejectedIdentity/)
  assert.match(detailView, /刷新身份后付款/)
  assert.match(detailView, /刷新身份后提交/)
  const customerErrors = await read('miniprogram/utils/customer-error.js')
  assert.match(customerErrors, /ACTIVITY_PAYMENT_CONFIGURATION_UNAVAILABLE/)
  assert.match(customerErrors, /ACTIVITY_PAYMENT_NETWORK_REJECTED/)
  assert.match(customerErrors, /ACTIVITY_PAYMENT_PROVIDER_REJECTED/)
  assert.match(customerErrors, /ACTIVITY_PAYMENT_RESULT_UNKNOWN/)
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

test('a required paid activity opens WeChat payment as part of one registration action', async () => {
  const detailLogic = await read('miniprogram/pages/community-detail/index.js')
  const storage = new Map()
  const calls = { register: 0, paymentAction: 0, paymentQuery: 0, requestPayment: 0, outcome: 0, modal: 0 }
  let pageDefinition
  const api = {
    getActivity: async () => null,
    getActivityPreview: async () => null,
    getActivityLoyaltyBenefits: async () => [],
    getActivityRegistrations: async () => [],
    registerActivity: async () => {
      calls.register += 1
      return {
        publicId: 'registration-direct-payment-001', status: 'payment_pending',
        payment: { publicId: 'activity-payment-direct-001', amountMinor: 2000, method: 'jsapi' },
      }
    },
    getActivityRegistrationPayment: async () => ({
      registrationStatus: 'payment_pending', allowedActions: ['start_payment', 'query_payment', 'cancel_registration'],
      payment: { publicId: 'activity-payment-direct-001', amountMinor: 2000, method: 'jsapi' },
    }),
    startActivityRegistrationPayment: async () => {
      calls.paymentAction += 1
      return {
        providerAction: {
          status: 'pending', presentation: 'jsapi',
          payload: { timeStamp: '1', nonceStr: 'nonce', package: 'prepay_id=demo', signType: 'RSA', paySign: 'signature' },
        },
      }
    },
    queryActivityRegistrationPayment: async () => {
      calls.paymentQuery += 1
      return {
        registrationStatus: 'confirmed', resolutionState: 'confirmed', allowedActions: [],
        payment: { publicId: 'activity-payment-direct-001', amountMinor: 2000, method: 'jsapi' },
      }
    },
    cancelActivityRegistration: async () => ({}),
    getMiniBootstrap: async () => ({}),
    getWechatNotificationPrompt: async () => ({ authorizations: [] }),
    enrollMembership: async () => ({}),
  }
  const require = (path) => {
    if (path === '../../utils/api') return api
    if (path === '../../utils/auth') return { ensureCustomerSession: async () => ({}) }
    if (path === '../../utils/id') return { randomId: (prefix) => `${prefix}-unit-test-key-0001` }
    if (path === '../../utils/format') return { money: (minor) => `¥${(Number(minor) / 100).toFixed(2)}`, dateTime: (value) => String(value || '') }
    if (path === '../../utils/media') return { publicImageUrl: (value) => value || '' }
    if (path === '../../utils/wechat-phone') return { readWechatPhoneAuthorization: () => ({ code: '' }) }
    if (path === '../../utils/customer-error') return { customerErrorMessage: (_error, fallback) => fallback, isWechatCancellation: () => false }
    if (path === '../../utils/wechat-subscription') return { requestWechatSubscription: async () => ({ presented: false, outcomes: [] }) }
    throw new Error(`unexpected mini-program dependency: ${path}`)
  }
  const wx = {
    getStorageSync: (key) => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: (key) => storage.delete(key),
    requestPayment: (options) => { calls.requestPayment += 1; options.success({}) },
    showModal: () => { calls.modal += 1; throw new Error('the required-payment path must not add a modal before WeChat payment') },
    showActionSheet: () => { throw new Error('a required payment has no alternate payment choice') },
    pageScrollTo: () => {},
    switchTab: () => {},
    navigateBack: () => {},
    navigateTo: () => {},
    showToast: () => {},
  }
  vm.runInNewContext(detailLogic, { Page: (definition) => { pageDefinition = definition }, require, wx, setTimeout, clearTimeout, Date, Promise, Object, Array, Number, String, Boolean, RegExp, Math })
  assert.ok(pageDefinition)

  const page = Object.assign({}, pageDefinition)
  const instance = Object.assign(page, {
    data: Object.assign({}, pageDefinition.data, {
      busy: false, membership: { publicId: 'member-direct-payment' }, partySize: 1, contact: '13800138000',
      ruleAcknowledged: true, registration: null, selectedPackage: null, selectedPackagePublicId: '',
      activity: {
        publicId: 'activity-direct-payment', registrationBlocked: false, packageSelectionRequired: false,
        remainingCapacity: 8, feeAmountMinor: 2000, feeBasis: 'per_registration', depositAmountMinor: 0,
        paymentMode: 'full_required', paymentAvailability: 'available', availablePaymentMethods: ['jsapi'],
        paymentDeadlineMinutes: 15, paymentRuleText: '报名后立即支付', safetyPolicyVersion: 'safety-v1', refundPolicyVersion: 'refund-v1',
      },
    }),
    setData(next, callback) { this.data = Object.assign({}, this.data, next); if (callback) callback() },
    async refreshActivityAvailability() {},
    rememberRegistration() {},
    async showRegistrationOutcome() { calls.outcome += 1 },
  })

  await instance.register()

  assert.equal(calls.register, 1)
  assert.equal(calls.paymentAction, 1)
  assert.equal(calls.requestPayment, 1)
  assert.equal(calls.paymentQuery, 1)
  assert.equal(calls.outcome, 0)
  assert.equal(calls.modal, 0)
  assert.equal(instance.data.registration.resolutionState, 'confirmed')
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

  assert.match(orderView, /<button class="table-strip__service" bindtap="openStatus"><text class="table-strip__service-value">\{\{serviceSummary\.label\}\}<\/text><text class="table-strip__service-link">查看进展 ›<\/text><\/button>/)
  assert.doesNotMatch(orderView, /自动更新/)
  assert.match(orderView, /呼叫服务员/)
  assert.match(orderView, /生日\/需求/)
  assert.match(orderView, /data-code="celebration" aria-label="生日或个性化需求"/)
  assert.match(orderView, /投诉\/不满意/)
  assert.match(orderView, /帮我选/)
  assert.match(orderView, /摇一摇/)
  assert.ok(orderView.indexOf('class="recommend-entry"') < orderView.lastIndexOf('<view class="menu-tools">'), 'first-screen recommendation value appears before the full menu controls')
  assert.match(orderView, /selectedCategory === 'recommendation'[^>]*class="recommend-entry"/)
  assert.match(orderView, /selectedCategory !== 'recommendation' \|\| searchText[^>]*class="section product-section"/)
  assert.match(orderView, /class="recommend-entry__actions"[^>]*aria-label="智能推荐"[\s\S]*?bindtap="onRecommend"[\s\S]*?bindtap="onShakeRecommendation"/)
  assert.ok(orderView.indexOf('class="quick-service"') < orderView.indexOf('class="recommend-entry__actions"'))
  assert.ok(orderView.indexOf('class="recommend-entry__actions"') < orderView.indexOf('class="menu-tools"'))
  assert.match(orderLogic, /showRecommendationSurface\(onReady\)[\s\S]*?selectedCategory === 'recommendation'[\s\S]*?onRecommend\(\) \{ return this\.showRecommendationSurface/)
  assert.doesNotMatch(orderView, /记录今晚偏好|recommend-preference/)
  assert.match(orderView, /按本桌情况与当晚菜单实时推荐/)
  assert.ok(orderView.indexOf('class="category-scroll"') < orderView.indexOf('class="search-box"'), 'editable categories appear before search like the approved reference layout')
  assert.match(orderLogic, /recommendationError: customerErrorMessage\(error, '今夜推荐正在更新'\)/)
  assert.match(orderView, /wx:if="\{\{recommendationError\}\}" class="recommendation-note"/)
  assert.match(orderView, /单点约 \{\{item\.separatePriceText\}\}/)
  assert.match(orderView, /\{\{item\.savingsText\}\}/)
  assert.match(orderView, /class="recommend-fit">更适合这一桌/)
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
  assert.match(orderStyle, /\.table-strip__service \{ min-height: 88rpx/)
  assert.match(orderStyle, /\.quick-service__surface \{ min-height: 62rpx/)
  assert.match(orderStyle, /\.recommend-entry__actions \{ display: grid; grid-template-columns: 1fr 1fr/)
  assert.match(orderStyle, /\.recommend-card \{ width: 520rpx; min-height: 390rpx/)
  assert.match(orderStyle, /\.product-list \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/)
  assert.match(orderStyle, /\.product-row \{[^}]*flex-direction: column/)
  assert.match(orderView, /class="checkout-guard"/)
  assert.doesNotMatch(orderView, /class="checkout-recovery"/)
  assert.match(orderView, /class="cart-overview" aria-label="本桌已选\{\{cartCount\}\}件商品"/)
  assert.doesNotMatch(orderView, /wx:if="\{\{cartExpanded\}\}"/)
  assert.match(orderStyle, /\.checkout-guard \{[^}]*position: fixed/)
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
  assert.match(communityView, /加入会员后即可查看活动详情并报名。/)
  assert.match(communityView, /wx:if="\{\{membershipInviteAgreed\}\}"[^>]*open-type="getPhoneNumber"[^>]*bindgetphonenumber="acceptMembershipInvite"/)
  assert.match(detailLogic, /const bootstrap = await getMiniBootstrap\(\)/)
  assert.match(detailLogic, /getActivityPreview\(this\.data\.id\)/)
  assert.match(detailLogic, /if \(!membership\)\s*\{[\s\S]*?previewOnly: true/)
  assert.match(detailLogic, /if \(!this\.data\.membership\)/)
  assert.match(detailLogic, /enrollMembership\(terms\.version, 'mini_community', authorization\.code\)/)
  assert.match(detailView, /加入会员，解锁超嗨活动/)
  assert.match(detailView, /加入会员后即可查看活动详情并报名。/)
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

test('customer menu categories come from the editable backend hierarchy and reveal a configured second level only when needed', async () => {
  const [orderLogic, orderView, guestMenuApi, catalogPanel] = await Promise.all([
    read('miniprogram/pages/order/index.js'),
    read('miniprogram/pages/order/index.wxml'),
    read('server/normalized/guest-commerce-service-api.ts'),
    read('src/normalized-ui/CatalogManagementPanel.tsx'),
  ])

  assert.match(orderLogic, /function menuCategoryIdentity\(item\)/)
  assert.match(orderLogic, /function customerCategoryName\(item\)/)
  assert.match(orderLogic, /categoryName: customerCategoryName\(item\)/)
  assert.match(orderLogic, /LEGACY_MENU_CATEGORY_HIERARCHY/)
  assert.match(orderLogic, /cocktail: \{ name: '鸡尾酒', parentCode: 'drinks', parentName: '酒水'/)
  assert.match(orderLogic, /legacyUnparentedCategory/)
  assert.match(orderLogic, /return legacyCategory \? legacyCategory\.name : '其他'/)
  assert.match(orderLogic, /const legacyUnconfigured = parentCode === '' && categoryName === '其他'/)
  assert.match(orderLogic, /categoryParentCode/)
  assert.match(orderLogic, /categoryParentName/)
  assert.match(orderLogic, /topCategorySortOrder/)
  assert.match(orderLogic, /function menuCategoryState\(products, selectedTopCategory, selectedSubcategory, includeRecommendations = false\)/)
  assert.match(orderLogic, /code: 'recommendation', name: '今夜推荐'/)
  assert.match(orderLogic, /includeRecommendations \? 'recommendation' : 'all'/)
  assert.match(orderLogic, /selectSubcategory\(event\)/)
  assert.match(orderLogic, /category\.topCode === this\.data\.selectedCategory/)
  assert.match(orderLogic, /category\.childCode === this\.data\.selectedSubcategory/)
  assert.doesNotMatch(orderLogic, /function menuCategories\(items\)/)
  assert.match(orderView, /wx:if="\{\{subcategories\.length\}\}"[\s\S]*?bindtap="selectSubcategory"/)
  assert.doesNotMatch(orderView, />cocktail</)

  assert.match(guestMenuApi, /LEFT JOIN mbox\.menu_categories AS menu_category/)
  assert.match(guestMenuApi, /LEFT JOIN mbox\.menu_categories AS parent_menu_category/)
  assert.match(guestMenuApi, /const categoryName = configuredCategoryName[\s\S]*?publicCatalogCategoryFallbackName/)
  assert.match(guestMenuApi, /function publicCatalogCategoryFallbackName\([\s\S]*?return '其他'/)
  assert.match(guestMenuApi, /categoryParentCode: unconfiguredCategory \? 'other' : row\.category_parent_code/)
  assert.match(guestMenuApi, /menu_category\.guest_visible/)

  assert.match(catalogPanel, /\/api\/catalog\/menu-categories/)
  assert.match(catalogPanel, /顾客菜单分类/)
  assert.match(catalogPanel, /一级入口和二级分类都在这里配置/)
  assert.match(catalogPanel, /<label>顾客菜单分类<select/)
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
  assert.match(logic, /const DAYS_PER_PAGE = 5/)
  assert.match(logic, /function calendarData\(selectedDate, windowStartDate\)/)
  assert.match(logic, /changeDayPage\(event\)/)
  assert.match(logic, /onCalendarTouchEnd\(event\)/)
  assert.match(view, /fields="month" value="\{\{monthValue\}\}" start="\{\{minimumMonth\}\}"/)
  assert.match(view, /class="day-pager" aria-label="未来五日演出日期"/)
  assert.match(view, /data-direction="-1" bindtap="changeDayPage"/)
  assert.match(view, /data-direction="1" bindtap="changeDayPage"/)
  assert.match(view, /bindtouchstart="onCalendarTouchStart" bindtouchend="onCalendarTouchEnd"/)
  assert.match(view, /hover-class="day-chip--pressed"/)
  assert.match(view, /class="day-chip__date"/)
  assert.match(style, /\.day-window\{display:flex;min-width:0;flex:1;gap:8rpx\}/)
  assert.match(style, /\.day-chip\{display:flex;min-width:0/)
  assert.match(style, /\.day-chip--pressed\{transform:scale\(\.96\)/)
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
  assert.match(profileLogic, /成长值持续累积/)
  assert.doesNotMatch(profileLogic, /成长进度暂不可显示/)
  assert.match(profileStyle, /\.profile-member-card__top button, \.profile-member-card__foot button \{[^}]*min-height: 88rpx/)
  assert.match(profileStyle, /\.profile-member-card__foot \{ min-height: 88rpx/)
  assert.match(orderLogic, /const connectionError = session\.tableToken[\s\S]*?customerErrorMessage\(error, '桌台连接已失效，请重新扫描桌面二维码'\) : ''/)
  assert.match(orderStyle, /\.quick-service \{[^}]*display: grid[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)[^}]*gap: 12rpx/)
  assert.match(orderStyle, /\.quick-service button \{[^}]*width: 100%[^}]*min-height: 88rpx[^}]*background: transparent/)
  assert.match(orderStyle, /\.quick-service__surface \{[^}]*width: 100%[^}]*min-height: 64rpx[^}]*border-radius: 32rpx[^}]*background: #eef6f1/)
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
  assert.doesNotMatch(profileView, /储值余额/)
  assert.doesNotMatch(profileLogic, /openBalance\(\)/)
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
  assert.doesNotMatch(profileView, /活动、权益与等级/)
  assert.doesNotMatch(profileView, /我的资料/)
  assert.doesNotMatch(profileView, /了解个人信息处理范围/)
  assert.doesNotMatch(profileView, /personal-entry-section/)
  assert.doesNotMatch(profileView, /bindtap="openPoints">我的积分/)
  assert.doesNotMatch(profileView, /bindtap="openCoupons">我的优惠券/)
  assert.doesNotMatch(profileView, /bindtap="openBalance">我的余额/)
  assert.doesNotMatch(profileView, /openNotificationSettings/)
  assert.match(miniApi, /getWechatMemberServiceNotificationAuthorizations/)
  assert.match(miniApi, /recordWechatMemberServiceNotificationAuthorization/)
  assert.match(contactLogic, /wx\.makePhoneCall/)
  assert.match(contactLogic, /17621392152/)
  assert.match(contactLogic, /openCustomerServiceChat/)
  assert.match(contactView, /企业微信/)
  assert.match(contactView, /拨打/)
  assert.match(supportService, /customer\.support\.contact/)
  assert.match(supportApi, /\/staff\/customer-experience\/support-contact/)
})

test('subscription messages are requested from customer actions, not a settings-page application flow', async () => {
  const [subscriptionSource, notificationLogic, notificationView, activityLogic, orderLogic, orderView, profileLogic] = await Promise.all([
    read('miniprogram/utils/wechat-subscription.js'),
    read('miniprogram/pages/profile-notifications/index.js'),
    read('miniprogram/pages/profile-notifications/index.wxml'),
    read('miniprogram/pages/community-detail/index.js'),
    read('miniprogram/pages/order/index.js'),
    read('miniprogram/pages/order/index.wxml'),
    read('miniprogram/pages/profile/index.js'),
  ])
  const recorded = []
  const presented = []
  const helperModule = { exports: {} }
  vm.runInNewContext(subscriptionSource, {
    module: helperModule,
    require: () => ({
      recordWechatNotificationAuthorization: async (input) => recorded.push({ kind: 'loyalty', ...input }),
      recordWechatMemberServiceNotificationAuthorization: async (input) => recorded.push({ kind: 'member_service', ...input }),
    }),
    wx: {
      requestSubscribeMessage: ({ tmplIds, success }) => {
        presented.push(tmplIds)
        success(Object.fromEntries(tmplIds.map((templateId) => [templateId, 'accept'])))
      },
    },
    // The immediate successful recordings win the race; no real timer is
    // needed in this isolated helper contract test.
    setTimeout: () => 0,
  })
  const options = ['activity_registration_confirmed', 'member_benefit_issued', 'loyalty_points_credited', 'membership_tier_changed']
    .map((notificationType, index) => ({
      apiKind: index === 2 ? 'loyalty' : 'member_service', notificationType,
      policyId: `policy-${index}`, policyVersion: 1, templateId: `template-${index}`,
      authorizationVersion: 0, usesRemaining: 0, platformResult: null,
    }))
  const result = await helperModule.exports.requestWechatSubscription(options, options.map((item) => item.notificationType))
  assert.equal(result.presented, true)
  assert.equal(presented[0].length, 3)
  assert.equal(recorded.length, 3)
  assert.match(subscriptionSource, /MAX_TEMPLATE_IDS_PER_REQUEST = 3/)
  assert.match(subscriptionSource, /AUTHORIZATION_RECORDING_WAIT_MS = 1500/)
  assert.doesNotMatch(notificationLogic, /enableOption|requestSubscribeMessage/)
  assert.doesNotMatch(notificationView, /可申请的提醒|开启提醒/)
  assert.match(activityLogic, /getWechatNotificationPrompt\('activity_registration'\)/)
  assert.match(activityLogic, /await this\.offerActivityRegistrationNotifications\(\)[\s\S]{0,700}?choosePayment\(pricing\)/)
  assert.doesNotMatch(activityLogic, /offerActivityPaymentNotifications/)
  assert.match(orderLogic, /getWechatNotificationPrompt\('order_checkout'\)/)
  assert.match(orderLogic, /getWechatNotificationPrompt\('order_selection'\)/)
  assert.match(orderLogic, /async addProduct\(event\)[\s\S]{0,900}?offerOrderNotifications\('order_selection', tableRequest\)/)
  const checkoutOpenStart = orderLogic.indexOf('async openCheckout()')
  const checkoutOpenEnd = orderLogic.indexOf('  closeCheckoutConfirm()', checkoutOpenStart)
  const checkoutConfirmStart = orderLogic.indexOf('async confirmCheckout()')
  const checkoutConfirmEnd = orderLogic.indexOf('  async retryCheckout(request)', checkoutConfirmStart)
  assert.ok(checkoutOpenStart >= 0 && checkoutOpenEnd > checkoutOpenStart)
  assert.ok(checkoutConfirmStart >= 0 && checkoutConfirmEnd > checkoutConfirmStart)
  const openCheckoutSource = orderLogic.slice(checkoutOpenStart, checkoutOpenEnd)
  const confirmCheckoutSource = orderLogic.slice(checkoutConfirmStart, checkoutConfirmEnd)
  assert.match(openCheckoutSource, /checkoutConfirmVisible:\s*true/)
  assert.doesNotMatch(openCheckoutSource, /checkoutSharedCart|submitOrder|prepareCheckoutUpgrade|offerOrderNotifications/)
  assert.match(confirmCheckoutSource, /await this\.offerOrderNotifications\('order_checkout', tableRequest\)[\s\S]{0,500}?await this\.submitOrder\(null, true, null, tableRequest\)/)
  assert.doesNotMatch(confirmCheckoutSource, /prepareCheckoutUpgrade|upgradeOffer/)
  assert.match(orderView, /已选 \{\{cartCount\}\} 件/)
  assert.match(orderView, /wx:if="\{\{checkoutConfirmVisible\}\}"[\s\S]*?确认并支付/)
  assert.match(orderView, /确认后调起微信支付/)
  assert.match(orderLogic, /applyWechatSubscriptionOutcomes\(\s*this\.data\.wechatNotificationPromptOptions, result\.outcomes,?\s*\)/)
  assert.match(orderLogic, /applyWechatSubscriptionOutcomes\(\s*this\.data\.wechatOrderSelectionPromptOptions, result\.outcomes,?\s*\)/)
  const paymentActionStart = orderLogic.indexOf('async handlePaymentAction')
  const paymentActionEnd = orderLogic.indexOf('async offerOrderNotifications')
  assert.doesNotMatch(orderLogic.slice(paymentActionStart, paymentActionEnd), /offerOrderNotifications/)
  assert.match(profileLogic, /getWechatNotificationPrompt\('coupon_open'\)/)
  assert.match(profileLogic, /async openCoupons\(\)[\s\S]{0,500}?requestWechatSubscription/)
})
