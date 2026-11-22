BEGIN;
ALTER TABLE mbox.table_ticket_purchases ADD COLUMN original_lock_id uuid,
 ADD FOREIGN KEY(tenant_id,store_id,original_lock_id) REFERENCES mbox.reservation_table_locks(tenant_id,store_id,id);
CREATE INDEX table_ticket_original_lock ON mbox.table_ticket_purchases(tenant_id,store_id,original_lock_id) WHERE original_lock_id IS NOT NULL;
CREATE FUNCTION mbox.ticket_original_lock_in_use(t uuid,s uuid,lock_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
SELECT EXISTS(SELECT 1 FROM mbox.table_ticket_purchases p JOIN mbox.community_activity_registrations r ON
 (r.tenant_id,r.store_id,r.id)=(p.tenant_id,p.store_id,p.registration_id)
 WHERE (p.tenant_id,p.store_id,p.original_lock_id)=(t,s,lock_id) AND r.status IN('payment_pending','confirmed','checked_in')
 AND NOT EXISTS(SELECT 1 FROM mbox.table_tickets k WHERE(k.tenant_id,k.store_id,k.registration_id)=(p.tenant_id,p.store_id,p.registration_id)
   AND k.ordinal=1 AND k.refunded_at IS NOT NULL))
 OR EXISTS(SELECT 1 FROM mbox.table_tickets k WHERE (k.tenant_id,k.store_id,k.reservation_lock_id)=(t,s,lock_id) AND k.refunded_at IS NULL)
$$;
DO $$ DECLARE d text;BEGIN
 d:=pg_get_functiondef('mbox.table_ticket_area_remaining(uuid,uuid,uuid,timestamptz,timestamptz)'::regprocedure);
 EXECUTE replace(d,'SELECT p.quantity-', 'SELECT p.quantity-
    CASE WHEN p.original_lock_id IS NOT NULL AND EXISTS(SELECT 1 FROM mbox.reservation_table_locks keep WHERE keep.id=p.original_lock_id
      AND keep.status IN(''held'',''confirmed'') AND keep.reserved_during @> tstzrange(p.starts_at,p.ends_at,''[)''))
      AND NOT EXISTS(SELECT 1 FROM mbox.table_tickets k WHERE(k.tenant_id,k.store_id,k.registration_id)=(p.tenant_id,p.store_id,p.registration_id)
        AND k.ordinal=1 AND (k.refunded_at IS NOT NULL OR k.reservation_lock_id IS NOT NULL)) THEN 1 ELSE 0 END-');
END $$;
CREATE FUNCTION mbox.ticket_guests_committed(t uuid,s uuid,starts timestamptz,ends timestamptz) RETURNS bigint LANGUAGE sql STABLE AS $$
 SELECT coalesce(sum(greatest(0, (r.reserved_seats/p.quantity)*(p.quantity-
   (SELECT count(*) FROM mbox.table_tickets k WHERE(k.tenant_id,k.store_id,k.registration_id)=(p.tenant_id,p.store_id,p.registration_id) AND k.refunded_at IS NOT NULL))
   -coalesce((SELECT sum(rs.guest_count) FROM mbox.reservations rs WHERE rs.tenant_id=t AND rs.store_id=s AND rs.status IN('confirmed','arrived','seated')
     AND EXISTS(SELECT 1 FROM mbox.reservation_table_locks l WHERE(l.tenant_id,l.store_id,l.reservation_id)=(rs.tenant_id,rs.store_id,rs.id)
     AND (l.id=p.original_lock_id OR EXISTS(SELECT 1 FROM mbox.table_tickets k WHERE(k.tenant_id,k.store_id,k.registration_id)=(p.tenant_id,p.store_id,p.registration_id)
       AND k.reservation_lock_id=l.id AND k.refunded_at IS NULL)))),0))),0)::bigint
 FROM mbox.table_ticket_purchases p JOIN mbox.community_activity_registrations r ON(r.tenant_id,r.store_id,r.id)=(p.tenant_id,p.store_id,p.registration_id)
 WHERE p.tenant_id=t AND p.store_id=s AND r.status IN('payment_pending','confirmed','checked_in')
 AND tstzrange(p.starts_at,p.ends_at,'[)') && tstzrange(starts,ends,'[)')
$$;
UPDATE mbox.normalized_schema_metadata SET schema_version='339',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
