const { beginMemberPage } = require('../../utils/member-pagination')
const {isPresentableWechatJsapiAction}=require('../../utils/wechat-payment')
const { getTableOrders, getCustomerOrderHistory, payTableOrders } = require('../../utils/api')
const { getRuntimeConfig } = require('../../config/index')
const { parseScanValue, getTableSession, tableSessionCacheScope } = require('../../utils/session')
const { createTableRequestGuard, tableRequestScope } = require('../../utils/table-request-scope')
const { randomId } = require('../../utils/id')
const { money, dateTime } = require('../../utils/format')
const { customerErrorMessage } = require('../../utils/customer-error')
const {
  PENDING_GUEST_PAYMENT_ABANDONMENT_KEY,
} = require('../../utils/guest-payment-abandonment')

const PENDING_PAYMENT_KEY = 'mbox.pending.guest.payment.v1'

const ORDER_STATUS = {
  submitted: '已下单',
  confirmed: '已确认',
  fulfilling: '出品中',
  completed: '已完成',
  cancelled: '已取消',
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
    historyMode: false, readFailed: false,
    loading: true,
    error: '',
    isDevelopment: false,
    tableCode: '',
    orders: [],
    outstandingText: '', settlementReviewCount: 0,
    busyOrderId: '', selectedPublicIds:[], selectedTotalText:'¥0.00', payingBatch:false,
    pendingBatch: false, originalAmountText: '', canResumeBatch: false, success: '',
  },

  onLoad(options) {
    this.historyMode = !!options && options.mode === 'history'
    this.setData({ historyMode: this.historyMode })
    this.ensureTableRequestGuard()
    this.setData({ tableCode: getTableSession().tableCode, isDevelopment: getRuntimeConfig().isDevelopment })
  },

  onShow() { this.loadData() },
  onHide() {
    this.invalidateTableRequests()
  },
  onUnload() {
    this.invalidateTableRequests()
  },

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
    const abandonment = wx.getStorageSync(PENDING_GUEST_PAYMENT_ABANDONMENT_KEY) || null
    if (abandonment && abandonment.tableScope !== paymentScope) {
      wx.removeStorageSync(PENDING_GUEST_PAYMENT_ABANDONMENT_KEY)
    }
    // Older records predate table scoping and are unsafe to recover.  A
    // different scanned credential is equally unsafe, even if the table code
    // was reused after turnover.
    if (stored && (!stored.tableScope || stored.tableScope !== paymentScope)) {
      wx.removeStorageSync(PENDING_PAYMENT_KEY)
      return null
    }
    return stored
  },

  retryRead() { return this.loadData() },
  rescanTable() {
    const scope = tableRequestScope(getTableSession())
    const stillOnBill = () => getCurrentPages().slice(-1)[0] === this && scope === tableRequestScope(getTableSession())
    wx.scanCode({
      onlyFromCamera: true, scanType: ['qrCode', 'wxCode'],
      success: result => {
        if (!stillOnBill()) return
        try {
          const query = parseScanValue(result.path || result.result)
          if (!query.token && !query.tableToken) throw new Error('桌码无效')
          getApp().refreshRuntime({query, forceTableScan: true})
          wx.switchTab({url: '/pages/order/index'})
        } catch (_) { this.setData({error: '请扫描桌面的点单码。'}) }
      },
      fail: error => {
        if (stillOnBill() && !String(error.errMsg || '').includes('cancel')) {
          this.setData({error: '未能扫码，请再试一次。'})
        }
      },
    })
  },
  loadMoreHistory() {
    if (this.data.loading || !this.data.hasMoreHistory || !this.data.orders.length) return
    return this.loadData(true, this.data.orders[this.data.orders.length - 1].publicId)
  },

  async loadData(preserveMessage, before) {
    const session = getTableSession()
    const request = this.beginTableRequest(session)
    const paymentScope = tableSessionCacheScope(session)
    const batchKey = 'mbox.table-batch-attempt:' + paymentScope
    const batchAtRead = this.historyMode ? null : wx.getStorageSync(batchKey)
    const scopeChanged = this.visibleTableScope !== request.scope
    this.visibleTableScope = request.scope
    if (scopeChanged) { this.batchPaymentOperation = null; this.hasReadBill = false }
    if (!this.historyMode) this.clearForeignPendingPayment(paymentScope)
    this.setData(Object.assign({
      loading: true, readFailed: false, error: '', tableCode: session.tableCode || '',
    }, scopeChanged ? {
      orders: [], outstandingText: '', settlementReviewCount: 0, busyOrderId: '',
      payingBatch: false, pendingBatch: false, originalAmountText: '', canResumeBatch: false, selectedPublicIds: [], selectedTotalText: '¥0.00',
    } : {}, this.historyMode && !before ? { orders: [], hasMoreHistory: false } : {}, preserveMessage ? {} : { success: '' }))
    try {
      const acceptPage = this.historyMode ? beginMemberPage(this, 'history', before) : null
      const rawOrders = await (this.historyMode ? getCustomerOrderHistory(before) : getTableOrders())
      if (!this.isCurrentTableRequest(request)) return
      if (acceptPage) acceptPage(rawOrders.length === 30 ? rawOrders[rawOrders.length - 1].publicId : null)
      // Confirm every original receivable from this guarded server read before
      // releasing an unknown batch, so a paid batch cannot block later orders.
      if (batchAtRead && Array.isArray(batchAtRead.ids) && batchAtRead.ids.length > 0
        && batchAtRead.ids.every(id => (rawOrders || []).some(order => order.publicId === id
          && order.payableAmountMinor === 0 && order.paymentAccess === 'not_required'))) {
        const currentBatch = wx.getStorageSync(batchKey)
        if (currentBatch && currentBatch.key === batchAtRead.key) wx.removeStorageSync(batchKey)
      }
      if (!this.historyMode && wx.getStorageSync(PENDING_GUEST_PAYMENT_ABANDONMENT_KEY)) wx.removeStorageSync(PENDING_GUEST_PAYMENT_ABANDONMENT_KEY)
      const storedPending = this.historyMode ? null : this.clearForeignPendingPayment(paymentScope)
      const storedOrder = storedPending && (rawOrders || []).find((item) => item.publicId === storedPending.orderPublicId)
      if (storedPending && storedOrder && storedOrder.payableAmountMinor === 0 && storedOrder.paymentAccess === 'not_required') {
        wx.removeStorageSync(PENDING_PAYMENT_KEY)
      }
      const orders = (rawOrders || []).map((order) => ({
        publicId: order.publicId,
        roundText: this.historyMode ? (order.tableCode ? order.tableCode + '桌' : '原桌号未留存') : `第 ${order.round} 轮`,
        statusText: ORDER_STATUS[order.status] || '状态待确认',
        paymentText: order.receivableReductionMinor > 0 && order.paymentAccess === 'not_required' && order.paymentStatus === 'unpaid'
          ? '无需再付款' : order.totalAmountMinor === 0 && order.status !== 'cancelled'
          ? (order.pricingKind === 'gift' ? '赠送，无需支付' : '无需支付')
          : PAYMENT_STATUS[order.paymentStatus] || '付款状态待确认',
        createdAtText: dateTime(order.createdAt),
        paidAtText: order.paidAt ? dateTime(order.paidAt) : '',
        totalText: Number.isSafeInteger(order.totalAmountMinor) ? money(order.totalAmountMinor) : '金额待同步',
        pointsReceipt: order.points && {
          original: Number.isSafeInteger(order.subtotalAmountMinor) ? money(order.subtotalAmountMinor) : '',
          state: order.points.state,
          used: order.points.used,
          discount: money(order.points.used * 100),
          restored: order.points.restored,
          expired: order.points.restored - order.points.credited,
          paid: Number.isSafeInteger(order.points.paidMinor) ? money(order.points.paidMinor) : '',
          refunded: order.points.refundedMinor > 0 ? money(order.points.refundedMinor) : '',
        },
        discountText: Number.isSafeInteger(order.discountAmountMinor) && order.discountAmountMinor > 0 ? money(order.discountAmountMinor) : '',
        receivableIncreaseText: Number.isSafeInteger(order.receivableIncreaseMinor) && order.receivableIncreaseMinor > 0 ? money(order.receivableIncreaseMinor) : '',
        receivableReductionText: Number.isSafeInteger(order.receivableReductionMinor) && order.receivableReductionMinor > 0 ? money(order.receivableReductionMinor) : '',
        settlementReviewRequired: order.settlementReviewRequired === true,
        payableText: money(order.payableAmountMinor),
        payableAmountMinor: Number(order.payableAmountMinor || 0),
        pricingKind: order.pricingKind || 'none',
        pricingLabel: order.pricingLabel || '',
        paymentAccess: order.paymentAccess,
        // Customer self-orders always pay inside the one-shot checkout flow.
        // A historical unpaid row is never an invitation to resurrect its old
        // payment; the customer can return to the cart and create a new one.
        canPay: !this.historyMode&&order.status!=='cancelled'&&order.paymentAccess==='available'&&Number(order.payableAmountMinor)>0,
        paymentHint: order.settlementReviewRequired === true ? '商品停止金额待员工核对，暂不发起本单付款' : this.historyMode ? '保留原桌订单；未送达商品仍按原订单地点协调送达' : this.paymentHint(order.paymentAccess, Number(order.payableAmountMinor || 0)),
        sourceText: typeof order.sourceText === 'string' && order.sourceText.trim()
          ? order.sourceText.trim() : '点单来源待确认',
        items: (order.items || []).map((item, index) => ({
          key: item.id || `${order.publicId}:${item.productId}:${index}`,
          name: item.name,
          quantity: item.quantity,
          pointsDiscount: order.points?.state === 'consumed' && item.pointsDiscountMinor > 0 ? money(item.pointsDiscountMinor) : '',
          unitPriceText: Number.isSafeInteger(item.unitPriceMinor) ? money(item.unitPriceMinor) : '待同步',
          totalText: Number.isSafeInteger(item.totalAmountMinor) ? money(item.totalAmountMinor) : '待同步',
          componentsText: (item.components || []).map((component) => `${component.name} ×${component.quantity}${component.progressText ? '（' + component.progressText + '）' : ''}`).join(' · '),
          note: item.note || '',
          statusText: item.progressText || ITEM_STATUS[item.status] || '出品状态待确认',
        })),
      }))
      const journal = this.historyMode ? null : wx.getStorageSync(batchKey)
      const originalIds = journal && Array.isArray(journal.ids) ? journal.ids : []
      const originalOrders = orders.filter(order => originalIds.includes(order.publicId))
      const originalAvailable = originalIds.length > 0 && originalOrders.length === originalIds.length
      const originalAmount = originalOrders.reduce((sum, order) => sum + order.payableAmountMinor, 0)
      const originalAmountText = journal && Number.isSafeInteger(journal.amountMinor) ? money(journal.amountMinor) : ''
      const canResumeBatch = originalAvailable && originalOrders.every(order => order.canPay || order.paymentAccess === 'payment_in_progress')
        && (!Number.isSafeInteger(journal.amountMinor) || journal.amountMinor === originalAmount)
      const payableIds = orders.filter(order => order.canPay).map(order => order.publicId)
      let selectedPublicIds = payableIds
      if (journal) selectedPublicIds = originalIds
      else if (batchAtRead) selectedPublicIds = []
      else if (!scopeChanged && this.hasReadBill && !this.historyMode) selectedPublicIds = payableIds.filter(id => this.data.selectedPublicIds.includes(id))
      this.hasReadBill = true
      orders.forEach(order=>{order.selected=selectedPublicIds.includes(order.publicId)})
      const outstanding = orders.reduce((sum, order) => sum + order.payableAmountMinor, 0)
      const nextOrders = before ? this.data.orders.concat(orders.filter(order => !this.data.orders.some(current => current.publicId === order.publicId))) : orders
      this.setData({ loading: false, orders: nextOrders, settlementReviewCount: orders.filter(order => order.paymentAccess === 'status_review').length, selectedPublicIds, pendingBatch: Boolean(journal), originalAmountText, canResumeBatch,
        ...(batchAtRead && !journal ? {success: '上次所选订单已无待付金额。'} : {}),
        selectedTotalText:money(orders.filter(order => order.selected).reduce((sum, order) => sum + order.payableAmountMinor, 0)), hasMoreHistory: this.historyMode && rawOrders.length === 30, outstandingText: money(outstanding) })
    } catch (error) {
      if (this.isCurrentTableRequest(request)) {
        if (error.memberPageOwnerChanged) this.setData({ orders: [], hasMoreHistory: false })
        const readFailed = !before || !this.data.orders.length
        this.setData({
          loading: false, readFailed,
          ...(readFailed ? {orders: [], outstandingText: '', selectedPublicIds: [], hasMoreHistory: false} : {}),
          error: customerErrorMessage(error, this.historyMode ? '订单暂时无法读取' : '桌账暂时无法读取'),
        })
      }
    }
  },

  togglePaymentOrder(event){
    if(this.data.payingBatch || this.data.pendingBatch)return
    const id=event.currentTarget.dataset.id
    const ids=this.data.selectedPublicIds.includes(id)?this.data.selectedPublicIds.filter(value=>value!==id):this.data.selectedPublicIds.concat(id)
    const orders=this.data.orders.map(order=>Object.assign({},order,{selected:ids.includes(order.publicId)}))
    this.setData({orders,selectedPublicIds:ids,selectedTotalText:money(orders.filter(order=>order.selected).reduce((sum,order)=>sum+order.payableAmountMinor,0))})
  },
  async paySelectedOrders(){
    if(this.historyMode||this.data.readFailed||this.data.loading||this.data.payingBatch||!this.data.selectedPublicIds.length)return
    const scope=tableSessionCacheScope(),ids=this.data.selectedPublicIds.slice().sort()
    const storageKey='mbox.table-batch-attempt:'+scope
    let attempt=wx.getStorageSync(storageKey)
    if(attempt && (!Array.isArray(attempt.ids) || typeof attempt.key !== 'string' || attempt.key.length < 8 || JSON.stringify(attempt.ids)!==JSON.stringify(ids))){
      this.setData({error:'上次付款的结果还未确认，请选择原订单查看，或联系服务员核对。'})
      return
    }
    if (this.data.pendingBatch && !attempt) return this.loadData()
    if (this.data.pendingBatch && !this.data.canResumeBatch) return
    if (!attempt) {
      const amountMinor = (this.data.orders || []).filter(order => ids.includes(order.publicId)).reduce((sum, order) => sum + order.payableAmountMinor, 0)
      attempt = {ids, key: randomId('table-batch'), amountMinor}
    }
    wx.setStorageSync(storageKey,attempt)
    const operation = this.batchPaymentOperation = {}
    const ownsOperation = () => this.batchPaymentOperation === operation && scope === tableSessionCacheScope()
    this.setData({payingBatch:true, pendingBatch:true, originalAmountText:Number.isSafeInteger(attempt.amountMinor) ? money(attempt.amountMinor) : '', canResumeBatch:false, error:'',success:''})
    try{
      const action=await payTableOrders(ids,attempt.key)
      if(!ownsOperation())return
      // Only an authoritative resolved payment ends the recovery journal.
      if(action && action.status==='resolved'){
        wx.removeStorageSync(storageKey)
        const paymentEnded = ['closed','failed'].includes(action.terminalPaymentStatus)
        this.setData({selectedPublicIds:[], selectedTotalText:money(0), pendingBatch:false, canResumeBatch:false, originalAmountText:'',
          success:paymentEnded ? '上次付款未成功，原订单保留。请核对待付金额。' : '已恢复原付款结果，请核对最新桌账。'})
        try { await this.loadData(true) } catch (_error) {
          if(ownsOperation())this.setData({error:'原付款结果已找到，最新桌账暂未读到，请刷新核对。'})
        }
        return
      }
      if(!isPresentableWechatJsapiAction(action)){
        this.setData({error:action&&action.status==='failed'?'本次支付未能打开，请重试或联系员工收款':'付款结果还未确认，请刷新桌账或联系服务员核对，避免重复付款。'})
        return
      }
      await new Promise((resolve,reject)=>wx.requestPayment(Object.assign({},action.payload,{success:resolve,fail:reject})))
      if(ownsOperation()){this.setData({success:'支付操作已完成，金额以到账核对结果为准。'});await this.loadData(true)}
    }catch(error){if(ownsOperation())this.setData({error:error&&/cancel/i.test(error.errMsg||'')?'已取消本次支付，原订单保留。':customerErrorMessage(error,'付款结果还未确认，请查看桌账或联系服务员核对，避免重复付款')})}
    finally{
      if(this.batchPaymentOperation === operation){this.batchPaymentOperation = null;this.setData({payingBatch:false})}
    }
  },

  paymentHint(access, outstanding) {
    if (outstanding <= 0 || access === 'not_required') return '本轮已结清'
    if (access === 'staff_collecting') return '工作人员正在收款，请勿重复支付'
    if (access === 'payment_in_progress') return '同桌已有支付进行中，请稍候刷新'
    if (access === 'status_review') return '付款结果还在确认，请勿重复付款'
    return '本单尚有待付金额，可请有收款权限的员工直接收款'
  },
})
