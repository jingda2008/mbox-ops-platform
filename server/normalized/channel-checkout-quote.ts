import { CheckoutCouponQuoteRepository } from './checkout-coupon-quote-repository.js'
import { CheckoutCartPricingError } from './checkout-cart-pricing.js'
import type { ScopedTransaction } from './transaction-runner.js'

/** Both quote types retain their original owner and authorization mechanism. */
export async function checkoutPriceSource(tx:ScopedTransaction,id:string):Promise<'channel_quote'|'checkout_quote'>{
 const exists=await tx.query('SELECT id FROM mbox.channel_price_quotes WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[tx.scope.tenantId,tx.scope.storeId,id])
 return exists.rows.length?'channel_quote':'checkout_quote'
}
export async function findCheckoutPriceQuote(tx:ScopedTransaction,context:{customerId:string;tableSessionId:string;actorRef:string},id:string){
 if(await checkoutPriceSource(tx,id)==='checkout_quote')return{...await new CheckoutCouponQuoteRepository(tx).find(id,context.customerId),sourceType:'checkout_quote' as const}
 const row=(await tx.query<{id:string;table_session_id:string;snapshot:{cart?:{id:string;generation:number;version:number};subtotalMinor:number;discountMinor:number;payableMinor:number;currency:string};expires_at:string;current:boolean}>(`SELECT q.*,q.expires_at::text,
  q.expires_at>clock_timestamp() AND EXISTS(SELECT 1 FROM mbox.guest_shared_carts c WHERE (c.tenant_id,c.store_id,c.id)=(q.tenant_id,q.store_id,(q.snapshot->'cart'->>'id')::uuid)
   AND c.table_session_id=q.table_session_id AND c.status='open' AND c.generation=(q.snapshot->'cart'->>'generation')::bigint AND c.version=(q.snapshot->'cart'->>'version')::bigint) AS current
  FROM mbox.channel_price_quotes q WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND actor_ref=$4 AND customer_id=$5 AND table_session_id=$6`,[tx.scope.tenantId,tx.scope.storeId,id,context.actorRef,context.customerId,context.tableSessionId])).rows[0]
 if(!row?.snapshot.cart)throw new CheckoutCartPricingError('渠道报价不属于当前顾客和购物车')
 return{id:row.id,tableSessionId:row.table_session_id,generation:row.snapshot.cart.generation,version:row.snapshot.cart.version,current:row.current,expiresAt:row.expires_at,
  subtotalMinor:row.snapshot.subtotalMinor,discountMinor:row.snapshot.discountMinor,payableMinor:row.snapshot.payableMinor,currency:row.snapshot.currency,pointsUsed:0,sourceType:'channel_quote' as const}
}
