function decodeScene(scene) {
  if (!scene) return {}
  try {
    const decoded = String(decodeURIComponent(String(scene))).trim()
    if (/^[A-Za-z0-9_-]{32}$/.test(decoded)) return { token: decoded }
    const result = {}
    for (const pair of decoded.split('&')) {
      const separator = pair.indexOf('=')
      if (separator < 1) throw new Error('scene格式无效')
      const key = decodeURIComponent(pair.slice(0, separator))
      const value = decodeURIComponent(pair.slice(separator + 1))
      if (!['token', 'tableToken', 'table', 'tableCode'].includes(key) || !value || result[key] !== undefined) {
        throw new Error('scene格式无效')
      }
      result[key] = value
    }
    return result
  } catch {
    throw new Error('桌码scene无效，无法识别当前桌位')
  }
}

function normalizeTableCode(value) {
  return String(value || '').trim().toUpperCase().slice(0, 32)
}

function applyLaunchSession(options, config) {
  const launch = options && typeof options === 'object' ? options : {}
  const rawQuery = launch.query && typeof launch.query === 'object' ? launch.query : {}
  const forceTableScan = launch.forceTableScan === true
  const sceneQuery = decodeScene(rawQuery.scene)
  const explicitToken = consistentAlias(rawQuery.token, rawQuery.tableToken, '桌码凭证')
  const sceneToken = consistentAlias(sceneQuery.token, sceneQuery.tableToken, 'scene桌码凭证')
  const explicitTable = consistentAlias(rawQuery.table, rawQuery.tableCode, '桌号')
  const sceneTable = consistentAlias(sceneQuery.table, sceneQuery.tableCode, 'scene桌号')
  const tableToken = consistentAlias(sceneToken, explicitToken, 'scene与query桌码凭证')
  const tableCodeInput = consistentAlias(sceneTable, explicitTable, 'scene与query桌号')
  const previous = wx.getStorageSync('mbox.table.session') || {}
  const connection = wx.getStorageSync('mbox.table.connection.state') || {}
  const connectionAge = Date.now() - Date.parse(connection.updatedAt || '')
  const recoverWaiting = connection.status === 'waiting_for_table' && connectionAge >= 0 && connectionAge <= 30 * 60 * 1000
  const mayReusePrevious = config.isDevelopment || recoverWaiting
  const tableCode = normalizeTableCode(tableCodeInput || (mayReusePrevious ? previous.tableCode : '') || config.defaultTableCode)
  const resolvedToken = validateTableToken(tableToken || (mayReusePrevious ? previous.tableToken : '') || config.defaultTableToken || '')
  // A table credential identifies one billable table visit.  A fresh scan (or
  // a cold unscanned launch after a prior visit) must never carry the old
  // guest credential forward into the next table.  Keep the reservation and
  // membership storage domains untouched.
  const tokenChanged = resolvedToken !== String(previous.tableToken || '')
  const startsNewTableScan = Boolean(resolvedToken) && (forceTableScan || tokenChanged)
  // Re-scanning a fixed physical QR after turnover must start a new local
  // generation even when its credential text has not changed. It clears only
  // the guest-table domain; reservation and member credentials stay intact.
  if (startsNewTableScan) clearTableConnection()
  const previousScanNonce = normalizeScanNonce(previous.scanNonce)
  const scanNonce = resolvedToken
    ? (startsNewTableScan || !previousScanNonce ? createScanNonce() : previousScanNonce)
    : ''
  const session = {
    tableCode,
    tableToken: resolvedToken,
    // cartScope is issued by the server after it has identified a concrete
    // table session. Never carry it across a new scan generation.
    cartScope: startsNewTableScan ? '' : normalizeCartScope(previous.cartScope),
    scanNonce,
    enteredAt: new Date().toISOString(),
  }
  wx.setStorageSync('mbox.table.session', session)
  return session
}

function consistentAlias(left, right, label) {
  const first = String(left || '').trim()
  const second = String(right || '').trim()
  if (first && second && first !== second) throw new Error(`${label}参数冲突`)
  return first || second
}

function validateTableToken(value) {
  const token = String(value || '').trim()
  if (!token) return ''
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('桌码凭证格式无效')
  return token
}

function getTableSession() {
  const app = getApp()
  return app.globalData.tableSession || wx.getStorageSync('mbox.table.session') || {}
}

function tableSessionCacheScope(value) {
  const session = value && typeof value === 'object' ? value : getTableSession()
  const tableCode = normalizeTableCode(session.tableCode) || 'unbound'
  const token = String(session.tableToken || '')
  const cartScope = normalizeCartScope(session.cartScope)
  // A table code can be reused after turnover. Keep local-only service records
  // scoped to the scanned credential without exposing that credential itself
  // in a storage key.
  let hash = 2166136261
  for (const character of `${token}:${cartScope}`) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return `${tableCode}.${(hash >>> 0).toString(36)}`
}

function updateTableToken(tableToken) {
  const current = getTableSession()
  const session = Object.assign({}, current, { tableToken: String(tableToken || '') })
  const app = getApp()
  app.globalData.tableSession = session
  wx.setStorageSync('mbox.table.session', session)
  return session
}

function rememberTableConnection(value) {
  const current = getTableSession()
  const state = Object.assign({ status: 'unknown', updatedAt: new Date().toISOString() }, value || {}, {
    scanNonce: normalizeScanNonce(current.scanNonce),
  })
  wx.setStorageSync('mbox.table.connection.state', state)
  const connectedTableCode = normalizeTableCode(state.table && (state.table.code || state.table.tableCode))
  if (connectedTableCode) {
    const session = Object.assign({}, current, {
      tableCode: connectedTableCode,
      cartScope: normalizeCartScope(state.cartScope),
    })
    const app = getApp()
    app.globalData.tableSession = session
    wx.setStorageSync('mbox.table.session', session)
  }
  return state
}

function normalizeCartScope(value) {
  const scope = String(value || '').trim()
  return /^[A-Za-z0-9_-]{16,64}$/.test(scope) ? scope : ''
}

function normalizeScanNonce(value) {
  const nonce = String(value || '').trim()
  return /^[A-Za-z0-9_-]{8,80}$/.test(nonce) ? nonce : ''
}

function createScanNonce() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

function getTableConnection() {
  return wx.getStorageSync('mbox.table.connection.state') || { status: 'unknown' }
}

function clearTableConnection() {
  wx.removeStorageSync('mbox.connected.table.token')
  wx.removeStorageSync('mbox.table.connection.state')
  wx.removeStorageSync('mbox.http.cookie.guest.v2')
  wx.removeStorageSync('mbox.pending.guest.payment.v1')
}

module.exports = {
  applyLaunchSession,
  getTableSession,
  tableSessionCacheScope,
  normalizeTableCode,
  updateTableToken,
  rememberTableConnection,
  getTableConnection,
  clearTableConnection,
}
