import {describe,it,expect} from 'vitest'
import {pricingLineFingerprint,verifyPricingLineAllocations} from './pricing-line-allocation.js'
import type {SubmitOrderLineInput} from './order-repository.js'

const lines:SubmitOrderLineInput[]=[{productId:'first',quantity:1,note:'少冰'},
  {productId:'second',quantity:1,bundleSelections:[{groups:[{groupId:'choice',productIds:['drink']}]}]}]
const allocations=()=>lines.map((line,index)=>({requestIndex:index,productId:line.productId,
  quantity:1,unitPriceMinor:8800,discountAmountMinor:index===1?7810:0,lineFingerprint:pricingLineFingerprint(line)}))
describe('authoritative per-line pricing allocation',()=>{
  it('keeps the first drink at standard price and the chosen second drink at 9.90',()=>{
    const result=verifyPricingLineAllocations(allocations(),lines,7810)
    expect(result.map(row=>row.unitPriceMinor-row.discountAmountMinor)).toEqual([8800,990])
    expect(Object.isFrozen(result)&&result.every(Object.isFrozen)).toBe(true)
  })
  it('copies allocation authority so later adapter mutation cannot move discount',()=>{
    const input=allocations(),verified=verifyPricingLineAllocations(input,lines,7810)
    input[1]!.discountAmountMinor=0
    expect(verified[1]!.discountAmountMinor).toBe(7810)
  })
  for(const [name,change] of [
    ['quantity',(input:SubmitOrderLineInput[])=>{input[1]!.quantity=2}],
    ['product',(input:SubmitOrderLineInput[])=>{input[1]!.productId='another'}],
    ['choice',(input:SubmitOrderLineInput[])=>{input[1]!.bundleSelections=[{groups:[{groupId:'choice',productIds:['other']}]}]}],
    ['note',(input:SubmitOrderLineInput[])=>{input[0]!.note='多冰'}],
  ] as const)it(`rejects a changed ${name}`,()=>{
    const changed=structuredClone(lines);change(changed)
    expect(()=>verifyPricingLineAllocations(allocations(),changed,7810)).toThrow()
  })
  it('requires zero-discount lines as well and rejects reordering',()=>{
    expect(()=>verifyPricingLineAllocations(allocations().slice(1),lines,7810)).toThrow()
    expect(()=>verifyPricingLineAllocations(allocations().reverse(),lines,7810)).toThrow()
  })
  it('rejects excess, fractional and mismatched discount totals',()=>{
    for(const amount of [-1,0.1,8801,Number.MAX_SAFE_INTEGER+1]){
      const input=allocations();input[1]!.discountAmountMinor=amount
      expect(()=>verifyPricingLineAllocations(input,lines,amount)).toThrow()
    }
    expect(()=>verifyPricingLineAllocations(allocations(),lines,7811)).toThrow()
  })
})
