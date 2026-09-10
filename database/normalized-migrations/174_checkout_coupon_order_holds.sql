BEGIN;
ALTER TABLE mbox.pricing_authorizations ADD COLUMN checkout_quote_id uuid,
 ADD CONSTRAINT pricing_authorization_checkout_quote_fk FOREIGN KEY(tenant_id,store_id,checkout_quote_id) REFERENCES mbox.checkout_coupon_quotes(tenant_id,store_id,id);
ALTER TABLE mbox.pricing_authorizations DROP CONSTRAINT pricing_authorizations_source_type_check;
ALTER TABLE mbox.pricing_authorizations ADD CONSTRAINT pricing_authorizations_source_type_check CHECK(source_type IN('employee','benefit','checkout_quote'));
DO $$ DECLARE target text;matches integer; BEGIN
 SELECT count(*),min(conname) INTO matches,target FROM pg_constraint WHERE conrelid='mbox.pricing_authorizations'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%source_type%' AND pg_get_constraintdef(oid) LIKE '%role_approval_limit_id%';
 IF matches<>1 THEN RAISE EXCEPTION 'Expected one original pricing source integrity constraint'; END IF;
 EXECUTE format('ALTER TABLE mbox.pricing_authorizations DROP CONSTRAINT %I',target);
END $$;
ALTER TABLE mbox.pricing_authorizations ADD CONSTRAINT pricing_authorizations_source_integrity CHECK(
 (source_type='employee' AND authorized_by_employee_id IS NOT NULL AND capability IN('order.discount','order.gift') AND role_approval_limit_id=source_id AND benefit_id IS NULL AND checkout_quote_id IS NULL)
 OR(source_type='benefit' AND capability IS NULL AND benefit_id=source_id AND role_approval_limit_id IS NULL AND checkout_quote_id IS NULL)
 OR(source_type='checkout_quote' AND capability IS NULL AND authorized_by_employee_id IS NULL AND benefit_id IS NULL AND role_approval_limit_id IS NULL AND checkout_quote_id IS NOT NULL AND checkout_quote_id=source_id AND kind='discount')
);
CREATE UNIQUE INDEX pricing_authorizations_checkout_quote_once ON mbox.pricing_authorizations(tenant_id,store_id,checkout_quote_id) WHERE checkout_quote_id IS NOT NULL;
CREATE TABLE mbox.checkout_coupon_quote_reservations(
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,quote_id uuid NOT NULL,benefit_id uuid NOT NULL,reservation_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,store_id,quote_id,benefit_id),UNIQUE(tenant_id,store_id,reservation_id),
 FOREIGN KEY(tenant_id,store_id,quote_id) REFERENCES mbox.checkout_coupon_quotes(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,benefit_id) REFERENCES mbox.benefits(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,reservation_id) REFERENCES mbox.benefit_reservations(tenant_id,store_id,id)
);
CREATE TABLE mbox.checkout_coupon_order_links(
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,quote_id uuid NOT NULL,order_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,store_id,quote_id),UNIQUE(tenant_id,store_id,order_id),
 FOREIGN KEY(tenant_id,store_id,quote_id) REFERENCES mbox.checkout_coupon_quotes(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,order_id) REFERENCES mbox.orders(tenant_id,store_id,id)
);
CREATE FUNCTION mbox.validate_checkout_coupon_hold() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM mbox.benefit_reservations r JOIN mbox.checkout_coupon_quotes q ON q.tenant_id=r.tenant_id AND q.store_id=r.store_id AND q.table_session_id=r.table_session_id
  WHERE q.tenant_id=NEW.tenant_id AND q.store_id=NEW.store_id AND q.id=NEW.quote_id AND r.id=NEW.reservation_id AND r.benefit_id=NEW.benefit_id AND r.status='reserved'
   AND mbox.canonical_customer_id(r.tenant_id,r.store_id,r.customer_id)=mbox.canonical_customer_id(q.tenant_id,q.store_id,q.customer_id)
   AND r.quantity=(SELECT count(*) FROM mbox.checkout_coupon_quote_lines l WHERE l.tenant_id=q.tenant_id AND l.store_id=q.store_id AND l.quote_id=q.id AND l.benefit_id=r.benefit_id)) THEN RAISE EXCEPTION 'Coupon hold must match exact quote customer and quantity'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION mbox.validate_checkout_coupon_order_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM mbox.checkout_coupon_quotes q JOIN mbox.orders o ON o.tenant_id=q.tenant_id AND o.store_id=q.store_id AND o.table_session_id=q.table_session_id
  JOIN mbox.pricing_authorizations a ON a.tenant_id=q.tenant_id AND a.store_id=q.store_id AND a.checkout_quote_id=q.id AND a.order_id=o.id AND a.status='consumed'
  WHERE q.tenant_id=NEW.tenant_id AND q.store_id=NEW.store_id AND q.id=NEW.quote_id AND o.id=NEW.order_id AND o.total_amount_minor=q.payable_minor AND o.discount_amount_minor=q.discount_minor AND o.currency=q.currency)
  OR EXISTS(SELECT 1 FROM mbox.checkout_coupon_quote_lines l WHERE l.tenant_id=NEW.tenant_id AND l.store_id=NEW.store_id AND l.quote_id=NEW.quote_id AND l.benefit_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM mbox.checkout_coupon_quote_reservations r WHERE r.tenant_id=l.tenant_id AND r.store_id=l.store_id AND r.quote_id=l.quote_id AND r.benefit_id=l.benefit_id)) THEN RAISE EXCEPTION 'Coupon order requires matching consumed price authority and all holds'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER validate_checkout_coupon_hold BEFORE INSERT ON mbox.checkout_coupon_quote_reservations FOR EACH ROW EXECUTE FUNCTION mbox.validate_checkout_coupon_hold();
CREATE TRIGGER validate_checkout_coupon_order_link BEFORE INSERT ON mbox.checkout_coupon_order_links FOR EACH ROW EXECUTE FUNCTION mbox.validate_checkout_coupon_order_link();
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['checkout_coupon_quote_reservations','checkout_coupon_order_links'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON mbox.%I FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change()',name);
  EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY tenant_store_isolation ON mbox.%I USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',name);
  EXECUTE format('REVOKE ALL ON mbox.%I FROM PUBLIC,mbox_runtime',name);
  EXECUTE format('GRANT SELECT,INSERT ON mbox.%I TO mbox_runtime',name);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION mbox.validate_checkout_coupon_hold(),mbox.validate_checkout_coupon_order_link() FROM PUBLIC;
UPDATE mbox.normalized_schema_metadata SET schema_version='174',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
