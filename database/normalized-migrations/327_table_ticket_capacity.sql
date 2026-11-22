BEGIN;
SET LOCAL lock_timeout='3s';

-- Whole-table capacity uses complete time ranges, not tables available at a
-- single instant. Existing physical bookings and a seated table count once.
CREATE FUNCTION mbox.table_ticket_area_remaining(t uuid,s uuid,area uuid,starts timestamptz,ends timestamptz)
RETURNS integer LANGUAGE sql STABLE AS $$
 WITH physical AS (
   SELECT tab.id FROM mbox.tables tab JOIN mbox.areas a ON (a.tenant_id,a.store_id,a.id)=(tab.tenant_id,tab.store_id,tab.area_id)
   WHERE tab.tenant_id=t AND tab.store_id=s AND tab.area_id=area AND tab.status='available' AND a.status='active'
     AND NOT EXISTS(SELECT 1 FROM mbox.reservation_table_locks l WHERE l.tenant_id=t AND l.store_id=s AND l.table_id=tab.id
       AND l.status IN('held','confirmed') AND l.reserved_during && tstzrange(starts,ends,'[)'))
     AND NOT EXISTS(SELECT 1 FROM mbox.table_sessions sess WHERE sess.tenant_id=t AND sess.store_id=s AND sess.table_id=tab.id
       AND sess.status IN('open','closing') AND sess.opened_at<ends AND starts<=clock_timestamp())
 ), promised AS (
   SELECT p.quantity-(SELECT count(*) FROM mbox.table_tickets k JOIN mbox.reservation_table_locks l
     ON (l.tenant_id,l.store_id,l.id)=(k.tenant_id,k.store_id,k.reservation_lock_id)
     WHERE (k.tenant_id,k.store_id,k.registration_id)=(p.tenant_id,p.store_id,p.registration_id)
       AND l.status IN('held','confirmed') AND l.reserved_during @> tstzrange(p.starts_at,p.ends_at,'[)')) qty
   FROM mbox.table_ticket_purchases p JOIN mbox.table_ticket_offers o ON (o.tenant_id,o.store_id,o.id)=(p.tenant_id,p.store_id,p.offer_id)
   JOIN mbox.community_activity_registrations r ON (r.tenant_id,r.store_id,r.id)=(p.tenant_id,p.store_id,p.registration_id)
   WHERE p.tenant_id=t AND p.store_id=s AND o.area_id=area AND tstzrange(p.starts_at,p.ends_at,'[)') && tstzrange(starts,ends,'[)')
     AND r.status IN('payment_pending','confirmed','checked_in')
 )
 SELECT ((SELECT count(*) FROM physical)-(SELECT coalesce(sum(qty),0) FROM promised))::integer
$$;
REVOKE ALL ON FUNCTION mbox.table_ticket_area_remaining(uuid,uuid,uuid,timestamptz,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.table_ticket_area_remaining(uuid,uuid,uuid,timestamptz,timestamptz) TO mbox_runtime;
UPDATE mbox.normalized_schema_metadata SET schema_version='327',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
