import type { ScopedTransaction } from './transaction-runner.js'
import { legacyProductDeadlineSql } from './issued-coupon-product-promise.js'

/** Validate only a NEW payment action. Recovery must keep the original snapshot. */
export async function validateProductPaymentWindow(transaction: ScopedTransaction, paymentId: string, defaultExpiresAt: string): Promise<string> {
  const result = await transaction.query<{ product_id:string; deadline:string|null; price_until:string|null; reservation_until:string|null; valid:boolean }>(`
    SELECT item.product_id,
      CASE WHEN promise.benefit_id IS NOT NULL THEN CASE WHEN (${legacyProductDeadlineSql('p')}) IS NULL THEN NULL ELSE LEAST(promise.deadline,${legacyProductDeadlineSql('p')})::text END
        ELSE mbox.product_quote_deadline(p.tenant_id,p.store_id,p.id,o.created_by_customer_id,item.unit_price_minor,
          COALESCE(item.product_snapshot->>'priceType'='member_card',false))::text END AS deadline,
      CASE WHEN promise.benefit_id IS NULL THEN price.valid_until::text ELSE NULL END AS price_until,o.fulfillment_expires_at::text AS reservation_until,
      (p.status='active' AND o.channel=ANY(p.allowed_channels)
        AND (NOT (item.product_snapshot ? 'fulfillmentBenefitId') OR promise.benefit_id IS NOT NULL)
        AND (promise.benefit_id IS NOT NULL OR o.channel<>'guest_qr' OR mbox.product_visible_now(p.tenant_id,p.store_id,p.id,o.created_by_customer_id))
        AND CASE WHEN promise.benefit_id IS NOT NULL THEN true
          WHEN item.product_snapshot->>'priceType'='member_card'
          THEN mbox.customer_card_price(p.tenant_id,p.store_id,p.id,o.created_by_customer_id)=item.unit_price_minor
          ELSE price.amount_minor=item.unit_price_minor END) AS valid
    FROM mbox.payments payment
    JOIN mbox.orders o ON o.tenant_id=payment.tenant_id AND o.store_id=payment.store_id
      AND (o.id=payment.order_id OR EXISTS(SELECT 1 FROM mbox.order_payment_allocations a
        WHERE a.tenant_id=payment.tenant_id AND a.store_id=payment.store_id AND a.batch_id=payment.order_batch_id AND a.order_id=o.id))
    JOIN mbox.order_items item ON item.tenant_id=o.tenant_id AND item.store_id=o.store_id AND item.order_id=o.id AND item.parent_order_item_id IS NULL
    JOIN mbox.products p ON p.tenant_id=item.tenant_id AND p.store_id=item.store_id AND p.id=item.product_id
    JOIN mbox.stores store ON store.tenant_id=p.tenant_id AND store.id=p.store_id
    ${issuedPromiseJoin('item')}
    LEFT JOIN LATERAL (SELECT amount_minor,valid_until FROM mbox.product_prices candidate
      WHERE candidate.tenant_id=p.tenant_id AND candidate.store_id=p.store_id AND candidate.product_id=p.id
        AND candidate.price_type='standard' AND candidate.valid_from<=clock_timestamp()
        AND (candidate.valid_until IS NULL OR candidate.valid_until>clock_timestamp())
      ORDER BY candidate.valid_from DESC,candidate.id DESC LIMIT 1) price ON true
    WHERE payment.tenant_id=$1::uuid AND payment.store_id=$2::uuid AND payment.id=$3::uuid
      AND o.settlement_mode='immediate_payment' AND o.fulfillment_state<>'active'
      -- New rules apply to new purchase quotes, not inherited invoices or debt.
      AND item.product_snapshot->>'purchaseRuleVersion'='3'
      AND NOT EXISTS(SELECT 1 FROM mbox.payments prior
        WHERE prior.tenant_id=o.tenant_id AND prior.store_id=o.store_id AND prior.id<>payment.id
          AND prior.status IN('succeeded','partially_refunded','refunded')
          AND (prior.order_id=o.id OR EXISTS(SELECT 1 FROM mbox.order_payment_allocations allocation
            WHERE allocation.tenant_id=o.tenant_id AND allocation.store_id=o.store_id
              AND allocation.batch_id=prior.order_batch_id AND allocation.order_id=o.id)))
    FOR SHARE OF p
  `,[transaction.scope.tenantId,transaction.scope.storeId,paymentId])
  const choices=await transaction.query<{product_id:string;deadline:string|null;price_until:string|null;reservation_until:string|null;valid:boolean}>(`
    SELECT p.id AS product_id,CASE WHEN promise.benefit_id IS NOT NULL THEN (${legacyProductDeadlineSql('p')})::text ELSE mbox.product_base_service_deadline(p.tenant_id,p.store_id,p.id)::text END AS deadline,
      NULL::text AS price_until,o.fulfillment_expires_at::text AS reservation_until,
      (p.status='active' AND o.channel=ANY(p.allowed_channels)
        AND (NOT (parent.product_snapshot ? 'fulfillmentBenefitId') OR promise.benefit_id IS NOT NULL)
        AND (promise.benefit_id IS NOT NULL OR o.channel<>'guest_qr' OR p.guest_visible)) AS valid
    FROM mbox.payments payment
    JOIN mbox.orders o ON o.tenant_id=payment.tenant_id AND o.store_id=payment.store_id
      AND (o.id=payment.order_id OR EXISTS(SELECT 1 FROM mbox.order_payment_allocations a
        WHERE a.tenant_id=payment.tenant_id AND a.store_id=payment.store_id AND a.batch_id=payment.order_batch_id AND a.order_id=o.id))
    JOIN mbox.order_items item ON item.tenant_id=o.tenant_id AND item.store_id=o.store_id AND item.order_id=o.id
      AND item.parent_order_item_id IS NOT NULL AND item.product_snapshot ? 'bundleChoiceGroupId'
    JOIN mbox.order_items parent ON parent.tenant_id=item.tenant_id AND parent.store_id=item.store_id
      AND parent.order_id=o.id AND parent.id=item.parent_order_item_id
    JOIN mbox.products p ON p.tenant_id=item.tenant_id AND p.store_id=item.store_id AND p.id=item.product_id
    JOIN mbox.stores store ON store.tenant_id=p.tenant_id AND store.id=p.store_id
    ${issuedPromiseJoin('parent')}
    WHERE payment.tenant_id=$1::uuid AND payment.store_id=$2::uuid AND payment.id=$3::uuid
      AND o.settlement_mode='immediate_payment' AND o.fulfillment_state<>'active'
      AND parent.product_snapshot->>'purchaseRuleVersion'='3'
      AND NOT EXISTS(SELECT 1 FROM mbox.payments prior
        WHERE prior.tenant_id=o.tenant_id AND prior.store_id=o.store_id AND prior.id<>payment.id
          AND prior.status IN('succeeded','partially_refunded','refunded')
          AND (prior.order_id=o.id OR EXISTS(SELECT 1 FROM mbox.order_payment_allocations allocation
            WHERE allocation.tenant_id=o.tenant_id AND allocation.store_id=o.store_id
              AND allocation.batch_id=prior.order_batch_id AND allocation.order_id=o.id)))
    FOR SHARE OF p
  `,[transaction.scope.tenantId,transaction.scope.storeId,paymentId])
  const singles=await transaction.query<{product_id:string;deadline:string|null;price_until:string|null;reservation_until:string|null;valid:boolean}>(`
    SELECT p.id AS product_id,mbox.product_quote_deadline(p.tenant_id,p.store_id,p.id,r.customer_id,
      (item->>'unitPriceMinor')::bigint,item->>'priceType'='member_card')::text AS deadline,
      price.valid_until::text AS price_until,r.payment_due_at::text AS reservation_until,
      (p.status='active' AND 'guest_qr'=ANY(p.allowed_channels)
        AND mbox.product_visible_now(p.tenant_id,p.store_id,p.id,r.customer_id)
        AND CASE WHEN item->>'priceType'='member_card'
          THEN mbox.customer_card_price(p.tenant_id,p.store_id,p.id,r.customer_id)=(item->>'unitPriceMinor')::bigint
          ELSE price.amount_minor=(item->>'unitPriceMinor')::bigint END) AS valid
    FROM mbox.payments payment JOIN mbox.community_activity_registrations r
      ON r.tenant_id=payment.tenant_id AND r.store_id=payment.store_id AND r.id=payment.activity_registration_id
    CROSS JOIN LATERAL jsonb_array_elements(r.service_items_snapshot) item
    JOIN mbox.products p ON p.tenant_id=r.tenant_id AND p.store_id=r.store_id AND p.id=(item->>'productId')::uuid
    LEFT JOIN LATERAL (SELECT amount_minor,valid_until FROM mbox.product_prices candidate
      WHERE candidate.tenant_id=p.tenant_id AND candidate.store_id=p.store_id AND candidate.product_id=p.id
        AND candidate.price_type='standard' AND candidate.valid_from<=clock_timestamp()
        AND (candidate.valid_until IS NULL OR candidate.valid_until>clock_timestamp())
      ORDER BY candidate.valid_from DESC,candidate.id DESC LIMIT 1) price ON true
    WHERE payment.tenant_id=$1::uuid AND payment.store_id=$2::uuid AND payment.id=$3::uuid
      AND r.service_version=3 AND r.purchase_kind='single_dish'
    FOR SHARE OF p
  `,[transaction.scope.tenantId,transaction.scope.storeId,paymentId])
  result.rows.push(...choices.rows,...singles.rows)
  const activity=await transaction.query<{deadline:string|null}>(`SELECT r.payment_due_at::text AS deadline
    FROM mbox.payments p JOIN mbox.community_activity_registrations r
      ON r.tenant_id=p.tenant_id AND r.store_id=p.store_id AND r.id=p.activity_registration_id
    WHERE p.tenant_id=$1::uuid AND p.store_id=$2::uuid AND p.id=$3::uuid`,
    [transaction.scope.tenantId,transaction.scope.storeId,paymentId])
  let deadline=Date.parse(defaultExpiresAt)
  const activityDeadline=activity.rows[0]?.deadline
  if(activityDeadline && Number.isFinite(Date.parse(activityDeadline))) deadline=Math.min(deadline,Date.parse(activityDeadline))
  for(const row of result.rows) {
    if(!row.valid || row.deadline===null) throw new Error('商品供应时间、资格或价格已变化，请返回购物车确认后重新下单')
    for(const value of [row.deadline,row.price_until,row.reservation_until]) {
      const candidate=value===null?NaN:Date.parse(value)
      if(Number.isFinite(candidate)) deadline=Math.min(deadline,candidate)
    }
  }
  if(deadline<=Date.now()) throw new Error('本次购买已过截止时间，请刷新菜单重新选择')
  const expiresAt=new Date(deadline).toISOString()
  // The action deadline is durable before any request reaches the provider.
  await transaction.query(`UPDATE mbox.payment_provider_actions SET expires_at=$4::timestamptz
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND payment_id=$3::uuid AND state='creating'`,
    [transaction.scope.tenantId,transaction.scope.storeId,paymentId,expiresAt])
  return expiresAt
}

function issuedPromiseJoin(item: 'item' | 'parent'): string {
  return `    LEFT JOIN LATERAL (
      SELECT b.id AS benefit_id,LEAST(b.valid_until,r.expires_at,q.expires_at) AS deadline
      FROM mbox.pricing_authorizations a
      JOIN mbox.checkout_coupon_quotes q ON q.tenant_id=a.tenant_id AND q.store_id=a.store_id AND q.id=a.checkout_quote_id
      JOIN mbox.checkout_coupon_quote_lines line ON line.tenant_id=q.tenant_id AND line.store_id=q.store_id AND line.quote_id=q.id
      JOIN mbox.checkout_coupon_quote_reservations hold ON hold.tenant_id=line.tenant_id AND hold.store_id=line.store_id AND hold.quote_id=line.quote_id AND hold.benefit_id=line.benefit_id
      JOIN mbox.benefit_reservations r ON r.tenant_id=hold.tenant_id AND r.store_id=hold.store_id AND r.id=hold.reservation_id
      JOIN mbox.benefits b ON b.tenant_id=r.tenant_id AND b.store_id=r.store_id AND b.id=r.benefit_id
      WHERE a.tenant_id=o.tenant_id AND a.store_id=o.store_id AND a.order_id=o.id AND a.status='consumed'
        AND a.source_type='checkout_quote' AND a.id::text=${item}.product_snapshot->>'fulfillmentPricingAuthorizationId'
        AND line.request_index::text=${item}.product_snapshot->>'fulfillmentPromiseIndex'
        AND line.product_id=${item}.product_id AND b.id::text=${item}.product_snapshot->>'fulfillmentBenefitId'
        AND mbox.canonical_customer_id(b.tenant_id,b.store_id,b.customer_id)=mbox.canonical_customer_id(o.tenant_id,o.store_id,o.created_by_customer_id)
        AND r.status='reserved' AND r.expires_at>clock_timestamp()
        AND b.status IN('issued','reserved') AND (b.valid_until IS NULL OR b.valid_until>clock_timestamp())
    ) promise ON true
`
}
