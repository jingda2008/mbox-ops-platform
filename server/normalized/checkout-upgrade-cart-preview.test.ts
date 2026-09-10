import {describe,it,expect} from 'vitest'
import {previewCartPortionReplacement} from './checkout-upgrade-cart-preview.js'
import type {GuestSharedCart} from './guest-shared-cart-repository.js'
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222'
function fixture(){return{status:'open',guestWritesFrozen:false,generation:2,version:7,lines:[{productId:a,quantity:2,portionIds:['first','second'],bundleSelections:[{groups:[{groupId:'g',productIds:['A']}]},{groups:[{groupId:'g',productIds:['B']}]}],available:true}]} as unknown as GuestSharedCart}
describe('non-mutating specific-portion upgrade comparison',()=>{
 it('does not preview an impossible twenty-first target portion',()=>{
  const cart=fixture();cart.lines=[...cart.lines,{...cart.lines[0]!,productId:b,quantity:20,portionIds:Array.from({length:20},(_,i)=>`existing-${i}`)}]
  const original=structuredClone(cart)
  expect(()=>previewCartPortionReplacement(cart,{portionId:'first',targetProductId:b})).toThrow('份数上限')
  expect(cart).toEqual(original)
 })
 it('keeps the second choice and its identity when comparing a replacement of the first',()=>{
  const cart=fixture(),original=structuredClone(cart)
  const proposed=previewCartPortionReplacement(cart,{portionId:'first',targetProductId:b,bundleSelection:{groups:[{groupId:'target',productIds:['A','snack']}]}})
  expect(cart).toEqual(original);expect(proposed.previewOnly).toBe(true)
  expect(proposed.lines.find(line=>line.productId===a)).toMatchObject({quantity:1,portionIds:['second'],bundleSelections:[original.lines[0]!.bundleSelections[1]]})
  expect(proposed.lines.find(line=>line.productId===b)).toMatchObject({quantity:1,portionIds:['first'],unitPriceMinor:null})
  expect(proposed.version).toBe(7)
 })
 it.each(['missing','same','frozen','closed'])('rejects %s without modifying the original',mode=>{
  const cart=fixture();if(mode==='frozen')cart.guestWritesFrozen=true;if(mode==='closed')cart.status='submitted'
  const original=structuredClone(cart)
  expect(()=>previewCartPortionReplacement(cart,{portionId:mode==='missing'?'missing':'first',targetProductId:mode==='same'?a:b})).toThrow()
  expect(cart).toEqual(original)
 })
})
