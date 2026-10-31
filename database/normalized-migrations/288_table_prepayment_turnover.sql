BEGIN;
-- Physical turnover keeps an immutable financial follow-up on the old session.
-- Only the existing authorized SECURITY DEFINER turnover function can insert it.
CREATE TABLE mbox.table_prepayment_turnovers (
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,table_session_id uuid NOT NULL,employee_id uuid NOT NULL,
 reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,store_id,table_session_id),
 FOREIGN KEY(tenant_id,store_id,table_session_id) REFERENCES mbox.table_sessions(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
ALTER TABLE mbox.table_prepayment_turnovers ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.table_prepayment_turnovers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.table_prepayment_turnovers USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
REVOKE ALL ON mbox.table_prepayment_turnovers FROM PUBLIC,mbox_runtime;
GRANT SELECT ON mbox.table_prepayment_turnovers TO mbox_runtime;
CREATE TRIGGER immutable_turnover BEFORE UPDATE OR DELETE ON mbox.table_prepayment_turnovers FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
DO $$ DECLARE definition text;needle text:='  UPDATE mbox.table_sessions'; BEGIN
 definition:=pg_get_functiondef('mbox.close_table_after_customer_left(uuid,uuid,date,text,text,character)'::regprocedure);
 IF position(needle IN definition)=0 THEN RAISE EXCEPTION 'Turnover guard target missing';END IF;
 definition:=replace(definition,needle,'  INSERT INTO mbox.table_prepayment_turnovers(tenant_id,store_id,table_session_id,employee_id,reason)
    SELECT tenant_scope,store_scope,p_table_session_id,p_actor_employee_id,btrim(p_reason_note)
    WHERE EXISTS(SELECT 1 FROM mbox.table_sessions WHERE (tenant_id,store_id,id)=(tenant_scope,store_scope,p_table_session_id) AND minimum_spend_mode=''prepaid'') ON CONFLICT DO NOTHING;
'||needle);
 EXECUTE definition;
 definition:=pg_get_functiondef('mbox.guard_table_minimum_settlement()'::regprocedure);
 definition:=replace(definition,'AND mbox.table_prepayment_unsettled(NEW.tenant_id,NEW.store_id,NEW.id) THEN','AND mbox.table_prepayment_unsettled(NEW.tenant_id,NEW.store_id,NEW.id) AND NOT EXISTS(SELECT 1 FROM mbox.table_prepayment_turnovers turnover WHERE (turnover.tenant_id,turnover.store_id,turnover.table_session_id)=(NEW.tenant_id,NEW.store_id,NEW.id)) THEN');
 EXECUTE definition;
END $$;
UPDATE mbox.normalized_schema_metadata SET schema_version='288',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
