BEGIN;

-- A physical table turnover is not a financial reversal.  140 correctly
-- keeps an unresolved collection auditable, but it also rejected every table
-- which had any historical paid/refunded order.  That made an ordinary table
-- containing settled history impossible to turn over after a guest left.
--
-- Rebuild the stored procedure from its current definition so this migration
-- stays narrowly scoped to the already deployed command.  Financial facts and
-- settled order headers remain immutable; only their outstanding operational
-- work (unfulfilled items, KDS tasks and reservations) is retired.
DO $migration$
DECLARE
  close_function_sql text;
  old_safety_scan text := $old$
  -- Do the safety scan before mutating anything. A confirmed/partially paid
  -- outcome is never reclassified as a customer-left unpaid handover.
  IF EXISTS (
    SELECT 1
    FROM mbox.orders ordering
    WHERE ordering.tenant_id=tenant_scope AND ordering.store_id=store_scope
      AND ordering.table_session_id=p_table_session_id
      AND ordering.status<>'cancelled'
      AND ordering.payment_status NOT IN ('unpaid','pending')
    FOR UPDATE
  ) THEN
    RAISE EXCEPTION 'a confirmed or partially paid order prevents customer-left turnover'
      USING ERRCODE='55000';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM mbox.payments payment
    JOIN mbox.orders ordering
      ON ordering.tenant_id=payment.tenant_id AND ordering.store_id=payment.store_id
     AND ordering.id=payment.order_id
    WHERE payment.tenant_id=tenant_scope AND payment.store_id=store_scope
      AND ordering.table_session_id=p_table_session_id
      AND payment.status IN ('succeeded','partially_refunded','refunded')
    FOR UPDATE OF payment,ordering
  ) THEN
    RAISE EXCEPTION 'a successful payment prevents customer-left turnover'
      USING ERRCODE='55000';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM mbox.refunds refund
    JOIN mbox.payments payment
      ON payment.tenant_id=refund.tenant_id AND payment.store_id=refund.store_id
     AND payment.id=refund.payment_id
    JOIN mbox.orders ordering
      ON ordering.tenant_id=payment.tenant_id AND ordering.store_id=payment.store_id
     AND ordering.id=payment.order_id
    WHERE refund.tenant_id=tenant_scope AND refund.store_id=store_scope
      AND ordering.table_session_id=p_table_session_id
      AND refund.status IN ('requested','approved','processing','succeeded')
    FOR UPDATE OF refund,payment,ordering
  ) THEN
    RAISE EXCEPTION 'an active refund prevents customer-left turnover' USING ERRCODE='55000';
  END IF;

$old$;
  new_safety_scan text := $new$
  -- A physical turnover does not rewrite a settled order, payment or refund.
  -- Their financial lifecycle remains available for reconciliation and any
  -- later after-sales work.  The per-order loop below still retires only
  -- operational work which has not been delivered, so it cannot carry into
  -- the next guest at this table.

$new$;
  old_completed_guard text := $old$
    IF order_row.status='completed' THEN
$old$;
  new_completed_guard text := $new$
    IF order_row.status='completed' AND order_row.payment_status IN ('unpaid','pending') THEN
$new$;
  old_settled_guard text := $old$
    IF order_row.payment_status NOT IN ('unpaid','pending') THEN
      RAISE EXCEPTION 'order payment state changed during customer-left turnover'
        USING ERRCODE='40001';
    END IF;

$old$;
  new_settled_guard text := $new$
    -- Settled/refunded headers remain immutable.  Continue through the
    -- operational cleanup, then leave their order/payment/refund states as-is.

$new$;
  old_order_cancel text := $old$
    ) SELECT count(*)::integer INTO released_reservations FROM released;

    UPDATE mbox.orders SET status='cancelled',cancelled_at=clock_timestamp(),completed_at=NULL,
$old$;
  new_order_cancel text := $new$
    ) SELECT count(*)::integer INTO released_reservations FROM released;

    IF order_row.payment_status NOT IN ('unpaid','pending') THEN
      CONTINUE;
    END IF;

    UPDATE mbox.orders SET status='cancelled',cancelled_at=clock_timestamp(),completed_at=NULL,
$new$;
BEGIN
  SELECT pg_get_functiondef(
    'mbox.close_table_after_customer_left(uuid,uuid,date,text,text,character)'::regprocedure
  ) INTO close_function_sql;
  IF close_function_sql IS NULL
    OR position(old_safety_scan IN close_function_sql)=0
    OR position(old_completed_guard IN close_function_sql)=0
    OR position(old_settled_guard IN close_function_sql)=0
    OR position(old_order_cancel IN close_function_sql)=0
  THEN
    RAISE EXCEPTION 'customer-left turnover function does not match the expected settled-history baseline'
      USING ERRCODE='55000';
  END IF;

  close_function_sql := replace(close_function_sql,old_safety_scan,new_safety_scan);
  close_function_sql := replace(close_function_sql,old_completed_guard,new_completed_guard);
  close_function_sql := replace(close_function_sql,old_settled_guard,new_settled_guard);
  close_function_sql := replace(close_function_sql,old_order_cancel,new_order_cancel);
  EXECUTE close_function_sql;
END $migration$;

COMMENT ON FUNCTION mbox.close_table_after_customer_left(uuid,uuid,date,text,text,char) IS
  'Atomically retires unfulfilled table work while preserving settled orders, payments and refunds for reconciliation, then closes a table after a guest leaves without confirmed payment.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='143',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
