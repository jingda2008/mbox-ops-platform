BEGIN;

-- Migration 129 correctly prevents new or advancing operational work after a
-- table session closes.  It also unintentionally prevented an authorized
-- manager from terminally cancelling a legacy KDS task that had escaped an
-- older close flow.  Keep the write lock, but allow only the exact task bound
-- by the manager-cancel command to move from an active state to cancelled.
CREATE OR REPLACE FUNCTION mbox.lock_kds_table_session_for_closure_fact_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, mbox
AS $$
DECLARE
  new_row jsonb := to_jsonb(NEW);
  old_row jsonb := CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
  table_session_id_value uuid;
  table_session_status text;
  should_lock boolean := false;
  closed_manager_cancel_allowed boolean := false;
BEGIN
  IF TG_OP='UPDATE'
    AND new_row->>'order_item_id' IS DISTINCT FROM old_row->>'order_item_id' THEN
    RAISE EXCEPTION 'KDS order-item ownership is immutable'
      USING ERRCODE='23514';
  END IF;

  should_lock := TG_OP='INSERT'
    OR new_row->>'status' IS DISTINCT FROM old_row->>'status';
  IF NOT should_lock THEN RETURN NEW; END IF;

  SELECT ordering.table_session_id INTO table_session_id_value
  FROM mbox.order_items AS item
  JOIN mbox.orders AS ordering
    ON ordering.tenant_id=item.tenant_id AND ordering.store_id=item.store_id
   AND ordering.id=item.order_id
  WHERE item.tenant_id=(new_row->>'tenant_id')::uuid
    AND item.store_id=(new_row->>'store_id')::uuid
    AND item.id=(new_row->>'order_item_id')::uuid;

  IF table_session_id_value IS NULL THEN
    RAISE EXCEPTION 'closure fact write has no authoritative table session: kds_tasks'
      USING ERRCODE='23514';
  END IF;

  SELECT session.status INTO table_session_status
  FROM mbox.table_sessions AS session
  WHERE session.tenant_id=(new_row->>'tenant_id')::uuid
    AND session.store_id=(new_row->>'store_id')::uuid
    AND session.id=table_session_id_value
  FOR SHARE;

  IF table_session_status IS NULL THEN
    RAISE EXCEPTION 'closure fact references an unavailable table session: %',table_session_id_value
      USING ERRCODE='23503';
  END IF;

  closed_manager_cancel_allowed := TG_OP='UPDATE'
    AND old_row->>'status' IN ('pending','accepted','preparing')
    AND new_row->>'status'='cancelled'
    AND COALESCE(current_setting('app.kds_manager_cancel_task_id',true),'')=new_row->>'id'
    AND (
      new_row - ARRAY['status','assigned_employee_id','cancelled_at','updated_at','worker_locked_by','worker_locked_at']
    ) IS NOT DISTINCT FROM (
      old_row - ARRAY['status','assigned_employee_id','cancelled_at','updated_at','worker_locked_by','worker_locked_at']
    );

  IF table_session_status NOT IN ('open','closing')
    AND NOT closed_manager_cancel_allowed THEN
    RAISE EXCEPTION 'cannot create or change table work after the table session is closed'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER kds_tasks_closure_fact_write_lock ON mbox.kds_tasks;
CREATE TRIGGER kds_tasks_closure_fact_write_lock
  BEFORE INSERT OR UPDATE ON mbox.kds_tasks
  FOR EACH ROW EXECUTE FUNCTION mbox.lock_kds_table_session_for_closure_fact_write();

REVOKE ALL ON FUNCTION mbox.lock_kds_table_session_for_closure_fact_write() FROM PUBLIC;

UPDATE mbox.normalized_schema_metadata
SET schema_version='162',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
