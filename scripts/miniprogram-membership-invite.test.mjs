import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
const { fixture, deferred, cart } = createRequire(import.meta.url)('./miniprogram-state-fixture.cjs')
const terms = { version: 1, summary: '消费积分说明' }
const bootstrap = { membership: null, membershipTerms: terms }
const event = { currentTarget: { dataset: { id: 'p1' } } }
const phone = { detail: { code: 'wechat-phone-test-code' } }
const agree = { detail: { value: ['agree'] } }
const key = 'mbox.membership.invite.dismissed.until.v1'
function setup(overrides = {}) {
  return fixture('order', { getMiniBootstrap: async () => bootstrap, adjustSharedCart: async () => cart(2), ...overrides })
}
async function read(h) { await h.page.loadOrderExtra('membership', h.page.currentTableRequest()); return h }
async function ready(overrides = {}) { return read(setup(overrides)) }

test('entering menu invites confirmed nonmember before any dish selection or phone submission', async () => {
  let enrollments = 0
  const h = setup({ enrollMembership: async () => { enrollments++ } })
  h.page.updateCart([], { ...cart(1), lines: [] })
  await read(h)
  assert.equal(h.page.data.cartCount, 0)
  assert.equal(h.page.data.membershipInviteVisible, true)
  assert.equal(h.page.data.membershipInviteAgreed, false)
  assert.equal(enrollments, 0)
  const before = Date.now()
  h.page.dismissMembershipInvite()
  assert.ok(h.state.storage.get(key) >= before + 24 * 3600000)
  await h.page.addProduct(event)
  assert.equal(h.page.data.membershipInviteVisible, false)
  assert.equal(h.page.data.cartCount, 1)
})

for (const [name, response] of [['member', { ...bootstrap, membership: { memberNo: 'M1' } }], ['missing identity', { membershipTerms: terms }], ['empty response', null], ['unpublished terms', { membership: null, membershipTerms: null }]]) {
  test(`${name} never receives an enrollment invitation`, async () => {
    const h = await ready({ getMiniBootstrap: async () => response })
    await h.page.addProduct(event)
    assert.equal(h.page.data.membershipInviteVisible, false)
  })
}

test('identity failure does not become nonmember and does not block cart writes', async () => {
  const h = await ready({ getMiniBootstrap: async () => { throw Error('offline') } })
  assert.equal(await h.page.addProduct(event), true)
  assert.equal(h.page.data.membershipStatus, 'unknown')
  assert.equal(h.page.data.membershipInviteVisible, false)
})

test('dismissal survives page recreation; expired dismissal permits entry invitation', async () => {
  const h = setup()
  h.state.storage.set(key, Date.now() + 3600000)
  await read(h)
  assert.equal(h.page.data.membershipInviteVisible, false)
  h.state.storage.set(key, Date.now() - 1)
  await read(h)
  assert.equal(h.page.data.membershipInviteVisible, true)
})

test('late membership read does not delay menu or cart writes', async () => {
  const response = deferred()
  const h = setup({ getMiniBootstrap: () => response.promise })
  const reading = read(h)
  await h.page.addProduct(event)
  assert.equal(h.page.data.cartCount, 1)
  assert.equal(h.page.data.membershipInviteVisible, false)
  response.resolve(bootstrap)
  await reading
  assert.equal(h.page.data.membershipInviteVisible, true)
})

test('old-table membership response cannot invite on a new table', async () => {
  const response = deferred()
  const h = setup({ getMiniBootstrap: () => response.promise })
  const reading = read(h)
  h.state.session = { tableCode: 'W21', tableToken: 'other', cartScope: 'other' }
  h.page.beginTableRequest()
  response.resolve(bootstrap)
  await reading
  assert.equal(h.page.data.membershipInviteVisible, false)
  assert.equal(h.page.data.membershipStatus, 'unknown')
})

test('product detail and native notification prompt finish before entry invitation', async () => {
  const h = setup()
  const notification = deferred()
  h.page.offerOrderNotifications = () => notification.promise
  h.page.setData({ detailProduct: { productId: 'p1' } })
  await h.page.addProduct(event)
  await read(h)
  assert.equal(h.page.data.membershipInviteVisible, false)
  notification.resolve()
  await Promise.resolve(); await Promise.resolve()
  assert.equal(h.page.data.membershipInviteVisible, false)
  h.page.closeProductDetail()
  assert.equal(h.page.data.membershipInviteVisible, true)
})

test('checkout is never covered by a late invitation', async () => {
  const h = setup()
  h.page.setData({ checkoutConfirmVisible: true })
  await read(h)
  assert.equal(h.page.data.membershipInviteVisible, false)
})

test('no agreement, denied phone and closed invitation never submit enrollment', async () => {
  let calls = 0
  const h = await ready({ enrollMembership: async () => { calls++ } })
  await h.page.enrollFromMenu(phone)
  assert.equal(calls, 0)
  h.page.onMembershipInviteAgreementChange(agree)
  await h.page.enrollFromMenu({ detail: { errMsg: 'getPhoneNumber:fail user deny' } })
  assert.equal(calls, 0)
  assert.match(h.page.data.membershipInviteError, /未授权/)
  h.page.dismissMembershipInvite()
  await h.page.enrollFromMenu(phone)
  assert.equal(calls, 0)
  assert.equal(await h.page.addProduct(event), true)
})

test('phone authorization submits once with current terms; enrollment preserves cart and refreshes identity', async () => {
  const pending = deferred(), calls = []
  const h = await ready({ enrollMembership: async (...args) => { calls.push(args); return pending.promise } })
  h.page.onMembershipInviteAgreementChange(agree)
  const enrolling = h.page.enrollFromMenu(phone)
  await h.page.enrollFromMenu(phone)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], [1, 'mini_menu', phone.detail.code])
  h.api.getMiniBootstrap = async () => ({ ...bootstrap, membership: { memberNo: 'new-member' } })
  pending.resolve({ membership: { memberNo: 'new-member' } })
  await enrolling
  assert.equal(h.page.data.membershipStatus, 'member')
  assert.equal(h.page.data.membershipInviteVisible, false)
  assert.equal(h.page.data.membershipBusy, false)
  assert.equal(h.page.data.cartCount, 1)
})

test('failed enrollment stays retryable and customer can continue ordering', async () => {
  const h = await ready({ enrollMembership: async () => { throw Error('offline') } })
  h.page.onMembershipInviteAgreementChange(agree)
  await h.page.enrollFromMenu(phone)
  assert.equal(h.page.data.membershipStatus, 'nonmember')
  assert.equal(h.page.data.membershipBusy, false)
  assert.ok(h.page.data.membershipInviteError)
  h.page.dismissMembershipInvite()
  assert.equal(await h.page.addProduct(event), true)
})

test('returning from reading agreements reopens invitation without preselecting consent', async () => {
  for (const action of ['showMembershipTerms', 'openInvitePrivacy']) {
    const h = await ready(), routes = []
    h.wx.navigateTo = options => routes.push(options.url)
    h.page.onMembershipInviteAgreementChange(agree)
    h.page[action]()
    assert.equal(routes.length, 1)
    h.page.onHide()
    await h.page.preparePage()
    await read(h)
    assert.equal(h.page.data.membershipInviteVisible, true)
    assert.equal(h.page.data.membershipInviteAgreed, false)
    assert.equal(h.page.data.cartCount, 1)
  }
})

test('hidden-page and stale enrollment responses do not alter a new table', async () => {
  const response = deferred()
  const h = await ready({ enrollMembership: () => response.promise })
  h.page.onMembershipInviteAgreementChange(agree)
  const pending = h.page.enrollFromMenu(phone)
  h.page.onHide()
  h.state.session = { tableCode: 'W21', tableToken: 'other', cartScope: 'other' }
  h.page.beginTableRequest()
  response.resolve({ membership: { memberNo: 'old-response' } })
  await pending
  assert.equal(h.page.data.membershipStatus, 'unknown')
  assert.equal(h.page.data.membershipInviteVisible, false)
})

test('browse menu also loads entry invitation, without requiring a table or cart', async () => {
  const h = setup()
  await h.page.loadBrowseData('', undefined, h.page.currentTableRequest())
  await Promise.resolve(); await Promise.resolve()
  assert.equal(h.page.data.browseOnly, true)
  assert.equal(h.page.data.membershipInviteVisible, true)
})
