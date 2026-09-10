import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
for (const platform of ['miniprogram','alipay-miniprogram']) {
const read = path => readFile(new URL('../' + path.replace(/^miniprogram\//,platform+'/').replace(/\.wxml$/,platform==='miniprogram'?'.wxml':'.axml'), import.meta.url), 'utf8')

test('portion notes survive polling, follow stable portions, and reset with the table generation', async () => {
  const source = await read('miniprogram/pages/order/index.js')
  const methods = source.slice(source.indexOf('  onCheckoutNoteInput(event)'), source.indexOf('  async refreshSharedCart('))
  let scope = 'table-A'
  const page = vm.runInNewContext('({' + methods + '})', { tableSessionCacheScope: () => scope, money: String, compactMoney: String })
  page.data = { cart: [], cartGeneration: 1, cartVersion: 1, couponSelections: [] }
  page.setData = patch => Object.assign(page.data, patch)
  page.invalidateCheckoutCoupons = () => {}
  const line = { productId: 'drink', quantity: 2, portionIds: ['A', 'B'], subtotalAmountMinor: 19600 }
  const cart = { generation: 1, version: 1, totalAmountMinor: 19600 }
  page.updateCart([line], cart)
  const input = (id, value) => page.onLineNoteInput({ currentTarget: { dataset: { portion: id } }, detail: { value } })
  input('A', '少冰'); input('B', '不加糖')
  page.onCheckoutNoteInput({ detail: { value: '一起上齐' } })
  page.updateCart([line], cart)
  assert.equal(page.data.cart[0].noteUnits[1].note, '不加糖')
  assert.equal(page.data.checkoutNote, '一起上齐')
  page.updateCart([{ ...line, portionIds: ['B', 'C'] }], { ...cart, version: 2 })
  assert.equal(page.data.cart[0].noteUnits[0].note, '不加糖')
  assert.equal(page.data.cart[0].noteUnits[1].note, '')
  assert.equal(page.checkoutLineNotes.A, undefined)
  input('removed', '不能写入'); assert.equal(page.checkoutLineNotes.removed, undefined)
  page.data.checkoutLocked = true; input('B', '不能篡改'); assert.equal(page.checkoutLineNotes.B, '不加糖')
  page.data.checkoutLocked = false
  page.updateCart([line], { ...cart, generation: 2 })
  assert.equal(page.data.checkoutNote, ''); assert.equal(Object.keys(page.checkoutLineNotes).length, 0)
  input('A', '旧桌备注'); scope = 'table-B'; page.updateCart([line], cart)
  assert.equal(Object.keys(page.checkoutLineNotes).length, 0)
})

test('retry uses saved note snapshot and template has per-portion fields plus compact overall note', async () => {
  const source = await read('miniprogram/pages/order/index.js')
  const view = await read('miniprogram/pages/order/index.wxml')
  assert.match(source, /const attempt = previousAttempt \|\| \{\s*note: this.data.checkoutNote/)
  assert.match(source, /checkoutSharedCart\(\{\s*note: attempt.note \|\| '',\s*lineNotes: attempt.lineNotes \|\| \[\]/)
  assert.match(view, /(?:wx|a):key="portionId"/)
  assert.match(view, /(?:bindinput|onInput)="onLineNoteInput" maxlength="300"/)
  assert.match(view, /class="checkout-note"/)
  assert.match(await read('miniprogram/pages/account/index.wxml'), /备注：\{\{product.note\}\}/)
})

async function identityFixture(responses) {
  let definition
  vm.runInNewContext(await read('miniprogram/components/member-identities/index.js'), {
    Component: value => { definition = value },
    require: path => path.endsWith('/api') ? { getMemberCards: () => { const value = responses.shift(); if (value instanceof Error) throw value; return value } } : { dateInput: value => value },
    Date,
  })
  const instance = { ...definition.methods, data: { ...definition.data }, setData(patch) { Object.assign(this.data, patch) } }
  return { instance, definition }
}
const identity = { id: 'one', project_id: 'music', name: '五迷卡', status: 'active', expired: false, valid_from: '2020-01-01', valid_until: '2099-01-01' }
test('menu taste indicators use supported backend tags, deduplicate and tolerate legacy data', async () => {
  const source = await read('miniprogram/pages/order/index.js')
  const fn = source.slice(source.indexOf('function menuProducts('), source.indexOf('function menuRecommendations('))
  const menu = vm.runInNewContext(fn + '; menuProducts', { menuAvailability: () => ({}), bundleValuePresentation: () => ({}), customerCategoryName: () => '', money: String, publicImageUrl: value => value })
  const rows = menu([{ recommendation: { tasteTags: ['refreshing', 'refreshing', 'any', 'layered', 'strong', 'unknown'] } }, {}, { recommendation: { tasteTags: 'legacy' } }])
  assert.deepEqual(Array.from(rows[0].tasteLabels), ['清爽', '层次丰富', '浓郁'])
  assert.equal(rows[1].tasteLabels.length, 0); assert.equal(rows[2].tasteLabels.length, 0)
})
test('only current approved active identities appear, with actual configured names and pagination', async () => {
  const { instance } = await identityFixture([
    { activeMember: true, cards: [identity, { ...identity, id: 'pending', status: 'pending' }, { ...identity, id: 'suspended', status: 'suspended' }, { ...identity, id: 'expired', expired: true }, { ...identity, id: 'future', valid_from: '2098-01-01' }], nextCursors: { cards: 'next' } },
    { activeMember: true, cards: [{ ...identity, id: 'two', project_id: 'other', name: '音乐卡' }], nextCursors: {} },
  ])
  await instance.reload()
  assert.deepEqual(Array.from(instance.data.identities, item => item.name), ['五迷卡', '音乐卡'])
  for (const page of ['profile', 'member-center']) {
    const view = await read(`miniprogram/pages/${page}/index.wxml`)
    assert.ok(view.indexOf('<member-identities') < view.indexOf('class="' + (page === 'profile' ? 'profile-member-card' : 'member-card')))
  }
})
test('identity errors and inactive memberships never retain a previously granted badge', async () => {
  const { instance } = await identityFixture([new Error('offline')])
  instance.data.identities = [identity]; await instance.reload()
  assert.equal(instance.data.identities.length, 0); assert.equal(instance.data.failed, true)
  const inactive = await identityFixture([{ activeMember: false, cards: [identity] }])
  await inactive.instance.reload(); assert.equal(inactive.instance.data.identities.length, 0)
})
test('hidden page rejects late identity responses', async () => {
  let resolve
  const { instance, definition } = await identityFixture([new Promise(done => { resolve = done })])
  const pending = instance.reload()
  if(platform==='miniprogram')definition.pageLifetimes.hide.call(instance)
  else definition.didUnmount.call(instance)
  resolve({ activeMember: true, cards: [identity] })
  await pending; assert.equal(instance.data.identities.length, 0)
})
}
