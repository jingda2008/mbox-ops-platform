function decodeScene(scene) {
  if (!scene) return {}
  try {
    return String(decodeURIComponent(scene)).split('&').reduce((result, pair) => {
      const separator = pair.indexOf('=')
      if (separator === -1) return result
      result[pair.slice(0, separator)] = pair.slice(separator + 1)
      return result
    }, {})
  } catch (_error) {
    return {}
  }
}

function normalizeTableCode(value) {
  return String(value || '').trim().toUpperCase().slice(0, 32)
}

function applyLaunchSession(options, config) {
  const query = Object.assign({}, decodeScene(options.scene), options.query || {})
  const previous = wx.getStorageSync('mbox.table.session') || {}
  const tableCode = normalizeTableCode(query.table || query.tableCode || (config.isDevelopment ? previous.tableCode : '') || config.defaultTableCode)
  const tableToken = String(query.token || query.tableToken || (config.isDevelopment ? previous.tableToken : '') || config.defaultTableToken || '')
  const session = { tableCode, tableToken, enteredAt: new Date().toISOString() }
  wx.setStorageSync('mbox.table.session', session)
  return session
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

module.exports = { applyLaunchSession, getTableSession, normalizeTableCode, updateTableToken }
