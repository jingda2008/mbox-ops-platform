const { getReservationPerformances } = require('../../utils/api')
const { dateTime } = require('../../utils/format')
const { customerErrorMessage } = require('../../utils/customer-error')

const DAYS_PER_PAGE = 5
const SWIPE_THRESHOLD = 48
const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function shanghaiDate(offsetDays) {
  return new Date(Date.now() + (offsetDays || 0) * 86400000 + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}
function monthText(date) { return `${date.slice(0, 4)}年${Number(date.slice(5, 7))}月` }
function selectedDateForMonth(value, previousDate) {
  const month = String(value || '').trim().slice(0, 7)
  if (!/^\d{4}-\d{2}$/.test(month)) return previousDate
  const previousDay = /^\d{4}-\d{2}-\d{2}$/.test(previousDate)
    ? Number(previousDate.slice(8, 10))
    : Number(shanghaiDate(0).slice(8, 10))
  const year = Number(month.slice(0, 4))
  const monthNumber = Number(month.slice(5, 7))
  const lastDay = new Date(year, monthNumber, 0).getDate()
  return `${month}-${String(Math.min(previousDay, lastDay)).padStart(2, '0')}`
}
function dateAt(date, offsetDays) {
  const year = Number(date.slice(0, 4))
  const month = Number(date.slice(5, 7))
  const day = Number(date.slice(8, 10))
  return new Date(Date.UTC(year, month - 1, day + offsetDays)).toISOString().slice(0, 10)
}

function weekdayText(date) {
  const year = Number(date.slice(0, 4))
  const month = Number(date.slice(5, 7))
  const day = Number(date.slice(8, 10))
  return WEEKDAY_LABELS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]
}

function calendarData(selectedDate, windowStartDate) {
  const today = shanghaiDate(0)
  const start = windowStartDate < today ? today : windowStartDate
  return {
    days: Array.from({ length: DAYS_PER_PAGE }, (_, index) => {
      const value = dateAt(start, index)
      return {
        value,
        day: String(Number(value.slice(8, 10))),
        weekday: weekdayText(value),
        marker: value === today ? '今天' : value.slice(8, 10) === '01' ? `${Number(value.slice(5, 7))}月` : '',
        isToday: value === today,
        isSelected: value === selectedDate,
      }
    }),
    calendarStartDate: start,
    canShowPrevious: start > today,
  }
}

Page({
  data: {
    loading: true, error: '', selectedDate: '', monthValue: '', minimumMonth: '', title: '',
    schedules: [], phase: '', days: [], calendarStartDate: '', canShowPrevious: false,
  },
  onLoad() {
    const date = shanghaiDate(0)
    this.setData({
      selectedDate: date,
      monthValue: date.slice(0, 7),
      minimumMonth: date.slice(0, 7),
      title: monthText(date),
      ...calendarData(date, date),
    })
    this.load()
  },
  onDateChange(event) {
    const selectedDate = selectedDateForMonth(event.detail.value, this.data.selectedDate)
    this.setData({
      selectedDate,
      monthValue: selectedDate.slice(0, 7),
      title: monthText(selectedDate),
      ...calendarData(selectedDate, selectedDate),
    })
    this.load()
  },
  selectDay(event) {
    const selectedDate = event.currentTarget.dataset.date
    if (!selectedDate || selectedDate < shanghaiDate(0)) return
    this.setData({
      selectedDate,
      title: monthText(selectedDate),
      ...calendarData(selectedDate, this.data.calendarStartDate),
    })
    this.load()
  },
  changeDayPage(event) {
    const direction = Number(event.currentTarget.dataset.direction)
    if (!direction) return
    const start = this.data.calendarStartDate || this.data.selectedDate
    const today = shanghaiDate(0)
    const shifted = dateAt(start, direction * DAYS_PER_PAGE)
    const nextStart = shifted < today ? today : shifted
    if (nextStart === start) return
    this.setData({
      selectedDate: nextStart,
      monthValue: nextStart.slice(0, 7),
      title: monthText(nextStart),
      ...calendarData(nextStart, nextStart),
    })
    this.load()
  },
  onCalendarTouchStart(event) {
    const touch = event.touches && event.touches[0]
    if (!touch) return
    this.calendarTouchStart = { x: touch.pageX, y: touch.pageY }
  },
  onCalendarTouchEnd(event) {
    const touch = event.changedTouches && event.changedTouches[0]
    const start = this.calendarTouchStart
    this.calendarTouchStart = null
    if (!touch || !start) return
    const deltaX = touch.pageX - start.x
    const deltaY = touch.pageY - start.y
    if (Math.abs(deltaX) < SWIPE_THRESHOLD || Math.abs(deltaX) <= Math.abs(deltaY)) return
    this.changeDayPage({ currentTarget: { dataset: { direction: deltaX < 0 ? 1 : -1 } } })
  },
  async load() {
    const date = this.data.selectedDate
    const requestId = (this.performanceRequestId || 0) + 1
    this.performanceRequestId = requestId
    this.setData({ loading: true, error: '' })
    try {
      const data = await getReservationPerformances(date)
      if (requestId !== this.performanceRequestId || date !== this.data.selectedDate) return
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
      if (requestId !== this.performanceRequestId || date !== this.data.selectedDate) return
      this.setData({ loading: false, schedules: [], error: customerErrorMessage(error, '演出安排暂时无法读取') })
    }
  },
})
