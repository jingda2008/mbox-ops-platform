import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const detailPath = new URL('../miniprogram/pages/community-detail/index.js', import.meta.url)

function anonymousPreview() {
  return {
    publicId: 'ACT-SHARE-001', kind: 'music_picnic', title: '夏夜音乐会', summary: '公开活动预览',
    coverUrl: '/api/public/media-assets/activity-share.jpg', startsAt: '2026-09-01T12:00:00.000Z', endsAt: '2026-09-01T15:00:00.000Z',
    assemblyLocation: 'M-BOX', feeAmountMinor: 0, depositAmountMinor: 0, feeBasis: 'per_booking', paymentMode: 'none',
    paymentRuleText: '加入会员后确认', currency: 'CNY', availability: 'available', availabilityText: '可报名',
    marketingCopy: {
      details: '欢迎参加', includedItems: ['入场手环'], participationRequirements: ['年满十八岁'],
      memberBenefitText: '会员到场后获得积分',
    },
    safetyRequirements: ['遵守现场指引'], packageSelectionRequired: false,
    registrationRequiresMembership: true,
    packages: [{
      publicId: 'PKG-SHARE-001', name: '双人套餐', description: '两杯特调', imageUrl: null, includedItems: ['两杯特调'],
      feeAmountMinor: 12800, depositAmountMinor: 0, feeBasis: 'per_booking', paymentMode: 'full_required',
      paymentRuleText: '入会后付款', currency: 'CNY', availability: 'available', availabilityText: '可报名',
    }],
  }
}

function memberDetail() {
  const preview = anonymousPreview()
  return Object.assign({}, preview, {
    capacity: 20, remainingCapacity: 4, paymentDeadlineMinutes: 15, paymentAvailability: 'available',
    availablePaymentChoices: ['none'], availablePaymentMethods: ['jsapi'], refundPolicy: { policyVersion: 'refund-v1', summary: '退款规则' },
    safety: { policyVersion: 'safety-v1', requirements: ['遵守现场指引'] }, registrationRequiresMembership: undefined,
    packages: preview.packages.map((item) => Object.assign({}, item, {
      remainingCapacity: 2, memberPurchaseLimit: 2, paymentDeadlineMinutes: 15, paymentAvailability: 'available',
      availablePaymentChoices: ['full'], availablePaymentMethods: ['jsapi'], redemptionPolicyVersion: null, refundPolicyVersion: 'refund-v1',
    })),
  })
}

async function loadDetailPage(state) {
  const source = await readFile(detailPath, 'utf8')
  const storage = new Map()
  let definition = null
  const api = {
    getMiniBootstrap: async () => {
      state.bootstrapCalls.push('bootstrap')
      return { membership: state.membership, membershipTerms: { title: '会员协议', version: 'v1' } }
    },
    getActivityPreview: async (publicId) => { state.previewCalls.push(publicId); return anonymousPreview() },
    getActivity: async (publicId) => { state.detailCalls.push(publicId); return memberDetail() },
    getActivityLoyaltyBenefits: async () => [], getActivityRegistrations: async () => [],
    getWechatNotificationPrompt: async () => ({ available: false, authorizations: [] }),
    registerActivity: async () => { throw new Error('not used') }, getActivityRegistrationPayment: async () => null,
    startActivityRegistrationPayment: async () => null, queryActivityRegistrationPayment: async () => null,
    cancelActivityRegistration: async () => null,
    enrollMembership: async () => {
      state.membership = { publicId: 'MEM-001', level: 'member' }
      return { membership: state.membership }
    },
  }
  const context = {
    module: { exports: {} }, exports: {},
    require(specifier) {
      if (specifier === '../../utils/api') return api
      if (specifier === '../../utils/id') return { randomId: (prefix) => `${prefix}-contract` }
      if (specifier === '../../utils/format') return { money: (value) => `¥${Number(value || 0) / 100}`, dateTime: (value) => String(value || '') }
      if (specifier === '../../utils/media') return { publicImageUrl: (value) => value || '' }
      if (specifier === '../../utils/wechat-phone') return { readWechatPhoneAuthorization: () => ({ code: 'wechat-phone-authorization-code' }) }
      if (specifier === '../../utils/auth') return {
        ensureCustomerSession: async (force) => { (state.identityRefreshCalls || (state.identityRefreshCalls = [])).push(force) },
      }
      if (specifier === '../../utils/customer-error') return { customerErrorMessage: (error, fallback) => error?.message || fallback, isWechatCancellation: () => false }
      if (specifier === '../../utils/wechat-subscription') return {
        requestWechatSubscription: async () => ({ presented: false, outcomes: [] }),
        mergeWechatNotificationPromptOptions: (...groups) => [].concat(...groups.filter(Boolean)),
        extractPromptPresentation: (prompt) => (prompt && prompt.presentation) || [],
        buildActivitySubscriptionPresentation: (...groups) => [].concat(...groups.filter(Boolean)),
        ACTIVITY_REGISTRATION_SUBSCRIBE_TYPES: [],
      }
      if (specifier === '../../utils/wechat-subscription-presentation-cache') return {
        rememberPresentationOptions: () => [],
      }
      if (specifier === '../../utils/public-share') return {
        enablePublicShareMenu: () => undefined,
      }
      throw new Error(`unexpected require: ${specifier}`)
    },
    Page: (page) => { definition = page },
    wx: {
      getStorageSync: (key) => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: (key) => storage.delete(key),
      showToast: () => undefined, navigateBack: () => undefined, switchTab: () => undefined, pageScrollTo: () => undefined,
    },
    setTimeout, clearTimeout,
  }
  vm.runInNewContext(source, context, { filename: 'miniprogram/pages/community-detail/index.js' })
  const page = Object.assign({}, definition, { data: JSON.parse(JSON.stringify(definition.data)) })
  page.setData = (patch) => Object.assign(page.data, patch)
  return page
}

async function loadMiniProgramApp() {
  const source = await readFile(new URL('../miniprogram/app.js', import.meta.url), 'utf8')
  const issuedRequests = []
  let definition = null
  const context = {
    module: { exports: {} }, exports: {},
    require(specifier) {
      if (specifier === './config/index') return { getRuntimeConfig: () => ({ isDevelopment: false }) }
      if (specifier === './utils/session') return { applyLaunchSession: () => ({}) }
      if (specifier === './utils/auth') return {
        ensureCustomerSession: async () => { issuedRequests.push('/api/public/reservation/session') },
      }
      if (specifier === './utils/customer-error') return { customerErrorMessage: () => '初始化失败' }
      throw new Error(`unexpected require: ${specifier}`)
    },
    App: (app) => { definition = app },
  }
  vm.runInNewContext(source, context, { filename: 'miniprogram/app.js' })
  return { app: Object.assign({}, definition, { globalData: JSON.parse(JSON.stringify(definition.globalData)) }), issuedRequests }
}

test('an anonymous activity preview uses the narrow preview endpoint and keeps a local package choice through membership refresh', async () => {
  const state = { membership: null, previewCalls: [], detailCalls: [], bootstrapCalls: [] }
  const page = await loadDetailPage(state)
  page.onLoad({ id: 'ACT-SHARE-001', source: 'share', phone: '13800000000', memberId: 'MEM-LEAK' })
  await page.load()

  assert.deepEqual(state.previewCalls, ['ACT-SHARE-001'])
  assert.deepEqual(state.detailCalls, [])
  assert.deepEqual(state.bootstrapCalls, [])
  assert.equal(page.data.previewOnly, true)
  assert.equal(page.data.membershipInviteVisible, false)
  assert.equal(page.data.partySize, 1)
  assert.equal(page.data.activity.details, '欢迎参加')
  assert.deepEqual(page.data.activity.includedItems, ['入场手环'])
  assert.deepEqual(page.data.activity.participationRequirements, ['年满十八岁'])
  assert.equal(page.data.activity.memberBenefitText, '会员到场后获得积分')
  page.choosePackage({ currentTarget: { dataset: { packageId: 'PKG-SHARE-001' } } })
  assert.equal(page.data.selectedPackagePublicId, 'PKG-SHARE-001')

  await page.openMembershipInvite()
  assert.deepEqual(state.bootstrapCalls, ['bootstrap'])
  assert.equal(page.data.membershipInviteVisible, true)
  page.setData({ membershipInviteAgreed: true, membershipInviteVisible: true })
  await page.acceptMembershipInvite({})
  assert.deepEqual(state.detailCalls, ['ACT-SHARE-001'])
  assert.equal(page.data.previewOnly, false)
  assert.equal(page.data.selectedPackagePublicId, 'PKG-SHARE-001')
  assert.equal(page.data.partySize, 1)
})

test('WeChat friend and timeline shares contain only the public activity identifier and share source', async () => {
  const state = { membership: null, previewCalls: [], detailCalls: [], bootstrapCalls: [] }
  const page = await loadDetailPage(state)
  page.onLoad({ id: 'ACT-SHARE-001', source: 'share' })
  await page.load()
  const friend = page.onShareAppMessage()
  const timeline = page.onShareTimeline()

  assert.equal(friend.path, '/pages/community-detail/index?id=ACT-SHARE-001&source=share')
  assert.equal(timeline.query, 'id=ACT-SHARE-001&source=share')
  for (const payload of [friend.path, timeline.query]) {
    assert.doesNotMatch(payload, /(package|party|phone|contact|member|openid)/i)
  }
})

test('activity payment identity recovery forces a new identity and resumes the preserved next action', async () => {
  const state = { membership: null, previewCalls: [], detailCalls: [], bootstrapCalls: [], identityRefreshCalls: [] }
  const page = await loadDetailPage(state)
  page.data.registration = { publicId: 'REG-001', canStartPayment: true }
  page.data.wechatIdentityRefreshRequired = true
  let resumedPayment = 0
  page.startPayment = async () => { resumedPayment += 1 }
  await page.refreshWechatIdentityAndRetry()
  assert.deepEqual(state.identityRefreshCalls, [true])
  assert.equal(resumedPayment, 1)
  assert.equal(page.data.wechatIdentityRefreshRequired, false)

  page.data.registration = null
  page.data.wechatIdentityRefreshRequired = true
  let resumedRegistration = 0
  page.register = async () => { resumedRegistration += 1 }
  await page.refreshWechatIdentityAndRetry()
  assert.deepEqual(state.identityRefreshCalls, [true, true])
  assert.equal(resumedRegistration, 1)
})

test('a share launch reaches the preview without creating a reservation session until the recipient requests member access', async () => {
  const shared = await loadMiniProgramApp()
  shared.app.onLaunch({ path: 'pages/community-detail/index', query: { id: 'ACT-SHARE-001', source: 'share' } })
  await Promise.resolve()
  assert.deepEqual(shared.issuedRequests, [])

  const normal = await loadMiniProgramApp()
  normal.app.onLaunch({ path: 'pages/community-detail/index', query: { id: 'ACT-SHARE-001' } })
  await Promise.resolve()
  assert.deepEqual(normal.issuedRequests, ['/api/public/reservation/session'])
})

test('malformed and missing activity-share links do not create a reservation session before the preview returns its neutral not-found result', async () => {
  const malformed = await loadMiniProgramApp()
  malformed.app.onLaunch({ path: 'pages/community-detail/index', query: { id: '%', source: 'share' } })
  await Promise.resolve()
  assert.deepEqual(malformed.issuedRequests, [])

  const missing = await loadMiniProgramApp()
  missing.app.onLaunch({ path: 'pages/community-detail/index', query: { source: 'share' } })
  await Promise.resolve()
  assert.deepEqual(missing.issuedRequests, [])
})

test('the activity detail exposes the standard friend share control and the public-preview membership handoff', async () => {
  const [logic, view, style, api, pageConfig] = await Promise.all([
    readFile(detailPath, 'utf8'),
    readFile(new URL('../miniprogram/pages/community-detail/index.wxml', import.meta.url), 'utf8'),
    readFile(new URL('../miniprogram/pages/community-detail/index.wxss', import.meta.url), 'utf8'),
    readFile(new URL('../miniprogram/utils/api.js', import.meta.url), 'utf8'),
    readFile(new URL('../miniprogram/pages/community-detail/index.json', import.meta.url), 'utf8'),
  ])
  assert.match(api, /function getActivityPreview\(activityPublicId\)[\s\S]*?request\(`\/api\/public\/mini\/activity-previews\/[\s\S]*?credentialDomain:\s*'none'/)
  assert.match(logic, /onShareAppMessage\(\)/)
  assert.match(logic, /onShareTimeline\(\)/)
  assert.match(logic, /getActivityPreview\(this\.data\.id\)/)
  assert.match(logic, /isSharePreview[\s\S]*?raw\.marketingCopy/)
  assert.match(logic, /if \(this\.data\.previewOnly\) return/)
  assert.match(logic, /shareSource === 'share' && !this\.data\.memberAccessRequested/)
  assert.match(logic, /await this\.load\(\)/)
  assert.match(logic, /await ensureCustomerSession\(true\)/)
  assert.match(logic, /refreshWechatIdentityAndRetry\(\)/)
  assert.match(view, /open-type="share"/)
  assert.match(view, /wx:if="\{\{previewOnly\}\}"/)
  assert.match(view, /bindtap="openMembershipInvite"/)
  assert.match(view, /bindtap="refreshWechatIdentityAndRetry"/)
  assert.match(view, /刷新身份后付款/)
  assert.match(view, />继续付款<\/button>/)
  assert.match(style, /\.detail-share\s*\{[^}]*min-height:\s*88rpx/)
  const config = JSON.parse(pageConfig)
  assert.equal(Object.hasOwn(config, 'enableShareAppMessage'), false)
  assert.equal(Object.hasOwn(config, 'enableShareTimeline'), false)
})
