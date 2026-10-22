import {describe,it,expect} from 'vitest'
import {DEFAULT_PRODUCT_SERVICE_WINDOW as all,parseProductServiceWindow,serviceWindowState} from './product-service-window.js'

describe('product service windows',()=>{
 const overnight={...all,dateFrom:'2026-10-23',dateThrough:'2026-10-23',weekdays:[5],saleStartMinute:1320,saleEndMinute:1560,visibleStartMinute:1260,visibleEndMinute:1560}
 it('uses the starting Friday for Saturday after midnight, including the final configured date',()=>{
  expect(serviceWindowState(overnight,new Date('2026-10-23T17:59:59Z'))).toEqual({active:true,until:'2026-10-23T18:00:00.000Z'})
  expect(serviceWindowState(overnight,new Date('2026-10-23T18:00:00Z')).active).toBe(false)
  expect(serviceWindowState(overnight,new Date('2026-10-24T14:00:00Z')).active).toBe(false)
 })
 it('includes the beginning, excludes the end, and separates preview from sale',()=>{
  expect(serviceWindowState(overnight,new Date('2026-10-23T13:30:00Z'),'Asia/Shanghai','visible').active).toBe(true)
  expect(serviceWindowState(overnight,new Date('2026-10-23T13:30:00Z')).active).toBe(false)
  expect(serviceWindowState(overnight,new Date('2026-10-23T14:00:00Z')).active).toBe(true)
 })
 it('preserves missing rules and handles all-day without treating equal clock times as empty',()=>{
  expect(serviceWindowState(null)).toEqual({active:true,until:null})
  expect(serviceWindowState(all,new Date('2026-10-22T15:59:59Z'))).toEqual({active:true,until:'2026-10-22T16:00:00.000Z'})
 })
 it('uses the store timezone rather than the device timezone',()=>{
  expect(serviceWindowState({...all,saleStartMinute:540,saleEndMinute:600},new Date('2026-10-22T13:30:00Z'),'America/New_York')).toEqual({active:true,until:'2026-10-22T14:00:00.000Z'})
 })
 it('re-evaluates the exact end boundary and changed rules with a reused timezone',()=>{
  const rule={...all,saleStartMinute:1080,saleEndMinute:1560}
  expect(serviceWindowState(rule,new Date('2026-10-22T17:59:59Z'))).toEqual({active:true,until:'2026-10-22T18:00:00.000Z'})
  expect(serviceWindowState(rule,new Date('2026-10-22T18:00:00Z'))).toEqual({active:false,until:null})
  expect(serviceWindowState({...rule,dateThrough:'2026-10-21'},new Date('2026-10-22T17:59:59Z'))).toEqual({active:false,until:null})
  expect(serviceWindowState(rule,new Date('2026-10-23T10:00:00Z'))).toEqual({active:true,until:'2026-10-23T18:00:00.000Z'})
 })
 it.each([
  ['2026-03-08T06:30:00Z','2026-03-08T08:00:00.000Z'],
  ['2026-11-01T05:30:00Z','2026-11-01T09:00:00.000Z'],
  ['2026-11-01T06:30:00Z','2026-11-01T09:00:00.000Z'],
 ])('keeps the local end through DST changes at %s without caching an offset', (now,until)=>{
  const rule={...all,saleStartMinute:60,saleEndMinute:240}
  expect(serviceWindowState(rule,new Date(now),'America/New_York')).toEqual({active:true,until})
  expect(serviceWindowState(rule,new Date(now),'Asia/Shanghai')).toEqual({active:false,until:null})
  expect(serviceWindowState(rule,new Date(until),'America/New_York')).toEqual({active:false,until:null})
 })
 it.each([
  {dateFrom:'2026-02-30'}, {dateFrom:'2027-01-01',dateThrough:'2026-01-01'}, {weekdays:[]}, {weekdays:[1,1]}, {weekdays:[0]},
  {saleStartMinute:0.5}, {saleEndMinute:0}, {saleEndMinute:1441}, {visibleStartMinute:1}, {unsupported:true},
 ])('rejects invalid configuration %j',patch=>expect(()=>parseProductServiceWindow({...all,...patch})).toThrow())
 it('defaults preview to sale and canonicalizes weekdays',()=>{
  expect(parseProductServiceWindow({dateFrom:null,dateThrough:null,weekdays:[7,1],saleStartMinute:1080,saleEndMinute:1560})).toMatchObject({weekdays:[1,7],visibleStartMinute:1080,visibleEndMinute:1560})
 })
})
