import type { ScopedTransaction } from './transaction-runner.js'
import { InventoryRepository } from './inventory-repository.js'

/** Refund money is not a unit count: only fully returned lines (or a fully paid,
 * fully refunded bill) can cancel unstarted fulfilment automatically. */
export class RefundFulfillmentRepository {
  constructor(private readonly tx: ScopedTransaction) {}

  async synchronize(orderId: string, refundId: string) {
    const scope = [this.tx.scope.tenantId, this.tx.scope.storeId]
    const order = (await this.tx.query<{ payment_status: string; fully_refunded: boolean }>(`
      SELECT o.payment_status,
        o.total_amount_minor>0 AND o.payment_status='refunded'
        AND COALESCE((SELECT sum(p.amount_minor) FROM mbox.order_payment_facts p
          WHERE p.tenant_id=o.tenant_id AND p.store_id=o.store_id AND p.order_id=o.id
            AND p.status IN ('succeeded','partially_refunded','refunded')),0)>=o.total_amount_minor AS fully_refunded
      FROM mbox.orders o WHERE o.tenant_id=$1 AND o.store_id=$2 AND o.id=$3
        AND EXISTS(SELECT 1 FROM mbox.refunds r WHERE r.tenant_id=o.tenant_id AND r.store_id=o.store_id
          AND r.id=$4 AND r.status='succeeded' AND COALESCE(r.order_id,
            (SELECT p.order_id FROM mbox.payments p WHERE p.tenant_id=r.tenant_id AND p.store_id=r.store_id AND p.id=r.payment_id))=o.id)
      FOR UPDATE OF o`, [...scope, orderId, refundId])).rows[0]
    if (!order || order.payment_status === 'paid') return { cancelledItemIds: [], restoredInventoryRecords: 0 }
    // Match production's task -> item lock order, then re-read authoritative
    // production evidence. A refund racing a start cannot return used material.
    const tasks = (await this.tx.query<{ id: string; order_item_id: string; status: string; ready_at: string | null }>(`
      SELECT task.id,task.order_item_id,task.status,task.ready_at FROM mbox.kds_tasks task
      JOIN mbox.order_items item ON item.tenant_id=task.tenant_id AND item.store_id=task.store_id AND item.id=task.order_item_id
      WHERE item.tenant_id=$1 AND item.store_id=$2 AND item.order_id=$3 ORDER BY task.id FOR UPDATE OF task`, [...scope, orderId])).rows
    const items = (await this.tx.query<{ id: string; status: string; parent_order_item_id: string | null; fully_refunded: boolean }>(`
      SELECT item.id,item.status,item.parent_order_item_id,
        item.total_amount_minor>0 AND COALESCE((SELECT sum(ri.amount_minor) FROM mbox.refund_items ri
          JOIN mbox.refunds r ON r.tenant_id=ri.tenant_id AND r.store_id=ri.store_id AND r.id=ri.refund_id
          WHERE ri.tenant_id=item.tenant_id AND ri.store_id=item.store_id AND ri.order_item_id=item.id AND r.status='succeeded'),0)>=item.total_amount_minor AS fully_refunded
      FROM mbox.order_items item WHERE item.tenant_id=$1 AND item.store_id=$2 AND item.order_id=$3
      ORDER BY item.id FOR UPDATE`, [...scope, orderId])).rows
    const eligible = new Set(items.filter(item => order.fully_refunded || item.fully_refunded).map(item => item.id))
    for (let pass = 0; pass < items.length; pass++) {
      let added = false
      for (const item of items) if (item.parent_order_item_id && eligible.has(item.parent_order_item_id) && !eligible.has(item.id)) {
        eligible.add(item.id); added = true
      }
      if (!added) break
    }
    const produced = new Set((await this.tx.query<{ order_item_id: string }>(`
      SELECT DISTINCT task.order_item_id FROM mbox.kds_tasks task JOIN mbox.kds_task_events event
        ON event.tenant_id=task.tenant_id AND event.store_id=task.store_id AND event.kds_task_id=task.id
      WHERE task.tenant_id=$1 AND task.store_id=$2 AND task.id=ANY($3::uuid[])
        AND (event.from_status IN ('preparing','ready') OR event.to_status IN ('preparing','ready'))`, [...scope, tasks.map(task => task.id)])).rows.map(row => row.order_item_id))
    const cancelledItemIds: string[] = []
    let restoredInventoryRecords = 0
    for (const item of items) {
      if (!eligible.has(item.id) || ['preparing', 'ready', 'delivered'].includes(item.status) || produced.has(item.id)) continue
      const itemTasks = tasks.filter(task => task.order_item_id === item.id)
      if (itemTasks.some(task => task.ready_at !== null || ['preparing', 'ready'].includes(task.status))) continue
      for (const task of itemTasks) {
        if (task.status === 'cancelled') continue
        await this.tx.query(`UPDATE mbox.kds_tasks SET status='cancelled',cancelled_at=clock_timestamp(),
          worker_locked_by=NULL,worker_locked_at=NULL,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND store_id=$2 AND id=$3`, [...scope, task.id])
        await this.tx.query(`INSERT INTO mbox.kds_task_events(tenant_id,store_id,kds_task_id,event_type,from_status,to_status,metadata,idempotency_key)
          VALUES($1,$2,$3,'task.cancelled',$4,'cancelled',jsonb_build_object('source','confirmed_refund','refundId',$5::text),$6)
          ON CONFLICT(tenant_id,store_id,kds_task_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
        [...scope, task.id, task.status, refundId, `refund-stop:${refundId}:${task.id}`])
      }
      const changed = await this.tx.query(`UPDATE mbox.order_items SET status='cancelled',updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status<>'cancelled'`, [...scope, item.id])
      const restored = await this.restoreReservations(item.id, refundId)
      restoredInventoryRecords += restored
      for (const task of itemTasks) await new InventoryRepository(this.tx).releaseRemakeMaterials(task.id, '退款确认成功，尚未制作的重做任务已取消')
      if (changed.rowCount || restored > 0) {
        cancelledItemIds.push(item.id)
        await this.tx.query(`INSERT INTO mbox.audit_events(tenant_id,store_id,actor_type,actor_ref,action,object_type,object_id,business_date,metadata)
          SELECT $1,$2,'system','confirmed-refund','order_item.refund_fulfillment_cancelled','order_item',$3::text,
            ((clock_timestamp() AT TIME ZONE timezone)-make_interval(secs=>extract(epoch FROM business_day_cutoff)))::date,
            jsonb_build_object('refundId',$4::text,'restoredInventoryRecords',$5::integer,'productionEvidence','not_started')
          FROM mbox.stores WHERE tenant_id=$1 AND id=$2`, [...scope, item.id, refundId, restored])
      }
    }
    if (cancelledItemIds.length > 0) await this.tx.query(`UPDATE mbox.orders o SET
      status=CASE WHEN o.status='completed' THEN o.status ELSE 'cancelled' END,
      cancelled_at=CASE WHEN o.status='completed' THEN o.cancelled_at ELSE COALESCE(o.cancelled_at,clock_timestamp()) END,
      fulfillment_state='cancelled',fulfillment_activated_at=NULL,fulfillment_expires_at=NULL,fulfillment_released_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE o.tenant_id=$1 AND o.store_id=$2 AND o.id=$3
        AND NOT EXISTS(SELECT 1 FROM mbox.order_items item WHERE item.tenant_id=o.tenant_id AND item.store_id=o.store_id
          AND item.order_id=o.id AND item.status<>'cancelled')`, [...scope, orderId])
    return { cancelledItemIds, restoredInventoryRecords }
  }

  private async restoreReservations(itemId: string, refundId: string) {
    const scope = [this.tx.scope.tenantId, this.tx.scope.storeId]
    const rows = (await this.tx.query<{ id: string; inventory_item_id: string; status: string; quantity: string; movement_id: string | null }>(`
      SELECT id,inventory_item_id,status,quantity::text,movement_id FROM mbox.inventory_order_reservations
      WHERE tenant_id=$1 AND store_id=$2 AND order_item_id=$3 ORDER BY inventory_item_id,id FOR UPDATE`, [...scope, itemId])).rows
    if (rows.length === 0) return this.restoreDeferredConsumption(itemId, refundId)
    let count = 0
    for (const row of rows) {
      if (!['reserved', 'consumed'].includes(row.status)) continue
      await this.tx.query(`SELECT inventory_item_id FROM mbox.inventory_balances WHERE tenant_id=$1 AND store_id=$2 AND inventory_item_id=$3 FOR UPDATE`, [...scope, row.inventory_item_id])
      if (row.status === 'reserved') {
        const balance = await this.tx.query(`UPDATE mbox.inventory_balances SET reserved_quantity=reserved_quantity-$4::numeric,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND store_id=$2 AND inventory_item_id=$3 AND reserved_quantity>=$4::numeric`, [...scope, row.inventory_item_id, row.quantity])
        if (balance.rowCount !== 1) throw new Error('Refund reservation release lacks matching inventory balance')
        await this.tx.query(`UPDATE mbox.inventory_order_reservations SET status='released',expires_at=NULL,released_at=clock_timestamp(),
          release_reason='退款确认成功，未开始制作',updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3`, [...scope, row.id])
      } else {
        const previous = (await this.tx.query<{ remaining: string; movement_id: string | null }>(`SELECT
          ($4::numeric-COALESCE(sum(quantity),0))::text AS remaining,(array_agg(movement_id ORDER BY id DESC))[1] AS movement_id
          FROM mbox.order_stock_return_movements WHERE tenant_id=$1 AND store_id=$2 AND reservation_id=$3`, [...scope, row.id, row.quantity])).rows[0]!
        if (Number(previous.remaining) < 0) throw new Error('Prior physical returns exceed reserved inventory')
        let movementId = previous.movement_id
        if (Number(previous.remaining) > 0) {
          movementId = (await this.tx.query<{ id: string }>(`INSERT INTO mbox.inventory_movements(tenant_id,store_id,inventory_item_id,
            movement_type,quantity_delta,reference_type,reference_id,order_item_id,reason,unit_cost_minor,metadata)
            SELECT $1,$2,$3,'return',$4::numeric,'refund_unmade',$5,$6,'退款确认成功，未开始制作',original.unit_cost_minor,
              jsonb_build_object('reservationId',$7::text,'originalMovementId',original.id)
            FROM mbox.inventory_movements original WHERE original.tenant_id=$1 AND original.store_id=$2 AND original.id=$8
            RETURNING id`, [...scope, row.inventory_item_id, previous.remaining, refundId, itemId, row.id, row.movement_id])).rows[0]?.id ?? null
          if (!movementId) throw new Error('Refund inventory return lacks original consumption evidence')
          const balance = await this.tx.query(`UPDATE mbox.inventory_balances SET on_hand_quantity=on_hand_quantity+$4::numeric,
            last_movement_id=$5,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND inventory_item_id=$3`, [...scope, row.inventory_item_id, previous.remaining, movementId])
          if (balance.rowCount !== 1) throw new Error('Refund inventory return lacks inventory balance')
        }
        if (!movementId) throw new Error('Refund inventory return lacks movement evidence')
        await this.tx.query(`UPDATE mbox.inventory_order_reservations SET status='returned',return_movement_id=$4,
          returned_at=clock_timestamp(),release_reason='退款确认成功，未开始制作',updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND store_id=$2 AND id=$3`, [...scope, row.id, movementId])
      }
      count++
    }
    return count
  }
  // Deferred settlement predates reservation-backed consumption. Return only
  // original order-item sale movements, net of all already recorded returns.
  private async restoreDeferredConsumption(itemId: string, refundId: string) {
    const scope = [this.tx.scope.tenantId, this.tx.scope.storeId]
    const movements = (await this.tx.query<{id:string;inventory_item_id:string;remaining:string;unit_cost_minor:string|null}>(`
      SELECT original.id,original.inventory_item_id,original.unit_cost_minor,
        GREATEST(0,LEAST(-original.quantity_delta,
          sum(-original.quantity_delta) OVER(PARTITION BY original.inventory_item_id ORDER BY original.occurred_at,original.id)
          -COALESCE((SELECT sum(returned.quantity_delta) FROM mbox.inventory_movements returned
            WHERE returned.tenant_id=original.tenant_id AND returned.store_id=original.store_id
              AND returned.order_item_id=original.order_item_id AND returned.inventory_item_id=original.inventory_item_id
              AND returned.movement_type='return' AND returned.quantity_delta>0),0)))::text AS remaining
      FROM mbox.inventory_movements original
      WHERE original.tenant_id=$1 AND original.store_id=$2 AND original.order_item_id=$3
        AND original.movement_type='sale' AND original.reference_type='order_item' AND original.quantity_delta<0
      ORDER BY original.inventory_item_id,original.occurred_at,original.id`,[...scope,itemId])).rows
    let count = 0
    for (const movement of movements) {
      if (Number(movement.remaining)<=0) continue
      await this.tx.query(`SELECT inventory_item_id FROM mbox.inventory_balances
        WHERE tenant_id=$1 AND store_id=$2 AND inventory_item_id=$3 FOR UPDATE`,[...scope,movement.inventory_item_id])
      const restored=(await this.tx.query<{id:string}>(`INSERT INTO mbox.inventory_movements(tenant_id,store_id,inventory_item_id,
        movement_type,quantity_delta,reference_type,reference_id,order_item_id,reason,unit_cost_minor,metadata)
        VALUES($1,$2,$3,'return',$4::numeric,'refund_unmade',$5,$6,'退款确认成功，未开始制作',$7,
          jsonb_build_object('originalMovementId',$8::text,'source','deferred_order_sale')) RETURNING id`,
        [...scope,movement.inventory_item_id,movement.remaining,refundId,itemId,movement.unit_cost_minor,movement.id])).rows[0]!
      const balance=await this.tx.query(`UPDATE mbox.inventory_balances SET on_hand_quantity=on_hand_quantity+$4::numeric,
        last_movement_id=$5,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND inventory_item_id=$3`,
        [...scope,movement.inventory_item_id,movement.remaining,restored.id])
      if(balance.rowCount!==1) throw new Error('Deferred refund inventory return lacks matching balance')
      count++
    }
    return count
  }

}
