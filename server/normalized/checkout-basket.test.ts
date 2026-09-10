import { describe, expect, it } from 'vitest'
import { normalizeCheckoutBasket, type CheckoutBasketLine } from './customer-experience-repository.js'
const productId='11111111-1111-4111-8111-111111111111'
const groupId='22222222-2222-4222-8222-222222222222'
const other='33333333-3333-4333-8333-333333333333'
describe('checkout upgrade basket choice preservation',()=>{
  it('retains independent choices for two portions and does not mutate input',()=>{
    const lines=[{productId,quantity:2,note:'  少冰  ',bundleSelections:[{groups:[{groupId,productIds:[productId]}]},{groups:[{groupId,productIds:[other]}]}]}]
    const original=JSON.stringify(lines)
    expect(normalizeCheckoutBasket(lines)[0]).toEqual({...lines[0],note:'少冰'})
    expect(JSON.stringify(lines)).toBe(original)
  })
  it('normalizes equivalent group ordering but keeps portion identity',()=>{
    const one={productId,quantity:1,bundleSelections:[{groups:[{groupId,productIds:[other,productId]},{groupId:other,productIds:[productId]}]}]}
    const two={...one,bundleSelections:[{groups:[...one.bundleSelections[0]!.groups].reverse().map(group=>({...group,productIds:[...group.productIds].reverse()}))}]}
    expect(normalizeCheckoutBasket([one])).toEqual(normalizeCheckoutBasket([two]))
  })
  it.each([null,'bad',[{}],[{groups:'bad'}],[{groups:[{groupId,productIds:['bad']}]}],[{groups:[{groupId,productIds:[]},{groupId,productIds:[]}]}]])('rejects malformed choices %j',(bundleSelections)=>{
    expect(()=>normalizeCheckoutBasket([{productId,quantity:1,bundleSelections} as CheckoutBasketLine])).toThrow()
  })
  it('rejects missing per-portion selections rather than silently dropping them',()=>{
    expect(()=>normalizeCheckoutBasket([{productId,quantity:2,bundleSelections:[{groups:[{groupId,productIds:[productId]}]}]}])).toThrow('份数')
  })
  it('keeps legacy baskets unchanged when no choices exist',()=>{
    expect(normalizeCheckoutBasket([{productId,quantity:1,bundleSelections:[]}])).toEqual([{productId,quantity:1}])
  })
})
