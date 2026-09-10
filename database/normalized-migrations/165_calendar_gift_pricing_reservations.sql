BEGIN;
-- Legacy single-use authorizations keep their original uniqueness. New calendar
-- gifts are unique per authoritative reservation, not once for an entire card.
ALTER TABLE mbox.pricing_authorizations ADD COLUMN benefit_reservation_id uuid;
ALTER TABLE mbox.pricing_authorizations ADD CONSTRAINT pricing_benefit_reservation_fk
  FOREIGN KEY(tenant_id,store_id,benefit_reservation_id) REFERENCES mbox.benefit_reservations(tenant_id,store_id,id);
ALTER TABLE mbox.pricing_authorizations ADD CONSTRAINT pricing_reservation_gift_only
  CHECK(benefit_reservation_id IS NULL OR (source_type='benefit' AND kind='gift'));
DROP INDEX mbox.pricing_authorizations_benefit_once_per_table_uq;
CREATE UNIQUE INDEX pricing_authorizations_benefit_once_per_table_uq
  ON mbox.pricing_authorizations(tenant_id,store_id,table_session_id,source_type,source_id)
  WHERE source_type='benefit' AND benefit_reservation_id IS NULL;
CREATE UNIQUE INDEX pricing_authorizations_benefit_reservation_uq
  ON mbox.pricing_authorizations(tenant_id,store_id,benefit_reservation_id)
  WHERE benefit_reservation_id IS NOT NULL;
CREATE FUNCTION mbox.guard_calendar_gift_pricing_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_type='benefit' AND NEW.benefit_reservation_id IS NULL AND EXISTS(
    SELECT 1 FROM mbox.benefit_coupon_calendar_bindings b
    WHERE b.tenant_id=NEW.tenant_id AND b.store_id=NEW.store_id AND b.benefit_id=NEW.benefit_id
  ) THEN
    RAISE EXCEPTION 'Calendar gift pricing requires its counted reservation' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND NEW.benefit_reservation_id IS DISTINCT FROM OLD.benefit_reservation_id THEN
    RAISE EXCEPTION 'Pricing reservation reference is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.benefit_reservation_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM mbox.benefit_reservations r
    JOIN mbox.benefit_coupon_calendar_bindings b ON b.tenant_id=r.tenant_id AND b.store_id=r.store_id AND b.benefit_id=r.benefit_id
    JOIN mbox.benefit_coupon_calendar_usage u ON u.tenant_id=r.tenant_id AND u.store_id=r.store_id AND u.reservation_id=r.id AND u.version_id=b.version_id
    WHERE r.tenant_id=NEW.tenant_id AND r.store_id=NEW.store_id AND r.id=NEW.benefit_reservation_id
      AND r.benefit_id=NEW.benefit_id AND r.table_session_id=NEW.table_session_id
  ) THEN
    RAISE EXCEPTION 'Pricing reservation does not match calendar gift' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pricing_calendar_reservation_guard BEFORE INSERT OR UPDATE ON mbox.pricing_authorizations
FOR EACH ROW EXECUTE FUNCTION mbox.guard_calendar_gift_pricing_reservation();
UPDATE mbox.normalized_schema_metadata SET schema_version='165',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
