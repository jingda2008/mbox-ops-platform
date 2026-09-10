BEGIN;
-- Prepared quotes do not reserve coupons or inventory, create orders, or
-- authorize a payment. Checkout must revalidate every bound fact atomically.
CREATE TABLE mbox.checkout_coupon_quotes(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
  cart_id uuid NOT NULL,cart_generation bigint NOT NULL CHECK(cart_generation>0),cart_version bigint NOT NULL CHECK(cart_version>0),
  table_session_id uuid NOT NULL,customer_id uuid NOT NULL,
  subtotal_minor bigint NOT NULL CHECK(subtotal_minor BETWEEN 1 AND 9007199254740991),
  discount_minor bigint NOT NULL CHECK(discount_minor>0 AND discount_minor<=subtotal_minor),
  payable_minor bigint NOT NULL CHECK(payable_minor=subtotal_minor-discount_minor),
  currency char(3) NOT NULL CHECK(currency='CNY'),expires_at timestamptz NOT NULL,
  request_key text NOT NULL CHECK(length(request_key) BETWEEN 8 AND 128),request_fingerprint text NOT NULL CHECK(request_fingerprint~'^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),CHECK(expires_at>created_at),
  UNIQUE(tenant_id,store_id,id),UNIQUE(tenant_id,store_id,customer_id,request_key),
  FOREIGN KEY(tenant_id,store_id,cart_id) REFERENCES mbox.guest_shared_carts(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,table_session_id) REFERENCES mbox.table_sessions(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,customer_id) REFERENCES mbox.customers(tenant_id,store_id,id)
);
CREATE TABLE mbox.checkout_coupon_quote_lines(
  tenant_id uuid NOT NULL,store_id uuid NOT NULL,quote_id uuid NOT NULL,
  request_index integer NOT NULL CHECK(request_index BETWEEN 0 AND 99),portion_id uuid NOT NULL,product_id uuid NOT NULL,
  standard_minor bigint NOT NULL CHECK(standard_minor BETWEEN 0 AND 9007199254740991),
  discount_minor bigint NOT NULL CHECK(discount_minor>=0 AND discount_minor<=standard_minor),
  line_fingerprint text NOT NULL CHECK(line_fingerprint~'^[0-9a-f]{64}$'),benefit_id uuid,
  PRIMARY KEY(tenant_id,store_id,quote_id,request_index),UNIQUE(tenant_id,store_id,quote_id,portion_id),
  FOREIGN KEY(tenant_id,store_id,quote_id) REFERENCES mbox.checkout_coupon_quotes(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,portion_id) REFERENCES mbox.guest_shared_cart_portions(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,product_id) REFERENCES mbox.products(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,benefit_id) REFERENCES mbox.benefits(tenant_id,store_id,id),
  CHECK(benefit_id IS NOT NULL OR discount_minor=0)
);
CREATE INDEX checkout_coupon_quotes_cart ON mbox.checkout_coupon_quotes(tenant_id,store_id,cart_id,cart_version);
CREATE TABLE mbox.checkout_coupon_quote_seals(
  tenant_id uuid NOT NULL,store_id uuid NOT NULL,quote_id uuid NOT NULL,sealed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,store_id,quote_id),
  FOREIGN KEY(tenant_id,store_id,quote_id) REFERENCES mbox.checkout_coupon_quotes(tenant_id,store_id,id)
);
CREATE FUNCTION mbox.validate_checkout_coupon_quote() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM mbox.guest_shared_carts c WHERE c.tenant_id=NEW.tenant_id AND c.store_id=NEW.store_id AND c.id=NEW.cart_id AND c.table_session_id=NEW.table_session_id AND c.generation=NEW.cart_generation AND c.version=NEW.cart_version AND c.status='open') THEN RAISE EXCEPTION 'Quote requires exact current open cart version'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION mbox.validate_checkout_coupon_quote_line() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM mbox.checkout_coupon_quote_seals WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND quote_id=NEW.quote_id) THEN RAISE EXCEPTION 'Sealed quote cannot accept additional lines'; END IF;
  IF NOT EXISTS(SELECT 1 FROM mbox.checkout_coupon_quotes q JOIN mbox.guest_shared_cart_portions p ON p.tenant_id=q.tenant_id AND p.store_id=q.store_id AND p.cart_id=q.cart_id WHERE q.tenant_id=NEW.tenant_id AND q.store_id=NEW.store_id AND q.id=NEW.quote_id AND p.id=NEW.portion_id AND p.product_id=NEW.product_id AND p.removed_at IS NULL) THEN RAISE EXCEPTION 'Quote line must identify its current cart portion'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION mbox.check_checkout_coupon_quote_totals() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE quote_id uuid; q mbox.checkout_coupon_quotes; count_lines integer; total_standard numeric;total_discount numeric;first_index integer;last_index integer;
BEGIN
  IF TG_TABLE_NAME='checkout_coupon_quotes' THEN quote_id=NEW.id; ELSE quote_id=NEW.quote_id; END IF;
  SELECT * INTO q FROM mbox.checkout_coupon_quotes WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=quote_id;
  IF NOT EXISTS(SELECT 1 FROM mbox.checkout_coupon_quote_seals s WHERE s.tenant_id=q.tenant_id AND s.store_id=q.store_id AND s.quote_id=q.id) THEN RAISE EXCEPTION 'Quote must be sealed in its creation transaction'; END IF;
  SELECT count(*),sum(l.standard_minor),sum(l.discount_minor),min(l.request_index),max(l.request_index) INTO count_lines,total_standard,total_discount,first_index,last_index FROM mbox.checkout_coupon_quote_lines l WHERE l.tenant_id=NEW.tenant_id AND l.store_id=NEW.store_id AND l.quote_id=q.id;
  IF count_lines<1 OR count_lines>100 OR total_standard<>q.subtotal_minor OR total_discount<>q.discount_minor OR first_index<>0 OR last_index<>count_lines-1 THEN RAISE EXCEPTION 'Quote requires complete exact line allocation'; END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER validate_checkout_coupon_quote BEFORE INSERT ON mbox.checkout_coupon_quotes FOR EACH ROW EXECUTE FUNCTION mbox.validate_checkout_coupon_quote();
CREATE TRIGGER validate_checkout_coupon_quote_line BEFORE INSERT ON mbox.checkout_coupon_quote_lines FOR EACH ROW EXECUTE FUNCTION mbox.validate_checkout_coupon_quote_line();
CREATE CONSTRAINT TRIGGER checkout_coupon_quote_totals AFTER INSERT ON mbox.checkout_coupon_quotes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mbox.check_checkout_coupon_quote_totals();
CREATE CONSTRAINT TRIGGER checkout_coupon_quote_line_totals AFTER INSERT ON mbox.checkout_coupon_quote_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mbox.check_checkout_coupon_quote_totals();
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['checkout_coupon_quotes','checkout_coupon_quote_lines','checkout_coupon_quote_seals'] LOOP
    EXECUTE format('CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON mbox.%I FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change()',name);
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY tenant_store_isolation ON mbox.%I USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',name);
    EXECUTE format('REVOKE ALL ON mbox.%I FROM PUBLIC,mbox_runtime',name);
    EXECUTE format('GRANT SELECT,INSERT ON mbox.%I TO mbox_runtime',name);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION mbox.validate_checkout_coupon_quote(),mbox.validate_checkout_coupon_quote_line(),mbox.check_checkout_coupon_quote_totals() FROM PUBLIC;
UPDATE mbox.normalized_schema_metadata SET schema_version='173',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
