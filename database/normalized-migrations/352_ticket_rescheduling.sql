BEGIN;
CREATE TABLE mbox.ticket_reschedule_offers(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,ticket_id uuid NOT NULL,
 offer_id uuid NOT NULL,activity_id uuid NOT NULL,table_id uuid NOT NULL,starts_at timestamptz NOT NULL,ends_at timestamptz NOT NULL,
 reason text NOT NULL,proposed_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 status text NOT NULL DEFAULT 'proposed' CHECK(status IN('proposed','accepted','declined','superseded')),
 decided_at timestamptz,customer_id uuid,request_key text NOT NULL,
 UNIQUE(tenant_id,store_id,ticket_id,id),UNIQUE(tenant_id,store_id,proposed_by,request_key),
 FOREIGN KEY(tenant_id,store_id,ticket_id) REFERENCES mbox.table_tickets(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,offer_id) REFERENCES mbox.table_ticket_offers(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,activity_id) REFERENCES mbox.community_activities(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,table_id) REFERENCES mbox.tables(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,proposed_by) REFERENCES mbox.employees(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,customer_id) REFERENCES mbox.customers(tenant_id,store_id,id), CHECK(ends_at>starts_at)
);
CREATE UNIQUE INDEX one_pending_ticket_move ON mbox.ticket_reschedule_offers(tenant_id,store_id,ticket_id) WHERE status='proposed';
ALTER TABLE mbox.ticket_reschedule_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.ticket_reschedule_offers FORCE ROW LEVEL SECURITY;
CREATE POLICY scoped ON mbox.ticket_reschedule_offers USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
 WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
GRANT SELECT,INSERT,UPDATE(status,customer_id,decided_at) ON mbox.ticket_reschedule_offers TO mbox_runtime;
ALTER TABLE mbox.table_tickets ADD COLUMN reschedule_id uuid,
 ADD FOREIGN KEY(tenant_id,store_id,id,reschedule_id) REFERENCES mbox.ticket_reschedule_offers(tenant_id,store_id,ticket_id,id);
GRANT UPDATE(reschedule_id) ON mbox.table_tickets TO mbox_runtime;
-- The accepted replacement has its own full-capacity physical reservation.
-- Exclude precisely that ticket from the original anonymous promise.
DO $$ DECLARE d text; BEGIN
 d:=pg_get_functiondef('mbox.table_ticket_area_remaining(uuid,uuid,uuid,timestamptz,timestamptz)'::regprocedure);
 EXECUTE replace(replace(d,'AND ret.refunded_at IS NOT NULL','AND (ret.refunded_at IS NOT NULL OR ret.reschedule_id IS NOT NULL)'),
   'AND k.refunded_at IS NULL AND (l.status','AND k.refunded_at IS NULL AND k.reschedule_id IS NULL AND (l.status');
 d:=pg_get_functiondef('mbox.ticket_guests_committed(uuid,uuid,timestamptz,timestamptz)'::regprocedure);
 EXECUTE replace(replace(replace(d,'AND k.refunded_at IS NOT NULL','AND (k.refunded_at IS NOT NULL OR k.reschedule_id IS NOT NULL)'),
   'l.id=p.original_lock_id OR','(l.id=p.original_lock_id AND NOT EXISTS(SELECT 1 FROM mbox.table_tickets moved WHERE moved.registration_id=p.registration_id AND moved.ordinal=1 AND moved.reschedule_id IS NOT NULL)) OR'),
   'k.reservation_lock_id=l.id AND k.refunded_at IS NULL','k.reservation_lock_id=l.id AND k.refunded_at IS NULL AND k.reschedule_id IS NULL');
 d:=pg_get_functiondef('mbox.ticket_original_lock_in_use(uuid,uuid,uuid)'::regprocedure);
 EXECUTE replace(d,'k.ordinal=1 AND k.refunded_at IS NOT NULL','k.ordinal=1 AND (k.refunded_at IS NOT NULL OR k.reschedule_id IS NOT NULL)');
 d:=pg_get_functiondef('mbox.finish_ticket_case(uuid,uuid,uuid)'::regprocedure);
 EXECUTE replace(d,' AND r.public_id=''ticket-''||item.ticket_id::text',' AND r.id=(SELECT l.reservation_id FROM mbox.reservation_table_locks l WHERE l.id=item.reservation_lock_id)');
END $$;
CREATE FUNCTION mbox.ticket_event_committed(t uuid,s uuid,event uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT sum(coalesce(r.reserved_seats,r.party_size)-coalesce((r.reserved_seats/nullif(p.quantity,0))*
      (SELECT count(*) FROM mbox.table_tickets k WHERE k.registration_id=r.id AND (k.refunded_at IS NOT NULL OR k.reschedule_id IS NOT NULL)),0))
   FROM mbox.community_activity_registrations r LEFT JOIN mbox.table_ticket_purchases p ON(p.tenant_id,p.store_id,p.registration_id)=(r.tenant_id,r.store_id,r.id)
   WHERE r.tenant_id=t AND r.store_id=s AND r.activity_id=event AND r.status IN('reserved','payment_pending','confirmed','checked_in')),0)
 +coalesce((SELECT sum(r.reserved_seats/p.quantity) FROM mbox.table_tickets k JOIN mbox.ticket_reschedule_offers m ON m.id=k.reschedule_id
   JOIN mbox.table_ticket_purchases p ON p.registration_id=k.registration_id JOIN mbox.community_activity_registrations r ON r.id=p.registration_id
   WHERE k.tenant_id=t AND k.store_id=s AND m.activity_id=event AND k.refunded_at IS NULL),0)
$$;
UPDATE mbox.normalized_schema_metadata SET schema_version='352',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
