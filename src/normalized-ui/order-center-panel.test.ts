import {describe,it,expect} from 'vitest'
import {groupOrdersBySession,historyItemPriceLabel} from '../shared/order-history-presentation'
import type {OperatingHistory} from '../shared/operating-history'
describe('order center session grouping',()=>{
 it('labels package components without presenting zero as a standalone price',()=>{
  const item={id:'item',name:'鸡尾酒',quantity:2,unitPriceMinor:5000,totalMinor:8000,status:'ready',note:null}
  expect(historyItemPriceLabel(item)).toBe('单价 ¥50.00 · 小计 ¥80.00')
  expect(historyItemPriceLabel({...item,includedInBundle:true,unitPriceMinor:0,totalMinor:0})).toBe('套餐内商品，不另收费')
 })
 it('never groups two parties merely because they share a table code',()=>{
  const order=(id:string,tableSessionId?:string)=>({id,publicId:id,tableCode:'W01',tableSessionId,
   employeeName:null,submittedAt:'2026-09-10T12:00:00Z',status:'submitted',paymentStatus:'paid',totalMinor:0,items:[]})
  const rows:OperatingHistory['orders']=[order('a','first-party'),order('b','second-party'),order('c','first-party'),order('legacy')]
  expect(groupOrdersBySession(rows).map(group=>group.orders.map(row=>row.id))).toEqual([['a','c'],['b'],['legacy']])
  expect(rows.map(row=>row.id)).toEqual(['a','b','c','legacy'])
 })
})
