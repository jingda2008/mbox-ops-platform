import type { ScopedTransaction } from './transaction-runner.js'

export interface RecommendationFinancialAttributionResult {
  recorded: number
}

export class RecommendationFinancialAttributionRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async recordPaidForOrder(input: Readonly<{
    paymentId: string
    orderId: string
    actorRef: string
  }>): Promise<RecommendationFinancialAttributionResult> {
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
        item.total_amount_minor, item.currency,
        'paid', 'system', $5, NULL,
        jsonb_build_object('source', 'authoritative_order_payment')
      FROM mbox.recommendation_behavior_events AS ordered_event
      JOIN mbox.orders AS order_row
        ON order_row.tenant_id=ordered_event.tenant_id
       AND order_row.store_id=ordered_event.store_id
       AND order_row.id=ordered_event.order_id
       AND order_row.payment_status='paid'
      JOIN mbox.order_items AS item
        ON item.tenant_id=ordered_event.tenant_id
       AND item.store_id=ordered_event.store_id
       AND item.order_id=ordered_event.order_id
       AND item.id=ordered_event.order_item_id
       AND item.parent_order_item_id IS NULL
       AND item.quantity > 0 AND item.total_amount_minor > 0
       AND item.status <> 'cancelled'
      JOIN mbox.payments AS payment
        ON payment.tenant_id=ordered_event.tenant_id
       AND payment.store_id=ordered_event.store_id
       AND payment.order_id=ordered_event.order_id
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
    return { recorded: result.rowCount ?? result.rows.length }
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
       AND payment.id=refund.payment_id AND payment.order_id=ordered_event.order_id
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
