BEGIN;
-- A portion identity survives editing and another device's reads. Removing
-- then re-adding quantity must never reuse the removed identity.
CREATE TABLE mbox.guest_shared_cart_portions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
  cart_id uuid NOT NULL,line_id uuid NOT NULL,product_id uuid NOT NULL,
  ordinal bigint NOT NULL CHECK(ordinal>=0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),removed_at timestamptz,
  UNIQUE(tenant_id,store_id,id),UNIQUE(tenant_id,store_id,line_id,ordinal),
  FOREIGN KEY(tenant_id,store_id,cart_id) REFERENCES mbox.guest_shared_carts(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,product_id) REFERENCES mbox.products(tenant_id,store_id,id)
);
CREATE INDEX guest_cart_portions_active ON mbox.guest_shared_cart_portions(tenant_id,store_id,line_id,ordinal) WHERE removed_at IS NULL;
-- Only editable legacy carts need fresh portion identities. Historical closed
-- carts keep their existing order evidence; don't invent historical identities.
INSERT INTO mbox.guest_shared_cart_portions(tenant_id,store_id,cart_id,line_id,product_id,ordinal)
 SELECT l.tenant_id,l.store_id,l.cart_id,l.id,l.product_id,n FROM mbox.guest_shared_cart_lines l
 JOIN mbox.guest_shared_carts c ON c.tenant_id=l.tenant_id AND c.store_id=l.store_id AND c.id=l.cart_id AND c.status='open'
 CROSS JOIN LATERAL generate_series(0,l.quantity-1)n;
CREATE FUNCTION mbox.validate_guest_cart_portion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Removed portion identity must be retained'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.removed_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM mbox.guest_shared_cart_lines l JOIN mbox.guest_shared_carts c ON c.tenant_id=l.tenant_id AND c.store_id=l.store_id AND c.id=l.cart_id WHERE l.tenant_id=NEW.tenant_id AND l.store_id=NEW.store_id AND l.id=NEW.line_id AND l.cart_id=NEW.cart_id AND l.product_id=NEW.product_id AND c.status='open') THEN RAISE EXCEPTION 'Portion requires current open cart line'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL OR (to_jsonb(NEW)-'removed_at') IS DISTINCT FROM (to_jsonb(OLD)-'removed_at') THEN RAISE EXCEPTION 'Portion identity is immutable and cannot be reused'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_guest_cart_portion BEFORE INSERT OR UPDATE OR DELETE ON mbox.guest_shared_cart_portions FOR EACH ROW EXECUTE FUNCTION mbox.validate_guest_cart_portion();
CREATE FUNCTION mbox.sync_guest_cart_portions() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE active_count integer;last_ordinal bigint;
BEGIN
  IF TG_OP='DELETE' THEN
    UPDATE mbox.guest_shared_cart_portions SET removed_at=clock_timestamp() WHERE tenant_id=OLD.tenant_id AND store_id=OLD.store_id AND line_id=OLD.id AND removed_at IS NULL;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND ROW(NEW.id,NEW.tenant_id,NEW.store_id,NEW.cart_id,NEW.product_id) IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.store_id,OLD.cart_id,OLD.product_id) THEN RAISE EXCEPTION 'Cart line identity cannot change'; END IF;
  SELECT count(*)::int INTO active_count FROM mbox.guest_shared_cart_portions WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND line_id=NEW.id AND removed_at IS NULL;
  IF active_count>NEW.quantity THEN
    UPDATE mbox.guest_shared_cart_portions SET removed_at=clock_timestamp() WHERE id IN(SELECT id FROM mbox.guest_shared_cart_portions WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND line_id=NEW.id AND removed_at IS NULL ORDER BY ordinal DESC LIMIT active_count-NEW.quantity);
  ELSIF active_count<NEW.quantity THEN
    SELECT COALESCE(max(ordinal),-1) INTO last_ordinal FROM mbox.guest_shared_cart_portions WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND line_id=NEW.id;
    INSERT INTO mbox.guest_shared_cart_portions(tenant_id,store_id,cart_id,line_id,product_id,ordinal)
      SELECT NEW.tenant_id,NEW.store_id,NEW.cart_id,NEW.id,NEW.product_id,last_ordinal+n FROM generate_series(1,NEW.quantity-active_count)n;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sync_guest_cart_portions AFTER INSERT OR UPDATE OR DELETE ON mbox.guest_shared_cart_lines FOR EACH ROW EXECUTE FUNCTION mbox.sync_guest_cart_portions();
CREATE FUNCTION mbox.check_guest_cart_portion_count() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected integer;actual integer;
BEGIN
  SELECT quantity INTO expected FROM mbox.guest_shared_cart_lines WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.line_id;
  SELECT count(*)::int INTO actual FROM mbox.guest_shared_cart_portions WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND line_id=NEW.line_id AND removed_at IS NULL;
  IF actual<>COALESCE(expected,0) THEN RAISE EXCEPTION 'Cart portion count does not match line quantity'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER check_guest_cart_portion_count AFTER INSERT OR UPDATE ON mbox.guest_shared_cart_portions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mbox.check_guest_cart_portion_count();
ALTER TABLE mbox.guest_shared_cart_portions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.guest_shared_cart_portions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.guest_shared_cart_portions USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
REVOKE ALL ON mbox.guest_shared_cart_portions FROM PUBLIC,mbox_runtime;
GRANT SELECT,INSERT,UPDATE ON mbox.guest_shared_cart_portions TO mbox_runtime;
REVOKE ALL ON FUNCTION mbox.validate_guest_cart_portion(),mbox.sync_guest_cart_portions(),mbox.check_guest_cart_portion_count() FROM PUBLIC;
UPDATE mbox.normalized_schema_metadata SET schema_version='170',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
