import type {ScopedTransaction} from './transaction-runner.js'
import {CustomerRepository} from './customer-repository.js'
import {CouponCalendarRepository} from './coupon-calendar-repository.js'
import {CouponPricePromiseRepository} from './coupon-price-promise-repository.js'
import {StackingPricingDraftRepository} from './stacking-pricing-draft-repository.js'
import {intersectCouponPolicies} from './checkout-coupon-policy.js'
import {quoteCheckoutCart,CheckoutCartPricingError} from './checkout-cart-pricing.js'
import {OrderRepository,type OrderChannel} from './order-repository.js'
import type {GuestSharedCart} from './guest-shared-cart-repository.js'
import type {PricingEffect,StackingPolicy} from './stacking-pricing.js'

export interface CheckoutCouponSelection {benefitId:string;portionId:string}
/** Internal checkout resolver. Customer identity/cart must come from the
 * authenticated session, never an HTTP customer-id override. This preview
 * does not consume coupons or authorize order creation. */
export class CheckoutCouponRepository{
  constructor(private readonly tx:ScopedTransaction){}
  async quote(input:{customerId:string;cart:GuestSharedCart;expectedGeneration:number;expectedVersion:number;selections:readonly CheckoutCouponSelection[];channel:OrderChannel;upgradedPortionIds?:readonly string[]}){
    if(!input.selections.length||input.selections.length>10)throw new CheckoutCartPricingError('每次请选择1至10份券权益')
    const uuid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
    if(input.selections.some(s=>!uuid.test(s.benefitId)||!uuid.test(s.portionId))||new Set(input.selections.map(s=>s.portionId)).size!==input.selections.length)throw new CheckoutCartPricingError('用券份次无效或同一份商品重复用券')
    if(input.cart.version!==input.expectedVersion||input.cart.generation!==input.expectedGeneration)throw new CheckoutCartPricingError('购物车已变化，请重新选择优惠券')
    const customer=await new CustomerRepository(this.tx).resolveCanonical(input.customerId)
    const ids=[...new Set(input.selections.map(s=>s.benefitId))]
    const owned=await this.tx.query<{id:string;available:number}>(`
      WITH RECURSIVE family(id) AS(SELECT $3::uuid UNION SELECT c.id FROM mbox.customers c JOIN family f ON c.merged_into_customer_id=f.id WHERE c.tenant_id=$1 AND c.store_id=$2)
      SELECT b.id,b.quantity_total-b.quantity_reserved-b.quantity_redeemed AS available FROM mbox.benefits b
      WHERE b.tenant_id=$1 AND b.store_id=$2 AND b.id=ANY($4::uuid[]) AND b.customer_id IN(SELECT id FROM family)
        AND b.status IN('issued','reserved') AND b.valid_from<=clock_timestamp() AND (b.valid_until IS NULL OR b.valid_until>clock_timestamp())
      ORDER BY b.id
    `,[this.tx.scope.tenantId,this.tx.scope.storeId,customer.id,ids])
    if(owned.rows.length!==ids.length)throw new CheckoutCartPricingError('有券不属于当前会员或已经失效，请刷新券包')
    const calendars=await this.tx.query<{benefit_id:string;code:string}>(`SELECT b.benefit_id,v.code FROM mbox.benefit_coupon_calendar_bindings b JOIN mbox.coupon_calendar_versions v ON v.tenant_id=b.tenant_id AND v.store_id=b.store_id AND v.id=b.version_id WHERE b.tenant_id=$1 AND b.store_id=$2 AND b.benefit_id=ANY($3::uuid[])`,[this.tx.scope.tenantId,this.tx.scope.storeId,ids])
    const codes=new Map(calendars.rows.map(r=>[r.benefit_id,r.code]))
    const promises=await new CouponPricePromiseRepository(this.tx).views(ids),policies=new Map<string,StackingPolicy>(),effects:PricingEffect[]=[]
    for(const row of owned.rows){
      const selections=input.selections.filter(s=>s.benefitId===row.id),promise=promises.get(row.id)
      if(!promise)throw new CheckoutCartPricingError('所选券没有本入口所需的低价承诺，请从券包查看适用入口')
      if(row.available<selections.length)throw new CheckoutCartPricingError(`所选券可用${row.available}份，本次选择${selections.length}份，请减少用券数量`)
      // Preview has not persisted reservations: account for every selected
      // coupon sharing this calendar campaign, including different versions.
      const combinedQuantity=input.selections.filter(s=>codes.get(s.benefitId)===codes.get(row.id)).length
      const calendar=await new CouponCalendarRepository(this.tx).authorizeReservation(row.id,customer.id,combinedQuantity)
      if(!calendar)throw new CheckoutCartPricingError('缺少券有效时间与次数规则')
      if(!policies.has(promise.stackingVersionId)){
        const version=await new StackingPricingDraftRepository(this.tx).find(promise.stackingVersionId)
        if(!['published','stopped'].includes(version.status))throw new CheckoutCartPricingError('券绑定的叠加规则未正式发布')
        policies.set(promise.stackingVersionId,version.policy)
      }
      for(const selection of selections){
        const line=input.cart.lines.find(l=>l.portionIds?.includes(selection.portionId))
        if(!line||!promise.products.some(p=>p.id===line.productId))throw new CheckoutCartPricingError('选择的商品份次不在该券商品池内')
        effects.push({id:selection.portionId,stage:'coupon',kind:'fixed_price',value:promise.fixedPriceMinor,unitIds:[selection.portionId],minimumSpendMinor:0})
      }
    }
    // Upgrade status belongs to the durable portion, not to the caller's
    // chosen order of operations. Applying a coupon after accepting an upgrade
    // must enforce exactly the same rule as selecting the coupon beforehand.
    const accepted=(await this.tx.query<{replacement_portion_id:string}>(`SELECT c.replacement_portion_id FROM mbox.checkout_upgrade_opportunity_closures c JOIN mbox.checkout_upgrade_opportunities o ON o.tenant_id=c.tenant_id AND o.store_id=c.store_id AND o.id=c.opportunity_id WHERE o.tenant_id=$1 AND o.store_id=$2 AND o.cart_id=$3 AND c.action='accepted' AND c.replacement_portion_id=ANY($4::uuid[])`,[this.tx.scope.tenantId,this.tx.scope.storeId,input.cart.id,input.cart.lines.flatMap(line=>line.portionIds??[])])).rows
    const upgradedPortionIds=[...new Set([...(input.upgradedPortionIds??[]),...accepted.map(row=>row.replacement_portion_id)])]
    const quote=await quoteCheckoutCart(new OrderRepository(this.tx),input.cart,{...input,upgradedPortionIds,policy:intersectCouponPolicies([...policies.values()]),effects})
    if(quote.price.discountMinor<=0)throw new CheckoutCartPricingError('当前商品没有可兑现的券优惠，请按原价下单')
    return{...quote,customerId:customer.id,selections:input.selections.map(s=>({...s})),stackingVersionIds:[...policies.keys()]}
  }
}
