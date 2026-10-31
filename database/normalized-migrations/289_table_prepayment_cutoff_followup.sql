BEGIN;
ALTER TABLE mbox.table_prepayment_turnovers ALTER COLUMN employee_id DROP NOT NULL;
DO $$ DECLARE definition text;target regprocedure;needle text:='  UPDATE mbox.table_sessions'; BEGIN
 FOREACH target IN ARRAY ARRAY['mbox.close_table_after_customer_left(uuid,uuid,date,text,text,character)'::regprocedure,'mbox.close_table_after_automatic_cutoff(uuid,uuid,date,text,text,character)'::regprocedure] LOOP
 definition:=pg_get_functiondef(target);
 IF position(needle IN definition)=0 THEN RAISE EXCEPTION 'Turnover guard target missing';END IF;
 definition:=replace(definition,needle,'  pending_payments:=pending_payments+(SELECT count(*)::integer FROM mbox.payments WHERE (tenant_id,store_id,prepaid_table_session_id)=(tenant_scope,store_scope,p_table_session_id) AND status IN (''created'',''pending''));
'||CASE WHEN target::text LIKE '%automatic_cutoff%' THEN '  INSERT INTO mbox.table_prepayment_turnovers(tenant_id,store_id,table_session_id,employee_id,reason)
    SELECT tenant_scope,store_scope,p_table_session_id,NULL,btrim(p_reason_note)
    WHERE EXISTS(SELECT 1 FROM mbox.table_sessions WHERE (tenant_id,store_id,id)=(tenant_scope,store_scope,p_table_session_id) AND minimum_spend_mode=''prepaid'') ON CONFLICT DO NOTHING;
' ELSE '' END||needle);
 EXECUTE definition;
 END LOOP;
END $$;
UPDATE mbox.normalized_schema_metadata SET schema_version='289',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
