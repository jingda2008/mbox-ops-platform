import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

export function liveMiniHarness(platform, respond, options = {}) {
  const root = resolve(new URL('..', import.meta.url).pathname, platform)
  const storage = options.storage || new Map()
  if (!storage.has('mbox.http.cookie.reservation.v2')) storage.set('mbox.http.cookie.reservation.v2', 'mbox_reservation_session=customer-a')
  let sequence = 0
  const calls = [], modals = [], nativePayments = []
  const config = { apiBaseUrl: 'https://audit.example.test', storeId: 'audit-store', requestTimeoutMs: 1000, isDevelopment: true }
  const table = { tableCode: 'A1', tableToken: 'table-a', cartScope: 'cart-a' }
  const state = { customerPublicId: 'customer-a', storageFailure: false, modalConfirm: true }
  function nativeRequest(input) {
    const call = { path: new URL(input.url).pathname, method: input.method || 'GET', data: input.data,
      headers: input.header || input.headers || {} }
    calls.push(call)
    Promise.resolve().then(() => respond(call, { state, calls, storage })).then(result => {
      if (result?.networkError) { input.fail({ errMsg: 'request:fail timeout', error: 12, errorMessage: 'network unavailable' }); return }
      const status = result?.status || 200, data = result?.data || {}
      if (platform === 'alipay-miniprogram' && status !== 200) input.fail({ error: 19, errorMessage: 'http status error', status, data: JSON.stringify(data) })
      else input.success({ status, statusCode: status, data, header: {} })
    }, error => { input.fail({ errMsg: error.message || 'request:fail', error: 12 }) })
  }
  const runtime = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => { if (state.storageFailure) throw Error('disk full'); storage.set(key, structuredClone(value)) },
    removeStorageSync: key => storage.delete(key), request: nativeRequest,
    showModal: input => { modals.push(input); input.success({ confirm: state.modalConfirm }) },
    requestPayment: input => { nativePayments.push(input); input.success({}) },
    stopPullDownRefresh() {}, showToast() {},
  }
  const my = {
    getStorageSync: ({ key }) => ({ data: storage.get(key) }),
    setStorageSync: ({ key, data }) => runtime.setStorageSync(key, data),
    removeStorageSync: ({ key }) => storage.delete(key), request: nativeRequest,
    confirm: runtime.showModal, tradePay: input => { nativePayments.push(input); input.success({ resultCode: '9000' }) },
  }
  const modules = new Map()
  function load(path) {
    const file = path.endsWith('.js') ? path : path + '.js'
    if (modules.has(file)) return modules.get(file).exports
    if (file === root + '/config/index.js') return { getRuntimeConfig: () => config }
    if (file === root + '/utils/auth.js') return { ensureCustomerSession: async () => true, ensureWechatIdentity: async () => true,
      isCustomerSessionInvalid: e => e?.statusCode === 401, isWechatIdentityUnavailable: () => false, isAlipayIdentityUnavailable: () => false,
      renewReservationSessionOnly() {}, isMembershipLoggedOut: () => false }
    if (file === root + '/utils/id.js') return { randomId: prefix => `${prefix}-audit-${++sequence}-0123456789` }
    if (file === root + '/utils/session.js') return { getTableSession: () => table, tableSessionCacheScope: () => 'table-one', rememberTableConnection() {}, clearTableConnection() {} }
    const module = { exports: {} }; modules.set(file, module)
    const source = readFileSync(file, 'utf8').replace(/^export\s+default\s+/gm, 'module.exports = ')
      .replace(/^export\s+\{\s*\n([\s\S]*?)^\}\s*$/gm, 'module.exports = {\n$1\n}')
      .replace(/^export\s+\{([^\n}]*)\}\s*$/gm, 'module.exports = {$1}')
    vm.runInNewContext(source, { module, exports: module.exports, wx: runtime, my, Date, setTimeout, clearTimeout,
      require: relative => load(resolve(dirname(file), relative)) }, { filename: file })
    return module.exports
  }
  const api = load(root + '/utils/api.js')
  const platformRuntime = platform === 'alipay-miniprogram' ? load(root + '/utils/platform.js') : runtime
  function page(name, names, globals = {}) {
    const source = readFileSync(`${root}/pages/${name}/index.js`, 'utf8')
    const tree = ts.createSourceFile('index.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    const pageNode = tree.statements.find(n => ts.isExpressionStatement(n) && ts.isCallExpression(n.expression) && n.expression.expression.getText(tree) === 'Page').expression.arguments[0]
    const selected = pageNode.properties.filter(n => names.includes(n.name?.getText(tree)))
    const obj = vm.runInNewContext(`({${selected.map(n => n.getText(tree)).join(',')}})`, {
      ...api, wx: runtime, runtime: platformRuntime, Date, setTimeout, clearTimeout,
      randomId: prefix => `${prefix}-page-${++sequence}-0123456789`, tableSessionCacheScope: () => 'table-one',
      customerErrorMessage: e => e.message, getRuntimeConfig: () => config, money: String, ...globals,
    })
    obj.data = {}; obj.setData = (patch, done) => { Object.assign(obj.data, patch); done?.() }
    return obj
  }
  return { api, page, load, root, calls, modals, storage, state, runtime, config, nativePayments }
}
