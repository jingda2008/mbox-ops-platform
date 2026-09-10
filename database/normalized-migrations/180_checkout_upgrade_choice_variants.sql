BEGIN;
CREATE TABLE mbox.checkout_upgrade_choice_variants(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,opportunity_id uuid NOT NULL,
 quote_fingerprint text NOT NULL CHECK(quote_fingerprint~'^[0-9a-f]{64}$'),
 label text NOT NULL CHECK(length(btrim(label)) BETWEEN 1 AND 5000),
 UNIQUE(tenant_id,store_id,id),UNIQUE(tenant_id,store_id,opportunity_id,quote_fingerprint),
 FOREIGN KEY(tenant_id,store_id,opportunity_id) REFERENCES mbox.checkout_upgrade_opportunities(tenant_id,store_id,id)
);
CREATE TABLE mbox.checkout_upgrade_variant_choices(
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,opportunity_id uuid NOT NULL,variant_id uuid NOT NULL,
 choice_group_id uuid NOT NULL,position integer NOT NULL CHECK(position BETWEEN 0 AND 99),component_product_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,store_id,variant_id,choice_group_id,position),
 FOREIGN KEY(tenant_id,store_id,variant_id) REFERENCES mbox.checkout_upgrade_choice_variants(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,opportunity_id) REFERENCES mbox.checkout_upgrade_opportunities(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,component_product_id) REFERENCES mbox.products(tenant_id,store_id,id)
);
CREATE TRIGGER freeze_upgrade_variant BEFORE INSERT ON mbox.checkout_upgrade_choice_variants FOR EACH ROW EXECUTE FUNCTION mbox.validate_upgrade_opportunity_child();
CREATE TRIGGER freeze_upgrade_variant_choice BEFORE INSERT ON mbox.checkout_upgrade_variant_choices FOR EACH ROW EXECUTE FUNCTION mbox.validate_upgrade_opportunity_child();
CREATE FUNCTION mbox.validate_upgrade_variant_choice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM mbox.checkout_upgrade_choice_variants v WHERE v.tenant_id=NEW.tenant_id AND v.store_id=NEW.store_id AND v.id=NEW.variant_id AND v.opportunity_id=NEW.opportunity_id) THEN RAISE EXCEPTION 'Variant belongs to another opportunity'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER validate_upgrade_variant_choice BEFORE INSERT ON mbox.checkout_upgrade_variant_choices FOR EACH ROW EXECUTE FUNCTION mbox.validate_upgrade_variant_choice();
ALTER TABLE mbox.checkout_upgrade_opportunity_closures ADD COLUMN accepted_variant_id uuid;
ALTER TABLE mbox.checkout_upgrade_opportunity_closures ADD FOREIGN KEY(tenant_id,store_id,accepted_variant_id) REFERENCES mbox.checkout_upgrade_choice_variants(tenant_id,store_id,id);
ALTER TABLE mbox.checkout_upgrade_opportunity_closures ADD CHECK(action='accepted' OR accepted_variant_id IS NULL);
CREATE FUNCTION mbox.validate_upgrade_accepted_variant() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual_groups jsonb;expected_groups jsonb;
BEGIN
 IF NEW.action<>'accepted' THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM mbox.checkout_upgrade_choice_variants v WHERE v.tenant_id=NEW.tenant_id AND v.store_id=NEW.store_id AND v.opportunity_id=NEW.opportunity_id) THEN
  IF NOT EXISTS(SELECT 1 FROM mbox.checkout_upgrade_choice_variants v WHERE v.tenant_id=NEW.tenant_id AND v.store_id=NEW.store_id AND v.opportunity_id=NEW.opportunity_id AND v.id=NEW.accepted_variant_id) THEN RAISE EXCEPTION 'Explicit complete upgrade choice required'; END IF;
  SELECT jsonb_object_agg(group_id,products) INTO expected_groups FROM(
   SELECT choice_group_id::text AS group_id,jsonb_agg(component_product_id::text ORDER BY component_product_id) AS products FROM mbox.checkout_upgrade_variant_choices WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND variant_id=NEW.accepted_variant_id GROUP BY choice_group_id
  ) expected;
  SELECT jsonb_object_agg(g->>'groupId',(SELECT jsonb_agg(p ORDER BY p) FROM jsonb_array_elements_text(g->'productIds') p)) INTO actual_groups
   FROM mbox.guest_shared_cart_operations op CROSS JOIN LATERAL jsonb_array_elements(op.payload->'bundleSelection'->'groups') g
   WHERE op.tenant_id=NEW.tenant_id AND op.store_id=NEW.store_id AND op.id=NEW.accepted_operation_id;
  IF expected_groups IS NULL OR actual_groups IS DISTINCT FROM expected_groups THEN RAISE EXCEPTION 'Actual replacement choices differ from selected qualified variant'; END IF;
 ELSIF NEW.accepted_variant_id IS NOT NULL THEN RAISE EXCEPTION 'Unexpected upgrade variant'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER validate_upgrade_accepted_variant BEFORE INSERT ON mbox.checkout_upgrade_opportunity_closures FOR EACH ROW EXECUTE FUNCTION mbox.validate_upgrade_accepted_variant();
DO $$ DECLARE table_name text;BEGIN
 FOREACH table_name IN ARRAY ARRAY['checkout_upgrade_choice_variants','checkout_upgrade_variant_choices'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_upgrade_variant BEFORE UPDATE OR DELETE ON mbox.%I FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change()',table_name);
  EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',table_name);
  EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',table_name);
  EXECUTE format('CREATE POLICY tenant_store_isolation ON mbox.%I USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',table_name);
  EXECUTE format('REVOKE ALL ON mbox.%I FROM PUBLIC,mbox_runtime',table_name);
  EXECUTE format('GRANT SELECT,INSERT ON mbox.%I TO mbox_runtime',table_name);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION mbox.validate_upgrade_variant_choice(),mbox.validate_upgrade_accepted_variant() FROM PUBLIC;
UPDATE mbox.normalized_schema_metadata SET schema_version='180',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
