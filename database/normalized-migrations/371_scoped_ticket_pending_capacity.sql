BEGIN;
SET LOCAL lock_timeout='3s';

-- A legacy area-wide offer returns NULL; a scoped offer with no eligible desks returns {}.
CREATE FUNCTION mbox.ticket_assignable_desk_ids(t uuid,s uuid,offer uuid)
RETURNS uuid[] LANGUAGE sql STABLE AS $$
  SELECT ARRAY(
    SELECT desk.id FROM mbox.tables desk JOIN mbox.ticket_table_roster roster
      ON (roster.tenant_id,roster.store_id,roster.table_id)=(desk.tenant_id,desk.store_id,desk.id)
    JOIN mbox.areas area ON (area.tenant_id,area.store_id,area.id)=(desk.tenant_id,desk.store_id,desk.area_id)
    WHERE (desk.tenant_id,desk.store_id,desk.area_id)=(frozen.tenant_id,frozen.store_id,frozen.area_id)
      AND desk.id=ANY(frozen.table_ids) AND desk.status='available' AND area.status='active'
    ORDER BY desk.code,desk.id)
  FROM mbox.scoped_ticket_offer_membership frozen WHERE (frozen.tenant_id,frozen.store_id,frozen.offer_id)=(t,s,offer)
$$;
REVOKE ALL ON FUNCTION mbox.ticket_assignable_desk_ids(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.ticket_assignable_desk_ids(uuid,uuid,uuid) TO mbox_runtime;

-- Physical exclusion already subtracts each held desk once. Only the same
-- unconverted pending unit may offset that desk in anonymous area promises.
CREATE FUNCTION mbox.scoped_pending_ticket_hold_credit(t uuid,s uuid,registration uuid)
RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT count(*)::int
  FROM mbox.scoped_ticket_hold_identity h
  JOIN mbox.table_ticket_purchases p
    ON (p.tenant_id,p.store_id,p.registration_id)=(h.tenant_id,h.store_id,h.registration_id)
  JOIN mbox.community_activity_registrations c
    ON (c.tenant_id,c.store_id,c.id)=(p.tenant_id,p.store_id,p.registration_id)
  JOIN mbox.scoped_ticket_offer_membership m
    ON (m.tenant_id,m.store_id,m.offer_id)=(p.tenant_id,p.store_id,p.offer_id)
  JOIN mbox.reservation_table_locks l
    ON (l.tenant_id,l.store_id,l.id)=(h.tenant_id,h.store_id,h.reservation_lock_id)
  JOIN mbox.reservations b
    ON (b.tenant_id,b.store_id,b.id)=(l.tenant_id,l.store_id,l.reservation_id)
  JOIN mbox.tables d ON (d.tenant_id,d.store_id,d.id)=(l.tenant_id,l.store_id,l.table_id)
  JOIN mbox.areas a ON (a.tenant_id,a.store_id,a.id)=(d.tenant_id,d.store_id,d.area_id)
  JOIN mbox.ticket_table_roster roster ON (roster.tenant_id,roster.store_id,roster.table_id)=(d.tenant_id,d.store_id,d.id)
  WHERE (h.tenant_id,h.store_id,h.registration_id)=(t,s,registration)
    AND h.ordinal BETWEEN 1 AND p.quantity
    AND c.status='payment_pending' AND c.seat_hold_expires_at>statement_timestamp()
    AND l.status='held' AND l.hold_expires_at>statement_timestamp()
    AND l.hold_expires_at<=c.seat_hold_expires_at
    AND l.reserved_during=tstzrange(p.starts_at,p.ends_at,'[)')
    AND b.status='pending' AND b.source='integration' AND b.customer_id=c.customer_id
    AND b.reservation_snapshot @> jsonb_build_object('scopedTicketHold',
      jsonb_build_object('registrationId',h.registration_id,'ordinal',h.ordinal))
    AND d.area_id=m.area_id AND d.id=ANY(m.table_ids) AND d.status='available' AND a.status='active'
    AND NOT EXISTS (SELECT 1 FROM mbox.table_tickets unit
      WHERE (unit.tenant_id,unit.store_id,unit.registration_id,unit.ordinal)=(t,s,registration,h.ordinal)
        AND (unit.reservation_lock_id IS NOT NULL OR unit.refunded_at IS NOT NULL OR unit.reschedule_id IS NOT NULL))
    AND NOT (h.ordinal=1 AND p.original_lock_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM mbox.reservation_table_locks original
      WHERE (original.tenant_id,original.store_id,original.id)=(t,s,p.original_lock_id)
        AND original.status IN ('held','confirmed')
        AND original.reserved_during @> tstzrange(p.starts_at,p.ends_at,'[)')
    ))
$$;
REVOKE ALL ON FUNCTION mbox.scoped_pending_ticket_hold_credit(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.scoped_pending_ticket_hold_credit(uuid,uuid,uuid) TO mbox_runtime;
DO $$
DECLARE original text; changed text;
BEGIN
  original:=pg_get_functiondef('mbox.table_ticket_area_remaining(uuid,uuid,uuid,timestamptz,timestamptz)'::regprocedure);
  changed:=replace(original,'SELECT p.quantity-','SELECT p.quantity-CASE WHEN r.status=''payment_pending'' AND p.offer_id IN
    (SELECT frozen.offer_id FROM mbox.scoped_ticket_offer_membership frozen WHERE frozen.tenant_id=t AND frozen.store_id=s)
    THEN mbox.scoped_pending_ticket_hold_credit(p.tenant_id,p.store_id,p.registration_id) ELSE 0 END-');
  IF changed=original THEN RAISE EXCEPTION 'Scoped pending hold capacity anchor missing'; END IF;
  EXECUTE changed;
END $$;
UPDATE mbox.normalized_schema_metadata SET schema_version='371',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
