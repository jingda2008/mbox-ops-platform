import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

function tableScope(session) {
  const token = String(session.tableToken || '').trim()
  const cartScope = String(session.cartScope || '').trim()
  if (token && cartScope) return `session:${token}:${cartScope}`
  if (token) return `scan:${String(session.scanNonce || '').trim()}:${token}`
  return `table:${String(session.tableCode || '').trim().toUpperCase()}`
}

function product(number, name) {
  return {
    productId: `product-${String(number).padStart(4, '0')}`,
    name: name || `商品 ${number}`,
  }
}

function page(...ranges) {
  return ranges.flatMap(([start, end]) => {
    const values = []
    for (let number = start; number <= end; number += 1) {
      values.push(product(number, number === 138 ? '培恩龙舌兰(银)' : undefined))
    }
    return values
  })
}

async function loadApi(state, requestHandler) {
  const source = await readFile(new URL('../miniprogram/utils/api.js', import.meta.url), 'utf8')
  const calls = []
  const context = {
    module: { exports: {} }, exports: {},
    require(specifier) {
      if (specifier === './request') return {
        deviceKey: () => 'menu-pagination-device',
        request: async (path, options) => {
          calls.push({ path, options })
          return requestHandler(path, options, calls.length)
        },
      }
      if (specifier === './id') return { randomId: (prefix) => `${prefix}-pagination-test` }
      if (specifier === './session') return {
        getTableSession: () => state.session,
        rememberTableConnection: () => undefined,
        clearTableConnection: () => undefined,
      }
      if (specifier === './table-request-scope') return { tableRequestScope: tableScope }
      if (specifier === './auth') return {
        ensureCustomerSession: async () => true,
        renewReservationSessionOnly: () => undefined,
        isCustomerSessionInvalid: () => false,
        isWechatIdentityUnavailable: () => false,
      }
      if (specifier === './recommendation-attribution') {
        return { checkoutRecommendationAttribution: () => null }
      }
      throw new Error(`unexpected require: ${specifier}`)
    },
    wx: {
      getStorageSync: () => undefined,
      setStorageSync: () => undefined,
      removeStorageSync: () => undefined,
    },
    // Keep retry tests fast while still exercising the retry boundary.
    setTimeout: (callback) => { callback(); return 1 },
    clearTimeout: () => undefined,
  }
  vm.runInNewContext(source, context, { filename: 'miniprogram/utils/api.js' })
  return { api: context.module.exports, calls }
}

async function loadCustomerError() {
  const source = await readFile(new URL('../miniprogram/utils/customer-error.js', import.meta.url), 'utf8')
  const context = { module: { exports: {} }, exports: {} }
  vm.runInNewContext(source, context, { filename: 'miniprogram/utils/customer-error.js' })
  return context.module.exports
}

function offsetOf(path) {
  return Number(new URL(path, 'https://mini.example.test').searchParams.get('offset'))
}

test('public menu loads every page beyond 100 and deduplicates a boundary repeat', async () => {
  const pages = new Map([
    [0, page([1, 100])],
    [100, [product(100), ...page([101, 199])]],
    [200, page([200, 247])],
  ])
  const state = { session: { tableCode: '' } }
  const fixture = await loadApi(state, async (path) => {
    const items = pages.get(offsetOf(path)) || []
    return { data: items, meta: { count: items.length } }
  })

  const products = await fixture.api.getPublicMenu({})

  assert.equal(products.length, 247)
  assert.equal(products.find((item) => item.productId === 'product-0138').name, '培恩龙舌兰(银)')
  assert.deepEqual(fixture.calls.map((call) => offsetOf(call.path)), [0, 100, 200])
  assert.ok(fixture.calls.every((call) => call.path.includes('limit=100')))
  assert.ok(fixture.calls.every((call) => call.path.startsWith('/api/public/mini/menu/products?')))
})

test('guest menu preserves filters and table scope across all pages', async () => {
  const state = {
    session: { tableCode: 'A01', tableToken: 'token-a', cartScope: 'cart-scope-a' },
  }
  const fixture = await loadApi(state, async (path) => {
    const offset = offsetOf(path)
    return { data: offset === 0 ? page([1, 100]) : page([101, 112]), meta: {} }
  })

  const products = await fixture.api.getMenu({ categoryCode: 'tequila & mezcal', search: '培恩/银' })

  assert.equal(products.length, 112)
  assert.deepEqual(fixture.calls.map((call) => offsetOf(call.path)), [0, 100])
  for (const call of fixture.calls) {
    const url = new URL(call.path, 'https://mini.example.test')
    assert.equal(url.searchParams.get('categoryCode'), 'tequila & mezcal')
    assert.equal(url.searchParams.get('search'), '培恩/银')
    assert.equal(call.options.expectedTableScope, 'session:token-a:cart-scope-a')
    assert.equal(call.options.guardCookiePersistence, true)
  }
})

test('menu page retries two transient failures and then completes', async () => {
  const state = { session: { tableCode: '' } }
  let secondPageAttempts = 0
  const fixture = await loadApi(state, async (path) => {
    const offset = offsetOf(path)
    if (offset === 0) return { data: page([1, 100]), meta: {} }
    secondPageAttempts += 1
    if (secondPageAttempts < 3) {
      throw Object.assign(new Error('temporary network error'), { code: 'NETWORK_ERROR' })
    }
    return { data: page([101, 138]), meta: {} }
  })

  const products = await fixture.api.getPublicMenu({})

  assert.equal(products.length, 138)
  assert.equal(secondPageAttempts, 3)
  assert.deepEqual(fixture.calls.map((call) => offsetOf(call.path)), [0, 100, 100, 100])
})

test('menu never reports a partial catalog as complete after retries are exhausted', async () => {
  const state = { session: { tableCode: '' } }
  const fixture = await loadApi(state, async (path) => {
    if (offsetOf(path) === 0) return { data: page([1, 100]), meta: {} }
    throw Object.assign(new Error('still offline'), { code: 'NETWORK_ERROR' })
  })

  await assert.rejects(fixture.api.getPublicMenu({}), (error) => {
    assert.equal(error.code, 'MENU_CATALOG_INCOMPLETE')
    assert.equal(error.causeCode, 'NETWORK_ERROR')
    assert.equal(error.failedOffset, 100)
    assert.equal(error.partialCount, 100)
    return true
  })
  assert.deepEqual(fixture.calls.map((call) => offsetOf(call.path)), [0, 100, 100, 100])
})

test('menu stops immediately when the table changes during a page request', async () => {
  const state = {
    session: { tableCode: 'A01', tableToken: 'token-a', cartScope: 'cart-scope-a' },
  }
  const fixture = await loadApi(state, async () => {
    state.session = { tableCode: 'B02', tableToken: 'token-b', cartScope: 'cart-scope-b' }
    return { data: page([1, 100]), meta: {} }
  })

  await assert.rejects(fixture.api.getMenu({}), (error) => {
    assert.equal(error.code, 'TABLE_SESSION_SCOPE_CHANGED')
    assert.equal(error.partialCount, 0)
    return true
  })
  assert.equal(fixture.calls.length, 1)
})

test('customer copy distinguishes an incomplete menu from an expired table session', async () => {
  const customerError = await loadCustomerError()

  assert.equal(
    customerError.customerErrorMessage({ code: 'MENU_CATALOG_INCOMPLETE' }, '桌台连接已失效'),
    '菜单没有完整加载，请检查网络后重试',
  )
  assert.equal(
    customerError.customerErrorMessage({ code: 'MENU_CATALOG_CHANGED' }, '桌台连接已失效'),
    '菜单正在更新，请稍后重新加载',
  )
})
