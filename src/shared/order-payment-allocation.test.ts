import {describe,it,expect} from 'vitest'
import {allocateOrderPayment} from './order-payment-allocation'
describe('same-session collection allocation',()=>{
 const orders=[{id:'c',submittedAt:'2026-09-11T12:03:00Z',outstandingMinor:300},{id:'b',submittedAt:'2026-09-11T12:00:00Z',outstandingMinor:200},{id:'a',submittedAt:'2026-09-11T12:00:00Z',outstandingMinor:100}]
 it('uses submitted time then stable id for a partial payment and skips settled orders',()=>{
  expect(allocateOrderPayment([...orders,{id:'z',submittedAt:'2026-09-11T11:00:00Z',outstandingMinor:0}],250)).toEqual([{orderId:'a',amountMinor:100},{orderId:'b',amountMinor:150}])
  expect(orders[0]?.id).toBe('c')
 })
 it('allocates the exact total without manufacturing sales',()=>{expect(allocateOrderPayment(orders,600)).toEqual([{orderId:'a',amountMinor:100},{orderId:'b',amountMinor:200},{orderId:'c',amountMinor:300}])})
 it('rejects overcollection, duplicates and unsafe amounts before creating an attempt',()=>{
  expect(()=>allocateOrderPayment(orders,601)).toThrow('超过')
  expect(()=>allocateOrderPayment([orders[0]!,orders[0]!],100)).toThrow('重复')
  for(const amount of [0,-1,1.2,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])expect(()=>allocateOrderPayment(orders,amount)).toThrow()
 })
})
