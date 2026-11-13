const { randomId } = require('./id')
const { getTableSession } = require('./session')
const { getRuntimeConfig } = require('../config/index')

const flights = new Map()
const SAFE_REPLAY_MS = 23 * 60 * 60 * 1000
// Lookup checksum only; server authorization and request fingerprints remain mandatory.
function checksum(text) {
  let a = 2166136261, b = 5381
  for (let i = 0; i < text.length; i += 1) {
    a = Math.imul(a ^ text.charCodeAt(i), 16777619)
    b = Math.imul(b, 33) ^ text.charCodeAt(i)
  }
  return `${(a >>> 0).toString(36)}-${(b >>> 0).toString(36)}`
}
function failure(code, message) { return Object.assign(new Error(message), { code }) }
function recoveryScope(options) {
  const session = getTableSession(), config = getRuntimeConfig()
  const principal = wx.getStorageSync('mbox.wechat.identity.principal.v1') || {}
  const identity = principal.principalId || principal.memberId
    || wx.getStorageSync('mbox.public.identity.assertion')
    || wx.getStorageSync('mbox.http.cookie.reservation.v2') || 'guest'
  return JSON.stringify([config.apiBaseUrl, config.storeId,
    options && options.customerOnly ? 'customer' : session.cartScope || session.scanNonce || 'unbound',
    identity, wx.getStorageSync('mbox.membership.loggedOut.v1') || ''])
}
function recoverableGuestCommand(operation, body, send, options) {
  // Reject before sending when persistence cannot prove the original request.
  // No cookies, QR credentials or customer input are stored in this journal.
  try {
    const scope = recoveryScope(options), bodyHash = checksum(JSON.stringify(body))
    const storageKey = `mbox.command.v2:${checksum(scope)}:${checksum(operation)}`
    const session = getTableSession(), principal = wx.getStorageSync('mbox.wechat.identity.principal.v1') || {}
    const oldScope = JSON.stringify([options && options.customerOnly ? 'customer' : session.cartScope || session.scanNonce || 'unbound', principal.principalId || principal.memberId || 'guest'])
    const legacyKey = `mbox.command.v1:${checksum(oldScope)}:${checksum((options && options.legacyOperation || operation) + JSON.stringify(body))}`
    const exists = value => value !== undefined && value !== null && value !== ''
    // wx returns '' for a missing key. getStorageInfoSync distinguishes a
    // persisted empty/corrupt record on real devices; test stores use undefined.
    const stored = wx.getStorageSync(storageKey)
    const hasKey = key => typeof wx.getStorageInfoSync === 'function' && (wx.getStorageInfoSync().keys || []).includes(key)
    const legacyScopePrefix = `mbox.command.v1:${checksum(oldScope)}:`
    const oldScopeExists = typeof wx.getStorageInfoSync === 'function' && (wx.getStorageInfoSync().keys || []).some(key => key.startsWith(legacyScopePrefix))
    if (oldScopeExists || exists(wx.getStorageSync(legacyKey)) || hasKey(legacyKey)) throw failure('COMMAND_RECOVERY_REVIEW_REQUIRED', '旧版请求结果待核对，请查看当前状态或联系门店，暂不重复提交。')
    for (const key of options && options.legacyKeys || []) {
      if (exists(wx.getStorageSync(key)) || hasKey(key)) throw failure('COMMAND_RECOVERY_REVIEW_REQUIRED', '旧版请求结果待核对，请查看当前状态或联系门店，暂不重复提交。')
    }
    const recovery = stored !== undefined && stored !== null && (stored !== '' || hasKey(storageKey))
    if (recovery && (!stored || stored.version !== 2 || typeof stored.key !== 'string' || stored.key.length < 8
      || !Number.isFinite(stored.createdAt) || typeof stored.bodyHash !== 'string')) {
      throw failure('COMMAND_RECOVERY_RECORD_INVALID', '本机原请求记录无法核对，请联系门店确认，避免重复操作。')
    }
    if (recovery && stored.bodyHash !== bodyHash) throw failure('COMMAND_RECOVERY_PENDING', '上次操作结果尚未确认，请先恢复原请求或联系门店核对，再修改内容。')
    const prior = flights.get(storageKey)
    if (prior) return prior.promise
    const record = recovery ? stored : { version: 2, key: options && options.initialKey || randomId('guest-command'), bodyHash, createdAt: Date.now() }
    if (Date.now() - record.createdAt < 0 || Date.now() - record.createdAt > SAFE_REPLAY_MS) {
      throw failure('COMMAND_RECOVERY_EXPIRED', '原请求已超过安全重试时间，请查看当前状态或联系门店核对，本次不会重新执行。')
    }
    wx.setStorageSync(storageKey, record)
    const persisted = wx.getStorageSync(storageKey)
    if (!persisted || persisted.key !== record.key || persisted.bodyHash !== record.bodyHash || persisted.createdAt !== record.createdAt) throw failure('COMMAND_RECOVERY_RECORD_INVALID', '原请求无法可靠保存，本次没有提交，请稍后重试。')
    const assertCurrent = () => {
      if (recoveryScope(options) !== scope) throw failure('COMMAND_RECOVERY_SCOPE_CHANGED', '身份或桌台已变化，原请求已保留，请重新核对当前状态。')
    }
    const clear = () => {
      const current = wx.getStorageSync(storageKey)
      if (current && current.key === record.key) wx.removeStorageSync(storageKey)
    }
    const pending = { promise: null }
    pending.promise = Promise.resolve().then(() => { assertCurrent(); return send(record.key, { recovery }) }).then(result => {
      assertCurrent()
      if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length === 0 || ('data' in result && (!result.data || typeof result.data !== 'object'))) throw failure('COMMAND_RECOVERY_UNCONFIRMED', '操作回执暂时无法确认，请核对原请求，不要重复提交。')
      clear(); return result
    }, error => {
      assertCurrent()
      const status = Number(error && (error.statusCode || error.status))
      // A later rejection cannot prove the earlier timed-out request failed.
      // Only opted-in commands may trust an explicit rollback on their FIRST send.
      // A later rejection cannot resolve an earlier lost response.
      const knownNotCommitted = options && options.clearOnNotCommitted
        && error && error.commitDisposition === 'not_committed' && [400, 403, 404, 409, 422].includes(status)
      if (!recovery && ([400, 422].includes(status) || knownNotCommitted)) clear()
      throw error
    }).finally(() => { if (flights.get(storageKey) === pending) flights.delete(storageKey) })
    flights.set(storageKey, pending)
    return pending.promise
  } catch (error) { return Promise.reject(error) }
}
// Digest is only a local ownership boundary; never an authorization credential.
function commandIdentityScope() { return checksum(recoveryScope({ customerOnly: true })) }
module.exports = { recoverableGuestCommand, commandIdentityScope }
