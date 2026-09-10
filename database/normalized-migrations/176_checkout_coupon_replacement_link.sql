BEGIN;
ALTER TABLE mbox.checkout_coupon_refund_decisions DROP CONSTRAINT checkout_coupon_refund_decisions_action_check;
ALTER TABLE mbox.checkout_coupon_refund_decisions
 ADD CONSTRAINT checkout_coupon_refund_decisions_action_check CHECK(action IN('no_return','external_compensation','replacement_coupon')),
 ADD COLUMN replacement_benefit_id uuid,
 ADD COLUMN replacement_quantity integer,
 ADD CONSTRAINT coupon_refund_replacement_fk FOREIGN KEY(tenant_id,store_id,replacement_benefit_id) REFERENCES mbox.benefits(tenant_id,store_id,id),
 ADD CONSTRAINT coupon_refund_replacement_shape CHECK(
  (action='replacement_coupon' AND replacement_benefit_id IS NOT NULL AND replacement_quantity IS NOT NULL AND replacement_quantity>0)
  OR(action<>'replacement_coupon' AND replacement_benefit_id IS NULL AND replacement_quantity IS NULL));
CREATE UNIQUE INDEX coupon_refund_replacement_once ON mbox.checkout_coupon_refund_decisions(tenant_id,store_id,replacement_benefit_id) WHERE replacement_benefit_id IS NOT NULL;
CREATE FUNCTION mbox.validate_checkout_coupon_replacement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.action='replacement_coupon' AND NOT EXISTS(
  SELECT 1 FROM mbox.benefit_reservations original
  JOIN mbox.refunds refund ON refund.tenant_id=original.tenant_id AND refund.store_id=original.store_id AND refund.id=NEW.refund_id
  JOIN mbox.benefits replacement ON replacement.tenant_id=original.tenant_id AND replacement.store_id=original.store_id AND replacement.id=NEW.replacement_benefit_id
  WHERE original.tenant_id=NEW.tenant_id AND original.store_id=NEW.store_id AND original.id=NEW.reservation_id
   AND replacement.id<>original.benefit_id
   AND mbox.canonical_customer_id(replacement.tenant_id,replacement.store_id,replacement.customer_id)=mbox.canonical_customer_id(original.tenant_id,original.store_id,original.customer_id)
   AND replacement.created_at>=refund.created_at AND replacement.status='issued'
   AND replacement.quantity_reserved=0 AND replacement.quantity_redeemed=0 AND replacement.quantity_total=NEW.replacement_quantity
   AND replacement.valid_from<=clock_timestamp() AND (replacement.valid_until IS NULL OR replacement.valid_until>clock_timestamp())
 ) THEN RAISE EXCEPTION 'Replacement must be a new unused issued coupon for the same customer after this refund request'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER validate_checkout_coupon_replacement BEFORE INSERT ON mbox.checkout_coupon_refund_decisions FOR EACH ROW EXECUTE FUNCTION mbox.validate_checkout_coupon_replacement();
REVOKE ALL ON FUNCTION mbox.validate_checkout_coupon_replacement() FROM PUBLIC;
UPDATE mbox.normalized_schema_metadata SET schema_version='176',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
