const TASK_STATUS = {
  pending: '等待接单',
  accepted: '服务人员已接单',
  arrived: '服务人员已到桌',
  completed: '等待您确认',
  confirmed: '已解决',
  reopened: '已升级继续处理',
  escalated: '已升级处理',
  cancelled: '已取消',
}

const SONG_STATUS = {
  pending_confirmation: '待服务伙伴确认',
  pending_payment: '等待现场收费',
  paid: '现场已收款',
  accepted: '舞台已接单',
  performing: '正在演唱',
  completed: '已演唱',
  rejected: '无法安排',
  cancelled: '已取消',
  refund_required: '退款处理中',
  refunded: '已退款',
}

function money(amount) {
  return `¥${(Number(amount || 0) / 100).toFixed(2)}`
}

// Business instants require an explicit zone. Never guess the phone timezone.
// Normalize PostgreSQL offsets and microseconds before the native ISO parser.
function dateInput(value) {
  if (typeof value !== 'string') return ''
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(value.trim())
  if (!match) return ''
  const [, year, month, day, hour, minute, second = '00', fraction, offset] = match
  if (!offset) return ''
  const calendar = new Date(0)
  calendar.setUTCFullYear(Number(year), Number(month) - 1, Number(day))
  if (calendar.getUTCFullYear() !== Number(year) || calendar.getUTCMonth() + 1 !== Number(month)
    || calendar.getUTCDate() !== Number(day) || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return ''
  const digits = offset.slice(1).replace(':', '')
  if (offset !== 'Z' && (Number(digits.slice(0, 2)) > 23 || Number(digits.slice(2) || 0) > 59)) return ''
  const zone = offset === 'Z' ? 'Z' : offset[0] + digits.slice(0, 2) + ':' + (digits.slice(2) || '00')
  const millis = fraction ? '.' + (fraction + '00').slice(0, 3) : ''
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${millis}${zone}`
}

function parseInstant(value) {
  if (typeof value === 'number') return Number.isFinite(value) && Math.abs(value) <= 8640000000000000 ? value : NaN
  if (value instanceof Date) return value.getTime()
  const iso = dateInput(value)
  return iso ? Date.parse(iso) : NaN
}

function beijingDateTime(value, fallback = '--') {
  const instant = parseInstant(value)
  if (!Number.isFinite(instant)) return fallback
  const date = new Date(instant + 28800000)
  if (!Number.isFinite(date.getTime())) return fallback
  return date.toISOString().slice(0, 16).replace('T', ' ')
}

function beijingDate(value, fallback = '--') {
  // A calendar date (birthday/business date) is not an instant to shift.
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && dateInput(value + 'T00:00:00Z')) return value
  const text = beijingDateTime(value, '')
  return text ? text.slice(0, 10) : fallback
}

function dateTime(value) {
  const text = beijingDateTime(value, '')
  return text ? text.slice(5) : '--'
}

module.exports = { TASK_STATUS, SONG_STATUS, money, dateInput, parseInstant, beijingDateTime, beijingDate, dateTime }
