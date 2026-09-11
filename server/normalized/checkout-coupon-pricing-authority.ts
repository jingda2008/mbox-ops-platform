import {randomUUID} from 'node:crypto'
import type {ScopedTransaction} from './transaction-runner.js'
import {PricingAuthorizationDeniedError,type PricingAuthorityContext,type PricingAuthorityDecision} from './pricing-authorization-policy.js'
import {CheckoutCouponQuoteRepository} from './checkout-coupon-quote-repository.js'
import {lockBoundGuestTablePosition} from './guest-table-authority.js'
import {verifyPricingLineAllocations} from './pricing-line-allocation.js'
import {OrderRepository} from './order-repository.js'
import {BenefitRepository} from './benefit-repository.js'

/** Only consumed through PricingAuthorizationPolicy in the order transaction.
 * A prepared quote or client amount can never itself authorize a discount. */
export async function authorizeCheckoutCouponQuote(tx:ScopedTransaction,context:Readonly<PricingAuthorityContext>):Promise<Readonly<PricingAuthorityDecision>>{
  const scope=[tx.scope.tenantId,tx.scope.storeId]
  if(context.actor.type!=='guest'||context.channel!=='guest_qr')throw new PricingAuthorizationDeniedError('此报价只能由原会员在桌边结算时确认')
  const row=(await tx.query<{customer_id:string;table_session_id:string;unexpired:boolean;cart_matches:boolean}>(`SELECT q.customer_id,q.table_session_id,q.expires_at>clock_timestamp() AS unexpired,
      (c.status='submitting' AND c.generation=q.cart_generation AND c.version=q.cart_version+1) AS cart_matches
    FROM mbox.checkout_coupon_quotes q JOIN mbox.guest_shared_carts c ON c.tenant_id=q.tenant_id AND c.store_id=q.store_id AND c.id=q.cart_id
    WHERE q.tenant_id=$1 AND q.store_id=$2 AND q.id=$3
    FOR UPDATE OF q`,[...scope,context.request.sourceId])).rows[0]
  if(!row)throw new PricingAuthorizationDeniedError('该结算报价不存在，请重新确认购物车')
  if(row.table_session_id!==context.tableSessionId)throw new PricingAuthorizationDeniedError('该报价属于原桌次，请在当前桌重新确认购物车')
  if(!row.unexpired)throw new PricingAuthorizationDeniedError('结算报价已过期，请重新确认当前价格与优惠')
  if(!row.cart_matches)throw new PricingAuthorizationDeniedError('购物车商品已变更，请重新确认结算报价')
  if(!await lockBoundGuestTablePosition(tx,{tableSessionId:context.tableSessionId,customerId:row.customer_id,actorRef:context.actor.ref}))throw new PricingAuthorizationDeniedError('原会员已不在此桌，请重新扫码确认会员与桌台')
  const quote=await new CheckoutCouponQuoteRepository(tx).find(context.request.sourceId,row.customer_id)
  const allocations=verifyPricingLineAllocations(quote.lines.map(line=>({requestIndex:line.requestIndex,productId:line.productId,quantity:1,unitPriceMinor:line.standardMinor,discountAmountMinor:line.discountMinor,lineFingerprint:line.lineFingerprint})),context.lines,quote.discountMinor)
  const standard=await new OrderRepository(tx).quoteCurrent(context.lines,context.channel)
  if(standard.currency!==quote.currency||standard.items.length!==allocations.length||standard.items.some((item,index)=>item.unitPriceMinor!==allocations[index]!.unitPriceMinor||item.quantity!==1))throw new PricingAuthorizationDeniedError('商品价格已变化，请重新确认报价')
  const benefits=[...new Set(quote.lines.flatMap(line=>line.benefitId?[line.benefitId]:[]))].sort()
  for(const benefitId of benefits){
    const reservation=await new BenefitRepository(tx).reserve({benefitId,customerId:quote.customerId,tableSessionId:context.tableSessionId,
      quantity:quote.lines.filter(line=>line.benefitId===benefitId).length,expiresAt:quote.expiresAt,
      reservationIdempotencyKey:`checkout-quote:${quote.id}:${benefitId}`,reservationFingerprint:quote.id},context.actor.ref)
    await tx.query('INSERT INTO mbox.checkout_coupon_quote_reservations(tenant_id,store_id,quote_id,benefit_id,reservation_id) VALUES($1,$2,$3,$4,$5)',[...scope,quote.id,benefitId,reservation.id])
  }
  const authorizationId=randomUUID()
  await tx.query(`INSERT INTO mbox.pricing_authorizations(id,tenant_id,store_id,table_session_id,source_type,source_id,checkout_quote_id,kind,amount_minor,maximum_amount_minor,currency,expires_at)
    VALUES($1,$2,$3,$4,'checkout_quote',$5,$5,'discount',$6,$6,$7,$8)`,[authorizationId,...scope,context.tableSessionId,quote.id,quote.discountMinor,quote.currency,quote.expiresAt])
  return{authorized:true,authorizationId,kind:'discount',sourceType:'checkout_quote',sourceId:quote.id,amountMinor:quote.discountMinor,maximumAmountMinor:quote.discountMinor,currency:quote.currency,expiresAt:quote.expiresAt,lineAllocations:allocations}
}
