import type {ScopedTransaction} from './transaction-runner.js'
import type {GuestSharedCart} from './guest-shared-cart-repository.js'
import {OrderRepository,type BundleUnitSelectionInput,type OrderChannel} from './order-repository.js'
import {CheckoutCouponRepository,type CheckoutCouponSelection} from './checkout-coupon-repository.js'
import {quoteCheckoutCart,CheckoutCartPricingError} from './checkout-cart-pricing.js'
import {DEFAULT_STACKING_POLICY} from './stacking-pricing.js'
import {previewCartPortionReplacement} from './checkout-upgrade-cart-preview.js'
import {MAX_CART_AMOUNT_MINOR} from './guest-shared-cart-limits.js'

/** Both alternatives use the current checkout authority, not sticker-price
 * subtraction. A selected coupon may not silently disappear: incompatibility
 * rejects this candidate. No quote/hold/order/cart write occurs here. */
export class CheckoutUpgradePricingRepository{
 constructor(private readonly tx:ScopedTransaction){}
 async compare(input:{cart:GuestSharedCart;customerId:string;portionId:string;targetProductId:string;bundleSelection?:BundleUnitSelectionInput;selections:readonly CheckoutCouponSelection[];channel:OrderChannel}){
  const proposed=previewCartPortionReplacement(input.cart,input)
  const quote=async(cart:GuestSharedCart,upgradedPortionIds:string[])=>{
   const state={expectedGeneration:input.cart.generation,expectedVersion:input.cart.version,channel:input.channel,upgradedPortionIds}
   if(input.selections.length)return new CheckoutCouponRepository(this.tx).quote({...state,cart,customerId:input.customerId,selections:input.selections})
   return quoteCheckoutCart(new OrderRepository(this.tx),cart,{...state,policy:DEFAULT_STACKING_POLICY,effects:[]})
  }
  const before=await quote(input.cart,[]),after=await quote(proposed,[input.portionId])
  if(before.currency!==after.currency)throw new CheckoutCartPricingError('升级前后币种不一致')
  if(after.price.subtotalMinor>MAX_CART_AMOUNT_MINOR)throw new CheckoutCartPricingError('升级后超出购物车金额上限')
  // A price update between reads invalidates the comparison, even for another
  // guest's unaffected portion. It must not become hidden upgrade cost.
  for(const allocation of before.lineAllocations){
   const portionId=before.portionIds[allocation.requestIndex]!
   if(portionId===input.portionId)continue
   const index=after.portionIds.indexOf(portionId),other=after.lineAllocations[index]
   if(index<0||!other||other.productId!==allocation.productId||other.unitPriceMinor!==allocation.unitPriceMinor||other.lineFingerprint!==allocation.lineFingerprint)throw new CheckoutCartPricingError('其他商品或价格已变化，请重新确认原购物车')
  }
  return{previewOnly:true as const,orderAuthorization:false as const,cartChanged:false as const,inventoryReserved:false as const,
   pricingBasis:input.selections.length?'fixed_coupon_and_standard' as const:'standard_only' as const,
   before,after,sourcePortionId:input.portionId,addedPayableMinor:after.price.payableMinor-before.price.payableMinor}
 }
}
