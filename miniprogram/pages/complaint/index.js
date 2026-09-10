const { createServiceTask } = require('../../utils/api')
const { getRuntimeConfig } = require('../../config/index')
const { getTableSession } = require('../../utils/session')
const { createTableRequestGuard, tableRequestScope } = require('../../utils/table-request-scope')
const { customerErrorMessage } = require('../../utils/customer-error')

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
    this.refreshScope()
    this.setData({ tableCode: getTableSession().tableCode, isDevelopment: getRuntimeConfig().isDevelopment })
  },
  onShow() { this.refreshScope() },
  refreshScope() {
    const scope = tableRequestScope(getTableSession())
    if (this.complaintScope !== scope) {
      this.complaintScope = scope
      this.guard = createTableRequestGuard(() => tableRequestScope(getTableSession()))
      this.setData({ submitting: false, details: '', categoryIndex: 0, error: '', success: '', tableCode: getTableSession().tableCode })
    }
  },

  onCategoryChange(event) { const index = Number(event.detail.value); if (!this.data.submitting && Number.isInteger(index) && index >= 0 && index < this.data.categories.length) this.setData({ categoryIndex: index }) },
  onDetailsInput(event) { if (!this.data.submitting) this.setData({ details: String(event.detail.value || '').slice(0, 300) }) },

  async submitComplaint() {
    if (this.data.submitting) return
    this.refreshScope()
    const details = this.data.details.trim()
    if (!details) {
      this.setData({ error: '请简要说明发生了什么，便于值班经理直接处理' })
      return
    }
    const guard = this.guard
    const request = guard.beginWrite(this.complaintScope, 'complaint')
    this.setData({ submitting: true, error: '', success: '' })
    try {
      const category = this.data.categories[this.data.categoryIndex]
      const response = await createServiceTask({ requestType: 'complaint', detail: `【${category}】${details}` })
      if (this.guard !== guard || !guard.isCurrentWrite(request)) return
      const result = response.data || response
      this.setData({ success: result.message || '已收到，值班经理会尽快到桌了解情况。', details: '' })
    } catch (error) {
      if (this.guard === guard && guard.isCurrentWrite(request)) this.setData({ error: customerErrorMessage(error, '请求结果尚未确认，可重试核对原请求') })
    } finally {
      if (guard.finishWrite(request) && this.guard === guard) this.setData({ submitting: false })
    }
  },
})
