const { createServiceTask } = require('../../utils/api')
const { getRuntimeConfig } = require('../../config/index')
const { getTableSession } = require('../../utils/session')

Page({
  data: {
    submitting: false,
    error: '',
    success: '',
    isDevelopment: false,
    tableCode: '',
    categories: ['服务响应慢', '服务态度', '商品或出品', '账单疑问', '现场安全', '其他问题'],
    categoryIndex: 0,
    details: '',
  },

  onLoad() {
    this.setData({ tableCode: getTableSession().tableCode, isDevelopment: getRuntimeConfig().isDevelopment })
  },

  onCategoryChange(event) { this.setData({ categoryIndex: Number(event.detail.value) }) },
  onDetailsInput(event) { this.setData({ details: event.detail.value }) },

  async submitComplaint() {
    const details = this.data.details.trim()
    if (!details) {
      this.setData({ error: '请简要说明发生了什么，便于值班经理直接处理' })
      return
    }
    this.setData({ submitting: true, error: '', success: '' })
    try {
      const category = this.data.categories[this.data.categoryIndex]
      const response = await createServiceTask({ requestType: 'complaint', detail: `【${category}】${details}` })
      const result = response.data || response
      this.setData({ success: result.message || '已收到，值班经理会尽快到桌了解情况。', details: '' })
    } catch (error) {
      this.setData({ error: error.message || '投诉未提交，请重试' })
    } finally {
      this.setData({ submitting: false })
    }
  },
})
