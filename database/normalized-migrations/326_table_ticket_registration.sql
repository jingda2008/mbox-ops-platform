BEGIN;
SET LOCAL lock_timeout='3s';
ALTER TABLE mbox.community_activity_registrations
  DROP CONSTRAINT community_activity_registrations_service_version_check,
  ADD CONSTRAINT community_activity_registrations_service_version_check CHECK(service_version IN(1,3,4)),
  DROP CONSTRAINT activity_service_shape,
  ADD CONSTRAINT activity_service_shape CHECK(service_version=1 OR
    (service_version=3 AND reserved_seats IS NOT NULL AND max_participants IS NOT NULL AND purchase_kind IS NOT NULL AND party_size<=max_participants)
    OR (service_version=4 AND membership_id IS NOT NULL AND max_participants IS NULL AND purchase_kind IS NULL AND reserved_seats IS NOT NULL AND reserved_seats>0)),
  DROP CONSTRAINT community_activity_registrations_reserved_seats_check,
  ADD CONSTRAINT community_activity_registrations_reserved_seats_check CHECK(reserved_seats>=0 AND (service_version=4 OR reserved_seats<=50)),
  DROP CONSTRAINT activity_service_admission_shape,
  ADD CONSTRAINT activity_service_admission_shape CHECK(service_version<>3 OR
    ((includes_admission AND purchase_kind='admission_package' AND reserved_seats=max_participants)
      OR (NOT includes_admission AND purchase_kind IN('meal_package','single_dish') AND reserved_seats=0 AND parent_registration_id IS NOT NULL)));
CREATE INDEX table_ticket_purchase_window ON mbox.table_ticket_purchases(tenant_id,store_id,starts_at,ends_at);
UPDATE mbox.normalized_schema_metadata SET schema_version='326',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
