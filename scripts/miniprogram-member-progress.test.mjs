import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8')
const progress = { rollingGrowth: 0, upgradeThreshold: 2000, nextTier: 'silver', upgradeRemaining: 2000, evaluationWindowMonths: 12 }

async function harness(name, bootstrap = async () => ({}), platform = 'miniprogram', overrides = {}) {
  let page
  const source = await read(`${platform}/pages/${name}/index.js`)
  const platformHelper = { exports: {} }
  const helperSource = (await read(`${platform}/utils/member-card-progress.js`))
    .replace('export { memberCardProgress, progressNumber }', 'module.exports = { memberCardProgress, progressNumber }')
  vm.runInNewContext(helperSource, { module: platformHelper })
  const navigation = []
  const runtime = { getStorageSync: () => '', removeStorageSync: () => {},
    showModal: ({ success }) => success({ confirm: true }), showToast: () => {},
    navigateTo: target => navigation.push(target.url) }
  const api = new Proxy({
    getMiniBootstrap: bootstrap,
    getCustomerPreferenceFacts: async () => ({ facts: [], sources: [] }),
    getReservations: async () => ({ reservations: [] }),
    getRedemptionCatalog: async () => ({ items: [] }),
    ...overrides,
  }, { get: (o, k) => o[k] || (async () => []) })
  const fallback = new Proxy({
    getTableConnection: () => ({ status: 'none' }),
    readWechatPhoneAuthorization: () => ({code:'phone-authorized'}),
    obtainAlipayPhoneAuthorization: async () => ({code:'phone-authorized'}),
    customerErrorMessage: e => e.message,
    mergeWechatNotificationPromptOptions: () => [],
    mergeAlipayNotificationPromptOptions: () => [],
    requestWechatSubscription: async () => ({}),
    requestAlipaySubscription: async () => ({}),
    extractPromptPresentation: () => [],
    rememberPresentationOptions: () => {},
  }, { get: (o, k) => o[k] || (() => undefined) })
  const view = vm.runInNewContext(source + '\n;membershipView', {
    Page: definition => { page = definition }, wx: runtime,
    require: path => path.endsWith('/member-card-progress') ? platformHelper.exports
      : path.endsWith('/api') ? api : path.endsWith('/platform') ? runtime : fallback,
  })
  page.setData = patch => Object.assign(page.data, patch)
  return { view, page, navigation }
}

for (const platform of ['miniprogram', 'alipay-miniprogram']) {
for (const name of ['profile', 'member-center']) {
  test(`${platform}/${name}: zero growth displays the full track and authoritative target`, async () => {
    const { view } = await harness(name, undefined, platform)
    const result = view({ level: 'member', tierProgress: progress })
    assert.equal(result.cardProgressAvailable, true)
    assert.equal(result.cardProgressPercent, 0)
    assert.equal(result.cardGrowthText, '成长值 0 / 2,000')
    assert.equal(result.cardDifferenceText, '距银卡还差 2,000')
    assert.equal(result.cardProgressRetry, false)
    assert.equal(result.qualificationGrowth, 0)
  })

  test(`${platform}/${name}: missing and invalid growth never masquerade as zero or complete`, async () => {
    const { view } = await harness(name, undefined, platform)
    for (const tierProgress of [null, undefined, {}, ...[null, undefined, '', ' ', false, NaN, Infinity, 'bad'].map(rollingGrowth => ({ ...progress, rollingGrowth }))]) {
      const result = view({ level: 'member', tierProgress })
      assert.equal(result.cardProgressAvailable, false)
      assert.equal(result.cardProgressRetry, true)
      assert.equal(result.cardGrowthText, '成长进度暂未读取')
      assert.equal(result.qualificationGrowth, null)
    }
  })

  test(`${platform}/${name}: policy unavailable is explicit; a missing target cannot imply 100%`, async () => {
    const { view } = await harness(name, undefined, platform)
    const unavailable = view({ level: 'member', tierProgress: null, tierProgressStatus: 'rules_unavailable' })
    assert.equal(unavailable.cardDifferenceText, '升级规则待公布')
    assert.equal(unavailable.cardProgressAvailable, false)
    assert.equal(unavailable.cardNextTierText, '')
    for (const upgradeThreshold of [null, undefined, 0, -1, '', 'invalid']) {
      const result = view({ level: 'member', tierProgress: { ...progress, upgradeThreshold } })
      assert.equal(result.cardProgressAvailable, false)
      assert.equal(result.cardProgressPercent, 0)
      assert.equal(result.cardGrowthText, '成长值 0')
    }
  })

  test(`${platform}/${name}: ordinary, completed and highest tier progress remain accurate`, async () => {
    const { view } = await harness(name, undefined, platform)
    for (const [growth, expected] of [[680, 34], [2000, 100], [3000, 100], [-10, 0], ['0', 0]]) {
      assert.equal(view({ level: 'member', tierProgress: { ...progress, rollingGrowth: growth } }).cardProgressPercent, expected)
    }
    assert.match(view({ level: 'member', tierProgress: { ...progress, rollingGrowth: 2000 } }).cardDifferenceText, /成长值条件/)
    const gold = view({ level: 'gold', tierProgress: { ...progress, nextTier: null, upgradeThreshold: null } })
    assert.equal(gold.cardProgressPercent, 100)
    assert.equal(gold.cardDifferenceText, '金卡等级已达成')
    assert.equal(gold.cardNextTierText, '')
  })

  test(`${platform}/${name}: track is unconditional, zero fill is empty, and retry is connected`, async () => {
    const prefix = name === 'profile' ? 'profile-member-card' : 'member-card'
    const template = await read(`${platform}/pages/${name}/index.${platform === 'miniprogram' ? 'wxml' : 'axml'}`)
    const style = await read(`${platform}/pages/${name}/index.${platform === 'miniprogram' ? 'wxss' : 'acss'}`)
    const track = template.match(new RegExp(`<view[^>]*class="${prefix}__track"[^>]*>`))[0]
    assert.doesNotMatch(track, /(?:wx|a):if/)
    assert.match(template, /(?:wx|a):if="\{\{membership.cardProgressRetry\}\}"[^>]*(?:bindtap|onTap)="load"/)
    assert.doesNotMatch(style.match(new RegExp(`\\.${prefix}__track view \\{[^}]+\\}`))[0], /min-width: [1-9]/)
    assert.equal(typeof (await harness(name, undefined, platform)).page.load, 'function')
  })
}

}

test('member center retry recovers missing progress to real zero; network error stays explicit', async () => {
  let attempt = 0
  const { page } = await harness('member-center', async () => {
    attempt++
    if (attempt === 2) throw new Error('offline')
    return { membership: { level: 'member', tierProgress: attempt === 1 ? null : progress } }
  })
  await page.load()
  assert.equal(page.data.membership.cardProgressRetry, true)
  await page.load()
  assert.ok(page.data.error)
  await page.load()
  assert.equal(page.data.error, '')
  assert.equal(page.data.membership.cardProgressAvailable, true)
  assert.equal(page.data.membership.cardProgressPercent, 0)
  assert.equal(page.data.membership.cardProgressRetry, false)
})

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const response = growth => ({ membership: { level: 'member', tierProgress: { ...progress, rollingGrowth: growth } } })
for (const platform of ['miniprogram', 'alipay-miniprogram']) {
  for (const name of ['profile', 'member-center']) {
    for (const outcome of ['success', 'failure']) {
      test(`${platform}/${name}: stale ${outcome} cannot replace a newer successful load`, async () => {
        const old = deferred(), current = deferred()
        let count = 0
        const { page } = await harness(name, () => count++ ? current.promise : old.promise, platform)
        const first = page.load(), second = page.load()
        current.resolve(response(680)); await second
        if (outcome === 'success') old.resolve(response(0))
        else old.reject(new Error('stale failure'))
        await first
        assert.equal(page.data.membership.cardGrowthText, '成长值 680 / 2,000')
        assert.equal(page.data.error, '')
      })
    }
    for (const action of ['onHide', 'onUnload', 'invalidateMemberLoad']) {
      test(`${platform}/${name}: ${action} invalidates an in-flight read`, async () => {
        const pending = deferred()
        const { page } = await harness(name, () => pending.promise, platform)
        const first = page.load()
        page[action]()
        pending.resolve(response(0)); await first
        assert.equal(page.data.membership, null)
        page._pageHidden = false
        await page.load()
        assert.equal(page.data.membership.cardGrowthText, '成长值 0 / 2,000')
      })
    }
    test(`${platform}/${name}: coupon label opens the actual coupon wallet`, async () => {
      const { page, view, navigation } = await harness(name, undefined, platform)
      page.data.membership = view(response(0).membership)
      assert.equal(page.data.membership.cardBenefitText, '查看我的优惠券 ›')
      await page.openCoupons()
      assert.equal(navigation.at(-1), '/pages/profile-coupons/index')
      const template = await read(`${platform}/pages/${name}/index.${platform === 'miniprogram' ? 'wxml' : 'axml'}`)
      assert.match(template, /<button[^>]*(?:bindtap|onTap)="openCoupons"[^>]*>\{\{membership.cardBenefitText\}\}<\/button>/)
    })
  }
  test(`${platform}/profile: stale secondary failures cannot overwrite current rights`, async () => {
    const old = deferred()
    let count = 0
    const { page } = await harness('profile', async () => response(680), platform, {
      getCustomerBenefits: () => count++ ? Promise.resolve([]) : old.promise,
    })
    const first = page.load()
    await page.load()
    old.reject(new Error('old rights failed')); await first
    assert.equal(page.data.benefitError, '')
    assert.equal(page.data.membership.cardGrowthText, '成长值 680 / 2,000')
  })
}

for (const platform of ['miniprogram', 'alipay-miniprogram']) {
  test(`${platform}/profile: logout cannot be undone by an old member response`, async () => {
    const old = deferred()
    let count = 0
    const {page, view} = await harness('profile', () => count++ ? Promise.resolve({membership:null}) : old.promise, platform)
    page.data.membership = view(response(680).membership)
    const first = page.load()
    await page.logoutMember()
    assert.equal(page.data.membership, null)
    old.resolve(response(680)); await first
    assert.equal(page.data.membership, null)
  })
  test(`${platform}/profile: old anonymous load cannot erase successful enrollment`, async () => {
    const old = deferred()
    let count = 0
    const {page} = await harness('profile', () => count++ ? Promise.resolve(response(680)) : old.promise, platform, {
      enrollMembership: async () => response(680),
    })
    page.data.membershipTerms = {version:1}
    page.data.agreedToPolicies = true
    const first = page.load()
    await page.quickLoginAndEnroll({})
    assert.equal(page.data.membership.cardGrowthText, '成长值 680 / 2,000')
    old.resolve({membership:null}); await first
    assert.equal(page.data.membership.cardGrowthText, '成长值 680 / 2,000')
  })
}
test('profile: delayed terms fallback after a failed read cannot clear a newer membership', async () => {
  const terms = deferred(), started = deferred()
  let count = 0
  const {page} = await harness('profile', async () => {
    if (!count++) throw new Error('old bootstrap failed')
    return response(680)
  }, 'miniprogram', {getMembershipTerms: () => {started.resolve();return terms.promise}})
  const first = page.load()
  await started.promise
  await page.load()
  terms.resolve({version:1}); await first
  assert.equal(page.data.membership.cardGrowthText, '成长值 680 / 2,000')
  assert.equal(page.data.error, '')
})
