BEGIN;
ALTER TABLE mbox.refunds ADD COLUMN purpose text
 CHECK(purpose IN ('return_goods','price_adjustment','service_compensation','duplicate_payment'));
COMMENT ON COLUMN mbox.refunds.purpose IS 'Financial purpose; null preserves legacy semantics. Compensation, difference and duplicate collection do not cancel goods or restore stock.';
CREATE FUNCTION mbox.protect_refund_purpose() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.purpose IS DISTINCT FROM OLD.purpose THEN
  RAISE EXCEPTION 'refund purpose is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER refunds_immutable_purpose BEFORE UPDATE OF purpose ON mbox.refunds
FOR EACH ROW EXECUTE FUNCTION mbox.protect_refund_purpose();
UPDATE mbox.normalized_schema_metadata SET schema_version='200',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
