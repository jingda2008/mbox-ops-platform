import { describe, expect, it } from 'vitest'
import { notificationLocalTime } from './notification-local-time.js'

describe('venue notification time', () => {
  it.each([
    ['2026-08-27T12:00:00Z', '2026-08-27 20:00'],
    ['2026-08-27T16:00:00Z', '2026-08-28 00:00'],
    ['2026-12-31T16:01:00Z', '2027-01-01 00:01'],
    ['2026-08-28T00:00:00+08:00', '2026-08-28 00:00'],
  ])('formats %s in explicit Shanghai time', (input, expected) => {
    expect(notificationLocalTime(input)).toBe(expected)
  })
  it('does not turn invalid timestamps into a customer-facing date', () => {
    expect(() => notificationLocalTime('not-a-date')).toThrow('Notification time is invalid')
  })
})
