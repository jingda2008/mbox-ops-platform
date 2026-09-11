const DAY = 86_400_000
const MINUTE = 60_000
const SHANGHAI_OFFSET = 480 * MINUTE
export class CouponCalendarError extends Error {}
export interface CouponCalendarRule {
  timezone: 'Asia/Shanghai'
  dateBasis: 'natural' | 'business'
  businessDayStartMinute: number
  dateFrom: string
  dateThrough: string
  validFrom: string
  validUntil: string
  weekdays: number[] // ISO: Monday=1, Sunday=7
  weekStartsOn: number
  windows: Array<{ startMinute: number; endMinute: number }>
  excludedDates: string[]
  relativeValidity?: { days: number; basis: 'elapsed' | 'natural_end' | 'business_end' }
}
interface Window { from: string; until: string }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CouponCalendarError('时间规则格式无效')
  return value as Record<string, unknown>
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new CouponCalendarError('时间或星期取值超出范围')
  return value
}
function dateMs(value: unknown): number {
  if (typeof value !== 'string' || !/^[2-9]\d{3}-\d{2}-\d{2}$/.test(value)) throw new CouponCalendarError('日期须包含完整年份、月份和日期')
  const result = Date.parse(`${value}T00:00:00Z`)
  if (!Number.isFinite(result) || new Date(result).toISOString().slice(0, 10) !== value) throw new CouponCalendarError('日期不存在')
  return result
}
function instant(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(value)) throw new CouponCalendarError('绝对有效期必须包含时区和秒')
  dateMs(value.slice(0, 10))
  const result = Date.parse(value)
  if (!Number.isFinite(result)) throw new CouponCalendarError('绝对有效期无效')
  return result
}
export function parseCouponCalendarRule(value: unknown): CouponCalendarRule {
  const input = object(value)
  if (input.timezone !== 'Asia/Shanghai') throw new CouponCalendarError('当前仅支持已实现的上海门店时区')
  if (input.dateBasis !== 'natural' && input.dateBasis !== 'business') throw new CouponCalendarError('须明确按自然日还是营业日使用')
  const cutoff = integer(input.businessDayStartMinute, 0, 1439)
  if (input.dateBasis === 'natural' && cutoff !== 0) throw new CouponCalendarError('自然日必须从零点开始')
  const first = dateMs(input.dateFrom), last = dateMs(input.dateThrough)
  if (last < first || last - first > 3660 * DAY) throw new CouponCalendarError('日期范围必须正序且不超过3661天')
  if (instant(input.validUntil) <= instant(input.validFrom)) throw new CouponCalendarError('绝对截止时间必须晚于开始时间')
  if (!Array.isArray(input.weekdays) || input.weekdays.length < 1 || input.weekdays.length > 7) throw new CouponCalendarError('至少选择一个可用星期')
  const weekdays = input.weekdays.map(day => integer(day, 1, 7))
  if (new Set(weekdays).size !== weekdays.length) throw new CouponCalendarError('可用星期不能重复')
  if (!Array.isArray(input.windows) || !input.windows.length || input.windows.length > 12) throw new CouponCalendarError('须配置1至12个每日时间段')
  const windows = input.windows.map(value => {
    const window = object(value)
    const startMinute = integer(window.startMinute, 0, 1439), endMinute = integer(window.endMinute, 0, 1440)
    if (startMinute === endMinute || (startMinute === 0 && endMinute === 0)) throw new CouponCalendarError('时段起止不能相同；全天请配置00:00至24:00')
    return { startMinute, endMinute }
  })
  if (!Array.isArray(input.excludedDates) || input.excludedDates.length > 3661) throw new CouponCalendarError('排除日期列表无效')
  const excludedDates = input.excludedDates.map(value => {
    const date = dateMs(value)
    if (date < first || date > last) throw new CouponCalendarError('排除日期必须位于活动日期范围内')
    return value as string
  })
  let relativeValidity: CouponCalendarRule['relativeValidity']
  if (input.relativeValidity !== undefined && input.relativeValidity !== null) {
    const relative = object(input.relativeValidity)
    if (!['elapsed','natural_end','business_end'].includes(relative.basis as string)) throw new CouponCalendarError('须明确发放后有效天数的结束口径')
    if (relative.basis === 'business_end' && input.dateBasis !== 'business') throw new CouponCalendarError('营业日结束口径须同时配置营业日换日时刻')
    relativeValidity = { days: integer(relative.days, 1, 3660), basis: relative.basis as NonNullable<CouponCalendarRule['relativeValidity']>['basis'] }
  }
  return { timezone: 'Asia/Shanghai', dateBasis: input.dateBasis, businessDayStartMinute: cutoff,
    dateFrom: input.dateFrom as string, dateThrough: input.dateThrough as string,
    validFrom: new Date(instant(input.validFrom)).toISOString(), validUntil: new Date(instant(input.validUntil)).toISOString(),
    weekdays: weekdays.sort((a, b) => a - b), weekStartsOn: integer(input.weekStartsOn, 1, 7),
    windows, excludedDates: [...new Set(excludedDates)].sort(), ...(relativeValidity ? { relativeValidity } : {}) }
}

/** Freeze each issued coupon's interval. Calendar-end modes count the day of
 * issuance as day one; absolute campaign and explicit coupon bounds only
 * shorten it. Caller time must be authoritative except in labelled previews. */
export function couponIssuanceValidity(value: unknown, issuedAt: Date, bounds: {validFrom?: string; validUntil?: string | null} = {}) {
  const rule = parseCouponCalendarRule(value), issued = issuedAt.getTime()
  if (!Number.isFinite(issued)) throw new CouponCalendarError('发放时间无效')
  const from = Math.max(issued, instant(rule.validFrom), bounds.validFrom ? instant(bounds.validFrom) : issued)
  let until = Math.min(instant(rule.validUntil), bounds.validUntil ? instant(bounds.validUntil) : Infinity)
  if (rule.relativeValidity) {
    const {days,basis} = rule.relativeValidity
    const cutoff = basis === 'business_end' ? rule.businessDayStartMinute * MINUTE : 0
    const relativeUntil = basis === 'elapsed' ? issued + days * DAY
      : Math.floor((issued + SHANGHAI_OFFSET - cutoff) / DAY) * DAY - SHANGHAI_OFFSET + cutoff + days * DAY
    until = Math.min(until, relativeUntil)
  }
  if (until <= from) throw new CouponCalendarError('发放后的实际有效期为空，不能发出不可用的券')
  const effectiveRule = { ...rule, validFrom: new Date(from).toISOString(), validUntil: new Date(until).toISOString() }
  if (!previewCouponCalendar(effectiveRule, issuedAt, undefined, 1).hasUsableWindow) throw new CouponCalendarError('发放后有效期内没有可用时段，不能发出不可用的券')
  return {validFrom:effectiveRule.validFrom,validUntil:effectiveRule.validUntil}
}
function isoDay(ms: number): string { return new Date(ms).toISOString().slice(0, 10) }
function isoWeekday(ms: number): number { return new Date(ms).getUTCDay() || 7 }

// Eligibility dates partition the real timeline. Natural-day midnight cuts a
// cross-midnight window; business-day cutoff keeps the early hours on the prior
// business date. Absolute validity always wins over either date interpretation.
function dailyWindows(rule: CouponCalendarRule, day: number): Window[] {
  if (!rule.weekdays.includes(isoWeekday(day)) || rule.excludedDates.includes(isoDay(day))) return []
  const midnight = day - SHANGHAI_OFFSET
  const start = Math.max(midnight + rule.businessDayStartMinute * MINUTE, Date.parse(rule.validFrom))
  const end = Math.min(midnight + rule.businessDayStartMinute * MINUTE + DAY, Date.parse(rule.validUntil))
  const candidates: Array<[number, number]> = []
  for (const window of rule.windows) {
    for (const shift of [-DAY, 0, DAY]) {
      const from = Math.max(start, midnight + shift + window.startMinute * MINUTE)
      const until = Math.min(end, midnight + shift + (window.endMinute + (window.endMinute < window.startMinute ? 1440 : 0)) * MINUTE)
      if (from < until) candidates.push([from, until])
    }
  }
  candidates.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const interval of candidates) {
    const previous = merged.at(-1)
    if (previous && interval[0] <= previous[1]) previous[1] = Math.max(previous[1], interval[1])
    else merged.push([...interval])
  }
  return merged.map(([from, until]) => ({ from: new Date(from).toISOString(), until: new Date(until).toISOString() }))
}
export function previewCouponCalendar(value: unknown, at: Date, previewFrom?: string, days = 31) {
  const rule = parseCouponCalendarRule(value)
  if (!Number.isFinite(at.getTime())) throw new CouponCalendarError('服务端时间无效')
  integer(days, 1, 62)
  const first = dateMs(rule.dateFrom), last = dateMs(rule.dateThrough)
  const calendarStart = previewFrom === undefined ? first : dateMs(previewFrom)
  if (calendarStart < first || calendarStart > last) throw new CouponCalendarError('日历起点必须在活动日期内')
  const calendar: Array<{ date: string; windows: Window[]; reasons?:string[] }> = []
  let nextAvailableAt: string | null = null, lastAvailableUntil: string | null = null, available = false
  for (let day = first; day <= last; day += DAY) {
    const windows = dailyWindows(rule, day)
    if (day >= calendarStart && day < calendarStart + days * DAY) calendar.push({ date: isoDay(day), windows,...(windows.length?{}:{reasons:[
      ...(!rule.weekdays.includes(isoWeekday(day))?['该星期未在可用星期范围内']:[]),
      ...(rule.excludedDates.includes(isoDay(day))?['该日期已被明确排除']:[]),
      ...((day-SHANGHAI_OFFSET+rule.businessDayStartMinute*MINUTE+DAY<=Date.parse(rule.validFrom))?['该日期早于实际有效期开始']:[]),
      ...((day-SHANGHAI_OFFSET+rule.businessDayStartMinute*MINUTE>=Date.parse(rule.validUntil))?['该日期已超过实际有效期结束（含发放后有效期限制）']:[]),
      ...(rule.weekdays.includes(isoWeekday(day))&&!rule.excludedDates.includes(isoDay(day))?['配置的时段与实际有效期没有交集，请核对绝对时间及发放后期限']:[]),
    ]}) })
    for (const window of windows) {
      lastAvailableUntil = window.until
      if (Date.parse(window.from) <= at.getTime() && at.getTime() < Date.parse(window.until)) available = true
      if (nextAvailableAt === null && Date.parse(window.until) > at.getTime()) nextAvailableAt = new Date(Math.max(at.getTime(), Date.parse(window.from))).toISOString()
    }
  }
  const usageDayMs = Math.floor((at.getTime() + SHANGHAI_OFFSET - rule.businessDayStartMinute * MINUTE) / DAY) * DAY
  const usageWeekMs = usageDayMs - ((isoWeekday(usageDayMs) - rule.weekStartsOn + 7) % 7) * DAY
  return { rule, available, nextAvailableAt, lastAvailableUntil, hasUsableWindow: lastAvailableUntil !== null,
    calendar, nextCalendarDate: calendarStart + days * DAY <= last ? isoDay(calendarStart + days * DAY) : null,
    // Period identities only, never an increment, grant or reservation. Counters
    // must be checked/changed atomically by the authoritative redemption command.
    usageDate: isoDay(usageDayMs), usageWeekStart: isoDay(usageWeekMs),
    boundary: 'start_inclusive_end_exclusive' as const }
}
