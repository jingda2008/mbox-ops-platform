BEGIN;
CREATE FUNCTION mbox.table_qualifying_goods(t uuid,s uuid,session_id uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
    SELECT COALESCE(sum(COALESCE((i.product_snapshot->>'standardAmountMinor')::bigint,i.unit_price_minor)
      * GREATEST(0,i.quantity-(SELECT count(*) FROM mbox.order_item_quantity_units u
          WHERE u.tenant_id=i.tenant_id AND u.store_id=i.store_id AND u.order_item_id=i.id AND u.operationally_stopped))),0)::bigint AS consumed_minor
    FROM mbox.orders o JOIN mbox.order_items i ON (i.tenant_id,i.store_id,i.order_id)=(o.tenant_id,o.store_id,o.id)
    WHERE o.tenant_id=t AND o.store_id=s AND o.table_session_id=session_id AND o.status<>'cancelled'
      AND (o.settlement_mode='table_tab' OR o.payment_status IN ('paid','partially_refunded'))
      AND i.status<>'cancelled' AND i.parent_order_item_id IS NULL AND i.pricing_kind NOT IN ('gift','points_redemption')
      AND NOT EXISTS(SELECT 1 FROM mbox.pricing_authorizations p WHERE p.tenant_id=o.tenant_id AND p.store_id=o.store_id
        AND p.order_id=o.id AND p.status='consumed' AND p.kind='gift')
$$;
CREATE FUNCTION mbox.table_prepayment_unsettled(t uuid,s uuid,session_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM mbox.table_sessions session WHERE (session.tenant_id,session.store_id,session.id)=(t,s,session_id) AND session.minimum_spend_mode='prepaid' AND (
   mbox.table_qualifying_goods(t,s,session_id)<session.minimum_spend_minor-session.minimum_spend_waiver_minor
   OR EXISTS(SELECT 1 FROM mbox.payments p WHERE (p.tenant_id,p.store_id,p.prepaid_table_session_id)=(t,s,session_id)
     AND (p.status IN ('created','pending') OR mbox.prepayment_available(t,s,p.id)>0
       OR EXISTS(SELECT 1 FROM mbox.refunds r WHERE (r.tenant_id,r.store_id,r.payment_id)=(t,s,p.id) AND r.status NOT IN ('succeeded','cancelled','rejected'))))))
$$;
CREATE FUNCTION mbox.guard_table_minimum_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.minimum_spend_waiver_minor<>COALESCE((SELECT sum(amount_minor) FROM mbox.table_minimum_spend_waivers WHERE (tenant_id,store_id,table_session_id)=(NEW.tenant_id,NEW.store_id,NEW.id)),0) THEN RAISE EXCEPTION 'minimum waiver requires immutable authority record' USING ERRCODE='23514';END IF;
 IF NEW.status='closed' AND OLD.status<>'closed' AND mbox.table_prepayment_unsettled(NEW.tenant_id,NEW.store_id,NEW.id) THEN
 RAISE EXCEPTION 'prepayment settlement requires qualifying goods or recorded waiver, and original refunds must complete; difference charging is disabled' USING ERRCODE='P2851';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_table_minimum_settlement BEFORE UPDATE ON mbox.table_sessions FOR EACH ROW EXECUTE FUNCTION mbox.guard_table_minimum_settlement();
REVOKE ALL ON FUNCTION mbox.table_qualifying_goods(uuid,uuid,uuid),mbox.table_prepayment_unsettled(uuid,uuid,uuid),mbox.guard_table_minimum_settlement() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.table_qualifying_goods(uuid,uuid,uuid),mbox.table_prepayment_unsettled(uuid,uuid,uuid) TO mbox_runtime;
UPDATE mbox.normalized_schema_metadata SET schema_version='286',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
