BEGIN;

CREATE TABLE mbox.print_ticket_policies (
 tenant_id uuid NOT NULL, store_id uuid NOT NULL,
 ticket_kind text NOT NULL CHECK(ticket_kind IN ('cashier_settlement','cashier_payment','cashier_refund','bar_production','kitchen_production','order_summary','delivery','table_settlement')),
 enabled boolean NOT NULL DEFAULT true, copies integer NOT NULL CHECK(copies BETWEEN 1 AND 5),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,store_id,ticket_kind),
 FOREIGN KEY(tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id)
);
ALTER TABLE mbox.print_ticket_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.print_ticket_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.print_ticket_policies USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
REVOKE ALL ON mbox.print_ticket_policies FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON mbox.print_ticket_policies TO mbox_runtime;

ALTER TABLE mbox.print_source_jobs DROP CONSTRAINT print_source_jobs_ticket_kind_check;
ALTER TABLE mbox.print_source_jobs ADD CHECK(ticket_kind IN ('production','settlement','payment','activity_payment','refund','activity_refund','order_summary','delivery','table_settlement'));

-- Extend enrollment separately from the existing payment trigger. No history
-- replay, device I/O, rendering or provider calls in a business transaction.
CREATE FUNCTION mbox.enqueue_additional_print_sources() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind text;
BEGIN
 IF NEW.aggregate_type='order' AND (
   (NEW.message_type IN ('order.submitted.v1','benefit.gift.fulfillment-dispatched.v1')
     AND jsonb_typeof(NEW.payload->'kdsTaskIds')='array' AND NEW.payload->'kdsTaskIds'<>'[]'::jsonb)
   OR (NEW.message_type='order.fulfillment_activated_after_payment.v1' AND NEW.payload->>'kdsTaskCount' ~ '^[1-9][0-9]*$')
 ) THEN kind:='order_summary';
 ELSIF NEW.aggregate_type='kds_task' AND NEW.message_type='kds.complete.v1' THEN kind:='delivery';
 ELSIF NEW.aggregate_type='table_session' AND NEW.payload->>'status'='closed' THEN kind:='table_settlement';
 END IF;
 IF kind IS NOT NULL THEN
   INSERT INTO mbox.print_source_jobs(tenant_id,store_id,source_outbox_message_id,aggregate_id,ticket_kind)
   VALUES(NEW.tenant_id,NEW.store_id,NEW.id,NEW.aggregate_id,kind)
   ON CONFLICT(tenant_id,store_id,ticket_kind,aggregate_id) DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER enqueue_additional_print_sources AFTER INSERT ON mbox.outbox_messages FOR EACH ROW EXECUTE FUNCTION mbox.enqueue_additional_print_sources();
REVOKE ALL ON FUNCTION mbox.enqueue_additional_print_sources() FROM PUBLIC;
UPDATE mbox.normalized_schema_metadata SET schema_version='182',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
