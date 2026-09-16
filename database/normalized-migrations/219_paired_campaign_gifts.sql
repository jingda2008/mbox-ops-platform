BEGIN;
ALTER TABLE mbox.member_gift_campaign_versions ADD COLUMN dessert_product_id uuid,
 ADD COLUMN highlight_metrics text[] NOT NULL DEFAULT ARRAY['issued','redeemed','remaining'],
 ADD FOREIGN KEY(tenant_id,store_id,dessert_product_id) REFERENCES mbox.products(tenant_id,store_id,id),
 ADD CHECK(highlight_metrics <@ ARRAY['issued','redeemed','remaining','cost']::text[]);
ALTER TABLE mbox.member_gift_delivery_jobs ADD COLUMN dessert_benefit_id uuid,
 ADD FOREIGN KEY(tenant_id,store_id,dessert_benefit_id) REFERENCES mbox.benefits(tenant_id,store_id,id);
CREATE FUNCTION mbox.protect_paired_gift_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE dessert uuid; b mbox.benefits;
BEGIN
 SELECT dessert_product_id INTO dessert FROM mbox.member_gift_campaign_versions WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.campaign_version_id;
 IF NEW.status='issued' AND dessert IS NOT NULL THEN
  SELECT * INTO b FROM mbox.benefits WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.dessert_benefit_id;
  IF b.id IS NULL OR b.id=NEW.benefit_id OR b.benefit_type<>'gift_product' OR b.quantity_total<>NEW.quantity OR b.issuance_idempotency_key<>('member-gift-dessert:'||NEW.id::text) OR mbox.canonical_customer_id(b.tenant_id,b.store_id,b.customer_id)<>mbox.canonical_customer_id(NEW.tenant_id,NEW.store_id,NEW.customer_id) THEN RAISE EXCEPTION 'Paired dessert benefit mismatch'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_paired_gift_job BEFORE INSERT OR UPDATE ON mbox.member_gift_delivery_jobs FOR EACH ROW EXECUTE FUNCTION mbox.protect_paired_gift_job();
REVOKE ALL ON FUNCTION mbox.protect_paired_gift_job() FROM PUBLIC;
UPDATE mbox.normalized_schema_metadata SET schema_version='219',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
