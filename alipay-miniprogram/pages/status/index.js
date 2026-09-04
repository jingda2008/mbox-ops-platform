const runtime = require('../../utils/platform')
const { getServiceRequests, actOnServiceTask } = require('../../utils/api')
const { getRuntimeConfig } = require('../../config/index')
const { getTableSession, tableSessionCacheScope } = require('../../utils/session')
const { createTableRequestGuard, tableRequestScope } = require('../../utils/table-request-scope')
const { TASK_STATUS, dateTime } = require('../../utils/format')
const { customerErrorMessage } = require('../../utils/customer-error')

const LOCAL_REQUESTS_KEY = 'mbox.guest.service.requests.v3'
const REQUEST_TYPE_NAMES = {
  call_staff: '呼叫服务人员',
  complaint: '值班负责人协助',
  custom: '个性化需求',
}
const SERVICE_STATUS_NAMES = {
  pending: '等待接单',
  acknowledged: '服务人员已接单',
  in_progress: '正在处理',
  completed: '等待您确认',
  cancelled: '已取消',
  expired: '已失效',
}
const ACTIVE_SERVICE_STATUSES = ['pending', 'acknowledged', 'in_progress']

function localRequestsKey(scope) {
  return `${LOCAL_REQUESTS_KEY}.${scope || tableSessionCacheScope()}`
}

function cachedRequests(scope) {
  const stored = runtime.getStorageSync(localRequestsKey(scope))
  if (Array.isArray(stored)) return { tasks: stored, savedAt: null }
  if (stored && typeof stored === 'object' && Array.isArray(stored.tasks)) return stored
  return { tasks: [], savedAt: null }
}

function normalizeTask(task) {
  const status = task.status || task.taskStatus || 'pending'
  return {
    publicId: task.publicId || task.taskPublicId || task.id,
    name: task.name || task.serviceName || task.requestTypeName || REQUEST_TYPE_NAMES[task.requestType] || '桌边服务',
    detail: task.detail || task.note || '',
    ownerText: task.publicServiceName
      ? `由 ${task.publicServiceName} 负责`
      : '等待服务人员接单',
    requestCountText: Number(task.requestCount || 1) > 1 ? `已合并 ${Number(task.requestCount)} 次同类请求` : '',
    status,
    statusText: SERVICE_STATUS_NAMES[status] || TASK_STATUS[status] || '状态待确认',
    createdAtText: dateTime(task.createdAt),
    canConfirm: status === 'completed',
    canEscalate: ACTIVE_SERVICE_STATUSES.includes(status),
  }
}

Page({
  data: { loading: true, feedbackTaskId: '', error: '', success: '', isDevelopment: false, tableCode: '', tasks: [], live: true, cachedAtText: '' },

  onLoad() {
    this.ensureTableRequestGuard()
    this.setData({ tableCode: getTableSession().tableCode, isDevelopment: getRuntimeConfig().isDevelopment })
  },
  onShow() { this.loadData(); this.startPolling() },
  onHide() { this.invalidateTableRequests(); this.stopPolling() },
  onUnload() { this.invalidateTableRequests(); this.stopPolling() },
  onPullDownRefresh() { this.loadData().finally(() => runtime.stopPullDownRefresh()) },

  startPolling() { this.stopPolling(); this.pollTimer = setInterval(() => this.loadData(true), 6000) },
  stopPolling() { if (this.pollTimer) clearInterval(this.pollTimer); this.pollTimer = null },

  ensureTableRequestGuard() {
    if (!this.tableRequestGuard) {
      this.tableRequestGuard = createTableRequestGuard(() => tableRequestScope(getTableSession()))
    }
    return this.tableRequestGuard
  },
  beginTableRequest() { return this.ensureTableRequestGuard().begin(tableRequestScope(getTableSession())) },
  isCurrentTableRequest(request) { return this.ensureTableRequestGuard().isCurrent(request) },
  invalidateTableRequests() { this.ensureTableRequestGuard().invalidate() },

  async loadData(silent) {
    const request = this.beginTableRequest()
    if (!silent) this.setData({ loading: true, error: '' })
    try {
      const response = await getServiceRequests()
      if (!this.isCurrentTableRequest(request)) return
      const raw = Array.isArray(response) ? response : response.tasks || []
      const stored = cachedRequests(request.scope)
      const localById = new Map(stored.tasks.map((item) => [item.publicId || item.taskPublicId || item.id, item]))
      const hydrated = raw.map((item) => Object.assign({}, localById.get(item.publicId) || {}, item))
      const tasks = hydrated.map(normalizeTask)
      runtime.setStorageSync(localRequestsKey(request.scope), { savedAt: new Date().toISOString(), tasks: hydrated })
      this.setData({ loading: false, tableCode: getTableSession().tableCode, tasks, live: true, cachedAtText: '', error: '' })
    } catch (error) {
      if (!this.isCurrentTableRequest(request)) return
      const stored = cachedRequests(request.scope)
      this.setData({
        loading: false,
        tableCode: getTableSession().tableCode,
        tasks: stored.tasks.map(normalizeTask),
        live: false,
        cachedAtText: stored.savedAt ? `上次更新于 ${dateTime(stored.savedAt)}` : '',
        error: stored.tasks.length ? '服务进展暂时无法更新，以下为本桌最近提交的需求。请勿重复呼叫。' : customerErrorMessage(error, '服务进展暂时无法读取'),
      })
    }
  },

  async submitFeedback(event) {
    const taskPublicId = event.currentTarget.dataset.id
    const action = event.currentTarget.dataset.action
    const request = this.beginTableRequest()
    this.setData({ feedbackTaskId: taskPublicId, error: '', success: '' })
    try {
      await actOnServiceTask(taskPublicId, action)
      if (!this.isCurrentTableRequest(request)) return
      this.setData({
        feedbackTaskId: '',
        success: action === 'confirm' ? '感谢确认，本次服务已经解决。' : '已继续升级处理，值班负责人会跟进。',
      })
      await this.loadData()
    } catch (error) {
      if (this.isCurrentTableRequest(request)) this.setData({ error: customerErrorMessage(error, '反馈没有送达，请稍后重试') })
    } finally { if (this.isCurrentTableRequest(request)) this.setData({ feedbackTaskId: '' }) }
  },

  openService() { runtime.navigateTo({ url: '/pages/service/index' }) },
})
