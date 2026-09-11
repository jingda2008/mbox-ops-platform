const runtime = require('../../utils/platform')
const {isPresentableAlipayTradeAction}=require('../../utils/alipay-payment')
const { getTableOrders, getCustomerOrderHistory, payTableOrders, abandonGuestCheckout } = require('../../utils/api')
const { getRuntimeConfig } = require('../../config/index')
const { getTableSession, tableSessionCacheScope } = require('../../utils/session')
const { createTableRequestGuard, tableRequestScope } = require('../../utils/table-request-scope')
const { randomId } = require('../../utils/id')
const { money, dateTime } = require('../../utils/format')
const { customerErrorMessage } = require('../../utils/customer-error')
const {
  PENDING_GUEST_PAYMENT_ABANDONMENT_KEY,
  createGuestPaymentAbandonmentRecord,
  isRetryableGuestPaymentAbandonment,
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
    historyMode: false,
    loading: true,
    error: '',
    isDevelopment: false,
    tableCode: '',
    orders: [],
    outstandingText: '¥0.00',
    busyOrderId: '', selectedPublicIds:[], selectedTotalText:'¥0.00', payingBatch:false,
    success: '',
  },

  onLoad(options) {
    this.historyMode = !!options && options.mode === 'history'
    this.setData({ historyMode: this.historyMode })
    this.ensureTableRequestGuard()
    this.setData({ tableCode: getTableSession().tableCode, isDevelopment: getRuntimeConfig().isDevelopment })
  },

  onShow() { this.loadData() },
  onHide() {
    const record = this.queuePendingGuestPaymentAbandonment()
    if (record) void this.executePendingGuestPaymentAbandonment(record)
    this.invalidateTableRequests()
  },
  onUnload() {
    const record = this.queuePendingGuestPaymentAbandonment()
    if (record) void this.executePendingGuestPaymentAbandonment(record)
    this.invalidateTableRequests()
  },

  onPullDownRefresh() {
    this.loadData().finally(() => runtime.stopPullDownRefresh())
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
    const stored = runtime.getStorageSync(PENDING_PAYMENT_KEY) || null
    const abandonment = runtime.getStorageSync(PENDING_GUEST_PAYMENT_ABANDONMENT_KEY) || null
    if (abandonment && abandonment.tableScope !== paymentScope) {
      runtime.removeStorageSync(PENDING_GUEST_PAYMENT_ABANDONMENT_KEY)
    }
    // Older records predate table scoping and are unsafe to recover.  A
    // different scanned credential is equally unsafe, even if the table code
    // was reused after turnover.
    if (stored && (!stored.tableScope || stored.tableScope !== paymentScope)) {
      runtime.removeStorageSync(PENDING_PAYMENT_KEY)
      return null
    }
    return stored
  },

  queuePendingGuestPaymentAbandonment() {
    if (this.historyMode) return null
    const paymentScope = tableSessionCacheScope()
    const pending = this.clearForeignPendingPayment(paymentScope)
    const record = createGuestPaymentAbandonmentRecord(
      pending,
      paymentScope,
      (orderPublicId) => randomId(`guest-checkout-abandon-${orderPublicId}`),
    )
    if (!record) return null
    runtime.setStorageSync(PENDING_PAYMENT_KEY, Object.assign({}, pending, {
      abandonmentIdempotencyKey: record.idempotencyKey,
    }))
    runtime.setStorageSync(PENDING_GUEST_PAYMENT_ABANDONMENT_KEY, record)
    return record
  },

  async executePendingGuestPaymentAbandonment(record) {
    if (this._guestPaymentAbandonmentInFlight === record.idempotencyKey) {
      return this._guestPaymentAbandonmentPromise || null
    }
    this._guestPaymentAbandonmentInFlight = record.idempotencyKey
    const execution = abandonGuestCheckout(record.orderPublicId, record.idempotencyKey)
      .then((result) => {
        if (result && result.operationalState === 'cancelled') {
          const stored = runtime.getStorageSync(PENDING_PAYMENT_KEY)
          if (stored && stored.orderPublicId === record.orderPublicId
            && stored.tableScope === record.tableScope) runtime.removeStorageSync(PENDING_PAYMENT_KEY)
          const persisted = runtime.getStorageSync(PENDING_GUEST_PAYMENT_ABANDONMENT_KEY)
          if (persisted && persisted.idempotencyKey === record.idempotencyKey) {
            runtime.removeStorageSync(PENDING_GUEST_PAYMENT_ABANDONMENT_KEY)
          }
        }
        return result || null
      })
      .catch((error) => {
        if (error && ['GUEST_CHECKOUT_ALREADY_PAID', 'GUEST_CHECKOUT_NOT_FOUND', 'GUEST_ORDER_ACCESS_FORBIDDEN'].includes(error.code)) {
          runtime.removeStorageSync(PENDING_PAYMENT_KEY)
          runtime.removeStorageSync(PENDING_GUEST_PAYMENT_ABANDONMENT_KEY)
        }
        return null
      })
    this._guestPaymentAbandonmentPromise = execution
    try { return await execution }
    finally {
      if (this._guestPaymentAbandonmentInFlight === record.idempotencyKey) {
        this._guestPaymentAbandonmentInFlight = null
        this._guestPaymentAbandonmentPromise = null
      }
    }
  },

  loadMoreHistory() {
    if (this.data.loading || !this.data.hasMoreHistory || !this.data.orders.length) return
    return this.loadData(true, this.data.orders[this.data.orders.length - 1].publicId)
  },

  async loadData(preserveMessage, before) {
    const session = getTableSession()
    const request = this.beginTableRequest(session)
    const paymentScope = tableSessionCacheScope(session)
    const scopeChanged = this.visibleTableScope !== request.scope
    this.visibleTableScope = request.scope
    if (!this.historyMode) this.clearForeignPendingPayment(paymentScope)
    this.setData(Object.assign({
      loading: true, error: '', tableCode: session.tableCode || '',
    }, scopeChanged ? {
      orders: [], outstandingText: '¥0.00', busyOrderId: '',
    } : {}, preserveMessage ? {} : { success: '' }))
    try {
      const rawOrders = await (this.historyMode ? getCustomerOrderHistory(before) : getTableOrders())
      if (!this.isCurrentTableRequest(request)) return
      const storedAbandonment = this.historyMode ? null : runtime.getStorageSync(PENDING_GUEST_PAYMENT_ABANDONMENT_KEY) || null
      const storedPending = this.historyMode ? null : this.clearForeignPendingPayment(paymentScope)
      const storedOrder = storedPending && (rawOrders || []).find((item) => item.publicId === storedPending.orderPublicId)
      if (storedPending && (!storedOrder || Number(storedOrder.payableAmountMinor || 0) === 0)) {
        runtime.removeStorageSync(PENDING_PAYMENT_KEY)
      }
      const orders = (rawOrders || []).map((order) => ({
        publicId: order.publicId,
        roundText: this.historyMode ? (order.tableCode ? order.tableCode + '桌' : '原桌号未留存') : `第 ${order.round} 轮`,
        statusText: ORDER_STATUS[order.status] || '状态待确认',
        paymentText: order.totalAmountMinor === 0 && order.status !== 'cancelled'
          ? (order.pricingKind === 'gift' ? '赠送，无需支付' : '无需支付')
          : PAYMENT_STATUS[order.paymentStatus] || '付款状态待确认',
        createdAtText: dateTime(order.createdAt),
        paidAtText: order.paidAt ? dateTime(order.paidAt) : '',
        totalText: Number.isSafeInteger(order.totalAmountMinor) ? money(order.totalAmountMinor) : '金额待同步',
        discountText: Number.isSafeInteger(order.discountAmountMinor) && order.discountAmountMinor > 0 ? money(order.discountAmountMinor) : '',
        payableText: money(order.payableAmountMinor),
        payableAmountMinor: Number(order.payableAmountMinor || 0),
        pricingKind: order.pricingKind || 'none',
        pricingLabel: order.pricingLabel || '',
        paymentAccess: order.paymentAccess,
        // Customer self-orders always pay inside the one-shot checkout flow.
        // A historical unpaid row is never an invitation to resurrect its old
        // payment; the customer can return to the cart and create a new one.
        canPay: !this.historyMode&&order.status!=='cancelled'&&order.paymentAccess==='available'&&Number(order.payableAmountMinor)>0,
        paymentHint: this.historyMode ? '保留原桌订单；未送达商品仍按原订单地点协调送达' : this.paymentHint(order.paymentAccess, Number(order.payableAmountMinor || 0)),
        sourceText: typeof order.sourceText === 'string' && order.sourceText.trim()
          ? order.sourceText.trim() : '点单来源待确认',
        items: (order.items || []).map((item, index) => ({
          key: item.id || `${order.publicId}:${item.productId}:${index}`,
          name: item.name,
          quantity: item.quantity,
          unitPriceText: Number.isSafeInteger(item.unitPriceMinor) ? money(item.unitPriceMinor) : '待同步',
          totalText: Number.isSafeInteger(item.totalAmountMinor) ? money(item.totalAmountMinor) : '待同步',
          componentsText: (item.components || []).map((component) => `${component.name} ×${component.quantity}`).join(' · '),
          note: item.note || '',
          statusText: ITEM_STATUS[item.status] || '出品状态待确认',
        })),
      }))
      const selectedPublicIds=orders.filter(order=>order.canPay).map(order=>order.publicId)
      orders.forEach(order=>{order.selected=selectedPublicIds.includes(order.publicId)})
      const outstanding = orders.reduce((sum, order) => sum + order.payableAmountMinor, 0)
      const nextOrders = before ? this.data.orders.concat(orders.filter(order => !this.data.orders.some(current => current.publicId === order.publicId))) : orders
      this.setData({ loading: false, orders: nextOrders, selectedPublicIds, selectedTotalText:money(outstanding), hasMoreHistory: this.historyMode && rawOrders.length === 30, outstandingText: money(outstanding) })
      const abandonmentOrder = storedAbandonment
        && storedAbandonment.tableScope === paymentScope
        && (rawOrders || []).find((item) => item.publicId === storedAbandonment.orderPublicId)
      if (isRetryableGuestPaymentAbandonment(storedAbandonment, paymentScope, abandonmentOrder)) {
        void this.executePendingGuestPaymentAbandonment(storedAbandonment)
      } else if (storedAbandonment) {
        runtime.removeStorageSync(PENDING_GUEST_PAYMENT_ABANDONMENT_KEY)
      }
    } catch (error) {
      if (this.isCurrentTableRequest(request)) {
        this.setData({ loading: false, error: customerErrorMessage(error, '桌账载入失败') })
      }
    }
  },

  togglePaymentOrder(event){
    if(this.data.payingBatch)return
    const id=event.currentTarget.dataset.id
    const ids=this.data.selectedPublicIds.includes(id)?this.data.selectedPublicIds.filter(value=>value!==id):this.data.selectedPublicIds.concat(id)
    const orders=this.data.orders.map(order=>Object.assign({},order,{selected:ids.includes(order.publicId)}))
    this.setData({orders,selectedPublicIds:ids,selectedTotalText:money(orders.filter(order=>order.selected).reduce((sum,order)=>sum+order.payableAmountMinor,0))})
  },
  async paySelectedOrders(){
    if(this.historyMode||this.data.payingBatch||!this.data.selectedPublicIds.length)return
    const scope=tableSessionCacheScope(),ids=this.data.selectedPublicIds.slice().sort()
    const storageKey='mbox.table-batch-attempt:'+scope
    let attempt=runtime.getStorageSync(storageKey)
    if(!attempt||JSON.stringify(attempt.ids)!==JSON.stringify(ids))attempt={ids,key:randomId('table-batch')}
    runtime.setStorageSync(storageKey,attempt)
    this.setData({payingBatch:true,error:'',success:''})
    try{
      const action=await payTableOrders(ids,attempt.key)
      if(scope!==tableSessionCacheScope())return
      // A received action completes this request. A later deliberate payment uses a new attempt.
      runtime.removeStorageSync(storageKey)
      if(!isPresentableAlipayTradeAction(action)){
        this.setData({error:action&&action.status==='failed'?'本次支付未能打开，请重试或联系员工收款':'本次支付结果尚未确认，可联系员工继续收款；后台会核对实际到账。'})
        return
      }
      await new Promise((resolve,reject)=>runtime.requestPayment(Object.assign({},action.payload,{success:resolve,fail:reject})))
      if(scope===tableSessionCacheScope()){this.setData({success:'支付操作已完成，金额以到账核对结果为准。'});await this.loadData(true)}
    }catch(error){if(scope===tableSessionCacheScope())this.setData({error:error&&/cancel/i.test(error.errMsg||'')?'已取消本次支付，原订单保留。':customerErrorMessage(error,'本次结果未确认，请重试同次请求或联系员工收款')})}
    finally{if(scope===tableSessionCacheScope())this.setData({payingBatch:false})}
  },

  paymentHint(access, outstanding) {
    if (outstanding <= 0 || access === 'not_required') return '本轮已结清'
    if (access === 'staff_collecting') return '工作人员正在收款，请勿重复支付'
    if (access === 'payment_in_progress') return '同桌已有支付进行中，请稍候刷新'
    if (access === 'status_review') return '支付结果待通道核对，请勿再次支付'
    return '本单尚有待付金额，可请有收款权限的员工直接收款'
  },
})
