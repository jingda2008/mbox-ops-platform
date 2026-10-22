const { getTodayPerformances, submitSongRequest } = require('../../utils/api')
const { getRuntimeConfig } = require('../../config/index')
const { getTableSession } = require('../../utils/session')
const { dateTime } = require('../../utils/format')
const { customerErrorMessage } = require('../../utils/customer-error')
const { createTableRequestGuard, tableRequestScope } = require('../../utils/table-request-scope')

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
    this.refreshTable()
  },

  onShow() { this.refreshTable(); this.loadData() },
  onHide() { this.invalidateRequests() },
  onUnload() { this.invalidateRequests() },
  ensureGuard() { if (!this.requestGuard) this.requestGuard = createTableRequestGuard(() => tableRequestScope(getTableSession())); return this.requestGuard },
  invalidateRequests() { this.ensureGuard().invalidate(); this.readGeneration = (this.readGeneration || 0) + 1; this.setData({ submitting: false }) },
  refreshTable() {
    const request = this.ensureGuard().begin(tableRequestScope(getTableSession()))
    if (request.scope !== this.visibleScope) {
      this.visibleScope = request.scope
      this.setData({ songTitle: '', note: '', requestExtension: false, schedules: [], scheduleIndex: 0, error: '', success: '', submitting: false })
    }
    this.setData({ tableCode: getTableSession().tableCode || '' })
    return request
  },

  async loadData() {
    const generation = this.readGeneration = (this.readGeneration || 0) + 1
    this.setData({ loading: true, error: '' })
    try {
      const view = await getTodayPerformances()
      if (generation !== this.readGeneration) return
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
      if (generation !== this.readGeneration) return
      this.setData({ loading: false, error: customerErrorMessage(error, '当晚演出排班载入失败') })
    }
  },

  onScheduleChange(event) { if (!this.data.submitting) { const index = Number(event.detail.value); if (Number.isInteger(index) && this.data.schedules[index]) this.setData({ scheduleIndex: index }) } },
  onSongInput(event) { if (!this.data.submitting) this.setData({ songTitle: String(event.detail.value || '').slice(0, 200) }) },
  onNoteInput(event) { if (!this.data.submitting) this.setData({ note: String(event.detail.value || '').slice(0, 300) }) },
  onExtensionChange(event) { if (!this.data.submitting) this.setData({ requestExtension: Boolean(event.detail.value) }) },

  async submitIntent() {
    if (this.data.submitting || this.data.loading) return
    const request = this.ensureGuard().current()
    if (!this.ensureGuard().isCurrent(request)) return
    const schedule = this.data.schedules[this.data.scheduleIndex]
    const songTitle = this.data.songTitle.trim()
    if (!schedule) return this.setData({ error: '今晚没有可选择的演出场次' })
    if (!songTitle) return this.setData({ error: '请输入想听的歌曲名称' })
    this.setData({ submitting: true, error: '', success: '' })
    try {
      await submitSongRequest({
        scheduleId: schedule.id,
        songTitle,
        requestType: 'custom',
        note: this.data.note.trim() || null,
        requestExtension: this.data.requestExtension,
      })
      if (!this.ensureGuard().isCurrent(request)) return
      this.setData({
        songTitle: '', note: '', requestExtension: false,
        success: '点歌意向已提交，舞台确认后会显示最新进展。',
      })
    } catch (error) {
      if (!this.ensureGuard().isCurrent(request)) return
      this.setData({ error: customerErrorMessage(error, '点歌意向未提交') })
    } finally {
      if (this.ensureGuard().isCurrent(request)) this.setData({ submitting: false })
    }
  },
})

function phaseText(phase) {
  return ({ no_schedule: '今晚暂无排班', upcoming: '演出即将开始', live: '演出进行中', between: '场间休息', ended: '今晚演出已结束' })[phase] || '当晚演出'
}
