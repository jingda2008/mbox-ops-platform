BEGIN;

-- Physical table release does not resolve a complaint. Preserve its original
-- task, session and history for an authorized manager, including at day cutoff.
DO $complaints$
DECLARE signature text; definition text;
  original text := $old$AND task.table_session_id=p_table_session_id
      AND task.status IN ('pending','acknowledged','in_progress')$old$;
  replacement text := $new$AND task.table_session_id=p_table_session_id
      AND task.task_type <> 'guest.complaint'
      AND task.status IN ('pending','acknowledged','in_progress')$new$;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'mbox.close_table_after_customer_left(uuid,uuid,date,text,text,character)',
    'mbox.close_table_after_automatic_cutoff(uuid,uuid,date,text,text,character)'
  ] LOOP
    definition := pg_get_functiondef(signature::regprocedure);
    IF array_length(string_to_array(definition,original),1) <> 2 THEN
      RAISE EXCEPTION 'turnover task cancellation does not match the expected baseline: %',signature
        USING ERRCODE='55000';
    END IF;
    EXECUTE replace(definition,original,replacement);
  END LOOP;
END $complaints$;

-- A retained complaint must also remain resolvable after table release. Only
-- the original complaint's forward workflow fields may change; no new closed
-- table work, reassociation, rewritten complaint or terminal reopening is allowed.
DO $resolution$
DECLARE definition text;
  original text := $old$    WHEN 'service_tasks' THEN
      should_lock := TG_OP='INSERT'
        OR new_row->>'status' IS DISTINCT FROM old_row->>'status';
      table_session_id_value := (new_row->>'table_session_id')::uuid;$old$;
  replacement text := $new$    WHEN 'service_tasks' THEN
      IF TG_OP='UPDATE' AND old_row->>'task_type'='guest.complaint'
        AND (new_row - ARRAY['status','priority','assigned_employee_id','backup_employee_id','acknowledged_at','completed_at','cancelled_at','updated_at','worker_locked_by','worker_locked_at','next_action_at','escalate_at'])
          IS DISTINCT FROM (old_row - ARRAY['status','priority','assigned_employee_id','backup_employee_id','acknowledged_at','completed_at','cancelled_at','updated_at','worker_locked_by','worker_locked_at','next_action_at','escalate_at']) THEN
        RAISE EXCEPTION 'original complaint identity and content are immutable' USING ERRCODE='23514';
      END IF;
      should_lock := TG_OP='INSERT'
        OR new_row->>'status' IS DISTINCT FROM old_row->>'status'
        OR (TG_OP='UPDATE' AND old_row->>'task_type'='guest.complaint');
      closed_write_allowed := TG_OP='UPDATE'
        AND old_row->>'task_type'='guest.complaint'
        AND CASE old_row->>'status'
          WHEN 'pending' THEN new_row->>'status' IN ('pending','acknowledged','in_progress','completed','cancelled')
          WHEN 'acknowledged' THEN new_row->>'status' IN ('acknowledged','in_progress','completed','cancelled')
          WHEN 'in_progress' THEN new_row->>'status' IN ('in_progress','completed','cancelled')
          ELSE false END
        AND (new_row - ARRAY['status','priority','assigned_employee_id','backup_employee_id','acknowledged_at','completed_at','cancelled_at','updated_at','worker_locked_by','worker_locked_at','next_action_at','escalate_at'])
          IS NOT DISTINCT FROM (old_row - ARRAY['status','priority','assigned_employee_id','backup_employee_id','acknowledged_at','completed_at','cancelled_at','updated_at','worker_locked_by','worker_locked_at','next_action_at','escalate_at']);
      table_session_id_value := (new_row->>'table_session_id')::uuid;$new$;
BEGIN
  definition := pg_get_functiondef('mbox.lock_table_session_for_closure_fact_write()'::regprocedure);
  IF array_length(string_to_array(definition,original),1) <> 2 THEN
    RAISE EXCEPTION 'service task closure guard does not match the expected baseline' USING ERRCODE='55000';
  END IF;
  EXECUTE replace(definition,original,replacement);
END $resolution$;

UPDATE mbox.normalized_schema_metadata SET schema_version='230',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
