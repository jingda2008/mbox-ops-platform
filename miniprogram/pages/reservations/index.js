const { getReservations, createCustomerReservation } = require('../../utils/api')
const { getRuntimeConfig } = require('../../config/index')

const STATUS_NAMES = {
  requested: '待确认',
  confirmed: '已确认',
  arrived: '已到店',
  seated: '已入座',
  cancelled: '已取消',
  no_show: '未到店',
}

function shanghaiDate(daysFromToday) {
  return new Date(Date.now() + (daysFromToday * 86400000) + (8 * 3600000)).toISOString().slice(0, 10)
}

function displayTime(value) {
  const chinaTime = new Date(Date.parse(value) + (8 * 3600000)).toISOString()
  return `${chinaTime.slice(0, 10)} ${chinaTime.slice(11, 16)}`
}

Page({
  data: {
    loading: true,
    submitting: false,
    error: '',
    success: '',
    isDevelopment: false,
    config: null,
    reservations: [],
    customerName: '',
    partySize: 2,
    reservationDate: '',
    reservationTime: '20:00',
    minimumDate: '',
    areaOptions: [{ code: '', name: '不限区域' }],
    areaIndex: 0,
    occasionOptions: [{ code: '', name: '无特殊场景' }],
    occasionIndex: 0,
    occasionNote: '',
  },

  onLoad() {
    this.setData({
      isDevelopment: getRuntimeConfig().isDevelopment,
      minimumDate: shanghaiDate(0),
      reservationDate: shanghaiDate(1),
    })
    this.loadData()
  },

  onPullDownRefresh() {
    this.loadData().finally(() => wx.stopPullDownRefresh())
  },

  async loadData() {
    this.setData({ loading: true, error: '' })
    try {
      const data = await getReservations()
      const areaOptions = [{ code: '', name: '不限区域' }].concat(data.config.areaPreferences || [])
      const occasionOptions = [{ code: '', name: '无特殊场景' }].concat(data.config.occasions || [])
      const reservations = (data.reservations || []).map((item) => Object.assign({}, item, {
        statusText: STATUS_NAMES[item.status] || item.status,
        scheduledAtText: displayTime(item.scheduledAt),
        areaName: (areaOptions.find((option) => option.code === item.areaPreferenceCode) || {}).name || '不限区域',
        occasionName: (occasionOptions.find((option) => option.code === item.occasionCode) || {}).name || '',
      }))
      this.setData({
        loading: false,
        config: data.config,
        areaOptions,
        occasionOptions,
        reservations,
      })
    } catch (error) {
      this.setData({ loading: false, error: error.message || '预约信息载入失败' })
    }
  },

  onNameInput(event) { this.setData({ customerName: event.detail.value }) },
  onPartySizeInput(event) { this.setData({ partySize: Number(event.detail.value) || 0 }) },
  onDateChange(event) { this.setData({ reservationDate: event.detail.value }) },
  onTimeChange(event) { this.setData({ reservationTime: event.detail.value }) },
  onAreaChange(event) { this.setData({ areaIndex: Number(event.detail.value) }) },
  onOccasionChange(event) { this.setData({ occasionIndex: Number(event.detail.value) }) },
  onNoteInput(event) { this.setData({ occasionNote: event.detail.value }) },

  async submitReservation() {
    if (this.data.submitting) return
    const customerName = this.data.customerName.trim()
    const config = this.data.config
    if (!customerName) return this.setData({ error: '请填写预约称呼', success: '' })
    if (!config || this.data.partySize < config.minimumPartySize || this.data.partySize > config.maximumPartySize) {
      return this.setData({ error: `预约人数需在 ${config ? config.minimumPartySize : 1} 至 ${config ? config.maximumPartySize : 100} 人之间`, success: '' })
    }
    const area = this.data.areaOptions[this.data.areaIndex]
    const occasion = this.data.occasionOptions[this.data.occasionIndex]
    const payload = {
      customerName,
      partySize: this.data.partySize,
      scheduledAt: `${this.data.reservationDate}T${this.data.reservationTime}:00+08:00`,
      occasionNote: this.data.occasionNote.trim(),
    }
    if (area && area.code) payload.areaPreferenceCode = area.code
    if (occasion && occasion.code) payload.occasionCode = occasion.code
    this.setData({ submitting: true, error: '', success: '' })
    try {
      await createCustomerReservation(payload)
      this.setData({ success: '预约已提交，门店确认后状态会在本页更新', occasionNote: '' })
      await this.loadData()
    } catch (error) {
      this.setData({ error: error.message || '预约提交失败' })
    } finally {
      this.setData({ submitting: false })
    }
  },
})
