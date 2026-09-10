BEGIN;
-- A financial refund is not authority to reissue a consumed benefit. Keep a
-- separate immutable decision for each refund and affected coupon hold.
CREATE TABLE mbox.checkout_coupon_refund_decisions(
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,refund_id uuid NOT NULL,reservation_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN('no_return','external_compensation')),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 2 AND 500),
 evidence_reference text NOT NULL CHECK(length(btrim(evidence_reference)) BETWEEN 2 AND 200),
 decided_by_employee_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,store_id,refund_id,reservation_id),
 FOREIGN KEY(tenant_id,store_id,refund_id) REFERENCES mbox.refunds(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,reservation_id) REFERENCES mbox.benefit_reservations(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,decided_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE FUNCTION mbox.validate_checkout_coupon_refund_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(
  SELECT 1 FROM mbox.refunds r JOIN mbox.payments p ON p.tenant_id=r.tenant_id AND p.store_id=r.store_id AND p.id=r.payment_id
  JOIN mbox.checkout_coupon_order_links l ON l.tenant_id=p.tenant_id AND l.store_id=p.store_id AND l.order_id=p.order_id
  JOIN mbox.checkout_coupon_quote_reservations h ON h.tenant_id=l.tenant_id AND h.store_id=l.store_id AND h.quote_id=l.quote_id
  JOIN mbox.benefit_reservations b ON b.tenant_id=h.tenant_id AND b.store_id=h.store_id AND b.id=h.reservation_id
  WHERE r.tenant_id=NEW.tenant_id AND r.store_id=NEW.store_id AND r.id=NEW.refund_id AND r.status='succeeded'
   AND b.id=NEW.reservation_id AND b.status IN('reserved','redeemed')
 ) THEN RAISE EXCEPTION 'Coupon review requires a succeeded refund and its actual order coupon hold'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER validate_checkout_coupon_refund_decision BEFORE INSERT ON mbox.checkout_coupon_refund_decisions FOR EACH ROW EXECUTE FUNCTION mbox.validate_checkout_coupon_refund_decision();
CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON mbox.checkout_coupon_refund_decisions FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
ALTER TABLE mbox.checkout_coupon_refund_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.checkout_coupon_refund_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.checkout_coupon_refund_decisions USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
REVOKE ALL ON mbox.checkout_coupon_refund_decisions FROM PUBLIC,mbox_runtime;
GRANT SELECT,INSERT ON mbox.checkout_coupon_refund_decisions TO mbox_runtime;
REVOKE ALL ON FUNCTION mbox.validate_checkout_coupon_refund_decision() FROM PUBLIC;
UPDATE mbox.normalized_schema_metadata SET schema_version='175',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
