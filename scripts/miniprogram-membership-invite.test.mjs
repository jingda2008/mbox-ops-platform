import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
const { fixture, deferred, cart } = createRequire(import.meta.url)('./miniprogram-state-fixture.cjs')
const terms = { version: 1, summary: '消费积分说明' }
const bootstrap = { membership: null, membershipTerms: terms }
const event = { currentTarget: { dataset: { id: 'p1' } } }
function setup(overrides = {}) {
  return fixture('order', { getMiniBootstrap: async () => bootstrap, getVerifiedPhones: async () => [], adjustSharedCart: async () => cart(2), ...overrides })
}
async function read(h) { await h.page.loadOrderExtra('membership', h.page.currentTableRequest()); return h }
test('browsing needs neither a membership lookup nor a verified phone', async () => {
  const calls = []
  const h = setup({ getMiniBootstrap: () => calls.push('member'), getVerifiedPhones: () => calls.push('phone') })
  await h.page.loadBrowseData('', undefined, h.page.currentTableRequest())
  assert.equal(h.page.data.browseOnly, true)
  assert.deepEqual(calls, [])
})

test('table checkout reads membership without requesting phone data', async () => {
  for (const [response, status] of [[bootstrap,'nonmember'], [{membership:{memberNo:'123456'}},'member'], [null,'unknown']]) {
    const calls = []
    const h = setup({getMiniBootstrap:async()=>response,getVerifiedPhones:async()=>{calls.push('phone');return []}})
    await read(h)
    assert.equal(h.page.data.membershipStatus,status)
    assert.deepEqual(calls,[])
  }
})

test('identity failure does not become nonmember and does not block cart writes', async () => {
  const h = await read(setup({ getMiniBootstrap: async () => { throw Error('offline') } }))
  assert.equal(await h.page.addProduct(event), true)
  assert.equal(h.page.data.membershipStatus, 'unknown')
})

test('late membership read does not delay menu or cart writes', async () => {
  const response = deferred()
  const h = setup({ getMiniBootstrap: () => response.promise })
  const reading = read(h)
  await h.page.addProduct(event)
  assert.equal(h.page.data.cartCount, 1)
  response.resolve(bootstrap)
  await reading
  assert.equal(h.page.data.membershipStatus, 'nonmember')
})

test('old-table membership response cannot invite on a new table', async () => {
  const response = deferred()
  const h = setup({ getMiniBootstrap: () => response.promise })
  const reading = read(h)
  h.state.session = { tableCode: 'W21', tableToken: 'other', cartScope: 'other' }
  h.page.beginTableRequest()
  response.resolve(bootstrap)
  await reading
  assert.equal(h.page.data.membershipStatus, 'unknown')
})
