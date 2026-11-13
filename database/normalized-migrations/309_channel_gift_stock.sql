BEGIN;
CREATE TABLE mbox.channel_gift_promises (
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,claim_id uuid NOT NULL,product_id uuid NOT NULL,recipe_id uuid NOT NULL,
 quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 100),cost_minor bigint NOT NULL CHECK(cost_minor>=0),sale_generation bigint,
 state text NOT NULL DEFAULT 'reserved' CHECK(state IN('reserved','converted','released')),order_id uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz,
 PRIMARY KEY(tenant_id,store_id,claim_id),
 FOREIGN KEY(tenant_id,store_id,claim_id) REFERENCES mbox.channel_claims(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,product_id) REFERENCES mbox.products(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,recipe_id) REFERENCES mbox.recipes(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,order_id) REFERENCES mbox.orders(tenant_id,store_id,id)
);
CREATE TABLE mbox.channel_gift_stock (
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,claim_id uuid NOT NULL,inventory_item_id uuid NOT NULL,
 quantity numeric(18,6) NOT NULL CHECK(quantity>0),
 PRIMARY KEY(tenant_id,store_id,claim_id,inventory_item_id),
 FOREIGN KEY(tenant_id,store_id,claim_id) REFERENCES mbox.channel_gift_promises(tenant_id,store_id,claim_id),
 FOREIGN KEY(tenant_id,store_id,inventory_item_id) REFERENCES mbox.inventory_items(tenant_id,store_id,id)
);
DO $$ DECLARE n text; BEGIN
 FOREACH n IN ARRAY ARRAY['channel_gift_promises','channel_gift_stock'] LOOP
  EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',n);EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',n);
  EXECUTE format('CREATE POLICY scoped ON mbox.%I USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',n);
  EXECUTE format('GRANT SELECT,INSERT ON mbox.%I TO mbox_runtime',n);
 END LOOP;
END $$;
GRANT UPDATE ON mbox.channel_gift_promises TO mbox_runtime;
CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON mbox.channel_gift_stock FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
-- A sales-count reset must not silently consume already promised product units.
CREATE FUNCTION mbox.protect_channel_gift_sale_generation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.sale_quantity_generation IS DISTINCT FROM OLD.sale_quantity_generation OR (NEW.sale_remaining_quantity IS NULL) IS DISTINCT FROM (OLD.sale_remaining_quantity IS NULL))
 AND EXISTS(SELECT 1 FROM mbox.channel_gift_promises WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND product_id=NEW.id AND state='reserved' AND sale_generation IS NOT NULL)
 THEN RAISE EXCEPTION '该商品有渠道赠品承诺，请先履约或办理替换再重置可售数量' USING ERRCODE='23514';END IF;
 RETURN NEW;END $$;
REVOKE ALL ON FUNCTION mbox.protect_channel_gift_sale_generation() FROM PUBLIC;
CREATE TRIGGER products_channel_promised_sale_count BEFORE UPDATE ON mbox.products FOR EACH ROW EXECUTE FUNCTION mbox.protect_channel_gift_sale_generation();
ALTER TABLE mbox.channel_price_quotes DROP CONSTRAINT channel_price_quotes_channel_check;
ALTER TABLE mbox.channel_price_quotes ADD CHECK(channel IN('guest_qr','staff_assisted','cashier'));
-- Only the internal, table-authorized gift command creates cashier quotes.
ALTER TABLE mbox.pricing_authorizations DROP CONSTRAINT pricing_authorizations_source_integrity;
ALTER TABLE mbox.pricing_authorizations ADD CONSTRAINT pricing_authorizations_source_integrity CHECK(
 (source_type='employee' AND authorized_by_employee_id IS NOT NULL AND capability IN('order.discount','order.gift') AND role_approval_limit_id=source_id AND benefit_id IS NULL AND checkout_quote_id IS NULL AND channel_quote_id IS NULL)
 OR(source_type='benefit' AND capability IS NULL AND benefit_id=source_id AND role_approval_limit_id IS NULL AND checkout_quote_id IS NULL AND channel_quote_id IS NULL)
 OR(source_type='checkout_quote' AND capability IS NULL AND authorized_by_employee_id IS NULL AND benefit_id IS NULL AND role_approval_limit_id IS NULL AND checkout_quote_id IS NOT NULL AND checkout_quote_id=source_id AND channel_quote_id IS NULL AND kind='discount')
 OR(source_type='channel_quote' AND capability IS NULL AND authorized_by_employee_id IS NULL AND benefit_id IS NULL AND role_approval_limit_id IS NULL AND checkout_quote_id IS NULL AND channel_quote_id IS NOT NULL AND channel_quote_id=source_id AND kind IN('discount','gift'))
);
UPDATE mbox.normalized_schema_metadata SET schema_version='309',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
