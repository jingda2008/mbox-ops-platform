export const CHINA_TIME_ZONE = 'Asia/Shanghai'
export const CHINA_UTC_OFFSET = '+08:00'

type TimeInput = Date | string | number

function dateValue(value: TimeInput) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('时间格式无效')
  return date
}

function chinaParts(value: TimeInput) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CHINA_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(dateValue(value))
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? ''
  return {
    year: part('year'), month: part('month'), day: part('day'),
    hour: part('hour'), minute: part('minute'), second: part('second'),
  }
}

export function chinaDateKey(value: TimeInput = Date.now()) {
  const parts = chinaParts(value)
  return `${parts.year}-${parts.month}-${parts.day}`
}

export function chinaBusinessDateKey(value: TimeInput = Date.now(), rolloverHour = 6) {
  if (!Number.isInteger(rolloverHour) || rolloverHour < 0 || rolloverHour > 23) throw new Error('营业日切换小时无效')
  const parts = chinaParts(value)
  const date = `${parts.year}-${parts.month}-${parts.day}`
  return Number(parts.hour) < rolloverHour ? shiftDateKey(date, -1) : date
}

export function chinaDateTimeLocalValue(value: TimeInput) {
  const parts = chinaParts(value)
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
}

export function chinaLocalDateTimeToIso(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) throw new Error('北京时间必须使用YYYY-MM-DDTHH:mm格式')
  return new Date(`${value}${CHINA_UTC_OFFSET}`).toISOString()
}

export function shiftDateKey(date: string, days: number) {
  const value = new Date(`${date}T12:00:00.000Z`)
  if (Number.isNaN(value.getTime())) throw new Error('日期格式无效')
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

export function chinaStartOfDay(value: TimeInput = Date.now()) {
  return new Date(`${chinaDateKey(value)}T00:00:00${CHINA_UTC_OFFSET}`)
}

export function formatChinaTime(value: TimeInput, options: Intl.DateTimeFormatOptions = {}) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit', minute: '2-digit', hour12: false,
    ...options,
    timeZone: CHINA_TIME_ZONE,
  }).format(dateValue(value))
}

export function formatChinaDateTime(value: TimeInput, options: Intl.DateTimeFormatOptions = {}) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    ...options,
    timeZone: CHINA_TIME_ZONE,
  }).format(dateValue(value))
}
