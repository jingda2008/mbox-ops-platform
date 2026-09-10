import { describe, expect, it } from 'vitest'
import { parseCouponCalendarRule, previewCouponCalendar, couponIssuanceValidity } from './coupon-calendar.js'

const rule = { timezone: 'Asia/Shanghai', dateBasis: 'business', businessDayStartMinute: 360,
  dateFrom: '2026-09-01', dateThrough: '2026-09-30', validFrom: '2026-09-01T00:00:00+08:00',
  validUntil: '2026-10-01T06:00:00+08:00', weekdays: [1, 2, 3], weekStartsOn: 1,
  windows: [{ startMinute: 1260, endMinute: 120 }], excludedDates: [] }
describe('shared coupon calendar', () => {
  it.each([
    ['elapsed','2026-09-11T01:00:00+08:00'],
    ['natural_end','2026-09-11T00:00:00+08:00'],
    ['business_end','2026-09-10T06:00:00+08:00'],
  ] as const)('freezes two-day validity using explicit %s semantics', (basis,expected) => {
    const value={...rule,weekdays:[1,2,3,4,5,6,7],windows:[{startMinute:0,endMinute:1440}],relativeValidity:{days:2,basis}}
    const result=couponIssuanceValidity(value,new Date('2026-09-09T01:00:00+08:00'))
    expect(result.validUntil).toBe(new Date(expected).toISOString())
    expect(result.validFrom).toBe('2026-09-08T17:00:00.000Z')
  })
  it('absolute expiry and narrower coupon bounds win over relative days',()=>{
    const value={...rule,weekdays:[1,2,3,4,5,6,7],windows:[{startMinute:0,endMinute:1440}],relativeValidity:{days:30,basis:'elapsed'}}
    expect(couponIssuanceValidity(value,new Date('2026-09-29T12:00:00+08:00')).validUntil).toBe(new Date(rule.validUntil).toISOString())
    expect(couponIssuanceValidity(value,new Date('2026-09-29T12:00:00+08:00'),{validUntil:'2026-09-30T00:00:00+08:00'}).validUntil).toBe('2026-09-29T16:00:00.000Z')
  })
  it('does not shift relative validity to a later first usable weekday',()=>{
    expect(()=>couponIssuanceValidity({...rule,relativeValidity:{days:1,basis:'elapsed'}},new Date('2026-09-10T12:00:00+08:00'))).toThrow('没有可用时段')
  })
  it.each([{days:0,basis:'elapsed'},{days:1,basis:'guess'},{days:1.5,basis:'natural_end'}])('rejects ambiguous relative validity %j',relativeValidity=>{
    expect(()=>parseCouponCalendarRule({...rule,relativeValidity})).toThrow()
  })
  it('keeps Wednesday early morning service on its business date without inventing weekly grants', () => {
    const result = previewCouponCalendar(rule, new Date('2026-10-01T01:00:00+08:00'))
    expect(result).toMatchObject({ available: true, usageDate: '2026-09-30', usageWeekStart: '2026-09-28', lastAvailableUntil: '2026-09-30T18:00:00.000Z' })
    expect(result).not.toHaveProperty('quantity')
  })
  it('natural-day eligibility does not carry Wednesday over into Thursday', () => {
    expect(previewCouponCalendar({ ...rule, dateBasis: 'natural', businessDayStartMinute: 0 }, new Date('2026-10-01T01:00:00+08:00')).available).toBe(false)
  })
  it('never extends an absolute deadline to fit a business-day window', () => {
    const clipped = { ...rule, validUntil: '2026-10-01T00:00:00+08:00' }
    const result = previewCouponCalendar(clipped, new Date('2026-10-01T01:00:00+08:00'))
    expect(result).toMatchObject({ available: false, nextAvailableAt: null, lastAvailableUntil: '2026-09-30T16:00:00.000Z' })
  })
  it('uses inclusive starts and exclusive ends to millisecond precision', () => {
    expect(previewCouponCalendar(rule, new Date('2026-09-09T21:00:00+08:00')).available).toBe(true)
    expect(previewCouponCalendar(rule, new Date('2026-09-10T01:59:59.999+08:00')).available).toBe(true)
    expect(previewCouponCalendar(rule, new Date('2026-09-10T02:00:00+08:00')).available).toBe(false)
  })
  it('exclusions win and overlapping windows merge without duplicate eligibility', () => {
    const result = previewCouponCalendar({ ...rule, excludedDates: ['2026-09-09'], windows: [
      { startMinute: 1260, endMinute: 120 }, { startMinute: 1320, endMinute: 60 },
    ] }, new Date('2026-09-09T21:00:00+08:00'))
    expect(result.available).toBe(false)
    expect(result.calendar.find(day => day.date === '2026-09-09')?.windows).toEqual([])
    expect(result.calendar.find(day => day.date === '2026-09-08')?.windows).toHaveLength(1)
  })
  it('reports empty calendar instead of silently treating it as unrestricted', () => {
    expect(previewCouponCalendar({ ...rule, dateFrom: '2026-09-03', dateThrough: '2026-09-03' }, new Date('2026-09-03T21:00:00+08:00')))
      .toMatchObject({ hasUsableWindow: false, nextAvailableAt: null, lastAvailableUntil: null, available: false })
  })
  it('paginates bounded calendar dates while computing the final deadline and next window globally', () => {
    const result = previewCouponCalendar(rule, new Date('2026-09-01T01:00:00+08:00'), '2026-09-01', 2)
    expect(result.calendar).toHaveLength(2)
    expect(result.nextCalendarDate).toBe('2026-09-03')
    expect(result.nextAvailableAt).toBe('2026-09-01T13:00:00.000Z')
    expect(result.lastAvailableUntil).toBe('2026-09-30T18:00:00.000Z')
  })
  it('partitions all-day windows at the configured cutoff and respects week start', () => {
    const allDay = { ...rule, weekdays: [1,2,3,4,5,6,7], windows: [{ startMinute: 0, endMinute: 1440 }], weekStartsOn: 7 }
    const result = previewCouponCalendar(allDay, new Date('2026-09-07T05:59:59+08:00'))
    expect(result).toMatchObject({ available: true, usageDate: '2026-09-06', usageWeekStart: '2026-09-06' })
    expect(result.calendar.find(day => day.date === '2026-09-06')?.windows).toEqual([{ from: '2026-09-05T22:00:00.000Z', until: '2026-09-06T22:00:00.000Z' }])
  })
  it.each([
    { dateFrom: '2026-02-30' }, { timezone: 'UTC' }, { weekdays: [] }, { weekdays: [1,1] },
    { windows: [{ startMinute: 120, endMinute: 120 }] }, { weekStartsOn: 0 },
    { validUntil: '2026-09-03T00:00:00' }, { dateThrough: '2026-08-01' },
    { dateBasis: 'natural', businessDayStartMinute: 360 }, { excludedDates: ['2027-01-01'] },
  ])('rejects ambiguous or impossible configuration: %j', invalid => {
    expect(() => parseCouponCalendarRule({ ...rule, ...invalid })).toThrow()
  })
  it('does not mutate the caller rule or rely on a customer-provided time', () => {
    const before = structuredClone(rule)
    previewCouponCalendar(rule, new Date('2026-09-09T13:00:00Z'))
    expect(rule).toEqual(before)
  })
})
