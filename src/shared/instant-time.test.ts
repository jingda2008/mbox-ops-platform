import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { dateInput, parseInstant } from './instant-time.js'
import { chinaBusinessDateKey, chinaDateKey, chinaDateTimeLocalValue } from './china-time.js'
import { menuCheckoutPricing } from '../components/menu-channel-pricing.js'
const module = { exports: {} as { dateInput:(value:unknown)=>string; parseInstant:(value:unknown)=>number } }
vm.runInNewContext(readFileSync('miniprogram/utils/format.js','utf8'),{module,Date})
const values:unknown[]=['2026-12-31 16:00:00.123456+00','2027-01-01T00:00:00.123+08:00','2026-12-31T11:00:00.123-0500','2027-01-01 00:00+08','2024-02-29T00:00:00Z','2026-02-29T00:00:00Z','2026-11-15T00:00:00','2026-11-15',null,undefined,'',false,0,NaN,Infinity,'infinity','2026-01-01T00:00:00+08:60']
describe('web and Mini instant parser contract',()=>{
 it.each(values)('matches both runtimes for %s',value=>{
  expect(dateInput(value)).toBe(module.exports.dateInput(value))
  expect(parseInstant(value)).toBe(module.exports.parseInstant(value))
 })
 it('formats PG UTC timestamps as Beijing date without phone timezone',()=>{
  expect(chinaDateTimeLocalValue('2026-12-31 16:00:00.123456+00')).toBe('2027-01-01T00:00')
  expect(chinaDateKey('2026-12-31 15:59:59.999999+00')).toBe('2026-12-31')
  expect(chinaDateKey('2024-02-28 16:00:00+00')).toBe('2024-02-29')
  expect(()=>chinaDateKey('2026-02-29')).toThrow('时间格式无效')
  expect(()=>chinaDateKey('2026-12-31T16:00:00')).toThrow('时间格式无效')
 })
 it('business day changes at 06:00 Beijing, not at midnight',()=>{
  expect(chinaBusinessDateKey('2026-12-31T16:00:00Z')).toBe('2026-12-31')
  expect(chinaBusinessDateKey('2026-12-31 21:59:59.999999+00')).toBe('2026-12-31')
  expect(chinaBusinessDateKey('2026-12-31 22:00:00+00')).toBe('2027-01-01')
 })
 it.each([-1,0,1])('cart quote exact expiry offset %s ms',delta=>{
  const result=menuCheckoutPricing({originalMinor:10000,quote:{id:'q',payableMinor:9000,discountMinor:1000,fingerprint:'W1',expiresAt:'2027-01-01 00:00:00.123456+08'},fingerprint:'W1',now:Date.parse('2026-12-31T16:00:00.123Z')+delta})
  expect(result.needsReview).toBe(delta>=0)
  expect(result.amountMinor).toBe(delta<0?9000:null)
 })
})
