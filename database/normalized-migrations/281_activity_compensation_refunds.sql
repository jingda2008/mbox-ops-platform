BEGIN;
-- Financial compensation does not erase admitted guests or food already produced.
ALTER TABLE mbox.community_activity_registrations
  ADD COLUMN service_refund_disposition text,
  ADD CONSTRAINT activity_compensation_disposition CHECK(service_refund_disposition IS NULL OR (service_version=3 AND service_refund_disposition IN('retain_fulfillment','stop_unstarted')));
ALTER TABLE mbox.refunds
  ADD COLUMN activity_disposition text,
  ADD COLUMN activity_customer_confirmed boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT activity_refund_disposition CHECK(activity_disposition IS NULL OR (activity_disposition IN('retain_fulfillment','stop_unstarted') AND activity_customer_confirmed AND requested_by_employee_id IS NOT NULL AND requested_by_customer_id IS NULL));
CREATE FUNCTION mbox.guard_activity_refund_disposition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.activity_disposition IS DISTINCT FROM OLD.activity_disposition OR NEW.activity_customer_confirmed IS DISTINCT FROM OLD.activity_customer_confirmed THEN
  RAISE EXCEPTION 'activity refund agreement is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER activity_refund_disposition_immutable BEFORE UPDATE ON mbox.refunds FOR EACH ROW EXECUTE FUNCTION mbox.guard_activity_refund_disposition();

CREATE OR REPLACE FUNCTION mbox.guard_activity_kds_source() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='UPDATE' AND (NEW.activity_service_line_id IS DISTINCT FROM OLD.activity_service_line_id OR NEW.order_item_id IS DISTINCT FROM OLD.order_item_id) THEN RAISE EXCEPTION 'KDS source is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.activity_service_line_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM mbox.activity_service_lines line JOIN mbox.community_activity_registrations registration
   ON (registration.tenant_id,registration.store_id,registration.id)=(line.tenant_id,line.store_id,line.registration_id)
  WHERE (line.tenant_id,line.store_id,line.id)=(NEW.tenant_id,NEW.store_id,NEW.activity_service_line_id)
   AND line.station_code=NEW.station_code AND line.quantity=NEW.quantity
   AND (NEW.status IN('cancelled','failed') OR ((registration.payment_status='paid'
    OR (registration.payment_status='not_required' AND registration.fee_amount_minor=0)
    OR (registration.payment_status='refunded' AND registration.service_refund_disposition IS NOT NULL))
    AND registration.status IN('confirmed','checked_in')))
 ) THEN RAISE EXCEPTION 'activity KDS requires paid redeemed source or approved retained compensation' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
UPDATE mbox.normalized_schema_metadata SET schema_version='281',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
