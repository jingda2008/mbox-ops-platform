const runtime = require('../../utils/platform')
const { getActivities, getActivityRegistrations, getMiniBootstrap, enrollMembership } = require('../../utils/api')
const { money, dateInput } = require('../../utils/format')
const { publicImageUrl } = require('../../utils/media')
const { readAlipayPhoneAuthorization } = require('../../utils/alipay-phone')
const { customerErrorMessage } = require('../../utils/customer-error')
const { enablePublicShareMenu, publicSharePayload, publicTimelinePayload } = require('../../utils/public-share')

const KIND_NAMES = {
  member_night: '会员之夜', hike: '城市轻徒步', camping: '露营计划', city_walk: '城市漫游',
  music_picnic: '音乐野餐', proposal: '特别企划', other: '超嗨活动',
}
const REGISTRATION_STATUS_NAMES = {
  reserved: '名额已暂留', payment_pending: '待付款处理', confirmed: '已报名',
  waitlisted: '候补中', checked_in: '已签到', no_show: '未到场',
  cancelled: '已取消', refunded: '已退款', expired: '已失效',
}
const PAYMENT_RESOLUTION_NAMES = {
  action_required: '等待付款', pending: '付款确认中', unknown: '付款结果待确认', confirmed: '付款已确认',
  failed: '付款失败', expired: '付款已超时', refund_requested: '退款申请确认中', refunding: '退款处理中', refunded: '已退款',
}

function dateText(value) {
  const date = new Date(dateInput(value))
  if (Number.isNaN(date.getTime())) return '时间待定'
  return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit' })
}

Page({
  data: {
    loading: true, error: '', activities: [], membership: null, membershipTerms: null,
    membershipInviteVisible: false, membershipInviteAgreed: false, membershipInviteBusy: false,
    pendingActivityId: '',
  },
  onShow() { enablePublicShareMenu(); this.load() },
  onPullDownRefresh() { this.load().finally(() => runtime.stopPullDownRefresh()) },

  onShareAppMessage() {
    return publicSharePayload({
      title: 'M-BOX 超嗨部落 · 现场、朋友与城市',
      path: '/pages/community/index',
    })
  },

  onShareTimeline() {
    return publicTimelinePayload({
      title: 'M-BOX 超嗨部落 · 现场、朋友与城市',
      path: '/pages/community/index',
    })
  },

  async load() {
    this.setData({ loading: true, error: '' })
    try {
      const [rawActivities, rawRegistrations, bootstrap] = await Promise.all([
        getActivities(),
        getActivityRegistrations().catch(() => []),
        getMiniBootstrap(),
      ])
      const registrations = new Map((rawRegistrations || []).map((item) => [item.activityPublicId, item]))
      const activities = (rawActivities || []).map((item) => {
        const registration = registrations.get(item.publicId)
        return Object.assign({}, item, {
          coverUrl: publicImageUrl(item.coverUrl),
          kindText: KIND_NAMES[item.kind] || '超嗨活动',
          dateText: dateText(item.startsAt),
          feeText: item.feeAmountMinor > 0 ? `${money(item.feeAmountMinor)}${item.feeBasis === 'per_person' ? '/人' : '/次'}` : '免费',
          availabilityText: item.remainingCapacity > 0 ? `余 ${item.remainingCapacity} 位` : '已满',
          sequenceText: Number.isInteger(Number(item.sortOrder)) && Number(item.sortOrder) > 0
            ? `SUPERHIGH · ${String(Number(item.sortOrder)).padStart(2, '0')}` : '',
          registrationText: registration
            ? (REGISTRATION_STATUS_NAMES[registration.status] || '状态待确认')
            : item.registrationStatus ? (REGISTRATION_STATUS_NAMES[item.registrationStatus] || '状态待确认') : '',
          paymentStateText: registration && registration.resolutionState
            && registration.resolutionState !== 'not_required'
            ? `付款：${PAYMENT_RESOLUTION_NAMES[registration.resolutionState] || '状态待确认'}`
            : '',
        })
      })
      this.setData({
        loading: false,
        activities,
        membership: bootstrap.membership || null,
        membershipTerms: bootstrap.membershipTerms || null,
        membershipInviteVisible: false,
        membershipInviteAgreed: false,
      })
    } catch (error) { this.setData({ loading: false, error: customerErrorMessage(error, '活动或会员服务暂时没有接上') }) }
  },

  openDetail(event) {
    const activityId = String(event.currentTarget.dataset.id || '').trim()
    if (!activityId) return
    if (!this.data.membership) {
      this.setData({
        membershipInviteVisible: true,
        membershipInviteAgreed: false,
        pendingActivityId: activityId,
      })
      return
    }
    this.navigateToActivity(activityId)
  },

  navigateToActivity(activityId) {
    runtime.navigateTo({ url: `/pages/community-detail/index?id=${encodeURIComponent(activityId)}` })
  },

  dismissMembershipInvite() {
    this.setData({ membershipInviteVisible: false, membershipInviteAgreed: false, pendingActivityId: '' })
  },

  onMembershipInviteAgreementChange(event) {
    const values = event && event.detail && Array.isArray(event.detail.value) ? event.detail.value : []
    this.setData({ membershipInviteAgreed: values.indexOf('agree') >= 0 })
  },

  remindMembershipInviteAgreement() {
    runtime.showToast({ title: '请先勾选同意会员协议', icon: 'none' })
  },

  showMembershipTerms() {
    runtime.navigateTo({ url: '/pages/membership-terms/index?source=mini_community&action=view' })
  },

  onAgreePrivacyAuthorization() {},

  async acceptMembershipInvite(event) {
    if (this.data.membershipInviteBusy) return
    if (!this.data.membershipInviteAgreed) return this.remindMembershipInviteAgreement()
    const terms = this.data.membershipTerms
    if (!terms) {
      runtime.showToast({ title: '当前会员协议暂时无法读取', icon: 'none' })
      return
    }
    const authorization = readAlipayPhoneAuthorization(event)
    if (!authorization.code) {
      runtime.showToast({ title: authorization.message, icon: 'none' })
      return
    }
    this.setData({ membershipInviteBusy: true, error: '' })
    try {
      const result = await enrollMembership(terms.version, 'mini_community', authorization.code)
      const membership = result.membership || null
      this.setData({
        membership,
        membershipInviteVisible: false,
        membershipInviteAgreed: false,
        membershipInviteBusy: false,
      })
      if (!membership) throw new Error('会员状态暂时未刷新，请稍后重试')
      const activityId = this.data.pendingActivityId
      this.setData({ pendingActivityId: '' })
      runtime.showToast({ title: '入会成功', icon: 'success' })
      if (activityId) this.navigateToActivity(activityId)
    } catch (error) {
      this.setData({ membershipInviteBusy: false, error: customerErrorMessage(error, '入会暂时没有完成') })
      runtime.showToast({ title: customerErrorMessage(error, '入会未完成'), icon: 'none' })
    }
  },

  noop() {},
})
