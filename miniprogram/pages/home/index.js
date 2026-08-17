const {
  getGuestSession,
  getMiniBootstrap,
  getReservations,
  getTodayPerformances,
  getCustomerBenefits,
} = require('../../utils/api')
const { getRuntimeConfig } = require('../../config/index')
const { dateTime } = require('../../utils/format')

function settled(loader, fallback) {
  return loader().then((value) => value).catch(() => fallback)
}

function performanceView(view) {
  if (!view) return null
  const schedule = view.current || view.next
  if (!schedule) return null
  const current = Boolean(view.current && view.current.id === schedule.id)
  return {
    performer: schedule.performerStageName,
    imageUrl: schedule.performerProfile && schedule.performerProfile.imageUrl,
    timeText: `${dateTime(schedule.startsAt)}–${dateTime(schedule.endsAt).slice(6)}`,
    stateText: current ? '正在演出' : '下一场',
    summary: current ? '现场正在进行' : '今晚即将登台',
  }
}

function reservationView(items) {
  const active = (items || []).filter((item) => !['cancelled', 'expired', 'no_show'].includes(item.status))
    .sort((left, right) => String(left.arrivalAt).localeCompare(String(right.arrivalAt)))[0]
  if (!active) return null
  return {
    publicId: active.publicId,
    title: `${dateTime(active.arrivalAt)} · ${active.guestCount}人`,
    statusText: ({ pending: '等待门店确认', confirmed: '预约已确认', arrived: '已经到店', seated: '已经入座' })[active.status] || '状态待确认',
  }
}

Page({
  data: {
    loading: true,
    error: '',
    warning: '',
    isDevelopment: false,
    tableCode: '',
    table: null,
    membership: null,
    benefitCount: 0,
    upcomingActivity: null,
    upcomingReservation: null,
    performance: null,
    visitState: 'prearrival',
    canEnter: false,
    hasTableSession: false,
    connectionMessage: '',
    serviceOwner: '现场服务组',
    guestCountText: '人数待确认',
  },

  onLoad(options) {
    const app = getApp()
    const session = app.refreshRuntime({ query: options })
    const config = getRuntimeConfig()
    this.setData({
      tableCode: session.tableCode,
      isDevelopment: config.isDevelopment,
      hasTableSession: Boolean(session.tableToken || (config.isDevelopment && session.tableCode)),
    })
  },

  onShow() { this.loadData() },
  onHide() { this.stopWaitingPoll() },
  onUnload() { this.stopWaitingPoll() },

  onPullDownRefresh() {
    this.loadData().finally(() => wx.stopPullDownRefresh())
  },

  stopWaitingPoll() {
    if (this.waitingTimer) clearTimeout(this.waitingTimer)
    this.waitingTimer = null
  },

  scheduleWaitingPoll() {
    this.stopWaitingPoll()
    this.waitingTimer = setTimeout(() => this.loadTableState(true), 6000)
  },

  async loadData() {
    this.stopWaitingPoll()
    this.setData({ loading: true, error: '' })
    const [bootstrap, reservations, performances, benefits] = await Promise.all([
      settled(() => getMiniBootstrap(), { membership: null, activities: [] }),
      settled(() => getReservations(), { reservations: [] }),
      settled(() => getTodayPerformances(), null),
      settled(() => getCustomerBenefits(), []),
    ])
    this.setData({
      membership: bootstrap.membership || null,
      benefitCount: (benefits || []).reduce((sum, item) => sum + Number(item.quantityAvailable || 0), 0),
      upcomingActivity: bootstrap.activities && bootstrap.activities.length ? bootstrap.activities[0] : null,
      upcomingReservation: reservationView(reservations.reservations),
      performance: performanceView(performances),
    })
    if (!this.data.hasTableSession) {
      this.setData({ loading: false, visitState: 'prearrival', canEnter: false, table: null })
      return
    }
    await this.loadTableState(false)
  },

  async loadTableState(silent) {
    if (!silent) this.setData({ loading: true })
    try {
      const result = await getGuestSession()
      const session = result.data || {}
      const active = session.status === 'active' || session.status === 'already_active'
      const waiting = session.status === 'waiting_for_table'
      this.setData({
        loading: false,
        warning: result.warning || '',
        table: session.table || null,
        canEnter: active,
        visitState: active ? 'active' : waiting ? 'waiting' : 'prearrival',
        connectionMessage: session.message || (waiting ? '桌位已识别，等待工作人员开台。' : ''),
        serviceOwner: session.primaryServiceName || '现场服务组',
        guestCountText: Number(session.guestCount) > 0 ? `${Number(session.guestCount)}位` : '人数待确认',
        error: '',
      })
      if (waiting) this.scheduleWaitingPoll()
    } catch (error) {
      this.setData({
        loading: false,
        visitState: 'prearrival',
        canEnter: false,
        table: null,
        error: error.message || '桌台连接已失效，请重新扫描桌面二维码',
      })
    }
  },

  retryTable() { this.loadTableState(false) },
  openPage(event) { wx.navigateTo({ url: event.currentTarget.dataset.url }) },
  openTab(event) { wx.switchTab({ url: event.currentTarget.dataset.url }) },
})
