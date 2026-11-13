BEGIN;
-- A changed bank account needs a newly confirmed tail-payment document, while
-- original ledger occupancy and already-paid bank facts remain immutable.
ALTER TABLE mbox.channel_statements ADD COLUMN source_statement_id uuid,
 ADD FOREIGN KEY(tenant_id,store_id,source_statement_id) REFERENCES mbox.channel_statements(tenant_id,store_id,id),
 ADD CHECK(source_statement_id IS NULL OR source_statement_id<>id);

ALTER TABLE mbox.channel_visits ADD COLUMN source_review_required boolean NOT NULL DEFAULT false,ADD COLUMN reporting_root_id uuid,ADD FOREIGN KEY(tenant_id,store_id,reporting_root_id) REFERENCES mbox.channel_visits(tenant_id,store_id,id);
CREATE TABLE mbox.channel_poster_versions(
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,batch_id uuid NOT NULL,artifact_key char(64) NOT NULL,sha256 char(64) NOT NULL,
 png bytea NOT NULL CHECK(octet_length(png) BETWEEN 1 AND 2000000),snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,store_id,batch_id,artifact_key),FOREIGN KEY(tenant_id,store_id,batch_id) REFERENCES mbox.channel_batches(tenant_id,store_id,id)
);
CREATE TABLE mbox.channel_request_buckets(
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,actor_hash char(64) NOT NULL,minute timestamptz NOT NULL,count integer NOT NULL,
 PRIMARY KEY(tenant_id,store_id,actor_hash,minute),FOREIGN KEY(tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id)
);
DO $$ DECLARE n text; BEGIN
 FOREACH n IN ARRAY ARRAY['channel_poster_versions','channel_request_buckets'] LOOP
  EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',n);EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',n);
  EXECUTE format('CREATE POLICY scoped ON mbox.%I USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',n);
  EXECUTE format('GRANT SELECT,INSERT ON mbox.%I TO mbox_runtime',n);
 END LOOP;
END $$;
GRANT UPDATE,DELETE ON mbox.channel_request_buckets TO mbox_runtime;
CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON mbox.channel_poster_versions FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
-- Linearize refund fact commits with commission approval/payout registration.
-- No source-row lock is acquired by the projection while it holds this lock.
CREATE FUNCTION mbox.lock_channel_refund_fact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM mbox.channel_effective_attributions a JOIN mbox.order_payment_facts p ON (p.tenant_id,p.store_id,p.order_id)=(a.tenant_id,a.store_id,a.order_id)
  WHERE p.tenant_id=NEW.tenant_id AND p.store_id=NEW.store_id AND p.id=NEW.payment_id
   AND (NEW.order_id IS NULL OR a.order_id=NEW.order_id)) THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('channel-finance:'||NEW.tenant_id::text||':'||NEW.store_id::text,0));
 END IF;RETURN NEW;END $$;
REVOKE ALL ON FUNCTION mbox.lock_channel_refund_fact() FROM PUBLIC;
CREATE TRIGGER channel_refund_serialization BEFORE INSERT OR UPDATE ON mbox.refunds FOR EACH ROW EXECUTE FUNCTION mbox.lock_channel_refund_fact();
UPDATE mbox.normalized_schema_metadata SET schema_version='312',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
