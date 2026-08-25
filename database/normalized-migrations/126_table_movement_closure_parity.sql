BEGIN;

-- Migration 096 owns the security-definer participant-movement command. The
-- production order lifecycle no longer aggregates a paid order into a
-- synthetic `completed` status, so the old embedded close guard could disagree
-- with the preview and direct table closure. Replace only the three audited
-- blocker fragments and fail closed if the predecessor has drifted.
DO $migration$
DECLARE
  function_definition text;
  needle text;
  replacement text;
  occurrence_count integer;
BEGIN
  SELECT pg_get_functiondef(procedure.oid)
  INTO function_definition
  FROM pg_proc procedure
  JOIN pg_namespace namespace ON namespace.oid=procedure.pronamespace
  WHERE namespace.nspname='mbox'
    AND procedure.proname='execute_table_customer_movement'
    AND procedure.pronargs=15;

  IF function_definition IS NULL THEN
    RAISE EXCEPTION 'execute_table_customer_movement predecessor is missing';
  END IF;

  needle := $old$
          (order_row.status='completed'
            AND order_row.payment_status IN ('paid','partially_refunded','refunded'))
          OR (order_row.status='cancelled' AND order_row.payment_status IN ('unpaid','refunded'))
        $old$;
  replacement := $new$
          (order_row.status<>'cancelled'
            AND order_row.payment_status IN ('paid','partially_refunded','refunded'))
          OR (order_row.status='cancelled' AND order_row.payment_status='refunded')
          OR (order_row.status='cancelled' AND order_row.payment_status='unpaid'
            AND NOT EXISTS (
              SELECT 1 FROM mbox.order_items delivered_item
              WHERE delivered_item.tenant_id=tenant_id_value
                AND delivered_item.store_id=store_id_value
                AND delivered_item.order_id=order_row.id
                AND delivered_item.status='delivered'
            ))
          OR (order_row.status='cancelled' AND order_row.payment_status='unpaid'
            AND EXISTS (
              SELECT 1 FROM mbox.order_settlement_exception_events settlement_exception
              WHERE settlement_exception.tenant_id=tenant_id_value
                AND settlement_exception.store_id=store_id_value
                AND settlement_exception.order_id=order_row.id
            ))
        $new$;
  occurrence_count := (length(function_definition)-length(replace(function_definition,needle,'')))
    / length(needle);
  IF occurrence_count<>1 THEN
    RAISE EXCEPTION 'unexpected movement order-settlement guard definition: % matches',occurrence_count;
  END IF;
  function_definition := replace(function_definition,needle,replacement);

  needle := $old$
          AND order_row.table_session_id=source_session.id
          AND item.status NOT IN ('delivered','cancelled')
          AND (closes_source_session OR order_row.created_by_customer_id IS NULL
        $old$;
  replacement := $new$
          AND order_row.table_session_id=source_session.id
          AND item.fulfillment_station IN ('bar','kitchen')
          AND item.status NOT IN ('delivered','cancelled')
          AND (closes_source_session OR order_row.created_by_customer_id IS NULL
        $new$;
  occurrence_count := (length(function_definition)-length(replace(function_definition,needle,'')))
    / length(needle);
  IF occurrence_count<>1 THEN
    RAISE EXCEPTION 'unexpected movement order-item guard definition: % matches',occurrence_count;
  END IF;
  function_definition := replace(function_definition,needle,replacement);

  needle := $old$
      OR EXISTS (SELECT 1
        FROM mbox.kds_tasks task
        JOIN mbox.order_items item ON item.tenant_id=task.tenant_id
        $old$;
  replacement := $new$
      OR EXISTS (SELECT 1
        FROM mbox.inventory_order_reservations reservation
        JOIN mbox.orders order_row ON order_row.tenant_id=reservation.tenant_id
          AND order_row.store_id=reservation.store_id AND order_row.id=reservation.order_id
        WHERE order_row.tenant_id=tenant_id_value AND order_row.store_id=store_id_value
          AND order_row.table_session_id=source_session.id
          AND reservation.status='reserved'
          AND (closes_source_session OR order_row.created_by_customer_id IS NULL
            OR mbox.canonical_customer_id(
              order_row.tenant_id,order_row.store_id,order_row.created_by_customer_id
            )=ANY(selected_canonical_customer_ids)))
      OR EXISTS (SELECT 1
        FROM mbox.kds_tasks task
        JOIN mbox.order_items item ON item.tenant_id=task.tenant_id
        $new$;
  occurrence_count := (length(function_definition)-length(replace(function_definition,needle,'')))
    / length(needle);
  IF occurrence_count<>1 THEN
    RAISE EXCEPTION 'unexpected movement inventory insertion point: % matches',occurrence_count;
  END IF;
  function_definition := replace(function_definition,needle,replacement);

  EXECUTE function_definition;
END $migration$;

UPDATE mbox.normalized_schema_metadata
SET schema_version='126',updated_at=clock_timestamp()
WHERE singleton=true;

COMMIT;
