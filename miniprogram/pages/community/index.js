const { getActivities, getActivityRegistrations } = require('../../utils/api')
const { money } = require('../../utils/format')

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
  action_required: '等待付款', pending: '支付处理中', unknown: '付款待核对', confirmed: '付款已确认',
  failed: '付款失败', expired: '付款已超时', refund_requested: '退款待审核', refunding: '退款处理中', refunded: '已退款',
}

function dateText(value) {
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit' })
}

Page({
  data: { loading: true, error: '', activities: [] },
  onShow() { this.load() },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()) },

  async load() {
    this.setData({ loading: true, error: '' })
    try {
      const [rawActivities, rawRegistrations] = await Promise.all([
        getActivities(),
        getActivityRegistrations().catch(() => []),
      ])
      const registrations = new Map((rawRegistrations || []).map((item) => [item.activityPublicId, item]))
      const activities = (rawActivities || []).map((item) => {
        const registration = registrations.get(item.publicId)
        return Object.assign({}, item, {
          kindText: KIND_NAMES[item.kind] || '超嗨活动',
          dateText: dateText(item.startsAt),
          feeText: item.feeAmountMinor > 0 ? `${money(item.feeAmountMinor)}${item.feeBasis === 'per_person' ? '/人' : '/次'}` : '免费',
          availabilityText: item.remainingCapacity > 0 ? `余 ${item.remainingCapacity} 位` : '已满',
          sequenceText: `SUPERHIGH · ${String(item.sortOrder || 0).toString().padStart(2, '0')}`,
          registrationText: registration
            ? (PAYMENT_RESOLUTION_NAMES[registration.resolutionState] || REGISTRATION_STATUS_NAMES[registration.status] || '状态待确认')
            : item.registrationStatus ? (REGISTRATION_STATUS_NAMES[item.registrationStatus] || '状态待确认') : '',
        })
      })
      this.setData({ loading: false, activities })
    } catch (error) { this.setData({ loading: false, error: error.message || '活动暂时没有接上' }) }
  },

  openDetail(event) {
    wx.navigateTo({ url: `/pages/community-detail/index?id=${encodeURIComponent(event.currentTarget.dataset.id)}` })
  },
})
