BEGIN;
CREATE TABLE mbox.checkout_upgrade_qualifications(
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,rule_id uuid NOT NULL,
 maximum_add_minor bigint NOT NULL CHECK(maximum_add_minor>=0),
 maximum_add_basis_points integer CHECK(maximum_add_basis_points BETWEEN 0 AND 1000000),
 minimum_contribution_minor bigint NOT NULL CHECK(minimum_contribution_minor>=0),
 minimum_incremental_contribution_minor bigint NOT NULL CHECK(minimum_incremental_contribution_minor>=0),
 positive_fit_reason text NOT NULL CHECK(length(btrim(positive_fit_reason)) BETWEEN 2 AND 500),
 created_transaction bigint NOT NULL DEFAULT txid_current(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,store_id,rule_id),
 FOREIGN KEY(tenant_id,store_id,rule_id) REFERENCES mbox.checkout_upgrade_rules(tenant_id,store_id,id)
);
CREATE TABLE mbox.checkout_upgrade_portion_limits(
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,rule_id uuid NOT NULL,product_id uuid NOT NULL,
 maximum_per_person integer NOT NULL CHECK(maximum_per_person BETWEEN 1 AND 100),
 PRIMARY KEY(tenant_id,store_id,rule_id,product_id),
 FOREIGN KEY(tenant_id,store_id,rule_id) REFERENCES mbox.checkout_upgrade_qualifications(tenant_id,store_id,rule_id),
 FOREIGN KEY(tenant_id,store_id,product_id) REFERENCES mbox.products(tenant_id,store_id,id)
);
CREATE TABLE mbox.checkout_upgrade_excluded_products(
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,rule_id uuid NOT NULL,product_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,store_id,rule_id,product_id),
 FOREIGN KEY(tenant_id,store_id,rule_id) REFERENCES mbox.checkout_upgrade_qualifications(tenant_id,store_id,rule_id),
 FOREIGN KEY(tenant_id,store_id,product_id) REFERENCES mbox.products(tenant_id,store_id,id)
);
CREATE FUNCTION mbox.validate_checkout_upgrade_qualification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM mbox.checkout_upgrade_rules r WHERE r.tenant_id=NEW.tenant_id AND r.store_id=NEW.store_id AND r.id=NEW.rule_id AND r.status='draft' AND r.publication_mode='separated') THEN RAISE EXCEPTION 'Strict qualification belongs to a separated draft rule'; END IF;
 IF TG_TABLE_NAME='checkout_upgrade_qualifications' THEN
  NEW.created_transaction:=txid_current();
 ELSIF NOT EXISTS(SELECT 1 FROM mbox.checkout_upgrade_qualifications q WHERE q.tenant_id=NEW.tenant_id AND q.store_id=NEW.store_id AND q.rule_id=NEW.rule_id AND q.created_transaction=txid_current()) THEN
  RAISE EXCEPTION 'Strict qualification children must be frozen in the same transaction';
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['checkout_upgrade_qualifications','checkout_upgrade_portion_limits','checkout_upgrade_excluded_products'] LOOP
  EXECUTE format('CREATE TRIGGER validate_qualification BEFORE INSERT ON mbox.%I FOR EACH ROW EXECUTE FUNCTION mbox.validate_checkout_upgrade_qualification()',name);
  EXECUTE format('CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON mbox.%I FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change()',name);
  EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY tenant_store_isolation ON mbox.%I USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',name);
  EXECUTE format('REVOKE ALL ON mbox.%I FROM PUBLIC,mbox_runtime',name);
  EXECUTE format('GRANT SELECT,INSERT ON mbox.%I TO mbox_runtime',name);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION mbox.validate_checkout_upgrade_qualification() FROM PUBLIC;
UPDATE mbox.normalized_schema_metadata SET schema_version='177',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
