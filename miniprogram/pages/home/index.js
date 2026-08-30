const {
  getGuestSession,
  getMiniBootstrap,
  getReservations,
  getReservationPerformances,
  getCustomerBenefits,
  enrollMembership,
} = require('../../utils/api')
const { getRuntimeConfig } = require('../../config/index')
const { getTableSession } = require('../../utils/session')
const { createTableRequestGuard, tableRequestScope } = require('../../utils/table-request-scope')
const { dateTime } = require('../../utils/format')
const { readWechatPhoneAuthorization } = require('../../utils/wechat-phone')
const { publicImageUrl } = require('../../utils/media')
const { customerErrorMessage } = require('../../utils/customer-error')
const { enablePublicShareMenu, publicSharePayload, publicTimelinePayload } = require('../../utils/public-share')
const MEMBERSHIP_INVITE_DISMISSED_KEY = 'mbox.membership.invite.dismissed.until.v1'
const CONTENT_ROTATION_WINDOW_MS = 6 * 60 * 60 * 1000

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
    imageUrl: publicImageUrl(item.performerProfile && item.performerProfile.imageUrl),
    bio: item.performerProfile && item.performerProfile.bio || '',
    tags: item.performerProfile && ([]).concat(item.performerProfile.genres || [], item.performerProfile.styles || []).slice(0, 3).join(' · '),
    timeText: `${dateTime(item.startsAt)}–${dateTime(item.endsAt).slice(6)}`,
    stateText: item.id === (view.current && view.current.id) ? '正在演出' : item.id === (view.next && view.next.id) ? '即将开始' : '今晚场次',
  }))
  if (!schedule) return {
    hasSchedule: false,
    stateText: '今晚安排',
    summary: '当晚暂无演出安排',
    schedules,
  }
  return {
    hasSchedule: true,
    performer: schedule.performerStageName,
    imageUrl: publicImageUrl(schedule.performerProfile && schedule.performerProfile.imageUrl),
    bio: schedule.performerProfile && schedule.performerProfile.bio || '',
    tags: schedule.performerProfile && ([]).concat(schedule.performerProfile.genres || [], schedule.performerProfile.styles || []).slice(0, 3).join(' · '),
    timeText: `${dateTime(schedule.startsAt)}–${dateTime(schedule.endsAt).slice(6)}`,
    stateText: current ? '正在演出' : '即将开始',
    summary: current ? '正在演出' : '即将开始',
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
const CONTENT_PAGE_TARGETS = new Set(['/pages/performances/index', '/pages/brand-story/index'])
const MBOX_STORY_CARD = Object.freeze({
  code: 'mbox-story-1999',
  type: 'article',
  eyebrow: 'M-BOX 故事',
  title: '从1999开始',
  summary: '一座仍在演出的城市档案',
  imageUrl: '',
  ctaLabel: '阅读全文',
  targetPath: '/pages/brand-story/index',
  displayMode: 'pinned',
  hasTarget: true,
  canOpen: true,
  isMboxStory: true,
})

function safeContentTarget(value) {
  return CONTENT_TAB_TARGETS.has(value) || CONTENT_PAGE_TARGETS.has(value) ? value : null
}

function contentCardView(item) {
  const targetPath = safeContentTarget(item && item.targetPath)
  return {
    code: String(item.code || ''),
    type: String(item.type || 'article'),
    eyebrow: item.type === 'show' ? 'M-BOX 现场演出' : item.type === 'activity' ? 'SUPERHIGH 活动' : item.type === 'presale' ? '今晚推荐' : item.type === 'benefit' ? '会员专享' : item.type === 'return_offer' ? '欢迎回来' : 'M-BOX 故事',
    title: String(item.title || ''),
    summary: String(item.summary || ''),
    imageUrl: publicImageUrl(item.imageUrl),
    ctaLabel: String(item.ctaLabel || '查看内容'),
    targetPath,
    displayMode: item.displayMode === 'pinned' ? 'pinned' : 'rotation',
    hasTarget: Boolean(targetPath && targetPath !== '/pages/home/index'),
    canOpen: true,
    isMboxStory: String(item.code || '') === MBOX_STORY_CARD.code,
  }
}

function homepageContentCards(items) {
  // 首页只保留一个固定的品牌故事入口；其他文章类内容不再生成第二张“故事”卡。
  const cards = (items || []).filter((item) => item && item.type !== 'show' && item.type !== 'article' && item.code !== MBOX_STORY_CARD.code)
    .sort((left, right) => Number(left.priority || 0) - Number(right.priority || 0))
    .map(contentCardView)
  const pinned = cards.filter((item) => item.displayMode === 'pinned')
  const rotating = cards.filter((item) => item.displayMode === 'rotation')
  if (!rotating.length) return [MBOX_STORY_CARD].concat(pinned)
  const shanghaiWindow = Math.floor((Date.now() + 8 * 60 * 60 * 1000) / CONTENT_ROTATION_WINDOW_MS)
  const rotationIndex = shanghaiWindow % rotating.length
  return [MBOX_STORY_CARD].concat(pinned, rotating[rotationIndex])
}

function activityFeatureView(item) {
  if (!item) return null
  return Object.assign({}, item, {
    coverUrl: publicImageUrl(item.coverUrl),
    dateText: dateTime(item.startsAt),
    availabilityText: item.remainingCapacity > 0 ? `余 ${item.remainingCapacity} 位` : '名额已满',
  })
}

function softNetworkError(error) {
  const message = String((error && error.message) || '')
  if (/request:fail|timeout|ERR_CONNECTION|Failed to fetch|网络/i.test(message)) {
    return ''
  }
  return customerErrorMessage(error, '桌台连接已失效，请重新扫描桌面二维码')
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
    pendingActivityId: '',
    benefitCount: 0,
    upcomingActivity: null,
    brandStoryCard: null,
    editorialCards: [],
    monthlyPerformanceCard: null,
    upcomingReservation: null,
    performance: null,
    performancePanel: '',
    editorialPanel: null,
    visitState: 'prearrival',
    canEnter: false,
    hasTableSession: false,
    connectionMessage: '',
    serviceOwner: '随时为你服务',
    guestCountText: '人数待确认',
  },

  onLoad(options) {
    const app = getApp()
    const session = app.refreshRuntime({ query: options })
    const config = getRuntimeConfig()
    this.setData({
      tableCode: session.tableCode,
      isDevelopment: config.isDevelopment,
      // 仅有桌码、没有桌台令牌时不强制拉取会话，避免开发态出现 request:fail 红条。
      hasTableSession: Boolean(session.tableToken),
    })
    this.ensureTableRequestGuard()
  },

  onShow() { enablePublicShareMenu(); this.loadData() },
  onHide() { this.stopWaitingPoll(); this.invalidateTableRequests() },
  onUnload() { this.stopWaitingPoll(); this.invalidateTableRequests() },

  onShareAppMessage() {
    return publicSharePayload({
      title: 'M-BOX · 今晚，刚刚好',
      path: '/pages/home/index',
    })
  },

  onShareTimeline() {
    return publicTimelinePayload({
      title: 'M-BOX · 今晚，刚刚好',
      path: '/pages/home/index',
    })
  },

  onPullDownRefresh() {
    this.loadData().finally(() => wx.stopPullDownRefresh())
  },

  stopWaitingPoll() {
    if (this.waitingTimer) clearTimeout(this.waitingTimer)
    this.waitingTimer = null
  },

  scheduleWaitingPoll(request) {
    this.stopWaitingPoll()
    this.waitingTimer = setTimeout(() => {
      if (!this.isCurrentTableRequest(request)) return
      this.loadTableState(true, request)
    }, 6000)
  },

  ensureTableRequestGuard() {
    if (!this.tableRequestGuard) {
      this.tableRequestGuard = createTableRequestGuard(() => tableRequestScope(getTableSession()))
    }
    return this.tableRequestGuard
  },
  beginTableRequest(session) {
    return this.ensureTableRequestGuard().begin(tableRequestScope(session || getTableSession()))
  },
  rebaseTableRequest(request) {
    const rebased = this.ensureTableRequestGuard().rebase(request, tableRequestScope(getTableSession()))
    if (rebased) this.visibleTableScope = request.scope
    return rebased
  },
  isCurrentTableRequest(request) { return this.ensureTableRequestGuard().isCurrent(request) },
  invalidateTableRequests() { this.ensureTableRequestGuard().invalidate() },

  resetTableScope(session) {
    this.stopWaitingPoll()
    this.setData({
      tableCode: session.tableCode || '',
      hasTableSession: Boolean(session.tableToken),
      table: null,
      warning: '',
      visitState: 'prearrival',
      canEnter: false,
      connectionMessage: '',
      serviceOwner: '随时为你服务',
      guestCountText: '人数待确认',
    })
  },

  async loadData() {
    this.stopWaitingPoll()
    const session = getTableSession()
    const request = this.beginTableRequest(session)
    const scopeChanged = this.visibleTableScope !== request.scope
    this.visibleTableScope = request.scope
    if (scopeChanged) this.resetTableScope(session)
    this.setData({ loading: true, error: '', tableCode: session.tableCode || '', hasTableSession: Boolean(session.tableToken) })
    const [bootstrap, reservations, performances, benefits] = await Promise.all([
      settled(() => getMiniBootstrap(), { membership: null, activities: [] }),
      settled(() => getReservations(), { reservations: [] }),
      settled(() => getReservationPerformances(shanghaiDate()), null),
      settled(() => getCustomerBenefits(), []),
    ])
    if (!this.isCurrentTableRequest(request)) return
    const app = getApp()
    const homepageCards = homepageContentCards(bootstrap.content)
    this.setData({
      membership: bootstrap.membership || null,
      membershipTerms: bootstrap.membershipTerms || null,
      membershipInviteVisible: false,
      benefitCount: (benefits || []).reduce((sum, item) => sum + Number(item.quantityAvailable || 0), 0),
      upcomingActivity: activityFeatureView(bootstrap.activities && bootstrap.activities.length ? bootstrap.activities[0] : null),
      brandStoryCard: homepageCards.find((item) => item.isMboxStory) || MBOX_STORY_CARD,
      editorialCards: homepageCards.filter((item) => !item.isMboxStory),
      monthlyPerformanceCard: contentCardView((bootstrap.content || []).find((item) => item && item.type === 'show') || {
        code: 'published-performance-calendar', type: 'show', title: '本月演出安排', summary: '按日期查看演出与舞台阵容', ctaLabel: '查看安排', targetPath: '/pages/performances/index',
      }),
      upcomingReservation: reservationView(reservations.reservations),
      performance: performanceView(performances),
    })
    if (!session.tableToken) {
      this.setData({ loading: false, visitState: 'prearrival', canEnter: false, table: null })
      return
    }
    await this.loadTableState(false, request)
  },

  async loadTableState(silent, request) {
    const tableRequest = request || this.beginTableRequest()
    if (!this.isCurrentTableRequest(tableRequest)) return
    if (!silent) this.setData({ loading: true })
    try {
      const result = await getGuestSession()
      // The scan starts with a fixed-QR scope. A verified response upgrades it
      // to cartScope; keep this same request current while rejecting any older
      // scan generation that arrived in the meantime.
      if (!this.rebaseTableRequest(tableRequest)) return
      if (!this.isCurrentTableRequest(tableRequest)) return
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
        serviceOwner: session.primaryServiceName || '随时为你服务',
        guestCountText: Number(session.guestCount) > 0 ? `${Number(session.guestCount)}位` : '人数待确认',
        error: '',
      })
      if (waiting) this.scheduleWaitingPoll(tableRequest)
    } catch (error) {
      if (!this.isCurrentTableRequest(tableRequest)) return
      this.setData({
        loading: false,
        visitState: 'prearrival',
        canEnter: false,
        table: null,
        error: silent ? this.data.error : softNetworkError(error),
      })
    }
  },

  retryTable() { this.loadTableState(false) },
  openPage(event) { wx.navigateTo({ url: event.currentTarget.dataset.url }) },
  openTab(event) { wx.switchTab({ url: event.currentTarget.dataset.url }) },

  openTonightSchedule() {
    const performance = this.data.performance
    if (!performance || !(performance.schedules && performance.schedules.length)) {
      wx.showToast({ title: '今晚暂无演出安排', icon: 'none' })
      return
    }
    this.setData({ performancePanel: 'tonight' })
  },

  openPerformerProfile() {
    const performance = this.data.performance
    if (performance && performance.hasSchedule) {
      this.setData({ performancePanel: 'performer' })
      return
    }
    if (performance && performance.schedules && performance.schedules.length) {
      this.setData({ performancePanel: 'tonight' })
      return
    }
    wx.navigateTo({ url: '/pages/performances/index' })
  },

  closePerformancePanel() { this.setData({ performancePanel: '' }) },

  openMonthlyPerformance() {
    const card = this.data.monthlyPerformanceCard
    const target = card && card.targetPath
    if (target && target !== '/pages/home/index') {
      if (CONTENT_TAB_TARGETS.has(target)) wx.switchTab({ url: target })
      else wx.navigateTo({ url: target })
      return
    }
    wx.navigateTo({ url: '/pages/performances/index' })
  },

  openFeaturedActivity() {
    const activity = this.data.upcomingActivity
    if (!activity || !activity.publicId) return
    if (!this.data.membership) {
      if (!this.data.membershipTerms) {
        wx.showToast({ title: '当前会员协议暂时无法读取', icon: 'none' })
        return
      }
      this.setData({
        membershipInviteVisible: true,
        membershipInviteAgreed: false,
        pendingActivityId: activity.publicId,
      })
      return
    }
    wx.navigateTo({ url: `/pages/community-detail/index?id=${encodeURIComponent(activity.publicId)}` })
  },

  openEditorial(event) {
    const cards = [this.data.brandStoryCard].concat(this.data.editorialCards || []).filter(Boolean)
    const card = cards.find((item) => item.code === event.currentTarget.dataset.code)
    if (!card) return
    if (card.isMboxStory) {
      wx.navigateTo({ url: '/pages/brand-story/index' })
      return
    }
    if (card.type === 'article' || !card.hasTarget) {
      this.setData({ editorialPanel: card })
      return
    }
    this.openEditorialTarget(card)
  },

  closeEditorial() { this.setData({ editorialPanel: null }) },

  openEditorialTarget(candidate) {
    const card = candidate && candidate.targetPath ? candidate : this.data.editorialPanel
    const target = card && card.targetPath
    if (!target || target === '/pages/home/index') return this.closeEditorial()
    this.closeEditorial()
    if (CONTENT_TAB_TARGETS.has(target)) wx.switchTab({ url: target })
    else wx.navigateTo({ url: target })
  },

  openMembershipInvite() {
    if (this.data.membership || !this.data.membershipTerms) return
    this.setData({ membershipInviteVisible: true, membershipInviteAgreed: false, pendingActivityId: '' })
  },

  dismissMembershipInvite() {
    const configuredHours = Number(getRuntimeConfig().membershipInviteCooldownHours)
    const cooldownHours = Number.isFinite(configuredHours) && configuredHours >= 1 && configuredHours <= 2160
      ? configuredHours : 24
    wx.setStorageSync(MEMBERSHIP_INVITE_DISMISSED_KEY, Date.now() + cooldownHours * 60 * 60 * 1000)
    this.setData({ membershipInviteVisible: false, membershipInviteAgreed: false, pendingActivityId: '' })
  },

  onMembershipInviteAgreementChange(event) {
    const values = event && event.detail && Array.isArray(event.detail.value) ? event.detail.value : []
    this.setData({ membershipInviteAgreed: values.indexOf('agree') >= 0 })
  },

  remindMembershipInviteAgreement() {
    wx.showToast({ title: '请先勾选同意协议', icon: 'none' })
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
      const membership = result.membership || null
      if (!membership) throw new Error('会员状态暂时未刷新，请稍后重试')
      const pendingActivityId = this.data.pendingActivityId
      this.setData({
        membership,
        membershipInviteVisible: false,
        membershipInviteAgreed: false,
        pendingActivityId: '',
      })
      wx.showToast({ title: '入会成功', icon: 'success' })
      if (pendingActivityId) {
        wx.navigateTo({ url: `/pages/community-detail/index?id=${encodeURIComponent(pendingActivityId)}` })
      }
    } catch (error) {
      this.setData({ error: customerErrorMessage(error, '入会暂时没有完成') })
      wx.showToast({ title: customerErrorMessage(error, '入会未完成'), icon: 'none' })
    } finally {
      this.setData({ membershipInviteBusy: false })
    }
  },

  declineMembershipInvite() {
    this.dismissMembershipInvite()
  },
  noop() {},
})
