import {describe,it,expect} from 'vitest'
import {itemQuantityAvailability,planItemQuantityHold,originalQuantityAmount} from './order-item-quantity-plan.js'

describe('quantity after-sales planning from original facts',()=>{
 const original={ordered:5,stoppedUnmade:0,stoppedMade:0,heldUnmade:0,heldMade:0,started:0,ready:0,delivered:0}
 it('stops one of five unpaid unmade units while the other four continue',()=>{
  expect(planItemQuantityHold(original,1,'unpaid_stop')).toEqual({requested:1,unmade:1,madeReview:0,otherUnmade:4})
 })
 it('reserves requested units against a second request without freezing untouched units',()=>{
  const held={...original,heldUnmade:2}
  expect(itemQuantityAvailability(held)).toEqual({unmade:3,made:0,selectable:3})
  expect(()=>planItemQuantityHold(held,4,'paid_return')).toThrow('最多可处理3份')
  expect(planItemQuantityHold(held,1,'paid_return').otherUnmade).toBe(2)
 })
 it('preserves made facts when production wins the lock before a stop',()=>{
  const raced={...original,started:4,ready:3,delivered:2}
  expect(planItemQuantityHold(raced,3,'paid_return')).toEqual({requested:3,unmade:1,madeReview:2,otherUnmade:0})
  expect(()=>planItemQuantityHold(raced,3,'unpaid_stop')).toThrow('已有制作记录')
 })
 it.each([0,-1,1.5,NaN,Infinity])('rejects invalid selected quantity %s',quantity=>{
  expect(()=>planItemQuantityHold(original,quantity,'paid_return')).toThrow('数量')
 })
 it('refuses inconsistent or over-occupied source facts instead of clamping them to zero',()=>{
  for(const patch of [{heldUnmade:6},{started:2,ready:3},{started:2,heldMade:3},{stoppedUnmade:4,started:2}]){
   expect(()=>itemQuantityAvailability({...original,...patch})).toThrow()
  }
 })
 it('keeps cancelled made units within original production history without offering them twice',()=>{
  expect(itemQuantityAvailability({...original,started:3,ready:2,delivered:1,stoppedMade:2,heldUnmade:1})).toEqual({unmade:1,made:1,selectable:2})
 })
 it('prices ordinary selected units from their original price, not the current menu',()=>{
  expect(originalQuantityAmount({quantity:5,unitAmountMinor:800,totalAmountMinor:4000,includedInBundle:false},[1,3])).toBe(1600)
 })
 it('requires original unit allocation for a discounted partial return and preserves remainder cents',()=>{
  const price={quantity:3,unitAmountMinor:40,totalAmountMinor:100,includedInBundle:false}
  expect(()=>originalQuantityAmount(price,[0])).toThrow('没有原单份分摊')
  expect(originalQuantityAmount(price,[0,1,2])).toBe(100)
  const allocated={...price,unitAllocationsMinor:[33,33,34]}
  expect([0,1,2].reduce((sum,index)=>sum+originalQuantityAmount(allocated,[index]),0)).toBe(100)
  expect(()=>originalQuantityAmount({...allocated,unitAllocationsMinor:[34,34,34]},[0])).toThrow('不完整')
 })
 it('never charges or refunds a bundle child at standalone price',()=>{
  expect(()=>originalQuantityAmount({quantity:1,unitAmountMinor:0,totalAmountMinor:0,includedInBundle:true},[0])).toThrow('原套餐')
 })
})
