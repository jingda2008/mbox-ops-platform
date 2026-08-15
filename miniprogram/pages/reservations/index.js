const { getReservations, getReservationAvailability, createCustomerReservation } = require('../../utils/api')
const { getRuntimeConfig } = require('../../config/index')
const { money } = require('../../utils/format')

const STATUS_NAMES = { pending: '待门店确认', confirmed: '已确认', arrived: '已到店', seated: '已入座', cancelled: '已取消', no_show: '未到店', expired: '已失效' }
const SEATS = [
  { code: 'no_preference', name: '由门店安排' }, { code: 'comfortable_booth', name: '舒适卡座' },
  { code: 'stage_atmosphere', name: '靠近舞台' }, { code: 'quiet_chat', name: '适合聊天' }, { code: 'outdoor_view', name: '外景位置' },
]
const OCCASIONS = [
  { code: '', name: '普通到店' }, { code: 'date', name: '约会' }, { code: 'friends', name: '朋友聚会' },
  { code: 'business', name: '商务沟通' }, { code: 'birthday', name: '生日庆祝' }, { code: 'proposal', name: '求婚/特别安排' },
]

function shanghaiDate(daysFromToday) { return new Date(Date.now() + daysFromToday * 86400000 + 8 * 3600000).toISOString().slice(0, 10) }
function displayTime(value) { return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }

Page({
  data: {
    loading: true, checking: false, submitting: false, error: '', success: '', isDevelopment: false,
    reservations: [], customerName: '', contact: '', partySize: 2, reservationDate: '', reservationTime: '20:00', minimumDate: '',
    seatOptions: SEATS, seatIndex: 0, occasionOptions: OCCASIONS, occasionIndex: 0, occasionNote: '',
    availability: null, availabilityText: '选择时间后确认容量', depositText: '',
  },
  onLoad() {
    this.setData({ isDevelopment: getRuntimeConfig().isDevelopment, minimumDate: shanghaiDate(0), reservationDate: shanghaiDate(1) })
    this.loadData()
  },
  onPullDownRefresh() { Promise.all([this.loadData(), this.checkAvailability()]).finally(() => wx.stopPullDownRefresh()) },
  async loadData() {
    this.setData({ loading: true, error: '' })
    try {
      const data = await getReservations()
      const reservations = (data.reservations || []).map((item) => ({
        ...item,
        statusText: STATUS_NAMES[item.status] || item.status,
        scheduledAtText: displayTime(item.arrivalAt),
        partySize: item.guestCount,
        seatName: (SEATS.find((option) => option.code === item.seatPreference) || SEATS[0]).name,
      }))
      this.setData({ loading: false, reservations })
      await this.checkAvailability()
    } catch (error) { this.setData({ loading: false, error: error.message || '预约信息载入失败' }) }
  },
  arrivalAt() { return `${this.data.reservationDate}T${this.data.reservationTime}:00+08:00` },
  async checkAvailability() {
    if (this.data.partySize < 1 || this.data.partySize > 20) return
    this.setData({ checking: true })
    try {
      const availability = await getReservationAvailability(this.arrivalAt(), this.data.partySize)
      const rule = availability.depositRule || {}
      this.setData({
        availability,
        availabilityText: availability.acceptingReservations ? '当前可提交，具体桌位由门店确认' : '当前容量不足，请调整时间或人数',
        depositText: rule.enabled ? `预约规则：需付${money(rule.amountMinor || 0)}定金，${rule.ruleText || '以门店确认为准'}` : '预约规则：当前不要求线上定金',
      })
    } catch (error) { this.setData({ availability: null, availabilityText: error.message || '暂时无法确认容量', depositText: '' }) }
    finally { this.setData({ checking: false }) }
  },
  onNameInput(event) { this.setData({ customerName: event.detail.value }) },
  onContactInput(event) { this.setData({ contact: event.detail.value }) },
  onPartySizeInput(event) { this.setData({ partySize: Number(event.detail.value) || 0 }) },
  onPartySizeConfirm() { this.checkAvailability() },
  onDateChange(event) { this.setData({ reservationDate: event.detail.value }, () => this.checkAvailability()) },
  onTimeChange(event) { this.setData({ reservationTime: event.detail.value }, () => this.checkAvailability()) },
  onSeatChange(event) { this.setData({ seatIndex: Number(event.detail.value) }) },
  onOccasionChange(event) { this.setData({ occasionIndex: Number(event.detail.value) }) },
  onNoteInput(event) { this.setData({ occasionNote: event.detail.value }) },
  async submitReservation() {
    if (this.data.submitting) return
    const customerName = this.data.customerName.trim()
    const contact = this.data.contact.trim()
    if (!customerName) return this.setData({ error: '请填写预约称呼', success: '' })
    if (contact.length < 3) return this.setData({ error: '请填写可联系的手机号或微信', success: '' })
    if (this.data.partySize < 1 || this.data.partySize > 20) return this.setData({ error: '线上预约人数需在1至20人之间，更多人数请联系活动经理', success: '' })
    this.setData({ submitting: true, error: '', success: '' })
    try {
      const availability = await getReservationAvailability(this.arrivalAt(), this.data.partySize)
      if (!availability.acceptingReservations) throw new Error('当前时间容量不足，请调整人数或时间')
      const occasion = this.data.occasionOptions[this.data.occasionIndex]
      const noteParts = [occasion.code ? `到店场景：${occasion.name}` : '', this.data.occasionNote.trim()].filter(Boolean)
      await createCustomerReservation({
        customerName, contact, partySize: this.data.partySize, scheduledAt: this.arrivalAt(),
        seatPreference: this.data.seatOptions[this.data.seatIndex].code, note: noteParts.join('；') || null,
      })
      this.setData({ success: '预约已提交，门店确认后状态会在本页更新', occasionNote: '' })
      await this.loadData()
    } catch (error) { this.setData({ error: error.message || '预约提交失败' }) }
    finally { this.setData({ submitting: false }) }
  },
})
