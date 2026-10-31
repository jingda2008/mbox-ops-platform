import {describe,it,expect} from 'vitest'
import {tableSettlement,type TableSettlementInput} from './table-settlement-policy.js'
const base:TableSettlementInput={minimumMinor:50000,waiverMinor:0,qualifyingGoodsMinor:50000,goodsPayableMinor:50000,receivedMinor:50000,refundedMinor:0,pendingRefundMinor:0,differenceDisposition:'not_authorized'}
describe('table settlement preview policy',()=>{
 it.each([
  [{},0,0,0],
  [{goodsPayableMinor:45000},0,5000,0],
  [{qualifyingGoodsMinor:40000,goodsPayableMinor:36000,differenceDisposition:'collect'},0,4000,10000],
  [{qualifyingGoodsMinor:40000,goodsPayableMinor:40000,differenceDisposition:'collect'},0,0,10000],
  [{qualifyingGoodsMinor:40000,goodsPayableMinor:36000,waiverMinor:10000},0,14000,0],
  [{qualifyingGoodsMinor:60000,goodsPayableMinor:54000},4000,0,0],
 ] as Array<[Partial<TableSettlementInput>,number,number,number]>)('calculates final obligations without consuming discounts: %j',(patch,collect,refund,difference)=>{
  expect(tableSettlement({...base,...patch})).toMatchObject({collectMinor:collect,refundMinor:refund,differenceMinor:difference})
 })
 it.each(['not_authorized','disputed'] as const)('does not silently charge or settle a shortfall with disposition %s',differenceDisposition=>{
  expect(tableSettlement({...base,qualifyingGoodsMinor:40000,goodsPayableMinor:36000,differenceDisposition})).toMatchObject({shortfallMinor:10000,differenceMinor:0,actionRequired:'review',collectMinor:0,refundMinor:0})
 })
 it('blocks a second refund while an original refund is in flight',()=>{
  expect(tableSettlement({...base,goodsPayableMinor:45000,pendingRefundMinor:5000})).toMatchObject({actionRequired:'review',refundMinor:0})
 })
 it('accounts for completed refunds rather than refunding the entire overpayment again',()=>{
  expect(tableSettlement({...base,goodsPayableMinor:45000,refundedMinor:3000})).toMatchObject({refundMinor:2000})
 })
 it.each([{waiverMinor:50001},{refundedMinor:50001},{pendingRefundMinor:50001},{goodsPayableMinor:-1},{minimumMinor:NaN},{receivedMinor:0.1}])('rejects impossible balances %j',patch=>{
  expect(()=>tableSettlement({...base,...patch})).toThrow()
 })
})
