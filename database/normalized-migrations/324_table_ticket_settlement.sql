BEGIN;
SET LOCAL lock_timeout='3s';

-- One purchase snapshot links the approved offer to the original payment path.
CREATE TABLE mbox.table_ticket_purchases (
  tenant_id uuid NOT NULL, store_id uuid NOT NULL, registration_id uuid NOT NULL,
  offer_id uuid NOT NULL, quantity integer NOT NULL CHECK(quantity>0),
  membership_id uuid NOT NULL, contact_id uuid NOT NULL,
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL CHECK(ends_at>starts_at),
  PRIMARY KEY(tenant_id,store_id,registration_id),
  FOREIGN KEY(tenant_id,store_id,registration_id) REFERENCES mbox.community_activity_registrations(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,offer_id) REFERENCES mbox.table_ticket_offers(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,membership_id) REFERENCES mbox.customer_memberships(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,contact_id) REFERENCES mbox.customer_verified_contacts(tenant_id,store_id,id)
);
CREATE TABLE mbox.table_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL, store_id uuid NOT NULL, registration_id uuid NOT NULL, ordinal integer NOT NULL CHECK(ordinal>0),
  payment_id uuid NOT NULL, paid_at timestamptz NOT NULL,
  point_lot_id uuid, reservation_lock_id uuid,
  UNIQUE(tenant_id,store_id,id), UNIQUE(tenant_id,store_id,registration_id,ordinal),
  UNIQUE(tenant_id,store_id,point_lot_id), UNIQUE(tenant_id,store_id,reservation_lock_id),
  FOREIGN KEY(tenant_id,store_id,registration_id) REFERENCES mbox.table_ticket_purchases(tenant_id,store_id,registration_id),
  FOREIGN KEY(tenant_id,store_id,payment_id) REFERENCES mbox.payments(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,point_lot_id) REFERENCES mbox.loyalty_point_lots(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,reservation_lock_id) REFERENCES mbox.reservation_table_locks(tenant_id,store_id,id)
);
CREATE TABLE mbox.checkout_point_portion_sources (
  tenant_id uuid NOT NULL,store_id uuid NOT NULL,quote_id uuid NOT NULL,portion_id uuid NOT NULL,
  lot_id uuid NOT NULL,amount_minor bigint NOT NULL CHECK(amount_minor>0),
  PRIMARY KEY(tenant_id,store_id,quote_id,portion_id,lot_id),
  FOREIGN KEY(tenant_id,store_id,quote_id,lot_id) REFERENCES mbox.checkout_point_lots(tenant_id,store_id,quote_id,lot_id),
  FOREIGN KEY(tenant_id,store_id,quote_id,portion_id) REFERENCES mbox.checkout_coupon_quote_lines(tenant_id,store_id,quote_id,portion_id)
);
CREATE FUNCTION mbox.table_ticket_expiry(paid_at timestamptz)
RETURNS timestamptz LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT (((paid_at AT TIME ZONE 'Asia/Shanghai')::date + interval '1 year' + interval '1 day') AT TIME ZONE 'Asia/Shanghai')
$$;
ALTER TABLE mbox.loyalty_point_lots DROP CONSTRAINT loyalty_point_lots_source_type_check,
  ADD CONSTRAINT loyalty_point_lots_source_type_check CHECK(source_type IN('order','supplement','adjust','restore','legacy_balance','promotion','table_ticket'));
ALTER TABLE mbox.loyalty_point_lot_movements DROP CONSTRAINT loyalty_point_lot_movements_source_type_check,
  ADD CONSTRAINT loyalty_point_lot_movements_source_type_check CHECK(source_type IN('order','refund','redemption','supplement','manual','system','legacy_balance','promotion','table_ticket'));

DO $$ DECLARE tbl text; BEGIN
  FOREACH tbl IN ARRAY ARRAY['table_ticket_purchases','table_tickets','checkout_point_portion_sources'] LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',tbl);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',tbl);
    EXECUTE format('CREATE POLICY scoped ON mbox.%I USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',tbl);
    EXECUTE format('GRANT SELECT,INSERT ON mbox.%I TO mbox_runtime',tbl);
  END LOOP;
END $$;
GRANT UPDATE(point_lot_id,reservation_lock_id) ON mbox.table_tickets TO mbox_runtime;
CREATE TRIGGER table_ticket_purchase_history BEFORE UPDATE OR DELETE ON mbox.table_ticket_purchases
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
CREATE TRIGGER checkout_point_portion_history BEFORE UPDATE OR DELETE ON mbox.checkout_point_portion_sources
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
UPDATE mbox.normalized_schema_metadata SET schema_version='324',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
