BEGIN;

-- Compare the invoice against its own allocated shares, not the gross batch
-- amount or the number of callbacks. A verified observation is not a ledger entry.
CREATE FUNCTION mbox.tab_covered_by_unposted_capture(p_tenant uuid,p_store uuid,p_order uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,mbox AS $$
  WITH receipts AS (
    SELECT f.amount_minor, f.status IN ('succeeded','partially_refunded','refunded') AS posted,
      EXISTS (SELECT 1 FROM mbox.verified_provider_observations v
        WHERE (v.tenant_id,v.store_id,v.payment_id)=(f.tenant_id,f.store_id,f.id)
          AND v.observed_status='payment_succeeded' AND v.consumed_at IS NULL) AS confirmed
    FROM mbox.order_payment_facts f
    WHERE (f.tenant_id,f.store_id,f.order_id)=(p_tenant,p_store,p_order)
  )
  SELECT EXISTS (
    SELECT 1 FROM mbox.orders o
    WHERE (o.tenant_id,o.store_id,o.id)=(p_tenant,p_store,p_order)
      AND o.settlement_mode='table_tab' AND o.payment_status IN ('unpaid','pending')
      AND EXISTS (SELECT 1 FROM receipts WHERE confirmed AND NOT posted)
      AND (SELECT sum(amount_minor) FROM receipts WHERE posted OR confirmed)
        - COALESCE((SELECT sum(r.amount_minor) FROM mbox.order_refund_facts r
          WHERE (r.tenant_id,r.store_id,r.order_id)=(p_tenant,p_store,p_order) AND r.status='succeeded'),0)
        >= mbox.order_receivable_amount(p_tenant,p_store,p_order)
  )
$$;
REVOKE ALL ON FUNCTION mbox.tab_covered_by_unposted_capture(uuid,uuid,uuid) FROM PUBLIC;

-- Extend the current turnover implementations in place, preserving their
-- lock order, permissions, operational cleanup and original receipt semantics.
DO $migration$
DECLARE fn regprocedure; definition text; owner_name name;
  select_orders constant text := 'SELECT ordering.*' || chr(10) || '    FROM mbox.orders ordering';
  completed_unpaid constant text := 'IF order_row.status=''completed'' AND order_row.payment_status IN (''unpaid'',''pending'') THEN';
  preserve_paid constant text := 'IF order_row.payment_status NOT IN (''unpaid'',''pending'') THEN';
  skip_debt constant text := 'IF receivable IS NULL OR receivable<=receipts THEN CONTINUE; END IF;';
BEGIN
  -- Production retains distinct owners for turnover and carryover functions.
  -- Grant only those callers access to this invoker-rights calculation.
  FOR owner_name IN
    SELECT DISTINCT pg_get_userbyid(proowner) FROM pg_proc
    WHERE oid IN ('mbox.close_table_after_customer_left(uuid,uuid,date,text,text,char)'::regprocedure,
      'mbox.close_table_after_automatic_cutoff(uuid,uuid,date,text,text,char)'::regprocedure,
      'mbox.capture_closed_table_debts()'::regprocedure)
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION mbox.tab_covered_by_unposted_capture(uuid,uuid,uuid) TO %I',owner_name);
  END LOOP;

  FOREACH fn IN ARRAY ARRAY[
    'mbox.close_table_after_customer_left(uuid,uuid,date,text,text,char)'::regprocedure,
    'mbox.close_table_after_automatic_cutoff(uuid,uuid,date,text,text,char)'::regprocedure
  ] LOOP
    definition:=pg_get_functiondef(fn);
    IF strpos(definition,select_orders)=0 OR strpos(definition,completed_unpaid)=0 OR strpos(definition,preserve_paid)=0 THEN
      RAISE EXCEPTION 'unexpected turnover definition for %',fn;
    END IF;
    definition:=replace(definition,select_orders,
      'SELECT ordering.*, mbox.tab_covered_by_unposted_capture(ordering.tenant_id,ordering.store_id,ordering.id) AS capture_covers_tab FROM mbox.orders ordering');
    definition:=replace(definition,completed_unpaid,replace(completed_unpaid,' THEN',' AND NOT order_row.capture_covers_tab THEN'));
    definition:=replace(definition,preserve_paid,replace(preserve_paid,' THEN',' OR order_row.capture_covers_tab THEN'));
    EXECUTE definition;
  END LOOP;
  definition:=pg_get_functiondef('mbox.capture_closed_table_debts()'::regprocedure);
  IF strpos(definition,skip_debt)=0 THEN RAISE EXCEPTION 'unexpected carryover definition'; END IF;
  EXECUTE replace(definition,skip_debt,replace(skip_debt,' THEN',' OR mbox.tab_covered_by_unposted_capture(o.tenant_id,o.store_id,o.id) THEN'));
END $migration$;

UPDATE mbox.normalized_schema_metadata SET schema_version='318',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
