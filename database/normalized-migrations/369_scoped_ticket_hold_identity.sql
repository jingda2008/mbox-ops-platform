BEGIN;
SET LOCAL lock_timeout='3s';

-- A private pre-assignment, not a guest-facing table assignment. Its physical
-- exclusion is provided by the linked reservation lock, never this registry.
-- No historical tickets, reservations or offer statuses are updated.
CREATE TABLE mbox.scoped_ticket_hold_identity (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  registration_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK(ordinal>0),
  reservation_lock_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,store_id,registration_id,ordinal),
  UNIQUE(tenant_id,store_id,reservation_lock_id),
  FOREIGN KEY(tenant_id,store_id,registration_id)
    REFERENCES mbox.table_ticket_purchases(tenant_id,store_id,registration_id),
  FOREIGN KEY(tenant_id,store_id,reservation_lock_id)
    REFERENCES mbox.reservation_table_locks(tenant_id,store_id,id)
);
ALTER TABLE mbox.scoped_ticket_hold_identity ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.scoped_ticket_hold_identity FORCE ROW LEVEL SECURITY;
CREATE POLICY scoped ON mbox.scoped_ticket_hold_identity
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());

-- Only isolated foundation code binds reservations for now. This does not
-- permit publishing selected desks or start acquiring live holds.
CREATE FUNCTION mbox.check_scoped_ticket_hold_identity()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,mbox AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM mbox.table_ticket_purchases p
      JOIN mbox.table_ticket_offers o
        ON (o.tenant_id,o.store_id,o.id)=(p.tenant_id,p.store_id,p.offer_id)
      JOIN mbox.reservation_table_locks l
        ON (l.tenant_id,l.store_id,l.id)=(p.tenant_id,p.store_id,NEW.reservation_lock_id)
      JOIN mbox.reservations b
        ON (b.tenant_id,b.store_id,b.id)=(l.tenant_id,l.store_id,l.reservation_id)
      JOIN mbox.tables d ON (d.tenant_id,d.store_id,d.id)=(l.tenant_id,l.store_id,l.table_id)
      JOIN mbox.areas a ON (a.tenant_id,a.store_id,a.id)=(d.tenant_id,d.store_id,d.area_id)
      JOIN mbox.ticket_table_roster r ON (r.tenant_id,r.store_id,r.table_id)=(d.tenant_id,d.store_id,d.id)
      JOIN mbox.community_activity_registrations c
        ON (c.tenant_id,c.store_id,c.id)=(p.tenant_id,p.store_id,p.registration_id)
    WHERE (p.tenant_id,p.store_id,p.registration_id)=(NEW.tenant_id,NEW.store_id,NEW.registration_id)
      AND NEW.ordinal BETWEEN 1 AND p.quantity
      AND c.status='payment_pending'
      AND b.source='integration' AND b.status='pending' AND b.customer_id=c.customer_id
      AND b.reservation_snapshot @> jsonb_build_object(
        'scopedTicketHold',jsonb_build_object('registrationId',NEW.registration_id,'ordinal',NEW.ordinal))
      AND (b.arrival_at,b.expected_end_at)=(p.starts_at,p.ends_at)
      AND l.status='held' AND l.hold_expires_at>statement_timestamp()
      AND l.hold_expires_at<=c.seat_hold_expires_at
      AND l.reserved_during=tstzrange(p.starts_at,p.ends_at,'[)')
      AND d.status='available' AND a.status='active' AND d.area_id=o.area_id
      AND NOT EXISTS (
        SELECT 1 FROM mbox.table_ticket_purchases existing
        WHERE (existing.tenant_id,existing.store_id,existing.original_lock_id)=(l.tenant_id,l.store_id,l.id)
      )
      AND NOT EXISTS (
        SELECT 1 FROM mbox.table_tickets existing
        WHERE (existing.tenant_id,existing.store_id,existing.reservation_lock_id)=(l.tenant_id,l.store_id,l.id)
      )
  ) THEN
    RAISE EXCEPTION USING MESSAGE='Scoped ticket physical hold does not match a pending ticket unit', ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER scoped_ticket_hold_identity_valid BEFORE INSERT ON mbox.scoped_ticket_hold_identity
  FOR EACH ROW EXECUTE FUNCTION mbox.check_scoped_ticket_hold_identity();
CREATE TRIGGER scoped_ticket_hold_identity_history BEFORE UPDATE OR DELETE ON mbox.scoped_ticket_hold_identity
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
GRANT SELECT,INSERT ON mbox.scoped_ticket_hold_identity TO mbox_runtime;
UPDATE mbox.normalized_schema_metadata SET schema_version='369',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
