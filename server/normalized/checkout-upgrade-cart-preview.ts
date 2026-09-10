import type {GuestSharedCart} from './guest-shared-cart-repository.js'
import type {BundleUnitSelectionInput} from './order-repository.js'
import {CheckoutCartPricingError} from './checkout-cart-pricing.js'
import {MAX_LINE_QUANTITY,MAX_CART_QUANTITY} from './guest-shared-cart-limits.js'

/** Comparison-only alias: the source portion id denotes the replaced slot.
 * Never persist this cart. Accepted replacement retires the source id and
 * allocates a fresh target id through GuestSharedCartRepository. */
export function previewCartPortionReplacement(cart:GuestSharedCart,input:{portionId:string;targetProductId:string;bundleSelection?:BundleUnitSelectionInput}):GuestSharedCart&{previewOnly:true}{
 if(cart.status!=='open'||cart.guestWritesFrozen)throw new CheckoutCartPricingError('当前草稿不可升级')
 const source=cart.lines.find(line=>line.portionIds?.includes(input.portionId))
 if(!source||source.portionIds?.length!==source.quantity||source.productId===input.targetProductId)throw new CheckoutCartPricingError('升级份次不存在或目标没有变化')
 if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(input.targetProductId))throw new CheckoutCartPricingError('升级目标商品无效')
 const index=source.portionIds.indexOf(input.portionId),target=cart.lines.find(line=>line.productId===input.targetProductId)
 if((target?.quantity??0)+1>MAX_LINE_QUANTITY||cart.lines.some(line=>!Number.isSafeInteger(line.quantity)||line.quantity<1||line.quantity>MAX_LINE_QUANTITY)||cart.lines.reduce((sum,line)=>sum+line.quantity,0)>MAX_CART_QUANTITY)throw new CheckoutCartPricingError('升级后超出购物车份数上限')
 const replacement={productId:input.targetProductId,name:target?.name??'',quantity:(target?.quantity??0)+1,
  portionIds:[...(target?.portionIds??[]),input.portionId],bundleSelections:[...structuredClone(target?.bundleSelections??[]),...(input.bundleSelection?[structuredClone(input.bundleSelection)]:[])],
  // These flags are not product authority; quoteCurrent must validate the exact
  // product, channel, time, price and every concrete choice before any result.
  available:target?.available??true,unavailableReason:target?.unavailableReason??null,unitPriceMinor:null,subtotalAmountMinor:null,currency:null}
 const lines=cart.lines.flatMap(line=>{
  if(line===target)return[replacement]
  if(line!==source)return[structuredClone(line)]
  return source.quantity>1?[{...structuredClone(source),quantity:source.quantity-1,portionIds:source.portionIds!.filter(id=>id!==input.portionId),bundleSelections:source.bundleSelections.filter((_,position)=>position!==index),subtotalAmountMinor:null}]:[]
 })
 if(!target)lines.push(replacement)
 return{...cart,lines,totalAmountMinor:null,currency:null,previewOnly:true}
}
