const { createServiceTask, getGuestSession } = require('../../utils/api')
const { getRuntimeConfig } = require('../../config/index')
const { getTableSession } = require('../../utils/session')

Page({
  data: {
    loading: true,
    error: '',
    warning: '',
    success: '',
    isDevelopment: false,
    isFallback: false,
    tableCode: '',
    serviceTypes: [],
    note: '',
    submittingId: '',
  },

  onLoad() {
    const session = getTableSession()
    this.setData({ tableCode: session.tableCode, isDevelopment: getRuntimeConfig().isDevelopment })
    this.loadData()
  },

  async loadData() {
    this.setData({ loading: true, error: '' })
    try {
      const result = await getGuestSession()
      const serviceTypes = (result.data.serviceTypes || []).filter((item) => item.code !== 'complaint' && item.id !== 'complaint')
      this.setData({ loading: false, warning: result.warning, isFallback: result.source !== 'api', serviceTypes })
    } catch (error) {
      this.setData({ loading: false, error: error.message || '服务项目载入失败' })
    }
  },

  onNoteInput(event) {
    this.setData({ note: event.detail.value })
  },

  async requestService(event) {
    if (this.data.isFallback) {
      this.setData({ error: '开发占位数据不能提交服务，请启动本地 API 后重试' })
      return
    }
    const serviceTypeId = event.currentTarget.dataset.id
    this.setData({ submittingId: serviceTypeId, error: '', success: '' })
    try {
      const task = await createServiceTask({ serviceTypeId, note: this.data.note.trim() })
      this.setData({ success: task.customerReply || '已收到，服务人员正在处理。', note: '' })
    } catch (error) {
      this.setData({ error: error.message || '请求未提交，请重试' })
    } finally {
      this.setData({ submittingId: '' })
    }
  },
})
