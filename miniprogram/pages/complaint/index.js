const { createServiceTask, getGuestSession } = require('../../utils/api')
const { getRuntimeConfig } = require('../../config/index')
const { getTableSession } = require('../../utils/session')

Page({
  data: {
    loading: true,
    submitting: false,
    error: '',
    warning: '',
    success: '',
    isDevelopment: false,
    isFallback: false,
    tableCode: '',
    complaintServiceId: '',
    categories: ['服务响应慢', '服务态度', '商品或出品', '账单疑问', '现场安全', '其他问题'],
    categoryIndex: 0,
    details: '',
  },

  onLoad() {
    this.setData({ tableCode: getTableSession().tableCode, isDevelopment: getRuntimeConfig().isDevelopment })
    this.loadData()
  },

  async loadData() {
    try {
      const result = await getGuestSession()
      const service = (result.data.serviceTypes || []).find((item) => item.code === 'complaint' || item.id === 'complaint')
      this.setData({
        loading: false,
        warning: result.warning,
        isFallback: result.source !== 'api',
        complaintServiceId: service ? service.id : '',
        error: service ? '' : '门店当前未启用投诉服务，请直接联系值班经理',
      })
    } catch (error) {
      this.setData({ loading: false, error: error.message || '投诉通道载入失败' })
    }
  },

  onCategoryChange(event) {
    this.setData({ categoryIndex: Number(event.detail.value) })
  },

  onDetailsInput(event) {
    this.setData({ details: event.detail.value })
  },

  async submitComplaint() {
    if (!this.data.details.trim()) {
      this.setData({ error: '请简要说明发生了什么，便于领班直接处理' })
      return
    }
    if (this.data.isFallback) {
      this.setData({ error: '开发占位数据不能提交投诉，请启动本地 API 后重试' })
      return
    }
    this.setData({ submitting: true, error: '', success: '' })
    try {
      const category = this.data.categories[this.data.categoryIndex]
      const task = await createServiceTask({
        serviceTypeId: this.data.complaintServiceId,
        note: `【${category}】${this.data.details.trim()}`,
      })
      this.setData({ success: task.customerReply || '投诉已收到，领班将继续跟进。', details: '' })
    } catch (error) {
      this.setData({ error: error.message || '投诉未提交，请重试' })
    } finally {
      this.setData({ submitting: false })
    }
  },
})
