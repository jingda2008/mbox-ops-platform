BEGIN;

-- A package hold begins with the payment deadline. After the registration is
-- paid it becomes a fulfilment hold, so repair only current paid reservations
-- whose activity can still be delivered. Historical consumed/released rows
-- and any refund decision/execution in flight remain immutable here.
UPDATE mbox.community_activity_package_inventory_reservations reservation
SET expires_at=activity.ends_at,updated_at=clock_timestamp()
FROM mbox.community_activity_registrations registration
JOIN mbox.community_activities activity
  ON activity.tenant_id=registration.tenant_id AND activity.store_id=registration.store_id
 AND activity.id=registration.activity_id
WHERE reservation.tenant_id=registration.tenant_id AND reservation.store_id=registration.store_id
  AND reservation.registration_id=registration.id
  AND reservation.registration_cycle=registration.registration_cycle
  AND reservation.status='reserved'
  AND reservation.expires_at<activity.ends_at
  AND registration.status='confirmed' AND registration.payment_status='paid'
  AND activity.ends_at>clock_timestamp()
  AND NOT EXISTS (
    SELECT 1 FROM mbox.refunds refund
    WHERE refund.tenant_id=registration.tenant_id AND refund.store_id=registration.store_id
      AND refund.payment_id=registration.payment_id
      AND refund.status IN ('requested','approved','processing')
  );

UPDATE mbox.normalized_schema_metadata
SET schema_version='138',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
