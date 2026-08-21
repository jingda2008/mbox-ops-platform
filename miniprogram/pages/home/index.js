const {
  getGuestSession,
  getMiniBootstrap,
  getReservations,
  getReservationPerformances,
  getCustomerBenefits,
  enrollMembership,
} = require('../../utils/api')
const { getRuntimeConfig } = require('../../config/index')
const { dateTime } = require('../../utils/format')
const { readWechatPhoneAuthorization } = require('../../utils/wechat-phone')
const MEMBERSHIP_INVITE_DISMISSED_KEY = 'mbox.membership.invite.dismissed.until.v1'
const HOME_CAMPAIGN_DISMISSED_PREFIX = 'mbox.home.campaign.dismissed.v1:'

function shanghaiDate() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function settled(loader, fallback) {
  return loader().then((value) => value).catch(() => fallback)
}

function performanceView(view) {
  if (!view) return null
  const schedule = view.current || view.next
  const current = Boolean(schedule && view.current && view.current.id === schedule.id)
  const schedules = (view.schedules || []).filter((item) => item.status !== 'cancelled').map((item) => ({
    id: item.id,
    performer: item.performerStageName,
    imageUrl: item.performerProfile && item.performerProfile.imageUrl,
    bio: item.performerProfile && item.performerProfile.bio || '',
    tags: item.performerProfile && ([]).concat(item.performerProfile.genres || [], item.performerProfile.styles || []).slice(0, 3).join(' · '),
    timeText: `${dateTime(item.startsAt)}–${dateTime(item.endsAt).slice(6)}`,
    stateText: item.id === (view.current && view.current.id) ? '正在演出' : item.id === (view.next && view.next.id) ? '即将开始' : '今晚场次',
  }))
  if (!schedule) return {
    hasSchedule: false,
    stateText: '今晚安排',
    summary: '当晚暂无已发布场次',
    schedules,
  }
  return {
    hasSchedule: true,
    performer: schedule.performerStageName,
    imageUrl: schedule.performerProfile && schedule.performerProfile.imageUrl,
    bio: schedule.performerProfile && schedule.performerProfile.bio || '',
    tags: schedule.performerProfile && ([]).concat(schedule.performerProfile.genres || [], schedule.performerProfile.styles || []).slice(0, 3).join(' · '),
    timeText: `${dateTime(schedule.startsAt)}–${dateTime(schedule.endsAt).slice(6)}`,
    stateText: current ? '正在演出' : '即将开始',
    summary: current ? 'LIVE NOW' : 'UP NEXT',
    schedules,
  }
}

function reservationView(items) {
  const active = (items || []).filter((item) => ['pending', 'confirmed'].includes(item.status))
    .sort((left, right) => String(left.arrivalAt).localeCompare(String(right.arrivalAt)))[0]
  if (!active) return null
  return {
    publicId: active.publicId,
    title: `${dateTime(active.arrivalAt)} · ${active.guestCount}人`,
    statusText: ({ pending: '等待门店确认', confirmed: '预约已确认', arrived: '已经到店', seated: '已经入座' })[active.status] || '状态待确认',
  }
}

const CONTENT_TAB_TARGETS = new Set([
  '/pages/home/index', '/pages/reservations/index', '/pages/order/index',
  '/pages/community/index', '/pages/profile/index',
])
const CONTENT_PAGE_TARGETS = new Set(['/pages/performances/index'])

function safeContentTarget(value) {
  return CONTENT_TAB_TARGETS.has(value) || CONTENT_PAGE_TARGETS.has(value) ? value : null
}

function contentCardView(item) {
  const targetPath = safeContentTarget(item && item.targetPath)
  return {
    code: String(item.code || ''),
    type: String(item.type || 'article'),
    eyebrow: item.type === 'show' ? 'M-BOX LIVE' : item.type === 'benefit' ? 'MEMBER EDIT' : 'M-BOX STORY',
    title: String(item.title || ''),
    summary: String(item.summary || ''),
    imageUrl: item.imageUrl || '',
    ctaLabel: String(item.ctaLabel || '查看内容'),
    targetPath,
  }
}

function activityFeatureView(item) {
  if (!item) return null
  return Object.assign({}, item, {
    dateText: dateTime(item.startsAt),
    availabilityText: item.remainingCapacity > 0 ? `余 ${item.remainingCapacity} 位` : '名额已满',
  })
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
    membershipTerms: null,
    membershipInviteVisible: false,
    membershipInviteAgreed: false,
    membershipInviteBusy: false,
    benefitCount: 0,
    upcomingActivity: null,
    editorialCards: [],
    monthlyPerformanceCard: null,
    upcomingReservation: null,
    performance: null,
    performancePanel: '',
    homeCampaign: null,
    homeCampaignVisible: false,
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
      settled(() => getReservationPerformances(shanghaiDate()), null),
      settled(() => getCustomerBenefits(), []),
    ])
    const app = getApp()
    const dismissedUntil = Number(wx.getStorageSync(MEMBERSHIP_INVITE_DISMISSED_KEY) || 0)
    const inviteVisible = Boolean(
      bootstrap && !bootstrap.membership && bootstrap.membershipTerms
      && Date.now() >= dismissedUntil
      && !app.globalData.membershipInvitePresented,
    )
    if (inviteVisible) app.globalData.membershipInvitePresented = true
    const campaign = (bootstrap.content || []).filter((item) => (
      item && item.type === 'presale'
    )).sort((left, right) => Number(left.priority || 0) - Number(right.priority || 0))[0] || null
    const campaignDismissed = campaign && Number(wx.getStorageSync(`${HOME_CAMPAIGN_DISMISSED_PREFIX}${campaign.code}`) || 0) > Date.now()
    this.setData({
      membership: bootstrap.membership || null,
      membershipTerms: bootstrap.membershipTerms || null,
      membershipInviteVisible: inviteVisible,
      benefitCount: (benefits || []).reduce((sum, item) => sum + Number(item.quantityAvailable || 0), 0),
      upcomingActivity: activityFeatureView(bootstrap.activities && bootstrap.activities.length ? bootstrap.activities[0] : null),
      editorialCards: (bootstrap.content || []).filter((item) => item && !['activity', 'show', 'presale'].includes(item.type))
        .sort((left, right) => Number(left.priority || 0) - Number(right.priority || 0))
        .slice(0, 2).map(contentCardView),
      monthlyPerformanceCard: contentCardView((bootstrap.content || []).find((item) => item && item.type === 'show') || {
        code: 'published-performance-calendar', type: 'show', title: '本月演出安排', summary: '按日期查看门店已发布的演出与舞台阵容', ctaLabel: '查看安排', targetPath: '/pages/performances/index',
      }),
      upcomingReservation: reservationView(reservations.reservations),
      performance: performanceView(performances),
      homeCampaign: campaign ? contentCardView(campaign) : null,
      homeCampaignVisible: Boolean(campaign && !campaignDismissed && !inviteVisible),
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

  openTonightSchedule() {
    if (!this.data.performance || !this.data.performance.schedules.length) {
      wx.showToast({ title: '今晚暂无已发布演出', icon: 'none' })
      return
    }
    this.setData({ performancePanel: 'tonight' })
  },

  openPerformerProfile() {
    if (!this.data.performance || !this.data.performance.hasSchedule) {
      wx.showToast({ title: '歌手与乐队资料待发布', icon: 'none' })
      return
    }
    this.setData({ performancePanel: 'performer' })
  },

  closePerformancePanel() { this.setData({ performancePanel: '' }) },

  openMonthlyPerformance() {
    wx.navigateTo({ url: '/pages/performances/index' })
  },

  openFeaturedActivity() {
    const activity = this.data.upcomingActivity
    if (!activity || !activity.publicId) return
    wx.navigateTo({ url: `/pages/community-detail/index?id=${encodeURIComponent(activity.publicId)}` })
  },

  openEditorial(event) {
    const card = this.data.editorialCards.find((item) => item.code === event.currentTarget.dataset.code)
    if (!card) return
    if (!card.targetPath || card.targetPath === '/pages/home/index') {
      wx.showModal({ title: card.title, content: card.summary, showCancel: false, confirmText: '知道了' })
      return
    }
    wx.switchTab({ url: card.targetPath })
  },

  dismissMembershipInvite() {
    const configuredHours = Number(getRuntimeConfig().membershipInviteCooldownHours)
    const cooldownHours = Number.isFinite(configuredHours) && configuredHours >= 1 && configuredHours <= 2160
      ? configuredHours : 24
    wx.setStorageSync(MEMBERSHIP_INVITE_DISMISSED_KEY, Date.now() + cooldownHours * 60 * 60 * 1000)
    this.setData({ membershipInviteVisible: false, membershipInviteAgreed: false })
  },

  onMembershipInviteAgreementChange(event) {
    const values = event && event.detail && Array.isArray(event.detail.value) ? event.detail.value : []
    this.setData({ membershipInviteAgreed: values.indexOf('agree') >= 0 })
  },

  remindMembershipInviteAgreement() {
    wx.showToast({ title: '请先阅读并勾选同意协议', icon: 'none' })
  },

  showMembershipTerms() {
    wx.navigateTo({ url: '/pages/membership-terms/index?source=mini_profile&action=view' })
  },

  openPrivacy() {
    wx.navigateTo({ url: '/pages/privacy/index' })
  },

  onAgreePrivacyAuthorization() {},

  async acceptMembershipInvite(event) {
    if (this.data.membershipInviteBusy) return
    if (!this.data.membershipInviteAgreed) {
      this.remindMembershipInviteAgreement()
      return
    }
    const terms = this.data.membershipTerms
    if (!terms) {
      wx.showToast({ title: '当前会员协议暂时无法读取', icon: 'none' })
      return
    }
    const authorization = readWechatPhoneAuthorization(event)
    if (!authorization.code) {
      wx.showToast({ title: authorization.message, icon: 'none' })
      return
    }
    this.setData({ membershipInviteBusy: true, error: '' })
    try {
      const result = await enrollMembership(terms.version, 'mini_profile', authorization.code)
      this.setData({
        membership: result.membership || null,
        membershipInviteVisible: false,
        membershipInviteAgreed: false,
      })
      wx.showToast({ title: '入会成功', icon: 'success' })
    } catch (error) {
      this.setData({ error: error.message || '入会暂时没有完成' })
      wx.showToast({ title: error.message || '入会未完成', icon: 'none' })
    } finally {
      this.setData({ membershipInviteBusy: false })
    }
  },

  declineMembershipInvite() {
    this.dismissMembershipInvite()
  },
  dismissHomeCampaign() {
    const campaign = this.data.homeCampaign
    if (campaign && campaign.code) {
      wx.setStorageSync(`${HOME_CAMPAIGN_DISMISSED_PREFIX}${campaign.code}`, Date.now() + 24 * 60 * 60 * 1000)
    }
    this.setData({ homeCampaignVisible: false })
  },
  openHomeCampaign() {
    const card = this.data.homeCampaign
    this.dismissHomeCampaign()
    if (!card || !card.targetPath || card.targetPath === '/pages/home/index') return
    if (CONTENT_TAB_TARGETS.has(card.targetPath)) wx.switchTab({ url: card.targetPath })
    else wx.navigateTo({ url: card.targetPath })
  },
  noop() {},
})
