import {describe,expect,it} from 'vitest'
import {DEFAULT_FULFILLMENT_SLA_SECONDS,fulfillmentDueAt} from './fulfillment-sla.js'
describe('shared order and qualification deadlines',()=>{
 it.each(['bar','kitchen','cashier'] as const)('uses the same %s fallback for actual orders and previews',station=>{
  expect(fulfillmentDueAt(station,null,0)).toBe(new Date(DEFAULT_FULFILLMENT_SLA_SECONDS[station]*1000).toISOString())
 })
 it('preserves explicit immediate/configured deadlines and no-production products',()=>{
  expect(fulfillmentDueAt('bar',0,1000)).toBe(new Date(1000).toISOString())
  expect(fulfillmentDueAt('kitchen',70,1000)).toBe(new Date(71000).toISOString())
  expect(fulfillmentDueAt('none',300,1000)).toBeNull()
 })
})
