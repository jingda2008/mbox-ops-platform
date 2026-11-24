const { getActivityRegistrationHistory, getActivityRegistrationPayment } = require('../../utils/api')
const { beginMemberPage } = require('../../utils/member-pagination')
const { beijingDateTime, parseInstant, money } = require('../../utils/format')
const { customerErrorMessage } = require('../../utils/customer-error')

const statuses = {
  reserved: '已预留', payment_pending: '待付款', confirmed: '已确认报名', checked_in: '已签到',
  waitlisted: '候补中', no_show: '未到场', cancelled: '已取消', refunded: '已退款', expired: '已失效',
}
const payments = { not_required: '无需在线付款', pending: '待付款', paid: '付款已确认', expired: '付款已超时', refunded: '已退款' }
const resolutions = { not_required: '无需在线付款', action_required: '等待付款', pending: '付款确认中',
  unknown: '付款结果待确认', confirmed: '付款已确认', failed: '付款失败', expired: '付款已超时',
  refund_requested: '退款申请确认中', refunding: '退款处理中', refunded: '已退款' }
const refunds = { requested: '退款待复核', approved: '退款待执行', processing: '退款处理中', succeeded: '已退款', failed: '退款失败', rejected: '退款被驳回' }

function summary(row) {
  return { id: row.publicId, detailUrl: '/pages/profile-activities/index?id=' + encodeURIComponent(row.publicId), title: row.activityTitle, start: beijingDateTime(row.startsAt),
    status: statuses[row.status] || '状态待确认', ended: parseInstant(row.endsAt) <= Date.now(), packageName: row.activityPackage?.name || '' }
}
function detail(row, payment) {
  return { ...summary(row), end: beijingDateTime(row.endsAt, ''), registered: beijingDateTime(row.registeredAt, ''),
    location: row.location, description: row.activityDescription, refund: row.refundSummary, party: row.serviceVersion === 4 ? null : row.partySize,
    paid: row.paidAmountMinor == null ? '' : money(row.paidAmountMinor), total: row.totalFeeAmountMinor == null ? '' : money(row.totalFeeAmountMinor),
    payment: refunds[payment?.refundStatus] || resolutions[payment?.resolutionState] || payments[row.paymentStatus] || '状态待确认',
    items: row.purchasedItems || [], note: row.note, ticket: row.serviceVersion === 4,
    liveUrl: row.liveDetailAvailable ? '/pages/community-detail/index?id=' + encodeURIComponent(row.activityPublicId)
      + '&registrationId=' + encodeURIComponent(row.publicId) : '' }
}

Page({
  data: { id: '', loading: true, loadingMore: false, error: '', rows: [], selected: null, nextCursor: null },
  onLoad(options) { this.setData({id: options.id || ''}) },
  onShow() { return this.load() },
  onHide() {
    this.generation = (this.generation || 0) + 1
    this.setData({rows: [], selected: null, nextCursor: null, error: '', loading: true, loadingMore: false})
  },
  onUnload() { this.onHide() },
  load() { return this.read(null) },
  retry() { return this.data.rows.length && this.data.nextCursor ? this.loadMore() : this.load() },
  loadMore() {
    if (this.data.nextCursor && !this.data.loading && !this.data.loadingMore) return this.read(this.data.nextCursor)
  },
  async read(before) {
    const generation = this.generation = (this.generation || 0) + 1
    const id = this.data.id
    this.setData(before ? {loadingMore: true, error: ''} : {loading: true, loadingMore: false, error: '', rows: [], selected: null, nextCursor: null})
    try {
      const accept = beginMemberPage(this, 'activities', before)
      const result = await getActivityRegistrationHistory({id, before})
      if (generation !== this.generation) return
      if (id) {
        const row = result.items.find(item => item.publicId === id)
        if (!row) throw Error('未找到本人的这笔报名记录')
        const payment = await getActivityRegistrationPayment(id).catch(() => null)
        if (generation !== this.generation) return
        accept(null)
        this.setData({selected: detail(row, payment), loading: false})
      } else {
        accept(result.nextCursor)
        this.setData({rows: this.data.rows.concat(result.items.map(summary)), nextCursor: result.nextCursor, loading: false, loadingMore: false})
      }
    } catch (error) {
      if (generation !== this.generation) return
      this.setData({loading: false, loadingMore: false, error: customerErrorMessage(error, '报名记录暂时无法读取'),
        ...(error.memberPageOwnerChanged ? {rows: [], selected: null, nextCursor: null} : {})})
    }
  },
  discover() { wx.switchTab({url: '/pages/community/index'}) },
})
