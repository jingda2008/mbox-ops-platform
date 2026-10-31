BEGIN;
GRANT UPDATE(minimum_spend_waiver_minor) ON mbox.table_sessions TO mbox_runtime;
-- Preserve the privileges of existing views/definers when migrations are run
-- by a maintenance account different from the original schema owner.
DO $$ DECLARE owner_name text; BEGIN
 SELECT pg_get_userbyid(relowner) INTO owner_name FROM pg_class WHERE oid='mbox.order_payment_facts'::regclass;
 EXECUTE format('GRANT SELECT ON mbox.table_prepayment_allocations TO %I',owner_name);
 FOR owner_name IN SELECT DISTINCT pg_get_userbyid(proowner) FROM pg_proc WHERE oid IN (
   'mbox.close_table_after_customer_left(uuid,uuid,date,text,text,character)'::regprocedure,
   'mbox.close_table_after_automatic_cutoff(uuid,uuid,date,text,text,character)'::regprocedure
 ) LOOP
   EXECUTE format('GRANT SELECT,INSERT ON mbox.table_prepayment_turnovers TO %I',owner_name);
   EXECUTE format('GRANT SELECT ON mbox.table_minimum_spend_waivers,mbox.table_prepayment_allocations,mbox.table_prepayment_revocations TO %I',owner_name);
   EXECUTE format('GRANT EXECUTE ON FUNCTION mbox.table_prepayment_unsettled(uuid,uuid,uuid),mbox.table_qualifying_goods(uuid,uuid,uuid),mbox.prepayment_available(uuid,uuid,uuid) TO %I',owner_name);
 END LOOP;
END $$;
UPDATE mbox.normalized_schema_metadata SET schema_version='290',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
