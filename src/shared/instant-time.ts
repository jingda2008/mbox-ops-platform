// Mini uses CommonJS: keep this parser aligned with miniprogram/utils/format.js.
// instant-time.test.ts checks identical inputs across both runtime adapters.
// Business instants require an explicit zone. Never guess the phone timezone.
// Normalize PostgreSQL offsets and microseconds before the native ISO parser.
export function dateInput(value: unknown): string {
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

export function parseInstant(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) && Math.abs(value) <= 8640000000000000 ? value : NaN
  if (value instanceof Date) return value.getTime()
  const iso = dateInput(value)
  return iso ? Date.parse(iso) : NaN
}

