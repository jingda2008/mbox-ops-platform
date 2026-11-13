import type { ScopedTransaction } from './transaction-runner.js'

/** Call before taking downstream row locks, or while already holding the movement
 * lock. The same lock is reentrant and shared with quote consumption and movement.
 * Pending/created payment attempts are not evidence of an unpaid final outcome. */
export async function releaseUnusedChannelDiscounts(tx:ScopedTransaction,visitId:string){
 const scope=[tx.scope.tenantId,tx.scope.storeId]
 await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('table-customer-movement:'||$1::text||':'||$2::text,0))`,scope)
  // Only a completely cancelled, never-paid, never-made order can return its
  // discount hold. A return after payment/production keeps used L and its cap.
  const rows=(await tx.query<{quote_id:string;activation_id:string;order_id:string;amount_minor:string}>(`SELECT p.quote_id,p.activation_id,p.order_id,p.amount_minor::text
   FROM mbox.channel_price_applications p JOIN mbox.channel_activations a ON (a.tenant_id,a.store_id,a.id)=(p.tenant_id,p.store_id,p.activation_id)
   JOIN mbox.orders o ON (o.tenant_id,o.store_id,o.id)=(p.tenant_id,p.store_id,p.order_id)
   WHERE p.tenant_id=$1 AND p.store_id=$2 AND a.visit_id=$3 AND o.status='cancelled'
   AND NOT EXISTS(SELECT 1 FROM mbox.channel_gift_promises g WHERE (g.tenant_id,g.store_id,g.order_id)=(o.tenant_id,o.store_id,o.id))
   AND NOT EXISTS(SELECT 1 FROM mbox.channel_price_releases r WHERE (r.tenant_id,r.store_id,r.quote_id,r.activation_id)=(p.tenant_id,p.store_id,p.quote_id,p.activation_id))
   AND NOT EXISTS(SELECT 1 FROM mbox.order_payment_facts f WHERE (f.tenant_id,f.store_id,f.order_id)=(o.tenant_id,o.store_id,o.id) AND f.status NOT IN('failed','closed'))
   AND NOT EXISTS(SELECT 1 FROM mbox.order_items i WHERE (i.tenant_id,i.store_id,i.order_id)=(o.tenant_id,o.store_id,o.id) AND i.status IN('preparing','ready','delivered'))
   AND NOT EXISTS(SELECT 1 FROM mbox.order_cancellation_events e WHERE (e.tenant_id,e.store_id,e.order_id)=(o.tenant_id,o.store_id,o.id) AND e.delivered_item_count>0)
   AND NOT EXISTS(SELECT 1 FROM mbox.order_items i JOIN mbox.kds_tasks k ON (k.tenant_id,k.store_id,k.order_item_id)=(i.tenant_id,i.store_id,i.id)
    WHERE (i.tenant_id,i.store_id,i.order_id)=(o.tenant_id,o.store_id,o.id) AND (k.ready_at IS NOT NULL OR EXISTS(SELECT 1 FROM mbox.kds_task_events e WHERE (e.tenant_id,e.store_id,e.kds_task_id)=(k.tenant_id,k.store_id,k.id) AND e.to_status IN('preparing','ready'))))
   AND NOT EXISTS(SELECT 1 FROM mbox.inventory_movements m JOIN mbox.order_items i ON (i.tenant_id,i.store_id,i.id)=(m.tenant_id,m.store_id,m.order_item_id) WHERE (i.tenant_id,i.store_id,i.order_id)=(o.tenant_id,o.store_id,o.id) AND m.quantity_delta<0)
   ORDER BY p.activation_id,p.order_id FOR UPDATE OF a`,[...scope,visitId])).rows
  for(const row of rows){
   await tx.query(`INSERT INTO mbox.channel_price_releases(tenant_id,store_id,quote_id,activation_id,order_id,reason) VALUES($1,$2,$3,$4,$5,'unpaid_unmade_order_cancelled')`,[...scope,row.quote_id,row.activation_id,row.order_id])
   await tx.query(`UPDATE mbox.channel_activations SET applied_discount_minor=applied_discount_minor-$4 WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND applied_discount_minor>=$4`,[...scope,row.activation_id,row.amount_minor])
  }
}
