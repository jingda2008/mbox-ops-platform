import {describe,it,expect,vi} from 'vitest'
import {quoteCheckoutCart} from './checkout-cart-pricing.js'
import {DEFAULT_STACKING_POLICY} from './stacking-pricing.js'
import type {GuestSharedCart} from './guest-shared-cart-repository.js'
const first='11111111-1111-4111-8111-111111111111',second='22222222-2222-4222-8222-222222222222'
function fixture(){
  const cart={id:'cart',generation:1,version:5,status:'open',guestWritesFrozen:false,lines:[{productId:'bundle',quantity:2,available:true,portionIds:[first,second],bundleSelections:[{groups:[{groupId:'choice',productIds:['first-drink']}]},{groups:[{groupId:'choice',productIds:['second-drink']}]}]}]} as unknown as GuestSharedCart
  const quoteCurrent=vi.fn(async()=>({pricingBasis:'standard_only' as const,currency:'CNY',subtotalAmountMinor:13600,costAmountMinor:4200,items:[0,1].map(index=>({requestIndex:index,productId:'bundle',quantity:1,amountMinor:6800,unitPriceMinor:6800,costMinor:index===0?1800:2400,name:'套餐',bundle:true,note:null,composition:[{productId:index===0?'first-drink':'second-drink',quantity:1,choiceGroupId:'choice',name:'具体酒水'}]}))}))
  const input={expectedGeneration:1,expectedVersion:5,policy:{...DEFAULT_STACKING_POLICY,allowBundlePrice:true},effects:[{id:'coupon',stage:'coupon' as const,kind:'fixed_price' as const,value:990,unitIds:[second],minimumSpendMinor:0}],channel:'guest_qr' as const}
  return{cart,orders:{quoteCurrent},input}
}
describe('cart portions to standard-price and coupon quote composition',()=>{
  it('preserves two choices and applies a fixed-price coupon only to its stable portion',async()=>{
    const {cart,orders,input}=fixture(),result=await quoteCheckoutCart(orders,cart,input)
    expect(result.price.units.map(row=>row.payableMinor)).toEqual([6800,990])
    expect(result.price.costMinor).toBe(4200)
    expect(result.lineAllocations.map(row=>row.discountAmountMinor)).toEqual([0,5810])
    expect(result.lines.map(line=>line.bundleSelections![0]!.groups[0]!.productIds)).toEqual([['first-drink'],['second-drink']])
    expect(result).toMatchObject({orderAuthorization:false,inventoryReserved:false,portionIds:[first,second]})
    expect(result.lines.every(line=>line.quantity===1)).toBe(true)
  })
  it('rejects a stale cart before any quote query',async()=>{
    const {cart,orders,input}=fixture();await expect(quoteCheckoutCart(orders,cart,{...input,expectedVersion:4})).rejects.toThrow('购物车已变化');expect(orders.quoteCurrent).not.toHaveBeenCalled()
  })
  it('rejects missing or reused portion identities before consulting prices',async()=>{
    for(const ids of [[],[first,first]]){const {cart,orders,input}=fixture();cart.lines[0]!.portionIds=ids;await expect(quoteCheckoutCart(orders,cart,input)).rejects.toThrow();expect(orders.quoteCurrent).not.toHaveBeenCalled()}
  })
  it('does not silently move a coupon after its selected portion was removed',async()=>{
    const {cart,orders,input}=fixture();await expect(quoteCheckoutCart(orders,cart,{...input,effects:[{...input.effects[0]!,unitIds:['removed']}]})).rejects.toThrow('优惠份次不存在')
  })
  it('honors independent upgrade stacking while preserving normal ordering when no coupon is selected',async()=>{
    const {cart,orders,input}=fixture();await expect(quoteCheckoutCart(orders,cart,{...input,upgradedPortionIds:[second]})).rejects.toThrow('不能用于升级')
    expect((await quoteCheckoutCart(orders,cart,{...input,effects:[],upgradedPortionIds:[second]})).price.payableMinor).toBe(13600)
  })
})
