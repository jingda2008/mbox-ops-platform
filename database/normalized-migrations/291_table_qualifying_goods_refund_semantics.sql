BEGIN;
CREATE OR REPLACE FUNCTION mbox.table_qualifying_goods(t uuid,s uuid,session_id uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
    SELECT COALESCE(sum(COALESCE((i.product_snapshot->>'standardAmountMinor')::bigint,i.unit_price_minor)
      * GREATEST(0,i.quantity-(SELECT count(*) FROM mbox.order_item_quantity_units u
          WHERE u.tenant_id=i.tenant_id AND u.store_id=i.store_id AND u.order_item_id=i.id AND u.operationally_stopped))),0)::bigint AS consumed_minor
    FROM mbox.orders o JOIN mbox.order_items i ON (i.tenant_id,i.store_id,i.order_id)=(o.tenant_id,o.store_id,o.id)
    WHERE o.tenant_id=t AND o.store_id=s AND o.table_session_id=session_id AND o.status<>'cancelled'
      AND (o.settlement_mode='table_tab' OR (o.payment_status IN ('paid','partially_refunded') OR (o.payment_status='refunded' AND EXISTS(SELECT 1 FROM mbox.order_payment_facts paid WHERE (paid.tenant_id,paid.store_id,paid.order_id)=(o.tenant_id,o.store_id,o.id) AND paid.status IN ('succeeded','partially_refunded','refunded')))))
      AND i.status<>'cancelled' AND i.parent_order_item_id IS NULL AND i.pricing_kind NOT IN ('gift','points_redemption')
      AND NOT EXISTS(SELECT 1 FROM mbox.pricing_authorizations p WHERE p.tenant_id=o.tenant_id AND p.store_id=o.store_id
        AND p.order_id=o.id AND p.status='consumed' AND p.kind='gift')
$$;
UPDATE mbox.normalized_schema_metadata SET schema_version='291',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
