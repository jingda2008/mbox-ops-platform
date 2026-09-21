import type { ScopedTransaction } from './transaction-runner.js'
import type { JsonValue } from './command-executor.js'

export interface RecommendationFinancialAttributionResult {
  recorded: number
}

export interface RecollectionRecoveryPreview {
  orderId: string
  currency: string | null
  recoveryPaymentId: string | null
  eligible: boolean
  blockReasons: string[]
  items: Array<{refundId:string;orderItemId:string;amountMinor:number;currency:string;restored:boolean;recoverable:boolean}>
  recommendationCurrentMinor: number
  recommendationDeltaMinor: number
  recommendationExpectedMinor: number
  basis: JsonValue[]
}

export class RecommendationFinancialAttributionRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  /** A read-only, server-calculated basis for independent recovery review.
   * The caller owns scope/permissions and hashes this with other reward facts. */
  async previewRecollectedForOrder(input: Readonly<{orderId:string}>): Promise<RecollectionRecoveryPreview> {
    const args=[this.transaction.scope.tenantId,this.transaction.scope.storeId,input.orderId]
    const order=(await this.transaction.query<{currency:string;settled:boolean;basis:JsonValue}>(`
      SELECT currency,mbox.order_consumption_settled(tenant_id,store_id,id) settled,
        jsonb_build_object('kind','order','id',id,'tableSessionId',table_session_id,'status',status,
          'paymentStatus',payment_status,'amountMinor',total_amount_minor::text,'currency',currency,
          'dueMinor',mbox.order_collection_due_amount(tenant_id,store_id,id)::text) basis
      FROM mbox.orders WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,args)).rows[0]
    if(!order)return {orderId:input.orderId,currency:null,recoveryPaymentId:null,eligible:false,
      blockReasons:['order_not_found'],items:[],recommendationCurrentMinor:0,recommendationDeltaMinor:0,recommendationExpectedMinor:0,basis:[]}
    const items=(await this.transaction.query<{refund_id:string;order_item_id:string;amount_minor:string;currency:string;restored:boolean;basis:JsonValue}>(`
      SELECT item.refund_id,item.order_item_id,item.amount_minor::text,item.currency,
        restored.refund_id IS NOT NULL restored,
        jsonb_build_object('kind','refund_item','refundId',item.refund_id,'orderItemId',item.order_item_id,
          'amountMinor',item.amount_minor::text,'currency',item.currency,'refundCompletedAt',refund.completed_at,
          'authorizationId',approval.id,'authorizedAt',approval.created_at,
          'restoration',to_jsonb(restored)) basis
      FROM mbox.order_recollection_refund_obligations obligation
      JOIN mbox.refunds refund ON (refund.tenant_id,refund.store_id,refund.id)
        =(obligation.tenant_id,obligation.store_id,obligation.refund_id)
      JOIN mbox.refund_items item ON (item.tenant_id,item.store_id,item.refund_id)
        =(refund.tenant_id,refund.store_id,refund.id)
      JOIN mbox.order_items original_item ON (original_item.tenant_id,original_item.store_id,original_item.id,original_item.order_id)
        =(item.tenant_id,item.store_id,item.order_item_id,obligation.order_id)
      JOIN mbox.order_recollection_authorizations approval ON (approval.tenant_id,approval.store_id,approval.id)
        =(obligation.tenant_id,obligation.store_id,obligation.authorization_id)
      LEFT JOIN mbox.order_recollection_item_restorations restored
        ON (restored.tenant_id,restored.store_id,restored.order_id,restored.refund_id,restored.order_item_id)
          =(obligation.tenant_id,obligation.store_id,obligation.order_id,item.refund_id,item.order_item_id)
      WHERE obligation.tenant_id=$1 AND obligation.store_id=$2 AND obligation.order_id=$3
        AND refund.status='succeeded' AND refund.purpose IS DISTINCT FROM 'service_compensation'
        AND NOT EXISTS(SELECT 1 FROM mbox.item_after_sales_case_refunds quantity_refund
          WHERE (quantity_refund.tenant_id,quantity_refund.store_id,quantity_refund.refund_id)
            =(refund.tenant_id,refund.store_id,refund.id))
      ORDER BY item.refund_id,item.order_item_id`,args)).rows
    const receipts=(await this.transaction.query<{id:string;basis:JsonValue}>(`
      SELECT receipt.id,jsonb_build_object('kind','receipt','id',receipt.id,'status',receipt.status,
        'amountMinor',receipt.amount_minor::text,'currency',receipt.currency,'succeededAt',receipt.succeeded_at,
        'ledgers',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',ledger.id,'amountMinor',ledger.amount_minor::text,
          'currency',ledger.currency,'provider',ledger.provider,'occurredAt',ledger.occurred_at) ORDER BY ledger.id)
          FROM mbox.reconciliation_entries ledger WHERE (ledger.tenant_id,ledger.store_id,ledger.payment_id)
            =(receipt.tenant_id,receipt.store_id,receipt.id) AND ledger.entry_type='payment'),'[]'::jsonb)) basis
      FROM mbox.order_payment_facts receipt WHERE receipt.tenant_id=$1 AND receipt.store_id=$2 AND receipt.order_id=$3
      ORDER BY receipt.succeeded_at DESC NULLS LAST,receipt.id`,args)).rows
    const observations=(await this.transaction.query<{basis:JsonValue}>(`
      SELECT jsonb_build_object('kind','provider_observation','id',observation.id,
        'subjectKind',observation.subject_kind,'paymentId',observation.payment_id,'refundId',observation.refund_id,
        'status',observation.observed_status,'amountMinor',observation.reported_amount_minor::text,
        'currency',observation.reported_currency,'evidenceSha256',observation.evidence_sha256,
        'occurredAt',observation.occurred_at,'consumedAt',observation.consumed_at) basis
      FROM mbox.verified_provider_observations observation
      WHERE observation.tenant_id=$1 AND observation.store_id=$2 AND (
        EXISTS(SELECT 1 FROM mbox.order_payment_facts receipt
          WHERE (receipt.tenant_id,receipt.store_id,receipt.order_id,receipt.id)
            =(observation.tenant_id,observation.store_id,$3::uuid,observation.payment_id))
        OR EXISTS(SELECT 1 FROM mbox.order_refund_facts refund
          WHERE (refund.tenant_id,refund.store_id,refund.order_id,refund.id)
            =(observation.tenant_id,observation.store_id,$3::uuid,observation.refund_id)))
      ORDER BY observation.id`,args)).rows
    const unrestored=items.filter(item=>!item.restored)
    let recoveryPaymentId:string|null=null
    if(order.settled&&items.length){
      for(const receipt of receipts){
        const valid=(await this.transaction.query<{valid:boolean}>(`
          SELECT COALESCE(bool_and(mbox.order_recollection_item_restoration_valid($1,$2,$3,target.refund_id,target.item_id,$4)),false) valid
          FROM unnest($5::uuid[],$6::uuid[]) target(refund_id,item_id)`,
        [...args,receipt.id,(unrestored.length?unrestored:items).map(item=>item.refund_id),(unrestored.length?unrestored:items).map(item=>item.order_item_id)])).rows[0]?.valid
        if(valid){recoveryPaymentId=receipt.id;break}
      }
    }
    // Previously appended facts retain their settlement receipt after later
    // refunds; their existence does not depend on today's settled predicate.
    if(!unrestored.length&&items.length&&!recoveryPaymentId){
      recoveryPaymentId=(await this.transaction.query<{recollection_payment_id:string}>(`
        SELECT recollection_payment_id FROM mbox.order_recollection_item_restorations
        WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 ORDER BY settled_at DESC,refund_id,order_item_id LIMIT 1`,args)).rows[0]?.recollection_payment_id??null
    }
    const events=(await this.transaction.query<{event_type:string;recommendation_session_id:string;recommendation_option_id:string;order_item_id:string;refund_id:string|null;amount_minor:string;currency:string;restored_amount:string|null;basis:JsonValue}>(`
      SELECT event.event_type,event.recommendation_session_id,event.recommendation_option_id,event.order_item_id,event.refund_id,
        event.attributed_amount_minor::text amount_minor,event.attributed_currency currency,
        restored.amount_minor::text restored_amount,
        jsonb_build_object('kind','recommendation_event','id',event.id,'type',event.event_type,
          'sessionId',event.recommendation_session_id,'optionId',event.recommendation_option_id,
          'itemId',event.order_item_id,'refundId',event.refund_id,'amountMinor',event.attributed_amount_minor::text,
          'currency',event.attributed_currency) basis
      FROM mbox.recommendation_behavior_events event LEFT JOIN mbox.order_recollection_item_restorations restored
        ON (restored.tenant_id,restored.store_id,restored.order_id,restored.refund_id,restored.order_item_id,restored.currency,restored.amount_minor)
          =(event.tenant_id,event.store_id,event.order_id,event.refund_id,event.order_item_id,event.attributed_currency,event.attributed_amount_minor)
      WHERE event.tenant_id=$1 AND event.store_id=$2 AND event.order_id=$3 AND event.event_type IN ('paid','refunded')
      ORDER BY event.id`,args)).rows
    const key=(event:typeof events[number])=>[event.recommendation_session_id,event.recommendation_option_id,event.order_item_id,event.currency].join(':')
    const paidKeys=new Set(events.filter(event=>event.event_type==='paid').map(key))
    let current=0,delta=0
    for(const event of events){
      const amount=attributionMinor(event.amount_minor)
      if(event.event_type==='paid')current+=amount
      else{
        current-=amount
        if(paidKeys.has(key(event))){
          if(event.restored_amount!==null)current+=attributionMinor(event.restored_amount)
          else if(recoveryPaymentId&&unrestored.some(item=>item.refund_id===event.refund_id&&item.order_item_id===event.order_item_id&&item.currency===event.currency&&item.amount_minor===event.amount_minor))delta+=amount
        }
      }
    }
    const eligible=items.length>0&&recoveryPaymentId!==null
    return {orderId:input.orderId,currency:order.currency,recoveryPaymentId,eligible,
      blockReasons:eligible?[]:items.length===0?['no_authorized_ordinary_refund']:!order.settled?['collection_not_settled']:['settlement_receipt_not_proven'],
      items:items.map(item=>({refundId:item.refund_id,orderItemId:item.order_item_id,amountMinor:attributionMinor(item.amount_minor),currency:item.currency,
        restored:item.restored,recoverable:item.restored||eligible})),
      recommendationCurrentMinor:current,recommendationDeltaMinor:delta,recommendationExpectedMinor:current+delta,
      basis:[order.basis,...items.map(item=>item.basis),...receipts.map(receipt=>receipt.basis),...events.map(event=>event.basis),...observations.map(observation=>observation.basis)]}
  }

  async recordPaidForOrder(input: Readonly<{
    paymentId: string
    orderId: string
    actorRef: string
  }>): Promise<RecommendationFinancialAttributionResult> {
    await this.lockOrder(input.orderId)
    const result = await this.transaction.query<{ id: string }>(`
      INSERT INTO mbox.recommendation_behavior_events (
        tenant_id, store_id, recommendation_session_id, recommendation_option_id,
        customer_id, table_session_id, order_id, order_item_id, payment_id,
        attributed_amount_minor, attributed_currency,
        event_type, actor_type, actor_ref, reason_code, evidence_snapshot
      )
      SELECT ordered_event.tenant_id, ordered_event.store_id,
        ordered_event.recommendation_session_id, ordered_event.recommendation_option_id,
        ordered_event.customer_id, ordered_event.table_session_id,
        ordered_event.order_id, ordered_event.order_item_id, payment.id,
        basis.amount_minor, item.currency,
        'paid', 'system', $5, NULL,
        jsonb_build_object('source', 'authoritative_order_payment')
      FROM mbox.recommendation_behavior_events AS ordered_event
      JOIN mbox.orders AS order_row
        ON order_row.tenant_id=ordered_event.tenant_id
       AND order_row.store_id=ordered_event.store_id
       AND order_row.id=ordered_event.order_id
       AND mbox.order_consumption_settled(order_row.tenant_id,order_row.store_id,order_row.id)
      JOIN mbox.order_items AS item
        ON item.tenant_id=ordered_event.tenant_id
       AND item.store_id=ordered_event.store_id
       AND item.order_id=ordered_event.order_id
       AND item.id=ordered_event.order_item_id
       AND item.parent_order_item_id IS NULL
       AND item.quantity > 0 AND item.total_amount_minor > 0
       AND (item.status <> 'cancelled' OR EXISTS(
         SELECT 1 FROM mbox.refund_items allocation
         JOIN mbox.refunds returned ON (returned.tenant_id,returned.store_id,returned.id)=(allocation.tenant_id,allocation.store_id,allocation.refund_id)
         JOIN mbox.item_after_sales_case_refunds quantity_return
           ON (quantity_return.tenant_id,quantity_return.store_id,quantity_return.refund_id)=(returned.tenant_id,returned.store_id,returned.id)
         WHERE (allocation.tenant_id,allocation.store_id,allocation.order_item_id)=(item.tenant_id,item.store_id,item.id)
           AND returned.status='succeeded' AND allocation.amount_minor>0
       ))
      JOIN mbox.loyalty_order_item_basis basis
        ON (basis.tenant_id,basis.store_id,basis.order_id,basis.order_item_id)=(item.tenant_id,item.store_id,item.order_id,item.id)
       AND basis.amount_minor>0
      JOIN mbox.payments AS payment
        ON payment.tenant_id=ordered_event.tenant_id
       AND payment.store_id=ordered_event.store_id
       AND (payment.order_id=ordered_event.order_id OR EXISTS(SELECT 1 FROM mbox.order_payment_allocations batch_allocation WHERE batch_allocation.tenant_id=payment.tenant_id AND batch_allocation.store_id=payment.store_id AND batch_allocation.batch_id=payment.order_batch_id AND batch_allocation.order_id=ordered_event.order_id))
       AND payment.id=$3::uuid AND payment.status='succeeded'
       AND payment.currency=item.currency
      WHERE ordered_event.tenant_id=$1::uuid AND ordered_event.store_id=$2::uuid
        AND ordered_event.order_id=$4::uuid AND ordered_event.event_type='ordered'
        AND ordered_event.recommendation_option_id IS NOT NULL
        AND ordered_event.order_item_id IS NOT NULL
      ON CONFLICT DO NOTHING
      RETURNING id
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.paymentId,
      input.orderId,
      input.actorRef,
    ])
    const restored = await this.restoreRecollectedForOrder(input)
    return { recorded: (result.rowCount ?? result.rows.length) + restored.recorded }
  }

  /** Also supports bounded repair of previously settled orders. This never
   * rewrites their original sale/refund events or creates another sale count. */
  async restoreRecollectedForOrder(input: Readonly<{
    paymentId: string
    orderId: string
    actorRef: string
  }>): Promise<RecommendationFinancialAttributionResult> {
    await this.lockOrder(input.orderId)
    const result = await this.transaction.query<{ refund_id: string }>(`
      INSERT INTO mbox.order_recollection_item_restorations (
        tenant_id,store_id,order_id,refund_id,order_item_id,recollection_payment_id,
        reconciliation_entry_id,amount_minor,currency,settled_at,ledger_occurred_at,actor_ref
      )
      SELECT obligation.tenant_id,obligation.store_id,obligation.order_id,obligation.refund_id,
        item.order_item_id,payment.id,ledger.id,item.amount_minor,item.currency,
        payment.succeeded_at,ledger.occurred_at,$5
      FROM mbox.order_recollection_refund_obligations obligation
      JOIN mbox.refund_items item ON (item.tenant_id,item.store_id,item.refund_id)
        =(obligation.tenant_id,obligation.store_id,obligation.refund_id)
      JOIN mbox.payments payment ON (payment.tenant_id,payment.store_id,payment.id)
        =(obligation.tenant_id,obligation.store_id,$3::uuid)
      JOIN mbox.reconciliation_entries ledger ON (ledger.tenant_id,ledger.store_id,ledger.payment_id)
        =(payment.tenant_id,payment.store_id,payment.id)
        AND ledger.entry_type='payment' AND ledger.amount_minor=payment.amount_minor
        AND ledger.currency=payment.currency AND ledger.provider=payment.provider
      WHERE obligation.tenant_id=$1::uuid AND obligation.store_id=$2::uuid AND obligation.order_id=$4::uuid
        AND NOT EXISTS (SELECT 1 FROM mbox.order_recollection_item_restorations existing
          WHERE (existing.tenant_id,existing.store_id,existing.order_id,existing.refund_id,existing.order_item_id)
            =(obligation.tenant_id,obligation.store_id,obligation.order_id,obligation.refund_id,item.order_item_id))
        AND mbox.order_recollection_item_restoration_valid($1::uuid,$2::uuid,$4::uuid,obligation.refund_id,item.order_item_id,$3::uuid)
      ON CONFLICT (tenant_id,store_id,order_id,refund_id,order_item_id) DO NOTHING
      RETURNING refund_id
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,
      input.paymentId,input.orderId,input.actorRef])
    return { recorded: result.rowCount ?? result.rows.length }
  }

  private async lockOrder(orderId: string): Promise<void> {
    await this.transaction.query(`SELECT id FROM mbox.orders
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid FOR UPDATE`,
    [this.transaction.scope.tenantId,this.transaction.scope.storeId,orderId])
  }

  async recordRefundedForOrder(input: Readonly<{
    refundId: string
    paymentId: string
    orderId: string
    actorRef: string
  }>): Promise<RecommendationFinancialAttributionResult> {
    const result = await this.transaction.query<{ id: string }>(`
      INSERT INTO mbox.recommendation_behavior_events (
        tenant_id, store_id, recommendation_session_id, recommendation_option_id,
        customer_id, table_session_id, order_id, order_item_id, payment_id, refund_id,
        attributed_amount_minor, attributed_currency,
        event_type, actor_type, actor_ref, reason_code, evidence_snapshot
      )
      SELECT ordered_event.tenant_id, ordered_event.store_id,
        ordered_event.recommendation_session_id, ordered_event.recommendation_option_id,
        ordered_event.customer_id, ordered_event.table_session_id,
        ordered_event.order_id, ordered_event.order_item_id,
        refund.payment_id, refund.id,
        refund_item.amount_minor, refund_item.currency,
        'refunded', 'system', $6, NULL,
        jsonb_build_object('source', 'authoritative_item_refund')
      FROM mbox.recommendation_behavior_events AS ordered_event
      JOIN mbox.refunds AS refund
        ON refund.tenant_id=ordered_event.tenant_id
       AND refund.store_id=ordered_event.store_id
       AND refund.id=$3::uuid AND refund.payment_id=$4::uuid
       AND refund.status='succeeded'
      JOIN mbox.payments AS payment
       ON payment.tenant_id=refund.tenant_id AND payment.store_id=refund.store_id
       AND payment.id=refund.payment_id AND (payment.order_id=ordered_event.order_id OR EXISTS(SELECT 1 FROM mbox.order_payment_allocations batch_allocation WHERE batch_allocation.tenant_id=payment.tenant_id AND batch_allocation.store_id=payment.store_id AND batch_allocation.batch_id=payment.order_batch_id AND batch_allocation.order_id=ordered_event.order_id))
       AND payment.currency=refund.currency
      JOIN mbox.refund_items AS refund_item
        ON refund_item.tenant_id=refund.tenant_id AND refund_item.store_id=refund.store_id
       AND refund_item.refund_id=refund.id
       AND refund_item.order_item_id=ordered_event.order_item_id
       AND refund_item.amount_minor > 0 AND refund_item.currency=refund.currency
      JOIN mbox.order_items AS item
        ON item.tenant_id=ordered_event.tenant_id
       AND item.store_id=ordered_event.store_id
       AND item.order_id=ordered_event.order_id
       AND item.id=ordered_event.order_item_id AND item.currency=refund_item.currency
      WHERE ordered_event.tenant_id=$1::uuid AND ordered_event.store_id=$2::uuid
        AND ordered_event.order_id=$5::uuid AND ordered_event.event_type='ordered'
        AND (EXISTS(SELECT 1 FROM mbox.orders ordering
          WHERE (ordering.tenant_id,ordering.store_id,ordering.id)=(ordered_event.tenant_id,ordered_event.store_id,ordered_event.order_id)
            AND ordering.payment_status<>'paid')
          OR EXISTS(SELECT 1 FROM mbox.item_after_sales_case_refunds quantity_refund
            WHERE (quantity_refund.tenant_id,quantity_refund.store_id,quantity_refund.refund_id)=(refund.tenant_id,refund.store_id,refund.id)))
        AND ordered_event.recommendation_option_id IS NOT NULL
        AND ordered_event.order_item_id IS NOT NULL
      ON CONFLICT DO NOTHING
      RETURNING id
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.refundId,
      input.paymentId,
      input.orderId,
      input.actorRef,
    ])
    return { recorded: result.rowCount ?? result.rows.length }
  }
}

function attributionMinor(value:string):number {
  const amount=Number(value)
  if(!Number.isSafeInteger(amount)||amount<0)throw new RangeError('Invalid recommendation attribution amount')
  return amount
}
