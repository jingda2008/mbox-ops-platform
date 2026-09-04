const runtime = require('../utils/platform')
const RELEASE_CONFIG = require('./release-config.generated').default

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
  alipayIdentityEnabled: false,
  alipayPaymentEnabled: false,
  alipayPhoneEnabled: false,
  alipayNotificationEnabled: false,
  membershipInviteCooldownHours: 24,
  identityTenantId: '10000000-0000-4000-8000-000000000001',
  identityStoreId: '20000000-0000-4000-8000-000000000001',
  alipayAppId: '2021006196615276',
  // 微信客服：须与小程序后台「功能 → 客服 → 微信客服」绑定的企业 ID 一致。
  wecomCorpId: 'ww205bd249a5431d8b',
  wecomCustomerServiceUrl: 'https://work.weixin.qq.com/kfid/kfca1f1f83497d7b082',
})

const DEPLOYMENT_DEFAULTS = Object.freeze({
  mode: 'production',
  apiBaseUrl: 'https://mbox.shmbox.com',
  storeId: 'mbox-lujiazui',
  defaultTableCode: '',
  defaultTableToken: '',
  developmentActorId: '',
  developmentMemberId: '',
  allowDevDataFallback: false,
  requestTimeoutMs: 10000,
  alipayIdentityEnabled: false,
  alipayPaymentEnabled: false,
  alipayPhoneEnabled: false,
  alipayNotificationEnabled: false,
  membershipInviteCooldownHours: 24,
  identityTenantId: '10000000-0000-4000-8000-000000000001',
  identityStoreId: '20000000-0000-4000-8000-000000000001',
  alipayAppId: '2021006196615276',
  wecomCorpId: 'ww205bd249a5431d8b',
  wecomCustomerServiceUrl: 'https://work.weixin.qq.com/kfid/kfca1f1f83497d7b082',
})

function compact(object) {
  return Object.keys(object || {}).reduce((result, key) => {
    const value = object[key]
    if (value !== undefined && value !== null && value !== '') result[key] = value
    return result
  }, {})
}

function getRuntimeConfig() {
  let envVersion = 'release'
  try {
    const reported = runtime.getAccountInfoSync().miniProgram.envVersion
    envVersion = ['develop', 'trial', 'release'].includes(reported) ? reported : 'release'
  } catch (_error) {
    envVersion = 'release'
  }
  let extConfig = {}
  try {
    extConfig = runtime.getExtConfigSync ? runtime.getExtConfigSync() : {}
  } catch (_error) {
    extConfig = {}
  }
  const stored = envVersion === 'develop' ? (runtime.getStorageSync('mbox.runtime.config') || {}) : {}
  const defaults = envVersion === 'develop' ? DEVELOPMENT_DEFAULTS : DEPLOYMENT_DEFAULTS
  const merged = Object.assign(
    {}, defaults, compact(extConfig.mbox || extConfig), compact(stored), compact(RELEASE_CONFIG),
  )
  // These capabilities require Alipay-specific server verification/provider
  // adapters. This frontend-only candidate must stay fail-closed even when a
  // local ext/stored/release override tries to enable them.
  merged.alipayIdentityEnabled = false
  merged.alipayPaymentEnabled = false
  merged.alipayPhoneEnabled = false
  merged.alipayNotificationEnabled = false
  merged.apiBaseUrl = String(merged.apiBaseUrl || '').replace(/\/$/, '')
  merged.isDevelopment = envVersion === 'develop' && merged.mode === 'development'
  merged.envVersion = envVersion
  return merged
}

export { DEVELOPMENT_DEFAULTS, DEPLOYMENT_DEFAULTS, getRuntimeConfig }
