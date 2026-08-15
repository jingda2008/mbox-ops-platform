const { getGuestSession, getMiniBootstrap } = require('../../utils/api')
const { getRuntimeConfig } = require('../../config/index')

Page({
  data: {
    loading: true,
    error: '',
    warning: '',
    isDevelopment: false,
    tableCode: '',
    table: null,
    membership: null,
    upcomingActivity: null,
    canEnter: false,
    hasTableSession: false,
  },

  onLoad(options) {
    const app = getApp()
    const session = app.refreshRuntime({ query: options })
    this.setData({ tableCode: session.tableCode, isDevelopment: getRuntimeConfig().isDevelopment })
    const hasTableSession = Boolean(session.tableCode && (session.tableToken || getRuntimeConfig().isDevelopment))
    this.setData({ hasTableSession })
    if (!hasTableSession) {
      this.loadData()
      return
    }
    this.loadData()
  },

  onPullDownRefresh() {
    this.loadData().finally(() => wx.stopPullDownRefresh())
  },

  async loadData() {
    this.setData({ loading: true, error: '' })
    try {
      const bootstrap = await getMiniBootstrap()
      const session = this.data.hasTableSession ? await getGuestSession() : null
      const table = session ? session.data.table : null
      this.setData({
        loading: false,
        warning: session ? session.warning : '',
        table,
        membership: bootstrap.membership,
        upcomingActivity: bootstrap.activities && bootstrap.activities.length ? bootstrap.activities[0] : null,
        canEnter: Boolean(table && (session.data.status === 'active' || session.data.status === 'already_active')),
        error: this.data.hasTableSession && !table ? `桌码 ${this.data.tableCode} 尚未完成开台，请联系门迎` : '',
      })
    } catch (error) {
      this.setData({ loading: false, error: error.message || '桌台信息载入失败' })
    }
  },

  openPage(event) {
    wx.navigateTo({ url: event.currentTarget.dataset.url })
  },
  openTab(event) { wx.switchTab({ url: event.currentTarget.dataset.url }) },
})
