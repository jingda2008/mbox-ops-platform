import {
  DEFAULT_VENUE_TIME_ZONE,
  formatVenueDateTime,
  formatVenueTime,
  shiftDateKey,
  venueBusinessDateKey,
  venueDateKey,
  venueDateTimeLocalValue,
  venueLocalDateTimeToIso,
  venueStartOfDay,
  type TimeInput,
} from './venue-time.js'

export const CHINA_TIME_ZONE = DEFAULT_VENUE_TIME_ZONE

export function chinaDateKey(value: TimeInput = Date.now()) {
  return venueDateKey(value, CHINA_TIME_ZONE)
}

export function chinaBusinessDateKey(value: TimeInput = Date.now(), rolloverHour = 6) {
  return venueBusinessDateKey(value, CHINA_TIME_ZONE, rolloverHour)
}

export function chinaDateTimeLocalValue(value: TimeInput) {
  return venueDateTimeLocalValue(value, CHINA_TIME_ZONE)
}

export function chinaLocalDateTimeToIso(value: string) {
  return venueLocalDateTimeToIso(value, CHINA_TIME_ZONE)
}

export { shiftDateKey }

export function chinaStartOfDay(value: TimeInput = Date.now()) {
  return venueStartOfDay(value, CHINA_TIME_ZONE)
}

export function formatChinaTime(value: TimeInput, options: Intl.DateTimeFormatOptions = {}) {
  return formatVenueTime(value, CHINA_TIME_ZONE, options)
}

export function formatChinaDateTime(value: TimeInput, options: Intl.DateTimeFormatOptions = {}) {
  return formatVenueDateTime(value, CHINA_TIME_ZONE, options)
}
