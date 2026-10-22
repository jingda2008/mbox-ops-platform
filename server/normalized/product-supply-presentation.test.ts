import {describe,it,expect} from 'vitest'
import {customerSupplyCopy} from './product-supply-presentation.js'
import {DEFAULT_PRODUCT_SERVICE_WINDOW as all} from '../../src/shared/product-service-window.js'
describe('customer supply explanation uses the applicable original constraints',()=>{
 const boundaryTimes=['2026-10-22T17:59:00Z','2026-10-22T18:00:00Z','2026-10-23T10:00:00Z']
 it.each(boundaryTimes)('prioritizes a future supply date over legacy daily hours at %s (01:59 / 02:00 / 18:00 local)',at=>{
  const copy=customerSupplyCopy({from:'18:00',until:'02:00',timezone:'Asia/Shanghai',at,window:{...all,dateFrom:'2100-01-01',dateThrough:'2100-01-01',weekdays:[5],saleStartMinute:1320,saleEndMinute:1560,visibleStartMinute:1320,visibleEndMinute:1560}})
  expect(copy.unavailableText).toMatch(/^供应日期尚未开始。/)
  expect(copy.unavailableText).toContain('2100-01-01至2100-01-01')
  expect(copy.unavailableText).toContain('请核对供应时间或选择其他商品')
 })
 it.each(boundaryTimes)('prioritizes an expired supply date over legacy daily hours at %s (01:59 / 02:00 / 18:00 local)',at=>{
  const copy=customerSupplyCopy({from:'18:00',until:'02:00',timezone:'Asia/Shanghai',at,window:{...all,dateFrom:'2026-10-20',dateThrough:'2026-10-20',weekdays:[2],saleStartMinute:1320,saleEndMinute:1560,visibleStartMinute:1320,visibleEndMinute:1560}})
  expect(copy.unavailableText).toMatch(/^供应日期已结束。/)
 })
 it('explains an unavailable weekday before a coincident legacy time failure',()=>{
  const copy=customerSupplyCopy({from:'18:00',until:'02:00',timezone:'Asia/Shanghai',at:'2026-10-22T18:00:00Z',window:{...all,weekdays:[1],saleStartMinute:1320,saleEndMinute:1560,visibleStartMinute:1320,visibleEndMinute:1560}})
  expect(copy.unavailableText).toMatch(/^当前不在供应星期。/)
 })
 it('still explains the legacy time restriction when the dated base rule is active',()=>{
  const copy=customerSupplyCopy({from:'18:00',until:'02:00',timezone:'Asia/Shanghai',at:'2026-10-22T18:00:00Z',window:{...all,dateFrom:'2026-10-20',dateThrough:'2026-10-30'}})
  expect(copy.unavailableText).toMatch(/^本时段已结束。/)
 })
 it('explains new dated weekday windows as well as the legacy supply limit',()=>{
  const copy=customerSupplyCopy({from:'18:00',until:'02:00',timezone:'Asia/Shanghai',at:'2026-10-23T11:00:00Z',window:{...all,dateFrom:'2026-10-25',dateThrough:'2026-10-30',weekdays:[1,3,5],saleStartMinute:1200,saleEndMinute:1500,visibleStartMinute:1200,visibleEndMinute:1500}})
  expect(copy.description).toContain('18:00–次日02:00');expect(copy.description).toContain('2026-10-25至2026-10-30 周一、周三、周五 20:00–次日01:00')
  expect(copy.unavailableText).toContain('供应日期尚未开始')
 })
 it('keeps overnight end anchored to the previous start day',()=>{
  const rule={...all,dateFrom:'2026-10-22',dateThrough:'2026-10-22',weekdays:[4],saleStartMinute:1320,saleEndMinute:1560,visibleStartMinute:1320,visibleEndMinute:1560}
  const copy=customerSupplyCopy({timezone:'Asia/Shanghai',at:'2026-10-22T18:00:00Z',window:rule})
  expect(copy.unavailableText).toContain('本时段已结束');expect(copy.description).toContain('周四 22:00–次日02:00')
 })
 it('describes held card alternatives without inventing names, prices or opening dates',()=>{
  const copy=customerSupplyCopy({at:'2026-10-23T02:00:00Z',cards:[{window:{...all,weekdays:[5],saleStartMinute:1080,saleEndMinute:1200},validUntil:null}]})
  expect(copy.unavailableText).toContain('当前不在本人持卡可购时段');expect(copy.description).toContain('本人持卡时段之一：周五 18:00–20:00')
 })
 it('does not invent supply hours for an unchanged product',()=>expect(customerSupplyCopy(undefined).description).toBe(''))
})
