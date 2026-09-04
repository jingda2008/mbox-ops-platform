import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const platformPath = fileURLToPath(new URL('../alipay-miniprogram/utils/platform.js', import.meta.url))
const paymentPath = fileURLToPath(new URL('../alipay-miniprogram/utils/alipay-payment.js', import.meta.url))
const phonePath = fileURLToPath(new URL('../alipay-miniprogram/utils/alipay-phone.js', import.meta.url))
const configPath = fileURLToPath(new URL('../alipay-miniprogram/config/index.js', import.meta.url))

function loadCommonJs(path) {
  const module = { exports: {} }
  const source = readFileSync(path, 'utf8')
    .replace(/^export\s+default\s+/gm, 'module.exports = ')
    .replace(/^export\s+\{\s*\n([\s\S]*?)^\}\s*$/gm, 'module.exports = {\n$1\n}')
    .replace(/^export\s+\{([^\n}]*)\}\s*$/gm, 'module.exports = {$1}')
  const wrapper = new vm.Script(`(function (module, exports) { ${source}\n})`, { filename: path })
  wrapper.runInThisContext()(module, module.exports)
  return module.exports
}

const platform = loadCommonJs(platformPath)
const { isPresentableAlipayTradeAction } = loadCommonJs(paymentPath)

function loadRuntimeConfig(runtime, releaseConfig = {}) {
  const module = { exports: {} }
  const source = readFileSync(configPath, 'utf8')
    .replace(/^export\s+\{([^\n}]*)\}\s*$/gm, 'module.exports = {$1}')
  const wrapper = new vm.Script(`(function (module, exports, require) { ${source}\n})`, { filename: configPath })
  wrapper.runInThisContext()(module, module.exports, (request) => {
    if (request === '../utils/platform') return runtime
    if (request === './release-config.generated') return { default: releaseConfig }
    throw new Error(`Unexpected require: ${request}`)
  })
  return module.exports
}

test.afterEach(() => {
  delete global.my
})

test('normalizes Alipay synchronous storage to the shared page contract', () => {
  const values = new Map([['saved', { ok: true }]])
  global.my = {
    getStorageSync: ({ key }) => ({ data: values.get(key) }),
    setStorageSync: ({ key, data }) => values.set(key, data),
    removeStorageSync: ({ key }) => values.delete(key),
  }
  assert.deepEqual(platform.getStorageSync('saved'), { ok: true })
  platform.setStorageSync('next', 7)
  assert.equal(values.get('next'), 7)
  platform.removeStorageSync('next')
  assert.equal(values.has('next'), false)
})

test('missing account-info API defaults to release rather than development', () => {
  global.my = {}
  assert.equal(platform.getAccountInfoSync().miniProgram.envVersion, 'release')
})

test('defaults unknown clients to production and cannot override locked server capabilities', () => {
  const { getRuntimeConfig } = loadRuntimeConfig({
    getAccountInfoSync: () => ({ miniProgram: {} }),
    getExtConfigSync: () => ({ mbox: {
      mode: 'development',
      alipayIdentityEnabled: true,
      alipayPaymentEnabled: true,
      alipayPhoneEnabled: true,
      alipayNotificationEnabled: true,
    } }),
    getStorageSync: () => ({ alipayPaymentEnabled: true }),
  }, { alipayPaymentEnabled: true })
  const config = getRuntimeConfig()
  assert.equal(config.envVersion, 'release')
  assert.equal(config.isDevelopment, false)
  assert.equal(config.defaultTableCode, '')
  assert.equal(config.allowDevDataFallback, false)
  assert.equal(config.alipayIdentityEnabled, false)
  assert.equal(config.alipayPaymentEnabled, false)
  assert.equal(config.alipayPhoneEnabled, false)
  assert.equal(config.alipayNotificationEnabled, false)
})

test('scan is camera-only and does not admit album replay', async () => {
  global.my = {
    scan(options) {
      assert.equal(options.type, 'qr')
      assert.equal(options.hideAlbum, true)
      options.success({ code: 'https://mbox.example/table' })
    },
  }
  const result = await new Promise((resolve, reject) => platform.scanCode({ success: resolve, fail: reject }))
  assert.equal(result.result, 'https://mbox.example/table')
})

test('normalizes request headers and response status without changing the business URL', async () => {
  global.my = {
    request(options) {
      assert.equal(options.url, 'https://mbox.example/api/public/mini/bootstrap')
      assert.deepEqual(options.headers, { accept: 'application/json' })
      assert.equal(options.enableCookie, true)
      options.success({ status: 200, headers: { etag: 'v1' }, data: { ok: true } })
    },
  }
  const response = await new Promise((resolve, reject) => platform.request({
    url: 'https://mbox.example/api/public/mini/bootstrap',
    header: { accept: 'application/json' },
    success: resolve,
    fail: reject,
  }))
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.header, { etag: 'v1' })
  assert.deepEqual(response.data, { ok: true })
})

test('turns Alipay http status error into a normal HTTP response so 201 enroll can succeed', async () => {
  global.my = {
    request(options) {
      options.fail({
        error: 19,
        errorMessage: 'http status error',
        status: 201,
        headers: { etag: 'enroll-1' },
        data: { data: { membership: { level: 'member' } } },
      })
    },
  }
  const response = await new Promise((resolve, reject) => platform.request({
    url: 'https://mbox.shmbox.com/api/public/mini/membership/enroll-with-phone',
    success: resolve,
    fail: reject,
  }))
  assert.equal(response.statusCode, 201)
  assert.deepEqual(response.header, { etag: 'enroll-1' })
  assert.equal(response.data.data.membership.level, 'member')
})

test('surfaces Alipay 4xx http status error body instead of a fake network failure', async () => {
  global.my = {
    request(options) {
      options.fail({
        error: 19,
        errorMessage: 'http status error',
        status: 503,
        data: JSON.stringify({
          error: { code: 'ALIPAY_PHONE_NOT_CONFIGURED', message: '支付宝手机号入会尚未接通' },
        }),
      })
    },
  }
  const response = await new Promise((resolve, reject) => platform.request({
    url: 'https://mbox.shmbox.com/api/public/mini/membership/enroll-with-phone',
    success: resolve,
    fail: reject,
  }))
  assert.equal(response.statusCode, 503)
  assert.equal(response.data.error.code, 'ALIPAY_PHONE_NOT_CONFIGURED')
})

test('keeps real transport failures on the fail path', async () => {
  global.my = {
    request(options) {
      options.fail({ error: 12, errorMessage: '似乎已断开与互联网的连接。' })
    },
  }
  const error = await new Promise((resolve) => platform.request({
    url: 'https://mbox.shmbox.com/api/public/mini/bootstrap',
    success: () => resolve(null),
    fail: resolve,
  }))
  assert.equal(error.error, 12)
})

test('maps shared toast and phone-call options to Alipay parameter names', () => {
  const calls = []
  global.my = {
    showToast: (options) => calls.push(['toast', options]),
    makePhoneCall: (options) => calls.push(['phone', options]),
  }
  platform.showToast({ title: '已保存', icon: 'success' })
  platform.makePhoneCall({ phoneNumber: '02100000000' })
  assert.equal(calls[0][1].content, '已保存')
  assert.equal(calls[0][1].type, 'success')
  assert.equal(calls[1][1].number, '02100000000')
})

test('only presents a server-created Alipay trade number', async () => {
  assert.equal(isPresentableAlipayTradeAction({
    status: 'pending', presentation: 'alipay_jsapi', payload: { tradeNO: '202609030001' },
  }), true)
  assert.equal(isPresentableAlipayTradeAction({
    status: 'pending', presentation: 'jsapi', payload: {
      timeStamp: '1', nonceStr: 'n', package: 'p', signType: 'RSA', paySign: 's',
    },
  }), false)

  global.my = {
    tradePay(options) {
      assert.equal(options.tradeNO, '202609030001')
      options.success({ resultCode: '9000' })
    },
  }
  await new Promise((resolve, reject) => platform.requestPayment({
    tradeNO: '202609030001', success: resolve, fail: reject,
  }))
})

test('missing trade number fails closed before invoking Alipay', async () => {
  let invoked = false
  global.my = { tradePay: () => { invoked = true } }
  const error = await new Promise((resolve) => platform.requestPayment({ fail: resolve }))
  assert.equal(error.code, 'ALIPAY_TRADE_NO_MISSING')
  assert.equal(invoked, false)
})

test('maps Alipay result code 6001 to an explicit cancellation', async () => {
  global.my = {
    tradePay(options) {
      options.success({ resultCode: '6001' })
    },
  }
  const error = await new Promise((resolve) => platform.requestPayment({
    tradeNO: '202609030002', success: () => resolve(null), fail: resolve,
  }))
  assert.equal(error.code, 'ALIPAY_PAYMENT_CANCELLED')
  assert.match(error.errMsg, /cancel/)
})

test('getAuthorize callback always calls getPhoneNumber unless the event already has ciphertext', async () => {
  const phone = loadCommonJs(phonePath)
  let called = 0
  global.my = {
    getPhoneNumber(options) {
      called += 1
      options.success({
        response: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        sign: 'rsa-sign',
      })
    },
  }
  const fromAuthorize = await phone.obtainAlipayPhoneAuthorization({ result: 'success' })
  assert.equal(called, 1)
  assert.match(fromAuthorize.code, /response/)
  const alreadyCipher = await phone.obtainAlipayPhoneAuthorization({
    response: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    sign: 'rsa-sign',
  })
  assert.equal(called, 1)
  assert.match(alreadyCipher.code, /BBBB/)
})
