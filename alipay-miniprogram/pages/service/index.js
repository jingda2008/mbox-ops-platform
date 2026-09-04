const runtime = require('../../utils/platform')
const { createServiceTask, getTableOrders } = require('../../utils/api')
const { getRuntimeConfig } = require('../../config/index')
const { getTableSession, tableSessionCacheScope } = require('../../utils/session')
const { createTableRequestGuard, tableRequestScope } = require('../../utils/table-request-scope')
const { customerErrorMessage } = require('../../utils/customer-error')

const LOCAL_REQUESTS_KEY = 'mbox.guest.service.requests.v3'

function localRequestsKey(scope) {
  return `${LOCAL_REQUESTS_KEY}.${scope || tableSessionCacheScope()}`
}

function cachedRequests(scope) {
  const stored = runtime.getStorageSync(localRequestsKey(scope))
  if (Array.isArray(stored)) return { tasks: stored, savedAt: null }
  if (stored && typeof stored === 'object' && Array.isArray(stored.tasks)) return stored
  return { tasks: [], savedAt: null }
}

Page({
  data: {
    submittingId: '', error: '', success: '', isDevelopment: false, tableCode: '', note: '',
    complaintOrders: [{ publicId: '', label: '整桌问题（不指定订单）' }], complaintOrderIndex: 0,
    serviceTypes: [
      { id: 'water', name: '加水', detail: '顾客需要加水', mark: '水' },
      { id: 'ice', name: '加冰', detail: '顾客需要加冰', mark: '冰' },
      { id: 'tableware', name: '补充杯具', detail: '顾客需要补充杯具或餐具', mark: '杯' },
      { id: 'order_help', name: '点单协助', detail: '顾客需要点单协助', mark: '单' },
      { id: 'bill_help', name: '买单协助', detail: '顾客需要买单协助', mark: '账' },
      { id: 'call_staff', name: '呼叫服务人员', detail: '', mark: '人' },
    ],
  },

  onLoad() {
    this.ensureTableRequestGuard()
    this.setData({ tableCode: getTableSession().tableCode, isDevelopment: getRuntimeConfig().isDevelopment })
    this.loadComplaintOrders()
  },
  onShow() {
    this.setData({ tableCode: getTableSession().tableCode })
    this.loadComplaintOrders()
  },
  onHide() { this.invalidateTableRequests() },
  onUnload() { this.invalidateTableRequests() },

  ensureTableRequestGuard() {
    if (!this.tableRequestGuard) {
      this.tableRequestGuard = createTableRequestGuard(() => tableRequestScope(getTableSession()))
    }
    return this.tableRequestGuard
  },
  beginTableRequest() { return this.ensureTableRequestGuard().begin(tableRequestScope(getTableSession())) },
  isCurrentTableRequest(request) { return this.ensureTableRequestGuard().isCurrent(request) },
  invalidateTableRequests() { this.ensureTableRequestGuard().invalidate() },

  async loadComplaintOrders() {
    const request = this.beginTableRequest()
    try {
      const orders = await getTableOrders()
      if (!this.isCurrentTableRequest(request)) return
      const complaintOrders = [{ publicId: '', label: '整桌问题（不指定订单）' }].concat(
        (orders || []).slice(0, 8).map((order) => ({
          publicId: order.publicId,
          label: `${String(order.publicId || '').slice(-8)} · ${(order.items || []).slice(0, 2).map((item) => item.name).join('、') || '订单'}`,
        })),
      )
      this.setData({ tableCode: getTableSession().tableCode, complaintOrders, complaintOrderIndex: 0 })
    } catch (_) {}
  },

  onNoteInput(event) { this.setData({ note: event.detail.value }) },
  onComplaintOrderChange(event) { this.setData({ complaintOrderIndex: Number(event.detail.value) }) },

  requestService(event) {
    const item = this.data.serviceTypes.find((value) => value.id === event.currentTarget.dataset.id)
    if (!item) return
    return this.submitService(item.id, item.id === 'call_staff' ? 'call_staff' : 'custom', item.detail)
  },

  submitCustomRequest() {
    const note = this.data.note.trim()
    if (note.length < 2) return this.setData({ error: '请简单说明需要什么，我们好马上安排', success: '' })
    return this.submitService('custom', 'custom', note)
  },

  requestManager() {
    const selected = this.data.complaintOrders[this.data.complaintOrderIndex]
    return this.submitService('manager', 'complaint', '顾客请求值班经理到桌协助', selected && selected.publicId)
  },

  async submitService(id, requestType, detail, relatedOrderPublicId) {
    if (this.data.submittingId) return
    const request = this.beginTableRequest()
    this.setData({ submittingId: id, error: '', success: '' })
    try {
      const response = await createServiceTask({ requestType, detail, relatedOrderPublicId })
      if (!this.isCurrentTableRequest(request)) return
      const task = response.data || response
      const record = {
        publicId: task.taskPublicId || `local-${Date.now()}`,
        requestType,
        name: id === 'manager' ? '门店协助' : (this.data.serviceTypes.find((item) => item.id === id) || {}).name || '个性化需求',
        detail,
        status: task.taskStatus || 'pending',
        statusText: '等待接单',
        createdAt: new Date().toISOString(),
      }
      const stored = cachedRequests(request.scope)
      runtime.setStorageSync(localRequestsKey(request.scope), {
        savedAt: new Date().toISOString(),
        tasks: [record].concat(stored.tasks.filter((item) => item.publicId !== record.publicId)).slice(0, 30),
      })
      this.setData({ tableCode: getTableSession().tableCode, success: task.message || '收到，我们马上来照顾您。', note: '' })
    } catch (error) {
      if (this.isCurrentTableRequest(request)) this.setData({ error: customerErrorMessage(error, '请求暂时没有送达，请稍后重试') })
    } finally { if (this.isCurrentTableRequest(request)) this.setData({ submittingId: '' }) }
  },

  openStatus() { runtime.navigateTo({ url: '/pages/status/index' }) },
})
