const { dateInput, dateTime } = require('./format')

// Display only. The server remains authoritative for visibility and booking.
function currentActivities(items, now = Date.now()) {
  return (Array.isArray(items) ? items : []).filter((item) => {
    if (!item) return false
    if (item.status && !['published', 'full'].includes(item.status)) return false
    const end = new Date(dateInput(item.endsAt)).getTime()
    return Number.isFinite(end) && end > now
  })
}

function activityTimeText(item, now = Date.now()) {
  const start = new Date(dateInput(item.startsAt)).getTime()
  return Number.isFinite(start) && start <= now
    ? `进行中 · 至 ${dateTime(item.endsAt)}`
    : `${dateTime(item.startsAt)} 开始`
}

module.exports = { currentActivities, activityTimeText }
