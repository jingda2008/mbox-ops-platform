const { getTableOrders } = require('../../utils/api')
const { getRuntimeConfig } = require('../../config/index')
const { getTableSession } = require('../../utils/session')
const { money, dateTime } = require('../../utils/format')

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
  },

  onLoad() {
    this.setData({ tableCode: getTableSession().tableCode, isDevelopment: getRuntimeConfig().isDevelopment })
  },

  onShow() { this.loadData() },

  onPullDownRefresh() {
    this.loadData().finally(() => wx.stopPullDownRefresh())
  },

  async loadData() {
    this.setData({ loading: true, error: '' })
    try {
      const rawOrders = await getTableOrders()
      const orders = (rawOrders || []).map((order) => ({
        publicId: order.publicId,
        roundText: `第 ${order.round} 轮`,
        statusText: ORDER_STATUS[order.status] || order.status,
        paymentText: PAYMENT_STATUS[order.paymentStatus] || order.paymentStatus,
        createdAtText: dateTime(order.createdAt),
        payableText: money(order.payableAmountMinor),
        payableAmountMinor: Number(order.payableAmountMinor || 0),
        isMineText: order.isMine ? '本机下单' : '同桌订单',
        items: (order.items || []).map((item) => ({
          key: `${order.publicId}:${item.productId}`,
          name: item.name,
          quantity: item.quantity,
          statusText: ITEM_STATUS[item.status] || item.status,
        })),
      }))
      const outstanding = orders.reduce((sum, order) => sum + order.payableAmountMinor, 0)
      this.setData({ loading: false, orders, outstandingText: money(outstanding) })
    } catch (error) {
      this.setData({ loading: false, error: error.message || '桌账载入失败' })
    }
  },
})
