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

function dateInput(value) {
  const source = String(value || '').trim()
  if (!source) return ''
  // PostgreSQL's common `YYYY-MM-DD HH:mm:ss+08` presentation is accepted by
  // Chromium but not consistently by iOS WebKit.  Normalize it to ISO-8601
  // before passing it to Date so the same activity/service time is shown on
  // both platforms.  Values already using `T` or an explicit minute offset
  // are left intact.
  const compactOffset = source.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)([+-]\d{2})$/)
  if (compactOffset) return `${compactOffset[1]}T${compactOffset[2]}${compactOffset[3]}:00`
  return source.replace(/^(\d{4}-\d{2}-\d{2})\s+/, '$1T')
}

function dateTime(value) {
  if (!value) return '--'
  const date = new Date(dateInput(value))
  if (Number.isNaN(date.getTime())) return '--'
  const pad = (number) => String(number).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

module.exports = { TASK_STATUS, SONG_STATUS, money, dateInput, dateTime }
