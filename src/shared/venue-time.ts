export const DEFAULT_VENUE_TIME_ZONE = 'Asia/Shanghai'
export const DEFAULT_BUSINESS_DAY_ROLLOVER_HOUR = 6

export type TimeInput = Date | string | number

export interface Clock {
  now(): number
}

export const systemClock: Clock = Object.freeze({ now: () => Date.now() })

type VenueDateTimeParts = {
  year: string
  month: string
  day: string
  hour: string
  minute: string
  second: string
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>()

function dateValue(value: TimeInput) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('时间格式无效')
  return date
}

export function assertIanaTimeZone(timeZone: string) {
  const normalized = timeZone.trim()
  if (!normalized) throw new Error('门店时区不能为空')
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: normalized }).format(0)
  } catch {
    throw new Error(`门店时区无效：${normalized}`)
  }
  return normalized
}

function partsFormatter(timeZone: string) {
  const normalized = assertIanaTimeZone(timeZone)
  const cached = partsFormatters.get(normalized)
  if (cached) return cached
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: normalized,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  })
  partsFormatters.set(normalized, formatter)
  return formatter
}

export function venueDateTimeParts(value: TimeInput, timeZone = DEFAULT_VENUE_TIME_ZONE): VenueDateTimeParts {
  const parts = partsFormatter(timeZone).formatToParts(dateValue(value))
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? ''
  return {
    year: part('year'), month: part('month'), day: part('day'),
    hour: part('hour'), minute: part('minute'), second: part('second'),
  }
}

export function venueDateKey(value: TimeInput = systemClock.now(), timeZone = DEFAULT_VENUE_TIME_ZONE) {
  const parts = venueDateTimeParts(value, timeZone)
  return `${parts.year}-${parts.month}-${parts.day}`
}

export function shiftDateKey(date: string, days: number) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isSafeInteger(days)) throw new Error('日期格式无效')
  const value = new Date(`${date}T12:00:00.000Z`)
  if (Number.isNaN(value.getTime())) throw new Error('日期格式无效')
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

export function venueBusinessDateKey(
  value: TimeInput = systemClock.now(),
  timeZone = DEFAULT_VENUE_TIME_ZONE,
  rolloverHour = DEFAULT_BUSINESS_DAY_ROLLOVER_HOUR,
) {
  if (!Number.isInteger(rolloverHour) || rolloverHour < 0 || rolloverHour > 23) throw new Error('营业日切换小时无效')
  const parts = venueDateTimeParts(value, timeZone)
  const date = `${parts.year}-${parts.month}-${parts.day}`
  return Number(parts.hour) < rolloverHour ? shiftDateKey(date, -1) : date
}

export function venueDateTimeLocalValue(value: TimeInput, timeZone = DEFAULT_VENUE_TIME_ZONE) {
  const parts = venueDateTimeParts(value, timeZone)
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
}

export function venueDateTimeOffsetValue(value: TimeInput, timeZone = DEFAULT_VENUE_TIME_ZONE) {
  const instant = dateValue(value)
  const parts = venueDateTimeParts(instant, timeZone)
  const representedWallTime = localPartsAsUtcMillis(parts)
  const offsetMinutes = Math.round((representedWallTime - instant.getTime()) / 60_000)
  const sign = offsetMinutes < 0 ? '-' : '+'
  const absolute = Math.abs(offsetMinutes)
  const offset = `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`
}

function localPartsAsUtcMillis(value: VenueDateTimeParts) {
  return Date.UTC(
    Number(value.year), Number(value.month) - 1, Number(value.day),
    Number(value.hour), Number(value.minute), Number(value.second),
  )
}

export function venueLocalDateTimeToIso(value: string, timeZone = DEFAULT_VENUE_TIME_ZONE) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value)
  if (!match) throw new Error('门店本地时间必须使用YYYY-MM-DDTHH:mm格式')
  const desired: VenueDateTimeParts = {
    year: match[1]!, month: match[2]!, day: match[3]!,
    hour: match[4]!, minute: match[5]!, second: match[6] ?? '00',
  }
  const desiredWallTime = localPartsAsUtcMillis(desired)
  if (!Number.isFinite(desiredWallTime)) throw new Error('门店本地时间无效')

  // Resolve the IANA-zone offset at the target instant. Iteration is required
  // because the offset at the naive UTC guess can differ near a zone transition.
  let candidate = desiredWallTime
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const representedWallTime = localPartsAsUtcMillis(venueDateTimeParts(candidate, timeZone))
    const next = candidate + (desiredWallTime - representedWallTime)
    if (next === candidate) break
    candidate = next
  }
  const roundTrip = venueDateTimeParts(candidate, timeZone)
  if (Object.keys(desired).some((key) => desired[key as keyof VenueDateTimeParts] !== roundTrip[key as keyof VenueDateTimeParts])) {
    throw new Error('门店本地时间在所选时区不存在或无法唯一转换')
  }
  return new Date(candidate).toISOString()
}

export function venueStartOfDay(value: TimeInput = systemClock.now(), timeZone = DEFAULT_VENUE_TIME_ZONE) {
  return new Date(venueLocalDateTimeToIso(`${venueDateKey(value, timeZone)}T00:00`, timeZone))
}

export function formatVenueTime(
  value: TimeInput,
  timeZone = DEFAULT_VENUE_TIME_ZONE,
  options: Intl.DateTimeFormatOptions = {},
) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit', minute: '2-digit', hour12: false,
    ...options,
    timeZone: assertIanaTimeZone(timeZone),
  }).format(dateValue(value))
}

export function formatVenueDateTime(
  value: TimeInput,
  timeZone = DEFAULT_VENUE_TIME_ZONE,
  options: Intl.DateTimeFormatOptions = {},
) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    ...options,
    timeZone: assertIanaTimeZone(timeZone),
  }).format(dateValue(value))
}
