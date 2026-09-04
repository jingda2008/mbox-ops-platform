const { getTodayPerformances, submitSongRequest } = require('../../utils/api')
const { getRuntimeConfig } = require('../../config/index')
const { getTableSession } = require('../../utils/session')
const { dateTime } = require('../../utils/format')
const { customerErrorMessage } = require('../../utils/customer-error')

Page({
  data: {
    loading: true,
    submitting: false,
    error: '',
    success: '',
    isDevelopment: false,
    tableCode: '',
    phaseText: '',
    schedules: [],
    scheduleIndex: 0,
    songTitle: '',
    note: '',
    requestExtension: false,
  },

  onLoad() {
    this.setData({ tableCode: getTableSession().tableCode, isDevelopment: getRuntimeConfig().isDevelopment })
  },

  onShow() { this.loadData() },

  async loadData() {
    this.setData({ loading: true, error: '' })
    try {
      const view = await getTodayPerformances()
      const schedules = (view.schedules || []).filter((item) => item.status !== 'cancelled').map((item) => ({
        id: item.id,
        performerStageName: item.performerStageName,
        timeText: `${dateTime(item.startsAt)} - ${dateTime(item.endsAt).slice(6)}`,
        statusText: item.id === (view.current && view.current.id) ? '正在演出' : item.id === (view.next && view.next.id) ? '下一场' : '今晚场次',
      }))
      this.setData({
        loading: false,
        schedules,
        scheduleIndex: Math.max(0, schedules.findIndex((item) => item.id === ((view.current || view.next || {}).id))),
        phaseText: phaseText(view.phase),
      })
    } catch (error) {
      this.setData({ loading: false, error: customerErrorMessage(error, '当晚演出排班载入失败') })
    }
  },

  onScheduleChange(event) { this.setData({ scheduleIndex: Number(event.detail.value) }) },
  onSongInput(event) { this.setData({ songTitle: event.detail.value }) },
  onNoteInput(event) { this.setData({ note: event.detail.value }) },
  onExtensionChange(event) { this.setData({ requestExtension: Boolean(event.detail.value) }) },

  async submitIntent() {
    const schedule = this.data.schedules[this.data.scheduleIndex]
    const songTitle = this.data.songTitle.trim()
    if (!schedule) return this.setData({ error: '今晚没有可选择的演出场次' })
    if (!songTitle) return this.setData({ error: '请输入想听的歌曲名称' })
    this.setData({ submitting: true, error: '', success: '' })
    try {
      const response = await submitSongRequest({
        scheduleId: schedule.id,
        songTitle,
        requestType: 'custom',
        note: this.data.note.trim() || null,
        requestExtension: this.data.requestExtension,
      })
      const result = response.data || response
      const request = result.request || {}
      this.setData({
        songTitle: '', note: '', requestExtension: false,
        success: '点歌意向已提交，舞台确认后会显示最新进展。',
      })
    } catch (error) {
      this.setData({ error: customerErrorMessage(error, '点歌意向未提交') })
    } finally {
      this.setData({ submitting: false })
    }
  },
})

function phaseText(phase) {
  return ({ no_schedule: '今晚暂无排班', upcoming: '演出即将开始', live: '演出进行中', between: '场间休息', ended: '今晚演出已结束' })[phase] || '当晚演出'
}
