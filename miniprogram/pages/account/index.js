const { getGuestSession } = require('../../utils/api')
const { getRuntimeConfig } = require('../../config/index')
const { getTableSession } = require('../../utils/session')
const { money, dateTime } = require('../../utils/format')

const ORDER_STATUS = {
  draft: '待提交',
  authorization_pending: '待授权',
  submitted: '已下单',
  in_fulfillment: '出品中',
  fulfilled: '已送达',
}

Page({
  data: {
    loading: true,
    error: '',
    warning: '',
    isDevelopment: false,
    tableCode: '',
    sessionId: '',
    orders: [],
    totals: { gross: '¥0.00', discount: '¥0.00', gift: '¥0.00', payable: '¥0.00', balance: '¥0.00' },
  },

  onLoad() {
    this.setData({ tableCode: getTableSession().tableCode, isDevelopment: getRuntimeConfig().isDevelopment })
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
      const account = data.account
      if (!account.tableSessionId) {
        this.setData({ loading: false, warning: result.warning, sessionId: '', orders: [] })
        return
      }
      const rawOrders = account.orders || []
      const total = rawOrders.reduce((sum, order) => ({
        gross: sum.gross + order.items.reduce((itemSum, item) => itemSum + item.amount, 0),
        payable: sum.payable + order.payableAmount,
      }), { gross: 0, payable: 0 })
      const orders = rawOrders.map((order) => ({
        id: order.id,
        statusText: ORDER_STATUS[order.status] || order.status,
        createdAtText: dateTime(order.createdAt),
        payableText: money(order.payableAmount),
        items: order.items.map((item) => ({
          id: item.id,
          name: item.name,
          specification: item.specification,
          quantity: item.quantity,
          amountText: money(item.amount),
          fulfillmentText: item.fulfillmentStatus === 'delivered' ? '已送达' : item.fulfillmentStatus === 'draft' ? '待提交' : '出品流转中',
        })),
      }))
      const discount = Math.max(0, total.gross - total.payable)
      this.setData({
        loading: false,
        warning: result.warning,
        sessionId: account.tableSessionId,
        orders,
        totals: { gross: money(total.gross), discount: money(discount), gift: money(0), payable: money(total.payable), balance: money(account.balanceAmount) },
      })
    } catch (error) {
      this.setData({ loading: false, error: error.message || '桌账载入失败' })
    }
  },
})
