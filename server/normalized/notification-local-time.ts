/** Human-facing venue notification time. Never inherit the worker host's TZ. */
export function notificationLocalTime(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new TypeError('Notification time is invalid')
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date)
  const field = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)!.value
  return `${field('year')}-${field('month')}-${field('day')} ${field('hour')}:${field('minute')}`
}
