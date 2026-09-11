import type {GuestSharedCart} from './guest-shared-cart-repository.js'
import {OrderRepository,type OrderChannel,type SubmitOrderLineInput} from './order-repository.js'
import {calculateStackingPrice,StackingPricingError,type PricingEffect,type StackingPolicy} from './stacking-pricing.js'
import {pricingLineFingerprint,verifyPricingLineAllocations} from './pricing-line-allocation.js'
import {MAX_LINE_QUANTITY,MAX_CART_QUANTITY} from './guest-shared-cart-limits.js'

export class CheckoutCartPricingError extends Error{}
/** Shared quote composition, NOT coupon ownership or order authority. The
 * caller must load cart and approved effects under the checkout transaction.
 * One physical portion becomes one independently refundable billable line. */
export async function quoteCheckoutCart(
  orders:Pick<OrderRepository,'quoteCurrent'>,
  cart:GuestSharedCart,
  input:{expectedGeneration:number;expectedVersion:number;policy:StackingPolicy;effects:readonly PricingEffect[];channel:OrderChannel;upgradedPortionIds?:readonly string[]},
){
  if(cart.status!=='open'||cart.guestWritesFrozen||cart.version!==input.expectedVersion||cart.generation!==input.expectedGeneration)throw new CheckoutCartPricingError('购物车已变化或不可修改，请刷新后重新确认')
  if(!cart.lines.length)throw new CheckoutCartPricingError('购物车为空，请先添加商品')
  const unavailable=cart.lines.filter(line=>!line.available)
  if(unavailable.length)throw new CheckoutCartPricingError(`以下商品暂不可售：${unavailable.map(line=>line.name).join('、')}，请移除或重新选择`)
  const portionIds:string[]=[],lines:SubmitOrderLineInput[]=[]
  for(const line of cart.lines){
    if(!Number.isSafeInteger(line.quantity)||line.quantity<1||line.quantity>MAX_LINE_QUANTITY||line.portionIds?.length!==line.quantity
      ||(line.bundleSelections.length!==0&&line.bundleSelections.length!==line.quantity))throw new CheckoutCartPricingError('套餐份次或选项信息不完整，请刷新购物车')
    for(let index=0;index<line.quantity;index++){
      const portionId=line.portionIds[index]!
      if(typeof portionId!=='string'||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(portionId)||portionIds.includes(portionId))throw new CheckoutCartPricingError('商品份次编号无效或重复')
      portionIds.push(portionId);lines.push({productId:line.productId,quantity:1,...(line.bundleSelections.length?{bundleSelections:[line.bundleSelections[index]!]}:{})})
    }
  }
  if(lines.length>MAX_CART_QUANTITY)throw new CheckoutCartPricingError('本次商品份数超出结算范围')
  const upgraded=input.upgradedPortionIds??[]
  if(new Set(upgraded).size!==upgraded.length||upgraded.some(id=>!portionIds.includes(id)))throw new CheckoutCartPricingError('升级份次不属于当前购物车')
  const standard=await orders.quoteCurrent(lines,input.channel)
  if(standard.items.length!==lines.length)throw new CheckoutCartPricingError('报价明细不完整')
  const units=standard.items.map((item,index)=>{
    if(item.requestIndex!==index||item.productId!==lines[index]!.productId||item.quantity!==1)throw new CheckoutCartPricingError('报价与具体份次不一致')
    return{id:portionIds[index]!,amountMinor:item.amountMinor,costMinor:item.costMinor,bundle:item.bundle,upgraded:upgraded.includes(portionIds[index]!)}
  })
  let price:ReturnType<typeof calculateStackingPrice>
  try{price=calculateStackingPrice(input.policy,{units,effects:input.effects})}
  catch(error){if(error instanceof StackingPricingError)throw new CheckoutCartPricingError(error.message);throw error}
  const allocations=verifyPricingLineAllocations(price.units.map((unit,index)=>({requestIndex:index,
    productId:lines[index]!.productId,quantity:1,unitPriceMinor:standard.items[index]!.unitPriceMinor,
    discountAmountMinor:unit.discountMinor,lineFingerprint:pricingLineFingerprint(lines[index]!),
  })),lines,price.discountMinor)
  return{orderAuthorization:false as const,inventoryReserved:false as const,cartId:cart.id,
    generation:cart.generation,version:cart.version,currency:standard.currency,lines,portionIds,
    price,lineAllocations:allocations,operationalPortions:standard.operationalPortions,composition:standard.items.map((item,index)=>({portionId:portionIds[index]!,items:item.composition,costMinor:item.costMinor})),
  }
}
