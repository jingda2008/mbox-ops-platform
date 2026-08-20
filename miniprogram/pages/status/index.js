const { getServiceRequests, actOnServiceTask } = require('../../utils/api')
const { getRuntimeConfig } = require('../../config/index')
const { getTableSession } = require('../../utils/session')
const { TASK_STATUS, dateTime } = require('../../utils/format')

const LOCAL_REQUESTS_KEY = 'mbox.guest.service.requests.v2'
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

function normalizeTask(task) {
  const status = task.status || task.taskStatus || 'pending'
  return {
    publicId: task.publicId || task.taskPublicId || task.id,
    name: task.name || task.serviceName || task.requestTypeName || REQUEST_TYPE_NAMES[task.requestType] || '桌边服务',
    detail: task.detail || task.note || '',
    ownerText: task.assignedStaffName || task.ownerName || task.assigneeName
      ? `由 ${task.assignedStaffName || task.ownerName || task.assigneeName} 负责`
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
  data: { loading: true, feedbackTaskId: '', error: '', success: '', isDevelopment: false, tableCode: '', tasks: [], live: true },

  onLoad() {
    this.setData({ tableCode: getTableSession().tableCode, isDevelopment: getRuntimeConfig().isDevelopment })
  },
  onShow() { this.loadData(); this.startPolling() },
  onHide() { this.stopPolling() },
  onUnload() { this.stopPolling() },
  onPullDownRefresh() { this.loadData().finally(() => wx.stopPullDownRefresh()) },

  startPolling() { this.stopPolling(); this.pollTimer = setInterval(() => this.loadData(true), 6000) },
  stopPolling() { if (this.pollTimer) clearInterval(this.pollTimer); this.pollTimer = null },

  async loadData(silent) {
    if (!silent) this.setData({ loading: true, error: '' })
    try {
      const response = await getServiceRequests()
      const raw = Array.isArray(response) ? response : response.tasks || []
      const stored = wx.getStorageSync(LOCAL_REQUESTS_KEY) || []
      const localById = new Map(stored.map((item) => [item.publicId || item.taskPublicId || item.id, item]))
      const hydrated = raw.map((item) => Object.assign({}, localById.get(item.publicId) || {}, item))
      const tasks = hydrated.map(normalizeTask)
      wx.setStorageSync(LOCAL_REQUESTS_KEY, hydrated)
      this.setData({ loading: false, tasks, live: true, error: '' })
    } catch (error) {
      const stored = wx.getStorageSync(LOCAL_REQUESTS_KEY) || []
      this.setData({
        loading: false,
        tasks: stored.map(normalizeTask),
        live: false,
        error: stored.length ? '实时状态暂时未连接，以下为本机最近提交记录。请勿重复呼叫。' : (error.message || '服务进度暂时无法读取'),
      })
    }
  },

  async submitFeedback(event) {
    const taskPublicId = event.currentTarget.dataset.id
    const action = event.currentTarget.dataset.action
    this.setData({ feedbackTaskId: taskPublicId, error: '', success: '' })
    try {
      await actOnServiceTask(taskPublicId, action)
      this.setData({ success: action === 'confirm' ? '感谢确认，本次服务已经解决。' : '已继续升级处理，值班负责人会跟进。' })
      await this.loadData()
    } catch (error) { this.setData({ error: error.message || '反馈没有送达，请稍后重试' }) }
    finally { this.setData({ feedbackTaskId: '' }) }
  },

  openService() { wx.navigateTo({ url: '/pages/service/index' }) },
})
