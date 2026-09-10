import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { loadMiniModule } from './load-miniprogram-test-module.mjs'
const guard = loadMiniModule(new URL('../miniprogram/utils/table-request-scope.js', import.meta.url))
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function fixture(name) {
  let page, session = { tableCode: 'W01', tableToken: 'test-one', cartScope: 'first' }
  const pending = [], storage = new Map()
  vm.runInNewContext(await readFile(new URL(`../miniprogram/pages/${name}/index.js`, import.meta.url), 'utf8'), {
    Page: value => { page = value },
    require(path) {
      if (path.endsWith('/table-request-scope')) return guard
      if (path.endsWith('/session')) return { getTableSession: () => session, tableSessionCacheScope: () => guard.tableRequestScope(session) }
      if (path.endsWith('/api')) return { getTableOrders: async () => [], createServiceTask: input => { const item = deferred(); pending.push({ ...item, input }); return item.promise } }
      if (path.endsWith('/customer-error')) return { customerErrorMessage: (_, fallback) => fallback }
      if (path.endsWith('/config/index')) return { getRuntimeConfig: () => ({}) }
      throw new Error(path)
    },
    wx: { getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value) }, Date,
  })
  page.data = { ...page.data }; page.setData = patch => Object.assign(page.data, patch)
  page.onLoad(); page.onShow()
  return { page, pending, switchTable() { session = { tableCode: 'W02', tableToken: 'test-two', cartScope: 'second' }; page.onShow() } }
}
for (const name of ['complaint', 'service']) {
  test(`${name}: old table completion cannot clear a new table's pending request or draft`, async () => {
    const { page, pending, switchTable } = await fixture(name)
    const send = () => name === 'complaint' ? page.submitComplaint() : page.submitService('custom', 'custom', page.data.note)
    page.setData(name === 'complaint' ? { details: '第一桌的请求' } : { note: '第一桌的请求' })
    const first = send(); await send(); assert.equal(pending.length, 1)
    switchTable(); assert.equal(page.data.tableCode, 'W02')
    assert.equal(name === 'complaint' ? page.data.details : page.data.note, '')
    page.setData(name === 'complaint' ? { details: '第二桌的请求' } : { note: '第二桌的请求' })
    const second = send(); assert.equal(pending.length, 2)
    pending[0].resolve({ data: { taskPublicId: 'first', message: '旧请求已完成' } }); await first
    assert.ok(name === 'complaint' ? page.data.submitting : page.data.submittingId)
    assert.equal(page.data.success, '')
    assert.equal(name === 'complaint' ? page.data.details : page.data.note, '第二桌的请求')
    pending[1].resolve({ data: { taskPublicId: 'second', message: '新请求已收到' } }); await second
    assert.equal(page.data.success, '新请求已收到')
    assert.ok(!(name === 'complaint' ? page.data.submitting : page.data.submittingId))
  })
}
test('complaint input rejects invalid categories and cannot change while sending', async () => {
  const { page, pending } = await fixture('complaint')
  page.onCategoryChange({ detail: { value: 999 } }); assert.equal(page.data.categoryIndex, 0)
  page.onDetailsInput({ detail: { value: 'a'.repeat(350) } }); assert.equal(page.data.details.length, 300)
  const action = page.submitComplaint()
  page.onDetailsInput({ detail: { value: 'changed' } }); assert.equal(page.data.details.length, 300)
  pending[0].resolve({ data: {} }); await action
})
test('compact secondary layout addresses intrinsic sizing without clipping page overflow', async () => {
  const style = await readFile(new URL('../miniprogram/styles/compact-secondary.wxss', import.meta.url), 'utf8')
  assert.match(style, /\.page\.service-page \.manager-entry\{[^}]*width:100%;min-width:0/)
  assert.match(style, /\.page\.reservations-page \.field-row\{[^}]*repeat\(2,minmax\(0,1fr\)\)/)
  assert.match(style, /\.page\.profile-contact-page \.contact-action\{[^}]*height:auto[^}]*max-height:none[^}]*white-space:normal/)
  assert.doesNotMatch(style, /overflow(?:-x)?:hidden/)
})
