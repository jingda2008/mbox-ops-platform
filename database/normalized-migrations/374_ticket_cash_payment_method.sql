BEGIN;
SET LOCAL lock_timeout='3s';
ALTER TABLE mbox.community_activity_registrations DROP CONSTRAINT community_activity_requested_payment_method_ck,
  ADD CONSTRAINT community_activity_requested_payment_method_ck CHECK (
    requested_payment_method IS NULL OR requested_payment_method IN ('jsapi','native_qr')
    OR (requested_payment_method='cash' AND service_version=4)
  ) NOT VALID;
ALTER TABLE mbox.community_activity_registrations VALIDATE CONSTRAINT community_activity_requested_payment_method_ck;
UPDATE mbox.normalized_schema_metadata SET schema_version='374', updated_at=clock_timestamp() WHERE singleton;
COMMIT;
