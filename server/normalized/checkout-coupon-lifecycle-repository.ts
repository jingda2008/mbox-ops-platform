import type {ScopedTransaction} from './transaction-runner.js'
import {appendAuditEvent} from './command-executor.js'

// Use durable production history, not just current task status: cancelling a
// task does not undo ingredients used or goods already made. Alias o is orders.
export const noCouponFulfillmentHistorySql=`NOT EXISTS(
  SELECT 1 FROM mbox.order_items i JOIN mbox.kds_tasks k ON k.tenant_id=i.tenant_id AND k.store_id=i.store_id AND k.order_item_id=i.id
  WHERE i.tenant_id=o.tenant_id AND i.store_id=o.store_id AND i.order_id=o.id
    AND (k.accepted_at IS NOT NULL OR k.ready_at IS NOT NULL OR k.status IN('accepted','preparing','ready')
      OR EXISTS(SELECT 1 FROM mbox.kds_task_events e WHERE e.tenant_id=k.tenant_id AND e.store_id=k.store_id AND e.kds_task_id=k.id AND (e.from_status IN('accepted','preparing','ready') OR e.to_status IN('accepted','preparing','ready')))))`

/** A coupon is held at submission, not redeemed until authoritative paid
 * activation. Payment uncertainty never releases or consumes a coupon. */
export class CheckoutCouponLifecycleRepository{
  constructor(private readonly tx:ScopedTransaction){}
  async releaseCancelledOrderHolds(orderId:string){
    const scope=[this.tx.scope.tenantId,this.tx.scope.storeId]
    const order=(await this.tx.query<{id:string;business_date:string}>(`SELECT o.id,t.business_date::text FROM mbox.orders o JOIN mbox.table_sessions t ON t.tenant_id=o.tenant_id AND t.store_id=o.store_id AND t.id=o.table_session_id WHERE o.tenant_id=$1 AND o.store_id=$2 AND o.id=$3
      AND o.status='cancelled' AND o.fulfillment_state='cancelled'
      AND ${noCouponFulfillmentHistorySql}
      AND NOT EXISTS(SELECT 1 FROM mbox.payments p WHERE p.tenant_id=o.tenant_id AND p.store_id=o.store_id AND p.order_id=o.id AND p.status IN('created','pending'))
      AND (SELECT COALESCE(sum(p.amount_minor),0) FROM mbox.payments p WHERE p.tenant_id=o.tenant_id AND p.store_id=o.store_id AND p.order_id=o.id AND p.status IN('succeeded','partially_refunded','refunded'))
       =(SELECT COALESCE(sum(r.amount_minor),0) FROM mbox.refunds r JOIN mbox.payments p ON p.tenant_id=r.tenant_id AND p.store_id=r.store_id AND p.id=r.payment_id WHERE p.tenant_id=o.tenant_id AND p.store_id=o.store_id AND p.order_id=o.id AND r.status='succeeded')
      FOR UPDATE OF o SKIP LOCKED`,[...scope,orderId])).rows[0]
    if(!order)return{released:0}
    const holds=(await this.tx.query<{id:string;benefit_id:string;quantity:number}>(`SELECT r.id,r.benefit_id,r.quantity FROM mbox.checkout_coupon_order_links l JOIN mbox.checkout_coupon_quote_reservations h ON h.tenant_id=l.tenant_id AND h.store_id=l.store_id AND h.quote_id=l.quote_id JOIN mbox.benefit_reservations r ON r.tenant_id=h.tenant_id AND r.store_id=h.store_id AND r.id=h.reservation_id WHERE l.tenant_id=$1 AND l.store_id=$2 AND l.order_id=$3 AND r.status='reserved' ORDER BY r.benefit_id FOR UPDATE OF r`,[...scope,orderId])).rows
    let released=0
    for(const hold of holds){
      const changed=await this.tx.query(`UPDATE mbox.benefits SET quantity_reserved=quantity_reserved-$4,
        status=CASE WHEN status IN('revoked','expired') THEN status WHEN quantity_redeemed=quantity_total THEN 'redeemed' ELSE 'issued' END,
        aggregate_version=aggregate_version+1 WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND quantity_reserved>=$4`,[...scope,hold.benefit_id,hold.quantity])
      if(changed.rowCount!==1)throw new Error('Cancelled checkout coupon hold quantity mismatch')
      await this.tx.query("UPDATE mbox.benefit_reservations SET status='cancelled',completed_at=clock_timestamp(),cancel_reason='订单已取消且无未确认或未退收款，释放未核销占用' WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status='reserved'",[...scope,hold.id])
      await appendAuditEvent(this.tx,{actor:{type:'system',ref:'checkout-coupon-recovery'},businessDate:order.business_date,action:'checkout_coupon.hold_released',objectType:'benefit_reservation',objectId:hold.id,reason:'订单取消且净收款为零；保留原券有效期，不自动延长',metadata:{orderId,benefitId:hold.benefit_id,quantity:hold.quantity}})
      released+=hold.quantity
    }
    return{released}
  }
  async redeemPaidOrder(orderId:string){
    const scope=[this.tx.scope.tenantId,this.tx.scope.storeId]
    const link=(await this.tx.query<{quote_id:string}>('SELECT quote_id FROM mbox.checkout_coupon_order_links WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3',[...scope,orderId])).rows[0]
    if(!link)return{redeemed:0}
    const paid=(await this.tx.query<{id:string;public_id:string}>(`SELECT o.id,o.public_id FROM mbox.orders o WHERE o.tenant_id=$1 AND o.store_id=$2 AND o.id=$3 AND o.payment_status='paid' AND o.fulfillment_state<>'cancelled'
      AND o.total_amount_minor<=(SELECT COALESCE(sum(p.amount_minor),0) FROM mbox.payments p WHERE p.tenant_id=o.tenant_id AND p.store_id=o.store_id AND p.order_id=o.id AND p.status IN('succeeded','partially_refunded','refunded')) FOR UPDATE`,[...scope,orderId])).rows[0]
    if(!paid)throw new Error('Coupon redemption requires confirmed paid order and non-cancelled fulfillment')
    const holds=(await this.tx.query<{id:string;benefit_id:string;customer_id:string;table_session_id:string;quantity:number;status:string}>(`SELECT r.id,r.benefit_id,r.customer_id,r.table_session_id,r.quantity,r.status FROM mbox.checkout_coupon_quote_reservations h JOIN mbox.benefit_reservations r ON r.tenant_id=h.tenant_id AND r.store_id=h.store_id AND r.id=h.reservation_id WHERE h.tenant_id=$1 AND h.store_id=$2 AND h.quote_id=$3 ORDER BY r.benefit_id FOR UPDATE OF r`,[...scope,link.quote_id])).rows
    let redeemed=0
    for(const hold of holds){
      if(hold.status==='redeemed'){
        const existing=await this.tx.query('SELECT 1 FROM mbox.benefit_redemptions WHERE tenant_id=$1 AND store_id=$2 AND benefit_reservation_id=$3 AND gift_order_reference=$4',[...scope,hold.id,paid.public_id])
        if(existing.rowCount!==1)throw new Error('Coupon redemption belongs to a different fulfillment')
        continue
      }
      if(hold.status!=='reserved')throw new Error('Paid order coupon hold was unexpectedly released')
      await this.tx.query(`INSERT INTO mbox.benefit_redemptions(tenant_id,store_id,benefit_id,benefit_reservation_id,customer_id,table_session_id,quantity,redemption_idempotency_key,redemption_fingerprint,gift_order_reference,authorization_source)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,jsonb_build_object('kind','checkout_quote','quoteId',$11::text,'orderId',$12::text))`,[...scope,hold.benefit_id,hold.id,hold.customer_id,hold.table_session_id,hold.quantity,`paid-coupon:${hold.id}`,link.quote_id,paid.public_id,link.quote_id,orderId])
      await this.tx.query("UPDATE mbox.benefit_reservations SET status='redeemed',completed_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status='reserved'",[...scope,hold.id])
      const changed=await this.tx.query(`UPDATE mbox.benefits SET quantity_reserved=quantity_reserved-$4,quantity_redeemed=quantity_redeemed+$4,
        status=CASE WHEN quantity_redeemed+$4=quantity_total THEN 'redeemed' ELSE 'issued' END,
        redeemed_at=CASE WHEN quantity_redeemed+$4=quantity_total THEN clock_timestamp() ELSE redeemed_at END,aggregate_version=aggregate_version+1
        WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND quantity_reserved>=$4`,[...scope,hold.benefit_id,hold.quantity])
      if(changed.rowCount!==1)throw new Error('Coupon hold quantity changed during paid activation')
      redeemed+=hold.quantity
    }
    return{redeemed}
  }
}
