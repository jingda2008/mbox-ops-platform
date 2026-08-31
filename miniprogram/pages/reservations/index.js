const {
  getMiniBootstrap,
  getReservations,
  getReservationAvailability,
  getReservationPerformances,
  createCustomerReservation,
  cancelCustomerReservation,
  getReservationPerformanceImpacts,
  acknowledgeReservationPerformanceImpact,
  getReservationPerformanceNotificationAuthorizations,
  getWechatNotificationPrompt,
  getWechatNotificationAuthorizations,
  getWechatMemberServiceNotificationAuthorizations,
} = require('../../utils/api')
const { redirectToMembershipLogin } = require('../../utils/membership-gate')
const { randomId } = require('../../utils/id')
const { getRuntimeConfig } = require('../../config/index')
const { money, dateTime } = require('../../utils/format')
const { customerErrorCode, customerErrorMessage } = require('../../utils/customer-error')
const { enablePublicShareMenu, publicSharePayload, publicTimelinePayload } = require('../../utils/public-share')
const {
  requestWechatSubscriptionFromTap,
  mergeWechatNotificationPromptOptions,
  extractPromptPresentation,
  buildReservationSubscriptionPresentation,
  RESERVATION_SUCCESS_SUBSCRIBE_TYPES,
} = require('../../utils/wechat-subscription')
const {
  rememberPresentationOptions,
  resolvePresentationOptions,
} = require('../../utils/wechat-subscription-presentation-cache')

const STATUS_NAMES = { pending: '等待门店确认', confirmed: '预约已确认', arrived: '已经到店', seated: '已经入座', cancelled: '已取消', no_show: '未到店', expired: '已失效' }
// “我的预约”只保留顾客仍能执行或等待门店确认的记录。到店、入座、过期等
// 历史仍由服务端和员工端保留，不能为了简化页面而删除业务事实。
const EXECUTABLE_RESERVATION_STATUSES = new Set(['pending', 'confirmed'])
const DEFAULT_SEATS = [
  { code: 'no_preference', name: '由门店安排', copy: '交给现场团队按人数和当晚情况安排' },
  { code: 'comfortable_booth', name: '舒适卡座', copy: '适合多人交流与较完整的桌面服务' },
  { code: 'stage_atmosphere', name: '靠近舞台', copy: '更接近演出氛围，现场音量也会更高' },
  { code: 'quiet_chat', name: '适合聊天', copy: '优先考虑相对便于交谈的位置' },
  { code: 'outdoor_view', name: '外景位置', copy: '以天气和当晚开放情况为准' },
]
const DEFAULT_OCCASIONS = [
  { code: '', name: '普通到店' }, { code: 'date', name: '约会' }, { code: 'friends', name: '朋友聚会' },
  { code: 'business', name: '商务沟通' }, { code: 'birthday', name: '生日庆祝' }, { code: 'proposal', name: '特别安排' },
]

function shanghaiDate(days) {
  return new Date(Date.now() + days * 86400000 + 8 * 3600000).toISOString().slice(0, 10)
}

function performanceRows(view) {
  return (view && view.schedules || []).filter((item) => item.status !== 'cancelled').map((item) => ({
    id: item.id,
    name: item.performerStageName,
    timeText: `${dateTime(item.startsAt)}–${dateTime(item.endsAt).slice(6)}`,
    imageUrl: item.performerProfile && item.performerProfile.imageUrl,
  }))
}

function impactView(impact) {
  const revision = impact.revision || {}
  const kind = revision.kind
  const title = kind === 'rescheduled' ? '演出时间有调整' : kind === 'replaced' ? '演出已换场' : '原演出已取消'
  const resultingScheduleEligible = (impact.eligibleSchedules || []).some((schedule) => (
    schedule.id === revision.resultingScheduleId
  ))
  const acceptLabel = kind === 'cancelled' || !resultingScheduleEligible
    ? '保留预约，不选演出' : kind === 'rescheduled' ? '接受改期' : '接受换场'
  const previousText = revision.previousStartsAt ? `${revision.previousPerformerStageName || '原演出'} · ${dateTime(revision.previousStartsAt)}` : ''
  const resultingText = revision.resultingStartsAt && kind !== 'cancelled'
    ? `${revision.resultingPerformerStageName || '调整后演出'} · ${dateTime(revision.resultingStartsAt)}` : ''
  return Object.assign({}, impact, {
    title, acceptLabel, previousText, resultingText,
    pending: !impact.acknowledgement,
    eligibleSchedules: (impact.eligibleSchedules || []).map((schedule) => Object.assign({}, schedule, {
      timeText: dateTime(schedule.startsAt),
    })),
  })
}

Page({
  data: {
    loading: true, checking: false, submitting: false, loadingShows: false,
    error: '', success: '', isDevelopment: false, membershipRequired: false,
    reservations: [], showForm: true, step: 1, cancelBusyId: '',
    performanceImpacts: [], impactsError: '', impactBusyId: '', impactNotice: '',
    expandedImpactId: '', impactAttempts: {},
    notificationBusyId: '', notificationNotice: '',
    customerName: '', contact: '', partySize: 2, reservationDate: '', reservationTime: '20:00', minimumDate: '',
    seatOptions: DEFAULT_SEATS, seatIndex: 0, occasionOptions: DEFAULT_OCCASIONS, occasionIndex: 0, occasionNote: '',
    performances: [], selectedPerformanceId: '', selectedPerformance: null,
    availability: null, availabilityText: '选择时间和人数后确认容量', depositText: '', maxGuestCount: 200,
    wechatSubscriptionPresentationOptions: [],
  },

  onLoad() {
    this.setData({ isDevelopment: getRuntimeConfig().isDevelopment, minimumDate: shanghaiDate(0), reservationDate: shanghaiDate(1) })
  },
  onShow() { enablePublicShareMenu(); this.loadData() },

  onShareAppMessage() {
    return publicSharePayload({
      title: '约一晚现场音乐 · M-BOX 到店预约',
      path: '/pages/reservations/index',
    })
  },

  onShareTimeline() {
    return publicTimelinePayload({
      title: '约一晚现场音乐 · M-BOX 到店预约',
      path: '/pages/reservations/index',
    })
  },
  onPullDownRefresh() { this.loadData().finally(() => wx.stopPullDownRefresh()) },

  async loadData() {
    this.setData({ loading: true, error: '' })
    try {
      const bootstrap = await getMiniBootstrap()
      if (!bootstrap.membership) {
        this.setData({
          loading: false,
          membershipRequired: true,
          reservations: [],
          showForm: false,
          performanceImpacts: [],
          impactsError: '',
        })
        return
      }
      this.setData({ membershipRequired: false })
      const [reservationResult, impactResult, notificationResult, preloadResult] = await Promise.allSettled([
        getReservations(), getReservationPerformanceImpacts(),
        getReservationPerformanceNotificationAuthorizations(),
        this.preloadWechatSubscriptionPresentationOptions(),
      ])
      if (preloadResult.status === 'fulfilled' && preloadResult.value.length) {
        this.setData({ wechatSubscriptionPresentationOptions: preloadResult.value })
      }
      if (reservationResult.status === 'rejected') throw reservationResult.reason
      const data = reservationResult.value
      const performanceImpacts = impactResult.status === 'fulfilled'
        ? (impactResult.value.impacts || []).map(impactView) : []
      const pendingByReservation = new Map()
      performanceImpacts.filter((impact) => impact.pending).forEach((impact) => {
        if (!pendingByReservation.has(impact.reservationPublicId)) pendingByReservation.set(impact.reservationPublicId, impact)
      })
      const notificationByReservation = new Map()
      if (notificationResult.status === 'fulfilled') {
        ;(notificationResult.value.authorizations || []).forEach((option) => {
          notificationByReservation.set(option.reservationPublicId, option)
        })
      }
      const now = Date.now()
      const reservations = (data.reservations || []).filter((item) => {
        if (!EXECUTABLE_RESERVATION_STATUSES.has(item.status)) return false
        const arrivalMs = Date.parse(item.arrivalAt)
        // 已过到店时间较久的预约视为不可执行，不再占用“我的预约”。
        if (Number.isFinite(arrivalMs) && arrivalMs < now - 12 * 60 * 60 * 1000) return false
        return true
      }).map((item) => ({
        ...item,
        statusText: STATUS_NAMES[item.status] || '状态待确认',
        scheduledAtText: dateTime(item.arrivalAt),
        partySize: item.guestCount,
        seatName: (this.data.seatOptions.find((option) => option.code === item.seatPreference) || this.data.seatOptions[0]).name,
        priorityBooking: item.priorityBooking || null,
        priorityText: item.priorityBooking
          ? '门店会优先安排；具体座位以到店时现场安排为准。'
          : '',
        active: true,
        canCancel: item.canCancelSelf !== false
          && EXECUTABLE_RESERVATION_STATUSES.has(item.status)
          && (
            !item.customerCancelUntil
            || (Number.isFinite(Date.parse(item.customerCancelUntil))
              && Date.parse(item.customerCancelUntil) > now)
          ),
        performanceImpact: pendingByReservation.get(item.publicId) || null,
        performanceNotificationOption: notificationByReservation.get(item.publicId) || null,
      })).sort((left, right) => String(right.arrivalAt).localeCompare(String(left.arrivalAt)))
      this.setData({
        loading: false, reservations, performanceImpacts,
        impactsError: impactResult.status === 'rejected' ? '演出调整状态暂时无法读取，请重试' : '',
        showForm: reservations.length === 0,
      })
      await Promise.all([this.checkAvailability(), this.loadPerformances()])
    } catch (error) { this.setData({ loading: false, error: customerErrorMessage(error, '预约信息载入失败') }) }
  },

  retryImpacts() { this.loadData() },
  toggleImpactSchedules(event) {
    const impactId = event.currentTarget.dataset.impact
    this.setData({ expandedImpactId: this.data.expandedImpactId === impactId ? '' : impactId, impactNotice: '' })
  },
  async acknowledgeImpact(event) {
    const impactId = event.currentTarget.dataset.impact
    const decision = event.currentTarget.dataset.decision
    const selectedScheduleId = event.currentTarget.dataset.schedule || null
    if (!impactId || this.data.impactBusyId) return
    const signature = `${decision}:${selectedScheduleId || ''}`
    const previous = this.data.impactAttempts[impactId]
    const attempt = previous && previous.signature === signature
      ? previous : { signature, key: randomId(`reservation-performance-${decision}`) }
    this.setData({
      impactBusyId: impactId, impactNotice: '',
      [`impactAttempts.${impactId}`]: attempt,
    })
    try {
      await acknowledgeReservationPerformanceImpact(
        impactId, decision, selectedScheduleId, attempt.key,
      )
      this.setData({
        impactNotice: decision === 'reselect' ? '已更新演出偏好，预约仍然有效。' : '已确认演出调整，预约仍然有效。',
        expandedImpactId: '',
        [`impactAttempts.${impactId}`]: null,
      })
      await this.loadData()
    } catch (error) {
      this.setData({ impactNotice: `${customerErrorMessage(error, '确认未完成')}；选择已保留，可直接重试。` })
    } finally { this.setData({ impactBusyId: '' }) }
  },

  async enablePerformanceNotification(event) {
    const reservationPublicId = event.currentTarget.dataset.reservation
    const reservation = this.data.reservations.find((item) => item.publicId === reservationPublicId)
    const option = reservation && reservation.performanceNotificationOption
    if (!option || this.data.notificationBusyId || typeof wx.requestSubscribeMessage !== 'function') return
    this.setData({ notificationBusyId: reservationPublicId, notificationNotice: '' })
    try {
      const performanceOption = Object.assign({}, option, {
        apiKind: 'reservation_performance',
        notificationType: 'reservation_performance_revised',
        reservationPublicId,
      })
      const options = mergeWechatNotificationPromptOptions(
        [performanceOption],
        this.data.wechatSubscriptionPresentationOptions,
      )
      const result = await requestWechatSubscriptionFromTap(options, RESERVATION_SUCCESS_SUBSCRIBE_TYPES)
      const outcome = (result.outcomes || []).find((item) => item.option.templateId === option.templateId)
      const platformResult = outcome && outcome.platformResult
      if (!['accept', 'reject', 'ban'].includes(platformResult)) {
        this.setData({ notificationNotice: '未完成提醒选择，可稍后再试。' })
        return
      }
      this.setData({
        notificationNotice: platformResult === 'accept'
          ? '本次预约的演出变更提醒已申请。' : '未开启提醒，不影响预约和到店。',
      })
      await this.loadData()
    } catch (error) {
      this.setData({
        notificationNotice: customerErrorCode(error) === 'NETWORK_ERROR'
          ? `${customerErrorMessage(error, '提醒授权未完成')}；授权结果已保留，可直接重试。`
          : `${customerErrorMessage(error, '提醒授权未完成')}；请刷新预约后重试。`,
      })
    } finally { this.setData({ notificationBusyId: '' }) }
  },

  arrivalAt() { return `${this.data.reservationDate}T${this.data.reservationTime}:00+08:00` },

  async checkAvailability() {
    if (this.data.partySize < 1 || this.data.partySize > this.data.maxGuestCount) return
    this.setData({ checking: true })
    try {
      const availability = await getReservationAvailability(this.arrivalAt(), this.data.partySize)
      const rule = availability.depositRule || {}
      const seatOptions = Array.isArray(availability.seatPreferences) && availability.seatPreferences.length
        ? availability.seatPreferences : this.data.seatOptions
      this.setData({
        availability,
        seatOptions,
        maxGuestCount: Number(availability.maximumGuestCount || availability.maxGuestCount || this.data.maxGuestCount),
        availabilityText: availability.acceptingReservations ? '当前时段可提交，具体位置由门店确认' : '当前容量不足，请调整时间或人数',
        depositText: rule.enabled ? `需付${money(rule.amountMinor || 0)}定金 · ${rule.ruleText || '提交前再次确认'}` : '当前不要求线上定金',
      })
    } catch (error) {
      this.setData({ availability: null, availabilityText: customerErrorMessage(error, '暂时无法确认容量'), depositText: '' })
    } finally { this.setData({ checking: false }) }
  },

  async loadPerformances() {
    this.setData({ loadingShows: true })
    try {
      const view = await getReservationPerformances(this.data.reservationDate)
      const performances = performanceRows(view)
      const selectedPerformanceId = performances.some((item) => item.id === this.data.selectedPerformanceId) ? this.data.selectedPerformanceId : ''
      this.setData({
        performances,
        selectedPerformanceId,
        selectedPerformance: performances.find((item) => item.id === selectedPerformanceId) || null,
      })
    } catch (_error) { this.setData({ performances: [], selectedPerformanceId: '', selectedPerformance: null }) }
    finally { this.setData({ loadingShows: false }) }
  },

  startNewReservation() {
    this.setData({ showForm: true, step: 1, error: '', success: '' }, () => {
      this.preloadWechatSubscriptionPresentationOptions().catch(() => {})
    })
  },
  goMembershipLogin() { redirectToMembershipLogin() },
  closeForm() { if (this.data.reservations.length) this.setData({ showForm: false, error: '' }) },

  async cancelReservation(event) {
    const publicId = event.currentTarget.dataset.id
    const reservation = this.data.reservations.find((item) => item.publicId === publicId)
    if (!publicId || !reservation || !reservation.canCancel || this.data.cancelBusyId) return
    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: '取消预约',
        content: `确认取消 ${reservation.scheduledAtText} · ${reservation.partySize}人 的预约吗？`,
        confirmText: '确认取消',
        cancelText: '再想想',
        success: (result) => resolve(Boolean(result.confirm)),
        fail: (error) => {
          wx.showToast({ title: (error && error.errMsg) || '确认弹窗未能打开', icon: 'none' })
          resolve(false)
        },
      })
    })
    if (!confirmed) return
    this.setData({ cancelBusyId: publicId, error: '', success: '' })
    try {
      await cancelCustomerReservation(publicId)
      this.setData({ success: '预约已取消。' })
      await this.loadData()
    } catch (error) {
      this.setData({ error: customerErrorMessage(error, '取消预约失败，请稍后重试或联系门店') })
    } finally {
      this.setData({ cancelBusyId: '' })
    }
  },

  onNameInput(event) { this.setData({ customerName: event.detail.value }) },
  onContactInput(event) { this.setData({ contact: event.detail.value }) },
  onPartySizeInput(event) { this.setData({ partySize: Number(event.detail.value) || 0 }) },
  onPartySizeConfirm() { this.checkAvailability() },
  onDateChange(event) {
    this.setData({ reservationDate: event.detail.value }, () => Promise.all([this.checkAvailability(), this.loadPerformances()]))
  },
  onTimeChange(event) { this.setData({ reservationTime: event.detail.value }, () => this.checkAvailability()) },
  onSeatChange(event) { this.setData({ seatIndex: Number(event.detail.value) }) },
  onOccasionChange(event) { this.setData({ occasionIndex: Number(event.detail.value) }) },
  chooseSeat(event) { this.setData({ seatIndex: Number(event.currentTarget.dataset.index) }) },
  chooseOccasion(event) { this.setData({ occasionIndex: Number(event.currentTarget.dataset.index) }) },
  onNoteInput(event) { this.setData({ occasionNote: event.detail.value }) },
  selectPerformance(event) {
    const id = event.currentTarget.dataset.id
    const selectedPerformanceId = this.data.selectedPerformanceId === id ? '' : id
    this.setData({
      selectedPerformanceId,
      selectedPerformance: this.data.performances.find((item) => item.id === selectedPerformanceId) || null,
    })
  },

  nextStep() {
    if (this.data.step === 1) {
      if (this.data.partySize < 1 || this.data.partySize > this.data.maxGuestCount) {
        return this.setData({ error: `预约人数需在1至${this.data.maxGuestCount}人之间` })
      }
      if (!this.data.availability || !this.data.availability.acceptingReservations) {
        return this.setData({ error: '请先选择当前可接受预约的时间与人数' })
      }
    }
    const step = Math.min(3, this.data.step + 1)
    this.setData({ step, error: '' }, () => {
      if (step === 3) this.preloadWechatSubscriptionPresentationOptions().catch(() => {})
    })
  },
  previousStep() { this.setData({ step: Math.max(1, this.data.step - 1), error: '' }) },

  async preloadWechatSubscriptionPresentationOptions() {
    try {
      const empty = { presentation: [], authorizations: [] }
      // reservation_submit presentationPolicy returns the published reservation
      // template even when the guest has no existing reservation yet.  Without it,
      // first-time submit falls back to member/loyalty fillers only.
      const [loyalty, memberService, performance, reservationPrompt, activityPrompt, checkoutPrompt, memberPrompt, couponPrompt] = await Promise.all([
        getWechatNotificationAuthorizations().catch(() => ({ authorizations: [] })),
        getWechatMemberServiceNotificationAuthorizations().catch(() => ({ authorizations: [] })),
        getReservationPerformanceNotificationAuthorizations().catch(() => ({ authorizations: [] })),
        getWechatNotificationPrompt('reservation_submit').catch(() => empty),
        getWechatNotificationPrompt('activity_registration').catch(() => empty),
        getWechatNotificationPrompt('order_checkout').catch(() => empty),
        getWechatNotificationPrompt('member_card').catch(() => empty),
        getWechatNotificationPrompt('coupon_open').catch(() => empty),
      ])
      const performanceOptions = (performance.authorizations || []).map((item) => Object.assign({}, item, {
        apiKind: 'reservation_performance',
        notificationType: 'reservation_performance_revised',
      }))
      const options = buildReservationSubscriptionPresentation(
        extractPromptPresentation(reservationPrompt),
        performanceOptions,
        (memberService.authorizations || []).map((item) => Object.assign({}, item, { apiKind: 'member_service' })),
        (loyalty.authorizations || []).map((item) => Object.assign({}, item, { apiKind: 'loyalty' })),
        extractPromptPresentation(activityPrompt),
        extractPromptPresentation(checkoutPrompt),
        extractPromptPresentation(memberPrompt),
        extractPromptPresentation(couponPrompt),
      )
      this._presentationOptions = options
      rememberPresentationOptions('reservation_submit', options)
      rememberPresentationOptions('activity_registration', extractPromptPresentation(activityPrompt))
      rememberPresentationOptions('order_checkout', extractPromptPresentation(checkoutPrompt))
      rememberPresentationOptions('member_card', extractPromptPresentation(memberPrompt))
      if (options.length) this.setData({ wechatSubscriptionPresentationOptions: options })
      return options
    } catch (_error) {
      return this.data.wechatSubscriptionPresentationOptions || []
    }
  },

  submitReservation() {
    if (this.data.membershipRequired) {
      redirectToMembershipLogin()
      return
    }
    if (this.data.submitting || this._reservationSubmitPending) return
    const customerName = this.data.customerName.trim()
    const contact = this.data.contact.trim()
    if (!customerName) {
      this.setData({ error: '请填写预约称呼', success: '' })
      return
    }
    if (contact.length < 3) {
      this.setData({ error: '请填写可联系的手机号或微信', success: '' })
      return
    }
    const options = resolvePresentationOptions(
      'reservation_submit',
      this._presentationOptions,
      this.data.wechatSubscriptionPresentationOptions,
    )
    this._reservationSubmitPending = true
    requestWechatSubscriptionFromTap(options, RESERVATION_SUCCESS_SUBSCRIBE_TYPES).finally(() => {
      this._reservationSubmitPending = false
      this.completeReservationSubmit()
    })
  },

  async completeReservationSubmit() {
    if (this.data.submitting) return
    const customerName = this.data.customerName.trim()
    const contact = this.data.contact.trim()
    if (!customerName || contact.length < 3) {
      this.setData({ error: !customerName ? '请填写预约称呼' : '请填写可联系的手机号或微信', success: '' })
      return
    }
    this.setData({ submitting: true, error: '', success: '' })
    try {
      const availability = await getReservationAvailability(this.arrivalAt(), this.data.partySize)
      if (!availability.acceptingReservations) throw new Error('当前时间容量已经变化，请重新选择')
      const occasion = this.data.occasionOptions[this.data.occasionIndex]
      const show = this.data.performances.find((item) => item.id === this.data.selectedPerformanceId)
      const noteParts = [
        occasion.code ? `到店场景：${occasion.name}` : '',
        this.data.occasionNote.trim(),
      ].filter(Boolean)
      await createCustomerReservation({
        customerName, contact, partySize: this.data.partySize, scheduledAt: this.arrivalAt(),
        seatPreference: this.data.seatOptions[this.data.seatIndex].code, note: noteParts.join('；') || null,
        reservationPolicyVersion: Number((availability.depositRule || {}).policyVersion),
        preferredScheduleId: show ? show.id : null,
      })
      this.preloadWechatSubscriptionPresentationOptions().catch(() => {})
      this.setData({ success: '预约已提交，门店确认后会更新状态。', occasionNote: '', showForm: false, step: 1 })
      await this.loadData()
    } catch (error) { this.setData({ error: customerErrorMessage(error, '预约提交失败') }) }
    finally { this.setData({ submitting: false }) }
  },
})
