const { actOnTask, getGuestSession } = require('../../utils/api')
const { getRuntimeConfig } = require('../../config/index')
const { getTableSession } = require('../../utils/session')
const { TASK_STATUS, SONG_STATUS, dateTime } = require('../../utils/format')

Page({
  data: {
    loading: true,
    feedbackTaskId: '',
    error: '',
    warning: '',
    success: '',
    isDevelopment: false,
    isFallback: false,
    tableCode: '',
    tasks: [],
    songRequests: [],
  },

  onLoad() {
    this.setData({ tableCode: getTableSession().tableCode, isDevelopment: getRuntimeConfig().isDevelopment })
    this.loadData()
  },

  onShow() {
    if (!this.data.loading) this.loadData(true)
    this.stopPolling()
    this.pollTimer = setInterval(() => this.loadData(true), 5000)
  },

  onHide() {
    this.stopPolling()
  },

  onUnload() {
    this.stopPolling()
  },

  stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
  },

  onPullDownRefresh() {
    this.loadData().finally(() => wx.stopPullDownRefresh())
  },

  async loadData(silent) {
    if (!silent) this.setData({ loading: true, error: '' })
    try {
      const result = await getGuestSession()
      const data = result.data
      const serviceTypes = data.serviceTypes || []
      const tasks = (data.tasks || []).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20).map((task) => {
        const type = serviceTypes.find((item) => item.id === task.serviceTypeId)
        return {
          id: task.id,
          status: task.status,
          statusText: TASK_STATUS[task.status] || task.status,
          serviceName: type ? type.name : '服务请求',
          ownerName: task.ownerName || '领班调度池',
          createdAtText: dateTime(task.createdAt),
          canFeedback: task.status === 'completed',
        }
      })
      const songRequests = (data.songRequests || []).map((item) => ({
        id: item.id,
        songTitle: item.songTitle,
        singerName: item.singerName,
        statusText: SONG_STATUS[item.status] || item.status,
        createdAtText: dateTime(item.createdAt),
      }))
      this.setData({ loading: false, warning: result.warning, isFallback: result.source !== 'api', tasks, songRequests })
    } catch (error) {
      this.setData({ loading: false, error: error.message || '状态载入失败' })
    }
  },

  async submitFeedback(event) {
    if (this.data.isFallback) {
      this.setData({ error: '开发占位数据不能提交反馈，请启动本地 API 后重试' })
      return
    }
    const taskId = event.currentTarget.dataset.id
    const action = event.currentTarget.dataset.action
    this.setData({ feedbackTaskId: taskId, error: '', success: '' })
    try {
      await actOnTask(taskId, action)
      this.setData({ success: action === 'confirm' ? '感谢确认，本次服务已完成。' : '已升级处理，值班领班会继续跟进。' })
      await this.loadData()
    } catch (error) {
      this.setData({ error: error.message || '反馈未提交' })
    } finally {
      this.setData({ feedbackTaskId: '' })
    }
  },
})
