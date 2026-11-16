import {describe,expect,it} from 'vitest'
import {beijingDisplayTime} from './beijing-display-time'
describe('channel employee records use explicit Beijing time',()=>{
 it.each([
  ['2026-12-31 15:59:59.999999+00','2026-12-31 23:59'],
  ['2026-12-31 16:00:00.123456+00','2027-01-01 00:00'],
  ['2027-01-01T00:00:00+08:00','2027-01-01 00:00'],
  ['2024-02-28 16:00:00+00','2024-02-29 00:00'],
  ['2026-11-16T11:00:00-0500','2026-11-17 00:00'],
 ])('formats %s consistently', (value,expected)=>expect(beijingDisplayTime(value)).toBe(expected))
 it.each([null,undefined,'','2026-02-29T16:00:00Z','2026-11-16 13:00:00','2026-11-16T24:00:00Z'])('does not invent a timestamp for %s',value=>expect(beijingDisplayTime(value)).toBe('时间待核对'))
})
