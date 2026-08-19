const RELEASE_CONFIG = require('./release-config.generated')

const DEVELOPMENT_DEFAULTS = Object.freeze({
  mode: 'development',
  // DevTools 默认打现网；本机 8787 可在控制台写入 mbox.runtime.config.apiBaseUrl 覆盖。
  apiBaseUrl: 'https://mbox.shmbox.com',
  storeId: 'mbox-lujiazui',
  defaultTableCode: 'L01',
  defaultTableToken: '',
  developmentActorId: 'emp-chen',
  developmentMemberId: 'member-amy',
  allowDevDataFallback: true,
  requestTimeoutMs: 10000,
  wechatIdentityEnabled: false,
  membershipInviteCooldownHours: 720,
  identityTenantId: '',
  identityStoreId: '',
  wechatAppId: '',
})

const DEPLOYMENT_DEFAULTS = Object.freeze({
  mode: 'production',
  apiBaseUrl: '',
  storeId: '',
  defaultTableCode: '',
  defaultTableToken: '',
  developmentActorId: '',
  developmentMemberId: '',
  allowDevDataFallback: false,
  requestTimeoutMs: 10000,
  wechatIdentityEnabled: false,
  membershipInviteCooldownHours: 720,
  identityTenantId: '',
  identityStoreId: '',
  wechatAppId: '',
})

function compact(object) {
  return Object.keys(object || {}).reduce((result, key) => {
    const value = object[key]
    if (value !== undefined && value !== null && value !== '') result[key] = value
    return result
  }, {})
}

function getRuntimeConfig() {
  let envVersion = 'develop'
  try {
    envVersion = wx.getAccountInfoSync().miniProgram.envVersion || 'develop'
  } catch (_error) {
    envVersion = 'develop'
  }
  let extConfig = {}
  try {
    extConfig = wx.getExtConfigSync ? wx.getExtConfigSync() : {}
  } catch (_error) {
    extConfig = {}
  }
  const stored = envVersion === 'develop' ? (wx.getStorageSync('mbox.runtime.config') || {}) : {}
  const defaults = envVersion === 'develop' ? DEVELOPMENT_DEFAULTS : DEPLOYMENT_DEFAULTS
  const merged = Object.assign(
    {}, defaults, compact(extConfig.mbox || extConfig), compact(stored), compact(RELEASE_CONFIG),
  )
  merged.apiBaseUrl = String(merged.apiBaseUrl || '').replace(/\/$/, '')
  merged.isDevelopment = merged.mode === 'development'
  merged.envVersion = envVersion
  return merged
}

module.exports = { DEVELOPMENT_DEFAULTS, DEPLOYMENT_DEFAULTS, getRuntimeConfig }
