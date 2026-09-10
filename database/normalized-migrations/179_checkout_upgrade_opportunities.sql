BEGIN;
-- A cart id is one stable checkout generation, shared across devices. Never
-- delete the opportunity on decline/expiry; that would reopen promotion.
CREATE TABLE mbox.checkout_upgrade_opportunities(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
 cart_id uuid NOT NULL,cart_generation integer NOT NULL,cart_version bigint NOT NULL CHECK(cart_version>0),
 customer_id uuid NOT NULL,rule_id uuid NOT NULL,source_portion_id uuid NOT NULL,
 source_product_id uuid NOT NULL,target_product_id uuid NOT NULL,
 original_payable_minor bigint NOT NULL CHECK(original_payable_minor BETWEEN 0 AND 9007199254740991),
 upgraded_payable_minor bigint NOT NULL CHECK(upgraded_payable_minor BETWEEN 1 AND 9007199254740991),
 currency char(3) NOT NULL CHECK(currency='CNY'),quote_fingerprint text NOT NULL CHECK(quote_fingerprint~'^[0-9a-f]{64}$'),
 source_name text NOT NULL,target_name text NOT NULL,fit_reason text NOT NULL,
 occasion text CHECK(length(occasion)<=120),alcohol_preference text CHECK(length(alcohol_preference)<=120),
 request_key text NOT NULL CHECK(length(request_key) BETWEEN 8 AND 128),
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 created_transaction bigint NOT NULL DEFAULT txid_current(),
 CHECK(upgraded_payable_minor>original_payable_minor),CHECK(expires_at>created_at AND expires_at<=created_at+interval '30 minutes'),CHECK(source_product_id<>target_product_id),
 UNIQUE(tenant_id,store_id,id),UNIQUE(tenant_id,store_id,cart_id),
 FOREIGN KEY(tenant_id,store_id,cart_id) REFERENCES mbox.guest_shared_carts(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,customer_id) REFERENCES mbox.customers(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,rule_id) REFERENCES mbox.checkout_upgrade_rules(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,source_portion_id) REFERENCES mbox.guest_shared_cart_portions(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,source_product_id) REFERENCES mbox.products(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,target_product_id) REFERENCES mbox.products(tenant_id,store_id,id)
);
CREATE TABLE mbox.checkout_upgrade_opportunity_coupons(
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,opportunity_id uuid NOT NULL,portion_id uuid NOT NULL,benefit_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,store_id,opportunity_id,portion_id),
 FOREIGN KEY(tenant_id,store_id,opportunity_id) REFERENCES mbox.checkout_upgrade_opportunities(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,portion_id) REFERENCES mbox.guest_shared_cart_portions(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,benefit_id) REFERENCES mbox.benefits(tenant_id,store_id,id)
);
CREATE TABLE mbox.checkout_upgrade_opportunity_choices(
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,opportunity_id uuid NOT NULL,
 -- Historical group identity remains after an editable menu group is removed;
 -- acceptance must revalidate the live group, never treat this snapshot as authority.
 choice_group_id uuid NOT NULL,position integer NOT NULL CHECK(position BETWEEN 0 AND 99),component_product_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,store_id,opportunity_id,choice_group_id,position),
 FOREIGN KEY(tenant_id,store_id,opportunity_id) REFERENCES mbox.checkout_upgrade_opportunities(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,component_product_id) REFERENCES mbox.products(tenant_id,store_id,id)
);
CREATE TABLE mbox.checkout_upgrade_opportunity_closures(
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,opportunity_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN('declined','accepted','expired','invalidated')),
 customer_id uuid,accepted_operation_id uuid,replacement_portion_id uuid,accepted_quote_id uuid,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 2 AND 500),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,store_id,opportunity_id),
 CHECK((action='accepted' AND customer_id IS NOT NULL AND accepted_operation_id IS NOT NULL AND replacement_portion_id IS NOT NULL)
   OR(action<>'accepted' AND accepted_operation_id IS NULL AND replacement_portion_id IS NULL AND accepted_quote_id IS NULL)),
 CHECK(action<>'declined' OR customer_id IS NOT NULL),
 FOREIGN KEY(tenant_id,store_id,opportunity_id) REFERENCES mbox.checkout_upgrade_opportunities(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,customer_id) REFERENCES mbox.customers(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,accepted_operation_id) REFERENCES mbox.guest_shared_cart_operations(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,replacement_portion_id) REFERENCES mbox.guest_shared_cart_portions(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,accepted_quote_id) REFERENCES mbox.checkout_coupon_quotes(tenant_id,store_id,id)
);
CREATE FUNCTION mbox.validate_checkout_upgrade_opportunity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM mbox.guest_shared_carts c JOIN mbox.guest_shared_cart_portions p ON p.tenant_id=c.tenant_id AND p.store_id=c.store_id AND p.cart_id=c.id
   JOIN mbox.checkout_upgrade_rules r ON r.tenant_id=c.tenant_id AND r.store_id=c.store_id AND r.id=NEW.rule_id
   WHERE c.tenant_id=NEW.tenant_id AND c.store_id=NEW.store_id AND c.id=NEW.cart_id AND c.generation=NEW.cart_generation AND c.version=NEW.cart_version AND c.status='open'
     AND p.id=NEW.source_portion_id AND p.product_id=NEW.source_product_id AND p.removed_at IS NULL
     AND r.status='active' AND r.source_product_id=NEW.source_product_id AND r.target_product_id=NEW.target_product_id) THEN
   RAISE EXCEPTION 'Opportunity requires current cart portion and published matching rule'; END IF;
 NEW.created_transaction=txid_current();RETURN NEW;
END $$;
CREATE TRIGGER validate_checkout_upgrade_opportunity BEFORE INSERT ON mbox.checkout_upgrade_opportunities FOR EACH ROW EXECUTE FUNCTION mbox.validate_checkout_upgrade_opportunity();
CREATE FUNCTION mbox.validate_upgrade_opportunity_child() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM mbox.checkout_upgrade_opportunities p WHERE p.tenant_id=NEW.tenant_id AND p.store_id=NEW.store_id AND p.id=NEW.opportunity_id AND p.created_transaction=txid_current()) THEN RAISE EXCEPTION 'Opportunity choices and coupons must freeze in the same transaction'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER validate_upgrade_opportunity_child BEFORE INSERT ON mbox.checkout_upgrade_opportunity_choices FOR EACH ROW EXECUTE FUNCTION mbox.validate_upgrade_opportunity_child();
CREATE TRIGGER validate_upgrade_opportunity_child BEFORE INSERT ON mbox.checkout_upgrade_opportunity_coupons FOR EACH ROW EXECUTE FUNCTION mbox.validate_upgrade_opportunity_child();
CREATE FUNCTION mbox.validate_upgrade_opportunity_closure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE opportunity mbox.checkout_upgrade_opportunities%ROWTYPE;
BEGIN
 -- Immutable tables deliberately do not grant UPDATE. Serialize with a
 -- non-waiting advisory lock rather than requiring SELECT FOR UPDATE rights.
 IF NOT pg_try_advisory_xact_lock(hashtextextended('upgrade-accept:'||NEW.tenant_id||':'||NEW.store_id||':'||NEW.opportunity_id,0)) THEN RAISE EXCEPTION 'Opportunity confirmation in progress'; END IF;
 SELECT * INTO opportunity FROM mbox.checkout_upgrade_opportunities WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.opportunity_id;
 IF opportunity.id IS NULL THEN RAISE EXCEPTION 'Opportunity unavailable'; END IF;
 IF NEW.customer_id IS NOT NULL AND mbox.canonical_customer_id(NEW.tenant_id,NEW.store_id,NEW.customer_id) IS DISTINCT FROM mbox.canonical_customer_id(opportunity.tenant_id,opportunity.store_id,opportunity.customer_id) THEN RAISE EXCEPTION 'Opportunity belongs to another customer'; END IF;
 IF NEW.action='accepted' THEN
   IF opportunity.expires_at<=clock_timestamp() OR NOT EXISTS(
     SELECT 1 FROM mbox.guest_shared_cart_operations op JOIN mbox.guest_shared_cart_portions p ON p.tenant_id=op.tenant_id AND p.store_id=op.store_id AND p.cart_id=op.cart_id
     WHERE op.tenant_id=NEW.tenant_id AND op.store_id=NEW.store_id AND op.id=NEW.accepted_operation_id AND op.cart_id=opportunity.cart_id AND op.command='replace_portion'
       AND op.expected_version=opportunity.cart_version AND op.resulting_version=opportunity.cart_version+1
       AND op.payload->>'portionId'=opportunity.source_portion_id::text AND op.payload->>'productId'=opportunity.source_product_id::text AND op.payload->>'targetProductId'=opportunity.target_product_id::text
       AND p.id=NEW.replacement_portion_id AND p.product_id=opportunity.target_product_id AND p.removed_at IS NULL AND p.created_at>=opportunity.created_at
       AND EXISTS(SELECT 1 FROM mbox.guest_shared_carts c WHERE c.tenant_id=op.tenant_id AND c.store_id=op.store_id AND c.id=op.cart_id AND c.version=op.resulting_version AND c.status='open')
       AND EXISTS(SELECT 1 FROM mbox.guest_shared_cart_portions retired WHERE retired.tenant_id=op.tenant_id AND retired.store_id=op.store_id AND retired.id=opportunity.source_portion_id AND retired.removed_at>=opportunity.created_at)) THEN
     RAISE EXCEPTION 'Accepted opportunity requires its actual atomic portion replacement'; END IF;
   IF EXISTS(SELECT 1 FROM mbox.checkout_upgrade_opportunity_coupons c WHERE c.tenant_id=NEW.tenant_id AND c.store_id=NEW.store_id AND c.opportunity_id=NEW.opportunity_id)
      AND (NEW.accepted_quote_id IS NULL OR NOT EXISTS(SELECT 1 FROM mbox.checkout_coupon_quotes q WHERE q.tenant_id=NEW.tenant_id AND q.store_id=NEW.store_id AND q.id=NEW.accepted_quote_id AND q.cart_id=opportunity.cart_id AND q.cart_version=opportunity.cart_version+1 AND q.payable_minor=opportunity.upgraded_payable_minor
       AND mbox.canonical_customer_id(q.tenant_id,q.store_id,q.customer_id)=mbox.canonical_customer_id(opportunity.tenant_id,opportunity.store_id,opportunity.customer_id)
       AND NOT EXISTS(SELECT 1 FROM mbox.checkout_upgrade_opportunity_coupons c WHERE c.tenant_id=q.tenant_id AND c.store_id=q.store_id AND c.opportunity_id=opportunity.id
        AND NOT EXISTS(SELECT 1 FROM mbox.checkout_coupon_quote_lines l WHERE l.tenant_id=q.tenant_id AND l.store_id=q.store_id AND l.quote_id=q.id AND l.benefit_id=c.benefit_id AND l.portion_id=CASE WHEN c.portion_id=opportunity.source_portion_id THEN NEW.replacement_portion_id ELSE c.portion_id END)))) THEN
     RAISE EXCEPTION 'Accepted coupon upgrade requires revalidated actual cart quote'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER validate_upgrade_opportunity_closure BEFORE INSERT ON mbox.checkout_upgrade_opportunity_closures FOR EACH ROW EXECUTE FUNCTION mbox.validate_upgrade_opportunity_closure();
DO $$ DECLARE table_name text;BEGIN
 FOREACH table_name IN ARRAY ARRAY['checkout_upgrade_opportunities','checkout_upgrade_opportunity_coupons','checkout_upgrade_opportunity_choices','checkout_upgrade_opportunity_closures'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_upgrade_opportunity BEFORE UPDATE OR DELETE ON mbox.%I FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change()',table_name);
  EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',table_name);
  EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',table_name);
  EXECUTE format('CREATE POLICY tenant_store_isolation ON mbox.%I USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',table_name);
  EXECUTE format('REVOKE ALL ON mbox.%I FROM PUBLIC,mbox_runtime',table_name);
  EXECUTE format('GRANT SELECT,INSERT ON mbox.%I TO mbox_runtime',table_name);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION mbox.validate_checkout_upgrade_opportunity(),mbox.validate_upgrade_opportunity_child(),mbox.validate_upgrade_opportunity_closure() FROM PUBLIC;
-- Live cart rows are mutable selections, unlike durable portions/operations.
-- Existing remove/clear and the final source-unit replacement delete them.
-- Keep tenant/store RLS and history triggers; do not grant DELETE on history.
GRANT DELETE ON mbox.guest_shared_cart_lines TO mbox_runtime;
UPDATE mbox.normalized_schema_metadata SET schema_version='179',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
