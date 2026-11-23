BEGIN;
-- Follow the session created by seating this reservation, including transfers and departure.
CREATE FUNCTION mbox.ticket_seating(t uuid,s uuid,lock_id uuid)
 RETURNS TABLE(table_id uuid,active boolean) LANGUAGE sql STABLE AS $$
 SELECT session.table_id,session.status IN('open','closing')
 FROM mbox.reservation_table_locks l JOIN mbox.reservation_seating_batches b
   ON (b.tenant_id,b.store_id,b.reservation_id)=(l.tenant_id,l.store_id,l.reservation_id)
 JOIN mbox.reservation_seating_sessions seat ON (seat.tenant_id,seat.store_id,seat.batch_id,seat.table_id_at_seating)=(b.tenant_id,b.store_id,b.id,l.table_id)
 JOIN mbox.table_sessions session ON (session.tenant_id,session.store_id,session.id)=(seat.tenant_id,seat.store_id,seat.table_session_id)
 WHERE (l.tenant_id,l.store_id,l.id)=(t,s,lock_id)
$$;
CREATE FUNCTION mbox.ticket_current_table(t uuid,s uuid,lock_id uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN l.status IN('held','confirmed') THEN l.table_id
   WHEN l.status='released' THEN (SELECT seat.table_id FROM mbox.ticket_seating(t,s,l.id) seat WHERE seat.active LIMIT 1) END
 FROM mbox.reservation_table_locks l WHERE (l.tenant_id,l.store_id,l.id)=(t,s,lock_id)
$$;
CREATE OR REPLACE FUNCTION mbox.ticket_lock_active(t uuid,s uuid,lock_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT mbox.ticket_current_table(t,s,lock_id) IS NOT NULL
$$;
DO $$ DECLARE d text; marker text:='mbox.ticket_seated_at_original_table(t,s,l.reservation_id,l.table_id)';
BEGIN
 d:=pg_get_functiondef('mbox.table_ticket_area_remaining(uuid,uuid,uuid,timestamptz,timestamptz)'::regprocedure);
 IF position(marker IN d)=0 THEN RAISE EXCEPTION 'missing ticket seating offset'; END IF;
 EXECUTE replace(d,marker,'EXISTS(SELECT 1 FROM mbox.ticket_seating(t,s,l.id))');
 d:=pg_get_functiondef('mbox.unassigned_moved_tickets(uuid,uuid,timestamptz,timestamptz)'::regprocedure);
 EXECUTE replace(d,'AND NOT mbox.ticket_lock_active','AND NOT EXISTS(SELECT 1 FROM mbox.ticket_seating(t,s,k.reservation_lock_id)) AND NOT mbox.ticket_lock_active');
 d:=pg_get_functiondef('mbox.ticket_guests_committed(uuid,uuid,timestamptz,timestamptz)'::regprocedure);
 EXECUTE replace(d,'rs.status IN(''confirmed'',''arrived'',''seated'')','rs.status IN(''confirmed'',''arrived'',''seated'',''completed'')');
END $$;
UPDATE mbox.normalized_schema_metadata SET schema_version='359',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
