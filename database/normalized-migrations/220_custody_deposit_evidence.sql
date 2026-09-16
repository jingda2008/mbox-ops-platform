BEGIN;
CREATE TABLE mbox.bottle_custody_deposits (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
 order_id uuid NOT NULL,collection_id uuid,employee_id uuid NOT NULL,
 quantity numeric(18,6) NOT NULL CHECK(quantity>0),fraction_label text,
 phone_source text NOT NULL CHECK(phone_source IN ('membership','manual')),
 encrypted_phone bytea NOT NULL CHECK(octet_length(encrypted_phone)>=32),phone_hash text NOT NULL,
 phone_key_id text NOT NULL,phone_masked text NOT NULL,contact_id uuid,
 photo bytea NOT NULL CHECK(octet_length(photo) BETWEEN 100 AND 524288),photo_sha256 text NOT NULL,
 recorded_at timestamptz NOT NULL,watermark text NOT NULL,
 UNIQUE(tenant_id,store_id,id),UNIQUE(tenant_id,store_id,collection_id),
 FOREIGN KEY(tenant_id,store_id,order_id) REFERENCES mbox.bottle_custody_orders(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,collection_id) REFERENCES mbox.bottle_custody_collections(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,contact_id) REFERENCES mbox.customer_verified_contacts(tenant_id,store_id,id)
);
CREATE INDEX bottle_custody_deposit_order ON mbox.bottle_custody_deposits(tenant_id,store_id,order_id,recorded_at);
ALTER TABLE mbox.bottle_custody_deposits ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.bottle_custody_deposits FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.bottle_custody_deposits USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
REVOKE ALL ON mbox.bottle_custody_deposits FROM PUBLIC,mbox_runtime;
GRANT SELECT,INSERT ON mbox.bottle_custody_deposits TO mbox_runtime;
CREATE TRIGGER bottle_custody_deposits_append_only BEFORE UPDATE OR DELETE ON mbox.bottle_custody_deposits FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
CREATE FUNCTION mbox.require_custody_deposit_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM mbox.bottle_custody_deposits WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND order_id=NEW.id) THEN
  RAISE EXCEPTION 'new custody requires photo and phone evidence' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER custody_deposit_required AFTER INSERT ON mbox.bottle_custody_orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mbox.require_custody_deposit_evidence();
UPDATE mbox.normalized_schema_metadata SET schema_version='220',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
