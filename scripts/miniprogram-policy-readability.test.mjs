import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import vm from 'node:vm'
import test from 'node:test'

function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function fixture(pageName, overrides = {}) {
  const storage = new Map([
    ['mbox.http.cookie.reservation.v2', 'mbox_reservation_session=private-reservation'],
    ['mbox.http.cookie.guest.v2', '__Host-mbox_guest_session=private-table'],
    ['mbox.wechat.identity.accessToken.v1', 'private-identity-token-abcdefghijklmnopqrstuvwxyz'],
  ])
  const calls = [], authCalls = [], modules = new Map()
  let definition, api
  const runtime = {
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key),
    showToast: () => {}, showModal: () => {}, navigateTo: () => {},
    request: input => {
      calls.push(input)
      input.success({ statusCode: 200, data: { data: { version: 7, content: 'published agreement' } }, header: {} })
    },
  }
  const read = file => {
    if (modules.has(file)) return modules.get(file).exports
    const module = { exports: {} }; modules.set(file, module)
    vm.runInNewContext(readFileSync(file, 'utf8'), {
      module, exports: module.exports, Date, Map, Set, Promise, setTimeout: () => 0, clearTimeout: () => {}, wx: runtime,
      Page: value => { definition = value },
      require: spec => {
        if (spec.endsWith('/config/index')) return { getRuntimeConfig: () => ({ apiBaseUrl: 'https://mini.example.test', storeId: 'configured-store', requestTimeoutMs: 10000 }) }
        if (spec.endsWith('/session') || spec === './session') return { getTableSession: () => ({ tableCode: 'A01', tableToken: 'private-token' }), clearTableConnection: () => {} }
        if (spec === './auth') return { ensureCustomerSession: async () => { authCalls.push('login'); throw new Error('identity offline') } }
        const result = read(resolve(dirname(file), `${spec}.js`))
        if (spec.endsWith('/api')) { api = { ...result, ...overrides }; return api }
        return result
      },
    }, { filename: file })
    return module.exports
  }
  if (pageName) read(resolve(`miniprogram/pages/${pageName}/index.js`))
  else api = read(resolve('miniprogram/utils/api.js'))
  const page = definition && { ...definition, data: structuredClone(definition.data) }
  if (page) page.setData = patch => Object.assign(page.data, patch)
  return { page, api, calls, authCalls, storage }
}

test('WeChat agreements remain readable with broken login and never send member, table or identity credentials', async () => {
  const h = fixture()
  await h.api.getPrivacyPolicy()
  await h.api.getMembershipTerms()
  assert.deepEqual(h.authCalls, [])
  assert.equal(h.calls.length, 2)
  for (const call of h.calls) {
    assert.equal(call.method, 'GET')
    assert.equal(call.header.cookie, undefined)
    assert.equal(call.header.authorization, undefined)
    assert.equal(call.header['x-mbox-guest-device'], undefined)
    assert.equal(call.header['x-mbox-table-code'], undefined)
    assert.equal(call.header['x-mbox-store-id'], 'configured-store')
  }
  assert.doesNotMatch(JSON.stringify(h.calls), /private-/)
  await assert.rejects(h.api.getMiniBootstrap(), /identity offline/)
  assert.equal(h.authCalls.length, 1)
  assert.equal(h.calls.length, 2)
})

test('WeChat privacy retries and old failed response cannot erase the newer published policy', async () => {
  const first = deferred(), second = deferred(); let n = 0
  const h = fixture('privacy', { getPrivacyPolicy: () => ++n === 1 ? first.promise : second.promise })
  const old = h.page.loadPrivacyPolicy(), current = h.page.loadPrivacyPolicy()
  second.resolve({ version: 'current', content: 'current copy' }); await current
  first.reject(new Error('old timeout')); await old
  assert.equal(h.page.data.policy.version, 'current')
  assert.equal(h.page.data.policyMessage, '')
})

test('WeChat privacy page keeps the approved review copy readable as separate paragraphs', async () => {
  const content = `${'甲'.repeat(500)}\n\n第二段正文。\n仍在第二段。`
  const h = fixture('privacy', {
    getPrivacyPolicy: async () => ({
      version: 'MBOX-PRIVACY-20260914-V2',
      content,
      effectiveAt: '2026-09-14T00:00:00.000+08:00',
    }),
  })
  await h.page.loadPrivacyPolicy()
  assert.equal(h.page.data.policy.version, 'MBOX-PRIVACY-20260914-V2')
  assert.equal(h.page.data.policyMessage, '')
  assert.equal(h.page.data.policyEffectiveLabel, '2026-09-14 00:00')
  const shown = h.page.data.policyParagraphs.map((item) => String(item.text))
  assert.equal(shown.join('\n\n'), `${'甲'.repeat(480)}\n\n${'甲'.repeat(20)}\n\n第二段正文。\n仍在第二段。`)
  assert.ok(shown.every((item) => item.length <= 480))
})

test('WeChat privacy failure is visible and reopening the page recovers without login', async () => {
  let failed = true
  const h = fixture('privacy', { getPrivacyPolicy: async () => { if (failed) throw new Error('offline'); return { version: 'restored', content: 'restored copy' } } })
  await h.page.loadPrivacyPolicy()
  assert.equal(h.page.data.policy, null)
  assert.ok(h.page.data.policyMessage)
  failed = false
  await h.page.loadPrivacyPolicy()
  assert.equal(h.page.data.policy.version, 'restored')
  assert.equal(h.page.data.policyMessage, '')
})

test('WeChat service agreement viewing does not load personal membership', async () => {
  let personalReads = 0
  const h = fixture('membership-terms', {
    getMembershipTerms: async () => ({ version: 8, content: 'current terms' }),
    getMiniBootstrap: async () => { personalReads++; throw new Error('offline') },
  })
  h.page.onLoad({ action: 'view' })
  await h.page.load()
  assert.equal(h.page.data.terms.version, 8)
  assert.equal(h.page.data.loading, false)
  assert.equal(personalReads, 0)
  assert.equal(h.page.data.agreedToPolicies, false)
})

test('WeChat enrollment identity can stall or fail without hiding terms or authorizing enrollment', async () => {
  const identity = deferred(); let enrollments = 0
  const h = fixture('membership-terms', {
    getMembershipTerms: async () => ({ version: 9, content: 'current terms' }),
    getMiniBootstrap: () => identity.promise,
    enrollMembership: async () => { enrollments++ },
  })
  h.page.onLoad({ action: 'enroll' })
  await h.page.load()
  assert.equal(h.page.data.terms.version, 9)
  assert.equal(h.page.data.enrollmentReady, false)
  h.page.onAgreementChange({ detail: { value: ['agree'] } })
  await h.page.acceptAndEnroll({ detail: { code: 'one-use-code' } })
  assert.equal(enrollments, 0)
  identity.reject(new Error('login failed'))
  await h.page.enrollmentPending
  assert.equal(h.page.data.terms.version, 9)
  assert.ok(h.page.data.enrollmentError)
  assert.equal(enrollments, 0)
})

test('WeChat enrollment recovery requires a new explicit agreement and preserves existing members', async () => {
  let fail = true
  const h = fixture('membership-terms', {
    getMembershipTerms: async () => ({ version: fail ? 9 : 10, content: 'terms' }),
    getMiniBootstrap: async () => { if (fail) throw new Error('offline'); return { membership: { memberNo: 'existing-member' } } },
  })
  h.page.onLoad({ action: 'enroll' })
  await h.page.load(); await h.page.enrollmentPending
  h.page.onAgreementChange({ detail: { value: ['agree'] } })
  fail = false
  await h.page.load(); await h.page.enrollmentPending
  assert.equal(h.page.data.terms.version, 10)
  assert.equal(h.page.data.agreedToPolicies, false)
  assert.equal(h.page.data.membership.memberNo, 'existing-member')
  assert.equal(h.page.data.enrollmentReady, true)
  assert.equal(h.page.data.enrollmentError, '')
})

test('WeChat policy and terms ignore responses after leaving the page', async () => {
  for (const name of ['privacy', 'membership-terms']) {
    const response = deferred()
    const h = fixture(name, { getPrivacyPolicy: () => response.promise, getMembershipTerms: () => response.promise })
    const read = name === 'privacy' ? h.page.loadPrivacyPolicy() : h.page.load()
    h.page.onHide(); response.resolve({ version: 'late' }); await read
    assert.equal(h.page.data[name === 'privacy' ? 'policy' : 'terms'], null)
  }
})

test('WeChat agreement pages expose retries and do not label a network failure as unpublished', () => {
  const privacy = readFileSync('miniprogram/pages/privacy/index.wxml', 'utf8')
  const terms = readFileSync('miniprogram/pages/membership-terms/index.wxml', 'utf8')
  assert.match(privacy, /bindtap="loadPrivacyPolicy">重新读取/)
  assert.match(terms, /bindtap="load">重新读取/)
  assert.match(terms, /wx:if="\{\{!terms && !error\}\}"/)
  assert.match(terms, /wx:if="\{\{agreedToPolicies && enrollmentReady\}\}"[^>]*open-type="getPhoneNumber"/)
})


test('WeChat dietary consent defaults off and editing the text cancels earlier selection', async () => {
  const h = fixture('profile-preferences', { getCustomerProfile: async () => ({ preferences: { dietaryNotes: '已有说明' } }) })
  await h.page.load()
  assert.equal(h.page.data.dietaryConsent, false)
  h.page.onDietaryConsentChange({ detail: { value: ['dietary'] } })
  assert.equal(h.page.data.dietaryConsent, true)
  h.page.onDietaryInput({ detail: { value: '修改后的说明' } })
  assert.equal(h.page.data.dietaryConsent, false)
})

test('WeChat dietary notes cannot be saved without separate consent and clear-to-withdraw remains available', async () => {
  const writes = []
  const h = fixture('profile-preferences', {
    getCustomerProfile: async () => ({ preferences: {} }),
    updatePreferences: async (...args) => { writes.push(args) },
  })
  await h.page.load()
  h.page.onDietaryInput({ detail: { value: '花生过敏' } })
  await h.page.save()
  assert.equal(writes.length, 0)
  h.page.onDietaryConsentChange({ detail: { value: ['dietary'] } })
  await h.page.save()
  assert.equal(writes.length, 1)
  assert.equal(writes[0][2].version, 'wechat-dietary-v1')
  assert.equal(writes[0][2].granted, true)
  h.page.onDietaryInput({ detail: { value: '' } })
  await h.page.save()
  assert.equal(writes[1][0].dietaryNotes, '')
  assert.equal(writes[1][2].granted, false)
})

test('WeChat failed initial preference read cannot overwrite the stored profile', async () => {
  let writes = 0
  const h = fixture('profile-preferences', {
    getCustomerProfile: async () => { throw new Error('offline') },
    updatePreferences: async () => { writes++ },
  })
  await h.page.load(); await h.page.save()
  assert.equal(writes, 0)
  assert.ok(h.page.data.error)
})
