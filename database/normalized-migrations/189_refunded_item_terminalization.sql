BEGIN;

-- Preserve the closed-session write barrier. Permit only a status-only terminal
-- correction supported by a refunded order and original manager cancellation.
DO $migration$
DECLARE
  definition text;
  needle text := $needle$    WHEN 'order_items' THEN$needle$;
  replacement text := $replacement$    WHEN 'order_items' THEN
      closed_write_allowed := TG_OP='UPDATE'
        AND old_row->>'status'='submitted' AND new_row->>'status'='cancelled'
        AND (new_row - 'status' - 'updated_at') = (old_row - 'status' - 'updated_at')
        AND EXISTS (
          SELECT 1 FROM mbox.orders ordering
          WHERE ordering.tenant_id=(new_row->>'tenant_id')::uuid
            AND ordering.store_id=(new_row->>'store_id')::uuid
            AND ordering.id=(new_row->>'order_id')::uuid AND ordering.payment_status='refunded'
        )
        AND EXISTS (
          SELECT 1 FROM mbox.kds_tasks task JOIN mbox.kds_task_events event
            ON event.tenant_id=task.tenant_id AND event.store_id=task.store_id AND event.kds_task_id=task.id
          WHERE task.tenant_id=(new_row->>'tenant_id')::uuid AND task.store_id=(new_row->>'store_id')::uuid
            AND task.order_item_id=(new_row->>'id')::uuid AND task.status='cancelled'
            AND event.event_type='task.cancelled' AND event.actor_employee_id IS NOT NULL
            AND event.metadata->>'source'='manager_exception_api'
        )
        AND NOT EXISTS (
          SELECT 1 FROM mbox.kds_tasks task
          WHERE task.tenant_id=(new_row->>'tenant_id')::uuid AND task.store_id=(new_row->>'store_id')::uuid
            AND task.order_item_id=(new_row->>'id')::uuid AND task.status<>'cancelled'
        );$replacement$;
BEGIN
  SELECT pg_get_functiondef('mbox.lock_table_session_for_closure_fact_write()'::regprocedure) INTO definition;
  IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Missing order-item closure guard'; END IF;
  EXECUTE replace(definition,needle,replacement);
END;
$migration$;

UPDATE mbox.normalized_schema_metadata SET schema_version='189',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
