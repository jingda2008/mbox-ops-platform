import {describe,it,expect} from 'vitest'
import {priceBrokenBundle,pricePlainItemStop,remainingRefundCapacity} from './item-after-sales-price-policy.js'
describe('confirmed store after-sales pricing',()=>{
 it('caps selected refund by actual captured money less successful and already reserved refunds',()=>{
  expect(pricePlainItemStop({selectedOriginalMinor:3000,paidMinor:4000,succeededRefundMinor:0,reservedRefundMinor:0})).toEqual({cancelledAmountMinor:3000,refundAmountMinor:3000})
  expect(pricePlainItemStop({selectedOriginalMinor:7000,paidMinor:4000,succeededRefundMinor:1000,reservedRefundMinor:2000})).toEqual({cancelledAmountMinor:7000,refundAmountMinor:1000})
  expect(remainingRefundCapacity(4000,4000,100)).toBe(0)
 })
 it('reprices retained bundle goods using original single prices instead of refunding the returned menu price',()=>{
  expect(priceBrokenBundle({components:[{originalSinglePriceMinor:8000,retainedQuantity:1},{originalSinglePriceMinor:6000,retainedQuantity:0}],otherEffectiveChargesMinor:5000,paidMinor:15000,succeededRefundMinor:0,reservedRefundMinor:0})).toEqual({retainedBundleAmountMinor:8000,effectiveAmountMinor:13000,refundAmountMinor:2000,outstandingAmountMinor:0})
 })
 it('shows the remaining receivable without inventing a negative refund or an automatic extra charge',()=>{
  expect(priceBrokenBundle({components:[{originalSinglePriceMinor:8000,retainedQuantity:1}],otherEffectiveChargesMinor:0,paidMinor:4000,succeededRefundMinor:0,reservedRefundMinor:0})).toMatchObject({refundAmountMinor:0,outstandingAmountMinor:4000})
 })
 it('subtracts previous and in-flight refunds and keeps unrelated retained charges',()=>{
  expect(priceBrokenBundle({components:[{originalSinglePriceMinor:2000,retainedQuantity:1}],otherEffectiveChargesMinor:1000,paidMinor:10000,succeededRefundMinor:3000,reservedRefundMinor:1000})).toMatchObject({effectiveAmountMinor:3000,refundAmountMinor:3000})
 })
 it('returns only remaining captured funds when all bundle goods are stopped, even if legacy stopped rows have no price',()=>{
  expect(priceBrokenBundle({components:[{originalSinglePriceMinor:null,retainedQuantity:0}],otherEffectiveChargesMinor:0,paidMinor:10000,succeededRefundMinor:2000,reservedRefundMinor:1000})).toMatchObject({refundAmountMinor:7000})
 })
 it('refuses guessed original prices, fractional units and overflow',()=>{
  const source={components:[{originalSinglePriceMinor:null,retainedQuantity:1}],otherEffectiveChargesMinor:0,paidMinor:10000,succeededRefundMinor:0,reservedRefundMinor:0}
  expect(()=>priceBrokenBundle(source)).toThrow('下单时单点原价')
  expect(()=>priceBrokenBundle({...source,components:[{originalSinglePriceMinor:100,retainedQuantity:.5}]})).toThrow('数量')
  expect(()=>priceBrokenBundle({...source,components:[{originalSinglePriceMinor:Number.MAX_SAFE_INTEGER,retainedQuantity:2}]})).toThrow('安全范围')
  expect(()=>remainingRefundCapacity(-1,0,0)).toThrow('非负整数分')
 })
})
