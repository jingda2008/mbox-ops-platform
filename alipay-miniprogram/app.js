const { getRuntimeConfig } = require('./config/index')
const { applyLaunchSession } = require('./utils/session')
const { ensureCustomerSession } = require('./utils/auth')
const { customerErrorMessage } = require('./utils/customer-error')

function isActivityShareLaunch(options) {
  const launch = options && typeof options === 'object' ? options : {}
  const path = String(launch.path || '').replace(/^\/+/, '')
  const query = launch.query && typeof launch.query === 'object' ? launch.query : {}
  return path === 'pages/community-detail/index'
    && query.source === 'share'
}

function hasTableScanLaunch(options) {
  const launch = options && typeof options === 'object' ? options : {}
  const query = launch.query && typeof launch.query === 'object' ? launch.query : {}
  // applyLaunchSession remains the authority that parses and validates these
  // values. This merely marks a cold QR deep link as a new table visit so a
  // fixed physical code never inherits a prior turnover's local guest state.
  return ['token', 'tableToken', 'scene'].some((key) => String(query[key] || '').trim() !== '')
}

App({
  globalData: {
    config: null,
    tableSession: null,
  },

  onLaunch(options) {
    const config = getRuntimeConfig()
    this.globalData.config = config
    const launchSessionOptions = hasTableScanLaunch(options)
      ? Object.assign({}, options || {}, { forceTableScan: true })
      : options
    this.globalData.tableSession = applyLaunchSession(launchSessionOptions, config)
    // 分享首屏（包括畸形或已失效链接）必须先走无凭据预览并由页面统一给出
    // 404；不能因链接参数无效而提前建立预约/会员会话。
    if (isActivityShareLaunch(options)) {
      return
    }
    ensureCustomerSession().catch((error) => {
      this.globalData.identityError = customerErrorMessage(error, '支付宝访客会话初始化失败')
    })
  },

  refreshRuntime(options) {
    const config = getRuntimeConfig()
    this.globalData.config = config
    this.globalData.tableSession = applyLaunchSession(options || {}, config)
    return this.globalData.tableSession
  },
})
