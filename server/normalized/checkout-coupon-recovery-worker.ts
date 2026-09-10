import type {ScopedPostgresTransactionRunner,StoreScope} from './transaction-runner.js'
import {CheckoutCouponLifecycleRepository,noCouponFulfillmentHistorySql} from './checkout-coupon-lifecycle-repository.js'
export interface CheckoutCouponRecoveryBatch{workerId:string;examined:number;released:number;failed:number}
/** Local financial facts only: no provider calls and no business-screen locks.
 * Unknown attempts are excluded, not treated as failed or repeatedly audited. */
export class CheckoutCouponRecoveryWorker{
  constructor(private readonly transactions:Pick<ScopedPostgresTransactionRunner,'run'>){}
  async runBatch(scope:Readonly<StoreScope>,workerId:string,batchSize=50):Promise<CheckoutCouponRecoveryBatch>{
    if(!Number.isInteger(batchSize)||batchSize<1||batchSize>100)throw new TypeError('Invalid coupon recovery batch')
    const result:CheckoutCouponRecoveryBatch={workerId,examined:0,released:0,failed:0}
    const rows=await this.transactions.run(scope,async tx=>(await tx.query<{order_id:string}>(`SELECT l.order_id FROM mbox.checkout_coupon_order_links l JOIN mbox.orders o ON o.tenant_id=l.tenant_id AND o.store_id=l.store_id AND o.id=l.order_id
      WHERE l.tenant_id=$1 AND l.store_id=$2 AND o.status='cancelled' AND o.fulfillment_state='cancelled'
       AND ${noCouponFulfillmentHistorySql}
       AND EXISTS(SELECT 1 FROM mbox.checkout_coupon_quote_reservations h JOIN mbox.benefit_reservations r ON r.tenant_id=h.tenant_id AND r.store_id=h.store_id AND r.id=h.reservation_id WHERE h.tenant_id=l.tenant_id AND h.store_id=l.store_id AND h.quote_id=l.quote_id AND r.status='reserved')
       AND NOT EXISTS(SELECT 1 FROM mbox.payments p WHERE p.tenant_id=o.tenant_id AND p.store_id=o.store_id AND p.order_id=o.id AND p.status IN('created','pending'))
       AND (SELECT COALESCE(sum(p.amount_minor),0) FROM mbox.payments p WHERE p.tenant_id=o.tenant_id AND p.store_id=o.store_id AND p.order_id=o.id AND p.status IN('succeeded','partially_refunded','refunded'))
        =(SELECT COALESCE(sum(r.amount_minor),0) FROM mbox.refunds r JOIN mbox.payments p ON p.tenant_id=r.tenant_id AND p.store_id=r.store_id AND p.id=r.payment_id WHERE p.tenant_id=o.tenant_id AND p.store_id=o.store_id AND p.order_id=o.id AND r.status='succeeded')
      ORDER BY l.created_at,l.order_id LIMIT $3`,[scope.tenantId,scope.storeId,batchSize])).rows,{readOnly:true})
    for(const row of rows){
      result.examined++
      try{result.released+=(await this.transactions.run(scope,tx=>new CheckoutCouponLifecycleRepository(tx).releaseCancelledOrderHolds(row.order_id))).released}
      catch{result.failed++}
    }
    return result
  }
}
