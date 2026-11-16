import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { parseInstant } from '../shared/instant-time'

// Exercise the formatter actually shipped in the standalone cooperation page.
const source = readFileSync('public/cooperation/app.js', 'utf8')
const formatter = source.slice(source.indexOf('const beijing ='), source.indexOf('\nfunction renderRows'))
class StrictDate extends Date {
  static parse(value: string) {
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/)
    return Date.parse(value)
  }
  constructor(value: number | string) {
    if (typeof value === 'string' && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) super(NaN)
    else super(value)
  }
}
const beijing = vm.runInNewContext(formatter + '; beijing', { Date: StrictDate, Intl: undefined }) as (value: unknown) => string

describe('cooperation dates match employee and Mini business instants', () => {
  it.each([
    ['2026-12-31 16:00:00.123456+00', '2027-01-01 00:00'],
    ['2027-01-01T00:00:00.123+08:00', '2027-01-01 00:00'],
    ['2026-12-31T11:00:00.123-0500', '2027-01-01 00:00'],
    ['2027-01-01 00:00+08', '2027-01-01 00:00'],
    ['2026-12-31T15:59:59.999Z', '2026-12-31 23:59'],
    ['2024-02-28 16:00:00+00', '2024-02-29 00:00'],
  ])('formats database and ISO values without a permissive browser parser: %s', (input, expected) => {
    expect(beijing(input)).toBe(expected)
    expect(new Date(parseInstant(input) + 28_800_000).toISOString().slice(0, 16).replace('T', ' ')).toBe(expected)
  })
  it.each([null, undefined, '', '2026-11-16', '2026-11-16T18:00:00', '2026-02-29T00:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T00:00:00+08:60', 'infinity'])('does not invent a date for missing or invalid input: %s', input => {
    expect(beijing(input)).toBe('时间待核对')
  })
})
