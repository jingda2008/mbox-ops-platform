import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
const { fixture, deferred, cart } = createRequire(import.meta.url)('./miniprogram-state-fixture.cjs')
const terms = { version: 'v1', summary: '消费积分说明' }
const bootstrap = { membership: null, membershipTerms: terms }
const event = { currentTarget: { dataset: { id: 'p1' } } }
const key = 'mbox.membership.invite.dismissed.until.v1'
async function ready(overrides = {}) {
  const h = fixture('order', { getMiniBootstrap: async () => bootstrap, adjustSharedCart: async () => cart(2), ...overrides })
  await h.page.loadOrderExtra('membership', h.page.currentTableRequest())
  return h
}

test('successful add invites a confirmed nonmember only once, preserves cart and persists dismissal', async () => {
  const h = await ready()
  assert.equal(h.page.data.membershipInviteVisible, false)
  assert.equal(await h.page.addProduct(event), true)
  assert.equal(h.page.data.membershipInviteVisible, true)
  assert.equal(h.page.data.cartCount, 1)
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

test('failed add and cart refresh do not invite', async () => {
  const h = await ready({ adjustSharedCart: async () => { throw Error('offline') } })
  assert.equal(await h.page.addProduct(event), false)
  h.page.updateCart(cart(3).lines, cart(3))
  assert.equal(h.page.data.membershipInviteVisible, false)
})

test('dismissal survives page recreation; expired dismissal permits a new invitation', async () => {
  const h = await ready()
  h.state.storage.set(key, Date.now() + 3600000)
  await h.page.addProduct(event)
  assert.equal(h.page.data.membershipInviteVisible, false)
  h.state.storage.set(key, Date.now() - 1)
  await h.page.addProduct(event)
  assert.equal(h.page.data.membershipInviteVisible, true)
})

test('late membership read invites after a successful add, without delaying the add', async () => {
  const response = deferred()
  const h = fixture('order', { getMiniBootstrap: () => response.promise, adjustSharedCart: async () => cart(2) })
  const reading = h.page.loadOrderExtra('membership', h.page.currentTableRequest())
  await h.page.addProduct(event)
  assert.equal(h.page.data.cartCount, 1)
  assert.equal(h.page.data.membershipInviteVisible, false)
  response.resolve(bootstrap)
  await reading
  assert.equal(h.page.data.membershipInviteVisible, true)
})

test('old-table membership response cannot invite on a new table', async () => {
  const response = deferred()
  const h = fixture('order', { getMiniBootstrap: () => response.promise, adjustSharedCart: async () => cart(2) })
  const reading = h.page.loadOrderExtra('membership', h.page.currentTableRequest())
  await h.page.addProduct(event)
  h.state.session = { tableCode: 'W21', tableToken: 'other', cartScope: 'other' }
  h.page.beginTableRequest()
  response.resolve(bootstrap)
  await reading
  assert.equal(h.page.data.membershipInviteVisible, false)
  assert.equal(h.page.data.membershipStatus, 'unknown')
})

test('product detail and native notification prompt finish before membership invitation', async () => {
  const h = await ready()
  const notification = deferred()
  h.page.offerOrderNotifications = () => notification.promise
  h.page.setData({ detailProduct: { productId: 'p1' } })
  await h.page.addProduct(event)
  assert.equal(h.page.data.membershipInviteVisible, false)
  notification.resolve()
  await Promise.resolve(); await Promise.resolve()
  assert.equal(h.page.data.membershipInviteVisible, false)
  h.page.closeProductDetail()
  assert.equal(h.page.data.membershipInviteVisible, true)
})

test('checkout is never covered by a late membership invitation', async () => {
  const h = await ready()
  h.page.setData({ checkoutConfirmVisible: true })
  await h.page.addProduct(event)
  assert.equal(h.page.data.membershipInviteVisible, false)
})

test('enrollment uses existing consent route; returning as member retains shared cart without reinviting', async () => {
  const h = await ready({ getSharedCart: async () => cart(2) })
  const routes = []
  h.wx.navigateTo = options => routes.push(options.url)
  await h.page.addProduct(event)
  h.page.enrollFromMenu()
  assert.deepEqual(routes, ['/pages/membership-terms/index?source=mini_menu&action=enroll'])
  assert.equal(h.page.data.membershipInviteVisible, false)
  h.page.onHide()
  h.api.getMiniBootstrap = async () => ({ ...bootstrap, membership: { memberNo: 'new-member' } })
  await h.page.preparePage()
  await h.page.loadOrderExtra('membership', h.page.currentTableRequest())
  assert.equal(h.page.data.membershipStatus, 'member')
  assert.equal(h.page.data.cartCount, 1)
  await h.page.addProduct(event)
  assert.equal(h.page.data.membershipInviteVisible, false)
})

test('hiding the page prevents late membership response from reopening invitation', async () => {
  const h = await ready()
  const response = deferred()
  h.api.getMiniBootstrap = () => response.promise
  const reading = h.page.loadOrderExtra('membership', h.page.currentTableRequest())
  h.page.onHide()
  response.resolve(bootstrap)
  await reading
  assert.equal(h.page.data.membershipStatus, 'unknown')
  assert.equal(h.page.data.membershipInviteVisible, false)
})
