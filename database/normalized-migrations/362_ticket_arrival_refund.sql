BEGIN;
-- Arrival is a front-desk registration. Only actual seating keeps a ticket-owned desk occupied after refund.
DO $$ DECLARE body text; previous text:='r.status IN(''pending'',''confirmed'')';
BEGIN
 body:=pg_get_functiondef('mbox.finish_ticket_case(uuid,uuid,uuid)'::regprocedure);
 IF array_length(string_to_array(body,previous),1)<>3 THEN RAISE EXCEPTION 'unexpected ticket reservation release rules'; END IF;
 EXECUTE replace(body,previous,'r.status IN(''pending'',''confirmed'',''arrived'')');
END $$;
CREATE INDEX table_tickets_active_reservation_lock ON mbox.table_tickets(tenant_id,store_id,reservation_lock_id)
 WHERE reservation_lock_id IS NOT NULL AND refunded_at IS NULL;
UPDATE mbox.normalized_schema_metadata SET schema_version='362',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
