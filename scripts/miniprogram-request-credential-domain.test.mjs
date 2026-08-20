import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const RESERVATION_KEY = 'mbox.http.cookie.reservation.v2'
const GUEST_KEY = 'mbox.http.cookie.guest.v2'
const LEGACY_KEY = 'mbox.http.cookie.v1'
const IDENTITY_KEY = 'mbox.wechat.identity.accessToken.v1'

async function loadRequestModule() {
  const source = await readFile(new URL('../miniprogram/utils/request.js', import.meta.url), 'utf8')
  const storage = new Map()
  const calls = []
  const responses = []
  const context = {
    module: { exports: {} },
    exports: {},
    require(specifier) {
      if (specifier === '../config/index') {
        return { getRuntimeConfig: () => ({
          apiBaseUrl: 'https://mini.example.test',
          storeId: 'mbox-lujiazui',
          requestTimeoutMs: 10_000,
        }) }
      }
      if (specifier === './session') return { getTableSession: () => ({ tableCode: 'L01' }) }
      throw new Error(`unexpected require: ${specifier}`)
    },
    wx: {
      getStorageSync: (key) => storage.get(key),
      setStorageSync: (key, value) => storage.set(key, value),
      removeStorageSync: (key) => storage.delete(key),
      request(input) {
        calls.push(input)
        const response = responses.shift() || { statusCode: 200, data: { ok: true }, header: {} }
        input.success(response)
      },
    },
  }
  vm.runInNewContext(source, context, { filename: 'miniprogram/utils/request.js' })
  return { requestModule: context.module.exports, storage, calls, responses }
}

async function loadApiModule() {
  const source = await readFile(new URL('../miniprogram/utils/api.js', import.meta.url), 'utf8')
  const storage = new Map()
  const calls = []
  const context = {
    module: { exports: {} },
    exports: {},
    require(specifier) {
      if (specifier === './request') {
        return {
          deviceKey: () => 'device-contract',
          request: async (path, options) => {
            calls.push({ path, options: options || {} })
            return { data: { publicId: 'redemption-contract' } }
          },
        }
      }
      if (specifier === './id') return { randomId: (prefix) => `${prefix}-contract-id` }
      if (specifier === './session') {
        return {
          getTableSession: () => ({}), rememberTableConnection: () => undefined,
          clearTableConnection: () => undefined,
        }
      }
      if (specifier === './auth') return { ensureCustomerSession: async () => true }
      if (specifier === './recommendation-attribution') {
        return { checkoutRecommendationAttribution: () => null }
      }
      throw new Error(`unexpected require: ${specifier}`)
    },
    wx: {
      getStorageSync: (key) => storage.get(key),
      setStorageSync: (key, value) => storage.set(key, value),
      removeStorageSync: (key) => storage.delete(key),
    },
  }
  vm.runInNewContext(source, context, { filename: 'miniprogram/utils/api.js' })
  return { api: context.module.exports, calls }
}

function responseWith(setCookie, cookies) {
  return {
    statusCode: 200,
    data: { ok: true },
    header: setCookie === undefined ? {} : { 'Set-Cookie': setCookie },
    ...(cookies === undefined ? {} : { cookies }),
  }
}

test('public requests send only the reservation session and never inherit WeChat bearer or caller cookies', async () => {
  const fixture = await loadRequestModule()
  fixture.storage.set(RESERVATION_KEY, 'mbox_reservation_session=reservation-a')
  fixture.storage.set(GUEST_KEY, '__Host-mbox_guest_session=guest-a')
  fixture.storage.set(IDENTITY_KEY, 'identity-token-abcdefghijklmnopqrstuvwxyz')

  await fixture.requestModule.request('/api/public/mini/bootstrap?source=profile', {
    requireTableSession: false,
    headers: { Cookie: '__Host-mbox_guest_session=forged', Authorization: 'Bearer should-not-leak' },
  })

  const headers = fixture.calls[0].header
  assert.equal(headers.cookie, 'mbox_reservation_session=reservation-a')
  assert.equal(headers.Cookie, undefined)
  assert.equal(headers.authorization, undefined)
  assert.equal(headers.Authorization, undefined)
  assert.equal(JSON.stringify(headers).includes('guest-a'), false)
  assert.equal(JSON.stringify(headers).includes('identity-token'), false)
})

test('guest scan starts without another domain credential, then sends only the issued guest session', async () => {
  const fixture = await loadRequestModule()
  fixture.storage.set(RESERVATION_KEY, 'mbox_reservation_session=reservation-a')
  fixture.storage.set(IDENTITY_KEY, 'identity-token-abcdefghijklmnopqrstuvwxyz')
  fixture.responses.push(responseWith('__Host-mbox_guest_session=guest-a; Path=/; HttpOnly; Secure; SameSite=Lax'))

  await fixture.requestModule.request('/api/guest/session/scan', { method: 'POST', requireTableSession: false })
  assert.equal(fixture.calls[0].header.cookie, undefined)
  assert.equal(fixture.calls[0].header.authorization, undefined)

  await fixture.requestModule.request('/api/guest/session', { requireTableSession: false })
  assert.equal(fixture.calls[1].header.cookie, '__Host-mbox_guest_session=guest-a')
  assert.equal(JSON.stringify(fixture.calls[1].header).includes('reservation-a'), false)
  assert.equal(JSON.stringify(fixture.calls[1].header).includes('identity-token'), false)
})

test('all Set-Cookie values are parsed without splitting the comma in Expires', async () => {
  const fixture = await loadRequestModule()
  fixture.responses.push(responseWith(
    'mbox_reservation_session=reservation-b; Path=/api/public; Expires=Wed, 21 Oct 2037 07:28:00 GMT, __Host-mbox_guest_session=guest-b; Path=/; HttpOnly',
    ['__Host-mbox_staff_session=ignored; Path=/api', '__Host-mbox_guest_session=guest-c; Path=/; HttpOnly'],
  ))
  await fixture.requestModule.request('/api/wechat/challenges', { requireTableSession: false })

  await fixture.requestModule.request('/api/public/reservations/mine', { requireTableSession: false })
  await fixture.requestModule.request('/api/guest/session', { requireTableSession: false })
  assert.equal(fixture.calls[1].header.cookie, 'mbox_reservation_session=reservation-b')
  assert.equal(fixture.calls[2].header.cookie, '__Host-mbox_guest_session=guest-c')
  assert.equal([...fixture.storage.values()].some((value) => String(value).includes('staff_session')), false)
})

test('table-session switching and cookie clearing never overwrite the reservation domain', async () => {
  const fixture = await loadRequestModule()
  fixture.storage.set(RESERVATION_KEY, 'mbox_reservation_session=reservation-stable')
  fixture.storage.set(GUEST_KEY, '__Host-mbox_guest_session=guest-old')
  fixture.responses.push(responseWith('__Host-mbox_guest_session=guest-new; Path=/; HttpOnly'))
  await fixture.requestModule.request('/api/guest/session/scan', { method: 'POST', requireTableSession: false })
  assert.equal(fixture.calls[0].header.cookie, '__Host-mbox_guest_session=guest-old')

  fixture.responses.push(responseWith('__Host-mbox_guest_session=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT'))
  await fixture.requestModule.request('/api/guest/session', { requireTableSession: false })
  await fixture.requestModule.request('/api/guest/session', { requireTableSession: false })
  await fixture.requestModule.request('/api/public/mini/bootstrap', { requireTableSession: false })
  assert.equal(fixture.calls[2].header.cookie, undefined)
  assert.equal(fixture.calls[3].header.cookie, 'mbox_reservation_session=reservation-stable')
})

test('legacy one-slot cookies migrate by their exact name and cannot cross domains', async () => {
  const guestFixture = await loadRequestModule()
  guestFixture.storage.set(LEGACY_KEY, '__Host-mbox_guest_session=legacy-guest')
  await guestFixture.requestModule.request('/api/public/mini/bootstrap', { requireTableSession: false })
  await guestFixture.requestModule.request('/api/guest/session', { requireTableSession: false })
  assert.equal(guestFixture.calls[0].header.cookie, undefined)
  assert.equal(guestFixture.calls[1].header.cookie, '__Host-mbox_guest_session=legacy-guest')
  assert.equal(guestFixture.storage.has(LEGACY_KEY), false)

  const reservationFixture = await loadRequestModule()
  reservationFixture.storage.set(LEGACY_KEY, 'mbox_reservation_session=legacy-reservation')
  await reservationFixture.requestModule.request('/api/guest/session', { requireTableSession: false })
  await reservationFixture.requestModule.request('/api/public/mini/bootstrap', { requireTableSession: false })
  assert.equal(reservationFixture.calls[0].header.cookie, undefined)
  assert.equal(reservationFixture.calls[1].header.cookie, 'mbox_reservation_session=legacy-reservation')
})

test('WeChat bearer is opt-in for a dedicated identity call and rejected on public or guest routes', async () => {
  const fixture = await loadRequestModule()
  const token = 'identity-token-abcdefghijklmnopqrstuvwxyz'
  fixture.storage.set(IDENTITY_KEY, token)
  fixture.storage.set(RESERVATION_KEY, 'mbox_reservation_session=reservation-a')
  fixture.storage.set(GUEST_KEY, '__Host-mbox_guest_session=guest-a')

  await fixture.requestModule.request('/api/wechat/challenges', { requireTableSession: false })
  assert.equal(fixture.calls[0].header.authorization, undefined)
  assert.equal(fixture.calls[0].header.cookie, undefined)

  await fixture.requestModule.request('/api/wechat/identity-profile', {
    requireTableSession: false,
    credentialDomain: 'wechat_identity',
  })
  assert.equal(fixture.calls[1].header.authorization, `Bearer ${token}`)
  assert.equal(fixture.calls[1].header.cookie, undefined)

  await assert.rejects(
    fixture.requestModule.request('/api/public/mini/bootstrap', {
      requireTableSession: false,
      credentialDomain: 'wechat_identity',
    }),
    /不能发送到预约或桌台会话接口/,
  )
  assert.equal(fixture.calls.length, 2)
})

test('only redemption creation can explicitly combine reservation and guest sessions without a bearer', async () => {
  const fixture = await loadRequestModule()
  fixture.storage.set(RESERVATION_KEY, 'mbox_reservation_session=reservation-a')
  fixture.storage.set(GUEST_KEY, '__Host-mbox_guest_session=guest-a')
  fixture.storage.set(IDENTITY_KEY, 'identity-token-abcdefghijklmnopqrstuvwxyz')

  await fixture.requestModule.request('/api/public/mini/redemptions', {
    method: 'POST',
    requireTableSession: false,
    credentialDomain: 'reservation+guest',
  })
  assert.equal(
    fixture.calls[0].header.cookie,
    'mbox_reservation_session=reservation-a; __Host-mbox_guest_session=guest-a',
  )
  assert.equal(fixture.calls[0].header.authorization, undefined)

  await fixture.requestModule.request('/api/public/mini/redemptions/catalog', { requireTableSession: false })
  await fixture.requestModule.request('/api/public/mini/redemptions/redemption-a/cancel', {
    method: 'POST', requireTableSession: false,
  })
  assert.equal(fixture.calls[1].header.cookie, 'mbox_reservation_session=reservation-a')
  assert.equal(fixture.calls[2].header.cookie, 'mbox_reservation_session=reservation-a')

  await assert.rejects(
    fixture.requestModule.request('/api/public/mini/redemptions', {
      method: 'GET', requireTableSession: false, credentialDomain: 'reservation+guest',
    }),
    /双会话凭证仅限创建会员兑换/,
  )
  await assert.rejects(
    fixture.requestModule.request('/api/public/mini/redemptions/redemption-a/cancel', {
      method: 'POST', requireTableSession: false, credentialDomain: 'reservation+guest',
    }),
    /双会话凭证仅限创建会员兑换/,
  )
  assert.equal(fixture.calls.length, 3)
})

test('the mini-program API opts into the combined credential only for redemption creation', async () => {
  const fixture = await loadApiModule()
  await fixture.api.getRedemptionCatalog()
  await fixture.api.getRedemptions()
  await fixture.api.createRedemption('catalog-item-a')
  await fixture.api.cancelRedemption('redemption-a', '顾客取消')

  assert.equal(fixture.calls[0].path, '/api/public/mini/redemptions/catalog')
  assert.equal(fixture.calls[0].options.credentialDomain, undefined)
  assert.equal(fixture.calls[1].path, '/api/public/mini/redemptions')
  assert.equal(fixture.calls[1].options.credentialDomain, undefined)
  assert.equal(fixture.calls[2].path, '/api/public/mini/redemptions')
  assert.equal(fixture.calls[2].options.method, 'POST')
  assert.equal(fixture.calls[2].options.credentialDomain, 'reservation+guest')
  assert.match(fixture.calls[2].options.headers['idempotency-key'], /^redemption-catalog-item-a-/)
  assert.equal(fixture.calls[3].path, '/api/public/mini/redemptions/redemption-a/cancel')
  assert.equal(fixture.calls[3].options.credentialDomain, undefined)
})
