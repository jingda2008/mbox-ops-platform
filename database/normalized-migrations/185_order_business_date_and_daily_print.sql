BEGIN;
ALTER TABLE mbox.orders ADD COLUMN business_date date;
UPDATE mbox.orders o SET business_date=s.business_date FROM mbox.table_sessions s
 WHERE s.tenant_id=o.tenant_id AND s.store_id=o.store_id AND s.id=o.table_session_id;
ALTER TABLE mbox.orders ALTER COLUMN business_date SET NOT NULL;
CREATE INDEX orders_business_date_idx ON mbox.orders(tenant_id,store_id,business_date,created_at DESC,id);
CREATE FUNCTION mbox.assign_order_business_date() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE session_date date;
BEGIN
 IF TG_OP='UPDATE' THEN
   IF NEW.business_date IS DISTINCT FROM OLD.business_date THEN RAISE EXCEPTION 'order business date is immutable'; END IF;
   RETURN NEW;
 END IF;
 -- Same lock as the manual boundary writer: an order belongs wholly before
 -- or after that boundary, irrespective of a previously resolved HTTP clock.
 PERFORM 1 FROM mbox.stores WHERE tenant_id=NEW.tenant_id AND id=NEW.store_id FOR SHARE;
 SELECT business_date INTO STRICT session_date FROM mbox.table_sessions
  WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.table_session_id;
 IF EXISTS(SELECT 1 FROM mbox.manual_business_day_ends WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id) THEN
   SELECT GREATEST(((statement_timestamp() AT TIME ZONE timezone)-business_day_cutoff)::date,
     (SELECT max(next_business_date) FROM mbox.manual_business_day_ends WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id))
   INTO NEW.business_date FROM mbox.stores WHERE tenant_id=NEW.tenant_id AND id=NEW.store_id;
 ELSE NEW.business_date:=session_date;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER order_business_date_guard BEFORE INSERT OR UPDATE OF business_date ON mbox.orders
 FOR EACH ROW EXECUTE FUNCTION mbox.assign_order_business_date();
REVOKE ALL ON FUNCTION mbox.assign_order_business_date() FROM PUBLIC;

ALTER TABLE mbox.manual_business_day_ends ADD COLUMN operating_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE FUNCTION mbox.operating_day_summary(p_tenant uuid,p_store uuid,p_date date)
RETURNS jsonb LANGUAGE sql STABLE AS $$
 WITH day_orders AS (
   SELECT o.* FROM mbox.orders o WHERE o.tenant_id=p_tenant AND o.store_id=p_store AND o.business_date=p_date
     AND o.status NOT IN ('draft','cancelled')
 ), amounts AS (
   SELECT o.id,o.total_amount_minor,
     CASE WHEN o.payment_status IN ('paid','partially_refunded','refunded') THEN 0 ELSE
       GREATEST(0,o.total_amount_minor-COALESCE((SELECT sum(p.amount_minor) FROM mbox.payments p
         WHERE p.tenant_id=p_tenant AND p.store_id=p_store AND p.order_id=o.id
         AND p.status IN ('succeeded','partially_refunded','refunded')),0)) END AS outstanding
   FROM day_orders o
 ) SELECT jsonb_build_object(
   'orderCount',(SELECT count(*) FROM amounts),
   'orderAmountMinor',(SELECT COALESCE(sum(total_amount_minor),0)::text FROM amounts),
   'unsettledCount',(SELECT count(*) FROM amounts WHERE outstanding>0),
   'outstandingMinor',(SELECT COALESCE(sum(outstanding),0)::text FROM amounts),
   'pendingPaymentCount',(SELECT count(*) FROM mbox.payments p JOIN mbox.orders o ON o.tenant_id=p.tenant_id AND o.store_id=p.store_id AND o.id=p.order_id
     WHERE p.tenant_id=p_tenant AND p.store_id=p_store AND o.business_date=p_date AND p.status IN ('created','pending')),
   'pendingRefundCount',(SELECT count(*) FROM mbox.refunds r JOIN mbox.payments p ON p.tenant_id=r.tenant_id AND p.store_id=r.store_id AND p.id=r.payment_id
     JOIN mbox.orders o ON o.tenant_id=p.tenant_id AND o.store_id=p.store_id AND o.id=p.order_id
     WHERE p.tenant_id=p_tenant AND p.store_id=p_store AND o.business_date=p_date AND r.status IN ('requested','approved','processing','failed')))
$$;
REVOKE ALL ON FUNCTION mbox.operating_day_summary(uuid,uuid,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.operating_day_summary(uuid,uuid,date) TO mbox_runtime;

ALTER TABLE mbox.print_ticket_policies DROP CONSTRAINT print_ticket_policies_ticket_kind_check;
ALTER TABLE mbox.print_ticket_policies ADD CHECK(ticket_kind IN ('cashier_settlement','cashier_payment','cashier_refund','bar_production','kitchen_production','order_summary','delivery','table_settlement','daily_settlement'));
ALTER TABLE mbox.print_source_jobs DROP CONSTRAINT print_source_jobs_ticket_kind_check;
ALTER TABLE mbox.print_source_jobs ADD CHECK(ticket_kind IN ('production','settlement','payment','activity_payment','refund','activity_refund','order_summary','delivery','table_settlement','daily_settlement'));
CREATE FUNCTION mbox.enqueue_daily_settlement_print() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.message_type='business_day.manually_ended.v1' AND NEW.aggregate_type='manual_business_day_end' THEN
   INSERT INTO mbox.print_source_jobs(tenant_id,store_id,source_outbox_message_id,aggregate_id,ticket_kind)
   VALUES(NEW.tenant_id,NEW.store_id,NEW.id,NEW.aggregate_id,'daily_settlement')
   ON CONFLICT(tenant_id,store_id,ticket_kind,aggregate_id) DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER enqueue_daily_settlement_print AFTER INSERT ON mbox.outbox_messages
 FOR EACH ROW EXECUTE FUNCTION mbox.enqueue_daily_settlement_print();
REVOKE ALL ON FUNCTION mbox.enqueue_daily_settlement_print() FROM PUBLIC;
UPDATE mbox.normalized_schema_metadata SET schema_version='185',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
