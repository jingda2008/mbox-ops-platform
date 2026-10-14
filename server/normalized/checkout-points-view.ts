import type {ScopedTransaction} from './transaction-runner.js'
export interface CheckoutPointsView {used:number;restored:number;credited:number;state:'held'|'consumed'|'released'}
/** Read original deduction and restoration facts without converting them into
 * cash receipts. Old-schema repair/replay paths safely have no such facts. */
export async function readCheckoutPoints(tx:ScopedTransaction,orderIds:readonly string[],publicIds=false){
  const result=new Map<string,CheckoutPointsView>()
  if(!orderIds.length || !(await tx.query<{present:boolean}>("SELECT to_regclass('mbox.checkout_point_holds') IS NOT NULL AS present")).rows[0]?.present)return result
  const rows=await tx.query<{id:string;public_id:string;points:number;restored_points:number;credited:string;status:CheckoutPointsView['state']}>(`SELECT o.id,o.public_id,h.points,h.restored_points,h.status,
    COALESCE((SELECT sum(r.credited_points) FROM mbox.checkout_point_restorations r WHERE (r.tenant_id,r.store_id,r.quote_id)=(h.tenant_id,h.store_id,h.quote_id)),0)::text AS credited
    FROM mbox.orders o JOIN mbox.checkout_coupon_order_links l ON (l.tenant_id,l.store_id,l.order_id)=(o.tenant_id,o.store_id,o.id)
    JOIN mbox.checkout_point_holds h ON (h.tenant_id,h.store_id,h.quote_id)=(l.tenant_id,l.store_id,l.quote_id)
    WHERE o.tenant_id=$1 AND o.store_id=$2 AND ${publicIds?'o.public_id=ANY($3::text[])':'o.id=ANY($3::uuid[])'}`,[tx.scope.tenantId,tx.scope.storeId,orderIds])
  for(const row of rows.rows)result.set(publicIds?row.public_id:row.id,{used:row.points,restored:row.restored_points,credited:Number(row.credited),state:row.status})
  return result
}
