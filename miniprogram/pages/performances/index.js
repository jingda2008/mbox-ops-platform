const { getReservationPerformances } = require('../../utils/api')
const { dateTime } = require('../../utils/format')
const { customerErrorMessage } = require('../../utils/customer-error')

function shanghaiDate(offsetDays) {
  return new Date(Date.now() + (offsetDays || 0) * 86400000 + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}
function monthText(date) { return `${date.slice(0, 4)}年${Number(date.slice(5, 7))}月` }
function monthDays(date) {
  const year = Number(date.slice(0, 4))
  const month = Number(date.slice(5, 7))
  const total = new Date(year, month, 0).getDate()
  const today = shanghaiDate(0)
  return Array.from({ length: total }, (_, index) => {
    const day = String(index + 1).padStart(2, '0')
    const value = `${date.slice(0, 7)}-${day}`
    return {
      value,
      label: `${index + 1}`,
      isToday: value === today,
      isSelected: false,
    }
  })
}

Page({
  data: {
    loading: true, error: '', selectedDate: '', minimumDate: '', title: '',
    schedules: [], phase: '', days: [],
  },
  onLoad() {
    const date = shanghaiDate(0)
    this.setData({
      selectedDate: date,
      minimumDate: date,
      title: monthText(date),
      days: monthDays(date).map((item) => Object.assign({}, item, { isSelected: item.value === date })),
    })
    this.load()
  },
  onDateChange(event) {
    const selectedDate = event.detail.value
    this.setData({
      selectedDate,
      title: monthText(selectedDate),
      days: monthDays(selectedDate).map((item) => Object.assign({}, item, { isSelected: item.value === selectedDate })),
    })
    this.load()
  },
  selectDay(event) {
    const selectedDate = event.currentTarget.dataset.date
    if (!selectedDate) return
    this.setData({
      selectedDate,
      title: monthText(selectedDate),
      days: this.data.days.map((item) => Object.assign({}, item, { isSelected: item.value === selectedDate })),
    })
    this.load()
  },
  async load() {
    const date = this.data.selectedDate
    this.setData({ loading: true, error: '' })
    try {
      const data = await getReservationPerformances(date)
      const schedules = (data.schedules || []).filter((item) => item.status !== 'cancelled').map((item) => ({
        id: item.id,
        performer: item.performerStageName,
        imageUrl: item.performerProfile && item.performerProfile.imageUrl,
        bio: item.performerProfile && item.performerProfile.bio || '',
        tags: item.performerProfile && ([]).concat(item.performerProfile.genres || [], item.performerProfile.styles || []).slice(0, 3).join(' · '),
        timeText: `${dateTime(item.startsAt)}–${dateTime(item.endsAt).slice(6)}`,
      }))
      this.setData({ loading: false, schedules, phase: data.phase || '' })
    } catch (error) {
      this.setData({ loading: false, schedules: [], error: customerErrorMessage(error, '演出安排暂时无法读取') })
    }
  },
})
