import { describe, expect, it } from 'vitest'
import {
  chinaDateKey,
  chinaDateTimeLocalValue,
  chinaLocalDateTimeToIso,
  chinaStartOfDay,
  formatChinaTime,
} from './china-time.js'

describe('China standard time', () => {
  it('uses UTC+8 across the UTC calendar boundary', () => {
    const instant = '2026-07-17T16:30:00.000Z'
    expect(chinaDateKey(instant)).toBe('2026-07-18')
    expect(chinaDateTimeLocalValue(instant)).toBe('2026-07-18T00:30')
    expect(formatChinaTime(instant)).toBe('00:30')
  })

  it('parses datetime-local fields as Beijing wall time regardless of device timezone', () => {
    expect(chinaLocalDateTimeToIso('2026-07-17T20:30')).toBe('2026-07-17T12:30:00.000Z')
    expect(chinaDateTimeLocalValue('2026-07-17T12:30:00.000Z')).toBe('2026-07-17T20:30')
  })

  it('creates the Beijing start of day as an absolute instant', () => {
    expect(chinaStartOfDay('2026-07-17T16:30:00.000Z').toISOString()).toBe('2026-07-17T16:00:00.000Z')
  })
})
