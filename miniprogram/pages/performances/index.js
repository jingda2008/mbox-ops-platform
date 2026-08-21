const { getReservationPerformances } = require('../../utils/api')
const { dateTime } = require('../../utils/format')

function shanghaiDate() { return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10) }
function monthText(date) { return `${date.slice(0, 4)}年${Number(date.slice(5, 7))}月` }

Page({
  data: { loading: true, error: '', selectedDate: '', minimumDate: '', title: '', schedules: [], phase: '' },
  onLoad() { const date = shanghaiDate(); this.setData({ selectedDate: date, minimumDate: date, title: monthText(date) }); this.load() },
  onDateChange(event) { const selectedDate = event.detail.value; this.setData({ selectedDate, title: monthText(selectedDate) }); this.load() },
  async load() {
    const date = this.data.selectedDate
    this.setData({ loading: true, error: '' })
    try {
      const data = await getReservationPerformances(date)
      const schedules = (data.schedules || []).filter((item) => item.status !== 'cancelled').map((item) => ({
        id: item.id, performer: item.performerStageName, imageUrl: item.performerProfile && item.performerProfile.imageUrl,
        tags: item.performerProfile && ([]).concat(item.performerProfile.genres || [], item.performerProfile.styles || []).slice(0, 3).join(' · '),
        timeText: `${dateTime(item.startsAt)}–${dateTime(item.endsAt).slice(6)}`,
      }))
      this.setData({ loading: false, schedules, phase: data.phase || '' })
    } catch (error) { this.setData({ loading: false, schedules: [], error: error.message || '演出安排暂时无法读取' }) }
  },
})
