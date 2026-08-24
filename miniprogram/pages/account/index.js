const { getTableOrders, retryOrderPayment } = require('../../utils/api')
const { getRuntimeConfig } = require('../../config/index')
const { getTableSession } = require('../../utils/session')
const { randomId } = require('../../utils/id')
const { money, dateTime } = require('../../utils/format')
const { customerErrorMessage, isWechatCancellation } = require('../../utils/customer-error')

const PENDING_PAYMENT_KEY = 'mbox.pending.guest.payment.v1'

const ORDER_STATUS = {
  submitted: '已下单',
  confirmed: '已确认',
  fulfilling: '出品中',
  completed: '已完成',
}

const ITEM_STATUS = {
  submitted: '已提交',
  accepted: '已接单',
  preparing: '制作中',
  ready: '待送达',
  delivered: '已送达',
  cancelled: '已取消',
}

const PAYMENT_STATUS = {
  unpaid: '待付款',
  pending: '付款处理中',
  partially_paid: '部分付款',
  paid: '已付款',
  partially_refunded: '部分退款',
  refunded: '已退款',
}

Page({
  data: {
    loading: true,
    error: '',
    isDevelopment: false,
    tableCode: '',
    orders: [],
    outstandingText: '¥0.00',
    busyOrderId: '',
    success: '',
  },

  onLoad() {
    this.setData({ tableCode: getTableSession().tableCode, isDevelopment: getRuntimeConfig().isDevelopment })
  },

  onShow() { this.loadData() },

  onPullDownRefresh() {
    this.loadData().finally(() => wx.stopPullDownRefresh())
  },

  async loadData(preserveMessage) {
    this.setData(Object.assign({ loading: true, error: '' }, preserveMessage ? {} : { success: '' }))
    try {
      const rawOrders = await getTableOrders()
      const storedPending = wx.getStorageSync(PENDING_PAYMENT_KEY) || null
      const storedOrder = storedPending && (rawOrders || []).find((item) => item.publicId === storedPending.orderPublicId)
      if (storedOrder && Number(storedOrder.payableAmountMinor || 0) === 0) wx.removeStorageSync(PENDING_PAYMENT_KEY)
      const orders = (rawOrders || []).map((order) => ({
        publicId: order.publicId,
        roundText: `第 ${order.round} 轮`,
        statusText: ORDER_STATUS[order.status] || '状态待确认',
        paymentText: PAYMENT_STATUS[order.paymentStatus] || '付款状态待确认',
        createdAtText: dateTime(order.createdAt),
        payableText: money(order.payableAmountMinor),
        payableAmountMinor: Number(order.payableAmountMinor || 0),
        pricingKind: order.pricingKind || 'none',
        pricingLabel: order.pricingLabel || '',
        paymentAccess: order.paymentAccess,
        canPay: order.paymentAccess === 'available' && Number(order.payableAmountMinor || 0) > 0,
        paymentHint: this.paymentHint(order.paymentAccess, Number(order.payableAmountMinor || 0)),
        isMineText: order.isMine ? '本机下单' : '同桌订单',
        items: (order.items || []).map((item) => ({
          key: `${order.publicId}:${item.productId}`,
          name: item.name,
          quantity: item.quantity,
          statusText: ITEM_STATUS[item.status] || '出品状态待确认',
        })),
      }))
      const outstanding = orders.reduce((sum, order) => sum + order.payableAmountMinor, 0)
      this.setData({ loading: false, orders, outstandingText: money(outstanding) })
    } catch (error) {
      this.setData({ loading: false, error: customerErrorMessage(error, '桌账载入失败') })
    }
  },

  paymentHint(access, outstanding) {
    if (outstanding <= 0 || access === 'not_required') return '本轮已结清'
    if (access === 'staff_collecting') return '工作人员正在收款，请勿重复支付'
    if (access === 'payment_in_progress') return '同桌已有支付进行中，请稍候刷新'
    if (access === 'status_review') return '支付结果待通道核对，请勿再次支付'
    return '可继续线上支付'
  },

  async continuePayment(event) {
    const orderPublicId = event.currentTarget.dataset.id
    const order = this.data.orders.find((item) => item.publicId === orderPublicId)
    if (!order || !order.canPay || this.data.busyOrderId) return
    const stored = wx.getStorageSync(PENDING_PAYMENT_KEY) || {}
    const retryIdempotencyKey = stored.orderPublicId === orderPublicId && stored.retryIdempotencyKey
      ? stored.retryIdempotencyKey
      : randomId(`guest-payment-${orderPublicId}`)
    const pendingPayment = {
      orderPublicId,
      retryIdempotencyKey,
      amountText: order.payableText,
      statusText: '订单等待付款',
    }
    wx.setStorageSync(PENDING_PAYMENT_KEY, pendingPayment)
    this.setData({ busyOrderId: orderPublicId, error: '', success: '' })
    try {
      const action = await retryOrderPayment(orderPublicId, retryIdempotencyKey)
      if (!action || action.status !== 'ready' || action.presentation !== 'jsapi' || !action.payload) {
        const statusText = action && action.status === 'unknown'
          ? '付款结果待核对'
          : action && action.presentation === 'qr'
            ? '已生成通道二维码，请由工作人员协助完成'
            : '付款尚未完成'
        wx.setStorageSync(PENDING_PAYMENT_KEY, Object.assign({}, pendingPayment, { statusText }))
        this.setData({ error: `${statusText}，系统不会把它显示为支付成功。` })
        return
      }
      await new Promise((resolve, reject) => wx.requestPayment(Object.assign({}, action.payload, { success: resolve, fail: reject })))
      wx.setStorageSync(PENDING_PAYMENT_KEY, Object.assign({}, pendingPayment, { statusText: '支付请求已提交，等待到账确认' }))
      this.setData({ success: '支付请求已提交，最终结果正在以支付回调和桌账核对。' })
      await this.loadData(true)
    } catch (error) {
      const cancelled = isWechatCancellation(error)
      const statusText = cancelled ? '订单已保留，付款已取消' : '付款未完成，可稍后继续'
      wx.setStorageSync(PENDING_PAYMENT_KEY, Object.assign({}, pendingPayment, { statusText }))
      this.setData({ error: cancelled ? '' : '付款未完成，请勿重新下单。', success: cancelled ? statusText : '' })
    } finally {
      this.setData({ busyOrderId: '' })
    }
  },
})
