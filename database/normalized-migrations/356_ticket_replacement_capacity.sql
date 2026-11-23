BEGIN;
CREATE FUNCTION mbox.ticket_lock_active(t uuid,s uuid,lock_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM mbox.reservation_table_locks l
   WHERE (l.tenant_id,l.store_id,l.id)=(t,s,lock_id)
   AND (l.status IN('held','confirmed') OR (l.status='released' AND mbox.ticket_seated_at_original_table(t,s,l.reservation_id,l.table_id))))
$$;
-- Expiration of the linked reservation must not discard the still-valid ticket's promise.
CREATE FUNCTION mbox.unassigned_moved_tickets(t uuid,s uuid,starts timestamptz,ends timestamptz)
 RETURNS TABLE(area_id uuid,seats integer) LANGUAGE sql STABLE AS $$
 SELECT o.area_id,r.reserved_seats/p.quantity
 FROM mbox.table_tickets k JOIN mbox.ticket_reschedule_offers m ON m.id=k.reschedule_id
 JOIN mbox.table_ticket_offers o ON o.id=m.offer_id JOIN mbox.table_ticket_purchases p ON p.registration_id=k.registration_id
 JOIN mbox.community_activity_registrations r ON r.id=p.registration_id
 WHERE k.tenant_id=t AND k.store_id=s AND k.refunded_at IS NULL AND tstzrange(m.starts_at,m.ends_at,'[)') && tstzrange(starts,ends,'[)')
 AND NOT mbox.ticket_lock_active(t,s,k.reservation_lock_id)
$$;
DO $$ DECLARE d text; BEGIN
 d:=pg_get_functiondef('mbox.table_ticket_area_remaining(uuid,uuid,uuid,timestamptz,timestamptz)'::regprocedure);
 EXECUTE replace(d,'(SELECT coalesce(sum(qty),0) FROM promised)','(SELECT coalesce(sum(qty),0) FROM promised)-(SELECT count(*) FROM mbox.unassigned_moved_tickets(t,s,starts,ends) extra WHERE extra.area_id=area)');
 d:=pg_get_functiondef('mbox.ticket_guests_committed(uuid,uuid,timestamptz,timestamptz)'::regprocedure);
 EXECUTE replace(d,'SELECT coalesce(sum(greatest','SELECT (SELECT coalesce(sum(extra.seats),0) FROM mbox.unassigned_moved_tickets(t,s,starts,ends) extra)+coalesce(sum(greatest');
 d:=pg_get_functiondef('mbox.check_ticket_capacity()'::regprocedure);
 EXECUTE replace(d,chr(10)||' LOOP',chr(10)||' UNION SELECT m.starts_at,m.ends_at,o.area_id FROM mbox.table_tickets k
   JOIN mbox.ticket_reschedule_offers m ON m.id=k.reschedule_id JOIN mbox.table_ticket_offers o ON o.id=m.offer_id
   WHERE k.tenant_id=NEW.tenant_id AND k.store_id=NEW.store_id AND k.refunded_at IS NULL AND m.ends_at>clock_timestamp()
 LOOP');
END $$;
UPDATE mbox.normalized_schema_metadata SET schema_version='356',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
