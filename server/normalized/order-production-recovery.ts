import { appendOutboxMessage } from './command-executor.js'
import { KdsRepository } from './kds-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'

// A missing electronic task may already have a paper counterpart. Once any production
// has reached a person or printer, the duty manager must reconcile the original.
export async function retryUndispatchedProduction(tx: ScopedTransaction, limit: number): Promise<void> {
  const args = [tx.scope.tenantId,tx.scope.storeId]
  const missing = `i.fulfillment_station IN ('bar','kitchen') AND i.status='submitted' AND EXISTS (
    SELECT 1 FROM mbox.outbox_messages source WHERE (source.tenant_id,source.store_id,source.aggregate_id)=(i.tenant_id,i.store_id,i.order_id)
      AND source.message_type='order.submitted.v1' AND (source.payload->'productionItemIds') ? i.id::text) AND NOT EXISTS (
    SELECT 1 FROM mbox.kds_tasks k WHERE (k.tenant_id,k.store_id,k.order_item_id)=(i.tenant_id,i.store_id,i.id))`
  const candidates = await tx.query<{id:string}>(`
    SELECT o.id FROM mbox.table_sessions s JOIN mbox.orders o
      ON (o.tenant_id,o.store_id,o.table_session_id)=(s.tenant_id,s.store_id,s.id)
    WHERE s.tenant_id=$1 AND s.store_id=$2 AND s.status='open'
      AND o.fulfillment_state='active' AND o.status IN ('submitted','confirmed')
      AND o.updated_at<now()-interval '90 seconds'
      AND EXISTS (SELECT 1 FROM mbox.order_items i WHERE (i.tenant_id,i.store_id,i.order_id)=(o.tenant_id,o.store_id,o.id) AND ${missing})
      AND NOT EXISTS (SELECT 1 FROM mbox.order_items i WHERE (i.tenant_id,i.store_id,i.order_id)=(o.tenant_id,o.store_id,o.id)
        AND (i.status<>'submitted' OR EXISTS (SELECT 1 FROM mbox.kds_tasks k
          WHERE (k.tenant_id,k.store_id,k.order_item_id)=(i.tenant_id,i.store_id,i.id) AND k.status<>'pending')
        OR EXISTS (SELECT 1 FROM mbox.order_item_quantity_units u
          WHERE (u.tenant_id,u.store_id,u.order_item_id)=(i.tenant_id,i.store_id,i.id)
            AND (u.production_state<>'unmade' OR u.held_by_case_id IS NOT NULL OR u.operationally_stopped))))
      AND NOT EXISTS (SELECT 1 FROM mbox.print_jobs j WHERE j.tenant_id=o.tenant_id AND j.store_id=o.store_id
        AND j.print_snapshot->>'ticketReference'=o.public_id AND j.print_snapshot->>'kind' IN ('bar_production','kitchen_production'))
      AND NOT EXISTS (SELECT 1 FROM mbox.inventory_order_reservations r WHERE (r.tenant_id,r.store_id,r.order_id)=(o.tenant_id,o.store_id,o.id) AND r.status<>'consumed')
      AND NOT EXISTS (SELECT 1 FROM mbox.fulfillment_capacity_reservations r WHERE (r.tenant_id,r.store_id,r.order_id)=(o.tenant_id,o.store_id,o.id) AND r.status<>'active')
      AND mbox.order_consumption_settled(o.tenant_id,o.store_id,o.id)
    ORDER BY o.updated_at,o.id LIMIT $3 FOR UPDATE OF s,o SKIP LOCKED`,[...args,limit])
  for (const {id} of candidates.rows) {
    const items = await tx.query<{id:string;fulfillment_station:'bar'|'kitchen';quantity:number;fulfillment_priority:number;due_at:string|null}>(`
      SELECT i.id,i.fulfillment_station,i.quantity,i.fulfillment_priority,i.fulfillment_due_at::text AS due_at
      FROM mbox.order_items i WHERE (i.tenant_id,i.store_id,i.order_id)=($1,$2,$3) AND ${missing} ORDER BY i.id`,[...args,id])
    const kds = new KdsRepository(tx)
    for (const i of items.rows) {
      await kds.create({orderItemId:i.id,stationCode:i.fulfillment_station,quantity:i.quantity,priority:i.fulfillment_priority,
        dueAt:i.due_at,eventIdempotencyKey:`production-recovery:${i.id}`})
    }
    if (items.rows.length) await appendOutboxMessage(tx,{
      businessEventKey:`production-recovery:${id}`,aggregateType:'order',aggregateId:id,aggregateVersion:2,
      eventType:'order.fulfillment_activated_after_payment.v1',payload:{orderId:id,kdsTaskCount:items.rows.length,recovery:true},
    })
  }
}
