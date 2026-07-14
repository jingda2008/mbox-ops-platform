const { getGuestSession } = require('../../utils/api')
const { getRuntimeConfig } = require('../../config/index')
const { money } = require('../../utils/format')

Page({
  data: {
    loading: true,
    error: '',
    warning: '',
    isDevelopment: false,
    tableCode: '',
    table: null,
    ownerName: '正在安排',
    storeName: 'M-Box',
    openTaskCount: 0,
    accountBalance: '¥0.00',
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
      this.setData({ loading: false, error: '尚未识别桌码；仍可预约，到店入桌后请扫描桌码使用现场服务' })
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
      const result = await getGuestSession()
      const data = result.data
      const table = data.table
      if (!table) {
        this.setData({ loading: false, warning: result.warning, error: `桌码 ${this.data.tableCode} 无效，请联系现场服务人员` })
        return
      }
      const openStatuses = ['pending', 'accepted', 'arrived', 'completed', 'reopened', 'escalated']
      const openTaskCount = (data.tasks || []).filter((task) => openStatuses.includes(task.status)).length
      this.setData({
        loading: false,
        warning: result.warning,
        table,
        ownerName: data.primaryServiceName || '正在安排',
        storeName: data.store ? data.store.name : 'M-Box',
        openTaskCount,
        accountBalance: money(data.account.balanceAmount),
        canEnter: table.occupied,
        error: table.status === 'occupied' ? '' : '当前桌台尚未开台，请呼叫迎宾确认后再进入',
      })
    } catch (error) {
      this.setData({ loading: false, error: error.message || '桌台信息载入失败' })
    }
  },

  openPage(event) {
    if (!this.data.canEnter) return
    wx.navigateTo({ url: event.currentTarget.dataset.url })
  },

  openReservation() {
    wx.navigateTo({ url: '/pages/reservations/index' })
  },
})
