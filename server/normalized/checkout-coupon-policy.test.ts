import {describe,it,expect} from 'vitest'
import {intersectCouponPolicies} from './checkout-coupon-policy.js'
import {DEFAULT_STACKING_POLICY} from './stacking-pricing.js'
describe('every coupon controls whether it can join a price combination',()=>{
  it('does not let an open coupon override a closed promise',()=>{
    const open={...DEFAULT_STACKING_POLICY,allowOtherCoupons:true,maxCoupons:4,allowBundlePrice:true,allowCheckoutUpgrade:true}
    expect(intersectCouponPolicies([open,{...DEFAULT_STACKING_POLICY}])).toMatchObject({allowOtherCoupons:false,maxCoupons:1,allowBundlePrice:false,allowCheckoutUpgrade:false})
  })
  it('uses all explicit money and count boundaries, independent of selection order',()=>{
    const a={...DEFAULT_STACKING_POLICY,allowOtherCoupons:true,maxCoupons:4,maximumDiscountMinor:4000,minimumPayableMinor:100},b={...a,maxCoupons:2,maximumDiscountMinor:3000,minimumPayableMinor:200}
    expect(intersectCouponPolicies([a,b])).toEqual(intersectCouponPolicies([b,a]))
    expect(intersectCouponPolicies([a,b])).toMatchObject({maxCoupons:2,maximumDiscountMinor:3000,minimumPayableMinor:200})
  })
  it('refuses incompatible calculation orders rather than guessing a profitable order',()=>{
    expect(()=>intersectCouponPolicies([{...DEFAULT_STACKING_POLICY},{...DEFAULT_STACKING_POLICY,calculationOrder:['coupon','member','points']}])).toThrow('顺序不一致')
    expect(()=>intersectCouponPolicies([])).toThrow()
  })
})
