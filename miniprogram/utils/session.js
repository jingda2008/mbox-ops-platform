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
  if (resolvedToken && resolvedToken !== previous.tableToken) {
    wx.removeStorageSync('mbox.connected.table.token')
    wx.removeStorageSync('mbox.table.connection.state')
  }
  const session = { tableCode, tableToken: resolvedToken, enteredAt: new Date().toISOString() }
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

function updateTableToken(tableToken) {
  const current = getTableSession()
  const session = Object.assign({}, current, { tableToken: String(tableToken || '') })
  const app = getApp()
  app.globalData.tableSession = session
  wx.setStorageSync('mbox.table.session', session)
  return session
}

function rememberTableConnection(value) {
  const state = Object.assign({ status: 'unknown', updatedAt: new Date().toISOString() }, value || {})
  wx.setStorageSync('mbox.table.connection.state', state)
  const connectedTableCode = normalizeTableCode(state.table && (state.table.code || state.table.tableCode))
  if (connectedTableCode) {
    const current = getTableSession()
    const session = Object.assign({}, current, { tableCode: connectedTableCode })
    const app = getApp()
    app.globalData.tableSession = session
    wx.setStorageSync('mbox.table.session', session)
  }
  return state
}

function getTableConnection() {
  return wx.getStorageSync('mbox.table.connection.state') || { status: 'unknown' }
}

function clearTableConnection() {
  wx.removeStorageSync('mbox.connected.table.token')
  wx.removeStorageSync('mbox.table.connection.state')
}

module.exports = {
  applyLaunchSession,
  getTableSession,
  normalizeTableCode,
  updateTableToken,
  rememberTableConnection,
  getTableConnection,
  clearTableConnection,
}
