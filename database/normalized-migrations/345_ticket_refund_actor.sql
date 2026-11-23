BEGIN;
CREATE OR REPLACE FUNCTION mbox.guard_activity_customer_refund_actor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='UPDATE' AND (NEW.requested_by_employee_id IS DISTINCT FROM OLD.requested_by_employee_id OR NEW.requested_by_customer_id IS DISTINCT FROM OLD.requested_by_customer_id) THEN
  RAISE EXCEPTION 'Refund requester is immutable' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' AND NEW.requested_by_customer_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM mbox.payments p JOIN mbox.community_activity_registrations r
    ON r.tenant_id=p.tenant_id AND r.store_id=p.store_id AND r.id=p.activity_registration_id
  WHERE p.tenant_id=NEW.tenant_id AND p.store_id=NEW.store_id AND p.id=NEW.payment_id
    AND p.payable_kind='activity_registration' AND p.status='succeeded' AND (r.service_version=3 OR mbox.unissued_late_ticket_payment(p.tenant_id,p.store_id,p.id))
    AND NEW.amount_minor=p.amount_minor AND NEW.currency=p.currency
    AND mbox.canonical_customer_id(r.tenant_id,r.store_id,r.customer_id)=mbox.canonical_customer_id(NEW.tenant_id,NEW.store_id,NEW.requested_by_customer_id)
 ) THEN RAISE EXCEPTION 'Customer refund must reference their full original activity payment' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
UPDATE mbox.normalized_schema_metadata SET schema_version='345',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
