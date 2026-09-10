BEGIN;

-- Only new committed business events are enrolled. Do not flood printers with
-- historical orders on deployment. Rendering, routing and devices are isolated
-- from the transaction that records the business fact.
CREATE TABLE mbox.print_source_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, store_id uuid NOT NULL,
 source_outbox_message_id uuid NOT NULL, aggregate_id uuid NOT NULL,
 ticket_kind text NOT NULL CHECK(ticket_kind IN ('production','settlement','payment','activity_payment','refund','activity_refund')),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','retry','completed','skipped','dead')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 8),
 next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_error_code text, job_count integer NOT NULL DEFAULT 0 CHECK(job_count>=0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
 UNIQUE(tenant_id,store_id,id), UNIQUE(tenant_id,store_id,ticket_kind,aggregate_id),
 FOREIGN KEY(tenant_id,store_id,source_outbox_message_id) REFERENCES mbox.outbox_messages(tenant_id,store_id,id)
);
CREATE INDEX print_source_jobs_due ON mbox.print_source_jobs(tenant_id,store_id,next_attempt_at,id) WHERE status IN ('pending','retry');
ALTER TABLE mbox.print_source_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.print_source_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.print_source_jobs USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
REVOKE ALL ON mbox.print_source_jobs FROM PUBLIC,mbox_runtime;
GRANT SELECT,INSERT,UPDATE ON mbox.print_source_jobs TO mbox_runtime;

CREATE FUNCTION mbox.enqueue_print_source_from_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind text;
BEGIN
 IF NEW.aggregate_type='order' AND (
   (NEW.message_type IN ('order.submitted.v1','benefit.gift.fulfillment-dispatched.v1')
    AND jsonb_typeof(NEW.payload->'kdsTaskIds')='array' AND NEW.payload->'kdsTaskIds'<>'[]'::jsonb)
   OR (NEW.message_type='order.fulfillment_activated_after_payment.v1' AND NEW.payload->>'kdsTaskCount' ~ '^[1-9][0-9]*$')
 ) THEN kind:='production';
 ELSIF NEW.aggregate_type='payment' AND NEW.payload->>'status'='succeeded' THEN
   kind:=CASE WHEN NEW.payload->>'payableKind'='activity_registration' THEN 'activity_payment' ELSE 'payment' END;
 ELSIF NEW.aggregate_type='payment' AND NEW.message_type='payment.initiated.v1'
   AND NEW.payload->>'status'='pending' AND NEW.payload->>'orderId' IS NOT NULL THEN kind:='settlement';
 ELSIF NEW.aggregate_type='refund' AND NEW.payload->>'status'='succeeded' THEN
   kind:=CASE WHEN NEW.payload->>'orderId' IS NULL THEN 'activity_refund' ELSE 'refund' END;
 END IF;
 IF kind IS NOT NULL THEN
   INSERT INTO mbox.print_source_jobs(tenant_id,store_id,source_outbox_message_id,aggregate_id,ticket_kind)
   VALUES(NEW.tenant_id,NEW.store_id,NEW.id,NEW.aggregate_id,kind)
   ON CONFLICT(tenant_id,store_id,ticket_kind,aggregate_id) DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER enqueue_print_source AFTER INSERT ON mbox.outbox_messages FOR EACH ROW EXECUTE FUNCTION mbox.enqueue_print_source_from_event();
REVOKE ALL ON FUNCTION mbox.enqueue_print_source_from_event() FROM PUBLIC;
UPDATE mbox.normalized_schema_metadata SET schema_version='181',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
