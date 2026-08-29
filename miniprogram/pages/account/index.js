const { getTableOrders } = require('../../utils/api')
const { getRuntimeConfig } = require('../../config/index')
const { getTableSession, tableSessionCacheScope } = require('../../utils/session')
const { createTableRequestGuard, tableRequestScope } = require('../../utils/table-request-scope')
const { money, dateTime } = require('../../utils/format')
const { customerErrorMessage } = require('../../utils/customer-error')

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
  pending: '付款确认中',
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
    this.ensureTableRequestGuard()
    this.setData({ tableCode: getTableSession().tableCode, isDevelopment: getRuntimeConfig().isDevelopment })
  },

  onShow() { this.loadData() },
  onHide() { this.invalidateTableRequests() },
  onUnload() { this.invalidateTableRequests() },

  onPullDownRefresh() {
    this.loadData().finally(() => wx.stopPullDownRefresh())
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
  isCurrentTableRequest(request) { return this.ensureTableRequestGuard().isCurrent(request) },
  invalidateTableRequests() { this.ensureTableRequestGuard().invalidate() },

  clearForeignPendingPayment(paymentScope) {
    const stored = wx.getStorageSync(PENDING_PAYMENT_KEY) || null
    // Older records predate table scoping and are unsafe to recover.  A
    // different scanned credential is equally unsafe, even if the table code
    // was reused after turnover.
    if (stored && (!stored.tableScope || stored.tableScope !== paymentScope)) {
      wx.removeStorageSync(PENDING_PAYMENT_KEY)
      return null
    }
    return stored
  },

  async loadData(preserveMessage) {
    const session = getTableSession()
    const request = this.beginTableRequest(session)
    const paymentScope = tableSessionCacheScope(session)
    const scopeChanged = this.visibleTableScope !== request.scope
    this.visibleTableScope = request.scope
    this.clearForeignPendingPayment(paymentScope)
    this.setData(Object.assign({
      loading: true, error: '', tableCode: session.tableCode || '',
    }, scopeChanged ? {
      orders: [], outstandingText: '¥0.00', busyOrderId: '',
    } : {}, preserveMessage ? {} : { success: '' }))
    try {
      const rawOrders = await getTableOrders()
      if (!this.isCurrentTableRequest(request)) return
      const storedPending = this.clearForeignPendingPayment(paymentScope)
      const storedOrder = storedPending && (rawOrders || []).find((item) => item.publicId === storedPending.orderPublicId)
      if (storedPending && (!storedOrder || Number(storedOrder.payableAmountMinor || 0) === 0)) {
        wx.removeStorageSync(PENDING_PAYMENT_KEY)
      }
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
        // Customer self-orders always pay inside the one-shot checkout flow.
        // A historical unpaid row is never an invitation to resurrect its old
        // payment; the customer can return to the cart and create a new one.
        canPay: false,
        paymentHint: this.paymentHint(order.paymentAccess, Number(order.payableAmountMinor || 0)),
        sourceText: typeof order.sourceText === 'string' && order.sourceText.trim()
          ? order.sourceText.trim() : '点单来源待确认',
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
      if (this.isCurrentTableRequest(request)) {
        this.setData({ loading: false, error: customerErrorMessage(error, '桌账载入失败') })
      }
    }
  },

  paymentHint(access, outstanding) {
    if (outstanding <= 0 || access === 'not_required') return '本轮已结清'
    if (access === 'staff_collecting') return '工作人员正在收款，请勿重复支付'
    if (access === 'payment_in_progress') return '同桌已有支付进行中，请稍候刷新'
    if (access === 'status_review') return '支付结果待通道核对，请勿再次支付'
    return '如需付款，请返回点单重新选购'
  },
})
