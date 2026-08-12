import type {
  ArrivalSlot,
  OperatingHours,
  PublicReservation,
  ReservationArea,
  ReservationDraft,
  ReservationTable,
  ReservationTableStatus,
  ReservationZone,
  SeatPreference,
} from './types'

export const DEFAULT_OPERATING_HOURS: Readonly<OperatingHours> = Object.freeze({
  openingMinute: 12 * 60,
  lastArrivalMinute: 25 * 60 + 30,
  slotMinutes: 30,
})

const SHANGHAI_OFFSET = '+08:00'

export function shanghaiBusinessDate(now = new Date()): string {
  return new Date(now.getTime() + 8 * 60 * 60_000).toISOString().slice(0, 10)
}

export function addCalendarDays(date: string, days: number): string {
  const parsed = parseDate(date)
  const value = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + days))
  return value.toISOString().slice(0, 10)
}

export function createArrivalSlots(
  businessDate: string,
  now = new Date(),
  hours: Readonly<OperatingHours> = DEFAULT_OPERATING_HOURS,
): ArrivalSlot[] {
  validateHours(hours)
  const slots: ArrivalSlot[] = []
  for (let minute = hours.openingMinute; minute <= hours.lastArrivalMinute; minute += hours.slotMinutes) {
    const nextDay = minute >= 24 * 60
    const calendarDate = nextDay ? addCalendarDays(businessDate, 1) : businessDate
    const minuteInDay = minute % (24 * 60)
    const hour = Math.floor(minuteInDay / 60)
    const minutePart = minuteInDay % 60
    const time = `${pad(hour)}:${pad(minutePart)}`
    const iso = `${calendarDate}T${time}:00${SHANGHAI_OFFSET}`
    if (Date.parse(iso) <= now.getTime() + 15 * 60_000) continue
    slots.push({ value: `${businessDate}|${minute}`, label: `${time}${nextDay ? ' 次日' : ''}`, iso, nextDay })
  }
  return slots
}

export function arrivalIso(
  businessDate: string,
  slotValue: string,
  hours: Readonly<OperatingHours> = DEFAULT_OPERATING_HOURS,
): string {
  const [slotDate, minuteText] = slotValue.split('|')
  if (slotDate !== businessDate || !/^\d+$/.test(minuteText ?? '')) {
    throw new TypeError('到店时间无效')
  }
  const minute = Number(minuteText)
  if (minute < hours.openingMinute || minute > hours.lastArrivalMinute || minute % hours.slotMinutes !== 0) {
    throw new TypeError('到店时间不在营业时段内')
  }
  const nextDay = minute >= 24 * 60
  const calendarDate = nextDay ? addCalendarDays(businessDate, 1) : businessDate
  const minuteInDay = minute % (24 * 60)
  return `${calendarDate}T${pad(Math.floor(minuteInDay / 60))}:${pad(minuteInDay % 60)}:00${SHANGHAI_OFFSET}`
}

export function classifyZone(area: Pick<ReservationArea, 'code' | 'name' | 'type'>): ReservationZone {
  const text = `${area.code} ${area.name}`.toLowerCase()
  if (area.type === 'outdoor' || /室外|露台|outdoor/.test(text)) return 'outdoor'
  if (area.type === 'stage' || area.type === 'vip' || /舞台|vip|卡座|stage/.test(text)) return 'stage-front'
  return 'indoor-middle'
}

export function zoneLabel(zone: ReservationZone): string {
  if (zone === 'stage-front') return '舞台前'
  if (zone === 'outdoor') return '室外'
  return '室内中区'
}

export function tableStatusLabel(status: ReservationTableStatus): string {
  if (status === 'reserved') return '已预订'
  if (status === 'locked') return '临时锁定'
  return '可预约'
}

export function seatPreferenceLabel(preference: SeatPreference): string {
  return ({
    no_preference: '门店帮我安排',
    stage_atmosphere: '靠近舞台',
    quiet_chat: '方便聊天',
    comfortable_booth: '卡座舒适',
    outdoor_view: '室外露台',
  } satisfies Record<SeatPreference, string>)[preference]
}

export function formatMoney(minor: number | null, currency = 'CNY'): string {
  if (minor === null) return '无最低消费'
  const amount = minor / 100
  if (currency === 'CNY') return `最低消费 ¥${amount.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`
  return `最低消费 ${currency} ${amount.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`
}

export function findTable(areas: readonly ReservationArea[], code: string | null): ReservationTable | null {
  if (code === null) return null
  for (const area of areas) {
    const table = area.tables.find((candidate) => candidate.code === code)
    if (table !== undefined) return table
  }
  return null
}

export function tablesForZone(areas: readonly ReservationArea[], zone: ReservationZone): ReservationArea[] {
  return areas.filter((area) => area.zone === zone && area.tables.length > 0)
}

export function validateSchedule(draft: Readonly<ReservationDraft>, availableSlots: readonly ArrivalSlot[]): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date)) return '请选择预约日期'
  if (!availableSlots.some((slot) => slot.value === draft.time)) return '请选择有效到店时间'
  if (!Number.isInteger(draft.guestCount) || draft.guestCount < 1 || draft.guestCount > 200) return '请输入正确人数'
  return null
}

export function validateConfirmation(draft: Readonly<ReservationDraft>): string | null {
  return validateGuestDetails(draft)
}

export function validateGuestDetails(draft: Pick<ReservationDraft, 'customerName' | 'contact'>): string | null {
  if (draft.customerName.trim().length === 0) return '请填写预约姓名'
  if (draft.contact.trim().length < 3) return '请填写手机或微信联系方式'
  return null
}

export type ReservationArrivalHoldState =
  | { kind: 'hidden'; seconds: 0 }
  | { kind: 'active'; seconds: number }
  | { kind: 'expired'; seconds: 0 }

export function reservationArrivalHoldState(
  reservation: Pick<PublicReservation, 'status' | 'arrivalState' | 'arrivalAt' | 'arrivalGraceEndsAt'>,
  now = new Date(),
): ReservationArrivalHoldState {
  if (reservation.status !== 'confirmed' || reservation.arrivalState !== 'not_arrived') {
    return { kind: 'hidden', seconds: 0 }
  }
  const nowMs = now.getTime()
  const arrivalMs = Date.parse(reservation.arrivalAt)
  const graceEndMs = Date.parse(reservation.arrivalGraceEndsAt)
  if (!Number.isFinite(arrivalMs) || !Number.isFinite(graceEndMs) || graceEndMs <= arrivalMs || nowMs < arrivalMs) {
    return { kind: 'hidden', seconds: 0 }
  }
  if (nowMs >= graceEndMs) return { kind: 'expired', seconds: 0 }
  return { kind: 'active', seconds: Math.ceil((graceEndMs - nowMs) / 1000) }
}

function parseDate(value: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) throw new TypeError('日期格式无效')
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() + 1 !== month || probe.getUTCDate() !== day) {
    throw new TypeError('日期无效')
  }
  return { year, month, day }
}

function validateHours(hours: Readonly<OperatingHours>): void {
  if (!Number.isInteger(hours.openingMinute) || !Number.isInteger(hours.lastArrivalMinute)
    || !Number.isInteger(hours.slotMinutes) || hours.slotMinutes <= 0
    || hours.openingMinute < 0 || hours.lastArrivalMinute < hours.openingMinute
    || hours.lastArrivalMinute >= 48 * 60) {
    throw new TypeError('营业时间配置无效')
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}
