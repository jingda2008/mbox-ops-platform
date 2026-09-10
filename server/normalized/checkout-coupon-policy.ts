import {parseStackingPolicy,type StackingPolicy,StackingPricingError} from './stacking-pricing.js'

/** All participating promises must permit a combination. Never choose the
 * most permissive coupon's policy or silently change a calculation order. */
export function intersectCouponPolicies(policies:readonly StackingPolicy[]):StackingPolicy{
  if(!policies.length)throw new StackingPricingError('请选择有效券规则')
  const parsed=policies.map(parseStackingPolicy),first=parsed[0]!
  if(parsed.some(p=>p.calculationOrder.join(',')!==first.calculationOrder.join(',')))throw new StackingPricingError('这些券的计算顺序不一致，不能组合使用')
  const allowOtherCoupons=parsed.every(p=>p.allowOtherCoupons)
  const caps=parsed.map(p=>p.maximumDiscountMinor).filter((n):n is number=>n!==null)
  return{allowMemberPrice:parsed.every(p=>p.allowMemberPrice),allowBundlePrice:parsed.every(p=>p.allowBundlePrice),
    allowCheckoutUpgrade:parsed.every(p=>p.allowCheckoutUpgrade),allowOtherCoupons,allowPoints:parsed.every(p=>p.allowPoints),
    maxCoupons:allowOtherCoupons?Math.min(...parsed.map(p=>p.maxCoupons)):1,calculationOrder:[...first.calculationOrder],
    maximumDiscountMinor:caps.length?Math.min(...caps):null,minimumPayableMinor:Math.max(...parsed.map(p=>p.minimumPayableMinor))}
}
