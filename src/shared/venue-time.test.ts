import { describe, expect, it } from 'vitest'
import {
  assertIanaTimeZone,
  venueBusinessDateKey,
  venueDateKey,
  venueDateTimeLocalValue,
  venueDateTimeOffsetValue,
  venueLocalDateTimeToIso,
  venueStartOfDay,
} from './venue-time.js'

describe('venue time', () => {
  it('derives the Shanghai business date from an absolute instant at the 06:00 boundary', () => {
    expect(venueBusinessDateKey('2026-08-08T21:59:59.999Z', 'Asia/Shanghai', 6)).toBe('2026-08-08')
    expect(venueBusinessDateKey('2026-08-08T22:00:00.000Z', 'Asia/Shanghai', 6)).toBe('2026-08-09')
  })

  it('does not depend on the host process timezone', () => {
    const instant = '2026-08-08T22:30:00.000Z'
    expect(venueDateKey(instant, 'Asia/Shanghai')).toBe('2026-08-09')
    expect(venueDateKey(instant, 'America/New_York')).toBe('2026-08-08')
    expect(venueBusinessDateKey(instant, 'America/New_York', 6)).toBe('2026-08-08')
  })

  it('round trips datetime-local values through an IANA timezone', () => {
    const iso = venueLocalDateTimeToIso('2026-08-09T20:30', 'Asia/Shanghai')
    expect(iso).toBe('2026-08-09T12:30:00.000Z')
    expect(venueLocalDateTimeToIso('2026-08-09T23:59:59', 'Asia/Shanghai')).toBe('2026-08-09T15:59:59.000Z')
    expect(venueDateTimeLocalValue(iso, 'Asia/Shanghai')).toBe('2026-08-09T20:30')
    expect(venueStartOfDay(iso, 'Asia/Shanghai').toISOString()).toBe('2026-08-08T16:00:00.000Z')
  })

  it('uses IANA transition rules instead of a fixed offset', () => {
    expect(venueLocalDateTimeToIso('2026-01-15T12:00', 'America/New_York')).toBe('2026-01-15T17:00:00.000Z')
    expect(venueLocalDateTimeToIso('2026-07-15T12:00', 'America/New_York')).toBe('2026-07-15T16:00:00.000Z')
    expect(venueDateTimeOffsetValue('2026-01-15T17:00:00.000Z', 'America/New_York')).toBe('2026-01-15T12:00:00-05:00')
    expect(venueDateTimeOffsetValue('2026-07-15T16:00:00.000Z', 'America/New_York')).toBe('2026-07-15T12:00:00-04:00')
  })

  it('rejects invalid zones, invalid rollover hours and nonexistent local times', () => {
    expect(() => assertIanaTimeZone('Mars/Olympus')).toThrow('门店时区无效')
    expect(() => venueBusinessDateKey(Date.now(), 'Asia/Shanghai', 24)).toThrow('营业日切换小时无效')
    expect(() => venueLocalDateTimeToIso('2026-03-08T02:30', 'America/New_York')).toThrow('不存在或无法唯一转换')
  })
})
