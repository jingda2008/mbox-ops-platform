import {describe,it,expect} from 'vitest'
import {customerSupplyCopy} from './product-supply-presentation.js'
import {DEFAULT_PRODUCT_SERVICE_WINDOW as all} from '../../src/shared/product-service-window.js'
describe('customer supply explanation uses the applicable original constraints',()=>{
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
