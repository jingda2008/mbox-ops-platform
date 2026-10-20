import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
const { fixture, deferred, cart } = createRequire(import.meta.url)('./miniprogram-state-fixture.cjs')
const terms = { version: 1, summary: '消费积分说明' }
const bootstrap = { membership: null, membershipTerms: terms }
const event = { currentTarget: { dataset: { id: 'p1' } } }
const phone = { detail: { code: 'wechat-phone-test-code' } }
const verifiedPhone = { publicId: 'CVC' + '1'.repeat(32), status: 'active' }
const key = 'mbox.membership.invite.dismissed.until.v1'
function setup(overrides = {}) {
  return fixture('order', { getMiniBootstrap: async () => bootstrap, getVerifiedPhones: async () => [], adjustSharedCart: async () => cart(2), ...overrides })
}
async function read(h) { await h.page.loadOrderExtra('membership', h.page.currentTableRequest()); return h }
async function ready(overrides = {}) { return read(setup(overrides)) }

test('entering menu invites confirmed nonmember before any dish selection or phone submission', async () => {
  let enrollments = 0
  const h = setup({ replaceVerifiedPhone: async () => { enrollments++ } })
  h.page.updateCart([], { ...cart(1), lines: [] })
  await read(h)
  assert.equal(h.page.data.cartCount, 0)
  assert.equal(h.page.data.membershipInviteVisible, true)
  assert.equal(h.page.data.menuPhoneStatus, 'missing')
  assert.equal(enrollments, 0)
  const before = Date.now()
  h.page.dismissMembershipInvite()
  assert.ok(h.state.storage.get(key) >= before + 24 * 3600000)
  await h.page.addProduct(event)
  assert.equal(h.page.data.membershipInviteVisible, false)
  assert.equal(h.page.data.cartCount, 1)
})

for (const [name, response] of [['member', { ...bootstrap, membership: { memberNo: 'M1' } }], ['missing identity', { membershipTerms: terms }], ['empty response', null]]) {
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

test('denied phone and closed entry never submit phone or membership', async () => {
  let calls = 0
  const h = await ready({ replaceVerifiedPhone: async () => { calls++ } })
  await h.page.authorizeMenuPhone({ detail: { errMsg: 'getPhoneNumber:fail user deny' } })
  assert.equal(calls, 0)
  assert.match(h.page.data.membershipInviteError, /未授权/)
  h.page.dismissMembershipInvite()
  await h.page.authorizeMenuPhone(phone)
  assert.equal(calls, 0)
  assert.equal(await h.page.addProduct(event), true)
})

test('native phone authorization submits once without terms or enrollment and preserves cart', async () => {
  const pending = deferred(), calls = []
  const h = await ready({ replaceVerifiedPhone: async (...args) => { calls.push(args); return pending.promise } })
  const enrolling = h.page.authorizeMenuPhone(phone)
  await h.page.authorizeMenuPhone(phone)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], [phone.detail.code])
  h.api.enrollMembership = async () => { throw Error('must not enroll') }
  pending.resolve(verifiedPhone)
  await enrolling
  assert.equal(h.page.data.membershipStatus, 'nonmember')
  assert.equal(h.page.data.menuPhoneStatus, 'verified')
  assert.equal(h.page.data.membershipInviteVisible, false)
  assert.equal(h.page.data.membershipBusy, false)
  assert.equal(h.page.data.cartCount, 1)
})

test('failed phone verification stays retryable and customer can continue ordering', async () => {
  const h = await ready({ replaceVerifiedPhone: async () => { throw Error('offline') } })
  await h.page.authorizeMenuPhone(phone)
  assert.equal(h.page.data.membershipStatus, 'nonmember')
  assert.equal(h.page.data.membershipBusy, false)
  assert.ok(h.page.data.membershipInviteError)
  h.page.dismissMembershipInvite()
  assert.equal(await h.page.addProduct(event), true)
})

test('returning from privacy preserves the phone entry and cart', async () => {
  for (const action of ['openInvitePrivacy']) {
    const h = await ready(), routes = []
    h.wx.navigateTo = options => routes.push(options.url)
    h.page[action]()
    assert.equal(routes.length, 1)
    h.page.onHide()
    await h.page.preparePage()
    await read(h)
    assert.equal(h.page.data.membershipInviteVisible, true)
    assert.equal(h.page.data.menuPhoneStatus, 'missing')
    assert.equal(h.page.data.cartCount, 1)
  }
})

test('hidden-page and stale phone verification responses do not alter a new table', async () => {
  const response = deferred()
  const h = await ready({ replaceVerifiedPhone: () => response.promise })
  const pending = h.page.authorizeMenuPhone(phone)
  h.page.onHide()
  h.state.session = { tableCode: 'W21', tableToken: 'other', cartScope: 'other' }
  h.page.beginTableRequest()
  response.resolve(verifiedPhone)
  await pending
  assert.equal(h.page.data.membershipStatus, 'unknown')
  assert.equal(h.page.data.membershipInviteVisible, false)
})

test('browse menu also loads entry invitation, without requiring a table or cart', async () => {
  const h = setup()
  await h.page.loadBrowseData('', undefined, h.page.currentTableRequest())
  await Promise.resolve(); await Promise.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.page.data.browseOnly, true)
  assert.equal(h.page.data.membershipInviteVisible, true)
})

 test('phone authorization does not require published membership terms', async () => {
   const h = await ready({ getMiniBootstrap: async () => ({ membership: null, membershipTerms: null }) })
   assert.equal(h.page.data.membershipInviteVisible, true)
 })
 test('verified phone and unknown phone state suppress the optional entry', async () => {
   for (const getVerifiedPhones of [async () => [verifiedPhone], async () => { throw Error('offline') }]) {
     const h = await ready({ getVerifiedPhones })
     assert.equal(h.page.data.membershipInviteVisible, false)
     assert.equal(await h.page.addProduct(event), true)
   }
 })
 test('incomplete verification response never claims success', async () => {
   const h = await ready({ replaceVerifiedPhone: async () => ({}) })
   await h.page.authorizeMenuPhone(phone)
   assert.equal(h.page.data.menuPhoneStatus, 'missing')
   assert.equal(h.page.data.membershipInviteVisible, true)
   assert.ok(h.page.data.membershipInviteError)
 })
