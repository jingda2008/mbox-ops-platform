const { getRuntimeConfig } = require('./config/index')
const { applyLaunchSession } = require('./utils/session')
const { ensureCustomerSession } = require('./utils/auth')
const { customerErrorMessage } = require('./utils/customer-error')

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
      this.globalData.identityError = customerErrorMessage(error, '微信身份初始化失败')
    })
  },

  refreshRuntime(options) {
    const config = getRuntimeConfig()
    this.globalData.config = config
    this.globalData.tableSession = applyLaunchSession(options || {}, config)
    return this.globalData.tableSession
  },
})
