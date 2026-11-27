BEGIN;
SET LOCAL lock_timeout='3s';
CREATE TABLE mbox.ticket_dining_sessions (
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,ticket_id uuid NOT NULL,session_id uuid NOT NULL,
 linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,store_id,ticket_id), UNIQUE(tenant_id,store_id,session_id),
 FOREIGN KEY(tenant_id,store_id,ticket_id) REFERENCES mbox.table_tickets(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,session_id) REFERENCES mbox.table_sessions(tenant_id,store_id,id)
);
ALTER TABLE mbox.ticket_dining_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.ticket_dining_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_scope ON mbox.ticket_dining_sessions USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
 WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
GRANT SELECT,INSERT ON mbox.ticket_dining_sessions TO mbox_runtime;
-- Ticket entitlement follows the admitted reservation's actual seated session,
-- including transfers. An earlier party at the same physical table cannot qualify.
CREATE FUNCTION mbox.session_dining_ticket(t uuid,s uuid,session_id uuid) RETURNS uuid
LANGUAGE sql STABLE STRICT AS $$
 SELECT d.ticket_id FROM mbox.ticket_dining_sessions d WHERE (d.tenant_id,d.store_id,d.session_id)=(t,s,$3)
 UNION ALL SELECT k.id FROM mbox.reservation_seating_sessions seat
 JOIN mbox.reservation_seating_batches b ON (b.tenant_id,b.store_id,b.id)=(seat.tenant_id,seat.store_id,seat.batch_id)
 JOIN mbox.reservation_table_locks l ON (l.tenant_id,l.store_id,l.reservation_id,l.table_id)=(b.tenant_id,b.store_id,b.reservation_id,seat.table_id_at_seating)
 JOIN mbox.table_tickets k ON (k.tenant_id,k.store_id,k.reservation_lock_id)=(l.tenant_id,l.store_id,l.id)
 WHERE (seat.tenant_id,seat.store_id,seat.table_session_id)=(t,s,session_id)
 AND (k.refunded_at IS NULL OR k.refunded_at>b.seated_at)
 LIMIT 1
$$;
CREATE TABLE mbox.dining_day_rules (
 tenant_id uuid NOT NULL, store_id uuid NOT NULL, business_date date NOT NULL,
 minimum_enabled boolean NOT NULL, ticket_enabled boolean NOT NULL, revision integer NOT NULL CHECK (revision>0),
 PRIMARY KEY (tenant_id,store_id,business_date),
 FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id)
);
ALTER TABLE mbox.dining_day_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.dining_day_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY dining_day_scope ON mbox.dining_day_rules
 USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
 WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
GRANT SELECT,INSERT,UPDATE ON mbox.dining_day_rules TO mbox_runtime;
-- With no explicit day rule, ordinary tables use their opening amount and ticket tables qualify.
CREATE FUNCTION mbox.session_dining_flags(t uuid,s uuid,sid uuid) RETURNS TABLE(minimum_enabled boolean,ticket_enabled boolean)
LANGUAGE sql STABLE STRICT AS $$
 SELECT coalesce(d.minimum_enabled,true),coalesce(d.ticket_enabled,true) FROM mbox.table_sessions ss
 LEFT JOIN mbox.dining_day_rules d USING(tenant_id,store_id,business_date)
 WHERE (ss.tenant_id,ss.store_id,ss.id)=(t,s,sid)
$$;
CREATE FUNCTION mbox.valid_dining_buyer(t uuid,s uuid,sid uuid,buyer uuid) RETURNS boolean
LANGUAGE sql STABLE STRICT AS $$
 SELECT EXISTS(SELECT 1 FROM mbox.table_tickets k
 JOIN mbox.table_ticket_purchases p USING(tenant_id,store_id,registration_id)
 JOIN mbox.community_activity_registrations r ON (r.tenant_id,r.store_id,r.id)=(k.tenant_id,k.store_id,k.registration_id)
 LEFT JOIN mbox.ticket_reschedule_offers m ON (m.tenant_id,m.store_id,m.id)=(k.tenant_id,k.store_id,k.reschedule_id)
 JOIN mbox.community_activities a ON a.id=coalesce(m.activity_id,r.activity_id)
 WHERE (k.tenant_id,k.store_id,k.id)=(t,s,mbox.session_dining_ticket(t,s,sid))
 AND mbox.canonical_customer_id(t,s,r.customer_id)=mbox.canonical_customer_id(t,s,buyer)
 AND r.status IN ('confirmed','checked_in') AND r.payment_status='paid' AND k.refunded_at IS NULL
 AND a.status IN ('published','completed') AND statement_timestamp()>=coalesce(m.starts_at,p.starts_at)
 AND statement_timestamp()<coalesce(m.ends_at,p.ends_at)
 AND NOT EXISTS(SELECT 1 FROM mbox.table_ticket_refund_requests f WHERE f.ticket_id=k.id AND f.status NOT IN ('cancelled','rejected')))
$$;
CREATE FUNCTION mbox.session_dining_minimum(t uuid,s uuid,session_id uuid,original bigint) RETURNS bigint
LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN original=0 OR NOT minimum_enabled OR (ticket_enabled AND mbox.session_dining_ticket(t,s,session_id) IS NOT NULL) THEN 0 ELSE original END FROM mbox.session_dining_flags(t,s,session_id)
$$;
CREATE FUNCTION mbox.session_dining_mode(t uuid,s uuid,session_id uuid,mode text) RETURNS text
LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN mode='prepaid' AND (NOT minimum_enabled OR (ticket_enabled AND mbox.session_dining_ticket(t,s,session_id) IS NOT NULL))
 AND NOT EXISTS(SELECT 1 FROM mbox.payments p WHERE (p.tenant_id,p.store_id,p.prepaid_table_session_id)=(t,s,session_id)
 AND (p.status IN ('created','pending') OR mbox.prepayment_available(t,s,p.id)>0))
 THEN 'order_gate' ELSE mode END FROM mbox.session_dining_flags(t,s,session_id)
$$;
GRANT EXECUTE ON FUNCTION mbox.session_dining_ticket(uuid,uuid,uuid),mbox.session_dining_minimum(uuid,uuid,uuid,bigint),
 mbox.session_dining_mode(uuid,uuid,uuid,text) TO mbox_runtime;
DROP TRIGGER open_optional_dining ON mbox.table_sessions;
DROP FUNCTION mbox.open_optional_dining();
DO $$ DECLARE d text;
BEGIN
 d:=pg_get_functiondef('mbox.snapshot_transfer_minimum()'::regprocedure);
 d:=replace(d,'OLD.effective_minimum_spend_minor,new_minimum','mbox.session_dining_minimum(OLD.tenant_id,OLD.store_id,OLD.id,OLD.effective_minimum_spend_minor),new_minimum');
 EXECUTE replace(d,'mbox.ticket_store_minimum(NEW.tenant_id,NEW.store_id,','mbox.session_dining_minimum(NEW.tenant_id,NEW.store_id,NEW.id,');
 d:=pg_get_functiondef('mbox.table_prepayment_unsettled(uuid,uuid,uuid)'::regprocedure);
 EXECUTE replace(d,'mbox.ticket_store_minimum(t,s,','mbox.session_dining_minimum(t,s,session_id,');
END $$;
-- The current ticket desk follows the same bill after a whole-table transfer.
CREATE OR REPLACE FUNCTION mbox.ticket_seating(t uuid,s uuid,lock_id uuid)
RETURNS TABLE(table_id uuid,active boolean) LANGUAGE sql STABLE AS $$
 SELECT ss.table_id,ss.status IN ('open','closing') FROM mbox.table_tickets k
 JOIN mbox.ticket_dining_sessions d ON (d.tenant_id,d.store_id,d.ticket_id)=(k.tenant_id,k.store_id,k.id)
 JOIN mbox.table_sessions ss ON (ss.tenant_id,ss.store_id,ss.id)=(d.tenant_id,d.store_id,d.session_id)
 WHERE (k.tenant_id,k.store_id,k.reservation_lock_id)=(t,s,lock_id)
 UNION
 SELECT ss.table_id,ss.status IN ('open','closing') FROM mbox.reservation_table_locks l
 JOIN mbox.reservation_seating_batches b ON (b.tenant_id,b.store_id,b.reservation_id)=(l.tenant_id,l.store_id,l.reservation_id)
 JOIN mbox.reservation_seating_sessions seat ON (seat.tenant_id,seat.store_id,seat.batch_id,seat.table_id_at_seating)=(b.tenant_id,b.store_id,b.id,l.table_id)
 JOIN mbox.table_sessions ss ON (ss.tenant_id,ss.store_id,ss.id)=(seat.tenant_id,seat.store_id,seat.table_session_id)
 WHERE (l.tenant_id,l.store_id,l.id)=(t,s,lock_id)
$$;
CREATE OR REPLACE FUNCTION mbox.ticket_current_table(t uuid,s uuid,lock_id uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN EXISTS(SELECT 1 FROM mbox.ticket_seating(t,s,lock_id)) THEN
 (SELECT seat.table_id FROM mbox.ticket_seating(t,s,lock_id) seat WHERE active LIMIT 1)
 WHEN l.status IN ('held','confirmed') THEN l.table_id END
 FROM mbox.reservation_table_locks l WHERE (l.tenant_id,l.store_id,l.id)=(t,s,lock_id)
$$;
-- A store-level lookup can no longer waive a table minimum.
CREATE OR REPLACE FUNCTION mbox.ticket_store_minimum(t uuid,s uuid,original bigint) RETURNS bigint
LANGUAGE sql IMMUTABLE AS $$ SELECT original $$;
UPDATE mbox.normalized_schema_metadata SET schema_version='376',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
