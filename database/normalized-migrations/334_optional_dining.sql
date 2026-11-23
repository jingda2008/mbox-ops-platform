BEGIN;
-- A store adopting table ticket sales permits zero dining spend at every table.
CREATE FUNCTION mbox.ticket_store_minimum(t uuid,s uuid,original bigint) RETURNS bigint LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN EXISTS(SELECT 1 FROM mbox.table_ticket_offers o
   WHERE o.tenant_id=t AND o.store_id=s AND o.status='published') THEN 0 ELSE original END
$$;
CREATE INDEX table_ticket_published_store ON mbox.table_ticket_offers(tenant_id,store_id) WHERE status='published';
CREATE FUNCTION mbox.open_optional_dining() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF mbox.ticket_store_minimum(NEW.tenant_id,NEW.store_id,1)=0 THEN
   NEW.minimum_spend_minor:=0; NEW.minimum_spend_mode:='order_gate';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER open_optional_dining BEFORE INSERT ON mbox.table_sessions FOR EACH ROW EXECUTE FUNCTION mbox.open_optional_dining();
DO $$ DECLARE d text;BEGIN
 d:=pg_get_functiondef('mbox.snapshot_transfer_minimum()'::regprocedure);
 EXECUTE replace(d,'SELECT COALESCE(minimum_spend_minor,0) INTO','SELECT mbox.ticket_store_minimum(NEW.tenant_id,NEW.store_id,COALESCE(minimum_spend_minor,0)) INTO');
 d:=pg_get_functiondef('mbox.table_prepayment_unsettled(uuid,uuid,uuid)'::regprocedure);
 EXECUTE replace(d,'<session.effective_minimum_spend_minor','<mbox.ticket_store_minimum(t,s,session.effective_minimum_spend_minor)');
END $$;
UPDATE mbox.normalized_schema_metadata SET schema_version='334',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
