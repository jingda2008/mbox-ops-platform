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
    customServiceTypeId: '',
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
      const availableTypes = result.data.serviceTypes || []
      const customType = availableTypes.find((item) => item.code === 'CUSTOM_REQUEST')
      const serviceTypes = availableTypes.filter((item) => (
        item.code !== 'complaint' && item.id !== 'complaint' && item.code !== 'CUSTOM_REQUEST'
      ))
      this.setData({ loading: false, warning: result.warning, isFallback: result.source !== 'api', serviceTypes, customServiceTypeId: customType ? customType.id : '' })
    } catch (error) {
      this.setData({ loading: false, error: error.message || '服务项目载入失败' })
    }
  },

  onNoteInput(event) {
    this.setData({ note: event.detail.value })
  },

  async requestService(event) {
    return this.submitService(event.currentTarget.dataset.id, '')
  },

  async submitCustomRequest() {
    const note = this.data.note.trim()
    if (!note) {
      this.setData({ error: '请先填写您的个性化需求', success: '' })
      return
    }
    if (!this.data.customServiceTypeId) {
      this.setData({ error: '个性化需求服务暂未启用，请直接呼叫服务员', success: '' })
      return
    }
    return this.submitService(this.data.customServiceTypeId, note)
  },

  async submitService(serviceTypeId, note) {
    if (this.data.isFallback) {
      this.setData({ error: '开发占位数据不能提交服务，请启动本地 API 后重试' })
      return
    }
    this.setData({ submittingId: serviceTypeId, error: '', success: '' })
    try {
      const task = await createServiceTask({ serviceTypeId, note })
      this.setData({ success: task.customerReply || '已收到，服务人员正在处理。', note: '' })
    } catch (error) {
      this.setData({ error: error.message || '请求未提交，请重试' })
    } finally {
      this.setData({ submittingId: '' })
    }
  },
})
