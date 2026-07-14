const { getRuntimeConfig } = require('./config/index')
const { applyLaunchSession } = require('./utils/session')
const { ensureCustomerSession } = require('./utils/auth')

App({
  globalData: {
    config: null,
    tableSession: null,
  },

  onLaunch(options) {
    const config = getRuntimeConfig()
    this.globalData.config = config
    this.globalData.tableSession = applyLaunchSession(options, config)
    ensureCustomerSession().catch((error) => {
      this.globalData.identityError = error.message || '微信身份初始化失败'
    })
  },

  refreshRuntime(options) {
    const config = getRuntimeConfig()
    this.globalData.config = config
    this.globalData.tableSession = applyLaunchSession(options || {}, config)
    return this.globalData.tableSession
  },
})
