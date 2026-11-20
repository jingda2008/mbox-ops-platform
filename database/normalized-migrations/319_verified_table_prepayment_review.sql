BEGIN;

-- Keep the existing minimum, refunds, allocations and carryover rules. A
-- locally closed receipt can have a verified capture awaiting ledger posting.
DO $migration$
DECLARE
  fn regprocedure;
  definition text;
  owner_name name;
  pending constant text := 'p.status IN(''created'',''pending'')';
  still_unsettled constant text := '(p.status IN(''created'',''pending'') OR
    (p.status IN(''closed'',''failed'') AND EXISTS (
      SELECT 1 FROM mbox.verified_provider_observations v
      WHERE (v.tenant_id,v.store_id,v.payment_id)=(p.tenant_id,p.store_id,p.id)
        AND v.observed_status=''payment_succeeded'')))';
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'mbox.table_prepayment_unsettled(uuid,uuid,uuid)'::regprocedure,
    'mbox.order_has_unresolved_table_credit(uuid,uuid,uuid)'::regprocedure
  ] LOOP
    definition := pg_get_functiondef(fn);
    IF strpos(definition,pending)=0 THEN RAISE EXCEPTION 'Missing pending-receipt predicate in %',fn; END IF;
    EXECUTE replace(definition,pending,still_unsettled);
  END LOOP;

  FOR owner_name IN
    SELECT DISTINCT pg_get_userbyid(proowner) FROM pg_proc WHERE oid IN (
      'mbox.guard_table_minimum_settlement()'::regprocedure,
      'mbox.confirm_carryover_tab_review(uuid,uuid,uuid,uuid,bigint,jsonb,text)'::regprocedure,
      'mbox.capture_closed_table_tab_reviews()'::regprocedure,
      'mbox.capture_closed_table_debts()'::regprocedure,
      'mbox.close_table_after_customer_left(uuid,uuid,date,text,text,character)'::regprocedure,
      'mbox.close_table_after_automatic_cutoff(uuid,uuid,date,text,text,character)'::regprocedure)
  LOOP
    EXECUTE format('GRANT SELECT (tenant_id,store_id,payment_id,observed_status) ON mbox.verified_provider_observations TO %I',owner_name);
  END LOOP;
END $migration$;

UPDATE mbox.normalized_schema_metadata SET schema_version='319',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
